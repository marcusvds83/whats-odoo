'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { io, Socket } from 'socket.io-client'
import type {
  OdooStatus,
  OdooConfig,
  OdooContact,
  OdooLead,
  OdooSale,
  OdooProject,
  OdooTask,
  OdooRecord,
} from '@/lib/types'

// ========== Auto-Sync Types ==========
export interface AutoSyncSettings {
  enabled: boolean
  autoCreateContact: boolean
  autoCreateLead: boolean
  autoPostMessages: boolean
  autoCreateActivity: boolean
  leadPrefix: string
  leadTeamId: number | null
  leadUserId: number | null
}

export interface AutoSyncResult {
  phone: string
  partnerId: number | null
  leadId: number | null
  mailMessageId: number | null
  activityId: number | null
  created: { partner: boolean; lead: boolean }
  errors: string[]
}

/**
 * v7.23: Read the JWT session token from the whats_odoo_session cookie.
 * The server's socket.io auth middleware (src/lib/auth-edge.cjs) verifies
 * this token and attaches the user's UserSession to the socket.
 */
function getSessionToken(): string | null {
  if (typeof document === 'undefined') return null
  const match = document.cookie.match(/(?:^|;\s*)whats_odoo_session=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

export function useOdoo() {
  const socketRef = useRef<Socket | null>(null)
  const [status, setStatus] = useState<OdooStatus>({ connected: false })
  const [isConnected, setIsConnected] = useState(false)
  // v7.19: Defaults match the server — autoCreateLead is FALSE by default;
  // opportunities are only created explicitly via the side menu button.
  const [autoSyncSettings, setAutoSyncSettings] = useState<AutoSyncSettings>({
    enabled: true,
    autoCreateContact: true,
    autoCreateLead: false,
    autoPostMessages: true,
    autoCreateActivity: false,
    leadPrefix: '[WhatsApp] ',
    leadTeamId: null,
    leadUserId: null,
  })
  const [lastSyncResult, setLastSyncResult] = useState<AutoSyncResult | null>(null)

  // Map of conversation JID -> linked Odoo records (model + recordId)
  // Updated whenever the Odoo service emits 'odoo:conversation:linked'
  const [conversationLinks, setConversationLinks] = useState<Map<string, Array<{ model: string; recordId: number }>>>(new Map())

  useEffect(() => {
    const socket = io('/odoo', {
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 2000,
      timeout: 15000,
      // v7.23: pass the JWT in the socket.io handshake so the server can
      // authenticate the user and route events to their own UserSession.
      auth: { token: getSessionToken() },
    })

    socketRef.current = socket

    socket.on('connect', () => {
      console.log('[Odoo] Socket connected')
      setIsConnected(true)
    })

    // v7.23: Redirect to /login if the server rejects the socket (token
    // expired / invalid / user inactive).
    socket.on('connect_error', (err: Error & { message?: string; data?: any }) => {
      console.error('[Odoo] Socket connect_error:', err.message)
      setIsConnected(false)
      const reason = err?.data?.message || err?.message || ''
      if (reason === 'unauthorized' || reason === 'user_inactive' || reason === 'not_authenticated') {
        if (typeof window !== 'undefined') {
          window.location.href = '/login'
        }
      }
    })

    socket.on('disconnect', () => {
      console.log('[Odoo] Socket disconnected')
      setIsConnected(false)
    })

    socket.on('odoo:status', (data: OdooStatus) => {
      console.log('[Odoo] Status:', data)
      setStatus(data)
    })

    socket.on('odoo:record:created', (data: { model: string; id: number; values: any }) => {
      console.log('[Odoo] Record created:', data.model, data.id)
    })

    socket.on('odoo:conversation:linked', (data: { jid: string; model: string; recordId: number }) => {
      console.log('[Odoo] Conversation linked:', data)
      setConversationLinks(prev => {
        const next = new Map(prev)
        const existing = next.get(data.jid) || []
        // Avoid duplicates
        if (!existing.some(r => r.model === data.model && r.recordId === data.recordId)) {
          next.set(data.jid, [...existing, { model: data.model, recordId: data.recordId }])
        }
        return next
      })
    })

    // Also track auto-sync results (from WhatsApp service forwarding)
    // so the "Pull from Odoo" button knows about auto-created leads/partners
    socket.on('odoo:autosync:result', (data: AutoSyncResult & { jid?: string }) => {
      console.log('[Odoo] Auto-sync result:', data)
      setLastSyncResult(data)
      // If the result includes a JID (forwarded from WhatsApp service), track links
      if (data.jid && (data.leadId || data.partnerId)) {
        setConversationLinks(prev => {
          const next = new Map(prev)
          const existing = next.get(data.jid!) || []
          const additions: Array<{ model: string; recordId: number }> = []
          if (data.partnerId && !existing.some(r => r.model === 'res.partner' && r.recordId === data.partnerId)) {
            additions.push({ model: 'res.partner', recordId: data.partnerId })
          }
          if (data.leadId && !existing.some(r => r.model === 'crm.lead' && r.recordId === data.leadId)) {
            additions.push({ model: 'crm.lead', recordId: data.leadId })
          }
          if (additions.length > 0) {
            next.set(data.jid!, [...existing, ...additions])
          }
          return next
        })
      }
    })

    // Auto-sync events
    socket.on('odoo:autosync:settings', (data: AutoSyncSettings) => {
      console.log('[Odoo] Auto-sync settings:', data)
      setAutoSyncSettings(data)
    })

    return () => {
      socket.disconnect()
    }
  }, [])

  const authenticate = useCallback((config: OdooConfig): Promise<{ success: boolean; uid?: number; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:authenticate', config, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  const disconnect = useCallback((): Promise<{ success: boolean }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:disconnect', {}, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  // ===== Auto-Sync Settings =====
  const updateAutoSyncSettings = useCallback((settings: Partial<AutoSyncSettings>): Promise<{ success: boolean; settings?: AutoSyncSettings; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:autosync:update-settings', settings, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  const getAutoSyncSettings = useCallback((): Promise<{ success: boolean; settings?: AutoSyncSettings }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:autosync:get-settings', (response: any) => {
        resolve(response)
      })
    })
  }, [])

  // ===== Contacts =====
  const searchContacts = useCallback((query?: string, limit?: number): Promise<{ success: boolean; data?: OdooContact[]; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:contacts:search', { query, limit }, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  const createContact = useCallback((data: { name: string; phone?: string; mobile?: string; whatsapp?: string; email?: string }): Promise<{ success: boolean; id?: number; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:contacts:create', data, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  const searchOrCreateContact = useCallback((data: { phone: string; name?: string }): Promise<{ success: boolean; id?: number; created?: boolean; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:contacts:search-or-create', data, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  // ===== Leads =====
  const searchLeads = useCallback((query?: string, limit?: number): Promise<{ success: boolean; data?: OdooLead[]; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:leads:search', { query, limit }, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  const createLead = useCallback((data: {
    name: string
    phone?: string
    partner_id?: number
    partner_name?: string
    description?: string
    type?: string
    whatsapp_number?: string
    messages?: Array<{
      fromMe: boolean
      textContent: string | null
      mediaType?: string | null
      timestamp: string
    }>
  }): Promise<{ success: boolean; id?: number; postedMessages?: number; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:leads:create', data, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  // ===== Fetch conversation history from Odoo chatter =====
  // Reads mail.message records linked to a model/record and returns them
  // as WhatsApp-style message objects so the frontend can merge them back.
  const fetchHistory = useCallback((data: {
    model: string
    recordId: number
    limit?: number
  }): Promise<{ success: boolean; data?: Array<{
    externalId: string
    fromMe: boolean
    textContent: string | null
    mediaType: string | null
    timestamp: string
    source: string
  }>; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:fetch-history', data, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  // ===== v7.21: Sync ALL conversation history from Odoo chatter =====
  // Scans every res.partner that has WhatsApp chatter messages and pulls
  // them into the local conversation state. This is what runs automatically
  // on WA reconnect — exposed here so the UI can also trigger it manually.
  // Idempotent: running it twice won't duplicate messages (dedup by externalId
  // + content+timestamp).
  const syncAllHistory = useCallback((data?: { limit?: number }): Promise<{
    success: boolean
    partnersProcessed?: number
    messagesAdded?: number
    partnersFailed?: number
    lastRun?: { at: string; partnersProcessed: number; messagesAdded: number; partnersFailed: number; durationMs: number } | null
    error?: string
  }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:sync-all-history', data || {}, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  // ===== v7.21: Get current sync status (in-progress? last run stats?) =====
  const getSyncStatus = useCallback((): Promise<{
    success: boolean
    inProgress?: boolean
    lastRun?: { at: string; partnersProcessed: number; messagesAdded: number; partnersFailed: number; durationMs: number } | null
    error?: string
  }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:sync-status', {}, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  // v7.24 (R6): Admin-only — dump every active user's WA creds + conversation
  // state to Odoo chatter. Used by the "Backup de dados no Odoo" button in
  // the admin UsersPanel. Should be triggered manually BEFORE any deploy
  // (in addition to the automatic SIGTERM-triggered backup).
  const backupAllToOdoo = useCallback((): Promise<{
    success: boolean
    backed?: number
    total?: number
    failed?: Array<{ userId: string; email: string; error: string }>
    details?: Array<{ userId: string; email: string; success: boolean; chunksPosted?: number; error?: string }>
    error?: string
  }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('admin:backup-to-odoo', {}, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  // ===== Sales =====
  const searchSales = useCallback((query?: string, limit?: number): Promise<{ success: boolean; data?: OdooSale[]; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:sales:search', { query, limit }, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  const createSale = useCallback((data: { partner_id: number; whatsapp_number?: string }): Promise<{ success: boolean; id?: number; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:sales:create', data, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  // ===== Projects =====
  const searchProjects = useCallback((limit?: number): Promise<{ success: boolean; data?: OdooProject[]; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:projects:list', { limit }, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  const searchTasks = useCallback((query?: string, projectId?: number, limit?: number): Promise<{ success: boolean; data?: OdooTask[]; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:projects:search', { query, project_id: projectId, limit }, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  const createTask = useCallback((data: { name: string; project_id?: number; partner_id?: number; description?: string; whatsapp_number?: string }): Promise<{ success: boolean; id?: number; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:projects:create', data, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  // ===== Link & Log =====
  const linkConversation = useCallback((data: { jid: string; model: string; recordId: number; phone?: string }): Promise<{ success: boolean; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:link-conversation', data, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  const logMessage = useCallback((data: { model: string; recordId: number; message: string; fromWhatsApp?: boolean }): Promise<{ success: boolean; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:log-message', data, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  // ===== Generic =====
  const genericSearch = useCallback((data: { model: string; domain: any[]; fields?: string[]; limit?: number }): Promise<{ success: boolean; data?: any[]; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:search', data, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  const genericRead = useCallback((data: { model: string; ids: number[]; fields?: string[] }): Promise<{ success: boolean; data?: any[]; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:read', data, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  const genericWrite = useCallback((data: { model: string; ids: number[]; values: Record<string, any> }): Promise<{ success: boolean; data?: boolean; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:write', data, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  // ===== Teams & Users =====
  const searchTeams = useCallback((limit?: number): Promise<{ success: boolean; data?: any[]; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:teams:search', { limit }, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  const searchUsers = useCallback((limit?: number): Promise<{ success: boolean; data?: any[]; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:users:search', { limit }, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  return {
    status,
    isConnected,
    authenticate,
    disconnect,
    // Auto-sync
    autoSyncSettings,
    lastSyncResult,
    updateAutoSyncSettings,
    getAutoSyncSettings,
    // Conversation links (for "Pull from Odoo" button)
    conversationLinks,
    // Contacts
    searchContacts,
    createContact,
    searchOrCreateContact,
    // Leads
    searchLeads,
    createLead,
    // History
    fetchHistory,
    // v7.21: Sync all + status
    syncAllHistory,
    getSyncStatus,
    // v7.24 (R6): Admin-only backup of all user sessions to Odoo chatter
    backupAllToOdoo,
    // Sales
    searchSales,
    createSale,
    // Projects
    searchProjects,
    searchTasks,
    createTask,
    // Link & Log
    linkConversation,
    logMessage,
    // Generic
    genericSearch,
    genericRead,
    genericWrite,
    // Teams & Users
    searchTeams,
    searchUsers,
  }
}
