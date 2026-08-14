// ====================================================================
// v7.22: Auth utilities — JWT-based session using jose (edge-compatible)
// Passwords hashed with bcryptjs. Session cookie name: whats_odoo_session
// ====================================================================

import bcrypt from 'bcryptjs'
import { SignJWT, jwtVerify } from 'jose'

const JWT_SECRET = process.env.JWT_SECRET || 'whats-odoo-dev-secret-change-in-prod-please-very-long'
const SESSION_COOKIE = 'whats_odoo_session'
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7 // 7 days

// Encode the secret as Uint8Array (jose requires this)
const secretBytes = new TextEncoder().encode(JWT_SECRET)

export interface SessionPayload {
  userId: string
  email: string
  role: 'admin' | 'user'
  name?: string | null
}

// ===== Password hashing =====
export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(10)
  return bcrypt.hash(password, salt)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash)
  } catch {
    return false
  }
}

// ===== JWT signing / verification =====
export async function signSession(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretBytes)
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
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
        role: payload.role as 'admin' | 'user',
        name: (payload as any).name || null,
      }
    }
    return null
  } catch {
    return null
  }
}

// ===== Cookie helpers (for server-side API routes) =====
export function getSessionCookieName(): string {
  return SESSION_COOKIE
}

export function getSessionTtl(): number {
  return SESSION_TTL_SECONDS
}

// Parse cookies from a Cookie header string
export function parseCookies(cookieHeader: string | null | undefined): Record<string, string> {
  if (!cookieHeader) return {}
  const cookies: Record<string, string> = {}
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=')
    if (idx < 0) continue
    const key = pair.slice(0, idx).trim()
    const val = pair.slice(idx + 1).trim()
    if (key) cookies[key] = decodeURIComponent(val)
  }
  return cookies
}

// Read session from a Request (Next.js API route)
export async function getSessionFromRequest(req: Request): Promise<SessionPayload | null> {
  const cookieHeader = req.headers.get('cookie')
  const cookies = parseCookies(cookieHeader)
  const token = cookies[SESSION_COOKIE]
  if (!token) return null
  return verifySession(token)
}

// Build the Set-Cookie header value for login/logout
export function buildSessionCookieHeader(token: string, maxAgeSeconds: number = SESSION_TTL_SECONDS): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${
    process.env.NODE_ENV === 'production' ? '; Secure' : ''
  }`
}

export function buildClearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${
    process.env.NODE_ENV === 'production' ? '; Secure' : ''
  }`
}
