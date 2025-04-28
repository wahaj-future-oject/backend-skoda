const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const Replicate = require('replicate');
const fs = require('fs');
const fsPromises = require('fs').promises;
const axios = require('axios');
require('dotenv').config();
const { pool, initializeDatabase, logApiCall, getUserLogs, updateDatabaseSchema } = require('./db');

const app = express();
const port = process.env.PORT || 5000;

// Initialize Replicate client
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// Determine the base directory more reliably - works from any location
const BASE_DIR = path.resolve(__dirname, '..');
console.log(`Base directory: ${BASE_DIR}`);

// Detect if we're running on Upsun/Platform.sh
const isUpsun = process.env.PLATFORM_APPLICATION_NAME || process.env.PLATFORM_APP_DIR;

// Constants - use tmp directory on Upsun, local directories elsewhere
const DATA_DIR = isUpsun ? '/tmp' : path.join(BASE_DIR, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour in milliseconds
const THUMBNAILS_FILE = path.join(DATA_DIR, 'thumbnails.json');
const THUMBNAIL_DIR = path.join(DATA_DIR, 'thumbnails');

console.log(`Data directory: ${DATA_DIR}`);
console.log(`Uploads directory: ${UPLOADS_DIR}`);
console.log(`Thumbnails directory: ${THUMBNAIL_DIR}`);

// Ensure upload directory exists
function ensureUploadDirectory() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    try {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      console.log('Created uploads directory:', UPLOADS_DIR);
    } catch (error) {
      console.error('Failed to create uploads directory:', error);
      throw error;
    }
  }
}

// Basic initialization for uploads
try {
  ensureUploadDirectory();
} catch (error) {
  console.error('Error during uploads directory initialization:', error);
  // Continue execution even if this fails
}

async function ensureThumbnailDirectory() {
  try {
    if (!fs.existsSync(THUMBNAIL_DIR)) {
      await fsPromises.mkdir(THUMBNAIL_DIR, { recursive: true });
      console.log('Created thumbnails directory:', THUMBNAIL_DIR);
    }
    return THUMBNAIL_DIR;
  } catch (error) {
    console.error('Error creating thumbnail directory:', error);
    throw error;
  }
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG and WebP are allowed.'), false);
    }
  }
});

// Middleware
app.use(cors({
  origin: ['http://localhost:5600', 'https://frontify-artifacts.com', 'https://developer-sandbox-skoda.frontify.com'],
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id', 'x-user-name', 'x-user-email'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204
}));

// Handle preflight requests
app.options('*', cors());

app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));

// Add middleware to the app
app.use(getUserFromRequest);

// Constants and configurations
const ASPECT_RATIO_MAP = {
  square: "1:1",
  portrait: "3:4",
  landscape: "4:3",
  widescreen: "16:9",
  ultrawide: "9:16"
};

// Supported aspect ratios for Flux models
const VALID_ASPECT_RATIOS = ["1:1", "16:9", "3:2", "2:3", "4:5", "5:4", "9:16", "3:4", "4:3", "custom"];

// Helper function to validate and convert aspect ratio
function getValidAspectRatio(rawAspectRatio) {
  // If it's already a valid format, return it directly
  if (VALID_ASPECT_RATIOS.includes(rawAspectRatio)) {
    return rawAspectRatio;
  }
  
  // Convert from named format (e.g., "square") to ratio format (e.g., "1:1")
  const mappedRatio = ASPECT_RATIO_MAP[rawAspectRatio];
  
  // Return the mapped value or default to "1:1" if not found
  return mappedRatio && VALID_ASPECT_RATIOS.includes(mappedRatio) 
    ? mappedRatio 
    : "1:1";
}

// Model configuration - only using Replicate approved models
const MODELS = {
  standard: {
    type: 'model',
    model: 'black-forest-labs/flux-1.1-pro',
    version: 'b744535cf2bf3c4cf2130d0cc75cd4795b280215f8275b041015fb4f9917cbcd',
    displayName: 'Flux 1.1 Pro',
    description: 'Standard image generation with high quality results'
  },
  edge: {
    type: 'model',
    model: 'black-forest-labs/flux-canny-pro',
    version: 'eb672df541b42b50cb3b397d202de02a52210e6363fb1d8bc9e57fab089cee9d',
    displayName: 'Flux Canny Pro',
    description: 'Edge-based image generation for detailed control'
  },
  depth: {
    type: 'model',
    model: 'black-forest-labs/flux-depth-pro',
    version: '9964ef120f01973d86cb9121d5b6ec94a9f1b8e386ec86d4353ae5f7bc83ae24',
    displayName: 'Flux Depth Pro',
    description: 'Depth-aware image generation for 3D-like results'
  },
  character: {
    type: 'version',
    version: '8baa7ef2255075b46f4d91cd238c21d31181b3e6a864463f967960bb0112525b',
    displayName: 'Flux Pulid',
    description: 'Character-focused image generation'
  }
};

// Add Škoda Illustration model configuration
const SKODA_MODEL = {
  version: "f6e6805f4d32f8522f9af09f3efdbeeafc199621f9b15e3ade4ac9cef01c2af8"
};

// Helper to calculate dimensions based on aspect ratio
function calculateDimensions(aspectRatio) {
  // Default to 1:1 if no aspect ratio provided
  if (!aspectRatio) {
    return { width: 1024, height: 1024 };
  }
  
  let width, height;
  const BASE_SIZE = 1024;
  
  // Check if we're using a string with ratio format "w:h"
  if (typeof aspectRatio === 'string' && aspectRatio.includes(':')) {
    const [w, h] = aspectRatio.split(':').map(num => parseFloat(num));
    
    if (w >= h) {
      // Landscape or square
      width = BASE_SIZE;
      height = Math.round((h / w) * BASE_SIZE);
    } else {
      // Portrait
      height = BASE_SIZE;
      width = Math.round((w / h) * BASE_SIZE);
    }
  } else {
    // Use known aspect ratios
    switch (aspectRatio) {
      case 'square':
        width = 1024;
        height = 1024;
        break;
      case 'portrait':
        width = 768;
        height = 1024;
        break;
      case 'landscape':
        width = 1024;
        height = 768;
        break;
      case 'widescreen':
        width = 1024;
        height = 576;
        break;
      case 'ultrawide':
        width = 1024;
        height = 432;
        break;
      default:
        width = 1024;
        height = 1024;
    }
  }
  
  // Ensure dimensions are multiples of 8 (required by some models)
  width = Math.floor(width / 8) * 8;
  height = Math.floor(height / 8) * 8;
  
  return { width, height };
}

// Helper to sanitize prompts
function sanitizePrompt(prompt) {
  if (!prompt) return "";
  
  // Basic cleaning
  let cleaned = prompt.trim();
  
  // Replace multiple spaces with a single space
  cleaned = cleaned.replace(/\s+/g, ' ');
  
  // Define banned phrases
  const bannedPhrases = [
    'nsfw', 'nude', 'naked', 'xxx', 'porn', 'explicit', 'sex',
    'erotic', 'adult content', 'obscene', 'sexual', 'intimate parts'
  ];
  
  // Check for banned phrases and remove them
  bannedPhrases.forEach(phrase => {
    const regex = new RegExp(phrase, 'gi');
    cleaned = cleaned.replace(regex, '');
  });
  
  // Add high quality indicators if not present
  const qualityTerms = ['high quality', 'detailed', 'high resolution', 'hd', '4k', '8k'];
  const hasQualityTerm = qualityTerms.some(term => cleaned.toLowerCase().includes(term));
  
  if (!hasQualityTerm) {
    cleaned += ', high quality, detailed';
  }
  
  return cleaned;
}

// Clean up old files (older than 1 hour)
const cleanupOldFiles = async () => {
  try {
    const files = await fsPromises.readdir(UPLOADS_DIR);
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;

    for (const file of files) {
      const filePath = path.join(UPLOADS_DIR, file);
      const stats = await fsPromises.stat(filePath);
      if (now - stats.mtimeMs > ONE_HOUR) {
        await fsPromises.unlink(filePath);
        console.log(`Deleted old file: ${file}`);
      }
    }
  } catch (error) {
    console.error('Error cleaning up old files:', error);
  }
};

// Run cleanup every hour
setInterval(cleanupOldFiles, CLEANUP_INTERVAL);

// Upload local file to image hosting service
async function uploadToImageHost(localFilePath) {
  try {
    console.log(`Uploading local file to image hosting: ${localFilePath}`);
    
    // Read the file as base64
    const fileBuffer = await fsPromises.readFile(localFilePath);
    const base64Image = fileBuffer.toString('base64');
    
    // Try a different approach with ImgBB that forces a specific filename format
    try {
      console.log("Uploading to ImgBB with enhanced reliability...");
      
      // Generate a more reliable filename
      const timestamp = Date.now();
      const randomStr = Math.random().toString(36).substring(2, 8);
      const safeFilename = `image_${timestamp}_${randomStr}`;
      
      // Create FormData-like payload for upload with the name parameter
      const formData = new URLSearchParams();
      formData.append('image', base64Image);
      formData.append('name', safeFilename); // Specify a safe filename
      
      const imgbbApiKey = process.env.IMGBB_API_KEY || '58b111dccac952a08f78f8e8c1b2b0e3';
      
      const response = await axios.post(`https://api.imgbb.com/1/upload?key=${imgbbApiKey}`, formData, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000 // 15 second timeout
      });
      
      if (response.data && response.data.data) {
        // Use the url property which is more reliable than display_url
        const imageUrl = response.data.data.url;
        console.log(`Successfully uploaded to ImgBB. URL: ${imageUrl}`);
        
        // Verify URL validity
        try {
          const verifyResponse = await axios.head(imageUrl, { timeout: 3000 });
          if (verifyResponse.status >= 200 && verifyResponse.status < 300) {
            console.log('URL verification successful');
            return imageUrl;
          } else {
            console.warn('URL verification failed with status:', verifyResponse.status);
            // Fall through to try direct image upload
          }
        } catch (verifyError) {
          console.warn('URL verification failed:', verifyError.message);
          // Fall through to try direct image upload
        }
      } else {
        console.error('ImgBB response:', JSON.stringify(response.data));
      }
    } catch (imgbbError) {
      console.error('ImgBB upload failed:', imgbbError.message);
    }
    
    // If we reach here, try alternative image hosting services
    try {
      console.log("Trying alternative image hosting...");
      
      // Try imgcdn.dev as an alternative
      const formData = new FormData();
      formData.append('file', fileBuffer, {
        filename: `image_${Date.now()}.jpg`,
        contentType: 'image/jpeg'
      });
      
      const imgcdnResponse = await axios.post('https://imgcdn.dev/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 15000
      });
      
      if (imgcdnResponse.data && imgcdnResponse.data.url) {
        const imageUrl = imgcdnResponse.data.url;
        console.log(`Successfully uploaded to alternative host. URL: ${imageUrl}`);
        return imageUrl;
      }
    } catch (altError) {
      console.error('Alternative image hosting failed:', altError.message);
    }
    
    // Last resort: Use base64 for standard model and fail for other models
    console.log("Falling back to direct image data for compatible models...");
    
    return {
      isBase64: true,
      data: `data:image/jpeg;base64,${base64Image}`
    };
  } catch (error) {
    console.error('All image upload methods failed:', error.message);
    throw new Error(`Failed to upload image: ${error.message}`);
  }
}

// Helper function to get remotely accessible image URL
async function getAccessibleImageUrl(localImagePath) {
  // First try a direct upload
  try {
    const imageUrl = await uploadToImageHost(localImagePath);
    
    // If we got a string (URL), verify it's accessible
    if (typeof imageUrl === 'string') {
      try {
        const response = await axios.head(imageUrl, { timeout: 3000 });
        if (response.status >= 200 && response.status < 300) {
          console.log(`Verified accessible image URL: ${imageUrl}`);
          return imageUrl;
        }
      } catch (error) {
        console.warn(`Image URL verification failed: ${error.message}`);
      }
    }
    
    // If URL verification failed, return the base64 data if available
    if (typeof imageUrl === 'object' && imageUrl.isBase64) {
      return imageUrl;
    }
    
    // If we reached here, the upload was successful but URL is problematic
    // Try one more alternative approach
    try {
      console.log("Using public cloud storage as fallback...");
      
      // Create a temporary file with more reliable extension
      const tempFilename = `reliable_image_${Date.now()}.jpg`;
      const tempFilePath = path.join(UPLOADS_DIR, tempFilename);
      
      // Copy the file with the new name
      await fsPromises.copyFile(localImagePath, tempFilePath);
      
      // Try another upload method here (could be any other service)
      const secondAttemptUrl = await uploadToImageHost(tempFilePath);
      
      // Clean up the temp file
      await fsPromises.unlink(tempFilePath);
      
      // Return the result of the second attempt
      return secondAttemptUrl;
    } catch (fallbackError) {
      console.error("Fallback image hosting failed:", fallbackError.message);
      // Return the original result even though verification failed
      return imageUrl;
    }
  } catch (uploadError) {
    console.error("Failed to get accessible image URL:", uploadError.message);
    throw uploadError;
  }
}

// Helper function to validate URL
function isValidImageUrl(url) {
  if (!url) return false;
  
  // If it's a base64 data URL, it's valid
  if (typeof url === 'string' && url.startsWith('data:image/')) {
    return true;
  }
  
  try {
    const parsedUrl = new URL(url);
    return (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:');
  } catch (e) {
    return false;
  }
}

// Helper function to test image URL accessibility
async function isImageAccessible(url) {
  try {
    console.log(`Testing image URL accessibility: ${url}`);
    // Skip the test for potentially problematic URLs
    if (url.includes('KcbnhPJ9')) {
      console.warn('Potential problematic URL detected, returning false');
      return false;
    }
    
    const response = await axios.head(url, { timeout: 5000 });
    return response.status >= 200 && response.status < 300;
  } catch (error) {
    console.error(`Image URL accessibility test failed: ${error.message}`);
    return false;
  }
}

// Validate API token on startup
function validateApiToken() {
  if (!process.env.REPLICATE_API_TOKEN) {
    console.error('ERROR: REPLICATE_API_TOKEN is required in .env file');
    process.exit(1);
  }
  
  // Log available models
  console.log('Configured models:');
  Object.keys(MODELS).forEach(key => {
    console.log(`- ${key}: ${MODELS[key].displayName} (${MODELS[key].version})`);
  });
}

// Helper function to create a data URI for direct use with Replicate
async function createDataUri(localFilePath) {
  try {
    console.log(`Creating data URI from: ${localFilePath}`);
    
    // Read the file as binary data
    const fileBuffer = await fsPromises.readFile(localFilePath);
    
    // Get file mime type based on extension
    const ext = path.extname(localFilePath).toLowerCase();
    let mimeType = 'application/octet-stream'; // Default
    
    if (ext === '.jpg' || ext === '.jpeg') {
      mimeType = 'image/jpeg';
    } else if (ext === '.png') {
      mimeType = 'image/png';
    } else if (ext === '.webp') {
      mimeType = 'image/webp';
    }
    
    // Create data URI
    const base64Data = fileBuffer.toString('base64');
    const dataUri = `data:${mimeType};base64,${base64Data}`;
    
    console.log(`Created data URI with mime type: ${mimeType}`);
    return dataUri;
  } catch (error) {
    console.error('Failed to create data URI:', error.message);
    throw error;
  }
}

// Helper function to upload an image to Replicate's CDN (falling back to data URI approach)
async function uploadToReplicateCDN(filePath) {
  try {
    console.log(`Preparing data URI from: ${filePath}`);
    
    // Read the file as buffer
    const fileBuffer = await fsPromises.readFile(filePath);
    
    // Get file mime type based on extension
    const ext = path.extname(filePath).toLowerCase();
    let mimeType = 'application/octet-stream'; // Default
    
    if (ext === '.jpg' || ext === '.jpeg') {
      mimeType = 'image/jpeg';
    } else if (ext === '.png') {
      mimeType = 'image/png';
    } else if (ext === '.webp') {
      mimeType = 'image/webp';
    }
    
    // Create data URI
    const base64Data = fileBuffer.toString('base64');
    const dataUri = `data:${mimeType};base64,${base64Data}`;
    
    console.log(`Created data URI with mime type: ${mimeType}`);
    return dataUri;
  } catch (error) {
    console.error('Error creating data URI:', error.message);
    throw new Error(`Failed to create data URI: ${error.message}`);
  }
}

// Test endpoint for Replicate CDN upload
app.post('/api/test-replicate-upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const filePath = path.join(UPLOADS_DIR, req.file.filename);
    console.log(`Uploaded file: ${filePath}`);
    
    // Create a data URI
    const dataUri = await uploadToReplicateCDN(filePath);
    
    // Use the data URI with a test prediction to verify it works
    console.log('Testing data URI with Flux model...');
    const modelVersion = "black-forest-labs/flux-canny-pro:eb672df541b42b50cb3b397d202de02a52210e6363fb1d8bc9e57fab089cee9d";
    
    // Create a simple prediction
    const prediction = await replicate.predictions.create({
      version: modelVersion.split(':')[1],
      input: {
        prompt: "Test image, high quality",
        control_image: dataUri,
        prompt_upsampling: true,
        safety_tolerance: 2,
        output_format: "png",
        aspect_ratio: "1:1"
      }
    });
    
    res.json({
      success: true,
      dataUri: dataUri.substring(0, 50) + '...',  // Just show beginning of data URI for security
      predictionId: prediction.id,
      message: 'File uploaded and data URI created successfully'
    });
  } catch (error) {
    console.error('Error testing data URI upload:', error);
    res.status(500).json({ 
      error: 'Upload failed',
      details: error.message 
    });
  }
});

// Initialize database on startup
initializeDatabase();
updateDatabaseSchema();

// Middleware to get user from frontend
function getUserFromRequest(req, res, next) {
  // Get user info from request headers
  const userId = req.headers['x-user-id'] || 'anonymous';
  const userName = req.headers['x-user-name'] || 'Anonymous User';
  const userEmail = req.headers['x-user-email'] || 'anonymous';
  
  // Log the received user info for debugging
  console.log('Received user info:', {
    id: userId,
    name: userName,
    email: userEmail
  });
  
  req.user = {
    id: userId,
    name: userName,
    email: userEmail
  };
  
  next();
}

// API Routes
app.post('/api/generate-image', async (req, res) => {
  console.log('Received image generation request');
  const startTime = Date.now();
  
  try {
    // Extract all parameters from request body
    const { prompt, engineType, model, main_face_image, settings } = req.body;
    
    // Log the full request details
    console.log('----------------------------------------');
    console.log('FULL REQUEST DETAILS:');
    console.log(`Engine Type: ${engineType}`);
    console.log(`Model: ${model}`);
    console.log(`Settings: ${JSON.stringify(settings, null, 2)}`);
    console.log(`Main Face Image: ${main_face_image ? 'Present' : 'Not present'}`);
    console.log('----------------------------------------');
    
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }
    
    if (!engineType || !MODELS[engineType]) {
      console.error(`Invalid engine type: ${engineType}`);
      return res.status(400).json({ error: 'Valid engine type is required' });
    }

    // Get the selected model configuration
    const selectedModel = MODELS[engineType];

    // Log the model being used with extra details
    console.log(`Using model: ${selectedModel.displayName} (${selectedModel.version})`);
    console.log(`Model details: ${JSON.stringify(selectedModel, null, 2)}`);
    
    // Clean up the prompt
    const cleanPrompt = sanitizePrompt(prompt);
    console.log('Cleaned prompt:', cleanPrompt);
    
    // Log for image settings
    if (engineType === 'edge' || engineType === 'depth') {
      console.log('Checking composition image for ControlNet models...');
      
      if (!settings) {
        console.error('Settings object is missing');
        return res.status(400).json({ error: 'Settings are required' });
      }
      
      console.log('Settings found:', Object.keys(settings).join(', '));
      
      if (!settings.compositionImage) {
        console.error('Missing compositionImage in settings');
        return res.status(400).json({ 
          error: 'Composition image is required'
        });
      }
      
      console.log(`Composition image found: ${settings.compositionImage.substring(0, 50)}...`);
    }
    
    // Base input parameters based on model type
    let input = {};
    
    // Set model-specific parameters
    if (engineType === 'standard') {
      // Standard model (Flux 1.1 Pro)
      input = {
        prompt: cleanPrompt,
        prompt_upsampling: true,
        safety_tolerance: 2,
        output_format: "png",
        output_quality: 80,
      };
      
      // Check for composition image (if we're in composition mode)
      if (settings && settings.compositionImage && typeof settings.compositionImage === 'string') {
        console.log('Standard model with composition image detected');
        
        // Check for image parameter which is needed for Replicate API
        if (!settings.image) {
          console.warn('Missing image parameter, will use compositionImage instead');
          settings.image = settings.compositionImage;
        }
        
        let referenceImageUrl = settings.image;
        console.log(`Using reference image: ${referenceImageUrl.substring(0, 50)}...`);
        
        // Process local image if needed
        if (referenceImageUrl.includes('localhost') || referenceImageUrl.includes('127.0.0.1')) {
          // Process local image (similar to the code for edge/depth models)
          // ...existing code...
        }
        
        // Set image parameter for the model
        input.image = referenceImageUrl;
      }
      
      // Set aspect ratio
      if (settings && settings.aspectRatio) {
        input.aspect_ratio = settings.aspectRatio;
        
        // Calculate width and height based on aspect ratio
        const { width, height } = calculateDimensions(settings.aspectRatio);
        console.log(`Calculated dimensions: ${width}x${height}`);
      }
      
      if (settings?.steps) {
        input.num_inference_steps = settings.steps;
      }
      
      if (settings?.guidance) {
        input.guidance_scale = settings.guidance;
      }
      
      // Handle reference image for standard model if provided
      if (settings?.referenceImage && typeof settings.referenceImage === 'string') {
        let referenceImageUrl = settings.referenceImage;
        
        // Check if the image is from our local server
        if (referenceImageUrl.includes('localhost') || referenceImageUrl.includes('127.0.0.1')) {
          console.log('Processing local reference image...');
          try {
            // Extract filename from URL
            const filename = referenceImageUrl.substring(referenceImageUrl.lastIndexOf('/') + 1);
            const localFilePath = path.join(UPLOADS_DIR, filename);
            
            // Use our data URI helper function
            const dataUri = await createDataUri(localFilePath);
            
            // Use the data URI directly with the model
            input.image_base64 = dataUri;
            console.log('Reference image prepared as data URI');
          } catch (fileError) {
            console.error('Failed to prepare reference image:', fileError.message);
            return res.status(400).json({ 
              error: 'Failed to prepare reference image' 
            });
          }
        } else if (referenceImageUrl.startsWith('data:')) {
          // Image is already in base64/data URI format
          input.image_base64 = referenceImageUrl;
          console.log('Using provided data URI reference image');
        } else {
          // External URL, set it directly
          input.image = referenceImageUrl;
          console.log('Using external reference image URL');
        }
      }
    } 
    else if (engineType === 'edge' || engineType === 'depth') {
      // ControlNet models (Canny/Depth)
      // Validate composition image
      if (!settings || !settings.compositionImage || typeof settings.compositionImage !== 'string') {
        console.error('Missing compositionImage parameter in settings');
        return res.status(400).json({ 
          error: 'Composition image is required'
        });
      }
      
      // Check for control_image parameter which is needed for Replicate API
      if (settings && !settings.control_image) {
        console.warn('Missing control_image parameter, will use compositionImage instead');
        settings.control_image = settings.compositionImage;
      }
      
      let compositionImageUrl = settings.control_image || settings.compositionImage;
      console.log(`Using composition image: ${compositionImageUrl.substring(0, 50)}...`);
      
      // Check if the image is from our local server
      if (compositionImageUrl.includes('localhost') || compositionImageUrl.includes('127.0.0.1')) {
        console.log('Using direct local file for edge/depth model...');
        try {
          // Extract filename from URL
          const filename = compositionImageUrl.substring(compositionImageUrl.lastIndexOf('/') + 1);
          const localFilePath = path.join(UPLOADS_DIR, filename);
          
          console.log(`Extracted local filename: ${filename}`);
          console.log(`Full local file path: ${localFilePath}`);
          
          // Test if file exists
          try {
            await fsPromises.access(localFilePath);
            console.log(`File exists at: ${localFilePath}`);
          } catch (e) {
            console.error(`File does not exist at: ${localFilePath}`);
            return res.status(400).json({ error: 'Composition image file not found' });
          }
          
          // Upload to Replicate CDN to get a public URL
          try {
            console.log('Uploading to Replicate CDN for edge/depth model...');
            compositionImageUrl = await uploadToReplicateCDN(localFilePath);
            console.log(`Image uploaded to Replicate CDN: ${compositionImageUrl.substring(0, 50)}...`);
          } catch (replicateUploadError) {
            console.error('Replicate CDN upload failed:', replicateUploadError.message);
            
            // Fall back to previous methods if Replicate CDN fails
            console.log('Falling back to previous methods...');
            
            // Try preprocessing if it's still an option
            try {
              console.log('Trying preprocessing with Replicate...');
              // ... existing preprocessing code ...
            } catch (preprocessError) {
              console.error('Preprocessing error:', preprocessError.message);
              
              // Try data URI approach
              try {
                console.log('Falling back to direct data URI for the main model...');
                const dataUri = await createDataUri(localFilePath);
                compositionImageUrl = dataUri;
                console.log('Using data URI directly with main model');
              } catch (dataUriError) {
                console.error('Data URI creation failed:', dataUriError.message);
                
                // Fall back to previous approaches only as a last resort
                console.log('Falling back to external image hosting services...');
                
                // ... existing fallback code ...
              }
            }
          }
          
        } catch (fileError) {
          console.error('Failed to process composition image:', fileError.message);
          return res.status(400).json({ 
            error: 'Failed to process image file' 
          });
        }
      }
      
      // Now set the parameters based on the URL type
      input = {
        prompt: cleanPrompt,
        output_format: "png",
        output_quality: 80,
        safety_tolerance: 2,
        prompt_upsampling: true
      };
      
      // Set the control_image parameter regardless of URL type
      // The parameter can accept both data URIs and regular URLs
      input.control_image = compositionImageUrl;
      
      // Set aspect ratio
      if (settings && settings.aspectRatio) {
        input.aspect_ratio = settings.aspectRatio;
      }
      
      // Add steps and guidance if provided
      if (settings?.steps) {
        input.steps = settings.steps;
      }
      
      if (settings?.guidance) {
        input.guidance = settings.guidance;
      }
    } 
    else if (engineType === 'character') {
      // Pulid model
      // Validate character image
      const characterImage = main_face_image || settings?.characterImage;
      
      if (!characterImage) {
        console.error('Character image is missing');
        return res.status(400).json({ 
          error: 'Character image is required'
        });
      }
      
      let characterImageUrl = characterImage;
      
      // Check if the image is from our local server
      if (characterImageUrl.includes('localhost') || characterImageUrl.includes('127.0.0.1')) {
        console.log('Processing local character image...');
        try {
          // Extract filename from URL
          const filename = characterImageUrl.substring(characterImageUrl.lastIndexOf('/') + 1);
          const localFilePath = path.join(UPLOADS_DIR, filename);
          
          // First check if file exists
          try {
            await fsPromises.access(localFilePath);
            console.log(`Character image file exists at: ${localFilePath}`);
          } catch (e) {
            console.error(`Character image file not found at: ${localFilePath}`);
            return res.status(400).json({ error: 'Character image file not found' });
          }
          
          // Convert to data URI
          try {
            console.log('Converting character image to data URI...');
            const dataUri = await createDataUri(localFilePath);
            characterImageUrl = dataUri;
            console.log('Character image converted to data URI successfully');
          } catch (dataUriError) {
            console.error('Data URI creation failed:', dataUriError.message);
            return res.status(400).json({ error: 'Failed to process character image' });
          }
        } catch (fileError) {
          console.error('Failed to read character image file:', fileError.message);
          return res.status(400).json({ 
            error: 'Failed to read image file. Please try again with a different image.' 
          });
        }
      }
      
      // Now set the parameters for the character model
      input = {
        prompt: cleanPrompt,
        main_face_image: characterImageUrl,
        start_step: settings?.start_step || 4,
        num_outputs: settings?.num_outputs || 4,
        negative_prompt: settings?.negative_prompt || "bad quality, worst quality, text, signature, watermark, extra limbs",
        aspect_ratio: settings?.aspect_ratio || "1:1",
        num_inference_steps: settings?.num_inference_steps || 30,
        guidance_scale: settings?.guidance_scale || 7.5
      };
      
      console.log('Character model input prepared:', {
        ...input,
        main_face_image: input.main_face_image ? 'IMAGE_DATA_PRESENT' : 'MISSING'
      });
    }
    
    // Log the input for debugging
    console.log('----------------------------------------');
    console.log('FINAL MODEL INPUT:');
    console.log(`Model: ${selectedModel.model || "No model name"}`);
    console.log(`Version: ${selectedModel.version}`);
    console.log('Input parameters:');
    
    // Create a safe copy for logging that doesn't include full image data
    const safeInput = { ...input };
    if (safeInput.control_image && typeof safeInput.control_image === 'string') {
      if (safeInput.control_image.length > 100) {
        safeInput.control_image = `${safeInput.control_image.substring(0, 50)}... [truncated]`;
      }
    }
    if (safeInput.image && typeof safeInput.image === 'string') {
      if (safeInput.image.length > 100) {
        safeInput.image = `${safeInput.image.substring(0, 50)}... [truncated]`;
      }
    }
    
    console.log(JSON.stringify(safeInput, null, 2));
    console.log('----------------------------------------');
    
    // Create prediction using the Replicate API
    let prediction;
    // Always use direct version ID for predictable behavior
    console.log(`Creating prediction with version: ${selectedModel.version}`);
    
    try {
      prediction = await replicate.predictions.create({
        version: selectedModel.version,
        input: input
      });
      
      console.log(`Prediction created with ID: ${prediction.id}`);
      console.log(`Initial status: ${prediction.status}`);
    } catch (createError) {
      console.error('Error creating prediction:', createError);
      console.error('Error details:', createError.message);
      throw new Error(`Failed to create prediction: ${createError.message}`);
    }

    // Poll for the result
    let result = prediction;
    let attempts = 0;
    const maxAttempts = 300; // Poll for up to 90 seconds (increased from 60)
    
    while (result.status !== 'succeeded' && result.status !== 'failed' && attempts < maxAttempts) {
      console.log(`Polling attempt ${attempts + 1}/${maxAttempts}. Status: ${result.status}`);
      
      // Wait 1 second between polls
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Get updated prediction status
      try {
        result = await replicate.predictions.get(prediction.id);
      } catch (pollingError) {
        console.error('Error during polling:', pollingError.message);
        
        // If we can't get prediction status but haven't reached max attempts, continue
        if (attempts < maxAttempts - 1) {
          console.log('Will try polling again...');
          continue;
        }
        
        throw pollingError;
      }
      
      attempts++;
    }

    if (result.status === 'failed') {
      const errorMessage = result.error || 'Unknown error';
      console.error(`Prediction failed: ${errorMessage}`);
      console.error('Full prediction object:', JSON.stringify(result, null, 2));
      throw new Error(`Prediction failed: ${errorMessage}`);
    }

    if (attempts >= maxAttempts && result.status !== 'succeeded') {
      console.error('Prediction timed out. Last status:', result.status);
      console.error('Full prediction object:', JSON.stringify(result, null, 2));
      throw new Error(`Prediction timed out after ${maxAttempts} seconds. Last status: ${result.status}`);
    }

    console.log('Prediction succeeded:', result.id);
    console.log('Output:', result.output);

    // Process the output based on model type
    let imageUrls = [];
    if (engineType === 'character') {
      // Character model might return multiple images
      imageUrls = Array.isArray(result.output) ? result.output : [result.output];
    } else if (Array.isArray(result.output)) {
      // If output is an array, use it directly
      imageUrls = result.output;
    } else if (result.output && typeof result.output === 'string') {
      // If output is a single string (URL), put it in an array
      imageUrls = [result.output];
    } else if (result.output && result.output.image) {
      // Some ControlNet models return { image: URL }
      imageUrls = [result.output.image];
    } else if (result.output && result.output.images) {
      // Some models return { images: [URL, URL, ...] }
      imageUrls = result.output.images;
    } else {
      throw new Error('Unexpected output format from model');
    }

    if (!imageUrls.length) {
      throw new Error('No output images received from the model');
    }

    const generationTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`Image generated successfully in ${generationTime}s`);

    res.json({ 
      imageUrl: imageUrls[0],
      predictionId: prediction.id,
      imageUrls: imageUrls,
      metadata: {
        engine: engineType,
        aspectRatio: input.aspect_ratio,
        prompt: cleanPrompt,
        width: input.width,
        height: input.height,
        generationTime: `${generationTime}s`,
        settings: {
          steps: input.num_inference_steps || input.steps || 30,
          guidance: input.guidance_scale || input.guidance || 7.5
        }
      }
    });
  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error.message
    });
  }
});

app.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      throw new Error('No file uploaded');
    }

    console.log('File uploaded successfully:', {
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size
    });

    // Create local URL for the uploaded file
    const host = req.get('host');
    const protocol = req.protocol;
    const localImageUrl = `${protocol}://${host}/uploads/${req.file.filename}`;
    const localFilePath = path.join(UPLOADS_DIR, req.file.filename);
    
    console.log('Generated local image URL:', localImageUrl);
    
    // Store the file path for potential future upload to image hosting
    res.json({ 
      imagePath: localImageUrl,
      localFilePath: req.file.filename, // Just store the filename, not the full path
      filename: req.file.filename,
      message: 'File uploaded successfully'
    });
  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(400).json({ 
      error: 'Upload failed',
      details: error.message 
    });
  }
});

// Delete file endpoint
app.delete('/api/delete-file', async (req, res) => {
  try {
    const { filename } = req.body;
    if (!filename) {
      return res.status(400).json({ error: 'Filename is required' });
    }

    const filePath = path.join(UPLOADS_DIR, filename);
    
    // Security check: ensure file is within uploads directory
    if (!filePath.startsWith(UPLOADS_DIR)) {
      return res.status(400).json({ error: 'Invalid file path' });
    }

    try {
      await fsPromises.access(filePath);
    } catch {
      return res.status(404).json({ error: 'File not found' });
    }

    await fsPromises.unlink(filePath);
    res.json({ message: 'File deleted successfully' });
  } catch (error) {
    console.error('Error deleting file:', error);
    res.status(500).json({ 
      error: 'Delete failed',
      details: error.message 
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Global error handler:', err);
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'File size too large. Maximum size is 5MB.'
      });
    }
    return res.status(400).json({
      error: 'File upload error',
      details: err.message
    });
  }

  res.status(500).json({
    error: 'Internal server error',
    details: err.message
  });
});

// Add prediction results storage with concurrency support
const predictionResults = new Map();
const predictionLocks = new Map();

// Helper function to safely update prediction results
async function updatePredictionResult(id, updateFn) {
  if (!predictionLocks.has(id)) {
    predictionLocks.set(id, new Promise(resolve => resolve()));
  }
  
  const lock = predictionLocks.get(id);
  await lock;
  
  const newLock = new Promise(async (resolve) => {
    try {
      const currentResult = predictionResults.get(id) || { status: 'processing' };
      const updatedResult = await updateFn(currentResult);
      predictionResults.set(id, updatedResult);
    } finally {
      resolve();
    }
  });
  
  predictionLocks.set(id, newLock);
  await newLock;
}

// Add new route for Škoda Illustration
app.post('/api/generate-skoda-illustration', async (req, res) => {
  try {
    console.log('Received Škoda Illustration generation request');
    const { prompt, settings } = req.body;

    // Get user info from request headers
    const userInfo = {
      id: req.headers['x-user-id'] || 'anonymous',
      email: req.headers['x-user-email'] || 'anonymous',
      name: req.headers['x-user-name'] || 'Anonymous User'
    };

    // Clean and prepare the prompt
    const cleanedPrompt = `${prompt}, high quality, detailed`;
    console.log('Cleaned prompt:', cleanedPrompt);

    // Get the server URL from Upsun environment variables
    const serverUrl = process.env.PLATFORM_ROUTES ? 
      // Extract the first URL from PLATFORM_ROUTES (primary domain)
      Object.keys(JSON.parse(process.env.PLATFORM_ROUTES))[0] :
      null;

    // Prepare base model input
    const modelInput = {
      prompt: cleanedPrompt,
      start_step: 4,
      num_outputs: 1,
      negative_prompt: settings?.negative_prompt || 'bad quality, worst quality, signature, text',
      aspect_ratio: settings?.aspect_ratio || '1:1',
      prompt_guidance: settings?.guidance_scale || 7.5,
      skoda_strength: 1,
      character_name: '',
      extra_lora_scale: settings?.extra_lora_scale || 0.5,
      lora_scale: settings?.lora_scale || 1.0,
      output_quality: settings?.output_quality || 80
    };

    // Add webhook URL only when deployed on Upsun
    if (serverUrl) {
      console.log('Adding webhook URL:', `${serverUrl}/api/replicate-webhook`);
      modelInput.webhook = `${serverUrl}/api/replicate-webhook`;
    }

    // Process image if provided
    if (settings?.image) {
      let imageUri;
      if (settings.image.startsWith('data:image/')) {
        imageUri = settings.image;
      } else {
        const mimeType = 'image/jpeg';
        imageUri = `data:${mimeType};base64,${settings.image.replace(/^data:image\/\w+;base64,/, '')}`;
      }
      if (imageUri) {
        modelInput.image = imageUri;
      }
    }

    // Create prediction
    const prediction = await replicate.predictions.create({
      version: "f6e6805f4d32f8522f9af09f3efdbeeafc199621f9b15e3ade4ac9cef01c2af8",
      input: modelInput,
      ...(serverUrl && { webhook: modelInput.webhook }) // Add webhook only if serverUrl exists
    });

    console.log('Prediction created with ID:', prediction.id);

    // Store initial state with user info
    await updatePredictionResult(prediction.id, () => ({
      status: 'processing',
      startTime: Date.now(),
      userInfo: userInfo
    }));

    // Return immediately with prediction ID
    res.json({
      predictionId: prediction.id,
      status: 'processing',
      message: 'Image generation started'
    });

  } catch (error) {
    console.error('Error generating Škoda illustration:', error);
    res.status(500).json({
      error: 'Failed to generate image',
      details: error.message
    });
  }
});

// Add endpoint for clients to check prediction status
app.get('/api/prediction/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get result from our storage
    let result = predictionResults.get(id);
    
    if (!result) {
      return res.status(404).json({ error: 'Prediction not found' });
      }

    // If still processing, check with Replicate directly
    if (result.status === 'processing') {
      const prediction = await replicate.predictions.get(id);
      
      if (prediction.status === 'succeeded') {
        await updatePredictionResult(id, () => ({
          status: 'completed',
          imageUrl: prediction.output[0],
          completedTime: Date.now()
        }));
      } else if (prediction.status === 'failed') {
        await updatePredictionResult(id, () => ({
          status: 'failed',
          error: prediction.error || 'Image generation failed',
          completedTime: Date.now()
        }));
      }
      
      // Get updated result
      result = predictionResults.get(id);
    }
    
    // Clean up old results (older than 1 hour)
    const now = Date.now();
    for (const [key, value] of predictionResults.entries()) {
      if (value.completedTime && (now - value.completedTime) > 3600000) {
        predictionResults.delete(key);
        predictionLocks.delete(key);
      }
    }
    
    res.json({
      predictionId: id,
      ...result
    });
  } catch (error) {
    console.error('Error fetching prediction:', error);
    res.status(500).json({
      error: 'Failed to fetch prediction',
      details: error.message
    });
  }
});

// Add static route for serving thumbnail images
app.use('/ThumbnailImages', express.static(THUMBNAIL_DIR));

// Add helper functions for thumbnail management
async function downloadAndSaveImage(imageUrl) {
  try {
    await ensureThumbnailDirectory();
    
    // If the URL is already a local path, verify it exists and return it
    if (imageUrl.includes('ThumbnailImages')) {
      const filename = imageUrl.split('/').pop();
      const localPath = path.join(THUMBNAIL_DIR, filename);
      try {
        await fsPromises.access(localPath);
        return imageUrl; // File exists, return the URL
      } catch (error) {
        console.log('Local file not found, will attempt to download again');
        // Continue with download process
      }
    }

    let response;
    let retryCount = 0;
    const maxRetries = 3;

    while (retryCount < maxRetries) {
      try {
        response = await axios({
          url: imageUrl,
          responseType: 'arraybuffer',
          timeout: 30000, // Increased timeout to 30 seconds
          maxContentLength: 50 * 1024 * 1024, // 50MB max
          validateStatus: false // Don't reject on any status code
        });

        if (response.status === 200) {
          break; // Successful download
        }
        
        console.log(`Attempt ${retryCount + 1}: Status ${response.status}`);
        retryCount++;
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds before retry
  } catch (error) {
        console.error(`Download attempt ${retryCount + 1} failed:`, error.message);
        
        // Try alternative URL if available
        if (imageUrl.includes('replicate.delivery')) {
          const altUrl = imageUrl.replace('replicate.delivery', 'replicate.com');
          try {
            response = await axios({
              url: altUrl,
              responseType: 'arraybuffer',
              timeout: 30000
            });
            if (response.status === 200) break;
          } catch (altError) {
            console.error('Alternative URL failed:', altError.message);
          }
        }
        
        retryCount++;
        if (retryCount < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          throw new Error('Max retries reached for download');
        }
      }
    }

    if (!response || response.status !== 200) {
      throw new Error(`Failed to download image after ${maxRetries} attempts`);
    }

    // Generate a unique filename using timestamp and random string
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(7);
    const filename = `thumbnail_${timestamp}_${randomString}.png`;
    const localPath = path.join(THUMBNAIL_DIR, filename);
    
    // Write file with verification
    await fsPromises.writeFile(localPath, response.data);
    
    // Verify file was written correctly
    try {
      await fsPromises.access(localPath);
      const stats = await fsPromises.stat(localPath);
      if (stats.size === 0) {
        throw new Error('File was created but is empty');
      }
      console.log(`File saved successfully: ${localPath} (${stats.size} bytes)`);
    } catch (error) {
      throw new Error(`File verification failed: ${error.message}`);
    }

    // Return the local path with correct URL format
    const localUrl = `http://localhost:5000/ThumbnailImages/${filename}`;
    console.log('Local URL created:', localUrl);
    
    return localUrl;
  } catch (error) {
    console.error('Error in downloadAndSaveImage:', error);
    throw error;
  }
}

async function cleanupThumbnails() {
  try {
    console.log('Starting thumbnails cleanup...');
    
    // Read thumbnails file
    let thumbnails = [];
    try {
      const data = await fsPromises.readFile(THUMBNAILS_FILE, 'utf8');
      thumbnails = JSON.parse(data);
    } catch (error) {
      console.error('Error reading thumbnails file:', error);
      return;
    }

    const validThumbnails = [];
    const processedUrls = new Set(); // Track processed URLs to avoid duplicates

    for (const thumbnail of thumbnails) {
      // Skip if we've already processed this URL
      if (processedUrls.has(thumbnail.url)) {
        continue;
      }

      let isValid = false;
      let localUrl = thumbnail.url;

      if (thumbnail.url.includes('ThumbnailImages')) {
        const filename = thumbnail.url.split('/').pop();
        const localPath = path.join(THUMBNAIL_DIR, filename);

        try {
          await fsPromises.access(localPath);
          const stats = await fsPromises.stat(localPath);
          if (stats.size > 0) {
            isValid = true;
          } else {
            console.log(`Empty file found: ${filename}, attempting to redownload`);
          }
        } catch (error) {
          console.log(`Missing file: ${filename}, attempting to redownload`);
        }

        if (!isValid && thumbnail.originalUrl) {
          try {
            localUrl = await downloadAndSaveImage(thumbnail.originalUrl);
            isValid = true;
          } catch (error) {
            console.error('Failed to redownload:', error.message);
          }
        }
      } else {
        try {
          localUrl = await downloadAndSaveImage(thumbnail.url);
          isValid = true;
        } catch (error) {
          console.error('Failed to download non-local thumbnail:', error.message);
        }
      }

      if (isValid) {
        validThumbnails.push({
          ...thumbnail,
          url: localUrl,
          originalUrl: thumbnail.originalUrl || thumbnail.url
        });
        processedUrls.add(localUrl);
      }
    }

    // Save the updated thumbnails list
    await fsPromises.writeFile(THUMBNAILS_FILE, JSON.stringify(validThumbnails, null, 2));
    console.log(`Thumbnails cleanup completed. Valid thumbnails: ${validThumbnails.length}`);
  } catch (error) {
    console.error('Error during thumbnails cleanup:', error);
  }
}

// Initialize thumbnails storage
async function initializeThumbnailsStorage() {
  try {
    await fsPromises.access(THUMBNAILS_FILE);
  } catch (error) {
    // File doesn't exist, create it with empty array
    await fsPromises.writeFile(THUMBNAILS_FILE, JSON.stringify([]));
  }
}

// Get all thumbnails
app.get('/api/thumbnails', async (req, res) => {
  try {
    const data = await fsPromises.readFile(THUMBNAILS_FILE, 'utf8');
    const thumbnails = JSON.parse(data);
    res.json(thumbnails);
  } catch (error) {
    console.error('Error reading thumbnails:', error);
    res.status(500).json({ error: 'Failed to fetch thumbnails' });
  }
});

// Store a new thumbnail
app.post('/api/thumbnails', async (req, res) => {
  try {
    const thumbnail = req.body;
    
    if (!thumbnail.url || !thumbnail.prompt) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!thumbnail.timestamp) {
      thumbnail.timestamp = new Date().toISOString();
    }

    // Get user info from request headers
    const userInfo = {
      id: req.headers['x-user-id'] || 'anonymous',
      email: req.headers['x-user-email'] || 'anonymous',
      name: req.headers['x-user-name'] || 'Anonymous User'
    };

    // Log the received user info
    console.log('Processing thumbnail with user info:', userInfo);

    let localImageUrl;
    let retryCount = 0;
    const maxRetries = 3;

    while (retryCount < maxRetries) {
      try {
        localImageUrl = await downloadAndSaveImage(thumbnail.url);
        
        // Verify the saved image is accessible
        const filename = localImageUrl.split('/').pop();
        const localPath = path.join(THUMBNAIL_DIR, filename);
        await fsPromises.access(localPath);
        const stats = await fsPromises.stat(localPath);
        
        if (stats.size > 0) {
          break; // File exists and has content
        } else {
          throw new Error('Saved file is empty');
        }
      } catch (error) {
        console.error(`Attempt ${retryCount + 1} failed:`, error.message);
        retryCount++;
        
        if (retryCount >= maxRetries) {
          return res.status(500).json({ error: 'Failed to save image after multiple attempts' });
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait before retry
      }
    }

    // Store both URLs in the thumbnail object
    const updatedThumbnail = {
      ...thumbnail,
      originalUrl: thumbnail.url,
      url: localImageUrl,
      localPath: localImageUrl.split('/').pop(), // Store filename for verification
      userId: userInfo.id,
      userName: userInfo.name,
      userEmail: userInfo.email
    };

    // Read and update thumbnails file with verification
    let thumbnails = [];
    try {
      const data = await fsPromises.readFile(THUMBNAILS_FILE, 'utf8');
      thumbnails = JSON.parse(data);
    } catch (error) {
      console.warn('Could not read thumbnails file, starting fresh:', error.message);
    }

    // Add new thumbnail at the beginning
    thumbnails.unshift(updatedThumbnail);

    // Save updated thumbnails with retry
    let saveRetries = 0;
    while (saveRetries < 3) {
      try {
        await fsPromises.writeFile(THUMBNAILS_FILE, JSON.stringify(thumbnails, null, 2));
        // Verify the file was written correctly
        const verification = await fsPromises.readFile(THUMBNAILS_FILE, 'utf8');
        JSON.parse(verification); // Make sure it's valid JSON
        break;
      } catch (error) {
        console.error(`Failed to save thumbnails file, attempt ${saveRetries + 1}:`, error);
        saveRetries++;
        if (saveRetries >= 3) {
          return res.status(500).json({ error: 'Failed to save thumbnail metadata' });
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Log the successful image generation for billing
    console.log('Logging successful generation with user info:', userInfo);
    await logApiCall(
      userInfo,
      '/api/thumbnails',
      'POST',
      200,
      { prompt: thumbnail.prompt, settings: thumbnail.settings },
      { success: true, imageUrl: localImageUrl },
      null
    );

    res.json(updatedThumbnail);
  } catch (error) {
    console.error('Error storing thumbnail:', error);
    res.status(500).json({ error: 'Failed to store thumbnail' });
  }
});

// Delete a thumbnail
app.delete('/api/thumbnails/:id', async (req, res) => {
  try {
    const thumbnailUrl = req.params.id;
    
    // Read existing thumbnails
    const data = await fsPromises.readFile(THUMBNAILS_FILE, 'utf8');
    const thumbnails = JSON.parse(data);

    // Filter out the thumbnail to delete
    const updatedThumbnails = thumbnails.filter(t => t.url !== thumbnailUrl);

    // Save updated thumbnails
    await fsPromises.writeFile(THUMBNAILS_FILE, JSON.stringify(updatedThumbnails, null, 2));

    res.json({ message: 'Thumbnail deleted successfully' });
  } catch (error) {
    console.error('Error deleting thumbnail:', error);
    res.status(500).json({ error: 'Failed to delete thumbnail' });
  }
}); 

// Add endpoint to get user logs
app.get('/api/logs', async (req, res) => {
  try {
    const logs = await getUserLogs(req.user?.id || 'anonymous');
    res.json(logs);
  } catch (error) {
    console.error('Error getting logs:', error);
    res.status(500).json({ error: 'Failed to get logs' });
  }
});

// Webhook endpoint for Replicate callbacks
app.post('/api/replicate-webhook', async (req, res) => {
  try {
    const prediction = req.body;
    console.log('Received webhook callback for prediction:', prediction.id);
    console.log('Prediction status:', prediction.status);

    if (prediction.status === 'succeeded') {
      // Get the stored prediction result which contains user info
      const storedResult = predictionResults.get(prediction.id);
      if (!storedResult) {
        console.warn('No stored result found for prediction:', prediction.id);
        return res.sendStatus(200);
      }

      // Update prediction result
      await updatePredictionResult(prediction.id, () => ({
        status: 'completed',
        imageUrl: prediction.output[0],
        completedTime: Date.now()
      }));

      // Log successful image generation for billing
      const userInfo = storedResult.userInfo;
      if (userInfo) {
        await logApiCall(
          userInfo,
          '/api/replicate-webhook',
          'POST',
          200,
          { predictionId: prediction.id },
          { success: true, imageUrl: prediction.output[0] },
          null
        );
      }
    } else if (prediction.status === 'failed') {
      await updatePredictionResult(prediction.id, () => ({
        status: 'failed',
        error: prediction.error || 'Image generation failed',
        completedTime: Date.now()
      }));
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error handling webhook:', error);
    res.sendStatus(500);
  }
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  
  // Initialize directories
  await ensureThumbnailDirectory();
  ensureUploadDirectory();
  
  // Run initial thumbnails cleanup
  await cleanupThumbnails();
  
  // Validate API token and log models
  validateApiToken();
  
  console.log(`Upload directory: ${UPLOADS_DIR}`);
  console.log(`Thumbnail directory: ${THUMBNAIL_DIR}`);
});

// Run cleanup more frequently (every 15 minutes)
setInterval(cleanupThumbnails, 15 * 60 * 1000);