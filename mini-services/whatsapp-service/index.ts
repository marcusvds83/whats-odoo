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
  type proto,
  type BufferJSON,
  Browsers,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import P from 'pino'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

// ========== Configuration ==========
const PORT = 3001
const ODOO_SERVICE_URL = process.env.ODOO_SERVICE_URL || 'http://localhost:3002'
// Use DATA_DIR env var for persistent disk (Render), fallback to local auth_store
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'mini-services', 'whatsapp-service', 'auth_store')
const AUTH_FOLDER = join(DATA_DIR, 'auth_store')
const logger = P({ level: 'silent' })

// Ensure auth folder exists
if (!existsSync(AUTH_FOLDER)) {
  mkdirSync(AUTH_FOLDER, { recursive: true })
}

// ========== State ==========
let waSocket: WASocket | null = null
let connectionState: ConnectionState = {
  connection: 'close',
  lastDisconnect: undefined,
}

// Track whether we have saved credentials (for reconnection UX)
let hasSavedSession = existsSync(join(AUTH_FOLDER, 'creds.json'))

// Sync state tracking
let syncState: {
  isSyncing: boolean
  progress: number
  totalChats: number
  totalContacts: number
  totalMessages: number
  lastSyncAt: Date | null
} = {
  isSyncing: false,
  progress: 0,
  totalChats: 0,
  totalContacts: 0,
  totalMessages: 0,
  lastSyncAt: null,
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

// Contact name cache from WhatsApp history sync
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

  odooServiceSocket.on('connect', () => {
    console.log('[WA->Odoo] Connected to Odoo service')
  })

  odooServiceSocket.on('disconnect', () => {
    console.log('[WA->Odoo] Disconnected from Odoo service')
  })

  odooServiceSocket.on('connect_error', (err: any) => {
    console.log(`[WA->Odoo] Connection error: ${err.message}`)
  })
}

// ========== Helper Functions ==========

/**
 * Check if a JID is a valid phone number contact (@s.whatsapp.net)
 * Rejects @lid, @g.us, @broadcast, and other non-phone JIDs
 */
function isValidPhoneJid(jid: string): boolean {
  // Only accept individual contacts with @s.whatsapp.net suffix
  if (!jid.endsWith('@s.whatsapp.net')) return false
  // Extract the number part before @
  const numPart = jid.split('@')[0]
  // Must be digits only and at least 7 digits (international phone numbers)
  if (!/^\d{7,}$/.test(numPart)) return false
  return true
}

/**
 * Extract phone number from a valid JID
 */
function extractPhone(jid: string): string | null {
  if (!isValidPhoneJid(jid)) return null
  const match = jid.match(/^(\d+)@/)
  return match ? match[1] : null
}

/**
 * Get display name for a conversation - uses cached contact name, pushName, or phone
 */
function getDisplayName(jid: string, pushName?: string | null): string | null {
  // First check our contact name cache
  const cachedName = contactNames.get(jidNormalizedUser(jid))
  if (cachedName) return cachedName
  // Then check pushName
  if (pushName) return pushName
  return null
}

function getOrCreateConversation(jid: string, pushName?: string | null) {
  // NEVER create conversations for invalid JIDs
  if (!isValidPhoneJid(jid)) return null

  if (!conversations.has(jid)) {
    const name = getDisplayName(jid, pushName)
    conversations.set(jid, {
      jid,
      name,
      phone: extractPhone(jid),
      pushName: pushName || null,
      avatarUrl: null,
      lastMessage: null,
      lastMessageAt: null,
      unreadCount: 0,
      messages: [],
    })
  }
  const conv = conversations.get(jid)!
  // Update name if we have better info
  const betterName = getDisplayName(jid, pushName)
  if (betterName && !conv.name) {
    conv.name = betterName
  }
  if (pushName && !conv.pushName) {
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

/**
 * Get all conversations sorted by date (most recent first)
 */
function getSortedConversations() {
  return Array.from(conversations.values())
    .filter(conv => isValidPhoneJid(conv.jid)) // Extra safety: only valid JIDs
    .sort((a, b) => {
      const tA = a.lastMessageAt ? a.lastMessageAt.getTime() : 0
      const tB = b.lastMessageAt ? b.lastMessageAt.getTime() : 0
      return tB - tA // Most recent first
    })
    .map(serializeConversation)
    .filter(Boolean)
}

/**
 * Emit full sorted conversation list to all clients
 */
function emitConversationsList() {
  const sorted = getSortedConversations()
  io.emit('whatsapp:conversations', sorted)
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
  if (!odooServiceSocket?.connected) {
    console.log('[WA->Odoo] Odoo service not connected, skipping auto-sync')
    return
  }

  odooServiceSocket.emit('odoo:autosync:message', data, (response: any) => {
    if (response?.success) {
      console.log(`[WA->Odoo] Auto-sync OK for ${data.phone}: partner=${response.partnerId} lead=${response.leadId} msg=${response.mailMessageId}`)
      io.emit('whatsapp:odoo-sync', {
        jid: data.jid,
        phone: data.phone,
        partnerId: response.partnerId,
        leadId: response.leadId,
        mailMessageId: response.mailMessageId,
        activityId: response.activityId,
        created: response.created,
        errors: response.errors,
      })
    } else {
      console.log(`[WA->Odoo] Auto-sync failed for ${data.phone}: ${response?.error || 'unknown error'}`)
    }
  })
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
    // IMPORTANT: syncFullHistory = true to get all conversations like WhatsApp Web
    syncFullHistory: true,
    // Request recent messages only (not full year history)
    // Baileys will sync based on what WhatsApp server provides
  })

  // Save credentials on update - THIS IS KEY FOR PERSISTENCE
  waSocket.ev.on('creds.update', saveCreds)

  // Connection events
  waSocket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    connectionState = { connection, lastDisconnect }

    console.log(`[WA] Connection update: ${connection}`)

    if (qr) {
      console.log('[WA] QR Code generated, sending to clients')
      io.emit('whatsapp:qr', { qr })
      // When QR is shown, we don't have a saved session (or it expired)
      hasSavedSession = false
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      console.log(`[WA] Connection closed. Status: ${statusCode}, Reconnect: ${shouldReconnect}`)

      if (statusCode === DisconnectReason.loggedOut) {
        // Session was explicitly logged out from the phone
        hasSavedSession = false
        console.log('[WA] Session logged out from phone - need new QR scan')
      }

      io.emit('whatsapp:status', {
        connected: false,
        reason: statusCode === DisconnectReason.loggedOut ? 'logged_out' : 'reconnecting',
        hasSession: hasSavedSession,
      })

      if (shouldReconnect) {
        // Reconnect after delay - session persistence means we can auto-reconnect
        console.log('[WA] Reconnecting in 3 seconds...')
        setTimeout(() => connectWhatsApp(), 3000)
      }
    }

    if (connection === 'open') {
      console.log('[WA] Connected successfully!')
      hasSavedSession = true // We have a valid session now
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
      } catch {
        // Profile pic might not be available
      }

      // Emit current conversations (in case client reconnected)
      emitConversationsList()
    }
  })

  // ========== HISTORY SYNC - Like WhatsApp Web backup/sync ==========
  // This is the event that fires when WhatsApp syncs chat history after connection
  // It's equivalent to the "backup" step the user mentioned
  waSocket.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest, progress, syncType }) => {
    console.log(`[WA] History sync: type=${syncType}, isLatest=${isLatest}, progress=${progress}%, chats=${chats.length}, contacts=${Object.keys(contacts).length}, messages=${messages.length}`)

    syncState.isSyncing = true
    syncState.progress = progress || 0

    // Emit sync progress to clients
    io.emit('whatsapp:sync-progress', {
      isSyncing: true,
      progress: progress || 0,
      phase: syncType || 'historical',
      chatsCount: chats.length,
      contactsCount: Object.keys(contacts).length,
    })

    // ========== PROCESS CONTACTS FIRST ==========
    // Store contact names from the contacts map for later use
    let validContactsCount = 0
    for (const [jid, contact] of Object.entries(contacts)) {
      // Only store contacts with valid phone JIDs and actual names
      if (isValidPhoneJid(jid) && contact?.name) {
        contactNames.set(jidNormalizedUser(jid), contact.name)
        validContactsCount++
      }
    }
    syncState.totalContacts = validContactsCount
    console.log(`[WA] Stored ${validContactsCount} valid contacts (filtered out @lid, @g.us, etc.)`)

    // ========== PROCESS CHATS (CONVERSATIONS) ==========
    // Use CURRENT timestamp for all synced conversations (SEMPRE DE HOJE)
    const now = new Date()
    let chatsProcessed = 0

    for (const chat of chats) {
      const jid = chat.id

      // SKIP non-phone JIDs - only show real contacts with phone numbers
      if (!isValidPhoneJid(jid)) {
        continue
      }

      // Get contact name from our cache
      const contactName = contactNames.get(jidNormalizedUser(jid)) || null
      const phone = extractPhone(jid)

      // Get existing conversation or create new one
      if (!conversations.has(jid)) {
        conversations.set(jid, {
          jid,
          name: contactName,
          phone,
          pushName: null,
          avatarUrl: null,
          lastMessage: null,
          lastMessageAt: now, // ALWAYS CURRENT TIME
          unreadCount: chat.unreadCount || 0,
          messages: [],
        })
      } else {
        // Update existing conversation with contact name if we have it
        const conv = conversations.get(jid)!
        if (contactName && !conv.name) {
          conv.name = contactName
        }
      }

      chatsProcessed++
    }

    syncState.totalChats = chatsProcessed
    console.log(`[WA] Processed ${chatsProcessed} valid chats (filtered out groups and @lid entries)`)

    // ========== PROCESS MESSAGES ==========
    let messagesProcessed = 0
    for (const msg of messages) {
      if (!msg.key) continue

      const jid = msg.key.remoteJid!

      // Skip non-phone JIDs
      if (!isValidPhoneJid(jid)) continue

      // Skip status broadcast
      if (jid === 'status@broadcast') continue

      const fromMe = msg.key.fromMe || false

      // Extract text content
      const textContent =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        msg.message?.documentMessage?.caption ||
        null

      // Determine media type
      let mediaType: string | null = null
      if (msg.message?.imageMessage) mediaType = 'image'
      else if (msg.message?.videoMessage) mediaType = 'video'
      else if (msg.message?.audioMessage) mediaType = 'audio'
      else if (msg.message?.documentMessage) mediaType = 'document'
      else if (msg.message?.stickerMessage) mediaType = 'sticker'
      else if (msg.message?.contactMessage) mediaType = 'contact'
      else if (msg.message?.locationMessage) mediaType = 'location'

      // Only process messages with content
      if (!textContent && !mediaType) continue

      const conv = conversations.get(jid)
      if (!conv) continue

      // Check if message already exists (by ID)
      const msgId = msg.key.id
      if (msgId && conv.messages.some(m => m.whatsappId === msgId)) continue

      // Use message's original timestamp for ordering, but conversation date is ALWAYS NOW
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

      // Update last message - but ALWAYS keep lastMessageAt as NOW
      if (textContent) {
        conv.lastMessage = textContent
      } else if (mediaType) {
        conv.lastMessage = `[${mediaType}]`
      }
      // CRITICAL: lastMessageAt is ALWAYS current time - SEMPRE DE HOJE
      conv.lastMessageAt = now

      messagesProcessed++
    }

    syncState.totalMessages = messagesProcessed

    // If this is the latest (final) sync batch, finalize
    if (isLatest || progress >= 100) {
      syncState.isSyncing = false
      syncState.progress = 100
      syncState.lastSyncAt = new Date()

      console.log(`[WA] Sync complete! ${chatsProcessed} chats, ${validContactsCount} contacts, ${messagesProcessed} messages`)

      io.emit('whatsapp:sync-progress', {
        isSyncing: false,
        progress: 100,
        phase: 'complete',
        chatsCount: chatsProcessed,
        contactsCount: validContactsCount,
        messagesCount: messagesProcessed,
      })
    }

    // Emit updated conversation list (sorted by date)
    emitConversationsList()
  })

  // ========== REAL-TIME MESSAGE EVENTS ==========
  waSocket.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`[WA] Messages upsert: ${type}, count: ${messages.length}`)

    for (const msg of messages) {
      if (!msg.key) continue

      const jid = msg.key.remoteJid!
      const fromMe = msg.key.fromMe || false
      const pushName = (msg as any).pushName || null

      // Skip status messages
      if (jid === 'status@broadcast') continue

      // Skip non-phone JIDs
      if (!isValidPhoneJid(jid)) continue

      // Get or create conversation (only for valid phone JIDs)
      const conv = getOrCreateConversation(jid, fromMe ? undefined : pushName)
      if (!conv) continue

      // Extract text content
      const textContent =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        msg.message?.documentMessage?.caption ||
        null

      // Determine media type
      let mediaType: string | null = null
      if (msg.message?.imageMessage) mediaType = 'image'
      else if (msg.message?.videoMessage) mediaType = 'video'
      else if (msg.message?.audioMessage) mediaType = 'audio'
      else if (msg.message?.documentMessage) mediaType = 'document'
      else if (msg.message?.stickerMessage) mediaType = 'sticker'
      else if (msg.message?.contactMessage) mediaType = 'contact'
      else if (msg.message?.locationMessage) mediaType = 'location'

      // Only process messages with content
      if (!textContent && !mediaType) continue

      // Avoid duplicates (check by whatsappId)
      const msgId = msg.key.id
      if (msgId && conv.messages.some(m => m.whatsappId === msgId)) continue

      const messageData = {
        id: msgId || Math.random().toString(36).substr(2, 9),
        whatsappId: msgId || null,
        fromMe,
        textContent,
        mediaType,
        timestamp: new Date((msg.messageTimestamp as number) * 1000 || Date.now()),
        status: fromMe ? 'delivered' : 'received',
      }

      // Add to conversation
      conv.messages.push(messageData)
      conv.lastMessage = textContent || `[${mediaType}]`
      // ALWAYS update lastMessageAt to NOW for real-time messages
      conv.lastMessageAt = new Date()

      if (!fromMe) {
        conv.unreadCount++
      }

      // Try to get profile picture
      try {
        if (!conv.avatarUrl) {
          const picUrl = await waSocket!.profilePictureUrl(jid, 'image').catch(() => null)
          if (picUrl) conv.avatarUrl = picUrl
        }
      } catch {
        // No profile pic
      }

      // Emit to connected clients
      io.emit('whatsapp:message', {
        conversationJid: jid,
        message: messageData,
        conversation: serializeConversation(conv),
      })

      io.emit('whatsapp:conversation:update', serializeConversation(conv))

      // ========== AUTO-SYNC TO ODOO ==========
      const phone = extractPhone(jid)
      if (phone) {
        triggerAutoSync({
          jid,
          phone,
          pushName: conv.pushName,
          textContent,
          mediaType,
          fromMe,
          timestamp: messageData.timestamp.toISOString(),
        })
      }
    }
  })

  // ========== CONTACT UPDATE EVENTS ==========
  // When WhatsApp sends updated contact info (names, etc.)
  waSocket.ev.on('contacts.upsert', async (contacts) => {
    for (const contact of contacts) {
      if (contact.id && isValidPhoneJid(contact.id)) {
        if (contact.name) {
          contactNames.set(jidNormalizedUser(contact.id), contact.name)
          // Update existing conversations with the new name
          const conv = conversations.get(contact.id)
          if (conv && !conv.name) {
            conv.name = contact.name
          }
        }
      }
    }
    // Emit updated list
    emitConversationsList()
  })

  waSocket.ev.on('contacts.update', async (updates) => {
    for (const update of updates) {
      if (update.id && isValidPhoneJid(update.id)) {
        if (update.name) {
          contactNames.set(jidNormalizedUser(update.id), update.name)
          const conv = conversations.get(update.id)
          if (conv) {
            conv.name = update.name
          }
        }
      }
    }
    emitConversationsList()
  })

  // ========== CHAT UPDATE EVENTS ==========
  waSocket.ev.on('chats.upsert', async (chats) => {
    const now = new Date()
    for (const chat of chats) {
      if (!isValidPhoneJid(chat.id)) continue

      if (!conversations.has(chat.id)) {
        const contactName = contactNames.get(jidNormalizedUser(chat.id)) || null
        conversations.set(chat.id, {
          jid: chat.id,
          name: contactName,
          phone: extractPhone(chat.id),
          pushName: null,
          avatarUrl: null,
          lastMessage: null,
          lastMessageAt: now, // ALWAYS NOW
          unreadCount: chat.unreadCount || 0,
          messages: [],
        })
      }
    }
    emitConversationsList()
  })

  waSocket.ev.on('chats.update', async (updates) => {
    const now = new Date()
    for (const update of updates) {
      if (!isValidPhoneJid(update.id)) continue

      const conv = conversations.get(update.id)
      if (conv) {
        if (update.unreadCount !== undefined) {
          conv.unreadCount = update.unreadCount
        }
        // Always update timestamp to now
        conv.lastMessageAt = now
      }
    }
    emitConversationsList()
  })
}

// ========== Socket.io Events ==========
io.on('connection', (socket) => {
  console.log(`[IO] Client connected: ${socket.id}`)

  // Send current status on connect
  const isConnected = connectionState.connection === 'open'
  socket.emit('whatsapp:status', {
    connected: isConnected,
    reason: isConnected ? undefined : (hasSavedSession ? 'reconnecting' : 'disconnected'),
    hasSession: hasSavedSession,
  })

  // Send current conversations list (sorted)
  socket.emit('whatsapp:conversations', getSortedConversations())

  // Send sync progress if currently syncing
  if (syncState.isSyncing) {
    socket.emit('whatsapp:sync-progress', {
      isSyncing: true,
      progress: syncState.progress,
      phase: 'historical',
      chatsCount: syncState.totalChats,
      contactsCount: syncState.totalContacts,
    })
  }

  // Request QR code regeneration
  socket.on('whatsapp:request-qr', () => {
    if (connectionState.connection !== 'open' && waSocket) {
      socket.emit('whatsapp:status', { connected: false, reason: 'connecting', hasSession: hasSavedSession })
    } else if (!waSocket) {
      connectWhatsApp()
    }
  })

  // Get conversation messages
  socket.on('whatsapp:get-messages', (data: { jid: string }, callback) => {
    const conv = conversations.get(data.jid)
    if (conv) {
      callback({ messages: conv.messages.slice(-100) })
    } else {
      callback({ messages: [] })
    }
  })

  // Send a text message
  socket.on('whatsapp:send-message', async (data: { jid: string; text: string }, callback) => {
    try {
      if (!waSocket || connectionState.connection !== 'open') {
        callback({ success: false, error: 'WhatsApp not connected' })
        return
      }

      // Only allow sending to valid phone JIDs
      if (!isValidPhoneJid(data.jid)) {
        callback({ success: false, error: 'Invalid contact JID' })
        return
      }

      const sent = await waSocket.sendMessage(data.jid, { text: data.text })
      const conv = getOrCreateConversation(data.jid)
      if (!conv) {
        callback({ success: false, error: 'Could not create conversation' })
        return
      }

      const messageData = {
        id: sent.key.id || Math.random().toString(36).substr(2, 9),
        whatsappId: sent.key.id || null,
        fromMe: true,
        textContent: data.text,
        mediaType: null,
        timestamp: new Date(),
        status: 'sent',
      }

      conv.messages.push(messageData)
      conv.lastMessage = data.text
      conv.lastMessageAt = new Date() // ALWAYS NOW

      io.emit('whatsapp:message', {
        conversationJid: data.jid,
        message: messageData,
        conversation: serializeConversation(conv),
      })

      // Also sync sent messages to Odoo
      const phone = extractPhone(data.jid)
      if (phone) {
        triggerAutoSync({
          jid: data.jid,
          phone,
          pushName: conv.pushName,
          textContent: data.text,
          mediaType: null,
          fromMe: true,
          timestamp: messageData.timestamp.toISOString(),
        })
      }

      callback({ success: true, messageId: sent.key.id })
    } catch (error: any) {
      console.error('[WA] Send message error:', error)
      callback({ success: false, error: error.message })
    }
  })

  // Send media message
  socket.on(
    'whatsapp:send-media',
    async (
      data: { jid: string; type: string; url: string; caption?: string; mimeType?: string; fileName?: string },
      callback
    ) => {
      try {
        if (!waSocket || connectionState.connection !== 'open') {
          callback({ success: false, error: 'WhatsApp not connected' })
          return
        }

        if (!isValidPhoneJid(data.jid)) {
          callback({ success: false, error: 'Invalid contact JID' })
          return
        }

        let sent
        if (data.type === 'image') {
          sent = await waSocket.sendMessage(data.jid, {
            image: { url: data.url },
            caption: data.caption,
          })
        } else if (data.type === 'document') {
          sent = await waSocket.sendMessage(data.jid, {
            document: { url: data.url },
            fileName: data.fileName || 'document',
            mimetype: data.mimeType,
            caption: data.caption,
          })
        } else if (data.type === 'video') {
          sent = await waSocket.sendMessage(data.jid, {
            video: { url: data.url },
            caption: data.caption,
          })
        } else if (data.type === 'audio') {
          sent = await waSocket.sendMessage(data.jid, {
            audio: { url: data.url },
            mimetype: data.mimeType || 'audio/mp4',
          })
        } else {
          callback({ success: false, error: 'Unsupported media type' })
          return
        }

        const conv = getOrCreateConversation(data.jid)
        if (!conv) {
          callback({ success: false, error: 'Could not create conversation' })
          return
        }

        const messageData = {
          id: sent.key.id || Math.random().toString(36).substr(2, 9),
          whatsappId: sent.key.id || null,
          fromMe: true,
          textContent: data.caption || null,
          mediaType: data.type,
          timestamp: new Date(),
          status: 'sent',
        }

        conv.messages.push(messageData)
        conv.lastMessage = data.caption || `[${data.type}]`
        conv.lastMessageAt = new Date()

        io.emit('whatsapp:message', {
          conversationJid: data.jid,
          message: messageData,
          conversation: serializeConversation(conv),
        })

        callback({ success: true, messageId: sent.key.id })
      } catch (error: any) {
        console.error('[WA] Send media error:', error)
        callback({ success: false, error: error.message })
      }
    }
  )

  // Mark conversation as read
  socket.on('whatsapp:mark-read', async (data: { jid: string }, callback) => {
    try {
      if (!waSocket || connectionState.connection !== 'open') {
        callback({ success: false, error: 'WhatsApp not connected' })
        return
      }

      const conv = conversations.get(data.jid)
      if (conv) {
        conv.unreadCount = 0
        io.emit('whatsapp:conversation:update', serializeConversation(conv))
      }

      await waSocket.readMessages([{ remoteJid: data.jid, id: '' }])
      callback({ success: true })
    } catch (error: any) {
      callback({ success: false, error: error.message })
    }
  })

  // Disconnect WhatsApp
  socket.on('whatsapp:disconnect', async (callback) => {
    try {
      if (waSocket) {
        await waSocket.logout('User requested disconnect')
        waSocket = null
        connectionState = { connection: 'close' }
        hasSavedSession = false
        conversations.clear()
        contactNames.clear()
        io.emit('whatsapp:status', { connected: false, reason: 'logged_out', hasSession: false })
        io.emit('whatsapp:conversations', [])
        callback({ success: true })
      } else {
        callback({ success: false, error: 'Not connected' })
      }
    } catch (error: any) {
      callback({ success: false, error: error.message })
    }
  })

  // Get profile picture
  socket.on('whatsapp:get-profile-pic', async (data: { jid: string }, callback) => {
    try {
      if (!waSocket || connectionState.connection !== 'open') {
        callback({ success: false, error: 'WhatsApp not connected' })
        return
      }
      const url = await waSocket.profilePictureUrl(data.jid, 'image').catch(() => null)
      const conv = conversations.get(data.jid)
      if (conv && url) {
        conv.avatarUrl = url
      }
      callback({ success: true, url })
    } catch {
      callback({ success: false, url: null })
    }
  })

  socket.on('disconnect', () => {
    console.log(`[IO] Client disconnected: ${socket.id}`)
  })
})

// ========== Start Server ==========
async function start() {
  console.log('[WA Service] Starting WhatsApp service...')
  console.log(`[WA Service] Auth folder: ${AUTH_FOLDER}`)
  console.log(`[WA Service] Has saved session: ${hasSavedSession}`)

  // Connect to Odoo service for auto-sync
  connectToOdooService()

  // Auto-connect WhatsApp - if we have saved creds, it will auto-reconnect
  // If no creds, it will generate a QR code
  await connectWhatsApp()

  httpServer.listen(PORT, () => {
    console.log(`[WA Service] Server running on port ${PORT}`)
  })
}

start().catch(console.error)

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[WA Service] SIGTERM received, shutting down...')
  if (waSocket) waSocket.end(undefined)
  if (odooServiceSocket) odooServiceSocket.disconnect()
  httpServer.close(() => process.exit(0))
})

process.on('SIGINT', () => {
  console.log('[WA Service] SIGINT received, shutting down...')
  if (waSocket) waSocket.end(undefined)
  if (odooServiceSocket) odooServiceSocket.disconnect()
  httpServer.close(() => process.exit(0))
})
