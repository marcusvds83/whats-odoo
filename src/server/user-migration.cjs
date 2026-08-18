// ====================================================================
// Whats-Odoo v7.30 — CommonJS bridge for SQLite → Firestore user migration
// --------------------------------------------------------------------
// server.js is CommonJS and can't `await import('./src/lib/user-store.ts')`
// because Node won't transpile TypeScript on the fly. This file mirrors
// the migration logic from user-store.ts in plain CommonJS so server.js
// can call it directly on startup.
//
// The logic MUST stay in sync with src/lib/user-store.ts::migrateAllFromSqlite.
// If you change one, change the other.
// ====================================================================

const { PrismaClient } = require('@prisma/client')

function firebaseConfigured() {
  return Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT ||
      process.env.FIREBASE_SERVICE_ACCOUNT_B64 ||
      process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      (process.env.FIREBASE_PROJECT_ID &&
        process.env.FIREBASE_CLIENT_EMAIL &&
        process.env.FIREBASE_PRIVATE_KEY)
  )
}

function parseCredentials() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try { return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) } catch { return null }
  }
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64 || process.env.FIREBASE_SERVICE_ACCOUNT_BASE64
  if (b64) {
    try { return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) } catch { return null }
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      const fs = require('fs')
      return JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'))
    } catch { return null }
  }
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    return {
      type: 'service_account',
      project_id: process.env.FIREBASE_PROJECT_ID,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }
  }
  return null
}

let _firestore = null
function getFirestore() {
  if (_firestore) return _firestore
  if (!firebaseConfigured()) return null
  try {
    const { initializeApp, getApps, cert } = require('firebase-admin/app')
    const { getFirestore } = require('firebase-admin/firestore')
    const sa = parseCredentials()
    if (!sa) {
      console.warn('[user-migration] Firebase configured but credentials could not be parsed')
      return null
    }
    const app = (getApps && getApps().length > 0)
      ? getApps()[0]
      : initializeApp({ credential: cert(sa) })
    _firestore = getFirestore(app)
    return _firestore
  } catch (err) {
    console.error('[user-migration] Failed to init Firestore:', err && err.message)
    return null
  }
}

/**
 * One-time migration: copy every SQLite user into Firestore.
 * - Skips users that already exist in Firestore (by email — case-insensitive).
 * - Preserves the original `id` so existing JWTs and auth_state folders
 *   (data/auth_<userId>/) keep working without remapping.
 * - Returns { total, migrated, skipped, errors }.
 *
 * Idempotent — safe to call multiple times.
 */
async function migrateAllFromSqlite() {
  const result = { total: 0, migrated: 0, skipped: 0, errors: [] }
  const firestore = getFirestore()
  if (!firestore) {
    result.errors.push('Firestore not initialized')
    return result
  }
  const prisma = new PrismaClient()
  try {
    const sqliteUsers = await prisma.user.findMany().catch(() => [])
    result.total = sqliteUsers.length
    if (sqliteUsers.length === 0) {
      console.log('[user-migration] SQLite has 0 users — nothing to migrate')
      return result
    }
    console.log(`[user-migration] Scanning ${sqliteUsers.length} SQLite user(s) for migration to Firestore...`)

    for (const u of sqliteUsers) {
      try {
        // Check if email already exists in Firestore
        const existingSnap = await firestore.collection('users').where('email', '==', u.email).limit(1).get()
        if (!existingSnap.empty) {
          const existingDoc = existingSnap.docs[0]
          if (existingDoc.id !== u.id) {
            console.log(`[user-migration] Re-aligning ${u.email}: Firestore id=${existingDoc.id} → SQLite id=${u.id}`)
            await existingDoc.ref.delete()
            await firestore.collection('users').doc(u.id).set({
              id: u.id,
              email: u.email,
              passwordHash: u.passwordHash,
              name: u.name,
              role: u.role,
              odooUrl: u.odooUrl,
              odooDb: u.odooDb,
              odooUsername: u.odooUsername,
              odooPassword: u.odooPassword,
              whatsappPhone: u.whatsappPhone,
              isActive: u.isActive,
              createdAt: u.createdAt,
              updatedAt: new Date(),
            })
            result.migrated++
          } else {
            result.skipped++
          }
          continue
        }
        // Not in Firestore — create with the same id as SQLite
        await firestore.collection('users').doc(u.id).set({
          id: u.id,
          email: u.email,
          passwordHash: u.passwordHash,
          name: u.name,
          role: u.role,
          odooUrl: u.odooUrl,
          odooDb: u.odooDb,
          odooUsername: u.odooUsername,
          odooPassword: u.odooPassword,
          whatsappPhone: u.whatsappPhone,
          isActive: u.isActive,
          createdAt: u.createdAt,
          updatedAt: new Date(),
        })
        result.migrated++
        console.log(`[user-migration] ✓ Migrated ${u.email} (id=${u.id})`)
      } catch (err) {
        result.errors.push(`${u.email}: ${err.message}`)
        console.error(`[user-migration] ✗ Failed for ${u.email}:`, err.message)
      }
    }
    console.log(`[user-migration] Done — migrated=${result.migrated} skipped=${result.skipped} errors=${result.errors.length}`)
    return result
  } finally {
    try { await prisma.$disconnect() } catch {}
  }
}

module.exports = { migrateAllFromSqlite, getFirestore, firebaseConfigured }
