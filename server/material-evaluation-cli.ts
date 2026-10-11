import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { deepSeekProvider, ProviderRunFailure, type ProviderRunResult } from "./provider.ts"
import { PROMPT_VERSION } from "./prompts.ts"
import { validateResult } from "./validation.ts"
import {
  calculateEvaluationCost,
  loadMaterialEvaluationDataset,
  loadPricingSnapshot,
  modelOutputPreview,
  reportResult,
  scoreMaterialResult,
  selectMaterialEvaluationCases,
  summarizeEvaluation,
  type EvaluationCaseOutcome
} from "./material-evaluation.ts"

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function has(name: string): boolean {
  return process.argv.includes(name)
}

function usage(): never {
  throw new Error(
    "用法：npm run eval:material -- --dataset <评测集.json> --confirm-live "
    + "[--out <报告.json>] [--pricing <价格快照.json>] [--case-ids <逗号分隔ID>] [--max-cases <正整数>]"
  )
}

const datasetPath = argument("--dataset") || usage()
if (!has("--confirm-live")) {
  throw new Error("真实评测会产生第三方请求与费用；请检查数据范围后显式添加 --confirm-live")
}
const apiKey = process.env.DEEPSEEK_API_KEY || ""
if (!apiKey) throw new Error("请在本机服务端环境变量设置重新生成的 DEEPSEEK_API_KEY")
const model = process.env.DEEPSEEK_MODEL || "deepseek-flash"
const dataset = loadMaterialEvaluationDataset(datasetPath)
const pricingPath = argument("--pricing")
const pricing = pricingPath ? loadPricingSnapshot(pricingPath) : undefined
const maxCasesText = argument("--max-cases")
const maxCases = maxCasesText === undefined ? undefined : Number(maxCasesText)
const caseIdsText = argument("--case-ids")
const caseIds = caseIdsText?.split(",").map(item => item.trim()).filter(Boolean)
const selectedCases = selectMaterialEvaluationCases(dataset.cases, caseIds, maxCases)
const defaultName = "material-evaluation-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json"
const outputPath = resolve(argument("--out") || resolve("evaluation/reports", defaultName))
mkdirSync(dirname(outputPath), { recursive: true })
const provider = deepSeekProvider(apiKey, model)
const outcomes: EvaluationCaseOutcome[] = []
const evaluationStartedAt = new Date().toISOString()

function writeProgress(status: "running" | "completed") {
  const summary = summarizeEvaluation(outcomes, dataset.thresholds)
  const report = {
    schemaVersion: 2,
    status,
    dataset: { name: dataset.name, version: dataset.version },
    startedAt: evaluationStartedAt,
    updatedAt: new Date().toISOString(),
    requestedModel: model,
    promptVersion: PROMPT_VERSION,
    selectedCaseIds: selectedCases.map(item => item.id),
    completedCaseIds: outcomes.map(item => item.id),
    thresholds: dataset.thresholds,
    summary,
    ...(pricing ? { cost: calculateEvaluationCost(summary.usage, pricing) } : {}),
    privacy: "报告不含评测图片 data URL、图片路径或输入资料正文；字段结果及无效输出预览可能包含模型提取值。",
    cases: outcomes
  }
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8")
  return summary
}

for (const [index, item] of selectedCases.entries()) {
  const started = Date.now()
  let run: ProviderRunResult | undefined
  try {
    run = await provider.run(item.input, [])
    const result = validateResult(run.output, item.input, [])
    outcomes.push({
      id: item.id,
      title: item.title,
      critical: item.critical,
      tags: item.tags,
      imageCount: item.imageCount,
      contractValid: true,
      durationMs: Date.now() - started,
      providerRequestId: run.providerRequestId,
      responseModel: run.responseModel,
      usage: run.usage,
      score: scoreMaterialResult(item.expected, result),
      result: reportResult(result)
    })
  } catch (error) {
    const failedRun = error instanceof ProviderRunFailure ? error : undefined
    outcomes.push({
      id: item.id,
      title: item.title,
      critical: item.critical,
      tags: item.tags,
      imageCount: item.imageCount,
      contractValid: false,
      durationMs: Date.now() - started,
      providerRequestId: run?.providerRequestId || failedRun?.providerRequestId,
      responseModel: run?.responseModel || failedRun?.responseModel,
      usage: run?.usage || failedRun?.usage,
      score: scoreMaterialResult(item.expected),
      ...(run ? { invalidOutputPreview: modelOutputPreview(run.output) } : {}),
      error: error instanceof Error ? error.message : "未知评测错误"
    })
  }
  writeProgress("running")
  const latest = outcomes[outcomes.length - 1]
  console.log(`[${index + 1}/${selectedCases.length}] ${item.id}: ${latest.contractValid && latest.score.passed ? "通过" : "未通过"}`)
}

const summary = writeProgress("completed")
console.log(`材料评测完成：${summary.casesPassed}/${summary.caseCount} 个用例全部断言通过`)
console.log(`契约通过率 ${(summary.contractPassRate * 100).toFixed(1)}%，断言通过率 ${(summary.assertionPassRate * 100).toFixed(1)}%`)
console.log("报告：" + outputPath)
if (!summary.gatePassed) process.exitCode = 2
