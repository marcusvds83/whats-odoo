'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { io, Socket } from 'socket.io-client'
import type {
  WhatsAppConversation,
  WhatsAppMessage,
  WhatsAppStatus,
  WhatsAppMe,
  WhatsAppContact,
} from '@/lib/types'

export interface OdooSyncInfo {
  jid: string
  phone: string
  partnerId: number | null
  leadId: number | null
  created: { partner: boolean; lead: boolean }
  errors: string[]
}

export interface SyncProgress {
  isSyncing: boolean
  progress: number
  phase: string
  chatsCount?: number
  contactsCount?: number
  messagesCount?: number
}

/**
 * Sort conversations by date (most recent first)
 * Uses ACTUAL timestamps from WhatsApp (not fabricated ones)
 */
function sortConversations(convs: WhatsAppConversation[]): WhatsAppConversation[] {
  return [...convs].sort((a, b) => {
    const tA = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
    const tB = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
    return tB - tA
  })
}

export function useWhatsApp() {
  const socketRef = useRef<Socket | null>(null)
  const [status, setStatus] = useState<WhatsAppStatus & { hasSession?: boolean }>({ connected: false })
  const [me, setMe] = useState<WhatsAppMe | null>(null)
  const [qrCode, setQrCode] = useState<string | null>(null)
  const [conversations, setConversations] = useState<WhatsAppConversation[]>([])
  const [currentMessages, setCurrentMessages] = useState<WhatsAppMessage[]>([])
  const [currentJid, setCurrentJid] = useState<string | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null)

  // v7.3: Contacts from device
  const [contacts, setContacts] = useState<WhatsAppContact[]>([])

  // Odoo sync state per conversation
  const [odooSyncMap, setOdooSyncMap] = useState<Map<string, OdooSyncInfo>>(new Map())

  useEffect(() => {
    const socket = io('/whatsapp', {
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
      timeout: 15000,
    })

    socketRef.current = socket

    socket.on('connect', () => {
      console.log('[WhatsApp] Socket connected')
      setIsConnected(true)
    })

    socket.on('disconnect', () => {
      console.log('[WhatsApp] Socket disconnected')
      setIsConnected(false)
    })

    socket.on('whatsapp:status', (data: WhatsAppStatus & { hasSession?: boolean }) => {
      console.log('[WhatsApp] Status:', data)
      setStatus(data)
      if (data.connected) {
        setQrCode(null)
      }
    })

    socket.on('whatsapp:qr', (data: { qr: string }) => {
      console.log('[WhatsApp] QR received')
      setQrCode(data.qr)
    })

    socket.on('whatsapp:me', (data: WhatsAppMe) => {
      setMe(data)
    })

    socket.on('whatsapp:conversations', (data: WhatsAppConversation[]) => {
      // Sort conversations by date (most recent first) and filter out invalid ones
      const filtered = data.filter(c => {
        // Accept both individual contacts and groups
        return c.isGroup || (c.phone && /^\d{7,}$/.test(c.phone))
      })
      setConversations(sortConversations(filtered))
    })

    socket.on('whatsapp:conversation:update', (data: WhatsAppConversation) => {
      // Filter out invalid individual contacts (but allow groups)
      if (!data.isGroup && (!data.phone || !/^\d{7,}$/.test(data.phone))) return

      setConversations(prev => {
        const idx = prev.findIndex(c => c.jid === data.jid)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = data
          return sortConversations(next)
        }
        return sortConversations([data, ...prev])
      })
    })

    socket.on('whatsapp:message', (data: { conversationJid: string; message: WhatsAppMessage; conversation: WhatsAppConversation }) => {
      if (data.conversationJid === currentJid) {
        setCurrentMessages(prev => [...prev, data.message])
      }
      // Update conversation in list
      if (data.conversation && (data.conversation.isGroup || (data.conversation.phone && /^\d{7,}$/.test(data.conversation.phone)))) {
        setConversations(prev => {
          const idx = prev.findIndex(c => c.jid === data.conversationJid)
          if (idx >= 0) {
            const next = [...prev]
            next[idx] = data.conversation
            return sortConversations(next)
          }
          return sortConversations([data.conversation, ...prev])
        })
      }
    })

    // Sync progress events
    socket.on('whatsapp:sync-progress', (data: SyncProgress) => {
      console.log('[WhatsApp] Sync progress:', data)
      setSyncProgress(data)
      if (!data.isSyncing) {
        // Clear sync progress after a delay
        setTimeout(() => setSyncProgress(null), 3000)
      }
    })

    // Odoo sync events (from WhatsApp service forwarding)
    socket.on('whatsapp:odoo-sync', (data: OdooSyncInfo) => {
      console.log('[WhatsApp] Odoo sync:', data)
      setOdooSyncMap(prev => {
        const next = new Map(prev)
        next.set(data.jid, data)
        return next
      })
    })

    return () => {
      socket.disconnect()
    }
  }, [])

  const requestQR = useCallback(() => {
    socketRef.current?.emit('whatsapp:request-qr')
  }, [])

  const loadMessages = useCallback((jid: string) => {
    setCurrentJid(jid)
    setCurrentMessages([])
    socketRef.current?.emit('whatsapp:get-messages', { jid }, (response: { messages: WhatsAppMessage[] }) => {
      setCurrentMessages(response.messages)
    })
  }, [])

  const sendMessage = useCallback((jid: string, text: string): Promise<boolean> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:send-message', { jid, text }, (response: { success: boolean }) => {
        resolve(response.success)
      })
    })
  }, [])

  const markRead = useCallback((jid: string) => {
    socketRef.current?.emit('whatsapp:mark-read', { jid }, () => {})
  }, [])

  // Soft disconnect — keeps session alive for auto-reconnect
  const disconnect = useCallback((): Promise<boolean> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:disconnect', (response: { success: boolean }) => {
        resolve(response.success)
      })
    })
  }, [])

  // Hard logout — removes session, requires QR next time
  const logout = useCallback((): Promise<boolean> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:logout', (response: { success: boolean }) => {
        resolve(response.success)
      })
    })
  }, [])

  const getProfilePic = useCallback((jid: string): Promise<string | null> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:get-profile-pic', { jid }, (response: { success: boolean; url?: string | null }) => {
        resolve(response.url || null)
      })
    })
  }, [])

  const getOdooSync = useCallback((jid: string): OdooSyncInfo | null => {
    return odooSyncMap.get(jid) || null
  }, [odooSyncMap])

  // ========== v7.3: NEW ACTIONS ==========

  // Refresh conversations — re-fetches profile pics, group metadata from device
  const refreshConversations = useCallback((): Promise<{ success: boolean; refreshed?: number; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:refresh-conversations', (response: { success: boolean; refreshed?: number; error?: string }) => {
        resolve(response)
      })
    })
  }, [])

  // Start new conversation by phone number
  const startNewConversation = useCallback((phone: string): Promise<{ success: boolean; jid?: string; conversation?: WhatsAppConversation; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:start-conversation', { phone }, (response: { success: boolean; jid?: string; conversation?: WhatsAppConversation; error?: string }) => {
        resolve(response)
      })
    })
  }, [])

  // Get all contacts from device
  const getAllContacts = useCallback((): Promise<{ success: boolean; contacts?: WhatsAppContact[]; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:get-contacts', (response: { success: boolean; contacts?: WhatsAppContact[]; error?: string }) => {
        if (response.success && response.contacts) {
          setContacts(response.contacts)
        }
        resolve(response)
      })
    })
  }, [])

  // Force full sync — reconnects with syncFullHistory=true to fetch ALL conversations from device
  const forceFullSync = useCallback((): Promise<{ success: boolean; message?: string; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:force-full-sync', (response: { success: boolean; message?: string; error?: string }) => {
        resolve(response)
      })
    })
  }, [])

  return {
    status,
    me,
    qrCode,
    conversations,
    currentMessages,
    currentJid,
    isConnected,
    syncProgress,
    // v7.3: Contacts from device
    contacts,
    // Odoo sync
    odooSyncMap,
    getOdooSync,
    // Actions
    requestQR,
    loadMessages,
    sendMessage,
    markRead,
    disconnect,
    logout,
    getProfilePic,
    // v7.3: New actions
    refreshConversations,
    startNewConversation,
    getAllContacts,
    forceFullSync,
  }
}
