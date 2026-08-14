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
} from 'lucide-react'

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
          <Button size="sm" onClick={handleCreate} className="bg-emerald-600 hover:bg-emerald-700 text-white">
            <UserPlus className="size-4 mr-1.5" />
            Novo Usuário
          </Button>
        </div>
      </div>

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
                </Label>
                <Input
                  id="edit-password"
                  type="password"
                  value={editState.password}
                  onChange={(e) => setEditState(s => ({ ...s, password: e.target.value }))}
                  placeholder={editState.id ? 'Deixe em branco para manter' : 'Mínimo 6 caracteres'}
                  required={!editState.id}
                />
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
