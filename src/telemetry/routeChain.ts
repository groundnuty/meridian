/**
 * Fold priority-dispatch hops back into one row per client request.
 *
 * Priority routing serves one client request by re-entering the proxy once
 * per candidate account, so a failover already produces several telemetry
 * rows — one per attempt — that share a `routeGroupId`. Nothing correlates
 * them at write time on purpose: the request path may not spend a cycle on
 * anything the dashboard wants. The join happens HERE, on the read path,
 * when somebody actually asks for the data.
 *
 * Pure — no I/O, no store access, no clock.
 */

import type { RequestMetric, RouteHop, RouteKind } from "./types"

/** Ascending attempt order; timestamp breaks ties (hops can land in the
 *  same millisecond when an account rejects instantly). */
function byAttempt(a: RequestMetric, b: RequestMetric): number {
  return (a.routeAttempt ?? 0) - (b.routeAttempt ?? 0) || a.timestamp - b.timestamp
}

function toHop(metric: RequestMetric): RouteHop {
  return {
    profileId: metric.profileId ?? "default",
    ok: metric.error === null && metric.status < 400,
    status: metric.status,
    error: metric.error,
    ...(metric.routeRefusedBucket ? { refusedBucket: metric.routeRefusedBucket } : {}),
  }
}

/**
 * The kind a collapsed row carries, given the kind its hops recorded.
 *
 * The `-hop` suffix goes because the collapsed thing is a client request, not
 * an attempt. WHICH mode dispatched it must survive that: `priority` drained
 * the pool in configured order, `active+priority` put the selected account at
 * its head, and those are different answers to "why this account".
 */
function collapsedRouteKind(hopKind: RouteKind | undefined): RouteKind {
  return hopKind === "active+priority-hop" ? "active+priority" : "priority"
}

/**
 * Collapse each `routeGroupId` group down to the hop that answered the
 * client — the last one attempted, whether it succeeded or the pool ran
 * out — carrying the whole chain on it.
 *
 * @param metrics Newest first, as every ITelemetryStore.getRecent returns.
 *                Output keeps that order and the group's newest position.
 */
export function collapseRouteChains(metrics: RequestMetric[]): RequestMetric[] {
  const groups = new Map<string, RequestMetric[]>()
  for (const metric of metrics) {
    if (!metric.routeGroupId) continue
    const existing = groups.get(metric.routeGroupId)
    if (existing) existing.push(metric)
    else groups.set(metric.routeGroupId, [metric])
  }
  if (groups.size === 0) return metrics

  const emitted = new Set<string>()
  const out: RequestMetric[] = []
  for (const metric of metrics) {
    const groupId = metric.routeGroupId
    if (!groupId) {
      out.push(metric)
      continue
    }
    if (emitted.has(groupId)) continue
    emitted.add(groupId)
    out.push(collapseGroup(groups.get(groupId)!))
  }
  return out
}

/**
 * One group -> one row. The answering hop keeps its own identity (request
 * id, timings, tokens, status) because that IS what the client got; the
 * failed attempts survive only as chain entries, and the row is relabelled
 * `priority` since the collapsed thing is a client request, not a hop.
 *
 * A group may be partial when older hops have already aged out of the ring
 * buffer or fallen outside the `since` window. The chain then shows what is
 * still known rather than nothing.
 */
function collapseGroup(hops: RequestMetric[]): RequestMetric {
  const ordered = hops.length > 1 ? [...hops].sort(byAttempt) : hops
  const answering = ordered[ordered.length - 1]!
  return {
    ...answering,
    routeKind: collapsedRouteKind(answering.routeKind),
    routeChain: ordered.map(toHop),
  }
}
