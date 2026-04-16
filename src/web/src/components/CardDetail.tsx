import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Check, Trash2, RotateCcw, TerminalSquare, ExternalLink, X,
  GitBranch, Plus, AlertTriangle, Loader2, Undo2, Cpu, Link2, Send, GitPullRequest,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Separator } from '@/components/ui/separator'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useAppStore } from '../store'
import {
  useCardDetail, usePlan, useBoard, useUpdateCard, useDeleteCard,
  useGenerateSpec, useApproveCard, useApprovePlan, useRejectPlan,
  useRetryCard, useResetCard, useAddSubtask, useToggleSubtask, useAddNote,
  useModels, useChain, useReorderChain, useRemoveCardFromChain, useCreateChain, useAddCardToChain,
} from '../hooks/useBoards'
import type { Note, Subtask, CardDetail as CardDetailType, ImplementationPlan } from '../types'
import { api } from '../api'
import { stageColor, stageLabel, type PipelineStage } from '../types'

export function CardDetailDialog({ boardId }: { boardId: number }) {
  const { detailCardId, closeCardDetail, openTerminal } = useAppStore()
  const { data: card } = useCardDetail(detailCardId)

  const showPlan = card?.plan_status === 'ready' || card?.plan_status === 'approved'
  const { data: plan } = usePlan(detailCardId, showPlan)

  return (
    <Dialog open={detailCardId != null} onOpenChange={(open) => { if (!open) closeCardDetail() }}>
      <DialogContent className="max-w-5xl w-[900px] h-[80vh] p-0 gap-0 overflow-hidden flex flex-col" showCloseButton={false}>
        {card ? (
          <CardDetailContent
            card={card}
            plan={plan ?? null}
            boardId={boardId}
            onClose={closeCardDetail}
            onOpenTerminal={() => openTerminal(card.id)}
          />
        ) : (
          <div className="p-8 text-center text-muted-foreground text-sm">Loading...</div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function CardDetailContent({
  card,
  plan,
  boardId,
  onClose,
  onOpenTerminal,
}: {
  card: CardDetailType
  plan: ImplementationPlan | null
  boardId: number
  onClose: () => void
  onOpenTerminal: () => void
}) {
  const [editingTitle, setEditingTitle] = useState(false)
  const [title, setTitle] = useState(card.title)
  const [editingDesc, setEditingDesc] = useState(false)
  const [description, setDescription] = useState(card.description ?? '')
  const [editingSpec, setEditingSpec] = useState(false)
  const [spec, setSpec] = useState(card.spec ?? '')
  const [respecComment, setRespecComment] = useState('')
  const [showDelete, setShowDelete] = useState(false)
  const [rejectFeedback, setRejectFeedback] = useState('')
  const [newSubtask, setNewSubtask] = useState('')
  const [newNote, setNewNote] = useState('')
  const [activeTab, setActiveTab] = useState('spec')

  useEffect(() => { setTitle(card.title) }, [card.title])
  useEffect(() => { setDescription(card.description ?? '') }, [card.description])
  useEffect(() => { setSpec(card.spec ?? '') }, [card.spec])

  const updateCard = useUpdateCard(boardId)
  const deleteCard = useDeleteCard(boardId)
  const generateSpec = useGenerateSpec(boardId)
  const approveCard = useApproveCard(boardId)
  const approvePlan = useApprovePlan(boardId)
  const rejectPlan = useRejectPlan(boardId)
  const retryCard = useRetryCard(boardId)
  const resetCard = useResetCard(boardId)
  const addSubtask = useAddSubtask()
  const toggleSubtask = useToggleSubtask()
  const addNote = useAddNote()
  const { data: models } = useModels()

  const stage = getStage(card)
  const color = stageColor(stage)

  function saveTitle() {
    if (title.trim() && title !== card.title) {
      updateCard.mutate({ id: card.id, title: title.trim() }, { onError: (e) => toast.error(e.message) })
    }
    setEditingTitle(false)
  }

  function saveDescription() {
    if (description !== (card.description ?? '')) {
      updateCard.mutate({ id: card.id, description }, { onError: (e) => toast.error(e.message) })
    }
    setEditingDesc(false)
  }

  function saveSpec() {
    if (spec !== (card.spec ?? '')) {
      updateCard.mutate({ id: card.id, spec }, { onError: (e) => toast.error(e.message) })
    }
    setEditingSpec(false)
  }

  function handleModelChange(model: string) {
    updateCard.mutate({ id: card.id, model }, { onError: (e) => toast.error(e.message) })
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Header: Title ── */}
      <div className="px-6 pt-5 pb-2 shrink-0">
        {editingTitle ? (
          <Input
            value={title}
            onChange={e => setTitle(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={e => e.key === 'Enter' && saveTitle()}
            autoFocus
            className="text-lg font-semibold h-9 border-none shadow-none px-0 focus-visible:ring-0"
          />
        ) : (
          <h2
            className="text-lg font-semibold leading-snug cursor-pointer hover:text-muted-foreground transition-colors"
            onClick={() => setEditingTitle(true)}
          >
            {card.title}
          </h2>
        )}
      </div>

      {/* ── Metadata row (Linear-style properties) ── */}
      <div className="px-6 pb-3 shrink-0 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        {/* Stage */}
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground/60">Stage</span>
          <div className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
            <span className="text-foreground font-medium">{stageLabel(stage)}</span>
          </div>
        </div>

        {/* Status */}
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground/60">Status</span>
          <StatusBadge status={card.agent_status} />
        </div>

        {/* Model selector */}
        <div className="flex items-center gap-1.5">
          <Cpu className="h-3 w-3 text-muted-foreground/60" />
          <Select value={card.model ?? 'sonnet'} onValueChange={handleModelChange}>
            <SelectTrigger size="sm" className="h-6 text-xs border-none shadow-none bg-transparent hover:bg-muted/50 px-1.5 gap-1 w-auto">
              <SelectValue />
            </SelectTrigger>
            <SelectContent side="bottom" align="start" className="min-w-[120px]">
              {getUniqueModels(models ?? null).map(m => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Chain */}
        {card.chain_id != null && (
          <div className="flex items-center gap-1.5">
            <Link2 className="h-3 w-3 text-muted-foreground/60" />
            <span className="text-foreground font-medium">Chain #{card.chain_id}</span>
            {card.chain_position != null && (
              <span className="text-muted-foreground">pos {card.chain_position + 1}</span>
            )}
          </div>
        )}

        {/* Git branch */}
        {card.git && (
          <div className="flex items-center gap-1.5">
            <GitBranch className="h-3 w-3 text-muted-foreground/60" />
            <code className="text-[11px] font-mono text-foreground">{card.git.branch}</code>
          </div>
        )}

        {/* PR */}
        {card.pr_url && (
          <a href={card.pr_url} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1 text-primary hover:underline">
            <ExternalLink className="h-3 w-3" /> PR
          </a>
        )}
      </div>

      {/* ── Description ── */}
      <div className="px-6 pb-3 shrink-0">
        {editingDesc ? (
          <Textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            onBlur={saveDescription}
            className="text-sm min-h-[48px] resize-none"
            placeholder="Add a description..."
            autoFocus
          />
        ) : (
          <p
            className="text-[13px] text-muted-foreground cursor-pointer hover:bg-muted/50 rounded-md px-2 py-1.5 -mx-2 transition-colors leading-relaxed"
            onClick={() => setEditingDesc(true)}
          >
            {card.description || 'Add description...'}
          </p>
        )}
      </div>

      <Separator />

      {/* ── Tabs ── */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col flex-1 min-h-0">
        <TabsList className="h-9 mx-6 mt-2 shrink-0">
          <TabsTrigger value="spec" className="text-xs">Spec</TabsTrigger>
          <TabsTrigger value="plan" className="text-xs">Plan</TabsTrigger>
          <TabsTrigger value="notes" className="text-xs">
            Notes{card.notes.length > 0 ? ` (${card.notes.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="subtasks" className="text-xs">
            Subtasks{card.subtasks.length > 0 ? ` (${card.subtasks.filter((s: Subtask) => s.completed).length}/${card.subtasks.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="chain" className="text-xs">
            Chain{card.chain_id != null ? ' ✓' : ''}
          </TabsTrigger>
          <TabsTrigger value="info" className="text-xs">Info</TabsTrigger>
        </TabsList>

        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-6 py-4">
          {activeTab === 'spec' && <SpecTab card={card} editingSpec={editingSpec} setEditingSpec={setEditingSpec} spec={spec} setSpec={setSpec} saveSpec={saveSpec} respecComment={respecComment} setRespecComment={setRespecComment} generateSpec={generateSpec} />}
          {activeTab === 'plan' && <PlanTab card={card} plan={plan} approvePlan={approvePlan} rejectPlan={rejectPlan} rejectFeedback={rejectFeedback} setRejectFeedback={setRejectFeedback} />}
          {activeTab === 'notes' && <NotesTab card={card} newNote={newNote} setNewNote={setNewNote} addNote={addNote} />}
          {activeTab === 'subtasks' && <SubtasksTab card={card} newSubtask={newSubtask} setNewSubtask={setNewSubtask} addSubtask={addSubtask} toggleSubtask={toggleSubtask} />}
          {activeTab === 'chain' && <ChainTab card={card} boardId={boardId} />}
          {activeTab === 'info' && <InfoTab card={card} />}
        </div>
      </Tabs>

      {/* ── Footer ── */}
      <div className="border-t border-border bg-muted/30 px-5 py-2.5 flex items-center gap-2 shrink-0">
        {showDelete ? (
          <>
            <span className="text-sm text-destructive mr-auto">Delete this card?</span>
            <Button size="sm" variant="destructive" onClick={() => {
              deleteCard.mutate(card.id, {
                onSuccess: () => { onClose(); toast.success('Card deleted') },
                onError: (e) => toast.error(e.message),
              })
            }}>
              Confirm
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowDelete(false)}>Cancel</Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setShowDelete(true)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>

            <div className="flex-1" />

            {card.agent_status === 'errored' && (
              <Button size="sm" variant="outline" onClick={() => retryCard.mutate(card.id, { onError: (e) => toast.error(e.message) })}>
                <RotateCcw className="h-3 w-3 mr-1" /> Retry
              </Button>
            )}

            {stage !== 'idea' && stage !== 'done' && (
              <Button size="sm" variant="outline" onClick={() => resetCard.mutate(card.id, { onError: (e) => toast.error(e.message) })}>
                <Undo2 className="h-3 w-3 mr-1" /> Reset
              </Button>
            )}

            {(card.agent_status === 'working' || card.claude_session_id) && (
              <Button size="sm" variant="outline" onClick={() => { onClose(); onOpenTerminal() }}>
                <TerminalSquare className="h-3 w-3 mr-1" /> Terminal
              </Button>
            )}

            {card.spec_status === 'ready' && stage === 'spec_ready' && (
              <Button size="sm" onClick={() => approveCard.mutate(card.id, { onError: (e) => toast.error(e.message) })}>
                <Check className="h-3 w-3 mr-1" /> Approve Spec
              </Button>
            )}

            {stage === 'idea' && card.agent_status === 'idle' && (
              <Button size="sm" onClick={() => generateSpec.mutate({ id: card.id }, { onError: (e) => toast.error(e.message) })}>
                Generate Spec
              </Button>
            )}

            {card.pr_url && (
              <Button size="sm" variant="outline" onClick={() => window.open(card.pr_url!, '_blank')}>
                <ExternalLink className="h-3 w-3 mr-1" /> View PR
              </Button>
            )}

            {/* create PR: card has a branch, is completed, no PR yet */}
            {card.git_branch && !card.pr_url && card.agent_status === 'completed' && (
              <CreatePrInline cardId={card.id} />
            )}

            {/* work on PR: card has a branch and a PR, not currently working */}
            {card.git_branch && card.pr_url && card.agent_status !== 'working' && (
              <WorkOnPrInline cardId={card.id} />
            )}
          </>
        )}
      </div>
    </div>
  )
}

function CreatePrInline({ cardId }: { cardId: number }) {
  const [open, setOpen] = useState(false)
  const [baseBranch, setBaseBranch] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [defaultBranch, setDefaultBranch] = useState('main')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // fetch branches when expanded
  useEffect(() => {
    if (!open) return
    api.request<{ branches: string[]; default: string }>(`/api/cards/${cardId}/branches`)
      .then(data => {
        setBranches(data.branches)
        setDefaultBranch(data.default)
        setBaseBranch(data.default)
      })
      .catch(() => setBranches(['main']))
  }, [open, cardId])

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        <GitPullRequest className="h-3 w-3 mr-1" /> Create PR
      </Button>
    )
  }

  const submit = async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.request<{ pr_url: string; title: string }>(`/api/cards/${cardId}/create-pr`, {
        method: 'POST',
        body: JSON.stringify({ base: baseBranch || defaultBranch }),
      })
      toast.success(`PR created: ${result.title}`)
      setOpen(false)
    } catch (err: any) {
      setError(err.message || 'Failed to create PR')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex gap-2 items-center flex-wrap">
      <select
        value={baseBranch}
        onChange={(e) => setBaseBranch(e.target.value)}
        className="h-8 text-xs rounded-md border border-border bg-background px-2"
      >
        {branches.length > 0 ? (
          branches.map(b => <option key={b} value={b}>{b}</option>)
        ) : (
          <option value="main">main</option>
        )}
      </select>
      <Button size="sm" onClick={submit} disabled={loading}>
        {loading ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <GitPullRequest className="h-3 w-3 mr-1" />}
        {loading ? 'Creating PR...' : 'Create PR'}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
        <X className="h-3 w-3" />
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  )
}

function WorkOnPrInline({ cardId }: { cardId: number }) {
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState('')

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Send className="h-3 w-3 mr-1" /> Work on PR
      </Button>
    )
  }

  const submit = async () => {
    if (!prompt.trim()) return
    try {
      await api.request(`/api/cards/${cardId}/work-on-pr`, {
        method: 'POST', body: JSON.stringify({ prompt: prompt.trim() }),
      })
      toast.success('Claude is working on it')
      setPrompt('')
      setOpen(false)
    } catch (err: any) { toast.error(err.message || 'Failed') }
  }

  return (
    <div className="flex gap-2 items-center">
      <Input
        autoFocus
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setOpen(false); }}
        placeholder="what should claude change?"
        className="h-8 text-sm"
      />
      <Button size="sm" onClick={submit} disabled={!prompt.trim()}>
        <Send className="h-3 w-3" />
      </Button>
    </div>
  )
}

function StatusBadge({ status }: { status: CardDetailType['agent_status'] }) {
  switch (status) {
    case 'working':
      return <span className="flex items-center gap-1 text-blue-500 font-medium"><Loader2 className="h-3 w-3 animate-spin" /> Working</span>
    case 'waiting':
      return <span className="flex items-center gap-1 text-amber-500 font-medium"><AlertTriangle className="h-3 w-3" /> Waiting</span>
    case 'errored':
      return <span className="flex items-center gap-1 text-red-500 font-medium"><AlertTriangle className="h-3 w-3" /> Error</span>
    case 'completed':
      return <span className="flex items-center gap-1 text-green-500 font-medium"><Check className="h-3 w-3" /> Done</span>
    default:
      return <span className="text-foreground font-medium">Idle</span>
  }
}

// --- Tab content components ---

function SpecTab({ card, editingSpec, setEditingSpec, spec, setSpec, saveSpec, respecComment, setRespecComment, generateSpec }: {
  card: CardDetailType; editingSpec: boolean; setEditingSpec: (v: boolean) => void
  spec: string; setSpec: (v: string) => void; saveSpec: () => void
  respecComment: string; setRespecComment: (v: string) => void; generateSpec: { mutate: Function }
}) {
  if (!card.spec) {
    return (
      <div className="text-center py-16 text-muted-foreground text-sm">
        {card.spec_status === 'generating' ? (
          <div className="flex items-center justify-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Generating spec...
          </div>
        ) : (
          <p>No spec yet. Click "Generate Spec" to start.</p>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {editingSpec ? (
        <div className="space-y-2">
          <Textarea value={spec} onChange={e => setSpec(e.target.value)} className="min-h-[250px] font-mono text-xs" />
          <div className="flex gap-2">
            <Button size="sm" onClick={saveSpec}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => { setEditingSpec(false); setSpec(card.spec ?? '') }}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="prose-sm cursor-pointer hover:bg-muted/20 rounded-lg p-3 -m-3 transition-colors" onClick={() => setEditingSpec(true)}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{card.spec}</ReactMarkdown>
        </div>
      )}

      {card.spec_status === 'ready' && (
        <div className="flex gap-2 pt-3 border-t border-border">
          <Input placeholder="Feedback for re-spec..." value={respecComment} onChange={e => setRespecComment(e.target.value)} className="text-sm" />
          <Button size="sm" variant="outline" onClick={() => {
            generateSpec.mutate(
              { id: card.id, comment: respecComment || undefined },
              { onSuccess: () => { setRespecComment(''); toast.success('Re-spec started') }, onError: (e: Error) => toast.error(e.message) },
            )
          }}>
            Re-spec
          </Button>
        </div>
      )}
    </div>
  )
}

function PlanTab({ card, plan, approvePlan, rejectPlan, rejectFeedback, setRejectFeedback }: {
  card: CardDetailType; plan: ImplementationPlan | null
  approvePlan: { mutate: Function }; rejectPlan: { mutate: Function }
  rejectFeedback: string; setRejectFeedback: (v: string) => void
}) {
  if (!plan) {
    return (
      <div className="text-center py-16 text-muted-foreground text-sm">
        {card.plan_status === 'generating' ? (
          <div className="flex items-center justify-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Generating plan...
          </div>
        ) : (
          <p>No plan yet.</p>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-5 text-sm">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="text-[10px]">Version {plan.version}</Badge>
        <Badge variant="secondary" className="text-[10px]">Scope: {plan.estimated_scope}</Badge>
      </div>

      {plan.files_to_create.length > 0 && (
        <div>
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Files to create</Label>
          <ul className="mt-1.5 space-y-1">
            {plan.files_to_create.map((f, i) => (
              <li key={i} className="flex gap-2 text-xs">
                <code className="text-green-600 dark:text-green-400 shrink-0">{f.path}</code>
                <span className="text-muted-foreground truncate">{f.purpose}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {plan.files_to_modify.length > 0 && (
        <div>
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Files to modify</Label>
          <ul className="mt-1.5 space-y-1">
            {plan.files_to_modify.map((f, i) => (
              <li key={i} className="flex gap-2 text-xs">
                <code className="text-blue-600 dark:text-blue-400 shrink-0">{f.path}</code>
                <span className="text-muted-foreground truncate">{f.changes}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {plan.steps.length > 0 && (
        <div>
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Steps</Label>
          <ol className="mt-1.5 space-y-2">
            {plan.steps.map((s, i) => (
              <li key={i} className="text-xs">
                <span className="font-semibold text-foreground">{s.order}.</span> {s.description}
                {s.files.length > 0 && (
                  <div className="mt-0.5 flex gap-1 flex-wrap">
                    {s.files.map((f, fi) => (
                      <code key={fi} className="text-[10px] bg-muted px-1 py-0.5 rounded">{f}</code>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}

      {plan.feedback && (
        <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-3 text-xs">
          <span className="font-medium">Feedback:</span> {plan.feedback}
        </div>
      )}

      {card.plan_status === 'ready' && (
        <div className="flex gap-2 pt-3 border-t border-border">
          <Button size="sm" onClick={() => approvePlan.mutate(card.id, { onError: (e: Error) => toast.error(e.message) })}>
            <Check className="h-3 w-3 mr-1" /> Approve Plan
          </Button>
          <Input placeholder="Rejection feedback..." value={rejectFeedback} onChange={e => setRejectFeedback(e.target.value)} className="text-xs flex-1" />
          <Button size="sm" variant="outline" onClick={() => {
            rejectPlan.mutate(
              { id: card.id, feedback: rejectFeedback || undefined },
              { onSuccess: () => { setRejectFeedback(''); toast.success('Plan rejected') }, onError: (e: Error) => toast.error(e.message) },
            )
          }}>
            Reject
          </Button>
        </div>
      )}
    </div>
  )
}

function NotesTab({ card, newNote, setNewNote, addNote }: {
  card: CardDetailType; newNote: string; setNewNote: (v: string) => void; addNote: { mutate: Function }
}) {
  function send() {
    if (!newNote.trim()) return
    addNote.mutate({ cardId: card.id, content: newNote.trim() }, { onSuccess: () => setNewNote('') })
  }

  return (
    <div className="space-y-3">
      {card.notes.length === 0 && (
        <p className="text-center py-12 text-muted-foreground text-sm">No notes yet.</p>
      )}
      {card.notes.map((note: Note) => (
        <div key={note.id} className="flex gap-2.5">
          <div className={`h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
            note.source === 'agent'
              ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
              : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
          }`}>
            {note.source === 'agent' ? 'A' : 'U'}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm whitespace-pre-wrap break-words">{note.content}</p>
            <span className="text-[10px] text-muted-foreground">
              {new Date(note.created_at).toLocaleTimeString()}
              {note.type !== 'note' && ` · ${note.type.replace(/_/g, ' ')}`}
            </span>
          </div>
        </div>
      ))}

      <div className="flex gap-2 pt-3 border-t border-border">
        <Input placeholder="Add a note..." value={newNote} onChange={e => setNewNote(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') send() }} className="text-sm" />
        <Button size="sm" variant="outline" disabled={!newNote.trim()} onClick={send}>Send</Button>
      </div>
    </div>
  )
}

function SubtasksTab({ card, newSubtask, setNewSubtask, addSubtask, toggleSubtask }: {
  card: CardDetailType; newSubtask: string; setNewSubtask: (v: string) => void
  addSubtask: { mutate: Function }; toggleSubtask: { mutate: Function }
}) {
  function add() {
    if (!newSubtask.trim()) return
    addSubtask.mutate({ cardId: card.id, text: newSubtask.trim() }, { onSuccess: () => setNewSubtask('') })
  }

  return (
    <div className="space-y-1">
      {card.subtasks.length === 0 && (
        <p className="text-center py-12 text-muted-foreground text-sm">No subtasks yet.</p>
      )}
      {card.subtasks.map((st: Subtask) => (
        <label key={st.id} className="flex items-center gap-2.5 text-sm cursor-pointer hover:bg-muted/30 rounded-md px-2 py-1.5">
          <input type="checkbox" checked={st.completed} onChange={() => toggleSubtask.mutate(st.id)} className="rounded" />
          <span className={st.completed ? 'line-through text-muted-foreground' : ''}>{st.text}</span>
        </label>
      ))}

      <div className="flex gap-2 pt-3 border-t border-border mt-2">
        <Input placeholder="Add subtask..." value={newSubtask} onChange={e => setNewSubtask(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') add() }} className="text-sm" />
        <Button size="sm" variant="outline" disabled={!newSubtask.trim()} onClick={add}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}

function InfoTab({ card }: { card: CardDetailType }) {
  return (
    <div className="space-y-4 text-sm">
      {card.git && (
        <div>
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Git</Label>
          <div className="flex items-center gap-2 mt-1">
            <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{card.git.branch}</code>
            {card.git.dirty && <Badge variant="outline" className="text-[10px]">dirty</Badge>}
            {card.git.ahead > 0 && <Badge variant="secondary" className="text-[10px]">+{card.git.ahead}</Badge>}
          </div>
        </div>
      )}

      {card.pr_url && (
        <div>
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Pull Request</Label>
          <a href={card.pr_url} target="_blank" rel="noopener noreferrer"
            className="text-xs text-primary underline inline-flex items-center gap-1 mt-1">
            {card.pr_url} <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}

      {card.worktree_path && (
        <div>
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Worktree</Label>
          <code className="text-xs text-muted-foreground block mt-1">{card.worktree_path}</code>
        </div>
      )}

      {card.claude_session_id && (
        <div>
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Session</Label>
          <code className="text-xs text-muted-foreground block mt-1">{card.claude_session_id}</code>
        </div>
      )}

      {card.chain_id != null && (
        <div>
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Chain</Label>
          <div className="flex items-center gap-2 mt-1">
            <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs">Chain #{card.chain_id}</span>
            {card.chain_position != null && (
              <Badge variant="secondary" className="text-[10px]">Position {card.chain_position + 1}</Badge>
            )}
          </div>
        </div>
      )}

      {card.blockers.length > 0 && (
        <div>
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Blocked by</Label>
          <ul className="space-y-0.5 mt-1">
            {card.blockers.map(b => (
              <li key={b.id} className="text-xs text-muted-foreground">#{b.id} {b.title}</li>
            ))}
          </ul>
        </div>
      )}

      {card.dependents.length > 0 && (
        <div>
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Blocks</Label>
          <ul className="space-y-0.5 mt-1">
            {card.dependents.map(d => (
              <li key={d.id} className="text-xs text-muted-foreground">#{d.id} {d.title}</li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <Label className="text-xs text-muted-foreground uppercase tracking-wide">Created</Label>
        <span className="text-xs text-muted-foreground block mt-1">{new Date(card.created_at).toLocaleString()}</span>
      </div>
    </div>
  )
}

function ChainTab({ card, boardId }: { card: CardDetailType; boardId: number }) {
  const { data: chainData, isLoading } = useChain(card.chain_id)
  const { data: boardData } = useBoard(boardId)
  const reorderChain = useReorderChain()
  const removeFromChain = useRemoveCardFromChain()
  const createChain = useCreateChain()
  const addToChain = useAddCardToChain()
  const [newChainName, setNewChainName] = useState('')
  const [showCreate, setShowCreate] = useState(false)

  if (!card.chain_id) {
    const existingChains = boardData?.chains ?? []

    function handleCreateAndAdd() {
      if (!newChainName.trim()) return
      createChain.mutate({ boardId, name: newChainName.trim() }, {
        onSuccess: (chain) => {
          addToChain.mutate({ chainId: chain.id, cardId: card.id }, {
            onSuccess: () => toast.success(`Created chain "${chain.name}"`),
            onError: (e) => toast.error(e.message),
          })
          setNewChainName('')
          setShowCreate(false)
        },
        onError: (e) => toast.error(e.message),
      })
    }

    return (
      <div className="max-w-sm mx-auto space-y-4 py-6">
        <div className="text-center text-muted-foreground text-sm">
          <Link2 className="h-6 w-6 mx-auto mb-2 opacity-30" />
          <p className="font-medium text-foreground text-sm">Not in a chain</p>
          <p className="text-xs mt-0.5">Chains sequence cards to share a git worktree.</p>
        </div>

        {/* Existing chains */}
        {existingChains.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wide font-medium">Join existing</p>
            {existingChains.map(ch => (
              <div
                key={ch.id}
                className="flex items-center justify-between px-3 py-2 rounded-md border border-border hover:bg-muted/30 cursor-pointer transition-colors text-sm"
                onClick={() => {
                  addToChain.mutate({ chainId: ch.id, cardId: card.id }, {
                    onSuccess: () => toast.success(`Added to "${ch.name}"`),
                    onError: (e) => toast.error(e.message),
                  })
                }}
              >
                <span className="flex items-center gap-1.5">
                  <Link2 className="h-3 w-3 text-muted-foreground" /> {ch.name}
                </span>
                <Plus className="h-3 w-3 text-muted-foreground" />
              </div>
            ))}
          </div>
        )}

        {/* Create new */}
        {showCreate ? (
          <div className="flex gap-1.5 items-center">
            <Input
              value={newChainName}
              onChange={e => setNewChainName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreateAndAdd()}
              placeholder="Chain name..."
              autoFocus
              className="text-sm h-8"
            />
            <Button size="sm" className="h-8 shrink-0" disabled={!newChainName.trim()} onClick={handleCreateAndAdd}>Create</Button>
            <Button size="sm" variant="ghost" className="h-8 shrink-0" onClick={() => { setShowCreate(false); setNewChainName('') }}>Cancel</Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="w-full" onClick={() => setShowCreate(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" /> New Chain
          </Button>
        )}
      </div>
    )
  }

  if (isLoading || !chainData) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading chain...
      </div>
    )
  }

  const { chain, cards: chainCards } = chainData
  const sortedCards = [...chainCards].sort((a, b) => (a.chain_position ?? 0) - (b.chain_position ?? 0))

  // Detect ordering issues: a card further in the pipeline shouldn't come after one earlier
  const stageOrder: Record<PipelineStage, number> = {
    idea: 0, speccing: 1, spec_ready: 2, planning: 3, plan_review: 4, building: 5, reviewing: 6, done: 7,
  }
  const orderWarnings: string[] = []
  for (let i = 1; i < sortedCards.length; i++) {
    const prevStage = getStageFromCard(sortedCards[i - 1])
    const currStage = getStageFromCard(sortedCards[i])
    if (stageOrder[prevStage] > stageOrder[currStage] + 1) {
      orderWarnings.push(
        `Card ${i} "${sortedCards[i].title.substring(0, 25)}..." is at ${stageLabel(currStage)} but follows a card at ${stageLabel(prevStage)}`,
      )
    }
  }

  // Check if swapping two cards would create an illogical order
  // A card further in the pipeline (building/done) can't come before one earlier (idea/speccing)
  function canSwap(idxA: number, idxB: number): string | null {
    // After swap, the card at the lower index should not be further along than the one at the higher
    const newFirst = idxA < idxB ? sortedCards[idxB] : sortedCards[idxA]
    const newSecond = idxA < idxB ? sortedCards[idxA] : sortedCards[idxB]
    const firstStage = stageOrder[getStageFromCard(newFirst)]
    const secondStage = stageOrder[getStageFromCard(newSecond)]
    if (firstStage > secondStage + 1) {
      return `Can't move "${newFirst.title.substring(0, 30)}" (${stageLabel(getStageFromCard(newFirst))}) before "${newSecond.title.substring(0, 30)}" (${stageLabel(getStageFromCard(newSecond))})`
    }
    return null
  }

  function handleMoveUp(idx: number) {
    if (idx <= 0) return
    const err = canSwap(idx, idx - 1)
    if (err) { toast.error(err); return }
    const newOrder = sortedCards.map(c => c.id)
    ;[newOrder[idx - 1], newOrder[idx]] = [newOrder[idx], newOrder[idx - 1]]
    reorderChain.mutate({ chainId: chain.id, cardIds: newOrder })
  }

  function handleMoveDown(idx: number) {
    if (idx >= sortedCards.length - 1) return
    const err = canSwap(idx, idx + 1)
    if (err) { toast.error(err); return }
    const newOrder = sortedCards.map(c => c.id)
    ;[newOrder[idx], newOrder[idx + 1]] = [newOrder[idx + 1], newOrder[idx]]
    reorderChain.mutate({ chainId: chain.id, cardIds: newOrder })
  }

  function handleRemove(cardId: number) {
    removeFromChain.mutate({ chainId: chain.id, cardId }, {
      onError: (e) => toast.error(e.message),
    })
  }

  // Worktree info from any card in the chain
  const worktreePath = sortedCards.find(c => c.worktree_path)?.worktree_path
  const gitBranch = sortedCards.find(c => c.git_branch)?.git_branch
  // Derive expected worktree from chain name if none exists yet
  // Branch name is derived from the first card's title (matching backend slugifyBranch)
  const firstCardTitle = sortedCards[0]?.title ?? chain.name
  const slug = firstCardTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  const expectedBranch = gitBranch || `feat/${slug || 'task'}`

  return (
    <div className="space-y-4">
      {/* Chain header */}
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold">{chain.name}</h4>
          <p className="text-xs text-muted-foreground mt-0.5">
            {sortedCards.length} card{sortedCards.length !== 1 ? 's' : ''} in sequence
          </p>
        </div>
        <Badge variant="outline" className="text-[10px]">Chain #{chain.id}</Badge>
      </div>

      {/* Git worktree info - always show */}
      <div className="bg-muted/50 rounded-lg p-3 space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Git Worktree</p>
        <div className="flex items-center gap-1.5 text-xs">
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-foreground">{expectedBranch}</code>
          {!gitBranch && <span className="text-muted-foreground/60 italic">(will be created on build)</span>}
        </div>
        {worktreePath && (
          <div className="text-xs text-muted-foreground font-mono pl-5">{worktreePath}</div>
        )}
        <p className="text-[11px] text-muted-foreground/60 pl-5">
          All cards share one worktree. Changes accumulate step by step.
        </p>
      </div>

      {/* Ordering warnings */}
      {orderWarnings.length > 0 && (
        <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-3 space-y-1">
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400 flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" /> Chain order issue
          </p>
          {orderWarnings.map((w, i) => (
            <p key={i} className="text-[11px] text-amber-600 dark:text-amber-500">{w}</p>
          ))}
        </div>
      )}

      {/* Card sequence */}
      <div className="space-y-0">
        {sortedCards.map((c, idx) => {
          const isCurrent = c.id === card.id
          const stage = getStageFromCard(c)
          const color = stageColor(stage)
          const isLast = idx === sortedCards.length - 1

          return (
            <div key={c.id}>
              {/* Card row */}
              <div
                className={`flex items-center gap-3 rounded-lg border p-3 text-sm transition-colors ${
                  isCurrent
                    ? 'border-primary/40 bg-primary/5 ring-1 ring-primary/20'
                    : 'border-border hover:bg-muted/30'
                }`}
              >
                {/* Position */}
                <span className="text-xs text-muted-foreground font-mono w-5 text-center shrink-0 font-semibold">
                  {idx + 1}
                </span>

                {/* Stage dot */}
                <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className={`truncate ${isCurrent ? 'font-medium' : ''}`}>
                    {c.title}
                    {isCurrent && <span className="text-[10px] text-primary ml-1.5">(current)</span>}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-muted-foreground">{stageLabel(stage)}</span>
                    {c.agent_status !== 'idle' && (
                      <span className={`text-[10px] font-medium ${
                        c.agent_status === 'working' ? 'text-blue-500' :
                        c.agent_status === 'completed' ? 'text-green-500' :
                        c.agent_status === 'errored' ? 'text-red-500' :
                        c.agent_status === 'waiting' ? 'text-amber-500' :
                        'text-muted-foreground'
                      }`}>
                        {c.agent_status === 'working' ? '● Working' :
                         c.agent_status === 'completed' ? '✓ Done' :
                         c.agent_status === 'errored' ? '✕ Error' :
                         c.agent_status === 'waiting' ? '◷ Waiting' :
                         c.agent_status}
                      </span>
                    )}
                    {c.model && (
                      <span className="text-[10px] text-muted-foreground font-mono">{c.model}</span>
                    )}
                  </div>
                </div>

                {/* Reorder + remove */}
                <div className="flex items-center gap-0.5 shrink-0">
                  <Button variant="ghost" size="icon" className="h-6 w-6"
                    disabled={idx === 0 || !!canSwap(idx, idx - 1)}
                    onClick={() => handleMoveUp(idx)}>
                    <span className="text-xs">↑</span>
                  </Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6"
                    disabled={isLast || !!canSwap(idx, idx + 1)}
                    onClick={() => handleMoveDown(idx)}>
                    <span className="text-xs">↓</span>
                  </Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive"
                    onClick={() => handleRemove(c.id)}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>

              {/* Connector line between cards */}
              {!isLast && (
                <div className="flex justify-center py-0.5">
                  <div className="w-px h-3 bg-border" />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function getStageFromCard(c: import('../types').Card): PipelineStage {
  if (c.agent_status === 'completed') return 'done'
  if (c.spec_status === 'approved') {
    if (c.plan_status === 'approved') return 'building'
    if (c.plan_status === 'ready') return 'plan_review'
    if (c.plan_status === 'generating') return 'planning'
    return 'planning'
  }
  if (c.spec_status === 'ready') return 'spec_ready'
  if (c.spec_status === 'generating') return 'speccing'
  return 'idea'
}

function getUniqueModels(models: import('../types').ModelInfo[] | null): { value: string; label: string }[] {
  const defaults = [
    { value: 'opus', label: 'Opus' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'haiku', label: 'Haiku' },
  ]
  if (!models || models.length === 0) return defaults

  // Deduplicate by alias, show short name
  const seen = new Set<string>()
  const result: { value: string; label: string }[] = []
  for (const m of models) {
    const key = m.alias || m.id
    if (seen.has(key)) continue
    seen.add(key)
    const name = key.charAt(0).toUpperCase() + key.slice(1)
    result.push({ value: key, label: name })
  }
  return result.length > 0 ? result : defaults
}

function getStage(card: CardDetailType): PipelineStage {
  if (card.agent_status === 'completed') return 'done'
  // Plan stages only valid if spec is approved
  if (card.spec_status === 'approved') {
    if (card.plan_status === 'approved') return 'building'
    if (card.plan_status === 'ready') return 'plan_review'
    if (card.plan_status === 'generating') return 'planning'
    return 'planning'
  }
  if (card.spec_status === 'ready') return 'spec_ready'
  if (card.spec_status === 'generating') return 'speccing'
  return 'idea'
}
