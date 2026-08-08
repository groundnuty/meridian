/**
 * Pure helpers for reordering profiles on the Profiles page.
 *
 * The order itself already has a home: `PUT /settings/api/routing` persists
 * it as the `profileOrder` setting, and `resolvePriorityOrder()` in
 * src/proxy/routing.ts is what consumes it. These helpers only compute the
 * *next* order from a drag or a keyboard move, and apply a saved order to a
 * list of profiles for display.
 *
 * Mirrored by the inline browser script in profilePage.ts — the same house
 * pattern profileUsage.ts uses, and for the same reason: the page is one
 * template literal that runs in the browser, so it cannot import at runtime.
 * These TS versions are the tested source of truth (profile-order.test.ts).
 */

/**
 * Move the item at `from` to index `to`, returning a new array.
 *
 * Out-of-range indices (and a no-op move) return an unchanged copy rather
 * than throwing — the caller is a drag handler, and a drop outside the list
 * must not corrupt the order.
 */
export function moveInOrder<T>(order: readonly T[], from: number, to: number): T[] {
  const next = order.slice()
  if (from < 0 || from >= next.length) return next
  if (to < 0 || to >= next.length) return next
  if (from === to) return next
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved as T)
  return next
}

/**
 * Sort `items` by the id sequence in `order`.
 *
 * Ids in `order` come first, in that order. Anything not listed keeps its
 * original relative position at the end — a profile added since the order
 * was saved must still render, and it must render somewhere predictable.
 * This mirrors resolvePriorityOrder()'s "unlisted profiles appended in
 * config order" rule so the page and the router agree on what the order is.
 */
export function sortByOrder<T extends { id: string }>(items: readonly T[], order: readonly string[]): T[] {
  const rank = new Map<string, number>()
  for (let i = 0; i < order.length; i++) {
    if (!rank.has(order[i]!)) rank.set(order[i]!, i)
  }
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const ra = rank.get(a.item.id) ?? Number.MAX_SAFE_INTEGER
      const rb = rank.get(b.item.id) ?? Number.MAX_SAFE_INTEGER
      if (ra !== rb) return ra - rb
      return a.index - b.index
    })
    .map((entry) => entry.item)
}
