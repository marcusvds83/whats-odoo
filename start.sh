#!/bin/bash
set -e

echo "============================================"
echo "  Whats-Odoo Start Script"
echo "============================================"

# Create required directories
echo "[1/7] Creating directories..."
mkdir -p /opt/render/project/src/data/auth_store

# Generate Prisma client
echo "[2/7] Generating Prisma client..."
npx prisma generate

# Push DB schema (creates tables if not exist)
echo "[3/7] Pushing DB schema..."
npx prisma db push

# Install mini-service dependencies
echo "[4/7] Installing mini-service dependencies..."
cd mini-services/whatsapp-service && npm install && cd ../..
cd mini-services/odoo-service && npm install && cd ../..

# Build Next.js (ensures .next directory exists)
echo "[5/7] Building Next.js..."
NODE_OPTIONS='--max-old-space-size=4096' npx next build

# Start mini-services in background
echo "[6/7] Starting mini-services..."
npx tsx mini-services/whatsapp-service/index.ts &
npx tsx mini-services/odoo-service/index.ts &
sleep 3

# Start main server
echo "[7/7] Starting main server on port ${PORT:-10000}..."
exec node server.js
