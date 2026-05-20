// ========== WhatsApp Types ==========
export interface WhatsAppConversation {
  jid: string
  name: string | null
  phone: string | null
  pushName: string | null
  contactName: string | null
  avatarUrl: string | null
  lastMessage: string | null
  lastMessageAt: string | null
  unreadCount: number
  messageCount: number
  // Odoo links
  odooPartnerId?: number | null
  odooLeadId?: number | null
  odooSaleId?: number | null
  odooProjectId?: number | null
  odooTaskId?: number | null
}

export interface WhatsAppMessage {
  id: string
  whatsappId: string | null
  fromMe: boolean
  textContent: string | null
  mediaType: string | null
  mediaUrl: string | null
  timestamp: string
  status: string
}

export interface WhatsAppStatus {
  connected: boolean
  reason?: string
}

export interface WhatsAppMe {
  id: string
  name?: string
  profilePicUrl?: string
}

// ========== Odoo Types ==========
export interface OdooStatus {
  connected: boolean
  url?: string
  db?: string
  username?: string
}

export interface OdooConfig {
  url: string
  db: string
  username: string
  password: string
}

export interface OdooRecord {
  id: number
  name: string
  [key: string]: any
}

export interface OdooContact extends OdooRecord {
  phone?: string
  mobile?: string
  email?: string
  whatsapp?: string
  is_company?: boolean
  image_128?: string
  country_id?: [number, string]
  state_id?: [number, string]
  city?: string
}

export interface OdooLead extends OdooRecord {
  partner_id?: [number, string] | false
  partner_name?: string
  phone?: string
  mobile?: string
  email_from?: string
  type?: string
  stage_id?: [number, string] | false
  probability?: number
  user_id?: [number, string] | false
  team_id?: [number, string] | false
  whatsapp_number?: string
}

export interface OdooSale extends OdooRecord {
  partner_id?: [number, string] | false
  state?: string
  date_order?: string
  amount_total?: number
  user_id?: [number, string] | false
  whatsapp_number?: string
}

export interface OdooProject extends OdooRecord {
  label_tasks?: string
  user_id?: [number, string] | false
  partner_id?: [number, string] | false
}

export interface OdooTask extends OdooRecord {
  project_id?: [number, string] | false
  stage_id?: [number, string] | false
  user_ids?: number[]
  partner_id?: [number, string] | false
  priority?: string
  date_deadline?: string
  description?: string
  whatsapp_number?: string
}

// ========== App Types ==========
export type AppTab = 'dashboard' | 'whatsapp' | 'conversations' | 'chat' | 'settings'

export interface ChatViewData {
  conversationJid: string
  conversation: WhatsAppConversation | null
}

export interface CreateLeadData {
  name: string
  phone?: string
  partner_name?: string
  description?: string
  type?: string
  whatsapp_number?: string
}
