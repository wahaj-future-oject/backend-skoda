# Skoda Visualizer Backend

This is the backend for the Skoda Visualizer application, providing API endpoints for image generation and file upload.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create a `.env` file in the backend directory with your Replicate API token:

```
REPLICATE_API_TOKEN=your_replicate_token_here
IMGBB_API_KEY=optional_imgbb_api_key
IMGUR_CLIENT_ID=optional_imgur_client_id
```

## Running the Server

### Easiest Method (PowerShell Script)

We've included a PowerShell script that handles common errors and checks:

```powershell
.\start-server.ps1
```

This script:
- Checks if the .env file exists and creates it if missing
- Verifies the Replicate API token is configured
- Handles port conflicts automatically
- Ensures the uploads directory exists

### Manual Methods

#### From the project root folder:

```powershell
node backend/src/server.js
```

#### From inside the backend folder:

```powershell
node src/server.js
```

This will start the server on port 5000.

> **Note:** If you're seeing port conflicts (`EADDRINUSE` error), change the port in your `.env` file:
> ```
> PORT=5001
> ```

## API Endpoints

### Generate Image

`POST /api/generate-image`

Generates an image using Replicate's Flux models.

**Request Body:**

```json
{
  "prompt": "A car in a mountain landscape",
  "engineType": "standard",
  "settings": {
    "aspectRatio": "1:1",
    "steps": 30,
    "guidance": 7.5,
    "characterImage": "",
    "compositionImage": ""
  }
}
```

### Upload File

`POST /api/upload`

Uploads an image file to the server.

**Request Body:**
- Form data with an 'image' field containing the file.

**Response:**
```json
{
  "imagePath": "http://localhost:5000/uploads/filename.jpg",
  "localFilePath": "filename.jpg",
  "filename": "filename.jpg",
  "message": "File uploaded successfully"
}
```

### Test Data URI Creation

`POST /api/test-replicate-upload`

Creates a data URI from an uploaded image and uses it with a test model prediction.

**Request Body:**
- Form data with an 'image' field containing the file.

**Response:**
```json
{
  "success": true,
  "dataUri": "data:image/jpeg;base64,/9j/4AAQSkZJRgABA...",
  "predictionId": "abcd1234",
  "message": "File uploaded and data URI created successfully"
}
```

## Engine Types

The backend supports four different image generation models:

1. **standard** - Flux 1.1 Pro for general image creation
2. **edge** - Flux Canny Pro for edge-guided image generation
3. **depth** - Flux Depth Pro for depth-guided image generation
4. **character** - Flux Pulid for character-focused generation

## Image Handling

The backend uses data URIs for direct image upload to Replicate models:

1. **Data URIs** - Images are converted to data URIs and sent directly to Replicate's API. This approach works well for all model types and avoids the need for external hosting services. The data URI is passed directly to the `control_image` parameter.

2. **Multiple Fallback Layers** - If the primary methods fail, the backend tries multiple alternative approaches with proper error handling.

## Testing

The backend includes several test scripts:

### Test with Data URIs

```bash
node test-replicate-upload.js
```

Tests the data URI creation and usage with the edge model. This script:
- Finds an image in the uploads directory
- Converts it to a data URI
- Uses the data URI to create a prediction with the edge model
- Displays the result

This is the recommended way to test your Replicate API token with proper image handling.

### Test All Models

```bash
node test-all-models.js
```

Runs a comprehensive test of all four model types using the data URI approach.

## Troubleshooting

If you encounter errors when running the server:

1. **"control_image is required" Error** - This means you're trying to use an edge/depth model without a proper data URI or image URL. Make sure your images are being converted to data URIs using the new upload functionality.

2. **PowerShell Command Syntax** - Make sure to use semicolons (;) not ampersands (&&) to chain commands in PowerShell

3. **Port Already in Use** - If port 5000 is already in use, modify the PORT value in your .env file

## How Data URI Upload Works

The backend uses a simple process to prepare images for Replicate's API:

1. **Read the image file** from the uploads directory
2. **Determine the MIME type** based on the file extension (jpg, png, etc.)
3. **Convert to base64** and format as a data URI (`data:image/jpeg;base64,...`)
4. **Use the data URI directly** with Replicate's API as the `control_image` parameter

This approach is simpler and more reliable than using external image hosting services, and works well for all Replicate models. #   b a c k e n d - s k o d a  
 