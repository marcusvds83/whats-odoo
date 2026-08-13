'use client'

import { useState, useMemo, useEffect, useCallback } from 'react'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import {
  Search,
  MessageCircle,
  Phone,
  Clock,
  Loader2,
  Users,
  MessagesSquare,
  Server,
  RefreshCw,
  Trash2,
  MoreVertical,
} from 'lucide-react'
import { OdooContactSearchDialog } from './OdooContactSearchDialog'
import type { DeviceContact } from '@/lib/use-whatsapp'

interface ConversationListProps {
  conversations: Array<{
    jid: string
    name: string | null
    phone: string | null
    pushName: string | null
    avatarUrl: string | null
    lastMessage: string | null
    lastMessageAt: string | null
    unreadCount: number
  }>
  selectedJid: string | null
  onSelect: (jid: string) => void
  isSyncing?: boolean
  syncProgress?: number
  // New in v7.9: contacts tab support
  onGetContacts?: (query?: string) => Promise<{ success: boolean; data?: DeviceContact[]; error?: string }>
  // New in v7.9: Odoo contact search
  odooConnected?: boolean
  onSearchOdooContacts?: (query?: string, limit?: number) => Promise<{ success: boolean; data?: any[]; error?: string }>
  onStartConversation?: (phone: string, name?: string) => Promise<{ success: boolean; jid?: string; error?: string }>
  // New in v7.10: create Odoo contact from the dialog
  onCreateOdooContact?: (data: { name: string; phone?: string; mobile?: string; whatsapp?: string; email?: string }) => Promise<{ success: boolean; id?: number; error?: string }>
  // New in v7.12: delete + refresh
  onDeleteConversation?: (jid: string) => Promise<{ success: boolean; error?: string }>
  onRefreshData?: () => Promise<{ success: boolean; chatsFetched?: number; contactsFetched?: number; error?: string }>
}

function formatTime(dateStr: string | null): string {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } else if (diffDays === 1) {
    return 'Ontem'
  } else if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: 'short' })
  } else {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }
}

function getDisplayName(conversation: ConversationListProps['conversations'][number]): string {
  return conversation.name || conversation.pushName || conversation.phone || conversation.jid.split('@')[0]
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

function truncateMessage(msg: string | null, maxLen = 45): string {
  if (!msg) return ''
  if (msg.length <= maxLen) return msg
  return msg.slice(0, maxLen) + '...'
}

type Tab = 'conversations' | 'contacts'

export function ConversationList({
  conversations,
  selectedJid,
  onSelect,
  isSyncing,
  syncProgress,
  onGetContacts,
  odooConnected,
  onSearchOdooContacts,
  onStartConversation,
  onCreateOdooContact,
  onDeleteConversation,
  onRefreshData,
}: ConversationListProps) {
  const [activeTab, setActiveTab] = useState<Tab>('conversations')
  const [searchQuery, setSearchQuery] = useState('')
  const [odooSearchOpen, setOdooSearchOpen] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{ jid: string; name: string } | null>(null)

  // Contacts state
  const [contacts, setContacts] = useState<DeviceContact[]>([])
  const [contactsLoading, setContactsLoading] = useState(false)

  // Load contacts when contacts tab is opened
  const loadContacts = useCallback(async (query?: string) => {
    if (!onGetContacts) return
    setContactsLoading(true)
    try {
      const result = await onGetContacts(query)
      if (result.success) {
        setContacts(result.data || [])
      } else {
        setContacts([])
      }
    } catch {
      setContacts([])
    } finally {
      setContactsLoading(false)
    }
  }, [onGetContacts])

  useEffect(() => {
    if (activeTab === 'contacts' && onGetContacts) {
      loadContacts()
    }
  }, [activeTab, onGetContacts, loadContacts])

  // Debounced contact search
  useEffect(() => {
    if (activeTab !== 'contacts' || !onGetContacts) return
    const timer = setTimeout(() => {
      loadContacts(searchQuery || undefined)
    }, 350)
    return () => clearTimeout(timer)
  }, [searchQuery, activeTab, onGetContacts, loadContacts])

  const filteredConversations = useMemo(() => {
    if (!searchQuery.trim()) return conversations
    const query = searchQuery.toLowerCase()
    return conversations.filter(
      (c) =>
        (c.name && c.name.toLowerCase().includes(query)) ||
        (c.phone && c.phone.toLowerCase().includes(query)) ||
        (c.pushName && c.pushName.toLowerCase().includes(query)) ||
        c.jid.toLowerCase().includes(query)
    )
  }, [conversations, searchQuery])

  const totalUnread = conversations.reduce((sum, c) => sum + c.unreadCount, 0)

  const handleStartFromOdoo = async (phone: string, name?: string) => {
    if (!onStartConversation) {
      return { success: false, error: 'Start conversation not available' }
    }
    return onStartConversation(phone, name)
  }

  const handleConversationStarted = (jid: string) => {
    setActiveTab('conversations')
    onSelect(jid)
  }

  const handleRefresh = async () => {
    if (!onRefreshData || isRefreshing) return
    setIsRefreshing(true)
    try {
      const result = await onRefreshData()
      if (!result.success) {
        console.error('[ConversationList] Refresh failed:', result.error)
      }
    } catch (err) {
      console.error('[ConversationList] Refresh error:', err)
    } finally {
      setIsRefreshing(false)
    }
  }

  const handleConfirmDelete = async () => {
    if (!deleteTarget || !onDeleteConversation) return
    try {
      await onDeleteConversation(deleteTarget.jid)
    } catch (err) {
      console.error('[ConversationList] Delete error:', err)
    } finally {
      setDeleteTarget(null)
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header — fixed, never scrolls */}
      <div className="shrink-0 px-4 pt-4 pb-2">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <MessageCircle className="size-5 text-primary shrink-0" />
            <h2 className="font-semibold text-base truncate">WhatsApp</h2>
            {totalUnread > 0 && (
              <Badge className="bg-primary text-primary-foreground text-[10px] px-1.5 min-w-[20px] h-5 flex items-center justify-center shrink-0">
                {totalUnread > 99 ? '99+' : totalUnread}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {/* Refresh button — re-fetches chats & contacts from phone */}
            {onRefreshData && (
              <TooltipProvider delayDuration={400}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      onClick={handleRefresh}
                      disabled={isRefreshing}
                      title="Atualizar conversas e contatos"
                    >
                      <RefreshCw className={cn('size-4', isRefreshing && 'animate-spin')} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    Atualizar conversas e contatos do celular
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {/* Odoo contact search button */}
            {odooConnected && onSearchOdooContacts && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                onClick={() => setOdooSearchOpen(true)}
                title="Buscar contato no Odoo"
              >
                <Server className="size-3.5" />
                <span className="hidden sm:inline">Odoo</span>
              </Button>
            )}
          </div>
        </div>

        {/* Tab switcher: Conversas | Contatos */}
        <div className="flex items-center gap-1 mb-3 bg-muted/50 rounded-lg p-1">
          <button
            onClick={() => setActiveTab('conversations')}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium transition-colors',
              activeTab === 'conversations'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <MessagesSquare className="size-3.5" />
            Conversas
            {conversations.length > 0 && (
              <span className="text-[10px] text-muted-foreground">({conversations.length})</span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('contacts')}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium transition-colors',
              activeTab === 'contacts'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Users className="size-3.5" />
            Contatos
            {contacts.length > 0 && (
              <span className="text-[10px] text-muted-foreground">({contacts.length})</span>
            )}
          </button>
        </div>

        {/* Sync progress (only on conversations tab) */}
        {activeTab === 'conversations' && isSyncing && (
          <div className="flex items-center gap-2 mb-2 px-2 py-1.5 bg-primary/5 rounded-lg border border-primary/10">
            <Loader2 className="size-3.5 text-primary animate-spin" />
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-primary">Sincronizando...</span>
                <span className="text-[10px] text-muted-foreground">{syncProgress || 0}%</span>
              </div>
              <div className="w-full h-1 bg-primary/10 rounded-full mt-1">
                <div className="h-full bg-primary rounded-full transition-all duration-300" style={{ width: `${syncProgress || 0}%` }} />
              </div>
            </div>
          </div>
        )}

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder={activeTab === 'conversations' ? 'Buscar conversas...' : 'Buscar contatos...'}
            className="pl-9 h-9 text-sm bg-muted/50 border-transparent focus:border-border focus:bg-background"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Scrollable list */}
      <ScrollArea className="flex-1 min-h-0">
        {activeTab === 'conversations' ? (
          <ConversationsTabContent
            conversations={filteredConversations}
            selectedJid={selectedJid}
            onSelect={onSelect}
            isSyncing={isSyncing}
            hasSearchQuery={!!searchQuery.trim()}
            onDeleteConversation={onDeleteConversation ? (jid, name) => setDeleteTarget({ jid, name }) : undefined}
          />
        ) : (
          <ContactsTabContent
            contacts={contacts}
            loading={contactsLoading}
            selectedJid={selectedJid}
            onSelect={onSelect}
            hasSearchQuery={!!searchQuery.trim()}
            available={!!onGetContacts}
          />
        )}
      </ScrollArea>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Excluir conversa?</DialogTitle>
            <DialogDescription>
              Tem certeza que deseja excluir a conversa com <strong>{deleteTarget?.name}</strong>?
              As mensagens serão removidas localmente, mas a conversa pode reaparecer se o contato enviar uma nova mensagem.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancelar</Button>
            <Button variant="destructive" onClick={handleConfirmDelete} className="gap-1.5">
              <Trash2 className="size-4" /> Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Odoo contact search dialog */}
      {onSearchOdooContacts && onStartConversation && (
        <OdooContactSearchDialog
          open={odooSearchOpen}
          onOpenChange={setOdooSearchOpen}
          odooConnected={!!odooConnected}
          onSearchContacts={onSearchOdooContacts}
          onStartConversation={handleStartFromOdoo}
          onConversationStarted={handleConversationStarted}
          onCreateContact={onCreateOdooContact}
        />
      )}
    </div>
  )
}

// ========== Conversations tab content ==========

function ConversationsTabContent({
  conversations,
  selectedJid,
  onSelect,
  isSyncing,
  hasSearchQuery,
  onDeleteConversation,
}: {
  conversations: ConversationListProps['conversations']
  selectedJid: string | null
  onSelect: (jid: string) => void
  isSyncing?: boolean
  hasSearchQuery: boolean
  onDeleteConversation?: (jid: string, name: string) => void
}) {
  if (conversations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-4">
        {hasSearchQuery ? (
          <>
            <Search className="size-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium text-muted-foreground">Nenhum resultado</p>
          </>
        ) : isSyncing ? (
          <>
            <Loader2 className="size-10 text-primary/40 mb-3 animate-spin" />
            <p className="text-sm font-medium text-muted-foreground">Sincronizando conversas...</p>
            <p className="text-xs text-muted-foreground/70 mt-1">Aguarde enquanto carrega</p>
          </>
        ) : (
          <>
            <MessageCircle className="size-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium text-muted-foreground">Nenhuma conversa ainda</p>
            <p className="text-xs text-muted-foreground/70 mt-1">Conecte o WhatsApp para ver conversas</p>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="py-1">
      {conversations.map((conversation) => {
        const displayName = getDisplayName(conversation)
        const isSelected = selectedJid === conversation.jid
        const hasUnread = conversation.unreadCount > 0

        return (
          <div
            key={conversation.jid}
            onClick={() => onSelect(conversation.jid)}
            className={cn(
              'group w-full flex items-center gap-3 px-4 py-3 text-left transition-colors duration-150 cursor-pointer',
              'hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none',
              isSelected ? 'bg-primary/8 border-l-2 border-l-primary' : 'border-l-2 border-l-transparent',
              hasUnread && !isSelected && 'bg-muted/30'
            )}
          >
            <div className="relative shrink-0">
              <Avatar className="size-12">
                {conversation.avatarUrl && <AvatarImage src={conversation.avatarUrl} alt={displayName} />}
                <AvatarFallback className={cn('text-sm font-medium', isSelected ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground')}>
                  {getInitials(displayName)}
                </AvatarFallback>
              </Avatar>
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className={cn('text-sm truncate', hasUnread ? 'font-semibold' : 'font-medium')}>
                  {displayName}
                </span>
                {conversation.lastMessageAt && (
                  <span className={cn('text-[11px] shrink-0', hasUnread ? 'text-primary font-medium' : 'text-muted-foreground')}>
                    {formatTime(conversation.lastMessageAt)}
                  </span>
                )}
              </div>

              <div className="flex items-center justify-between gap-2 mt-0.5">
                <div className="flex items-center gap-1 min-w-0">
                  {conversation.phone && !conversation.name && <Phone className="size-3 text-muted-foreground/60 shrink-0" />}
                  {conversation.lastMessage ? (
                    <p className={cn('text-xs truncate', hasUnread ? 'text-foreground/80 font-medium' : 'text-muted-foreground')}>
                      {truncateMessage(conversation.lastMessage)}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground/60 italic flex items-center gap-1">
                      <Clock className="size-3" /> Sem mensagens
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {hasUnread && (
                    <Badge className="bg-primary text-primary-foreground text-[10px] px-1.5 min-w-[18px] h-[18px] flex items-center justify-center shrink-0">
                      {conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}
                    </Badge>
                  )}
                  {/* Delete button — shows on hover, stops propagation so click doesn't trigger select */}
                  {onDeleteConversation && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive/10 hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        onDeleteConversation(conversation.jid, displayName)
                      }}
                      title="Excluir conversa"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ========== Contacts tab content ==========

function ContactsTabContent({
  contacts,
  loading,
  selectedJid,
  onSelect,
  hasSearchQuery,
  available,
}: {
  contacts: DeviceContact[]
  loading: boolean
  selectedJid: string | null
  onSelect: (jid: string) => void
  hasSearchQuery: boolean
  available: boolean
}) {
  if (!available) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-4">
        <Users className="size-10 text-muted-foreground/40 mb-3" />
        <p className="text-sm font-medium text-muted-foreground">Contatos do dispositivo</p>
        <p className="text-xs text-muted-foreground/70 mt-1 text-center">
          Conecte o WhatsApp para sincronizar contatos do celular
        </p>
      </div>
    )
  }

  if (loading && contacts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <Loader2 className="size-10 text-primary/40 mb-3 animate-spin" />
        <p className="text-sm font-medium text-muted-foreground">Carregando contatos...</p>
      </div>
    )
  }

  if (contacts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-4">
        {hasSearchQuery ? (
          <>
            <Search className="size-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium text-muted-foreground">Nenhum contato encontrado</p>
          </>
        ) : (
          <>
            <Users className="size-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium text-muted-foreground">Nenhum contato sincronizado</p>
            <p className="text-xs text-muted-foreground/70 mt-1 text-center">
              Os contatos do seu celular aparecerão aqui após a sincronização
            </p>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="py-1">
      {contacts.map((contact) => {
        const isSelected = selectedJid === contact.jid
        return (
          <button
            key={contact.jid}
            onClick={() => onSelect(contact.jid)}
            className={cn(
              'w-full flex items-center gap-3 px-4 py-3 text-left transition-colors duration-150',
              'hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none',
              isSelected ? 'bg-primary/8 border-l-2 border-l-primary' : 'border-l-2 border-l-transparent'
            )}
          >
            <Avatar className="size-12 shrink-0">
              {contact.avatarUrl && <AvatarImage src={contact.avatarUrl} alt={contact.name} />}
              <AvatarFallback className={cn('text-sm font-medium', isSelected ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground')}>
                {getInitials(contact.name || contact.phone)}
              </AvatarFallback>
            </Avatar>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium truncate">{contact.name}</span>
              </div>
              <div className="flex items-center gap-1 mt-0.5">
                <Phone className="size-3 text-muted-foreground/60" />
                <span className="text-xs text-muted-foreground">
                  +{contact.phone}
                </span>
              </div>
            </div>
          </button>
        )
      })}
    </div>
  )
}
