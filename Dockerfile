FROM node:18-slim

WORKDIR /app

# Copy package files first to leverage Docker cache
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the application
COPY . .

# Create uploads directory
RUN mkdir -p uploads && chmod 777 uploads

# Expose the server port
EXPOSE 5000

# Start the server
CMD ["node", "src/server.js"] 