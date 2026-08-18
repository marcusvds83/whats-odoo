// ====================================================================
// v7.30: POST /api/auth/migrate-users
// --------------------------------------------------------------------
// Admin-only endpoint that copies every SQLite user into Firestore.
// Idempotent — skips users that already exist in Firestore (by email).
//
// Use case: the user reported "users aren't in Firebase, that's why they
// can't login". This usually means: Firebase env vars were added AFTER
// users had already been created in SQLite. So those users exist only in
// SQLite, and the Firestore-backed `userStore.findUnique({ where: { email } })`
// returns null for them. This migration copies them over.
//
// Returns: { success, total, migrated, skipped, errors }
// ====================================================================

import { NextRequest, NextResponse } from 'next/server'
import { userStore } from '@/lib/user-store'
import { getSessionFromRequest } from '@/lib/auth'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const ts = new Date().toISOString()
  try {
    const session = await getSessionFromRequest(req)
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autenticado' }, { status: 401 })
    }
    if (session.role !== 'admin') {
      return NextResponse.json({ success: false, error: 'Acesso restrito a administradores' }, { status: 403 })
    }

    console.log(`[${ts}][migrate-users] Starting SQLite → Firestore migration (triggered by ${session.email})`)
    const result = await userStore.migrateAllFromSqlite()
    console.log(`[${ts}][migrate-users] Result:`, JSON.stringify(result))

    return NextResponse.json({
      success: true,
      at: ts,
      ...result,
    })
  } catch (err: any) {
    console.error(`[${ts}][migrate-users] ERROR:`, err.message, err.stack)
    return NextResponse.json({ success: false, error: 'Erro interno: ' + err.message }, { status: 500 })
  }
}
