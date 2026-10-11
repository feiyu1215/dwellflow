import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import {
  calculateEvaluationCost,
  loadMaterialEvaluationDataset,
  loadPricingSnapshot,
  mergeEvaluationOutcomes,
  summarizeEvaluation,
  type EvaluationCaseOutcome
} from "./material-evaluation.ts"

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

const datasetPath = argument("--dataset")
const reportsText = argument("--reports")
const outputText = argument("--out")
if (!datasetPath || !reportsText || !outputText) {
  throw new Error("用法：npm run merge:material-eval -- --dataset <评测集> --reports <按优先级逗号分隔报告> --out <最终报告> [--pricing <价格快照>]")
}
const dataset = loadMaterialEvaluationDataset(datasetPath)
const reportPaths = reportsText.split(",").map(item => resolve(item.trim())).filter(Boolean)
if (!reportPaths.length) throw new Error("至少提供一份来源报告")
const documents = reportPaths.map(path => {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown
  if (!object(raw) || typeof raw.requestedModel !== "string" || typeof raw.promptVersion !== "string"
    || !Array.isArray(raw.cases)) throw new Error("评测报告格式不正确：" + path)
  return {
    path,
    requestedModel: raw.requestedModel,
    promptVersion: raw.promptVersion,
    cases: raw.cases as EvaluationCaseOutcome[]
  }
})
const models = new Set(documents.map(item => item.requestedModel))
const promptVersions = new Set(documents.map(item => item.promptVersion))
if (models.size !== 1 || promptVersions.size !== 1) {
  throw new Error("不能合并不同模型或 Prompt 版本的报告")
}
const cases = mergeEvaluationOutcomes(
  dataset.cases.map(item => item.id),
  documents.map(item => item.cases)
)
const summary = summarizeEvaluation(cases, dataset.thresholds)
const pricingPath = argument("--pricing")
const pricing = pricingPath ? loadPricingSnapshot(pricingPath) : undefined
const outputPath = resolve(outputText)
mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, JSON.stringify({
  schemaVersion: 2,
  status: "merged",
  dataset: { name: dataset.name, version: dataset.version },
  updatedAt: new Date().toISOString(),
  requestedModel: documents[0].requestedModel,
  promptVersion: documents[0].promptVersion,
  sourceReports: documents.map(item => basename(item.path)),
  selectedCaseIds: dataset.cases.map(item => item.id),
  completedCaseIds: cases.map(item => item.id),
  thresholds: dataset.thresholds,
  summary,
  ...(pricing ? { cost: calculateEvaluationCost(summary.usage, pricing) } : {}),
  costScope: "仅统计最终采用的每个用例执行；探索失败、被替换结果及中断调用另行披露。",
  privacy: "报告不含评测图片 data URL、图片路径或输入资料正文；字段结果可能包含模型提取值。",
  cases
}, null, 2) + "\n", "utf8")
console.log(`合并完成：${summary.casesPassed}/${summary.caseCount} 个用例通过，报告 ${outputPath}`)
if (!summary.gatePassed) process.exitCode = 2

