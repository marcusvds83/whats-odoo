// Custom Next.js server with Socket.io Bridge
// This allows the browser to connect to Socket.io on the main port (10000)
// and relays events to/from the internal mini-services (3001, 3002)

const { createServer } = require('http')
const { parse } = require('url')
const next = require('next')
const { Server } = require('socket.io')
const { io: ioClient } = require('socket.io-client')

// Ensure production mode on Render
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production'
const dev = process.env.NODE_ENV !== 'production'
const hostname = process.env.HOSTNAME || '0.0.0.0'
const port = parseInt(process.env.PORT || '10000', 10)

const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()

// Internal service URLs
const WHATSAPP_SERVICE_URL = process.env.WHATSAPP_SERVICE_URL || 'http://localhost:3001'
const ODOO_SERVICE_URL = process.env.ODOO_SERVICE_URL || 'http://localhost:3002'

app.prepare().then(() => {
  const httpServer = createServer((req, res) => {
    const parsedUrl = parse(req.url, true)
    handle(req, res, parsedUrl)
  })

  // ========== Socket.io Bridge Server ==========
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 60000,
    pingInterval: 25000,
  })

  // Namespaces for each service
  const waNamespace = io.of('/whatsapp')
  const odooNamespace = io.of('/odoo')

  // ========== Connect to WhatsApp Service (internal) ==========
  console.log(`[Bridge] Connecting to WhatsApp service at ${WHATSAPP_SERVICE_URL}`)
  const waServiceClient = ioClient(WHATSAPP_SERVICE_URL, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 3000,
    timeout: 10000,
  })

  waServiceClient.on('connect', () => {
    console.log('[Bridge] Connected to WhatsApp service')
  })

  waServiceClient.on('disconnect', () => {
    console.log('[Bridge] Disconnected from WhatsApp service')
  })

  waServiceClient.on('connect_error', (err) => {
    console.log(`[Bridge] WhatsApp service connection error: ${err.message}`)
  })

  // Relay WhatsApp events from service → browser clients
  const waEventsToRelay = [
    'whatsapp:status', 'whatsapp:qr', 'whatsapp:me',
    'whatsapp:conversations', 'whatsapp:conversation:update',
    'whatsapp:message', 'whatsapp:odoo-sync',
    'whatsapp:sync-progress',
  ]

  waEventsToRelay.forEach((event) => {
    waServiceClient.on(event, (data) => {
      waNamespace.emit(event, data)
    })
  })

  // Relay WhatsApp events from browser → service
  waNamespace.on('connection', (socket) => {
    console.log(`[Bridge] WhatsApp client connected: ${socket.id}`)

    // Forward client events to WhatsApp service
    const clientEvents = [
      'whatsapp:request-qr', 'whatsapp:get-messages',
      'whatsapp:send-message', 'whatsapp:send-media',
      'whatsapp:mark-read', 'whatsapp:disconnect',
      'whatsapp:get-profile-pic',
    ]

    clientEvents.forEach((event) => {
      socket.on(event, (data, callback) => {
        if (waServiceClient.connected) {
          waServiceClient.emit(event, data, callback)
        } else if (typeof callback === 'function') {
          callback({ success: false, error: 'WhatsApp service not connected' })
        }
      })
    })

    socket.on('disconnect', () => {
      console.log(`[Bridge] WhatsApp client disconnected: ${socket.id}`)
    })
  })

  // ========== Connect to Odoo Service (internal) ==========
  console.log(`[Bridge] Connecting to Odoo service at ${ODOO_SERVICE_URL}`)
  const odooServiceClient = ioClient(ODOO_SERVICE_URL, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 3000,
    timeout: 10000,
  })

  odooServiceClient.on('connect', () => {
    console.log('[Bridge] Connected to Odoo service')
  })

  odooServiceClient.on('disconnect', () => {
    console.log('[Bridge] Disconnected from Odoo service')
  })

  odooServiceClient.on('connect_error', (err) => {
    console.log(`[Bridge] Odoo service connection error: ${err.message}`)
  })

  // Relay Odoo events from service → browser clients
  const odooEventsToRelay = [
    'odoo:status', 'odoo:record:created', 'odoo:conversation:linked',
    'odoo:autosync:settings', 'odoo:autosync:result',
  ]

  odooEventsToRelay.forEach((event) => {
    odooServiceClient.on(event, (data) => {
      odooNamespace.emit(event, data)
    })
  })

  // Relay Odoo events from browser → service
  odooNamespace.on('connection', (socket) => {
    console.log(`[Bridge] Odoo client connected: ${socket.id}`)

    const clientEvents = [
      'odoo:authenticate', 'odoo:disconnect',
      'odoo:autosync:update-settings', 'odoo:autosync:get-settings',
      'odoo:contacts:search', 'odoo:contacts:create', 'odoo:contacts:search-or-create',
      'odoo:leads:search', 'odoo:leads:create',
      'odoo:sales:search', 'odoo:sales:create',
      'odoo:projects:list', 'odoo:projects:search', 'odoo:projects:create',
      'odoo:link-conversation', 'odoo:log-message',
      'odoo:fields', 'odoo:check-fields',
      'odoo:search', 'odoo:read', 'odoo:write',
      'odoo:teams:search', 'odoo:users:search',
    ]

    clientEvents.forEach((event) => {
      socket.on(event, (data, callback) => {
        if (odooServiceClient.connected) {
          odooServiceClient.emit(event, data, callback)
        } else if (typeof callback === 'function') {
          callback({ success: false, error: 'Odoo service not connected' })
        }
      })
    })

    socket.on('disconnect', () => {
      console.log(`[Bridge] Odoo client disconnected: ${socket.id}`)
    })
  })

  // ========== Start Server ==========
  httpServer.listen(port, hostname, () => {
    console.log(`[Server] > Ready on http://${hostname}:${port}`)
    console.log(`[Bridge] WhatsApp namespace: /whatsapp`)
    console.log(`[Bridge] Odoo namespace: /odoo`)
  })
})
