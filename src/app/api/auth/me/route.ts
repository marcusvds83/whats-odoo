// ====================================================================
// v7.27: GET /api/auth/me
// Returns the current authenticated user (or 401 if not logged in).
// Used by the frontend AuthProvider on initial page load.
// v7.27: Added debug logging to trace why /api/auth/me may return 401
//   even right after a successful login.
// ====================================================================

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionFromRequest, getSessionCookieName } from '@/lib/auth'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const ts = new Date().toISOString()
  try {
    const cookieName = getSessionCookieName()
    const cookieHeader = req.headers.get('cookie') || ''
    const hasCookie = cookieHeader.includes(`${cookieName}=`)

    const session = await getSessionFromRequest(req)
    if (!session) {
      console.warn(`[${ts}][/api/auth/me] 401 — hasCookie=${hasCookie} cookieHeaderLen=${cookieHeader.length} cookieNames=[${cookieHeader.split(';').map(p => p.split('=')[0].trim()).filter(Boolean).join(',')}]`)
      return NextResponse.json({ success: false, authenticated: false }, { status: 401 })
    }

    // Fetch fresh user data (in case role/isActive changed since JWT was issued)
    const user = await db.user.findUnique({
      where: { id: session.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        whatsappPhone: true,
        odooUrl: true,
        odooDb: true,
        odooUsername: true,
        // Don't return odooPassword to the browser
      },
    })

    if (!user || !user.isActive) {
      console.warn(`[${ts}][/api/auth/me] 401 — user not found or inactive (userId=${session.userId})`)
      return NextResponse.json({ success: false, authenticated: false }, { status: 401 })
    }

    console.log(`[${ts}][/api/auth/me] 200 — email=${user.email} role=${user.role}`)
    return NextResponse.json({
      success: true,
      authenticated: true,
      user,
    })
  } catch (err: any) {
    console.error(`[${ts}][/api/auth/me] error:`, err.message)
    return NextResponse.json({ success: false, authenticated: false }, { status: 500 })
  }
}
