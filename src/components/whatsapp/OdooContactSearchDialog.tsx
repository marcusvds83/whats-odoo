'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  Search,
  Loader2,
  User,
  Phone,
  MessageCircle,
  X,
  AlertCircle,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'

interface OdooContact {
  id: number
  name: string
  phone?: string | false
  mobile?: string | false
  email?: string | false
  image_128?: string | false
}

interface OdooContactSearchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  odooConnected: boolean
  onSearchContacts: (query?: string, limit?: number) => Promise<{ success: boolean; data?: OdooContact[]; error?: string }>
  onStartConversation: (phone: string, name?: string) => Promise<{ success: boolean; jid?: string; error?: string }>
  onConversationStarted?: (jid: string) => void
}

function extractDigits(phone: string): string {
  return phone.replace(/\D/g, '')
}

function getInitials(name: string): string {
  return name.split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
}

export function OdooContactSearchDialog({
  open,
  onOpenChange,
  odooConnected,
  onSearchContacts,
  onStartConversation,
  onConversationStarted,
}: OdooContactSearchDialogProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<OdooContact[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [startingJid, setStartingJid] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  // Debounced search
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const performSearch = useCallback(async (q: string) => {
    if (!odooConnected) return
    setLoading(true)
    setSearched(true)
    setError(null)
    try {
      const result = await onSearchContacts(q.trim() || undefined, 30)
      if (result.success) {
        setResults(result.data || [])
      } else {
        setResults([])
        setError(result.error || 'Erro ao buscar contatos')
      }
    } catch (err: any) {
      setResults([])
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [odooConnected, onSearchContacts])

  useEffect(() => {
    if (!open) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      performSearch(query)
    }, 400)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, open, performSearch])

  const handleStartConversation = async (contact: OdooContact) => {
    const phone = extractDigits(
      (contact.mobile as string) || (contact.phone as string) || ''
    )
    if (phone.length < 7) {
      setError(`Contato "${contact.name}" não tem telefone válido`)
      setTimeout(() => setError(null), 3000)
      return
    }

    setStartingJid(phone)
    setError(null)
    setSuccessMsg(null)
    try {
      const result = await onStartConversation(phone, contact.name)
      if (result.success && result.jid) {
        setSuccessMsg(`Conversa iniciada com ${contact.name}`)
        onConversationStarted?.(result.jid)
        onOpenChange(false)
        setQuery('')
        setResults([])
        setSearched(false)
      } else {
        setError(result.error || 'Não foi possível iniciar a conversa')
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setStartingJid(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <User className="size-4" />
            Buscar Contato no Odoo
          </DialogTitle>
          <DialogDescription>
            Procure um contato no Odoo e inicie uma conversa no WhatsApp
          </DialogDescription>
        </DialogHeader>

        {!odooConnected ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertCircle className="size-8 text-amber-500" />
            <p className="text-sm text-muted-foreground">
              Conecte ao Odoo primeiro para buscar contatos
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Search input */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar por nome, telefone, email..."
                className="pl-9 pr-9 h-9 text-sm"
                autoFocus
              />
              {query && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 size-9"
                  onClick={() => setQuery('')}
                >
                  <X className="size-3.5" />
                </Button>
              )}
            </div>

            {/* Error message */}
            {error && (
              <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
                <AlertCircle className="size-3.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* Success message */}
            {successMsg && (
              <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300">
                <MessageCircle className="size-3.5 shrink-0" />
                <span>{successMsg}</span>
              </div>
            )}

            {/* Results */}
            <ScrollArea className="h-[320px] rounded-md border">
              <div className="p-2 space-y-1">
                {loading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="size-6 animate-spin text-muted-foreground" />
                  </div>
                ) : results.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-8 text-center">
                    <Search className="size-8 text-muted-foreground/40 mb-2" />
                    <p className="text-sm text-muted-foreground">
                      {searched ? 'Nenhum contato encontrado' : 'Digite para buscar'}
                    </p>
                  </div>
                ) : (
                  results.map((contact) => {
                    const phone = extractDigits(
                      (contact.mobile as string) || (contact.phone as string) || ''
                    )
                    const phoneLabel = (contact.mobile as string) || (contact.phone as string) || null
                    const startingThis = startingJid === phone
                    return (
                      <div
                        key={contact.id}
                        className="flex items-center gap-3 rounded-md border bg-card p-2 hover:bg-accent/50 transition-colors"
                      >
                        <Avatar className="size-9 shrink-0">
                          {contact.image_128 && (
                            <AvatarImage
                              src={`data:image/png;base64,${contact.image_128}`}
                              alt={contact.name}
                            />
                          )}
                          <AvatarFallback className="bg-primary/10 text-primary text-xs">
                            {getInitials(contact.name || '?')}
                          </AvatarFallback>
                        </Avatar>

                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{contact.name}</p>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            {phoneLabel && (
                              <span className="flex items-center gap-1">
                                <Phone className="size-3" />
                                {phoneLabel}
                              </span>
                            )}
                            {contact.email && (
                              <span className="truncate">{contact.email as string}</span>
                            )}
                          </div>
                        </div>

                        <Button
                          size="sm"
                          variant="default"
                          className="h-8 gap-1.5 shrink-0 bg-emerald-600 hover:bg-emerald-700"
                          disabled={!phone || phone.length < 7 || startingThis}
                          onClick={() => handleStartConversation(contact)}
                        >
                          {startingThis ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <MessageCircle className="size-3.5" />
                          )}
                          Conversar
                        </Button>
                      </div>
                    )
                  })
                )}
              </div>
            </ScrollArea>

            <p className="text-[10px] text-muted-foreground text-center">
              Apenas contatos com telefone válido podem iniciar conversa no WhatsApp
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
