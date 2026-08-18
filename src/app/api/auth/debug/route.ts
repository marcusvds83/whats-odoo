// ====================================================================
// v7.30: GET /api/auth/debug
// --------------------------------------------------------------------
// Admin-only diagnostic endpoint that returns:
//   - Firebase configuration status (which env vars are present)
//   - Firebase initialization status (success / failure / error message)
//   - User counts: in Firestore, in SQLite
//   - First 10 user emails in each store (for cross-checking)
//
// Use this when "users aren't in Firebase" to see exactly WHY.
// ====================================================================

import { NextRequest, NextResponse } from 'next/server'
import { userStore } from '@/lib/user-store'
import { getFirebaseDiagnostics, getFirestoreDb } from '@/lib/firebase-admin'
import { getSessionFromRequest } from '@/lib/auth'
import { db } from '@/lib/db'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const ts = new Date().toISOString()
  try {
    // Admin-only
    const session = await getSessionFromRequest(req)
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autenticado' }, { status: 401 })
    }
    if (session.role !== 'admin') {
      return NextResponse.json({ success: false, error: 'Acesso restrito a administradores' }, { status: 403 })
    }

    const diag = getFirebaseDiagnostics()
    const firestore = getFirestoreDb()

    // Count users in Firestore
    let firestoreUserCount = 0
    let firestoreUsers: string[] = []
    if (firestore) {
      try {
        const snap = await firestore.collection('users').get()
        firestoreUserCount = snap.size
        firestoreUsers = snap.docs.slice(0, 10).map(d => {
          const data = d.data()
          return `${data.email || '(no email)'} | id=${d.id} | role=${data.role || '?'} | active=${data.isActive !== false}`
        })
      } catch (err: any) {
        firestoreUsers = [`<error reading Firestore: ${err.message}>`]
      }
    }

    // Count users in SQLite
    let sqliteUserCount = 0
    let sqliteUsers: string[] = []
    try {
      sqliteUserCount = await db.user.count()
      const all = await db.user.findMany({ take: 10, orderBy: { createdAt: 'desc' } })
      sqliteUsers = all.map(u => `${u.email} | id=${u.id} | role=${u.role} | active=${u.isActive}`)
    } catch (err: any) {
      sqliteUsers = [`<error reading SQLite: ${err.message}>`]
    }

    return NextResponse.json({
      success: true,
      at: ts,
      firebase: diag,
      firestore: {
        available: !!firestore,
        userCount: firestoreUserCount,
        sampleUsers: firestoreUsers,
      },
      sqlite: {
        userCount: sqliteUserCount,
        sampleUsers: sqliteUsers,
      },
      recommendations: !diag.configured
        ? ['Firebase env vars are NOT set. Set FIREBASE_SERVICE_ACCOUNT in Render to enable user persistence in Firestore.']
        : diag.configured && !diag.initialized
        ? [`Firebase env vars are present (via ${diag.configSource}) but initialization FAILED: ${diag.initError || 'unknown error'}. Check that the service account JSON is valid and the private key has correct \\n escapes.`]
        : diag.initialized && firestoreUserCount === 0 && sqliteUserCount > 0
        ? ['Firebase is initialized but Firestore has 0 users while SQLite has users. Run migration: POST /api/auth/migrate-users']
        : ['Everything looks good — users are stored in Firestore and will persist across deploys.'],
    })
  } catch (err: any) {
    console.error(`[${ts}][/api/auth/debug] error:`, err.message)
    return NextResponse.json({ success: false, error: 'Erro interno: ' + err.message }, { status: 500 })
  }
}
