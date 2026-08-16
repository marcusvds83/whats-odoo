// ====================================================================
// WhatsApp-Odoo v7.28 — UserStore
// --------------------------------------------------------------------
// Camada única de acesso aos usuários. Abstrai o banco usado para LOGINS:
//   - Se o Firebase Admin estiver configurado → leitura/escrita no
//     Firestore (coleção "users", um documento por usuário).
//   - Caso contrário → mantém o comportamento antigo no SQLite (Prisma).
//
// O resto do app (WhatsApp, conversas, Odoo) NÃO passa por aqui e
// continua no SQLite, exatamente como você pediu: Firestore apenas
// para criar e manter os logins de usuários.
//
// Coleção Firestore:
//   users/{id}  → { id, email, passwordHash, name, role, isActive,
//                  whatsappPhone, odooUrl, odooDb, odooUsername,
//                  odooPassword, createdAt, updatedAt }
// ====================================================================

import { db } from '@/lib/db'
import { getFirestoreDb } from '@/lib/firebase-admin'
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
}

export default userStore
