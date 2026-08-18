// ====================================================================
// v7.27: POST /api/auth/logout
// Clears the session cookie using response.cookies.set() (Next.js 16 API).
// ====================================================================

import { NextResponse } from 'next/server'
import { clearSessionCookie } from '@/lib/auth'

export const runtime = 'nodejs'

export async function POST() {
  const response = NextResponse.json({ success: true })
  clearSessionCookie(response)
  return response
}
