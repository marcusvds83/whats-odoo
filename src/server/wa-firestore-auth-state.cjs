// ====================================================================
// Whats-Odoo v7.30 — Firestore-backed Baileys Auth State
// --------------------------------------------------------------------
// This is the KEY piece that makes WhatsApp sessions survive deploys.
//
// Baileys uses an "auth state" object that contains:
//   - state.creds   : the long-lived credentials (registered phone, keys)
//   - state.keys    : a SignalKeyStore (get/set/clearAll) for pre-keys
//   - saveCreds()   : persists creds after `creds.update` event
//
// The default `useMultiFileAuthState(folder)` writes these to disk:
//   folder/creds.json
//   folder/app-state-sync-key-<id>.json
//   folder/pre-key-<id>.json
//   ... etc.
//
// On Render, the disk IS persistent (1GB at /opt/render/project/src/data),
// BUT in practice we've seen sessions get "logged out" after deploys.
// This file implements `useFirestoreAuthState(db, userId)` which writes
// the SAME data to Firestore instead. Firestore is always durable across
// deploys, regardless of disk mounts.
//
// Strategy:
//   - One Firestore doc per user: wa_auth_states/{userId}
//   - Doc shape: {
//       creds: { ...credsJSON },
//       keys: { '<keyId>': { ...keyData }, ... },
//       updatedAt: Timestamp
//     }
//   - On read: fetch the doc once, hydrate in-memory maps
//   - On write: update the in-memory map AND persist to Firestore
//     (debounced — Baileys fires many key writes in bursts)
//   - On clearAll: delete the doc + reset in-memory state
//
// FALLBACK:
//   If Firestore is not configured (no env vars) or init fails, this
//   module falls back to the filesystem `useMultiFileAuthState(folder)`.
//   This preserves the existing behavior for local dev and Render
//   instances that haven't set Firebase env vars yet.
//
// MIGRATION:
//   On first connect for a user, if Firestore has no creds but the
//   filesystem folder DOES have creds.json, we auto-migrate the
//   filesystem state to Firestore. After migration, the filesystem
//   files are left in place (as a backup) but no longer used.
//
// This file is CommonJS because user-session.js is CommonJS.
// ====================================================================

const path = require('path')
const fs = require('fs')

/**
 * Try to obtain a Firestore instance from the env-configured Admin SDK.
 * Returns null if Firestore is not configured or init failed.
 *
 * We do a lazy require() here so that this module doesn't crash at load
 * time if firebase-admin isn't available (e.g., in dev environments).
 */
function getFirestoreOrNull() {
  try {
    // Same env-var precedence as src/lib/firebase-admin.ts and user-lookup.cjs
    const configured = Boolean(
      process.env.FIREBASE_SERVICE_ACCOUNT ||
        process.env.FIREBASE_SERVICE_ACCOUNT_B64 ||
        process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS ||
        (process.env.FIREBASE_PROJECT_ID &&
          process.env.FIREBASE_CLIENT_EMAIL &&
          process.env.FIREBASE_PRIVATE_KEY)
    )
    if (!configured) return null
    // Lazy-load the admin SDK
    const { initializeApp, getApps, cert } = require('firebase-admin/app')
    const { getFirestore } = require('firebase-admin/firestore')

    let app = null
    if (getApps && getApps().length > 0) {
      app = getApps()[0]
    } else {
      const sa = parseServiceAccount()
      if (!sa) return null
      app = initializeApp({ credential: cert(sa) })
    }
    return getFirestore(app)
  } catch (err) {
    console.error('[wa-firestore-auth-state] Failed to init Firestore:', err && err.message)
    return null
  }
}

function parseServiceAccount() {
  // 1) raw JSON
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try { return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) } catch {}
  }
  // 2) base64
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64 || process.env.FIREBASE_SERVICE_ACCOUNT_BASE64
  if (b64) {
    try { return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) } catch {}
  }
  // 3) split vars
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

/**
 * In-memory representation of the auth state. Mirrors what Baileys'
 * `useMultiFileAuthState` returns, but backed by Firestore.
 *
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {string} userId — same userId used for the filesystem folder
 */
async function useFirestoreAuthState(db, userId) {
  const docRef = db.collection('wa_auth_states').doc(String(userId))
  const COLLECTION = 'wa_auth_states'

  // Hydrate in-memory state from Firestore
  let cached = { creds: null, keys: {} }
  try {
    const snap = await docRef.get()
    if (snap.exists) {
      const data = snap.data() || {}
      cached.creds = data.creds || null
      cached.keys = data.keys || {}
      console.log(`[WA-FS-Auth:${userId}] Loaded state from Firestore (creds=${cached.creds ? 'present' : 'null'}, keys=${Object.keys(cached.keys).length})`)
    } else {
      console.log(`[WA-FS-Auth:${userId}] No existing state in Firestore`)
    }
  } catch (err) {
    console.error(`[WA-FS-Auth:${userId}] Failed to read from Firestore:`, err && err.message)
  }

  // Debounced write — Baileys fires many key writes in bursts.
  let writeTimer = null
  let pendingWrite = false
  function schedulePersist() {
    if (writeTimer) return
    writeTimer = setTimeout(async () => {
      writeTimer = null
      pendingWrite = true
      try {
        await docRef.set({
          creds: cached.creds,
          keys: cached.keys,
          updatedAt: new Date(),
        }, { merge: false })
      } catch (err) {
        console.error(`[WA-FS-Auth:${userId}] Persist to Firestore failed:`, err && err.message)
      } finally {
        pendingWrite = false
      }
    }, 800)  // 800ms debounce — same as Baileys' filesystem default
  }

  // The SignalKeyStore interface Baileys expects
  const keys = {
    async get(type, ids) {
      const result = {}
      for (const id of ids) {
        const k = cached.keys[`${type}-${id}`]
        if (k) result[id] = k
      }
      return result
    },
    async set(data) {
      // `data` is an object keyed by type → { id: value }
      let changed = false
      for (const [type, entries] of Object.entries(data || {})) {
        for (const [id, value] of Object.entries(entries || {})) {
          cached.keys[`${type}-${id}`] = value
          changed = true
        }
      }
      if (changed) schedulePersist()
    },
    async clearAll() {
      cached.keys = {}
      cached.creds = null
      try {
        await docRef.delete()
        console.log(`[WA-FS-Auth:${userId}] Cleared all state in Firestore`)
      } catch (err) {
        console.error(`[WA-FS-Auth:${userId}] Clear failed:`, err && err.message)
      }
    },
  }

  const state = {
    creds: cached.creds,
    keys,
  }

  const saveCreds = async () => {
    if (!cached.creds) return
    try {
      await docRef.set({
        creds: cached.creds,
        keys: cached.keys,
        updatedAt: new Date(),
      }, { merge: false })
    } catch (err) {
      console.error(`[WA-FS-Auth:${userId}] saveCreds failed:`, err && err.message)
    }
  }

  return { state, saveCreds, source: 'firestore' }
}

/**
 * Migrate an existing filesystem auth state to Firestore.
 * Called once on startup if Firestore has no creds but the folder does.
 *
 * @param {string} folder — the per-user auth folder (data/auth_<userId>)
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {string} userId
 */
async function migrateFilesystemToFirestore(folder, db, userId) {
  const credsPath = path.join(folder, 'creds.json')
  if (!fs.existsSync(credsPath)) {
    return { migrated: false, reason: 'no creds.json in folder' }
  }
  try {
    const credsJson = JSON.parse(fs.readFileSync(credsPath, 'utf8'))
    // Read all key files
    const keys = {}
    const files = fs.readdirSync(folder)
    for (const f of files) {
      if (f === 'creds.json' || f.startsWith('.')) continue
      try {
        const filePath = path.join(folder, f)
        const stat = fs.statSync(filePath)
        if (!stat.isFile()) continue
        // Key file names look like: app-state-sync-key-<id>.json,
        // pre-key-<id>.json, sender-key-<id>.json, etc.
        // We store them with the file basename as the key id.
        const content = JSON.parse(fs.readFileSync(filePath, 'utf8'))
        keys[f.replace(/\.json$/, '')] = content
      } catch {}
    }
    const docRef = db.collection('wa_auth_states').doc(String(userId))
    await docRef.set({
      creds: credsJson,
      keys,
      migratedAt: new Date(),
      updatedAt: new Date(),
    })
    console.log(`[WA-FS-Auth:${userId}] ✓ Migrated ${files.length} file(s) from filesystem to Firestore`)
    return { migrated: true, files: files.length }
  } catch (err) {
    console.error(`[WA-FS-Auth:${userId}] Migration failed:`, err && err.message)
    return { migrated: false, reason: err.message }
  }
}

/**
 * Main entry point — tries Firestore, falls back to filesystem.
 *
 * @param {string} folder — per-user auth folder (used for fallback + migration)
 * @param {string} userId
 * @returns {Promise<{ state, saveCreds, source: 'firestore' | 'filesystem' }>}
 */
async function usePersistentAuthState(folder, userId) {
  const db = getFirestoreOrNull()
  if (db) {
    // Check if we need to migrate from filesystem
    try {
      const docRef = db.collection('wa_auth_states').doc(String(userId))
      const snap = await docRef.get()
      if (!snap.exists || !snap.data()?.creds) {
        // No Firestore state — try to migrate from filesystem
        const credsPath = path.join(folder, 'creds.json')
        if (fs.existsSync(credsPath)) {
          console.log(`[WA-FS-Auth:${userId}] Firestore empty, migrating from filesystem...`)
          await migrateFilesystemToFirestore(folder, db, userId)
        }
      }
    } catch (err) {
      console.warn(`[WA-FS-Auth:${userId}] Migration check failed:`, err && err.message)
    }
    try {
      const result = await useFirestoreAuthState(db, userId)
      console.log(`[WA-FS-Auth:${userId}] ✓ Using Firestore auth state`)
      return result
    } catch (err) {
      console.error(`[WA-FS-Auth:${userId}] Firestore auth state failed, falling back to filesystem:`, err && err.message)
    }
  }
  // Fallback: filesystem (the original behavior)
  const baileys = await import('@whiskeysockets/baileys')
  const { state, saveCreds } = await baileys.useMultiFileAuthState(folder)
  console.log(`[WA-FS-Auth:${userId}] Using filesystem auth state (fallback) at ${folder}`)
  return { state, saveCreds, source: 'filesystem' }
}

module.exports = {
  usePersistentAuthState,
  useFirestoreAuthState,
  migrateFilesystemToFirestore,
  getFirestoreOrNull,
}
