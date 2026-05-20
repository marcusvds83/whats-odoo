import { createServer } from 'http'
import { Server } from 'socket.io'
import { createClient, createSecureClient } from 'xmlrpc'

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

// Auto-sync settings
interface AutoSyncSettings {
  enabled: boolean
  autoCreateContact: boolean
  autoCreateLead: boolean
  autoPostMessages: boolean
  autoCreateActivity: boolean
  leadPrefix: string
  leadTeamId: number | null
  leadUserId: number | null
}

let autoSyncSettings: AutoSyncSettings = {
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
const modelFieldsCache = new Map<string, Set<string>>()

// Cache of phone -> Odoo record IDs (to avoid re-creating contacts/leads)
const phoneToPartnerCache = new Map<string, { partnerId: number; leadId: number | null; leadCreated: boolean }>()

// ========== HTTP + Socket.io Server ==========
const httpServer = createServer()
const io = new Server(httpServer, {
  path: '/socket.io',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

// ========== Odoo XML-RPC Client ==========
function makeXmlRpcClient(path: string) {
  const url = new URL(odooConfig.url)
  const isHttps = url.protocol === 'https:'
  const options = {
    host: url.hostname,
    port: parseInt(url.port) || (isHttps ? 443 : 80),
    path,
  }
  // CRITICAL: Must use createSecureClient for HTTPS (Odoo SaaS)
  return isHttps ? createSecureClient(options) : createClient(options)
}

function getOdooClient(path: string = '/xmlrpc/2/object') {
  return makeXmlRpcClient(path)
}

function odooAuthenticate(): Promise<number> {
  return new Promise((resolve, reject) => {
    const client = makeXmlRpcClient('/xmlrpc/2/common')

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
    if (available.has(key)) {
      safe[key] = value
    } else {
      console.log(`[Odoo] Field "${key}" does not exist on ${model}, skipping`)
    }
  }
  return safe
}

async function smartWriteWhatsAppNumber(model: string, ids: number[], phone: string): Promise<boolean> {
  const available = await getAvailableFields(model)
  const values: Record<string, any> = {}

  if (available.has('whatsapp')) {
    values.whatsapp = phone
    console.log(`[Odoo] Using custom field "whatsapp" on ${model}`)
  }
  if (available.has('whatsapp_number')) {
    values.whatsapp_number = phone
    console.log(`[Odoo] Using custom field "whatsapp_number" on ${model}`)
  }
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

async function odooCreateActivity(
  model: string,
  recordId: number,
  summary: string,
  note: string,
): Promise<number> {
  try {
    const activityTypeId = await findWhatsAppActivityType()
    const values: Record<string, any> = {
      res_model: model,
      res_id: recordId,
      summary,
      note,
      activity_type_id: activityTypeId || 1, // fallback to default type
    }

    if (autoSyncSettings.leadUserId) {
      values.user_id = autoSyncSettings.leadUserId
    }

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
    if (types && types.length > 0) {
      return types[0].id
    }
  } catch {
    // Activity type might not exist, that's OK
  }
  return null
}

async function odooGetFields(
  model: string,
  attributes: string[] = ['string', 'help', 'type', 'required', 'readonly']
): Promise<any> {
  return odooExecuteKw(model, 'fields_get', [], {
    attributes,
  })
}

// ========== AUTO-SYNC ENGINE ==========

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
  mailMessageId: number | null
  activityId: number | null
  created: { partner: boolean; lead: boolean }
  errors: string[]
}> {
  const result = {
    partnerId: null as number | null,
    leadId: null as number | null,
    mailMessageId: null as number | null,
    activityId: null as number | null,
    created: { partner: false, lead: false },
    errors: [] as string[],
  }

  if (!autoSyncSettings.enabled || !odooConfig.uid) {
    return result
  }

  console.log(`[AutoSync] Processing message from ${data.phone} (${data.pushName || 'unknown'})`)

  try {
    // Step 1: Create or update contact in res.partner
    if (autoSyncSettings.autoCreateContact) {
      const contactName = data.pushName || `WhatsApp ${data.phone}`
      const domain = ['|', ['phone', 'ilike', data.phone], ['mobile', 'ilike', data.phone]]
      const contactValues: Record<string, any> = {
        name: contactName,
        phone: data.phone,
        mobile: data.phone,
      }

      // Try to set whatsapp field if it exists
      const partnerFields = await getAvailableFields('res.partner')
      if (partnerFields.has('whatsapp')) {
        contactValues.whatsapp = data.phone
      }
      if (partnerFields.has('whatsapp_number')) {
        contactValues.whatsapp_number = data.phone
      }

      const partnerResult = await odooSearchOrCreate('res.partner', domain, contactValues)
      result.partnerId = partnerResult.id
      result.created.partner = partnerResult.created

      // Update cache
      const cached = phoneToPartnerCache.get(data.phone)
      if (cached) {
        cached.partnerId = partnerResult.id
      } else {
        phoneToPartnerCache.set(data.phone, { partnerId: partnerResult.id, leadId: null, leadCreated: false })
      }

      console.log(`[AutoSync] Contact ${partnerResult.created ? 'created' : 'updated'}: res.partner#${partnerResult.id}`)
    }

    // Step 2: Create lead in crm.lead for new conversations (only for incoming messages)
    if (autoSyncSettings.autoCreateLead && !data.fromMe && result.partnerId) {
      // Check cache first
      const cached = phoneToPartnerCache.get(data.phone)
      if (cached && cached.leadId && cached.leadCreated) {
        result.leadId = cached.leadId
      } else {
        // Check if there's already a lead for this partner with WhatsApp prefix
        const existingLeads = await odooSearch('crm.lead', [
          ['partner_id', '=', result.partnerId],
          ['name', 'like', autoSyncSettings.leadPrefix],
          ['type', '=', 'lead'],
        ], ['id', 'name'], 1)

        if (existingLeads && existingLeads.length > 0) {
          result.leadId = existingLeads[0].id
          // Update cache
          if (cached) {
            cached.leadId = existingLeads[0].id
            cached.leadCreated = true
          }
          console.log(`[AutoSync] Found existing lead: crm.lead#${existingLeads[0].id}`)
        } else {
          // Create new lead
          const leadName = `${autoSyncSettings.leadPrefix}${data.pushName || data.phone}`
          const leadValues: Record<string, any> = {
            name: leadName,
            type: 'lead',
            partner_id: result.partnerId,
            phone: data.phone,
            description: `Conversa iniciada via WhatsApp em ${new Date().toLocaleString('pt-BR')}`,
          }

          // Try to set custom whatsapp field
          const leadFields = await getAvailableFields('crm.lead')
          if (leadFields.has('whatsapp_number')) {
            leadValues.whatsapp_number = data.phone
          }

          if (autoSyncSettings.leadTeamId) {
            leadValues.team_id = autoSyncSettings.leadTeamId
          }
          if (autoSyncSettings.leadUserId) {
            leadValues.user_id = autoSyncSettings.leadUserId
          }

          result.leadId = await odooCreate('crm.lead', leadValues)
          result.created.lead = true

          // Update cache
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

    // Step 3: Post message as mail.message in Odoo chatter
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
          console.log(`[AutoSync] Message posted on ${targetModel}#${targetId}: mail.message#${result.mailMessageId}`)
        } catch (error: any) {
          result.errors.push(`Failed to post message: ${error.message}`)
          console.error(`[AutoSync] Failed to post message:`, error.message)
        }
      }
    }

    // Step 4: Create activity notification for the first message of a new lead
    if (autoSyncSettings.autoCreateActivity && result.created.lead && result.leadId) {
      const summary = 'Nova mensagem WhatsApp'
      const note = `Contato ${data.pushName || data.phone} iniciou uma conversa via WhatsApp.\n\nMensagem: ${data.textContent || '[Mídia]'}`

      try {
        result.activityId = await odooCreateActivity('crm.lead', result.leadId, summary, note)
        console.log(`[AutoSync] Activity created: mail.activity#${result.activityId}`)
      } catch (error: any) {
        result.errors.push(`Failed to create activity: ${error.message}`)
      }
    }

  } catch (error: any) {
    result.errors.push(`Auto-sync error: ${error.message}`)
    console.error(`[AutoSync] Error:`, error.message)
  }

  // Emit sync result to all connected clients
  io.emit('odoo:autosync:result', {
    phone: data.phone,
    ...result,
  })

  return result
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br/>')
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

  // Send current auto-sync settings
  socket.emit('odoo:autosync:settings', autoSyncSettings)

  // ===== Authentication =====
  socket.on(
    'odoo:authenticate',
    async (data: { url: string; db: string; username: string; password: string }, callback) => {
      try {
        odooConfig = { ...data, uid: null }
        modelFieldsCache.clear()
        phoneToPartnerCache.clear()
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
    phoneToPartnerCache.clear()
    io.emit('odoo:status', { connected: false })
    callback({ success: true })
  })

  // ===== Auto-Sync Settings =====
  socket.on(
    'odoo:autosync:update-settings',
    async (data: Partial<AutoSyncSettings>, callback) => {
      try {
        autoSyncSettings = { ...autoSyncSettings, ...data }
        console.log('[Odoo] Auto-sync settings updated:', autoSyncSettings)
        io.emit('odoo:autosync:settings', autoSyncSettings)
        callback({ success: true, settings: autoSyncSettings })
      } catch (error: any) {
        callback({ success: false, error: error.message })
      }
    }
  )

  socket.on('odoo:autosync:get-settings', (callback) => {
    callback({ success: true, settings: autoSyncSettings })
  })

  // ===== Auto-Sync Trigger (called by WhatsApp service) =====
  socket.on(
    'odoo:autosync:message',
    async (data: {
      jid: string
      phone: string
      pushName?: string | null
      textContent?: string | null
      mediaType?: string | null
      fromMe: boolean
      timestamp: string
    }, callback) => {
      console.log(`[Odoo] Auto-sync message received from ${data.phone}`)
      try {
        const result = await autoSyncWhatsAppMessage(data)
        if (callback) callback({ success: true, ...result })
      } catch (error: any) {
        console.error('[Odoo] Auto-sync error:', error.message)
        if (callback) callback({ success: false, error: error.message })
      }
    }
  )

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

        await smartWriteWhatsAppNumber(data.model, [data.recordId], phone)

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

  // ===== Get teams (for auto-sync settings) =====
  socket.on('odoo:teams:search', async (data: { limit?: number }, callback) => {
    try {
      const records = await odooSearch('crm.team', [], ['name', 'user_id'], data.limit || 20)
      callback({ success: true, data: records })
    } catch (error: any) {
      callback({ success: false, error: error.message })
    }
  })

  // ===== Get users (for auto-sync settings) =====
  socket.on('odoo:users:search', async (data: { limit?: number }, callback) => {
    try {
      const records = await odooSearch('res.users', [], ['name', 'login', 'image_128'], data.limit || 20)
      callback({ success: true, data: records })
    } catch (error: any) {
      callback({ success: false, error: error.message })
    }
  })

  socket.on('disconnect', () => {
    console.log(`[Odoo IO] Client disconnected: ${socket.id}`)
  })
})

// ========== Auto-Authenticate from Environment Variables ==========
async function autoAuthenticateFromEnv() {
  const envUrl = process.env.ODOO_URL
  const envDb = process.env.ODOO_DB
  const envUsername = process.env.ODOO_USERNAME
  const envPassword = process.env.ODOO_PASSWORD

  if (envUrl && envDb && envUsername && envPassword) {
    console.log(`[Odoo] Auto-authenticating with env vars: ${envUrl} / ${envDb} / ${envUsername}`)
    try {
      odooConfig = {
        url: envUrl,
        db: envDb,
        username: envUsername,
        password: envPassword,
        uid: null,
      }
      modelFieldsCache.clear()
      phoneToPartnerCache.clear()
      const uid = await odooAuthenticate()
      odooConfig.uid = uid
      console.log(`[Odoo] Auto-authenticated as ${envUsername} (uid: ${uid})`)

      // Pre-cache fields for main models
      await getAvailableFields('res.partner')
      await getAvailableFields('crm.lead')

      io.emit('odoo:status', {
        connected: true,
        url: odooConfig.url,
        db: odooConfig.db,
        username: odooConfig.username,
      })
    } catch (error: any) {
      console.error(`[Odoo] Auto-authentication failed: ${error.message}`)
      console.error('[Odoo] You can still connect manually via the UI')
    }
  } else {
    console.log('[Odoo] No ODOO_URL/ODOO_DB/ODOO_USERNAME/ODOO_PASSWORD env vars set. Waiting for manual connection via UI.')
  }
}

// ========== Start Server ==========
httpServer.listen(PORT, async () => {
  console.log(`[Odoo Service] Server running on port ${PORT}`)
  console.log(`[Odoo Service] Auto-sync enabled: ${autoSyncSettings.enabled}`)
  // Auto-authenticate if env vars are present
  await autoAuthenticateFromEnv()
})

process.on('SIGTERM', () => {
  console.log('[Odoo Service] SIGTERM received, shutting down...')
  httpServer.close(() => process.exit(0))
})

process.on('SIGINT', () => {
  console.log('[Odoo Service] SIGINT received, shutting down...')
  httpServer.close(() => process.exit(0))
})
