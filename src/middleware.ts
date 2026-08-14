// ====================================================================
// v7.27: Next.js middleware — protects all routes except public ones.
// v7.27: Added debug logging to trace cookie presence + JWT verification.
// v7.25: /admin is now a public admin login page (separate from /login).
// v7.25: /api/auth/setup-admin is the emergency admin recovery endpoint.
// Reads the whats_odoo_session cookie, verifies the JWT, and redirects
// unauthenticated users to /login.
// ====================================================================

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { verifySession, getSessionCookieName } from '@/lib/auth'

// Routes that don't require authentication
const PUBLIC_ROUTES = [
  '/login',
  '/admin',                          // v7.25: admin login page
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/setup',
  '/api/auth/setup-admin',           // v7.25: emergency admin recovery
]

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some(route => pathname === route || pathname.startsWith(route + '/'))
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  // Allow public routes
  if (isPublicRoute(pathname)) {
    return NextResponse.next()
  }

  // Allow static assets and Next.js internals
  if (
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/static/') ||
    pathname.startsWith('/media/') ||  // v7.22: media files are served by server.js
    pathname === '/favicon.ico' ||
    pathname === '/robots.txt' ||
    pathname === '/logo.svg' ||
    pathname === '/logo.png' ||
    pathname === '/logo.jpg'
  ) {
    return NextResponse.next()
  }

  // v7.27: debug logging — trace cookie presence on protected routes
  const cookieName = getSessionCookieName()
  const token = req.cookies.get(cookieName)?.value
  const ts = new Date().toISOString()

  if (!token) {
    console.warn(`[${ts}][middleware] NO COOKIE on ${pathname} — cookie names present: [${req.cookies.getAll().map(c => c.name).join(', ')}]`)
    // For API routes, return 401 JSON
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ success: false, error: 'Não autenticado' }, { status: 401 })
    }
    // For pages, redirect to /login
    const loginUrl = new URL('/login', req.url)
    loginUrl.searchParams.set('redirect', pathname)
    return NextResponse.redirect(loginUrl)
  }

  const session = await verifySession(token)
  if (!session) {
    // Invalid/expired token
    console.warn(`[${ts}][middleware] INVALID/EXPIRED JWT on ${pathname} — tokenLen=${token.length}`)
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ success: false, error: 'Sessão expirada' }, { status: 401 })
    }
    const loginUrl = new URL('/login', req.url)
    loginUrl.searchParams.set('redirect', pathname)
    return NextResponse.redirect(loginUrl)
  }

  // v7.27: successful auth — log only /api/auth/me hits (to keep logs clean)
  if (pathname === '/api/auth/me') {
    console.log(`[${ts}][middleware] OK /api/auth/me — session.userId=${session.userId} role=${session.role}`)
  }

  // Admin-only API routes
  if (pathname.startsWith('/api/users') && session.role !== 'admin') {
    return NextResponse.json({ success: false, error: 'Acesso restrito a administradores' }, { status: 403 })
  }

  return NextResponse.next()
}

export const config = {
  // Run on all routes except static asset optimizations
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico, robots.txt, logo.*
     */
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|logo.svg|logo.png|logo.jpg).*)',
  ],
}
