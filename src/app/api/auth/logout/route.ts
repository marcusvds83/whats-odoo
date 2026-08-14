// ====================================================================
// v7.22: POST /api/auth/logout
// Clears the session cookie.
// ====================================================================

import { NextResponse } from 'next/server'
import { buildClearSessionCookieHeader } from '@/lib/auth'

export const runtime = 'nodejs'

export async function POST() {
  const response = NextResponse.json({ success: true })
  response.headers.set('Set-Cookie', buildClearSessionCookieHeader())
  return response
}
