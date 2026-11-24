// opencode-teamwork — run-budget threshold semantics (0.17.2)
//
// The run budget is **advisory outside the massive-proof tournament**. Every
// cost reader reports usage and the Sentinel is expected to stop non-essential
// dispatch, but no standard-run tool (`teamwork_next`, `teamwork_task_update`,
// `teamwork_final_verify`) refuses work when the threshold is reached. The
// tournament is the only topology that enforces it: `teamwork_tournament` and
// `teamwork_next`'s tournament branch halt with `BUDGET_HALTED` and write a
// `PRESENT_PARTIAL` report.
//
// `budgetUsd: 0` is the explicit "no budget" sentinel: usage is reported as 0%
// and no threshold can be reached. It is not the same as a missing
// `budgetUsd` key, which `teamwork_plan` resolves to the default budget.

/** Percentage of a positive budget at which the advisory warning fires and
 *  tournament dispatch halts. One constant so both paths cannot drift. */
export const BUDGET_HALT_PCT = 80

/** Floored usage percentage. A non-positive/absent budget is 0% (unlimited). */
export function budgetPercent(spentUsd: number, budgetUsd: number): number {
  if (!(Number.isFinite(budgetUsd) && budgetUsd > 0)) return 0
  const spent = Number.isFinite(spentUsd) && spentUsd > 0 ? spentUsd : 0
  return Math.floor((spent / budgetUsd) * 100)
}

/** True when a positive budget has reached BUDGET_HALT_PCT. A zero budget is
 *  unlimited and can never reach it. */
export function budgetThresholdReached(spentUsd: number, budgetUsd: number): boolean {
  return Number.isFinite(budgetUsd) && budgetUsd > 0 && budgetPercent(spentUsd, budgetUsd) >= BUDGET_HALT_PCT
}
