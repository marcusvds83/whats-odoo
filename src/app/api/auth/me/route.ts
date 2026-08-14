// ====================================================================
// v7.22: GET /api/auth/me
// Returns the current authenticated user (or 401 if not logged in).
// Used by the frontend AuthProvider on initial page load.
// ====================================================================

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionFromRequest } from '@/lib/auth'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  try {
    const session = await getSessionFromRequest(req)
    if (!session) {
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
      return NextResponse.json({ success: false, authenticated: false }, { status: 401 })
    }

    return NextResponse.json({
      success: true,
      authenticated: true,
      user,
    })
  } catch (err: any) {
    console.error('[/api/auth/me] error:', err.message)
    return NextResponse.json({ success: false, authenticated: false }, { status: 500 })
  }
}
