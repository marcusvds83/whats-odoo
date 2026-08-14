#!/bin/bash
set -e

echo "============================================"
echo "  Whats-Odoo v7.26 Start Script"
echo "  (per-user + /admin + login debug + test-login)"
echo "============================================"

# [1/4] Create required directories
echo "[1/4] Creating directories..."
mkdir -p /opt/render/project/src/data 2>/dev/null || true
mkdir -p ./data 2>/dev/null || true

# [2/4] Generate Prisma client
echo "[2/4] Generating Prisma client..."
npx prisma generate

# [3/4] Push DB schema
echo "[3/4] Pushing DB schema..."
npx prisma db push

# [4/4] Start main server (single process: Next.js + per-user WhatsApp + per-user Odoo)
echo "[4/4] Launching single-process server on port ${PORT:-10000}..."
echo "  - Next.js (UI)"
echo "  - WhatsApp (Baileys, in-process, per-user)"
echo "  - Odoo (XML-RPC, in-process, per-user)"

exec node server.js
