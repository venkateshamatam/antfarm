export type AgentStatus = 'idle' | 'working' | 'waiting' | 'errored' | 'completed'
export type SpecStatus = 'pending' | 'generating' | 'ready' | 'approved'
export type PlanStatus = 'none' | 'generating' | 'ready' | 'approved' | 'failed'
export type PipelineStage = 'idea' | 'speccing' | 'spec_ready' | 'planning' | 'plan_review' | 'building' | 'reviewing' | 'done'
export type NoteSource = 'user' | 'agent'
export type NoteType = 'note' | 'output' | 'status_change' | 'human_review_request'
export type SpecTemplateType = 'general' | 'api_endpoint' | 'ui_component' | 'refactor' | 'bugfix'

export const SPEC_TEMPLATES: { value: SpecTemplateType; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'api_endpoint', label: 'API Endpoint' },
  { value: 'ui_component', label: 'UI Component' },
  { value: 'refactor', label: 'Refactor' },
  { value: 'bugfix', label: 'Bug Fix' },
]

export const PIPELINE_STAGES: { stage: PipelineStage; label: string; color: string }[] = [
  { stage: 'idea', label: 'Idea', color: '#6b7280' },
  { stage: 'speccing', label: 'Speccing', color: '#6366f1' },
  { stage: 'spec_ready', label: 'Spec Ready', color: '#8b5cf6' },
  { stage: 'planning', label: 'Planning', color: '#a855f7' },
  { stage: 'plan_review', label: 'Plan Review', color: '#d946ef' },
  { stage: 'building', label: 'Building', color: '#3b82f6' },
  { stage: 'reviewing', label: 'Reviewing', color: '#f97316' },
  { stage: 'done', label: 'Done', color: '#22c55e' },
]

export function stageColor(stage: PipelineStage): string {
  return PIPELINE_STAGES.find(s => s.stage === stage)?.color ?? '#6b7280'
}

export function stageLabel(stage: PipelineStage): string {
  return PIPELINE_STAGES.find(s => s.stage === stage)?.label ?? stage
}

export function parseTemplateType(context: string | null): SpecTemplateType {
  if (!context) return 'general'
  const match = context.match(/^\[template:(\w+)\]/)
  return (match?.[1] as SpecTemplateType) ?? 'general'
}

export interface Board {
  id: number
  name: string
  directory: string | null
  max_concurrency: number
  default_model: string
  created_at: string
  updated_at: string
}

export interface Column {
  id: number
  board_id: number
  name: string
  position: number
  color: string | null
}

export interface Card {
  id: number
  column_id: number
  title: string
  description: string | null
  context: string | null
  files: string | null
  directory_path: string | null
  git_branch: string | null
  agent_status: AgentStatus
  assigned_session: string | null
  last_activity_at: string | null
  archived: boolean
  created_at: string
  updated_at: string
  position: number
  spec: string | null
  spec_status: SpecStatus
  plan_status: PlanStatus
  pr_url: string | null
  pr_branch: string | null
  worktree_path: string | null
  claude_session_id: string | null
  chain_id: number | null
  chain_position: number | null
  model: string | null
  // Joined fields from getAllBoardCards
  column_name?: string
  column_position?: number
}

export interface Chain {
  id: number
  board_id: number
  name: string
  created_at: string
}

export interface Subtask {
  id: number
  card_id: number
  text: string
  completed: boolean
  position: number
}

export interface Note {
  id: number
  card_id: number
  content: string
  source: NoteSource
  type: NoteType
  created_at: string
}

export interface GitInfo {
  branch: string
  dirty: boolean
  ahead: number
  behind: number
}

export interface CardDetail extends Card {
  subtasks: Subtask[]
  notes: Note[]
  blockers: Card[]
  dependents: Card[]
  git: GitInfo | null
}

export interface BoardDetail {
  board: Board
  columns: Column[]
  cards: Card[]
  chains: Chain[]
}

export interface ImplementationPlan {
  id: number
  card_id: number
  version: number
  files_to_create: { path: string; purpose: string }[]
  files_to_modify: { path: string; changes: string }[]
  steps: { order: number; description: string; files: string[] }[]
  estimated_scope: 'small' | 'medium' | 'large'
  dependencies: string[]
  feedback: string | null
  created_at: string
}

export interface PoolStatus {
  active: number
  queued: number
  max: number
}

export interface ModelInfo {
  id: string
  alias: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}
