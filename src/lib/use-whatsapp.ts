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

/**
 * v7.14: Normalize a JID to canonical form <digits>@s.whatsapp.net for comparison.
 * Baileys may send JIDs with a :N device suffix (e.g. 5511999888777:7@s.whatsapp.net)
 * which would NOT match the canonical JID stored in the conversations list.
 */
function normalizeJidForCompare(j: string | null | undefined): string | null {
  if (!j) return null
  const atIdx = j.indexOf('@')
  if (atIdx < 0) return null
  const server = j.slice(atIdx + 1)
  if (server !== 's.whatsapp.net') return null
  const userCombined = j.slice(0, atIdx)
  const user = userCombined.split(':')[0].split('_')[0]
  if (!/^\d{7,}$/.test(user)) return null
  return `${user}@s.whatsapp.net`
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
      // *** CRITICAL: Normalize JIDs to canonical form <digits>@s.whatsapp.net
      // before comparing. Baileys may send JIDs with a :N device suffix
      // (e.g. 5511999888777:7@s.whatsapp.net) which would NOT match the
      // canonical JID stored in the conversations list, causing incoming
      // messages to never be appended to the active chat view.
      const normalizedIncoming = normalizeJidForCompare(data.conversationJid)
      const normalizedCurrent = normalizeJidForCompare(currentJidRef.current)
      const isActive = normalizedIncoming !== null && normalizedIncoming === normalizedCurrent

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

    // v7.14: Listen for "messages refreshed" events — emitted by the server
    // after a fetchMessageHistory call completes. Used to update the active
    // chat view with newly-fetched messages.
    socket.on('whatsapp:messages:refreshed', (data: { jid: string; messages: WhatsAppMessage[] }) => {
      console.log('[WhatsApp] Messages refreshed:', data.jid, data.messages.length, 'msgs')
      // Only update if this is for the active conversation
      const normalizedIncoming = normalizeJidForCompare(data.jid)
      const normalizedCurrent = normalizeJidForCompare(currentJidRef.current)
      if (normalizedIncoming && normalizedIncoming === normalizedCurrent) {
        setCurrentMessages(prev => {
          // Merge: keep existing messages, append new ones (dedup by id)
          const existingIds = new Set(prev.map(m => m.id))
          const newOnes = data.messages.filter(m => !existingIds.has(m.id))
          if (newOnes.length === 0) return prev
          console.log(`[WhatsApp] Appending ${newOnes.length} refreshed messages`)
          // Sort all by timestamp
          return [...prev, ...newOnes].sort((a, b) => {
            const tA = new Date(a.timestamp).getTime()
            const tB = new Date(b.timestamp).getTime()
            return tA - tB
          })
        })
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

  // ===== v7.14: Refresh messages for a conversation =====
  // Called by the "Atualizar mensagens" button in the chat view OR by the
  // auto-polling mechanism (every 5 seconds for the active conversation).
  // Returns the latest local messages AND triggers a server-side fetch
  // (fetchMessageHistory) in the background to catch any missed messages.
  const refreshMessages = useCallback((jid: string): Promise<{ success: boolean; messages?: WhatsAppMessage[]; count?: number; serverFetchAttempted?: boolean; error?: string }> => {
    return new Promise((resolve) => {
      socketRef.current?.emit('whatsapp:refresh-messages', { jid }, (response: any) => {
        if (response && response.success && response.messages) {
          // Replace current messages with the refreshed set (if for active chat)
          const normalizedIncoming = normalizeJidForCompare(jid)
          const normalizedCurrent = normalizeJidForCompare(currentJidRef.current)
          if (normalizedIncoming && normalizedIncoming === normalizedCurrent) {
            setCurrentMessages(response.messages)
          }
        }
        resolve(response)
      })
    })
  }, [])

  // ===== v7.14: Auto-polling for active conversation =====
  // Polls the server every 5 seconds for the active conversation's messages.
  // This is a fallback in case `messages.upsert` events don't fire (which has
  // been reported in some Baileys edge cases). The poll only fetches the local
  // server-side cache — it does NOT trigger a fetchMessageHistory call (that
  // would be too expensive every 5s). The user can manually click "Atualizar"
  // to trigger a server-side fetch.
  useEffect(() => {
    if (!currentJid) return
    // Use a ref-like pattern to avoid stale closures
    const jid = currentJid
    const pollInterval = setInterval(() => {
      // Only poll if this is still the active conversation
      if (currentJidRef.current !== jid) return
      socketRef.current?.emit('whatsapp:get-messages', { jid }, (response: { messages: WhatsAppMessage[] }) => {
        if (currentJidRef.current !== jid) return
        // Only update if the message count changed (avoid unnecessary re-renders)
        setCurrentMessages(prev => {
          if (response.messages.length === prev.length) return prev
          // Check if any new messages exist that aren't in prev
          const existingIds = new Set(prev.map(m => m.id))
          const hasNew = response.messages.some(m => !existingIds.has(m.id))
          if (!hasNew) return prev
          console.log(`[WhatsApp] Polling found ${response.messages.length - prev.length} new message(s)`)
          return response.messages
        })
      })
    }, 5000)
    return () => clearInterval(pollInterval)
  }, [currentJid])

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
    // v7.14 actions
    refreshMessages,
  }
}
