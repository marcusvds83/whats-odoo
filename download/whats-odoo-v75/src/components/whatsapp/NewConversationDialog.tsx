'use client'

import { useState, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Phone, Plus, Loader2, CheckCircle2, XCircle, MessageCircle } from 'lucide-react'

interface NewConversationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onStartConversation: (phone: string) => Promise<{ success: boolean; jid?: string; conversation?: any; error?: string }>
  onConversationStarted?: (jid: string) => void
}

export function NewConversationDialog({
  open,
  onOpenChange,
  onStartConversation,
  onConversationStarted,
}: NewConversationDialogProps) {
  const [phone, setPhone] = useState('')
  const [isChecking, setIsChecking] = useState(false)
  const [result, setResult] = useState<{ success: boolean; jid?: string; error?: string } | null>(null)

  const resetForm = useCallback(() => {
    setPhone('')
    setResult(null)
    setIsChecking(false)
  }, [])

  const handleStart = async () => {
    if (!phone.trim()) return
    setIsChecking(true)
    setResult(null)
    try {
      const res = await onStartConversation(phone)
      setResult(res)
      if (res.success && res.jid && onConversationStarted) {
        onConversationStarted(res.jid)
        // Close after a short delay to show success
        setTimeout(() => {
          onOpenChange(false)
          resetForm()
        }, 800)
      }
    } catch (err) {
      setResult({ success: false, error: err instanceof Error ? err.message : 'Erro desconhecido' })
    } finally {
      setIsChecking(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && phone.trim()) {
      e.preventDefault()
      handleStart()
    }
  }

  const phoneDigits = phone.replace(/\D/g, '')
  const isValidPhone = phoneDigits.length >= 7

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (nextOpen) resetForm()
      onOpenChange(nextOpen)
    }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="size-4 text-emerald-500" />
            Nova Conversa
          </DialogTitle>
          <DialogDescription>
            Digite o numero de telefone para iniciar uma nova conversa no WhatsApp
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="phone-number" className="flex items-center gap-1.5">
              <Phone className="size-3" />
              Numero de Telefone
            </Label>
            <Input
              id="phone-number"
              type="tel"
              placeholder="5511999999999"
              value={phone}
              onChange={(e) => { setPhone(e.target.value); setResult(null) }}
              onKeyDown={handleKeyDown}
              disabled={isChecking}
              className="text-lg font-mono"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Digite com codigo do pais e DDD. Ex: 5511999999999
            </p>
          </div>

          {/* Result feedback */}
          {result && (
            <div className={`flex items-center gap-2 rounded-lg border p-3 text-sm ${
              result.success
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                : 'border-destructive/30 bg-destructive/5 text-destructive'
            }`}>
              {result.success ? (
                <>
                  <CheckCircle2 className="size-4 shrink-0" />
                  <span>Numero encontrado no WhatsApp! Conversa criada.</span>
                </>
              ) : (
                <>
                  <XCircle className="size-4 shrink-0" />
                  <span>{result.error || 'Numero nao encontrado no WhatsApp'}</span>
                </>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={handleStart}
            disabled={!isValidPhone || isChecking}
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            {isChecking ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Verificando...
              </>
            ) : (
              <>
                <MessageCircle className="size-4" />
                Iniciar Conversa
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
