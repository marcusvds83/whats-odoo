'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Smile, Search, Clock, X } from 'lucide-react'
import { EMOJI_CATEGORIES, DEFAULT_RECENT_EMOJIS } from '@/lib/emoji-data'

interface EmojiPickerProps {
  onEmojiSelect: (emoji: string) => void
  children?: React.ReactNode
}

const STORAGE_KEY = 'whats-odoo:recent-emojis'

export function EmojiPicker({ onEmojiSelect, children }: EmojiPickerProps) {
  const [open, setOpen] = useState(false)
  const [activeCategory, setActiveCategory] = useState<string>('recent')
  const [search, setSearch] = useState('')
  const [recent, setRecent] = useState<string[]>(DEFAULT_RECENT_EMOJIS)
  const scrollRef = useRef<HTMLDivElement>(null)
  const categoryRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // Load recent emojis from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed) && parsed.length > 0) {
          setRecent(parsed)
        }
      }
    } catch {}
  }, [])

  const handleSelect = (emoji: string) => {
    onEmojiSelect(emoji)
    // Add to recent (dedupe, move to front, max 24)
    setRecent(prev => {
      const next = [emoji, ...prev.filter(e => e !== emoji)].slice(0, 24)
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {}
      return next
    })
  }

  // Filter emojis by search
  const filteredEmojis = useMemo(() => {
    if (!search.trim()) return null
    const q = search.toLowerCase().trim()
    const results: string[] = []
    for (const cat of EMOJI_CATEGORIES) {
      // Match by category name
      if (cat.name.toLowerCase().includes(q)) {
        results.push(...cat.emojis)
      }
    }
    return results
  }, [search])

  // Scroll to category
  const scrollToCategory = (catId: string) => {
    setActiveCategory(catId)
    const el = categoryRefs.current[catId]
    if (el && scrollRef.current) {
      const top = el.offsetTop - 8
      scrollRef.current.scrollTo({ top, behavior: 'smooth' })
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {children || (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
            title="Emoji"
          >
            <Smile className="size-5" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-[340px] p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col h-[400px]">
          {/* Search bar */}
          <div className="shrink-0 p-2 border-b">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                ref={(input) => {
                  if (input && open) {
                    setTimeout(() => input.focus(), 50)
                  }
                }}
                placeholder="Buscar emoji..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 pl-8 pr-8 text-sm"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          </div>

          {filteredEmojis ? (
            /* Search results */
            <div className="flex-1 min-h-0">
              <ScrollArea className="h-full">
                <div className="p-2 grid grid-cols-8 gap-1">
                  {filteredEmojis.map((emoji, idx) => (
                    <button
                      key={`${emoji}-${idx}`}
                      type="button"
                      onClick={() => handleSelect(emoji)}
                      className="size-9 flex items-center justify-center rounded-md hover:bg-accent text-xl leading-none transition-colors"
                    >
                      {emoji}
                    </button>
                  ))}
                  {filteredEmojis.length === 0 && (
                    <div className="col-span-8 py-8 text-center text-sm text-muted-foreground">
                      Nenhum emoji encontrado
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>
          ) : (
            <>
              {/* Emoji grid */}
              <div className="flex-1 min-h-0">
                <ScrollArea
                  className="h-full"
                  ref={(node) => {
                    if (node) {
                      // Find the viewport element
                      const viewport = node.querySelector('[data-radix-scroll-area-viewport]') as HTMLDivElement
                      if (viewport) {
                        scrollRef.current = viewport
                      }
                    }
                  }}
                >
                  <div className="pb-2">
                    {/* Recent */}
                    <div
                      ref={(el) => { categoryRefs.current['recent'] = el }}
                      className="pt-2"
                    >
                      <div className="px-3 pb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground sticky top-0 bg-background/95 backdrop-blur z-10">
                        <Clock className="size-3" />
                        <span>Recentes</span>
                      </div>
                      <div className="px-2 grid grid-cols-8 gap-1">
                        {recent.length === 0 ? (
                          <div className="col-span-8 px-3 py-2 text-xs text-muted-foreground">
                            Seus emojis usados aparecerão aqui
                          </div>
                        ) : (
                          recent.map((emoji, idx) => (
                            <button
                              key={`recent-${idx}`}
                              type="button"
                              onClick={() => handleSelect(emoji)}
                              className="size-9 flex items-center justify-center rounded-md hover:bg-accent text-xl leading-none transition-colors"
                            >
                              {emoji}
                            </button>
                          ))
                        )}
                      </div>
                    </div>

                    {/* All categories */}
                    {EMOJI_CATEGORIES.map((cat) => (
                      <div
                        key={cat.id}
                        ref={(el) => { categoryRefs.current[cat.id] = el }}
                        className="pt-3"
                      >
                        <div className="px-3 pb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground sticky top-0 bg-background/95 backdrop-blur z-10">
                          <span className="text-sm">{cat.icon}</span>
                          <span>{cat.name}</span>
                        </div>
                        <div className="px-2 grid grid-cols-8 gap-1">
                          {cat.emojis.map((emoji, idx) => (
                            <button
                              key={`${cat.id}-${idx}`}
                              type="button"
                              onClick={() => handleSelect(emoji)}
                              className="size-9 flex items-center justify-center rounded-md hover:bg-accent text-xl leading-none transition-colors"
                            >
                              {emoji}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>

              {/* Category tabs */}
              <div className="shrink-0 border-t">
                <div className="flex items-center justify-around p-1">
                  <button
                    type="button"
                    onClick={() => scrollToCategory('recent')}
                    className={`size-9 flex items-center justify-center rounded-md transition-colors ${
                      activeCategory === 'recent' ? 'bg-accent' : 'hover:bg-accent'
                    }`}
                    title="Recentes"
                  >
                    <Clock className="size-4" />
                  </button>
                  {EMOJI_CATEGORIES.map((cat) => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => scrollToCategory(cat.id)}
                      className={`size-9 flex items-center justify-center rounded-md text-lg transition-colors ${
                        activeCategory === cat.id ? 'bg-accent' : 'hover:bg-accent'
                      }`}
                      title={cat.name}
                    >
                      {cat.icon}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
