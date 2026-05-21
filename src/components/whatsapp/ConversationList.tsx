'use client'

import { useState, useMemo } from 'react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  MessageCircle,
  Phone,
  Search,
  User,
  Plus,
  Loader2,
  X,
  RefreshCw,
  Merge,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WhatsAppContact } from '@/lib/use-whatsapp'

interface Conversation {
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
}

interface ConversationListProps {
  conversations: Conversation[]
  selectedJid: string | null
  onSelect: (jid: string) => void
  // v4.0: contacts
  contacts?: WhatsAppContact[]
  onStartConversation?: (phone: string, name?: string, jid?: string) => Promise<{ success: boolean; jid?: string; error?: string }>
  onCheckNumber?: (phone: string) => Promise<{ success: boolean; exists?: boolean; jid?: string }>
  // v4.4: sync & merge
  onSyncConversations?: () => Promise<{ success: boolean; message?: string }>
  onMergeDuplicates?: () => Promise<{ success: boolean; merged?: number; message?: string }>
  syncStatus?: string | null
  mergeStatus?: string | null
  fetchRecentMessages?: (jid: string, count?: number) => Promise<{ success: boolean; fetchStarted?: boolean; error?: string }>
  // v6.0: Load messages explicitly
  onLoadMessages?: (jid: string) => Promise<{ success: boolean; fetchStarted?: boolean; error?: string }>
}

function formatTime(dateStr: string | null): string {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (diffDays === 1) return 'Ontem'
  if (diffDays < 7) return date.toLocaleDateString('pt-BR', { weekday: 'short' })
  return date.toLocaleDateString('pt-BR', { month: 'short', day: 'numeric' })
}

export function ConversationList({
  conversations,
  selectedJid,
  onSelect,
  contacts = [],
  onStartConversation,
  onCheckNumber,
  onSyncConversations,
  onMergeDuplicates,
  syncStatus,
  mergeStatus,
  fetchRecentMessages,
  onLoadMessages,
}: ConversationListProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [activeTab, setActiveTab] = useState<'conversations' | 'contacts'>('conversations')
  const [newConvOpen, setNewConvOpen] = useState(false)
  const [newPhone, setNewPhone] = useState('')
  const [newName, setNewName] = useState('')
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [merging, setMerging] = useState(false)
  const [loadingJid, setLoadingJid] = useState<string | null>(null)

  const filteredConversations = useMemo(() => {
    if (!searchQuery.trim()) return conversations
    const q = searchQuery.toLowerCase()
    return conversations.filter(c =>
      (c.pushName && c.pushName.toLowerCase().includes(q)) ||
      (c.phone && c.phone.includes(q)) ||
      (c.name && c.name.toLowerCase().includes(q))
    )
  }, [conversations, searchQuery])

  const filteredContacts = useMemo(() => {
    if (!searchQuery.trim()) return contacts
    const q = searchQuery.toLowerCase()
    return contacts.filter(c =>
      (c.name && c.name.toLowerCase().includes(q)) ||
      c.phone.includes(q) ||
      (c.notify && c.notify.toLowerCase().includes(q))
    )
  }, [contacts, searchQuery])

  const handleSyncConversations = async () => {
    if (!onSyncConversations || syncing) return
    setSyncing(true)
    try {
      await onSyncConversations()
    } finally {
      setSyncing(false)
    }
  }

  const handleMergeDuplicates = async () => {
    if (!onMergeDuplicates || merging) return
    setMerging(true)
    try {
      await onMergeDuplicates()
    } finally {
      setMerging(false)
    }
  }

  const handleStartConversation = async () => {
    if (!onStartConversation || !newPhone.trim()) return
    setStarting(true)
    setStartError('')
    try {
      const result = await onStartConversation(newPhone.replace(/[^0-9]/g, ''), newName || undefined)
      if (result.success && result.jid) {
        onSelect(result.jid)
        setNewConvOpen(false)
        setNewPhone('')
        setNewName('')
      } else {
        setStartError(result.error || 'Numero nao encontrado no WhatsApp')
      }
    } catch (err: any) {
      setStartError(err.message || 'Erro ao iniciar conversa')
    } finally {
      setStarting(false)
    }
  }

  const handleContactClick = (contact: WhatsAppContact) => {
    // If there's an existing conversation with this contact, select it
    // Check by JID match OR by phone number (to prevent duplicates from device suffix)
    const existing = conversations.find(c =>
      c.jid === contact.jid ||
      (c.phone && c.phone === contact.phone) ||
      (c.jid && contact.jid && c.jid.replace(/:\d+@/, '@') === contact.jid.replace(/:\d+@/, '@'))
    )
    if (existing) {
      onSelect(existing.jid)
      return
    }
    // Otherwise start a new conversation — PASS THE JID to prevent duplicates
    if (onStartConversation) {
      onStartConversation(contact.phone, contact.name || contact.notify || undefined, contact.jid)
        .then(result => {
          if (result.success && result.jid) {
            onSelect(result.jid)
          }
        })
        .catch(() => {})
    }
  }

  // v6.0: Handle loading messages for empty conversations
  const handleLoadMessages = async (jid: string) => {
    if (!onLoadMessages || loadingJid === jid) return
    setLoadingJid(jid)
    try {
      await onLoadMessages(jid)
    } finally {
      setTimeout(() => setLoadingJid(null), 3000) // Keep loading state for 3s
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header with tabs */}
      <div className="shrink-0 border-b">
        <div className="flex items-center gap-2 px-3 py-2">
          <h2 className="text-sm font-semibold flex-1">Mensagens</h2>
          {/* Sync & Merge buttons */}
          <Button
            variant="outline"
            size="icon"
            className="size-7"
            onClick={handleMergeDuplicates}
            disabled={merging || !onMergeDuplicates}
            title="Mesclar conversas duplicadas"
          >
            {merging ? <Loader2 className="size-3.5 animate-spin" /> : <Merge className="size-3.5" />}
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-7"
            onClick={handleSyncConversations}
            disabled={syncing || !onSyncConversations}
            title="Sincronizar conversas com meu telefone"
          >
            {syncing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-7"
            onClick={() => setNewConvOpen(!newConvOpen)}
            title="Nova conversa"
          >
            <Plus className="size-3.5" />
          </Button>
        </div>

        {/* Sync/Merge status messages */}
        {(syncStatus || mergeStatus) && (
          <div className="px-3 pb-1">
            <p className="text-xs text-center text-emerald-600 dark:text-emerald-400">
              {syncStatus || mergeStatus}
            </p>
          </div>
        )}

        {/* New conversation form */}
        {newConvOpen && (
          <div className="px-3 pb-2 space-y-2 border-b bg-muted/30">
            <div className="flex items-center gap-1.5">
              <Input
                placeholder="Numero ex: 5511999999999"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                className="h-8 text-sm flex-1"
              />
              <Button
                size="sm"
                className="h-8 gap-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                disabled={!newPhone.trim() || starting}
                onClick={handleStartConversation}
              >
                {starting ? <Loader2 className="size-3.5 animate-spin" /> : <MessageCircle className="size-3.5" />}
                Iniciar
              </Button>
              <Button variant="ghost" size="icon" className="size-8" onClick={() => setNewConvOpen(false)}>
                <X className="size-3.5" />
              </Button>
            </div>
            <Input
              placeholder="Nome (opcional)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="h-7 text-xs"
            />
            {startError && (
              <p className="text-xs text-red-500">{startError}</p>
            )}
          </div>
        )}

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)} className="w-full">
          <TabsList className="w-full rounded-none border-b bg-transparent h-9 p-0">
            <TabsTrigger value="conversations" className="flex-1 gap-1 text-xs data-[state=active]:bg-muted rounded-none data-[state=active]:shadow-none border-b-2 border-transparent data-[state=active]:border-primary">
              <MessageCircle className="size-3.5" /> Conversas
              {conversations.reduce((s, c) => s + c.unreadCount, 0) > 0 && (
                <Badge className="size-5 p-0 flex items-center justify-center text-[10px] bg-emerald-500 text-white border-0">
                  {conversations.reduce((s, c) => s + c.unreadCount, 0)}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="contacts" className="flex-1 gap-1 text-xs data-[state=active]:bg-muted rounded-none data-[state=active]:shadow-none border-b-2 border-transparent data-[state=active]:border-primary">
              <User className="size-3.5" /> Contatos
              {contacts.length > 0 && (
                <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">{contacts.length}</Badge>
              )}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Search */}
        <div className="px-3 py-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={activeTab === 'conversations' ? 'Buscar conversas...' : 'Buscar contatos...'}
              className="h-8 pl-8 text-sm"
            />
          </div>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'conversations' && (
          <div className="space-y-0.5 p-1">
            {filteredConversations.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <MessageCircle className="size-8 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">Nenhuma conversa</p>
                <p className="text-xs text-muted-foreground/70">Conecte o WhatsApp para ver suas conversas</p>
              </div>
            )}
            {filteredConversations.map((conv) => {
              const isSelected = conv.jid === selectedJid
              const displayName = conv.contactName || conv.name || conv.pushName || conv.phone || conv.jid.split('@')[0]
              return (
                <button
                  key={conv.jid}
                  onClick={() => onSelect(conv.jid)}
                  className={cn(
                    'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors',
                    isSelected ? 'bg-primary/10' : 'hover:bg-muted/60'
                  )}
                >
                  <Avatar className="size-10 shrink-0">
                    {conv.avatarUrl && <AvatarImage src={conv.avatarUrl} alt={displayName} />}
                    <AvatarFallback className="bg-primary/10 text-primary text-xs">
                      {displayName.split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || <User className="size-4" />}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium truncate">{displayName}</span>
                      <span className="text-[10px] text-muted-foreground shrink-0 ml-1">{formatTime(conv.lastMessageAt)}</span>
                    </div>
                    <div className="flex items-center justify-between mt-0.5">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Phone className="size-3" />
                          <span>{conv.phone}</span>
                        </div>
                        <span className="text-xs text-muted-foreground truncate block">
                          {conv.messageCount === 0
                            ? (loadingJid === conv.jid
                              ? <span className="flex items-center gap-1 text-emerald-600"><Loader2 className="size-3 animate-spin" /> Carregando...</span>
                              : (onLoadMessages
                                ? <button onClick={(e) => { e.stopPropagation(); handleLoadMessages(conv.jid) }} className="text-emerald-600 hover:underline cursor-pointer">Toque para carregar</button>
                                : 'Sem mensagens'))
                            : (conv.lastMessage || 'Sem mensagens')}
                        </span>
                      </div>
                      {conv.unreadCount > 0 && (
                        <Badge className="size-5 p-0 flex items-center justify-center text-[10px] bg-emerald-500 text-white border-0 shrink-0 ml-1">
                          {conv.unreadCount}
                        </Badge>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {activeTab === 'contacts' && (
          <div className="space-y-0.5 p-1">
            {filteredContacts.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <User className="size-8 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">Nenhum contato</p>
                <p className="text-xs text-muted-foreground/70">Conecte o WhatsApp para sincronizar seus contatos</p>
              </div>
            )}
            {filteredContacts.map((contact) => {
              const hasConversation = conversations.some(c => c.jid === contact.jid)
              const displayName = contact.name || contact.notify || contact.phone
              return (
                <button
                  key={contact.jid}
                  onClick={() => handleContactClick(contact)}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left hover:bg-muted/60 transition-colors"
                >
                  <Avatar className="size-9 shrink-0">
                    <AvatarFallback className={cn("text-xs", hasConversation ? "bg-emerald-50 text-emerald-700" : "bg-primary/10 text-primary")}>
                      {displayName.split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || <User className="size-3.5" />}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{displayName}</span>
                      {hasConversation && (
                        <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 bg-emerald-50 text-emerald-700 border-emerald-200">Chat</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Phone className="size-3" />
                      <span>{contact.phone}</span>
                    </div>
                  </div>
                  <MessageCircle className="size-4 text-muted-foreground/50 shrink-0" />
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
