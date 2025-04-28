# Script to start the Skoda Visualizer server
Write-Host "Starting Skoda Visualizer server..."

# Check if .env file exists
if (-not (Test-Path -Path ".env")) {
    Write-Host "Warning: .env file not found. Creating a sample .env file."
    @"
# Replicate API Token - REQUIRED
REPLICATE_API_TOKEN=your_token_here

# Optional settings
PORT=5000
IMGBB_API_KEY=58b111dccac952a08f78f8e8c1b2b0e3
IMGUR_CLIENT_ID=546c25a59c58ad7
"@ | Out-File -FilePath ".env"
    
    Write-Host "A sample .env file has been created. Please edit it to add your Replicate API token."
    Write-Host "Then run this script again."
    exit 1
}

# Check if the REPLICATE_API_TOKEN is set in .env
$envContent = Get-Content -Path ".env" -Raw
if ($envContent -match "REPLICATE_API_TOKEN=your_token_here" -or -not ($envContent -match "REPLICATE_API_TOKEN=")) {
    Write-Host "Error: REPLICATE_API_TOKEN is not set in .env file."
    Write-Host "Please edit the .env file and add your Replicate API token."
    exit 1
}

# Ensure the uploads directory exists
$uploadsDir = Join-Path -Path "." -ChildPath "uploads"
if (-not (Test-Path -Path $uploadsDir)) {
    Write-Host "Creating uploads directory..."
    New-Item -Path $uploadsDir -ItemType Directory | Out-Null
}

# Try to run the server, handling common errors
try {
    # Check if port 5000 is already in use
    $portInUse = Get-NetTCPConnection | Where-Object { $_.LocalPort -eq 5000 -and $_.State -eq "Listen" } -ErrorAction SilentlyContinue
    
    if ($portInUse) {
        Write-Host "Warning: Port 5000 is already in use."
        Write-Host "Would you like to use an alternative port? (Y/N)"
        $response = Read-Host
        
        if ($response -eq "Y" -or $response -eq "y") {
            # Update the .env file with a new port
            $newPort = 5001
            
            if ($envContent -match "PORT=\d+") {
                $envContent = $envContent -replace "PORT=\d+", "PORT=$newPort"
            } else {
                $envContent += "`nPORT=$newPort"
            }
            
            $envContent | Out-File -FilePath ".env" -NoNewline
            Write-Host "Updated .env file to use port $newPort."
        } else {
            Write-Host "Please stop the process using port 5000 and try again."
            exit 1
        }
    }
    
    # Start the server
    Write-Host "Starting server..."
    node src/server.js
} catch {
    Write-Host "Error starting server: $_"
    exit 1
} 