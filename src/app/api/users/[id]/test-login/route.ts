// ====================================================================
// v7.26: POST /api/users/[id]/test-login
// Admin-only diagnostic endpoint to test if a user's password works.
//
// Body: { password: string }
// Returns: {
//   success: true,
//   found: boolean,
//   isActive: boolean,
//   role: string,
//   passwordOk: boolean,    <- true if bcrypt compare succeeds
//   hashPrefix: string,     <- first 10 chars of stored hash (for debugging)
//   hashLength: number,
// }
//
// This endpoint does NOT issue a session. It only verifies the password.
// Use case: admin wants to debug why a user can't login — they can test
// the password directly without impersonating the user.
// ====================================================================

import { NextRequest, NextResponse } from 'next/server'
import { userStore } from '@/lib/user-store'
import { getSessionFromRequest, verifyPassword, hashPassword } from '@/lib/auth'

export const runtime = 'nodejs'

async function requireAdmin(req: NextRequest) {
  const session = await getSessionFromRequest(req)
  if (!session) return { error: NextResponse.json({ success: false, error: 'Não autenticado' }, { status: 401 }) }
  if (session.role !== 'admin') return { error: NextResponse.json({ success: false, error: 'Acesso restrito a administradores' }, { status: 403 }) }
  return { session }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req)
  if ('error' in auth) return auth.error

  const ts = new Date().toISOString()
  try {
    const { id } = await params
    const body = await req.json().catch(() => null)
    if (!body || typeof body.password !== 'string') {
      return NextResponse.json({ success: false, error: 'password é obrigatório' }, { status: 400 })
    }

    const user = await userStore.findUnique({ where: { id } })
    if (!user) {
      console.warn(`[${ts}][test-login] User not found: id=${id}`)
      return NextResponse.json({
        success: true,
        found: false,
        isActive: false,
        role: null,
        passwordOk: false,
        hashPrefix: null,
        hashLength: 0,
      })
    }

    const passwordOk = await verifyPassword(body.password, user.passwordHash)

    console.log(`[${ts}][test-login] id=${id} email="${user.email}" role=${user.role} isActive=${user.isActive} pwdLen=${body.password.length} hashLen=${user.passwordHash.length} passwordOk=${passwordOk}`)

    return NextResponse.json({
      success: true,
      found: true,
      isActive: user.isActive,
      role: user.role,
      passwordOk,
      hashPrefix: user.passwordHash.substring(0, 10),
      hashLength: user.passwordHash.length,
      // Helpful: also test what the hash of the provided password would be
      // (so admin can verify bcryptjs itself is working)
      providedHashPreview: (await hashPassword(body.password)).substring(0, 10),
    })
  } catch (err: any) {
    console.error(`[${ts}][test-login] ERROR:`, err.message, err.stack)
    return NextResponse.json({ success: false, error: 'Erro interno do servidor' }, { status: 500 })
  }
}
