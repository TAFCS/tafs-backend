# Use official Node.js 20 image
FROM node:20-slim

# Install system dependencies
# - postgresql-client: for pg_dump
# - openssl: required for Prisma
# - python3, make, g++: required to build native modules like bcrypt
RUN apt-get update && apt-get install -y \
    postgresql-client \
    openssl \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Copy prisma directory (needed for postinstall 'prisma generate' script)
COPY prisma ./prisma/

# Install dependencies
RUN npm install

# Copy the rest of the source code
COPY . .

# Build the app (this also runs prisma generate again in your build script)
RUN npm run build

# Expose the port
EXPOSE 8080

# Run the app
CMD ["npm", "run", "start:prod"]
