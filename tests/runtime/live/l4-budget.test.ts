// Unit coverage for L4 budget accounting. No model call, no network.

import { expect, test } from "bun:test"
import { BudgetTracker, extractUsageCostUsd, readSessionSpend, runBudgetedTurn, runBudgetedTurns } from "./l4-budget"

test("a $0.01 cap records the first turn and prevents the second prompt", async () => {
  const tracker = new BudgetTracker(0.01)
  const prompts: string[] = []
  const turns = [
    async () => {
      prompts.push("first")
      return { usage: { cost: 0.01 } }
    },
    async () => {
      prompts.push("second")
      return { usage: { cost: 0.01 } }
    },
  ]

  const run = await runBudgetedTurns(tracker, turns)

  expect(prompts).toEqual(["first"])
  expect(run.results.length).toBe(1)
  expect(run.stopped).toBe(true)
  expect(tracker.spentUsd).toBeCloseTo(0.01, 8)
})

test("an over-cap turn records the spend and fails before another prompt", async () => {
  const tracker = new BudgetTracker(0.01)
  const prompts: string[] = []

  await expect(
    runBudgetedTurn(tracker, async () => {
      prompts.push("first")
      return { info: { cost: 0.02 } }
    }),
  ).rejects.toThrow(/budget cap exceeded/i)

  expect(prompts).toEqual(["first"])
  expect(tracker.spentUsd).toBeCloseTo(0.02, 8)
  expect(tracker.canStartTurn()).toBe(false)
  await expect(
    runBudgetedTurn(tracker, async () => {
      prompts.push("second")
      return { usage: { cost: 0 } }
    }),
  ).rejects.toThrow(/cap reached before prompt/i)
  expect(prompts).toEqual(["first"])
})

test("usage cost extraction reads nested response shapes", () => {
  expect(extractUsageCostUsd({ usage: { cost: 0.004 } })).toBeCloseTo(0.004, 8)
  expect(extractUsageCostUsd({ info: { cost: 0.005 } })).toBeCloseTo(0.005, 8)
  expect(extractUsageCostUsd({ data: { message: { cost: 0.006 } } })).toBeCloseTo(0.006, 8)
  expect(extractUsageCostUsd({ usage: { inputTokens: 10 } })).toBe(0)
  expect(extractUsageCostUsd(undefined)).toBe(0)
})

test("session spend sums new assistant message costs once", async () => {
  const seen = new Set<string>()
  const client = {
    message: {
      list: async (input: any) => {
        expect(input.sessionID).toBe("ses_l4")
        expect(input.type).toBe("assistant")
        return {
          data: [
            { id: "m1", type: "assistant", cost: 0.003 },
            { id: "m2", type: "assistant", cost: 0.004 },
            { id: "u1", type: "user" },
          ],
        }
      },
    },
  }
  expect(await readSessionSpend(client, "ses_l4", seen)).toBeCloseTo(0.007, 8)
  expect(await readSessionSpend(client, "ses_l4", seen)).toBe(0)
})
