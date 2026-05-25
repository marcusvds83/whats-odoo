// =============================================================================
// Whats-Odoo v3.1 — Single-Process Server
// =============================================================================
// Merges Next.js frontend + WhatsApp Baileys + Odoo XML-RPC into ONE process.
// Previous architecture: 3 processes (server.js + tsx whatsapp + tsx odoo) = OOM
// New architecture:      1 process = ~250MB (fits in Render 512MB)
// =============================================================================

const { createServer } = require('http')
const { parse } = require('url')
const next = require('next')
const { Server } = require('socket.io')
const { existsSync, mkdirSync } = require('fs')
const { join } = require('path')
const { readFileSync, writeFileSync } = require('fs')

// Ensure production mode on Render
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production'
const dev = process.env.NODE_ENV !== 'production'
const hostname = process.env.HOSTNAME || '0.0.0.0'
const port = parseInt(process.env.PORT || '10000', 10)

// ========== WhatsApp Configuration ==========
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
const AUTH_FOLDER = join(DATA_DIR, 'auth_store')
if (!existsSync(AUTH_FOLDER)) mkdirSync(AUTH_FOLDER, { recursive: true })

// ========== Odoo Configuration ==========
let odooConfig = {
  url: '',
  db: '',
  username: '',
  password: '',
  uid: null,
}

// Auto-sync settings
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

// Cache of available fields per model (auto-detected)
const modelFieldsCache = new Map()
// Cache of phone -> Odoo record IDs
const phoneToPartnerCache = new Map()

// ========== WhatsApp State ==========
let waSocket = null
let connectionState = { connection: 'close', lastDisconnect: undefined }
let reconnectAttempts = 0

// Deduplication: track recently processed message IDs
const processedMessageIds = new Set()
const MAX_DEDUP_IDS = 1000 // reduced for memory savings

// In-memory conversation/message store
const MAX_MESSAGES_PER_CONVERSATION = 100 // reduced from 200 for memory
const conversations = new Map()

// In-memory WhatsApp contacts store
const waContacts = new Map() // jid -> { jid, name, phone, notify }
const MAX_CONTACTS = 5000 // limit for memory savings

// Baileys modules (loaded async)
let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore, Browsers, Boom, pino

// xmlrpc module (loaded async)
let xmlrpc

// Global Socket.io instance
let io = null
let waNamespace = null
let odooNamespace = null

// ========== Load ESM/CJS modules dynamically ==========
async function loadModules() {
  console.log('[Server] Loading modules...')

  // Baileys (WhatsApp) — MUST use dynamic import(), it's ESM-only
  console.log('[Server] Loading Baileys (ESM dynamic import)...')
  try {
    const baileys = await import('@whiskeysockets/baileys')
    makeWASocket = baileys.makeWASocket
    useMultiFileAuthState = baileys.useMultiFileAuthState
    DisconnectReason = baileys.DisconnectReason
    fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion
    makeCacheableSignalKeyStore = baileys.makeCacheableSignalKeyStore
    Browsers = baileys.Browsers
    console.log('[Server] Baileys loaded OK — makeWASocket:', typeof makeWASocket, 'Browsers:', typeof Browsers)
  } catch (err) {
    console.error('[Server] CRITICAL: Failed to load Baileys:', err.message)
    console.error('[Server] WhatsApp will NOT work! Check @whiskeysockets/baileys is installed.')
  }

  // @hapi/boom — ESM-only too
  try {
    const boom = await import('@hapi/boom')
    Boom = boom.Boom
    console.log('[Server] Boom loaded OK')
  } catch (err) {
    console.error('[Server] Failed to load @hapi/boom:', err.message)
  }

  // Pino logger — CJS compatible
  try {
    pino = require('pino')
    console.log('[Server] Pino loaded OK (CJS)')
  } catch {
    try {
      pino = (await import('pino')).default
      console.log('[Server] Pino loaded OK (ESM)')
    } catch (err) {
      console.error('[Server] Failed to load pino:', err.message)
      // Fallback: silent no-op logger
      pino = () => ({ info: () => {}, error: () => {}, warn: () => {}, child: () => ({ info: () => {}, error: () => {}, warn: () => {} }) })
    }
  }

  // xmlrpc — CJS compatible
  try {
    xmlrpc = require('xmlrpc')
    console.log('[Server] xmlrpc loaded OK (CJS)')
  } catch {
    try {
      xmlrpc = await import('xmlrpc')
      console.log('[Server] xmlrpc loaded OK (ESM)')
    } catch (err) {
      console.error('[Server] Failed to load xmlrpc:', err.message)
    }
  }

  console.log('[Server] All modules loaded — makeWASocket:', typeof makeWASocket, 'Browsers:', typeof Browsers, 'pino:', typeof pino)
}

// =============================================================================
// SECTION: WhatsApp Helper Functions
// =============================================================================

function extractPhone(jid) {
  const match = jid.match(/^(\d+)@/)
  return match ? match[1] : null
}

function getOrCreateConversation(jid, pushName) {
  if (!conversations.has(jid)) {
    conversations.set(jid, {
      jid,
      name: null,
      phone: extractPhone(jid),
      pushName: pushName || null,
      avatarUrl: null,
      lastMessage: null,
      lastMessageAt: null,
      unreadCount: 0,
      messages: [],
    })
  }
  const conv = conversations.get(jid)
  if (pushName && !conv.pushName) {
    conv.pushName = pushName
  }
  return conv
}

function serializeConversation(conv) {
  return {
    jid: conv.jid,
    name: conv.name,
    phone: conv.phone,
    pushName: conv.pushName,
    avatarUrl: conv.avatarUrl,
    lastMessage: conv.lastMessage,
    lastMessageAt: conv.lastMessageAt?.toISOString() || null,
    unreadCount: conv.unreadCount,
    messageCount: conv.messages.length,
  }
}

// =============================================================================
// SECTION: Odoo XML-RPC Client
// =============================================================================

function makeXmlRpcClient(path) {
  const url = new URL(odooConfig.url)
  const isHttps = url.protocol === 'https:'
  const options = {
    host: url.hostname,
    port: parseInt(url.port) || (isHttps ? 443 : 80),
    path,
  }
  return isHttps ? xmlrpc.createSecureClient(options) : xmlrpc.createClient(options)
}

function odooAuthenticate() {
  return new Promise((resolve, reject) => {
    const client = makeXmlRpcClient('/xmlrpc/2/common')
    client.methodCall('authenticate', [
      odooConfig.db, odooConfig.username, odooConfig.password, {},
    ], (error, value) => {
      if (error) return reject(error)
      if (!value) return reject(new Error('Authentication failed - invalid credentials'))
      resolve(value)
    })
  })
}

function odooExecuteKw(model, method, args, kwargs = {}) {
  return new Promise((resolve, reject) => {
    if (!odooConfig.uid) {
      return reject(new Error('Not authenticated with Odoo'))
    }
    const client = makeXmlRpcClient('/xmlrpc/2/object')
    client.methodCall('execute_kw', [
      odooConfig.db, odooConfig.uid, odooConfig.password, model, method, args, kwargs,
    ], (error, value) => {
      if (error) reject(error)
      else resolve(value)
    })
  })
}

// Smart Field Detection
async function getAvailableFields(model) {
  if (modelFieldsCache.has(model)) return modelFieldsCache.get(model)
  try {
    const fields = await odooExecuteKw(model, 'fields_get', [], { attributes: ['string', 'type'] })
    const fieldNames = new Set(Object.keys(fields))
    modelFieldsCache.set(model, fieldNames)
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
    if (available.has(key)) {
      safe[key] = value
    } else {
      console.log(`[Odoo] Field "${key}" does not exist on ${model}, skipping`)
    }
  }
  return safe
}

async function smartWriteWhatsAppNumber(model, ids, phone) {
  const available = await getAvailableFields(model)
  const values = {}
  if (available.has('whatsapp')) values.whatsapp = phone
  if (available.has('whatsapp_number')) values.whatsapp_number = phone
  if (available.has('phone')) values.phone = phone
  if (available.has('mobile') && !values.whatsapp) values.mobile = phone
  if (Object.keys(values).length === 0) return false
  return odooWrite(model, ids, values)
}

// High-level Odoo Operations
async function odooSearch(model, domain, fields = [], limit = 80, offset = 0) {
  const safeFields = fields.length > 0 ? await filterExistingFields(model, fields) : []
  return odooExecuteKw(model, 'search_read', [domain], {
    fields: safeFields.length > 0 ? safeFields : undefined,
    limit, offset,
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
    console.error('[Odoo] Failed to create activity:', error.message)
    return 0
  }
}

async function findWhatsAppActivityType() {
  try {
    const types = await odooExecuteKw('mail.activity.type', 'search_read', [
      [['name', 'ilike', 'WhatsApp']],
    ], { fields: ['id', 'name'], limit: 1 })
    if (types && types.length > 0) return types[0].id
  } catch { /* Activity type might not exist */ }
  return null
}

async function odooGetFields(model, attributes = ['string', 'help', 'type', 'required', 'readonly']) {
  return odooExecuteKw(model, 'fields_get', [], { attributes })
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br/>')
}

// =============================================================================
// SECTION: Auto-Sync Engine (DIRECT function calls, no Socket.io bridge)
// =============================================================================

async function autoSyncWhatsAppMessage(data) {
  const result = {
    partnerId: null,
    leadId: null,
    mailMessageId: null,
    activityId: null,
    created: { partner: false, lead: false },
    errors: [],
  }

  if (!autoSyncSettings.enabled || !odooConfig.uid) return result

  console.log(`[AutoSync] Processing message from ${data.phone} (${data.pushName || 'unknown'})`)

  try {
    // Step 1: Create or update contact
    if (autoSyncSettings.autoCreateContact) {
      const contactName = data.pushName || `WhatsApp ${data.phone}`
      const domain = ['|', ['phone', 'ilike', data.phone], ['mobile', 'ilike', data.phone]]
      const contactValues = { name: contactName, phone: data.phone, mobile: data.phone }

      const partnerFields = await getAvailableFields('res.partner')
      if (partnerFields.has('whatsapp')) contactValues.whatsapp = data.phone
      if (partnerFields.has('whatsapp_number')) contactValues.whatsapp_number = data.phone

      const partnerResult = await odooSearchOrCreate('res.partner', domain, contactValues)
      result.partnerId = partnerResult.id
      result.created.partner = partnerResult.created

      const cached = phoneToPartnerCache.get(data.phone)
      if (cached) {
        cached.partnerId = partnerResult.id
      } else {
        phoneToPartnerCache.set(data.phone, { partnerId: partnerResult.id, leadId: null, leadCreated: false })
      }
      console.log(`[AutoSync] Contact ${partnerResult.created ? 'created' : 'updated'}: res.partner#${partnerResult.id}`)
    }

    // Step 2: Create lead for new conversations
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
          console.log(`[AutoSync] Found existing lead: crm.lead#${existingLeads[0].id}`)
        } else {
          const leadName = `${autoSyncSettings.leadPrefix}${data.pushName || data.phone}`
          const leadValues = {
            name: leadName,
            type: 'lead',
            partner_id: result.partnerId,
            phone: data.phone,
            description: `Conversa iniciada via WhatsApp em ${new Date().toLocaleString('pt-BR')}`,
          }

          const leadFields = await getAvailableFields('crm.lead')
          if (leadFields.has('whatsapp_number')) leadValues.whatsapp_number = data.phone

          if (autoSyncSettings.leadTeamId) leadValues.team_id = autoSyncSettings.leadTeamId
          if (autoSyncSettings.leadUserId) leadValues.user_id = autoSyncSettings.leadUserId

          result.leadId = await odooCreate('crm.lead', leadValues)
          result.created.lead = true

          if (cached) {
            cached.leadId = result.leadId
            cached.leadCreated = true
          } else {
            phoneToPartnerCache.set(data.phone, { partnerId: result.partnerId, leadId: result.leadId, leadCreated: true })
          }
          console.log(`[AutoSync] Lead created: crm.lead#${result.leadId}`)
        }
      }
    }

    // Step 3: Post message in Odoo chatter
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
          console.log(`[AutoSync] Message posted on ${targetModel}#${targetId}`)
        } catch (error) {
          result.errors.push(`Failed to post message: ${error.message}`)
        }
      }
    }

    // Step 4: Create activity notification for first message of a new lead
    if (autoSyncSettings.autoCreateActivity && result.created.lead && result.leadId) {
      const summary = 'Nova mensagem WhatsApp'
      const note = `Contato ${data.pushName || data.phone} iniciou uma conversa via WhatsApp.\n\nMensagem: ${data.textContent || '[Mídia]'}`
      try {
        result.activityId = await odooCreateActivity('crm.lead', result.leadId, summary, note)
      } catch (error) {
        result.errors.push(`Failed to create activity: ${error.message}`)
      }
    }
  } catch (error) {
    result.errors.push(`Auto-sync error: ${error.message}`)
    console.error('[AutoSync] Error:', error.message)
  }

  // Emit sync result to all connected clients
  if (odooNamespace) {
    odooNamespace.emit('odoo:autosync:result', { phone: data.phone, ...result })
  }

  return result
}

// =============================================================================
// SECTION: WhatsApp Baileys Connection
// =============================================================================

// waLogger is created AFTER loadModules() in main(). This is a placeholder.
let waLogger = { info: () => {}, error: () => {}, warn: () => {}, child: () => ({ info: () => {}, error: () => {}, warn: () => {} }) }

async function connectWhatsApp() {
  // Guard: ensure Baileys modules are loaded
  if (typeof makeWASocket !== 'function' || typeof useMultiFileAuthState !== 'function') {
    console.error('[WA] Cannot connect: Baileys modules not loaded. WhatsApp will not work.')
    if (waNamespace) waNamespace.emit('whatsapp:status', { connected: false, reason: 'modules_not_loaded' })
    return
  }

  try {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER)
  const { version } = await fetchLatestBaileysVersion()

  waSocket = makeWASocket({
    version,
    logger: waLogger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, waLogger),
    },
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 30_000,
    keepAliveIntervalMs: 30_000, // increased from 25s for better stability
    markOnlineOnConnect: true,
    syncFullHistory: true, // Pull conversations from phone so user can create leads
    // Memory optimization: limit message history sync
    messageCaching: false,
  })

  // Save credentials on update
  waSocket.ev.on('creds.update', saveCreds)

  // Connection events
  waSocket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    connectionState = { connection, lastDisconnect }

    console.log(`[WA] Connection update: ${connection}`)

    if (qr) {
      console.log('[WA] QR Code generated, sending to clients')
      if (waNamespace) waNamespace.emit('whatsapp:qr', { qr })
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut

      console.log(`[WA] Connection closed. Status: ${statusCode}, Reconnect: ${shouldReconnect}`)

      if (waNamespace) waNamespace.emit('whatsapp:status', {
        connected: false,
        reason: statusCode === DisconnectReason.loggedOut ? 'logged_out' : 'disconnected',
      })

      if (shouldReconnect) {
        reconnectAttempts++
        // Exponential backoff: 2s, 4s, 8s, 16s, 30s, 30s, 30s...
        const delay = Math.min(2000 * Math.pow(2, Math.min(reconnectAttempts - 1, 4)), 30000)
        // Infinite reconnects (no max) — Render will restart the dyno if truly stuck
        console.log(`[WA] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`)
        setTimeout(() => connectWhatsApp(), delay)
      }
    }

    if (connection === 'open') {
      reconnectAttempts = 0
      console.log('[WA] Connected successfully!')
      if (waNamespace) waNamespace.emit('whatsapp:status', { connected: true })

      // Get profile picture for connected user
      try {
        const meId = waSocket?.user?.id
        if (meId) {
          const profilePicUrl = await waSocket.profilePictureUrl(meId, 'image')
          if (waNamespace) waNamespace.emit('whatsapp:me', {
            id: meId,
            name: waSocket?.user?.name,
            profilePicUrl,
          })
        }
      } catch { /* Profile pic might not be available */ }
    }
  })

  } catch (err) {
    console.error('[WA] connectWhatsApp error:', err.message)
    if (waNamespace) waNamespace.emit('whatsapp:status', { connected: false, reason: 'connection_error' })
    // Retry after delay
    reconnectAttempts++
    const delay = Math.min(5000 * reconnectAttempts, 60000)
    console.log(`[WA] Will retry connection in ${delay}ms`)
    setTimeout(() => connectWhatsApp(), delay)
    return
  }

  // ========== Contacts Sync ==========
  waSocket.ev.on('contacts.upsert', (contacts) => {
    console.log(`[WA] Contacts upsert: ${contacts.length} contacts`)
    for (const contact of contacts) {
      if (!contact.id) continue
      // Skip group contacts and broadcast
      if (contact.id.includes('@g.us') || contact.id === 'status@broadcast') continue
      const phone = extractPhone(contact.id)
      if (!phone) continue
      waContacts.set(contact.id, {
        jid: contact.id,
        name: contact.name || contact.notify || null,
        phone,
        notify: contact.notify || null,
      })
    }
    // Trim if too many
    if (waContacts.size > MAX_CONTACTS) {
      const entries = Array.from(waContacts.keys())
      const toRemove = entries.slice(0, entries.length - MAX_CONTACTS)
      toRemove.forEach(k => waContacts.delete(k))
    }
    // Emit to clients
    if (waNamespace) {
      const contactList = Array.from(waContacts.values())
      waNamespace.emit('whatsapp:contacts', contactList)
    }
  })

  waSocket.ev.on('contacts.update', (updates) => {
    for (const update of updates) {
      if (!update.id) continue
      const existing = waContacts.get(update.id)
      if (existing) {
        if (update.name) existing.name = update.name
        if (update.notify) existing.notify = update.notify
      }
    }
    if (waNamespace) {
      const contactList = Array.from(waContacts.values())
      waNamespace.emit('whatsapp:contacts', contactList)
    }
  })

  // ========== Chats/Conversations Sync ==========
  waSocket.ev.on('chats.upsert', (chats) => {
    console.log(`[WA] Chats upsert: ${chats.length} chats`)
    for (const chat of chats) {
      if (!chat.id) continue
      if (chat.id.includes('@g.us') || chat.id === 'status@broadcast') continue
      const conv = getOrCreateConversation(chat.id)
      if (chat.name) conv.name = chat.name
      conv.unreadCount = chat.unreadCount || 0
    }
    if (waNamespace) {
      const convList = Array.from(conversations.values()).map(serializeConversation)
      waNamespace.emit('whatsapp:conversations', convList)
    }
  })

  // Message events
  waSocket.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`[WA] Messages upsert: ${type}, count: ${messages.length}`)

    for (const msg of messages) {
      if (!msg.key) continue

      const jid = msg.key.remoteJid
      const fromMe = msg.key.fromMe || false
      const pushName = msg.pushName || null
      const msgKeyId = msg.key.id || ''

      // Skip status/broadcast messages
      if (jid === 'status@broadcast') continue

      // ========== DEDUPLICATION ==========
      // Skip our own echoed messages from Baileys (fromMe + append = echo)
      if (fromMe && type === 'append') {
        if (msgKeyId) processedMessageIds.add(msgKeyId)
        continue
      }

      // Check dedup set
      if (msgKeyId && processedMessageIds.has(msgKeyId)) {
        console.log(`[WA] Skipping duplicate message: ${msgKeyId}`)
        continue
      }
      if (msgKeyId) {
        processedMessageIds.add(msgKeyId)
        // Prevent memory leak
        if (processedMessageIds.size > MAX_DEDUP_IDS) {
          const entries = Array.from(processedMessageIds)
          const toRemove = entries.slice(0, entries.length - MAX_DEDUP_IDS / 2)
          toRemove.forEach(id => processedMessageIds.delete(id))
        }
      }

      // Get or create conversation
      const conv = getOrCreateConversation(jid, fromMe ? undefined : pushName)

      // Extract text content
      const textContent =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        msg.message?.documentMessage?.caption ||
        null

      // Determine media type
      let mediaType = null
      if (msg.message?.imageMessage) mediaType = 'image'
      else if (msg.message?.videoMessage) mediaType = 'video'
      else if (msg.message?.audioMessage) mediaType = 'audio'
      else if (msg.message?.documentMessage) mediaType = 'document'
      else if (msg.message?.stickerMessage) mediaType = 'sticker'
      else if (msg.message?.contactMessage) mediaType = 'contact'
      else if (msg.message?.locationMessage) mediaType = 'location'

      // Only process messages with content
      if (!textContent && !mediaType) continue

      const messageData = {
        id: msgKeyId || Math.random().toString(36).substr(2, 9),
        whatsappId: msgKeyId || null,
        fromMe,
        textContent,
        mediaType,
        timestamp: new Date((msg.messageTimestamp || Date.now() / 1000) * 1000),
        status: fromMe ? 'delivered' : 'received',
      }

      // Add to conversation
      conv.messages.push(messageData)
      if (conv.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
        conv.messages = conv.messages.slice(-MAX_MESSAGES_PER_CONVERSATION)
      }
      conv.lastMessage = textContent || `[${mediaType}]`
      conv.lastMessageAt = messageData.timestamp
      if (!fromMe) conv.unreadCount++

      // Try to get profile picture (lazy, only once)
      try {
        if (!conv.avatarUrl && waSocket) {
          const picUrl = await waSocket.profilePictureUrl(jid, 'image')
          conv.avatarUrl = picUrl
        }
      } catch { /* No profile pic */ }

      // Emit to connected clients
      if (waNamespace) {
        waNamespace.emit('whatsapp:message', {
          conversationJid: jid,
          message: messageData,
          conversation: serializeConversation(conv),
        })
        waNamespace.emit('whatsapp:conversation:update', serializeConversation(conv))
      }

      // ========== AUTO-SYNC TO ODOO (direct call, no bridge) ==========
      if (!fromMe) {
        const phone = extractPhone(jid)
        if (phone) {
          // Non-blocking: fire and forget, errors logged in autoSyncWhatsAppMessage
          autoSyncWhatsAppMessage({
            jid, phone,
            pushName: conv.pushName,
            textContent, mediaType, fromMe,
            timestamp: messageData.timestamp.toISOString(),
          }).catch(err => console.error('[AutoSync] Unhandled error:', err.message))

          // Also notify frontend about the sync
          if (waNamespace) {
            waNamespace.emit('whatsapp:odoo-sync', { jid, phone, syncing: true })
          }
        }
      }
    }
  })
}

// =============================================================================
// SECTION: Auto-Authenticate Odoo from Environment Variables
// =============================================================================

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

      if (odooNamespace) {
        odooNamespace.emit('odoo:status', {
          connected: true,
          url: odooConfig.url,
          db: odooConfig.db,
          username: odooConfig.username,
        })
      }
    } catch (error) {
      console.error(`[Odoo] Auto-authentication failed: ${error.message}`)
    }
  } else {
    console.log('[Odoo] No ODOO_URL/DB/USERNAME/PASSWORD env vars. Waiting for manual connection.')
  }
}

// =============================================================================
// SECTION: Socket.io /whatsapp Namespace Handlers
// =============================================================================

function setupWhatsAppNamespace(namespace) {
  namespace.on('connection', (socket) => {
    console.log(`[WA IO] Client connected: ${socket.id}`)

    // Send current status
    socket.emit('whatsapp:status', {
      connected: connectionState.connection === 'open',
    })

    // Send current conversations list
    const convList = Array.from(conversations.values()).map(serializeConversation)
    socket.emit('whatsapp:conversations', convList)

    // Send current contacts list
    const contactList = Array.from(waContacts.values())
    socket.emit('whatsapp:contacts', contactList)

    // Request QR code regeneration
    socket.on('whatsapp:request-qr', () => {
      reconnectAttempts = 0
      if (connectionState.connection !== 'open' && waSocket) {
        socket.emit('whatsapp:status', { connected: false, reason: 'connecting' })
      } else if (!waSocket) {
        connectWhatsApp()
      }
    })

    // Get conversation messages
    socket.on('whatsapp:get-messages', (data, callback) => {
      const conv = conversations.get(data.jid)
      callback?.(conv ? { messages: conv.messages.slice(-100) } : { messages: [] })
    })

    // Get conversation info
    socket.on('whatsapp:get-conversation-info', (data, callback) => {
      const conv = conversations.get(data.jid)
      callback?.(conv
        ? { success: true, conversation: serializeConversation(conv), messages: conv.messages.slice(-100) }
        : { success: false, conversation: null, messages: [] })
    })

    // Send a text message
    socket.on('whatsapp:send-message', async (data, callback) => {
      try {
        if (!waSocket || connectionState.connection !== 'open') {
          return callback?.({ success: false, error: 'WhatsApp not connected' })
        }

        const sent = await waSocket.sendMessage(data.jid, { text: data.text })
        const conv = getOrCreateConversation(data.jid)
        const msgKeyId = sent.key.id || ''
        const messageData = {
          id: msgKeyId || Math.random().toString(36).substr(2, 9),
          whatsappId: msgKeyId || null,
          fromMe: true,
          textContent: data.text,
          mediaType: null,
          timestamp: new Date(),
          status: 'sent',
        }

        // Mark as processed to prevent duplicate from Baileys echo
        if (msgKeyId) processedMessageIds.add(msgKeyId)

        conv.messages.push(messageData)
        if (conv.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
          conv.messages = conv.messages.slice(-MAX_MESSAGES_PER_CONVERSATION)
        }
        conv.lastMessage = data.text
        conv.lastMessageAt = messageData.timestamp

        if (waNamespace) {
          waNamespace.emit('whatsapp:message', {
            conversationJid: data.jid,
            message: messageData,
            conversation: serializeConversation(conv),
          })
          waNamespace.emit('whatsapp:conversation:update', serializeConversation(conv))
        }

        callback?.({ success: true, messageId: sent.key.id })
      } catch (error) {
        console.error('[WA] Send message error:', error.message)
        callback?.({ success: false, error: error.message })
      }
    })

    // Send media message
    socket.on('whatsapp:send-media', async (data, callback) => {
      try {
        if (!waSocket || connectionState.connection !== 'open') {
          return callback?.({ success: false, error: 'WhatsApp not connected' })
        }

        let sent
        if (data.type === 'image') {
          sent = await waSocket.sendMessage(data.jid, { image: { url: data.url }, caption: data.caption })
        } else if (data.type === 'document') {
          sent = await waSocket.sendMessage(data.jid, { document: { url: data.url }, fileName: data.fileName || 'document', mimetype: data.mimeType, caption: data.caption })
        } else if (data.type === 'video') {
          sent = await waSocket.sendMessage(data.jid, { video: { url: data.url }, caption: data.caption })
        } else if (data.type === 'audio') {
          sent = await waSocket.sendMessage(data.jid, { audio: { url: data.url }, mimetype: data.mimeType || 'audio/mp4' })
        } else {
          return callback?.({ success: false, error: 'Unsupported media type' })
        }

        const conv = getOrCreateConversation(data.jid)
        const msgKeyId = sent.key.id || ''
        const messageData = {
          id: msgKeyId || Math.random().toString(36).substr(2, 9),
          whatsappId: msgKeyId || null,
          fromMe: true,
          textContent: data.caption || null,
          mediaType: data.type,
          timestamp: new Date(),
          status: 'sent',
        }

        if (msgKeyId) processedMessageIds.add(msgKeyId)

        conv.messages.push(messageData)
        conv.lastMessage = data.caption || `[${data.type}]`
        conv.lastMessageAt = messageData.timestamp

        if (waNamespace) {
          waNamespace.emit('whatsapp:message', {
            conversationJid: data.jid,
            message: messageData,
            conversation: serializeConversation(conv),
          })
        }

        callback?.({ success: true, messageId: sent.key.id })
      } catch (error) {
        console.error('[WA] Send media error:', error.message)
        callback?.({ success: false, error: error.message })
      }
    })

    // Mark conversation as read
    socket.on('whatsapp:mark-read', async (data, callback) => {
      try {
        if (!waSocket || connectionState.connection !== 'open') {
          return callback?.({ success: false, error: 'WhatsApp not connected' })
        }
        const conv = conversations.get(data.jid)
        if (conv) {
          conv.unreadCount = 0
          if (waNamespace) waNamespace.emit('whatsapp:conversation:update', serializeConversation(conv))
        }
        await waSocket.readMessages([{ remoteJid: data.jid, id: '' }])
        callback?.({ success: true })
      } catch (error) {
        callback?.({ success: false, error: error.message })
      }
    })

    // Disconnect WhatsApp
    socket.on('whatsapp:disconnect', async (callback) => {
      try {
        if (waSocket) {
          await waSocket.logout('User requested disconnect')
          waSocket = null
          connectionState = { connection: 'close' }
          if (waNamespace) waNamespace.emit('whatsapp:status', { connected: false, reason: 'logged_out' })
          callback?.({ success: true })
        } else {
          callback?.({ success: false, error: 'Not connected' })
        }
      } catch (error) {
        callback?.({ success: false, error: error.message })
      }
    })

    // ========== Check if phone is on WhatsApp ==========
    socket.on('whatsapp:check-number', async (data, callback) => {
      try {
        if (!waSocket || connectionState.connection !== 'open') {
          return callback?.({ success: false, error: 'WhatsApp not connected' })
        }
        const phone = data.phone.replace(/[^0-9]/g, '')
        if (!phone) return callback?.({ success: false, error: 'Invalid phone number' })

        const [result] = await waSocket.onWhatsApp(`${phone}@s.whatsapp.net`)
        if (result && result.exists) {
          callback?.({ success: true, exists: true, jid: result.jid })
        } else {
          callback?.({ success: true, exists: false, jid: null })
        }
      } catch (error) {
        callback?.({ success: false, error: error.message })
      }
    })

    // ========== Start new conversation by phone ==========
    socket.on('whatsapp:start-conversation', async (data, callback) => {
      try {
        if (!waSocket || connectionState.connection !== 'open') {
          return callback?.({ success: false, error: 'WhatsApp not connected' })
        }
        const phone = data.phone.replace(/[^0-9]/g, '')
        if (!phone) return callback?.({ success: false, error: 'Invalid phone number' })

        const jid = data.jid || `${phone}@s.whatsapp.net`

        // Verify number is on WhatsApp (unless jid already provided)
        if (!data.jid) {
          try {
            const [result] = await waSocket.onWhatsApp(jid)
            if (!result || !result.exists) {
              return callback?.({ success: false, error: 'Este numero nao esta no WhatsApp' })
            }
          } catch (err) {
            console.error('[WA] onWhatsApp check error:', err.message)
            // Continue anyway - might still work
          }
        }

        // Create or get conversation
        const conv = getOrCreateConversation(jid, data.name || null)

        // Try to get profile picture
        try {
          if (!conv.avatarUrl && waSocket) {
            const picUrl = await waSocket.profilePictureUrl(jid, 'image')
            conv.avatarUrl = picUrl
          }
        } catch { /* No profile pic */ }

        const serialized = serializeConversation(conv)

        // Emit to all clients
        if (waNamespace) {
          waNamespace.emit('whatsapp:conversation:update', serialized)
        }

        callback?.({ success: true, conversation: serialized, jid })
      } catch (error) {
        console.error('[WA] Start conversation error:', error.message)
        callback?.({ success: false, error: error.message })
      }
    })

    // ========== Get WhatsApp contacts ==========
    socket.on('whatsapp:get-contacts', (data, callback) => {
      const contactList = Array.from(waContacts.values())
      if (callback) {
        callback?.({ success: true, data: contactList })
      }
    })

    // Get profile picture
    socket.on('whatsapp:get-profile-pic', async (data, callback) => {
      try {
        if (!waSocket || connectionState.connection !== 'open') {
          return callback?.({ success: false, url: null })
        }
        const url = await waSocket.profilePictureUrl(data.jid, 'image')
        const conv = conversations.get(data.jid)
        if (conv) conv.avatarUrl = url
        callback?.({ success: true, url })
      } catch {
        callback?.({ success: false, url: null })
      }
    })

    socket.on('disconnect', () => {
      // console.log(`[WA IO] Client disconnected: ${socket.id}`)
    })
  })
}

// =============================================================================
// SECTION: Socket.io /odoo Namespace Handlers
// =============================================================================

function setupOdooNamespace(namespace) {
  namespace.on('connection', (socket) => {
    console.log(`[Odoo IO] Client connected: ${socket.id}`)

    socket.emit('odoo:status', {
      connected: !!odooConfig.uid,
      url: odooConfig.url,
      db: odooConfig.db,
      username: odooConfig.username,
    })
    socket.emit('odoo:autosync:settings', autoSyncSettings)

    // ===== Authentication =====
    socket.on('odoo:authenticate', async (data, callback) => {
      try {
        odooConfig = { ...data, uid: null }
        modelFieldsCache.clear()
        phoneToPartnerCache.clear()
        const uid = await odooAuthenticate()
        odooConfig.uid = uid
        console.log(`[Odoo] Authenticated as ${data.username} (uid: ${uid})`)
        namespace.emit('odoo:status', {
          connected: true,
          url: odooConfig.url,
          db: odooConfig.db,
          username: odooConfig.username,
        })
        callback?.({ success: true, uid })
      } catch (error) {
        console.error('[Odoo] Auth error:', error.message)
        callback?.({ success: false, error: error.message })
      }
    })

    // ===== Disconnect =====
    socket.on('odoo:disconnect', (callback) => {
      odooConfig = { url: '', db: '', username: '', password: '', uid: null }
      modelFieldsCache.clear()
      phoneToPartnerCache.clear()
      namespace.emit('odoo:status', { connected: false })
      callback?.({ success: true })
    })

    // ===== Auto-Sync Settings =====
    socket.on('odoo:autosync:update-settings', async (data, callback) => {
      try {
        autoSyncSettings = { ...autoSyncSettings, ...data }
        console.log('[Odoo] Auto-sync settings updated')
        namespace.emit('odoo:autosync:settings', autoSyncSettings)
        callback?.({ success: true, settings: autoSyncSettings })
      } catch (error) {
        callback?.({ success: false, error: error.message })
      }
    })

    socket.on('odoo:autosync:get-settings', (callback) => {
      callback?.({ success: true, settings: autoSyncSettings })
    })

    // ===== Auto-Sync Trigger (called internally now, but kept for compatibility) =====
    socket.on('odoo:autosync:message', async (data, callback) => {
      try {
        const result = await autoSyncWhatsAppMessage(data)
        callback?.({ success: true, ...result })
      } catch (error) {
        callback?.({ success: false, error: error.message })
      }
    })

    // ===== Contacts =====
    socket.on('odoo:contacts:search', async (data, callback) => {
      try {
        const domain = data.query
          ? ['|', '|', ['name', 'ilike', data.query], ['phone', 'ilike', data.query], ['mobile', 'ilike', data.query]]
          : []
        const records = await odooSearch('res.partner', domain, [
          'name', 'phone', 'mobile', 'email', 'whatsapp', 'image_128',
          'is_company', 'country_id', 'state_id', 'city',
        ], data.limit || 20)
        callback?.({ success: true, data: records })
      } catch (error) {
        callback?.({ success: false, error: error.message })
      }
    })

    socket.on('odoo:contacts:create', async (data, callback) => {
      try {
        const values = { name: data.name }
        if (data.phone) values.phone = data.phone
        if (data.mobile) values.mobile = data.mobile
        if (data.whatsapp) values.whatsapp = data.whatsapp
        if (data.email) values.email = data.email
        const id = await odooCreate('res.partner', values)
        callback?.({ success: true, id })
        namespace.emit('odoo:record:created', { model: 'res.partner', id, values })
      } catch (error) {
        callback?.({ success: false, error: error.message })
      }
    })

    socket.on('odoo:contacts:search-or-create', async (data, callback) => {
      try {
        const domain = ['|', ['phone', 'ilike', data.phone], ['mobile', 'ilike', data.phone]]
        const values = { name: data.name || `WhatsApp ${data.phone}`, phone: data.phone, mobile: data.phone }
        const result = await odooSearchOrCreate('res.partner', domain, values)
        callback?.({ success: true, ...result })
      } catch (error) {
        callback?.({ success: false, error: error.message })
      }
    })

    // ===== CRM Leads =====
    socket.on('odoo:leads:search', async (data, callback) => {
      try {
        const domain = data.query
          ? ['|', ['name', 'ilike', data.query], ['partner_name', 'ilike', data.query]]
          : []
        const records = await odooSearch('crm.lead', domain, [
          'name', 'partner_id', 'partner_name', 'phone', 'mobile', 'email_from',
          'type', 'stage_id', 'probability', 'user_id', 'team_id',
          'create_date', 'write_date', 'whatsapp_number',
        ], data.limit || 20)
        callback?.({ success: true, data: records })
      } catch (error) {
        callback?.({ success: false, error: error.message })
      }
    })

    socket.on('odoo:leads:create', async (data, callback) => {
      try {
        const values = { name: data.name }

        // Check if 'type' field exists on crm.lead before setting it
        // Some Odoo SaaS instances may not have the 'type' field or it may not accept 'lead'
        const leadFields = await getAvailableFields('crm.lead')
        if (leadFields.has('type') && data.type) {
          values.type = data.type
        } else if (leadFields.has('type')) {
          values.type = 'lead'
        } else {
          console.log('[Odoo] Field "type" does not exist on crm.lead, skipping')
        }

        if (data.phone) values.phone = data.phone
        if (data.partner_id) values.partner_id = data.partner_id
        if (data.partner_name) values.partner_name = data.partner_name
        if (data.description) values.description = data.description
        if (data.whatsapp_number) values.whatsapp_number = data.whatsapp_number

        console.log(`[Odoo] Creating lead with values: ${JSON.stringify(Object.keys(values))}`)

        const id = await odooCreate('crm.lead', values)
        console.log(`[Odoo] Lead created successfully: crm.lead#${id}`)
        callback?.({ success: true, id })
        namespace.emit('odoo:record:created', { model: 'crm.lead', id, values })
      } catch (error) {
        console.error(`[Odoo] Lead creation failed: ${error.message}`)
        console.error(`[Odoo] Lead creation data: name=${data.name}, type=${data.type}, phone=${data.phone}`)
        callback?.({ success: false, error: `Erro ao criar lead: ${error.message}` })
      }
    })

    // ===== Sales =====
    socket.on('odoo:sales:search', async (data, callback) => {
      try {
        const domain = data.query
          ? ['|', ['name', 'ilike', data.query], ['partner_id', 'ilike', data.query]]
          : []
        const records = await odooSearch('sale.order', domain, [
          'name', 'partner_id', 'state', 'date_order', 'amount_total',
          'user_id', 'team_id', 'whatsapp_number',
        ], data.limit || 20)
        callback?.({ success: true, data: records })
      } catch (error) {
        callback?.({ success: false, error: error.message })
      }
    })

    socket.on('odoo:sales:create', async (data, callback) => {
      try {
        const values = { partner_id: data.partner_id }
        if (data.whatsapp_number) values.whatsapp_number = data.whatsapp_number
        const id = await odooCreate('sale.order', values)
        callback?.({ success: true, id })
        namespace.emit('odoo:record:created', { model: 'sale.order', id, values })
      } catch (error) {
        callback?.({ success: false, error: error.message })
      }
    })

    // ===== Projects =====
    socket.on('odoo:projects:search', async (data, callback) => {
      try {
        const domain = []
        if (data.query) domain.push('|', ['name', 'ilike', data.query], ['description', 'ilike', data.query])
        if (data.project_id) domain.push(['project_id', '=', data.project_id])
        const records = await odooSearch('project.task', domain, [
          'name', 'description', 'project_id', 'stage_id', 'user_ids',
          'partner_id', 'priority', 'create_date', 'date_deadline', 'whatsapp_number',
        ], data.limit || 20)
        callback?.({ success: true, data: records })
      } catch (error) {
        callback?.({ success: false, error: error.message })
      }
    })

    socket.on('odoo:projects:create', async (data, callback) => {
      try {
        const values = { name: data.name }
        if (data.project_id) values.project_id = data.project_id
        if (data.partner_id) values.partner_id = data.partner_id
        if (data.description) values.description = data.description
        if (data.whatsapp_number) values.whatsapp_number = data.whatsapp_number
        const id = await odooCreate('project.task', values)
        callback?.({ success: true, id })
        namespace.emit('odoo:record:created', { model: 'project.task', id, values })
      } catch (error) {
        callback?.({ success: false, error: error.message })
      }
    })

    socket.on('odoo:projects:list', async (data, callback) => {
      try {
        const records = await odooSearch('project.project', [], [
          'name', 'label_tasks', 'user_id', 'partner_id',
        ], data.limit || 50)
        callback?.({ success: true, data: records })
      } catch (error) {
        callback?.({ success: false, error: error.message })
      }
    })

    // ===== Link Conversation =====
    socket.on('odoo:link-conversation', async (data, callback) => {
      try {
        const phone = data.phone || data.jid.split('@')[0]
        await smartWriteWhatsAppNumber(data.model, [data.recordId], phone)
        try {
          await odooPostMessage(data.model, data.recordId,
            `<p><strong>[WhatsApp Middleware]</strong> Conversa vinculada — Número: ${phone}</p>`)
        } catch { /* Chatter might not be available */ }
        callback?.({ success: true })
        namespace.emit('odoo:conversation:linked', { jid: data.jid, model: data.model, recordId: data.recordId })
      } catch (error) {
        callback?.({ success: false, error: error.message })
      }
    })

    // ===== Search Records Across Multiple Models =====
    socket.on('odoo:search-records', async (data, callback) => {
      try {
        const { query, models, limit } = data
        const searchLimit = limit || 10
        const results = []

        const modelConfigs = {
          'res.partner': {
            domain: query ? ['|', '|', ['name', 'ilike', query], ['phone', 'ilike', query], ['mobile', 'ilike', query]] : [],
            fields: ['name', 'phone', 'mobile', 'email', 'whatsapp', 'is_company'],
            label: 'Contato',
          },
          'crm.lead': {
            domain: query ? ['|', ['name', 'ilike', query], ['partner_name', 'ilike', query]] : [],
            fields: ['name', 'partner_id', 'phone', 'type', 'stage_id', 'probability'],
            label: 'Lead',
          },
          'sale.order': {
            domain: query ? ['|', ['name', 'ilike', query], ['partner_id', 'ilike', query]] : [],
            fields: ['name', 'partner_id', 'state', 'date_order', 'amount_total'],
            label: 'Venda',
          },
          'project.task': {
            domain: query ? ['|', ['name', 'ilike', query], ['description', 'ilike', query]] : [],
            fields: ['name', 'project_id', 'stage_id', 'partner_id', 'priority'],
            label: 'Tarefa',
          },
        }

        const modelsToSearch = models && models.length > 0
          ? models.filter(m => modelConfigs[m])
          : Object.keys(modelConfigs)

        for (const model of modelsToSearch) {
          const config = modelConfigs[model]
          try {
            const records = await odooSearch(model, config.domain, config.fields, searchLimit)
            if (records && records.length > 0) {
              for (const record of records) {
                results.push({
                  model,
                  modelLabel: config.label,
                  recordId: record.id,
                  name: record.name || `#${record.id}`,
                  details: record,
                })
              }
            }
          } catch (err) {
            console.error(`[Odoo] Search error on ${model}:`, err.message)
          }
        }

        callback?.({ success: true, data: results })
      } catch (error) {
        callback?.({ success: false, error: error.message })
      }
    })

    // ===== Link and Post Conversation to Chatter =====
    socket.on('odoo:link-and-post-chatter', async (data, callback) => {
      try {
        const { jid, model, recordId, phone, messages, postToChatter } = data
        const phoneNum = phone || (jid ? jid.split('@')[0] : '')

        // Step 1: Link the conversation (write WhatsApp number to the record)
        try {
          await smartWriteWhatsAppNumber(model, [recordId], phoneNum)
        } catch (err) {
          console.error(`[Odoo] Failed to write WhatsApp number to ${model}#${recordId}:`, err.message)
        }

        // Step 2: Post link notification to chatter
        try {
          await odooPostMessage(model, recordId,
            `<p><strong>[WhatsApp Middleware]</strong> Conversa vinculada — Número: ${phoneNum}</p>`)
        } catch { /* Chatter might not be available */ }

        // Step 3: Post conversation messages to chatter if requested
        let messagesPosted = 0
        if (postToChatter && messages && messages.length > 0) {
          // Build a single consolidated message with the conversation history
          const lines = []
          lines.push(`<p><strong>📱 Histórico da Conversa WhatsApp</strong></p>`)
          lines.push(`<p><em>Número: ${phoneNum} | Mensagens: ${messages.length}</em></p>`)
          lines.push(`<hr/>`)

          for (const msg of messages) {
            const time = new Date(msg.timestamp).toLocaleString('pt-BR')
            const direction = msg.fromMe ? 'Enviada' : 'Recebida'
            const mediaLabel = msg.mediaType ? ` [${msg.mediaType}]` : ''
            const content = msg.textContent
              ? escapeHtml(msg.textContent)
              : `<em>[Mídia${mediaLabel}]</em>`
            const sender = msg.fromMe ? 'Você' : 'Contato'
            lines.push(`<p><strong>${time} — ${sender} (${direction}):</strong>${mediaLabel}<br/>${content}</p>`)
          }

          try {
            await odooPostMessage(model, recordId, lines.join(''))
            messagesPosted = messages.length
            console.log(`[Odoo] Posted ${messagesPosted} messages to ${model}#${recordId} chatter`)
          } catch (err) {
            console.error(`[Odoo] Failed to post conversation to ${model}#${recordId}:`, err.message)
          }
        }

        callback?.({ success: true, messagesPosted })
        namespace.emit('odoo:conversation:linked', { jid, model, recordId })
      } catch (error) {
        console.error(`[Odoo] link-and-post-chatter error:`, error.message)
        callback?.({ success: false, error: error.message })
      }
    })

    // ===== Log Message =====
    socket.on('odoo:log-message', async (data, callback) => {
      try {
        const body = data.fromWhatsApp
          ? `<p><strong>[WhatsApp]</strong> ${data.message}</p>`
          : data.message
        await odooPostMessage(data.model, data.recordId, body)
        callback?.({ success: true })
      } catch (error) {
        callback?.({ success: false, error: error.message })
      }
    })

    // ===== Get Model Fields =====
    socket.on('odoo:fields', async (data, callback) => {
      try {
        const fields = await odooGetFields(data.model)
        callback?.({ success: true, data: fields })
      } catch (error) {
        callback?.({ success: false, error: error.message })
      }
    })

    // ===== Check Custom Fields =====
    socket.on('odoo:check-fields', async (data, callback) => {
      try {
        const available = await getAvailableFields(data.model)
        const result = {}
        for (const field of data.fields) result[field] = available.has(field)
        callback?.({ success: true, data: result })
      } catch (error) {
        callback?.({ success: false, error: error.message })
      }
    })

    // ===== Generic CRUD =====
    socket.on('odoo:search', async (data, callback) => {
      try {
        const records = await odooSearch(data.model, data.domain, data.fields || [], data.limit || 20)
        callback?.({ success: true, data: records })
      } catch (error) {
        callback?.({ success: false, error: error.message })
      }
    })

    socket.on('odoo:read', async (data, callback) => {
      try {
        const records = await odooRead(data.model, data.ids, data.fields || [])
        callback?.({ success: true, data: records })
      } catch (error) {
        callback?.({ success: false, error: error.message })
      }
    })

    socket.on('odoo:write', async (data, callback) => {
      try {
        const result = await odooWrite(data.model, data.ids, data.values)
        callback?.({ success: true, data: result })
      } catch (error) {
        callback?.({ success: false, error: error.message })
      }
    })

    // ===== Teams & Users =====
    socket.on('odoo:teams:search', async (data, callback) => {
      try {
        const records = await odooSearch('crm.team', [], ['name', 'user_id'], data.limit || 20)
        callback?.({ success: true, data: records })
      } catch (error) {
        callback?.({ success: false, error: error.message })
      }
    })

    socket.on('odoo:users:search', async (data, callback) => {
      try {
        const records = await odooSearch('res.users', [], ['name', 'login', 'image_128'], data.limit || 20)
        callback?.({ success: true, data: records })
      } catch (error) {
        callback?.({ success: false, error: error.message })
      }
    })

    socket.on('disconnect', () => {
      // console.log(`[Odoo IO] Client disconnected: ${socket.id}`)
    })
  })
}

// =============================================================================
// SECTION: Memory Monitoring
// =============================================================================

function logMemoryUsage() {
  const used = process.memoryUsage()
  const mb = (bytes) => Math.round(bytes / 1024 / 1024)
  console.log(`[Memory] RSS: ${mb(used.rss)}MB | Heap: ${mb(used.heapUsed)}/${mb(used.heapTotal)}MB | External: ${mb(used.external)}MB`)
}

// =============================================================================
// SECTION: Main Startup
// =============================================================================

async function main() {
  console.log('============================================')
  console.log('  Whats-Odoo v4.0 — Single-Process Server')
  console.log('============================================')

  // 1. Load modules
  await loadModules()

  // pino module is now loaded — waLogger will be initialized in step 5 below

  // 2. Initialize Next.js
  console.log('[Server] Initializing Next.js...')
  const app = next({ dev, hostname, port })
  const handle = app.getRequestHandler()
  await app.prepare()
  console.log('[Server] Next.js ready')

  // 3. Create HTTP server
  const httpServer = createServer((req, res) => {
    const parsedUrl = parse(req.url, true)
    handle(req, res, parsedUrl)
  })

  // 4. Setup Socket.io
  io = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 60000,
    pingInterval: 25000,
  })

  waNamespace = io.of('/whatsapp')
  odooNamespace = io.of('/odoo')

  // Setup namespace handlers (direct, no bridge!)
  setupWhatsAppNamespace(waNamespace)
  setupOdooNamespace(odooNamespace)

  // 5. Initialize WhatsApp logger now that pino is loaded — MUST be before connectWhatsApp()
  try {
    waLogger = pino({ level: 'silent' })
    console.log('[Server] WhatsApp logger initialized (pino level=silent)')
  } catch (err) {
    console.error('[Server] Failed to create pino logger:', err.message)
    waLogger = { info: () => {}, error: () => {}, warn: () => {}, child: () => ({ info: () => {}, error: () => {}, warn: () => {} }) }
  }

  // 6. Initialize WhatsApp (non-blocking) — waLogger must already be set above
  console.log('[Server] Initializing WhatsApp... makeWASocket:', typeof makeWASocket, 'waLogger type:', typeof waLogger)
  if (typeof makeWASocket !== 'function') {
    console.error('[Server] CRITICAL: makeWASocket is not a function! WhatsApp will not work.')
    console.error('[Server] This usually means @whiskeysockets/baileys is not installed correctly.')
  } else {
    connectWhatsApp().catch(err => {
      console.error('[WA] Initial connection error:', err.message)
      // Retry after 10 seconds if initial connection fails
      setTimeout(() => {
        console.log('[WA] Retrying initial connection...')
        connectWhatsApp().catch(retryErr => console.error('[WA] Retry connection error:', retryErr.message))
      }, 10000)
    })
  }

  // 7. Auto-authenticate Odoo from env vars (non-blocking)
  autoAuthenticateFromEnv().catch(err => console.error('[Odoo] Auto-auth error:', err.message))

  // 8. Start HTTP server
  httpServer.listen(port, hostname, () => {
    console.log(`[Server] > Ready on http://${hostname}:${port}`)
    console.log('[Server] WhatsApp namespace: /whatsapp')
    console.log('[Server] Odoo namespace: /odoo')
    logMemoryUsage()
  })

  // Periodic memory monitoring (every 5 minutes)
  setInterval(() => {
    logMemoryUsage()
    // Force garbage collection if available (node --expose-gc)
    if (global.gc) {
      global.gc()
      console.log('[Memory] GC triggered')
    }
  }, 5 * 60 * 1000)
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received, shutting down...')
  if (waSocket) waSocket.end(undefined)
  process.exit(0)
})

process.on('SIGINT', () => {
  console.log('[Server] SIGINT received, shutting down...')
  if (waSocket) waSocket.end(undefined)
  process.exit(0)
})

// Prevent unhandled errors from crashing
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception:', err.message)
})

process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled rejection:', reason?.message || reason)
})

// Start!
main().catch(err => {
  console.error('[Server] Fatal error:', err)
  process.exit(1)
})
