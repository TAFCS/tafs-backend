# Use official Node.js 20 image
FROM node:20-slim

# Install system dependencies
# 1. Add official PostgreSQL repository to get version 18 client
# 2. Install postgresql-client-18, openssl, and build tools
RUN apt-get update && apt-get install -y wget gnupg2 lsb-release \
    && sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list' \
    && wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | apt-key add - \
    && apt-get update \
    && apt-get install -y \
    postgresql-client-18 \
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

# Build the app
RUN npm run build

# Expose the port
EXPOSE 8080

# Run the app
CMD ["npm", "run", "start:prod"]
