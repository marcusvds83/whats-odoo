// ====================================================================
// v7.23: CommonJS wrapper around the JWT helpers in src/lib/auth.ts
//
// WHY THIS EXISTS:
//   server.js is a CommonJS module. It needs to verify JWT session tokens
//   on incoming socket.io connections (so each user only sees their own
//   WhatsApp/Odoo data). The JWT signing/verification logic lives in
//   src/lib/auth.ts which uses ESM + TypeScript — incompatible with a
//   plain `require()`.
//
//   This file re-implements the small subset of functions server.js needs,
//   in plain CommonJS, using the same `jose` library and the same
//   JWT_SECRET env var. Tokens signed by auth.ts verify correctly here
//   and vice-versa.
//
// EXPORTED FUNCTIONS:
//   - getSessionCookieName()  → 'whats_odoo_session'
//   - parseCookies(header)    → { [name]: value }
//   - verifySession(token)    → Promise<{ userId, email, role, name } | null>
//   - signSession(payload)    → Promise<string>  (for completeness)
// ====================================================================

const { SignJWT, jwtVerify } = require('jose')

const JWT_SECRET = process.env.JWT_SECRET || 'whats-odoo-dev-secret-change-in-prod-please-very-long'
const SESSION_COOKIE = 'whats_odoo_session'
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7 // 7 days

// Encode the secret as Uint8Array (jose requires this)
const secretBytes = new TextEncoder().encode(JWT_SECRET)

function getSessionCookieName() {
  return SESSION_COOKIE
}

function getSessionTtl() {
  return SESSION_TTL_SECONDS
}

// Parse cookies from a Cookie header string
function parseCookies(cookieHeader) {
  if (!cookieHeader) return {}
  const cookies = {}
  for (const pair of String(cookieHeader).split(';')) {
    const idx = pair.indexOf('=')
    if (idx < 0) continue
    const key = pair.slice(0, idx).trim()
    const val = pair.slice(idx + 1).trim()
    if (key) {
      try {
        cookies[key] = decodeURIComponent(val)
      } catch {
        cookies[key] = val
      }
    }
  }
  return cookies
}

async function signSession(payload) {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretBytes)
}

async function verifySession(token) {
  if (!token || typeof token !== 'string') return null
  try {
    const { payload } = await jwtVerify(token, secretBytes)
    if (
      typeof payload.userId === 'string' &&
      typeof payload.email === 'string' &&
      typeof payload.role === 'string'
    ) {
      return {
        userId: payload.userId,
        email: payload.email,
        role: payload.role,
        name: payload.name || null,
      }
    }
    return null
  } catch {
    return null
  }
}

module.exports = {
  getSessionCookieName,
  getSessionTtl,
  parseCookies,
  signSession,
  verifySession,
  SESSION_COOKIE,
}
