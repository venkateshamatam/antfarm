import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import type { Card } from '../types'

export function useBoardList() {
  return useQuery({ queryKey: ['boards'], queryFn: api.getBoards })
}

export function useBoard(boardId: number | null) {
  return useQuery({
    queryKey: ['board', boardId],
    queryFn: () => api.getBoard(boardId!),
    enabled: boardId != null,
  })
}

export function useCardDetail(cardId: number | null) {
  return useQuery({
    queryKey: ['card', cardId],
    queryFn: () => api.getCard(cardId!),
    enabled: cardId != null,
    refetchInterval: 5000,
  })
}

export function usePlan(cardId: number | null, enabled: boolean) {
  return useQuery({
    queryKey: ['plan', cardId],
    queryFn: () => api.getPlan(cardId!),
    enabled: cardId != null && enabled,
  })
}

export function usePoolStatus(boardId: number | null) {
  return useQuery({
    queryKey: ['pool', boardId],
    queryFn: () => api.getPoolStatus(boardId!),
    enabled: boardId != null,
    refetchInterval: 5000,
  })
}

export function useModels() {
  return useQuery({
    queryKey: ['models'],
    queryFn: api.getModels,
    staleTime: 60000,
  })
}

// Mutations
export function useCreateBoard() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => api.createBoard(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['boards'] }),
  })
}

export function useCreateCard(boardId: number | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: { column_id: number; title: string; description?: string; context?: string; model?: string }) =>
      api.createCard(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['board', boardId] }),
  })
}

export function useUpdateCard(boardId: number | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...data }: Partial<Card> & { id: number }) => api.updateCard(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['board', boardId] })
      qc.invalidateQueries({ queryKey: ['card'] })
    },
  })
}

export function useDeleteCard(boardId: number | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api.deleteCard(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['board', boardId] }),
  })
}

export function useGenerateSpec(boardId: number | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, comment }: { id: number; comment?: string }) => api.generateSpec(id, comment),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['board', boardId] }),
  })
}

export function useApproveCard(boardId: number | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api.approve(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['board', boardId] }),
  })
}

export function useApprovePlan(boardId: number | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api.approvePlan(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['board', boardId] }),
  })
}

export function useRejectPlan(boardId: number | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, feedback }: { id: number; feedback?: string }) => api.rejectPlan(id, feedback),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['board', boardId] }),
  })
}

export function useRetryCard(boardId: number | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api.retry(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['board', boardId] }),
  })
}

export function useResetCard(boardId: number | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api.reset(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['board', boardId] }),
  })
}

export function useSetDirectory(boardId: number | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (directory: string) => api.setDirectory(boardId!, directory),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['board', boardId] }),
  })
}

export function useUpdateBoardConfig(boardId: number | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (config: { max_concurrency?: number; default_model?: string }) =>
      api.updateBoardConfig(boardId!, config),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['board', boardId] }),
  })
}

export function useSeedTasks(boardId: number | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.seedTasks(boardId!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['board', boardId] }),
  })
}

export function useAddSubtask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ cardId, text }: { cardId: number; text: string }) => api.addSubtask(cardId, text),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['card'] }),
  })
}

export function useToggleSubtask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api.toggleSubtask(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['card'] }),
  })
}

export function useAddNote() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ cardId, content }: { cardId: number; content: string }) => api.addNote(cardId, content),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['card'] }),
  })
}

// Chain hooks
export function useChain(chainId: number | null) {
  return useQuery({
    queryKey: ['chain', chainId],
    queryFn: () => api.getChain(chainId!),
    enabled: chainId != null,
  })
}

export function useReorderChain() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ chainId, cardIds }: { chainId: number; cardIds: number[] }) =>
      api.reorderChain(chainId, cardIds),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['chain'] })
      qc.invalidateQueries({ queryKey: ['board'] })
    },
  })
}

export function useRemoveCardFromChain() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ chainId, cardId }: { chainId: number; cardId: number }) =>
      api.removeCardFromChain(chainId, cardId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['chain'] })
      qc.invalidateQueries({ queryKey: ['board'] })
      qc.invalidateQueries({ queryKey: ['card'] })
    },
  })
}

export function useCreateChain() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ boardId, name }: { boardId: number; name: string }) =>
      api.createChain(boardId, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['chain'] })
      qc.invalidateQueries({ queryKey: ['board'] })
      qc.invalidateQueries({ queryKey: ['card'] })
    },
  })
}

export function useAddCardToChain() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ chainId, cardId }: { chainId: number; cardId: number }) =>
      api.addCardToChain(chainId, cardId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['chain'] })
      qc.invalidateQueries({ queryKey: ['board'] })
      qc.invalidateQueries({ queryKey: ['card'] })
    },
  })
}
