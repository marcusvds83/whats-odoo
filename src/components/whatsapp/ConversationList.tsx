'use client'

import { useState, useMemo } from 'react'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import {
  Search,
  MessageCircle,
  User,
  Phone,
  Clock,
} from 'lucide-react'

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
    return 'Yesterday'
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

export function ConversationList({
  conversations,
  selectedJid,
  onSelect,
}: ConversationListProps) {
  const [searchQuery, setSearchQuery] = useState('')

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

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 pt-4 pb-2">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <MessageCircle className="size-5 text-primary" />
            <h2 className="font-semibold text-base">Chats</h2>
            {totalUnread > 0 && (
              <Badge className="bg-primary text-primary-foreground text-[10px] px-1.5 min-w-[20px] h-5 flex items-center justify-center">
                {totalUnread > 99 ? '99+' : totalUnread}
              </Badge>
            )}
          </div>
          <span className="text-xs text-muted-foreground">{conversations.length} conversations</span>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="Search conversations..."
            className="pl-9 h-9 text-sm bg-muted/50 border-transparent focus:border-border focus:bg-background"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Conversation List */}
      <ScrollArea className="flex-1">
        {filteredConversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-4">
            {searchQuery ? (
              <>
                <Search className="size-10 text-muted-foreground/40 mb-3" />
                <p className="text-sm font-medium text-muted-foreground">No results found</p>
                <p className="text-xs text-muted-foreground/70 mt-1">
                  Try a different search term
                </p>
              </>
            ) : (
              <>
                <MessageCircle className="size-10 text-muted-foreground/40 mb-3" />
                <p className="text-sm font-medium text-muted-foreground">No conversations yet</p>
                <p className="text-xs text-muted-foreground/70 mt-1">
                  Conversations will appear here when you receive messages
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="py-1">
            {filteredConversations.map((conversation) => {
              const displayName = getDisplayName(conversation)
              const isSelected = selectedJid === conversation.jid
              const hasUnread = conversation.unreadCount > 0

              return (
                <button
                  key={conversation.jid}
                  onClick={() => onSelect(conversation.jid)}
                  className={cn(
                    'w-full flex items-center gap-3 px-4 py-3 text-left transition-colors duration-150',
                    'hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none',
                    isSelected
                      ? 'bg-primary/8 border-l-2 border-l-primary'
                      : 'border-l-2 border-l-transparent',
                    hasUnread && !isSelected && 'bg-muted/30'
                  )}
                >
                  {/* Avatar */}
                  <div className="relative shrink-0">
                    <Avatar className="size-12">
                      {conversation.avatarUrl && (
                        <AvatarImage src={conversation.avatarUrl} alt={displayName} />
                      )}
                      <AvatarFallback
                        className={cn(
                          'text-sm font-medium',
                          isSelected
                            ? 'bg-primary/15 text-primary'
                            : 'bg-muted text-muted-foreground'
                        )}
                      >
                        {getInitials(displayName)}
                      </AvatarFallback>
                    </Avatar>
                    {/* Online indicator could go here */}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={cn(
                          'text-sm truncate',
                          hasUnread ? 'font-semibold' : 'font-medium'
                        )}
                      >
                        {displayName}
                      </span>
                      {conversation.lastMessageAt && (
                        <span
                          className={cn(
                            'text-[11px] shrink-0',
                            hasUnread
                              ? 'text-primary font-medium'
                              : 'text-muted-foreground'
                          )}
                        >
                          {formatTime(conversation.lastMessageAt)}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center justify-between gap-2 mt-0.5">
                      <div className="flex items-center gap-1 min-w-0">
                        {conversation.phone && !conversation.name && (
                          <Phone className="size-3 text-muted-foreground/60 shrink-0" />
                        )}
                        {conversation.lastMessage ? (
                          <p
                            className={cn(
                              'text-xs truncate',
                              hasUnread
                                ? 'text-foreground/80 font-medium'
                                : 'text-muted-foreground'
                            )}
                          >
                            {truncateMessage(conversation.lastMessage)}
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground/60 italic flex items-center gap-1">
                            <Clock className="size-3" />
                            No messages
                          </p>
                        )}
                      </div>

                      {hasUnread && (
                        <Badge className="bg-primary text-primary-foreground text-[10px] px-1.5 min-w-[18px] h-[18px] flex items-center justify-center shrink-0">
                          {conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}
                        </Badge>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
