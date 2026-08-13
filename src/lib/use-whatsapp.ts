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

export interface DeviceContact {
  jid: string
  phone: string
  name: string
  avatarUrl: string | null
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

  // Ref mirror of currentJid — used inside the socket.on('whatsapp:message')
  // handler so we don't capture a stale closure of currentJid (which was null
  // at mount). Without this, incoming/sent-echo messages never get appended to
  // currentMessages because the comparison `data.conversationJid === currentJid`
  // always evaluated to `=== null`.
  const currentJidRef = useRef<string | null>(null)
  useEffect(() => {
    currentJidRef.current = currentJid
  }, [currentJid])

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
      console.log('[WhatsApp] Message received:', {
        conversationJid: data.conversationJid,
        currentJid: currentJidRef.current,
        messageId: data.message?.id,
        fromMe: data.message?.fromMe,
        text: data.message?.textContent?.slice(0, 30),
      })

      // Use the ref so we always see the latest currentJid even though this
      // handler is registered once on mount. Without this, sent/incoming
      // messages would never be appended to the active chat view.
      // Normalize JIDs (strip any ":xx" suffix) for the comparison to be safe.
      const normalizeJid = (j: string | null | undefined) => (j ? j.split(':')[0] : j)
      const isActive = normalizeJid(data.conversationJid) === normalizeJid(currentJidRef.current)

      if (isActive) {
        setCurrentMessages(prev => {
          // Dedup by message id — the server echoes our own sends back to us,
          // and Baileys may also deliver the same upsert. Avoid duplicate bubbles.
          if (data.message?.id && prev.some(m => m.id === data.message.id)) {
            console.log('[WhatsApp] Message skipped (duplicate id)')
            return prev
          }
          // Also dedup by whatsappId as a fallback
          if (data.message?.whatsappId && prev.some(m => m.whatsappId === data.message.whatsappId)) {
            console.log('[WhatsApp] Message skipped (duplicate whatsappId)')
            return prev
          }
          console.log('[WhatsApp] Appending message to active chat')
          return [...prev, data.message]
        })
      } else {
        console.log('[WhatsApp] Message for non-active chat, only updating list')
      }

      // Always update the conversation list (so unread/lastMessage reflect new state)
      if (data.conversation && data.conversation.phone && /^\d{7,}$/.test(data.conversation.phone)) {
        setConversations(prev => {
          const idx = prev.findIndex(c => c.jid === data.conversationJid)
          if (idx >= 0) {
            const next = [...prev]
            // Preserve the _isDeviceContact flag if the existing conv had it
            const existing = next[idx]
            next[idx] = { ...data.conversation, _isDeviceContact: (existing as any)?._isDeviceContact }
            return sortConversations(next)
          }
          return sortConversations([data.conversation, ...prev])
        })
      }
    })

    // Message status updates (sent → delivered → read)
    socket.on('whatsapp:message:status', (data: { conversationJid: string; messageId: string; status: string }) => {
      console.log('[WhatsApp] Message status update:', data)
      // Only update if the message is in the active chat
      if (data.conversationJid === currentJidRef.current) {
        setCurrentMessages(prev => prev.map(m =>
          m.id === data.messageId ? { ...m, status: data.status } : m
        ))
      }
    })

    // Handle conversation deletion — clear active chat if needed
    socket.on('whatsapp:conversation:deleted', (data: { jid: string }) => {
      console.log('[WhatsApp] Conversation deleted:', data.jid)
      setConversations(prev => prev.filter(c => c.jid !== data.jid))
      if (currentJidRef.current === data.jid) {
        setCurrentJid(null)
        setCurrentMessages([])
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

  // ===== Get device contacts (phonebook) =====
  const getContacts = useCallback((query?: string): Promise<{ success: boolean; data?: DeviceContact[]; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:get-contacts', { query }, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  // ===== Start a conversation from a phone number =====
  // Verifies the number is on WhatsApp, creates the conversation in memory,
  // and returns the JID so the UI can navigate to the chat.
  const startConversation = useCallback((phone: string, name?: string): Promise<{ success: boolean; jid?: string; error?: string; conversation?: any }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:start-conversation', { phone, name }, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  // ===== Inject historical messages into a conversation =====
  // Used by the "Pull from Odoo" button to restore history that was lost from local memory.
  const injectHistory = useCallback((jid: string, messages: Array<{
    fromMe: boolean
    textContent: string | null
    mediaType?: string | null
    timestamp: string
    externalId?: string
  }>): Promise<{ success: boolean; added?: number; skipped?: number; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:inject-history', { jid, messages }, (response: any) => {
        // After injecting, reload current messages for this JID if it's the active one
        if (response.success && currentJid === jid) {
          socketRef.current?.emit('whatsapp:get-messages', { jid }, (msgResponse: { messages: WhatsAppMessage[] }) => {
            setCurrentMessages(msgResponse.messages)
          })
        }
        resolve(response)
      })
    })
  }, [currentJid])

  const getOdooSync = useCallback((jid: string): OdooSyncInfo | null => {
    return odooSyncMap.get(jid) || null
  }, [odooSyncMap])

  // ===== Delete a conversation =====
  const deleteConversation = useCallback((jid: string): Promise<{ success: boolean; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:delete-conversation', { jid }, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  // ===== Refresh data: re-fetch chats & contacts from phone =====
  const refreshData = useCallback((): Promise<{ success: boolean; chatsFetched?: number; contactsFetched?: number; picsFetched?: number; totalConversations?: number; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:refresh-data', {}, (response: any) => {
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
    // v7.9 actions
    getContacts,
    startConversation,
    injectHistory,
    // v7.12 actions
    deleteConversation,
    refreshData,
  }
}
