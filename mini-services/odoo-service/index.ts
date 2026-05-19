import { createServer } from 'http'
import { Server } from 'socket.io'
import { createClient } from 'xmlrpc'

// ========== Configuration ==========
const PORT = 3002

// Odoo connection config (received from frontend, stored in memory)
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

// Cache of available fields per model (auto-detected)
const modelFieldsCache = new Map<string, Set<string>>()

// ========== HTTP + Socket.io Server ==========
const httpServer = createServer()
const io = new Server(httpServer, {
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

// ========== Odoo XML-RPC Client ==========
function getOdooClient(path: string = '/xmlrpc/2/object') {
  const url = new URL(odooConfig.url)
  const client = createClient({
    host: url.hostname,
    port: parseInt(url.port) || (url.protocol === 'https:' ? 443 : 80),
    path,
  })
  return client
}

function odooAuthenticate(): Promise<number> {
  return new Promise((resolve, reject) => {
    const client = createClient({
      host: new URL(odooConfig.url).hostname,
      port: parseInt(new URL(odooConfig.url).port) || (new URL(odooConfig.url).protocol === 'https:' ? 443 : 80),
      path: '/xmlrpc/2/common',
    })

    client.methodCall('authenticate', [
      odooConfig.db,
      odooConfig.username,
      odooConfig.password,
      {},
    ], (error: any, value: any) => {
      if (error) {
        reject(error)
      } else if (!value) {
        reject(new Error('Authentication failed - invalid credentials'))
      } else {
        resolve(value)
      }
    })
  })
}

function odooExecuteKw(
  model: string,
  method: string,
  args: any[],
  kwargs: any = {}
): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!odooConfig.uid) {
      reject(new Error('Not authenticated with Odoo'))
      return
    }

    const client = getOdooClient()
    client.methodCall(
      'execute_kw',
      [
        odooConfig.db,
        odooConfig.uid,
        odooConfig.password,
        model,
        method,
        args,
        kwargs,
      ],
      (error: any, value: any) => {
        if (error) {
          reject(error)
        } else {
          resolve(value)
        }
      }
    )
  })
}

// ========== Smart Field Detection ==========

// Check which fields exist on a model (with cache)
async function getAvailableFields(model: string): Promise<Set<string>> {
  if (modelFieldsCache.has(model)) {
    return modelFieldsCache.get(model)!
  }

  try {
    const fields = await odooExecuteKw(model, 'fields_get', [], {
      attributes: ['string', 'type'],
    })
    const fieldNames = new Set(Object.keys(fields))
    modelFieldsCache.set(model, fieldNames)
    console.log(`[Odoo] Model ${model} has ${fieldNames.size} fields. Custom checks: whatsapp=${fieldNames.has('whatsapp')}, whatsapp_number=${fieldNames.has('whatsapp_number')}`)
    return fieldNames
  } catch (error: any) {
    console.error(`[Odoo] Failed to get fields for ${model}:`, error.message)
    return new Set()
  }
}

// Filter a list of requested fields to only those that exist on the model
async function filterExistingFields(model: string, requestedFields: string[]): Promise<string[]> {
  const available = await getAvailableFields(model)
  const existing = requestedFields.filter(f => available.has(f))
  // Always return at least 'id' and 'name' if they exist
  if (!existing.includes('id') && available.has('id')) existing.unshift('id')
  if (!existing.includes('name') && available.has('name')) existing.push('name')
  return existing
}

// Build a safe values dict — only include keys that exist on the model
async function buildSafeValues(model: string, values: Record<string, any>): Promise<Record<string, any>> {
  const available = await getAvailableFields(model)
  const safe: Record<string, any> = {}
  for (const [key, value] of Object.entries(values)) {
    if (available.has(key)) {
      safe[key] = value
    } else {
      console.log(`[Odoo] Field "${key}" does not exist on ${model}, skipping`)
    }
  }
  return safe
}

// Smart write — tries custom fields first, falls back to standard fields
async function smartWriteWhatsAppNumber(model: string, ids: number[], phone: string): Promise<boolean> {
  const available = await getAvailableFields(model)
  const values: Record<string, any> = {}

  // Check for custom WhatsApp fields
  if (available.has('whatsapp')) {
    values.whatsapp = phone
    console.log(`[Odoo] Using custom field "whatsapp" on ${model}`)
  }
  if (available.has('whatsapp_number')) {
    values.whatsapp_number = phone
    console.log(`[Odoo] Using custom field "whatsapp_number" on ${model}`)
  }

  // Always update standard phone/mobile fields as fallback
  if (available.has('phone')) {
    values.phone = phone
  }
  if (available.has('mobile') && !values.whatsapp) {
    values.mobile = phone
  }

  if (Object.keys(values).length === 0) {
    console.log(`[Odoo] No phone/whatsapp fields found on ${model}, skipping write`)
    return false
  }

  return odooWrite(model, ids, values)
}

// ========== High-level Odoo Operations ==========

async function odooSearch(
  model: string,
  domain: any[],
  fields: string[] = [],
  limit: number = 80,
  offset: number = 0
): Promise<any[]> {
  // Auto-filter to only existing fields
  const safeFields = fields.length > 0
    ? await filterExistingFields(model, fields)
    : []
  return odooExecuteKw(model, 'search_read', [domain], {
    fields: safeFields.length > 0 ? safeFields : undefined,
    limit,
    offset,
  })
}

async function odooRead(
  model: string,
  ids: number[],
  fields: string[] = []
): Promise<any[]> {
  const safeFields = fields.length > 0
    ? await filterExistingFields(model, fields)
    : []
  return odooExecuteKw(model, 'read', [ids], {
    fields: safeFields.length > 0 ? safeFields : undefined,
  })
}

async function odooCreate(model: string, values: Record<string, any>): Promise<number> {
  const safeValues = await buildSafeValues(model, values)
  return odooExecuteKw(model, 'create', [safeValues])
}

async function odooWrite(model: string, ids: number[], values: Record<string, any>): Promise<boolean> {
  const safeValues = await buildSafeValues(model, values)
  return odooExecuteKw(model, 'write', [ids, safeValues])
}

async function odooSearchOrCreate(
  model: string,
  domain: any[],
  values: Record<string, any>
): Promise<{ id: number; created: boolean }> {
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

async function odooPostMessage(
  model: string,
  recordId: number,
  message: string,
): Promise<any> {
  return odooExecuteKw(model, 'message_post', [recordId], {
    body: message,
    message_type: 'comment',
    subtype_xmlid: 'mail.mt_comment',
  })
}

async function odooGetFields(
  model: string,
  attributes: string[] = ['string', 'help', 'type', 'required', 'readonly']
): Promise<any> {
  return odooExecuteKw(model, 'fields_get', [], {
    attributes,
  })
}

// ========== Socket.io Events ==========
io.on('connection', (socket) => {
  console.log(`[Odoo IO] Client connected: ${socket.id}`)

  socket.emit('odoo:status', {
    connected: !!odooConfig.uid,
    url: odooConfig.url,
    db: odooConfig.db,
    username: odooConfig.username,
  })

  // ===== Authentication =====
  socket.on(
    'odoo:authenticate',
    async (data: { url: string; db: string; username: string; password: string }, callback) => {
      try {
        odooConfig = { ...data, uid: null }
        // Clear field cache on new connection
        modelFieldsCache.clear()
        const uid = await odooAuthenticate()
        odooConfig.uid = uid
        console.log(`[Odoo] Authenticated as ${data.username} (uid: ${uid})`)

        // Pre-cache fields for main models
        await getAvailableFields('res.partner')
        await getAvailableFields('crm.lead')

        io.emit('odoo:status', {
          connected: true,
          url: odooConfig.url,
          db: odooConfig.db,
          username: odooConfig.username,
        })
        callback({ success: true, uid })
      } catch (error: any) {
        console.error('[Odoo] Auth error:', error.message)
        callback({ success: false, error: error.message })
      }
    }
  )

  // ===== Disconnect =====
  socket.on('odoo:disconnect', (callback) => {
    odooConfig = { url: '', db: '', username: '', password: '', uid: null }
    modelFieldsCache.clear()
    io.emit('odoo:status', { connected: false })
    callback({ success: true })
  })

  // ===== Contacts (res.partner) =====
  socket.on(
    'odoo:contacts:search',
    async (data: { query?: string; limit?: number }, callback) => {
      try {
        const domain = data.query
          ? ['|', '|', ['name', 'ilike', data.query], ['phone', 'ilike', data.query], ['mobile', 'ilike', data.query]]
          : []
        const records = await odooSearch('res.partner', domain, [
          'name', 'phone', 'mobile', 'email', 'whatsapp', 'image_128',
          'is_company', 'country_id', 'state_id', 'city',
        ], data.limit || 20)
        callback({ success: true, data: records })
      } catch (error: any) {
        callback({ success: false, error: error.message })
      }
    }
  )

  socket.on(
    'odoo:contacts:create',
    async (data: { name: string; phone?: string; mobile?: string; whatsapp?: string; email?: string }, callback) => {
      try {
        const values: Record<string, any> = { name: data.name }
        if (data.phone) values.phone = data.phone
        if (data.mobile) values.mobile = data.mobile
        if (data.whatsapp) values.whatsapp = data.whatsapp
        if (data.email) values.email = data.email

        const id = await odooCreate('res.partner', values)
        callback({ success: true, id })
        io.emit('odoo:record:created', { model: 'res.partner', id, values })
      } catch (error: any) {
        callback({ success: false, error: error.message })
      }
    }
  )

  socket.on(
    'odoo:contacts:search-or-create',
    async (data: { phone: string; name?: string }, callback) => {
      try {
        const domain = ['|', ['phone', 'ilike', data.phone], ['mobile', 'ilike', data.phone]]
        const values: Record<string, any> = {
          name: data.name || `WhatsApp ${data.phone}`,
          phone: data.phone,
          mobile: data.phone,
        }
        const result = await odooSearchOrCreate('res.partner', domain, values)
        callback({ success: true, ...result })
      } catch (error: any) {
        callback({ success: false, error: error.message })
      }
    }
  )

  // ===== CRM Leads =====
  socket.on(
    'odoo:leads:search',
    async (data: { query?: string; limit?: number }, callback) => {
      try {
        const domain = data.query
          ? ['|', ['name', 'ilike', data.query], ['partner_name', 'ilike', data.query]]
          : []
        const records = await odooSearch('crm.lead', domain, [
          'name', 'partner_id', 'partner_name', 'phone', 'mobile', 'email_from',
          'type', 'stage_id', 'probability', 'user_id', 'team_id',
          'create_date', 'write_date', 'whatsapp_number',
        ], data.limit || 20)
        callback({ success: true, data: records })
      } catch (error: any) {
        callback({ success: false, error: error.message })
      }
    }
  )

  socket.on(
    'odoo:leads:create',
    async (data: {
      name: string
      phone?: string
      partner_id?: number
      partner_name?: string
      description?: string
      type?: string
      whatsapp_number?: string
    }, callback) => {
      try {
        const values: Record<string, any> = {
          name: data.name,
          type: data.type || 'lead',
        }
        if (data.phone) values.phone = data.phone
        if (data.partner_id) values.partner_id = data.partner_id
        if (data.partner_name) values.partner_name = data.partner_name
        if (data.description) values.description = data.description
        if (data.whatsapp_number) values.whatsapp_number = data.whatsapp_number

        const id = await odooCreate('crm.lead', values)
        callback({ success: true, id })
        io.emit('odoo:record:created', { model: 'crm.lead', id, values })
      } catch (error: any) {
        callback({ success: false, error: error.message })
      }
    }
  )

  // ===== Sales (sale.order) =====
  socket.on(
    'odoo:sales:search',
    async (data: { query?: string; limit?: number }, callback) => {
      try {
        const domain = data.query
          ? ['|', ['name', 'ilike', data.query], ['partner_id', 'ilike', data.query]]
          : []
        const records = await odooSearch('sale.order', domain, [
          'name', 'partner_id', 'state', 'date_order', 'amount_total',
          'user_id', 'team_id', 'whatsapp_number',
        ], data.limit || 20)
        callback({ success: true, data: records })
      } catch (error: any) {
        callback({ success: false, error: error.message })
      }
    }
  )

  socket.on(
    'odoo:sales:create',
    async (data: {
      partner_id: number
      whatsapp_number?: string
    }, callback) => {
      try {
        const values: Record<string, any> = {
          partner_id: data.partner_id,
        }
        if (data.whatsapp_number) values.whatsapp_number = data.whatsapp_number

        const id = await odooCreate('sale.order', values)
        callback({ success: true, id })
        io.emit('odoo:record:created', { model: 'sale.order', id, values })
      } catch (error: any) {
        callback({ success: false, error: error.message })
      }
    }
  )

  // ===== Projects (project.task) =====
  socket.on(
    'odoo:projects:search',
    async (data: { query?: string; project_id?: number; limit?: number }, callback) => {
      try {
        const domain: any[] = []
        if (data.query) {
          domain.push('|', ['name', 'ilike', data.query], ['description', 'ilike', data.query])
        }
        if (data.project_id) {
          domain.push(['project_id', '=', data.project_id])
        }
        const records = await odooSearch('project.task', domain, [
          'name', 'description', 'project_id', 'stage_id', 'user_ids',
          'partner_id', 'priority', 'create_date', 'date_deadline',
          'whatsapp_number',
        ], data.limit || 20)
        callback({ success: true, data: records })
      } catch (error: any) {
        callback({ success: false, error: error.message })
      }
    }
  )

  socket.on(
    'odoo:projects:create',
    async (data: {
      name: string
      project_id?: number
      partner_id?: number
      description?: string
      whatsapp_number?: string
    }, callback) => {
      try {
        const values: Record<string, any> = { name: data.name }
        if (data.project_id) values.project_id = data.project_id
        if (data.partner_id) values.partner_id = data.partner_id
        if (data.description) values.description = data.description
        if (data.whatsapp_number) values.whatsapp_number = data.whatsapp_number

        const id = await odooCreate('project.task', values)
        callback({ success: true, id })
        io.emit('odoo:record:created', { model: 'project.task', id, values })
      } catch (error: any) {
        callback({ success: false, error: error.message })
      }
    }
  )

  // ===== Projects list =====
  socket.on(
    'odoo:projects:list',
    async (data: { limit?: number }, callback) => {
      try {
        const records = await odooSearch('project.project', [], [
          'name', 'label_tasks', 'user_id', 'partner_id',
        ], data.limit || 50)
        callback({ success: true, data: records })
      } catch (error: any) {
        callback({ success: false, error: error.message })
      }
    }
  )

  // ===== Link WhatsApp conversation to Odoo record =====
  socket.on(
    'odoo:link-conversation',
    async (data: {
      jid: string
      model: string
      recordId: number
      phone?: string
    }, callback) => {
      try {
        const phone = data.phone || data.jid.split('@')[0]

        // Use smart write that auto-detects available fields
        await smartWriteWhatsAppNumber(data.model, [data.recordId], phone)

        // Also log a message in the chatter
        try {
          await odooPostMessage(data.model, data.recordId,
            `<p><strong>[WhatsApp Middleware]</strong> Conversa vinculada — Número: ${phone}</p>`
          )
        } catch {
          // Chatter might not be available on all models, ignore
        }

        callback({ success: true })
        io.emit('odoo:conversation:linked', {
          jid: data.jid,
          model: data.model,
          recordId: data.recordId,
        })
      } catch (error: any) {
        callback({ success: false, error: error.message })
      }
    }
  )

  // ===== Log message in Odoo (mail.thread chatter) =====
  socket.on(
    'odoo:log-message',
    async (data: {
      model: string
      recordId: number
      message: string
      fromWhatsApp?: boolean
    }, callback) => {
      try {
        const body = data.fromWhatsApp
          ? `<p><strong>[WhatsApp]</strong> ${data.message}</p>`
          : data.message
        await odooPostMessage(data.model, data.recordId, body)
        callback({ success: true })
      } catch (error: any) {
        callback({ success: false, error: error.message })
      }
    }
  )

  // ===== Get model fields =====
  socket.on(
    'odoo:fields',
    async (data: { model: string }, callback) => {
      try {
        const fields = await odooGetFields(data.model)
        callback({ success: true, data: fields })
      } catch (error: any) {
        callback({ success: false, error: error.message })
      }
    }
  )

  // ===== Check if custom fields exist =====
  socket.on(
    'odoo:check-fields',
    async (data: { model: string; fields: string[] }, callback) => {
      try {
        const available = await getAvailableFields(data.model)
        const result: Record<string, boolean> = {}
        for (const field of data.fields) {
          result[field] = available.has(field)
        }
        callback({ success: true, data: result })
      } catch (error: any) {
        callback({ success: false, error: error.message })
      }
    }
  )

  // ===== Generic CRUD =====
  socket.on('odoo:search', async (data: { model: string; domain: any[]; fields?: string[]; limit?: number }, callback) => {
    try {
      const records = await odooSearch(data.model, data.domain, data.fields || [], data.limit || 20)
      callback({ success: true, data: records })
    } catch (error: any) {
      callback({ success: false, error: error.message })
    }
  })

  socket.on('odoo:read', async (data: { model: string; ids: number[]; fields?: string[] }, callback) => {
    try {
      const records = await odooRead(data.model, data.ids, data.fields || [])
      callback({ success: true, data: records })
    } catch (error: any) {
      callback({ success: false, error: error.message })
    }
  })

  socket.on('odoo:write', async (data: { model: string; ids: number[]; values: Record<string, any> }, callback) => {
    try {
      const result = await odooWrite(data.model, data.ids, data.values)
      callback({ success: true, data: result })
    } catch (error: any) {
      callback({ success: false, error: error.message })
    }
  })

  socket.on('disconnect', () => {
    console.log(`[Odoo IO] Client disconnected: ${socket.id}`)
  })
})

// ========== Start Server ==========
httpServer.listen(PORT, () => {
  console.log(`[Odoo Service] Server running on port ${PORT}`)
})

process.on('SIGTERM', () => {
  console.log('[Odoo Service] SIGTERM received, shutting down...')
  httpServer.close(() => process.exit(0))
})

process.on('SIGINT', () => {
  console.log('[Odoo Service] SIGINT received, shutting down...')
  httpServer.close(() => process.exit(0))
})
