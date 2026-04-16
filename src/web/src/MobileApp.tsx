import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { useSSE } from './hooks/useSSE'
import {
  useBoardList, useBoard, useGenerateSpec, useApproveCard,
  useRetryCard, useResetCard, useCreateCard,
} from './hooks/useBoards'
import { api, setAuthToken } from './api'
import type { Card } from './types'

const STAGES = ['Idea', 'Speccing', 'Spec Ready', 'Planning', 'Plan Review', 'Building', 'Reviewing', 'Done'] as const

const STAGE_COLORS: Record<string, string> = {
  'Idea': '#6b7280', 'Speccing': '#6366f1', 'Spec Ready': '#8b5cf6',
  'Planning': '#a855f7', 'Plan Review': '#d946ef', 'Building': '#3b82f6',
  'Reviewing': '#f97316', 'Done': '#22c55e',
}

const STATUS_COLORS: Record<string, string> = {
  idle: '#71717a', working: '#818cf8', waiting: '#f59e0b',
  errored: '#f87171', completed: '#4ade80',
}

// login screen when auth is required
function LoginScreen() {
  const [token, setToken] = useState('')
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '100vh', padding: '24px',
      background: '#0a0a0a', color: '#e4e4e7',
    }}>
      <h1 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '8px' }}>antfarm</h1>
      <p style={{ fontSize: '14px', color: '#71717a', marginBottom: '24px' }}>enter your api key to continue</p>
      <input
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && token.trim()) { setAuthToken(token.trim()); window.location.reload(); } }}
        placeholder="API key"
        style={{
          width: '100%', maxWidth: '320px', padding: '14px 16px', borderRadius: '12px',
          border: '1px solid #27272a', background: '#18181b', color: '#e4e4e7',
          fontSize: '16px', marginBottom: '12px', outline: 'none',
        }}
      />
      <button
        onClick={() => { if (token.trim()) { setAuthToken(token.trim()); window.location.reload(); } }}
        style={{
          width: '100%', maxWidth: '320px', padding: '14px', borderRadius: '12px',
          border: 'none', background: '#6366f1', color: 'white',
          fontSize: '16px', fontWeight: 600, cursor: 'pointer',
        }}
      >
        Connect
      </button>
    </div>
  )
}

// mobile card row
function MobileCard({ card, columnName, onTap }: { card: Card; columnName: string; onTap: () => void }) {
  const statusColor = STATUS_COLORS[card.agent_status] || '#71717a'
  return (
    <button
      onClick={onTap}
      style={{
        display: 'flex', flexDirection: 'column', gap: '6px',
        padding: '14px 16px', borderRadius: '12px',
        background: '#18181b', border: '1px solid #27272a',
        width: '100%', textAlign: 'left', cursor: 'pointer',
        borderLeft: `3px solid ${STAGE_COLORS[columnName] || '#6b7280'}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{
          width: '8px', height: '8px', borderRadius: '50%',
          background: statusColor, flexShrink: 0,
        }} />
        <span style={{ fontSize: '15px', fontWeight: 500, color: '#e4e4e7', flex: 1 }}>
          {card.title}
        </span>
      </div>
      {card.model && (
        <span style={{
          fontSize: '11px', color: '#6366f1', fontFamily: 'monospace',
          background: 'rgba(99,102,241,0.1)', padding: '2px 6px', borderRadius: '4px',
          alignSelf: 'flex-start', textTransform: 'uppercase',
        }}>
          {card.model}
        </span>
      )}
    </button>
  )
}

// expanded card detail (inline, not modal)
function MobileCardDetail({ card, boardId, onClose }: { card: Card; boardId: number; onClose: () => void }) {
  const [detail, setDetail] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const generateSpec = useGenerateSpec(boardId)
  const approveCard = useApproveCard(boardId)
  const retryCard = useRetryCard(boardId)
  const resetCard = useResetCard(boardId)

  useEffect(() => {
    api.getCard(card.id).then(d => { setDetail(d); setLoading(false); }).catch(() => setLoading(false))
  }, [card.id])

  if (loading) return (
    <div style={{ padding: '20px', textAlign: 'center', color: '#71717a' }}>loading...</div>
  )

  const d = detail || card

  return (
    <div style={{
      background: '#18181b', borderRadius: '16px', border: '1px solid #27272a',
      margin: '0 0 12px', overflow: 'hidden',
    }}>
      {/* header */}
      <div style={{
        padding: '16px', display: 'flex', alignItems: 'flex-start', gap: '12px',
        borderBottom: '1px solid #27272a',
      }}>
        <div style={{ flex: 1 }}>
          <h3 style={{ fontSize: '17px', fontWeight: 600, color: '#e4e4e7', margin: 0 }}>{d.title}</h3>
          {d.description && (
            <p style={{ fontSize: '13px', color: '#a1a1aa', margin: '6px 0 0', lineHeight: '18px' }}>{d.description}</p>
          )}
        </div>
        <button onClick={onClose} style={{
          background: 'none', border: 'none', color: '#71717a',
          fontSize: '20px', cursor: 'pointer', padding: '0',
        }}>x</button>
      </div>

      {/* spec preview */}
      {d.spec && (
        <div style={{
          padding: '12px 16px', fontSize: '13px', color: '#a1a1aa',
          lineHeight: '18px', maxHeight: '200px', overflow: 'auto',
          borderBottom: '1px solid #27272a', whiteSpace: 'pre-wrap',
        }}>
          {d.spec.slice(0, 500)}{d.spec.length > 500 ? '...' : ''}
        </div>
      )}

      {/* actions */}
      <div style={{
        padding: '12px 16px', display: 'flex', gap: '8px', flexWrap: 'wrap',
      }}>
        {d.spec_status === 'pending' && (
          <ActionButton label="Generate Spec" color="#8b5cf6" onClick={() => {
            generateSpec.mutate(d.id)
            toast.success('Spec generation started')
            onClose()
          }} />
        )}
        {d.spec_status === 'ready' && (
          <ActionButton label="Approve" color="#22c55e" onClick={() => {
            approveCard.mutate(d.id)
            toast.success('Approved')
            onClose()
          }} />
        )}
        {d.agent_status === 'errored' && (
          <>
            <ActionButton label="Retry" color="#f97316" onClick={() => {
              retryCard.mutate(d.id)
              toast.success('Retrying')
              onClose()
            }} />
            <ActionButton label="Reset" color="#71717a" onClick={() => {
              resetCard.mutate(d.id)
              toast.success('Reset to Idea')
              onClose()
            }} />
          </>
        )}
        {d.pr_url && (
          <a href={d.pr_url} target="_blank" rel="noopener noreferrer" style={{
            padding: '10px 16px', borderRadius: '10px', fontSize: '14px', fontWeight: 600,
            background: '#6366f1', color: 'white', textDecoration: 'none',
          }}>
            View PR
          </a>
        )}

        {/* create PR (when card has a branch but no PR yet) */}
        {d.git_branch && !d.pr_url && d.agent_status === 'completed' && (
          <MobileCreatePr cardId={d.id} onDone={onClose} />
        )}

        {/* work on PR (send more prompts to the same branch) */}
        {d.git_branch && d.agent_status !== 'working' && (
          <WorkOnPrButton cardId={d.id} onDone={onClose} />
        )}
      </div>
    </div>
  )
}

function MobileCreatePr({ cardId, onDone }: { cardId: number; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [baseBranch, setBaseBranch] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    api.request<{ branches: string[]; default: string }>(`/api/cards/${cardId}/branches`)
      .then(data => { setBranches(data.branches); setBaseBranch(data.default); })
      .catch(() => {})
  }, [open, cardId])

  if (!open) {
    return <ActionButton label="Create PR" color="#6366f1" onClick={() => setOpen(true)} />
  }

  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
      <select
        value={baseBranch}
        onChange={(e) => setBaseBranch(e.target.value)}
        style={{
          width: '100%', padding: '10px 12px', borderRadius: '10px',
          border: '1px solid #27272a', background: '#0a0a0a', color: '#e4e4e7',
          fontSize: '14px',
        }}
      >
        {branches.map(b => <option key={b} value={b}>base: {b}</option>)}
      </select>
      <button
        onClick={async () => {
          setLoading(true)
          try {
            const result = await api.request<{ pr_url: string; title: string }>(`/api/cards/${cardId}/create-pr`, {
              method: 'POST', body: JSON.stringify({ base: baseBranch }),
            })
            toast.success(`PR created`)
            onDone()
          } catch (err: any) {
            toast.error(err.message || 'Failed to create PR')
            setLoading(false)
          }
        }}
        disabled={loading}
        style={{
          padding: '12px', borderRadius: '10px', border: 'none',
          background: loading ? '#3f3f46' : '#6366f1', color: 'white',
          fontSize: '15px', fontWeight: 600,
        }}
      >
        {loading ? 'Creating PR...' : 'Create Pull Request'}
      </button>
    </div>
  )
}

function WorkOnPrButton({ cardId, onDone }: { cardId: number; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState('')

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{
        padding: '10px 16px', borderRadius: '10px', border: '1px solid #27272a',
        background: 'transparent', color: '#a1a1aa', fontSize: '14px', fontWeight: 500,
        cursor: 'pointer',
      }}>
        Work on PR
      </button>
    )
  }

  const submit = async () => {
    if (!prompt.trim()) return
    try {
      await api.request(`/api/cards/${cardId}/work-on-pr`, {
        method: 'POST', body: JSON.stringify({ prompt: prompt.trim() }),
      })
      toast.success('Working on it')
      setPrompt('')
      setOpen(false)
      onDone()
    } catch (err: any) {
      toast.error(err.message || 'Failed')
    }
  }

  return (
    <div style={{
      width: '100%', display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px',
    }}>
      <input
        autoFocus
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setOpen(false); }}
        placeholder="what should claude fix or change?"
        style={{
          width: '100%', padding: '12px 14px', borderRadius: '10px',
          border: '1px solid #27272a', background: '#0a0a0a', color: '#e4e4e7',
          fontSize: '15px', outline: 'none',
        }}
      />
      <div style={{ display: 'flex', gap: '8px' }}>
        <button onClick={submit} style={{
          flex: 1, padding: '10px', borderRadius: '10px', border: 'none',
          background: '#6366f1', color: 'white', fontSize: '14px', fontWeight: 600,
        }}>Send</button>
        <button onClick={() => setOpen(false)} style={{
          padding: '10px 14px', borderRadius: '10px', border: '1px solid #27272a',
          background: 'transparent', color: '#71717a', fontSize: '14px',
        }}>Cancel</button>
      </div>
    </div>
  )
}

function ActionButton({ label, color, onClick }: { label: string; color: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      padding: '10px 16px', borderRadius: '10px', border: 'none',
      background: color, color: 'white', fontSize: '14px', fontWeight: 600,
      cursor: 'pointer',
    }}>
      {label}
    </button>
  )
}

export function MobileApp() {
  const [activeStage, setActiveStage] = useState<string>('Idea')
  const [expandedCardId, setExpandedCardId] = useState<number | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newModel, setNewModel] = useState('')

  const boardList = useBoardList()
  const boardId = boardList.data?.[0]?.id
  const board = useBoard(boardId ?? 0)
  const createCard = useCreateCard(boardId ?? null)

  useSSE('/events')

  // detect auth failure
  if (board.error?.message === 'Unauthorized') {
    return <LoginScreen />
  }

  if (board.isLoading || !board.data) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', background: '#0a0a0a', color: '#71717a',
      }}>
        loading...
      </div>
    )
  }

  const { columns, cards } = board.data
  const activeColumn = columns.find(c => c.name === activeStage)
  const activeCards = activeColumn
    ? cards.filter(c => c.column_id === activeColumn.id && !c.archived)
    : []

  // count cards per stage for badges
  const countByStage: Record<string, number> = {}
  for (const col of columns) {
    countByStage[col.name] = cards.filter(c => c.column_id === col.id && !c.archived).length
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      background: '#0a0a0a', color: '#e4e4e7',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      {/* header */}
      <header style={{
        padding: '12px 16px', display: 'flex', alignItems: 'center',
        borderBottom: '1px solid #27272a',
        paddingTop: 'env(safe-area-inset-top, 12px)',
      }}>
        <h1 style={{ fontSize: '17px', fontWeight: 700, margin: 0, flex: 1 }}>antfarm</h1>
        <span style={{ fontSize: '12px', color: '#71717a' }}>
          {cards.filter(c => c.agent_status === 'working').length} working
        </span>
      </header>

      {/* stage tabs (horizontally scrollable) */}
      <div style={{
        display: 'flex', gap: '0', overflowX: 'auto', borderBottom: '1px solid #27272a',
        WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none',
      }}>
        {STAGES.map(stage => {
          const count = countByStage[stage] || 0
          const isActive = activeStage === stage
          return (
            <button
              key={stage}
              onClick={() => setActiveStage(stage)}
              style={{
                padding: '10px 14px', border: 'none', background: 'transparent',
                color: isActive ? '#e4e4e7' : '#52525b', fontSize: '13px', fontWeight: 500,
                cursor: 'pointer', whiteSpace: 'nowrap', position: 'relative',
                borderBottom: isActive ? `2px solid ${STAGE_COLORS[stage]}` : '2px solid transparent',
                flexShrink: 0,
              }}
            >
              {stage.replace('Spec Ready', 'Ready').replace('Plan Review', 'Review')}
              {count > 0 && (
                <span style={{
                  marginLeft: '4px', fontSize: '11px', color: '#71717a',
                }}>
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* card list */}
      <div style={{
        flex: 1, overflow: 'auto', padding: '12px 16px',
        display: 'flex', flexDirection: 'column', gap: '8px',
        paddingBottom: 'env(safe-area-inset-bottom, 12px)',
      }}>
        {activeCards.length === 0 && (
          <div style={{
            textAlign: 'center', padding: '48px 16px', color: '#52525b', fontSize: '14px',
          }}>
            no cards in {activeStage.toLowerCase()}
          </div>
        )}

        {activeCards.map(card => (
          expandedCardId === card.id ? (
            <MobileCardDetail
              key={card.id}
              card={card}
              boardId={boardId!}
              onClose={() => setExpandedCardId(null)}
            />
          ) : (
            <MobileCard
              key={card.id}
              card={card}
              columnName={activeStage}
              onTap={() => setExpandedCardId(card.id)}
            />
          )
        ))}

        {/* create task (only in Idea tab) */}
        {activeStage === 'Idea' && activeColumn && (
          showCreate ? (
            <div style={{
              padding: '14px', borderRadius: '12px', background: '#18181b',
              border: '1px solid #27272a', display: 'flex', flexDirection: 'column', gap: '10px',
            }}>
              <input
                autoFocus
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="task title"
                style={{
                  width: '100%', padding: '12px 14px', borderRadius: '10px',
                  border: '1px solid #27272a', background: '#0a0a0a', color: '#e4e4e7',
                  fontSize: '16px', outline: 'none',
                }}
              />
              <textarea
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="description... be detailed, claude reads this to write the spec"
                rows={4}
                style={{
                  width: '100%', padding: '12px 14px', borderRadius: '10px',
                  border: '1px solid #27272a', background: '#0a0a0a', color: '#e4e4e7',
                  fontSize: '14px', outline: 'none', resize: 'vertical', lineHeight: '20px',
                }}
              />
              <select
                value={newModel}
                onChange={(e) => setNewModel(e.target.value)}
                style={{
                  width: '100%', padding: '10px 12px', borderRadius: '10px',
                  border: '1px solid #27272a', background: '#0a0a0a', color: '#e4e4e7',
                  fontSize: '14px',
                }}
              >
                <option value="">default model ({board.data?.board.default_model || 'opus'})</option>
                <option value="opus">opus</option>
                <option value="sonnet">sonnet</option>
                <option value="haiku">haiku</option>
              </select>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => {
                    if (newTitle.trim()) {
                      createCard.mutate({
                        column_id: activeColumn.id,
                        title: newTitle.trim(),
                        description: newDesc.trim() || undefined,
                        model: newModel || undefined,
                      })
                      setNewTitle(''); setNewDesc(''); setNewModel('')
                      setShowCreate(false)
                      toast.success('Task created')
                    }
                  }}
                  style={{
                    flex: 1, padding: '12px', borderRadius: '10px', border: 'none',
                    background: newTitle.trim() ? '#6366f1' : '#27272a',
                    color: newTitle.trim() ? 'white' : '#52525b',
                    fontSize: '15px', fontWeight: 600,
                  }}
                >
                  Create task
                </button>
                <button
                  onClick={() => { setShowCreate(false); setNewTitle(''); setNewDesc(''); setNewModel(''); }}
                  style={{
                    padding: '12px 16px', borderRadius: '10px', border: '1px solid #27272a',
                    background: 'transparent', color: '#71717a', fontSize: '15px',
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowCreate(true)}
              style={{
                width: '100%', padding: '14px', borderRadius: '12px',
                border: '1px dashed #27272a', background: 'transparent',
                color: '#52525b', fontSize: '15px', fontWeight: 500, cursor: 'pointer',
              }}
            >
              + new task
            </button>
          )
        )}
      </div>
    </div>
  )
}
