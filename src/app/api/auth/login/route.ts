// ====================================================================
// v7.27: POST /api/auth/login
// Body: { email, password, requireAdmin?: boolean }
//   - requireAdmin=true: only allow users with role='admin' (used by /admin page)
// Returns: { success, user?: { id, email, name, role } }
// Sets the whats_odoo_session cookie on success.
// v7.27 FIX: Use response.cookies.set() instead of response.headers.set()
//   ('Set-Cookie', ...) — the old approach silently dropped the cookie
//   on Next.js 16, causing login to succeed server-side but the session
//   never persisted in the browser.
// ====================================================================

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyPassword, signSession, setSessionCookie } from '@/lib/auth'
import type { SessionPayload } from '@/lib/auth'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const ts = new Date().toISOString()
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body.email !== 'string' || typeof body.password !== 'string') {
      console.warn(`[${ts}][login] Bad request — missing email/password`)
      return NextResponse.json({ success: false, error: 'Email e senha são obrigatórios' }, { status: 400 })
    }

    const requireAdmin: boolean = body.requireAdmin === true
    const email = body.email.trim().toLowerCase()
    const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown'

    console.log(`[${ts}][login] Attempt: email="${email}" requireAdmin=${requireAdmin} ip=${clientIp} pwdLen=${body.password.length}`)

    const user = await db.user.findUnique({ where: { email } })

    if (!user) {
      console.warn(`[${ts}][login] FAIL: user not found for email="${email}"`)
      return NextResponse.json({ success: false, error: 'Credenciais inválidas' }, { status: 401 })
    }

    if (!user.isActive) {
      console.warn(`[${ts}][login] FAIL: user "${email}" is deactivated (isActive=false)`)
      return NextResponse.json({ success: false, error: 'Credenciais inválidas' }, { status: 401 })
    }

    console.log(`[${ts}][login] User found: id=${user.id} role=${user.role} hashPrefix=${user.passwordHash.substring(0, 7)}...`)

    const ok = await verifyPassword(body.password, user.passwordHash)
    if (!ok) {
      console.warn(`[${ts}][login] FAIL: bcrypt compare returned false for email="${email}" (pwdLen=${body.password.length} hashLen=${user.passwordHash.length})`)
      return NextResponse.json({ success: false, error: 'Credenciais inválidas' }, { status: 401 })
    }

    console.log(`[${ts}][login] OK: password verified for email="${email}"`)

    // v7.25: enforce admin-only login when requireAdmin flag is set
    if (requireAdmin && user.role !== 'admin') {
      console.warn(`[${ts}][login] FAIL: requireAdmin=true but user "${email}" has role=${user.role}`)
      return NextResponse.json({
        success: false,
        error: 'Esta conta não tem privilégio de administrador. Use o login normal em /login.',
      }, { status: 403 })
    }

    const payload: SessionPayload = {
      userId: user.id,
      email: user.email,
      role: user.role as 'admin' | 'user',
      name: user.name,
    }
    const token = await signSession(payload)

    console.log(`[${ts}][login] SUCCESS: issued session for email="${email}" role=${user.role} tokenLen=${token.length}`)

    const response = NextResponse.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    })
    // v7.27: use response.cookies.set() — the Next.js 16 recommended API.
    setSessionCookie(response, token)
    console.log(`[${ts}][login] Cookie set via response.cookies.set() — name=whats_odoo_session secure=${process.env.NODE_ENV === 'production'}`)
    return response
  } catch (err: any) {
    console.error(`[${ts}][login] ERROR:`, err.message, err.stack)
    return NextResponse.json({ success: false, error: 'Erro interno do servidor' }, { status: 500 })
  }
}
