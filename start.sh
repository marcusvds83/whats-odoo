#!/bin/bash
set -e

echo "============================================"
echo "  Whats-Odoo v7.8 Start Script"
echo "============================================"

# Create required directories
echo "[1/6] Creating directories..."
mkdir -p /opt/render/project/src/data/auth_store 2>/dev/null || true
mkdir -p ./data/auth_store 2>/dev/null || true

# Generate Prisma client (fast, no network if already generated)
echo "[2/6] Generating Prisma client..."
npx prisma generate

# Push DB schema (creates tables if not exist)
echo "[3/6] Pushing DB schema..."
npx prisma db push

# Install mini-service dependencies (if needed)
echo "[4/6] Checking mini-service dependencies..."
if [ ! -d "mini-services/whatsapp-service/node_modules" ] || [ ! -d "mini-services/odoo-service/node_modules" ]; then
  echo "Installing mini-service dependencies..."
  (cd mini-services/whatsapp-service && npm install --omit=dev 2>&1 | tail -3) || true
  (cd mini-services/odoo-service && npm install --omit=dev 2>&1 | tail -3) || true
fi

# Start WhatsApp service in background
echo "[5/6] Starting WhatsApp service (port 3001)..."
npx tsx mini-services/whatsapp-service/index.ts > /tmp/wa-service.log 2>&1 &
WA_PID=$!
echo "  WhatsApp service PID: $WA_PID"

# Wait for WhatsApp service to be ready (max 15 seconds)
echo "  Waiting for WhatsApp service to be ready..."
for i in $(seq 1 15); do
  if curl -s http://localhost:3001 > /dev/null 2>&1; then
    echo "  WhatsApp service is ready! (after ${i}s)"
    break
  fi
  # Check if process died
  if ! kill -0 $WA_PID 2>/dev/null; then
    echo "  ERROR: WhatsApp service died during startup. Logs:"
    cat /tmp/wa-service.log
    exit 1
  fi
  sleep 1
done

# Start Odoo service in background
echo "[6/6] Starting Odoo service (port 3002)..."
npx tsx mini-services/odoo-service/index.ts > /tmp/odoo-service.log 2>&1 &
ODOO_PID=$!
echo "  Odoo service PID: $ODOO_PID"

# Wait for Odoo service to be ready (max 10 seconds)
echo "  Waiting for Odoo service to be ready..."
for i in $(seq 1 10); do
  if curl -s http://localhost:3002 > /dev/null 2>&1; then
    echo "  Odoo service is ready! (after ${i}s)"
    break
  fi
  if ! kill -0 $ODOO_PID 2>/dev/null; then
    echo "  WARNING: Odoo service died during startup. Logs:"
    cat /tmp/odoo-service.log
    # Continue anyway — Odoo is optional
    break
  fi
  sleep 1
done

echo "============================================"
echo "  All services started. Launching main server on port ${PORT:-10000}..."
echo "============================================"

# Cleanup function — kill background services when server exits
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

# Start main Next.js server (foreground) — this is the long-running process
# Render expects this to be the main process
exec node server.js
