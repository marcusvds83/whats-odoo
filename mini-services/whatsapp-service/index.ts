import { createServer } from 'http'
import { Server } from 'socket.io'
import { io as ioClient } from 'socket.io-client'
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  type WASocket,
  type ConnectionState,
  Browsers,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import P from 'pino'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'

// ========== Configuration ==========
const PORT = 3001
const ODOO_SERVICE_URL = process.env.ODOO_SERVICE_URL || 'http://localhost:3002'
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'mini-services', 'whatsapp-service', 'auth_store')
const AUTH_FOLDER = join(DATA_DIR, 'auth_store')
const logger = P({ level: 'silent' })

if (!existsSync(AUTH_FOLDER)) {
  mkdirSync(AUTH_FOLDER, { recursive: true })
}

// ========== State ==========
let waSocket: WASocket | null = null
let connectionState: ConnectionState = {
  connection: 'close',
  lastDisconnect: undefined,
}

// Track saved session for reconnection UX
let hasSavedSession = existsSync(join(AUTH_FOLDER, 'creds.json'))

// *** CRITICAL: Store last QR code so we can re-emit to new browser clients ***
let lastQrCode: string | null = null

// Sync state tracking
let syncState: {
  isSyncing: boolean
  progress: number
  totalChats: number
  totalContacts: number
  totalMessages: number
} = {
  isSyncing: false,
  progress: 0,
  totalChats: 0,
  totalContacts: 0,
  totalMessages: 0,
}

// In-memory conversation/message store
const conversations = new Map<string, {
  jid: string
  name: string | null
  phone: string | null
  pushName: string | null
  avatarUrl: string | null
  lastMessage: string | null
  lastMessageAt: Date | null
  unreadCount: number
  messages: Array<{
    id: string
    whatsappId: string | null
    fromMe: boolean
    textContent: string | null
    mediaType: string | null
    timestamp: Date
    status: string
  }>
}>()

// Contact name cache from WhatsApp — device contact names (highest priority)
const contactNames = new Map<string, string>()

// ========== HTTP + Socket.io Server ==========
const httpServer = createServer()
const io = new Server(httpServer, {
  path: '/socket.io',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

// ========== Odoo Service Client ==========
let odooServiceSocket: any = null

function connectToOdooService() {
  if (odooServiceSocket?.connected) return
  odooServiceSocket = ioClient(ODOO_SERVICE_URL, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 3000,
    timeout: 10000,
  })
  odooServiceSocket.on('connect', () => console.log('[WA->Odoo] Connected to Odoo service'))
  odooServiceSocket.on('disconnect', () => console.log('[WA->Odoo] Disconnected from Odoo service'))
  odooServiceSocket.on('connect_error', (err: any) => console.log(`[WA->Odoo] Connection error: ${err.message}`))
}

// ========== Helper Functions ==========

/**
 * Only accept JIDs that are real phone numbers: digits@s.whatsapp.net
 * Rejects @lid, @g.us, @broadcast, short codes, etc.
 */
function isValidPhoneJid(jid: string): boolean {
  if (!jid.endsWith('@s.whatsapp.net')) return false
  const numPart = jid.split('@')[0]
  // Must be 7+ digits (international phone number)
  if (!/^\d{7,}$/.test(numPart)) return false
  return true
}

function extractPhone(jid: string): string | null {
  if (!isValidPhoneJid(jid)) return null
  return jid.split('@')[0]
}

function getOrCreateConversation(jid: string, pushName?: string | null) {
  if (!isValidPhoneJid(jid)) return null

  const cachedName = contactNames.get(jidNormalizedUser(jid)) || null

  if (!conversations.has(jid)) {
    conversations.set(jid, {
      jid,
      // Device contact name has highest priority, then pushName
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
  const conv = conversations.get(jid)!
  // ALWAYS update name from device contacts (device name > any other source)
  if (cachedName) {
    conv.name = cachedName
  } else if (pushName && !conv.name) {
    conv.pushName = pushName
  }
  return conv
}

function serializeConversation(conv: ReturnType<typeof getOrCreateConversation>) {
  if (!conv) return null
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

function getSortedConversations() {
  return Array.from(conversations.values())
    .filter(conv => isValidPhoneJid(conv.jid))
    .sort((a, b) => {
      const tA = a.lastMessageAt ? a.lastMessageAt.getTime() : 0
      const tB = b.lastMessageAt ? b.lastMessageAt.getTime() : 0
      return tB - tA // Most recent conversations at TOP
    })
    .map(serializeConversation)
    .filter(Boolean)
}

function emitConversationsList() {
  io.emit('whatsapp:conversations', getSortedConversations())
}

// ========== Auto-sync to Odoo ==========
function triggerAutoSync(data: {
  jid: string
  phone: string
  pushName: string | null
  textContent: string | null
  mediaType: string | null
  fromMe: boolean
  timestamp: string
}) {
  if (!odooServiceSocket?.connected) return
  odooServiceSocket.emit('odoo:autosync:message', data, (response: any) => {
    if (response?.success) {
      console.log(`[WA->Odoo] Auto-sync OK for ${data.phone}: partner=${response.partnerId} lead=${response.leadId}`)
      io.emit('whatsapp:odoo-sync', {
        jid: data.jid, phone: data.phone,
        partnerId: response.partnerId, leadId: response.leadId,
        mailMessageId: response.mailMessageId, activityId: response.activityId,
        created: response.created, errors: response.errors,
      })
    }
  })
}

// ========== Update conversation name from device contact ==========
function updateConversationName(jid: string, contactName: string) {
  if (!isValidPhoneJid(jid)) return
  const normalizedJid = jidNormalizedUser(jid)
  contactNames.set(normalizedJid, contactName)
  const conv = conversations.get(jid)
  if (conv) {
    // Device contact name always takes priority
    conv.name = contactName
  }
}

// ========== WhatsApp Connection ==========
async function connectWhatsApp() {
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
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 30_000,
    keepAliveIntervalMs: 25_000,
    markOnlineOnConnect: true,
    // Sync recent history (like WhatsApp Web without full backup)
    syncFullHistory: false,
  })

  // Save credentials on update — KEY FOR PERSISTENCE
  waSocket.ev.on('creds.update', saveCreds)

  // ========== Connection Events ==========
  waSocket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    connectionState = { connection, lastDisconnect }
    console.log(`[WA] Connection update: ${connection}`)

    if (qr) {
      lastQrCode = qr
      console.log('[WA] QR Code generated, sending to clients')
      io.emit('whatsapp:qr', { qr })
      hasSavedSession = false
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      console.log(`[WA] Connection closed. Status: ${statusCode}, Reconnect: ${shouldReconnect}`)

      if (statusCode === DisconnectReason.loggedOut) {
        hasSavedSession = false
        lastQrCode = null
        conversations.clear()
        contactNames.clear()
        emitConversationsList()
      }

      io.emit('whatsapp:status', {
        connected: false,
        reason: statusCode === DisconnectReason.loggedOut ? 'logged_out' : 'reconnecting',
        hasSession: hasSavedSession,
      })

      if (shouldReconnect) {
        setTimeout(() => connectWhatsApp(), 3000)
      }
    }

    if (connection === 'open') {
      console.log('[WA] Connected successfully!')
      hasSavedSession = true
      lastQrCode = null
      io.emit('whatsapp:status', { connected: true, hasSession: true })

      // Get profile picture for connected user
      try {
        const meId = waSocket!.user?.id
        if (meId) {
          const profilePicUrl = await waSocket!.profilePictureUrl(meId, 'image').catch(() => null)
          io.emit('whatsapp:me', {
            id: meId,
            name: waSocket!.user?.name,
            profilePicUrl,
          })
        }
      } catch {}

      // Emit current conversations to all clients
      emitConversationsList()

      // Request contact sync after connection to get device contact names
      // Baileys will fire contacts.upsert with device contacts
      try {
        setTimeout(async () => {
          if (waSocket && connectionState.connection === 'open') {
            console.log('[WA] Requesting contact sync from device...')
            // Force a contact resync by querying the store
            const contacts = await waSocket.fetchPrivacySettings?.().catch(() => null)
            console.log('[WA] Contact sync request sent')
          }
        }, 5000)
      } catch {}
    }
  })

  // ========== HISTORY SYNC ==========
  waSocket.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest, progress, syncType }) => {
    console.log(`[WA] History sync: type=${syncType}, progress=${progress}%, chats=${chats.length}, contacts=${Object.keys(contacts).length}, messages=${messages.length}`)

    syncState.isSyncing = true
    syncState.progress = progress || 0

    io.emit('whatsapp:sync-progress', {
      isSyncing: true,
      progress: progress || 0,
      phase: syncType || 'historical',
      chatsCount: chats.length,
      contactsCount: Object.keys(contacts).length,
    })

    // Process contacts — ALWAYS store device contact names for valid phone JIDs
    let validContactsCount = 0
    for (const [jid, contact] of Object.entries(contacts)) {
      if (isValidPhoneJid(jid) && contact?.name) {
        const normalizedJid = jidNormalizedUser(jid)
        contactNames.set(normalizedJid, contact.name)
        validContactsCount++
      }
    }
    syncState.totalContacts = validContactsCount
    console.log(`[WA] Processed ${validContactsCount} device contacts with names`)

    // Process chats — only valid phone JIDs
    let chatsProcessed = 0
    for (const chat of chats) {
      if (!isValidPhoneJid(chat.id)) continue

      const contactName = contactNames.get(jidNormalizedUser(chat.id)) || null
      if (!conversations.has(chat.id)) {
        conversations.set(chat.id, {
          jid: chat.id,
          name: contactName, // Device contact name takes priority
          phone: extractPhone(chat.id),
          pushName: null,
          avatarUrl: null,
          lastMessage: null,
          lastMessageAt: null, // Will be set when messages are processed
          unreadCount: chat.unreadCount || 0,
          messages: [],
        })
      } else {
        const conv = conversations.get(chat.id)!
        // ALWAYS update name from device contacts
        if (contactName) conv.name = contactName
      }
      chatsProcessed++
    }
    syncState.totalChats = chatsProcessed

    // Process messages — use ACTUAL timestamps for proper sort order
    let messagesProcessed = 0
    for (const msg of messages) {
      if (!msg.key) continue
      const jid = msg.key.remoteJid!
      if (!isValidPhoneJid(jid)) continue
      if (jid === 'status@broadcast') continue

      const fromMe = msg.key.fromMe || false
      const textContent =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        msg.message?.documentMessage?.caption || null

      let mediaType: string | null = null
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

      // Use ACTUAL message timestamp from WhatsApp
      const messageTimestamp = new Date((msg.messageTimestamp as number) * 1000 || Date.now())

      conv.messages.push({
        id: msgId || Math.random().toString(36).substr(2, 9),
        whatsappId: msgId || null,
        fromMe,
        textContent,
        mediaType,
        timestamp: messageTimestamp,
        status: fromMe ? 'delivered' : 'received',
      })

      if (textContent) conv.lastMessage = textContent
      else if (mediaType) conv.lastMessage = `[${mediaType}]`

      // Use actual timestamp for sort order — newest messages show first
      if (!conv.lastMessageAt || messageTimestamp > conv.lastMessageAt) {
        conv.lastMessageAt = messageTimestamp
      }

      messagesProcessed++
    }
    syncState.totalMessages = messagesProcessed

    // For conversations with no messages from history, set lastMessageAt to now
    // but with a slight offset so they sort below conversations with recent messages
    const baseTime = Date.now()
    let offset = 0
    for (const conv of conversations.values()) {
      if (!conv.lastMessageAt) {
        conv.lastMessageAt = new Date(baseTime - offset)
        offset += 1000 // 1 second offset between empty conversations
      }
    }

    if (isLatest || progress >= 100) {
      syncState.isSyncing = false
      syncState.progress = 100
      console.log(`[WA] Sync complete! ${chatsProcessed} chats, ${validContactsCount} contacts, ${messagesProcessed} messages`)
      io.emit('whatsapp:sync-progress', {
        isSyncing: false, progress: 100, phase: 'complete',
        chatsCount: chatsProcessed, contactsCount: validContactsCount, messagesCount: messagesProcessed,
      })
    }

    emitConversationsList()
  })

  // ========== REAL-TIME MESSAGES ==========
  waSocket.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      if (!msg.key) continue
      const jid = msg.key.remoteJid!
      const fromMe = msg.key.fromMe || false
      const pushName = (msg as any).pushName || null

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

      let mediaType: string | null = null
      if (msg.message?.imageMessage) mediaType = 'image'
      else if (msg.message?.videoMessage) mediaType = 'video'
      else if (msg.message?.audioMessage) mediaType = 'audio'
      else if (msg.message?.documentMessage) mediaType = 'document'
      else if (msg.message?.stickerMessage) mediaType = 'sticker'

      if (!textContent && !mediaType) continue

      const msgId = msg.key.id
      if (msgId && conv.messages.some(m => m.whatsappId === msgId)) continue

      const messageTimestamp = new Date((msg.messageTimestamp as number) * 1000 || Date.now())

      const messageData = {
        id: msgId || Math.random().toString(36).substr(2, 9),
        whatsappId: msgId || null,
        fromMe,
        textContent,
        mediaType,
        timestamp: messageTimestamp,
        status: fromMe ? 'delivered' : 'received',
      }

      conv.messages.push(messageData)
      conv.lastMessage = textContent || `[${mediaType}]`
      conv.lastMessageAt = new Date() // Real-time: use current time

      if (!fromMe) conv.unreadCount++

      try {
        if (!conv.avatarUrl) {
          const picUrl = await waSocket!.profilePictureUrl(jid, 'image').catch(() => null)
          if (picUrl) conv.avatarUrl = picUrl
        }
      } catch {}

      io.emit('whatsapp:message', {
        conversationJid: jid, message: messageData, conversation: serializeConversation(conv),
      })
      io.emit('whatsapp:conversation:update', serializeConversation(conv))

      const phone = extractPhone(jid)
      if (phone) {
        triggerAutoSync({
          jid, phone, pushName: conv.pushName, textContent, mediaType, fromMe,
          timestamp: messageData.timestamp.toISOString(),
        })
      }
    }
  })

  // ========== CONTACT EVENTS — Device contact names ==========
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
      emitConversationsList()
    }
  })

  waSocket.ev.on('contacts.update', async (updates) => {
    console.log(`[WA] contacts.update: ${updates.length} contacts updated`)
    let updatedCount = 0
    for (const update of updates) {
      if (update.id && isValidPhoneJid(update.id) && update.name) {
        updateConversationName(update.id, update.name)
        updatedCount++
      }
    }
    if (updatedCount > 0) {
      console.log(`[WA] Updated ${updatedCount} conversation names from contact updates`)
      emitConversationsList()
    }
  })

  // ========== CHAT EVENTS ==========
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
        // Update name from device contacts if available
        const conv = conversations.get(chat.id)!
        const contactName = contactNames.get(jidNormalizedUser(chat.id))
        if (contactName) conv.name = contactName
      }
    }
    emitConversationsList()
  })

  waSocket.ev.on('chats.update', async (updates) => {
    for (const update of updates) {
      if (!isValidPhoneJid(update.id)) continue
      const conv = conversations.get(update.id)
      if (conv) {
        if (update.unreadCount !== undefined) conv.unreadCount = update.unreadCount
        if (update.t) conv.lastMessageAt = new Date((update.t as number) * 1000)
      }
    }
    emitConversationsList()
  })
}

// ========== Socket.io Client Events ==========
io.on('connection', (socket) => {
  console.log(`[IO] Client connected: ${socket.id}`)

  const isConnected = connectionState.connection === 'open'

  // Send current status
  socket.emit('whatsapp:status', {
    connected: isConnected,
    reason: isConnected ? undefined : (hasSavedSession ? 'reconnecting' : 'disconnected'),
    hasSession: hasSavedSession,
  })

  // *** Re-emit stored QR code to new clients ***
  if (!isConnected && lastQrCode) {
    console.log('[IO] Re-sending stored QR code to new client')
    socket.emit('whatsapp:qr', { qr: lastQrCode })
  }

  // Send current conversations
  socket.emit('whatsapp:conversations', getSortedConversations())

  // Send sync progress if active
  if (syncState.isSyncing) {
    socket.emit('whatsapp:sync-progress', {
      isSyncing: true, progress: syncState.progress,
      phase: 'historical', chatsCount: syncState.totalChats, contactsCount: syncState.totalContacts,
    })
  }

  // Request QR code — forces a new connection to get fresh QR
  socket.on('whatsapp:request-qr', () => {
    console.log('[IO] QR requested by client')
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
      connectWhatsApp()
    }
  })

  // Get messages
  socket.on('whatsapp:get-messages', (data: { jid: string }, callback) => {
    const conv = conversations.get(data.jid)
    callback({ messages: conv ? conv.messages.slice(-100) : [] })
  })

  // Send message
  socket.on('whatsapp:send-message', async (data: { jid: string; text: string }, callback) => {
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

      io.emit('whatsapp:message', { conversationJid: data.jid, message: messageData, conversation: serializeConversation(conv) })

      const phone = extractPhone(data.jid)
      if (phone) triggerAutoSync({ jid: data.jid, phone, pushName: conv.pushName, textContent: data.text, mediaType: null, fromMe: true, timestamp: messageData.timestamp.toISOString() })

      callback({ success: true, messageId: sent.key.id })
    } catch (error: any) {
      callback({ success: false, error: error.message })
    }
  })

  // Send media
  socket.on('whatsapp:send-media', async (data: { jid: string; type: string; url: string; caption?: string; mimeType?: string; fileName?: string }, callback) => {
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

      io.emit('whatsapp:message', { conversationJid: data.jid, message: messageData, conversation: serializeConversation(conv) })
      callback({ success: true, messageId: sent.key.id })
    } catch (error: any) {
      callback({ success: false, error: error.message })
    }
  })

  // Mark read
  socket.on('whatsapp:mark-read', async (data: { jid: string }, callback) => {
    try {
      if (!waSocket || connectionState.connection !== 'open') { callback({ success: false, error: 'WhatsApp not connected' }); return }
      const conv = conversations.get(data.jid)
      if (conv) { conv.unreadCount = 0; io.emit('whatsapp:conversation:update', serializeConversation(conv)) }
      await waSocket.readMessages([{ remoteJid: data.jid, id: '' }])
      callback({ success: true })
    } catch (error: any) { callback({ success: false, error: error.message }) }
  })

  // Disconnect
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
        io.emit('whatsapp:status', { connected: false, reason: 'logged_out', hasSession: false })
        io.emit('whatsapp:conversations', [])
        callback({ success: true })
      } else {
        callback({ success: false, error: 'Not connected' })
      }
    } catch (error: any) { callback({ success: false, error: error.message }) }
  })

  // Get profile pic
  socket.on('whatsapp:get-profile-pic', async (data: { jid: string }, callback) => {
    try {
      if (!waSocket || connectionState.connection !== 'open') { callback({ success: false, error: 'WhatsApp not connected' }); return }
      const url = await waSocket.profilePictureUrl(data.jid, 'image').catch(() => null)
      const conv = conversations.get(data.jid)
      if (conv && url) conv.avatarUrl = url
      callback({ success: true, url })
    } catch { callback({ success: false, url: null }) }
  })

  socket.on('disconnect', () => console.log(`[IO] Client disconnected: ${socket.id}`))
})

// ========== Start ==========
async function start() {
  console.log(`[WA Service] Starting... Auth: ${AUTH_FOLDER}, Has session: ${hasSavedSession}`)
  connectToOdooService()
  await connectWhatsApp()
  httpServer.listen(PORT, () => console.log(`[WA Service] Running on port ${PORT}`))
}
start().catch(console.error)

process.on('SIGTERM', () => {
  if (waSocket) waSocket.end(undefined)
  if (odooServiceSocket) odooServiceSocket.disconnect()
  httpServer.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  if (waSocket) waSocket.end(undefined)
  if (odooServiceSocket) odooServiceSocket.disconnect()
  httpServer.close(() => process.exit(0))
})
