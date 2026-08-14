// ====================================================================
// v7.27: Auth utilities — JWT-based session using jose (edge-compatible)
// Passwords hashed with bcryptjs. Session cookie name: whats_odoo_session
// v7.27 FIX: Switched from response.headers.set('Set-Cookie', ...) to
//   response.cookies.set({...}) — the Next.js 16 recommended API.
//   The old headers.set() approach was silently dropping the Set-Cookie
//   header on some deployments, causing login to "succeed" server-side
//   but the cookie never reached the browser, so the next navigation
//   to / was redirected back to /login by the middleware.
// ====================================================================

import bcrypt from 'bcryptjs'
import { SignJWT, jwtVerify } from 'jose'
import type { NextResponse } from 'next/server'

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

// Build the Set-Cookie header value for login/logout (legacy — still used by
// auth-edge.cjs which runs in the custom server.js CommonJS context).
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

// ====================================================================
// v7.27: PREFERRED cookie helpers — use response.cookies.set() which is
// the Next.js 16 recommended API. The old response.headers.set('Set-Cookie')
// approach was unreliable on Next.js 16 + custom server setups.
// ====================================================================

export function setSessionCookie(
  response: NextResponse,
  token: string,
  maxAgeSeconds: number = SESSION_TTL_SECONDS
): void {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeSeconds,
  })
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  })
}
