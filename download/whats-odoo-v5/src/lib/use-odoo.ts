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

export function useOdoo() {
  const socketRef = useRef<Socket | null>(null)
  const [status, setStatus] = useState<OdooStatus>({ connected: false })
  const [isConnected, setIsConnected] = useState(false)
  const [autoSyncSettings, setAutoSyncSettings] = useState<AutoSyncSettings>({
    enabled: true,
    autoCreateContact: true,
    autoCreateLead: true,
    autoPostMessages: true,
    autoCreateActivity: true,
    leadPrefix: '[WhatsApp] ',
    leadTeamId: null,
    leadUserId: null,
  })
  const [lastSyncResult, setLastSyncResult] = useState<AutoSyncResult | null>(null)

  useEffect(() => {
    const socket = io('/odoo', {
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 2000,
      timeout: 15000,
    })

    socketRef.current = socket

    socket.on('connect', () => {
      console.log('[Odoo] Socket connected')
      setIsConnected(true)
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
    })

    // Auto-sync events
    socket.on('odoo:autosync:settings', (data: AutoSyncSettings) => {
      console.log('[Odoo] Auto-sync settings:', data)
      setAutoSyncSettings(data)
    })

    socket.on('odoo:autosync:result', (data: AutoSyncResult) => {
      console.log('[Odoo] Auto-sync result:', data)
      setLastSyncResult(data)
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

  const createLead = useCallback((data: { name: string; phone?: string; partner_id?: number; partner_name?: string; description?: string; type?: string; whatsapp_number?: string }): Promise<{ success: boolean; id?: number; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:leads:create', data, (response: any) => {
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

  // ===== Search Records (Multi-Model) =====
  const searchRecords = useCallback((data: { query?: string; models?: string[]; limit?: number }): Promise<{ success: boolean; data?: Array<{ model: string; modelLabel: string; recordId: number; name: string; details: any }>; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:search-records', data, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  // ===== Link and Post Chatter =====
  const linkAndPostChatter = useCallback((data: { jid: string; model: string; recordId: number; phone?: string; messages?: any[]; postToChatter?: boolean }): Promise<{ success: boolean; messagesPosted?: number; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('odoo:link-and-post-chatter', data, (response: any) => {
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
    // Contacts
    searchContacts,
    createContact,
    searchOrCreateContact,
    // Leads
    searchLeads,
    createLead,
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
    linkAndPostChatter,
    // Search (Multi-Model)
    searchRecords,
    // Generic
    genericSearch,
    genericRead,
    genericWrite,
    // Teams & Users
    searchTeams,
    searchUsers,
  }
}
