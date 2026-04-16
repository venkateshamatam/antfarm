import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { FolderOpen, Cpu, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { useAppStore } from '../store'
import { useSetDirectory, useUpdateBoardConfig, useModels } from '../hooks/useBoards'
import { api } from '../api'
import type { Board } from '../types'

export function DirectoryModal({ board }: { board: Board }) {
  const { showDirectoryModal, setShowDirectoryModal } = useAppStore()
  const setDirectory = useSetDirectory(board.id)
  const updateConfig = useUpdateBoardConfig(board.id)
  const { data: models } = useModels()

  const [dir, setDir] = useState(board.directory ?? '')
  const [concurrency, setConcurrency] = useState(board.max_concurrency ?? 3)
  const [defaultModel, setDefaultModel] = useState(board.default_model ?? 'sonnet')

  useEffect(() => {
    setDir(board.directory ?? '')
    setConcurrency(board.max_concurrency ?? 3)
    setDefaultModel(board.default_model ?? 'sonnet')
  }, [board])

  // Deduplicate models
  const modelOptions = (() => {
    if (!models || models.length === 0) {
      return [
        { value: 'opus', label: 'claude-opus-4' },
        { value: 'sonnet', label: 'claude-sonnet-4' },
        { value: 'haiku', label: 'claude-haiku-4' },
      ]
    }
    const seen = new Set<string>()
    const result: { value: string; label: string }[] = []
    for (const m of models) {
      const key = m.alias || m.id
      if (seen.has(key)) continue
      seen.add(key)
      result.push({ value: key, label: m.id })
    }
    return result
  })()

  async function handleBrowse() {
    try {
      const result = await api.pickDirectory()
      setDir(result.directory)
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to pick directory')
    }
  }

  function handleSave() {
    let changed = false

    if (dir !== (board.directory ?? '') && dir.trim()) {
      setDirectory.mutate(dir.trim(), { onError: (e) => toast.error(e.message) })
      changed = true
    }

    const configUpdates: { max_concurrency?: number; default_model?: string } = {}
    if (concurrency !== (board.max_concurrency ?? 3)) {
      configUpdates.max_concurrency = concurrency
      changed = true
    }
    if (defaultModel !== (board.default_model ?? 'sonnet')) {
      configUpdates.default_model = defaultModel
      changed = true
    }
    if (Object.keys(configUpdates).length > 0) {
      updateConfig.mutate(configUpdates, { onError: (e) => toast.error(e.message) })
    }

    if (changed) toast.success('Settings saved')
    setShowDirectoryModal(false)
  }

  return (
    <Dialog open={showDirectoryModal} onOpenChange={setShowDirectoryModal}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Board Settings</DialogTitle>
          <DialogDescription>Configure the project directory, default model, and agent concurrency.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Directory */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium flex items-center gap-1">
              <FolderOpen className="h-3 w-3" /> Project Directory
            </Label>
            <div className="flex gap-2">
              <Input
                value={dir}
                onChange={e => setDir(e.target.value)}
                placeholder="/path/to/project"
                className="font-mono text-sm"
              />
              <Button variant="outline" size="sm" onClick={handleBrowse}>Browse</Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Agents run specs and builds relative to this directory.
            </p>
          </div>

          <Separator />

          {/* Default Model + Concurrency side by side */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium flex items-center gap-1">
                <Cpu className="h-3 w-3" /> Default Model
              </Label>
              <Select value={defaultModel} onValueChange={setDefaultModel}>
                <SelectTrigger className="w-full h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map(m => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Used when a card doesn't specify a model.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium flex items-center gap-1">
                <Zap className="h-3 w-3" /> Max Concurrency: <span className="font-mono">{concurrency}</span>
              </Label>
              <input
                type="range"
                min={1}
                max={20}
                value={concurrency}
                onChange={e => setConcurrency(parseInt(e.target.value, 10))}
                className="w-full accent-primary mt-1"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>1</span>
                <span>20</span>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setShowDirectoryModal(false)}>Cancel</Button>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
