'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { io, Socket } from 'socket.io-client'
import type {
  WhatsAppConversation,
  WhatsAppMessage,
  WhatsAppStatus,
  WhatsAppMe,
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

  // Odoo sync state per conversation
  const [odooSyncMap, setOdooSyncMap] = useState<Map<string, OdooSyncInfo>>(new Map())

  // Contacts map (jid -> name) from WhatsApp device
  const [contactNames, setContactNames] = useState<Map<string, string>>(new Map())

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

    // Contacts list event (full contacts from device)
    socket.on('whatsapp:contacts-list', (data: Array<{ jid: string; name: string | null; phone: string | null }>) => {
      console.log('[WhatsApp] Contacts list received:', data.length)
      const newMap = new Map<string, string>()
      for (const c of data) {
        if (c.name && c.jid) {
          newMap.set(c.jid, c.name)
        }
      }
      setContactNames(newMap)
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

  // Refresh conversations from device — triggers Baileys re-sync
  const refreshConversations = useCallback(() => {
    socketRef.current?.emit('whatsapp:refresh-conversations')
  }, [])

  // Get contacts list from device
  const getContacts = useCallback(() => {
    socketRef.current?.emit('whatsapp:get-contacts')
  }, [])

  // Start a new conversation by phone number
  const startConversation = useCallback((phone: string): Promise<{ success: boolean; jid?: string; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:start-conversation', { phone }, (response: { success: boolean; jid?: string; error?: string }) => {
        resolve(response)
      })
    })
  }, [])

  // Fetch conversation messages from device (bring current conversation)
  const fetchConversationMessages = useCallback((jid: string) => {
    socketRef.current?.emit('whatsapp:fetch-conversation-messages', { jid }, (response: { success: boolean; count?: number }) => {
      if (response.success && response.count) {
        // Reload messages after fetching
        if (jid === currentJid) {
          socketRef.current?.emit('whatsapp:get-messages', { jid }, (msgResponse: { messages: WhatsAppMessage[] }) => {
            setCurrentMessages(msgResponse.messages)
          })
        }
      }
    })
  }, [currentJid])

  const getOdooSync = useCallback((jid: string): OdooSyncInfo | null => {
    return odooSyncMap.get(jid) || null
  }, [odooSyncMap])

  return {
    status,
    me,
    qrCode,
    conversations,
    currentMessages,
    currentJid,
    isConnected,
    syncProgress,
    // Contacts
    contactNames,
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
    // New actions
    refreshConversations,
    getContacts,
    startConversation,
    fetchConversationMessages,
  }
}
