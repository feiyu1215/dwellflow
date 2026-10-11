import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { AiResult } from "../miniprogram/core/ai-contract.ts"
import {
  loadM6cEvaluationDataset,
  scoreM6cResult,
  summarizeM6cEvaluation,
  type M6cEvaluationOutcome
} from "./m6c-evaluation.ts"

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function required(name: string): string {
  const value = argument(name)
  if (!value) {
    throw new Error("用法：node server/m6c-evaluation-rescore-cli.ts --dataset <评测集> --report <原报告> --out <新报告>")
  }
  return value
}

const dataset = loadM6cEvaluationDataset(required("--dataset"))
const reportPath = resolve(required("--report"))
const outputPath = resolve(required("--out"))
const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
  status?: string
  dataset?: { task?: string; name?: string }
  cases?: M6cEvaluationOutcome[]
  summary?: unknown
  [key: string]: unknown
}
if (report.status !== "completed" || report.dataset?.task !== dataset.task
  || !Array.isArray(report.cases)) {
  throw new Error("原报告不是同任务的完整 M6C 报告")
}
const byId = new Map(dataset.cases.map(item => [item.id, item]))
const rescored = report.cases.map(outcome => {
  const item = byId.get(outcome.id)
  if (!item || outcome.mode !== item.input.mode) {
    throw new Error("报告用例与当前评测集不一致：" + outcome.id)
  }
  const result: AiResult | undefined = outcome.contractValid && outcome.result
    ? {
      observations: [],
      differences: [],
      suggestions: [],
      ...outcome.result
    }
    : undefined
  return {
    ...outcome,
    score: scoreM6cResult(dataset.task, item.expected, result)
  }
})
if (rescored.length !== dataset.cases.length
  || new Set(rescored.map(item => item.id)).size !== dataset.cases.length) {
  throw new Error("报告未覆盖当前评测集的全部用例")
}
const next = {
  ...report,
  updatedAt: new Date().toISOString(),
  rescoredAt: new Date().toISOString(),
  scoringRevision: 2,
  previousSummary: report.summary,
  summary: summarizeM6cEvaluation(rescored, dataset.thresholds),
  cases: rescored
}
writeFileSync(outputPath, JSON.stringify(next, null, 2) + "\n", "utf8")
console.log("重新评分完成：" + outputPath)
console.log(JSON.stringify(next.summary))
