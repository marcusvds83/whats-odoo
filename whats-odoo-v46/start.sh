#!/bin/bash
# Whats-Odoo v3.1 — Start Script (BACKUP - Render uses npm run start)
# This script is kept as a fallback. Render's startCommand is "npm run start".
set -e

echo "============================================"
echo "  Whats-Odoo v3.1 Start (single-process)"
echo "============================================"

# Create required directories
echo "[1/3] Creating directories..."
mkdir -p ${DATA_DIR:-./data}/auth_store

# Push DB schema (creates tables if not exist)
echo "[2/3] Pushing DB schema..."
npx prisma db push --skip-generate 2>/dev/null || true

# Start single-process server
echo "[3/3] Starting server..."
exec NODE_OPTIONS='--max-old-space-size=384' node server.js
