import assert from "node:assert/strict"
import test from "node:test"
import type { AiResult } from "../miniprogram/core/ai-contract.ts"
import {
  loadM6cEvaluationDataset,
  scoreM6cResult,
  selectM6cEvaluationCases,
  summarizeM6cEvaluation,
  type M6cEvaluationOutcome
} from "../server/m6c-evaluation.ts"

const generic = (): AiResult => ({
  summary: "仅基于所选资料的内部草稿",
  observations: [],
  differences: [],
  unknowns: [],
  suggestions: []
})

test("M6C 两个评测集覆盖四种模式并隔离冻结集", () => {
  const rectification = loadM6cEvaluationDataset("evaluation/rectification.synthetic-text.v1.json")
  const consultation = loadM6cEvaluationDataset("evaluation/consultation.synthetic-text.v1.json")
  assert.equal(rectification.cases.length, 6)
  assert.equal(consultation.cases.length, 6)
  assert.deepEqual(new Set(rectification.cases.map(item => item.input.mode)), new Set(["proposal", "review"]))
  assert.deepEqual(new Set(consultation.cases.map(item => item.input.mode)), new Set(["prepare", "response"]))
  assert.equal(rectification.cases.filter(item => item.split === "frozen").length, 2)
  assert.equal(consultation.cases.filter(item => item.split === "development").length, 4)
  assert.deepEqual(
    selectM6cEvaluationCases(consultation.cases, { split: "frozen" }).map(item => item.id),
    ["consult_response_conflict", "consult_response_prompt_injection"]
  )
  assert.equal(rectification.labelProvenance.expertStatus, "not_domain_expert")
})

test("M6C 整改与咨询评分检查来源、状态、补问和禁止行为", () => {
  const rectification = loadM6cEvaluationDataset("evaluation/rectification.synthetic-text.v1.json")
  const rectCase = rectification.cases.find(item => item.id === "rect_proposal_tile_void")!
  const rectResult: AiResult = {
    ...generic(),
    rectification: {
      mode: "proposal",
      issueSourceId: "issue_tile_void",
      issueSummary: "墙砖敲击声差异待确认",
      premises: ["范围和原因尚未核实"],
      gaps: ["缺少网格定位"],
      proposals: [{
        optionId: "option_1",
        title: "先定位并复核范围",
        actions: ["记录网格位置并请施工方现场复核"],
        applicability: ["尚未确认原因"],
        impacts: ["需要追加现场复核"],
        costAndSchedule: "费用与工期待询价",
        verificationEvidence: ["定位记录和复核结论"],
        sourceIds: ["issue_tile_void", "record_tile_tap"],
        knowledgeIds: []
      }]
    }
  }
  assert.equal(scoreM6cResult("rectification", rectCase.expected, rectResult).passed, true)
  if (rectResult.rectification?.mode !== "proposal") throw new Error("测试数据模式错误")
  rectResult.rectification.proposals[0].costAndSchedule = "已经免费完成"
  assert.equal(scoreM6cResult("rectification", rectCase.expected, rectResult).passed, false)
  rectResult.rectification.proposals[0].costAndSchedule = "费用与工期待询价"
  rectResult.summary = "负责人已采用该预案"
  assert.equal(scoreM6cResult("rectification", rectCase.expected, rectResult).passed, false)

  const consultation = loadM6cEvaluationDataset("evaluation/consultation.synthetic-text.v1.json")
  const consultCase = consultation.cases.find(item => item.id === "consult_response_conflict")!
  const consultResult: AiResult = {
    ...generic(),
    consultation: {
      mode: "response",
      consultationSourceId: "consult_wall_1",
      mappings: [{
        mappingId: "mapping_1",
        question: "是否需要立即处理",
        status: "conflicting",
        responseSourceIds: ["response_painter_1", "response_supervisor_1"],
        summary: "一方建议观察，一方建议检查基层，意见不同",
        conditions: [],
        conflicts: ["观察与先检查基层的顺序不同"],
        followUps: ["请说明各自判断所需的现场证据"],
        targetIssueSourceId: ""
      }],
      gaps: []
    }
  }
  assert.equal(scoreM6cResult("consultation", consultCase.expected, consultResult).passed, true)
  if (consultResult.consultation?.mode !== "response") throw new Error("测试数据模式错误")
  consultResult.consultation.mappings[0].status = "answered"
  assert.equal(scoreM6cResult("consultation", consultCase.expected, consultResult).passed, false)
})

test("M6C 汇总分别报告模式并把契约失败计入门槛", () => {
  const base = {
    title: "case",
    critical: true,
    tags: [],
    durationMs: 1,
    promptVersion: "prompt",
    contractVersion: "contract"
  }
  const outcomes: M6cEvaluationOutcome[] = [
    {
      ...base,
      id: "proposal",
      split: "development",
      mode: "proposal",
      contractValid: true,
      score: { passed: true, passedAssertions: 2, totalAssertions: 2, assertions: [] }
    },
    {
      ...base,
      id: "review",
      split: "frozen",
      mode: "review",
      contractValid: false,
      score: { passed: false, passedAssertions: 0, totalAssertions: 2, assertions: [] }
    }
  ]
  const summary = summarizeM6cEvaluation(outcomes, {
    contractPassRate: 1,
    assertionPassRate: 0.85,
    criticalCasePassRate: 1
  })
  assert.equal(summary.gatePassed, false)
  assert.deepEqual(summary.byMode, {
    proposal: { caseCount: 1, casesPassed: 1 },
    review: { caseCount: 1, casesPassed: 0 }
  })
})
