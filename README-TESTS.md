# Skoda Visualizer Backend Tests

This directory contains test scripts for the Skoda Visualizer backend API, focusing on image upload and Replicate integration.

## Test Scripts

1. **`test-image-upload.js`**: Tests the file upload API and Replicate integration
   - Tests local file upload via API
   - Tests direct Replicate upload with base64 image
   - Tests server-side image generation with an uploaded file

## Running Tests

In PowerShell, use the semicolon (`;`) to separate commands instead of `&&`:

```powershell
cd backend; node test-image-upload.js
```

In Bash/CMD:

```bash
cd backend && node test-image-upload.js
```

## Test Requirements

The tests require:

1. The backend server to be running in a separate terminal
2. A valid Replicate API token in your `.env` file
3. Node.js dependencies installed (`npm install` if not already done)

## Environment Setup

Create a `.env` file in the backend directory with:

```
REPLICATE_API_TOKEN=your_replicate_api_token
IMGBB_API_KEY=your_imgbb_api_key  # Optional
IMGUR_CLIENT_ID=your_imgur_client_id  # Optional
```

## Understanding the Updates

The backend now supports two methods for handling images:

1. **URL-based approach**: Uploads images to external hosting and sends URLs to Replicate
   - Used for edge/depth/character models that require URL-based images
   - Multiple fallback services are configured for reliability

2. **Direct base64 upload**: Converts images to base64 and sends them directly to Replicate
   - Supported for the standard model
   - More reliable as it avoids dependency on external image hosting

The test script verifies both approaches to ensure reliable image handling.

## Troubleshooting

If the tests fail:

1. Check that your server is running on port 5000
2. Verify your Replicate API token is valid
3. Check network connectivity for external services
4. Look for errors in the test output 