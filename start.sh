#!/bin/bash
set -e

echo "============================================"
echo "  Whats-Odoo v7.9 Start Script"
echo "============================================"

# [1/5] Create required directories
echo "[1/5] Creating directories..."
mkdir -p /opt/render/project/src/data/auth_store 2>/dev/null || true
mkdir -p ./data/auth_store 2>/dev/null || true

# [2/5] Generate Prisma client
echo "[2/5] Generating Prisma client..."
npx prisma generate

# [3/5] Push DB schema
echo "[3/5] Pushing DB schema..."
npx prisma db push

# [4/5] Start WhatsApp service in background
echo "[4/5] Starting WhatsApp service (port 3001)..."
npx tsx mini-services/whatsapp-service/index.ts > /tmp/wa-service.log 2>&1 &
WA_PID=$!
echo "  WhatsApp service PID: $WA_PID"

echo "  Waiting for WhatsApp service to be ready..."
for i in $(seq 1 20); do
  if curl -s http://localhost:3001 > /dev/null 2>&1; then
    echo "  WhatsApp service is ready! (after ${i}s)"
    break
  fi
  if ! kill -0 $WA_PID 2>/dev/null; then
    echo "  ERROR: WhatsApp service died during startup. Logs:"
    cat /tmp/wa-service.log
    exit 1
  fi
  sleep 1
done

# [5/5] Start Odoo service in background
echo "[5/5] Starting Odoo service (port 3002)..."
npx tsx mini-services/odoo-service/index.ts > /tmp/odoo-service.log 2>&1 &
ODOO_PID=$!
echo "  Odoo service PID: $ODOO_PID"

echo "  Waiting for Odoo service to be ready..."
for i in $(seq 1 15); do
  if curl -s http://localhost:3002 > /dev/null 2>&1; then
    echo "  Odoo service is ready! (after ${i}s)"
    break
  fi
  if ! kill -0 $ODOO_PID 2>/dev/null; then
    echo "  WARNING: Odoo service died during startup. Logs:"
    cat /tmp/odoo-service.log
    break
  fi
  sleep 1
done

echo "============================================"
echo "  All services started. Launching main server on port ${PORT:-10000}..."
echo "============================================"

cleanup() {
  echo ""
  echo "[Shutdown] Cleaning up background services..."
  kill $WA_PID 2>/dev/null || true
  kill $ODOO_PID 2>/dev/null || true
  wait $WA_PID 2>/dev/null || true
  wait $ODOO_PID 2>/dev/null || true
  echo "[Shutdown] Done."
  exit 0
}

trap cleanup SIGTERM SIGINT

exec node server.js
