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
  isJidGroup,
  isJidBroadcast,
  type WASocket,
  type ConnectionState,
  Browsers,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import P from 'pino'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import NodeCache from 'node-cache'

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

// Group metadata cache (5 min TTL)
const groupMetadataCache = new NodeCache({ stdTtl: 300, useClones: false })

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
interface ConversationData {
  jid: string
  name: string | null
  phone: string | null
  pushName: string | null
  avatarUrl: string | null
  lastMessage: string | null
  lastMessageAt: Date | null
  unreadCount: number
  isGroup: boolean
  groupName: string | null
  messages: Array<{
    id: string
    whatsappId: string | null
    fromMe: boolean
    textContent: string | null
    mediaType: string | null
    timestamp: Date
    status: string
    senderName?: string | null
  }>
}

const conversations = new Map<string, ConversationData>()

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
  odooServiceSocket.on('connect', () => console.log('[WA->Odoo] Connected to Odoo service'))
  odooServiceSocket.on('disconnect', () => console.log('[WA->Odoo] Disconnected from Odoo service'))
  odooServiceSocket.on('connect_error', (err: any) => console.log(`[WA->Odoo] Connection error: ${err.message}`))
}

// ========== Helper Functions ==========

/**
 * Accept real phone JIDs: digits@s.whatsapp.net
 */
function isValidPhoneJid(jid: string): boolean {
  if (!jid.endsWith('@s.whatsapp.net')) return false
  const numPart = jid.split('@')[0]
  if (!/^\d{7,}$/.test(numPart)) return false
  return true
}

/**
 * Accept group JIDs: digits-digits@g.us
 */
function isValidGroupJid(jid: string): boolean {
  return isJidGroup(jid)
}

/**
 * Accept both phone and group JIDs
 */
function isValidConversationJid(jid: string): boolean {
  return isValidPhoneJid(jid) || isValidGroupJid(jid)
}

function extractPhone(jid: string): string | null {
  if (!isValidPhoneJid(jid)) return null
  return jid.split('@')[0]
}

function getOrCreateConversation(jid: string, pushName?: string | null) {
  if (!isValidConversationJid(jid)) return null

  if (!conversations.has(jid)) {
    const isGrp = isValidGroupJid(jid)
    const cachedName = contactNames.get(jidNormalizedUser(jid)) || null
    conversations.set(jid, {
      jid,
      name: isGrp ? null : (cachedName || pushName || null),
      phone: extractPhone(jid),
      pushName: isGrp ? null : (pushName || null),
      avatarUrl: null,
      lastMessage: null,
      lastMessageAt: null, // Will be set by actual timestamps
      unreadCount: 0,
      isGroup: isGrp,
      groupName: isGrp ? cachedName : null,
      messages: [],
    })
  }
  const conv = conversations.get(jid)!
  // Update name if we have better info
  if (!conv.isGroup) {
    const cachedName = contactNames.get(jidNormalizedUser(jid))
    if (cachedName && !conv.name) conv.name = cachedName
    if (pushName && !conv.pushName) conv.pushName = pushName
  }
  return conv
}

function serializeConversation(conv: ReturnType<typeof getOrCreateConversation>) {
  if (!conv) return null
  return {
    jid: conv.jid,
    name: conv.isGroup ? (conv.groupName || conv.name) : conv.name,
    phone: conv.phone,
    pushName: conv.pushName,
    avatarUrl: conv.avatarUrl,
    lastMessage: conv.lastMessage,
    lastMessageAt: conv.lastMessageAt?.toISOString() || null,
    unreadCount: conv.unreadCount,
    messageCount: conv.messages.length,
    isGroup: conv.isGroup,
    groupName: conv.groupName,
  }
}

/**
 * Sort conversations by ACTUAL last message timestamp (most recent first)
 * This mirrors WhatsApp Web's ordering
 */
function getSortedConversations() {
  return Array.from(conversations.values())
    .filter(conv => isValidConversationJid(conv.jid))
    .sort((a, b) => {
      const tA = a.lastMessageAt ? a.lastMessageAt.getTime() : 0
      const tB = b.lastMessageAt ? b.lastMessageAt.getTime() : 0
      return tB - tA // Most recent first
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
  // DO NOT auto-sync group conversations to Odoo
  if (isValidGroupJid(data.jid)) return
  if (!odooServiceSocket?.connected) return

  odooServiceSocket.emit('odoo:autosync:message', data, (response: any) => {
    if (response?.success) {
      console.log(`[WA->Odoo] Auto-sync OK for ${data.phone}: partner=${response.partnerId} lead=${response.leadId}`)
      io.emit('whatsapp:odoo-sync', {
        jid: data.jid, phone: data.phone,
        partnerId: response.partnerId, leadId: response.leadId,
        created: response.created, errors: response.errors,
      })
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
    // Sync recent history only (like WhatsApp Web) — NOT full backup
    syncFullHistory: false,
    // Cache group metadata to avoid rate limits
    cachedGroupMetadata: async (jid) => {
      const cached = groupMetadataCache.get(jid) as any
      if (cached) return cached
      try {
        if (waSocket && connectionState.connection === 'open') {
          const metadata = await waSocket.groupMetadata(jid)
          groupMetadataCache.set(jid, metadata)
          return metadata
        }
      } catch {}
      return undefined
    },
  })

  // Save credentials on update — KEY FOR PERSISTENCE
  waSocket.ev.on('creds.update', saveCreds)

  // ========== Connection Events ==========
  waSocket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    connectionState = { connection, lastDisconnect }
    console.log(`[WA] Connection update: ${connection}`)

    if (qr) {
      // *** Store QR so we can re-emit to new clients ***
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
        // Clear conversations on explicit logout
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
        // Auto-reconnect with exponential backoff
        const delay = statusCode === DisconnectReason.connectionClosed ? 1000 : 3000
        setTimeout(() => connectWhatsApp(), delay)
      }
    }

    if (connection === 'open') {
      console.log('[WA] Connected successfully!')
      hasSavedSession = true
      lastQrCode = null // Clear QR since we're connected
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

    // Process contacts — store names for valid JIDs (phones AND groups)
    let validContactsCount = 0
    for (const [jid, contact] of Object.entries(contacts)) {
      if (isValidConversationJid(jid) && contact?.name) {
        contactNames.set(jidNormalizedUser(jid), contact.name)
        validContactsCount++
      }
    }
    syncState.totalContacts = validContactsCount

    // Process chats — use ACTUAL conversationTimestamp for ordering
    // This is the key fix: use the real timestamp from WhatsApp, NOT new Date()
    let chatsProcessed = 0
    for (const chat of chats) {
      if (!isValidConversationJid(chat.id)) continue
      // Skip broadcast lists
      if (isJidBroadcast(chat.id)) continue

      const isGrp = isValidGroupJid(chat.id)
      const contactName = contactNames.get(jidNormalizedUser(chat.id)) || null

      // Use the ACTUAL conversation timestamp from WhatsApp
      const chatTimestamp = chat.conversationTimestamp
        ? new Date(Number(chat.conversationTimestamp) * 1000)
        : null

      if (!conversations.has(chat.id)) {
        conversations.set(chat.id, {
          jid: chat.id,
          name: isGrp ? null : (contactName || null),
          phone: extractPhone(chat.id),
          pushName: null,
          avatarUrl: null,
          lastMessage: null,
          lastMessageAt: chatTimestamp, // ACTUAL timestamp from WhatsApp
          unreadCount: chat.unreadCount || 0,
          isGroup: isGrp,
          groupName: isGrp ? (contactName || null) : null,
          messages: [],
        })
      } else {
        const conv = conversations.get(chat.id)!
        if (!conv.isGroup && contactName && !conv.name) conv.name = contactName
        if (isGrp && contactName && !conv.groupName) conv.groupName = contactName
        // Update timestamp only if the new one is more recent
        if (chatTimestamp && (!conv.lastMessageAt || chatTimestamp > conv.lastMessageAt)) {
          conv.lastMessageAt = chatTimestamp
        }
      }

      // Try to fetch group metadata for group chats
      if (isGrp && !groupMetadataCache.get(chat.id)) {
        try {
          if (waSocket && connectionState.connection === 'open') {
            const metadata = await waSocket.groupMetadata(chat.id)
            groupMetadataCache.set(chat.id, metadata)
            const conv = conversations.get(chat.id)
            if (conv && metadata) {
              conv.groupName = metadata.subject || conv.groupName
              conv.name = metadata.subject || conv.name
              conv.avatarUrl = null // Will be fetched on demand
            }
          }
        } catch {
          // Rate limited or group not accessible, that's OK
        }
      }

      chatsProcessed++
    }
    syncState.totalChats = chatsProcessed

    // Process messages — use ACTUAL message timestamps
    let messagesProcessed = 0
    for (const msg of messages) {
      if (!msg.key) continue
      const jid = msg.key.remoteJid!
      if (!isValidConversationJid(jid)) continue
      if (isJidBroadcast(jid)) continue

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

      // Use the ACTUAL message timestamp from WhatsApp
      const messageTimestamp = new Date((msg.messageTimestamp as number) * 1000 || Date.now())

      // For group messages, extract sender name
      let senderName: string | null = null
      if (conv.isGroup && !fromMe) {
        const participant = msg.key.participant || (msg as any).participant
        if (participant) {
          senderName = contactNames.get(jidNormalizedUser(participant)) || participant.split('@')[0]
        }
      }

      conv.messages.push({
        id: msgId || Math.random().toString(36).substr(2, 9),
        whatsappId: msgId || null,
        fromMe,
        textContent,
        mediaType,
        timestamp: messageTimestamp,
        status: fromMe ? 'delivered' : 'received',
        senderName,
      })

      if (textContent) conv.lastMessage = textContent
      else if (mediaType) conv.lastMessage = `[${mediaType}]`

      // Update lastMessageAt to the ACTUAL message timestamp (if more recent)
      if (!conv.lastMessageAt || messageTimestamp > conv.lastMessageAt) {
        conv.lastMessageAt = messageTimestamp
      }

      messagesProcessed++
    }
    syncState.totalMessages = messagesProcessed

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

      if (isJidBroadcast(jid)) continue
      if (!isValidConversationJid(jid)) continue

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

      // For group messages, extract sender name
      let senderName: string | null = null
      if (conv.isGroup && !fromMe) {
        const participant = msg.key.participant || (msg as any).participant
        if (participant) {
          senderName = contactNames.get(jidNormalizedUser(participant)) || pushName || participant.split('@')[0]
        }
      }

      // Use ACTUAL message timestamp
      const actualTimestamp = new Date((msg.messageTimestamp as number) * 1000 || Date.now())

      const messageData = {
        id: msgId || Math.random().toString(36).substr(2, 9),
        whatsappId: msgId || null,
        fromMe,
        textContent,
        mediaType,
        timestamp: actualTimestamp,
        status: fromMe ? 'delivered' : 'received',
        senderName,
      }

      conv.messages.push(messageData)
      conv.lastMessage = textContent || `[${mediaType}]`
      // Update lastMessageAt to actual message time if more recent
      if (!conv.lastMessageAt || actualTimestamp > conv.lastMessageAt) {
        conv.lastMessageAt = actualTimestamp
      }

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

      // Auto-sync to Odoo — only for individual contacts, NOT groups
      const phone = extractPhone(jid)
      if (phone) {
        triggerAutoSync({
          jid, phone, pushName: conv.pushName, textContent, mediaType, fromMe,
          timestamp: messageData.timestamp.toISOString(),
        })
      }
    }
  })

  // ========== CONTACT EVENTS ==========
  waSocket.ev.on('contacts.upsert', async (contacts) => {
    for (const contact of contacts) {
      if (contact.id && isValidConversationJid(contact.id) && contact.name) {
        contactNames.set(jidNormalizedUser(contact.id), contact.name)
        const conv = conversations.get(contact.id)
        if (conv) {
          if (conv.isGroup) {
            if (!conv.groupName) conv.groupName = contact.name
          } else {
            if (!conv.name) conv.name = contact.name
          }
        }
      }
    }
    emitConversationsList()
  })

  waSocket.ev.on('contacts.update', async (updates) => {
    for (const update of updates) {
      if (update.id && isValidConversationJid(update.id) && update.name) {
        contactNames.set(jidNormalizedUser(update.id), update.name)
        const conv = conversations.get(update.id)
        if (conv) {
          if (conv.isGroup) conv.groupName = update.name
          else conv.name = update.name
        }
      }
    }
    emitConversationsList()
  })

  // ========== CHAT EVENTS ==========
  waSocket.ev.on('chats.upsert', async (chats) => {
    for (const chat of chats) {
      if (!isValidConversationJid(chat.id)) continue
      if (isJidBroadcast(chat.id)) continue

      const isGrp = isValidGroupJid(chat.id)
      const chatTimestamp = chat.conversationTimestamp
        ? new Date(Number(chat.conversationTimestamp) * 1000)
        : null

      if (!conversations.has(chat.id)) {
        const contactName = contactNames.get(jidNormalizedUser(chat.id)) || null
        conversations.set(chat.id, {
          jid: chat.id, name: isGrp ? null : (contactName || null),
          phone: extractPhone(chat.id),
          pushName: null, avatarUrl: null, lastMessage: null,
          lastMessageAt: chatTimestamp, unreadCount: chat.unreadCount || 0,
          isGroup: isGrp, groupName: isGrp ? (contactName || null) : null,
          messages: [],
        })
      } else {
        const conv = conversations.get(chat.id)!
        if (chatTimestamp && (!conv.lastMessageAt || chatTimestamp > conv.lastMessageAt)) {
          conv.lastMessageAt = chatTimestamp
        }
      }
    }
    emitConversationsList()
  })

  waSocket.ev.on('chats.update', async (updates) => {
    for (const update of updates) {
      if (!isValidConversationJid(update.id)) continue
      const conv = conversations.get(update.id)
      if (conv) {
        if (update.unreadCount !== undefined) conv.unreadCount = update.unreadCount
        // Use actual conversation timestamp
        const updateTimestamp = update.conversationTimestamp
          ? new Date(Number(update.conversationTimestamp) * 1000)
          : null
        if (updateTimestamp && (!conv.lastMessageAt || updateTimestamp > conv.lastMessageAt)) {
          conv.lastMessageAt = updateTimestamp
        }
      }
    }
    emitConversationsList()
  })

  // ========== GROUP EVENTS ==========
  waSocket.ev.on('groups.upsert', async (groups) => {
    for (const group of groups) {
      if (!isValidGroupJid(group.id)) continue
      const contactName = contactNames.get(jidNormalizedUser(group.id)) || null

      if (!conversations.has(group.id)) {
        conversations.set(group.id, {
          jid: group.id, name: group.subject || contactName || null,
          phone: null, pushName: null, avatarUrl: null,
          lastMessage: null, lastMessageAt: null,
          unreadCount: 0, isGroup: true,
          groupName: group.subject || contactName || null,
          messages: [],
        })
      } else {
        const conv = conversations.get(group.id)!
        if (group.subject) {
          conv.groupName = group.subject
          conv.name = group.subject
        }
      }
      groupMetadataCache.set(group.id, group)
    }
    emitConversationsList()
  })

  waSocket.ev.on('groups.update', async (updates) => {
    for (const update of updates) {
      if (!update.id) continue
      const conv = conversations.get(update.id)
      if (conv && update.subject) {
        conv.groupName = update.subject
        conv.name = update.subject
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

  // Request QR code — start connection if needed
  socket.on('whatsapp:request-qr', () => {
    console.log('[IO] QR requested by client')
    if (connectionState.connection === 'open') {
      // Already connected, no QR needed
      socket.emit('whatsapp:status', { connected: true, hasSession: true })
    } else if (lastQrCode) {
      // We have a stored QR, send it immediately
      socket.emit('whatsapp:qr', { qr: lastQrCode })
    } else {
      // No QR yet, need to start/restart connection
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
      if (!isValidConversationJid(data.jid)) {
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

      // Auto-sync only for individual contacts, NOT groups
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
      if (!isValidConversationJid(data.jid)) { callback({ success: false, error: 'Invalid contact JID' }); return }

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

  // Disconnect (soft) — just close the browser connection, keep session alive
  // This is like closing WhatsApp Web tab — the phone stays connected
  socket.on('whatsapp:disconnect', async (callback) => {
    try {
      if (waSocket) {
        // DO NOT call logout() — just end the socket connection
        // Session is preserved so next time we auto-reconnect
        try { waSocket.end(undefined) } catch {}
        waSocket = null
        connectionState = { connection: 'close' }
        // Keep: hasSavedSession=true, lastQrCode=null, conversations, contactNames
        // These are all preserved for when the user comes back
        io.emit('whatsapp:status', { connected: false, reason: 'disconnected_by_user', hasSession: hasSavedSession })
        callback({ success: true })
      } else {
        callback({ success: false, error: 'Not connected' })
      }
    } catch (error: any) { callback({ success: false, error: error.message }) }
  })

  // Logout (hard) — removes session, requires QR code next time
  socket.on('whatsapp:logout', async (callback) => {
    try {
      if (waSocket) {
        await waSocket.logout('User requested logout')
        waSocket = null
      }
      connectionState = { connection: 'close' }
      hasSavedSession = false
      lastQrCode = null
      conversations.clear()
      contactNames.clear()
      groupMetadataCache.flushAll()
      io.emit('whatsapp:status', { connected: false, reason: 'logged_out', hasSession: false })
      io.emit('whatsapp:conversations', [])
      callback({ success: true })
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
  // Always try to connect on startup (will auto-reconnect if session exists)
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
