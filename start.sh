#!/bin/bash
set -e

echo "============================================"
echo "  Whats-Odoo v7.12 Start Script"
echo "  (single-process: Next.js + WA + Odoo)"
echo "============================================"

# [1/4] Create required directories
echo "[1/4] Creating directories..."
mkdir -p /opt/render/project/src/data/auth_store 2>/dev/null || true
mkdir -p ./data/auth_store 2>/dev/null || true

# [2/4] Generate Prisma client
echo "[2/4] Generating Prisma client..."
npx prisma generate

# [3/4] Push DB schema
echo "[3/4] Pushing DB schema..."
npx prisma db push

# [4/4] Start main server (single process: Next.js + WhatsApp + Odoo)
echo "[4/4] Launching single-process server on port ${PORT:-10000}..."
echo "  - Next.js (UI)"
echo "  - WhatsApp (Baileys, in-process)"
echo "  - Odoo (XML-RPC, in-process)"

exec node server.js
