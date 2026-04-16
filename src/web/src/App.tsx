import { useMemo, useCallback, useRef, useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  Keyboard, Moon, Sun, Plus, Settings, Zap,
  ChevronLeft, X, TerminalSquare, FolderOpen, LayoutGrid,
  Lightbulb, Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from './store'
import { getAuthToken, setAuthToken } from './api'
import { useSSE } from './hooks/useSSE'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import {
  useBoardList, useBoard, usePoolStatus, useCreateBoard,
  useGenerateSpec, useApproveCard, useDeleteCard, useRetryCard,
  useSuggestTasks,
} from './hooks/useBoards'
import type { Card } from './types'
import { Board } from './components/Board'
import { CardDetailDialog } from './components/CardDetail'
import { CreateTaskModal } from './components/CreateTaskModal'
import { DirectoryModal } from './components/DirectoryModal'
import { ShortcutOverlay } from './components/ShortcutOverlay'
import { Terminal } from './components/Terminal'

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState('')
  const [checking, setChecking] = useState(true)
  const [needsAuth, setNeedsAuth] = useState(false)

  useEffect(() => {
    // check if the api requires auth by making a test request
    fetch('/api/boards', {
      headers: getAuthToken() ? { 'Authorization': `Bearer ${getAuthToken()}` } : {},
    }).then(res => {
      if (res.status === 401) setNeedsAuth(true)
      setChecking(false)
    }).catch(() => setChecking(false))
  }, [])

  if (checking) return null
  if (!needsAuth) return <>{children}</>

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '100vh', gap: '16px',
    }}>
      <h1 style={{ fontSize: '20px', fontWeight: 700 }}>antfarm</h1>
      <p style={{ fontSize: '13px', color: 'var(--muted-foreground)' }}>enter api key to continue</p>
      <Input
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && token.trim()) {
            setAuthToken(token.trim())
            window.location.reload()
          }
        }}
        placeholder="API key"
        className="max-w-xs"
      />
      <Button onClick={() => { if (token.trim()) { setAuthToken(token.trim()); window.location.reload(); } }}>
        Connect
      </Button>
    </div>
  )
}

export default function App() {
  const { connected } = useSSE('/events')
  const store = useAppStore()
  const { data: boards } = useBoardList()
  const { data: boardData } = useBoard(store.activeBoardId)
  const { data: pool } = usePoolStatus(store.activeBoardId)

  const generateSpec = useGenerateSpec(store.activeBoardId)
  const approveCard = useApproveCard(store.activeBoardId)
  const deleteCard = useDeleteCard(store.activeBoardId)
  const retryCard = useRetryCard(store.activeBoardId)
  const suggestTasks = useSuggestTasks(store.activeBoardId)

  // Auto-select first board only on initial load
  const hasAutoSelected = useRef(false)
  useEffect(() => {
    if (boards?.length && !store.activeBoardId && !hasAutoSelected.current) {
      hasAutoSelected.current = true
      store.setActiveBoardId(boards[0].id)
    }
  }, [boards, store.activeBoardId])

  const cardsByColumn = useMemo(() => {
    const map = new Map<number, Card[]>()
    if (!boardData) return map
    for (const col of boardData.columns) {
      map.set(
        col.id,
        boardData.cards
          .filter((c: Card) => c.column_id === col.id && !c.archived)
          .sort((a: Card, b: Card) => a.position - b.position),
      )
    }
    return map
  }, [boardData])

  const handleGenerateSpec = useCallback((id: number) => {
    generateSpec.mutate({ id }, { onError: (e) => toast.error(e.message) })
  }, [generateSpec])

  const handleApprove = useCallback((id: number) => {
    approveCard.mutate(id, { onError: (e) => toast.error(e.message) })
  }, [approveCard])

  const handleDelete = useCallback((id: number) => {
    deleteCard.mutate(id, { onError: (e) => toast.error(e.message) })
  }, [deleteCard])

  const handleRetry = useCallback((id: number) => {
    retryCard.mutate(id, { onError: (e) => toast.error(e.message) })
  }, [retryCard])

  useKeyboardShortcuts({
    columns: boardData?.columns ?? [],
    cardsByColumn,
    onGenerateSpec: handleGenerateSpec,
    onApprove: handleApprove,
    onDelete: handleDelete,
    onRetry: handleRetry,
  })

  // Board list view
  if (!store.activeBoardId || !boardData) {
    return (
      <div className="h-screen flex flex-col bg-background">
        <Header connected={connected} />
        <BoardListView boards={boards ?? []} onSelect={(id) => { hasAutoSelected.current = true; store.setActiveBoardId(id) }} />
      </div>
    )
  }

  const activeCards = boardData.cards.filter((c: Card) =>
    c.agent_status === 'working' || c.agent_status === 'waiting',
  ).length

  return (
    <div className="h-screen flex flex-col bg-background">
      <Header connected={connected}>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => store.setActiveBoardId(null)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="font-semibold text-sm">{boardData.board.name}</span>
          {boardData.board.directory && (
            <span className="text-xs text-muted-foreground font-mono truncate max-w-[200px]">
              {boardData.board.directory.split('/').slice(-2).join('/')}
            </span>
          )}
        </div>

        {pool && (
          <div className="flex items-center gap-1.5">
            <Zap className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              {pool.active}/{pool.max}
              {pool.queued > 0 && ` +${pool.queued}q`}
            </span>
            {activeCards > 0 && (
              <Badge variant="secondary" className="text-[10px] h-5 px-1.5">
                {activeCards} active
              </Badge>
            )}
            <Badge variant="outline" className="text-[10px] h-5 px-1.5 font-mono">
              {boardData.board.default_model || 'sonnet'}
            </Badge>
          </div>
        )}

        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={<Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => store.setShowCreateTask(true)} />}
            >
              <Plus className="h-4 w-4" />
            </TooltipTrigger>
            <TooltipContent>New task</TooltipContent>
          </Tooltip>
          {boardData.board.directory && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    disabled={suggestTasks.isPending}
                    onClick={() => {
                      toast.info('Asking Claude to analyze the codebase...')
                      suggestTasks.mutate(undefined, {
                        onSuccess: (data) => toast.success(`${data.created} tasks created`),
                        onError: (e) => toast.error(e.message || 'Failed to suggest tasks'),
                      })
                    }}
                  />
                }
              >
                {suggestTasks.isPending
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Lightbulb className="h-4 w-4" />
                }
              </TooltipTrigger>
              <TooltipContent>Suggest tasks</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger
              render={<Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => store.setShowDirectoryModal(true)} />}
            >
              <Settings className="h-4 w-4" />
            </TooltipTrigger>
            <TooltipContent>Board settings</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={<Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => store.setShowHelp(true)} />}
            >
              <Keyboard className="h-3.5 w-3.5" />
            </TooltipTrigger>
            <TooltipContent>Shortcuts (?)</TooltipContent>
          </Tooltip>
        </div>
      </Header>

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-x-auto">
          <Board
            columns={boardData.columns}
            cards={boardData.cards}
            chains={boardData.chains}
            boardId={boardData.board.id}
          />
        </div>

        {store.terminalCardId && (
          <div
            className="border-l border-border flex flex-col bg-card"
            style={{ width: store.sidebarWidth }}
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <TerminalSquare className="h-3.5 w-3.5" />
                Terminal
              </div>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={store.closeTerminal}>
                <X className="h-3 w-3" />
              </Button>
            </div>
            <div className="flex-1 overflow-hidden">
              <Terminal cardId={store.terminalCardId} />
            </div>
          </div>
        )}
      </div>

      <CardDetailDialog boardId={store.activeBoardId} />
      <CreateTaskModal boardId={store.activeBoardId} columns={boardData.columns} />
      <DirectoryModal board={boardData.board} />
      <ShortcutOverlay />
    </div>
  )
}

function BoardListView({ boards, onSelect }: { boards: import('./types').Board[]; onSelect: (id: number) => void }) {
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const createBoard = useCreateBoard()

  function handleCreate() {
    if (!newName.trim()) return
    createBoard.mutate(newName.trim(), {
      onSuccess: (board) => {
        setNewName('')
        setShowCreate(false)
        onSelect(board.id)
        toast.success(`Board "${board.name}" created`)
      },
      onError: (e) => toast.error(e.message),
    })
  }

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center space-y-1">
          <h2 className="text-xl font-semibold">Your Boards</h2>
          <p className="text-sm text-muted-foreground">Select a board to manage tasks, or create a new one.</p>
        </div>

        <div className="space-y-2">
          {boards.map(b => (
            <div
              key={b.id}
              className="flex items-center gap-3 p-4 rounded-lg border border-border bg-card hover:bg-accent/50 cursor-pointer transition-colors"
              onClick={() => onSelect(b.id)}
            >
              <LayoutGrid className="h-5 w-5 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <h3 className="font-medium text-sm">{b.name}</h3>
                {b.directory && (
                  <p className="text-xs text-muted-foreground font-mono truncate mt-0.5 flex items-center gap-1">
                    <FolderOpen className="h-3 w-3 shrink-0" />
                    {b.directory}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {b.max_concurrency && (
                  <Badge variant="outline" className="text-[10px]">
                    <Zap className="h-2.5 w-2.5 mr-0.5" />{b.max_concurrency}
                  </Badge>
                )}
                <Badge variant="secondary" className="text-[10px] font-mono">
                  {b.default_model}
                </Badge>
                <ChevronLeft className="h-4 w-4 text-muted-foreground rotate-180" />
              </div>
            </div>
          ))}
        </div>

        {/* Create new board */}
        {showCreate ? (
          <div className="flex gap-2">
            <Input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
              placeholder="Board name..."
              autoFocus
              className="text-sm"
            />
            <Button size="sm" onClick={handleCreate} disabled={!newName.trim()}>Create</Button>
            <Button size="sm" variant="ghost" onClick={() => { setShowCreate(false); setNewName('') }}>Cancel</Button>
          </div>
        ) : (
          <Button variant="outline" className="w-full" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-2" /> New Board
          </Button>
        )}
      </div>
    </div>
  )
}

function Header({ connected, children }: { connected: boolean; children?: React.ReactNode }) {
  const store = useAppStore()

  return (
    <header className="h-11 border-b border-border flex items-center gap-3 px-3 shrink-0">
      <div className="flex items-center gap-1.5">
        <span className="text-base">🐜</span>
        <span className="text-sm font-semibold tracking-tight">Antfarm</span>
      </div>

      <div className="flex items-center gap-1">
        <div className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500 status-dot-pulse'}`} />
        <span className="text-[10px] text-muted-foreground">
          {connected ? 'Live' : 'Reconnecting'}
        </span>
      </div>

      <div className="flex-1 flex items-center gap-3">{children}</div>

      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon" className="h-7 w-7" onClick={store.toggleTheme} />}>
          {store.theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </TooltipTrigger>
        <TooltipContent>Toggle theme</TooltipContent>
      </Tooltip>
    </header>
  )
}
