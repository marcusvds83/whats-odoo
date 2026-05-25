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

// Normalize JID: strip device suffix (:XX) and resolve @lid to @s.whatsapp.net
function normalizeJid(jid: string): string {
  if (!jid) return jid
  // Strip device suffix (:XX)
  let normalized = jid.replace(/:\d+@/, '@')
  // Convert @lid to @s.whatsapp.net if we have the mapping (frontend keeps a local map)
  if (normalized.includes('@lid')) {
    const phone = lidPhoneMapLocal.get(normalized)
    if (phone) {
      normalized = `${phone}@s.whatsapp.net`
    }
  }
  normalized = normalized.replace(/@c\.us$/, '@s.whatsapp.net')
  return normalized
}

// Local LID→Phone map (frontend mirror of backend)
const lidPhoneMapLocal = new Map<string, string>()

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
  // v6.0: Loading state for messages
  const [messagesLoading, setMessagesLoading] = useState(false)

  // Sync/Merge status
  const [syncStatus, setSyncStatus] = useState<string | null>(null)
  const [mergeStatus, setMergeStatus] = useState<string | null>(null)

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
      // Normalize all JIDs to prevent duplicates from device variants
      const normalized = data.map(c => ({ ...c, jid: normalizeJid(c.jid) }))
      // v4.7: Filter out @lid conversations (no real phone)
      const filtered = normalized.filter(c => !c.jid.includes('@lid'))
      // Deduplicate by normalized JID
      const seen = new Map<string, WhatsAppConversation>()
      // Also deduplicate by phone number in case JIDs differ for same contact
      const phoneSeen = new Map<string, WhatsAppConversation>()
      for (const c of filtered) {
        const existing = seen.get(c.jid)
        if (!existing || (c.lastMessageAt && existing.lastMessageAt && new Date(c.lastMessageAt) > new Date(existing.lastMessageAt))) {
          seen.set(c.jid, c)
          // Track by phone too
          if (c.phone) {
            const existingByPhone = phoneSeen.get(c.phone)
            if (!existingByPhone || (c.lastMessageAt && existingByPhone.lastMessageAt && new Date(c.lastMessageAt) > new Date(existingByPhone.lastMessageAt))) {
              phoneSeen.set(c.phone, c)
            }
          }
        }
      }
      // Final pass: if phone dedup found duplicates, merge
      const final = new Map<string, WhatsAppConversation>()
      for (const c of seen.values()) {
        if (c.phone) {
          const byPhone = phoneSeen.get(c.phone)
          if (byPhone && byPhone.jid !== c.jid) {
            // Skip this one, the phone dedup version is better
            continue
          }
        }
        final.set(c.jid, c)
      }
      // Add phone-deduped versions that might not be in final
      for (const c of phoneSeen.values()) {
        if (!final.has(c.jid)) {
          final.set(c.jid, c)
        }
      }
      // v4.7: Sort by lastMessageAt descending (most recent first)
      const sorted = Array.from(final.values()).sort((a, b) => {
        const tA = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
        const tB = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
        return tB - tA
      })
      setConversations(sorted)
    })

    socket.on('whatsapp:conversation:update', (data: WhatsAppConversation) => {
      const normalizedData = { ...data, jid: normalizeJid(data.jid) }
      setConversations(prev => {
        const idx = prev.findIndex(c => c.jid === normalizedData.jid)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = normalizedData
          return next.sort((a, b) => {
            const tA = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
            const tB = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
            return tB - tA
          })
        }
        return [normalizedData, ...prev]
      })
    })

    socket.on('whatsapp:message', (data: { conversationJid: string; message: WhatsAppMessage; conversation: WhatsAppConversation }) => {
      const normalizedJid = normalizeJid(data.conversationJid)
      const normalizedConversation = { ...data.conversation, jid: normalizeJid(data.conversation.jid) }
      // v6.0: Add message to current view if it belongs to the active conversation
      if (normalizedJid === normalizeJid(currentJidRef.current || '')) {
        setCurrentMessages(prev => {
          // Dedup check on frontend too
          if (prev.some(m => m.id === data.message.id || (m.whatsappId && m.whatsappId === data.message.whatsappId))) {
            return prev
          }
          return [...prev, data.message]
        })
        // Clear loading state when messages arrive
        setMessagesLoading(false)
      }
      // Update conversation in list
      setConversations(prev => {
        const idx = prev.findIndex(c => c.jid === normalizedJid)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = normalizedConversation
          return next
        }
        return [normalizedConversation, ...prev]
      })
    })

    // Contacts sync
    socket.on('whatsapp:contacts', (data: WhatsAppContact[]) => {
      // Normalize contact JIDs and deduplicate
      const seen = new Map<string, WhatsAppContact>()
      for (const c of data) {
        const nj = normalizeJid(c.jid)
        // v4.7: Skip @lid contacts that couldn't be resolved
        if (nj.includes('@lid')) continue
        // Dedup by phone: keep the one with better name
        if (c.phone) {
          const existingByPhone = Array.from(seen.values()).find(e => e.phone === c.phone)
          if (existingByPhone) {
            const newName = c.name || c.notify || null
            if (newName && (!existingByPhone.name || existingByPhone.name.length < newName.length)) {
              existingByPhone.name = newName
            }
            continue
          }
        }
        seen.set(nj, { ...c, jid: nj })
      }
      setContacts(Array.from(seen.values()))
    })

    // History sync progress (from Baileys messaging-history.set)
    socket.on('whatsapp:history-sync-progress', (data: { progress: number | null; isLatest?: boolean; syncType?: number }) => {
      console.log('[WhatsApp] History sync progress:', data)
      if (data.progress !== null && data.progress !== undefined) {
        if (data.progress >= 100 || data.isLatest) {
          setSyncStatus('Sincronizacao completa!')
          setTimeout(() => setSyncStatus(null), 5000)
        } else {
          setSyncStatus(`Sincronizando... ${Math.min(Math.round(data.progress), 100)}%`)
        }
      }
    })

    // v5.1: Sync complete event
    socket.on('whatsapp:sync-complete', (data: { conversations: number; contacts: number }) => {
      console.log('[WhatsApp] Sync complete:', data)
      setSyncStatus('Sincronizacao completa!')
      setTimeout(() => setSyncStatus(null), 5000)
    })

    // Odoo sync events (from WhatsApp service forwarding)
    socket.on('whatsapp:odoo-sync', (data: OdooSyncInfo) => {
      console.log('[WhatsApp] Odoo sync:', data)
      const normalizedJid = normalizeJid(data.jid)
      setOdooSyncMap(prev => {
        const next = new Map(prev)
        next.set(normalizedJid, { ...data, jid: normalizedJid })
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
    const nj = normalizeJid(jid)
    currentJidRef.current = nj
    setCurrentJid(nj)
    setCurrentMessages([])
    setMessagesLoading(true)
    socketRef.current?.emit('whatsapp:get-messages', { jid: nj }, (response: { messages: WhatsAppMessage[] }) => {
      setCurrentMessages(response.messages)
      setMessagesLoading(false)
      // v6.0: If response has 0 messages, automatically trigger fetchRecentMessages
      if (response.messages.length === 0) {
        console.log('[WhatsApp] No messages in response, triggering fetchRecentMessages...')
        socketRef.current?.emit('whatsapp:load-messages', { jid: nj }, (fetchResponse: { success: boolean; fetchStarted?: boolean; error?: string }) => {
          if (fetchResponse?.success && fetchResponse?.fetchStarted) {
            console.log('[WhatsApp] Fetch started, waiting for messages to arrive...')
            // Messages will arrive via whatsapp:message events which update currentMessages
            setMessagesLoading(true)
            // Set a timeout to clear loading if no messages arrive
            setTimeout(() => setMessagesLoading(false), 10000)
          } else {
            setMessagesLoading(false)
          }
        })
      }
    })
  }, [])

  const sendMessage = useCallback((jid: string, text: string): Promise<boolean> => {
    const nj = normalizeJid(jid)
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:send-message', { jid: nj, text }, (response: { success: boolean }) => {
        resolve(response.success)
      })
    })
  }, [])

  const markRead = useCallback((jid: string) => {
    socketRef.current?.emit('whatsapp:mark-read', { jid: normalizeJid(jid) }, () => {})
  }, [])

  const disconnect = useCallback((): Promise<boolean> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:disconnect', (response: { success: boolean }) => {
        resolve(response.success)
      })
    })
  }, [])

  const getProfilePic = useCallback((jid: string): Promise<string | null> => {
    const nj = normalizeJid(jid)
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:get-profile-pic', { jid: nj }, (response: { success: boolean; url?: string | null }) => {
        resolve(response.url || null)
      })
    })
  }, [])

  const getConversationInfo = useCallback((jid: string): Promise<{
    success: boolean
    conversation: WhatsAppConversation | null
    messages: WhatsAppMessage[]
  }> => {
    const nj = normalizeJid(jid)
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:get-conversation-info', { jid: nj }, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  const getOdooSync = useCallback((jid: string): OdooSyncInfo | null => {
    return odooSyncMap.get(normalizeJid(jid)) || null
  }, [odooSyncMap])

  // ========== New v4.0 features ==========

  const checkNumber = useCallback((phone: string): Promise<{ success: boolean; exists?: boolean; jid?: string; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:check-number', { phone }, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  const startConversation = useCallback((phone: string, name?: string, jid?: string): Promise<{ success: boolean; conversation?: WhatsAppConversation; jid?: string; error?: string }> => {
    const nj = jid ? normalizeJid(jid) : undefined
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:start-conversation', { phone, name, jid: nj }, (response: any) => {
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

  // ========== Sync phone conversations ==========
  const syncConversations = useCallback((): Promise<{ success: boolean; conversations?: number; message?: string; error?: string }> => {
    setSyncStatus('Sincronizando...')
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:sync-phone-conversations', {}, (response: any) => {
        if (response.success) {
          setSyncStatus(response.message || 'Sincronizado!')
          setTimeout(() => setSyncStatus(null), 5000)
        } else {
          setSyncStatus('Erro: ' + (response.error || 'Falha'))
          setTimeout(() => setSyncStatus(null), 5000)
        }
        resolve(response)
      })
    })
  }, [])

  // ========== Merge duplicate conversations ==========
  const mergeDuplicates = useCallback((): Promise<{ success: boolean; before?: number; after?: number; merged?: number; message?: string; error?: string }> => {
    setMergeStatus('Mesclando...')
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:merge-duplicates', {}, (response: any) => {
        if (response.success) {
          setMergeStatus(response.message || 'Pronto!')
          setTimeout(() => setMergeStatus(null), 5000)
        } else {
          setMergeStatus('Erro: ' + (response.error || 'Falha'))
          setTimeout(() => setMergeStatus(null), 5000)
        }
        resolve(response)
      })
    })
  }, [])

  // ========== v5.1: Fetch recent messages for a conversation ==========
  const fetchRecentMessages = useCallback((jid: string, count: number = 50): Promise<{ success: boolean; fetchStarted?: boolean; error?: string }> => {
    const nj = normalizeJid(jid)
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:fetch-recent-messages', { jid: nj, count }, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  // ========== v6.0: Load messages via fetchMessageHistory ==========
  const loadMessagesSocket = useCallback((jid: string): Promise<{ success: boolean; fetchStarted?: boolean; error?: string }> => {
    const nj = normalizeJid(jid)
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:load-messages', { jid: nj }, (response: any) => {
        resolve(response)
      })
    })
  }, [])

  // ========== v5.1: Reset WhatsApp session ==========
  const resetSession = useCallback((): Promise<{ success: boolean; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:reset-session', {}, (response: any) => {
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
    // v6.0: Messages loading state
    messagesLoading,
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
    // v4.4 features
    syncConversations,
    mergeDuplicates,
    syncStatus,
    mergeStatus,
    // v5.1 features
    fetchRecentMessages,
    resetSession,
    // v6.0 features
    loadMessagesSocket,
  }
}
