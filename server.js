// ====================================================================
// Whats-Odoo v7.9 — SINGLE-PROCESS SERVER
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

let syncState = { isSyncing: false, progress: 0, totalChats: 0, totalContacts: 0, totalMessages: 0 }

function isValidPhoneJid(jid) {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return false
  const numPart = jid.split('@')[0]
  return /^\d{7,}$/.test(numPart)
}

function extractPhone(jid) {
  if (!isValidPhoneJid(jid)) return null
  return jid.split('@')[0]
}

function jidNormalizedUser(jid) {
  // Simplified — just return the jid as-is for our cache key
  return jid ? jid.split(':')[0] : jid
}

function getOrCreateConversation(jid, pushName) {
  if (!isValidPhoneJid(jid)) return null
  const cachedName = contactNames.get(jidNormalizedUser(jid)) || null

  if (!conversations.has(jid)) {
    conversations.set(jid, {
      jid,
      name: cachedName || pushName || null,
      phone: extractPhone(jid),
      pushName: pushName || null,
      avatarUrl: null,
      lastMessage: null,
      lastMessageAt: new Date(),
      unreadCount: 0,
      messages: [],
    })
  }
  const conv = conversations.get(jid)
  if (cachedName) {
    conv.name = cachedName
  } else if (pushName && !conv.name) {
    conv.pushName = pushName
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
  return Array.from(conversations.values())
    .filter(conv => isValidPhoneJid(conv.jid))
    .sort((a, b) => {
      const tA = a.lastMessageAt ? a.lastMessageAt.getTime() : 0
      const tB = b.lastMessageAt ? b.lastMessageAt.getTime() : 0
      return tB - tA
    })
    .map(serializeConversation)
    .filter(Boolean)
}

function updateConversationName(jid, contactName) {
  if (!isValidPhoneJid(jid)) return
  contactNames.set(jidNormalizedUser(jid), contactName)
  const conv = conversations.get(jid)
  if (conv) conv.name = contactName
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
    for (const [jid, contact] of Object.entries(contacts)) {
      if (isValidPhoneJid(jid) && contact?.name) {
        contactNames.set(jidNormalizedUser(jid), contact.name)
        validContactsCount++
      }
    }
    syncState.totalContacts = validContactsCount

    let chatsProcessed = 0
    for (const chat of chats) {
      if (!isValidPhoneJid(chat.id)) continue
      const contactName = contactNames.get(jidNormalizedUser(chat.id)) || null
      if (!conversations.has(chat.id)) {
        conversations.set(chat.id, {
          jid: chat.id, name: contactName, phone: extractPhone(chat.id),
          pushName: null, avatarUrl: null, lastMessage: null,
          lastMessageAt: null, unreadCount: chat.unreadCount || 0, messages: [],
        })
      } else {
        const conv = conversations.get(chat.id)
        if (contactName) conv.name = contactName
      }
      chatsProcessed++
    }
    syncState.totalChats = chatsProcessed

    let messagesProcessed = 0
    for (const msg of messages) {
      if (!msg.key) continue
      const jid = msg.key.remoteJid
      if (!isValidPhoneJid(jid)) continue

      const fromMe = msg.key.fromMe || false
      const textContent =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        msg.message?.documentMessage?.caption || null

      let mediaType = null
      if (msg.message?.imageMessage) mediaType = 'image'
      else if (msg.message?.videoMessage) mediaType = 'video'
      else if (msg.message?.audioMessage) mediaType = 'audio'
      else if (msg.message?.documentMessage) mediaType = 'document'
      else if (msg.message?.stickerMessage) mediaType = 'sticker'

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

  waSocket.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.key) continue
      const jid = msg.key.remoteJid
      const fromMe = msg.key.fromMe || false
      const pushName = msg.pushName || null

      if (jid === 'status@broadcast') continue
      if (!isValidPhoneJid(jid)) continue

      const conv = getOrCreateConversation(jid, fromMe ? undefined : pushName)
      if (!conv) continue

      const textContent =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        msg.message?.documentMessage?.caption || null

      let mediaType = null
      if (msg.message?.imageMessage) mediaType = 'image'
      else if (msg.message?.videoMessage) mediaType = 'video'
      else if (msg.message?.audioMessage) mediaType = 'audio'
      else if (msg.message?.documentMessage) mediaType = 'document'
      else if (msg.message?.stickerMessage) mediaType = 'sticker'

      if (!textContent && !mediaType) continue

      const msgId = msg.key.id
      if (msgId && conv.messages.some(m => m.whatsappId === msgId)) continue

      const messageTimestamp = new Date((msg.messageTimestamp) * 1000 || Date.now())
      const messageData = {
        id: msgId || Math.random().toString(36).substr(2, 9),
        whatsappId: msgId || null, fromMe, textContent, mediaType,
        timestamp: messageTimestamp, status: fromMe ? 'delivered' : 'received',
      }

      conv.messages.push(messageData)
      conv.lastMessage = textContent || `[${mediaType}]`
      conv.lastMessageAt = new Date()
      if (!fromMe) conv.unreadCount++

      try {
        if (!conv.avatarUrl) {
          const picUrl = await waSocket.profilePictureUrl(jid, 'image').catch(() => null)
          if (picUrl) conv.avatarUrl = picUrl
        }
      } catch {}

      io.of('/whatsapp').emit('whatsapp:message', {
        conversationJid: jid, message: messageData, conversation: serializeConversation(conv),
      })
      io.of('/whatsapp').emit('whatsapp:conversation:update', serializeConversation(conv))

      const phone = extractPhone(jid)
      if (phone) {
        try {
          const result = await autoSyncWhatsAppMessage({
            jid, phone, pushName: conv.pushName, textContent, mediaType, fromMe,
            timestamp: messageData.timestamp.toISOString(),
          })
          if (result.partnerId || result.leadId) {
            io.of('/whatsapp').emit('whatsapp:odoo-sync', {
              jid, phone, partnerId: result.partnerId, leadId: result.leadId,
              mailMessageId: result.mailMessageId, activityId: result.activityId,
              created: result.created, errors: result.errors,
            })
          }
        } catch (err) {
          console.error('[AutoSync] Error:', err.message)
        }
      }
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
      if (!isValidPhoneJid(chat.id)) continue
      if (!conversations.has(chat.id)) {
        const contactName = contactNames.get(jidNormalizedUser(chat.id)) || null
        conversations.set(chat.id, {
          jid: chat.id, name: contactName, phone: extractPhone(chat.id),
          pushName: null, avatarUrl: null, lastMessage: null,
          lastMessageAt: null, unreadCount: chat.unreadCount || 0, messages: [],
        })
      } else {
        const conv = conversations.get(chat.id)
        const contactName = contactNames.get(jidNormalizedUser(chat.id))
        if (contactName) conv.name = contactName
      }
    }
    io.of('/whatsapp').emit('whatsapp:conversations', getSortedConversations())
  })

  waSocket.ev.on('chats.update', async (updates) => {
    for (const update of updates) {
      if (!isValidPhoneJid(update.id)) continue
      const conv = conversations.get(update.id)
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
      const conv = conversations.get(data.jid)
      callback({ messages: conv ? conv.messages.slice(-100) : [] })
    })

    socket.on('whatsapp:send-message', async (data, callback) => {
      try {
        if (!waSocket || connectionState.connection !== 'open') {
          callback({ success: false, error: 'WhatsApp not connected' })
          return
        }
        if (!isValidPhoneJid(data.jid)) {
          callback({ success: false, error: 'Invalid contact JID' })
          return
        }

        const sent = await waSocket.sendMessage(data.jid, { text: data.text })
        const conv = getOrCreateConversation(data.jid)
        if (!conv) { callback({ success: false, error: 'Could not create conversation' }); return }

        const messageData = {
          id: sent.key.id || Math.random().toString(36).substr(2, 9),
          whatsappId: sent.key.id || null, fromMe: true, textContent: data.text,
          mediaType: null, timestamp: new Date(), status: 'sent',
        }

        conv.messages.push(messageData)
        conv.lastMessage = data.text
        conv.lastMessageAt = new Date()

        io.of('/whatsapp').emit('whatsapp:message', { conversationJid: data.jid, message: messageData, conversation: serializeConversation(conv) })

        const phone = extractPhone(data.jid)
        if (phone) {
          try {
            await autoSyncWhatsAppMessage({ jid: data.jid, phone, pushName: conv.pushName, textContent: data.text, mediaType: null, fromMe: true, timestamp: messageData.timestamp.toISOString() })
          } catch (err) {
            console.error('[AutoSync] Send error:', err.message)
          }
        }
        callback({ success: true, messageId: sent.key.id })
      } catch (error) {
        callback({ success: false, error: error.message })
      }
    })

    socket.on('whatsapp:send-media', async (data, callback) => {
      try {
        if (!waSocket || connectionState.connection !== 'open') { callback({ success: false, error: 'WhatsApp not connected' }); return }
        if (!isValidPhoneJid(data.jid)) { callback({ success: false, error: 'Invalid contact JID' }); return }

        let sent
        if (data.type === 'image') sent = await waSocket.sendMessage(data.jid, { image: { url: data.url }, caption: data.caption })
        else if (data.type === 'document') sent = await waSocket.sendMessage(data.jid, { document: { url: data.url }, fileName: data.fileName || 'document', mimetype: data.mimeType, caption: data.caption })
        else if (data.type === 'video') sent = await waSocket.sendMessage(data.jid, { video: { url: data.url }, caption: data.caption })
        else if (data.type === 'audio') sent = await waSocket.sendMessage(data.jid, { audio: { url: data.url }, mimetype: data.mimeType || 'audio/mp4' })
        else { callback({ success: false, error: 'Unsupported media type' }); return }

        const conv = getOrCreateConversation(data.jid)
        if (!conv) { callback({ success: false, error: 'Could not create conversation' }); return }

        const messageData = {
          id: sent.key.id || Math.random().toString(36).substr(2, 9),
          whatsappId: sent.key.id || null, fromMe: true, textContent: data.caption || null,
          mediaType: data.type, timestamp: new Date(), status: 'sent',
        }

        conv.messages.push(messageData)
        conv.lastMessage = data.caption || `[${data.type}]`
        conv.lastMessageAt = new Date()

        io.of('/whatsapp').emit('whatsapp:message', { conversationJid: data.jid, message: messageData, conversation: serializeConversation(conv) })
        callback({ success: true, messageId: sent.key.id })
      } catch (error) {
        callback({ success: false, error: error.message })
      }
    })

    socket.on('whatsapp:mark-read', async (data, callback) => {
      try {
        if (!waSocket || connectionState.connection !== 'open') { callback({ success: false, error: 'WhatsApp not connected' }); return }
        const conv = conversations.get(data.jid)
        if (conv) { conv.unreadCount = 0; io.of('/whatsapp').emit('whatsapp:conversation:update', serializeConversation(conv)) }
        await waSocket.readMessages([{ remoteJid: data.jid, id: '' }])
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
        const url = await waSocket.profilePictureUrl(data.jid, 'image').catch(() => null)
        const conv = conversations.get(data.jid)
        if (conv && url) conv.avatarUrl = url
        callback({ success: true, url })
      } catch { callback({ success: false, url: null }) }
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
