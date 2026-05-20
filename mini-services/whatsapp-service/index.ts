import { createServer } from 'http'
import { Server } from 'socket.io'
import { io as ioClient } from 'socket.io-client'
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
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

// ========== HTTP + Socket.io Server ==========
const httpServer = createServer()
const io = new Server(httpServer, {
  path: '/socket.io',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

// ========== Odoo Service Client ==========
// Connect to the Odoo service to trigger auto-sync
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
    console.log('[WA→Odoo] Connected to Odoo service')
  })

  odooServiceSocket.on('disconnect', () => {
    console.log('[WA→Odoo] Disconnected from Odoo service')
  })

  odooServiceSocket.on('connect_error', (err: any) => {
    console.log(`[WA→Odoo] Connection error: ${err.message}`)
  })
}

// ========== Helper Functions ==========
function extractPhone(jid: string): string | null {
  const match = jid.match(/^(\d+)@/)
  return match ? match[1] : null
}

function getOrCreateConversation(jid: string, pushName?: string | null) {
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
  const conv = conversations.get(jid)!
  if (pushName && !conv.pushName) {
    conv.pushName = pushName
  }
  return conv
}

function serializeConversation(conv: ReturnType<typeof getOrCreateConversation>) {
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
    console.log('[WA→Odoo] Odoo service not connected, skipping auto-sync')
    return
  }

  odooServiceSocket.emit('odoo:autosync:message', data, (response: any) => {
    if (response?.success) {
      console.log(`[WA→Odoo] Auto-sync OK for ${data.phone}: partner=${response.partnerId} lead=${response.leadId} msg=${response.mailMessageId}`)
      // Notify frontend clients about the sync result
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
      console.log(`[WA→Odoo] Auto-sync failed for ${data.phone}: ${response?.error || 'unknown error'}`)
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
    syncFullHistory: false,
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
      io.emit('whatsapp:qr', { qr })
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      console.log(`[WA] Connection closed. Status: ${statusCode}, Reconnect: ${shouldReconnect}`)

      io.emit('whatsapp:status', {
        connected: false,
        reason: statusCode === DisconnectReason.loggedOut ? 'logged_out' : 'disconnected',
      })

      if (shouldReconnect) {
        setTimeout(() => connectWhatsApp(), 3000)
      }
    }

    if (connection === 'open') {
      console.log('[WA] Connected successfully!')
      io.emit('whatsapp:status', { connected: true })

      // Get profile picture for connected user
      try {
        const meId = waSocket!.user?.id
        if (meId) {
          const profilePicUrl = await waSocket!.profilePictureUrl(meId, 'image')
          io.emit('whatsapp:me', {
            id: meId,
            name: waSocket!.user?.name,
            profilePicUrl,
          })
        }
      } catch {
        // Profile pic might not be available
      }
    }
  })

  // Message events
  waSocket.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`[WA] Messages upsert: ${type}, count: ${messages.length}`)

    for (const msg of messages) {
      if (!msg.key) continue

      const jid = msg.key.remoteJid!
      const fromMe = msg.key.fromMe || false
      const pushName = (msg as any).pushName || null

      // Skip status messages
      if (jid === 'status@broadcast') continue

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

      const messageData = {
        id: msg.key.id || Math.random().toString(36).substr(2, 9),
        whatsappId: msg.key.id || null,
        fromMe,
        textContent,
        mediaType,
        timestamp: new Date((msg.messageTimestamp as number) * 1000 || Date.now()),
        status: fromMe ? 'delivered' : 'received',
      }

      // Add to conversation
      conv.messages.push(messageData)
      conv.lastMessage = textContent || `[${mediaType}]`
      conv.lastMessageAt = messageData.timestamp

      if (!fromMe) {
        conv.unreadCount++
      }

      // Try to get profile picture
      try {
        if (!conv.avatarUrl) {
          const picUrl = await waSocket!.profilePictureUrl(jid, 'image')
          conv.avatarUrl = picUrl
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
      // Only auto-sync incoming messages (not fromMe) or all messages
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

  // Message status updates (read, delivered)
  waSocket.ev.on('messages.upsert', () => {})
}

// ========== Socket.io Events ==========
io.on('connection', (socket) => {
  console.log(`[IO] Client connected: ${socket.id}`)

  // Send current status on connect
  socket.emit('whatsapp:status', {
    connected: connectionState.connection === 'open',
  })

  // Send current conversations list
  const convList = Array.from(conversations.values()).map(serializeConversation)
  socket.emit('whatsapp:conversations', convList)

  // Request QR code regeneration
  socket.on('whatsapp:request-qr', () => {
    if (connectionState.connection !== 'open' && waSocket) {
      socket.emit('whatsapp:status', { connected: false, reason: 'connecting' })
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

      const sent = await waSocket.sendMessage(data.jid, { text: data.text })
      const conv = getOrCreateConversation(data.jid)

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
      conv.lastMessageAt = messageData.timestamp

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
        conv.lastMessageAt = messageData.timestamp

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
        io.emit('whatsapp:status', { connected: false, reason: 'logged_out' })
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
      const url = await waSocket.profilePictureUrl(data.jid, 'image')
      const conv = conversations.get(data.jid)
      if (conv) {
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

  // Connect to Odoo service for auto-sync
  connectToOdooService()

  // Auto-connect WhatsApp
  if (existsSync(join(AUTH_FOLDER, 'creds.json'))) {
    console.log('[WA Service] Found existing auth, connecting...')
    await connectWhatsApp()
  } else {
    console.log('[WA Service] No auth found, waiting for QR scan...')
    await connectWhatsApp()
  }

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
