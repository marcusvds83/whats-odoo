// ====================================================================
// Whats-Odoo v7.13 — SINGLE-PROCESS SERVER
// Everything in one process: Next.js + WhatsApp (Baileys) + Odoo (XML-RPC)
// Designed for Render 512MB RAM
// ====================================================================

const { createServer } = require('http')
const { parse } = require('url')
const next = require('next')
const { Server } = require('socket.io')
const { createClient, createSecureClient } = require('xmlrpc')
const path = require('path')
const fs = require('fs')

// Ensure production mode on Render
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production'
const dev = process.env.NODE_ENV !== 'production'
const hostname = process.env.HOSTNAME || '0.0.0.0'
const port = parseInt(process.env.PORT || '10000', 10)

const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()

// ========== Paths ==========
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data')
const AUTH_FOLDER = path.join(DATA_DIR, 'auth_store')

// Create directories on startup
function ensureDirs() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch {}
  try { fs.mkdirSync(AUTH_FOLDER, { recursive: true }) } catch {}
}
ensureDirs()

console.log(`[Server] Data dir: ${DATA_DIR}`)
console.log(`[Server] Auth folder: ${AUTH_FOLDER}`)

// ====================================================================
// ODOO MODULE — In-process (no separate service)
// ====================================================================

let odooConfig = {
  url: '',
  db: '',
  username: '',
  password: '',
  uid: null,
}

let autoSyncSettings = {
  enabled: true,
  autoCreateContact: true,
  autoCreateLead: true,
  autoPostMessages: true,
  autoCreateActivity: true,
  leadPrefix: '[WhatsApp] ',
  leadTeamId: null,
  leadUserId: null,
}

const modelFieldsCache = new Map()
const phoneToPartnerCache = new Map()

function makeXmlRpcClient(p) {
  const url = new URL(odooConfig.url)
  const isHttps = url.protocol === 'https:'
  const options = {
    host: url.hostname,
    port: parseInt(url.port) || (isHttps ? 443 : 80),
    path: p,
  }
  return isHttps ? createSecureClient(options) : createClient(options)
}

function odooAuthenticate() {
  return new Promise((resolve, reject) => {
    const client = makeXmlRpcClient('/xmlrpc/2/common')
    client.methodCall('authenticate', [odooConfig.db, odooConfig.username, odooConfig.password, {}], (error, value) => {
      if (error) reject(error)
      else if (!value) reject(new Error('Authentication failed - invalid credentials'))
      else resolve(value)
    })
  })
}

function odooExecuteKw(model, method, args, kwargs = {}) {
  return new Promise((resolve, reject) => {
    if (!odooConfig.uid) {
      reject(new Error('Not authenticated with Odoo'))
      return
    }
    const client = makeXmlRpcClient('/xmlrpc/2/object')
    client.methodCall('execute_kw', [odooConfig.db, odooConfig.uid, odooConfig.password, model, method, args, kwargs], (error, value) => {
      if (error) reject(error)
      else resolve(value)
    })
  })
}

async function getAvailableFields(model) {
  if (modelFieldsCache.has(model)) return modelFieldsCache.get(model)
  try {
    const fields = await odooExecuteKw(model, 'fields_get', [], { attributes: ['string', 'type'] })
    const fieldNames = new Set(Object.keys(fields))
    modelFieldsCache.set(model, fieldNames)
    console.log(`[Odoo] Model ${model} has ${fieldNames.size} fields`)
    return fieldNames
  } catch (error) {
    console.error(`[Odoo] Failed to get fields for ${model}:`, error.message)
    return new Set()
  }
}

async function filterExistingFields(model, requestedFields) {
  const available = await getAvailableFields(model)
  const existing = requestedFields.filter(f => available.has(f))
  if (!existing.includes('id') && available.has('id')) existing.unshift('id')
  if (!existing.includes('name') && available.has('name')) existing.push('name')
  return existing
}

async function buildSafeValues(model, values) {
  const available = await getAvailableFields(model)
  const safe = {}
  for (const [key, value] of Object.entries(values)) {
    if (available.has(key)) safe[key] = value
  }
  return safe
}

async function odooSearch(model, domain, fields = [], limit = 80, offset = 0) {
  const safeFields = fields.length > 0 ? await filterExistingFields(model, fields) : []
  return odooExecuteKw(model, 'search_read', [domain], {
    fields: safeFields.length > 0 ? safeFields : undefined,
    limit,
    offset,
  })
}

async function odooRead(model, ids, fields = []) {
  const safeFields = fields.length > 0 ? await filterExistingFields(model, fields) : []
  return odooExecuteKw(model, 'read', [ids], {
    fields: safeFields.length > 0 ? safeFields : undefined,
  })
}

async function odooCreate(model, values) {
  const safeValues = await buildSafeValues(model, values)
  return odooExecuteKw(model, 'create', [safeValues])
}

async function odooWrite(model, ids, values) {
  const safeValues = await buildSafeValues(model, values)
  return odooExecuteKw(model, 'write', [ids, safeValues])
}

async function odooSearchOrCreate(model, domain, values) {
  const existing = await odooExecuteKw(model, 'search', [domain], { limit: 1 })
  if (existing && existing.length > 0) {
    const safeValues = await buildSafeValues(model, values)
    await odooWrite(model, existing, safeValues)
    return { id: existing[0], created: false }
  }
  const safeValues = await buildSafeValues(model, values)
  const newId = await odooCreate(model, safeValues)
  return { id: newId, created: true }
}

async function odooPostMessage(model, recordId, message) {
  return odooExecuteKw(model, 'message_post', [recordId], {
    body: message,
    message_type: 'comment',
    subtype_xmlid: 'mail.mt_comment',
  })
}

async function findWhatsAppActivityType() {
  try {
    const types = await odooExecuteKw('mail.activity.type', 'search_read', [[['name', 'ilike', 'WhatsApp']]], { fields: ['id', 'name'], limit: 1 })
    if (types && types.length > 0) return types[0].id
  } catch {}
  return null
}

async function odooCreateActivity(model, recordId, summary, note) {
  try {
    const activityTypeId = await findWhatsAppActivityType()
    const values = {
      res_model: model,
      res_id: recordId,
      summary,
      note,
      activity_type_id: activityTypeId || 1,
    }
    if (autoSyncSettings.leadUserId) values.user_id = autoSyncSettings.leadUserId
    return await odooExecuteKw('mail.activity', 'create', [values])
  } catch (error) {
    console.error(`[Odoo] Failed to create activity:`, error.message)
    return 0
  }
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br/>')
}

async function autoSyncWhatsAppMessage(data) {
  const result = {
    partnerId: null, leadId: null, mailMessageId: null, activityId: null,
    created: { partner: false, lead: false }, errors: [],
  }

  if (!autoSyncSettings.enabled || !odooConfig.uid) return result

  console.log(`[AutoSync] Processing message from ${data.phone}`)

  try {
    if (autoSyncSettings.autoCreateContact) {
      const contactName = data.pushName || `WhatsApp ${data.phone}`
      const domain = ['|', ['phone', 'ilike', data.phone], ['mobile', 'ilike', data.phone]]
      const partnerFields = await getAvailableFields('res.partner')
      const contactValues = { name: contactName, phone: data.phone, mobile: data.phone }
      if (partnerFields.has('whatsapp')) contactValues.whatsapp = data.phone
      if (partnerFields.has('whatsapp_number')) contactValues.whatsapp_number = data.phone

      const partnerResult = await odooSearchOrCreate('res.partner', domain, contactValues)
      result.partnerId = partnerResult.id
      result.created.partner = partnerResult.created

      const cached = phoneToPartnerCache.get(data.phone)
      if (cached) cached.partnerId = partnerResult.id
      else phoneToPartnerCache.set(data.phone, { partnerId: partnerResult.id, leadId: null, leadCreated: false })
    }

    if (autoSyncSettings.autoCreateLead && !data.fromMe && result.partnerId) {
      const cached = phoneToPartnerCache.get(data.phone)
      if (cached && cached.leadId && cached.leadCreated) {
        result.leadId = cached.leadId
      } else {
        const existingLeads = await odooSearch('crm.lead', [
          ['partner_id', '=', result.partnerId],
          ['name', 'like', autoSyncSettings.leadPrefix],
          ['type', '=', 'lead'],
        ], ['id', 'name'], 1)

        if (existingLeads && existingLeads.length > 0) {
          result.leadId = existingLeads[0].id
          if (cached) { cached.leadId = existingLeads[0].id; cached.leadCreated = true }
        } else {
          const leadName = `${autoSyncSettings.leadPrefix}${data.pushName || data.phone}`
          const leadValues = {
            name: leadName, type: 'lead', partner_id: result.partnerId, phone: data.phone,
            description: `Conversa iniciada via WhatsApp em ${new Date().toLocaleString('pt-BR')}`,
          }
          const leadFields = await getAvailableFields('crm.lead')
          if (leadFields.has('whatsapp_number')) leadValues.whatsapp_number = data.phone
          if (autoSyncSettings.leadTeamId) leadValues.team_id = autoSyncSettings.leadTeamId
          if (autoSyncSettings.leadUserId) leadValues.user_id = autoSyncSettings.leadUserId

          result.leadId = await odooCreate('crm.lead', leadValues)
          result.created.lead = true
          if (cached) { cached.leadId = result.leadId; cached.leadCreated = true }
          else phoneToPartnerCache.set(data.phone, { partnerId: result.partnerId, leadId: result.leadId, leadCreated: true })
        }
      }
    }

    if (autoSyncSettings.autoPostMessages && !data.fromMe) {
      const targetModel = result.leadId ? 'crm.lead' : (result.partnerId ? 'res.partner' : null)
      const targetId = result.leadId || result.partnerId
      if (targetModel && targetId) {
        const direction = data.fromMe ? 'Enviada' : 'Recebida'
        const mediaLabel = data.mediaType ? ` [${data.mediaType}]` : ''
        const msgBody = data.textContent
          ? `<p><strong>📱 WhatsApp ${direction}:</strong>${mediaLabel}</p><p>${escapeHtml(data.textContent)}</p>`
          : `<p><strong>📱 WhatsApp ${direction}:</strong>${mediaLabel} [Mídia]</p>`
        try {
          result.mailMessageId = await odooPostMessage(targetModel, targetId, msgBody)
        } catch (error) {
          result.errors.push(`Failed to post message: ${error.message}`)
        }
      }
    }

    if (autoSyncSettings.autoCreateActivity && result.created.lead && result.leadId) {
      try {
        result.activityId = await odooCreateActivity('crm.lead', result.leadId, 'Nova mensagem WhatsApp', `Contato ${data.pushName || data.phone} iniciou uma conversa via WhatsApp.\n\nMensagem: ${data.textContent || '[Mídia]'}`)
      } catch (error) {
        result.errors.push(`Failed to create activity: ${error.message}`)
      }
    }
  } catch (error) {
    result.errors.push(`Auto-sync error: ${error.message}`)
    console.error(`[AutoSync] Error:`, error.message)
  }

  return result
}

async function autoAuthenticateFromEnv() {
  const envUrl = process.env.ODOO_URL
  const envDb = process.env.ODOO_DB
  const envUsername = process.env.ODOO_USERNAME
  const envPassword = process.env.ODOO_PASSWORD

  if (envUrl && envDb && envUsername && envPassword) {
    console.log(`[Odoo] Auto-authenticating with env vars: ${envUrl} / ${envDb} / ${envUsername}`)
    try {
      odooConfig = { url: envUrl, db: envDb, username: envUsername, password: envPassword, uid: null }
      modelFieldsCache.clear()
      phoneToPartnerCache.clear()
      const uid = await odooAuthenticate()
      odooConfig.uid = uid
      console.log(`[Odoo] Auto-authenticated as ${envUsername} (uid: ${uid})`)
      await getAvailableFields('res.partner')
      await getAvailableFields('crm.lead')
    } catch (error) {
      console.error(`[Odoo] Auto-authentication failed: ${error.message}`)
    }
  }
}

// ====================================================================
// WHATSAPP MODULE — In-process (Baileys)
// ====================================================================

let waSocket = null
let connectionState = { connection: 'close' }
let hasSavedSession = fs.existsSync(path.join(AUTH_FOLDER, 'creds.json'))
let lastQrCode = null
let reconnectAttempts = 0
let watchdogTimer = null

// Conversations store
const conversations = new Map()
const contactNames = new Map()

// Device contacts phonebook — full list of contacts synced from device
// (even those without an existing conversation yet).
// Each entry: { jid, phone, name, avatarUrl }
const deviceContacts = new Map()

let syncState = { isSyncing: false, progress: 0, totalChats: 0, totalContacts: 0, totalMessages: 0 }

// ========== JID Normalization ==========
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
  // Strip :device and _agent suffixes — keep only the phone digits
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

function getOrCreateConversation(jid, pushName) {
  // Always normalize first — Baileys may send 5511999888777:7@s.whatsapp.net
  const normalizedJid = normalizeJid(jid)
  if (!normalizedJid) return null
  const cachedName = contactNames.get(normalizedJid) || null
  const phone = extractPhone(normalizedJid)

  if (!conversations.has(normalizedJid)) {
    conversations.set(normalizedJid, {
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
  const conv = conversations.get(normalizedJid)
  if (cachedName) {
    conv.name = cachedName
  } else if (pushName && !conv.name) {
    conv.pushName = pushName
  }

  // Also track in deviceContacts phonebook (so conversations started from
  // incoming messages appear in the Contacts tab too)
  const displayName = cachedName || pushName || phone
  if (phone) {
    if (!deviceContacts.has(normalizedJid)) {
      deviceContacts.set(normalizedJid, { jid: normalizedJid, phone, name: displayName, avatarUrl: null })
    } else if (cachedName) {
      deviceContacts.get(normalizedJid).name = cachedName
    }
  }

  return conv
}

function serializeConversation(conv) {
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

function getSortedConversations() {
  // Build a set of JIDs that are already in conversations
  const conversationJids = new Set(conversations.keys())

  // Convert device contacts (that don't have a conversation yet) into
  // conversation-like objects so they show up in the Conversas list.
  // This way, the user can see their phone contacts and start chatting
  // even without a prior conversation.
  const deviceContactEntries = []
  for (const contact of deviceContacts.values()) {
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
      // Custom flag — frontend can use this to show "Sem mensagens" placeholder
      _isDeviceContact: true,
    })
  }

  return Array.from(conversations.values())
    .filter(conv => isValidPhoneJid(conv.jid))
    .map(serializeConversation)
    .filter(Boolean)
    .concat(deviceContactEntries)
    .sort((a, b) => {
      // Conversations with messages always come first
      const tA = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
      const tB = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
      if (tA === 0 && tB === 0) {
        // Both are device contacts without messages — sort by name
        return (a.name || a.phone || '').localeCompare(b.name || b.phone || '')
      }
      return tB - tA
    })
}

function updateConversationName(jid, contactName) {
  const normalizedJid = normalizeJid(jid)
  if (!normalizedJid) return
  contactNames.set(normalizedJid, contactName)
  // Also track in deviceContacts phonebook
  const phone = extractPhone(normalizedJid)
  const existing = deviceContacts.get(normalizedJid)
  if (existing) {
    existing.name = contactName
  } else if (phone) {
    deviceContacts.set(normalizedJid, { jid: normalizedJid, phone, name: contactName, avatarUrl: null })
  }
  const conv = conversations.get(normalizedJid)
  if (conv) conv.name = contactName
}

// Normalize a phone number (strip non-digits) to a WhatsApp JID
function normalizePhoneToJid(phone) {
  if (!phone) return null
  const digits = String(phone).replace(/\D/g, '')
  if (digits.length < 7) return null
  return `${digits}@s.whatsapp.net`
}

// Serialize device contacts list (sorted by name)
function getDeviceContactsList() {
  return Array.from(deviceContacts.values())
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
}

// Strip HTML tags from a string (used to convert Odoo chatter HTML to plain text)
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

// Fetch chatter messages from Odoo (mail.message) and merge them into a conversation.
// Returns the number of messages added. Used by "start conversation from Odoo"
// and by the "Pull from Odoo" button.
async function pullOdooChatterIntoConversation(jid, model, recordId, limit = 200) {
  if (!odooConfig.uid) return 0
  if (!isValidPhoneJid(jid)) return 0
  const conv = conversations.get(jid)
  if (!conv) return 0

  try {
    const domain = [
      ['model', '=', model],
      ['res_id', '=', recordId],
    ]
    const messages = await odooExecuteKw('mail.message', 'search_read', [domain], {
      fields: ['id', 'body', 'author_id', 'email_from', 'date', 'message_type', 'subtype_id', 'create_date'],
      order: 'date asc',
      limit,
    })

    let added = 0
    for (const msg of (messages || [])) {
      const body = msg.body || ''
      const plainText = stripHtml(body)
      // Detect direction from "Enviada" / "Recebida" markers we wrote earlier
      const isSent = /WhatsApp\s+Enviada/i.test(body)
      const fromMe = isSent

      // Extract timestamp — prefer date in body parentheses, fall back to msg.date
      let timestamp
      const dateMatch = body.match(/\(([^)]+)\)/)
      if (dateMatch) {
        const parsed = new Date(dateMatch[1])
        if (!isNaN(parsed.getTime())) timestamp = parsed
      }
      if (!timestamp) timestamp = new Date(msg.date || msg.create_date || Date.now())

      // Dedup by externalId
      const externalId = `odoo-${msg.id}`
      if (conv.messages.some(m => m.whatsappId === externalId)) continue
      // Dedup by content + timestamp window
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
      // Sort messages by timestamp
      conv.messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
      // Update lastMessage if needed
      const last = conv.messages[conv.messages.length - 1]
      if (!conv.lastMessageAt || last.timestamp > conv.lastMessageAt) {
        conv.lastMessageAt = last.timestamp
        if (last.textContent) conv.lastMessage = last.textContent
      }
    }
    return added
  } catch (err) {
    console.error(`[Odoo] Chatter pull failed for ${model}#${recordId}:`, err.message)
    return 0
  }
}

// Load Baileys lazily — only after app.prepare()
let baileysModule = null
async function loadBaileys() {
  if (baileysModule) return baileysModule
  baileysModule = await import('@whiskeysockets/baileys')
  return baileysModule
}

async function connectWhatsApp(io) {
  const baileys = await loadBaileys()
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

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER)
  const { version } = await fetchLatestBaileysVersion()

  waSocket = makeWASocket({
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

  waSocket.ev.on('creds.update', saveCreds)

  waSocket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    connectionState = { connection }
    console.log(`[WA] Connection update: ${connection}`)

    if (qr) {
      lastQrCode = qr
      console.log('[WA] QR Code generated, sending to clients')
      io.of('/whatsapp').emit('whatsapp:qr', { qr })
      hasSavedSession = false
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error)?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      console.log(`[WA] Connection closed. Status: ${statusCode}, Reconnect: ${shouldReconnect}`)

      if (statusCode === DisconnectReason.loggedOut) {
        hasSavedSession = false
        lastQrCode = null
        conversations.clear()
        contactNames.clear()
        deviceContacts.clear()
        io.of('/whatsapp').emit('whatsapp:conversations', [])
      }

      io.of('/whatsapp').emit('whatsapp:status', {
        connected: false,
        reason: statusCode === DisconnectReason.loggedOut ? 'logged_out' : 'reconnecting',
        hasSession: hasSavedSession,
      })

      if (shouldReconnect) {
        reconnectAttempts++
        const delay = Math.min(2000 * Math.pow(2, reconnectAttempts - 1), 30000)
        console.log(`[WA] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})...`)
        setTimeout(() => connectWhatsApp(io), delay)
      }
    }

    if (connection === 'open') {
      console.log('[WA] Connected successfully!')
      hasSavedSession = true
      reconnectAttempts = 0
      lastQrCode = null
      io.of('/whatsapp').emit('whatsapp:status', { connected: true, hasSession: true })

      if (watchdogTimer) clearInterval(watchdogTimer)
      watchdogTimer = setInterval(() => {
        try {
          if (!waSocket || connectionState.connection !== 'open') {
            console.log('[WA Watchdog] Connection not open, forcing reconnect...')
            try { waSocket?.end(undefined) } catch {}
            waSocket = null
            connectionState = { connection: 'close' }
            reconnectAttempts++
            const delay = Math.min(2000 * Math.pow(2, reconnectAttempts - 1), 30000)
            setTimeout(() => connectWhatsApp(io), delay)
            return
          }
          const state = waSocket.ws?.readyState
          if (state === 3 || state === 2) {
            console.log('[WA Watchdog] WebSocket dead, forcing reconnect...')
            try { waSocket.end(undefined) } catch {}
            waSocket = null
            connectionState = { connection: 'close' }
            reconnectAttempts++
            const delay = Math.min(2000 * Math.pow(2, reconnectAttempts - 1), 30000)
            setTimeout(() => connectWhatsApp(io), delay)
          }
        } catch (err) {
          console.log('[WA Watchdog] Error:', err.message)
        }
      }, 60_000)

      try {
        const meId = waSocket.user?.id
        if (meId) {
          const profilePicUrl = await waSocket.profilePictureUrl(meId, 'image').catch(() => null)
          io.of('/whatsapp').emit('whatsapp:me', { id: meId, name: waSocket.user?.name, profilePicUrl })
        }
      } catch {}

      io.of('/whatsapp').emit('whatsapp:conversations', getSortedConversations())
    }
  })

  waSocket.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest, progress, syncType }) => {
    console.log(`[WA] History sync: progress=${progress}%, chats=${chats.length}, contacts=${Object.keys(contacts).length}, messages=${messages.length}`)

    syncState.isSyncing = true
    syncState.progress = progress || 0
    io.of('/whatsapp').emit('whatsapp:sync-progress', {
      isSyncing: true, progress: progress || 0, phase: syncType || 'historical',
      chatsCount: chats.length, contactsCount: Object.keys(contacts).length,
    })

    let validContactsCount = 0
    for (const [rawJid, contact] of Object.entries(contacts)) {
      const jid = normalizeJid(rawJid)
      if (jid && contact?.name) {
        contactNames.set(jid, contact.name)
        // Also populate deviceContacts phonebook so phone contacts show up
        const phone = extractPhone(jid)
        if (phone) {
          const existing = deviceContacts.get(jid)
          if (existing) existing.name = contact.name
          else deviceContacts.set(jid, { jid, phone, name: contact.name, avatarUrl: null })
        }
        validContactsCount++
      }
    }
    syncState.totalContacts = validContactsCount

    let chatsProcessed = 0
    for (const chat of chats) {
      const jid = normalizeJid(chat.id)
      if (!jid) continue
      const contactName = contactNames.get(jid) || null
      if (!conversations.has(jid)) {
        conversations.set(jid, {
          jid, name: contactName, phone: extractPhone(jid),
          pushName: null, avatarUrl: null, lastMessage: null,
          lastMessageAt: null, unreadCount: chat.unreadCount || 0, messages: [],
        })
      } else {
        const conv = conversations.get(jid)
        if (contactName) conv.name = contactName
      }
      chatsProcessed++
    }
    syncState.totalChats = chatsProcessed

    let messagesProcessed = 0
    for (const msg of messages) {
      if (!msg.key) continue
      const jid = normalizeJid(msg.key.remoteJid)
      if (!jid) continue

      const fromMe = msg.key.fromMe || false
      // Unwrap nested message types (ephemeral, viewOnce)
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

      const conv = conversations.get(jid)
      if (!conv) continue

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
    syncState.totalMessages = messagesProcessed

    const baseTime = Date.now()
    let offset = 0
    for (const conv of conversations.values()) {
      if (!conv.lastMessageAt) {
        conv.lastMessageAt = new Date(baseTime - offset)
        offset += 1000
      }
    }

    if (isLatest || progress >= 100) {
      syncState.isSyncing = false
      syncState.progress = 100
      io.of('/whatsapp').emit('whatsapp:sync-progress', {
        isSyncing: false, progress: 100, phase: 'complete',
        chatsCount: chatsProcessed, contactsCount: validContactsCount, messagesCount: messagesProcessed,
      })
    }
    io.of('/whatsapp').emit('whatsapp:conversations', getSortedConversations())
  })

  waSocket.ev.on('messages.upsert', async ({ messages, type }) => {
    // type can be 'notify' (new message) or 'append' (history sync)
    console.log(`[WA] messages.upsert: ${messages?.length || 0} msgs (type=${type || 'n/a'})`)
    for (const msg of messages || []) {
      if (!msg.key) {
        console.log('[WA] upsert msg skipped — no key')
        continue
      }
      // *** CRITICAL: Normalize the JID ***
      // Baileys may deliver messages with the device suffix (e.g. 5511999888777:7@s.whatsapp.net).
      // If we don't normalize, isValidPhoneJid rejects it and the message is silently dropped,
      // which is exactly why incoming replies never showed in the chat view.
      const rawJid = msg.key.remoteJid
      const jid = normalizeJid(rawJid)
      const fromMe = msg.key.fromMe || false
      const pushName = msg.pushName || null

      console.log(`[WA] upsert msg: rawJid=${rawJid} → normalized=${jid} fromMe=${fromMe} id=${msg.key.id}`)

      if (rawJid === 'status@broadcast') continue
      if (!jid) {
        console.log(`[WA] upsert msg skipped — invalid JID: ${rawJid}`)
        continue
      }

      const conv = getOrCreateConversation(jid, fromMe ? undefined : pushName)
      if (!conv) {
        console.log(`[WA] upsert msg skipped — could not create conversation for ${jid}`)
        continue
      }

      // *** Unwrap nested message types ***
      // Disappearing messages come wrapped in `ephemeralMessage.message.*`
      // View-once messages come wrapped in `viewOnceMessage.message.*` / `viewOnceMessageV2.message.*`
      // Without unwrapping, text extraction fails and the message is silently dropped.
      let m = msg.message
      if (m?.ephemeralMessage?.message) m = m.ephemeralMessage.message
      else if (m?.viewOnceMessage?.message) m = m.viewOnceMessage.message
      else if (m?.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message
      else if (m?.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message

      if (!m) {
        console.log(`[WA] upsert msg skipped — no message body (protocol/receipt)`)
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
        null

      let mediaType = null
      if (m.imageMessage) mediaType = 'image'
      else if (m.videoMessage) mediaType = 'video'
      else if (m.audioMessage) mediaType = 'audio'
      else if (m.pttMessage) mediaType = 'ptt'
      else if (m.documentMessage) mediaType = 'document'
      else if (m.stickerMessage) mediaType = 'sticker'

      // Skip protocol/reaction messages with no actual content
      if (!textContent && !mediaType) {
        console.log(`[WA] upsert msg skipped — no text/media (msg keys: ${Object.keys(m).join(',')})`)
        continue
      }

      const msgId = msg.key.id
      // Dedup: skip if we already have this message by whatsappId
      if (msgId && conv.messages.some(m => m.whatsappId === msgId || m.id === msgId)) {
        console.log(`[WA] Skipping duplicate message ${msgId}`)
        continue
      }

      // Robust timestamp handling — Baileys can give number (seconds) or Long object
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

      const messageData = {
        id: msgId || `m-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        whatsappId: msgId || null,
        fromMe,
        textContent,
        mediaType,
        timestamp: messageTimestamp,
        status: fromMe ? 'delivered' : 'received',
      }

      conv.messages.push(messageData)
      conv.lastMessage = textContent || (mediaType ? `[${mediaType}]` : '')
      conv.lastMessageAt = new Date()
      if (!fromMe) conv.unreadCount++

      console.log(`[WA] ✓ New message stored in ${jid} fromMe=${fromMe}: ${textContent ? textContent.slice(0, 40) : `[${mediaType}]`}`)

      // Try to fetch profile picture in background (don't block)
      if (!conv.avatarUrl) {
        waSocket.profilePictureUrl(jid, 'image').then(picUrl => {
          if (picUrl) {
            conv.avatarUrl = picUrl
            io.of('/whatsapp').emit('whatsapp:conversation:update', serializeConversation(conv))
          }
        }).catch(() => {})
      }

      // Emit to all clients — the frontend's currentJidRef will decide if it appends to the active chat
      // *** IMPORTANT: Use the normalized JID here so the frontend can match it ***
      io.of('/whatsapp').emit('whatsapp:message', {
        conversationJid: jid,
        message: {
          ...messageData,
          // Serialize timestamp to ISO string for socket transport
          timestamp: messageTimestamp.toISOString(),
        },
        conversation: serializeConversation(conv),
      })
      io.of('/whatsapp').emit('whatsapp:conversation:update', serializeConversation(conv))

      // Auto-sync to Odoo in background
      const phone = extractPhone(jid)
      if (phone) {
        autoSyncWhatsAppMessage({
          jid, phone, pushName: conv.pushName, textContent, mediaType, fromMe,
          timestamp: messageTimestamp.toISOString(),
        }).then(result => {
          if (result.partnerId || result.leadId) {
            io.of('/whatsapp').emit('whatsapp:odoo-sync', {
              jid, phone, partnerId: result.partnerId, leadId: result.leadId,
              mailMessageId: result.mailMessageId, activityId: result.activityId,
              created: result.created, errors: result.errors,
            })
          }
        }).catch(err => console.error('[AutoSync] Error:', err.message))
      }
    }
  })

  // Handle message status updates (sent → delivered → read)
  waSocket.ev.on('messages.update', async (updates) => {
    try {
      for (const update of updates || []) {
        if (!update.key || !update.key.id) continue
        const jid = normalizeJid(update.key.remoteJid)
        if (!jid) continue
        const conv = conversations.get(jid)
        if (!conv) continue

        const existing = conv.messages.find(m => m.whatsappId === update.key.id || m.id === update.key.id)
        if (!existing) continue

        let newStatus = existing.status
        if (update.status === 'read') newStatus = 'read'
        else if (update.status === 'delivered' && existing.status !== 'read') newStatus = 'delivered'
        else if (update.status === 'played' && existing.mediaType === 'audio') newStatus = 'read'

        if (newStatus !== existing.status) {
          existing.status = newStatus
          io.of('/whatsapp').emit('whatsapp:message:status', {
            conversationJid: jid,
            messageId: existing.id,
            status: newStatus,
          })
        }
      }
    } catch (err) {
      console.error('[WA] messages.update error:', err.message)
    }
  })

  waSocket.ev.on('contacts.upsert', async (contacts) => {
    console.log(`[WA] contacts.upsert: ${contacts.length} contacts received`)
    let updatedCount = 0
    for (const contact of contacts) {
      if (contact.id && isValidPhoneJid(contact.id) && contact.name) {
        updateConversationName(contact.id, contact.name)
        updatedCount++
      }
    }
    if (updatedCount > 0) {
      console.log(`[WA] Updated ${updatedCount} conversation names from device contacts`)
      io.of('/whatsapp').emit('whatsapp:conversations', getSortedConversations())
    }
  })

  waSocket.ev.on('contacts.update', async (updates) => {
    let updatedCount = 0
    for (const update of updates) {
      if (update.id && isValidPhoneJid(update.id) && update.name) {
        updateConversationName(update.id, update.name)
        updatedCount++
      }
    }
    if (updatedCount > 0) {
      console.log(`[WA] Updated ${updatedCount} conversation names from contact updates`)
      io.of('/whatsapp').emit('whatsapp:conversations', getSortedConversations())
    }
  })

  waSocket.ev.on('chats.upsert', async (chats) => {
    for (const chat of chats) {
      const jid = normalizeJid(chat.id)
      if (!jid) continue
      if (!conversations.has(jid)) {
        const contactName = contactNames.get(jid) || null
        conversations.set(jid, {
          jid, name: contactName, phone: extractPhone(jid),
          pushName: null, avatarUrl: null, lastMessage: null,
          lastMessageAt: null, unreadCount: chat.unreadCount || 0, messages: [],
        })
      } else {
        const conv = conversations.get(jid)
        const contactName = contactNames.get(jid)
        if (contactName) conv.name = contactName
      }
    }
    io.of('/whatsapp').emit('whatsapp:conversations', getSortedConversations())
  })

  waSocket.ev.on('chats.update', async (updates) => {
    for (const update of updates) {
      const jid = normalizeJid(update.id)
      if (!jid) continue
      const conv = conversations.get(jid)
      if (conv) {
        if (update.unreadCount !== undefined) conv.unreadCount = update.unreadCount
        if (update.t) conv.lastMessageAt = new Date((update.t) * 1000)
      }
    }
    io.of('/whatsapp').emit('whatsapp:conversations', getSortedConversations())
  })
}

// ====================================================================
// MAIN SERVER — Next.js + Socket.io (single process)
// ====================================================================

app.prepare().then(async () => {
  const httpServer = createServer((req, res) => {
    const parsedUrl = parse(req.url, true)
    handle(req, res, parsedUrl)
  })

  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 60000,
    pingInterval: 25000,
  })

  const waNamespace = io.of('/whatsapp')
  const odooNamespace = io.of('/odoo')

  // ========== WHATSAPP NAMESPACE ==========
  waNamespace.on('connection', (socket) => {
    console.log(`[WA IO] Client connected: ${socket.id}`)

    const isConnected = connectionState.connection === 'open'
    socket.emit('whatsapp:status', {
      connected: isConnected,
      reason: isConnected ? undefined : (hasSavedSession ? 'reconnecting' : 'disconnected'),
      hasSession: hasSavedSession,
    })

    if (!isConnected && lastQrCode) {
      socket.emit('whatsapp:qr', { qr: lastQrCode })
    }

    socket.emit('whatsapp:conversations', getSortedConversations())

    if (syncState.isSyncing) {
      socket.emit('whatsapp:sync-progress', {
        isSyncing: true, progress: syncState.progress,
        phase: 'historical', chatsCount: syncState.totalChats, contactsCount: syncState.totalContacts,
      })
    }

    socket.on('whatsapp:request-qr', () => {
      console.log('[WA IO] QR requested by client')
      if (connectionState.connection === 'open') {
        socket.emit('whatsapp:status', { connected: true, hasSession: true })
      } else if (lastQrCode) {
        socket.emit('whatsapp:qr', { qr: lastQrCode })
      } else {
        if (waSocket) {
          try { waSocket.end(undefined) } catch {}
          waSocket = null
        }
        lastQrCode = null
        connectWhatsApp(io)
      }
    })

    socket.on('whatsapp:get-messages', (data, callback) => {
      const jid = normalizeJid(data?.jid)
      const conv = jid ? conversations.get(jid) : null
      if (!conv) { callback({ messages: [] }); return }
      // Serialize timestamps to ISO strings for socket transport
      const messages = conv.messages.slice(-200).map(m => ({
        ...m,
        timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp,
      }))
      callback({ messages })
    })

    socket.on('whatsapp:send-message', async (data, callback) => {
      try {
        if (!waSocket || connectionState.connection !== 'open') {
          callback({ success: false, error: 'WhatsApp not connected' })
          return
        }
        const jid = normalizeJid(data?.jid)
        if (!jid) {
          callback({ success: false, error: 'Invalid contact JID' })
          return
        }

        const sent = await waSocket.sendMessage(jid, { text: data.text })
        const conv = getOrCreateConversation(jid)
        if (!conv) { callback({ success: false, error: 'Could not create conversation' }); return }

        const msgId = sent?.key?.id || `m-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        // Skip if message already exists (e.g., if upsert beat us to it)
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

          io.of('/whatsapp').emit('whatsapp:message', {
            conversationJid: jid,
            message: {
              ...messageData,
              timestamp: messageTimestamp.toISOString(),
            },
            conversation: serializeConversation(conv),
          })
          io.of('/whatsapp').emit('whatsapp:conversation:update', serializeConversation(conv))
        }

        const phone = extractPhone(jid)
        if (phone) {
          try {
            await autoSyncWhatsAppMessage({ jid, phone, pushName: conv.pushName, textContent: data.text, mediaType: null, fromMe: true, timestamp: new Date().toISOString() })
          } catch (err) {
            console.error('[AutoSync] Send error:', err.message)
          }
        }
        callback({ success: true, messageId: msgId })
      } catch (error) {
        callback({ success: false, error: error.message })
      }
    })

    socket.on('whatsapp:send-media', async (data, callback) => {
      try {
        if (!waSocket || connectionState.connection !== 'open') { callback({ success: false, error: 'WhatsApp not connected' }); return }
        const jid = normalizeJid(data?.jid)
        if (!jid) { callback({ success: false, error: 'Invalid contact JID' }); return }

        let sent
        if (data.type === 'image') sent = await waSocket.sendMessage(jid, { image: { url: data.url }, caption: data.caption })
        else if (data.type === 'document') sent = await waSocket.sendMessage(jid, { document: { url: data.url }, fileName: data.fileName || 'document', mimetype: data.mimeType, caption: data.caption })
        else if (data.type === 'video') sent = await waSocket.sendMessage(jid, { video: { url: data.url }, caption: data.caption })
        else if (data.type === 'audio') sent = await waSocket.sendMessage(jid, { audio: { url: data.url }, mimetype: data.mimeType || 'audio/mp4' })
        else { callback({ success: false, error: 'Unsupported media type' }); return }

        const conv = getOrCreateConversation(jid)
        if (!conv) { callback({ success: false, error: 'Could not create conversation' }); return }

        const msgId = sent?.key?.id || `m-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        const messageTimestamp = new Date()
        const messageData = {
          id: msgId,
          whatsappId: msgId,
          fromMe: true,
          textContent: data.caption || null,
          mediaType: data.type,
          timestamp: messageTimestamp,
          status: 'sent',
        }

        conv.messages.push(messageData)
        conv.lastMessage = data.caption || `[${data.type}]`
        conv.lastMessageAt = new Date()

        io.of('/whatsapp').emit('whatsapp:message', {
          conversationJid: jid,
          message: { ...messageData, timestamp: messageTimestamp.toISOString() },
          conversation: serializeConversation(conv),
        })
        callback({ success: true, messageId: msgId })
      } catch (error) {
        callback({ success: false, error: error.message })
      }
    })

    socket.on('whatsapp:mark-read', async (data, callback) => {
      try {
        if (!waSocket || connectionState.connection !== 'open') { callback({ success: false, error: 'WhatsApp not connected' }); return }
        const jid = normalizeJid(data?.jid)
        if (!jid) { callback({ success: false, error: 'Invalid JID' }); return }
        const conv = conversations.get(jid)
        if (conv) { conv.unreadCount = 0; io.of('/whatsapp').emit('whatsapp:conversation:update', serializeConversation(conv)) }
        await waSocket.readMessages([{ remoteJid: jid, id: '' }])
        callback({ success: true })
      } catch (error) { callback({ success: false, error: error.message }) }
    })

    socket.on('whatsapp:disconnect', async (callback) => {
      try {
        if (waSocket) {
          await waSocket.logout('User requested disconnect')
          waSocket = null
          connectionState = { connection: 'close' }
          hasSavedSession = false
          lastQrCode = null
          conversations.clear()
          contactNames.clear()
          deviceContacts.clear()
          io.of('/whatsapp').emit('whatsapp:status', { connected: false, reason: 'logged_out', hasSession: false })
          io.of('/whatsapp').emit('whatsapp:conversations', [])
          callback({ success: true })
        } else {
          callback({ success: false, error: 'Not connected' })
        }
      } catch (error) { callback({ success: false, error: error.message }) }
    })

    socket.on('whatsapp:get-profile-pic', async (data, callback) => {
      try {
        if (!waSocket || connectionState.connection !== 'open') { callback({ success: false, error: 'WhatsApp not connected' }); return }
        const jid = normalizeJid(data?.jid)
        if (!jid) { callback({ success: false, url: null }); return }
        const url = await waSocket.profilePictureUrl(jid, 'image').catch(() => null)
        const conv = conversations.get(jid)
        if (conv && url) conv.avatarUrl = url
        callback({ success: true, url })
      } catch { callback({ success: false, url: null }) }
    })

    // ===== Get device contacts (phonebook) =====
    // Returns the list of contacts synced from the phone, optionally filtered by query.
    socket.on('whatsapp:get-contacts', (data, callback) => {
      try {
        let list = getDeviceContactsList()
        if (data?.query) {
          const q = String(data.query).toLowerCase()
          list = list.filter(c =>
            (c.name || '').toLowerCase().includes(q) ||
            (c.phone || '').includes(q)
          )
        }
        callback({ success: true, data: list.slice(0, 500) })
      } catch (error) {
        callback({ success: false, error: error.message, data: [] })
      }
    })

    // ===== Start a conversation from a phone number =====
    // Verifies the number is on WhatsApp, creates the conversation in memory,
    // AND if Odoo is connected + the phone matches an Odoo partner/lead,
    // pulls the chatter history from Odoo and merges it into the conversation.
    // Returns the JID so the UI can navigate to the chat.
    socket.on('whatsapp:start-conversation', async (data, callback) => {
      try {
        if (!waSocket || connectionState.connection !== 'open') {
          callback({ success: false, error: 'WhatsApp not connected' })
          return
        }

        const proposedJid = normalizePhoneToJid(data.phone)
        if (!proposedJid) {
          callback({ success: false, error: 'Invalid phone number' })
          return
        }

        // Check if the number is on WhatsApp
        let realJid = proposedJid
        try {
          const result = await waSocket.onWhatsApp(proposedJid)
          if (result && result.length > 0) {
            if (!result[0].exists) {
              callback({ success: false, error: 'Phone number is not on WhatsApp' })
              return
            }
            // *** Normalize the JID returned by onWhatsApp ***
            // Baileys may return 5511999888777:7@s.whatsapp.net — we need the canonical form
            realJid = normalizeJid(result[0].jid) || proposedJid
          }
        } catch (err) {
          console.error('[WA] onWhatsApp check failed:', err.message)
        }

        // Get or create conversation (uses normalized JID internally)
        const conv = getOrCreateConversation(realJid, data.name || null)
        if (!conv) {
          callback({ success: false, error: 'Could not create conversation' })
          return
        }

        // If a name was provided and there's no device contact name, use it
        if (data.name && !contactNames.has(realJid)) {
          conv.name = data.name
        }

        // Try to fetch profile picture
        try {
          if (!conv.avatarUrl) {
            const picUrl = await waSocket.profilePictureUrl(realJid, 'image').catch(() => null)
            if (picUrl) conv.avatarUrl = picUrl
          }
        } catch {}

        // ===== Pull history from Odoo if available =====
        // When starting a conversation from an Odoo contact, we check if there's
        // a partner or lead with this phone number and pull its chatter history.
        let pulledFromOdoo = 0
        let linkedRecords = []
        if (odooConfig.uid) {
          try {
            const phoneDigits = String(data.phone).replace(/\D/g, '')
            // Search for partner with matching phone/mobile
            const partnerDomain = ['|', '|',
              ['phone', 'ilike', phoneDigits],
              ['mobile', 'ilike', phoneDigits],
              ['whatsapp', 'ilike', phoneDigits],
            ]
            const partners = await odooExecuteKw('res.partner', 'search_read', [partnerDomain], {
              fields: ['id', 'name', 'phone', 'mobile'],
              limit: 5,
            }).catch(() => [])

            for (const p of (partners || [])) {
              linkedRecords.push({ model: 'res.partner', recordId: p.id, recordName: p.name })
              // Notify frontend of the link
              io.of('/odoo').emit('odoo:conversation:linked', { jid: realJid, model: 'res.partner', recordId: p.id })
              // Pull chatter
              const pulled = await pullOdooChatterIntoConversation(realJid, 'res.partner', p.id)
              pulledFromOdoo += pulled
            }

            // Also search leads
            const leadDomain = ['|',
              ['phone', 'ilike', phoneDigits],
              ['mobile', 'ilike', phoneDigits],
            ]
            const leads = await odooExecuteKw('crm.lead', 'search_read', [leadDomain], {
              fields: ['id', 'name', 'phone', 'mobile'],
              limit: 5,
            }).catch(() => [])

            for (const l of (leads || [])) {
              linkedRecords.push({ model: 'crm.lead', recordId: l.id, recordName: l.name })
              io.of('/odoo').emit('odoo:conversation:linked', { jid: realJid, model: 'crm.lead', recordId: l.id })
              const pulled = await pullOdooChatterIntoConversation(realJid, 'crm.lead', l.id)
              pulledFromOdoo += pulled
            }
          } catch (err) {
            console.error('[WA] Odoo history pull failed:', err.message)
          }
        }

        // Notify all clients of the new/updated conversation
        io.of('/whatsapp').emit('whatsapp:conversations', getSortedConversations())
        if (pulledFromOdoo > 0) {
          io.of('/whatsapp').emit('whatsapp:conversation:update', serializeConversation(conv))
        }

        callback({
          success: true,
          jid: realJid,
          conversation: serializeConversation(conv),
          pulledFromOdoo,
          linkedRecords,
        })
      } catch (error) {
        callback({ success: false, error: error.message })
      }
    })

    // ===== Inject historical messages (e.g., pulled from Odoo chatter) =====
    // Adds messages to a conversation if they're not already present (by externalId
    // or content+timestamp). Used by the "Pull from Odoo" button on the chat header.
    socket.on('whatsapp:inject-history', (data, callback) => {
      try {
        const jid = normalizeJid(data?.jid)
        const conv = jid ? conversations.get(jid) : null
        if (!conv) {
          callback({ success: false, error: 'Conversation not found' })
          return
        }

        let added = 0
        let skipped = 0

        for (const m of (data.messages || [])) {
          // Dedup by externalId if provided
          if (m.externalId && conv.messages.some(existing => existing.whatsappId === m.externalId)) {
            skipped++
            continue
          }

          // Dedup by timestamp + content (within 5s window)
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

        // Sort messages by timestamp
        conv.messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())

        // Update lastMessage / lastMessageAt if needed
        if (conv.messages.length > 0) {
          const last = conv.messages[conv.messages.length - 1]
          if (!conv.lastMessageAt || last.timestamp > conv.lastMessageAt) {
            conv.lastMessageAt = last.timestamp
            if (last.textContent) conv.lastMessage = last.textContent
            else if (last.mediaType) conv.lastMessage = `[${last.mediaType}]`
          }
        }

        io.of('/whatsapp').emit('whatsapp:conversation:update', serializeConversation(conv))
        callback({ success: true, added, skipped })
      } catch (error) {
        callback({ success: false, error: error.message })
      }
    })

    // ===== Delete a conversation =====
    // Removes the conversation from the in-memory map and notifies all clients.
    // The conversation will reappear if the contact sends a new message.
    socket.on('whatsapp:delete-conversation', (data, callback) => {
      try {
        const jid = normalizeJid(data?.jid)
        if (!jid) { callback({ success: false, error: 'valid jid required' }); return }
        const existed = conversations.delete(jid)
        // Also remove from deviceContacts so it disappears from the Contacts tab too
        deviceContacts.delete(jid)
        console.log(`[WA] Deleted conversation ${jid} (existed=${existed})`)
        io.of('/whatsapp').emit('whatsapp:conversations', getSortedConversations())
        io.of('/whatsapp').emit('whatsapp:conversation:deleted', { jid })
        callback({ success: true })
      } catch (error) {
        callback({ success: false, error: error.message })
      }
    })

    // ===== Refresh data: re-sync app state, fetch profile pics, re-emit lists =====
    // Triggered by the user clicking the "Refresh" button.
    //
    // IMPORTANT: Baileys does NOT expose getChats() or getContacts() on the WASocket.
    // The previous implementation called those non-existent methods and silently
    // failed with 0 results — which is why the refresh button "did nothing".
    //
    // The correct way to refresh is:
    //   1. Call waSocket.resyncAppState() to trigger a fresh history sync
    //      (this fires messaging-history.set with the latest chats/contacts/messages)
    //   2. Fetch profile pictures for conversations that don't have one yet
    //      (limit to 15 to avoid rate-limiting)
    //   3. Re-emit the current conversations and contacts lists to all clients
    socket.on('whatsapp:refresh-data', async (data, callback) => {
      try {
        if (!waSocket || connectionState.connection !== 'open') {
          callback({ success: false, error: 'WhatsApp not connected' })
          return
        }

        console.log('[WA] Manual refresh requested — re-syncing app state & fetching profile pics')

        // 1. Trigger a fresh app-state resync (fires messaging-history.set asynchronously)
        let resyncTriggered = false
        try {
          if (typeof waSocket.resyncAppState === 'function') {
            // Resync all app state collections in the background
            waSocket.resyncAppState(['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'], false)
              .then(() => console.log('[WA] resyncAppState complete'))
              .catch(err => console.error('[WA] resyncAppState error:', err.message))
            resyncTriggered = true
          } else {
            console.log('[WA] resyncAppState not available on this socket')
          }
        } catch (err) {
          console.error('[WA] resyncAppState trigger failed:', err.message)
        }

        // 2. Fetch profile pictures for conversations that don't have one yet
        // (limit to 15 to avoid rate-limiting — WhatsApp will block if we hit it too fast)
        let picsFetched = 0
        const picPromises = []
        for (const [jid, conv] of conversations.entries()) {
          if (picsFetched >= 15) break
          if (conv.avatarUrl) continue
          picsFetched++
          // Use a Promise chain so all fetches happen in parallel
          picPromises.push(
            waSocket.profilePictureUrl(jid, 'image')
              .then(picUrl => {
                if (picUrl) {
                  conv.avatarUrl = picUrl
                  io.of('/whatsapp').emit('whatsapp:conversation:update', serializeConversation(conv))
                }
              })
              .catch(() => {})
          )
        }
        // Wait for all pic fetches to complete (with a 10s timeout)
        await Promise.race([
          Promise.allSettled(picPromises),
          new Promise(resolve => setTimeout(resolve, 10000)),
        ])

        // 3. Re-emit the current conversations and contacts lists
        io.of('/whatsapp').emit('whatsapp:conversations', getSortedConversations())

        // 4. Compute counts for the response
        const totalConversations = conversations.size
        const totalContacts = deviceContacts.size

        console.log(`[WA] Refresh complete: resyncTriggered=${resyncTriggered}, picsFetched=${picsFetched}, totalConversations=${totalConversations}, totalContacts=${totalContacts}`)

        callback({
          success: true,
          resyncTriggered,
          picsFetched,
          chatsFetched: totalConversations,   // for backwards-compat with frontend prop name
          contactsFetched: totalContacts,     // for backwards-compat with frontend prop name
          totalConversations,
          totalContacts,
        })
      } catch (error) {
        callback({ success: false, error: error.message })
      }
    })

    socket.on('disconnect', () => console.log(`[WA IO] Client disconnected: ${socket.id}`))
  })

  // ========== ODOO NAMESPACE ==========
  odooNamespace.on('connection', (socket) => {
    console.log(`[Odoo IO] Client connected: ${socket.id}`)

    socket.emit('odoo:status', {
      connected: !!odooConfig.uid,
      url: odooConfig.url, db: odooConfig.db, username: odooConfig.username,
    })
    socket.emit('odoo:autosync:settings', autoSyncSettings)

    socket.on('odoo:authenticate', async (data, callback) => {
      try {
        odooConfig = { ...data, uid: null }
        modelFieldsCache.clear()
        phoneToPartnerCache.clear()
        const uid = await odooAuthenticate()
        odooConfig.uid = uid
        console.log(`[Odoo] Authenticated as ${data.username} (uid: ${uid})`)
        await getAvailableFields('res.partner')
        await getAvailableFields('crm.lead')
        io.of('/odoo').emit('odoo:status', { connected: true, url: odooConfig.url, db: odooConfig.db, username: odooConfig.username })
        callback({ success: true, uid })
      } catch (error) {
        callback({ success: false, error: error.message })
      }
    })

    socket.on('odoo:disconnect', (callback) => {
      odooConfig = { url: '', db: '', username: '', password: '', uid: null }
      modelFieldsCache.clear()
      phoneToPartnerCache.clear()
      io.of('/odoo').emit('odoo:status', { connected: false })
      callback({ success: true })
    })

    socket.on('odoo:autosync:update-settings', async (data, callback) => {
      try {
        autoSyncSettings = { ...autoSyncSettings, ...data }
        io.of('/odoo').emit('odoo:autosync:settings', autoSyncSettings)
        callback({ success: true, settings: autoSyncSettings })
      } catch (error) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:autosync:get-settings', (callback) => {
      callback({ success: true, settings: autoSyncSettings })
    })

    socket.on('odoo:contacts:search', async (data, callback) => {
      try {
        const domain = data.query
          ? ['|', '|', ['name', 'ilike', data.query], ['phone', 'ilike', data.query], ['mobile', 'ilike', data.query]]
          : []
        const records = await odooSearch('res.partner', domain, ['name', 'phone', 'mobile', 'email', 'whatsapp', 'image_128', 'is_company', 'country_id', 'state_id', 'city'], data.limit || 20)
        callback({ success: true, data: records })
      } catch (error) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:contacts:create', async (data, callback) => {
      try {
        const values = { name: data.name }
        if (data.phone) values.phone = data.phone
        if (data.mobile) values.mobile = data.mobile
        if (data.whatsapp) values.whatsapp = data.whatsapp
        if (data.email) values.email = data.email
        const id = await odooCreate('res.partner', values)
        callback({ success: true, id })
        io.of('/odoo').emit('odoo:record:created', { model: 'res.partner', id, values })
      } catch (error) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:contacts:search-or-create', async (data, callback) => {
      try {
        const domain = ['|', ['phone', 'ilike', data.phone], ['mobile', 'ilike', data.phone]]
        const values = { name: data.name || `WhatsApp ${data.phone}`, phone: data.phone, mobile: data.phone }
        const result = await odooSearchOrCreate('res.partner', domain, values)
        callback({ success: true, ...result })
      } catch (error) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:leads:search', async (data, callback) => {
      try {
        const domain = data.query ? ['|', ['name', 'ilike', data.query], ['partner_name', 'ilike', data.query]] : []
        const records = await odooSearch('crm.lead', domain, ['name', 'partner_id', 'partner_name', 'phone', 'mobile', 'email_from', 'type', 'stage_id', 'probability', 'user_id', 'team_id', 'create_date', 'write_date', 'whatsapp_number'], data.limit || 20)
        callback({ success: true, data: records })
      } catch (error) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:leads:create', async (data, callback) => {
      try {
        const values = { name: data.name, type: data.type || 'lead' }
        if (data.phone) values.phone = data.phone
        if (data.partner_id) values.partner_id = data.partner_id
        if (data.partner_name) values.partner_name = data.partner_name
        if (data.description) values.description = data.description
        if (data.whatsapp_number) values.whatsapp_number = data.whatsapp_number
        const id = await odooCreate('crm.lead', values)
        callback({ success: true, id })
        io.of('/odoo').emit('odoo:record:created', { model: 'crm.lead', id, values })
      } catch (error) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:sales:search', async (data, callback) => {
      try {
        const domain = data.query ? ['|', ['name', 'ilike', data.query], ['partner_id', 'ilike', data.query]] : []
        const records = await odooSearch('sale.order', domain, ['name', 'partner_id', 'state', 'date_order', 'amount_total', 'user_id', 'team_id', 'whatsapp_number'], data.limit || 20)
        callback({ success: true, data: records })
      } catch (error) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:sales:create', async (data, callback) => {
      try {
        const values = { partner_id: data.partner_id }
        if (data.whatsapp_number) values.whatsapp_number = data.whatsapp_number
        const id = await odooCreate('sale.order', values)
        callback({ success: true, id })
        io.of('/odoo').emit('odoo:record:created', { model: 'sale.order', id, values })
      } catch (error) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:projects:search', async (data, callback) => {
      try {
        const domain = []
        if (data.query) domain.push('|', ['name', 'ilike', data.query], ['description', 'ilike', data.query])
        if (data.project_id) domain.push(['project_id', '=', data.project_id])
        const records = await odooSearch('project.task', domain, ['name', 'description', 'project_id', 'stage_id', 'user_ids', 'partner_id', 'priority', 'create_date', 'date_deadline', 'whatsapp_number'], data.limit || 20)
        callback({ success: true, data: records })
      } catch (error) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:projects:create', async (data, callback) => {
      try {
        const values = { name: data.name }
        if (data.project_id) values.project_id = data.project_id
        if (data.partner_id) values.partner_id = data.partner_id
        if (data.description) values.description = data.description
        if (data.whatsapp_number) values.whatsapp_number = data.whatsapp_number
        const id = await odooCreate('project.task', values)
        callback({ success: true, id })
        io.of('/odoo').emit('odoo:record:created', { model: 'project.task', id, values })
      } catch (error) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:projects:list', async (data, callback) => {
      try {
        const records = await odooSearch('project.project', [], ['name', 'label_tasks', 'user_id', 'partner_id'], data.limit || 50)
        callback({ success: true, data: records })
      } catch (error) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:link-conversation', async (data, callback) => {
      try {
        const phone = data.phone || data.jid.split('@')[0]
        const available = await getAvailableFields(data.model)
        const values = {}
        if (available.has('whatsapp')) values.whatsapp = phone
        if (available.has('whatsapp_number')) values.whatsapp_number = phone
        if (available.has('phone')) values.phone = phone
        if (available.has('mobile') && !values.whatsapp) values.mobile = phone
        if (Object.keys(values).length > 0) {
          await odooWrite(data.model, [data.recordId], values)
        }
        try {
          await odooPostMessage(data.model, data.recordId, `<p><strong>[WhatsApp Middleware]</strong> Conversa vinculada — Número: ${phone}</p>`)
        } catch {}
        callback({ success: true })
        io.of('/odoo').emit('odoo:conversation:linked', { jid: data.jid, model: data.model, recordId: data.recordId })
      } catch (error) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:log-message', async (data, callback) => {
      try {
        const body = data.fromWhatsApp ? `<p><strong>[WhatsApp]</strong> ${data.message}</p>` : data.message
        await odooPostMessage(data.model, data.recordId, body)
        callback({ success: true })
      } catch (error) { callback({ success: false, error: error.message }) }
    })

    // ===== Fetch conversation history from Odoo chatter =====
    // Reads mail.message records attached to a model/record and returns them
    // as WhatsApp-style message objects so the frontend can merge them back.
    socket.on('odoo:fetch-history', async (data, callback) => {
      try {
        if (!odooConfig.uid) {
          callback({ success: false, error: 'Not authenticated with Odoo' })
          return
        }
        const domain = [
          ['model', '=', data.model],
          ['res_id', '=', data.recordId],
        ]
        const messages = await odooExecuteKw('mail.message', 'search_read', [domain], {
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

        callback({ success: true, data: converted })
      } catch (error) {
        callback({ success: false, error: error.message })
      }
    })

    socket.on('odoo:fields', async (data, callback) => {
      try {
        const fields = await odooExecuteKw(data.model, 'fields_get', [], { attributes: ['string', 'help', 'type', 'required', 'readonly'] })
        callback({ success: true, data: fields })
      } catch (error) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:check-fields', async (data, callback) => {
      try {
        const available = await getAvailableFields(data.model)
        const result = {}
        for (const field of data.fields) result[field] = available.has(field)
        callback({ success: true, data: result })
      } catch (error) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:search', async (data, callback) => {
      try {
        const records = await odooSearch(data.model, data.domain, data.fields || [], data.limit || 20)
        callback({ success: true, data: records })
      } catch (error) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:read', async (data, callback) => {
      try {
        const records = await odooRead(data.model, data.ids, data.fields || [])
        callback({ success: true, data: records })
      } catch (error) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:write', async (data, callback) => {
      try {
        const result = await odooWrite(data.model, data.ids, data.values)
        callback({ success: true, data: result })
      } catch (error) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:teams:search', async (data, callback) => {
      try {
        const records = await odooSearch('crm.team', [], ['name', 'user_id'], data.limit || 20)
        callback({ success: true, data: records })
      } catch (error) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:users:search', async (data, callback) => {
      try {
        const records = await odooSearch('res.users', [], ['name', 'login', 'image_128'], data.limit || 20)
        callback({ success: true, data: records })
      } catch (error) { callback({ success: false, error: error.message }) }
    })

    socket.on('disconnect', () => console.log(`[Odoo IO] Client disconnected: ${socket.id}`))
  })

  // ========== START WHATSAPP ==========
  console.log('[Server] Starting WhatsApp connection...')
  connectWhatsApp(io).catch(err => console.error('[WA] Startup error:', err.message))

  // ========== AUTO-AUTHENTICATE ODOO ==========
  autoAuthenticateFromEnv().catch(err => console.error('[Odoo] Auto-auth error:', err.message))

  // ========== START HTTP SERVER ==========
  httpServer.listen(port, hostname, () => {
    console.log(`[Server] > Ready on http://${hostname}:${port}`)
    console.log(`[Server] WhatsApp namespace: /whatsapp`)
    console.log(`[Server] Odoo namespace: /odoo`)
  })

  process.on('SIGTERM', () => {
    console.log('[Server] SIGTERM received, shutting down...')
    if (waSocket) try { waSocket.end(undefined) } catch {}
    if (watchdogTimer) clearInterval(watchdogTimer)
    httpServer.close(() => process.exit(0))
  })

  process.on('SIGINT', () => {
    console.log('[Server] SIGINT received, shutting down...')
    if (waSocket) try { waSocket.end(undefined) } catch {}
    if (watchdogTimer) clearInterval(watchdogTimer)
    httpServer.close(() => process.exit(0))
  })
})
