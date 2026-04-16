import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { Link2, Cpu, Info, FileText, GitBranch } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { useAppStore } from '../store'
import {
  useCreateCard, useModels, useBoard, useCreateChain, useAddCardToChain, useChain,
} from '../hooks/useBoards'
import { stageColor, stageLabel, type Column, type PipelineStage } from '../types'

interface CreateTaskModalProps {
  boardId: number
  columns: Column[]
}

export function CreateTaskModal({ boardId, columns }: CreateTaskModalProps) {
  const { showCreateTask, setShowCreateTask } = useAppStore()
  const createCard = useCreateCard(boardId)
  const { data: models } = useModels()
  const { data: boardData } = useBoard(boardId)
  const createChain = useCreateChain()
  const addToChain = useAddCardToChain()

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [model, setModel] = useState('')
  const [chainAction, setChainAction] = useState<'none' | 'new' | string>('none')
  const [newChainName, setNewChainName] = useState('')

  const ideaColumn = columns.find(c => c.name === 'Idea')
  const existingChains = boardData?.chains ?? []

  // Get selected chain details
  const selectedChainId = chainAction !== 'none' && chainAction !== 'new' ? parseInt(chainAction, 10) : null
  const { data: selectedChainData } = useChain(selectedChainId)

  useEffect(() => {
    if (showCreateTask) {
      setTitle('')
      setDescription('')
      setModel('')
      setChainAction('none')
      setNewChainName('')
    }
  }, [showCreateTask])

  // Deduplicate models by alias, show full model ID
  const modelOptions = (() => {
    const defaults = [
      { value: 'opus', label: 'claude-opus-4' },
      { value: 'sonnet', label: 'claude-sonnet-4' },
      { value: 'haiku', label: 'claude-haiku-4' },
    ]
    if (!models || models.length === 0) return defaults
    const seen = new Set<string>()
    const result: { value: string; label: string }[] = []
    for (const m of models) {
      const key = m.alias || m.id
      if (seen.has(key)) continue
      seen.add(key)
      result.push({ value: key, label: m.id })
    }
    return result.length > 0 ? result : defaults
  })()

  async function handleSubmit() {
    if (!title.trim() || !description.trim() || !ideaColumn) return

    try {
      const card = await createCard.mutateAsync({
        column_id: ideaColumn.id,
        title: title.trim(),
        description: description.trim(),
        model: model || undefined,
      })

      if (chainAction === 'new' && newChainName.trim()) {
        try {
          const chain = await createChain.mutateAsync({ boardId, name: newChainName.trim() })
          await addToChain.mutateAsync({ chainId: chain.id, cardId: card.id })
        } catch { /* card created, chain failed - non-critical */ }
      } else if (selectedChainId) {
        try {
          await addToChain.mutateAsync({ chainId: selectedChainId, cardId: card.id })
        } catch { /* card created, chain add failed - non-critical */ }
      }

      setShowCreateTask(false)
      toast.success('Task created')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to create task')
    }
  }

  // Chain cards for preview
  const chainCards = selectedChainData?.cards ?? []
  const sortedChainCards = [...chainCards].sort((a, b) => (a.chain_position ?? 0) - (b.chain_position ?? 0))
  const chainWorktree = sortedChainCards.find(c => c.git_branch)?.git_branch
  const firstTitle = sortedChainCards[0]?.title ?? newChainName
  const expectedBranch = chainWorktree || (firstTitle
    ? `feat/${firstTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)}`
    : null)

  return (
    <Dialog open={showCreateTask} onOpenChange={setShowCreateTask}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Create Task</DialogTitle>
          <DialogDescription>
            Added to the Idea column. Generate a spec to start the pipeline.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 max-h-[calc(90vh-10rem)] overflow-y-auto">
          {/* Title */}
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Title <span className="text-destructive">*</span></Label>
            <Input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Add OAuth2 login flow"
              autoFocus
              className="text-base"
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Description <span className="text-destructive">*</span></Label>
            <Textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={"What should be built and why?\n\nInclude:\n- Requirements and acceptance criteria\n- Edge cases to handle\n- Any constraints or dependencies"}
              rows={12}
              className="text-sm resize-y min-h-[200px]"
            />
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>This drives spec generation. Be specific about what you want.</span>
              <span>{description.length} characters</span>
            </div>
          </div>

          <Separator />

          {/* Model + Chain side by side */}
          <div className="grid grid-cols-2 gap-3">
            {/* Model */}
            <div className="space-y-1.5">
              <Label className="text-sm font-medium flex items-center gap-1">
                <Cpu className="h-3 w-3" /> Model
              </Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger className="w-full h-8 text-xs">
                  <SelectValue placeholder={`Default (${boardData?.board?.default_model || 'sonnet'})`} />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map(m => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Chain */}
            <div className="space-y-1.5">
              <Label className="text-sm font-medium flex items-center gap-1">
                <Link2 className="h-3 w-3" /> Chain
              </Label>
              <Select value={chainAction} onValueChange={setChainAction}>
                <SelectTrigger className="w-full h-8 text-xs">
                  <SelectValue>
                    {chainAction === 'none' ? 'None' :
                     chainAction === 'new' ? 'New chain' :
                     existingChains.find(c => String(c.id) === chainAction)?.name ?? chainAction}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="new">+ Create new chain</SelectItem>
                  {existingChains.map(ch => (
                    <SelectItem key={ch.id} value={String(ch.id)}>{ch.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* New chain name input */}
          {chainAction === 'new' && (
            <Input
              value={newChainName}
              onChange={e => setNewChainName(e.target.value)}
              placeholder="Chain name..."
              className="text-sm h-8"
            />
          )}

          {/* Chain preview */}
          {(selectedChainId || (chainAction === 'new' && newChainName)) && (expectedBranch || sortedChainCards.length > 0) && (
            <div className="bg-muted/40 rounded-lg p-3 space-y-2">
              {expectedBranch && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <GitBranch className="h-3 w-3 shrink-0" />
                  <code className="font-mono text-foreground">{expectedBranch}</code>
                  {!chainWorktree && <span className="italic text-[10px]">(created on build)</span>}
                </div>
              )}

              <div className="space-y-1">
                {sortedChainCards.length > 0 && (
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">Cards in chain</p>
                )}
                {sortedChainCards.map((c, i) => {
                  const stage = getStageFromCard(c)
                  return (
                    <div key={c.id} className="flex items-center gap-2 text-xs py-0.5">
                      <span className="text-muted-foreground font-mono w-3 text-right">{i + 1}</span>
                      <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: stageColor(stage) }} />
                      <span className="truncate">{c.title}</span>
                      <span className="text-[10px] text-muted-foreground ml-auto shrink-0">{stageLabel(stage)}</span>
                    </div>
                  )
                })}
                <div className="flex items-center gap-2 text-xs py-0.5 text-primary">
                  <span className="text-muted-foreground font-mono w-3 text-right">{sortedChainCards.length + 1}</span>
                  <span className="h-1.5 w-1.5 rounded-full shrink-0 bg-gray-400" />
                  <span className="truncate italic">{title || 'New task'}</span>
                  <span className="text-[10px] text-muted-foreground ml-auto shrink-0">Idea</span>
                </div>
              </div>
            </div>
          )}

          {/* Context info */}
          {boardData?.board?.directory && (
            <div className="flex items-start gap-2 text-[11px] text-muted-foreground">
              <Info className="h-3 w-3 mt-0.5 shrink-0" />
              <p>
                Agent reads all <code className="bg-muted px-1 rounded">CLAUDE.md</code> files
                in <code className="bg-muted px-1 rounded font-mono">{boardData.board.directory.split('/').slice(-2).join('/')}</code>
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setShowCreateTask(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={!title.trim() || !description.trim()}>
            Create Task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function getStageFromCard(c: { spec_status: string; plan_status: string; agent_status: string }): PipelineStage {
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
