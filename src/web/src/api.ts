import type { Board, BoardDetail, Card, CardDetail, Chain, ImplementationPlan, ModelInfo, Note, PoolStatus, Subtask } from './types'

// auth token for remote access (set via login prompt, stored in localStorage)
export function getAuthToken(): string | null {
  try { return localStorage.getItem('antfarm-token'); } catch { return null; }
}
export function setAuthToken(token: string) {
  try { localStorage.setItem('antfarm-token', token); } catch {}
}
export function clearAuthToken() {
  try { localStorage.removeItem('antfarm-token'); } catch {}
}

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const token = getAuthToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(path, {
    headers,
    ...opts,
  })
  if (!res.ok) {
    let msg: string
    try {
      const data = await res.json()
      msg = data.error ?? res.statusText
    } catch {
      msg = res.statusText
    }
    throw new Error(msg)
  }
  return res.json()
}

export const api = {
  // generic request (for endpoints not yet wrapped)
  request,

  // Boards
  getBoards: () => request<Board[]>('/api/boards'),
  getBoard: (id: number) => request<BoardDetail>(`/api/boards/${id}`),
  createBoard: (name: string) => request<Board>('/api/boards', { method: 'POST', body: JSON.stringify({ name }) }),
  setDirectory: (boardId: number, directory: string) =>
    request<{ success: true }>(`/api/boards/${boardId}/directory`, { method: 'POST', body: JSON.stringify({ directory }) }),
  updateBoardConfig: (boardId: number, config: { max_concurrency?: number; default_model?: string }) =>
    request<{ success: true }>(`/api/boards/${boardId}/config`, { method: 'PATCH', body: JSON.stringify(config) }),
  getPoolStatus: (boardId: number) => request<PoolStatus>(`/api/boards/${boardId}/pool`),
  seedTasks: (boardId: number) => request<{ created: number }>(`/api/boards/${boardId}/seed-tasks`, { method: 'POST' }),

  // Cards
  getCard: (id: number) => request<CardDetail>(`/api/cards/${id}`),
  createCard: (data: { column_id: number; title: string; description?: string; context?: string; model?: string }) =>
    request<Card>('/api/cards', { method: 'POST', body: JSON.stringify(data) }),
  updateCard: (id: number, data: Partial<Card>) =>
    request<Card>(`/api/cards/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteCard: (id: number) => request<{ success: true; unblocked: number[] }>(`/api/cards/${id}`, { method: 'DELETE' }),
  moveCard: (id: number, column_id: number) =>
    request<Card>(`/api/cards/${id}`, { method: 'PATCH', body: JSON.stringify({ column_id }) }),

  // Pipeline actions
  generateSpec: (id: number, comment?: string) =>
    request<{ success: true }>(`/api/cards/${id}/generate-spec`, { method: 'POST', body: JSON.stringify({ comment }) }),
  approve: (id: number) => request<{ success: true }>(`/api/cards/${id}/approve`, { method: 'POST' }),
  retry: (id: number) => request<{ success: true }>(`/api/cards/${id}/retry`, { method: 'POST' }),
  reset: (id: number) => request<{ success: true }>(`/api/cards/${id}/reset`, { method: 'POST' }),
  getPlan: (id: number) => request<ImplementationPlan>(`/api/cards/${id}/plan`),
  approvePlan: (id: number) => request<{ success: true }>(`/api/cards/${id}/plan/approve`, { method: 'POST' }),
  rejectPlan: (id: number, feedback?: string) =>
    request<{ success: true }>(`/api/cards/${id}/plan/reject`, { method: 'POST', body: JSON.stringify({ feedback }) }),

  // Terminal
  openTerminal: (id: number) =>
    request<{ success: true; session_id: string | null }>(`/api/open-terminal/${id}`, { method: 'POST' }),

  // Subtasks
  addSubtask: (cardId: number, text: string) =>
    request<Subtask>(`/api/cards/${cardId}/subtasks`, { method: 'POST', body: JSON.stringify({ text }) }),
  toggleSubtask: (id: number) => request<Subtask>(`/api/subtasks/${id}/toggle`, { method: 'PATCH' }),

  // Notes
  addNote: (cardId: number, content: string, source: 'user' | 'agent' = 'user') =>
    request<Note>(`/api/cards/${cardId}/notes`, { method: 'POST', body: JSON.stringify({ content, source }) }),

  // Chains
  getChain: (id: number) => request<{ chain: Chain; cards: Card[] }>(`/api/chains/${id}`),
  createChain: (boardId: number, name: string) =>
    request<Chain>('/api/chains', { method: 'POST', body: JSON.stringify({ board_id: boardId, name }) }),
  addCardToChain: (chainId: number, cardId: number) =>
    request<{ success: true }>(`/api/chains/${chainId}/cards`, { method: 'POST', body: JSON.stringify({ card_id: cardId }) }),
  removeCardFromChain: (chainId: number, cardId: number) =>
    request<{ success: true }>(`/api/chains/${chainId}/cards/${cardId}`, { method: 'DELETE' }),
  reorderChain: (chainId: number, cardIds: number[]) =>
    request<{ success: true }>(`/api/chains/${chainId}/reorder`, { method: 'PATCH', body: JSON.stringify({ card_ids: cardIds }) }),
  updateChain: (chainId: number, name: string) =>
    request<Chain>(`/api/chains/${chainId}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteChain: (chainId: number) =>
    request<{ success: true }>(`/api/chains/${chainId}`, { method: 'DELETE' }),

  // Directory picker
  pickDirectory: () => request<{ directory: string }>('/api/pick-directory', { method: 'POST' }),

  // Models
  getModels: () =>
    request<{ models: ModelInfo[] }>('/api/claude-stats').then(r => r.models),
}
