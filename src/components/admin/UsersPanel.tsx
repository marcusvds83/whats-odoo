'use client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Switch
} from '@/components/ui/switch'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  UserPlus,
  Pencil,
  Trash2,
  Loader2,
  Shield,
  User as UserIcon,
  Mail,
  Phone,
  RefreshCw,
  Key,
  ExternalLink,
  Database,
  CheckCircle2,
  AlertCircle,
  FlaskConical,
  Dices,
  Eye,
  EyeOff,
} from 'lucide-react'
import { useOdoo } from '@/lib/use-odoo'

interface UserRow {
  id: string
  email: string
  name: string | null
  role: string
  isActive: boolean
  whatsappPhone: string | null
  odooUrl: string | null
  odooDb: string | null
  odooUsername: string | null
  createdAt: string
  updatedAt: string
}

interface EditState {
  id?: string
  email: string
  name: string
  password: string
  role: 'user' | 'admin'
  isActive: boolean
  whatsappPhone: string
  odooUrl: string
  odooDb: string
  odooUsername: string
  odooPassword: string
}

const EMPTY_EDIT: EditState = {
  email: '',
  name: '',
  password: '',
  role: 'user',
  isActive: true,
  whatsappPhone: '',
  odooUrl: '',
  odooDb: '',
  odooUsername: '',
  odooPassword: '',
}

export function UsersPanel() {
  const [users, setUsers] = useState<UserRow[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editState, setEditState] = useState<EditState>(EMPTY_EDIT)
  const [isSaving, setIsSaving] = useState(false)
  // v7.24 (R6): pre-deploy backup state
  const odoo = useOdoo()
  const [isBackingUp, setIsBackingUp] = useState(false)
  const [backupResult, setBackupResult] = useState<{
    success: boolean
    backed: number
    total: number
    failed: Array<{ userId: string; email: string; error: string }>
    at: string
  } | null>(null)
  // v7.26: Test-login state
  const [testLoginUser, setTestLoginUser] = useState<UserRow | null>(null)
  const [testLoginPassword, setTestLoginPassword] = useState('')
  const [testLoginResult, setTestLoginResult] = useState<null | {
    found: boolean
    isActive: boolean
    role: string
    passwordOk: boolean
    hashPrefix: string
    hashLength: number
    providedHashPreview: string
  }>(null)
  const [isTestingLogin, setIsTestingLogin] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  const loadUsers = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/users', { cache: 'no-store' })
      const data = await res.json()
      if (data.success) {
        setUsers(data.users)
      } else {
        setError(data.error || 'Falha ao carregar usuários')
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadUsers()
  }, [loadUsers])

  // v7.24 (R6): Backup all active user sessions to Odoo chatter.
  // Should be triggered manually BEFORE any deploy.
  const handleBackupToOdoo = useCallback(async () => {
    if (isBackingUp) return
    setIsBackingUp(true)
    setBackupResult(null)
    try {
      const r = await odoo.backupAllToOdoo()
      if (r.success) {
        setBackupResult({
          success: true,
          backed: r.backed || 0,
          total: r.total || 0,
          failed: r.failed || [],
          at: new Date().toISOString(),
        })
      } else {
        setBackupResult({
          success: false,
          backed: r.backed || 0,
          total: r.total || 0,
          failed: r.failed || [{ userId: '-', email: '-', error: r.error || 'Falha desconhecida' }],
          at: new Date().toISOString(),
        })
      }
    } catch (err: any) {
      setBackupResult({
        success: false,
        backed: 0,
        total: 0,
        failed: [{ userId: '-', email: '-', error: err.message }],
        at: new Date().toISOString(),
      })
    } finally {
      setIsBackingUp(false)
    }
  }, [isBackingUp, odoo])

  const handleCreate = () => {
    setEditState(EMPTY_EDIT)
    setDialogOpen(true)
  }

  const handleEdit = (user: UserRow) => {
    setEditState({
      id: user.id,
      email: user.email,
      name: user.name || '',
      password: '',
      role: user.role as 'user' | 'admin',
      isActive: user.isActive,
      whatsappPhone: user.whatsappPhone || '',
      odooUrl: user.odooUrl || '',
      odooDb: user.odooDb || '',
      odooUsername: user.odooUsername || '',
      odooPassword: '',
    })
    setDialogOpen(true)
  }

  const handleSave = async () => {
    setIsSaving(true)
    setError(null)
    try {
      const isEditing = !!editState.id
      const url = isEditing ? `/api/users/${editState.id}` : '/api/users'
      const method = isEditing ? 'PATCH' : 'POST'

      const body: any = {
        email: editState.email,
        name: editState.name,
        role: editState.role,
        isActive: editState.isActive,
        whatsappPhone: editState.whatsappPhone,
        odooUrl: editState.odooUrl,
        odooDb: editState.odooDb,
        odooUsername: editState.odooUsername,
      }
      if (editState.password) body.password = editState.password
      if (editState.odooPassword) body.odooPassword = editState.odooPassword

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.success) {
        setDialogOpen(false)
        await loadUsers()
      } else {
        setError(data.error || 'Falha ao salvar')
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsSaving(false)
    }
  }

  // v7.26: Generate a random strong password and put it into the edit form
  const generatePassword = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%&*'
    let pwd = ''
    const arr = new Uint32Array(12)
    crypto.getRandomValues(arr)
    for (let i = 0; i < 12; i++) pwd += chars[arr[i] % chars.length]
    setEditState(s => ({ ...s, password: pwd }))
    setShowPassword(true)
  }

  // v7.26: Test a user's password without impersonating them
  const handleTestLogin = async () => {
    if (!testLoginUser || !testLoginPassword) return
    setIsTestingLogin(true)
    setTestLoginResult(null)
    try {
      const res = await fetch(`/api/users/${testLoginUser.id}/test-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: testLoginPassword }),
      })
      const data = await res.json()
      if (data.success) {
        setTestLoginResult({
          found: data.found,
          isActive: data.isActive,
          role: data.role,
          passwordOk: data.passwordOk,
          hashPrefix: data.hashPrefix,
          hashLength: data.hashLength,
          providedHashPreview: data.providedHashPreview,
        })
      } else {
        setTestLoginResult({
          found: false,
          isActive: false,
          role: '?',
          passwordOk: false,
          hashPrefix: 'error: ' + (data.error || 'unknown'),
          hashLength: 0,
          providedHashPreview: '',
        })
      }
    } catch (err: any) {
      setTestLoginResult({
        found: false,
        isActive: false,
        role: '?',
        passwordOk: false,
        hashPrefix: 'fetch error: ' + err.message,
        hashLength: 0,
        providedHashPreview: '',
      })
    } finally {
      setIsTestingLogin(false)
    }
  }

  const handleDelete = async (user: UserRow) => {
    if (!confirm(`Excluir o usuário "${user.email}"? Esta ação não pode ser desfeita.`)) return
    try {
      const res = await fetch(`/api/users/${user.id}`, { method: 'DELETE' })
      const data = await res.json()
      if (data.success) {
        await loadUsers()
      } else {
        setError(data.error || 'Falha ao excluir')
      }
    } catch (err: any) {
      setError(err.message)
    }
  }

  const activeCount = users.filter(u => u.isActive).length
  const adminCount = users.filter(u => u.role === 'admin').length

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2">
            <UserIcon className="size-5" />
            Usuários do Middleware
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {users.length} total • {activeCount} ativos • {adminCount} admin
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={loadUsers} disabled={isLoading}>
            <RefreshCw className={`size-4 mr-1.5 ${isLoading ? 'animate-spin' : ''}`} />
            Atualizar
          </Button>
          {/* v7.24 (R6): Pre-deploy backup button */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleBackupToOdoo}
            disabled={isBackingUp || !odoo.isConnected}
            title={odoo.isConnected ? 'Salva credenciais e conversas de todos os usuários no chatter do Odoo (use antes de deploy)' : 'Conecte ao Odoo primeiro'}
          >
            {isBackingUp ? <Loader2 className="size-4 mr-1.5 animate-spin" /> : <Database className="size-4 mr-1.5" />}
            {isBackingUp ? 'Backup em andamento…' : 'Backup no Odoo'}
          </Button>
          <Button size="sm" onClick={handleCreate} className="bg-emerald-600 hover:bg-emerald-700 text-white">
            <UserPlus className="size-4 mr-1.5" />
            Novo Usuário
          </Button>
        </div>
      </div>

      {/* v7.24 (R6): Backup result banner */}
      {backupResult && (
        <Alert variant={backupResult.success ? 'default' : 'destructive'}>
          {backupResult.success
            ? <CheckCircle2 className="size-4" />
            : <AlertCircle className="size-4" />}
          <AlertDescription>
            {backupResult.success
              ? `Backup concluído: ${backupResult.backed}/${backupResult.total} usuário(s) salvos no chatter do Odoo.`
              : `Backup parcial: ${backupResult.backed}/${backupResult.total} ok, ${backupResult.failed.length} falha(s).`}
            {backupResult.failed.length > 0 && (
              <ul className="mt-1 ml-4 text-xs list-disc">
                {backupResult.failed.map((f, i) => (
                  <li key={i}>{f.email}: {f.error}</li>
                ))}
              </ul>
            )}
            <span className="block mt-1 text-xs text-muted-foreground">
              Realizado em {new Date(backupResult.at).toLocaleString('pt-BR')}
            </span>
          </AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : users.length === 0 ? (
            <div className="text-center py-12">
              <UserIcon className="size-10 mx-auto text-muted-foreground/50 mb-2" />
              <p className="text-sm text-muted-foreground">Nenhum usuário cadastrado</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Usuário</TableHead>
                  <TableHead>Telefone WA</TableHead>
                  <TableHead>Odoo</TableHead>
                  <TableHead>Perfil</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium text-sm flex items-center gap-1.5">
                          {user.name || user.email}
                          {user.role === 'admin' && (
                            <Shield className="size-3 text-amber-600" />
                          )}
                        </span>
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Mail className="size-3" />
                          {user.email}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {user.whatsappPhone ? (
                        <span className="text-sm flex items-center gap-1">
                          <Phone className="size-3 text-muted-foreground" />
                          {user.whatsappPhone}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {user.odooUrl ? (
                        <div className="flex flex-col text-xs">
                          <span className="font-medium truncate max-w-[160px]">{user.odooUsername || '?'}</span>
                          <span className="text-muted-foreground truncate max-w-[160px]">
                            {user.odooDb}@{(() => {
                              try { return new URL(user.odooUrl!).hostname } catch { return user.odooUrl }
                            })()}
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">Usa config global</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {user.role === 'admin' ? (
                        <Badge className="bg-amber-100 text-amber-800 border-amber-200">Admin</Badge>
                      ) : (
                        <Badge variant="outline">Usuário</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {user.isActive ? (
                        <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200">Ativo</Badge>
                      ) : (
                        <Badge variant="secondary">Inativo</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          onClick={() => {
                            setTestLoginUser(user)
                            setTestLoginPassword('')
                            setTestLoginResult(null)
                          }}
                          title="Testar login"
                        >
                          <FlaskConical className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          onClick={() => handleEdit(user)}
                          title="Editar"
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => handleDelete(user)}
                          title="Excluir"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* v7.26: Test-login dialog */}
      <Dialog open={!!testLoginUser} onOpenChange={(o) => { if (!o) setTestLoginUser(null) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FlaskConical className="size-5 text-amber-600" />
              Testar login
            </DialogTitle>
            <DialogDescription>
              {testLoginUser && (
                <>Verificar senha de <strong>{testLoginUser.email}</strong> sem fazer login como este usuário.</>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="test-pwd" className="flex items-center gap-1">
                <Key className="size-3" />
                Senha para testar
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="size-6 p-0 ml-auto"
                  onClick={() => setShowPassword(s => !s)}
                  title={showPassword ? 'Ocultar' : 'Mostrar'}
                >
                  {showPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </Button>
              </Label>
              <Input
                id="test-pwd"
                type={showPassword ? 'text' : 'password'}
                value={testLoginPassword}
                onChange={(e) => setTestLoginPassword(e.target.value)}
                placeholder="Digite a senha que o usuário está tentando usar"
                className="font-mono"
                onKeyDown={(e) => { if (e.key === 'Enter' && testLoginPassword) handleTestLogin() }}
              />
            </div>

            <Button
              onClick={handleTestLogin}
              disabled={isTestingLogin || !testLoginPassword}
              className="w-full"
            >
              {isTestingLogin ? <Loader2 className="size-4 mr-1.5 animate-spin" /> : <FlaskConical className="size-4 mr-1.5" />}
              Testar senha
            </Button>

            {testLoginResult && (
              <div className={`rounded-md border p-3 text-sm space-y-1 ${
                testLoginResult.passwordOk
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : 'bg-red-50 border-red-200 text-red-900'
              }`}>
                <div className="flex items-center gap-2 font-medium">
                  {testLoginResult.passwordOk
                    ? <><CheckCircle2 className="size-4" /> Senha correta! Login deve funcionar.</>
                    : <><AlertCircle className="size-4" /> Senha incorreta.</>}
                </div>
                <div className="text-xs space-y-0.5 mt-2 font-mono">
                  <div>Usuário encontrado: <strong>{testLoginResult.found ? 'sim' : 'não'}</strong></div>
                  <div>Ativo: <strong>{testLoginResult.isActive ? 'sim' : 'não'}</strong></div>
                  <div>Role: <strong>{testLoginResult.role}</strong></div>
                  <div>Hash armazenado (prefix): <code>{testLoginResult.hashPrefix}</code></div>
                  <div>Hash length: <strong>{testLoginResult.hashLength}</strong> chars</div>
                  {testLoginResult.providedHashPreview && (
                    <div>Novo hash da senha digitada (prefix): <code>{testLoginResult.providedHashPreview}</code></div>
                  )}
                </div>
                {!testLoginResult.passwordOk && testLoginResult.found && (
                  <div className="text-xs mt-2 p-2 bg-amber-50 border border-amber-200 rounded">
                    <strong>Sugestão:</strong> Edite o usuário, clique no botão <Dices className="size-3 inline" /> para gerar uma senha forte,
                    salve, copie a senha e envie ao usuário. Use esta tela novamente para confirmar.
                  </div>
                )}
              </div>
            )}

            <div className="text-xs text-muted-foreground">
              <p>Este teste não faz login — apenas verifica se a senha bate com o hash armazenado.</p>
              <p>Também registra logs no servidor (timestamp + email + resultado) para diagnóstico.</p>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editState.id ? 'Editar Usuário' : 'Novo Usuário'}
            </DialogTitle>
            <DialogDescription>
              {editState.id
                ? 'Altere os campos abaixo. Deixe a senha em branco para manter a atual.'
                : 'Preencha os campos para criar um novo usuário do middleware.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="edit-email">Email *</Label>
                <Input
                  id="edit-email"
                  type="email"
                  value={editState.email}
                  onChange={(e) => setEditState(s => ({ ...s, email: e.target.value }))}
                  placeholder="voce@empresa.com"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-name">Nome</Label>
                <Input
                  id="edit-name"
                  value={editState.name}
                  onChange={(e) => setEditState(s => ({ ...s, name: e.target.value }))}
                  placeholder="Nome do usuário"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="edit-password" className="flex items-center gap-1">
                  <Key className="size-3" />
                  {editState.id ? 'Nova senha (opcional)' : 'Senha *'}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="size-6 p-0 ml-auto"
                    onClick={generatePassword}
                    title="Gerar senha forte"
                  >
                    <Dices className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="size-6 p-0"
                    onClick={() => setShowPassword(s => !s)}
                    title={showPassword ? 'Ocultar' : 'Mostrar'}
                  >
                    {showPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </Button>
                </Label>
                <Input
                  id="edit-password"
                  type={showPassword ? 'text' : 'password'}
                  value={editState.password}
                  onChange={(e) => setEditState(s => ({ ...s, password: e.target.value }))}
                  placeholder={editState.id ? 'Deixe em branco para manter' : 'Mínimo 6 caracteres'}
                  required={!editState.id}
                  className="font-mono"
                />
                {editState.password && showPassword && (
                  <p className="text-xs text-emerald-600">
                    Senha gerada: <code className="font-mono bg-muted px-1 rounded">{editState.password}</code>
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-phone">Telefone WhatsApp</Label>
                <Input
                  id="edit-phone"
                  value={editState.whatsappPhone}
                  onChange={(e) => setEditState(s => ({ ...s, whatsappPhone: e.target.value }))}
                  placeholder="5511999999999"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Perfil</Label>
                <Select
                  value={editState.role}
                  onValueChange={(v) => setEditState(s => ({ ...s, role: v as 'user' | 'admin' }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">Usuário</SelectItem>
                    <SelectItem value="admin">
                      <span className="flex items-center gap-1.5">
                        <Shield className="size-3" /> Admin
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Status</Label>
                <div className="flex items-center gap-2 h-9">
                  <Switch
                    checked={editState.isActive}
                    onCheckedChange={(v) => setEditState(s => ({ ...s, isActive: v }))}
                  />
                  <span className="text-sm">
                    {editState.isActive ? 'Ativo' : 'Inativo'}
                  </span>
                </div>
              </div>
            </div>

            <div className="rounded-md bg-muted/30 border p-3 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <ExternalLink className="size-4" />
                Configuração Odoo (por usuário)
                <span className="text-xs font-normal text-muted-foreground">
                  — opcional, usa config global se vazio
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="edit-odoo-url">URL Odoo</Label>
                  <Input
                    id="edit-odoo-url"
                    value={editState.odooUrl}
                    onChange={(e) => setEditState(s => ({ ...s, odooUrl: e.target.value }))}
                    placeholder="https://empresa.odoo.com"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-odoo-db">Banco de dados</Label>
                  <Input
                    id="edit-odoo-db"
                    value={editState.odooDb}
                    onChange={(e) => setEditState(s => ({ ...s, odooDb: e.target.value }))}
                    placeholder="empresa_db"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-odoo-user">Usuário Odoo</Label>
                  <Input
                    id="edit-odoo-user"
                    value={editState.odooUsername}
                    onChange={(e) => setEditState(s => ({ ...s, odooUsername: e.target.value }))}
                    placeholder="login odoo"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-odoo-pass" className="flex items-center gap-1">
                    <Key className="size-3" />
                    {editState.id ? 'Nova senha Odoo (opcional)' : 'Senha Odoo / API Key'}
                  </Label>
                  <Input
                    id="edit-odoo-pass"
                    type="password"
                    value={editState.odooPassword}
                    onChange={(e) => setEditState(s => ({ ...s, odooPassword: e.target.value }))}
                    placeholder={editState.id ? 'Deixe em branco para manter' : 'senha ou API key'}
                  />
                </div>
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={isSaving}>
              Cancelar
            </Button>
            <Button
              onClick={handleSave}
              disabled={isSaving || !editState.email || (!editState.id && !editState.password)}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {isSaving && <Loader2 className="size-4 mr-1.5 animate-spin" />}
              {editState.id ? 'Salvar alterações' : 'Criar usuário'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
