// ============================================================
// Whats-Odoo v7.2 — SINGLE PROCESS SERVER
// Consolidates WhatsApp + Odoo + Next.js into ONE process
// Eliminates inter-process websocket errors on Render
// ============================================================

import { createServer } from 'http'
import { parse } from 'url'
import next from 'next'
import { Server as SocketIOServer } from 'socket.io'
import { execSync } from 'child_process'
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  isJidGroup,
  isJidBroadcast,
  Browsers,
  type WASocket,
  type ConnectionState,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import P from 'pino'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import NodeCache from 'node-cache'
import { createClient, createSecureClient } from 'xmlrpc'

// ============================================================
// CONFIGURATION
// ============================================================
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production'
const dev = process.env.NODE_ENV !== 'production'
const hostname = process.env.HOSTNAME || '0.0.0.0'
const port = parseInt(process.env.PORT || '10000', 10)

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
const AUTH_FOLDER = join(DATA_DIR, 'auth_store')
const waLogger = P({ level: 'silent' })

if (!existsSync(AUTH_FOLDER)) {
  mkdirSync(AUTH_FOLDER, { recursive: true })
}

// ============================================================
// WHATSAPP STATE
// ============================================================
let waSocket: WASocket | null = null
let connectionState: ConnectionState = {
  connection: 'close',
  lastDisconnect: undefined,
}
let hasSavedSession = existsSync(join(AUTH_FOLDER, 'creds.json'))
let lastQrCode: string | null = null
const groupMetadataCache = new NodeCache({ stdTtl: 300, useClones: false })

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
const contactNames = new Map<string, string>()

// ============================================================
// ODOO STATE
// ============================================================
let odooConfig: {
  url: string
  db: string
  username: string
  password: string
  uid: number | null
} = {
  url: '',
  db: '',
  username: '',
  password: '',
  uid: null,
}

interface AutoSyncSettings {
  enabled: boolean
  autoCreateContact: boolean
  autoCreateLead: boolean
  autoCreateActivity: boolean
  leadPrefix: string
  leadTeamId: number | null
  leadUserId: number | null
}

let autoSyncSettings: AutoSyncSettings = {
  enabled: true,
  autoCreateContact: true,
  autoCreateLead: true,
  autoCreateActivity: true,
  leadPrefix: '[WhatsApp] ',
  leadTeamId: null,
  leadUserId: null,
}

const modelFieldsCache = new Map<string, Set<string>>()
const phoneToPartnerCache = new Map<string, { partnerId: number; leadId: number | null; leadCreated: boolean }>()

// ============================================================
// SOCKET.IO SERVER (single instance, no bridge)
// ============================================================

// Initialize DB schema before starting
try {
  console.log('[Server] Initializing database...')
  execSync('npx prisma db push --skip-generate', { stdio: 'inherit' })
  console.log('[Server] Database ready')
} catch (err: any) {
  console.log('[Server] DB init warning:', err.message)
}

const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()

app.prepare().then(() => {
  const httpServer = createServer((req, res) => {
    const parsedUrl = parse(req.url, true)
    handle(req, res, parsedUrl)
  })

  const io = new SocketIOServer(httpServer, {
    path: '/socket.io',
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 60000,
    pingInterval: 25000,
  })

  const waNamespace = io.of('/whatsapp')
  const odooNamespace = io.of('/odoo')

  // Initialize WhatsApp and Odoo (direct, no bridge)
  initWhatsApp(waNamespace, odooNamespace)
  initOdoo(odooNamespace)

  // Auto-authenticate Odoo from env vars
  autoAuthenticateOdoo(odooNamespace)

  httpServer.listen(port, hostname, () => {
    console.log(`[Server] > Ready on http://${hostname}:${port}`)
    console.log(`[Server] WhatsApp namespace: /whatsapp`)
    console.log(`[Server] Odoo namespace: /odoo`)
  })
})

// ============================================================
// WHATSAPP HELPER FUNCTIONS
// ============================================================
function isValidPhoneJid(jid: string): boolean {
  if (!jid.endsWith('@s.whatsapp.net')) return false
  const numPart = jid.split('@')[0]
  return /^\d{7,}$/.test(numPart)
}

function isValidGroupJid(jid: string): boolean {
  return isJidGroup(jid)
}

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
      lastMessageAt: null,
      unreadCount: 0,
      isGroup: isGrp,
      groupName: isGrp ? cachedName : null,
      messages: [],
    })
  }
  const conv = conversations.get(jid)!
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

// ============================================================
// WHATSAPP CONNECTION (Baileys)
// ============================================================
function initWhatsApp(waNs: ReturnType<import('socket.io')['Server']['of']>, odooNs: ReturnType<import('socket.io')['Server']['of']>) {

  function emitConversationsList() {
    waNs.emit('whatsapp:conversations', getSortedConversations())
  }

  // Auto-sync to Odoo — DIRECT call, no socket.io relay
  function triggerAutoSync(data: {
    jid: string
    phone: string
    pushName: string | null
    textContent: string | null
    mediaType: string | null
    fromMe: boolean
    timestamp: string
  }) {
    if (isValidGroupJid(data.jid)) return
    if (!odooConfig.uid || !autoSyncSettings.enabled) return

    autoSyncWhatsAppMessage(data).then(result => {
      if (result.partnerId || result.leadId) {
        console.log(`[AutoSync] OK for ${data.phone}: partner=${result.partnerId} lead=${result.leadId}`)
        waNs.emit('whatsapp:odoo-sync', {
          jid: data.jid, phone: data.phone,
          partnerId: result.partnerId, leadId: result.leadId,
          created: result.created, errors: result.errors,
        })
      }
    }).catch(err => {
      console.error(`[AutoSync] Error for ${data.phone}:`, err.message)
    })
  }

  async function connectWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER)
    let version: [number, number, number] = [2, 3000, 1015] // fallback
    try {
      const fetched = await fetchLatestBaileysVersion()
      version = fetched.version
      console.log(`[WA] Using Baileys version: ${version.join('.')}`)
    } catch (err: any) {
      console.log(`[WA] Could not fetch latest version, using fallback: ${err.message}`)
    }

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
      keepAliveIntervalMs: 25_000,
      markOnlineOnConnect: true,
      syncFullHistory: false,
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

    waSocket.ev.on('creds.update', saveCreds)

    // ========== Connection Events ==========
    waSocket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update
      connectionState = { connection, lastDisconnect }
      console.log(`[WA] Connection update: ${connection}`)

      if (qr) {
        lastQrCode = qr
        console.log('[WA] QR Code generated, sending to clients')
        waNs.emit('whatsapp:qr', { qr })
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

        waNs.emit('whatsapp:status', {
          connected: false,
          reason: statusCode === DisconnectReason.loggedOut ? 'logged_out' : 'reconnecting',
          hasSession: hasSavedSession,
        })

        if (shouldReconnect) {
          const delay = statusCode === DisconnectReason.connectionClosed ? 2000 : 5000
          setTimeout(() => connectWhatsApp(), delay)
        }
      }

      if (connection === 'open') {
        console.log('[WA] Connected successfully!')
        hasSavedSession = true
        lastQrCode = null
        waNs.emit('whatsapp:status', { connected: true, hasSession: true })

        try {
          const meId = waSocket!.user?.id
          if (meId) {
            const profilePicUrl = await waSocket!.profilePictureUrl(meId, 'image').catch(() => null)
            waNs.emit('whatsapp:me', {
              id: meId,
              name: waSocket!.user?.name,
              profilePicUrl,
            })
          }
        } catch {}

        emitConversationsList()
      }
    })

    // ========== HISTORY SYNC ==========
    waSocket.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest, progress, syncType }) => {
      console.log(`[WA] History sync: type=${syncType}, progress=${progress}%, chats=${chats.length}, contacts=${Object.keys(contacts).length}, messages=${messages.length}`)

      syncState.isSyncing = true
      syncState.progress = progress || 0

      waNs.emit('whatsapp:sync-progress', {
        isSyncing: true,
        progress: progress || 0,
        phase: syncType || 'historical',
        chatsCount: chats.length,
        contactsCount: Object.keys(contacts).length,
      })

      let validContactsCount = 0
      for (const [jid, contact] of Object.entries(contacts)) {
        if (isValidConversationJid(jid) && contact?.name) {
          contactNames.set(jidNormalizedUser(jid), contact.name)
          validContactsCount++
        }
      }
      syncState.totalContacts = validContactsCount

      let chatsProcessed = 0
      for (const chat of chats) {
        if (!isValidConversationJid(chat.id)) continue
        if (isJidBroadcast(chat.id)) continue

        const isGrp = isValidGroupJid(chat.id)
        const contactName = contactNames.get(jidNormalizedUser(chat.id)) || null
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
            lastMessageAt: chatTimestamp,
            unreadCount: chat.unreadCount || 0,
            isGroup: isGrp,
            groupName: isGrp ? (contactName || null) : null,
            messages: [],
          })
        } else {
          const conv = conversations.get(chat.id)!
          if (!conv.isGroup && contactName && !conv.name) conv.name = contactName
          if (isGrp && contactName && !conv.groupName) conv.groupName = contactName
          if (chatTimestamp && (!conv.lastMessageAt || chatTimestamp > conv.lastMessageAt)) {
            conv.lastMessageAt = chatTimestamp
          }
        }

        if (isGrp && !groupMetadataCache.get(chat.id)) {
          try {
            if (waSocket && connectionState.connection === 'open') {
              const metadata = await waSocket.groupMetadata(chat.id)
              groupMetadataCache.set(chat.id, metadata)
              const conv = conversations.get(chat.id)
              if (conv && metadata) {
                conv.groupName = metadata.subject || conv.groupName
                conv.name = metadata.subject || conv.name
              }
            }
          } catch {}
        }
        chatsProcessed++
      }
      syncState.totalChats = chatsProcessed

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

        const messageTimestamp = new Date((msg.messageTimestamp as number) * 1000 || Date.now())

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
        waNs.emit('whatsapp:sync-progress', {
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

        let senderName: string | null = null
        if (conv.isGroup && !fromMe) {
          const participant = msg.key.participant || (msg as any).participant
          if (participant) {
            senderName = contactNames.get(jidNormalizedUser(participant)) || pushName || participant.split('@')[0]
          }
        }

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

        waNs.emit('whatsapp:message', {
          conversationJid: jid, message: messageData, conversation: serializeConversation(conv),
        })
        waNs.emit('whatsapp:conversation:update', serializeConversation(conv))

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

  // ========== Socket.io Client Events (WhatsApp namespace) ==========
  waNs.on('connection', (socket) => {
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
        connectWhatsApp()
      }
    })

    socket.on('whatsapp:get-messages', (data: { jid: string }, callback) => {
      const conv = conversations.get(data.jid)
      callback({ messages: conv ? conv.messages.slice(-100) : [] })
    })

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

        waNs.emit('whatsapp:message', { conversationJid: data.jid, message: messageData, conversation: serializeConversation(conv) })

        const phone = extractPhone(data.jid)
        if (phone) triggerAutoSync({ jid: data.jid, phone, pushName: conv.pushName, textContent: data.text, mediaType: null, fromMe: true, timestamp: messageData.timestamp.toISOString() })

        callback({ success: true, messageId: sent.key.id })
      } catch (error: any) {
        callback({ success: false, error: error.message })
      }
    })

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

        waNs.emit('whatsapp:message', { conversationJid: data.jid, message: messageData, conversation: serializeConversation(conv) })
        callback({ success: true, messageId: sent.key.id })
      } catch (error: any) {
        callback({ success: false, error: error.message })
      }
    })

    socket.on('whatsapp:mark-read', async (data: { jid: string }, callback) => {
      try {
        if (!waSocket || connectionState.connection !== 'open') { callback({ success: false, error: 'WhatsApp not connected' }); return }
        const conv = conversations.get(data.jid)
        if (conv) { conv.unreadCount = 0; waNs.emit('whatsapp:conversation:update', serializeConversation(conv)) }
        await waSocket.readMessages([{ remoteJid: data.jid, id: '' }])
        callback({ success: true })
      } catch (error: any) { callback({ success: false, error: error.message }) }
    })

    socket.on('whatsapp:disconnect', async (callback) => {
      try {
        if (waSocket) {
          try { waSocket.end(undefined) } catch {}
          waSocket = null
          connectionState = { connection: 'close' }
          waNs.emit('whatsapp:status', { connected: false, reason: 'disconnected_by_user', hasSession: hasSavedSession })
          callback({ success: true })
        } else {
          callback({ success: false, error: 'Not connected' })
        }
      } catch (error: any) { callback({ success: false, error: error.message }) }
    })

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
        waNs.emit('whatsapp:status', { connected: false, reason: 'logged_out', hasSession: false })
        waNs.emit('whatsapp:conversations', [])
        callback({ success: true })
      } catch (error: any) { callback({ success: false, error: error.message }) }
    })

    socket.on('whatsapp:get-profile-pic', async (data: { jid: string }, callback) => {
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

  // Start WhatsApp connection on startup (auto-reconnect if session exists)
  console.log(`[WA] Starting... Auth: ${AUTH_FOLDER}, Has session: ${hasSavedSession}`)
  connectWhatsApp().catch(err => {
    console.error('[WA] Initial connection failed:', err.message)
    // Retry after delay
    setTimeout(() => connectWhatsApp(), 10000)
  })
}

// ============================================================
// ODOO INTEGRATION (XML-RPC) — IDENTICAL LOGIC
// ============================================================
function makeXmlRpcClient(path: string) {
  const url = new URL(odooConfig.url)
  const isHttps = url.protocol === 'https:'
  const options = {
    host: url.hostname,
    port: parseInt(url.port) || (isHttps ? 443 : 80),
    path,
  }
  return isHttps ? createSecureClient(options) : createClient(options)
}

function getOdooClient(path: string = '/xmlrpc/2/object') {
  return makeXmlRpcClient(path)
}

function odooAuthenticate(): Promise<number> {
  return new Promise((resolve, reject) => {
    const client = makeXmlRpcClient('/xmlrpc/2/common')
    client.methodCall('authenticate', [
      odooConfig.db, odooConfig.username, odooConfig.password, {},
    ], (error: any, value: any) => {
      if (error) reject(error)
      else if (!value) reject(new Error('Authentication failed - invalid credentials'))
      else resolve(value)
    })
  })
}

function odooExecuteKw(model: string, method: string, args: any[], kwargs: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!odooConfig.uid) { reject(new Error('Not authenticated with Odoo')); return }
    const client = getOdooClient()
    client.methodCall('execute_kw', [
      odooConfig.db, odooConfig.uid, odooConfig.password, model, method, args, kwargs,
    ], (error: any, value: any) => {
      if (error) reject(error)
      else resolve(value)
    })
  })
}

async function getAvailableFields(model: string): Promise<Set<string>> {
  if (modelFieldsCache.has(model)) return modelFieldsCache.get(model)!
  try {
    const fields = await odooExecuteKw(model, 'fields_get', [], { attributes: ['string', 'type'] })
    const fieldNames = new Set(Object.keys(fields))
    modelFieldsCache.set(model, fieldNames)
    return fieldNames
  } catch (error: any) {
    console.error(`[Odoo] Failed to get fields for ${model}:`, error.message)
    return new Set()
  }
}

async function filterExistingFields(model: string, requestedFields: string[]): Promise<string[]> {
  const available = await getAvailableFields(model)
  const existing = requestedFields.filter(f => available.has(f))
  if (!existing.includes('id') && available.has('id')) existing.unshift('id')
  if (!existing.includes('name') && available.has('name')) existing.push('name')
  return existing
}

async function buildSafeValues(model: string, values: Record<string, any>): Promise<Record<string, any>> {
  const available = await getAvailableFields(model)
  const safe: Record<string, any> = {}
  for (const [key, value] of Object.entries(values)) {
    if (available.has(key)) safe[key] = value
    else console.log(`[Odoo] Field "${key}" does not exist on ${model}, skipping`)
  }
  return safe
}

async function smartWriteWhatsAppNumber(model: string, ids: number[], phone: string): Promise<boolean> {
  const available = await getAvailableFields(model)
  const values: Record<string, any> = {}
  if (available.has('whatsapp')) values.whatsapp = phone
  if (available.has('whatsapp_number')) values.whatsapp_number = phone
  if (available.has('phone')) values.phone = phone
  if (available.has('mobile') && !values.whatsapp) values.mobile = phone
  if (Object.keys(values).length === 0) return false
  return odooWrite(model, ids, values)
}

async function odooSearch(model: string, domain: any[], fields: string[] = [], limit: number = 80, offset: number = 0): Promise<any[]> {
  const safeFields = fields.length > 0 ? await filterExistingFields(model, fields) : []
  return odooExecuteKw(model, 'search_read', [domain], {
    fields: safeFields.length > 0 ? safeFields : undefined, limit, offset,
  })
}

async function odooRead(model: string, ids: number[], fields: string[] = []): Promise<any[]> {
  const safeFields = fields.length > 0 ? await filterExistingFields(model, fields) : []
  return odooExecuteKw(model, 'read', [ids], { fields: safeFields.length > 0 ? safeFields : undefined })
}

async function odooCreate(model: string, values: Record<string, any>): Promise<number> {
  const safeValues = await buildSafeValues(model, values)
  return odooExecuteKw(model, 'create', [safeValues])
}

async function odooWrite(model: string, ids: number[], values: Record<string, any>): Promise<boolean> {
  const safeValues = await buildSafeValues(model, values)
  return odooExecuteKw(model, 'write', [ids, safeValues])
}

async function odooSearchOrCreate(model: string, domain: any[], values: Record<string, any>): Promise<{ id: number; created: boolean }> {
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

async function odooPostMessage(model: string, recordId: number, message: string): Promise<any> {
  return odooExecuteKw(model, 'message_post', [recordId], {
    body: message, message_type: 'comment', subtype_xmlid: 'mail.mt_comment',
  })
}

async function odooCreateActivity(model: string, recordId: number, summary: string, note: string): Promise<number> {
  try {
    const activityTypeId = await findWhatsAppActivityType()
    const values: Record<string, any> = {
      res_model: model, res_id: recordId, summary, note,
      activity_type_id: activityTypeId || 1,
    }
    if (autoSyncSettings.leadUserId) values.user_id = autoSyncSettings.leadUserId
    return await odooExecuteKw('mail.activity', 'create', [values])
  } catch (error: any) {
    console.error(`[Odoo] Failed to create activity:`, error.message)
    return 0
  }
}

async function findWhatsAppActivityType(): Promise<number | null> {
  try {
    const types = await odooExecuteKw('mail.activity.type', 'search_read', [
      [['name', 'ilike', 'WhatsApp']],
    ], { fields: ['id', 'name'], limit: 1 })
    if (types && types.length > 0) return types[0].id
  } catch {}
  return null
}

async function odooGetFields(model: string, attributes: string[] = ['string', 'help', 'type', 'required', 'readonly']): Promise<any> {
  return odooExecuteKw(model, 'fields_get', [], { attributes })
}

// ============================================================
// AUTO-SYNC ENGINE (NO per-message chatter posting)
// ============================================================
async function autoSyncWhatsAppMessage(data: {
  jid: string
  phone: string
  pushName?: string | null
  textContent?: string | null
  mediaType?: string | null
  fromMe: boolean
  timestamp: string
}): Promise<{
  partnerId: number | null
  leadId: number | null
  created: { partner: boolean; lead: boolean }
  errors: string[]
}> {
  const result = {
    partnerId: null as number | null,
    leadId: null as number | null,
    created: { partner: false, lead: false },
    errors: [] as string[],
  }

  if (!autoSyncSettings.enabled || !odooConfig.uid) return result

  console.log(`[AutoSync] Processing message from ${data.phone} (${data.pushName || 'unknown'})`)

  try {
    // Step 1: Create or update contact in res.partner
    if (autoSyncSettings.autoCreateContact) {
      const contactName = data.pushName || `WhatsApp ${data.phone}`
      const domain = ['|', ['phone', 'ilike', data.phone], ['mobile', 'ilike', data.phone]]
      const contactValues: Record<string, any> = {
        name: contactName, phone: data.phone, mobile: data.phone,
      }

      const partnerFields = await getAvailableFields('res.partner')
      if (partnerFields.has('whatsapp')) contactValues.whatsapp = data.phone
      if (partnerFields.has('whatsapp_number')) contactValues.whatsapp_number = data.phone

      const partnerResult = await odooSearchOrCreate('res.partner', domain, contactValues)
      result.partnerId = partnerResult.id
      result.created.partner = partnerResult.created

      const cached = phoneToPartnerCache.get(data.phone)
      if (cached) cached.partnerId = partnerResult.id
      else phoneToPartnerCache.set(data.phone, { partnerId: partnerResult.id, leadId: null, leadCreated: false })

      console.log(`[AutoSync] Contact ${partnerResult.created ? 'created' : 'updated'}: res.partner#${partnerResult.id}`)
    }

    // Step 2: Create lead in crm.lead for new conversations
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
          const leadValues: Record<string, any> = {
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

          if (cached) { cached.leadId = result.leadId; cached.leadCreated = true }
          else phoneToPartnerCache.set(data.phone, { partnerId: result.partnerId, leadId: result.leadId, leadCreated: true })

          console.log(`[AutoSync] Lead created: crm.lead#${result.leadId}`)
        }
      }
    }

    // Step 3: REMOVED — No longer posting individual messages to chatter
    // User requested: "apenas leve toda conversa para o campo description como ja faz"

    // Step 4: Create activity notification for the first message of a new lead
    if (autoSyncSettings.autoCreateActivity && result.created.lead && result.leadId) {
      const summary = 'Nova mensagem WhatsApp'
      const note = `Contato ${data.pushName || data.phone} iniciou uma conversa via WhatsApp.\n\nMensagem: ${data.textContent || '[Midia]'}`
      try {
        await odooCreateActivity('crm.lead', result.leadId, summary, note)
        console.log(`[AutoSync] Activity created for lead #${result.leadId}`)
      } catch (error: any) {
        result.errors.push(`Failed to create activity: ${error.message}`)
      }
    }

  } catch (error: any) {
    result.errors.push(`Auto-sync error: ${error.message}`)
    console.error(`[AutoSync] Error:`, error.message)
  }

  return result
}

// ============================================================
// ODOO SOCKET.IO EVENTS
// ============================================================
function initOdoo(odooNs: ReturnType<import('socket.io')['Server']['of']>) {
  odooNs.on('connection', (socket) => {
    console.log(`[Odoo IO] Client connected: ${socket.id}`)

    socket.emit('odoo:status', {
      connected: !!odooConfig.uid, url: odooConfig.url, db: odooConfig.db, username: odooConfig.username,
    })
    socket.emit('odoo:autosync:settings', autoSyncSettings)

    // Authentication
    socket.on('odoo:authenticate', async (data: { url: string; db: string; username: string; password: string }, callback) => {
      try {
        odooConfig = { ...data, uid: null }
        modelFieldsCache.clear()
        phoneToPartnerCache.clear()
        const uid = await odooAuthenticate()
        odooConfig.uid = uid
        console.log(`[Odoo] Authenticated as ${data.username} (uid: ${uid})`)
        await getAvailableFields('res.partner')
        await getAvailableFields('crm.lead')
        odooNs.emit('odoo:status', { connected: true, url: odooConfig.url, db: odooConfig.db, username: odooConfig.username })
        callback({ success: true, uid })
      } catch (error: any) {
        console.error('[Odoo] Auth error:', error.message)
        callback({ success: false, error: error.message })
      }
    })

    // Disconnect
    socket.on('odoo:disconnect', (callback) => {
      odooConfig = { url: '', db: '', username: '', password: '', uid: null }
      modelFieldsCache.clear()
      phoneToPartnerCache.clear()
      odooNs.emit('odoo:status', { connected: false })
      callback({ success: true })
    })

    // Auto-Sync Settings
    socket.on('odoo:autosync:update-settings', async (data: Partial<AutoSyncSettings>, callback) => {
      try {
        autoSyncSettings = { ...autoSyncSettings, ...data }
        console.log('[Odoo] Auto-sync settings updated:', autoSyncSettings)
        odooNs.emit('odoo:autosync:settings', autoSyncSettings)
        callback({ success: true, settings: autoSyncSettings })
      } catch (error: any) {
        callback({ success: false, error: error.message })
      }
    })

    socket.on('odoo:autosync:get-settings', (callback) => {
      callback({ success: true, settings: autoSyncSettings })
    })

    // Auto-Sync Trigger
    socket.on('odoo:autosync:message', async (data: { jid: string; phone: string; pushName?: string | null; textContent?: string | null; mediaType?: string | null; fromMe: boolean; timestamp: string }, callback) => {
      console.log(`[Odoo] Auto-sync message received from ${data.phone}`)
      try {
        const result = await autoSyncWhatsAppMessage(data)
        if (callback) callback({ success: true, ...result })
      } catch (error: any) {
        console.error('[Odoo] Auto-sync error:', error.message)
        if (callback) callback({ success: false, error: error.message })
      }
    })

    // Contacts
    socket.on('odoo:contacts:search', async (data: { query?: string; limit?: number }, callback) => {
      try {
        const domain = data.query ? ['|', '|', ['name', 'ilike', data.query], ['phone', 'ilike', data.query], ['mobile', 'ilike', data.query]] : []
        const records = await odooSearch('res.partner', domain, ['name', 'phone', 'mobile', 'email', 'whatsapp', 'image_128', 'is_company', 'country_id', 'state_id', 'city'], data.limit || 20)
        callback({ success: true, data: records })
      } catch (error: any) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:contacts:create', async (data: { name: string; phone?: string; mobile?: string; whatsapp?: string; email?: string }, callback) => {
      try {
        const values: Record<string, any> = { name: data.name }
        if (data.phone) values.phone = data.phone
        if (data.mobile) values.mobile = data.mobile
        if (data.whatsapp) values.whatsapp = data.whatsapp
        if (data.email) values.email = data.email
        const id = await odooCreate('res.partner', values)
        callback({ success: true, id })
        odooNs.emit('odoo:record:created', { model: 'res.partner', id, values })
      } catch (error: any) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:contacts:search-or-create', async (data: { phone: string; name?: string }, callback) => {
      try {
        const domain = ['|', ['phone', 'ilike', data.phone], ['mobile', 'ilike', data.phone]]
        const values: Record<string, any> = { name: data.name || `WhatsApp ${data.phone}`, phone: data.phone, mobile: data.phone }
        const result = await odooSearchOrCreate('res.partner', domain, values)
        callback({ success: true, ...result })
      } catch (error: any) { callback({ success: false, error: error.message }) }
    })

    // CRM Leads
    socket.on('odoo:leads:search', async (data: { query?: string; limit?: number }, callback) => {
      try {
        const domain = data.query ? ['|', ['name', 'ilike', data.query], ['partner_name', 'ilike', data.query]] : []
        const records = await odooSearch('crm.lead', domain, ['name', 'partner_id', 'partner_name', 'phone', 'mobile', 'email_from', 'type', 'stage_id', 'probability', 'user_id', 'team_id', 'create_date', 'write_date', 'whatsapp_number'], data.limit || 20)
        callback({ success: true, data: records })
      } catch (error: any) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:leads:create', async (data: { name: string; phone?: string; partner_id?: number; partner_name?: string; description?: string; type?: string; whatsapp_number?: string }, callback) => {
      try {
        const values: Record<string, any> = { name: data.name, type: data.type || 'lead' }
        if (data.phone) values.phone = data.phone
        if (data.partner_id) values.partner_id = data.partner_id
        if (data.partner_name) values.partner_name = data.partner_name
        if (data.description) values.description = data.description
        if (data.whatsapp_number) values.whatsapp_number = data.whatsapp_number
        const id = await odooCreate('crm.lead', values)
        callback({ success: true, id })
        odooNs.emit('odoo:record:created', { model: 'crm.lead', id, values })
      } catch (error: any) { callback({ success: false, error: error.message }) }
    })

    // Sales
    socket.on('odoo:sales:search', async (data: { query?: string; limit?: number }, callback) => {
      try {
        const domain = data.query ? ['|', ['name', 'ilike', data.query], ['partner_id', 'ilike', data.query]] : []
        const records = await odooSearch('sale.order', domain, ['name', 'partner_id', 'state', 'date_order', 'amount_total', 'user_id', 'team_id', 'whatsapp_number'], data.limit || 20)
        callback({ success: true, data: records })
      } catch (error: any) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:sales:create', async (data: { partner_id: number; whatsapp_number?: string }, callback) => {
      try {
        const values: Record<string, any> = { partner_id: data.partner_id }
        if (data.whatsapp_number) values.whatsapp_number = data.whatsapp_number
        const id = await odooCreate('sale.order', values)
        callback({ success: true, id })
        odooNs.emit('odoo:record:created', { model: 'sale.order', id, values })
      } catch (error: any) { callback({ success: false, error: error.message }) }
    })

    // Projects
    socket.on('odoo:projects:search', async (data: { query?: string; project_id?: number; limit?: number }, callback) => {
      try {
        const domain: any[] = []
        if (data.query) domain.push('|', ['name', 'ilike', data.query], ['description', 'ilike', data.query])
        if (data.project_id) domain.push(['project_id', '=', data.project_id])
        const records = await odooSearch('project.task', domain, ['name', 'description', 'project_id', 'stage_id', 'user_ids', 'partner_id', 'priority', 'create_date', 'date_deadline', 'whatsapp_number'], data.limit || 20)
        callback({ success: true, data: records })
      } catch (error: any) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:projects:create', async (data: { name: string; project_id?: number; partner_id?: number; description?: string; whatsapp_number?: string }, callback) => {
      try {
        const values: Record<string, any> = { name: data.name }
        if (data.project_id) values.project_id = data.project_id
        if (data.partner_id) values.partner_id = data.partner_id
        if (data.description) values.description = data.description
        if (data.whatsapp_number) values.whatsapp_number = data.whatsapp_number
        const id = await odooCreate('project.task', values)
        callback({ success: true, id })
        odooNs.emit('odoo:record:created', { model: 'project.task', id, values })
      } catch (error: any) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:projects:list', async (data: { limit?: number }, callback) => {
      try {
        const records = await odooSearch('project.project', [], ['name', 'label_tasks', 'user_id', 'partner_id'], data.limit || 50)
        callback({ success: true, data: records })
      } catch (error: any) { callback({ success: false, error: error.message }) }
    })

    // Link WhatsApp conversation to Odoo record
    socket.on('odoo:link-conversation', async (data: { jid: string; model: string; recordId: number; phone?: string }, callback) => {
      try {
        const phone = data.phone || data.jid.split('@')[0]
        await smartWriteWhatsAppNumber(data.model, [data.recordId], phone)
        try {
          await odooPostMessage(data.model, data.recordId,
            `<p><strong>[WhatsApp Middleware]</strong> Conversa vinculada — Numero: ${phone}</p>`)
        } catch {}
        callback({ success: true })
        odooNs.emit('odoo:conversation:linked', { jid: data.jid, model: data.model, recordId: data.recordId })
      } catch (error: any) { callback({ success: false, error: error.message }) }
    })

    // Log message in Odoo (manual, user-initiated only)
    socket.on('odoo:log-message', async (data: { model: string; recordId: number; message: string; fromWhatsApp?: boolean }, callback) => {
      try {
        const body = data.fromWhatsApp
          ? `<p><strong>[WhatsApp]</strong> ${data.message}</p>`
          : data.message
        await odooPostMessage(data.model, data.recordId, body)
        callback({ success: true })
      } catch (error: any) { callback({ success: false, error: error.message }) }
    })

    // Get model fields
    socket.on('odoo:fields', async (data: { model: string }, callback) => {
      try {
        const fields = await odooGetFields(data.model)
        callback({ success: true, data: fields })
      } catch (error: any) { callback({ success: false, error: error.message }) }
    })

    // Check if custom fields exist
    socket.on('odoo:check-fields', async (data: { model: string; fields: string[] }, callback) => {
      try {
        const available = await getAvailableFields(data.model)
        const result: Record<string, boolean> = {}
        for (const field of data.fields) result[field] = available.has(field)
        callback({ success: true, data: result })
      } catch (error: any) { callback({ success: false, error: error.message }) }
    })

    // Generic CRUD
    socket.on('odoo:search', async (data: { model: string; domain: any[]; fields?: string[]; limit?: number }, callback) => {
      try {
        const records = await odooSearch(data.model, data.domain, data.fields || [], data.limit || 20)
        callback({ success: true, data: records })
      } catch (error: any) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:read', async (data: { model: string; ids: number[]; fields?: string[] }, callback) => {
      try {
        const records = await odooRead(data.model, data.ids, data.fields || [])
        callback({ success: true, data: records })
      } catch (error: any) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:write', async (data: { model: string; ids: number[]; values: Record<string, any> }, callback) => {
      try {
        const result = await odooWrite(data.model, data.ids, data.values)
        callback({ success: true, data: result })
      } catch (error: any) { callback({ success: false, error: error.message }) }
    })

    // Teams & Users
    socket.on('odoo:teams:search', async (data: { limit?: number }, callback) => {
      try {
        const records = await odooSearch('crm.team', [], ['name', 'user_id'], data.limit || 20)
        callback({ success: true, data: records })
      } catch (error: any) { callback({ success: false, error: error.message }) }
    })

    socket.on('odoo:users:search', async (data: { limit?: number }, callback) => {
      try {
        const records = await odooSearch('res.users', [], ['name', 'login', 'image_128'], data.limit || 20)
        callback({ success: true, data: records })
      } catch (error: any) { callback({ success: false, error: error.message }) }
    })

    socket.on('disconnect', () => console.log(`[Odoo IO] Client disconnected: ${socket.id}`))
  })
}

// ============================================================
// ODOO AUTO-AUTHENTICATE FROM ENV VARS
// ============================================================
async function autoAuthenticateOdoo(odooNs: ReturnType<import('socket.io')['Server']['of']>) {
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
      odooNs.emit('odoo:status', { connected: true, url: odooConfig.url, db: odooConfig.db, username: odooConfig.username })
    } catch (error: any) {
      console.error(`[Odoo] Auto-authentication failed: ${error.message}`)
    }
  }
}

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================
process.on('SIGTERM', () => {
  if (waSocket) waSocket.end(undefined)
  process.exit(0)
})
process.on('SIGINT', () => {
  if (waSocket) waSocket.end(undefined)
  process.exit(0)
})
