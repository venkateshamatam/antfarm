import { useRef, useEffect } from 'react'
import type { Card, Column } from '../types'

function getDoneColumnId(columns: Column[]): number | null {
  const doneCol = columns.find(c => c.name === 'Done')
  return doneCol?.id ?? null
}

async function fireConfetti(originX: number, originY: number) {
  try {
    const confetti = (await import('canvas-confetti')).default
    confetti({
      particleCount: 100,
      spread: 60,
      origin: { x: originX, y: originY },
      colors: ['#22c55e', '#fbbf24', '#ffffff'],
      gravity: 1.2,
      scalar: 0.9,
      ticks: 120,
    })
  } catch {
    // canvas-confetti not available, skip silently
  }
}

function getConfettiOrigin(cardId: number): { x: number; y: number } {
  // Try to find the card element
  const cardEl = document.querySelector(`[data-card-id="${cardId}"]`)
  if (cardEl) {
    const rect = cardEl.getBoundingClientRect()
    return {
      x: rect.left / window.innerWidth + (rect.width / window.innerWidth / 2),
      y: rect.top / window.innerHeight,
    }
  }

  // Fallback: Done column header
  const colEl = document.querySelector('[data-column-stage="done"]')
  if (colEl) {
    const rect = colEl.getBoundingClientRect()
    return {
      x: rect.left / window.innerWidth + (rect.width / window.innerWidth / 2),
      y: rect.top / window.innerHeight + (rect.height / window.innerHeight / 2),
    }
  }

  // Final fallback: center-top of viewport
  return { x: 0.5, y: 0.3 }
}

export function useConfetti(cards: Card[], columns: Column[]) {
  const prevDoneIdsRef = useRef<Set<number> | null>(null)

  useEffect(() => {
    const doneColumnId = getDoneColumnId(columns)
    if (doneColumnId === null) return

    const currentDoneIds = new Set(
      cards.filter(c => c.column_id === doneColumnId && !c.archived).map(c => c.id)
    )

    // First render: seed the set without firing confetti
    if (prevDoneIdsRef.current === null) {
      prevDoneIdsRef.current = currentDoneIds
      return
    }

    // Find newly arrived Done cards
    const newDoneIds: number[] = []
    for (const id of currentDoneIds) {
      if (!prevDoneIdsRef.current.has(id)) {
        newDoneIds.push(id)
      }
    }

    // Update the ref (also removes cards that left Done)
    prevDoneIdsRef.current = currentDoneIds

    // Skip if tab is hidden or no new cards
    if (newDoneIds.length === 0 || document.hidden) return

    // Fire confetti for each new Done card, staggered by 200ms
    const timers = newDoneIds.map((cardId, index) =>
      setTimeout(() => {
        const origin = getConfettiOrigin(cardId)
        fireConfetti(origin.x, origin.y)
      }, index * 200)
    )

    return () => timers.forEach(clearTimeout)
  }, [cards, columns])
}
