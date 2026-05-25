'use client'

import { useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Separator } from '@/components/ui/separator'
import {
  QrCode,
  Wifi,
  WifiOff,
  Loader2,
  LogOut,
  User,
  Phone,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Smartphone,
  RefreshCcw,
} from 'lucide-react'

interface QRCodePanelProps {
  qrCode: string | null
  status: { connected: boolean; reason?: string; hasSession?: boolean }
  me: { id: string; name?: string; profilePicUrl?: string } | null
  onRequestQR: () => void
  onDisconnect: () => void
  isConnected: boolean
}

export function QRCodePanel({
  qrCode,
  status,
  me,
  onRequestQR,
  onDisconnect,
  isConnected,
}: QRCodePanelProps) {
  const [isRequesting, setIsRequesting] = useState(false)
  const [isDisconnecting, setIsDisconnecting] = useState(false)

  const hasSession = status.hasSession ?? false
  const isReconnecting = !isConnected && hasSession && status.reason === 'reconnecting'

  const handleRequestQR = async () => {
    setIsRequesting(true)
    try {
      await onRequestQR()
    } finally {
      setIsRequesting(false)
    }
  }

  const handleDisconnect = async () => {
    setIsDisconnecting(true)
    try {
      await onDisconnect()
    } finally {
      setIsDisconnecting(false)
    }
  }

  const getStatusBadge = () => {
    if (isConnected) {
      return (
        <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/25 hover:bg-emerald-500/25">
          <CheckCircle2 className="size-3" />
          Conectado
        </Badge>
      )
    }
    if (isReconnecting) {
      return (
        <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/25 hover:bg-amber-500/25">
          <Loader2 className="size-3 animate-spin" />
          Reconectando...
        </Badge>
      )
    }
    if (qrCode) {
      return (
        <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/25 hover:bg-amber-500/25">
          <Loader2 className="size-3 animate-spin" />
          Aguardando scan
        </Badge>
      )
    }
    return (
      <Badge variant="destructive">
        <XCircle className="size-3" />
        Desconectado
      </Badge>
    )
  }

  const getStatusIcon = () => {
    if (isConnected) {
      return <Wifi className="size-5 text-emerald-500" />
    }
    if (isReconnecting) {
      return <RefreshCcw className="size-5 text-amber-500 animate-spin" />
    }
    if (qrCode) {
      return <Loader2 className="size-5 text-amber-500 animate-spin" />
    }
    return <WifiOff className="size-5 text-muted-foreground" />
  }

  return (
    <Card className="w-full max-w-md mx-auto">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Smartphone className="size-5 text-primary" />
            <CardTitle className="text-lg">Conexao WhatsApp</CardTitle>
          </div>
          {getStatusBadge()}
        </div>
        <CardDescription>
          {isConnected
            ? 'Seu WhatsApp esta conectado e pronto para uso'
            : isReconnecting
              ? 'Restaurando sessao anterior, aguarde...'
              : qrCode
                ? 'Escaneie o QR code com o WhatsApp'
                : 'Solicite um QR code para conectar seu WhatsApp'}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Status Bar */}
        <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
          {getStatusIcon()}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">
              {isConnected ? 'Conectado' : isReconnecting ? 'Reconectando sessao...' : qrCode ? 'Aguardando scan' : 'Desconectado'}
            </p>
            {status.reason === 'logged_out' && (
              <p className="text-xs text-muted-foreground truncate">Sessao encerrada pelo aparelho</p>
            )}
            {status.reason === 'reconnecting' && (
              <p className="text-xs text-muted-foreground truncate">Tentando restaurar sessao salva...</p>
            )}
          </div>
        </div>

        {/* Reconnecting State - Show waiting message instead of QR */}
        {isReconnecting && !qrCode && (
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="size-20 rounded-full bg-amber-50 dark:bg-amber-950/30 flex items-center justify-center">
              <RefreshCcw className="size-8 text-amber-500 animate-spin" />
            </div>
            <div className="text-center space-y-1">
              <p className="text-sm font-medium">Restaurando sessao...</p>
              <p className="text-xs text-muted-foreground max-w-[280px]">
                Sua sessao anterior esta sendo restaurada. Se o aparelho ainda estiver conectado, isso deve levar alguns segundos.
              </p>
            </div>
          </div>
        )}

        {/* QR Code Area or Connected Profile */}
        {isConnected && me ? (
          <div className="space-y-4">
            {/* Profile Card */}
            <div className="flex flex-col items-center gap-3 p-4 rounded-lg bg-muted/30">
              <Avatar className="size-20 ring-2 ring-emerald-500/30 ring-offset-2 ring-offset-background">
                {me.profilePicUrl && <AvatarImage src={me.profilePicUrl} alt={me.name || 'Profile'} />}
                <AvatarFallback className="text-2xl bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300">
                  <User className="size-8" />
                </AvatarFallback>
              </Avatar>
              <div className="text-center">
                <p className="font-semibold text-base">{me.name || 'Desconhecido'}</p>
                <p className="text-sm text-muted-foreground flex items-center justify-center gap-1">
                  <Phone className="size-3" />
                  {me.id.split('@')[0]}
                </p>
              </div>
            </div>

            <Separator />

            {/* Connected Info */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">WhatsApp ID</span>
                <span className="font-mono text-xs">{me.id}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Status</span>
                <span className="text-emerald-600 dark:text-emerald-400 font-medium">Ativo</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Sessao</span>
                <span className="text-emerald-600 dark:text-emerald-400 font-medium text-xs">Salva automaticamente</span>
              </div>
            </div>

            <Separator />

            {/* Disconnect Button */}
            <Button
              variant="destructive"
              className="w-full"
              onClick={handleDisconnect}
              disabled={isDisconnecting}
            >
              {isDisconnecting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Desconectando...
                </>
              ) : (
                <>
                  <LogOut className="size-4" />
                  Desconectar WhatsApp
                </>
              )}
            </Button>
          </div>
        ) : !isReconnecting ? (
          <div className="space-y-4">
            {/* QR Code Display */}
            {qrCode ? (
              <div className="flex flex-col items-center gap-4">
                <div className="relative p-4 bg-white rounded-xl shadow-sm border">
                  <QRCodeSVG
                    value={qrCode}
                    size={220}
                    level="H"
                    bgColor="#ffffff"
                    fgColor="#111827"
                    includeMargin={false}
                  />
                  {/* Subtle pulse animation around QR */}
                  <div className="absolute inset-0 rounded-xl border-2 border-primary/20 animate-pulse pointer-events-none" />
                </div>
                <div className="text-center space-y-1">
                  <p className="text-sm font-medium">Escaneie com o WhatsApp</p>
                  <p className="text-xs text-muted-foreground max-w-[280px]">
                    Abra o WhatsApp → Aparelhos conectados → Conectar um aparelho → Escaneie este QR code
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4 py-8">
                <div className="size-48 rounded-2xl bg-muted/50 border-2 border-dashed border-muted-foreground/25 flex items-center justify-center">
                  <QrCode className="size-16 text-muted-foreground/40" />
                </div>
                <p className="text-sm text-muted-foreground text-center">
                  Clique no botao abaixo para gerar o QR code
                </p>
              </div>
            )}

            {/* Request QR Button */}
            <Button
              className="w-full"
              onClick={handleRequestQR}
              disabled={isRequesting}
              variant={qrCode ? 'outline' : 'default'}
            >
              {isRequesting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Gerando QR Code...
                </>
              ) : qrCode ? (
                <>
                  <RefreshCw className="size-4" />
                  Atualizar QR Code
                </>
              ) : (
                <>
                  <QrCode className="size-4" />
                  Solicitar QR Code
                </>
              )}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
