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
  mailMessageId: number | null
  activityId: number | null
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
      // Sort conversations by date (most recent first) and filter out any invalid ones
      const filtered = data.filter(c => {
        // Only accept contacts with phone numbers
        return c.phone && /^\d{7,}$/.test(c.phone)
      })
      setConversations(sortConversations(filtered))
    })

    socket.on('whatsapp:conversation:update', (data: WhatsAppConversation) => {
      // Filter out invalid JIDs
      if (!data.phone || !/^\d{7,}$/.test(data.phone)) return

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
      if (data.conversation && data.conversation.phone && /^\d{7,}$/.test(data.conversation.phone)) {
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
  }, []) // Remove currentJid from deps to avoid re-creating socket

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

  const disconnect = useCallback((): Promise<boolean> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:disconnect', (response: { success: boolean }) => {
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

  return {
    status,
    me,
    qrCode,
    conversations,
    currentMessages,
    currentJid,
    isConnected,
    syncProgress,
    // Odoo sync
    odooSyncMap,
    getOdooSync,
    // Actions
    requestQR,
    loadMessages,
    sendMessage,
    markRead,
    disconnect,
    getProfilePic,
  }
}
