// =============================================================================
// Whats-Odoo v6.0 — Single-Process Server
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

// v6.0: Raw Baileys message cache for downloadMediaMessage()
// Key = msg.key.id, Value = raw Baileys message object
const rawMessageCache = new Map()
const MAX_RAW_MESSAGES = 200

function storeRawMessage(msg) {
  if (!msg?.key?.id) return
  rawMessageCache.set(msg.key.id, msg)
  // Evict oldest entries if cache is too large
  if (rawMessageCache.size > MAX_RAW_MESSAGES) {
    const keys = Array.from(rawMessageCache.keys())
    const toRemove = keys.slice(0, keys.length - MAX_RAW_MESSAGES)
    toRemove.forEach(k => rawMessageCache.delete(k))
  }
}

// LID → Phone mapping: WhatsApp uses @lid JIDs for privacy (no phone digits).
// We maintain a map so we can resolve @lid → phone → @s.whatsapp.net
const lidToPhoneMap = new Map() // "12345@lid" -> "5511999999999"

// Register a LID↔Phone mapping from any source (contacts, messages, onWhatsApp)
function registerLidMapping(lid, phone) {
  if (!lid || !phone) return
  const normalizedLid = lid.replace(/:(\d+)@/, '@') // strip device suffix
  if (!lidToPhoneMap.has(normalizedLid)) {
    console.log(`[LID] Registered mapping: ${normalizedLid} -> ${phone}`)
    lidToPhoneMap.set(normalizedLid, phone)
  }
}

// Baileys modules (loaded async)
let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore, Browsers, Boom, pino, jidNormalizedUser, downloadMediaMessage

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
    // jidNormalizedUser: Baileys' official JID normalizer — strips device suffixes (:XX)
    // and converts @c.us → @s.whatsapp.net. This is what Baileys uses internally
    // in cleanMessage() before emitting messages.upsert.
    jidNormalizedUser = baileys.jidNormalizedUser
    // v6.0: downloadMediaMessage for proper media download with auth
    downloadMediaMessage = baileys.downloadMediaMessage
    console.log('[Server] Baileys loaded OK — makeWASocket:', typeof makeWASocket, 'Browsers:', typeof Browsers, 'jidNormalizedUser:', typeof jidNormalizedUser, 'downloadMediaMessage:', typeof downloadMediaMessage)
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

// Extract phone number from JID — handles both @s.whatsapp.net and @lid JIDs
// Baileys can use @lid JIDs (WhatsApp privacy feature) which have NO phone digits.
// For @lid JIDs, we return null and rely on the lidToPhoneMap for resolution.
function extractPhone(jid) {
  if (!jid) return null
  // Strip device suffix first (:XX@ → @)
  const cleaned = jid.replace(/:(\d+)@/, '@')
  // For @s.whatsapp.net JIDs, extract the phone digits before @
  const match = cleaned.match(/^(\d+)@/)
  if (match) return match[1]
  // For @lid JIDs (e.g. "12345@lid"), try to resolve from our map
  if (cleaned.includes('@lid')) {
    const resolved = lidToPhoneMap.get(cleaned)
    if (resolved) return resolved
  }
  return null
}

// Normalize JID: canonical form for conversation lookup.
// STRATEGY:
// 1. Use Baileys' jidNormalizedUser() — this is the OFFICIAL normalizer that Baileys
//    uses internally in cleanMessage() before emitting messages.upsert. It strips
//    device suffixes (:XX) and agent suffixes (_N), and converts @c.us → @s.whatsapp.net.
//    IMPORTANT: Baileys already normalizes key.remoteJid before we receive it in
//    messages.upsert. So the JID we get should already be device-suffix-free.
// 2. CRITICAL: Resolve @lid JIDs to their @s.whatsapp.net equivalent.
//    WhatsApp is migrating to LID-first addressing. A contact can appear as
//    both "5511999999999@s.whatsapp.net" AND "12345@lid" — these are the SAME person.
//    Without this resolution, we get duplicate conversations.
function normalizeJid(jid) {
  if (!jid) return jid
  // Step 1: Use Baileys' official normalizer (strips :XX, _N, converts @c.us)
  let normalized
  try {
    normalized = typeof jidNormalizedUser === 'function' ? jidNormalizedUser(jid) : jid
  } catch {
    // Fallback: manual strip
    normalized = jid.replace(/:(\d+)@/, '@').replace(/@c\.us$/, '@s.whatsapp.net')
  }
  // Step 2: Resolve @lid to @s.whatsapp.net if we have the mapping
  if (normalized.includes('@lid')) {
    const lidNorm = normalized.replace(/:(\d+)@/, '@') // strip device suffix from LID too
    const phone = lidToPhoneMap.get(lidNorm)
    if (phone) {
      normalized = `${phone}@s.whatsapp.net`
    }
  }
  return normalized
}

// Extract real phone number from JID, always returns digits or null
function extractRealPhone(jid) {
  return extractPhone(jid)
}

// Find existing conversation by phone number (used for dedup when JIDs don't match)
function findConversationByPhone(phone) {
  if (!phone) return null
  for (const [, conv] of conversations) {
    if (conv.phone === phone) return conv
  }
  return null
}

// Merge duplicate conversations: if a conversation with the same phone
// but different JID exists, merge them into one.
function mergeDuplicateConversations(normalizedJid, phone) {
  if (!phone) return
  const existing = findConversationByPhone(phone)
  if (existing && existing.jid !== normalizedJid) {
    console.log(`[Dedup] Merging conversation ${existing.jid} into ${normalizedJid} (same phone: ${phone})`)
    // Move messages and data to the new (normalized) JID
    const target = conversations.get(normalizedJid)
    if (target && existing) {
      // Merge messages (keep the ones with more data)
      const allMessages = [...existing.messages, ...target.messages]
      // Deduplicate by message ID
      const seen = new Set()
      target.messages = allMessages.filter(m => {
        if (seen.has(m.id)) return false
        seen.add(m.id)
        return true
      })
      // Keep the better name
      if (!target.name && existing.name) target.name = existing.name
      if (!target.pushName && existing.pushName) target.pushName = existing.pushName
      if (!target.avatarUrl && existing.avatarUrl) target.avatarUrl = existing.avatarUrl
      // Sum unread counts
      target.unreadCount = Math.max(target.unreadCount, existing.unreadCount)
      // Keep the latest lastMessageAt
      if (existing.lastMessageAt && (!target.lastMessageAt || existing.lastMessageAt > target.lastMessageAt)) {
        target.lastMessage = existing.lastMessage
        target.lastMessageAt = existing.lastMessageAt
      }
      // Remove the duplicate
      conversations.delete(existing.jid)
    }
  }
}

function getOrCreateConversation(jid, pushName) {
  const normalizedJid = normalizeJid(jid)
  const phone = extractPhone(normalizedJid)
  
  // Before creating, check if a conversation with the same phone already exists
  // under a different JID (edge case for dedup)
  if (!conversations.has(normalizedJid) && phone) {
    const existingByPhone = findConversationByPhone(phone)
    if (existingByPhone) {
      // A conversation with this phone exists under a different JID
      // Move it to the normalized JID
      console.log(`[Dedup] Rekeying conversation ${existingByPhone.jid} -> ${normalizedJid}`)
      conversations.delete(existingByPhone.jid)
      existingByPhone.jid = normalizedJid
      existingByPhone.phone = phone
      conversations.set(normalizedJid, existingByPhone)
      if (pushName && !existingByPhone.pushName) {
        existingByPhone.pushName = pushName
      }
      return existingByPhone
    }
  }
  
  if (!conversations.has(normalizedJid)) {
    conversations.set(normalizedJid, {
      jid: normalizedJid,
      name: null,
      phone: phone,
      pushName: pushName || null,
      avatarUrl: null,
      lastMessage: null,
      lastMessageAt: null,
      unreadCount: 0,
      messages: [],
    })
  }
  const conv = conversations.get(normalizedJid)
  if (pushName && !conv.pushName) {
    conv.pushName = pushName
  }
  return conv
}

function serializeConversation(conv) {
  // Look up contact name from waContacts by phone number
  let contactName = conv.pushName || conv.name || null
  if (!contactName && conv.phone) {
    const waContact = Array.from(waContacts.values()).find(c => c.phone === conv.phone)
    if (waContact?.name) contactName = waContact.name
  }
  return {
    jid: conv.jid,
    name: conv.name,
    phone: conv.phone,
    pushName: conv.pushName,
    contactName,
    avatarUrl: conv.avatarUrl,
    lastMessage: conv.lastMessage,
    lastMessageAt: conv.lastMessageAt?.toISOString() || null,
    unreadCount: conv.unreadCount,
    messageCount: conv.messages.length,
  }
}

// Run full dedup pass on conversations Map: remove any entries where
// the phone number is the same as another entry.  Keeps the entry with
// the most recent lastMessageAt.  Returns the deduplicated list.
function deduplicateConversations() {
  const phoneMap = new Map() // phone -> best conversation
  const toDelete = []

  for (const [jid, conv] of conversations) {
    if (!conv.phone) continue
    const existing = phoneMap.get(conv.phone)
    if (!existing) {
      phoneMap.set(conv.phone, { jid, conv })
    } else {
      // Keep the one with more recent activity or more messages
      const existingTime = existing.conv.lastMessageAt ? new Date(existing.conv.lastMessageAt).getTime() : 0
      const currentTime = conv.lastMessageAt ? new Date(conv.lastMessageAt).getTime() : 0
      if (currentTime > existingTime || conv.messages.length > existing.conv.messages.length) {
        // New one is better — merge messages into it and mark old for deletion
        const allMsgs = [...existing.conv.messages, ...conv.messages]
        const seen = new Set()
        conv.messages = allMsgs.filter(m => {
          if (seen.has(m.id)) return false
          seen.add(m.id)
          return true
        })
        if (!conv.name && existing.conv.name) conv.name = existing.conv.name
        if (!conv.pushName && existing.conv.pushName) conv.pushName = existing.conv.pushName
        if (!conv.avatarUrl && existing.conv.avatarUrl) conv.avatarUrl = existing.conv.avatarUrl
        conv.unreadCount = Math.max(conv.unreadCount, existing.conv.unreadCount)
        toDelete.push(existing.jid)
        phoneMap.set(conv.phone, { jid, conv })
      } else {
        // Existing is better — merge new into existing and mark new for deletion
        const allMsgs = [...conv.messages, ...existing.conv.messages]
        const seen = new Set()
        existing.conv.messages = allMsgs.filter(m => {
          if (seen.has(m.id)) return false
          seen.add(m.id)
          return true
        })
        if (!existing.conv.name && conv.name) existing.conv.name = conv.name
        if (!existing.conv.pushName && conv.pushName) existing.conv.pushName = conv.pushName
        if (!existing.conv.avatarUrl && conv.avatarUrl) existing.conv.avatarUrl = conv.avatarUrl
        existing.conv.unreadCount = Math.max(existing.conv.unreadCount, conv.unreadCount)
        // Rekey existing to normalized JID if needed
        if (existing.jid !== jid) {
          toDelete.push(jid)
        }
      }
    }
  }

  for (const jid of toDelete) {
    console.log(`[Dedup] Removing duplicate conversation: ${jid}`)
    conversations.delete(jid)
  }
}

// Emit deduplicated conversations to a single socket
function emitDedupedConversationsToSocket(socket) {
  deduplicateConversations()
  // v4.7: Sort by lastMessageAt descending and filter out @lid
  const convList = Array.from(conversations.values())
    .filter(c => !c.jid.includes('@lid'))
    .sort((a, b) => {
      const tA = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
      const tB = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
      return tB - tA
    })
    .map(serializeConversation)
  socket.emit('whatsapp:conversations', convList)
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

// Build a safe Odoo search domain that only uses fields that exist on the model.
// Prevents "Invalid field" errors on Odoo SaaS instances that lack certain fields (e.g. mobile on res.partner).
// Input: model name + array of OR-conditions like [['phone','ilike','x'], ['mobile','ilike','x']]
// Output: safe domain with only existing fields, or [['name','!=','/']] if none match
async function buildSafeDomain(model, conditions) {
  const available = await getAvailableFields(model)
  const safeConditions = conditions.filter(cond => {
    if (!Array.isArray(cond) || cond.length < 1) return false
    const fieldName = cond[0]
    return available.has(fieldName)
  })
  if (safeConditions.length === 0) {
    // Fallback: search by name (always exists)
    return [['name', '!=', '/']]
  }
  if (safeConditions.length === 1) {
    return safeConditions
  }
  // Wrap multiple conditions with '|' (OR operator)
  const result = []
  for (let i = 0; i < safeConditions.length - 1; i++) {
    result.push('|')
  }
  result.push(...safeConditions)
  return result
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
      const waContact = Array.from(waContacts.values()).find(c => c.phone === data.phone)
      const contactName = data.pushName || waContact?.name || `WhatsApp ${data.phone}`
      const domain = await buildSafeDomain('res.partner', [['phone', 'ilike', data.phone], ['mobile', 'ilike', data.phone]])
      const contactValues = { name: contactName, phone: data.phone }
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
    syncFullHistory: false, // v6.0: Disabled to prevent pulling year-old backup messages
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

      // After connection, give Baileys a moment to sync chats, then emit what we have
      // This ensures the frontend gets conversations even if chats.upsert already fired before client connected
      // Emit at 5s for quick feedback, and again at 15s for full history sync
      const emitConversationsToClients = () => {
        deduplicateConversations()
        // v6.0: Filter conversations to only show those with activity in the last 90 days
        const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
        if (waNamespace && conversations.size > 0) {
          console.log(`[WA] Emitting ${conversations.size} existing conversations to clients`)
          // v4.7: Sort by lastMessageAt descending and filter out @lid
          const convList = Array.from(conversations.values())
            .filter(c => !c.jid.includes('@lid'))
            .filter(c => {
              // v6.0: Only show conversations with activity in last 90 days
              if (!c.lastMessageAt) return true // Keep conversations without timestamps
              return c.lastMessageAt >= ninetyDaysAgo
            })
            .sort((a, b) => {
              const tA = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
              const tB = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
              return tB - tA
            })
            .map(serializeConversation)
          waNamespace.emit('whatsapp:conversations', convList)
        }
        if (waNamespace && waContacts.size > 0) {
          console.log(`[WA] Emitting ${waContacts.size} existing contacts to clients`)
          // v4.7: Filter out @lid contacts when emitting
          const contactList = Array.from(waContacts.values()).filter(c => !c.jid.includes('@lid'))
          waNamespace.emit('whatsapp:contacts', contactList)
        }
      }
      setTimeout(emitConversationsToClients, 5000) // 5 second delay for initial sync
      setTimeout(emitConversationsToClients, 15000) // 15 second delay for full history

      // v6.0: After connection opens, fetch recent messages for active conversations
      // Since syncFullHistory is now false, Baileys will still receive chats.upsert
      // and contacts.upsert events which give us the conversation list and metadata.
      // We then use fetchMessageHistory on-demand when a user selects a conversation.
      // However, we can pre-fetch messages for the most recent conversations.
      setTimeout(async () => {
        try {
          if (waSocket && typeof waSocket.fetchMessageHistory === 'function' && conversations.size > 0) {
            // Fetch recent messages for the top 10 most recent conversations
            const recentConvs = Array.from(conversations.values())
              .sort((a, b) => {
                const tA = a.lastMessageAt ? a.lastMessageAt.getTime() : 0
                const tB = b.lastMessageAt ? b.lastMessageAt.getTime() : 0
                return tB - tA
              })
              .slice(0, 10)

            for (const conv of recentConvs) {
              try {
                const timestamp = conv.lastMessageAt
                  ? Math.floor(conv.lastMessageAt.getTime() / 1000)
                  : Math.floor(Date.now() / 1000)
                await waSocket.fetchMessageHistory(20, { remoteJid: conv.jid }, timestamp)
                console.log(`[WA] Pre-fetched messages for ${conv.jid}`)
              } catch (fetchErr) {
                console.log(`[WA] Pre-fetch failed for ${conv.jid}: ${fetchErr.message}`)
              }
              // Small delay between fetches to avoid rate limiting
              await new Promise(r => setTimeout(r, 500))
            }
            // Re-emit after pre-fetch
            emitConversationsToClients()
          }
        } catch (err) {
          console.log('[WA] Pre-fetch error:', err.message)
        }
      }, 8000) // Wait 8s for initial chats/contacts sync to complete
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

      // Register LID mappings if this contact has both lid and phone-based JID
      if (contact.id.includes('@lid')) {
        const lidNorm = contact.id.replace(/:(\d+)@/, '@')
        const phoneFromOther = Array.from(waContacts.values()).find(c =>
          c.name === (contact.name || contact.notify) && c.phone && !c.jid.includes('@lid')
        )
        if (phoneFromOther) {
          registerLidMapping(lidNorm, phoneFromOther.phone)
        }
      }

      const normalizedId = normalizeJid(contact.id)
      // v4.7: Skip contacts where normalizedId still has @lid (can't resolve to real phone)
      if (normalizedId.includes('@lid')) continue
      const phone = extractPhone(normalizedId)
      if (!phone) continue

      // v4.7: Dedup by phone number — if a contact with same phone exists, update name only
      const existingByPhone = Array.from(waContacts.values()).find(c => c.phone === phone)
      if (existingByPhone) {
        // Update name if the new one is better
        const newName = contact.name || contact.notify || null
        if (newName && (!existingByPhone.name || existingByPhone.name.length < newName.length)) {
          existingByPhone.name = newName
        }
        if (contact.notify && !existingByPhone.notify) existingByPhone.notify = contact.notify
        continue // Don't add duplicate
      }

      waContacts.set(normalizedId, {
        jid: normalizedId,
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
    // Enrich conversation names from newly synced contacts
    for (const [, conv] of conversations) {
      if (!conv.name && !conv.pushName && conv.phone) {
        const waContact = Array.from(waContacts.values()).find(c => c.phone === conv.phone)
        if (waContact?.name) conv.pushName = waContact.name
      }
    }
    // Emit to clients — filter out any remaining @lid entries
    if (waNamespace) {
      const contactList = Array.from(waContacts.values()).filter(c => !c.jid.includes('@lid'))
      waNamespace.emit('whatsapp:contacts', contactList)
    }
  })

  waSocket.ev.on('contacts.update', (updates) => {
    for (const update of updates) {
      if (!update.id) continue
      const normalizedId = normalizeJid(update.id)
      // v4.7: Skip @lid contacts that couldn't be resolved
      if (normalizedId.includes('@lid')) continue
      const existing = waContacts.get(normalizedId)
      if (existing) {
        if (update.name) existing.name = update.name
        if (update.notify) existing.notify = update.notify
      }
    }
    if (waNamespace) {
      const contactList = Array.from(waContacts.values()).filter(c => !c.jid.includes('@lid'))
      waNamespace.emit('whatsapp:contacts', contactList)
    }
  })

  // ========== Chats/Conversations Sync ==========
  // Deduplicate and emit conversations helper (uses the global deduplicateConversations)
  function emitDedupedConversations() {
    if (!waNamespace) return
    deduplicateConversations()
    // v4.7: Sort by lastMessageAt descending (most recent first) and filter out @lid
    const convList = Array.from(conversations.values())
      .filter(c => !c.jid.includes('@lid'))
      .sort((a, b) => {
        const tA = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
        const tB = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
        return tB - tA
      })
      .map(serializeConversation)
    waNamespace.emit('whatsapp:conversations', convList)
  }

  waSocket.ev.on('chats.upsert', (chats) => {
    console.log(`[WA] Chats upsert: ${chats.length} chats`)
    for (const chat of chats) {
      if (!chat.id) continue
      if (chat.id.includes('@g.us') || chat.id === 'status@broadcast') continue
      const conv = getOrCreateConversation(chat.id)
      if (chat.name) conv.name = chat.name
      conv.unreadCount = chat.unreadCount || 0
      // v4.7: Use conversationTimestamp for lastMessageAt
      if (chat.conversationTimestamp) {
        const ts = new Date(chat.conversationTimestamp * 1000)
        if (!conv.lastMessageAt || ts > conv.lastMessageAt) {
          conv.lastMessageAt = ts
        }
      }
    }
    emitDedupedConversations()
  })

  // =====================================================================
  // CRITICAL FIX v5.1: messaging-history.set — the CORRECT Baileys event
  // for history sync. The old events `chats.set` and `messages.set` do NOT
  // exist in @whiskeysockets/baileys! They were from the old Baileys v4 API.
  // This is why conversations from the phone were NEVER syncing.
  //
  // Baileys fires `messaging-history.set` when the phone sends history sync
  // notifications. The event includes { chats, contacts, messages, isLatest,
  // progress, syncType }. We MUST listen to this to get phone conversations.
  // =====================================================================
  waSocket.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest, progress, syncType }) => {
    console.log(`[WA] messaging-history.set: ${chats?.length || 0} chats, ${contacts?.length || 0} contacts, ${messages?.length || 0} messages, isLatest: ${isLatest}, progress: ${progress}, syncType: ${syncType}`)

    // Process chats from history sync
    if (chats && chats.length > 0) {
      for (const chat of chats) {
        if (!chat.id) continue
        if (chat.id.includes('@g.us') || chat.id === 'status@broadcast') continue
        const conv = getOrCreateConversation(chat.id)
        if (chat.name) conv.name = chat.name
        conv.unreadCount = chat.unreadCount || 0
        // Set conversation timestamp from chat
        if (chat.conversationTimestamp) {
          const ts = new Date(chat.conversationTimestamp * 1000)
          if (!conv.lastMessageAt || ts > conv.lastMessageAt) {
            conv.lastMessageAt = ts
          }
        }
      }
    }

    // Process contacts from history sync
    if (contacts && contacts.length > 0) {
      for (const contact of contacts) {
        if (!contact.id) continue
        if (contact.id.includes('@g.us') || contact.id === 'status@broadcast') continue

        // Register LID mappings
        if (contact.id.includes('@lid')) {
          const lidNorm = contact.id.replace(/:(\d+)@/, '@')
          const phoneFromOther = Array.from(waContacts.values()).find(c =>
            c.name === (contact.name || contact.notify) && c.phone && !c.jid.includes('@lid')
          )
          if (phoneFromOther) {
            registerLidMapping(lidNorm, phoneFromOther.phone)
          }
        }

        const normalizedId = normalizeJid(contact.id)
        // v4.7: Skip contacts where normalizedId still has @lid (can't resolve to real phone)
        if (normalizedId.includes('@lid')) continue
        const phone = extractPhone(normalizedId)
        if (!phone) continue

        // v4.7: Dedup by phone number — if a contact with same phone exists, update name only
        const existingByPhone = Array.from(waContacts.values()).find(c => c.phone === phone)
        if (existingByPhone) {
          const newName = contact.name || contact.notify || null
          if (newName && (!existingByPhone.name || existingByPhone.name.length < newName.length)) {
            existingByPhone.name = newName
          }
          if (contact.notify && !existingByPhone.notify) existingByPhone.notify = contact.notify
          continue
        }

        waContacts.set(normalizedId, {
          jid: normalizedId,
          name: contact.name || contact.notify || null,
          phone,
          notify: contact.notify || null,
        })
      }

      // Enrich conversation names from contacts
      for (const [, conv] of conversations) {
        if (!conv.name && !conv.pushName && conv.phone) {
          const waContact = Array.from(waContacts.values()).find(c => c.phone === conv.phone)
          if (waContact?.name) conv.pushName = waContact.name
        }
      }
    }

    // Process messages from history sync
    if (messages && messages.length > 0) {
      for (const msg of messages) {
        if (!msg.key) continue
        const jid = normalizeJid(msg.key.remoteJid)
        if (jid === 'status@broadcast' || jid.includes('@g.us')) continue

        // v6.0: Skip messages older than 90 days to avoid pulling year-old backup data
        const msgTimestamp = msg.messageTimestamp || 0
        if (msgTimestamp > 0) {
          const msgDate = new Date(msgTimestamp * 1000)
          const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
          if (msgDate < ninetyDaysAgo) continue
        }

        const fromMe = msg.key.fromMe || false
        const pushName = msg.pushName || null
        const msgKeyId = msg.key.id || ''

        // v6.0: Store raw message for downloadMediaMessage()
        storeRawMessage(msg)

        // Skip duplicates
        if (msgKeyId && processedMessageIds.has(msgKeyId)) continue
        if (msgKeyId) processedMessageIds.add(msgKeyId)

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

        // Extract media URL
        let mediaUrl = null
        if (msg.message?.imageMessage?.url) mediaUrl = msg.message.imageMessage.url
        else if (msg.message?.videoMessage?.url) mediaUrl = msg.message.videoMessage.url
        else if (msg.message?.audioMessage?.url) mediaUrl = msg.message.audioMessage.url
        else if (msg.message?.documentMessage?.url) mediaUrl = msg.message.documentMessage.url
        else if (msg.message?.stickerMessage?.url) mediaUrl = msg.message.stickerMessage.url

        // Only process messages with content
        if (!textContent && !mediaType) continue

        const messageData = {
          id: msgKeyId || Math.random().toString(36).substr(2, 9),
          whatsappId: msgKeyId || null,
          fromMe,
          textContent,
          mediaType,
          mediaUrl,
          timestamp: new Date((msg.messageTimestamp || Date.now() / 1000) * 1000),
          status: fromMe ? 'delivered' : 'received',
        }

        // Add to conversation (avoid duplicates)
        if (!conv.messages.some(m => m.id === messageData.id)) {
          conv.messages.push(messageData)
        }
        if (conv.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
          conv.messages = conv.messages.slice(-MAX_MESSAGES_PER_CONVERSATION)
        }
        // Update last message if this one is newer
        if (!conv.lastMessageAt || messageData.timestamp > conv.lastMessageAt) {
          conv.lastMessage = textContent || `[${mediaType}]`
          conv.lastMessageAt = messageData.timestamp
        }
      }
    }

    // Emit updated conversations after history sync
    emitDedupedConversations()

    // Emit contacts
    if (waNamespace && waContacts.size > 0) {
      const contactList = Array.from(waContacts.values())
      waNamespace.emit('whatsapp:contacts', contactList)
    }

    // Emit sync progress to frontend
    if (waNamespace) {
      waNamespace.emit('whatsapp:history-sync-progress', { progress, isLatest, syncType })
      console.log(`[WA] History sync progress: ${progress}%, isLatest: ${isLatest}, conversations: ${conversations.size}`)
    }

    // v5.1: Emit whatsapp:sync-complete when sync is done
    if (isLatest || (progress !== null && progress !== undefined && progress >= 100)) {
      console.log(`[WA] Sync complete! conversations: ${conversations.size}, contacts: ${waContacts.size}`)
      if (waNamespace) {
        waNamespace.emit('whatsapp:sync-complete', { conversations: conversations.size, contacts: waContacts.size })
      }
    }

    // v5.1: Auto-fetch recent messages for stale conversations after sync completes
    if (isLatest && waSocket && typeof waSocket.fetchMessageHistory === 'function') {
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
      const staleConvs = Array.from(conversations.values())
        .filter(c => c.lastMessageAt && c.lastMessageAt.getTime() < sevenDaysAgo && c.messages.length > 0)
        .sort((a, b) => {
          const tA = a.lastMessageAt ? a.lastMessageAt.getTime() : 0
          const tB = b.lastMessageAt ? b.lastMessageAt.getTime() : 0
          return tB - tA // most recent first
        })
        .slice(0, 20)

      if (staleConvs.length > 0) {
        console.log(`[WA] Auto-fetching recent messages for ${staleConvs.length} stale conversations`)
        staleConvs.forEach((conv, idx) => {
          setTimeout(() => {
            try {
              const lastMsg = conv.messages[conv.messages.length - 1]
              const key = lastMsg?.whatsappId
                ? { remoteJid: conv.jid, id: lastMsg.whatsappId, fromMe: lastMsg.fromMe }
                : { remoteJid: conv.jid }
              const timestamp = conv.lastMessageAt
                ? Math.floor(conv.lastMessageAt.getTime() / 1000)
                : Math.floor(Date.now() / 1000)
              waSocket.fetchMessageHistory(50, key, timestamp)
              console.log(`[WA] Auto-fetch: ${conv.jid} (stale)`)
            } catch (err) {
              console.log(`[WA] Auto-fetch failed for ${conv.jid}: ${err.message}`)
            }
          }, idx * 100) // 100ms delay between each
        })
      }
    }
  })

  // chats.update — fired when chat properties change (name, unread, etc)
  waSocket.ev.on('chats.update', (updates) => {
    for (const update of updates) {
      if (!update.id) continue
      const normalizedId = normalizeJid(update.id)
      const conv = conversations.get(normalizedId)
      if (conv) {
        if (update.name) conv.name = update.name
        if (update.unreadCount !== undefined) conv.unreadCount = update.unreadCount
      }
    }
    emitDedupedConversations()
  })

  // NOTE: The old `messages.set` event does NOT exist in @whiskeysockets/baileys.
  // All historical messages from phone sync arrive via `messaging-history.set` above.
  // Real-time messages arrive via `messages.upsert` below.

  // Message events
  waSocket.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`[WA] Messages upsert: ${type}, count: ${messages.length}`)

    for (const msg of messages) {
      if (!msg.key) continue

      // ========== LID MAPPING REGISTRATION ==========
      // Messages carry both senderPn (phone@s.whatsapp.net) and senderLid (@lid)
      // This is the BEST source for LID→Phone mappings.
      // CRITICAL: We register ALL available LID→Phone mappings BEFORE normalizing
      // the remoteJid, because normalizeJid() needs these mappings to resolve
      // @lid JIDs to @s.whatsapp.net JIDs.
      if (msg.key.senderPn && msg.key.senderLid) {
        const phoneFromPn = msg.key.senderPn.split('@')[0].split(':')[0]
        registerLidMapping(msg.key.senderLid, phoneFromPn)
      }
      // Also check participant fields for group messages
      if (msg.key.participantPn && msg.key.participantLid) {
        const phoneFromPn = msg.key.participantPn.split('@')[0].split(':')[0]
        registerLidMapping(msg.key.participantLid, phoneFromPn)
      }

      // If remoteJid is a @lid, also try to register from senderPn
      if (msg.key.remoteJid && msg.key.remoteJid.includes('@lid')) {
        if (msg.key.senderPn) {
          const phoneFromPn = msg.key.senderPn.split('@')[0].split(':')[0]
          registerLidMapping(msg.key.remoteJid, phoneFromPn)
        }
        // ALSO try to resolve from participantPn for group messages where sender is participant
        if (msg.key.participantPn) {
          const phoneFromPn = msg.key.participantPn.split('@')[0].split(':')[0]
          registerLidMapping(msg.key.remoteJid, phoneFromPn)
        }
      }

      // ========== JID RESOLUTION ==========
      // Baileys' cleanMessage() already normalizes remoteJid using jidNormalizedUser()
      // before emitting this event. So device suffixes (:XX) should already be stripped.
      // However, @lid JIDs need our custom resolution.
      let jid = normalizeJid(msg.key.remoteJid)
      const fromMe = msg.key.fromMe || false
      const pushName = msg.pushName || null
      const msgKeyId = msg.key.id || ''

      // Skip status/broadcast messages
      if (jid === 'status@broadcast') continue
      // Skip group messages (we only handle 1:1 chats)
      if (jid.includes('@g.us')) continue

      // ========== DEDUPLICATION ==========
      // Skip our own echoed messages from Baileys send handler (fromMe + append = echo)
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

      // ========== PHONE EXTRACTION (FALLBACK) ==========
      // If jid still contains @lid (mapping not available), try to extract phone
      // from any available source in the message key before creating conversation.
      let phoneFromMsg = extractPhone(jid)
      if (!phoneFromMsg && msg.key.senderPn) {
        phoneFromMsg = msg.key.senderPn.split('@')[0].split(':')[0]
        // We have the phone from senderPn! Register the LID mapping NOW and re-resolve
        if (jid.includes('@lid')) {
          registerLidMapping(jid, phoneFromMsg)
          jid = normalizeJid(msg.key.remoteJid) // re-resolve with new mapping
          console.log(`[WA] Late LID resolution: ${msg.key.remoteJid} -> ${jid} (phone: ${phoneFromMsg})`)
        }
      }
      if (!phoneFromMsg && msg.key.participantPn) {
        phoneFromMsg = msg.key.participantPn.split('@')[0].split(':')[0]
        if (jid.includes('@lid')) {
          registerLidMapping(jid, phoneFromMsg)
          jid = normalizeJid(msg.key.remoteJid)
        }
      }

      // v6.0: Store raw message for downloadMediaMessage()
      storeRawMessage(msg)

      // ========== CONVERSATION LOOKUP ==========
      // Get or create conversation — handles dedup by phone number
      const conv = getOrCreateConversation(jid, fromMe ? undefined : pushName)
      const resolvedPhone = conv.phone || extractPhone(jid)
      console.log(`[WA] Message for ${jid} -> conv ${conv.jid} (phone: ${resolvedPhone}) fromMe: ${fromMe} type: ${type} pushName: ${pushName}`)

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

      // Extract media URL
      let mediaUrl = null
      if (msg.message?.imageMessage?.url) mediaUrl = msg.message.imageMessage.url
      else if (msg.message?.videoMessage?.url) mediaUrl = msg.message.videoMessage.url
      else if (msg.message?.audioMessage?.url) mediaUrl = msg.message.audioMessage.url
      else if (msg.message?.documentMessage?.url) mediaUrl = msg.message.documentMessage.url
      else if (msg.message?.stickerMessage?.url) mediaUrl = msg.message.stickerMessage.url

      // Only process messages with content
      if (!textContent && !mediaType) continue

      const messageData = {
        id: msgKeyId || Math.random().toString(36).substr(2, 9),
        whatsappId: msgKeyId || null,
        fromMe,
        textContent,
        mediaType,
        mediaUrl,
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

    // Send current conversations list (deduplicated by phone)
    emitDedupedConversationsToSocket(socket)

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
    // v6.0: Auto-fetch messages on-demand if conversation is empty or stale
    socket.on('whatsapp:get-messages', async (data, callback) => {
      const nj = normalizeJid(data.jid)
      const conv = conversations.get(nj)
      const msgs = conv ? conv.messages.slice(-100) : []

      // v6.0: If no messages or last message is older than 1 hour, auto-fetch
      if (conv && waSocket && connectionState.connection === 'open') {
        const shouldAutoFetch = msgs.length === 0 || (() => {
          const lastMsg = msgs[msgs.length - 1]
          if (!lastMsg?.timestamp) return true
          const hoursSince = (Date.now() - new Date(lastMsg.timestamp).getTime()) / (1000 * 60 * 60)
          return hoursSince > 1
        })()

        if (shouldAutoFetch && typeof waSocket.fetchMessageHistory === 'function') {
          try {
            const key = msgs.length > 0 && msgs[msgs.length - 1]?.whatsappId
              ? { remoteJid: nj, id: msgs[msgs.length - 1].whatsappId, fromMe: msgs[msgs.length - 1].fromMe }
              : { remoteJid: nj }
            const timestamp = conv.lastMessageAt
              ? Math.floor(new Date(conv.lastMessageAt).getTime() / 1000)
              : Math.floor(Date.now() / 1000)
            console.log(`[WA] Auto-fetching messages for ${nj} (stale/empty)`)
            await waSocket.fetchMessageHistory(50, key, timestamp)
            // Schedule re-emit of conversations after 3 seconds so frontend gets updated
            setTimeout(() => {
              const updatedConv = conversations.get(nj)
              if (updatedConv) {
                if (waNamespace) {
                  waNamespace.emit('whatsapp:conversation:update', serializeConversation(updatedConv))
                }
              }
            }, 3000)
          } catch (err) {
            console.log(`[WA] Auto-fetch failed for ${nj}: ${err.message}`)
          }
        }
      }

      callback?.({ messages: msgs })
    })

    // v6.0: Explicitly load messages for a conversation using fetchMessageHistory
    socket.on('whatsapp:load-messages', async (data, callback) => {
      try {
        if (!waSocket || connectionState.connection !== 'open') {
          return callback?.({ success: false, error: 'WhatsApp not connected' })
        }

        const nj = normalizeJid(data.jid)
        if (!nj) return callback?.({ success: false, error: 'Invalid JID' })

        if (typeof waSocket.fetchMessageHistory !== 'function') {
          return callback?.({ success: false, error: 'fetchMessageHistory not available' })
        }

        const conv = conversations.get(nj)
        let key, timestamp

        if (conv && conv.messages.length > 0) {
          const lastMsg = conv.messages[conv.messages.length - 1]
          key = lastMsg?.whatsappId
            ? { remoteJid: nj, id: lastMsg.whatsappId, fromMe: lastMsg.fromMe }
            : { remoteJid: nj }
          timestamp = conv.lastMessageAt
            ? Math.floor(new Date(conv.lastMessageAt).getTime() / 1000)
            : Math.floor(Date.now() / 1000)
        } else {
          key = { remoteJid: nj }
          timestamp = Math.floor(Date.now() / 1000)
        }

        console.log(`[WA] Loading messages for ${nj}`)
        const fetchResult = await waSocket.fetchMessageHistory(50, key, timestamp)
        console.log(`[WA] fetchMessageHistory result for ${nj}:`, fetchResult)

        // Schedule re-emit of conversations after 3 seconds
        setTimeout(() => {
          const updatedConv = conversations.get(nj)
          if (updatedConv && waNamespace) {
            waNamespace.emit('whatsapp:conversation:update', serializeConversation(updatedConv))
          }
        }, 3000)

        callback?.({ success: true, fetchStarted: true })
      } catch (error) {
        console.error('[WA] Load messages error:', error.message)
        callback?.({ success: false, error: error.message })
      }
    })

    // Get conversation info
    socket.on('whatsapp:get-conversation-info', (data, callback) => {
      const conv = conversations.get(normalizeJid(data.jid))
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

        const normalizedJid = normalizeJid(data.jid)
        const sent = await waSocket.sendMessage(normalizedJid, { text: data.text })
        const conv = getOrCreateConversation(normalizedJid)
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
            conversationJid: normalizedJid,
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

        const normalizedJid = normalizeJid(data.jid)
        let sent
        if (data.type === 'image') {
          sent = await waSocket.sendMessage(normalizedJid, { image: { url: data.url }, caption: data.caption })
        } else if (data.type === 'document') {
          sent = await waSocket.sendMessage(normalizedJid, { document: { url: data.url }, fileName: data.fileName || 'document', mimetype: data.mimeType, caption: data.caption })
        } else if (data.type === 'video') {
          sent = await waSocket.sendMessage(normalizedJid, { video: { url: data.url }, caption: data.caption })
        } else if (data.type === 'audio') {
          sent = await waSocket.sendMessage(normalizedJid, { audio: { url: data.url }, mimetype: data.mimeType || 'audio/mp4' })
        } else {
          return callback?.({ success: false, error: 'Unsupported media type' })
        }

        const conv = getOrCreateConversation(normalizedJid)
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
            conversationJid: normalizedJid,
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
        const normalizedJid = normalizeJid(data.jid)
        const conv = conversations.get(normalizedJid)
        if (conv) {
          conv.unreadCount = 0
          if (waNamespace) waNamespace.emit('whatsapp:conversation:update', serializeConversation(conv))
        }
        await waSocket.readMessages([{ remoteJid: normalizedJid, id: '' }])
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
          // Register LID mapping if available
          if (result.lid) registerLidMapping(result.lid, phone)
          callback?.({ success: true, exists: true, jid: result.jid })
        } else {
          callback?.({ success: true, exists: false, jid: null })
        }
      } catch (error) {
        callback?.({ success: false, error: error.message })
      }
    })

    // ========== Start new conversation by phone or JID ==========
    socket.on('whatsapp:start-conversation', async (data, callback) => {
      try {
        if (!waSocket || connectionState.connection !== 'open') {
          return callback?.({ success: false, error: 'WhatsApp not connected' })
        }
        
        let jid = null
        
        // If JID is provided directly (from contacts list), use it
        if (data.jid) {
          jid = normalizeJid(data.jid)
        } else {
          // Otherwise construct from phone number
          const phone = data.phone?.replace(/[^0-9]/g, '') || ''
          if (!phone) return callback?.({ success: false, error: 'Invalid phone number' })
          jid = `${phone}@s.whatsapp.net`
          
          // Verify number is on WhatsApp
          try {
            const [result] = await waSocket.onWhatsApp(jid)
            if (!result || !result.exists) {
              return callback?.({ success: false, error: 'Este numero nao esta no WhatsApp' })
            }
            // Register LID mapping if available
            if (result.lid) registerLidMapping(result.lid, phone)
            // Use the JID returned by WhatsApp (might have device info)
            if (result.jid) {
              jid = normalizeJid(result.jid)
            }
          } catch (err) {
            console.error('[WA] onWhatsApp check error:', err.message)
            // Continue anyway - might still work
          }
        }

        // Check if conversation already exists (by normalized JID or by phone)
        const phone = extractPhone(jid)
        let conv = conversations.get(jid)
        
        // If not found by JID, try to find by phone number (dedup)
        if (!conv && phone) {
          conv = findConversationByPhone(phone)
          if (conv) {
            console.log(`[WA] Found existing conversation by phone: ${conv.jid} for new JID: ${jid}`)
            // Rekey to the new normalized JID if needed
            if (conv.jid !== jid) {
              conversations.delete(conv.jid)
              conv.jid = jid
              conversations.set(jid, conv)
            }
          }
        }
        
        if (!conv) {
          conv = getOrCreateConversation(jid, data.name || null)
        } else if (data.name && !conv.pushName) {
          conv.pushName = data.name
        }

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

        callback?.({ success: true, conversation: serialized, jid: conv.jid })
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

    // ========== Refresh conversations (force re-emit) ==========
    socket.on('whatsapp:refresh-conversations', (data, callback) => {
      const convList = Array.from(conversations.values()).map(serializeConversation)
      const contactList = Array.from(waContacts.values())
      socket.emit('whatsapp:conversations', convList)
      socket.emit('whatsapp:contacts', contactList)
      callback?.({ success: true, conversations: convList.length, contacts: contactList.length })
    })

    // ========== Sync phone conversations ==========
    socket.on('whatsapp:sync-phone-conversations', async (data, callback) => {
      try {
        if (!waSocket || connectionState.connection !== 'open') {
          return callback?.({ success: false, error: 'WhatsApp not connected' })
        }

        console.log('[WA] Manual sync: requesting history from phone...')
        deduplicateConversations()

        // Emit current state immediately
        const convList = Array.from(conversations.values()).map(serializeConversation)
        if (waNamespace) waNamespace.emit('whatsapp:conversations', convList)

        // Use Baileys' fetchMessageHistory to request on-demand history from phone
        // This sends a PeerDataOperationRequest to the phone, which responds via
        // messaging-history.set event (handled above).
        let fetchResult = null
        try {
          // Get the oldest conversation to use as starting point for history fetch
          const oldestConv = Array.from(conversations.values())
            .filter(c => c.messages.length > 0)
            .sort((a, b) => {
              const tA = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : Infinity
              const tB = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : Infinity
              return tA - tB // oldest first
            })[0]

          if (oldestConv && oldestConv.messages.length > 0 && waSocket.fetchMessageHistory) {
            const oldestMsg = oldestConv.messages[0]
            console.log(`[WA] Fetching message history from phone, starting at conv ${oldestConv.jid}...`)
            fetchResult = await waSocket.fetchMessageHistory(
              50, // number of messages to fetch
              { remoteJid: oldestConv.jid, id: oldestMsg.whatsappId || oldestMsg.id, fromMe: oldestMsg.fromMe },
              oldestConv.lastMessageAt ? Math.floor(oldestConv.lastMessageAt.getTime() / 1000) : Math.floor(Date.now() / 1000)
            )
            console.log('[WA] fetchMessageHistory result:', fetchResult)
          }
        } catch (fetchErr) {
          console.log('[WA] fetchMessageHistory not available or failed:', fetchErr.message)
        }

        // Schedule emits after delays for any late-arriving history
        const emitAfterDelay = (delay) => {
          setTimeout(() => {
            deduplicateConversations()
            if (waNamespace) {
              const updatedList = Array.from(conversations.values()).map(serializeConversation)
              waNamespace.emit('whatsapp:conversations', updatedList)
              console.log(`[WA] Post-sync emit: ${updatedList.length} conversations`)
            }
          }, delay)
        }
        emitAfterDelay(3000)
        emitAfterDelay(8000)
        emitAfterDelay(15000)

        callback?.({ success: true, conversations: convList.length, message: 'Sincronizando conversas do telefone...', fetchStarted: !!fetchResult })
      } catch (error) {
        callback?.({ success: false, error: error.message })
      }
    })

    // ========== Merge duplicate conversations ==========
    socket.on('whatsapp:merge-duplicates', (data, callback) => {
      try {
        const beforeCount = conversations.size
        deduplicateConversations()
        const afterCount = conversations.size
        const merged = beforeCount - afterCount

        // Emit the deduplicated list
        if (waNamespace) {
          const convList = Array.from(conversations.values()).map(serializeConversation)
          waNamespace.emit('whatsapp:conversations', convList)
        }

        console.log(`[WA] Merge duplicates: ${beforeCount} -> ${afterCount} conversations (${merged} merged)`)
        callback?.({ success: true, before: beforeCount, after: afterCount, merged, message: merged > 0 ? `${merged} conversas mescladas` : 'Nenhuma duplicata encontrada' })
      } catch (error) {
        callback?.({ success: false, error: error.message })
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

    // ========== Fetch recent messages for a conversation ==========
    socket.on('whatsapp:fetch-recent-messages', async (data, callback) => {
      try {
        if (!waSocket || connectionState.connection !== 'open') {
          return callback?.({ success: false, error: 'WhatsApp not connected' })
        }

        const jid = normalizeJid(data.jid)
        const count = data.count || 50

        if (!jid) {
          return callback?.({ success: false, error: 'Invalid JID' })
        }

        // Try to get the last message as a reference point
        const conv = conversations.get(jid)
        let key
        let timestamp

        if (conv && conv.messages.length > 0) {
          const lastMsg = conv.messages[conv.messages.length - 1]
          key = lastMsg?.whatsappId
            ? { remoteJid: jid, id: lastMsg.whatsappId, fromMe: lastMsg.fromMe }
            : { remoteJid: jid }
          timestamp = conv.lastMessageAt
            ? Math.floor(conv.lastMessageAt.getTime() / 1000)
            : Math.floor(Date.now() / 1000)
        } else {
          // No messages yet, use bare JID with current timestamp
          key = { remoteJid: jid }
          timestamp = Math.floor(Date.now() / 1000)
        }

        if (typeof waSocket.fetchMessageHistory !== 'function') {
          return callback?.({ success: false, error: 'fetchMessageHistory not available' })
        }

        console.log(`[WA] Fetching recent messages for ${jid}, count: ${count}`)
        const fetchResult = await waSocket.fetchMessageHistory(count, key, timestamp)
        console.log(`[WA] fetchMessageHistory result for ${jid}:`, fetchResult)

        callback?.({ success: true, fetchStarted: true })
      } catch (error) {
        console.error('[WA] Fetch recent messages error:', error.message)
        callback?.({ success: false, error: error.message })
      }
    })

    // ========== Reset WhatsApp session ==========
    socket.on('whatsapp:reset-session', async (data, callback) => {
      try {
        console.log('[WA] Resetting WhatsApp session...')

        // Close current socket
        if (waSocket) {
          try {
            waSocket.end(undefined)
          } catch { /* ignore */ }
          waSocket = null
        }

        // Delete auth store contents
        try {
          const { rmSync, readdirSync } = require('fs')
          const files = readdirSync(AUTH_FOLDER)
          for (const file of files) {
            try {
              rmSync(require('path').join(AUTH_FOLDER, file), { recursive: true, force: true })
            } catch { /* ignore individual file errors */ }
          }
          console.log('[WA] Auth store cleared')
        } catch (err) {
          console.log('[WA] Could not clear auth store:', err.message)
        }

        // Reset in-memory state
        conversations.clear()
        waContacts.clear()
        processedMessageIds.clear()
        lidToPhoneMap.clear()
        connectionState = { connection: 'close' }
        reconnectAttempts = 0

        // Notify clients
        if (waNamespace) {
          waNamespace.emit('whatsapp:status', { connected: false, reason: 'session_reset' })
          waNamespace.emit('whatsapp:conversations', [])
          waNamespace.emit('whatsapp:contacts', [])
        }

        // Create fresh session
        connectWhatsApp()

        callback?.({ success: true })
      } catch (error) {
        console.error('[WA] Reset session error:', error.message)
        callback?.({ success: false, error: error.message })
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
        let domain
        if (data.query) {
          domain = await buildSafeDomain('res.partner', [['name', 'ilike', data.query], ['phone', 'ilike', data.query], ['mobile', 'ilike', data.query]])
        } else {
          domain = []
        }
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
        const domain = await buildSafeDomain('res.partner', [['phone', 'ilike', data.phone], ['mobile', 'ilike', data.phone]])
        const values = { name: data.name || `WhatsApp ${data.phone}`, phone: data.phone }
        const partnerFields = await getAvailableFields('res.partner')
        if (partnerFields.has('mobile')) values.mobile = data.phone
        if (partnerFields.has('whatsapp')) values.whatsapp = data.phone
        if (partnerFields.has('whatsapp_number')) values.whatsapp_number = data.phone
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
        // Build values — only set fields that exist on the model
        const leadFields = await getAvailableFields('crm.lead')
        const values = { name: data.name }

        if (leadFields.has('type')) {
          values.type = data.type || 'lead'
        }

        if (data.phone && leadFields.has('phone')) values.phone = data.phone
        if (data.partner_id && leadFields.has('partner_id')) values.partner_id = Number(data.partner_id)
        if (data.partner_name && leadFields.has('partner_name')) values.partner_name = data.partner_name
        if (data.description && leadFields.has('description')) values.description = data.description
        if (data.whatsapp_number && leadFields.has('whatsapp_number')) values.whatsapp_number = data.whatsapp_number

        console.log(`[Odoo] Creating lead: name="${values.name}", type="${values.type}", partner_id=${values.partner_id}, phone=${values.phone}`)

        const id = await odooCreate('crm.lead', values)
        console.log(`[Odoo] Lead created successfully: crm.lead#${id}`)
        callback?.({ success: true, id })
        namespace.emit('odoo:record:created', { model: 'crm.lead', id, values })
      } catch (error) {
        console.error(`[Odoo] Lead creation FAILED: ${error.message}`)
        console.error(`[Odoo] Full error:`, error)
        console.error(`[Odoo] Data received:`, JSON.stringify(data))
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
            domain: query ? await buildSafeDomain('res.partner', [['name', 'ilike', query], ['phone', 'ilike', query], ['mobile', 'ilike', query]]) : [],
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
  console.log('  Whats-Odoo v6.0 — Single-Process Server')
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
  const httpServer = createServer(async (req, res) => {
    // v6.0: Media download endpoint — uses Baileys downloadMediaMessage() for proper auth
    if (req.url?.startsWith('/api/media-download')) {
      const params = new URL(req.url, 'http://localhost').searchParams
      const msgId = params.get('msgId')
      const jid = params.get('jid')

      if (!msgId || !jid) {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end('Missing msgId or jid param')
        return
      }

      try {
        // Find raw message in cache
        const rawMsg = rawMessageCache.get(msgId)

        if (!rawMsg) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('Message not found in cache. Try refreshing messages.')
          return
        }

        if (typeof downloadMediaMessage !== 'function') {
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end('downloadMediaMessage not available')
          return
        }

        // Download media using Baileys' authenticated download
        const mediaBuffer = await downloadMediaMessage(rawMsg, 'buffer', { logger: waLogger })

        if (!mediaBuffer) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('Media download returned empty')
          return
        }

        // Ensure it's a proper Buffer
        const buf = Buffer.isBuffer(mediaBuffer) ? mediaBuffer : Buffer.from(mediaBuffer)

        // Extract mimetype from the raw message
        let mimetype = 'application/octet-stream'
        if (rawMsg.message?.imageMessage?.mimetype) mimetype = rawMsg.message.imageMessage.mimetype
        else if (rawMsg.message?.videoMessage?.mimetype) mimetype = rawMsg.message.videoMessage.mimetype
        else if (rawMsg.message?.audioMessage?.mimetype) mimetype = rawMsg.message.audioMessage.mimetype
        else if (rawMsg.message?.documentMessage?.mimetype) mimetype = rawMsg.message.documentMessage.mimetype
        else if (rawMsg.message?.stickerMessage?.mimetype) mimetype = rawMsg.message.stickerMessage.mimetype
        else if (rawMsg.message?.pttMessage?.mimetype) mimetype = rawMsg.message.pttMessage.mimetype

        res.writeHead(200, {
          'Content-Type': mimetype,
          'Cache-Control': 'private, max-age=3600',
          'Content-Length': buf.length,
        })
        res.end(buf)
      } catch (e) {
        console.error('[Media] Download error:', e.message)
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Media download failed: ' + e.message)
      }
      return
    }

    // Media proxy endpoint - proxies WhatsApp CDN URLs to avoid CORS issues
    // v6.0: Enhanced with Baileys download fallback
    if (req.url?.startsWith('/api/media-proxy')) {
      const mediaUrl = new URL(req.url, 'http://localhost').searchParams.get('url')
      const msgId = new URL(req.url, 'http://localhost').searchParams.get('msgId')

      // v6.0: Try Baileys download first if msgId is provided
      if (msgId && typeof downloadMediaMessage === 'function') {
        const rawMsg = rawMessageCache.get(msgId)
        if (rawMsg) {
          try {
            const mediaBuffer = await downloadMediaMessage(rawMsg, 'buffer', { logger: waLogger })
            if (mediaBuffer) {
              const buf = Buffer.isBuffer(mediaBuffer) ? mediaBuffer : Buffer.from(mediaBuffer)
              let mimetype = 'application/octet-stream'
              if (rawMsg.message?.imageMessage?.mimetype) mimetype = rawMsg.message.imageMessage.mimetype
              else if (rawMsg.message?.videoMessage?.mimetype) mimetype = rawMsg.message.videoMessage.mimetype
              else if (rawMsg.message?.audioMessage?.mimetype) mimetype = rawMsg.message.audioMessage.mimetype
              else if (rawMsg.message?.documentMessage?.mimetype) mimetype = rawMsg.message.documentMessage.mimetype
              else if (rawMsg.message?.pttMessage?.mimetype) mimetype = rawMsg.message.pttMessage.mimetype

              res.writeHead(200, {
                'Content-Type': mimetype,
                'Cache-Control': 'private, max-age=3600',
                'Content-Length': buf.length,
              })
              res.end(buf)
              return
            }
          } catch (e) {
            console.log('[Media] Baileys download failed, falling back to URL proxy:', e.message)
          }
        }
      }

      // Fallback: simple URL proxy (old behavior)
      if (!mediaUrl) { res.writeHead(400); res.end('Missing url param'); return }
      try {
        const mediaRes = await fetch(mediaUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } })
        if (mediaRes.ok) {
          res.writeHead(mediaRes.status, { 'Content-Type': mediaRes.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' })
          const buf = Buffer.from(await mediaRes.arrayBuffer())
          res.end(buf)
        } else {
          // CDN URL expired — try Baileys download if we have the raw message
          res.writeHead(502, { 'Content-Type': 'text/plain' })
          res.end('Media URL expired. Use /api/media-download?msgId=...&jid=... instead.')
        }
      } catch (e) { res.writeHead(502); res.end('Media fetch failed') }
      return
    }

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
