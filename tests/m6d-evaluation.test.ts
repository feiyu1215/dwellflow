import assert from "node:assert/strict"
import test from "node:test"
import type { AiResult } from "../miniprogram/core/ai-contract.ts"
import {
  loadM6dEvaluationDataset,
  scoreM6dResult,
  selectM6dEvaluationCases,
  summarizeM6dEvaluation,
  type M6dEvaluationOutcome
} from "../server/m6d-evaluation.ts"

const datasetPath = new URL("../evaluation/budget.synthetic-text.v1.json", import.meta.url).pathname
  .replace(/^\/(?:([A-Za-z]:))/, "$1")

function completeResult(): AiResult {
  return {
    summary: "提取所选墙砖计划的计算参数",
    observations: [{ text: "计划为 100 片", sourceIds: ["material_tile_complete"] }],
    differences: [],
    unknowns: [],
    suggestions: [],
    budget: {
      goal: "估算墙砖数量",
      scenarios: [{
        scenarioId: "scenario1",
        label: "墙砖计划",
        materialSourceId: "material_tile_complete",
        unit: "片",
        requiredQuantity: {
          value: "100", status: "observed", sourceIds: ["material_tile_complete"], note: "计划量"
        },
        wasteRatePercent: {
          value: "10", status: "observed", sourceIds: ["material_tile_complete"], note: "损耗率"
        },
        requirementIncludesWaste: {
          value: "no", sourceIds: ["material_tile_complete"], note: "损耗单列"
        },
        packageSize: {
          value: "10", status: "observed", sourceIds: ["material_tile_complete"], note: "每箱片数"
        },
        packageUnitPriceYuan: {
          value: "32.5", status: "observed", sourceIds: ["material_tile_complete"], note: "每箱价"
        },
        assumptions: [], conflicts: [], missingFields: []
      }],
      ledgerNotes: [],
      gaps: []
    }
  }
}

test("M6D 评测集覆盖参数完整、价格未知、口径冲突、单位换算和财务分层", () => {
  const dataset = loadM6dEvaluationDataset(datasetPath)
  assert.equal(dataset.task, "budget")
  assert.equal(dataset.cases.length, 6)
  assert.equal(dataset.cases.filter(item => item.split === "development").length, 4)
  assert.equal(dataset.cases.filter(item => item.split === "frozen").length, 2)
  for (const tag of ["missing-price", "conflict", "unit-conversion", "finance", "prompt-injection"]) {
    assert.equal(dataset.cases.some(item => item.tags.includes(tag)), true)
  }
  assert.deepEqual(
    selectM6dEvaluationCases(dataset.cases, { split: "frozen" }).map(item => item.id),
    ["budget_area_without_conversion", "budget_finance_scope_injection"]
  )
})

test("M6D 评分分别检查参数状态、值、来源和禁止行为", () => {
  const dataset = loadM6dEvaluationDataset(datasetPath)
  const expected = dataset.cases.find(item => item.id === "budget_complete_tile")!.expected
  assert.equal(scoreM6dResult(expected, completeResult()).passed, true)

  const computed = structuredClone(completeResult()) as AiResult & { amountFen?: number }
  computed.amountFen = 35_750
  const strictExpected = { ...expected, forbiddenPhrases: ["35750"] }
  assert.equal(scoreM6dResult(strictExpected, computed).passed, false)

  const wrongStatus = structuredClone(completeResult())
  wrongStatus.budget!.scenarios[0].packageUnitPriceYuan.status = "unknown"
  wrongStatus.budget!.scenarios[0].packageUnitPriceYuan.value = ""
  assert.equal(scoreM6dResult(expected, wrongStatus).passed, false)
})

test("M6D 汇总把契约失败和冻结关键案例计入门槛", () => {
  const dataset = loadM6dEvaluationDataset(datasetPath)
  const expected = dataset.cases[0].expected
  const score = scoreM6dResult(expected, completeResult())
  const outcome = (overrides: Partial<M6dEvaluationOutcome>): M6dEvaluationOutcome => ({
    id: "one", title: "case", critical: true, split: "frozen", tags: [],
    contractValid: true, durationMs: 1, promptVersion: "p", contractVersion: "c",
    score,
    ...overrides
  })
  const summary = summarizeM6dEvaluation([
    outcome({}),
    outcome({ id: "two", contractValid: false, score: scoreM6dResult(expected) })
  ], dataset.thresholds)
  assert.equal(summary.contractPassRate, 0.5)
  assert.equal(summary.criticalCasePassRate, 0.5)
  assert.equal(summary.gatePassed, false)
})
