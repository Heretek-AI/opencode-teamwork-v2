// L4 budget accounting helpers.
//
// The live suite must stop before starting another model turn once the
// configured USD cap is reached. Keeping the accounting here makes the rule
// testable without a live model (see l4-budget.test.ts).

export interface BudgetTurnResult {
  readonly spentUsd: number
  readonly stopped: boolean
}

/** Read a USD cost from common response/usage shapes (depth-bounded). */
export function extractUsageCostUsd(response: unknown): number {
  const seen = new Set<object>()
  const visit = (value: unknown, depth: number): number => {
    if (value === null || typeof value !== "object" || depth > 4 || seen.has(value)) return 0
    seen.add(value)
    const record = value as Record<string, unknown>
    for (const key of ["cost", "totalCost", "total_cost"]) {
      const n = record[key]
      if (typeof n === "number" && Number.isFinite(n) && n > 0) return n
    }
    for (const key of ["usage", "info", "data", "message", "result", "response"]) {
      const nested = visit(record[key], depth + 1)
      if (nested > 0) return nested
    }
    return 0
  }
  return visit(response, 0)
}

/** Track spend against a hard USD cap. The cap is reached at `spent >= cap`. */
export class BudgetTracker {
  readonly capUsd: number
  spentUsd = 0

  constructor(capUsd: number) {
    if (!Number.isFinite(capUsd) || capUsd <= 0) {
      throw new Error(`Invalid L4 budget cap: ${capUsd}`)
    }
    this.capUsd = capUsd
  }

  /** False once the cap is reached; callers must stop before the next turn. */
  canStartTurn(): boolean {
    return this.spentUsd < this.capUsd
  }

  recordUsd(usd: number): void {
    if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) this.spentUsd += usd
  }

  recordUsage(response: unknown): number {
    const usd = extractUsageCostUsd(response)
    this.recordUsd(usd)
    return usd
  }

  assertWithinCap(): void {
    if (this.spentUsd > this.capUsd) {
      throw new Error(`L4 hard budget cap exceeded: $${this.spentUsd.toFixed(4)} > $${this.capUsd.toFixed(2)}`)
    }
  }
}

/**
 * Sum the cost of assistant messages not seen before. The 2.4.1 prompt call
 * returns the user inbox message, so spend is read back from session messages.
 */
export async function readSessionSpend(
  client: any,
  sessionID: string,
  seenMessageIds: Set<string>,
): Promise<number> {
  const list = client?.message?.list
  if (typeof list !== "function") return 0
  // Newest first so an incremental poll keeps seeing recent turns; the seen
  // set makes the read idempotent across turns.
  const response = await list.call(client.message, {
    sessionID,
    type: "assistant",
    order: "desc",
    limit: 200,
  })
  const messages = Array.isArray(response?.data) ? response.data : []
  let added = 0
  for (const message of messages) {
    if (!message || message.type !== "assistant" || typeof message.id !== "string") continue
    if (seenMessageIds.has(message.id)) continue
    seenMessageIds.add(message.id)
    const cost = Number(message.cost)
    if (Number.isFinite(cost) && cost > 0) added += cost
  }
  return added
}

/**
 * Run one prompt, record its usage (and any session spend read back), then
 * enforce the cap. Refuses to start when the cap has already been reached.
 */
export async function runBudgetedTurn<T>(
  tracker: BudgetTracker,
  run: () => Promise<T>,
  readSpend?: () => Promise<number>,
): Promise<T> {
  if (!tracker.canStartTurn()) {
    throw new Error(`L4 hard budget cap reached before prompt: $${tracker.spentUsd.toFixed(4)} >= $${tracker.capUsd.toFixed(2)}`)
  }
  const result = await run()
  const recorded = tracker.recordUsage(result)
  // The 2.4.1 prompt response carries no cost, so read spend back from the
  // session. Skip the readback when the response itself already reported cost.
  if (readSpend && recorded === 0) tracker.recordUsd(await readSpend())
  tracker.assertWithinCap()
  return result
}

/** Run prompts in order, stopping before the first turn over the cap. */
export async function runBudgetedTurns<T>(
  tracker: BudgetTracker,
  turns: Array<() => Promise<T>>,
  readSpend?: () => Promise<number>,
): Promise<BudgetTurnResult & { results: T[] }> {
  const results: T[] = []
  for (const turn of turns) {
    if (!tracker.canStartTurn()) return { results, spentUsd: tracker.spentUsd, stopped: true }
    results.push(await runBudgetedTurn(tracker, turn, readSpend))
  }
  return { results, spentUsd: tracker.spentUsd, stopped: !tracker.canStartTurn() }
}
