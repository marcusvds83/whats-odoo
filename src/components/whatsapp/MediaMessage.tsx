'use client'

import { useState, useRef, useEffect } from 'react'
import { cn } from '@/lib/utils'
import {
  ImageIcon,
  Play,
  Pause,
  Loader2,
  Download,
  FileText,
  Video,
  Music,
  Paperclip,
  AlertCircle,
} from 'lucide-react'

interface MediaMessageProps {
  mediaType: string
  mediaUrl?: string | null
  mediaBase64?: string | null
  fileName?: string | null
  mimeType?: string | null
  mediaDuration?: number | null | undefined
  fromMe: boolean
}

// Helper: format seconds → mm:ss
function formatDuration(seconds: number): string {
  if (!seconds || seconds < 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// Helper: format file size
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function MediaMessage({
  mediaType,
  mediaUrl,
  mediaBase64,
  fileName,
  mimeType,
  mediaDuration,
  fromMe,
}: MediaMessageProps) {
  // Resolve the display URL — prefer mediaUrl, fall back to base64 data URL
  const displayUrl = mediaUrl
    ? (mediaUrl.startsWith('http') || mediaUrl.startsWith('/') ? mediaUrl : `/${mediaUrl}`)
    : mediaBase64
      ? (mediaBase64.startsWith('data:') ? mediaBase64 : `data:${mimeType || 'application/octet-stream'};base64,${mediaBase64}`)
      : null

  // ===== IMAGE / PRINT =====
  if (mediaType === 'image' || mediaType === 'sticker') {
    const [loaded, setLoaded] = useState(false)
    const [errored, setErrored] = useState(false)

    if (!displayUrl) {
      return <MediaPlaceholder icon={<ImageIcon className="size-5" />} label="Foto" fromMe={fromMe} />
    }

    return (
      <div className="relative my-1 overflow-hidden rounded-lg max-w-[260px]">
        {!loaded && !errored && (
          <div className="flex items-center justify-center w-[260px] h-[180px] bg-black/10">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {errored ? (
          <MediaPlaceholder icon={<AlertCircle className="size-5" />} label="Falha ao carregar foto" fromMe={fromMe} />
        ) : (
          <img
            src={displayUrl}
            alt={fileName || 'Foto'}
            onLoad={() => setLoaded(true)}
            onError={() => setErrored(true)}
            className={cn(
              'block max-w-full max-h-[280px] rounded-lg cursor-pointer object-cover transition-opacity',
              loaded ? 'opacity-100' : 'opacity-0'
            )}
            onClick={() => {
              // Open in new tab for full-size view
              if (displayUrl) window.open(displayUrl, '_blank')
            }}
          />
        )}
      </div>
    )
  }

  // ===== AUDIO / PTT (push-to-talk) =====
  if (mediaType === 'audio' || mediaType === 'ptt') {
    return (
      <AudioPlayer
        url={displayUrl}
        duration={mediaDuration}
        fromMe={fromMe}
      />
    )
  }

  // ===== VIDEO =====
  if (mediaType === 'video') {
    if (!displayUrl) {
      return <MediaPlaceholder icon={<Video className="size-5" />} label="Video" fromMe={fromMe} />
    }
    return (
      <div className="my-1 overflow-hidden rounded-lg max-w-[260px]">
        <video
          src={displayUrl}
          controls
          className="block max-w-full max-h-[280px] rounded-lg"
          preload="metadata"
        />
      </div>
    )
  }

  // ===== DOCUMENT / PDF =====
  if (mediaType === 'document' || mediaType === 'pdf') {
    if (!displayUrl) {
      return <MediaPlaceholder icon={<FileText className="size-5" />} label={fileName || 'Documento'} fromMe={fromMe} />
    }
    return (
      <a
        href={displayUrl}
        download={fileName || undefined}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          'flex items-center gap-2 my-1 px-3 py-2 rounded-lg max-w-[260px] transition-colors',
          fromMe ? 'bg-emerald-500/50 hover:bg-emerald-500/70' : 'bg-background/60 hover:bg-background/80'
        )}
      >
        <div className={cn(
          'shrink-0 size-9 rounded flex items-center justify-center',
          fromMe ? 'bg-white/20' : 'bg-primary/10'
        )}>
          <FileText className={cn('size-5', fromMe ? 'text-white' : 'text-primary')} />
        </div>
        <div className="flex-1 min-w-0">
          <div className={cn('text-xs font-medium truncate', fromMe ? 'text-white' : 'text-foreground')}>
            {fileName || 'Documento'}
          </div>
          <div className={cn('text-[10px] truncate', fromMe ? 'text-white/70' : 'text-muted-foreground')}>
            {mimeType || 'arquivo'}
          </div>
        </div>
        <Download className={cn('size-4 shrink-0', fromMe ? 'text-white/80' : 'text-muted-foreground')} />
      </a>
    )
  }

  // ===== FALLBACK (unknown media) =====
  return <MediaPlaceholder icon={<Paperclip className="size-5" />} label={mediaType || 'Mídia'} fromMe={fromMe} />
}

// ===== Audio Player Component =====
function AudioPlayer({ url, duration, fromMe }: { url: string | null; duration?: number | null | undefined; fromMe: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [totalDuration, setTotalDuration] = useState(duration || 0)
  const [isLoading, setIsLoading] = useState(false)
  const [hasError, setHasError] = useState(false)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const onTimeUpdate = () => setCurrentTime(audio.currentTime)
    const onLoadedMetadata = () => {
      if (audio.duration && !isNaN(audio.duration)) {
        setTotalDuration(audio.duration)
      }
      setIsLoading(false)
    }
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    const onEnded = () => {
      setIsPlaying(false)
      setCurrentTime(0)
    }
    const onError = () => {
      setHasError(true)
      setIsLoading(false)
    }
    const onWaiting = () => setIsLoading(true)
    const onCanPlay = () => setIsLoading(false)

    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('loadedmetadata', onLoadedMetadata)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('error', onError)
    audio.addEventListener('waiting', onWaiting)
    audio.addEventListener('canplay', onCanPlay)

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onError)
      audio.removeEventListener('waiting', onWaiting)
      audio.removeEventListener('canplay', onCanPlay)
    }
  }, [])

  const togglePlayPause = () => {
    const audio = audioRef.current
    if (!audio) return
    if (isPlaying) {
      audio.pause()
    } else {
      audio.play().catch(() => setHasError(true))
    }
  }

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current
    if (!audio || !totalDuration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const percent = (e.clientX - rect.left) / rect.width
    audio.currentTime = percent * totalDuration
  }

  if (!url) {
    return <MediaPlaceholder icon={<Music className="size-5" />} label="Audio" fromMe={fromMe} />
  }

  if (hasError) {
    return (
      <div className={cn(
        'flex items-center gap-2 my-1 px-3 py-2 rounded-lg max-w-[260px]',
        fromMe ? 'bg-emerald-500/50' : 'bg-background/60'
      )}>
        <AlertCircle className={cn('size-4 shrink-0', fromMe ? 'text-white' : 'text-muted-foreground')} />
        <span className={cn('text-xs', fromMe ? 'text-white' : 'text-muted-foreground')}>
          Falha ao carregar áudio
        </span>
      </div>
    )
  }

  return (
    <div className={cn(
      'flex items-center gap-2 my-1 px-2 py-1.5 rounded-lg max-w-[280px] min-w-[200px]',
      fromMe ? 'bg-emerald-500/50' : 'bg-background/60'
    )}>
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        className="hidden"
      />

      {/* Play/Pause button */}
      <button
        type="button"
        onClick={togglePlayPause}
        disabled={isLoading}
        className={cn(
          'shrink-0 size-9 rounded-full flex items-center justify-center transition-colors',
          fromMe ? 'bg-white/25 hover:bg-white/40 text-white' : 'bg-primary hover:bg-primary/90 text-primary-foreground'
        )}
      >
        {isLoading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : isPlaying ? (
          <Pause className="size-4 fill-current" />
        ) : (
          <Play className="size-4 fill-current ml-0.5" />
        )}
      </button>

      {/* Waveform-style progress bar + timestamps */}
      <div className="flex-1 min-w-0">
        <div
          className="relative h-1.5 rounded-full bg-black/20 cursor-pointer group"
          onClick={handleSeek}
        >
          <div
            className={cn(
              'absolute left-0 top-0 h-full rounded-full transition-all',
              fromMe ? 'bg-white' : 'bg-primary'
            )}
            style={{ width: `${totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0}%` }}
          />
        </div>
        <div className={cn('flex items-center justify-between mt-1 text-[10px]', fromMe ? 'text-white/80' : 'text-muted-foreground')}>
          <span>{formatDuration(currentTime)}</span>
          <span>{formatDuration(totalDuration)}</span>
        </div>
      </div>
    </div>
  )
}

// ===== Placeholder (no URL / loading state) =====
function MediaPlaceholder({ icon, label, fromMe }: { icon: React.ReactNode; label: string; fromMe: boolean }) {
  return (
    <div className={cn(
      'flex items-center gap-2 my-1 px-3 py-2 rounded-lg max-w-[260px]',
      fromMe ? 'bg-emerald-500/50' : 'bg-background/60'
    )}>
      <div className={cn(
        'shrink-0 size-8 rounded flex items-center justify-center',
        fromMe ? 'bg-white/20' : 'bg-muted'
      )}>
        {icon}
      </div>
      <span className={cn('text-xs font-medium', fromMe ? 'text-white' : 'text-muted-foreground')}>
        {label}
      </span>
    </div>
  )
}
