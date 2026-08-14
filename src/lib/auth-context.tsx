'use client'

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'

// ====================================================================
// v7.22: AuthProvider — manages the current user's session client-side.
// On mount, fetches /api/auth/me to get the current user. Provides login,
// logout, and refresh methods.
// ====================================================================

export interface AuthUser {
  id: string
  email: string
  name: string | null
  role: 'admin' | 'user'
  isActive: boolean
  whatsappPhone: string | null
  odooUrl: string | null
  odooDb: string | null
  odooUsername: string | null
}

interface AuthContextValue {
  user: AuthUser | null
  isLoading: boolean
  isAuthenticated: boolean
  isAdmin: boolean
  // Refresh the user from the server
  refresh: () => Promise<void>
  // Login with email/password — returns { success, error? }
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>
  // Logout — clears the session
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me', { cache: 'no-store' })
      const data = await res.json()
      if (data.success && data.authenticated && data.user) {
        setUser(data.user)
      } else {
        setUser(null)
      }
    } catch {
      setUser(null)
    } finally {
      setIsLoading(false)
    }
  }, [])

  const login = useCallback(async (email: string, password: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (data.success && data.user) {
        setUser(data.user)
        return { success: true }
      }
      return { success: false, error: data.error || 'Falha no login' }
    } catch (err: any) {
      return { success: false, error: err.message || 'Erro de rede' }
    }
  }, [])

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } catch {}
    setUser(null)
    // Redirect to login page
    if (typeof window !== 'undefined') {
      window.location.href = '/login'
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: !!user,
        isAdmin: user?.role === 'admin',
        refresh,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
