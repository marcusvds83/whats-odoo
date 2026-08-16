// ====================================================================
// v7.25: POST /api/auth/setup-admin
// Emergency admin recovery endpoint.
//
// Use case: the admin user was created (e.g. via /admin setup form) but
// something went wrong — wrong password hash, role got set to 'user'
// instead of 'admin', or the user was deactivated. This endpoint lets
// the operator recover WITHOUT direct DB access, by setting an env var.
//
// Usage:
//   1. Set env var ADMIN_SETUP_TOKEN on Render (a long random string)
//   2. POST /api/auth/setup-admin with body:
//      { setupToken: "<the token>", email: "admin@x.com", password: "newpass", name?: "Admin" }
//   3. If a user with that email exists → password reset + role='admin' + isActive=true
//      If not → create new admin user
//   4. Returns the user record (without passwordHash) + sets the session cookie
//
// Security:
//   - Requires ADMIN_SETUP_TOKEN env var. If unset, this endpoint returns 503.
//   - Token must match exactly (constant-time comparison via bcrypt compare
//     would be nicer, but for an emergency endpoint, == is acceptable
//     because the token is a one-shot recovery secret, not a long-lived key).
//   - Rate-limited at the network layer (Render proxy / firewall).
//   - All calls are logged to stdout with timestamp + email.
// ====================================================================

import { NextRequest, NextResponse } from 'next/server'
import { userStore } from '@/lib/user-store'
import { hashPassword, signSession, setSessionCookie } from '@/lib/auth'
import type { SessionPayload } from '@/lib/auth'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const ts = new Date().toISOString()
  try {
    const expectedToken = process.env.ADMIN_SETUP_TOKEN
    if (!expectedToken || expectedToken.length < 16) {
      console.warn(`[${ts}][setup-admin] ADMIN_SETUP_TOKEN not configured or too short — refusing.`)
      return NextResponse.json(
        { success: false, error: 'Endpoint desativado. Configure a variável ADMIN_SETUP_TOKEN (mínimo 16 caracteres) no ambiente.' },
        { status: 503 }
      )
    }

    const body = await req.json().catch(() => null)
    if (
      !body ||
      typeof body.setupToken !== 'string' ||
      typeof body.email !== 'string' ||
      typeof body.password !== 'string'
    ) {
      return NextResponse.json({ success: false, error: 'setupToken, email e password são obrigatórios' }, { status: 400 })
    }

    if (body.setupToken !== expectedToken) {
      console.warn(`[${ts}][setup-admin] Invalid setup token for email=${body.email}`)
      return NextResponse.json({ success: false, error: 'Token inválido' }, { status: 403 })
    }

    if (body.password.length < 6) {
      return NextResponse.json({ success: false, error: 'Senha deve ter pelo menos 6 caracteres' }, { status: 400 })
    }

    const email = body.email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ success: false, error: 'Email inválido' }, { status: 400 })
    }

    const passwordHash = await hashPassword(body.password)
    const name = typeof body.name === 'string' ? body.name.trim() : null

    // Try to find existing user by email
    const existing = await userStore.findUnique({ where: { email } })

    let user
    if (existing) {
      // Promote + reset password + reactivate
      user = await userStore.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          role: 'admin',
          isActive: true,
          ...(name ? { name } : {}),
        },
      })
      console.log(`[${ts}][setup-admin] Promoted existing user ${email} to admin (was role=${existing.role}).`)
    } else {
      // Create new admin
      user = await userStore.create({
        data: {
          email,
          passwordHash,
          name,
          role: 'admin',
          isActive: true,
        },
      })
      console.log(`[${ts}][setup-admin] Created new admin user ${email}.`)
    }

    // Issue session token so the caller is logged in immediately
    const payload: SessionPayload = {
      userId: user.id,
      email: user.email,
      role: 'admin',
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
      message: existing
        ? 'Conta existente promovida para admin e senha redefinida.'
        : 'Novo admin criado.',
    })
    // v7.27: use response.cookies.set() for reliable cookie persistence on Next.js 16
    setSessionCookie(response, token)
    return response
  } catch (err: any) {
    console.error(`[${ts}][setup-admin] error:`, err.message)
    return NextResponse.json({ success: false, error: 'Erro interno do servidor' }, { status: 500 })
  }
}

// GET: returns whether this endpoint is enabled (without revealing the token).
export async function GET() {
  const enabled = !!process.env.ADMIN_SETUP_TOKEN && process.env.ADMIN_SETUP_TOKEN.length >= 16
  return NextResponse.json({
    success: true,
    enabled,
    message: enabled
      ? 'Endpoint de recuperação de admin ativo.'
      : 'Endpoint desativado. Configure ADMIN_SETUP_TOKEN para ativar.',
  })
}
