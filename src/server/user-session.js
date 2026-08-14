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
  constructor({ userId, user, io, prisma }) {
    this.userId = userId
    this.user = user              // Prisma User record (with odooUrl etc.)
    this.io = io                  // socket.io server instance (for namespaces)
    this.prisma = prisma          // shared PrismaClient

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
      if (this.odooReauthTimer) { clearInterval(this.odooReauthTimer); this.odooReauthTimer = null }
      try { this.waSocket?.end(undefined) } catch {}
      this.persistConversationsToDisk()
      console.log(`[UserSession:${this.userId}] Stopped`)
    } catch (err) {
      console.error(`[UserSession:${this.userId}] Stop error:`, err.message)
    }
  }

  // ------------------------------------------------------------------
  // Persistence — conversations/contacts/messages to per-user JSON file
  // ------------------------------------------------------------------

  persistConversationsToDisk() {
    try {
      const snapshot = {
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
      fs.writeFileSync(this.stateFile, JSON.stringify(snapshot), 'utf8')
      console.log(`[UserSession:${this.userId}] Persisted ${snapshot.conversations.length} conversations to disk`)
    } catch (err) {
      console.error(`[UserSession:${this.userId}] Failed to persist conversations: ${err.message}`)
    }
  }

  loadConversationsFromDisk() {
    try {
      if (!fs.existsSync(this.stateFile)) {
        console.log(`[UserSession:${this.userId}] No saved conversation state — starting fresh`)
        return
      }
      const raw = fs.readFileSync(this.stateFile, 'utf8')
      const snapshot = JSON.parse(raw)
      if (!snapshot || snapshot.version !== 1) {
        console.log(`[UserSession:${this.userId}] Saved conversation state is old format — ignoring`)
        return
      }

      let loaded = 0
      for (const c of snapshot.conversations || []) {
        if (!c.jid || !isValidPhoneJid(c.jid)) continue
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

      for (const [jid, name] of snapshot.contactNames || []) {
        this.contactNames.set(jid, name)
      }
      for (const c of snapshot.deviceContacts || []) {
        if (c.jid) this.deviceContacts.set(c.jid, c)
      }
      for (const [lid, phone] of snapshot.lidToPhoneMap || []) {
        this.lidToPhoneMap.set(lid, phone)
      }

      console.log(`[UserSession:${this.userId}] ✓ Loaded ${loaded} conversations, ${this.contactNames.size} contact names, ${this.deviceContacts.size} device contacts (saved ${snapshot.savedAt})`)
    } catch (err) {
      console.error(`[UserSession:${this.userId}] Failed to load conversations from disk: ${err.message}`)
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
    const conversationJids = new Set(this.conversations.keys())
    const deviceContactEntries = []
    for (const contact of this.deviceContacts.values()) {
      if (conversationJids.has(contact.jid)) continue
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
      const client = this.makeXmlRpcClient('/xmlrpc/2/common')
      client.methodCall('authenticate', [this.odooConfig.db, this.odooConfig.username, this.odooConfig.password, {}], (error, value) => {
        if (error) reject(error)
        else if (!value) reject(new Error('Authentication failed - invalid credentials'))
        else resolve(value)
      })
    })
  }

  odooExecuteKw(model, method, args, kwargs = {}) {
    return new Promise((resolve, reject) => {
      if (!this.odooConfig.uid) {
        reject(new Error('Not authenticated with Odoo'))
        return
      }
      const client = this.makeXmlRpcClient('/xmlrpc/2/object')
      client.methodCall('execute_kw', [this.odooConfig.db, this.odooConfig.uid, this.odooConfig.password, model, method, args, kwargs], (error, value) => {
        if (error) reject(error)
        else resolve(value)
      })
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
        const mediaLabel = data.mediaType ? ` [${data.mediaType}]` : ''
        const tsLabel = `(${data.timestamp})`
        const msgBody = data.textContent
          ? `<p><strong>📱 WhatsApp ${direction}:</strong>${mediaLabel} ${tsLabel}</p><p>${escapeHtml(data.textContent)}</p>`
          : `<p><strong>📱 WhatsApp ${direction}:</strong>${mediaLabel} ${tsLabel} [Mídia]</p>`

        try {
          result.mailMessageId = await this.odooPostMessage('res.partner', result.partnerId, msgBody)
          result.chatterPosted = true
          console.log(`[AutoSync:${this.userId}] ✓ Posted to partner ${result.partnerId} chatter: ${direction}`)
        } catch (error) {
          result.errors.push(`Failed to post to partner chatter: ${error.message}`)
        }

        if (result.leadId) {
          try {
            await this.odooPostMessage('crm.lead', result.leadId, msgBody)
            result.chatterLeadPosted = true
            console.log(`[AutoSync:${this.userId}] ✓ Posted to lead ${result.leadId} chatter: ${direction}`)
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
        const plainText = stripHtml(body)
        const isSent = /WhatsApp\s+Enviada/i.test(body)
        const fromMe = isSent

        let timestamp
        const dateMatch = body.match(/\(([^)]+)\)/)
        if (dateMatch) {
          const parsed = new Date(dateMatch[1])
          if (!isNaN(parsed.getTime())) timestamp = parsed
        }
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

  async connectWhatsApp() {
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

    const { state, saveCreds } = await useMultiFileAuthState(this.authFolder)
    const { version } = await fetchLatestBaileysVersion()

    this.waSocket = makeWASocket({
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
      keepAliveIntervalMs: 10_000,
      markOnlineOnConnect: true,
      syncFullHistory: false,
      retryRequestDelayMs: 250,
      maxMsgRetryCount: 5,
      shouldIgnoreJid: (jid) => jid === 'status@broadcast',
    })

    this.waSocket.ev.on('creds.update', saveCreds)

    this.waSocket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update
      this.connectionState = { connection }
      console.log(`[WA:${this.userId}] Connection update: ${connection}`)

      if (qr) {
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
          this.emitWA('whatsapp:conversations', [])
        }

        this.emitWA('whatsapp:status', {
          connected: false,
          reason: statusCode === DisconnectReason.loggedOut ? 'logged_out' : 'reconnecting',
          hasSession: this.hasSavedSession,
        })

        if (shouldReconnect) {
          this.reconnectAttempts++
          const delay = Math.min(2000 * Math.pow(2, this.reconnectAttempts - 1), 30000)
          console.log(`[WA:${this.userId}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`)
          setTimeout(() => this.connectWhatsApp(), delay)
        }
      }

      if (connection === 'open') {
        console.log(`[WA:${this.userId}] Connected successfully!`)
        this.hasSavedSession = true
        this.reconnectAttempts = 0
        this.lastQrCode = null
        this.emitWA('whatsapp:status', { connected: true, hasSession: true })

        if (this.watchdogTimer) clearInterval(this.watchdogTimer)
        this.watchdogTimer = setInterval(() => {
          try {
            if (!this.waSocket || this.connectionState.connection !== 'open') {
              console.log(`[WA Watchdog:${this.userId}] Connection not open, forcing reconnect...`)
              try { this.waSocket?.end(undefined) } catch {}
              this.waSocket = null
              this.connectionState = { connection: 'close' }
              this.reconnectAttempts++
              const delay = Math.min(2000 * Math.pow(2, this.reconnectAttempts - 1), 30000)
              setTimeout(() => this.connectWhatsApp(), delay)
              return
            }
            const state = this.waSocket.ws?.readyState
            if (state === 3 || state === 2) {
              console.log(`[WA Watchdog:${this.userId}] WebSocket dead, forcing reconnect...`)
              try { this.waSocket.end(undefined) } catch {}
              this.waSocket = null
              this.connectionState = { connection: 'close' }
              this.reconnectAttempts++
              const delay = Math.min(2000 * Math.pow(2, this.reconnectAttempts - 1), 30000)
              setTimeout(() => this.connectWhatsApp(), delay)
            }
          } catch (err) {
            console.log(`[WA Watchdog:${this.userId}] Error:`, err.message)
          }
        }, 60_000)

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
      for (const chat of chats) {
        let jid = normalizeJid(chat.id)
        if (!jid && chat.id && chat.id.endsWith('@lid')) {
          jid = lidToPhone.get(chat.id) || null
          if (jid) lidChatsResolved++
        }
        if (!jid) continue
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

          const conv = this.getOrCreateConversation(jid, fromMe ? undefined : pushName)
          if (!conv) {
            console.log(`[WA:${this.userId}] upsert msg skipped — could not create conversation for ${jid}`)
            continue
          }

          let m = msg.message
          if (m?.ephemeralMessage?.message) m = m.ephemeralMessage.message
          else if (m?.viewOnceMessage?.message) m = m.viewOnceMessage.message
          else if (m?.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message
          else if (m?.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message
          else if (m?.deviceSentMessage?.message) m = m.deviceSentMessage.message
          else if (m?.editedMessage?.message) m = m.editedMessage.message

          if (!m) {
            console.log(`[WA:${this.userId}] upsert msg skipped — no message body`)
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
            console.log(`[WA:${this.userId}] upsert msg skipped — no text/media`)
            try {
              this.logUpsertEvent({ type: 'skipped-no-content', jid, keys: Object.keys(m).join(','), sample: JSON.stringify(m).slice(0, 300) })
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
                console.log(`[WA:${this.userId}] ✓ Media downloaded: ${mediaType} → ${mediaUrl} (${buffer.length} bytes)`)
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
    } else if (this.lastQrCode) {
      this.emitTo(socket, 'whatsapp:qr', { qr: this.lastQrCode })
    } else {
      if (this.waSocket) {
        try { this.waSocket.end(undefined) } catch {}
        this.waSocket = null
      }
      this.lastQrCode = null
      this.connectWhatsApp()
    }
  }

  onGetMessages(data, callback) {
    const jid = normalizeJid(data?.jid)
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

      const phone = extractPhone(jid)
      if (phone) {
        try {
          await this.autoSyncWhatsAppMessage({ jid, phone, pushName: conv.pushName, textContent: data.text, mediaType: null, fromMe: true, timestamp: new Date().toISOString(), dedupId: msgId })
        } catch (err) {
          console.error(`[AutoSync:${this.userId}] Send error:`, err.message)
        }
      }
      callback?.({ success: true, messageId: msgId })
    } catch (error) {
      callback?.({ success: false, error: error.message })
    }
  }

  async onSendMedia(data, callback) {
    try {
      if (!this.waSocket || this.connectionState.connection !== 'open') { callback?.({ success: false, error: 'WhatsApp não conectado' }); return }
      const jid = normalizeJid(data?.jid)
      if (!jid) { callback?.({ success: false, error: 'Invalid contact JID' }); return }

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

      const phone = extractPhone(jid)
      if (phone) {
        try {
          await this.autoSyncWhatsAppMessage({ jid, phone, pushName: conv.pushName, textContent: data.caption || null, mediaType: data.type, fromMe: true, timestamp: messageTimestamp.toISOString(), dedupId: msgId })
        } catch (err) {
          console.error(`[AutoSync:${this.userId}] Send media error:`, err.message)
        }
      }
      callback?.({ success: true, messageId: msgId })
    } catch (error) {
      callback?.({ success: false, error: error.message })
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

      const phone = extractPhone(jid)
      if (phone) {
        try {
          await this.autoSyncWhatsAppMessage({
            jid, phone, pushName: conv.pushName,
            textContent: data.caption || `[${mediaType}]`,
            mediaType, fromMe: true,
            timestamp: messageTimestamp.toISOString(),
            dedupId: finalMsgId,
          })
        } catch (err) {
          console.error(`[AutoSync:${this.userId}] Send media base64 error:`, err.message)
        }
      }
      callback?.({ success: true, messageId: finalMsgId, mediaUrl })
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
      if (this.waSocket) {
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
        this.emitWA('whatsapp:status', { connected: false, reason: 'logged_out', hasSession: false })
        this.emitWA('whatsapp:conversations', [])
        callback?.({ success: true })
      } else {
        callback?.({ success: false, error: 'Not connected' })
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
        const plainText = stripHtml(body)
        const isSent = /WhatsApp\s+Enviada/i.test(body)
        const fromMe = isSent
        let timestamp
        const dateMatch = body.match(/\(([^)]+)\)/)
        if (dateMatch) {
          const parsed = new Date(dateMatch[1])
          if (!isNaN(parsed.getTime())) timestamp = parsed.toISOString()
        }
        if (!timestamp) timestamp = msg.date || msg.create_date || new Date().toISOString()
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
  constructor({ io, prisma }) {
    this.io = io
    this.prisma = prisma
    this.sessions = new Map()  // userId -> UserSession
  }

  async getOrCreate(userId) {
    let s = this.sessions.get(userId)
    if (s) return s

    // Load user from DB
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user || !user.isActive) return null

    s = new UserSession({ userId, user, io: this.io, prisma: this.prisma })
    this.sessions.set(userId, s)
    await s.start()
    return s
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
  }

  // Stop all sessions (used on SIGTERM)
  stopAll() {
    for (const [, s] of this.sessions) {
      try { s.stop() } catch {}
    }
    this.sessions.clear()
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
  pushNameFallback,
  buildConversationTranscript,
  DATA_DIR,
}
