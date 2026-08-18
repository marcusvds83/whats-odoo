// ====================================================================
// v7.22: GET /api/users — list all users (admin only)
// POST /api/users — create a new user (admin only)
// ====================================================================

import { NextRequest, NextResponse } from 'next/server'
import { userStore } from '@/lib/user-store'
import { getSessionFromRequest, hashPassword } from '@/lib/auth'

export const runtime = 'nodejs'

async function requireAdmin(req: NextRequest) {
  const session = await getSessionFromRequest(req)
  if (!session) return { error: NextResponse.json({ success: false, error: 'Não autenticado' }, { status: 401 }) }
  if (session.role !== 'admin') return { error: NextResponse.json({ success: false, error: 'Acesso restrito a administradores' }, { status: 403 }) }
  return { session }
}

// GET: list all users
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req)
  if ('error' in auth) return auth.error

  try {
    const all = await userStore.findMany()
    // Return only the safe fields (never passwordHash / odooPassword).
    const users = all.map(u => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      isActive: u.isActive,
      whatsappPhone: u.whatsappPhone,
      odooUrl: u.odooUrl,
      odooDb: u.odooDb,
      odooUsername: u.odooUsername,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    }))
    return NextResponse.json({ success: true, users })
  } catch (err: any) {
    console.error('[/api/users GET] error:', err.message)
    return NextResponse.json({ success: false, error: 'Erro interno do servidor' }, { status: 500 })
  }
}

// POST: create a new user
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if ('error' in auth) return auth.error

  try {
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

    // Check if email is already taken
    const existing = await userStore.findUnique({ where: { email } })
    if (existing) {
      return NextResponse.json({ success: false, error: 'Email já cadastrado' }, { status: 409 })
    }

    const passwordHash = await hashPassword(body.password)
    const created = await userStore.create({
      data: {
        email,
        passwordHash,
        name: body.name?.trim() || null,
        role: body.role === 'admin' ? 'admin' : 'user',
        isActive: body.isActive !== false,
        whatsappPhone: body.whatsappPhone?.trim() || null,
        odooUrl: body.odooUrl?.trim() || null,
        odooDb: body.odooDb?.trim() || null,
        odooUsername: body.odooUsername?.trim() || null,
        odooPassword: body.odooPassword?.trim() || null,
      },
    })

    const user = {
      id: created.id,
      email: created.email,
      name: created.name,
      role: created.role,
      isActive: created.isActive,
      whatsappPhone: created.whatsappPhone,
      odooUrl: created.odooUrl,
      odooDb: created.odooDb,
      odooUsername: created.odooUsername,
      createdAt: created.createdAt,
    }

    return NextResponse.json({ success: true, user })
  } catch (err: any) {
    console.error('[/api/users POST] error:', err.message, err.stack)

    // v7.31: Surface Firestore write-verification failures with a clear,
    // actionable message. The default 500 "Erro interno do servidor"
    // gave the admin no idea what went wrong — they would see "user
    // created" but the user wasn't actually in Firebase, and login
    // would fail. Now we detect Firestore-specific errors and tell
    // the admin to check their FIREBASE_SERVICE_ACCOUNT env var.
    const msg = String(err?.message || '')
    if (msg.includes('Firestore write verification failed')) {
      return NextResponse.json({
        success: false,
        error: 'Falha ao salvar o usuário no Firebase Firestore. Verifique se a variável FIREBASE_SERVICE_ACCOUNT está configurada corretamente no Render e se o service account tem permissão de escrita na coleção "users". Detalhe: ' + msg,
      }, { status: 502 })
    }
    if (msg.includes('Firestore') || msg.includes('firebase') || msg.includes('credential') || msg.includes('permission')) {
      return NextResponse.json({
        success: false,
        error: 'Erro do Firebase ao criar usuário: ' + msg + '. Verifique a configuração do Firebase Admin SDK no Render.',
      }, { status: 502 })
    }
    return NextResponse.json({ success: false, error: 'Erro interno do servidor: ' + msg }, { status: 500 })
  }
}
