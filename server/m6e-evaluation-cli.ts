import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { deepSeekProvider, ProviderRunFailure, type ProviderRunResult } from "./provider.ts"
import { contractVersionFor, promptVersionFor } from "./prompts.ts"
import { validateResult } from "./validation.ts"
import {
  calculateEvaluationCost,
  loadPricingSnapshot,
  modelOutputPreview
} from "./material-evaluation.ts"
import {
  loadM6eEvaluationDataset,
  reportM6eResult,
  scoreM6eResult,
  selectM6eEvaluationCases,
  summarizeM6eEvaluation,
  type M6eEvaluationOutcome,
  type M6eEvaluationSplit
} from "./m6e-evaluation.ts"

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const has = (name: string) => process.argv.includes(name)

function usage(): never {
  throw new Error(
    "用法：npm run eval:m6e -- --dataset <评测集.json> --confirm-live "
    + "[--out <报告.json>] [--pricing <价格快照.json>] [--split development|frozen] "
    + "[--case-ids <逗号分隔ID>] [--max-cases <正整数>]"
  )
}

const datasetPath = argument("--dataset") || usage()
if (!has("--confirm-live")) {
  throw new Error("真实评测会产生第三方请求与费用；请检查数据范围后显式添加 --confirm-live")
}
const apiKey = process.env.DEEPSEEK_API_KEY || ""
if (!apiKey) throw new Error("请在本机服务端环境变量设置重新生成的 DEEPSEEK_API_KEY")
const model = process.env.DEEPSEEK_MODEL || "deepseek-flash"
const dataset = loadM6eEvaluationDataset(datasetPath)
const pricingPath = argument("--pricing")
const pricing = pricingPath ? loadPricingSnapshot(pricingPath) : undefined
const maxCasesText = argument("--max-cases")
const maxCases = maxCasesText === undefined ? undefined : Number(maxCasesText)
const caseIds = argument("--case-ids")?.split(",").map(item => item.trim()).filter(Boolean)
const splitText = argument("--split")
if (splitText !== undefined && !["development", "frozen"].includes(splitText)) {
  throw new Error("--split 只能是 development 或 frozen")
}
const selectedCases = selectM6eEvaluationCases(dataset.cases, {
  caseIds,
  maxCases,
  split: splitText as M6eEvaluationSplit | undefined
})
if (!selectedCases.length) throw new Error("当前筛选范围没有 M6E 评测用例")
const defaultName = `project-summary-evaluation-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
const outputPath = resolve(argument("--out") || resolve("evaluation/reports", defaultName))
mkdirSync(dirname(outputPath), { recursive: true })
const provider = deepSeekProvider(apiKey, model)
const outcomes: M6eEvaluationOutcome[] = []
const startedAt = new Date().toISOString()

function writeProgress(status: "running" | "completed") {
  const summary = summarizeM6eEvaluation(outcomes, dataset.thresholds)
  const report = {
    schemaVersion: 1,
    status,
    dataset: {
      name: dataset.name,
      version: dataset.version,
      task: dataset.task,
      labelProvenance: dataset.labelProvenance
    },
    startedAt,
    updatedAt: new Date().toISOString(),
    requestedModel: model,
    promptVersion: promptVersionFor("project_summary"),
    contractVersion: contractVersionFor("project_summary"),
    selectedCaseIds: selectedCases.map(item => item.id),
    completedCaseIds: outcomes.map(item => item.id),
    thresholds: dataset.thresholds,
    summary,
    ...(pricing ? { cost: calculateEvaluationCost(summary.usage, pricing) } : {}),
    privacy: "报告只包含合成输入对应的项目总结结构结果；没有真实用户装修资料。",
    interpretation: "全部案例和参考断言均为内部合成，未经过装修行业专家标注；通过只代表本小样本达到范围、状态、来源和权限边界基线。",
    cases: outcomes
  }
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8")
  return summary
}

for (const [index, item] of selectedCases.entries()) {
  const runStartedAt = Date.now()
  const promptVersion = promptVersionFor("project_summary")
  const contractVersion = contractVersionFor("project_summary")
  let run: ProviderRunResult | undefined
  try {
    run = await provider.run(item.input, [])
    const result = validateResult(run.output, item.input, [])
    outcomes.push({
      id: item.id,
      title: item.title,
      critical: item.critical,
      split: item.split,
      tags: item.tags,
      contractValid: true,
      durationMs: Date.now() - runStartedAt,
      promptVersion,
      contractVersion,
      providerRequestId: run.providerRequestId,
      responseModel: run.responseModel,
      usage: run.usage,
      score: scoreM6eResult(item.expected, result),
      result: reportM6eResult(result)
    })
  } catch (error) {
    const failedRun = error instanceof ProviderRunFailure ? error : undefined
    outcomes.push({
      id: item.id,
      title: item.title,
      critical: item.critical,
      split: item.split,
      tags: item.tags,
      contractValid: false,
      durationMs: Date.now() - runStartedAt,
      promptVersion,
      contractVersion,
      providerRequestId: run?.providerRequestId || failedRun?.providerRequestId,
      responseModel: run?.responseModel || failedRun?.responseModel,
      usage: run?.usage || failedRun?.usage,
      score: scoreM6eResult(item.expected),
      ...(run ? { invalidOutputPreview: modelOutputPreview(run.output) } : {}),
      error: error instanceof Error ? error.message : "未知评测错误"
    })
  }
  writeProgress("running")
  const latest = outcomes[outcomes.length - 1]
  console.log(`[${index + 1}/${selectedCases.length}] ${item.id}: ${latest.contractValid && latest.score.passed ? "通过" : "未通过"}`)
}

const summary = writeProgress("completed")
console.log(`project_summary 评测完成：${summary.casesPassed}/${summary.caseCount} 个用例全部断言通过`)
console.log(`契约通过率 ${(summary.contractPassRate * 100).toFixed(1)}%，断言通过率 ${(summary.assertionPassRate * 100).toFixed(1)}%`)
console.log("报告：" + outputPath)
if (!summary.gatePassed) process.exitCode = 2
