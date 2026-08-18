// ====================================================================
// WhatsApp-Odoo v7.30 — Firebase Admin (servidor)
// --------------------------------------------------------------------
// Inicializa o Firebase Admin SDK de forma segura usando variáveis de
// ambiente. NÃO usar credenciais de cliente no navegador: a gestão de
// usuários acontece no servidor (API Routes + user-session.js).
//
// v7.30: Adds explicit logging at every step so we can see exactly
// WHERE initialization fails when env vars are set but Firestore writes
// don't seem to land. Also adds a `verifyWrite()` helper that user-store
// uses to confirm a doc is actually readable after `set()` — if not,
// we surface a clear error instead of silently falling back to SQLite.
//
// Credenciais aceitas (prioridade):
//   1) FIREBASE_SERVICE_ACCOUNT — JSON da Conta de Serviço, como string
//      JSON pura (escape de quebras de linha para '\\n').
//   2) FIREBASE_SERVICE_ACCOUNT_B64 — mesmo JSON, em base64.
//   3) GOOGLE_APPLICATION_CREDENTIALS — caminho do arquivo JSON no disco.
//   4) FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
//      (variáveis em separado — ver passo-a-passo no README).
//
// Se nenhuma credencial for encontrada, isFirestoreConfigured() retorna
// false e o app cai no SQLite (Prisma) como antes.
// ====================================================================

import { initializeApp, getApps, cert, type App } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'
import fs from 'fs'

let _initAttempted = false
let _initError: string | null = null
let _configSource: string | null = null

function normalizePrivateKey(pk: string | undefined): string | undefined {
  if (!pk) return undefined
  // Render e alguns painéis escapam as quebras de linha como \n literal.
  if (pk.includes('\\n')) return pk.replace(/\\n/g, '\n')
  return pk
}

function loadServiceAccount(): { sa: Record<string, any> | null; source: string | null; error?: string } {
  // 1) JSON inline
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT
  if (inline && inline.trim().length > 0) {
    try {
      const sa = JSON.parse(inline)
      if (!sa.project_id && !sa.databaseURL) {
        return { sa: null, source: 'FIREBASE_SERVICE_ACCOUNT', error: 'JSON parsed but missing project_id' }
      }
      return { sa, source: 'FIREBASE_SERVICE_ACCOUNT' }
    } catch (e: any) {
      return { sa: null, source: 'FIREBASE_SERVICE_ACCOUNT', error: `JSON parse failed: ${e.message}` }
    }
  }
  // 2) base64
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64 || process.env.FIREBASE_SERVICE_ACCOUNT_BASE64
  if (b64 && b64.trim().length > 0) {
    try {
      const sa = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
      if (!sa.project_id && !sa.databaseURL) {
        return { sa: null, source: 'FIREBASE_SERVICE_ACCOUNT_B64', error: 'base64 decoded but missing project_id' }
      }
      return { sa, source: 'FIREBASE_SERVICE_ACCOUNT_B64' }
    } catch (e: any) {
      return { sa: null, source: 'FIREBASE_SERVICE_ACCOUNT_B64', error: `base64 decode/parse failed: ${e.message}` }
    }
  }
  // 3) caminho do arquivo
  const filePath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (filePath && filePath.trim().length > 0) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8')
      const sa = JSON.parse(raw)
      if (!sa.project_id && !sa.databaseURL) {
        return { sa: null, source: 'GOOGLE_APPLICATION_CREDENTIALS', error: 'file read but missing project_id' }
      }
      return { sa, source: 'GOOGLE_APPLICATION_CREDENTIALS' }
    } catch (e: any) {
      return { sa: null, source: 'GOOGLE_APPLICATION_CREDENTIALS', error: `file read failed: ${e.message}` }
    }
  }
  // 4) variáveis separadas
  const projectId = process.env.FIREBASE_PROJECT_ID
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
  const privateKey = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY)
  if (projectId && clientEmail && privateKey) {
    return {
      sa: {
        type: 'service_account',
        project_id: projectId,
        client_email: clientEmail,
        private_key: privateKey,
      },
      source: 'FIREBASE_PROJECT_ID+EMAIL+KEY',
    }
  }
  return { sa: null, source: null }
}

export function isFirestoreConfigured(): boolean {
  return !!process.env.FIREBASE_PROJECT_ID ||
    !!process.env.FIREBASE_SERVICE_ACCOUNT ||
    !!process.env.FIREBASE_SERVICE_ACCOUNT_B64 ||
    !!process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ||
    !!process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    !!(process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY)
}

let cachedDb: Firestore | null = null

export function getFirestoreDb(): Firestore | null {
  if (cachedDb) return cachedDb
  if (_initAttempted) {
    // Already tried and failed — return null without re-attempting (don't spam logs).
    // The error from the first attempt is stored in _initError.
    return null
  }
  _initAttempted = true

  if (!isFirestoreConfigured()) {
    console.log('[firebase-admin] Firestore NOT configured (no env vars) — using SQLite fallback for users')
    return null
  }

  const { sa, source, error } = loadServiceAccount()
  if (!sa) {
    _initError = error || 'loadServiceAccount() returned null'
    console.error(`[firebase-admin] Firestore configured via ${source || 'unknown'} but load failed: ${_initError}`)
    console.error('[firebase-admin] Falling back to SQLite for user storage. Users created will NOT persist across deploys.')
    return null
  }
  _configSource = source || 'unknown'

  try {
    if (getApps().length === 0) {
      initializeApp({ credential: cert(sa as any) })
      console.log(`[firebase-admin] ✓ Initialized Firebase Admin via ${_configSource} (project_id=${sa.project_id || 'n/a'})`)
    } else {
      console.log(`[firebase-admin] ✓ Reusing existing Firebase Admin app (configured via ${_configSource})`)
    }
    cachedDb = getFirestore()
    console.log('[firebase-admin] ✓ Firestore instance obtained — user records will persist in Firestore (survives deploys)')
    return cachedDb
  } catch (err: any) {
    _initError = err.message
    console.error(`[firebase-admin] Falha ao iniciar Firebase Admin: ${err.message}`)
    console.error(err.stack || '')
    return null
  }
}

/**
 * Returns diagnostic info about the Firebase init state.
 * Used by /api/auth/debug to surface the exact reason users aren't landing in Firestore.
 */
export function getFirebaseDiagnostics(): {
  configured: boolean
  initialized: boolean
  configSource: string | null
  initError: string | null
  envVarsPresent: {
    FIREBASE_SERVICE_ACCOUNT: boolean
    FIREBASE_SERVICE_ACCOUNT_B64: boolean
    FIREBASE_SERVICE_ACCOUNT_BASE64: boolean
    GOOGLE_APPLICATION_CREDENTIALS: boolean
    FIREBASE_PROJECT_ID: boolean
    FIREBASE_CLIENT_EMAIL: boolean
    FIREBASE_PRIVATE_KEY: boolean
  }
} {
  return {
    configured: isFirestoreConfigured(),
    initialized: !!cachedDb,
    configSource: _configSource,
    initError: _initError,
    envVarsPresent: {
      FIREBASE_SERVICE_ACCOUNT: !!process.env.FIREBASE_SERVICE_ACCOUNT,
      FIREBASE_SERVICE_ACCOUNT_B64: !!process.env.FIREBASE_SERVICE_ACCOUNT_B64,
      FIREBASE_SERVICE_ACCOUNT_BASE64: !!process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
      GOOGLE_APPLICATION_CREDENTIALS: !!process.env.GOOGLE_APPLICATION_CREDENTIALS,
      FIREBASE_PROJECT_ID: !!process.env.FIREBASE_PROJECT_ID,
      FIREBASE_CLIENT_EMAIL: !!process.env.FIREBASE_CLIENT_EMAIL,
      FIREBASE_PRIVATE_KEY: !!process.env.FIREBASE_PRIVATE_KEY,
    },
  }
}

/**
 * Verify that a Firestore write actually landed by reading the doc back.
 * Used by user-store.create() to confirm a user was actually persisted
 * before returning success to the API caller.
 */
export async function verifyFirestoreDoc(
  collection: string,
  docId: string,
  timeoutMs: number = 3000
): Promise<{ ok: boolean; error?: string }> {
  const db = getFirestoreDb()
  if (!db) return { ok: false, error: 'Firestore not initialized' }
  try {
    // Firestore is strongly consistent for own-writes after the write Promise resolves,
    // but we add a small backoff retry loop for safety (renders sometimes see slight delays).
    const start = Date.now()
    for (let attempt = 0; attempt < 3; attempt++) {
      const doc = await db.collection(collection).doc(docId).get()
      if (doc.exists) return { ok: true }
      if (Date.now() - start > timeoutMs) break
      await new Promise(r => setTimeout(r, 200))
    }
    return { ok: false, error: 'doc not readable after write' }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
}

// O nome do app entre processos deve ser estável para evitar
// inicialização duplicada do Admin SDK.
export function getFirebaseApp(): App | null {
  if (!isFirestoreConfigured()) return null
  const existing = getApps()[0]
  if (existing) return existing
  const { sa } = loadServiceAccount()
  if (!sa) return null
  try {
    return initializeApp({ credential: cert(sa as any) })
  } catch (err: any) {
    console.error('[firebase-admin] Falha ao iniciar Firebase Admin:', err.message)
    return null
  }
}
