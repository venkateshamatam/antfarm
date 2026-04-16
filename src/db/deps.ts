// Dependency management for Antfarm cards
// Handles cycle detection, dependency resolution, and blocker queries

import type { DatabaseInstance } from './schema.js';
import type { Card } from '../types.js';

// Checks whether adding an edge (cardId -> dependsOnCardId) would create a cycle.
// Uses iterative DFS starting from dependsOnCardId, following existing dependency
// edges forward. If the traversal reaches cardId, a cycle would be formed.
export function hasCycle(db: DatabaseInstance, cardId: number, dependsOnCardId: number): boolean {
  // A card depending on itself is always a cycle
  if (cardId === dependsOnCardId) {
    return true;
  }

  // Traverse forward from dependsOnCardId through the dependency graph.
  // If we can reach cardId, then adding cardId -> dependsOnCardId creates a cycle.
  const getDeps = db.prepare('SELECT depends_on_card_id FROM card_deps WHERE card_id = ?');

  const visited = new Set<number>();
  const stack: number[] = [dependsOnCardId];

  while (stack.length > 0) {
    const current = stack.pop()!;

    if (current === cardId) {
      return true;
    }

    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    // Follow edges: current depends on X, so walk to X
    const deps = getDeps.all(current) as { depends_on_card_id: number }[];
    for (const dep of deps) {
      if (!visited.has(dep.depends_on_card_id)) {
        stack.push(dep.depends_on_card_id);
      }
    }
  }

  return false;
}

// After a card is completed, checks all cards that depended on it.
// If a dependent card has ALL its dependencies completed or archived,
// sets its status to idle so it can proceed. Keeps the card in its
// current column rather than moving it.
// Returns the list of card IDs that were unblocked.
export function resolveCompletedDeps(db: DatabaseInstance, completedCardId: number): number[] {
  // Find all cards that depend on the completed card
  const dependents = db.prepare(
    'SELECT card_id FROM card_deps WHERE depends_on_card_id = ?'
  ).all(completedCardId) as { card_id: number }[];

  if (dependents.length === 0) {
    return [];
  }

  // For each dependent, check if ALL its blockers are now completed or archived
  const getBlockerCount = db.prepare(`
    SELECT COUNT(*) as count
    FROM card_deps cd
    JOIN cards c ON c.id = cd.depends_on_card_id
    WHERE cd.card_id = ?
      AND c.agent_status != 'completed'
      AND c.archived = 0
  `);

  // Set card to idle status, keeping it in its current column
  const updateCard = db.prepare(`
    UPDATE cards
    SET agent_status = 'idle', updated_at = datetime('now')
    WHERE id = ?
  `);

  const logActivity = db.prepare(`
    INSERT INTO activity_log (card_id, action, actor, details_json)
    VALUES (?, 'card.unblocked', 'agent', ?)
  `);

  const unblockedIds: number[] = [];

  const resolve = db.transaction(() => {
    for (const dep of dependents) {
      const blockerResult = getBlockerCount.get(dep.card_id) as { count: number };

      // Skip if this card still has unresolved blockers
      if (blockerResult.count > 0) {
        continue;
      }

      updateCard.run(dep.card_id);

      const details = JSON.stringify({
        unblocked_by_card_id: completedCardId,
      });
      logActivity.run(dep.card_id, details);

      unblockedIds.push(dep.card_id);
    }
  });

  resolve();

  return unblockedIds;
}

// Returns the list of cards that are blocking the given card
// (dependencies that are not yet completed and not archived)
export function getBlockers(db: DatabaseInstance, cardId: number): Card[] {
  const rows = db.prepare(`
    SELECT c.*
    FROM card_deps cd
    JOIN cards c ON c.id = cd.depends_on_card_id
    WHERE cd.card_id = ?
      AND c.agent_status != 'completed'
      AND c.archived = 0
  `).all(cardId) as Card[];

  return rows;
}

// Returns the list of cards that depend on the given card
// (cards that will be affected when this card is completed)
export function getDependents(db: DatabaseInstance, cardId: number): Card[] {
  const rows = db.prepare(`
    SELECT c.*
    FROM card_deps cd
    JOIN cards c ON c.id = cd.card_id
    WHERE cd.depends_on_card_id = ?
  `).all(cardId) as Card[];

  return rows;
}
