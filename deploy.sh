#!/bin/bash
# Exit immediately if a command exits with a non-zero status
set -e

echo "🚀 Starting Tafs Backend deployment update..."

# 1. Pull latest code from GitHub
echo "📥 Pulling latest code..."
git pull origin main

# 2. Build and restart containers (NestJS app rebuilds, database restarts if configs change)
echo "📦 Rebuilding and starting containers..."
docker-compose up -d --build

# 3. Apply any new Prisma database migrations
echo "🗄️ Applying database migrations..."
docker-compose exec -T app npx prisma migrate deploy

# 4. Clean up unused old Docker images to save disk space
echo "🧹 Cleaning up old Docker images..."
docker image prune -f

echo "✅ Tafs Backend deployment update completed successfully!"
