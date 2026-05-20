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
} from 'lucide-react'

interface QRCodePanelProps {
  qrCode: string | null
  status: { connected: boolean; reason?: string }
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
          Connected
        </Badge>
      )
    }
    if (qrCode) {
      return (
        <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/25 hover:bg-amber-500/25">
          <Loader2 className="size-3 animate-spin" />
          Waiting for Scan
        </Badge>
      )
    }
    return (
      <Badge variant="destructive">
        <XCircle className="size-3" />
        Disconnected
      </Badge>
    )
  }

  const getStatusIcon = () => {
    if (isConnected) {
      return <Wifi className="size-5 text-emerald-500" />
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
            <CardTitle className="text-lg">WhatsApp Connection</CardTitle>
          </div>
          {getStatusBadge()}
        </div>
        <CardDescription>
          {isConnected
            ? 'Your WhatsApp account is connected and ready'
            : qrCode
              ? 'Scan the QR code with your WhatsApp app'
              : 'Request a QR code to connect your WhatsApp account'}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Status Bar */}
        <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
          {getStatusIcon()}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">
              {isConnected ? 'Connected' : qrCode ? 'Awaiting scan' : 'Not connected'}
            </p>
            {status.reason && (
              <p className="text-xs text-muted-foreground truncate">{status.reason}</p>
            )}
          </div>
        </div>

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
                <p className="font-semibold text-base">{me.name || 'Unknown'}</p>
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
                <span className="text-emerald-600 dark:text-emerald-400 font-medium">Active</span>
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
                  Disconnecting...
                </>
              ) : (
                <>
                  <LogOut className="size-4" />
                  Disconnect
                </>
              )}
            </Button>
          </div>
        ) : (
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
                  <p className="text-sm font-medium">Scan with WhatsApp</p>
                  <p className="text-xs text-muted-foreground max-w-[280px]">
                    Open WhatsApp &rarr; Linked Devices &rarr; Link a device &rarr; Scan this QR code
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4 py-8">
                <div className="size-48 rounded-2xl bg-muted/50 border-2 border-dashed border-muted-foreground/25 flex items-center justify-center">
                  <QrCode className="size-16 text-muted-foreground/40" />
                </div>
                <p className="text-sm text-muted-foreground text-center">
                  Click the button below to generate a QR code
                </p>
                <p className="text-xs text-amber-600 dark:text-amber-400 font-medium text-center">
                  Aguardar de 20 a 30 segundos para aparecer o QR Code
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
                  Generating QR Code...
                </>
              ) : qrCode ? (
                <>
                  <RefreshCw className="size-4" />
                  Refresh QR Code
                </>
              ) : (
                <>
                  <QrCode className="size-4" />
                  Request QR Code
                </>
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
