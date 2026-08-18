// ====================================================================
// v7.22: /api/users/[id] — admin user management
// PATCH  → update user (name, role, isActive, password, odoo*, whatsappPhone)
// DELETE → delete user
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

// PATCH: update user
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req)
  if ('error' in auth) return auth.error
  const { session } = auth

  try {
    const { id } = await params
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ success: false, error: 'Body inválido' }, { status: 400 })
    }

    // Verify user exists
    const existing = await userStore.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Usuário não encontrado' }, { status: 404 })
    }

    // Build update data — only include fields that are present
    const updateData: any = {}
    if (typeof body.name === 'string') updateData.name = body.name.trim() || null
    if (typeof body.role === 'string') updateData.role = body.role === 'admin' ? 'admin' : 'user'
    if (typeof body.isActive === 'boolean') {
      // Prevent admin from deactivating themselves
      if (body.isActive === false && session.userId === existing.id && existing.role === 'admin') {
        return NextResponse.json({ success: false, error: 'Você não pode desativar sua própria conta admin' }, { status: 400 })
      }
      updateData.isActive = body.isActive
    }
    if (typeof body.whatsappPhone === 'string') updateData.whatsappPhone = body.whatsappPhone.trim() || null
    if (typeof body.odooUrl === 'string') updateData.odooUrl = body.odooUrl.trim() || null
    if (typeof body.odooDb === 'string') updateData.odooDb = body.odooDb.trim() || null
    if (typeof body.odooUsername === 'string') updateData.odooUsername = body.odooUsername.trim() || null
    if (typeof body.odooPassword === 'string' && body.odooPassword.length > 0) {
      updateData.odooPassword = body.odooPassword.trim()
    }
    // Password change — only if a new password is provided
    if (typeof body.password === 'string' && body.password.length > 0) {
      if (body.password.length < 6) {
        return NextResponse.json({ success: false, error: 'Senha deve ter pelo menos 6 caracteres' }, { status: 400 })
      }
      updateData.passwordHash = await hashPassword(body.password)
    }
    // Email change — only if provided and different
    if (typeof body.email === 'string' && body.email.trim().toLowerCase() !== existing.email) {
      const newEmail = body.email.trim().toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
        return NextResponse.json({ success: false, error: 'Email inválido' }, { status: 400 })
      }
      const taken = await userStore.findUnique({ where: { email: newEmail } })
      if (taken && taken.id !== id) {
        return NextResponse.json({ success: false, error: 'Email já cadastrado' }, { status: 409 })
      }
      updateData.email = newEmail
    }

    const updatedRaw = await userStore.update({
      where: { id },
      data: updateData,
    })

    if (!updatedRaw) {
      return NextResponse.json({ success: false, error: 'Usuário não encontrado' }, { status: 404 })
    }

    const updated = {
      id: updatedRaw.id,
      email: updatedRaw.email,
      name: updatedRaw.name,
      role: updatedRaw.role,
      isActive: updatedRaw.isActive,
      whatsappPhone: updatedRaw.whatsappPhone,
      odooUrl: updatedRaw.odooUrl,
      odooDb: updatedRaw.odooDb,
      odooUsername: updatedRaw.odooUsername,
      updatedAt: updatedRaw.updatedAt,
    }

    return NextResponse.json({ success: true, user: updated })
  } catch (err: any) {
    console.error('[/api/users PATCH] error:', err.message, err.stack)
    // v7.31: Surface Firestore write-verification failures with clear messages
    const msg = String(err?.message || '')
    if (msg.includes('Firestore update verification failed')) {
      return NextResponse.json({
        success: false,
        error: 'Falha ao atualizar o usuário no Firebase Firestore. Verifique a configuração do Firebase Admin SDK no Render. Detalhe: ' + msg,
      }, { status: 502 })
    }
    if (msg.includes('Firestore') || msg.includes('firebase') || msg.includes('credential') || msg.includes('permission')) {
      return NextResponse.json({
        success: false,
        error: 'Erro do Firebase ao atualizar usuário: ' + msg,
      }, { status: 502 })
    }
    return NextResponse.json({ success: false, error: 'Erro interno do servidor: ' + msg }, { status: 500 })
  }
}

// DELETE: delete user
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req)
  if ('error' in auth) return auth.error
  const { session } = auth

  try {
    const { id } = await params

    // Prevent admin from deleting themselves
    if (id === session.userId) {
      return NextResponse.json({ success: false, error: 'Você não pode excluir sua própria conta' }, { status: 400 })
    }

    const existing = await userStore.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Usuário não encontrado' }, { status: 404 })
    }

    await userStore.delete({ where: { id } })
    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('[/api/users DELETE] error:', err.message)
    return NextResponse.json({ success: false, error: 'Erro interno do servidor' }, { status: 500 })
  }
}
