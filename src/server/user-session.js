// ====================================================================
// Whats-Odoo v7.23 — PER-USER SESSION
// --------------------------------------------------------------------
// Each logged-in middleware user has their own UserSession instance:
//   - Own Baileys WhatsApp socket (data/auth_<userId>/creds.json)
//   - Own conversations/messages state (in-memory Map + data/conv_state_<userId>.json)
//   - Own Odoo connection (per-user creds from DB, falling back to global OdooConfig)
//   - Own socket.io event routing (only sees their own QR codes + conversations)
//
// This file is CommonJS because server.js is CommonJS.
//
// The SessionManager lazily creates/starts a UserSession on the first
// socket.io connection from a logged-in user. Sessions stay alive after
// the socket disconnects (so WhatsApp stays connected); they are only
// destroyed by SessionManager.invalidate(userId) — currently only called
// on server shutdown.
//
// The pure helpers (normalizeJid, escapeHtml, etc.) are exported for
// server.js to use directly when wiring socket handlers.
// ====================================================================

const path = require('path')
const fs = require('fs')
const { createClient, createSecureClient } = require('xmlrpc')
const { PrismaClient } = require('@prisma/client')

// v7.30: Firestore-backed Baileys auth state — persists WhatsApp sessions
// across deploys even if the disk is wiped. Falls back to filesystem
// (useMultiFileAuthState) if Firestore is not configured.
const { usePersistentAuthState } = require('./wa-firestore-auth-state.cjs')

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data')

// ====================================================================
// PURE HELPERS — module-level (don't touch per-user state)
// ====================================================================

// Baileys can deliver JIDs in several forms:
//   5511999888777@s.whatsapp.net            — canonical DM
//   5511999888777:7@s.whatsapp.net          — DM with device suffix (multi-device send)
//   5511999888777:7:3@s.whatsapp.net        — DM with device + agent suffix
//   5511999888777@lid                        — Linked Identity (newer protocol)
// We normalize everything to canonical form: <digits>@s.whatsapp.net
function normalizeJid(jid) {
  if (!jid || typeof jid !== 'string') return null
  const atIdx = jid.indexOf('@')
  if (atIdx < 0) return null
  const server = jid.slice(atIdx + 1)
  if (server !== 's.whatsapp.net') return null
  const userCombined = jid.slice(0, atIdx)
  const user = userCombined.split(':')[0].split('_')[0]
  if (!/^\d{7,}$/.test(user)) return null
  return `${user}@s.whatsapp.net`
}

function isValidPhoneJid(jid) {
  return normalizeJid(jid) !== null
}

function extractPhone(jid) {
  const normalized = normalizeJid(jid)
  return normalized ? normalized.split('@')[0] : null
}

// Compatibility alias — many call sites use jidNormalizedUser()
function jidNormalizedUser(jid) {
  return normalizeJid(jid) || jid
}

// Normalize a phone number (strip non-digits) to a WhatsApp JID
function normalizePhoneToJid(phone) {
  if (!phone) return null
  const digits = String(phone).replace(/\D/g, '')
  if (digits.length < 7) return null
  return `${digits}@s.whatsapp.net`
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br/>')
}

function stripHtml(html) {
  if (!html) return ''
  let text = String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
  text = text.replace(/\n{3,}/g, '\n\n')
  return text
}

// v7.28: Parse a chatter body produced by buildChatterBody() back into clean
// message components (direction, timestamp, text). The chatter body format is:
//   <div><strong>📱 WhatsApp {Enviada|Recebida}:</strong> {ts}<br/>{mediaLine}<span>{text}</span></div>
// We want to extract ONLY the user-visible text (the <span> content), detect
// the direction from "Enviada" vs "Recebida", and parse the timestamp.
// Falls back to stripHtml() for any non-conforming body (e.g. messages posted
// by other Odoo users from the web UI — those are returned as-is, plain text).
function parseChatterBody(body) {
  if (!body) return { fromMe: false, timestamp: null, text: '' }
  const s = String(body)

  // Detect direction from the "WhatsApp Enviada/Recebida:" marker
  const isSent = /WhatsApp\s+Enviada/i.test(s)
  const fromMe = isSent

  // Extract timestamp from "(...)" — buildChatterBody uses toLocaleString('pt-BR')
  // inside parentheses as part of the label. Actually buildChatterBody does NOT
  // wrap in parens — it inserts the timestamp directly after the colon.
  // But older messages may have the "(date)" format. Support both.
  let timestamp = null
  const parenMatch = s.match(/\(([^)]+)\)/)
  if (parenMatch) {
    const parsed = new Date(parenMatch[1])
    if (!isNaN(parsed.getTime())) timestamp = parsed
  }

  // Extract the text content from the <span>...</span> block (the real message)
  let text = ''
  const spanMatch = s.match(/<span[^>]*>([\s\S]*?)<\/span>/i)
  if (spanMatch) {
    text = stripHtml(spanMatch[1])
  } else {
    // No <span> — this isn't a WhatsApp chatter message produced by us.
    // It's probably a note posted by a human via the Odoo UI, or a different
    // format entirely. Strip HTML and return the whole body as plain text.
    text = stripHtml(s)
    // If the body still starts with the WhatsApp metadata header, strip it.
    // This handles the case where buildChatterBody emitted no <span> because
    // textContent was empty (media-only message).
    const headerMatch = text.match(/^📱\s*WhatsApp\s+(Enviada|Recebida)[:\s]*(.*)$/is)
    if (headerMatch) {
      // For media-only messages, the "text" will be empty after the header.
      // Strip the header line and keep the remaining content (media label).
      const remaining = text.slice(headerMatch[0].length).trim()
      // Try to detect a media label line like "🎙️ Áudio"
      const mediaMatch = remaining.match(/^([🎙️🖼️📄🎬🏷️][^\n]*)/)
      text = mediaMatch ? mediaMatch[1] : remaining
    }
  }

  // Try to parse timestamp from the label after the colon (no parens case)
  if (!timestamp) {
    // Look for a date pattern like "14/08/2026, 10:30:45" or "14/08/2026 10:30"
    const dateMatch = s.match(/(\d{1,2}\/\d{1,2}\/\d{4})[,\s]+(\d{1,2}:\d{2}(?::\d{2})?)/)
    if (dateMatch) {
      const [_, d, t] = dateMatch
      // pt-BR format: DD/MM/YYYY HH:MM:SS
      const parsed = new Date(`${d.split('/').reverse().join('-')}T${t}`)
      if (!isNaN(parsed.getTime())) timestamp = parsed
    }
  }

  return { fromMe, timestamp, text }
}

// Extract a display name from a message's pushName field
function pushNameFallback(msg) {
  return msg?.pushName || null
}

// v7.19: Build a plain-text transcript of the WhatsApp conversation that will
// be written to the `description` field (Notes) of the CRM lead/opportunity.
function buildConversationTranscript(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return ''
  const sorted = [...messages].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  )
  const lines = sorted.map((m) => {
    const direction = m.fromMe ? 'Eu' : 'Contato'
    const dateLabel = new Date(m.timestamp).toLocaleString('pt-BR')
    const mediaLabel = m.mediaType ? ` [${m.mediaType}]` : ''
    const text = m.textContent && m.textContent.trim() ? m.textContent : '[Mídia]'
    return `[${dateLabel}] ${direction}${mediaLabel}: ${text}`
  })
  return `Conversa WhatsApp:\n${lines.join('\n')}`
}

// ====================================================================
// UserSession — encapsulates ALL per-user state
// ====================================================================

class UserSession {
  constructor({ userId, user, io, prisma, sessionManager }) {
    this.userId = userId
    this.user = user              // Prisma User record (with odooUrl etc.)
    this.io = io                  // socket.io server instance (for namespaces)
    this.prisma = prisma          // shared PrismaClient
    // v7.35: Reference back to the SessionManager — used to consult the
    // global conversation owner registry when filtering incoming messages
    // and outgoing echoes. Optional (some tests may construct UserSession
    // directly without a SessionManager; in that case the session will
    // process all messages, i.e., behave like the pre-v7.35 code).
    this.sessionManager = sessionManager || null

    // ===== Per-user paths =====
    this.authFolder = path.join(DATA_DIR, `auth_${userId}`)
    this.stateFile = path.join(DATA_DIR, `conv_state_${userId}.json`)
    this.mediaDir = path.join(DATA_DIR, 'media')  // shared (filenames are random cuids)

    // ===== WhatsApp state =====
    this.waSocket = null
    this.connectionState = { connection: 'close' }
    this.hasSavedSession = fs.existsSync(path.join(this.authFolder, 'creds.json'))
    this.lastQrCode = null
    this.reconnectAttempts = 0
    this.watchdogTimer = null
    this.initialConnectWatchdog = null   // v7.32: initial-connect watchdog
    this.waConnecting = false        // v7.29: re-entrancy guard for connectWhatsApp
    this.waReconnectTimer = null     // v7.29: single pending reconnect timer
    this.conversations = new Map()
    this.contactNames = new Map()
    this.deviceContacts = new Map()
    this.lidToPhoneMap = new Map()
    this.syncState = { isSyncing: false, progress: 0, totalChats: 0, totalContacts: 0, totalMessages: 0 }
    this.lastPersistTs = 0
    this.conversationDirty = false

    // v7.15: Ring buffer of recent `messages.upsert` events for debugging.
    this.recentUpsertEvents = []
    this.MAX_RECENT_EVENTS = 50

    // ===== Odoo state — initialized from user record =====
    // Per-user creds take precedence; if empty, loadOdooConfig() will fall
    // back to the global OdooConfig row from the DB.
    this.odooConfig = {
      url: user.odooUrl || '',
      db: user.odooDb || '',
      username: user.odooUsername || '',
      password: user.odooPassword || '',
      uid: null,
    }
    this.usingGlobalOdooConfig = !(this.odooConfig.url && this.odooConfig.db && this.odooConfig.username && this.odooConfig.password)

    this.autoSyncSettings = {
      enabled: true,
      autoCreateContact: true,
      autoCreateLead: false,       // v7.19: default OFF per user request
      autoPostMessages: true,
      autoCreateActivity: false,
      leadPrefix: '[WhatsApp] ',
      leadTeamId: null,
      leadUserId: null,
    }
    this.odooReauthTimer = null
    this.modelFieldsCache = new Map()
    this.phoneToPartnerCache = new Map()
    // Track which WhatsApp message IDs have already been posted to Odoo chatter
    this.postedChatterIds = new Set()
    // Track active lead IDs by phone (refreshed on every auto-sync)
    this.phoneToActiveLeadCache = new Map()

    // v7.21: Odoo chatter history sync state
    this.odooHistorySyncInProgress = false
    this.odooHistorySyncLastRun = null

    // ===== Socket.io bookkeeping =====
    this.connectedSockets = new Set()  // socket.io Socket instances subscribed to this user
    this.persistTimer = null
    this.isStarted = false
    this.isStarting = false
  }

  // ------------------------------------------------------------------
  // Emit helpers — send only to sockets subscribed to THIS user
  // ------------------------------------------------------------------
  emitWA(event, data) {
    for (const s of this.connectedSockets) {
      try { s.emit(event, data) } catch {}
    }
  }
  emitOdoo(event, data) {
    for (const s of this.connectedSockets) {
      try { s.emit(event, data) } catch {}
    }
  }
  // Emit to a specific socket (used for the initial burst on connection)
  emitTo(socket, event, data) {
    try { socket.emit(event, data) } catch {}
  }

  markDirty() { this.conversationDirty = true }

  logUpsertEvent(event) {
    try {
      this.recentUpsertEvents.push({ ts: new Date().toISOString(), ...event })
      while (this.recentUpsertEvents.length > this.MAX_RECENT_EVENTS) this.recentUpsertEvents.shift()
    } catch {}
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  async loadOdooConfig() {
    // If per-user creds are already set, nothing to do
    if (this.odooConfig.url && this.odooConfig.db && this.odooConfig.username && this.odooConfig.password) {
      this.usingGlobalOdooConfig = false
      return
    }
    // Fall back to global OdooConfig table
    try {
      const globalConfig = await this.prisma.odooConfig.findFirst({
        where: { active: true },
        orderBy: { updatedAt: 'desc' },
      })
      if (globalConfig) {
        this.odooConfig = {
          url: globalConfig.url,
          db: globalConfig.db,
          username: globalConfig.username,
          password: globalConfig.password,
          uid: null,
        }
        this.usingGlobalOdooConfig = true
        console.log(`[UserSession:${this.userId}] Using GLOBAL OdooConfig (no per-user creds set)`)
      } else {
        this.usingGlobalOdooConfig = true
        console.log(`[UserSession:${this.userId}] No Odoo config (per-user or global) — Odoo features disabled`)
      }
    } catch (err) {
      console.error(`[UserSession:${this.userId}] loadOdooConfig failed: ${err.message}`)
    }
  }

  async start() {
    if (this.isStarted || this.isStarting) return
    this.isStarting = true
    try {
      fs.mkdirSync(this.authFolder, { recursive: true })
      fs.mkdirSync(this.mediaDir, { recursive: true })

      this.loadConversationsFromDisk()

      // Persist conversations every 30 seconds (debounced — only if changed)
      this.persistTimer = setInterval(() => {
        if (this.conversationDirty && Date.now() - this.lastPersistTs > 25_000) {
          this.conversationDirty = false
          this.lastPersistTs = Date.now()
          this.persistConversationsToDisk()
        }
      }, 30_000)

      // v7.30: Also check Firestore for an existing WhatsApp session.
      // If Firestore has creds for this user but the local filesystem
      // doesn't (e.g., after a deploy that wiped the disk), we still
      // have a saved session. Updates hasSavedSession before logging.
      try {
        const { getFirestoreOrNull } = require('./wa-firestore-auth-state.cjs')
        const db = getFirestoreOrNull()
        if (db && !this.hasSavedSession) {
          const snap = await db.collection('wa_auth_states').doc(String(this.userId)).get()
          if (snap.exists && snap.data() && snap.data().creds) {
            this.hasSavedSession = true
            console.log(`[UserSession:${this.userId}] Found saved session in Firestore (no local creds.json)`)
          }
        }
      } catch (err) {
        console.warn(`[UserSession:${this.userId}] Firestore session check failed:`, err && err.message)
      }

      console.log(`[UserSession:${this.userId}] Starting — user=${this.user.email}, hasSavedSession=${this.hasSavedSession}, usingGlobalOdooConfig=${this.usingGlobalOdooConfig}`)

      // Load Odoo config from DB (if needed) before starting auto-auth
      await this.loadOdooConfig()

      // Start WA + Odoo (fire-and-forget — they self-retry internally)
      this.connectWhatsApp().catch(err => console.error(`[UserSession:${this.userId}] WA startup error:`, err.message))
      this.startOdooAutoAuth().catch(err => console.error(`[UserSession:${this.userId}] Odoo startup error:`, err.message))

      this.isStarted = true
    } finally {
      this.isStarting = false
    }
  }

  stop() {
    try {
      if (this.persistTimer) { clearInterval(this.persistTimer); this.persistTimer = null }
      if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null }
      if (this.waReconnectTimer) { clearTimeout(this.waReconnectTimer); this.waReconnectTimer = null }
      // v7.32: clear the initial-connect watchdog if still pending
      if (this.initialConnectWatchdog) { clearTimeout(this.initialConnectWatchdog); this.initialConnectWatchdog = null }
      if (this.odooReauthTimer) { clearInterval(this.odooReauthTimer); this.odooReauthTimer = null }
      try { this.waSocket?.end(undefined) } catch {}
      this.persistConversationsToDisk()
      console.log(`[UserSession:${this.userId}] Stopped`)
    } catch (err) {
      console.error(`[UserSession:${this.userId}] Stop error:`, err.message)
    }
  }

  // v7.24 (R6): Pre-deploy backup — dump this user's WA creds + conversation
  // state to Odoo chatter so the data survives even if the disk is wiped
  // during a Render deploy. Posted as a mail.message on a designated
  // res.partner (the user's own partner if findable, otherwise partner 1).
  //
  // Format: subject `[BACKUP-CREDS] User <email> — <timestamp>`, body is
  // JSON-stringified { creds, conversations }. If the JSON is too large
  // (>600 KB per chunk — Odoo's chatter body limit is ~1MB), it's split
  // into N chunks posted as separate messages with subject suffix `[1/N]`.
  //
  // Returns: { success, chunksPosted, partnerId, error? }
  async backupToOdoo() {
    if (!this.odooConfig.uid) {
      return { success: false, chunksPosted: 0, error: 'Odoo not authenticated' }
    }
    try {
      // Persist current state to disk first (so the backup reflects the
      // latest conversations, not the last periodic save).
      this.persistConversationsToDisk()

      // Read creds.json
      const credsPath = path.join(this.authFolder, 'creds.json')
      let credsJson = null
      try {
        if (fs.existsSync(credsPath)) {
          credsJson = JSON.parse(fs.readFileSync(credsPath, 'utf8'))
        }
      } catch (err) {
        console.warn(`[Backup:${this.userId}] Could not read creds.json:`, err.message)
      }

      // Read conv_state_<userId>.json
      let convState = null
      try {
        if (fs.existsSync(this.stateFile)) {
          convState = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
        }
      } catch (err) {
        console.warn(`[Backup:${this.userId}] Could not read conv state:`, err.message)
      }

      // Build the JSON payload
      const payload = JSON.stringify({
        userId: this.userId,
        email: this.user.email,
        backedUpAt: new Date().toISOString(),
        version: '7.24',
        creds: credsJson,
        conversations: convState,
      })

      // Find a partner to post to. Strategy: look up res.partner by the
      // user's email; if not found, fall back to partner id 1
      // (Administrator in most Odoo installs).
      let backupPartnerId = 1
      try {
        const partners = await this.odooExecuteKw('res.partner', 'search_read', [
          [['email', '=', this.user.email]],
        ], { fields: ['id', 'name'], limit: 1 })
        if (partners && partners.length > 0) {
          backupPartnerId = partners[0].id
        } else {
          // Fall back: try admin user's partner (res.users where login = 'admin')
          const adminUsers = await this.odooExecuteKw('res.users', 'search_read', [
            [['login', '=', 'admin']],
          ], { fields: ['partner_id'], limit: 1 })
          if (adminUsers && adminUsers.length > 0 && adminUsers[0].partner_id) {
            backupPartnerId = adminUsers[0].partner_id[0]
          }
        }
      } catch (err) {
        console.warn(`[Backup:${this.userId}] Partner lookup failed, using id=1:`, err.message)
      }

      // Split into chunks of ~600 KB (base64 expansion + Odoo overhead
      // means 600 KB raw → ~800 KB on the wire, safely under 1 MB).
      const CHUNK_SIZE = 600_000
      const chunks = []
      for (let i = 0; i < payload.length; i += CHUNK_SIZE) {
        chunks.push(payload.slice(i, i + CHUNK_SIZE))
      }
      if (chunks.length === 0) chunks.push('')

      const tsLabel = new Date().toISOString()
      const subject = `[BACKUP-CREDS] User ${this.user.email} — ${tsLabel}`
      const total = chunks.length

      for (let i = 0; i < chunks.length; i++) {
        const partNum = i + 1
        const body = `<div><strong>${subject}</strong> [${partNum}/${total}]<br/>` +
          `<em>Backup dos dados de conexão e conversas — não editar.</em>` +
          `<pre style="font-size:10px; white-space:pre-wrap; word-break:break-all;">${escapeHtml(chunks[i])}</pre></div>`
        try {
          await this.odooPostMessage('res.partner', backupPartnerId, body)
        } catch (err) {
          console.error(`[Backup:${this.userId}] Chunk ${partNum}/${total} failed:`, err.message)
          return { success: false, chunksPosted: i, partnerId: backupPartnerId, error: err.message }
        }
      }

      console.log(`[Backup:${this.userId}] ✓ Posted ${total} chunk(s) to partner ${backupPartnerId}`)
      return { success: true, chunksPosted: total, partnerId: backupPartnerId }
    } catch (err) {
      console.error(`[Backup:${this.userId}] Error:`, err.message)
      return { success: false, chunksPosted: 0, error: err.message }
    }
  }

  // ------------------------------------------------------------------
  // Persistence — conversations/contacts/messages to per-user JSON file
  // ------------------------------------------------------------------

  // v7.37: Build the snapshot object once, used by both disk + Firestore writes.
  _buildSnapshot() {
    return {
      version: 1,
      userId: this.userId,
      savedAt: new Date().toISOString(),
      conversations: Array.from(this.conversations.values()).map(c => ({
        jid: c.jid,
        name: c.name,
        phone: c.phone,
        pushName: c.pushName,
        avatarUrl: c.avatarUrl,
        lastMessage: c.lastMessage,
        lastMessageAt: c.lastMessageAt ? c.lastMessageAt.toISOString() : null,
        unreadCount: c.unreadCount,
        messages: c.messages.map(m => ({
          ...m,
          timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp,
        })),
      })),
      contactNames: Array.from(this.contactNames.entries()),
      deviceContacts: Array.from(this.deviceContacts.values()),
      lidToPhoneMap: Array.from(this.lidToPhoneMap.entries()),
    }
  }

  persistConversationsToDisk() {
    try {
      const snapshot = this._buildSnapshot()
      fs.writeFileSync(this.stateFile, JSON.stringify(snapshot), 'utf8')
      console.log(`[UserSession:${this.userId}] Persisted ${snapshot.conversations.length} conversations, ${snapshot.deviceContacts.length} device contacts to disk`)

      // v7.37: Also persist to Firestore so it survives Render deploys
      // (which wipe the ephemeral disk). Fire-and-forget — the disk write
      // already guarantees durability for the current process. If Firestore
      // is unconfigured or fails, we just log and continue.
      this._persistConversationsToFirestore(snapshot).catch(err => {
        console.warn(`[UserSession:${this.userId}] Firestore conv-state persist failed: ${err && err.message}`)
      })
    } catch (err) {
      console.error(`[UserSession:${this.userId}] Failed to persist conversations: ${err.message}`)
    }
  }

  // v7.37: Persist conversation state to Firestore.
  // Stored in collection `wa_conv_states` keyed by userId. This is the
  // counterpart to `wa_auth_states` — together they allow a full session
  // (auth creds + all conversations/contacts) to survive a Render deploy
  // or any other ephemeral-disk wipe.
  async _persistConversationsToFirestore(snapshot) {
    const { getFirestoreOrNull } = require('./wa-firestore-auth-state.cjs')
    const db = getFirestoreOrNull()
    if (!db) return  // Firestore not configured — disk-only mode
    const docRef = db.collection('wa_conv_states').doc(String(this.userId))
    // Firestore docs have a 1 MiB size limit. A snapshot with many
    // conversations + messages could exceed this. We attempt the write
    // and log on failure — but for typical usage (<500 conversations,
    // <200 messages each) we stay well under the limit.
    await docRef.set({
      snapshot: JSON.stringify(snapshot),
      savedAt: new Date(),
      conversationCount: snapshot.conversations.length,
      deviceContactCount: snapshot.deviceContacts.length,
    }, { merge: false })
    console.log(`[UserSession:${this.userId}] ✓ Persisted conv state to Firestore (${snapshot.conversations.length} convs, ${snapshot.deviceContacts.length} contacts)`)
  }

  loadConversationsFromDisk() {
    try {
      let snapshot = null
      if (fs.existsSync(this.stateFile)) {
        const raw = fs.readFileSync(this.stateFile, 'utf8')
        snapshot = JSON.parse(raw)
        if (!snapshot || snapshot.version !== 1) {
          console.log(`[UserSession:${this.userId}] Saved conversation state on disk is old format — ignoring`)
          snapshot = null
        }
      }

      // v7.37: If disk file is missing or old format (typical after a Render
      // deploy that wiped the ephemeral disk), try to load from Firestore.
      // The Firestore doc stores the same snapshot JSON-stringified.
      if (!snapshot) {
        console.log(`[UserSession:${this.userId}] No conv state on disk — trying Firestore fallback`)
        // We can't use await here because loadConversationsFromDisk is
        // synchronous (called from start() before the async connect flow).
        // Spawn an async load that re-populates Maps AFTER start returns.
        // This is OK because Baileys' live events will keep working in the
        // background; we just need to populate the Maps before the UI
        // requests them.
        this._loadConversationsFromFirestore().catch(err => {
          console.warn(`[UserSession:${this.userId}] Firestore conv-state load failed: ${err && err.message}`)
        })
        return
      }

      this._applySnapshot(snapshot)
      console.log(`[UserSession:${this.userId}] ✓ Loaded ${this.conversations.size} conversations, ${this.contactNames.size} contact names, ${this.deviceContacts.size} device contacts from disk (saved ${snapshot.savedAt})`)
    } catch (err) {
      console.error(`[UserSession:${this.userId}] Failed to load conversations from disk: ${err.message}`)
    }
  }

  // v7.37: Load conversation state from Firestore and apply it.
  // Used when the local disk file is missing (e.g., after Render deploy).
  async _loadConversationsFromFirestore() {
    try {
      const { getFirestoreOrNull } = require('./wa-firestore-auth-state.cjs')
      const db = getFirestoreOrNull()
      if (!db) {
        console.log(`[UserSession:${this.userId}] No Firestore conv state available — starting fresh`)
        return
      }
      const docRef = db.collection('wa_conv_states').doc(String(this.userId))
      const doc = await docRef.get()
      if (!doc.exists) {
        console.log(`[UserSession:${this.userId}] No conv state in Firestore — starting fresh`)
        return
      }
      const data = doc.data()
      if (!data || !data.snapshot) {
        console.log(`[UserSession:${this.userId}] Firestore conv state doc has no snapshot — starting fresh`)
        return
      }
      let snapshot
      try { snapshot = JSON.parse(data.snapshot) }
      catch { console.warn(`[UserSession:${this.userId}] Firestore conv state snapshot is not valid JSON`); return }
      if (!snapshot || snapshot.version !== 1) {
        console.log(`[UserSession:${this.userId}] Firestore conv state is old format — ignoring`)
        return
      }
      this._applySnapshot(snapshot)
      console.log(`[UserSession:${this.userId}] ✓✓ Loaded ${this.conversations.size} conversations, ${this.contactNames.size} contact names, ${this.deviceContacts.size} device contacts FROM FIRESTORE (saved ${snapshot.savedAt}) — disk was empty`)
      // Emit a conversations update so any connected frontend sees the
      // newly-restored conversations immediately.
      this.emitWA('whatsapp:conversations', this.getSortedConversations())
    } catch (err) {
      console.error(`[UserSession:${this.userId}] Failed to load conv state from Firestore:`, err && err.message)
    }
  }

  // v7.37: Apply a snapshot (from disk OR Firestore) to the in-memory Maps.
  // Shared by both loadConversationsFromDisk and _loadConversationsFromFirestore.
  _applySnapshot(snapshot) {
    let loaded = 0
    let droppedOwnedByOther = 0
    // v7.35/v7.37/v7.38: When loading saved conversations, filter out any
    // conversation that is now owned by ANOTHER user (non-admin only).
    // Admin loads all conversations. Conversations with no owner (external
    // leads) are kept — they're visible to everyone per v7.36 rules.
    const _sm = this.sessionManager
    const _isAdmin = this.user && this.user.role === 'admin'
    for (const c of snapshot.conversations || []) {
      if (!c.jid || !isValidPhoneJid(c.jid)) continue
      if (_sm) {
        const owner = _sm.getConversationOwner(c.jid)
        if (owner && owner !== this.userId && !_isAdmin) {
          droppedOwnedByOther++
          continue
        }
      }
      this.conversations.set(c.jid, {
        jid: c.jid,
        name: c.name || null,
        phone: c.phone || extractPhone(c.jid),
        pushName: c.pushName || null,
        avatarUrl: c.avatarUrl || null,
        lastMessage: c.lastMessage || null,
        lastMessageAt: c.lastMessageAt ? new Date(c.lastMessageAt) : null,
        unreadCount: c.unreadCount || 0,
        messages: (c.messages || []).map(m => ({
          ...m,
          timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
        })),
      })
      loaded++
    }
    if (droppedOwnedByOther > 0) {
      console.log(`[UserSession:${this.userId}] Dropped ${droppedOwnedByOther} conversation(s) from saved state — owned by other users (v7.35 isolation, non-admin only)`)
    }

    for (const [jid, name] of snapshot.contactNames || []) {
      this.contactNames.set(jid, name)
    }
    for (const c of snapshot.deviceContacts || []) {
      if (c.jid) this.deviceContacts.set(c.jid, c)
    }
    for (const [lid, phone] of snapshot.lidToPhoneMap || []) {
      this.lidToPhoneMap.set(lid, phone)
    }
  }

  // ------------------------------------------------------------------
  // Conversation helpers
  // ------------------------------------------------------------------

  getOrCreateConversation(jid, pushName) {
    const normalizedJid = normalizeJid(jid)
    if (!normalizedJid) return null
    const cachedName = this.contactNames.get(normalizedJid) || null
    const phone = extractPhone(normalizedJid)

    if (!this.conversations.has(normalizedJid)) {
      this.conversations.set(normalizedJid, {
        jid: normalizedJid,
        name: cachedName || pushName || null,
        phone,
        pushName: pushName || null,
        avatarUrl: null,
        lastMessage: null,
        lastMessageAt: new Date(),
        unreadCount: 0,
        messages: [],
      })
    }
    const conv = this.conversations.get(normalizedJid)
    if (cachedName) {
      conv.name = cachedName
    } else if (pushName && !conv.name) {
      conv.pushName = pushName
    }

    // Also track in deviceContacts phonebook
    const displayName = cachedName || pushName || phone
    if (phone) {
      if (!this.deviceContacts.has(normalizedJid)) {
        this.deviceContacts.set(normalizedJid, { jid: normalizedJid, phone, name: displayName, avatarUrl: null })
      } else if (cachedName) {
        this.deviceContacts.get(normalizedJid).name = cachedName
      }
    }

    return conv
  }

  serializeConversation(conv) {
    if (!conv) return null
    return {
      jid: conv.jid,
      name: conv.name,
      phone: conv.phone,
      pushName: conv.pushName,
      avatarUrl: conv.avatarUrl,
      lastMessage: conv.lastMessage,
      lastMessageAt: conv.lastMessageAt ? conv.lastMessageAt.toISOString() : null,
      unreadCount: conv.unreadCount,
      messageCount: conv.messages.length,
    }
  }

  getSortedConversations() {
    // v7.20: Conversas tab shows BOTH actual conversations AND device contacts
    // that don't have a conversation yet. Unified list.
    // v7.35: Apply ownership filter — non-admin users see only conversations
    // they own (i.e., that they initiated by sending the first message via
    // the system). Admins see all conversations including unclaimed ones
    // (contact-initiated leads that nobody has grabbed yet).
    // v7.36: External inbound messages (unclaimed conversations) and device
    // contacts are now visible to BOTH admin and normal users — so normal
    // users can see new leads arriving and respond (thereby claiming the
    // conversation). Only conversations OWNED BY ANOTHER user remain hidden.
    const conversationJids = new Set(this.conversations.keys())
    const deviceContactEntries = []
    const isAdmin = this.user && this.user.role === 'admin'
    const isOwnerOf = (jid) => {
      if (isAdmin) return true  // admin sees everything
      if (!this.sessionManager) return true  // no registry → no filtering (test mode)
      const owner = this.sessionManager.getConversationOwner(jid)
      if (!owner) return true  // v7.36: unclaimed → visible to everyone (new lead)
      if (owner === this.userId) return true  // user owns this conversation
      return false  // owned by someone else → hide from this non-admin user
    }
    for (const contact of this.deviceContacts.values()) {
      if (conversationJids.has(contact.jid)) continue
      // v7.36: device contacts are NOT subject to ownership filtering.
      // They are just an address book entry from the phone — every user
      // (admin or not) should be able to start a new conversation with
      // any of these contacts. Ownership is only enforced AFTER a
      // conversation is actually initiated via the system.
      deviceContactEntries.push({
        jid: contact.jid,
        name: contact.name,
        phone: contact.phone,
        pushName: null,
        avatarUrl: contact.avatarUrl || null,
        lastMessage: null,
        lastMessageAt: null,
        unreadCount: 0,
        messageCount: 0,
        _isDeviceContact: true,
      })
    }

    return Array.from(this.conversations.values())
      .filter(conv => isValidPhoneJid(conv.jid))
      .filter(conv => isOwnerOf(conv.jid))  // v7.35: ownership filter
      .map(c => this.serializeConversation(c))
      .filter(Boolean)
      .concat(deviceContactEntries)
      .sort((a, b) => {
        const tA = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
        const tB = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
        if (tA === 0 && tB === 0) {
          return (a.name || a.phone || '').localeCompare(b.name || b.phone || '')
        }
        return tB - tA
      })
  }

  updateConversationName(jid, contactName) {
    const normalizedJid = normalizeJid(jid)
    if (!normalizedJid) return
    this.contactNames.set(normalizedJid, contactName)
    const phone = extractPhone(normalizedJid)
    const existing = this.deviceContacts.get(normalizedJid)
    if (existing) {
      existing.name = contactName
    } else if (phone) {
      this.deviceContacts.set(normalizedJid, { jid: normalizedJid, phone, name: contactName, avatarUrl: null })
    }
    const conv = this.conversations.get(normalizedJid)
    if (conv) conv.name = contactName
  }

  getDeviceContactsList() {
    return Array.from(this.deviceContacts.values())
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  }

  // ------------------------------------------------------------------
  // Odoo XML-RPC methods (all use this.odooConfig)
  // ------------------------------------------------------------------

  makeXmlRpcClient(p) {
    const url = new URL(this.odooConfig.url)
    const isHttps = url.protocol === 'https:'
    const options = {
      host: url.hostname,
      port: parseInt(url.port) || (isHttps ? 443 : 80),
      path: p,
    }
    return isHttps ? createSecureClient(options) : createClient(options)
  }

  odooAuthenticate() {
    return new Promise((resolve, reject) => {
      // v7.29.2: 30s timeout on auth — same reasoning as odooExecuteKw
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error('Odoo authenticate timeout after 30s'))
      }, 30_000)
      try {
        const client = this.makeXmlRpcClient('/xmlrpc/2/common')
        client.methodCall('authenticate', [this.odooConfig.db, this.odooConfig.username, this.odooConfig.password, {}], (error, value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (error) reject(error)
          else if (!value) reject(new Error('Authentication failed - invalid credentials'))
          else resolve(value)
        })
      } catch (err) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      }
    })
  }

  odooExecuteKw(model, method, args, kwargs = {}) {
    return new Promise((resolve, reject) => {
      if (!this.odooConfig.uid) {
        reject(new Error('Not authenticated with Odoo'))
        return
      }
      // v7.29.2: Add 30s timeout. Without this, if Odoo hangs (network
      // glitch, server slow), the Promise never resolves and the calling
      // code stays blocked forever — which blocks the WA message handler
      // and the user perceives it as "the page fell".
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(`Odoo ${model}.${method} timeout after 30s`))
      }, 30_000)
      try {
        const client = this.makeXmlRpcClient('/xmlrpc/2/object')
        client.methodCall('execute_kw', [this.odooConfig.db, this.odooConfig.uid, this.odooConfig.password, model, method, args, kwargs], (error, value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (error) reject(error)
          else resolve(value)
        })
      } catch (err) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      }
    })
  }

  async getAvailableFields(model) {
    if (this.modelFieldsCache.has(model)) return this.modelFieldsCache.get(model)
    try {
      const fields = await this.odooExecuteKw(model, 'fields_get', [], { attributes: ['string', 'type'] })
      const fieldNames = new Set(Object.keys(fields))
      this.modelFieldsCache.set(model, fieldNames)
      console.log(`[Odoo:${this.userId}] Model ${model} has ${fieldNames.size} fields`)
      return fieldNames
    } catch (error) {
      console.error(`[Odoo:${this.userId}] Failed to get fields for ${model}:`, error.message)
      return new Set()
    }
  }

  async filterExistingFields(model, requestedFields) {
    const available = await this.getAvailableFields(model)
    const existing = requestedFields.filter(f => available.has(f))
    if (!existing.includes('id') && available.has('id')) existing.unshift('id')
    if (!existing.includes('name') && available.has('name')) existing.push('name')
    return existing
  }

  async buildSafeValues(model, values) {
    const available = await this.getAvailableFields(model)
    const safe = {}
    for (const [key, value] of Object.entries(values)) {
      if (available.has(key)) safe[key] = value
    }
    return safe
  }

  async odooSearch(model, domain, fields = [], limit = 80, offset = 0) {
    const safeFields = fields.length > 0 ? await this.filterExistingFields(model, fields) : []
    return this.odooExecuteKw(model, 'search_read', [domain], {
      fields: safeFields.length > 0 ? safeFields : undefined,
      limit,
      offset,
    })
  }

  // v7.20: Build a phone-number search domain that ONLY uses fields the model has
  async buildPhoneSearchDomain(model, phone, candidateFields = ['phone', 'mobile', 'whatsapp', 'whatsapp_number']) {
    if (!phone) return []
    const available = await this.getAvailableFields(model)
    const usable = candidateFields.filter(f => available.has(f))
    if (usable.length === 0) {
      return [['name', 'ilike', phone]]
    }
    if (usable.length === 1) {
      return [[usable[0], 'ilike', phone]]
    }
    const domain = []
    for (let i = 0; i < usable.length - 1; i++) domain.push('|')
    for (const f of usable) domain.push([f, 'ilike', phone])
    return domain
  }

  async odooRead(model, ids, fields = []) {
    const safeFields = fields.length > 0 ? await this.filterExistingFields(model, fields) : []
    return this.odooExecuteKw(model, 'read', [ids], {
      fields: safeFields.length > 0 ? safeFields : undefined,
    })
  }

  async odooCreate(model, values) {
    const safeValues = await this.buildSafeValues(model, values)
    return this.odooExecuteKw(model, 'create', [safeValues])
  }

  async odooWrite(model, ids, values) {
    const safeValues = await this.buildSafeValues(model, values)
    return this.odooExecuteKw(model, 'write', [ids, safeValues])
  }

  async odooSearchOrCreate(model, domain, values) {
    const existing = await this.odooExecuteKw(model, 'search', [domain], { limit: 1 })
    if (existing && existing.length > 0) {
      const safeValues = await this.buildSafeValues(model, values)
      await this.odooWrite(model, existing, safeValues)
      return { id: existing[0], created: false }
    }
    const safeValues = await this.buildSafeValues(model, values)
    const newId = await this.odooCreate(model, safeValues)
    return { id: newId, created: true }
  }

  async odooPostMessage(model, recordId, message) {
    return this.odooExecuteKw(model, 'message_post', [recordId], {
      body: message,
      message_type: 'comment',
      subtype_xmlid: 'mail.mt_comment',
    })
  }

  // v7.24 (R7): Post a message to Odoo chatter WITH media attachments.
  // Uploads the media as an ir.attachment (base64), then includes it in
  // the mail.message via attachment_ids. The body also gets a media
  // indicator line (🎙️ Áudio / 🖼️ Imagem / 📄 Documento / 🎬 Vídeo).
  // Emojis in the text content are preserved (UTF-8 is native to XML-RPC).
  //
  // mediaOpts: { mediaBase64, mimeType, fileName, mediaType } | null
  // Returns: { mailMessageId, attachmentIds }
  async odooPostMessageWithMedia(model, recordId, body, mediaOpts = null) {
    const attachmentIds = []

    if (mediaOpts && mediaOpts.mediaBase64 && mediaOpts.mimeType) {
      try {
        const safeName = mediaOpts.fileName || `midia-${Date.now()}`
        const attachmentId = await this.odooExecuteKw('ir.attachment', 'create', [{
          name: safeName,
          datas: mediaOpts.mediaBase64,
          mimetype: mediaOpts.mimeType,
          res_model: model,
          res_id: recordId,
        }])
        if (attachmentId) {
          attachmentIds.push(attachmentId)
          console.log(`[Odoo:${this.userId}] ✓ Attachment uploaded: ${safeName} (id=${attachmentId})`)
        }
      } catch (err) {
        console.error(`[Odoo:${this.userId}] Attachment create failed:`, err.message)
      }
    }

    // Build the mail.message payload. attachment_ids uses the Odoo
    // command tuple [6, 0, ids] = "replace the list with these ids".
    const kwargs = {
      body,
      message_type: 'comment',
      subtype_xmlid: 'mail.mt_comment',
    }
    if (attachmentIds.length > 0) {
      kwargs.attachment_ids = [[6, 0, attachmentIds]]
    }

    const mailMessageId = await this.odooExecuteKw(model, 'message_post', [recordId], kwargs)
    return { mailMessageId, attachmentIds }
  }

  // v7.24 (R7): Build the chatter body for a WhatsApp message that may
  // include media. Preserves emojis in the text content (no HTML escape
  // of UTF-8 emoji characters — only escapes HTML metacharacters).
  buildChatterBody(direction, timestamp, textContent, mediaOpts = null) {
    const tsLabel = new Date(timestamp).toLocaleString('pt-BR')
    let mediaLine = ''
    if (mediaOpts) {
      const t = mediaOpts.mediaType
      if (t === 'audio') mediaLine = '🎙️ Áudio<br/>'
      else if (t === 'image') mediaLine = '🖼️ Imagem<br/>'
      else if (t === 'document') mediaLine = `📄 ${escapeHtml(mediaOpts.fileName || 'Documento')}<br/>`
      else if (t === 'video') mediaLine = '🎬 Vídeo<br/>'
      else if (t === 'sticker') mediaLine = '🏷️ Sticker<br/>'
    }
    const textHtml = textContent ? `<span>${escapeHtml(textContent)}</span>` : ''
    return `<div><strong>📱 WhatsApp ${direction}:</strong> ${tsLabel}<br/>${mediaLine}${textHtml}</div>`
  }

  async findWhatsAppActivityType() {
    try {
      const types = await this.odooExecuteKw('mail.activity.type', 'search_read', [[['name', 'ilike', 'WhatsApp']]], { fields: ['id', 'name'], limit: 1 })
      if (types && types.length > 0) return types[0].id
    } catch {}
    return null
  }

  async odooCreateActivity(model, recordId, summary, note) {
    try {
      const activityTypeId = await this.findWhatsAppActivityType()
      const values = {
        res_model: model,
        res_id: recordId,
        summary,
        note,
        activity_type_id: activityTypeId || 1,
      }
      if (this.autoSyncSettings.leadUserId) values.user_id = this.autoSyncSettings.leadUserId
      return await this.odooExecuteKw('mail.activity', 'create', [values])
    } catch (error) {
      console.error(`[Odoo:${this.userId}] Failed to create activity:`, error.message)
      return 0
    }
  }

  async autoSyncWhatsAppMessage(data) {
    const result = {
      partnerId: null, leadId: null, mailMessageId: null, activityId: null,
      created: { partner: false, lead: false }, errors: [],
      chatterPosted: false, chatterLeadPosted: false,
    }

    if (!this.autoSyncSettings.enabled) {
      console.log(`[AutoSync:${this.userId}] SKIP — autoSyncSettings.enabled is false`)
      return result
    }
    if (!this.odooConfig.uid) {
      console.log(`[AutoSync:${this.userId}] SKIP — Odoo not authenticated (uid is null)`)
      return result
    }

    // Dedup by whatsappId (or fallback id) — never post the same message twice
    const dedupKey = data.dedupId
      ? `${data.jid}|${data.dedupId}`
      : `${data.jid}|${data.fromMe ? 'out' : 'in'}|${data.timestamp}|${(data.textContent || '').slice(0, 50)}`
    if (this.postedChatterIds.has(dedupKey)) {
      console.log(`[AutoSync:${this.userId}] Skipping — already posted to chatter: ${dedupKey}`)
      return result
    }

    console.log(`[AutoSync:${this.userId}] Processing message from ${data.phone} (fromMe=${data.fromMe}, autoCreateLead=${this.autoSyncSettings.autoCreateLead})`)

    try {
      // ===== Step 1: Always ensure partner exists (for both sent AND received) =====
      if (this.autoSyncSettings.autoCreateContact) {
        const contactName = data.pushName || `WhatsApp ${data.phone}`
        const partnerFields = await this.getAvailableFields('res.partner')
        const domain = await this.buildPhoneSearchDomain('res.partner', data.phone)

        const contactValues = { name: contactName, phone: data.phone }
        if (partnerFields.has('mobile')) contactValues.mobile = data.phone
        if (partnerFields.has('whatsapp')) contactValues.whatsapp = data.phone
        if (partnerFields.has('whatsapp_number')) contactValues.whatsapp_number = data.phone

        const partnerResult = await this.odooSearchOrCreate('res.partner', domain, contactValues)
        result.partnerId = partnerResult.id
        result.created.partner = partnerResult.created

        const cached = this.phoneToPartnerCache.get(data.phone)
        if (cached) cached.partnerId = partnerResult.id
        else this.phoneToPartnerCache.set(data.phone, { partnerId: partnerResult.id, leadId: null, leadCreated: false })
      }

      // ===== Step 2: For INCOMING messages, ensure a lead exists =====
      if (this.autoSyncSettings.autoCreateLead && !data.fromMe && result.partnerId) {
        const cached = this.phoneToPartnerCache.get(data.phone)
        if (cached && cached.leadId && cached.leadCreated) {
          result.leadId = cached.leadId
          console.log(`[AutoSync:${this.userId}] Lead reused from cache: crm.lead#${result.leadId}`)
        } else {
          const existingLeads = await this.odooSearch('crm.lead', [
            ['partner_id', '=', result.partnerId],
            ['type', '=', 'lead'],
            ['active', '=', true],
          ], ['id', 'name', 'stage_id'], 1)

          if (existingLeads && existingLeads.length > 0) {
            result.leadId = existingLeads[0].id
            if (cached) { cached.leadId = existingLeads[0].id; cached.leadCreated = true }
            else this.phoneToPartnerCache.set(data.phone, { partnerId: result.partnerId, leadId: existingLeads[0].id, leadCreated: true })
            console.log(`[AutoSync:${this.userId}] Lead reused from Odoo search: crm.lead#${result.leadId}`)
          } else {
            const leadName = `${this.autoSyncSettings.leadPrefix}${data.pushName || data.phone}`
            const leadValues = {
              name: leadName, type: 'lead', partner_id: result.partnerId, phone: data.phone,
              description: `Conversa iniciada via WhatsApp em ${new Date().toLocaleString('pt-BR')}`,
            }
            const leadFields = await this.getAvailableFields('crm.lead')
            if (leadFields.has('whatsapp_number')) leadValues.whatsapp_number = data.phone
            if (this.autoSyncSettings.leadTeamId) leadValues.team_id = this.autoSyncSettings.leadTeamId
            if (this.autoSyncSettings.leadUserId) leadValues.user_id = this.autoSyncSettings.leadUserId

            try {
              result.leadId = await this.odooCreate('crm.lead', leadValues)
              result.created.lead = true
              if (cached) { cached.leadId = result.leadId; cached.leadCreated = true }
              else this.phoneToPartnerCache.set(data.phone, { partnerId: result.partnerId, leadId: result.leadId, leadCreated: true })
              console.log(`[AutoSync:${this.userId}] ✓ NEW Lead created: crm.lead#${result.leadId}`)
            } catch (error) {
              console.error(`[AutoSync:${this.userId}] ✗ Lead creation FAILED: ${error.message}`)
              result.errors.push(`Lead creation failed: ${error.message}`)
            }
          }
        }
      } else if (this.autoSyncSettings.autoCreateLead && data.fromMe) {
        console.log(`[AutoSync:${this.userId}] Lead creation skipped — outgoing message`)
      }

      // ===== Step 2.5: For OUTGOING messages, find an active lead by phone =====
      if (data.fromMe && result.partnerId) {
        let cachedLeadId = this.phoneToActiveLeadCache.get(data.phone)
        if (!cachedLeadId) {
          const cached = this.phoneToPartnerCache.get(data.phone)
          if (cached && cached.leadId && cached.leadCreated) {
            cachedLeadId = cached.leadId
          } else {
            const existingLeads = await this.odooSearch('crm.lead', [
              ['partner_id', '=', result.partnerId],
              ['type', '=', 'lead'],
              ['active', '=', true],
            ], ['id'], 1)
            if (existingLeads && existingLeads.length > 0) {
              cachedLeadId = existingLeads[0].id
              if (cached) { cached.leadId = cachedLeadId; cached.leadCreated = true }
            }
          }
          if (cachedLeadId) {
            this.phoneToActiveLeadCache.set(data.phone, cachedLeadId)
            result.leadId = cachedLeadId
          }
        } else {
          result.leadId = cachedLeadId
        }
      }

      // ===== Step 3: ALWAYS post to chatter (incoming AND outgoing) =====
      if (this.autoSyncSettings.autoPostMessages && result.partnerId) {
        const direction = data.fromMe ? 'Enviada' : 'Recebida'

        // v7.24 (R7): Build the chatter body via the shared helper, which
        // includes a media indicator line (🎙️/🖼️/📄/🎬) when media is
        // present and preserves emoji characters in the text content.
        const mediaOpts = (data.mediaBase64 && data.mimeType)
          ? { mediaBase64: data.mediaBase64, mimeType: data.mimeType, fileName: data.fileName, mediaType: data.mediaType }
          : (data.mediaType ? { mediaType: data.mediaType, fileName: data.fileName } : null)
        const msgBody = this.buildChatterBody(direction, data.timestamp, data.textContent, mediaOpts)

        try {
          // v7.24 (R7): Use the media-aware post method when we have base64
          // data — it will upload the media as an ir.attachment and link it
          // to the mail.message. Falls back to plain text post otherwise.
          if (data.mediaBase64 && data.mimeType) {
            const r = await this.odooPostMessageWithMedia('res.partner', result.partnerId, msgBody, mediaOpts)
            result.mailMessageId = r.mailMessageId
          } else {
            result.mailMessageId = await this.odooPostMessage('res.partner', result.partnerId, msgBody)
          }
          result.chatterPosted = true
          console.log(`[AutoSync:${this.userId}] ✓ Posted to partner ${result.partnerId} chatter: ${direction}${data.mediaBase64 ? ' (with media)' : ''}`)
        } catch (error) {
          result.errors.push(`Failed to post to partner chatter: ${error.message}`)
        }

        if (result.leadId) {
          try {
            if (data.mediaBase64 && data.mimeType) {
              await this.odooPostMessageWithMedia('crm.lead', result.leadId, msgBody, mediaOpts)
            } else {
              await this.odooPostMessage('crm.lead', result.leadId, msgBody)
            }
            result.chatterLeadPosted = true
            console.log(`[AutoSync:${this.userId}] ✓ Posted to lead ${result.leadId} chatter: ${direction}${data.mediaBase64 ? ' (with media)' : ''}`)
          } catch (error) {
            result.errors.push(`Failed to post to lead chatter: ${error.message}`)
          }
        }
      }

      // ===== Step 4: Create activity ONLY for new leads =====
      if (this.autoSyncSettings.autoCreateActivity && result.created.lead && result.leadId) {
        try {
          result.activityId = await this.odooCreateActivity('crm.lead', result.leadId, 'Nova mensagem WhatsApp', `Contato ${data.pushName || data.phone} iniciou uma conversa via WhatsApp.\n\nMensagem: ${data.textContent || '[Mídia]'}`)
        } catch (error) {
          result.errors.push(`Failed to create activity: ${error.message}`)
        }
      }

      // ===== Step 5: Mark this message as posted (for dedup) =====
      if (result.chatterPosted || result.chatterLeadPosted) {
        this.postedChatterIds.add(dedupKey)
        if (this.postedChatterIds.size > 5000) {
          const firstKey = this.postedChatterIds.values().next().value
          this.postedChatterIds.delete(firstKey)
        }
      }
    } catch (error) {
      result.errors.push(`Auto-sync error: ${error.message}`)
      console.error(`[AutoSync:${this.userId}] Error:`, error.message)
    }

    return result
  }

  // v7.23: Renamed from autoAuthenticateFromEnv. Reads from this.odooConfig
  // (already populated from the user record / global OdooConfig in loadOdooConfig).
  // Same retry logic: 3 attempts with 5s delay, then a 60s background retry loop.
  async startOdooAutoAuth() {
    if (!this.odooConfig.url || !this.odooConfig.db || !this.odooConfig.username || !this.odooConfig.password) {
      console.log(`[Odoo:${this.userId}] No Odoo config — skipping auto-auth`)
      return
    }
    console.log(`[Odoo:${this.userId}] Auto-authenticating: ${this.odooConfig.url} / ${this.odooConfig.db} / ${this.odooConfig.username}`)

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (attempt === 1) {
          this.modelFieldsCache.clear()
          this.phoneToPartnerCache.clear()
        }
        const uid = await this.odooAuthenticate()
        this.odooConfig.uid = uid
        console.log(`[Odoo:${this.userId}] Auto-authenticated as ${this.odooConfig.username} (uid: ${uid}) on attempt ${attempt}`)
        await this.getAvailableFields('res.partner')
        await this.getAvailableFields('crm.lead')
        this.emitOdoo('odoo:status', {
          connected: true, url: this.odooConfig.url, db: this.odooConfig.db, username: this.odooConfig.username,
        })
        // v7.21: If WhatsApp is already connected, pull conversation history from Odoo
        if (this.waSocket && this.connectionState.connection === 'open') {
          console.log(`[Odoo:${this.userId}] WA is connected — scheduling Odoo history sync in 3s`)
          setTimeout(() => {
            this.syncAllConversationsFromOdoo({ silent: false }).catch(err =>
              console.error(`[Odoo:${this.userId}] Post-auth history sync failed:`, err.message)
            )
          }, 3000)
        }
        return
      } catch (error) {
        console.error(`[Odoo:${this.userId}] Auto-auth attempt ${attempt}/3 failed: ${error.message}`)
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 5000))
        }
      }
    }
    console.error(`[Odoo:${this.userId}] All auto-auth attempts failed. Background retry every 60s.`)
    if (!this.odooReauthTimer) {
      this.odooReauthTimer = setInterval(async () => {
        if (this.odooConfig.uid) {
          clearInterval(this.odooReauthTimer)
          this.odooReauthTimer = null
          return
        }
        console.log(`[Odoo:${this.userId}] Background re-auth attempt...`)
        try {
          const uid = await this.odooAuthenticate()
          this.odooConfig.uid = uid
          console.log(`[Odoo:${this.userId}] Background re-auth SUCCESS (uid: ${uid})`)
          await this.getAvailableFields('res.partner')
          await this.getAvailableFields('crm.lead')
          this.emitOdoo('odoo:status', {
            connected: true, url: this.odooConfig.url, db: this.odooConfig.db, username: this.odooConfig.username,
          })
          clearInterval(this.odooReauthTimer)
          this.odooReauthTimer = null
          if (this.waSocket && this.connectionState.connection === 'open') {
            console.log(`[Odoo:${this.userId}] WA is connected — scheduling Odoo history sync in 3s (post re-auth)`)
            setTimeout(() => {
              this.syncAllConversationsFromOdoo({ silent: false }).catch(err =>
                console.error(`[Odoo:${this.userId}] Post re-auth history sync failed:`, err.message)
              )
            }, 3000)
          }
        } catch (error) {
          console.log(`[Odoo:${this.userId}] Background re-auth still failing: ${error.message}`)
        }
      }, 60_000)
    }
  }

  // ------------------------------------------------------------------
  // Odoo chatter pull / history sync
  // ------------------------------------------------------------------

  async pullOdooChatterIntoConversation(jid, model, recordId, limit = 200) {
    if (!this.odooConfig.uid) return 0
    if (!isValidPhoneJid(jid)) return 0
    const conv = this.conversations.get(jid)
    if (!conv) return 0

    try {
      const domain = [
        ['model', '=', model],
        ['res_id', '=', recordId],
      ]
      const messages = await this.odooExecuteKw('mail.message', 'search_read', [domain], {
        fields: ['id', 'body', 'author_id', 'email_from', 'date', 'message_type', 'subtype_id', 'create_date'],
        order: 'date asc',
        limit,
      })

      let added = 0
      for (const msg of (messages || [])) {
        const body = msg.body || ''
        // v7.28: Use parseChatterBody() to extract ONLY the user-visible
        // text from the chatter body (the content inside <span>), instead
        // of the whole stripped-HTML which included "📱 WhatsApp Enviada: ..."
        // metadata prefixes that made messages look ugly in the chat view.
        const parsed = parseChatterBody(body)
        const fromMe = parsed.fromMe
        const plainText = parsed.text

        let timestamp = parsed.timestamp
        if (!timestamp) timestamp = new Date(msg.date || msg.create_date || Date.now())

        const externalId = `odoo-${msg.id}`
        if (conv.messages.some(m => m.whatsappId === externalId)) continue
        const isDup = conv.messages.some(m =>
          m.fromMe === fromMe &&
          m.textContent === plainText &&
          Math.abs(m.timestamp.getTime() - timestamp.getTime()) < 5000
        )
        if (isDup) continue

        conv.messages.push({
          id: externalId,
          whatsappId: externalId,
          fromMe,
          textContent: plainText || null,
          mediaType: null,
          timestamp,
          status: 'delivered',
        })
        added++
      }

      if (added > 0) {
        conv.messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
        const last = conv.messages[conv.messages.length - 1]
        if (!conv.lastMessageAt || last.timestamp > conv.lastMessageAt) {
          conv.lastMessageAt = last.timestamp
          if (last.textContent) conv.lastMessage = last.textContent
        }
      }
      return added
    } catch (err) {
      console.error(`[Odoo:${this.userId}] Chatter pull failed for ${model}#${recordId}:`, err.message)
      return 0
    }
  }

  // v7.21: Pull ALL conversation history from Odoo chatter.
  async syncAllConversationsFromOdoo(opts = {}) {
    const { silent = false, limit = 1000 } = opts

    if (!this.odooConfig.uid) {
      if (!silent) console.log(`[OdooSync:${this.userId}] SKIP — Odoo not authenticated yet`)
      return { skipped: true, reason: 'not_authenticated' }
    }
    if (this.odooHistorySyncInProgress) {
      if (!silent) console.log(`[OdooSync:${this.userId}] SKIP — another sync is already running`)
      return { skipped: true, reason: 'already_running' }
    }

    this.odooHistorySyncInProgress = true
    const startedAt = Date.now()
    this.emitWA('whatsapp:odoo-sync-progress', {
      phase: 'starting', total: 0, processed: 0, added: 0, failed: 0,
    })

    try {
      console.log(`[OdooSync:${this.userId}] Scanning mail.message for WhatsApp chatter (limit=${limit})...`)
      const domain = [
        ['model', '=', 'res.partner'],
        ['body', 'ilike', 'WhatsApp'],
      ]
      const messages = await this.odooExecuteKw('mail.message', 'search_read', [domain], {
        fields: ['id', 'res_id', 'body', 'date', 'create_date'],
        order: 'date asc',
        limit,
      })

      if (!messages || messages.length === 0) {
        console.log(`[OdooSync:${this.userId}] No WhatsApp chatter messages found in Odoo`)
        this.odooHistorySyncLastRun = { at: new Date().toISOString(), partnersProcessed: 0, messagesAdded: 0, partnersFailed: 0, durationMs: Date.now() - startedAt }
        this.emitWA('whatsapp:odoo-sync-progress', {
          phase: 'complete', total: 0, processed: 0, added: 0, failed: 0,
        })
        return { partnersProcessed: 0, messagesAdded: 0, partnersFailed: 0 }
      }

      const partnerIds = [...new Set(messages.map(m => m.res_id).filter(id => typeof id === 'number' && id > 0))]
      console.log(`[OdooSync:${this.userId}] Found ${messages.length} chatter messages across ${partnerIds.length} partners`)

      this.emitWA('whatsapp:odoo-sync-progress', {
        phase: 'fetching_partners', total: partnerIds.length, processed: 0, added: 0, failed: 0,
      })

      const partnerFields = await this.getAvailableFields('res.partner')
      const readFields = ['id', 'name']
      if (partnerFields.has('phone')) readFields.push('phone')
      if (partnerFields.has('mobile')) readFields.push('mobile')
      if (partnerFields.has('whatsapp')) readFields.push('whatsapp')
      if (partnerFields.has('whatsapp_number')) readFields.push('whatsapp_number')

      const partners = await this.odooExecuteKw('res.partner', 'read', [partnerIds], { fields: readFields })
      const partnerMap = new Map()
      for (const p of (partners || [])) partnerMap.set(p.id, p)

      let processed = 0
      let totalAdded = 0
      let failed = 0
      for (const partnerId of partnerIds) {
        const p = partnerMap.get(partnerId)
        if (!p) { failed++; continue }

        const phoneRaw = p.phone || p.mobile || p.whatsapp || p.whatsapp_number || ''
        const phoneDigits = String(phoneRaw).replace(/\D/g, '')
        if (phoneDigits.length < 7) {
          console.log(`[OdooSync:${this.userId}] Partner ${partnerId} (${p.name || '?'}) has no valid phone — skipping`)
          failed++
          continue
        }

        const jid = `${phoneDigits}@s.whatsapp.net`
        if (!isValidPhoneJid(jid)) {
          console.log(`[OdooSync:${this.userId}] Partner ${partnerId} phone "${phoneRaw}" → invalid JID — skipping`)
          failed++
          continue
        }

        let conv = this.conversations.get(jid)
        if (!conv) {
          conv = this.getOrCreateConversation(jid, p.name || null)
          if (conv && p.name && !this.contactNames.has(jid)) {
            this.contactNames.set(jid, p.name)
            conv.name = p.name
          }
        } else if (p.name && !conv.name) {
          conv.name = p.name
          if (!this.contactNames.has(jid)) this.contactNames.set(jid, p.name)
        }

        if (!conv) { failed++; continue }

        try {
          const added = await this.pullOdooChatterIntoConversation(jid, 'res.partner', partnerId, 500)
          totalAdded += added
          processed++
          if (added > 0) {
            console.log(`[OdooSync:${this.userId}] ✓ Partner ${partnerId} (${p.name || phoneDigits}): +${added} messages`)
          }
        } catch (err) {
          console.error(`[OdooSync:${this.userId}] Partner ${partnerId} pull failed: ${err.message}`)
          failed++
        }

        this.emitOdoo('odoo:conversation:linked', { jid, model: 'res.partner', recordId: partnerId })

        await new Promise(r => setTimeout(r, 50))

        if (processed % 5 === 0) {
          this.emitWA('whatsapp:odoo-sync-progress', {
            phase: 'processing', total: partnerIds.length, processed, added: totalAdded, failed,
          })
        }
      }

      for (const [, conv] of this.conversations) {
        conv.messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
      }

      this.markDirty()
      this.emitWA('whatsapp:conversations', this.getSortedConversations())
      this.emitWA('whatsapp:odoo-sync-progress', {
        phase: 'complete', total: partnerIds.length, processed, added: totalAdded, failed,
      })

      const durationMs = Date.now() - startedAt
      this.odooHistorySyncLastRun = { at: new Date().toISOString(), partnersProcessed: processed, messagesAdded: totalAdded, partnersFailed: failed, durationMs }
      console.log(`[OdooSync:${this.userId}] ✓ DONE in ${durationMs}ms — partners: ${processed}, messages added: ${totalAdded}, failed: ${failed}`)
      return { partnersProcessed: processed, messagesAdded: totalAdded, partnersFailed: failed }
    } catch (err) {
      console.error(`[OdooSync:${this.userId}] FAILED:`, err.message)
      this.emitWA('whatsapp:odoo-sync-progress', {
        phase: 'error', error: err.message,
      })
      return { error: err.message }
    } finally {
      this.odooHistorySyncInProgress = false
    }
  }

  // ------------------------------------------------------------------
  // WhatsApp (Baileys) connection
  // ------------------------------------------------------------------

  async loadBaileys() {
    if (!this._baileysModule) {
      this._baileysModule = await import('@whiskeysockets/baileys')
    }
    return this._baileysModule
  }

  // v7.32: connectWhatsApp(force=false)
  // --------------------------------------------------------------------
  // - Default (force=false): re-entrancy guard — never start a second
  //   Baileys socket while one is still connecting. The watchdog and the
  //   connection.update reconnect timer could otherwise overlap, producing
  //   multiple sockets fighting over the same auth state.
  // - force=true: bypass the re-entrancy guard. Used by onRequestQR() and
  //   onForceNewQR() when the user explicitly clicks "Solicitar QR Code"
  //   or "Limpar sessão e gerar novo QR". Without this, clicking the QR
  //   button while the initial start() connect is still in-flight would
  //   SILENTLY NO-OP (return early), leaving the user with no QR ever.
  //   The previous socket was killed by onRequestQR but no new one was
  //   created → user stuck with no QR forever.
  // --------------------------------------------------------------------
  async connectWhatsApp(force = false) {
    if (this.waConnecting && !force) {
      console.log(`[WA:${this.userId}] connectWhatsApp called but waConnecting=true (use force=true to bypass) — ignoring`)
      return
    }
    if (this.waConnecting && force) {
      console.log(`[WA:${this.userId}] connectWhatsApp(force=true) — overriding waConnecting guard`)
    }
    this.waConnecting = true
    try {
      await this._connectWhatsAppInner()
    } catch (err) {
      // v7.33: Log the FULL stack trace, not just the message. Previously
      // the catch only printed `err.message`, which made it impossible to
      // diagnose why the QR wasn't appearing (the actual error was
      // happening inside makeWASocket when it tried to read
      // creds.noiseKey on a null creds object — silent crash, no QR).
      console.error(`[WA:${this.userId}] connectWhatsApp error:`, err && err.message)
      console.error(`[WA:${this.userId}] connectWhatsApp stack:`, err && err.stack)
      // Notify the client UI so the user sees something went wrong
      // instead of staring at "Desconectado" with no QR forever.
      try {
        this.emitWA('whatsapp:status', {
          connected: false,
          reason: 'connection_error',
          hasSession: this.hasSavedSession,
          error: err && err.message ? err.message : 'Unknown connection error',
        })
      } catch {}
      // Reset state so a future call isn't blocked by stale waSocket
      this.waSocket = null
    } finally {
      this.waConnecting = false
    }
  }

  // v7.29: schedule a single reconnect; reuses/cancels any pending timer so
  // repeated triggers never stack duplicate attempts.
  // v7.29.1: also clear any stale waSocket reference so the watchdog stops
  // firing on a socket that's already being replaced.
  scheduleReconnect(reason) {
    if (this.waReconnectTimer) {
      console.log(`[WA:${this.userId}] Reconnect already pending — ignoring '${reason}'`)
      return
    }
    this.reconnectAttempts++
    const delay = Math.min(2000 * Math.pow(2, this.reconnectAttempts - 1), 60000)
    console.log(`[WA:${this.userId}] ${reason} — reconnect #${this.reconnectAttempts} in ${delay}ms`)
    // v7.29.1: null out the old socket immediately so the watchdog and
    // connection.update handler treat subsequent events as stale.
    if (this.waSocket) {
      try { this.waSocket.ev.removeAllListeners() } catch {}
      try { this.waSocket.end(undefined) } catch {}
      this.waSocket = null
    }
    this.waReconnectTimer = setTimeout(() => {
      this.waReconnectTimer = null
      this.connectWhatsApp().catch(err =>
        console.error(`[WA:${this.userId}] reconnect error:`, err && err.message)
      )
    }, delay)
  }

  async _connectWhatsAppInner() {
    const baileys = await this.loadBaileys()
    const {
      makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
      Browsers,
    } = baileys
    const { Boom } = await import('@hapi/boom')
    const P = (await import('pino')).default
    const logger = P({ level: 'silent' })

    // v7.30: Use Firestore-backed auth state when available (persists
    // across deploys even if disk is wiped). Auto-migrates existing
    // filesystem state to Firestore on first read. Falls back to
    // useMultiFileAuthState (filesystem) when Firestore isn't configured.
    const { state, saveCreds, source: authSource } = await usePersistentAuthState(this.authFolder, this.userId)
    console.log(`[WA:${this.userId}] Auth state source: ${authSource}, hasCreds=${!!state.creds}`)
    const { version } = await fetchLatestBaileysVersion()

    // v7.29.1: capture THIS socket instance so we can ignore stale events
    // from any previous socket that hasn't fully closed yet. Without this,
    // the old socket fires 'close' AFTER the new socket is already open,
    // emitting whatsapp:status { reconnecting } → UI flicker loop.
    const socketInstance = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      connectTimeoutMs: 90_000,
      defaultQueryTimeoutMs: 60_000,
      // v7.29.1: 10s → 30s (Baileys default). 10s was too aggressive — on
      // Render, transient ping failures caused Baileys to close the WS
      // and trigger a reconnect every few minutes.
      keepAliveIntervalMs: 30_000,
      markOnlineOnConnect: true,
      syncFullHistory: false,
      retryRequestDelayMs: 250,
      maxMsgRetryCount: 5,
      shouldIgnoreJid: (jid) => jid === 'status@broadcast',
    })

    this.waSocket = socketInstance
    this.waSocketStartTime = Date.now()  // v7.29.1: track uptime for backoff reset

    // v7.29.1: returns true if socketInstance is still the current socket.
    // Used to ignore stale events from previous sockets.
    const isCurrentSocket = () => this.waSocket === socketInstance

    socketInstance.ev.on('creds.update', saveCreds)

    // v7.32: INITIAL-CONNECT WATCHDOG
    // --------------------------------------------------------------------
    // If after 30s the socket hasn't produced a QR code or opened, force a
    // fresh connect. This catches the scenario where Baileys silently fails
    // to generate a QR (e.g., stale auth state, network blip during init)
    // and the user is left staring at the "Solicitar QR Code" button with
    // no QR appearing. Without this, the user would have to manually click
    // the force-new-QR button.
    if (this.initialConnectWatchdog) {
      clearTimeout(this.initialConnectWatchdog)
      this.initialConnectWatchdog = null
    }
    let initialGotEvent = false
    this.initialConnectWatchdog = setTimeout(() => {
      if (!isCurrentSocket()) return
      if (this.connectionState.connection === 'open') return
      if (this.lastQrCode) return
      if (initialGotEvent) return
      console.warn(`[WA:${this.userId}] Initial-connect watchdog: no QR and no 'open' after 30s — forcing fresh connect`)
      try { socketInstance.ev.removeAllListeners() } catch {}
      try { socketInstance.end(undefined) } catch {}
      this.waSocket = null
      this.waConnecting = false
      this.connectWhatsApp(true).catch(err =>
        console.error(`[WA:${this.userId}] Watchdog reconnect error:`, err && err.message)
      )
    }, 30_000)
    // Clear the watchdog as soon as we get a meaningful event
    const clearInitialWatchdog = () => {
      if (this.initialConnectWatchdog) {
        clearTimeout(this.initialConnectWatchdog)
        this.initialConnectWatchdog = null
      }
    }

    socketInstance.ev.on('connection.update', async (update) => {
      // v7.29.1: Ignore events from stale sockets. This happens when the
      // old socket (from a previous failed connect or a watchdog kill)
      // finally fires its own 'close' event AFTER the new socket has
      // already been created. Without this guard, the old socket's close
      // would emit whatsapp:status { reconnecting } to the UI even though
      // the new socket is healthy → UI flicker / "caindo e reconectando".
      if (!isCurrentSocket()) {
        console.log(`[WA:${this.userId}] Ignoring stale socket event: ${update.connection}`)
        return
      }

      const { connection, lastDisconnect, qr } = update
      this.connectionState = { connection }
      console.log(`[WA:${this.userId}] Connection update: ${connection}`)

      if (qr) {
        clearInitialWatchdog()
        initialGotEvent = true
        this.lastQrCode = qr
        console.log(`[WA:${this.userId}] QR Code generated, sending to clients`)
        this.emitWA('whatsapp:qr', { qr })
        this.hasSavedSession = false
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error)?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut
        console.log(`[WA:${this.userId}] Connection closed. Status: ${statusCode}, Reconnect: ${shouldReconnect}`)

        if (statusCode === DisconnectReason.loggedOut) {
          this.hasSavedSession = false
          this.lastQrCode = null
          this.conversations.clear()
          this.contactNames.clear()
          this.deviceContacts.clear()
          this.lidToPhoneMap.clear()
          this.postedChatterIds.clear()
          this.phoneToActiveLeadCache.clear()
          try { if (fs.existsSync(this.stateFile)) fs.unlinkSync(this.stateFile) } catch {}
          // v7.30: Also clear the Firestore auth state — otherwise on the
          // next restart Baileys would re-hydrate the logged-out creds and
          // immediately get a 401, looping forever.
          try {
            const { getFirestoreOrNull } = require('./wa-firestore-auth-state.cjs')
            const db = getFirestoreOrNull()
            if (db) {
              db.collection('wa_auth_states').doc(String(this.userId)).delete()
                .then(() => console.log(`[WA:${this.userId}] Cleared Firestore auth state (loggedOut)`))
                .catch(err => console.warn(`[WA:${this.userId}] Could not clear Firestore auth state:`, err.message))
              // v7.37: Also clear conv state — otherwise on next QR scan
              // the user would inherit stale conversations/contacts from
              // the previous session.
              db.collection('wa_conv_states').doc(String(this.userId)).delete()
                .then(() => console.log(`[WA:${this.userId}] Cleared Firestore conv state (loggedOut)`))
                .catch(err => console.warn(`[WA:${this.userId}] Could not clear Firestore conv state:`, err.message))
            }
          } catch {}
          // Also delete the local filesystem auth folder so we don't
          // accidentally re-migrate stale creds back to Firestore.
          try {
            if (fs.existsSync(this.authFolder)) {
              for (const f of fs.readdirSync(this.authFolder)) {
                if (f.endsWith('.json')) {
                  fs.unlinkSync(path.join(this.authFolder, f))
                }
              }
            }
          } catch {}
          this.emitWA('whatsapp:conversations', [])
        }

        // v7.29.1: If the connection was open for >5 min before closing,
        // it was a stable session that hit a transient blip. Reset the
        // backoff so the reconnect is fast (2s) instead of escalating.
        const uptimeMs = this.waSocketStartTime ? (Date.now() - this.waSocketStartTime) : 0
        if (uptimeMs > 300_000 && shouldReconnect) {  // >5 min
          console.log(`[WA:${this.userId}] Was open for ${Math.round(uptimeMs/1000)}s — resetting backoff`)
          this.reconnectAttempts = 0
        }

        this.emitWA('whatsapp:status', {
          connected: false,
          reason: statusCode === DisconnectReason.loggedOut ? 'logged_out' : 'reconnecting',
          hasSession: this.hasSavedSession,
        })

        if (shouldReconnect) {
          this.scheduleReconnect(`Connection closed (status=${statusCode})`)
        }
      }

      if (connection === 'open') {
        clearInitialWatchdog()
        initialGotEvent = true
        console.log(`[WA:${this.userId}] Connected successfully!`)
        this.hasSavedSession = true
        this.reconnectAttempts = 0
        this.lastQrCode = null
        this.emitWA('whatsapp:status', { connected: true, hasSession: true })

        if (this.watchdogTimer) clearInterval(this.watchdogTimer)
        // v7.29.1: Conservative watchdog. The previous version fired every
        // 60s and forced reconnect whenever connectionState !== 'open',
        // which killed the connection DURING the initial 'connecting'
        // phase (which can take >60s on Render). The new watchdog:
        //   - Runs every 3 minutes (not 60s)
        //   - Skips entirely if a reconnect is already pending
        //   - Skips if connectionState !== 'open' (let the close handler
        //     deal with it)
        //   - Only forces reconnect after 2 consecutive dead-WS checks
        //     (~6 minutes of a truly dead WebSocket)
        let deadWsCount = 0
        this.watchdogTimer = setInterval(() => {
          if (this.waReconnectTimer) return            // reconnect already pending
          if (!this.waSocket) return                   // no socket to check
          if (!isCurrentSocket()) return                // stale socket ref
          if (this.connectionState.connection !== 'open') return  // let close handler deal

          const wsState = this.waSocket.ws?.readyState
          if (wsState === 3) {  // CLOSED
            deadWsCount++
            console.log(`[WA Watchdog:${this.userId}] WebSocket CLOSED (stale count=${deadWsCount}/2)`)
            if (deadWsCount >= 2) {
              console.log(`[WA Watchdog:${this.userId}] Dead WS for >6min, forcing reconnect...`)
              deadWsCount = 0
              this.emitWA('whatsapp:status', {
                connected: false,
                reason: 'reconnecting',
                hasSession: this.hasSavedSession,
              })
              this.scheduleReconnect('Watchdog: dead WS for >6min')
            }
          } else {
            deadWsCount = 0
          }
        }, 180_000)  // v7.29.1: 60s → 180s (3 minutes)

        try {
          const meId = this.waSocket.user?.id
          if (meId) {
            const profilePicUrl = await this.waSocket.profilePictureUrl(meId, 'image').catch(() => null)
            this.emitWA('whatsapp:me', { id: meId, name: this.waSocket.user?.name, profilePicUrl })
          }
        } catch {}

        this.markDirty()
        this.emitWA('whatsapp:conversations', this.getSortedConversations())

        // v7.16: Auto-resync app state 3s after connection to restore
        // contacts/conversations lost from memory after a restart.
        setTimeout(() => {
          try {
            if (this.waSocket && this.connectionState.connection === 'open' &&
                typeof this.waSocket.resyncAppState === 'function') {
              console.log(`[WA:${this.userId}] Auto-resyncing app state after connection`)
              this.waSocket.resyncAppState(
                ['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'],
                false
              ).then(() => console.log(`[WA:${this.userId}] Auto-resync complete`)).catch(err =>
                console.error(`[WA:${this.userId}] Auto-resync error:`, err.message)
              )
            }
          } catch (err) {
            console.error(`[WA:${this.userId}] Auto-resync trigger failed:`, err.message)
          }
        }, 3000)

        // v7.21: 8s after WA connects, pull all conversation history from Odoo chatter
        setTimeout(() => {
          if (this.waSocket && this.connectionState.connection === 'open') {
            console.log(`[WA:${this.userId}] Triggering Odoo chatter history sync (reconnect restore)`)
            this.syncAllConversationsFromOdoo({ silent: false }).catch(err =>
              console.error(`[WA:${this.userId}] Odoo history sync failed:`, err.message)
            )
          }
        }, 8000)
      }
    })

    this.waSocket.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest, progress, syncType }) => {
      console.log(`[WA:${this.userId}] History sync: progress=${progress}%, chats=${chats.length}, contacts=${Object.keys(contacts).length}, messages=${messages.length}`)

      this.syncState.isSyncing = true
      this.syncState.progress = progress || 0
      this.emitWA('whatsapp:sync-progress', {
        isSyncing: true, progress: progress || 0, phase: syncType || 'historical',
        chatsCount: chats.length, contactsCount: Object.keys(contacts).length,
      })

      // Build a LID → phone JID map from messages
      const lidToPhone = new Map()
      for (const msg of messages) {
        if (!msg.key) continue
        const rawJid = msg.key.remoteJid
        if (rawJid && rawJid.endsWith('@lid')) {
          const phoneCandidate = msg.key.senderPn || msg.key.participant
          if (phoneCandidate) {
            const normalized = normalizeJid(phoneCandidate)
            if (normalized) {
              lidToPhone.set(rawJid, normalized)
              this.lidToPhoneMap.set(rawJid, normalized)
            }
          }
        }
      }
      if (lidToPhone.size > 0) {
        console.log(`[WA:${this.userId}] Built LID→phone map: ${lidToPhone.size} entries`)
      }

      let validContactsCount = 0
      for (const [rawJid, contact] of Object.entries(contacts)) {
        let jid = normalizeJid(rawJid)
        if (!jid && rawJid && rawJid.endsWith('@lid')) {
          jid = lidToPhone.get(rawJid) || null
        }
        if (jid && contact?.name) {
          this.contactNames.set(jid, contact.name)
          const phone = extractPhone(jid)
          if (phone) {
            const existing = this.deviceContacts.get(jid)
            if (existing) existing.name = contact.name
            else this.deviceContacts.set(jid, { jid, phone, name: contact.name, avatarUrl: null })
          }
          validContactsCount++
        }
      }
      this.syncState.totalContacts = validContactsCount

      let chatsProcessed = 0
      let lidChatsResolved = 0
      // v7.35: Filter historical chats by ownership.
      // v7.36: Unclaimed chats (no owner yet) are now loaded for ALL users
      // (admin + non-admin) — so external message history is visible to
      // everyone. Only chats OWNED BY ANOTHER user are skipped.
      const _isAdmin = this.user && this.user.role === 'admin'
      const _sm = this.sessionManager
      for (const chat of chats) {
        let jid = normalizeJid(chat.id)
        if (!jid && chat.id && chat.id.endsWith('@lid')) {
          jid = lidToPhone.get(chat.id) || null
          if (jid) lidChatsResolved++
        }
        if (!jid) continue
        // v7.35/v7.36/v7.38: Skip chats owned by another user (non-admin only).
        // Admin loads all chats. Unclaimed chats are loaded for everyone so
        // external leads' history is visible to all users.
        if (_sm) {
          const owner = _sm.getConversationOwner(jid)
          const _isAdmin = this.user && this.user.role === 'admin'
          if (owner && owner !== this.userId && !_isAdmin) continue
        }
        const contactName = this.contactNames.get(jid) || null
        if (!this.conversations.has(jid)) {
          this.conversations.set(jid, {
            jid, name: contactName, phone: extractPhone(jid),
            pushName: null, avatarUrl: null, lastMessage: null,
            lastMessageAt: chat.t ? new Date(chat.t * 1000) : null,
            unreadCount: chat.unreadCount || 0, messages: [],
          })
        } else {
          const conv = this.conversations.get(jid)
          if (contactName) conv.name = contactName
          if (chat.unreadCount !== undefined) conv.unreadCount = chat.unreadCount
          if (chat.t && (!conv.lastMessageAt || new Date(chat.t * 1000) > conv.lastMessageAt)) {
            conv.lastMessageAt = new Date(chat.t * 1000)
          }
        }
        chatsProcessed++
      }
      if (lidChatsResolved > 0) {
        console.log(`[WA:${this.userId}] Resolved ${lidChatsResolved} LID chats to phone JIDs`)
      }
      this.syncState.totalChats = chatsProcessed

      let messagesProcessed = 0
      for (const msg of messages) {
        if (!msg.key) continue
        const rawJid = msg.key.remoteJid
        let jid = normalizeJid(rawJid)
        if (!jid && rawJid && rawJid.endsWith('@lid')) {
          jid = lidToPhone.get(rawJid) || null
          if (!jid) {
            const candidate = msg.key.senderPn || msg.key.participant || msg.key.senderLid
            if (candidate) jid = normalizeJid(candidate)
          }
        }
        if (!jid) continue

        // v7.35/v7.36/v7.38: Skip historical messages owned by another user
        // (non-admin only). Admin loads all messages. Unclaimed messages
        // are loaded for everyone so external leads are visible to all users.
        if (_sm) {
          const owner = _sm.getConversationOwner(jid)
          const _isAdmin = this.user && this.user.role === 'admin'
          if (owner && owner !== this.userId && !_isAdmin) continue
        }

        const fromMe = msg.key.fromMe || false
        let m = msg.message
        if (m?.ephemeralMessage?.message) m = m.ephemeralMessage.message
        else if (m?.viewOnceMessage?.message) m = m.viewOnceMessage.message
        else if (m?.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message
        else if (m?.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message
        if (!m) continue

        const textContent =
          m.conversation ||
          m.extendedTextMessage?.text ||
          m.imageMessage?.caption ||
          m.videoMessage?.caption ||
          m.documentMessage?.caption || null

        let mediaType = null
        if (m.imageMessage) mediaType = 'image'
        else if (m.videoMessage) mediaType = 'video'
        else if (m.audioMessage) mediaType = 'audio'
        else if (m.pttMessage) mediaType = 'ptt'
        else if (m.documentMessage) mediaType = 'document'
        else if (m.stickerMessage) mediaType = 'sticker'

        if (!textContent && !mediaType) continue

        let conv = this.conversations.get(jid)
        if (!conv) {
          const contactName = this.contactNames.get(jid) || null
          const phone = extractPhone(jid)
          conv = {
            jid, name: contactName || pushNameFallback(msg), phone,
            pushName: null, avatarUrl: null, lastMessage: null,
            lastMessageAt: null, unreadCount: 0, messages: [],
          }
          this.conversations.set(jid, conv)
        }

        const msgId = msg.key.id
        if (msgId && conv.messages.some(m => m.whatsappId === msgId)) continue

        const messageTimestamp = new Date((msg.messageTimestamp) * 1000 || Date.now())
        conv.messages.push({
          id: msgId || Math.random().toString(36).substr(2, 9),
          whatsappId: msgId || null, fromMe, textContent, mediaType,
          timestamp: messageTimestamp, status: fromMe ? 'delivered' : 'received',
        })

        if (textContent) conv.lastMessage = textContent
        else if (mediaType) conv.lastMessage = `[${mediaType}]`

        if (!conv.lastMessageAt || messageTimestamp > conv.lastMessageAt) {
          conv.lastMessageAt = messageTimestamp
        }
        messagesProcessed++
      }
      this.syncState.totalMessages = messagesProcessed

      const baseTime = Date.now()
      let offset = 0
      for (const conv of this.conversations.values()) {
        if (!conv.lastMessageAt) {
          conv.lastMessageAt = new Date(baseTime - offset)
          offset += 1000
        }
      }

      if (isLatest || progress >= 100) {
        this.syncState.isSyncing = false
        this.syncState.progress = 100
        this.emitWA('whatsapp:sync-progress', {
          isSyncing: false, progress: 100, phase: 'complete',
          chatsCount: chatsProcessed, contactsCount: validContactsCount, messagesCount: messagesProcessed,
        })
      }
      this.markDirty()
      this.emitWA('whatsapp:conversations', this.getSortedConversations())
    })

    this.waSocket.ev.on('messages.upsert', async ({ messages, type }) => {
      console.log(`[WA:${this.userId}] >>>>>> messages.upsert EVENT: ${messages?.length || 0} msgs (type=${type || 'n/a'}) <<<<<<`)
      this.logUpsertEvent({
        type: type || 'n/a',
        count: messages?.length || 0,
        ids: (messages || []).slice(0, 5).map(m => m?.key?.id || '?'),
        jids: (messages || []).slice(0, 5).map(m => m?.key?.remoteJid || '?'),
      })

      for (const msg of messages || []) {
        try {
          if (!msg.key) {
            console.log(`[WA:${this.userId}] upsert msg skipped — no key`)
            continue
          }

          const rawJid = msg.key.remoteJid
          let jid = normalizeJid(rawJid)
          if (!jid && rawJid && rawJid.endsWith('@lid')) {
            const candidate = msg.key.senderPn || msg.key.participant || msg.key.senderLid
            if (candidate) {
              jid = normalizeJid(candidate)
              if (jid) {
                const src = msg.key.senderPn ? 'senderPn' : (msg.key.participant ? 'participant' : 'senderLid')
                console.log(`[WA:${this.userId}] Recovered JID from ${src}: ${jid} (rawLid=${rawJid})`)
                this.lidToPhoneMap.set(rawJid, jid)
              }
            }
          }

          const fromMe = msg.key.fromMe || false
          const pushName = msg.pushName || null

          console.log(`[WA:${this.userId}] upsert msg: rawJid=${rawJid} → normalized=${jid} fromMe=${fromMe} id=${msg.key.id} senderPn=${msg.key.senderPn || 'n/a'} pushName=${pushName || 'n/a'}`)

          if (rawJid === 'status@broadcast') {
            console.log(`[WA:${this.userId}] upsert msg skipped — status broadcast`)
            continue
          }
          if (rawJid && rawJid.endsWith('@g.us')) {
            console.log(`[WA:${this.userId}] upsert msg skipped — group chat`)
            continue
          }
          if (!jid) {
            console.log(`[WA:${this.userId}] upsert msg skipped — invalid JID: ${rawJid}`)
            try {
              const sample = JSON.stringify(msg).slice(0, 400)
              console.log(`[WA:${this.userId}] full msg sample:`, sample)
              this.logUpsertEvent({ type: 'skipped-invalid-jid', rawJid, sample })
            } catch {}
            continue
          }

          // v7.35/v7.36/v7.38: Conversation ownership isolation.
          // - Admin sees ALL messages (no filtering).
          // - Non-admin: skip only if conversation is owned by ANOTHER user.
          //   Unclaimed (external inbound) and own conversations are processed.
          if (this.sessionManager) {
            const owner = this.sessionManager.getConversationOwner(jid)
            const _isAdmin = this.user && this.user.role === 'admin'
            if (owner && owner !== this.userId && !_isAdmin) {
              console.log(`[WA:${this.userId}] upsert msg skipped — conversation ${jid} owned by user ${owner}`)
              continue
            }
          }

          const conv = this.getOrCreateConversation(jid, fromMe ? undefined : pushName)
          if (!conv) {
            console.log(`[WA:${this.userId}] upsert msg skipped — could not create conversation for ${jid}`)
            continue
          }

          // v7.29.4: Use Baileys' own normalizeMessageContent to unwrap nested
          // message types (ephemeralMessage, viewOnceMessage, viewOnceMessageV2,
          // viewOnceMessageV2Extension, documentWithCaptionMessage, editedMessage).
          // The previous manual unwrap was missing viewOnceMessageV2Extension,
          // which is used for view-once media with captions — that caused real
          // media messages to be silently dropped with "no text/media".
          // Also handle deviceSentMessage separately (Baileys' normalize does NOT
          // include it — it's only used for outgoing message echoes).
          let m = msg.message
          if (m?.deviceSentMessage?.message) m = m.deviceSentMessage.message
          try {
            const baileysMod = await this.loadBaileys()
            const normalized = baileysMod.normalizeMessageContent?.(m)
            if (normalized) m = normalized
          } catch (e) {
            // Fallback: keep the original message body if normalize fails
          }

          // v7.29.4: Silently skip protocol/control messages that have no
          // user-visible content. These arrive with messageStubType set and
          // msg.message either missing or containing only messageContextInfo.
          // Skipping them loudly pollutes the logs ("no text/media" spam).
          if (msg.messageStubType !== undefined && msg.messageStubType !== null) {
            console.log(`[WA:${this.userId}] upsert msg skipped — stub type=${msg.messageStubType} (protocol/control message)`)
            continue
          }

          if (!m || typeof m !== 'object') {
            console.log(`[WA:${this.userId}] upsert msg skipped — no message body`)
            continue
          }

          // v7.29.4: Handle reactionMessage separately — these are emoji
          // reactions, not text/media. Skip them silently (we don't render
          // reactions in the chat view yet).
          if (m.reactionMessage) {
            console.log(`[WA:${this.userId}] upsert msg skipped — reactionMessage`)
            continue
          }

          // v7.29.4: Handle protocolMessage separately — these are protocol
          // updates (message revoked, E2E changed, etc.) with no body.
          if (m.protocolMessage) {
            console.log(`[WA:${this.userId}] upsert msg skipped — protocolMessage (type=${m.protocolMessage.type})`)
            continue
          }

          const textContent =
            m.conversation ||
            m.extendedTextMessage?.text ||
            m.imageMessage?.caption ||
            m.videoMessage?.caption ||
            m.documentMessage?.caption ||
            m.templateMessage?.hydratedFourRowTemplate?.hydratedContentText ||
            m.templateMessage?.hydratedTemplate?.hydratedContentText ||
            m.buttonsMessage?.contentText ||
            m.listMessage?.description ||
            m.buttonsResponseMessage?.selectedButtonId ||
            m.listResponseMessage?.title ||
            m.listResponseMessage?.description ||
            m.pollCreationMessage?.name ||
            m.pollCreationMessageV3?.name ||
            null

          let mediaType = null
          if (m.imageMessage) mediaType = 'image'
          else if (m.videoMessage) mediaType = 'video'
          else if (m.audioMessage) mediaType = 'audio'
          else if (m.pttMessage) mediaType = 'ptt'
          else if (m.documentMessage) mediaType = 'document'
          else if (m.stickerMessage) mediaType = 'sticker'

          if (!textContent && !mediaType) {
            // v7.29.4: Log the actual top-level keys present in `m` so we can
            // diagnose what Baileys is sending. Previously this was silent and
            // we had no way to know what message type was being skipped.
            const keys = Object.keys(m).join(',') || '(empty)'
            console.log(`[WA:${this.userId}] upsert msg skipped — no text/media | keys=[${keys}] fromMe=${fromMe}`)
            try {
              this.logUpsertEvent({ type: 'skipped-no-content', jid, keys, sample: JSON.stringify(m).slice(0, 300) })
            } catch {}
            continue
          }

          const msgId = msg.key.id
          if (msgId && conv.messages.some(m => m.whatsappId === msgId || m.id === msgId)) {
            console.log(`[WA:${this.userId}] Skipping duplicate message ${msgId}`)
            continue
          }

          let messageTimestamp
          try {
            const ts = typeof msg.messageTimestamp === 'number'
              ? msg.messageTimestamp
              : (msg.messageTimestamp?.low || msg.messageTimestamp || Math.floor(Date.now() / 1000))
            messageTimestamp = new Date(ts * 1000)
            if (isNaN(messageTimestamp.getTime())) messageTimestamp = new Date()
          } catch {
            messageTimestamp = new Date()
          }

          // v7.22: Extract media metadata + download the media file
          let mediaUrl = null
          let mediaBase64 = null
          let mediaFileName = null
          let mediaMimeType = null
          let mediaDuration = null

          if (mediaType) {
            try {
              if (mediaType === 'image' && m.imageMessage) {
                mediaMimeType = m.imageMessage.mimetype || 'image/jpeg'
                mediaFileName = `image_${msgId}.${(mediaMimeType.split('/')[1] || 'jpg').replace('jpeg', 'jpg')}`
              } else if (mediaType === 'video' && m.videoMessage) {
                mediaMimeType = m.videoMessage.mimetype || 'video/mp4'
                mediaFileName = `video_${msgId}.mp4`
                mediaDuration = m.videoMessage.seconds || null
              } else if (mediaType === 'audio' && m.audioMessage) {
                mediaMimeType = m.audioMessage.mimetype || 'audio/mpeg'
                const ext = mediaMimeType.includes('mp4') ? 'm4a' : (mediaMimeType.includes('mpeg') ? 'mp3' : 'ogg')
                mediaFileName = `audio_${msgId}.${ext}`
                mediaDuration = m.audioMessage.seconds || null
              } else if (mediaType === 'ptt' && m.pttMessage) {
                mediaMimeType = m.pttMessage.mimetype || 'audio/ogg'
                mediaFileName = `ptt_${msgId}.ogg`
                mediaDuration = m.pttMessage.seconds || null
              } else if (mediaType === 'document' && m.documentMessage) {
                mediaMimeType = m.documentMessage.mimetype || 'application/octet-stream'
                mediaFileName = m.documentMessage.fileName || `document_${msgId}`
              } else if (mediaType === 'sticker' && m.stickerMessage) {
                mediaMimeType = m.stickerMessage.mimetype || 'image/webp'
                mediaFileName = `sticker_${msgId}.webp`
              }

              const baileysForDownload = await this.loadBaileys()
              const buffer = await baileysForDownload.downloadMediaMessage(msg, 'buffer', {})
              if (buffer && buffer.length > 0) {
                try { fs.mkdirSync(this.mediaDir, { recursive: true }) } catch {}
                const safeFileName = (mediaFileName || `media_${msgId}`).replace(/[^a-zA-Z0-9._-]/g, '_')
                const filePath = path.join(this.mediaDir, safeFileName)
                fs.writeFileSync(filePath, buffer)
                mediaUrl = `/media/${safeFileName}`
                // v7.24 (R7): Also compute the base64 string so the message
                // can be uploaded to Odoo chatter as an ir.attachment.
                // Cap at ~1.5 MB (base64 ~2 MB) to avoid bloating memory —
                // larger media will still have the file URL on disk, but
                // won't be attached to Odoo chatter (only the media-line
                // indicator is posted).
                if (buffer.length < 1_500_000) {
                  mediaBase64 = buffer.toString('base64')
                }
                console.log(`[WA:${this.userId}] ✓ Media downloaded: ${mediaType} → ${mediaUrl} (${buffer.length} bytes, base64=${mediaBase64 ? 'yes' : 'skipped'})`)
              }
            } catch (mediaErr) {
              console.error(`[WA:${this.userId}] Media download failed for ${msgId}: ${mediaErr.message}`)
            }
          }

          const messageData = {
            id: msgId || `m-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            whatsappId: msgId || null,
            fromMe,
            textContent,
            mediaType,
            mediaUrl,
            mediaBase64,
            fileName: mediaFileName,
            mimeType: mediaMimeType,
            mediaDuration,
            timestamp: messageTimestamp,
            status: fromMe ? 'delivered' : 'received',
          }

          conv.messages.push(messageData)
          conv.lastMessage = textContent || (mediaType ? `[${mediaType}]` : '')
          conv.lastMessageAt = new Date()
          if (!fromMe) conv.unreadCount++

          console.log(`[WA:${this.userId}] ✓ New message stored in ${jid} fromMe=${fromMe}: ${textContent ? textContent.slice(0, 40) : `[${mediaType}]`}`)
          this.logUpsertEvent({ type: 'stored', jid, fromMe, msgId, preview: (textContent || '').slice(0, 30) })

          if (!conv.avatarUrl) {
            this.waSocket.profilePictureUrl(jid, 'image').then(picUrl => {
              if (picUrl) {
                conv.avatarUrl = picUrl
                this.emitWA('whatsapp:conversation:update', this.serializeConversation(conv))
              }
            }).catch(() => {})
          }

          this.markDirty()
          this.emitWA('whatsapp:message', {
            conversationJid: jid,
            message: {
              ...messageData,
              timestamp: messageTimestamp.toISOString(),
            },
            conversation: this.serializeConversation(conv),
          })
          this.emitWA('whatsapp:conversation:update', this.serializeConversation(conv))

          // Auto-sync to Odoo in background
          const phone = extractPhone(jid)
          if (phone) {
            this.autoSyncWhatsAppMessage({
              jid, phone, pushName: conv.pushName, textContent, mediaType, fromMe,
              timestamp: messageTimestamp.toISOString(),
              dedupId: msgId,
              // v7.24 (R7): pass media data so it can be uploaded to Odoo chatter
              mediaBase64,
              mimeType: mediaMimeType,
              fileName: mediaFileName,
            }).then(result => {
              if (result.partnerId || result.leadId) {
                this.emitWA('whatsapp:odoo-sync', {
                  jid, phone, partnerId: result.partnerId, leadId: result.leadId,
                  mailMessageId: result.mailMessageId, activityId: result.activityId,
                  created: result.created, errors: result.errors,
                })
              }
            }).catch(err => console.error(`[AutoSync:${this.userId}] Error:`, err.message))
          }
        } catch (msgErr) {
          console.error(`[WA:${this.userId}] upsert msg processing error:`, msgErr.message)
          try {
            this.logUpsertEvent({ type: 'processing-error', error: msgErr.message, sample: JSON.stringify(msg).slice(0, 300) })
          } catch {}
        }
      }
    })

    this.waSocket.ev.on('messages.update', async (updates) => {
      try {
        for (const update of updates || []) {
          if (!update.key || !update.key.id) continue
          const rawJid = update.key.remoteJid
          let jid = normalizeJid(rawJid)
          if (!jid && rawJid && rawJid.endsWith('@lid')) {
            const candidate = update.key.senderPn || update.key.participant || update.key.senderLid
            if (candidate) jid = normalizeJid(candidate)
          }
          if (!jid) continue
          // v7.35/v7.36/v7.38: ownership filter on messages.update too.
          // Admin sees everything. Non-admin skips conversations owned by
          // another user. Unclaimed conversations are processed for everyone.
          if (this.sessionManager) {
            const owner = this.sessionManager.getConversationOwner(jid)
            const _isAdmin = this.user && this.user.role === 'admin'
            if (owner && owner !== this.userId && !_isAdmin) continue
          }
          const conv = this.conversations.get(jid)
          if (!conv) continue

          const existing = conv.messages.find(m => m.whatsappId === update.key.id || m.id === update.key.id)

          // Fallback path: message doesn't exist locally AND update has a body
          if (!existing && update.message) {
            console.log(`[WA:${this.userId}] messages.update: found NEW message not in upsert — id=${update.key.id} jid=${jid}`)
            try {
              const m = update.message
              const textContent =
                m.conversation ||
                m.extendedTextMessage?.text ||
                m.imageMessage?.caption ||
                m.videoMessage?.caption ||
                m.documentMessage?.caption || null
              let mediaType = null
              if (m.imageMessage) mediaType = 'image'
              else if (m.videoMessage) mediaType = 'video'
              else if (m.audioMessage) mediaType = 'audio'
              else if (m.pttMessage) mediaType = 'ptt'
              else if (m.documentMessage) mediaType = 'document'
              else if (m.stickerMessage) mediaType = 'sticker'
              if (!textContent && !mediaType) continue

              const fromMe = update.key.fromMe || false
              const msgId = update.key.id
              if (conv.messages.some(mm => mm.whatsappId === msgId || mm.id === msgId)) continue

              let ts
              try {
                const tsv = typeof update.messageTimestamp === 'number'
                  ? update.messageTimestamp
                  : (update.messageTimestamp?.low || update.messageTimestamp || Math.floor(Date.now() / 1000))
                ts = new Date(tsv * 1000)
                if (isNaN(ts.getTime())) ts = new Date()
              } catch { ts = new Date() }

              const messageData = {
                id: msgId, whatsappId: msgId, fromMe, textContent, mediaType,
                timestamp: ts, status: fromMe ? 'delivered' : 'received',
              }
              conv.messages.push(messageData)
              conv.lastMessage = textContent || (mediaType ? `[${mediaType}]` : '')
              conv.lastMessageAt = new Date()
              if (!fromMe) conv.unreadCount++
              console.log(`[WA:${this.userId}] ✓ (via update) New message stored in ${jid} fromMe=${fromMe}`)

              this.markDirty()
              this.emitWA('whatsapp:message', {
                conversationJid: jid,
                message: { ...messageData, timestamp: ts.toISOString() },
                conversation: this.serializeConversation(conv),
              })
              this.emitWA('whatsapp:conversation:update', this.serializeConversation(conv))

              const phone = extractPhone(jid)
              if (phone) {
                this.autoSyncWhatsAppMessage({
                  jid, phone, pushName: conv.pushName, textContent, mediaType, fromMe,
                  timestamp: ts.toISOString(), dedupId: msgId,
                  // v7.24 (R7): media data not available in this fallback path
                  mediaBase64: null, mimeType: null, fileName: null,
                }).catch(err => console.error(`[AutoSync:${this.userId}] Error:`, err.message))
              }
            } catch (err) {
              console.error(`[WA:${this.userId}] fallback message processing failed:`, err.message)
            }
            continue
          }

          if (!existing) continue

          let newStatus = existing.status
          if (update.status === 'read') newStatus = 'read'
          else if (update.status === 'delivered' && existing.status !== 'read') newStatus = 'delivered'
          else if (update.status === 'played' && existing.mediaType === 'audio') newStatus = 'read'

          if (newStatus !== existing.status) {
            existing.status = newStatus
            this.emitWA('whatsapp:message:status', {
              conversationJid: jid,
              messageId: existing.id,
              status: newStatus,
            })
          }
        }
      } catch (err) {
        console.error(`[WA:${this.userId}] messages.update error:`, err.message)
      }
    })

    this.waSocket.ev.on('contacts.upsert', async (contacts) => {
      console.log(`[WA:${this.userId}] contacts.upsert: ${contacts.length} contacts received`)
      let updatedCount = 0
      for (const contact of contacts) {
        if (contact.id && isValidPhoneJid(contact.id) && contact.name) {
          this.updateConversationName(contact.id, contact.name)
          updatedCount++
        }
      }
      if (updatedCount > 0) {
        console.log(`[WA:${this.userId}] Updated ${updatedCount} conversation names from device contacts`)
        this.markDirty()
        this.emitWA('whatsapp:conversations', this.getSortedConversations())
      }
    })

    this.waSocket.ev.on('contacts.update', async (updates) => {
      let updatedCount = 0
      for (const update of updates) {
        if (update.id && isValidPhoneJid(update.id) && update.name) {
          this.updateConversationName(update.id, update.name)
          updatedCount++
        }
      }
      if (updatedCount > 0) {
        console.log(`[WA:${this.userId}] Updated ${updatedCount} conversation names from contact updates`)
        this.markDirty()
        this.emitWA('whatsapp:conversations', this.getSortedConversations())
      }
    })

    this.waSocket.ev.on('chats.upsert', async (chats) => {
      for (const chat of chats) {
        let jid = normalizeJid(chat.id)
        if (!jid && chat.id && chat.id.endsWith('@lid')) {
          jid = this.lidToPhoneMap.get(chat.id) || null
        }
        if (!jid) continue
        // v7.35/v7.36/v7.38: Skip chats owned by another user (non-admin only).
        // Admin sees all chats. Unclaimed chats are processed for everyone.
        if (this.sessionManager) {
          const owner = this.sessionManager.getConversationOwner(jid)
          const _isAdmin = this.user && this.user.role === 'admin'
          if (owner && owner !== this.userId && !_isAdmin) continue
        }
        if (!this.conversations.has(jid)) {
          const contactName = this.contactNames.get(jid) || null
          this.conversations.set(jid, {
            jid, name: contactName, phone: extractPhone(jid),
            pushName: null, avatarUrl: null, lastMessage: null,
            lastMessageAt: chat.t ? new Date(chat.t * 1000) : null,
            unreadCount: chat.unreadCount || 0, messages: [],
          })
        } else {
          const conv = this.conversations.get(jid)
          const contactName = this.contactNames.get(jid)
          if (contactName) conv.name = contactName
          if (chat.unreadCount !== undefined) conv.unreadCount = chat.unreadCount
          if (chat.t && (!conv.lastMessageAt || new Date(chat.t * 1000) > conv.lastMessageAt)) {
            conv.lastMessageAt = new Date(chat.t * 1000)
          }
        }
      }
      this.markDirty()
      this.emitWA('whatsapp:conversations', this.getSortedConversations())
    })

    this.waSocket.ev.on('chats.update', async (updates) => {
      for (const update of updates) {
        let jid = normalizeJid(update.id)
        if (!jid && update.id && update.id.endsWith('@lid')) {
          jid = this.lidToPhoneMap.get(update.id) || null
        }
        if (!jid) continue
        // v7.35/v7.36/v7.38: ownership filter — don't mutate other users'
        // conversations (non-admin only). Admin can update any conversation.
        // Unclaimed conversations can be updated by anyone.
        if (this.sessionManager) {
          const owner = this.sessionManager.getConversationOwner(jid)
          const _isAdmin = this.user && this.user.role === 'admin'
          if (owner && owner !== this.userId && !_isAdmin) continue
        }
        const conv = this.conversations.get(jid)
        if (conv) {
          if (update.unreadCount !== undefined) conv.unreadCount = update.unreadCount
          if (update.t) conv.lastMessageAt = new Date((update.t) * 1000)
        }
      }
      this.markDirty()
      this.emitWA('whatsapp:conversations', this.getSortedConversations())
    })
  }

  // ------------------------------------------------------------------
  // Socket.io connection handlers — called from server.js
  // Each method corresponds to one socket.on('event', ...) registration.
  // ------------------------------------------------------------------

  // Called when a new socket.io socket joins the /whatsapp namespace.
  // Emits the current per-user state so the client UI is in sync.
  onWAConnection(socket) {
    const isConnected = this.connectionState.connection === 'open'
    this.emitTo(socket, 'whatsapp:status', {
      connected: isConnected,
      reason: isConnected ? undefined : (this.hasSavedSession ? 'reconnecting' : 'disconnected'),
      hasSession: this.hasSavedSession,
    })

    if (!isConnected && this.lastQrCode) {
      this.emitTo(socket, 'whatsapp:qr', { qr: this.lastQrCode })
    }

    this.emitTo(socket, 'whatsapp:conversations', this.getSortedConversations())

    if (this.syncState.isSyncing) {
      this.emitTo(socket, 'whatsapp:sync-progress', {
        isSyncing: true, progress: this.syncState.progress,
        phase: 'historical', chatsCount: this.syncState.totalChats, contactsCount: this.syncState.totalContacts,
      })
    }
  }

  async onRequestQR(socket) {
    console.log(`[WA IO:${this.userId}] QR requested by client ${socket.id}`)
    if (this.connectionState.connection === 'open') {
      this.emitTo(socket, 'whatsapp:status', { connected: true, hasSession: true })
      return
    }
    if (this.lastQrCode) {
      // We already have a QR — just re-emit it to this socket (could be a
      // newly-connected client that missed the original whatsapp:qr event).
      console.log(`[WA IO:${this.userId}] Re-emitting cached QR to client ${socket.id}`)
      this.emitTo(socket, 'whatsapp:qr', { qr: this.lastQrCode })
      return
    }
    // v7.32: Force a fresh connect. Previously this called connectWhatsApp()
    // without force=true, which would silently return early if the initial
    // start() connect was still in-flight (waConnecting=true). The result
    // was that the user killed the existing socket but no new one was
    // created → no QR ever appeared.
    console.log(`[WA IO:${this.userId}] No QR cached — forcing fresh connectWhatsApp()`)
    if (this.waReconnectTimer) {
      clearTimeout(this.waReconnectTimer)
      this.waReconnectTimer = null
    }
    if (this.waSocket) {
      try { this.waSocket.ev.removeAllListeners() } catch {}
      try { this.waSocket.end(undefined) } catch {}
      this.waSocket = null
    }
    this.lastQrCode = null
    this.reconnectAttempts = 0
    // Emit a "connecting" status so the UI shows a loading spinner
    this.emitWA('whatsapp:status', {
      connected: false,
      reason: 'connecting',
      hasSession: this.hasSavedSession,
    })
    // Force=true so we override the waConnecting guard if the initial
    // connect from start() is still in-flight.
    this.connectWhatsApp(true)
  }

  // ------------------------------------------------------------------
  // v7.31: Force a brand-new QR code.
  // ------------------------------------------------------------------
  // Clears the saved WhatsApp session (Firestore auth state + filesystem
  // auth files), then starts a fresh connect. Baileys will generate a
  // new QR code because there are no saved creds to restore.
  //
  // Use this when:
  //   - The user clicks "Solicitar QR Code" but no QR appears (because
  //     Baileys is trying to restore a stale saved session)
  //   - The user is stuck in "reconnecting..." state with no QR visible
  //   - The saved session is expired/corrupted and the user wants to
  //     start fresh with a new phone scan
  //
  // This is DESTRUCTIVE — the saved session is gone after this. The user
  // MUST scan a new QR code to reconnect. Use onRequestQR() for non-
  // destructive reconnect attempts.
  // ------------------------------------------------------------------
  async onForceNewQR(socket, callback) {
    console.log(`[WA IO:${this.userId}] Force-new-QR requested by client ${socket.id}`)
    try {
      // Cancel any pending reconnect
      if (this.waReconnectTimer) {
        clearTimeout(this.waReconnectTimer)
        this.waReconnectTimer = null
      }

      // Kill the existing socket if any
      if (this.waSocket) {
        try { this.waSocket.ev.removeAllListeners() } catch {}
        try { this.waSocket.end(undefined) } catch {}
        this.waSocket = null
      }

      // Clear in-memory state
      this.lastQrCode = null
      this.reconnectAttempts = 0
      this.connectionState = { connection: 'close' }
      this.hasSavedSession = false

      // Clear Firestore auth state
      try {
        const { getFirestoreOrNull } = require('./wa-firestore-auth-state.cjs')
        const db = getFirestoreOrNull()
        if (db) {
          await db.collection('wa_auth_states').doc(String(this.userId)).delete()
          console.log(`[WA:${this.userId}] Force-new-QR: Cleared Firestore auth state`)
          // v7.37: Also clear conv state so the new session starts fresh.
          await db.collection('wa_conv_states').doc(String(this.userId)).delete()
          console.log(`[WA:${this.userId}] Force-new-QR: Cleared Firestore conv state`)
        }
      } catch (err) {
        console.warn(`[WA:${this.userId}] Force-new-QR: Could not clear Firestore auth state:`, err && err.message)
      }

      // Clear filesystem auth files
      try {
        if (fs.existsSync(this.authFolder)) {
          for (const f of fs.readdirSync(this.authFolder)) {
            if (f.endsWith('.json')) {
              fs.unlinkSync(path.join(this.authFolder, f))
            }
          }
          console.log(`[WA:${this.userId}] Force-new-QR: Cleared filesystem auth files`)
        }
      } catch (err) {
        console.warn(`[WA:${this.userId}] Force-new-QR: Could not clear filesystem auth files:`, err && err.message)
      }

      // Clear conversation state (saved session is gone, contacts are stale)
      this.conversations.clear()
      this.contactNames.clear()
      this.deviceContacts.clear()
      this.lidToPhoneMap.clear()
      this.postedChatterIds.clear()
      this.phoneToActiveLeadCache.clear()

      // Notify the client that we're starting fresh
      this.emitWA('whatsapp:status', { connected: false, reason: 'disconnected', hasSession: false })
      this.emitWA('whatsapp:conversations', [])

      // v7.32: force=true so we override waConnecting guard if a previous
      // connect is still in-flight. Without force, this would silently
      // return early if start()'s connect hadn't finished yet.
      this.connectWhatsApp(true).catch(err => {
        console.error(`[WA:${this.userId}] Force-new-QR connect error:`, err.message)
      })

      callback?.({ success: true })
    } catch (err) {
      console.error(`[WA:${this.userId}] Force-new-QR error:`, err.message)
      callback?.({ success: false, error: err.message })
    }
  }

  onGetMessages(data, callback) {
    const jid = normalizeJid(data?.jid)
    // v7.35/v7.36/v7.38: Block access to conversations owned by ANOTHER user
    // (non-admin only). Admin sees everything. Unclaimed and own conversations
    // are accessible to everyone.
    if (jid && this.sessionManager) {
      const owner = this.sessionManager.getConversationOwner(jid)
      const isAdmin = this.user && this.user.role === 'admin'
      if (owner && owner !== this.userId && !isAdmin) {
        console.warn(`[WA:${this.userId}] onGetMessages denied for ${jid} — owned by ${owner}`)
        callback?.({ messages: [], error: 'Acesso negado a esta conversa' })
        return
      }
    }
    const conv = jid ? this.conversations.get(jid) : null
    if (!conv) { callback?.({ messages: [] }); return }
    const messages = conv.messages.slice(-200).map(m => ({
      ...m,
      timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp,
    }))
    callback?.({ messages })
  }

  async onRefreshMessages(data, callback) {
    try {
      const jid = normalizeJid(data?.jid)
      if (!jid) {
        callback?.({ success: false, error: 'Invalid JID', messages: [] })
        return
      }
      // v7.35/v7.36/v7.38: ownership check — same as onGetMessages.
      // Only blocks conversations owned by ANOTHER user (non-admin only).
      // Admin, own, and unclaimed conversations are accessible to everyone.
      if (this.sessionManager) {
        const owner = this.sessionManager.getConversationOwner(jid)
        const isAdmin = this.user && this.user.role === 'admin'
        if (owner && owner !== this.userId && !isAdmin) {
          console.warn(`[WA:${this.userId}] onRefreshMessages denied for ${jid} — owned by ${owner}`)
          callback?.({ success: false, error: 'Acesso negado a esta conversa', messages: [] })
          return
        }
      }
      const conv = this.conversations.get(jid)
      if (!conv) {
        callback?.({ success: false, error: 'Conversation not found', messages: [] })
        return
      }

      const beforeCount = conv.messages.length
      console.log(`[WA:${this.userId}] Refresh messages for ${jid} (local count: ${beforeCount})`)

      let serverFetchAttempted = false
      let serverFetchMethods = []

      if (this.waSocket && this.connectionState.connection === 'open') {
        if (typeof this.waSocket.fetchMessageHistory === 'function' && conv.messages.length > 0) {
          serverFetchAttempted = true
          serverFetchMethods.push('fetchMessageHistory')
          try {
            const lastMsg = conv.messages[conv.messages.length - 1]
            const anchorKey = {
              remoteJid: jid,
              fromMe: lastMsg.fromMe,
              id: lastMsg.whatsappId || lastMsg.id,
            }
            const anchorTs = lastMsg.timestamp instanceof Date
              ? Math.floor(lastMsg.timestamp.getTime() / 1000)
              : Math.floor(new Date(lastMsg.timestamp).getTime() / 1000)
            console.log(`[WA:${this.userId}] Triggering fetchMessageHistory for ${jid}`)
            this.waSocket.fetchMessageHistory(50, anchorKey, anchorTs)
              .then(() => console.log(`[WA:${this.userId}] fetchMessageHistory completed for ${jid}`))
              .catch(err => console.error(`[WA:${this.userId}] fetchMessageHistory error:`, err.message))
          } catch (err) {
            console.error(`[WA:${this.userId}] fetchMessageHistory trigger failed:`, err.message)
          }
        }

        if (typeof this.waSocket.resyncAppState === 'function') {
          serverFetchAttempted = true
          serverFetchMethods.push('resyncAppState')
          try {
            this.waSocket.resyncAppState(['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'], false)
              .then(() => console.log(`[WA:${this.userId}] resyncAppState completed for refresh`))
              .catch(err => console.error(`[WA:${this.userId}] resyncAppState error:`, err.message))
          } catch (err) {
            console.error(`[WA:${this.userId}] resyncAppState trigger failed:`, err.message)
          }
        }
      } else {
        console.log(`[WA:${this.userId}] Refresh skipped server-fetch — WA not connected`)
      }

      const messages = conv.messages.slice(-200).map(m => ({
        ...m,
        timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp,
      }))
      callback?.({
        success: true,
        messages,
        count: messages.length,
        serverFetchAttempted,
        serverFetchMethods,
      })

      setTimeout(() => {
        const c = this.conversations.get(jid)
        if (c) {
          const msgs = c.messages.slice(-200).map(m => ({
            ...m,
            timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp,
          }))
          console.log(`[WA:${this.userId}] Refresh result for ${jid}: ${beforeCount} → ${msgs.length} msgs`)
          this.emitWA('whatsapp:messages:refreshed', { jid, messages: msgs })
          this.emitWA('whatsapp:conversation:update', this.serializeConversation(c))
        }
      }, 2500)
    } catch (error) {
      console.error(`[WA:${this.userId}] refresh-messages error:`, error.message)
      callback?.({ success: false, error: error.message, messages: [] })
    }
  }

  onDebugEvents(data, callback) {
    try {
      callback?.({
        success: true,
        recentEvents: this.recentUpsertEvents,
        connectionState: this.connectionState.connection,
        waSocketExists: !!this.waSocket,
        waSocketReadyState: this.waSocket?.ws?.readyState,
        totalConversations: this.conversations.size,
        totalContacts: this.deviceContacts.size,
        totalPostedChatter: this.postedChatterIds.size,
        hasFetchMessageHistory: typeof this.waSocket?.fetchMessageHistory === 'function',
        hasResyncAppState: typeof this.waSocket?.resyncAppState === 'function',
      })
    } catch (error) {
      callback?.({ success: false, error: error.message })
    }
  }

  onDebugJid(data, callback) {
    try {
      const jid = normalizeJid(data?.jid)
      const conv = jid ? this.conversations.get(jid) : null
      callback?.({
        success: true,
        jid,
        normalizedJid: jid,
        hasConversation: !!conv,
        messageCount: conv ? conv.messages.length : 0,
        lastMessage: conv?.lastMessage || null,
        lastMessageAt: conv?.lastMessageAt ? conv.lastMessageAt.toISOString() : null,
        connectionState: this.connectionState.connection,
        waSocketExists: !!this.waSocket,
        totalConversations: this.conversations.size,
        totalContacts: this.deviceContacts.size,
        totalPostedChatter: this.postedChatterIds.size,
      })
    } catch (error) {
      callback?.({ success: false, error: error.message })
    }
  }

  async onSendMessage(data, callback) {
    try {
      if (!this.waSocket || this.connectionState.connection !== 'open') {
        callback?.({ success: false, error: 'WhatsApp não conectado' })
        return
      }
      const jid = normalizeJid(data?.jid)
      if (!jid) {
        callback?.({ success: false, error: 'Invalid contact JID' })
        return
      }

      // v7.35: Claim this conversation for the current user BEFORE sending.
      // The first user to send a message to this JID becomes its owner.
      // Subsequent sends by other users are still allowed (the message goes
      // out via the shared WhatsApp number), but the original owner keeps
      // ownership — i.e., incoming replies will be routed to the original
      // owner, not to the user who later replied.
      if (this.sessionManager) {
        await this.sessionManager.claimConversation(jid, this.userId)
      }

      const sent = await this.waSocket.sendMessage(jid, { text: data.text })
      const conv = this.getOrCreateConversation(jid)
      if (!conv) { callback?.({ success: false, error: 'Could not create conversation' }); return }

      const msgId = sent?.key?.id || `m-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      if (!conv.messages.some(m => m.whatsappId === msgId || m.id === msgId)) {
        const messageTimestamp = new Date()
        const messageData = {
          id: msgId,
          whatsappId: msgId,
          fromMe: true,
          textContent: data.text,
          mediaType: null,
          timestamp: messageTimestamp,
          status: 'sent',
        }

        conv.messages.push(messageData)
        conv.lastMessage = data.text
        conv.lastMessageAt = new Date()

        this.markDirty()
        this.emitWA('whatsapp:message', {
          conversationJid: jid,
          message: { ...messageData, timestamp: messageTimestamp.toISOString() },
          conversation: this.serializeConversation(conv),
        })
        this.emitWA('whatsapp:conversation:update', this.serializeConversation(conv))
      }

      // v7.29.2: Respond to the client IMMEDIATELY after the WA message
      // is sent and the local conversation is updated. Previously the
      // callback waited for `await autoSyncWhatsAppMessage()` — if Odoo
      // was slow/unreachable, the UI stayed stuck in "Enviando..."
      // forever, which the user perceived as "the page fell".
      // Now autoSync runs in the background (fire-and-forget).
      callback?.({ success: true, messageId: msgId })

      const phone = extractPhone(jid)
      if (phone) {
        // v7.29.2: fire-and-forget with explicit error logging
        this.autoSyncWhatsAppMessage({
          jid, phone, pushName: conv.pushName,
          textContent: data.text, mediaType: null,
          fromMe: true, timestamp: new Date().toISOString(),
          dedupId: msgId,
          // v7.24 (R7): text-only message — no media fields
          mediaBase64: null, mimeType: null, fileName: null,
        }).then(result => {
          if (result.partnerId || result.leadId) {
            this.emitWA('whatsapp:odoo-sync', {
              jid, phone, partnerId: result.partnerId, leadId: result.leadId,
              mailMessageId: result.mailMessageId, activityId: result.activityId,
              created: result.created, errors: result.errors,
            })
          }
        }).catch(err => console.error(`[AutoSync:${this.userId}] Send error:`, err.message))
      }
    } catch (error) {
      callback?.({ success: false, error: error.message })
    }
  }

  async onSendMedia(data, callback) {
    try {
      if (!this.waSocket || this.connectionState.connection !== 'open') { callback?.({ success: false, error: 'WhatsApp não conectado' }); return }
      const jid = normalizeJid(data?.jid)
      if (!jid) { callback?.({ success: false, error: 'Invalid contact JID' }); return }

      // v7.35: Claim this conversation for the current user BEFORE sending.
      if (this.sessionManager) {
        await this.sessionManager.claimConversation(jid, this.userId)
      }

      let sent
      if (data.type === 'image') sent = await this.waSocket.sendMessage(jid, { image: { url: data.url }, caption: data.caption })
      else if (data.type === 'document') sent = await this.waSocket.sendMessage(jid, { document: { url: data.url }, fileName: data.fileName || 'document', mimetype: data.mimeType, caption: data.caption })
      else if (data.type === 'video') sent = await this.waSocket.sendMessage(jid, { video: { url: data.url }, caption: data.caption })
      else if (data.type === 'audio') sent = await this.waSocket.sendMessage(jid, { audio: { url: data.url }, mimetype: data.mimeType || 'audio/mp4' })
      else { callback?.({ success: false, error: 'Unsupported media type' }); return }

      const conv = this.getOrCreateConversation(jid)
      if (!conv) { callback?.({ success: false, error: 'Could not create conversation' }); return }

      const msgId = sent?.key?.id || `m-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      const messageTimestamp = new Date()
      const messageData = {
        id: msgId, whatsappId: msgId, fromMe: true,
        textContent: data.caption || null, mediaType: data.type,
        timestamp: messageTimestamp, status: 'sent',
      }
      conv.messages.push(messageData)
      conv.lastMessage = data.caption || `[${data.type}]`
      conv.lastMessageAt = new Date()

      this.markDirty()
      this.emitWA('whatsapp:message', {
        conversationJid: jid,
        message: { ...messageData, timestamp: messageTimestamp.toISOString() },
        conversation: this.serializeConversation(conv),
      })

      // v7.29.2: respond immediately — don't block the UI on Odoo sync
      callback?.({ success: true, messageId: msgId })

      const phone = extractPhone(jid)
      if (phone) {
        // v7.29.2: fire-and-forget (read file + sync to Odoo in background)
        this._syncOutgoingMedia(data, conv, msgId, messageTimestamp, phone).catch(err =>
          console.error(`[AutoSync:${this.userId}] Send media error:`, err.message)
        )
      }
    } catch (error) {
      callback?.({ success: false, error: error.message })
    }
  }

  // v7.29.2: Helper — read media file from disk + sync to Odoo chatter
  // in the background. Used by onSendMedia so the UI callback isn't blocked.
  async _syncOutgoingMedia(data, conv, msgId, messageTimestamp, phone) {
    let outgoingB64 = null
    try {
      const fpath = data.url?.replace(/^\/media\//, this.mediaDir + '/')
      if (fpath && fs.existsSync(fpath)) {
        const buf = fs.readFileSync(fpath)
        if (buf.length < 1_500_000) outgoingB64 = buf.toString('base64')
      }
    } catch {}
    const result = await this.autoSyncWhatsAppMessage({
      jid: normalizeJid(data?.jid), phone, pushName: conv.pushName,
      textContent: data.caption || null, mediaType: data.type,
      fromMe: true, timestamp: messageTimestamp.toISOString(),
      dedupId: msgId,
      mediaBase64: outgoingB64,
      mimeType: data.mimeType || null,
      fileName: data.fileName || null,
    })
    if (result.partnerId || result.leadId) {
      this.emitWA('whatsapp:odoo-sync', {
        jid: normalizeJid(data?.jid), phone, partnerId: result.partnerId, leadId: result.leadId,
        mailMessageId: result.mailMessageId, activityId: result.activityId,
        created: result.created, errors: result.errors,
      })
    }
  }

  async onSendMediaBase64(data, callback) {
    try {
      if (!this.waSocket || this.connectionState.connection !== 'open') {
        callback?.({ success: false, error: 'WhatsApp não conectado' })
        return
      }
      const jid = normalizeJid(data?.jid)
      if (!jid) { callback?.({ success: false, error: 'Invalid contact JID' }); return }
      if (!data.base64 || !data.type) { callback?.({ success: false, error: 'Missing base64 or type' }); return }

      // v7.35: Claim this conversation for the current user BEFORE sending.
      if (this.sessionManager) {
        await this.sessionManager.claimConversation(jid, this.userId)
      }

      const buffer = Buffer.from(data.base64, 'base64')
      if (buffer.length === 0) { callback?.({ success: false, error: 'Empty file' }); return }

      try { fs.mkdirSync(this.mediaDir, { recursive: true }) } catch {}
      const msgId = `m-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      const safeFileName = (data.fileName || `${data.type}_${msgId}`).replace(/[^a-zA-Z0-9._-]/g, '_')
      const filePath = path.join(this.mediaDir, safeFileName)
      fs.writeFileSync(filePath, buffer)
      const mediaUrl = `/media/${safeFileName}`

      const mimeType = data.mimeType || 'application/octet-stream'

      let sent
      let mediaType = data.type
      if (data.type === 'image') {
        sent = await this.waSocket.sendMessage(jid, {
          image: buffer,
          caption: data.caption || undefined,
          mimetype: mimeType,
        })
      } else if (data.type === 'audio') {
        sent = await this.waSocket.sendMessage(jid, {
          audio: buffer,
          mimetype: mimeType || 'audio/mpeg',
          ptt: true,
        })
        mediaType = 'ptt'
      } else if (data.type === 'video') {
        sent = await this.waSocket.sendMessage(jid, {
          video: buffer,
          caption: data.caption || undefined,
          mimetype: mimeType,
        })
      } else if (data.type === 'document') {
        sent = await this.waSocket.sendMessage(jid, {
          document: buffer,
          fileName: data.fileName || 'document',
          mimetype: mimeType,
          caption: data.caption || undefined,
        })
      } else {
        callback?.({ success: false, error: 'Unsupported media type' })
        return
      }

      const conv = this.getOrCreateConversation(jid)
      if (!conv) { callback?.({ success: false, error: 'Could not create conversation' }); return }

      const finalMsgId = sent?.key?.id || msgId
      const messageTimestamp = new Date()
      const messageData = {
        id: finalMsgId, whatsappId: finalMsgId, fromMe: true,
        textContent: data.caption || null, mediaType,
        mediaUrl, mediaBase64: null,
        fileName: data.fileName || null, mimeType,
        mediaDuration: null,
        timestamp: messageTimestamp, status: 'sent',
      }

      if (!conv.messages.some(m => m.whatsappId === finalMsgId || m.id === finalMsgId)) {
        conv.messages.push(messageData)
        conv.lastMessage = data.caption || `[${mediaType}]`
        conv.lastMessageAt = new Date()

        this.markDirty()
        this.emitWA('whatsapp:message', {
          conversationJid: jid,
          message: { ...messageData, timestamp: messageTimestamp.toISOString() },
          conversation: this.serializeConversation(conv),
        })
        this.emitWA('whatsapp:conversation:update', this.serializeConversation(conv))
      }

      // v7.29.2: respond immediately — don't block the UI on Odoo sync
      callback?.({ success: true, messageId: finalMsgId, mediaUrl })

      const phone = extractPhone(jid)
      if (phone) {
        // v7.29.2: fire-and-forget (Odoo sync in background)
        // Pass the base64 data straight through — it's already in memory,
        // no need to re-read from disk. Cap at 1.5 MB to avoid Odoo XML-RPC
        // payload limits.
        const outgoingB64 = (buffer.length < 1_500_000) ? data.base64 : null
        this.autoSyncWhatsAppMessage({
          jid, phone, pushName: conv.pushName,
          textContent: data.caption || `[${mediaType}]`,
          mediaType, fromMe: true,
          timestamp: messageTimestamp.toISOString(),
          dedupId: finalMsgId,
          mediaBase64: outgoingB64,
          mimeType,
          fileName: data.fileName || null,
        }).then(result => {
          if (result.partnerId || result.leadId) {
            this.emitWA('whatsapp:odoo-sync', {
              jid, phone, partnerId: result.partnerId, leadId: result.leadId,
              mailMessageId: result.mailMessageId, activityId: result.activityId,
              created: result.created, errors: result.errors,
            })
          }
        }).catch(err => console.error(`[AutoSync:${this.userId}] Send media base64 error:`, err.message))
      }
    } catch (error) {
      console.error(`[WA IO:${this.userId}] send-media-base64 error:`, error.message)
      callback?.({ success: false, error: error.message })
    }
  }

  async onMarkRead(data, callback) {
    try {
      if (!this.waSocket || this.connectionState.connection !== 'open') { callback?.({ success: false, error: 'WhatsApp não conectado' }); return }
      const jid = normalizeJid(data?.jid)
      if (!jid) { callback?.({ success: false, error: 'Invalid JID' }); return }
      const conv = this.conversations.get(jid)
      if (conv) { conv.unreadCount = 0; this.emitWA('whatsapp:conversation:update', this.serializeConversation(conv)) }
      await this.waSocket.readMessages([{ remoteJid: jid, id: '' }])
      callback?.({ success: true })
    } catch (error) { callback?.({ success: false, error: error.message }) }
  }

  async onDisconnectWA(callback) {
    try {
      // v7.29.1: cancel any pending reconnect BEFORE logging out, otherwise
      // the timer would fire after logout and start a new socket.
      if (this.waReconnectTimer) {
        clearTimeout(this.waReconnectTimer)
        this.waReconnectTimer = null
      }
      if (this.waSocket) {
        try { this.waSocket.ev.removeAllListeners() } catch {}
        await this.waSocket.logout('User requested disconnect')
        this.waSocket = null
        this.connectionState = { connection: 'close' }
        this.hasSavedSession = false
        this.lastQrCode = null
        this.conversations.clear()
        this.contactNames.clear()
        this.deviceContacts.clear()
        this.lidToPhoneMap.clear()
        this.postedChatterIds.clear()
        this.phoneToActiveLeadCache.clear()
        try { if (fs.existsSync(this.stateFile)) fs.unlinkSync(this.stateFile) } catch {}
        // v7.30: Clear Firestore auth state on explicit logout too —
        // otherwise on next reconnect Baileys would re-hydrate the
        // logged-out creds and immediately get a 401, looping forever.
        try {
          const { getFirestoreOrNull } = require('./wa-firestore-auth-state.cjs')
          const db = getFirestoreOrNull()
          if (db) {
            await db.collection('wa_auth_states').doc(String(this.userId)).delete()
            console.log(`[WA:${this.userId}] Cleared Firestore auth state (explicit logout)`)
            // v7.37: Also clear conv state on explicit logout.
            await db.collection('wa_conv_states').doc(String(this.userId)).delete()
            console.log(`[WA:${this.userId}] Cleared Firestore conv state (explicit logout)`)
          }
        } catch (err) {
          console.warn(`[WA:${this.userId}] Could not clear Firestore auth state on logout:`, err && err.message)
        }
        // Also delete local filesystem creds files
        try {
          if (fs.existsSync(this.authFolder)) {
            for (const f of fs.readdirSync(this.authFolder)) {
              if (f.endsWith('.json')) fs.unlinkSync(path.join(this.authFolder, f))
            }
          }
        } catch {}
        this.emitWA('whatsapp:status', { connected: false, reason: 'logged_out', hasSession: false })
        this.emitWA('whatsapp:conversations', [])
        callback?.({ success: true })
      } else {
        // v7.29.1: even if waSocket is null, clear state so the UI shows
        // the disconnected state properly.
        this.connectionState = { connection: 'close' }
        this.hasSavedSession = false
        this.lastQrCode = null
        this.emitWA('whatsapp:status', { connected: false, reason: 'logged_out', hasSession: false })
        callback?.({ success: true })
      }
    } catch (error) { callback?.({ success: false, error: error.message }) }
  }

  async onGetProfilePic(data, callback) {
    try {
      if (!this.waSocket || this.connectionState.connection !== 'open') { callback?.({ success: false, url: null }); return }
      const jid = normalizeJid(data?.jid)
      if (!jid) { callback?.({ success: false, url: null }); return }
      const url = await this.waSocket.profilePictureUrl(jid, 'image').catch(() => null)
      const conv = this.conversations.get(jid)
      if (conv && url) conv.avatarUrl = url
      callback?.({ success: true, url })
    } catch { callback?.({ success: false, url: null }) }
  }

  onGetContacts(data, callback) {
    try {
      let list = this.getDeviceContactsList()
      if (data?.query) {
        const q = String(data.query).toLowerCase()
        list = list.filter(c =>
          (c.name || '').toLowerCase().includes(q) ||
          (c.phone || '').includes(q)
        )
      }
      callback?.({ success: true, data: list.slice(0, 500) })
    } catch (error) {
      callback?.({ success: false, error: error.message, data: [] })
    }
  }

  async onStartConversation(data, callback) {
    try {
      if (!this.waSocket || this.connectionState.connection !== 'open') {
        callback?.({ success: false, error: 'WhatsApp não conectado' })
        return
      }

      const proposedJid = normalizePhoneToJid(data.phone)
      if (!proposedJid) {
        callback?.({ success: false, error: 'Invalid phone number' })
        return
      }

      let realJid = proposedJid
      try {
        const result = await this.waSocket.onWhatsApp(proposedJid)
        if (result && result.length > 0) {
          if (!result[0].exists) {
            callback?.({ success: false, error: 'Phone number is not on WhatsApp' })
            return
          }
          realJid = normalizeJid(result[0].jid) || proposedJid
        }
      } catch (err) {
        console.error(`[WA:${this.userId}] onWhatsApp check failed:`, err.message)
      }

      const conv = this.getOrCreateConversation(realJid, data.name || null)
      if (!conv) {
        callback?.({ success: false, error: 'Could not create conversation' })
        return
      }

      if (data.name && !this.contactNames.has(realJid)) {
        conv.name = data.name
      }

      try {
        if (!conv.avatarUrl) {
          const picUrl = await this.waSocket.profilePictureUrl(realJid, 'image').catch(() => null)
          if (picUrl) conv.avatarUrl = picUrl
        }
      } catch {}

      // Pull history from Odoo if available
      let pulledFromOdoo = 0
      let linkedRecords = []
      if (this.odooConfig.uid) {
        try {
          const phoneDigits = String(data.phone).replace(/\D/g, '')
          const partnerDomain = await this.buildPhoneSearchDomain('res.partner', phoneDigits)
          const partnerFields = await this.getAvailableFields('res.partner')
          const partnerReadFields = ['id', 'name'].filter(f => partnerFields.has(f))
          if (partnerFields.has('phone')) partnerReadFields.push('phone')
          if (partnerFields.has('mobile')) partnerReadFields.push('mobile')
          const partners = await this.odooExecuteKw('res.partner', 'search_read', [partnerDomain], {
            fields: partnerReadFields,
            limit: 5,
          }).catch(() => [])

          for (const p of (partners || [])) {
            linkedRecords.push({ model: 'res.partner', recordId: p.id, recordName: p.name })
            this.emitOdoo('odoo:conversation:linked', { jid: realJid, model: 'res.partner', recordId: p.id })
            const pulled = await this.pullOdooChatterIntoConversation(realJid, 'res.partner', p.id)
            pulledFromOdoo += pulled
          }

          const leadDomain = await this.buildPhoneSearchDomain('crm.lead', phoneDigits, ['phone', 'mobile', 'whatsapp_number'])
          const leadFields = await this.getAvailableFields('crm.lead')
          const leadReadFields = ['id', 'name'].filter(f => leadFields.has(f))
          if (leadFields.has('phone')) leadReadFields.push('phone')
          if (leadFields.has('mobile')) leadReadFields.push('mobile')
          const leads = await this.odooExecuteKw('crm.lead', 'search_read', [leadDomain], {
            fields: leadReadFields,
            limit: 5,
          }).catch(() => [])

          for (const l of (leads || [])) {
            linkedRecords.push({ model: 'crm.lead', recordId: l.id, recordName: l.name })
            this.emitOdoo('odoo:conversation:linked', { jid: realJid, model: 'crm.lead', recordId: l.id })
            const pulled = await this.pullOdooChatterIntoConversation(realJid, 'crm.lead', l.id)
            pulledFromOdoo += pulled
          }
        } catch (err) {
          console.error(`[WA:${this.userId}] Odoo history pull failed:`, err.message)
        }
      }

      this.markDirty()
      this.emitWA('whatsapp:conversations', this.getSortedConversations())
      if (pulledFromOdoo > 0) {
        this.emitWA('whatsapp:conversation:update', this.serializeConversation(conv))
      }

      callback?.({
        success: true,
        jid: realJid,
        conversation: this.serializeConversation(conv),
        pulledFromOdoo,
        linkedRecords,
      })
    } catch (error) {
      callback?.({ success: false, error: error.message })
    }
  }

  onInjectHistory(data, callback) {
    try {
      const jid = normalizeJid(data?.jid)
      const conv = jid ? this.conversations.get(jid) : null
      if (!conv) {
        callback?.({ success: false, error: 'Conversation not found' })
        return
      }

      let added = 0
      let skipped = 0

      for (const m of (data.messages || [])) {
        if (m.externalId && conv.messages.some(existing => existing.whatsappId === m.externalId)) {
          skipped++
          continue
        }
        const ts = new Date(m.timestamp)
        const isDup = conv.messages.some(existing =>
          existing.fromMe === m.fromMe &&
          existing.textContent === m.textContent &&
          Math.abs(existing.timestamp.getTime() - ts.getTime()) < 5000
        )
        if (isDup) {
          skipped++
          continue
        }
        conv.messages.push({
          id: `odoo-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          whatsappId: m.externalId || null,
          fromMe: m.fromMe,
          textContent: m.textContent,
          mediaType: m.mediaType || null,
          timestamp: ts,
          status: 'delivered',
        })
        added++
      }

      conv.messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())

      if (conv.messages.length > 0) {
        const last = conv.messages[conv.messages.length - 1]
        if (!conv.lastMessageAt || last.timestamp > conv.lastMessageAt) {
          conv.lastMessageAt = last.timestamp
          if (last.textContent) conv.lastMessage = last.textContent
          else if (last.mediaType) conv.lastMessage = `[${last.mediaType}]`
        }
      }

      this.emitWA('whatsapp:conversation:update', this.serializeConversation(conv))
      callback?.({ success: true, added, skipped })
    } catch (error) {
      callback?.({ success: false, error: error.message })
    }
  }

  onDeleteConversation(data, callback) {
    try {
      const jid = normalizeJid(data?.jid)
      if (!jid) { callback?.({ success: false, error: 'valid jid required' }); return }
      const existed = this.conversations.delete(jid)
      this.deviceContacts.delete(jid)
      console.log(`[WA:${this.userId}] Deleted conversation ${jid} (existed=${existed})`)
      this.markDirty()
      this.emitWA('whatsapp:conversations', this.getSortedConversations())
      this.emitWA('whatsapp:conversation:deleted', { jid })
      callback?.({ success: true })
    } catch (error) {
      callback?.({ success: false, error: error.message })
    }
  }

  async onRefreshData(data, callback) {
    try {
      if (!this.waSocket || this.connectionState.connection !== 'open') {
        callback?.({ success: false, error: 'WhatsApp não conectado' })
        return
      }

      console.log(`[WA:${this.userId}] Manual refresh requested — re-syncing app state & fetching profile pics`)

      let resyncTriggered = false
      try {
        if (typeof this.waSocket.resyncAppState === 'function') {
          this.waSocket.resyncAppState(['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'], false)
            .then(() => console.log(`[WA:${this.userId}] resyncAppState complete`))
            .catch(err => console.error(`[WA:${this.userId}] resyncAppState error:`, err.message))
          resyncTriggered = true
        }
      } catch (err) {
        console.error(`[WA:${this.userId}] resyncAppState trigger failed:`, err.message)
      }

      let picsFetched = 0
      const picPromises = []
      for (const [jid, conv] of this.conversations.entries()) {
        if (picsFetched >= 15) break
        if (conv.avatarUrl) continue
        picsFetched++
        picPromises.push(
          this.waSocket.profilePictureUrl(jid, 'image')
            .then(picUrl => {
              if (picUrl) {
                conv.avatarUrl = picUrl
                this.emitWA('whatsapp:conversation:update', this.serializeConversation(conv))
              }
            })
            .catch(() => {})
        )
      }
      await Promise.race([
        Promise.allSettled(picPromises),
        new Promise(resolve => setTimeout(resolve, 10000)),
      ])

      this.markDirty()
      this.emitWA('whatsapp:conversations', this.getSortedConversations())

      const totalConversations = this.conversations.size
      const totalContacts = this.deviceContacts.size

      console.log(`[WA:${this.userId}] Refresh complete: resyncTriggered=${resyncTriggered}, picsFetched=${picsFetched}, totalConversations=${totalConversations}, totalContacts=${totalContacts}`)

      callback?.({
        success: true,
        resyncTriggered,
        picsFetched,
        chatsFetched: totalConversations,
        contactsFetched: totalContacts,
        totalConversations,
        totalContacts,
      })
    } catch (error) {
      callback?.({ success: false, error: error.message })
    }
  }

  // ===== Odoo namespace handlers =====

  onOdooConnection(socket) {
    this.emitTo(socket, 'odoo:status', {
      connected: !!this.odooConfig.uid,
      url: this.odooConfig.url, db: this.odooConfig.db, username: this.odooConfig.username,
    })
    this.emitTo(socket, 'odoo:autosync:settings', this.autoSyncSettings)
  }

  async onOdooAuthenticate(data, callback) {
    try {
      this.odooConfig = { ...data, uid: null }
      this.usingGlobalOdooConfig = false
      this.modelFieldsCache.clear()
      this.phoneToPartnerCache.clear()
      const uid = await this.odooAuthenticate()
      this.odooConfig.uid = uid
      console.log(`[Odoo:${this.userId}] Authenticated as ${data.username} (uid: ${uid})`)
      await this.getAvailableFields('res.partner')
      await this.getAvailableFields('crm.lead')
      this.emitOdoo('odoo:status', { connected: true, url: this.odooConfig.url, db: this.odooConfig.db, username: this.odooConfig.username })
      callback?.({ success: true, uid })
    } catch (error) {
      callback?.({ success: false, error: error.message })
    }
  }

  onOdooDisconnect(callback) {
    this.odooConfig = { url: '', db: '', username: '', password: '', uid: null }
    this.modelFieldsCache.clear()
    this.phoneToPartnerCache.clear()
    this.emitOdoo('odoo:status', { connected: false })
    callback?.({ success: true })
  }

  onAutoSyncUpdateSettings(data, callback) {
    try {
      this.autoSyncSettings = { ...this.autoSyncSettings, ...data }
      this.emitOdoo('odoo:autosync:settings', this.autoSyncSettings)
      callback?.({ success: true, settings: this.autoSyncSettings })
    } catch (error) { callback?.({ success: false, error: error.message }) }
  }

  onAutoSyncGetSettings(callback) {
    callback?.({ success: true, settings: this.autoSyncSettings })
  }

  async onContactsSearch(data, callback) {
    try {
      let domain = []
      if (data.query) {
        const partnerFields = await this.getAvailableFields('res.partner')
        const orClauses = []
        orClauses.push(['name', 'ilike', data.query])
        if (partnerFields.has('phone')) orClauses.push(['phone', 'ilike', data.query])
        if (partnerFields.has('mobile')) orClauses.push(['mobile', 'ilike', data.query])
        if (partnerFields.has('whatsapp')) orClauses.push(['whatsapp', 'ilike', data.query])
        if (partnerFields.has('whatsapp_number')) orClauses.push(['whatsapp_number', 'ilike', data.query])
        if (orClauses.length === 1) {
          domain = orClauses
        } else {
          domain = []
          for (let i = 0; i < orClauses.length - 1; i++) domain.push('|')
          for (const c of orClauses) domain.push(c)
        }
      }
      const records = await this.odooSearch('res.partner', domain, ['name', 'phone', 'mobile', 'email', 'whatsapp', 'image_128', 'is_company', 'country_id', 'state_id', 'city'], data.limit || 20)
      callback?.({ success: true, data: records })
    } catch (error) { callback?.({ success: false, error: error.message }) }
  }

  async onContactsCreate(data, callback) {
    try {
      const partnerFields = await this.getAvailableFields('res.partner')
      const values = { name: data.name }
      if (data.phone && partnerFields.has('phone')) values.phone = data.phone
      if (data.mobile && partnerFields.has('mobile')) values.mobile = data.mobile
      if (data.whatsapp && partnerFields.has('whatsapp')) values.whatsapp = data.whatsapp
      if (data.email && partnerFields.has('email')) values.email = data.email
      const id = await this.odooCreate('res.partner', values)
      callback?.({ success: true, id })
      this.emitOdoo('odoo:record:created', { model: 'res.partner', id, values })
    } catch (error) { callback?.({ success: false, error: error.message }) }
  }

  async onContactsSearchOrCreate(data, callback) {
    try {
      const partnerFields = await this.getAvailableFields('res.partner')
      const domain = await this.buildPhoneSearchDomain('res.partner', data.phone)
      const values = { name: data.name || `WhatsApp ${data.phone}`, phone: data.phone }
      if (partnerFields.has('mobile')) values.mobile = data.phone
      if (partnerFields.has('whatsapp')) values.whatsapp = data.phone
      const result = await this.odooSearchOrCreate('res.partner', domain, values)
      callback?.({ success: true, ...result })
    } catch (error) { callback?.({ success: false, error: error.message }) }
  }

  async onLeadsSearch(data, callback) {
    try {
      const domain = data.query ? ['|', ['name', 'ilike', data.query], ['partner_name', 'ilike', data.query]] : []
      const records = await this.odooSearch('crm.lead', domain, ['name', 'partner_id', 'partner_name', 'phone', 'mobile', 'email_from', 'type', 'stage_id', 'probability', 'user_id', 'team_id', 'create_date', 'write_date', 'whatsapp_number'], data.limit || 20)
      callback?.({ success: true, data: records })
    } catch (error) { callback?.({ success: false, error: error.message }) }
  }

  async onLeadsCreate(data, callback) {
    try {
      console.log(`[Odoo:${this.userId}] Creating ${data.type || 'opportunity'}: "${data.name}"`)
      const leadType = data.type || 'opportunity'
      const values = { name: data.name, type: leadType }
      if (data.phone) values.phone = data.phone
      if (data.partner_id) values.partner_id = data.partner_id
      if (data.partner_name) values.partner_name = data.partner_name
      if (data.whatsapp_number) values.whatsapp_number = data.whatsapp_number

      const transcript = buildConversationTranscript(data.messages || [])
      if (transcript) {
        values.description = data.description ? `${data.description}\n\n${transcript}` : transcript
      } else if (data.description) {
        values.description = data.description
      }

      const safeValues = await this.buildSafeValues('crm.lead', values)
      const id = await this.odooCreate('crm.lead', safeValues)
      console.log(`[Odoo:${this.userId}] ✓ Created crm.lead#${id} (type=${leadType})`)

      let postedMessages = 0
      if (data.messages && data.messages.length > 0) {
        console.log(`[Odoo:${this.userId}] Posting ${data.messages.length} messages to chatter of crm.lead#${id}`)
        const sorted = [...data.messages].sort(
          (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        )
        for (const m of sorted) {
          try {
            const direction = m.fromMe ? 'Enviada' : 'Recebida'
            const dateLabel = new Date(m.timestamp).toLocaleString('pt-BR')
            const mediaLabel = m.mediaType ? ` [${m.mediaType}]` : ''
            const body = m.textContent
              ? `<p><strong>📱 WhatsApp ${direction}</strong> <em>(${dateLabel})</em>${mediaLabel}</p><p>${escapeHtml(m.textContent)}</p>`
              : `<p><strong>📱 WhatsApp ${direction}</strong> <em>(${dateLabel})</em>${mediaLabel} [Mídia]</p>`
            await this.odooPostMessage('crm.lead', id, body)
            postedMessages++
          } catch (err) {
            console.error(`[Odoo:${this.userId}] Failed to post message to chatter:`, err.message)
          }
        }
      }

      callback?.({ success: true, id, postedMessages })
      this.emitOdoo('odoo:record:created', { model: 'crm.lead', id, values: safeValues })
    } catch (error) {
      console.error(`[Odoo:${this.userId}] Lead/Opportunity creation FAILED:`, error.message)
      callback?.({ success: false, error: error.message })
    }
  }

  async onSalesSearch(data, callback) {
    try {
      const domain = data.query ? ['|', ['name', 'ilike', data.query], ['partner_id', 'ilike', data.query]] : []
      const records = await this.odooSearch('sale.order', domain, ['name', 'partner_id', 'state', 'date_order', 'amount_total', 'user_id', 'team_id', 'whatsapp_number'], data.limit || 20)
      callback?.({ success: true, data: records })
    } catch (error) { callback?.({ success: false, error: error.message }) }
  }

  async onSalesCreate(data, callback) {
    try {
      const values = { partner_id: data.partner_id }
      if (data.whatsapp_number) values.whatsapp_number = data.whatsapp_number
      const id = await this.odooCreate('sale.order', values)
      callback?.({ success: true, id })
      this.emitOdoo('odoo:record:created', { model: 'sale.order', id, values })
    } catch (error) { callback?.({ success: false, error: error.message }) }
  }

  async onProjectsSearch(data, callback) {
    try {
      const domain = []
      if (data.query) domain.push('|', ['name', 'ilike', data.query], ['description', 'ilike', data.query])
      if (data.project_id) domain.push(['project_id', '=', data.project_id])
      const records = await this.odooSearch('project.task', domain, ['name', 'description', 'project_id', 'stage_id', 'user_ids', 'partner_id', 'priority', 'create_date', 'date_deadline', 'whatsapp_number'], data.limit || 20)
      callback?.({ success: true, data: records })
    } catch (error) { callback?.({ success: false, error: error.message }) }
  }

  async onProjectsCreate(data, callback) {
    try {
      console.log(`[Odoo:${this.userId}] Creating project.task: "${data.name}" (project_id=${data.project_id || 'none'})`)
      const values = { name: data.name }
      if (data.project_id) values.project_id = data.project_id
      if (data.partner_id) values.partner_id = data.partner_id
      if (data.description) values.description = data.description
      if (data.whatsapp_number) values.whatsapp_number = data.whatsapp_number

      if (!values.project_id) {
        try {
          const projects = await this.odooSearch('project.project', [], ['id', 'name'], 1)
          if (projects && projects.length > 0) {
            values.project_id = projects[0].id
            console.log(`[Odoo:${this.userId}] Auto-selected project: ${projects[0].name} (id=${projects[0].id})`)
          }
        } catch (err) {
          console.log(`[Odoo:${this.userId}] Could not auto-select project: ${err.message}`)
        }
      }

      const safeValues = await this.buildSafeValues('project.task', values)
      const id = await this.odooCreate('project.task', safeValues)
      console.log(`[Odoo:${this.userId}] ✓ Created project.task#${id}`)
      callback?.({ success: true, id })
      this.emitOdoo('odoo:record:created', { model: 'project.task', id, values: safeValues })
    } catch (error) {
      console.error(`[Odoo:${this.userId}] project.task creation FAILED:`, error.message)
      callback?.({ success: false, error: error.message })
    }
  }

  async onProjectsList(data, callback) {
    try {
      const records = await this.odooSearch('project.project', [], ['name', 'label_tasks', 'user_id', 'partner_id'], data.limit || 50)
      callback?.({ success: true, data: records })
    } catch (error) { callback?.({ success: false, error: error.message }) }
  }

  async onLinkConversation(data, callback) {
    try {
      const phone = data.phone || data.jid.split('@')[0]
      const available = await this.getAvailableFields(data.model)
      const values = {}
      if (available.has('whatsapp')) values.whatsapp = phone
      if (available.has('whatsapp_number')) values.whatsapp_number = phone
      if (available.has('phone')) values.phone = phone
      if (available.has('mobile') && !values.whatsapp) values.mobile = phone
      if (Object.keys(values).length > 0) {
        await this.odooWrite(data.model, [data.recordId], values)
      }
      try {
        await this.odooPostMessage(data.model, data.recordId, `<p><strong>[WhatsApp Middleware]</strong> Conversa vinculada — Número: ${phone}</p>`)
      } catch {}
      callback?.({ success: true })
      this.emitOdoo('odoo:conversation:linked', { jid: data.jid, model: data.model, recordId: data.recordId })
    } catch (error) { callback?.({ success: false, error: error.message }) }
  }

  async onLogMessage(data, callback) {
    try {
      const body = data.fromWhatsApp ? `<p><strong>[WhatsApp]</strong> ${data.message}</p>` : data.message
      await this.odooPostMessage(data.model, data.recordId, body)
      callback?.({ success: true })
    } catch (error) { callback?.({ success: false, error: error.message }) }
  }

  async onFetchHistory(data, callback) {
    try {
      if (!this.odooConfig.uid) {
        callback?.({ success: false, error: 'Not authenticated with Odoo' })
        return
      }
      const domain = [
        ['model', '=', data.model],
        ['res_id', '=', data.recordId],
      ]
      const messages = await this.odooExecuteKw('mail.message', 'search_read', [domain], {
        fields: ['id', 'body', 'author_id', 'email_from', 'date', 'message_type', 'subtype_id', 'create_date'],
        order: 'date asc',
        limit: data.limit || 200,
      })

      const converted = (messages || []).map((msg) => {
        const body = msg.body || ''
        // v7.28: Use parseChatterBody() to extract ONLY the user-visible
        // text from the chatter body — the content inside <span> — instead
        // of the whole stripped-HTML which included metadata like
        // "📱 WhatsApp Enviada: 14/08/2026, 10:30:45" as a prefix.
        const parsed = parseChatterBody(body)
        const fromMe = parsed.fromMe
        const plainText = parsed.text
        let timestamp = parsed.timestamp
          ? parsed.timestamp.toISOString()
          : (msg.date || msg.create_date || new Date().toISOString())
        return {
          externalId: `odoo-${msg.id}`,
          fromMe,
          textContent: plainText || null,
          mediaType: null,
          timestamp,
          source: 'odoo',
        }
      })

      callback?.({ success: true, data: converted })
    } catch (error) {
      callback?.({ success: false, error: error.message })
    }
  }

  async onSyncAllHistory(data, callback) {
    try {
      if (!this.odooConfig.uid) {
        callback?.({ success: false, error: 'Not authenticated with Odoo' })
        return
      }
      console.log(`[Odoo:${this.userId}] Manual sync-all-history triggered`)
      const result = await this.syncAllConversationsFromOdoo({ silent: false, limit: data?.limit || 1000 })
      callback?.({ success: true, ...result, lastRun: this.odooHistorySyncLastRun })
    } catch (error) {
      callback?.({ success: false, error: error.message })
    }
  }

  onSyncStatus(data, callback) {
    try {
      callback?.({
        success: true,
        inProgress: this.odooHistorySyncInProgress,
        lastRun: this.odooHistorySyncLastRun,
      })
    } catch (error) {
      callback?.({ success: false, error: error.message })
    }
  }

  async onFields(data, callback) {
    try {
      const fields = await this.odooExecuteKw(data.model, 'fields_get', [], { attributes: ['string', 'help', 'type', 'required', 'readonly'] })
      callback?.({ success: true, data: fields })
    } catch (error) { callback?.({ success: false, error: error.message }) }
  }

  async onCheckFields(data, callback) {
    try {
      const available = await this.getAvailableFields(data.model)
      const result = {}
      for (const field of data.fields) result[field] = available.has(field)
      callback?.({ success: true, data: result })
    } catch (error) { callback?.({ success: false, error: error.message }) }
  }

  async onSearch(data, callback) {
    try {
      const records = await this.odooSearch(data.model, data.domain, data.fields || [], data.limit || 20)
      callback?.({ success: true, data: records })
    } catch (error) { callback?.({ success: false, error: error.message }) }
  }

  async onRead(data, callback) {
    try {
      const records = await this.odooRead(data.model, data.ids, data.fields || [])
      callback?.({ success: true, data: records })
    } catch (error) { callback?.({ success: false, error: error.message }) }
  }

  async onWrite(data, callback) {
    try {
      const result = await this.odooWrite(data.model, data.ids, data.values)
      callback?.({ success: true, data: result })
    } catch (error) { callback?.({ success: false, error: error.message }) }
  }

  async onTeamsSearch(data, callback) {
    try {
      const records = await this.odooSearch('crm.team', [], ['name', 'user_id'], data.limit || 20)
      callback?.({ success: true, data: records })
    } catch (error) { callback?.({ success: false, error: error.message }) }
  }

  async onUsersSearch(data, callback) {
    try {
      const records = await this.odooSearch('res.users', [], ['name', 'login', 'image_128'], data.limit || 20)
      callback?.({ success: true, data: records })
    } catch (error) { callback?.({ success: false, error: error.message }) }
  }
}

// ====================================================================
// SessionManager — owns the Map of userId → UserSession
// ====================================================================

class SessionManager {
  constructor({ io, prisma, loadUserById }) {
    this.io = io
    this.prisma = prisma
    // Route user lookup through the Firestore-capable bridge when provided
    // (Firestore for logins; otherwise falls back to SQLite/Prisma).
    this.loadUserById = loadUserById || null
    this.sessions = new Map()  // userId -> UserSession
    // v7.34: pending-promises map to dedupe concurrent getOrCreate() calls.
    // Without this, when a browser opens two socket connections in parallel
    // (e.g., one to /whatsapp and one to /odoo namespace on page load),
    // both call getOrCreate(userId) at the same instant, both see no
    // existing session, both create a NEW UserSession, and both call
    // start() — producing TWO parallel WhatsApp connections for the same
    // user that fight over the same Baileys auth state. This caused the
    // duplicate "QR Code generated" / "Connection update: connecting"
    // log lines visible in v7.33.1 Render logs, and was a contributing
    // cause of the 515 (loggedOut) status after QR scan.
    this._pending = new Map()  // userId -> Promise<UserSession|null>

    // v7.35: Conversation ownership registry — maps normalizedJid -> ownerUserId.
    // Used to enforce isolation between non-admin users sharing the same WhatsApp
    // number (multi-device linked phones). When a user sends the FIRST message
    // to a contact JID via the system (onSendMessage / onSendMedia), they
    // "claim" that conversation. Incoming messages for that JID are then routed
    // ONLY to the owner. Conversations with no owner (started by the contact
    // directly on the phone) are visible ONLY to admins.
    // Persisted to Firestore (collection: conversation_owners) so it survives
    // deploys and Render sleep/wake cycles.
    this.conversationOwners = new Map()  // jid -> userId
    this._ownersLoaded = false
    this._ownersLoading = null
  }

  // v7.35: Load conversation owner mappings from Firestore (idempotent).
  // Called once on first getOrCreate() so the registry is ready before
  // any UserSession starts processing messages.
  async loadOwners() {
    if (this._ownersLoaded) return
    if (this._ownersLoading) return this._ownersLoading
    this._ownersLoading = (async () => {
      try {
        const { getFirestoreOrNull } = require('./wa-firestore-auth-state.cjs')
        const db = getFirestoreOrNull()
        if (db) {
          const snap = await db.collection('conversation_owners').get()
          let count = 0
          snap.forEach(doc => {
            const data = doc.data()
            if (data && data.ownerUserId && data.jid) {
              this.conversationOwners.set(data.jid, data.ownerUserId)
              count++
            }
          })
          console.log(`[SessionManager] Loaded ${count} conversation owner mappings from Firestore`)
        } else {
          console.log(`[SessionManager] Firestore not configured — conversation owner registry is in-memory only (will be lost on restart)`)
        }
      } catch (err) {
        console.error('[SessionManager] Failed to load conversation owners:', err && err.message)
      } finally {
        this._ownersLoaded = true
        this._ownersLoading = null
      }
    })()
    return this._ownersLoading
  }

  // v7.35: Returns ownerUserId for a JID, or null if no owner yet.
  getConversationOwner(jid) {
    if (!jid) return null
    return this.conversationOwners.get(jid) || null
  }

  // v7.35: Claim a conversation for a user — only if it has no owner yet.
  // If the conversation is already owned by another user, this is a no-op
  // (the original owner keeps ownership). Persists to Firestore.
  async claimConversation(jid, userId) {
    if (!jid || !userId) return
    const existing = this.conversationOwners.get(jid)
    if (existing === userId) return  // already owned by this user
    if (existing) {
      // Already owned by someone else — keep current owner (don't overwrite)
      console.log(`[SessionManager] claimConversation(${jid}, ${userId}) — already owned by ${existing}, ignoring`)
      return
    }
    this.conversationOwners.set(jid, userId)
    console.log(`[SessionManager] claimConversation(${jid}, ${userId}) — claimed`)
    try {
      const { getFirestoreOrNull } = require('./wa-firestore-auth-state.cjs')
      const db = getFirestoreOrNull()
      if (db) {
        // Doc ID must be safe for Firestore — JIDs contain '@' and ':' which
        // are valid in Firestore doc IDs, but to be extra safe we URL-encode.
        // (Firestore doc IDs can be up to 1500 bytes; JIDs are far shorter.)
        const docId = jid
        await db.collection('conversation_owners').doc(docId).set({
          jid,
          ownerUserId: userId,
          claimedAt: new Date(),
        })
      }
    } catch (err) {
      console.error(`[SessionManager] Failed to persist conversation owner for ${jid}:`, err && err.message)
    }
  }

  async getOrCreate(userId) {
    // v7.35: ensure conversation owner registry is loaded before any session
    // starts processing messages. Idempotent — first call kicks off the load,
    // subsequent calls await the same promise.
    await this.loadOwners()

    const existing = this.sessions.get(userId)
    if (existing) return existing

    // v7.34: if another call is already in-flight for this user, await it
    // instead of starting a second UserSession.
    const pending = this._pending.get(userId)
    if (pending) return pending

    const promise = (async () => {
      try {
        // Load user from DB (Firestore when configured, else SQLite)
        const user = this.loadUserById
          ? await this.loadUserById(userId, this.prisma)
          : await this.prisma.user.findUnique({ where: { id: userId } })
        if (!user || !user.isActive) return null

        // v7.34: re-check after the awaited DB lookup — a concurrent
        // getOrCreate() might have finished first and inserted a session.
        const raced = this.sessions.get(userId)
        if (raced) return raced

        const s = new UserSession({ userId, user, io: this.io, prisma: this.prisma, sessionManager: this })
        this.sessions.set(userId, s)
        await s.start()
        return s
      } finally {
        this._pending.delete(userId)
      }
    })()

    this._pending.set(userId, promise)
    return promise
  }

  get(userId) {
    return this.sessions.get(userId) || null
  }

  async invalidate(userId) {
    const s = this.sessions.get(userId)
    if (s) {
      s.stop()
      this.sessions.delete(userId)
    }
    // v7.34: also clear any pending getOrCreate promise — if a session
    // is being invalidated while still starting, the in-flight promise
    // should not resurrect it.
    this._pending.delete(userId)
  }

  // Stop all sessions (used on SIGTERM)
  stopAll() {
    for (const [, s] of this.sessions) {
      try { s.stop() } catch {}
    }
    this.sessions.clear()
  }

  // v7.24 (R6): Backup ALL active user sessions to Odoo chatter before
  // a deploy. Iterates every UserSession and calls backupToOdoo() on it.
  // Returns: { backed: number, failed: [{userId, email, error}], total: number }
  async backupAllToOdoo() {
    const result = { backed: 0, failed: [], total: 0, details: [] }
    const entries = Array.from(this.sessions.entries())
    result.total = entries.length
    console.log(`[SessionManager] Backup all → ${entries.length} session(s)`)
    for (const [userId, s] of entries) {
      try {
        const r = await s.backupToOdoo()
        result.details.push({ userId, email: s.user.email, ...r })
        if (r.success) {
          result.backed++
        } else {
          result.failed.push({ userId, email: s.user.email, error: r.error || 'unknown' })
        }
      } catch (err) {
        result.failed.push({ userId, email: s.user?.email || '?', error: err.message })
      }
    }
    console.log(`[SessionManager] Backup complete: ${result.backed}/${result.total} ok, ${result.failed.length} failed`)
    return result
  }
}

module.exports = {
  UserSession,
  SessionManager,
  // Pure helpers
  normalizeJid,
  isValidPhoneJid,
  extractPhone,
  jidNormalizedUser,
  normalizePhoneToJid,
  escapeHtml,
  stripHtml,
  parseChatterBody,  // v7.28: exported for tests / external use
  pushNameFallback,
  buildConversationTranscript,
  DATA_DIR,
}
