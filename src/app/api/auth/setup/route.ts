// ====================================================================
// v7.22: POST /api/auth/setup
// Creates the first admin user. Only works if NO users exist yet in the DB.
// Body: { email, password, name }
// This is the bootstrap endpoint — once the first admin exists, this route
// returns 403 to prevent further use.
// ====================================================================

import { NextRequest, NextResponse } from 'next/server'
import { userStore } from '@/lib/user-store'
import { hashPassword, signSession, setSessionCookie } from '@/lib/auth'
import type { SessionPayload } from '@/lib/auth'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    // Security check: only allow if no users exist
    const userCount = await userStore.count()
    if (userCount > 0) {
      return NextResponse.json(
        { success: false, error: 'Setup já foi concluído. Faça login como administrador.' },
        { status: 403 }
      )
    }

    const body = await req.json().catch(() => null)
    if (!body || typeof body.email !== 'string' || typeof body.password !== 'string') {
      return NextResponse.json({ success: false, error: 'Email e senha são obrigatórios' }, { status: 400 })
    }

    if (body.password.length < 6) {
      return NextResponse.json({ success: false, error: 'Senha deve ter pelo menos 6 caracteres' }, { status: 400 })
    }

    const email = body.email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ success: false, error: 'Email inválido' }, { status: 400 })
    }

    const passwordHash = await hashPassword(body.password)
    const user = await userStore.create({
      data: {
        email,
        passwordHash,
        name: body.name?.trim() || null,
        role: 'admin', // First user is always admin
        isActive: true,
      },
    })

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
    // v7.27: use response.cookies.set() for reliable cookie persistence on Next.js 16
    setSessionCookie(response, token)
    return response
  } catch (err: any) {
    console.error('[/api/auth/setup] error:', err.message)
    return NextResponse.json({ success: false, error: 'Erro interno do servidor' }, { status: 500 })
  }
}

// GET: check if setup is needed (any users exist?)
export async function GET() {
  try {
    const userCount = await userStore.count()
    return NextResponse.json({
      success: true,
      needsSetup: userCount === 0,
      userCount,
    })
  } catch (err: any) {
    console.error('[/api/auth/setup GET] error:', err.message)
    return NextResponse.json({ success: false, error: 'Erro interno do servidor' }, { status: 500 })
  }
}
