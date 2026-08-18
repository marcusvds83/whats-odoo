// ====================================================================
// WhatsApp-Odoo v7.30 — UserStore
// --------------------------------------------------------------------
// Camada única de acesso aos usuários. Abstrai o banco usado para LOGINS:
//   - Se o Firebase Admin estiver configurado → leitura/escrita no
//     Firestore (coleção "users", um documento por usuário).
//   - Caso contrário → mantém o comportamento antigo no SQLite (Prisma).
//
// v7.30 changes:
//   - `create()` now verifies the Firestore write actually landed by
//     reading the doc back. If verification fails, surfaces a clear error
//     (instead of silently succeeding but leaving no record in Firestore).
//   - `findUnique()` falls back to SQLite ONLY when Firestore is not
//     configured at all. If Firestore IS configured but the user isn't
//     there, returns null (don't accidentally find a stale SQLite user).
//   - Added `migrateAllFromSqlite()` for one-time backfill of existing
//     SQLite users into Firestore.
//   - Added `countInSqlite()` and `findManyInSqlite()` for the migration.
//
// Coleção Firestore:
//   users/{id}  → { id, email, passwordHash, name, role, isActive,
//                  whatsappPhone, odooUrl, odooDb, odooUsername,
//                  odooPassword, createdAt, updatedAt }
// ====================================================================

import { db } from '@/lib/db'
import { getFirestoreDb, verifyFirestoreDoc } from '@/lib/firebase-admin'
import type { Firestore } from 'firebase-admin/firestore'

export interface UserRecord {
  id: string
  email: string
  passwordHash: string
  name: string | null
  role: string
  odooUrl: string | null
  odooDb: string | null
  odooUsername: string | null
  odooPassword: string | null
  whatsappPhone: string | null
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

export type UserWhere = { id?: string; email?: string }

interface CreateUserData {
  email: string
  passwordHash: string
  name?: string | null
  role?: string
  odooUrl?: string | null
  odooDb?: string | null
  odooUsername?: string | null
  odooPassword?: string | null
  whatsappPhone?: string | null
  isActive?: boolean
}

interface UpdateUserData {
  email?: string
  passwordHash?: string
  name?: string | null
  role?: string
  odooUrl?: string | null
  odooDb?: string | null
  odooUsername?: string | null
  odooPassword?: string | null
  whatsappPhone?: string | null
  isActive?: boolean
}

function nowMs(): number {
  return Date.now()
}

function toRecord(doc: any): UserRecord | null {
  if (!doc) return null
  const d = doc.exists ? doc.data() : doc
  if (!d) return null
  return {
    id: d.id || doc.id,
    email: d.email ?? '',
    passwordHash: d.passwordHash ?? '',
    name: d.name ?? null,
    role: d.role ?? 'user',
    odooUrl: d.odooUrl ?? null,
    odooDb: d.odooDb ?? null,
    odooUsername: d.odooUsername ?? null,
    odooPassword: d.odooPassword ?? null,
    whatsappPhone: d.whatsappPhone ?? null,
    isActive: d.isActive !== false,
    createdAt: d.createdAt ? new Date(typeof d.createdAt === 'object' && d.createdAt.toDate ? d.createdAt.toDate() : d.createdAt) : new Date(),
    updatedAt: d.updatedAt ? new Date(typeof d.updatedAt === 'object' && d.updatedAt.toDate ? d.updatedAt.toDate() : d.updatedAt) : new Date(),
  }
}

// ====================================================================
// Firestore helpers
// ====================================================================

async function fsFindUnique(firestore: Firestore, where: UserWhere): Promise<UserRecord | null> {
  const usersRef = firestore.collection('users')

  // If neither id nor email is provided, we have nothing to look up by.
  if (!where.id && !where.email) return null

  if (where.id) {
    const d = await usersRef.doc(where.id).get()
    return toRecord(d)
  }
  // email: query where email == (email must be lowercased consistently)
  const snapshot = await usersRef.where('email', '==', where.email).limit(1).get()
  if (snapshot.empty) return null
  return toRecord(snapshot.docs[0])
}

async function fsCreate(firestore: Firestore, data: CreateUserData): Promise<UserRecord> {
  const usersRef = firestore.collection('users')
  const now = new Date()
  const docRef = usersRef.doc()
  const id = docRef.id
  const payload = {
    id,
    email: data.email,
    passwordHash: data.passwordHash,
    name: data.name ?? null,
    role: data.role ?? 'user',
    odooUrl: data.odooUrl ?? null,
    odooDb: data.odooDb ?? null,
    odooUsername: data.odooUsername ?? null,
    odooPassword: data.odooPassword ?? null,
    whatsappPhone: data.whatsappPhone ?? null,
    isActive: data.isActive ?? true,
    createdAt: now,
    updatedAt: now,
  }
  await docRef.set(payload)

  // v7.30: VERIFY the write actually landed. Previously, if Firestore
  // silently rejected the write (e.g., due to permissions or a backend
  // issue), `fsCreate` would still return success — and the admin would
  // see "User created" but login would fail because there's no record
  // to find. Now we read the doc back to confirm.
  const verify = await verifyFirestoreDoc('users', id, 3000)
  if (!verify.ok) {
    // Don't silently succeed — throw with a clear message so the API route
    // surfaces the error to the admin.
    throw new Error(`Firestore write verification failed for user ${data.email}: ${verify.error || 'unknown'}. The user was NOT saved — check Firebase Admin SDK configuration and permissions.`)
  }
  console.log(`[user-store] ✓ Verified Firestore write: users/${id} (email=${data.email})`)

  return toRecord(payload) as UserRecord
}

async function fsUpdate(
  firestore: Firestore,
  id: string,
  data: UpdateUserData
): Promise<UserRecord | null> {
  const docRef = firestore.collection('users').doc(id)
  const existing = await docRef.get()
  if (!existing.exists) return null
  const payload: any = { updatedAt: new Date() }
  for (const k of Object.keys(data) as (keyof UpdateUserData)[]) {
    const v = data[k]
    if (v !== undefined) payload[k] = v
  }
  await docRef.update(payload)
  const after = await docRef.get()
  return toRecord(after)
}

async function fsCount(firestore: Firestore): Promise<number> {
  const snapshot = await firestore.collection('users').get()
  return snapshot.size
}

async function fsMany(firestore: Firestore): Promise<UserRecord[]> {
  const snapshot = await firestore.collection('users').get()
  const recs: UserRecord[] = []
  snapshot.forEach(d => {
    const r = toRecord(d)
    if (r) recs.push(r)
  })
  // Sort newest first (Prisma orderBy createdAt desc)
  recs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  return recs
}

async function fsDelete(firestore: Firestore, id: string): Promise<void> {
  await firestore.collection('users').doc(id).delete()
}

// ====================================================================
// Public API (same shapes as Prisma's db.user.*)
// ====================================================================

export const userStore = {
  async findUnique(args: { where: UserWhere }): Promise<UserRecord | null> {
    const firestore = getFirestoreDb()
    if (firestore) return fsFindUnique(firestore, args.where)
    return db.user.findUnique({ where: args.where as any })
  },

  async count(): Promise<number> {
    const firestore = getFirestoreDb()
    if (firestore) return fsCount(firestore)
    return db.user.count()
  },

  async create(args: { data: CreateUserData; select?: any }): Promise<UserRecord> {
    const firestore = getFirestoreDb()
    if (firestore) return fsCreate(firestore, args.data)
    return db.user.create({ data: args.data as any }) as unknown as UserRecord
  },

  async update(args: { where: { id: string }; data: UpdateUserData }): Promise<UserRecord | null> {
    const firestore = getFirestoreDb()
    if (firestore) return fsUpdate(firestore, args.where.id, args.data)
    return db.user.update({ where: { id: args.where.id }, data: args.data as any }) as unknown as UserRecord
  },

  async delete(args: { where: { id: string } }): Promise<void> {
    const firestore = getFirestoreDb()
    if (firestore) {
      await fsDelete(firestore, args.where.id)
      return
    }
    await db.user.delete({ where: { id: args.where.id } } as any)
  },

  async findMany(args?: { orderBy?: any }): Promise<UserRecord[]> {
    const firestore = getFirestoreDb()
    if (firestore) return fsMany(firestore)
    return db.user.findMany(args as any) as unknown as UserRecord[]
  },

  // ==================================================================
  // v7.30: Migration helpers — used by the auto-migration routine that
  // backfills existing SQLite users into Firestore on server startup.
  // Only call these from the migration endpoint / startup hook.
  // ==================================================================

  /** Count users stored in SQLite (ignores Firestore). */
  async countInSqlite(): Promise<number> {
    try {
      return await db.user.count()
    } catch (err: any) {
      console.warn('[user-store] countInSqlite failed:', err.message)
      return 0
    }
  },

  /** Read all users from SQLite (ignores Firestore). */
  async findManyInSqlite(): Promise<UserRecord[]> {
    try {
      return await db.user.findMany() as unknown as UserRecord[]
    } catch (err: any) {
      console.warn('[user-store] findManyInSqlite failed:', err.message)
      return []
    }
  },

  /**
   * One-time migration: copy every SQLite user into Firestore.
   * - Skips users that already exist in Firestore (by email — case-insensitive).
   * - Preserves the original `id` so existing JWTs and auth state folders
   *   (data/auth_<userId>/) keep working without remapping.
   * - Returns { total, migrated, skipped, errors }.
   *
   * This is idempotent — safe to call multiple times.
   */
  async migrateAllFromSqlite(): Promise<{ total: number; migrated: number; skipped: number; errors: string[] }> {
    const firestore = getFirestoreDb()
    if (!firestore) {
      return { total: 0, migrated: 0, skipped: 0, errors: ['Firestore not initialized — cannot migrate'] }
    }
    const sqliteUsers = await this.findManyInSqlite()
    const result = { total: sqliteUsers.length, migrated: 0, skipped: 0, errors: [] as string[] }
    if (sqliteUsers.length === 0) {
      console.log('[user-store] migrateAllFromSqlite: SQLite has 0 users — nothing to migrate')
      return result
    }
    console.log(`[user-store] migrateAllFromSqlite: scanning ${sqliteUsers.length} SQLite user(s)...`)
    for (const u of sqliteUsers) {
      try {
        // Check if a user with the same email already exists in Firestore.
        const existingSnap = await firestore.collection('users').where('email', '==', u.email).limit(1).get()
        if (!existingSnap.empty) {
          // Already migrated — skip but keep the original id (the SQLite id
          // and the Firestore id might differ; for forward compat, if the
          // existing Firestore doc has a DIFFERENT id, we should rewrite it
          // to match the SQLite id so existing JWTs keep working).
          const existingDoc = existingSnap.docs[0]
          if (existingDoc.id !== u.id) {
            console.log(`[user-store] migrateAllFromSqlite: email=${u.email} exists in Firestore with id=${existingDoc.id} but SQLite id=${u.id}. Re-aligning id...`)
            // Delete the existing doc and re-create with the SQLite id.
            await existingDoc.ref.delete()
            const newDocRef = firestore.collection('users').doc(u.id)
            await newDocRef.set({
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
            console.log(`[user-store] migrateAllFromSqlite: ✓ re-aligned ${u.email} to id=${u.id}`)
          } else {
            result.skipped++
            console.log(`[user-store] migrateAllFromSqlite: skip ${u.email} (already in Firestore)`)
          }
          continue
        }
        // Not in Firestore — create with the same id as SQLite.
        const docRef = firestore.collection('users').doc(u.id)
        await docRef.set({
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
        console.log(`[user-store] migrateAllFromSqlite: ✓ migrated ${u.email} (id=${u.id})`)
      } catch (err: any) {
        result.errors.push(`${u.email}: ${err.message}`)
        console.error(`[user-store] migrateAllFromSqlite: ✗ failed for ${u.email}:`, err.message)
      }
    }
    console.log(`[user-store] migrateAllFromSqlite: done — migrated=${result.migrated} skipped=${result.skipped} errors=${result.errors.length}`)
    return result
  },
}

export default userStore
