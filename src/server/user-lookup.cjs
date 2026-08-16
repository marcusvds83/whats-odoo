// ====================================================================
// Whats-Odoo v7.28 — CommonJS user lookup bridge (server.js / socket)
// --------------------------------------------------------------------
// Route da busca de usuário para LOGINS usado pelo servidor socket.io
// (SessionManager.getOrCreate). Espelha exatamente a lógica do
// src/lib/user-store.ts (camada TS usada pelas rotas Next /api/auth):
//
//   - Se as credenciais do Firebase Admin estiverem no ambiente → lê o
//     usuário do Firestore (coleção "users", doc users/{id}).
//   - Caso contrário → cai de volta no SQLite via PrismaClient.
//
// Os dados de WhatsApp/Odoo continuam no SQLite; aqui só buscamos os
// dados do USUÁRIO (para iniciar a sessão por usuário).
// ====================================================================

const fs = require('fs')

function firebaseConfigured() {
  return Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT ||
      process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS || // ignored here (needs admin SDK)
      (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY)
  )
}

// Minimal mapper identical to user-store.ts's toRecord.
function toRecord(doc) {
  const d = doc.data ? doc.data() : doc
  if (!d) return null
  const id = d.id || doc.id
  const toDate = (v) => {
    if (!v) return new Date()
    if (typeof v === 'object' && typeof v.toDate === 'function') return v.toDate()
    return new Date(v)
  }
  return {
    id,
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
    createdAt: toDate(d.createdAt),
    updatedAt: toDate(d.updatedAt),
  }
}

let _app = null
let _firestore = null

function getFirestore() {
  if (_firestore) return _firestore
  if (!firebaseConfigured()) return null
  try {
    if (!_app) {
      const { initializeApp, getApps, cert } = require('firebase-admin/app')
      const existing = getApps && getApps()[0]
      _app = existing || initializeApp({ credential: cert(parseCredentials()) })
    }
    const { getFirestore } = require('firebase-admin/firestore')
    _firestore = getFirestore(_app)
  } catch (err) {
    console.error(`[user-lookup] Firebase init failed, falling back to SQLite: ${err && err.message}`)
    _app = null
    return null
  }
  return _firestore
}

function parseCredentials() {
  // 1) raw JSON
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  }
  // 2) base64-encoded JSON
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    return JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8'))
  }
  // 3) split env vars
  return {
    project_id: process.env.FIREBASE_PROJECT_ID,
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }
}

// NOTE: GOOGLE_APPLICATION_CREDENTIALS requires a file path on disk; the
// admin SDK can read it automatically via applicationDefaultCredentials if
// set. We don't try to manage the file here — documented in the guide.

/**
 * Resolve a user by id. Prefers Firestore when configured; otherwise uses
 * the provided Prisma client (SQLite) exactly as before.
 * @param {object} prismaPrismaClient
 * @returns {Promise<object|null>}
 */
async function loadUserById(userId, prismaClient) {
  const firestore = getFirestore()
  if (firestore) {
    try {
      const doc = await firestore.collection('users').doc(String(userId)).get()
      if (!doc.exists) return null
      const rec = toRecord(doc)
      return rec && !rec.isActive ? null : rec
    } catch (err) {
      console.error(`[user-lookup] Firestore read failed, falling back to SQLite: ${err && err.message}`)
    }
  }
  return prismaClient.user.findUnique({ where: { id: String(userId) } })
}

module.exports = { loadUserById, firebaseConfigured }
