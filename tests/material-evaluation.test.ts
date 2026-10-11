import assert from "node:assert/strict"
import test from "node:test"
import type { AiResult } from "../miniprogram/core/ai-contract.ts"
import {
  calculateEvaluationCost,
  loadMaterialEvaluationDataset,
  mergeEvaluationOutcomes,
  modelOutputPreview,
  scoreMaterialResult,
  selectMaterialEvaluationCases,
  summarizeEvaluation,
  type EvaluationCaseOutcome,
  type MaterialEvaluationCase
} from "../server/material-evaluation.ts"

const expected: MaterialEvaluationCase["expected"] = {
  fields: [
    {
      key: "brand",
      statusOneOf: ["differs"],
      observedIncludesAny: ["现场牌"],
      expectedIncludesAny: ["约定牌"],
      observedSourceIdsInclude: ["receipt1"],
      expectedSourceIdsInclude: ["agreement1"]
    },
    { key: "model", statusOneOf: ["unknown"] }
  ]
}

const result: AiResult = {
  summary: "品牌不一致，型号未知",
  observations: [], differences: [], unknowns: ["型号看不清"], suggestions: [],
  materialCheck: {
    materialSourceId: "material1",
    receiptSourceId: "receipt1",
    fields: [
      {
        key: "brand", label: "品牌", observedValue: "现场牌 A", expectedValue: "约定牌 B",
        status: "differs", observedSourceIds: ["receipt1"], expectedSourceIds: ["agreement1"], note: ""
      },
      {
        key: "model", label: "型号", observedValue: "", expectedValue: "", status: "unknown",
        observedSourceIds: [], expectedSourceIds: [], note: "图片模糊"
      }
    ]
  }
}

test("material evaluation scores field values, status and provenance independently", () => {
  const score = scoreMaterialResult(expected, result)
  assert.equal(score.passed, true)
  assert.equal(score.passedAssertions, 8)
  assert.equal(score.totalAssertions, 8)
  const changed = structuredClone(result)
  changed.materialCheck!.fields[0].expectedSourceIds = ["wrong"]
  const failed = scoreMaterialResult(expected, changed)
  assert.equal(failed.passed, false)
  assert.equal(failed.assertions.find(item => item.name === "brand.expectedSourceIds")?.passed, false)
  const preview = modelOutputPreview({ value: "data:image/png;base64,iVBORw0KGgoAAA", note: "保留" })
  assert.doesNotMatch(preview, /iVBOR/)
  assert.match(preview, /redacted-image-data-url/)
})

test("checked-in material text smoke dataset is valid without embedding images", () => {
  const dataset = loadMaterialEvaluationDataset("evaluation/material-check.text-smoke.example.json")
  assert.equal(dataset.cases.length, 3)
  assert.equal(dataset.cases.every(item => item.input.task === "material_check"), true)
  assert.equal(dataset.cases.every(item => item.imageCount === 0), true)
  const vision = loadMaterialEvaluationDataset("evaluation/material-check.synthetic-vision.v1.json")
  assert.equal(vision.cases.length, 7)
  assert.equal(vision.cases.every(item => item.imageCount === 1), true)
  assert.equal(vision.cases.every(item => item.input.images[0].dataUrl.startsWith("data:image/png;base64,")), true)
  assert.deepEqual(
    selectMaterialEvaluationCases(vision.cases, ["vision_prompt_injection", "vision_clear_difference"])
      .map(item => item.id),
    ["vision_prompt_injection", "vision_clear_difference"]
  )
  assert.throws(() => selectMaterialEvaluationCases(vision.cases, ["missing-case"]), /不存在用例/)
})

test("material evaluation gate includes invalid contracts and critical cases", () => {
  const score = scoreMaterialResult(expected, result)
  const outcomes: EvaluationCaseOutcome[] = [
    {
      id: "pass", title: "通过", critical: true, tags: [], imageCount: 1,
      contractValid: true, durationMs: 10, score
    },
    {
      id: "error", title: "失败", critical: false, tags: [], imageCount: 0,
      contractValid: false, durationMs: 5, score: scoreMaterialResult(expected)
    }
  ]
  const summary = summarizeEvaluation(outcomes, {
    contractPassRate: 1,
    assertionPassRate: 0.8,
    criticalCasePassRate: 1
  })
  assert.equal(summary.contractPassRate, 0.5)
  assert.equal(summary.criticalCasePassRate, 1)
  assert.equal(summary.gatePassed, false)
  const corrected = { ...outcomes[1], contractValid: true, score, id: "error" }
  assert.deepEqual(
    mergeEvaluationOutcomes(["pass", "error"], [outcomes, [corrected]]).map(item => item.contractValid),
    [true, true]
  )
  assert.throws(() => mergeEvaluationOutcomes(["pass", "missing"], [[outcomes[0]]]), /缺少用例/)
  assert.throws(() => mergeEvaluationOutcomes(["pass"], [outcomes]), /评测集以外的用例/)
})

test("evaluation cost uses token usage and conservatively prices unclassified input as cache miss", () => {
  const cost = calculateEvaluationCost({
    promptTokens: 1_000_000,
    cacheHitPromptTokens: 200_000,
    cacheMissPromptTokens: 700_000,
    completionTokens: 100_000,
    totalTokens: 1_100_000
  }, {
    currency: "CNY",
    effectiveAt: "2026-09-26",
    source: "official snapshot",
    cacheHitInputPerMillion: 1,
    cacheMissInputPerMillion: 2,
    outputPerMillion: 3
  })
  assert.equal(cost.unclassifiedPromptTokensChargedAsCacheMiss, 100_000)
  assert.equal(cost.cacheHitInput, 0.2)
  assert.equal(cost.cacheMissInput, 1.6)
  assert.ok(Math.abs(cost.output - 0.3) < 1e-10)
  assert.ok(Math.abs(cost.estimatedTotal - 2.1) < 1e-10)
})
