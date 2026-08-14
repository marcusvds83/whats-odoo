// ====================================================================
// v7.22: GET /api/users — list all users (admin only)
// POST /api/users — create a new user (admin only)
// ====================================================================

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
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
    const users = await db.user.findMany({
      orderBy: { createdAt: 'desc' },
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
        createdAt: true,
        updatedAt: true,
        // passwordHash is intentionally excluded
      },
    })
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
    const existing = await db.user.findUnique({ where: { email } })
    if (existing) {
      return NextResponse.json({ success: false, error: 'Email já cadastrado' }, { status: 409 })
    }

    const passwordHash = await hashPassword(body.password)
    const user = await db.user.create({
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
        createdAt: true,
      },
    })

    return NextResponse.json({ success: true, user })
  } catch (err: any) {
    console.error('[/api/users POST] error:', err.message)
    return NextResponse.json({ success: false, error: 'Erro interno do servidor' }, { status: 500 })
  }
}
