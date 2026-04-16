import { useEffect, useCallback } from 'react'
import { useAppStore } from '../store'
import type { Card, Column } from '../types'

interface UseKeyboardShortcutsOptions {
  columns: Column[]
  cardsByColumn: Map<number, Card[]>
  onGenerateSpec: (id: number) => void
  onApprove: (id: number) => void
  onDelete: (id: number) => void
  onRetry: (id: number) => void
}

export function useKeyboardShortcuts({
  columns,
  cardsByColumn,
  onGenerateSpec,
  onApprove,
  onDelete,
  onRetry,
}: UseKeyboardShortcutsOptions) {
  const {
    selectedCardId,
    setSelectedCardId,
    detailCardId,
    openCardDetail,
    closeCardDetail,
    commandPaletteOpen,
    setCommandPaletteOpen,
    setShowHelp,
    showHelp,
  } = useAppStore()

  const getSelectedCard = useCallback((): Card | null => {
    if (!selectedCardId) return null
    for (const cards of cardsByColumn.values()) {
      const card = cards.find(c => c.id === selectedCardId)
      if (card) return card
    }
    return null
  }, [selectedCardId, cardsByColumn])

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      if (isInput) return
      if (commandPaletteOpen) return

      // Cmd+K: command palette
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setCommandPaletteOpen(true)
        return
      }

      // ?: help
      if (e.key === '?') {
        e.preventDefault()
        setShowHelp(!showHelp)
        return
      }

      // Escape: close detail or clear selection
      if (e.key === 'Escape') {
        if (detailCardId) {
          closeCardDetail()
        } else {
          setSelectedCardId(null)
        }
        return
      }

      // Enter: open detail
      if (e.key === 'Enter' && selectedCardId && !detailCardId) {
        e.preventDefault()
        openCardDetail(selectedCardId)
        return
      }

      // Navigation: j/k/ArrowDown/ArrowUp within column, h/l/ArrowLeft/ArrowRight between columns
      if (['j', 'k', 'h', 'l', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault()
        navigate(e.key)
        return
      }

      // Actions on selected card
      const card = getSelectedCard()
      if (!card) return

      if (e.key === 's' || e.key === 'S') {
        if (card.agent_status === 'idle' && card.spec_status === 'pending') onGenerateSpec(card.id)
      } else if (e.key === 'a' || e.key === 'A') {
        if (card.spec_status === 'ready') onApprove(card.id)
      } else if (e.key === 'd' || e.key === 'D') {
        onDelete(card.id)
      } else if (e.key === 'r' || e.key === 'R') {
        if (card.agent_status === 'errored') onRetry(card.id)
      }
    }

    function navigate(key: string) {
      const sortedColumns = [...columns].sort((a, b) => a.position - b.position)
      if (sortedColumns.length === 0) return

      // Find current column/card index
      let currentColIdx = -1
      let currentCardIdx = -1

      if (selectedCardId) {
        for (let ci = 0; ci < sortedColumns.length; ci++) {
          const cards = cardsByColumn.get(sortedColumns[ci].id) ?? []
          const cardIdx = cards.findIndex(c => c.id === selectedCardId)
          if (cardIdx >= 0) {
            currentColIdx = ci
            currentCardIdx = cardIdx
            break
          }
        }
      }

      if (currentColIdx === -1) {
        // No selection - select first card in first non-empty column
        for (const col of sortedColumns) {
          const cards = cardsByColumn.get(col.id) ?? []
          if (cards.length > 0) {
            setSelectedCardId(cards[0].id)
            return
          }
        }
        return
      }

      const isDown = key === 'j' || key === 'ArrowDown'
      const isUp = key === 'k' || key === 'ArrowUp'
      const isLeft = key === 'h' || key === 'ArrowLeft'
      const isRight = key === 'l' || key === 'ArrowRight'

      if (isDown || isUp) {
        const cards = cardsByColumn.get(sortedColumns[currentColIdx].id) ?? []
        const nextIdx = isDown
          ? Math.min(currentCardIdx + 1, cards.length - 1)
          : Math.max(currentCardIdx - 1, 0)
        setSelectedCardId(cards[nextIdx].id)
      } else if (isLeft || isRight) {
        const nextColIdx = isRight
          ? Math.min(currentColIdx + 1, sortedColumns.length - 1)
          : Math.max(currentColIdx - 1, 0)
        const cards = cardsByColumn.get(sortedColumns[nextColIdx].id) ?? []
        if (cards.length > 0) {
          const idx = Math.min(currentCardIdx, cards.length - 1)
          setSelectedCardId(cards[idx].id)
        }
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [
    columns, cardsByColumn, selectedCardId, detailCardId, commandPaletteOpen, showHelp,
    setSelectedCardId, openCardDetail, closeCardDetail, setCommandPaletteOpen, setShowHelp,
    getSelectedCard, onGenerateSpec, onApprove, onDelete, onRetry,
  ])
}
