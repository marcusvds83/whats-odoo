// ====================================================================
// Whats-Odoo v7.23 — SINGLE-PROCESS SERVER (per-user sessions)
// --------------------------------------------------------------------
// Everything in one process: Next.js + WhatsApp (Baileys) + Odoo (XML-RPC)
// Designed for Render 512MB RAM.
//
// v7.23 changes:
//   - PER-USER WhatsApp + Odoo sessions. Each logged-in user has their
//     own Baileys socket, conversation state, and Odoo connection.
//     Encapsulated in src/server/user-session.js (UserSession class).
//   - The SessionManager lazily creates/starts a UserSession on the
//     first socket.io connection from a logged-in user.
//   - socket.io auth middleware on BOTH /whatsapp and /odoo namespaces
//     verifies the JWT (from cookie or handshake auth.token) and
//     attaches `socket.userId` + `socket.userSession`. Events are
//     routed to the user's session only — no cross-user leakage.
//   - Per-user paths: data/auth_<userId>/creds.json + data/conv_state_<userId>.json
//   - Per-user Odoo config (from User.odooUrl etc.), falling back to
//     the global OdooConfig row if all per-user fields are empty.
//   - Admin user is just a regular user from the server's perspective;
//     admin-specific UI (managing other users) lives in /api/users +
//     the UsersPanel component (already done in v7.22 phase 2).
//
// v7.22 changes (preserved):
//   - Media features: audio player, image viewer, emoji picker, file upload
//     (served from /media/<filename> — files stored in data/media/).
//   - Multi-user auth: login page, JWT cookies, /api/auth/* routes,
//     /api/users CRUD, admin UsersPanel, src/middleware.ts route guard,
//     AuthProvider context.
//
// v7.21 changes (preserved, now per-user):
//   - "Reconnect brings back history" — Odoo chatter is the durable
//     conversation database. On every WA reconnect (and on every Odoo
//     auth success), the middleware scans all res.partner records that
//     have WhatsApp chatter messages and pulls them back into the
//     local conversation state. Survives deploys, crashes, disk wipes.
//
// v7.20 / v7.19 / v7.17-v7.18 changes (preserved, now per-user):
//   - Reverted contacts/conversations separation (unified list)
//   - Fixed Odoo 19.4 "Invalid field res.partner.mobile" via buildPhoneSearchDomain
//   - autoCreateLead default = false
//   - Session persistence across deploys (per-user JSON file)
//   - LID JID resolution (senderPn fallback for incoming DMs)
//   - Odoo auto-auth retry (3 attempts then 60s background loop)
// ====================================================================

const { createServer } = require('http')
const { parse } = require('url')
const next = require('next')
const { Server } = require('socket.io')
const path = require('path')
const fs = require('fs')
const { PrismaClient } = require('@prisma/client')

// v7.23: Per-user session manager + auth helpers (CommonJS)
const { SessionManager, DATA_DIR } = require('./src/server/user-session.js')
const { loadUserById } = require('./src/server/user-lookup.cjs')
const { getSessionCookieName, parseCookies, verifySession } = require('./src/lib/auth-edge.cjs')

// Ensure production mode on Render
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production'
const dev = process.env.NODE_ENV !== 'production'
const hostname = process.env.HOSTNAME || '0.0.0.0'
const port = parseInt(process.env.PORT || '10000', 10)

const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()

// ========== Paths ==========
const MEDIA_DIR = path.join(DATA_DIR, 'media')

// Create directories on startup
function ensureDirs() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch {}
  try { fs.mkdirSync(MEDIA_DIR, { recursive: true }) } catch {}
}
ensureDirs()

console.log(`[Server] v7.23 — Whats-Odoo single-process server`)
console.log(`[Server] Data dir: ${DATA_DIR}`)
console.log(`[Server] Media dir: ${MEDIA_DIR}`)

// v7.23: Shared Prisma client + SessionManager — both live for the
// lifetime of the process. Each UserSession gets the same PrismaClient
// (Prisma internally pools connections).
const prisma = new PrismaClient()
let sessionManager = null  // initialized after socket.io is created

// v7.17: Persistence diagnostics — verify the data dir is writable.
function runPersistenceDiagnostics() {
  try {
    const testFile = path.join(DATA_DIR, '.write-test')
    fs.writeFileSync(testFile, `persist-test-${Date.now()}`)
    fs.unlinkSync(testFile)
    console.log(`[Server] ✓ Data dir is writable: ${DATA_DIR}`)
  } catch (err) {
    console.error(`[Server] ✗ Persistence diagnostics FAILED: ${err.message}`)
    console.error(`[Server] ✗ DATA_DIR (${DATA_DIR}) may not be writable. Sessions will NOT persist across deploys!`)
  }
}
runPersistenceDiagnostics()

// Persist all user sessions on shutdown (best-effort)
function persistAllSessions() {
  if (!sessionManager) return
  for (const [, s] of sessionManager.sessions) {
    try { s.persistConversationsToDisk() } catch {}
  }
}

// v7.24 (R6): Pre-deploy backup — dump every active user's WA creds +
// conversation state to Odoo chatter before the process is killed.
// This runs synchronously in the SIGTERM handler so the deploy waits
// for the backup to complete (Render's grace period is ~30s, which is
// enough for 1-3 users; for more users the admin should also trigger a
// manual backup via the "Backup de dados no Odoo" button BEFORE pushing
// new code).
async function backupAllSessionsToOdoo() {
  if (!sessionManager) return { backed: 0, failed: [], total: 0 }
  try {
    console.log('[Server] SIGTERM — backing up all user sessions to Odoo chatter...')
    const result = await sessionManager.backupAllToOdoo()
    console.log(`[Server] Backup result: ${result.backed}/${result.total} ok, ${result.failed.length} failed`)
    return result
  } catch (err) {
    console.error('[Server] Backup error:', err.message)
    return { backed: 0, failed: [{ error: err.message }], total: 0 }
  }
}

let shuttingDown = false
async function gracefulShutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[Server] ${signal} received — starting graceful shutdown...`)
  try {
    // R6: backup to Odoo first (best-effort, 10s timeout per session)
    await Promise.race([
      backupAllSessionsToOdoo(),
      new Promise(r => setTimeout(r, 10_000)),
    ])
  } catch {}
  persistAllSessions()
  if (sessionManager) sessionManager.stopAll()
  console.log(`[Server] ${signal} shutdown complete`)
  process.exit(0)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

// v7.29.2: Catch-all for unhandled errors. Without these, a single
// unhandled promise rejection or synchronous exception in any of the
// event handlers (WA socket events, Odoo sync, etc.) would crash the
// entire Node process, kicking ALL users out (UI "falls" + redirect
// to /login because socket.io disconnects). With these handlers, the
// error is logged but the process keeps running.
process.on('unhandledRejection', (reason, promise) => {
  const msg = reason instanceof Error ? `${reason.message}\n${reason.stack || ''}` : String(reason)
  console.error(`[Server] ⚠️  unhandledRejection (process staying alive):`, msg)
})
process.on('uncaughtException', (err) => {
  console.error(`[Server] ⚠️  uncaughtException (process staying alive):`, err.message)
  console.error(err.stack || '')
  // Do NOT process.exit(1) — that would terminate the container and
  // disconnect every user. Render would auto-restart but mid-conversation
  // users would see "the page fell". Better to log and continue.
})

// ====================================================================
// MAIN SERVER — Next.js + Socket.io (single process)
// ====================================================================

app.prepare().then(async () => {
  const httpServer = createServer((req, res) => {
    const parsedUrl = parse(req.url, true)

    // v7.22: Serve media files from /media/<filename>
    // Files are stored in DATA_DIR/media/ and served publicly (no auth for now —
    // they're random cuid-named files).
    if (parsedUrl.pathname && parsedUrl.pathname.startsWith('/media/')) {
      const fileName = path.basename(parsedUrl.pathname)
      // Prevent path traversal — only allow filenames without slashes/dots prefix
      if (fileName && !fileName.includes('..') && !fileName.includes('/')) {
        const filePath = path.join(MEDIA_DIR, fileName)
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(fileName).toLowerCase()
          const contentTypes = {
            '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
            '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
            '.mp3': 'audio/mpeg', '.mp4': 'audio/mp4', '.m4a': 'audio/mp4',
            '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.wav': 'audio/wav',
            '.opus': 'audio/ogg',
            '.mp4v': 'video/mp4', '.webm': 'video/webm',
            '.pdf': 'application/pdf',
            '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            '.txt': 'text/plain',
          }
          const contentType = contentTypes[ext] || 'application/octet-stream'
          const stat = fs.statSync(filePath)
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': stat.size,
            'Cache-Control': 'public, max-age=86400',
          })
          fs.createReadStream(filePath).pipe(res)
          return
        }
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
      return
    }

    handle(req, res, parsedUrl)
  })

  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 60000,
    pingInterval: 25000,
  })

  // v7.23: Initialize the SessionManager — owns all UserSession instances
  sessionManager = new SessionManager({ io, prisma, loadUserById })

  const waNamespace = io.of('/whatsapp')
  const odooNamespace = io.of('/odoo')

  // ----------------------------------------------------------------
  // v7.23: socket.io auth middleware — runs on BOTH namespaces.
  // Verifies the JWT (from handshake auth.token OR cookie) and attaches
  // `socket.userId` + `socket.userSession`. Unauthenticated sockets
  // receive an 'unauthorized' error and are rejected.
  // ----------------------------------------------------------------
  async function attachUser(socket, next) {
    try {
      let token = socket.handshake.auth?.token
      if (!token) {
        const cookies = parseCookies(socket.handshake.headers.cookie)
        token = cookies[getSessionCookieName()]
      }
      if (!token) {
        return next(new Error('unauthorized'))
      }
      const session = await verifySession(token)
      if (!session) {
        return next(new Error('unauthorized'))
      }
      // Lazily create + start the user's UserSession
      const userSession = await sessionManager.getOrCreate(session.userId)
      if (!userSession) {
        return next(new Error('user_inactive'))
      }
      socket.userId = session.userId
      socket.userSession = userSession
      userSession.connectedSockets.add(socket)
      socket.on('disconnect', () => {
        try { userSession.connectedSockets.delete(socket) } catch {}
      })
      next()
    } catch (err) {
      next(err)
    }
  }

  waNamespace.use(attachUser)
  odooNamespace.use(attachUser)

  // ========== WHATSAPP NAMESPACE ==========
  waNamespace.on('connection', (socket) => {
    const s = socket.userSession
    if (!s) return  // attachUser rejected — socket won't reach here anyway

    console.log(`[WA IO] Client connected: ${socket.id} (user=${s.user.email})`)

    // Send initial per-user state
    s.onWAConnection(socket)

    socket.on('whatsapp:request-qr', () => s.onRequestQR(socket))

    socket.on('whatsapp:get-messages', (data, callback) => s.onGetMessages(data, callback))

    socket.on('whatsapp:refresh-messages', (data, callback) => s.onRefreshMessages(data, callback))

    socket.on('whatsapp:debug-events', (data, callback) => s.onDebugEvents(data, callback))

    socket.on('whatsapp:debug-jid', (data, callback) => s.onDebugJid(data, callback))

    socket.on('whatsapp:send-message', (data, callback) => s.onSendMessage(data, callback))

    socket.on('whatsapp:send-media', (data, callback) => s.onSendMedia(data, callback))

    socket.on('whatsapp:send-media-base64', (data, callback) => s.onSendMediaBase64(data, callback))

    socket.on('whatsapp:mark-read', (data, callback) => s.onMarkRead(data, callback))

    socket.on('whatsapp:disconnect', (callback) => s.onDisconnectWA(callback))

    socket.on('whatsapp:get-profile-pic', (data, callback) => s.onGetProfilePic(data, callback))

    socket.on('whatsapp:get-contacts', (data, callback) => s.onGetContacts(data, callback))

    socket.on('whatsapp:start-conversation', (data, callback) => s.onStartConversation(data, callback))

    socket.on('whatsapp:inject-history', (data, callback) => s.onInjectHistory(data, callback))

    socket.on('whatsapp:delete-conversation', (data, callback) => s.onDeleteConversation(data, callback))

    socket.on('whatsapp:refresh-data', (data, callback) => s.onRefreshData(data, callback))

    socket.on('disconnect', () => console.log(`[WA IO] Client disconnected: ${socket.id} (user=${s.user.email})`))
  })

  // ========== ODOO NAMESPACE ==========
  odooNamespace.on('connection', (socket) => {
    const s = socket.userSession
    if (!s) return

    console.log(`[Odoo IO] Client connected: ${socket.id} (user=${s.user.email})`)

    s.onOdooConnection(socket)

    socket.on('odoo:authenticate', (data, callback) => s.onOdooAuthenticate(data, callback))

    socket.on('odoo:disconnect', (data, callback) => s.onOdooDisconnect(typeof data === 'function' ? data : callback))

    socket.on('odoo:autosync:update-settings', (data, callback) => s.onAutoSyncUpdateSettings(data, callback))

    socket.on('odoo:autosync:get-settings', (callback) => s.onAutoSyncGetSettings(callback))

    socket.on('odoo:contacts:search', (data, callback) => s.onContactsSearch(data, callback))

    socket.on('odoo:contacts:create', (data, callback) => s.onContactsCreate(data, callback))

    socket.on('odoo:contacts:search-or-create', (data, callback) => s.onContactsSearchOrCreate(data, callback))

    socket.on('odoo:leads:search', (data, callback) => s.onLeadsSearch(data, callback))

    socket.on('odoo:leads:create', (data, callback) => s.onLeadsCreate(data, callback))

    socket.on('odoo:sales:search', (data, callback) => s.onSalesSearch(data, callback))

    socket.on('odoo:sales:create', (data, callback) => s.onSalesCreate(data, callback))

    socket.on('odoo:projects:search', (data, callback) => s.onProjectsSearch(data, callback))

    socket.on('odoo:projects:create', (data, callback) => s.onProjectsCreate(data, callback))

    socket.on('odoo:projects:list', (data, callback) => s.onProjectsList(data, callback))

    socket.on('odoo:link-conversation', (data, callback) => s.onLinkConversation(data, callback))

    socket.on('odoo:log-message', (data, callback) => s.onLogMessage(data, callback))

    socket.on('odoo:fetch-history', (data, callback) => s.onFetchHistory(data, callback))

    socket.on('odoo:sync-all-history', (data, callback) => s.onSyncAllHistory(data, callback))

    socket.on('odoo:sync-status', (data, callback) => s.onSyncStatus(data, callback))

    socket.on('odoo:fields', (data, callback) => s.onFields(data, callback))

    socket.on('odoo:check-fields', (data, callback) => s.onCheckFields(data, callback))

    socket.on('odoo:search', (data, callback) => s.onSearch(data, callback))

    socket.on('odoo:read', (data, callback) => s.onRead(data, callback))

    socket.on('odoo:write', (data, callback) => s.onWrite(data, callback))

    socket.on('odoo:teams:search', (data, callback) => s.onTeamsSearch(data, callback))

    socket.on('odoo:users:search', (data, callback) => s.onUsersSearch(data, callback))

    // v7.24 (R6): Admin-triggered backup of ALL active user sessions to
    // Odoo chatter. Only admins can call this — non-admins get a 403.
    socket.on('admin:backup-to-odoo', async (data, callback) => {
      try {
        if (s.user.role !== 'admin') {
          callback?.({ success: false, error: 'Acesso restrito a administradores' })
          return
        }
        const result = await sessionManager.backupAllToOdoo()
        callback?.({ success: true, ...result })
      } catch (err) {
        console.error('[Admin IO] backup-to-odoo error:', err.message)
        callback?.({ success: false, error: err.message })
      }
    })

    socket.on('disconnect', () => console.log(`[Odoo IO] Client disconnected: ${socket.id} (user=${s.user.email})`))
  })

  // v7.23: NO eager startup of WhatsApp or Odoo. UserSessions are
  // created lazily by SessionManager.getOrCreate(userId) when a logged-in
  // user's socket.io connection arrives. The first user to connect for a
  // given userId triggers WA + Odoo startup for that user.

  // ========== START HTTP SERVER ==========
  httpServer.listen(port, hostname, () => {
    console.log(`[Server] > Ready on http://${hostname}:${port}`)
    console.log(`[Server] WhatsApp namespace: /whatsapp (auth required)`)
    console.log(`[Server] Odoo namespace: /odoo (auth required)`)
    console.log(`[Server] Per-user auth folder pattern: data/auth_<userId>/`)
    console.log(`[Server] Per-user state file pattern: data/conv_state_<userId>.json`)
    console.log(`[Server] v7.24: Pre-deploy backup to Odoo enabled (SIGTERM triggers backupAllToOdoo)`)
  })

  // v7.24 (R6): Note — the SIGTERM/SIGINT handlers are already registered
  // above (see gracefulShutdown). They call backupAllSessionsToOdoo() with
  // a 10s timeout, then persistAllSessions() + sessionManager.stopAll().
  // The httpServer is closed by process.exit(0) inside gracefulShutdown.
  // No duplicate handlers here.
})
