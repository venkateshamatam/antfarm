import {
  Play, Check, RotateCcw, ExternalLink, TerminalSquare,
  GitBranch, Link2, AlertCircle, Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '../store'
import { useGenerateSpec, useApproveCard, useRetryCard } from '../hooks/useBoards'
import { stageColor, type Card, type PipelineStage } from '../types'

interface CardItemProps {
  card: Card
  stage: PipelineStage
  boardId: number
}

export function CardItem({ card, stage, boardId }: CardItemProps) {
  const { selectedCardId, openCardDetail, openTerminal } = useAppStore()
  const generateSpec = useGenerateSpec(boardId)
  const approveCard = useApproveCard(boardId)
  const retryCard = useRetryCard(boardId)

  const isSelected = selectedCardId === card.id
  const color = stageColor(stage)

  return (
    <div
      className={`
        group relative rounded-md border bg-card p-2.5 cursor-pointer outline-none
        transition-all duration-150 hover:shadow-sm hover:border-border/80
        ${isSelected ? 'ring-2 ring-ring shadow-sm' : 'border-border'}
      `}
      tabIndex={-1}
      onClick={() => openCardDetail(card.id)}
    >
      {/* Title */}
      <h4 className="text-[13px] font-medium pr-6 leading-snug line-clamp-2">
        {card.title}
      </h4>

      {/* Status & metadata row */}
      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
        <StatusIndicator status={card.agent_status} color={color} />

        {card.model && (
          <Badge variant="outline" className="text-[10px] h-4 px-1 font-mono">
            {card.model}
          </Badge>
        )}

        {card.chain_id != null && (
          <Badge variant="secondary" className="text-[10px] h-4 px-1">
            <Link2 className="h-2.5 w-2.5 mr-0.5" />chain
          </Badge>
        )}

        {card.auto_pilot && (
          <Badge variant="secondary" className="text-[10px] h-4 px-1 text-amber-500">
            <Zap className="h-2.5 w-2.5 mr-0.5" />auto
          </Badge>
        )}

        {card.git_branch && (
          <Badge variant="outline" className="text-[10px] h-4 px-1 font-mono truncate max-w-[100px]">
            <GitBranch className="h-2.5 w-2.5 mr-0.5 shrink-0" />
            {card.git_branch.replace('feat/', '')}
          </Badge>
        )}

        {card.pr_url && (
          <a
            href={card.pr_url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      {/* Spec preview for spec_ready */}
      {stage === 'spec_ready' && card.spec && (
        <p className="text-xs text-muted-foreground mt-1.5 line-clamp-2">
          {card.spec.slice(0, 120)}
        </p>
      )}

      {/* Hover actions */}
      <div className="absolute right-1.5 top-1.5 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {stage === 'idea' && card.agent_status === 'idle' && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="ghost" size="icon" className="h-6 w-6"
                  onClick={(e) => { e.stopPropagation(); generateSpec.mutate({ id: card.id }, { onError: (err) => toast.error(err.message) }) }}
                />
              }
            >
              <Play className="h-3 w-3" />
            </TooltipTrigger>
            <TooltipContent>Generate spec</TooltipContent>
          </Tooltip>
        )}

        {stage === 'spec_ready' && card.spec_status === 'ready' && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="ghost" size="icon" className="h-6 w-6"
                  onClick={(e) => { e.stopPropagation(); approveCard.mutate(card.id, { onError: (err) => toast.error(err.message) }) }}
                />
              }
            >
              <Check className="h-3 w-3" />
            </TooltipTrigger>
            <TooltipContent>Approve spec</TooltipContent>
          </Tooltip>
        )}

        {card.agent_status === 'errored' && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="ghost" size="icon" className="h-6 w-6"
                  onClick={(e) => { e.stopPropagation(); retryCard.mutate(card.id, { onError: (err) => toast.error(err.message) }) }}
                />
              }
            >
              <RotateCcw className="h-3 w-3" />
            </TooltipTrigger>
            <TooltipContent>Retry</TooltipContent>
          </Tooltip>
        )}

        {(card.agent_status === 'working' || card.claude_session_id) && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="ghost" size="icon" className="h-6 w-6"
                  onClick={(e) => { e.stopPropagation(); openTerminal(card.id) }}
                />
              }
            >
              <TerminalSquare className="h-3 w-3" />
            </TooltipTrigger>
            <TooltipContent>Terminal</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
}

function StatusIndicator({ status, color }: { status: Card['agent_status']; color: string }) {
  switch (status) {
    case 'working':
      return (
        <span className="flex items-center gap-1 text-blue-500" aria-label="Agent working">
          <span className="typing-dot" />
          <span className="typing-dot" style={{ animationDelay: '0.2s' }} />
          <span className="typing-dot" style={{ animationDelay: '0.4s' }} />
        </span>
      )
    case 'waiting':
      return (
        <span className="flex items-center gap-1 text-[10px] text-amber-500">
          <AlertCircle className="h-3 w-3" /> Waiting
        </span>
      )
    case 'errored':
      return (
        <span className="flex items-center gap-1 text-[10px] text-red-500">
          <AlertCircle className="h-3 w-3" /> Error
        </span>
      )
    case 'completed':
      return (
        <span className="flex items-center gap-1 text-[10px] text-green-500">
          <Check className="h-3 w-3" /> Done
        </span>
      )
    default:
      return (
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
        </span>
      )
  }
}
