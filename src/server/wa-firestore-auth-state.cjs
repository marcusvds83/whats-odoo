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
    const db = getFirestore(app)
    // v7.33.1: ignoreUndefinedProperties=true — CRITICAL.
    // Baileys' initAuthCreds() returns an object with `pairingCode: undefined`
    // and `lastPropHash: undefined`. Firestore REJECTS any document containing
    // undefined values by default (throws "Cannot use 'undefined' as a
    // Firestore value"). This was causing persistState() to fail every time
    // the user scanned the QR code → creds never got saved → on reconnect
    // we generated fresh initAuthCreds() → the scan was lost forever and
    // the user saw an infinite spinner. Enabling this flag tells Firestore
    // to silently drop undefined fields instead of throwing.
    try {
      db.settings({ ignoreUndefinedProperties: true })
    } catch (_) {
      // settings() throws if called more than once on the same instance —
      // safe to ignore since the setting is already applied from a prior call.
    }
    return db
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
 * v7.34: Deep-clone an object tree into PLAIN objects that Firestore can
 * serialize. Firestore rejects any value whose prototype is not Object.prototype
 * or Array.prototype — e.g. protobuf message instances like ADVSignedDeviceIdentity
 * that Baileys creates via `new` after a successful QR scan.
 *
 * Behavior:
 *   - Buffer → returned as-is (Firestore stores as Blob, revives as Buffer)
 *   - Date   → returned as-is (Firestore stores as Timestamp, revives as Date)
 *   - Array  → element-wise recursion into a fresh []
 *   - Object → copy all own enumerable string-keyed props into a fresh {}
 *              (this strips custom prototypes while preserving the data)
 *   - primitives (string/number/boolean/null/undefined) → returned as-is
 *   - cycle protection via WeakSet (returns null on revisits)
 *
 * This mirrors what Baileys' own useMultiFileAuthState does internally
 * (JSON.stringify + a Buffer-aware replacer), but without converting Buffers
 * to plain {type:'Buffer',data:base64} maps — Firestore's native Buffer
 * support gives us smaller docs and faster reads.
 */
function toPlainFirestore(obj, seen) {
  if (obj === null || obj === undefined) return obj
  if (Buffer.isBuffer(obj)) return obj
  if (obj instanceof Date) return obj
  if (typeof obj !== 'object') return obj
  if (!seen) seen = new WeakSet()
  if (seen.has(obj)) return null  // cycle protection
  seen.add(obj)
  if (Array.isArray(obj)) {
    const arr = new Array(obj.length)
    for (let i = 0; i < obj.length; i++) {
      arr[i] = toPlainFirestore(obj[i], seen)
    }
    return arr
  }
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k] = toPlainFirestore(v, seen)
  }
  return out
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

  // v7.33 CRITICAL FIX: import initAuthCreds from Baileys. This generates
  // the noiseKey, signedIdentityKey, signedPreKey, registrationId, etc.
  // that Baileys NEEDS to even initiate the WhatsApp WebSocket handshake.
  // Without these, makeWASocket throws synchronously when it tries to
  // read creds.noiseKey / creds.signedIdentityKey, the catch in
  // connectWhatsApp swallows the error, and NO QR CODE IS EVER GENERATED.
  //
  // Baileys' own useMultiFileAuthState does the equivalent:
  //   const creds = await readData('creds.json') || initAuthCreds()
  //
  // Previously the Firestore adapter returned state.creds = null when no
  // saved creds existed — this was THE bug that broke WhatsApp connection
  // for all users (including admin) in v7.30-v7.32.
  const { initAuthCreds } = require('@whiskeysockets/baileys')

  // Hydrate in-memory state from Firestore.
  // If Firestore has no creds, generate fresh ones via initAuthCreds() —
  // these will be persisted to Firestore on the first saveCreds() call
  // (fired by Baileys' creds.update event after registration completes).
  let cached = { creds: null, keys: {} }
  let credsWereFreshlyInit = false
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

  // v7.33: If still no creds after reading Firestore, generate fresh ones.
  // This matches Baileys' useMultiFileAuthState behavior exactly.
  if (!cached.creds) {
    cached.creds = initAuthCreds()
    credsWereFreshlyInit = true
    console.log(`[WA-FS-Auth:${userId}] No saved creds — generated fresh initAuthCreds() (will persist on first saveCreds)`)
  }

  // Debounced write — Baileys fires many key writes in bursts.
  let writeTimer = null
  let pendingWrite = false

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
      // v7.33: Match Baileys' useMultiFileAuthState behavior — generate
      // FRESH creds via initAuthCreds() instead of nulling them out.
      // Baileys internally reassigns state.creds after clearAll anyway,
      // but if any code reads state.creds between our clearAll and
      // Baileys' reassignment, null would crash it. initAuthCreds is safe.
      cached.keys = {}
      cached.creds = initAuthCreds()
      state.creds = cached.creds
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

  // v7.32 FIX: persistState reads from `state.creds` (the live reference Baileys
  // mutates) instead of `cached.creds` (a snapshot from the first read).
  // Previously, when Baileys reassigned `state.creds = {...newCreds}`, the
  // `cached.creds` snapshot stayed stale (still null for new users). The
  // debounced persist would then write `creds: null` to Firestore, so the
  // first scan's credentials were lost → next deploy, user had to re-scan.
  // Now we read `state.creds` at persist-time so we always save the latest.
  //
  // v7.34 CRITICAL FIX: deep-clone creds and keys into plain objects via
  // toPlainFirestore() before writing. After a successful QR scan, Baileys
  // populates creds.account with an ADVSignedDeviceIdentity protobuf instance
  // (custom prototype created via `new`). Firestore REJECTS any object whose
  // prototype is not Object.prototype or Array.prototype — it throws:
  //   "Couldn't serialize object of type 'ADVSignedDeviceIdentity' ...
  //    Firestore doesn't support JavaScript objects with custom prototypes"
  // When persistState threw, the freshly-paired creds never made it to
  // Firestore → on the next reconnect (status 515) we generated fresh
  // initAuthCreds() and the completed registration was lost → the phone
  // showed "couldn't connect, scan QR again" and the UI spun forever.
  //
  // toPlainFirestore() copies any custom-prototype object into a fresh {}
  // (preserving all own enumerable props) so Firestore accepts it, while
  // leaving Buffer and Date instances untouched (Firestore stores those
  // natively as Blob / Timestamp and revives them on read).
  const persistState = async () => {
    if (!state.creds) return
    try {
      cached.creds = state.creds  // keep cached in sync
      const plainCreds = toPlainFirestore(state.creds)
      const plainKeys = toPlainFirestore(cached.keys)
      await docRef.set({
        creds: plainCreds,
        keys: plainKeys,
        updatedAt: new Date(),
      }, { merge: false })
    } catch (err) {
      console.error(`[WA-FS-Auth:${userId}] persistState failed:`, err && err.message)
    }
  }

  const saveCreds = async () => {
    if (!state.creds) {
      console.warn(`[WA-FS-Auth:${userId}] saveCreds called but state.creds is null — Baileys may not have initialized yet`)
      return
    }
    await persistState()
  }

  function schedulePersist() {
    if (writeTimer) return
    writeTimer = setTimeout(async () => {
      writeTimer = null
      pendingWrite = true
      try {
        await persistState()
      } finally {
        pendingWrite = false
      }
    }, 800)  // 800ms debounce — same as Baileys' filesystem default
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
