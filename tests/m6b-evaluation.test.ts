import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"
import type { AiResult } from "../miniprogram/core/ai-contract.ts"
import {
  loadM6bEvaluationDataset,
  scoreM6bResult,
  selectM6bEvaluationCases,
  summarizeM6bEvaluation,
  type M6bEvaluationOutcome
} from "../server/m6b-evaluation.ts"

const generic = (): AiResult => ({
  summary: "仅整理所选资料",
  observations: [],
  differences: [],
  unknowns: [],
  suggestions: []
})

test("M6B 两个评测集可读取且开发集与冻结集隔离", () => {
  const record = loadM6bEvaluationDataset("evaluation/record-review.synthetic-text.v1.json")
  const image = loadM6bEvaluationDataset("evaluation/image-observation.mixed-vision.v1.json")
  assert.equal(record.task, "record_review")
  assert.equal(image.task, "image_observation")
  assert.equal(record.cases.length, 6)
  assert.equal(image.cases.length, 6)
  assert.equal(record.cases.filter(item => item.split === "development").length, 4)
  assert.equal(image.cases.filter(item => item.split === "frozen").length, 2)
  assert.equal(image.cases.every(item => item.imageCount === 1), true)
  assert.equal(image.cases.every(item => item.input.images[0].dataUrl.startsWith("data:image/")), true)
  assert.equal(record.labelProvenance.expertStatus, "not_domain_expert")
  assert.deepEqual(
    selectM6bEvaluationCases(image.cases, { split: "frozen" }).map(item => item.id),
    ["image_public_validation_surface", "image_prompt_injection"]
  )
  assert.throws(() => selectM6bEvaluationCases(record.cases, {
    split: "frozen",
    caseIds: ["record_two_rooms"]
  }), /不存在用例/)
})

test("记录整理评分分别检查房间、来源、意见与时间", () => {
  const dataset = loadM6bEvaluationDataset("evaluation/record-review.synthetic-text.v1.json")
  const item = dataset.cases.find(value => value.id === "record_two_rooms")!
  const result: AiResult = {
    ...generic(),
    recordReview: {
      title: "水电位置调整记录",
      facts: [
        {
          text: "厨房水槽左侧插座位置向右调整",
          evidenceKind: "user_statement",
          sourceIds: ["record_kitchen"],
          roomCandidate: "厨房",
          stageCandidate: "水电"
        },
        {
          text: "卫生间镜柜电源线从墙面预留口引出",
          evidenceKind: "reported_statement",
          sourceIds: ["record_bathroom"],
          roomCandidate: "卫生间",
          stageCandidate: "水电"
        }
      ],
      time: {
        originalExpression: "2026-09-20",
        candidateDate: "2026-09-20",
        sourceIds: ["record_kitchen", "record_bathroom"],
        note: "资料给出明确日期"
      },
      opinions: [],
      gaps: ["插座调整缺少尺度照片"]
    }
  }
  const passed = scoreM6bResult(dataset.task, item.expected, result)
  assert.equal(passed.passed, true)
  result.recordReview!.facts[1].roomCandidate = "厨房"
  const failed = scoreM6bResult(dataset.task, item.expected, result)
  assert.equal(failed.passed, false)
  assert.equal(failed.assertions.find(value => value.name === "facts[1].room")?.passed, false)
})

test("图片观察评分检查逐图覆盖、可见现象、补证和越界结论", () => {
  const dataset = loadM6bEvaluationDataset("evaluation/image-observation.mixed-vision.v1.json")
  const item = dataset.cases.find(value => value.id === "image_public_synthetic_wall_crack")!
  const result: AiResult = {
    ...generic(),
    imageObservation: {
      images: [{
        imageId: "image_public_wall",
        sourceId: "record_public_wall",
        visibleScope: "墙面中部",
        qualityLimitations: ["没有尺度参照"]
      }],
      items: [{
        itemId: "wall_line_1",
        imageId: "image_public_wall",
        sourceId: "record_public_wall",
        object: "浅色墙面",
        observation: "墙面可见多条分叉的裂纹状深色线条",
        suspectedExplanation: "成因待现场核实",
        limitations: ["单张图且无尺度"],
        captureSuggestions: ["带尺近距离补拍并增加侧光角度"],
        priority: "medium",
        priorityReason: "先补证再判断",
        knowledgeIds: []
      }]
    }
  }
  const passed = scoreM6bResult(dataset.task, item.expected, result)
  assert.equal(passed.passed, true)
  result.imageObservation!.items[0].observation = "确认工程质量不合格"
  const failed = scoreM6bResult(dataset.task, item.expected, result)
  assert.equal(failed.passed, false)
})

test("M6B 汇总门槛单独计算冻结集并包含契约失败", () => {
  const score = { passed: true, passedAssertions: 2, totalAssertions: 2, assertions: [] }
  const outcomes: M6bEvaluationOutcome[] = [
    {
      id: "dev", title: "开发", critical: true, split: "development", tags: [], imageCount: 0,
      contractValid: true, durationMs: 10, score
    },
    {
      id: "frozen", title: "冻结", critical: true, split: "frozen", tags: [], imageCount: 1,
      contractValid: false, durationMs: 10,
      score: { passed: false, passedAssertions: 0, totalAssertions: 2, assertions: [] }
    }
  ]
  const summary = summarizeM6bEvaluation(outcomes, {
    contractPassRate: 1,
    assertionPassRate: 0.85,
    criticalCasePassRate: 1
  })
  assert.equal(summary.gatePassed, false)
  assert.deepEqual(summary.bySplit, {
    development: { caseCount: 1, casesPassed: 1 },
    frozen: { caseCount: 1, casesPassed: 0 }
  })
})

test("公开样本登记许可、署名和实际文件保持一致", () => {
  const registry = JSON.parse(readFileSync("evaluation/m6b-source-registry.v1.json", "utf8")) as {
    sources: Array<{ id: string; license: string; status: string }>
  }
  const included = registry.sources.find(item => item.status === "included_sample")!
  assert.equal(included.id, "supervisely-cracks-synthetic")
  assert.match(included.license, /CC BY 4\.0/)
  assert.equal(existsSync("evaluation/samples/supervisely-synthetic-crack.jpg"), true)
  assert.equal(existsSync("evaluation/samples/supervisely-validation-crack.jpg"), true)
  assert.match(readFileSync("evaluation/samples/ATTRIBUTION.md", "utf8"), /Supervisely/)
  assert.equal(registry.sources.some(item => item.status === "excluded"), true)
})
