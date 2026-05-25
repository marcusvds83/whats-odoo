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

export interface WhatsAppContact {
  jid: string
  name: string | null
  phone: string
  notify: string | null
}

export function useWhatsApp() {
  const socketRef = useRef<Socket | null>(null)
  const [status, setStatus] = useState<WhatsAppStatus>({ connected: false })
  const [me, setMe] = useState<WhatsAppMe | null>(null)
  const [qrCode, setQrCode] = useState<string | null>(null)
  const [conversations, setConversations] = useState<WhatsAppConversation[]>([])
  const [currentMessages, setCurrentMessages] = useState<WhatsAppMessage[]>([])
  const currentJidRef = useRef<string | null>(null)
  const [currentJid, setCurrentJid] = useState<string | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [contacts, setContacts] = useState<WhatsAppContact[]>([])

  // Odoo sync state per conversation
  const [odooSyncMap, setOdooSyncMap] = useState<Map<string, OdooSyncInfo>>(new Map())

  useEffect(() => {
    const socket = io('/whatsapp', {
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 2000,
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

    socket.on('whatsapp:status', (data: WhatsAppStatus) => {
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
      setConversations(data)
    })

    socket.on('whatsapp:conversation:update', (data: WhatsAppConversation) => {
      setConversations(prev => {
        const idx = prev.findIndex(c => c.jid === data.jid)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = data
          return next.sort((a, b) => {
            const tA = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
            const tB = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
            return tB - tA
          })
        }
        return [data, ...prev]
      })
    })

    socket.on('whatsapp:message', (data: { conversationJid: string; message: WhatsAppMessage; conversation: WhatsAppConversation }) => {
      // Only add message to current view if it's the active conversation
      if (data.conversationJid === currentJidRef.current) {
        setCurrentMessages(prev => {
          // Dedup check on frontend too
          if (prev.some(m => m.id === data.message.id || (m.whatsappId && m.whatsappId === data.message.whatsappId))) {
            return prev
          }
          return [...prev, data.message]
        })
      }
      // Update conversation in list
      setConversations(prev => {
        const idx = prev.findIndex(c => c.jid === data.conversationJid)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = data.conversation
          return next
        }
        return [data.conversation, ...prev]
      })
    })

    // Contacts sync
    socket.on('whatsapp:contacts', (data: WhatsAppContact[]) => {
      setContacts(data)
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
  }, []) // NO currentJid dependency - socket persists across conversation changes

  const requestQR = useCallback(() => {
    socketRef.current?.emit('whatsapp:request-qr')
  }, [])

  const loadMessages = useCallback((jid: string) => {
    currentJidRef.current = jid
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

  const getConversationInfo = useCallback((jid: string): Promise<{
    success: boolean
    conversation: WhatsAppConversation | null
    messages: WhatsAppMessage[]
  }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:get-conversation-info', { jid }, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  const getOdooSync = useCallback((jid: string): OdooSyncInfo | null => {
    return odooSyncMap.get(jid) || null
  }, [odooSyncMap])

  // ========== New v4.0 features ==========

  const checkNumber = useCallback((phone: string): Promise<{ success: boolean; exists?: boolean; jid?: string; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:check-number', { phone }, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  const startConversation = useCallback((phone: string, name?: string): Promise<{ success: boolean; conversation?: WhatsAppConversation; jid?: string; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:start-conversation', { phone, name }, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  const getContacts = useCallback((): Promise<{ success: boolean; data?: WhatsAppContact[] }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:get-contacts', {}, (response: any) => {
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
    // Contacts
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
    getProfilePic,
    getConversationInfo,
    // v4.0 new features
    checkNumber,
    startConversation,
    getContacts,
  }
}
