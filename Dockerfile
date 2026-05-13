# Use official Node.js 20 image
FROM node:20-slim

# Install system dependencies
# - postgresql-client: for pg_dump
# - openssl: required for Prisma
RUN apt-get update && apt-get install -y \
    postgresql-client \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build the app
RUN npm run build

# Expose the port (Railway handles this, but good practice)
EXPOSE 8080

# Run the app
CMD ["npm", "run", "start:prod"]
