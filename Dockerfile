# Use Node.js with Debian for easy Ghostscript installation
FROM node:18-bullseye-slim

# Install Ghostscript and ImageMagick
RUN apt-get update && apt-get install -y \
    ghostscript \
    imagemagick \
    libgs-dev \
    && rm -rf /var/lib/apt/lists/*

# Fix ImageMagick policy to allow PDF operations
RUN sed -i 's/rights="none" pattern="PDF"/rights="read|write" pattern="PDF"/' /etc/ImageMagick-6/policy.xml || true

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy source code
COPY . .

# Create temp directory
RUN mkdir -p /tmp/pdf-processing

# Expose port
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
