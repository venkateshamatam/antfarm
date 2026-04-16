import { useMemo } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useAppStore } from '../store'
import { stageColor, type Card, type Column, type PipelineStage } from '../types'
import { CardItem } from './Card'

interface BoardProps {
  columns: Column[]
  cards: Card[]
  chains?: unknown[]
  boardId: number
}

const STAGE_MAP: Record<string, PipelineStage> = {
  'Idea': 'idea',
  'Speccing': 'speccing',
  'Spec Ready': 'spec_ready',
  'Approved': 'planning',
  'Planning': 'planning',
  'Plan Review': 'plan_review',
  'Building': 'building',
  'Reviewing': 'reviewing',
  'Done': 'done',
}

export function Board({ columns, cards, boardId }: BoardProps) {
  const sortedColumns = useMemo(
    () => [...columns].sort((a, b) => a.position - b.position),
    [columns],
  )

  const cardsByColumn = useMemo(() => {
    const map = new Map<number, Card[]>()
    for (const col of columns) {
      map.set(
        col.id,
        cards
          .filter(c => c.column_id === col.id && !c.archived)
          .sort((a, b) => a.position - b.position),
      )
    }
    return map
  }, [columns, cards])

  return (
    <div className="flex flex-col h-full min-w-max">
      {/* Column headers - single continuous row */}
      <div className="flex border-b border-border shrink-0">
        {sortedColumns.map((col, i) => {
          const colCards = cardsByColumn.get(col.id) ?? []
          const stage = STAGE_MAP[col.name] ?? 'idea'
          const color = stageColor(stage)
          const workingCount = colCards.filter(c => c.agent_status === 'working').length

          return (
            <div
              key={col.id}
              className={`w-[240px] flex items-center gap-2 px-3 py-2 ${
                i < sortedColumns.length - 1 ? 'border-r border-border' : ''
              }`}
            >
              <div className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
              <span className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
                {col.name}
              </span>
              <span className="text-[10px] text-muted-foreground/50 ml-auto">
                {colCards.length}
              </span>
              {workingCount > 0 && (
                <Badge variant="outline" className="text-[10px] h-4 px-1 gap-0.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-blue-500 status-dot-pulse" />
                  {workingCount}
                </Badge>
              )}
              {stage === 'idea' && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5"
                  onClick={() => useAppStore.getState().setShowCreateTask(true)}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              )}
            </div>
          )
        })}
      </div>

      {/* Column bodies */}
      <div className="flex flex-1 min-h-0">
        {sortedColumns.map((col, i) => {
          const colCards = cardsByColumn.get(col.id) ?? []
          const stage = STAGE_MAP[col.name] ?? 'idea'

          return (
            <div
              key={col.id}
              className={`w-[240px] overflow-y-auto ${
                i < sortedColumns.length - 1 ? 'border-r border-border' : ''
              }`}
            >
              <div className="space-y-1.5 p-2">
                {colCards.map(card => (
                  <CardItem
                    key={card.id}
                    card={card}
                    stage={stage}
                    boardId={boardId}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
