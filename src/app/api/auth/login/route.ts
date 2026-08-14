// ====================================================================
// v7.22: POST /api/auth/login
// Body: { email, password }
// Returns: { success, user?: { id, email, name, role } }
// Sets the whats_odoo_session cookie on success.
// ====================================================================

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyPassword, signSession, buildSessionCookieHeader } from '@/lib/auth'
import type { SessionPayload } from '@/lib/auth'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body.email !== 'string' || typeof body.password !== 'string') {
      return NextResponse.json({ success: false, error: 'Email e senha são obrigatórios' }, { status: 400 })
    }

    const email = body.email.trim().toLowerCase()
    const user = await db.user.findUnique({ where: { email } })

    if (!user || !user.isActive) {
      return NextResponse.json({ success: false, error: 'Credenciais inválidas' }, { status: 401 })
    }

    const ok = await verifyPassword(body.password, user.passwordHash)
    if (!ok) {
      return NextResponse.json({ success: false, error: 'Credenciais inválidas' }, { status: 401 })
    }

    const payload: SessionPayload = {
      userId: user.id,
      email: user.email,
      role: user.role as 'admin' | 'user',
      name: user.name,
    }
    const token = await signSession(payload)

    const response = NextResponse.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    })
    response.headers.set('Set-Cookie', buildSessionCookieHeader(token))
    return response
  } catch (err: any) {
    console.error('[/api/auth/login] error:', err.message)
    return NextResponse.json({ success: false, error: 'Erro interno do servidor' }, { status: 500 })
  }
}
