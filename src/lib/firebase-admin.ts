// ====================================================================
// WhatsApp-Odoo v7.28 — Firebase Admin (servidor)
// --------------------------------------------------------------------
// Inicializa o Firebase Admin SDK de forma segura usando variáveis de
// ambiente. NÃO usar credenciais de cliente no navegador: a gestão de
// usuários acontece no servidor (API Routes + user-session.js).
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
// false e o app cai no SQLite (Prisma) como antes. Assim o deploy atual
// continua funcionando mesmo antes de você adicionar as chaves do Firebase.
// ====================================================================

import { initializeApp, getApps, cert, type App } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'
import fs from 'fs'

function normalizePrivateKey(pk: string | undefined): string | undefined {
  if (!pk) return undefined
  // Render e alguns painéis escapam as quebras de linha como \n literal.
  if (pk.includes('\\n')) return pk.replace(/\\n/g, '\n')
  return pk
}

function loadServiceAccount(): Record<string, any> | null {
  // 1) JSON inline
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT
  if (inline && inline.trim().length > 0) {
    try {
      return JSON.parse(inline)
    } catch {
      console.error('[firebase-admin] FIREBASE_SERVICE_ACCOUNT não é um JSON válido.')
      return null
    }
  }
  // 2) base64
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64
  if (b64 && b64.trim().length > 0) {
    try {
      return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
    } catch {
      console.error('[firebase-admin] FIREBASE_SERVICE_ACCOUNT_B64 não é um JSON base64 válido.')
      return null
    }
  }
  // 3) caminho do arquivo
  const filePath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (filePath && filePath.trim().length > 0) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8')
      return JSON.parse(raw)
    } catch {
      console.error('[firebase-admin] Não foi possível ler GOOGLE_APPLICATION_CREDENTIALS.')
      return null
    }
  }
  // 4) variáveis separadas
  const projectId = process.env.FIREBASE_PROJECT_ID
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
  const privateKey = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY)
  if (projectId && clientEmail && privateKey) {
    return {
      type: 'service_account',
      project_id: projectId,
      client_email: clientEmail,
      private_key: privateKey,
    }
  }
  return null
}

export function isFirestoreConfigured(): boolean {
  return !!process.env.FIREBASE_PROJECT_ID ||
    !!process.env.FIREBASE_SERVICE_ACCOUNT ||
    !!process.env.FIREBASE_SERVICE_ACCOUNT_B64 ||
    !!process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    !!(process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY)
}

let cachedDb: Firestore | null = null

export function getFirestoreDb(): Firestore | null {
  if (cachedDb) return cachedDb
  if (!isFirestoreConfigured()) {
    return null
  }
  const sa = loadServiceAccount()
  if (!sa) return null
  try {
    if (getApps().length === 0) {
      initializeApp({ credential: cert(sa as any) })
    }
    cachedDb = getFirestore()
    return cachedDb
  } catch (err: any) {
    console.error('[firebase-admin] Falha ao iniciar Firebase Admin:', err.message)
    return null
  }
}

// O nome do app entre processos deve ser estável para evitar
// inicialização duplicada do Admin SDK.
export function getFirebaseApp(): App | null {
  if (!isFirestoreConfigured()) return null
  const existing = getApps()[0]
  if (existing) return existing
  const sa = loadServiceAccount()
  if (!sa) return null
  try {
    return initializeApp({ credential: cert(sa as any) })
  } catch (err: any) {
    console.error('[firebase-admin] Falha ao iniciar Firebase Admin:', err.message)
    return null
  }
}
