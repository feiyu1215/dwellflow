import test from "node:test"
import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Repository } from "../server/repository.ts"
import { createApi } from "../server/app.ts"
import { deepSeekProvider, ProviderRunFailure } from "../server/provider.ts"
import {
  validateBudgetReview,
  validateConsultationReview,
  validateInput,
  validateMaterialReview,
  validateProjectSummaryReview,
  validateRectificationReview,
  validateResult
} from "../server/validation.ts"
import { AI_TASKS, type AiInput, type AiResult } from "../miniprogram/core/ai-contract.ts"
import { calculateSelectedBudget } from "../server/calculations.ts"
import { contractVersionFor, promptVersionFor } from "../server/prompts.ts"

test("budget uses explicit assumptions and keeps expense actions separate", () => {
  const value = input()
  value.sources = [
    { id: "m1", kind: "material", title: "砖", version: "1",
      text: JSON.stringify({ unit: "片", plannedQuantity: 10, unitPriceFen: 125, wasteRatePermille: 100 }) },
    { id: "m2", kind: "material", title: "缺单价", version: "1", text: "{}" },
    { id: "e1", kind: "expense", title: "付款", version: "1", text: JSON.stringify({ action: "payment", amountFen: 1000 }) }
  ]
  const calculation = calculateSelectedBudget(value)
  assert.deepEqual(calculation.rows[0], { sourceId: "m1", label: "material_estimate", requiredQuantity: 11, amountFen: 1375 })
  assert.equal(calculation.rows[1].label, "payment")
  assert.equal(calculation.unknowns.length, 1)
})

const input = (task: AiInput["task"] = "material_check"): AiInput => ({
  requestId: "request1", projectId: "project1", task, stage: "水电",
  question: "",
  sources: [
    { id: "r1", kind: "record", title: "到货照片", text: "标签可见品牌，型号被遮挡", version: "1", authority: "project_fact", occurredAt: "2026-09-27T03:00:00.000Z", updatedAt: "2026-09-27T03:00:00.000Z", room: "厨房", stage: "水电" },
    { id: "m1", kind: "material", title: "电线", text: "材料：电线", version: "1", authority: "project_fact", occurredAt: "2026-09-20T03:00:00.000Z", updatedAt: "2026-09-20T03:00:00.000Z" },
    { id: "receipt1", kind: "receipt", title: "到货批次 1", text: "实到 9 卷", version: "1", authority: "project_fact", relatedMaterialId: "m1", occurredAt: "2026-09-27T04:00:00.000Z", updatedAt: "2026-09-27T04:00:00.000Z" },
    { id: "agreement1", kind: "agreement", title: "电线约定", text: "品牌示例牌；规格 2.5 平方；数量 10 卷", version: "2", authority: "approved_agreement", relatedMaterialId: "m1", occurredAt: "2026-09-19T03:00:00.000Z", updatedAt: "2026-09-19T03:00:00.000Z" },
    { id: "issue1", kind: "issue", title: "标签型号待确认", text: "问题仍待负责人确认", version: "3", authority: "project_fact", occurredAt: "2026-09-27T05:00:00.000Z", updatedAt: "2026-09-27T05:00:00.000Z", room: "厨房", stage: "水电" },
    { id: "consultation1", kind: "consultation", title: "标签咨询", text: "询问型号如何核实", version: "2", authority: "project_fact", occurredAt: "2026-09-27T06:00:00.000Z", updatedAt: "2026-09-27T06:00:00.000Z" },
    { id: "response1", kind: "consultation_response", title: "师傅回复", text: "建议补拍标签", version: "1", authority: "project_fact", relatedConsultationId: "consultation1", occurredAt: "2026-09-27T07:00:00.000Z", updatedAt: "2026-09-27T07:00:00.000Z" }
  ],
  images: [],
  ...(task === "rectification" ? {
    mode: "proposal" as const,
    target: { kind: "issue" as const, id: "issue1", version: "3" }
  } : task === "consultation" ? { mode: "prepare" as const }
    : task === "project_summary" ? {
      summaryScope: {
        title: "水电阶段周报",
        purpose: "阶段复盘与后续交接",
        audience: "家人与工长",
        stage: "水电",
        room: "全部房间",
        dateFrom: "2026-09-20",
        dateTo: "2026-09-28",
        cutoffAt: "2026-09-28T12:00:00.000Z"
      }
    } : {})
})
const genericResult = () => ({
  summary: "所选记录缺少标签信息", observations: [{ text: "标签不清晰", sourceIds: ["r1"] }],
  differences: [], unknowns: ["型号待核实"], suggestions: []
})
const materialResult = (): AiResult => ({
  ...genericResult(),
  materialCheck: {
    materialSourceId: "m1",
    receiptSourceId: "receipt1",
    fields: [
      {
        key: "brand", label: "品牌", observedValue: "示例牌", expectedValue: "示例牌", status: "matches",
        observedSourceIds: ["r1"], expectedSourceIds: ["agreement1"], note: "标签品牌清晰"
      },
      {
        key: "model", label: "型号", observedValue: "", expectedValue: "", status: "unknown",
        observedSourceIds: [], expectedSourceIds: [], note: "型号被遮挡"
      },
      {
        key: "specification", label: "规格", observedValue: "2.5 平方", expectedValue: "2.5 平方", status: "matches",
        observedSourceIds: ["r1"], expectedSourceIds: ["agreement1"], note: ""
      },
      {
        key: "quantity", label: "数量", observedValue: "9 卷", expectedValue: "10 卷", status: "differs",
        observedSourceIds: ["receipt1"], expectedSourceIds: ["agreement1"], note: "少 1 卷，待负责人核实"
      }
    ]
  }
})
const recordReviewResult = (): AiResult => ({
  ...genericResult(),
  recordReview: {
    title: "到货标签待补充",
    facts: [{
      text: "标签上的品牌可见，型号位置被遮挡",
      evidenceKind: "user_statement",
      sourceIds: ["r1"],
      roomCandidate: "",
      stageCandidate: "水电"
    }],
    time: {
      originalExpression: "",
      candidateDate: "",
      sourceIds: [],
      note: "所选资料没有明确发生日期"
    },
    opinions: [],
    gaps: ["需要补拍型号位置"]
  }
})
const imageObservationResult = (): AiResult => ({
  ...genericResult(),
  imageObservation: {
    images: [{
      imageId: "image1",
      sourceId: "r1",
      visibleScope: "仅观察到一张材料标签近景",
      qualityLimitations: ["型号位置被遮挡"]
    }],
    items: [{
      itemId: "observation1",
      imageId: "image1",
      sourceId: "r1",
      object: "材料标签",
      observation: "品牌区域可见，型号区域被遮挡",
      region: { x: 0.1, y: 0.1, width: 0.4, height: 0.3 },
      suspectedExplanation: "",
      limitations: ["无法读取型号"],
      captureSuggestions: ["移开遮挡后垂直补拍标签"],
      priority: "high",
      priorityReason: "型号是后续核对所需字段",
      knowledgeIds: []
    }]
  }
})
const rectificationProposalResult = (): AiResult => ({
  ...genericResult(),
  rectification: {
    mode: "proposal",
    issueSourceId: "issue1",
    issueSummary: "材料标签型号尚未核实",
    premises: ["当前只有一张型号位置被遮挡的照片"],
    gaps: ["缺少无遮挡标签近照"],
    proposals: [{
      optionId: "option1",
      title: "补拍后再核对",
      actions: ["移开遮挡并垂直补拍型号区域"],
      applicability: ["包装仍在现场且标签可重新拍摄"],
      impacts: ["确认前不改变材料可用状态"],
      costAndSchedule: "费用和完成时间待现场确认",
      verificationEvidence: ["清晰型号近照"],
      sourceIds: ["issue1", "r1"],
      knowledgeIds: []
    }]
  }
})
const rectificationReviewResult = (): AiResult => ({
  ...genericResult(),
  rectification: {
    mode: "review",
    issueSourceId: "issue1",
    treatmentId: "treatment1",
    evidenceRelation: "uncertain",
    checks: [{
      checkId: "check1",
      requirement: "确认补拍图与原标签属于同一包装",
      beforeSourceIds: ["r1"],
      afterSourceIds: ["issue1"],
      status: "not_verifiable",
      observation: "资料没有明确证明前后属于同一包装",
      limitations: ["缺少同框或连续拍摄证据"],
      nextSteps: ["补充同一包装全景与标签近照"],
      knowledgeIds: []
    }],
    gaps: ["前后证据关系待确认"]
  }
})
const consultationPrepareResult = (): AiResult => ({
  ...genericResult(),
  consultation: {
    mode: "prepare",
    title: "材料标签型号核实咨询",
    purpose: "确认需要补充什么证据才能核对型号",
    summary: "现有照片显示品牌区域，但型号位置被遮挡。",
    facts: [{ text: "型号位置被遮挡", sourceIds: ["r1"] }],
    timeline: [],
    disputes: [],
    gaps: ["缺少无遮挡近照"],
    questions: [{
      questionId: "question1",
      text: "需要补拍包装的哪些位置才能确认型号？",
      rationale: "当前型号区域不可读",
      expectedAnswer: "请指出需要拍摄的标签区域和清晰度要求",
      sourceIds: ["r1"]
    }]
  }
})
const consultationResponseResult = (): AiResult => ({
  ...genericResult(),
  consultation: {
    mode: "response",
    consultationSourceId: "consultation1",
    mappings: [{
      mappingId: "mapping1",
      question: "需要补拍哪些位置？",
      status: "answered",
      responseSourceIds: ["response1"],
      summary: "回复建议补拍完整标签。",
      conditions: ["包装仍可重新拍摄"],
      conflicts: [],
      followUps: ["确认是否需要同框拍摄整件包装"],
      targetIssueSourceId: "issue1"
    }],
    gaps: []
  }
})
const budgetResult = (): AiResult => ({
  ...genericResult(),
  budget: {
    goal: "估算电线剩余采购量并保留价格未知状态",
    scenarios: [{
      scenarioId: "scenario1",
      label: "现有电线计划",
      materialSourceId: "m1",
      unit: "卷",
      requiredQuantity: {
        value: "10", status: "observed", sourceIds: ["m1"], note: "材料计划数量"
      },
      wasteRatePercent: {
        value: "10", status: "observed", sourceIds: ["m1"], note: "材料计划损耗"
      },
      requirementIncludesWaste: {
        value: "no", sourceIds: ["m1"], note: "计划数量与损耗率分开记录"
      },
      packageSize: {
        value: "1", status: "observed", sourceIds: ["m1"], note: "每卷为一个采购单位"
      },
      packageUnitPriceYuan: {
        value: "", status: "unknown", sourceIds: [], note: "所选资料未记录单价"
      },
      assumptions: [],
      conflicts: [],
      missingFields: ["packageUnitPriceYuan"]
    }],
    ledgerNotes: [],
    gaps: ["单价未知，因此不能计算金额"]
  }
})
const projectSummaryResult = (): AiResult => ({
  ...genericResult(),
  projectSummary: {
    title: "水电阶段周报",
    scopeStatement: "覆盖水电工序、全部房间、2026-09-20 至 2026-09-28 所选资料，截止 2026-09-28T12:00:00.000Z，供家人与工长交接。",
    sections: [
      {
        key: "progress", title: "进展",
        items: [{ itemId: "progress1", text: "已保存一条到货标签记录。", status: "in_progress", sourceIds: ["r1"] }],
        gaps: ["所选资料没有施工完成证明"]
      },
      {
        key: "issues", title: "问题与整改",
        items: [{ itemId: "issue_summary1", text: "标签型号仍待负责人确认。", status: "pending_confirmation", sourceIds: ["issue1"] }],
        gaps: []
      },
      {
        key: "materials", title: "材料与资源",
        items: [{ itemId: "material1", text: "电线到货批次记录为 9 卷。", status: "pending_confirmation", sourceIds: ["receipt1"] }],
        gaps: ["型号被遮挡"]
      },
      { key: "finance", title: "费用与款项", items: [], gaps: ["所选资料没有费用事实"] },
      {
        key: "consultations", title: "咨询与协作",
        items: [{ itemId: "consultation_summary1", text: "已有补拍标签建议。", status: "in_progress", sourceIds: ["response1"] }],
        gaps: []
      }
    ],
    handoff: [
      { itemId: "handoff1", text: "补拍无遮挡标签。", status: "pending", sourceIds: ["issue1", "response1"] },
      { itemId: "handoff2", text: "补充费用与付款资料。", status: "missing", sourceIds: [] }
    ],
    overallGaps: ["没有全屋其他工序资料"]
  }
})
const rectificationProposalHumanReview = () => {
  const original = rectificationProposalResult().rectification
  if (!original || original.mode !== "proposal") throw new Error("invalid fixture")
  return {
    mode: "proposal" as const,
    items: original.proposals.map(option => ({
      optionId: option.optionId,
      included: true,
      title: option.title,
      content: `${option.title}：${option.actions.join("；")}`
    })),
    note: ""
  }
}
const consultationPreparationHumanReview = () => {
  const original = consultationPrepareResult().consultation
  if (!original || original.mode !== "prepare") throw new Error("invalid fixture")
  return {
    mode: "prepare" as const,
    title: original.title,
    purpose: original.purpose,
    facts: original.facts.map((item, sourceIndex) => ({
      sourceIndex, included: true, text: item.text
    })),
    timeline: original.timeline.map((item, sourceIndex) => ({
      sourceIndex, included: true, text: item.text
    })),
    disputes: original.disputes.map((item, sourceIndex) => ({
      sourceIndex, included: true, text: item.text
    })),
    gaps: original.gaps,
    questions: original.questions.map((item, sourceIndex) => ({
      sourceIndex, included: true, text: item.text
    })),
    note: ""
  }
}
const budgetHumanReview = () => ({
  scenarios: [{
    scenarioId: "scenario1",
    included: true,
    label: "现有电线计划",
    materialSourceId: "m1",
    unit: "卷",
    requiredQuantity: "10",
    wasteRatePercent: "10",
    requirementIncludesWaste: "no" as const,
    packageSize: "1",
    packageUnitPriceYuan: "",
    note: "价格未知，先保存数量估算"
  }],
  note: "仅比较所选材料"
})
const projectSummaryHumanReview = () => ({
  title: projectSummaryResult().projectSummary!.title,
  scopeStatement: projectSummaryResult().projectSummary!.scopeStatement,
  sections: projectSummaryResult().projectSummary!.sections.map(section => ({
    key: section.key,
    included: true,
    title: section.title,
    content: [
      ...section.items.map(item => item.text),
      ...section.gaps.map(gap => `资料缺口：${gap}`)
    ].join("\n") || "本分区暂无可引用事实。"
  })),
  handoff: projectSummaryResult().projectSummary!.handoff.map(item => ({
    itemId: item.itemId,
    included: true,
    text: item.text,
    status: item.status
  })),
  note: "负责人已核对所选范围"
})

const resultForTask = (task: AiInput["task"]): AiResult => {
  if (task === "material_check") return materialResult()
  if (task === "record_review") return recordReviewResult()
  if (task === "image_observation") return imageObservationResult()
  if (task === "rectification") return rectificationProposalResult()
  if (task === "consultation") return consultationPrepareResult()
  if (task === "budget") return budgetResult()
  if (task === "project_summary") return projectSummaryResult()
  return genericResult()
}

test("HTTP workflow: seven tasks, auth, idempotency, citations and correction", async () => {
  const repo = new Repository(":memory:")
  let calls = 0
  let invalid = false
  const server = createApi(repo, { model: "fake-test-only", async run(value) {
    calls++
    const output = resultForTask(value.task)
    return {
      output: invalid ? { ...output, observations: [{ text: "无依据", sourceIds: ["unknown"] }] } : output,
      providerRequestId: "provider-request-" + calls,
      responseModel: "fake-response-model",
      usage: {
        promptTokens: 100,
        cacheHitPromptTokens: 20,
        cacheMissPromptTokens: 80,
        completionTokens: 30,
        totalTokens: 130
      }
    }
  } }, "a".repeat(32))
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address() as { port: number }
  const base = "http://127.0.0.1:" + address.port
  const request = (path: string, body?: unknown, auth = true) => fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: { ...(auth ? { Authorization: "Bearer " + "a".repeat(32) } : {}), "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  try {
    assert.equal((await request("/v1/ai/jobs?projectId=project1", undefined, false)).status, 401)
    for (const task of AI_TASKS) {
      const value = { ...input(task.id), requestId: task.id }
      if (task.id === "image_observation") value.images = [{
        id: "image1", sourceId: "r1", dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
      }]
      const response = await request("/v1/ai/jobs", value)
      assert.equal(response.status, 200)
      const job = await response.json()
      assert.equal(job.status, "succeeded")
      assert.equal(job.mode, value.mode)
      assert.equal(job.promptVersion, promptVersionFor(task.id, value.mode))
      assert.equal(job.contractVersion, contractVersionFor(task.id, value.mode))
      assert.equal(job.metrics.responseModel, "fake-response-model")
      assert.equal(job.metrics.usage.totalTokens, 130)
      const count = calls
      const repeated = await (await request("/v1/ai/jobs", value)).json()
      assert.equal(repeated.id, job.id)
      assert.equal(calls, count)
      assert.equal((await request("/v1/ai/jobs", { ...value, question: "changed" })).status, 409)
      const materialReview = task.id === "material_check" ? {
        fields: materialResult().materialCheck!.fields.map(field => ({
          key: field.key,
          observedValue: field.observedValue,
          expectedValue: field.expectedValue,
          status: field.status,
          note: field.note
        }))
      } : undefined
      const recordReviewReview = task.id === "record_review" ? {
        title: recordReviewResult().recordReview!.title,
        room: "厨房",
        stage: "水电",
        occurredAt: "2026-09-27T04:00:00.000Z",
        note: "等待补拍型号",
        facts: recordReviewResult().recordReview!.facts.map((fact, sourceIndex) => ({
          sourceIndex,
          included: true,
          text: fact.text
        })),
        opinions: []
      } : undefined
      const imageObservationReview = task.id === "image_observation" ? {
        items: imageObservationResult().imageObservation!.items.map(item => ({
          itemId: item.itemId,
          disposition: "issue" as const,
          observation: item.observation,
          suspectedExplanation: item.suspectedExplanation,
          limitations: item.limitations,
          captureSuggestions: item.captureSuggestions,
          priority: item.priority,
          priorityReason: item.priorityReason,
          issueTitle: "材料标签型号待确认"
        }))
      } : undefined
      const rectificationReview = task.id === "rectification"
        ? rectificationProposalHumanReview() : undefined
      const consultationReview = task.id === "consultation"
        ? consultationPreparationHumanReview() : undefined
      const budgetReview = task.id === "budget" ? budgetHumanReview() : undefined
      const projectSummaryReview = task.id === "project_summary"
        ? projectSummaryHumanReview() : undefined
      if ([
        "material_check", "record_review", "image_observation", "rectification", "consultation", "budget",
        "project_summary"
      ].includes(task.id)) {
        assert.equal((await request("/v1/ai/jobs/" + job.id + "/decision",
          { decision: "accepted", correction: "型号需补拍" })).status, 400)
      }
      const decisionBody = {
        decision: "accepted",
        correction: "型号需补拍",
        ...(materialReview ? { materialReview } : {}),
        ...(recordReviewReview ? { recordReviewReview } : {}),
        ...(imageObservationReview ? { imageObservationReview } : {}),
        ...(rectificationReview ? { rectificationReview } : {}),
        ...(consultationReview ? { consultationReview } : {}),
        ...(budgetReview ? { budgetReview } : {}),
        ...(projectSummaryReview ? { projectSummaryReview } : {})
      }
      const decided = await (await request("/v1/ai/jobs/" + job.id + "/decision",
        decisionBody)).json()
      assert.equal(decided.correction, "型号需补拍")
      assert.deepEqual(decided.result, resultForTask(task.id))
      if (materialReview) assert.deepEqual(decided.materialReview, materialReview)
      if (recordReviewReview) assert.deepEqual(decided.recordReviewReview, recordReviewReview)
      if (imageObservationReview) {
        assert.deepEqual(decided.imageObservationReview, imageObservationReview)
      }
      if (rectificationReview) assert.deepEqual(decided.rectificationReview, rectificationReview)
      if (consultationReview) assert.deepEqual(decided.consultationReview, consultationReview)
      if (budgetReview) assert.deepEqual(decided.budgetReview, budgetReview)
      if (projectSummaryReview) {
        assert.deepEqual(decided.projectSummaryReview, projectSummaryReview)
      }
      const decisionsBeforeReplay = repo.db.prepare("SELECT COUNT(*) AS count FROM ai_decisions").get()!.count
      const replayedDecision = await (await request("/v1/ai/jobs/" + job.id + "/decision", decisionBody)).json()
      assert.equal(replayedDecision.id, job.id)
      assert.equal(repo.db.prepare("SELECT COUNT(*) AS count FROM ai_decisions").get()!.count, decisionsBeforeReplay)
      const snapshot = await (await request("/v1/ai/jobs/" + job.id + "/sources")).json()
      assert.equal(snapshot.sources[0].text, "标签可见品牌，型号被遮挡")
      if (task.id === "project_summary") assert.deepEqual(snapshot.summaryScope, value.summaryScope)
      assert.throws(() => repo.get("other-owner", job.id))
    }
    invalid = true
    const failed = await (await request("/v1/ai/jobs", input())).json()
    assert.equal(failed.status, "failed")
    assert.equal((await request("/v1/ai/jobs/" + failed.id + "/decision", { decision: "accepted", correction: "" })).status, 409)
    assert.equal(repo.db.prepare("SELECT COUNT(*) AS count FROM ai_decisions").get()!.count, 7)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    repo.close()
  }
})

test("后台 AI 任务可取消结果写入，并按原资料显式重试", async () => {
  const repo = new Repository(":memory:")
  let calls = 0
  let firstAborted = false
  const server = createApi(repo, {
    model: "fake-background",
    async run(_value, _knowledge, signal) {
      calls++
      if (calls === 1) {
        return await new Promise((_, reject) => {
          signal?.addEventListener("abort", () => {
            firstAborted = true
            reject(new Error("aborted"))
          }, { once: true })
        })
      }
      return {
        output: materialResult(),
        providerRequestId: "retry-provider",
        responseModel: "fake-background"
      }
    }
  }, "b".repeat(32))
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address() as { port: number }
  const base = "http://127.0.0.1:" + address.port
  const request = (path: string, body?: unknown) => fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer " + "b".repeat(32), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  try {
    const startedResponse = await request("/v1/ai/jobs?async=1", {
      ...input(), requestId: "async-cancel"
    })
    assert.equal(startedResponse.status, 202)
    const started = await startedResponse.json()
    assert.equal(started.status, "running")

    const cancelled = await (await request(
      "/v1/ai/jobs/" + started.id + "/cancel", {}
    )).json()
    assert.equal(cancelled.status, "cancelled")
    assert.match(cancelled.error, /可能已开始并产生费用/)
    assert.equal(firstAborted, true)
    assert.equal((await request(
      "/v1/ai/jobs/" + started.id + "/decision",
      { decision: "dismissed", correction: "" }
    )).status, 409)

    const retryResponse = await request("/v1/ai/jobs/" + started.id + "/retry", {})
    assert.equal(retryResponse.status, 202)
    let retried = await retryResponse.json()
    assert.notEqual(retried.id, started.id)
    assert.equal(retried.retryOfJobId, started.id)
    for (let attempt = 0; retried.status === "running" && attempt < 50; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      retried = await (await request("/v1/ai/jobs/" + retried.id)).json()
    }
    assert.equal(retried.status, "succeeded")
    assert.equal(retried.result.materialCheck.receiptSourceId, "receipt1")
    assert.ok(retried.finishedAt)
    assert.equal((await (await request("/v1/ai/jobs/" + started.id)).json()).status, "cancelled")
    assert.deepEqual(
      (await (await request("/v1/ai/jobs/" + retried.id + "/sources")).json()).sources,
      input().sources
    )
    assert.equal((await request("/v1/ai/jobs/" + retried.id + "/retry", {})).status, 409)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    repo.close()
  }
})

test("input rejects missing images and model rejects invented references or action fields", () => {
  assert.throws(() => validateInput(input("image_observation")))
  assert.throws(() => validateInput({ ...input(), images: [{ sourceId: "r1", dataUrl: "data:image/png;base64,YWJj" }] }))
  assert.throws(() => validateResult({ ...recordReviewResult(), approvePayment: true }, input("record_review")))
  assert.throws(() => validateResult({
    ...recordReviewResult(), observations: [{ text: "无依据", sourceIds: ["different"] }]
  }, input("record_review")))
})

test("record review and image observation use strict task contracts", () => {
  const recordInput = input("record_review")
  assert.deepEqual(validateResult(recordReviewResult(), recordInput), recordReviewResult())
  const inventedFact = structuredClone(recordReviewResult())
  inventedFact.recordReview!.facts[0].sourceIds = ["not_selected"]
  assert.throws(() => validateResult(inventedFact, recordInput))
  const guessedDate = structuredClone(recordReviewResult())
  guessedDate.recordReview!.time = {
    originalExpression: "昨天",
    candidateDate: "2026-02-30",
    sourceIds: ["r1"],
    note: ""
  }
  assert.throws(() => validateResult(guessedDate, recordInput))

  const imageInput = input("image_observation")
  imageInput.images = [{
    id: "image1",
    sourceId: "r1",
    dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
  }]
  assert.deepEqual(validateInput(imageInput), imageInput)
  assert.deepEqual(validateResult(imageObservationResult(), imageInput), imageObservationResult())
  const outOfBounds = structuredClone(imageObservationResult())
  outOfBounds.imageObservation!.items[0].region = { x: 0.9, y: 0.1, width: 0.2, height: 0.2 }
  assert.throws(() => validateResult(outOfBounds, imageInput))
  const wrongImage = structuredClone(imageObservationResult())
  wrongImage.imageObservation!.items[0].imageId = "invented_image"
  assert.throws(() => validateResult(wrongImage, imageInput))
  const missingCoverage = structuredClone(imageObservationResult())
  missingCoverage.imageObservation!.images = []
  assert.throws(() => validateResult(missingCoverage, imageInput))
})

test("rectification and consultation require explicit modes, targets and strict contracts", () => {
  const proposalInput = input("rectification")
  assert.deepEqual(validateInput(proposalInput), proposalInput)
  assert.deepEqual(validateResult(rectificationProposalResult(), proposalInput), rectificationProposalResult())
  assert.throws(() => validateInput({ ...proposalInput, mode: undefined }))
  assert.throws(() => validateInput({ ...proposalInput, target: undefined }))
  const inventedProposalSource = structuredClone(rectificationProposalResult())
  if (inventedProposalSource.rectification?.mode === "proposal") {
    inventedProposalSource.rectification.proposals[0].sourceIds = ["not_selected"]
  }
  assert.throws(() => validateResult(inventedProposalSource, proposalInput))

  const reviewInput: AiInput = {
    ...input("rectification"),
    requestId: "rectification-review",
    mode: "review"
  }
  assert.deepEqual(validateResult(rectificationReviewResult(), reviewInput), rectificationReviewResult())
  const unsupportedReview = structuredClone(rectificationReviewResult())
  if (unsupportedReview.rectification?.mode === "review") {
    unsupportedReview.rectification.checks[0].limitations = []
  }
  assert.throws(() => validateResult(unsupportedReview, reviewInput))

  const prepareInput = input("consultation")
  assert.deepEqual(validateInput(prepareInput), prepareInput)
  assert.deepEqual(validateResult(consultationPrepareResult(), prepareInput), consultationPrepareResult())
  const responseInput: AiInput = {
    ...input("consultation"),
    requestId: "consultation-response",
    mode: "response",
    target: { kind: "consultation", id: "consultation1", version: "2" }
  }
  assert.deepEqual(validateInput(responseInput), responseInput)
  assert.deepEqual(validateResult(consultationResponseResult(), responseInput), consultationResponseResult())
  const wrongResponse = structuredClone(responseInput)
  wrongResponse.sources = wrongResponse.sources.map(source =>
    source.kind === "consultation_response"
      ? { ...source, relatedConsultationId: "another_consultation" }
      : source)
  assert.throws(() => validateInput(wrongResponse))
  const inventedIssue = structuredClone(consultationResponseResult())
  if (inventedIssue.consultation?.mode === "response") {
    inventedIssue.consultation.mappings[0].targetIssueSourceId = "not_selected"
  }
  assert.throws(() => validateResult(inventedIssue, responseInput))

  const proposalReview = {
    mode: "proposal" as const,
    items: [{
      optionId: "option1", included: true, title: "补拍后再核对",
      content: "移开遮挡并垂直补拍型号区域"
    }],
    note: ""
  }
  assert.deepEqual(
    validateRectificationReview(proposalReview, rectificationProposalResult()),
    proposalReview
  )
  assert.throws(() => validateRectificationReview({
    ...proposalReview,
    items: [{ ...proposalReview.items[0], content: "" }]
  }, rectificationProposalResult()))
  const responseReview = {
    mode: "response" as const,
    mappings: [{
      mappingId: "mapping1", disposition: "proposal" as const, status: "answered" as const,
      summary: "建议补拍完整标签", conditions: ["包装仍在现场"], conflicts: [],
      followUps: [], targetIssueSourceId: "issue1", proposalContent: "补拍完整标签后核对"
    }],
    note: ""
  }
  assert.deepEqual(
    validateConsultationReview(responseReview, consultationResponseResult(), new Set(["issue1"])),
    responseReview
  )
  assert.throws(() => validateConsultationReview(
    responseReview,
    consultationResponseResult(),
    new Set()
  ))
})

test("budget contract extracts parameters only and human review confirms calculation inputs", () => {
  const budgetInput = input("budget")
  assert.deepEqual(validateResult(budgetResult(), budgetInput), budgetResult())
  assert.deepEqual(validateBudgetReview(budgetHumanReview(), budgetResult()), budgetHumanReview())

  const inventedAmount = structuredClone(budgetResult()) as AiResult & {
    budget: NonNullable<AiResult["budget"]> & { amountFen?: number }
  }
  inventedAmount.budget.amountFen = 1000
  assert.throws(() => validateResult(inventedAmount, budgetInput))

  const unknownWithValue = structuredClone(budgetResult())
  unknownWithValue.budget!.scenarios[0].packageUnitPriceYuan.value = "99"
  assert.throws(() => validateResult(unknownWithValue, budgetInput))

  const ungroundedObserved = structuredClone(budgetResult())
  ungroundedObserved.budget!.scenarios[0].requiredQuantity.sourceIds = []
  assert.throws(() => validateResult(ungroundedObserved, budgetInput))

  const missingRequired = structuredClone(budgetHumanReview())
  missingRequired.scenarios[0].requiredQuantity = ""
  assert.throws(() => validateBudgetReview(missingRequired, budgetResult()))

  const explicitZeroPrice = structuredClone(budgetHumanReview())
  explicitZeroPrice.scenarios[0].packageUnitPriceYuan = "0"
  assert.deepEqual(validateBudgetReview(explicitZeroPrice, budgetResult()), explicitZeroPrice)
})

test("project summary fixes scope, requires five sourced sections and keeps human edits explicit", () => {
  const summaryInput = input("project_summary")
  assert.deepEqual(validateInput(summaryInput), summaryInput)
  assert.deepEqual(validateResult(projectSummaryResult(), summaryInput), projectSummaryResult())
  assert.deepEqual(
    validateProjectSummaryReview(projectSummaryHumanReview(), projectSummaryResult()),
    projectSummaryHumanReview()
  )

  assert.throws(() => validateInput({ ...summaryInput, summaryScope: undefined }))
  assert.throws(() => validateInput({
    ...summaryInput,
    summaryScope: { ...summaryInput.summaryScope!, dateFrom: "2026-09-29" }
  }))
  const invented = structuredClone(projectSummaryResult())
  invented.projectSummary!.sections[0].items[0].sourceIds = ["not_selected"]
  assert.throws(() => validateResult(invented, summaryInput))
  const missingHandoffSource = structuredClone(projectSummaryResult())
  missingHandoffSource.projectSummary!.handoff[0].sourceIds = []
  assert.throws(() => validateResult(missingHandoffSource, summaryInput))
  const duplicateSection = structuredClone(projectSummaryResult())
  duplicateSection.projectSummary!.sections[4].key = "progress"
  assert.throws(() => validateResult(duplicateSection, summaryInput))
  const emptyReview = structuredClone(projectSummaryHumanReview())
  emptyReview.sections = emptyReview.sections.map(section => ({ ...section, included: false }))
  assert.throws(() => validateProjectSummaryReview(emptyReview, projectSummaryResult()))
})

test("material check requires one material and receipt plus four consistent core fields", () => {
  assert.throws(() => validateInput({
    ...input(), sources: input().sources.filter(source => source.kind !== "receipt")
  }))
  assert.throws(() => validateInput({
    ...input(), sources: input().sources.map(source => source.kind === "receipt"
      ? { ...source, relatedMaterialId: "another_material" }
      : source)
  }))
  assert.deepEqual(validateResult(materialResult(), input()), materialResult())
  assert.throws(() => validateResult(genericResult(), input()))
  assert.throws(() => validateResult({
    ...materialResult(),
    materialCheck: {
      ...materialResult().materialCheck,
      fields: materialResult().materialCheck!.fields.filter(field => field.key !== "model")
    }
  }, input()))
  const unapproved = input()
  unapproved.sources = unapproved.sources.map(source => source.kind === "agreement"
    ? { ...source, authority: "unapproved_agreement" }
    : source)
  assert.throws(() => validateResult(materialResult(), unapproved))
  const wrongAgreement = input()
  wrongAgreement.sources = wrongAgreement.sources.map(source => source.kind === "agreement"
    ? { ...source, relatedMaterialId: "another_material" }
    : source)
  assert.throws(() => validateResult(materialResult(), wrongAgreement))
  assert.throws(() => validateResult({
    ...materialResult(),
    materialCheck: {
      ...materialResult().materialCheck,
      fields: materialResult().materialCheck!.fields.map(field => field.key === "brand"
        ? { ...field, status: "observed_only", expectedValue: "示例牌", expectedSourceIds: ["agreement1"] }
        : field)
    }
  }, input()))
  const review = {
    fields: materialResult().materialCheck!.fields.map(field => ({
      key: field.key,
      observedValue: field.observedValue,
      expectedValue: field.expectedValue,
      status: field.status,
      note: field.note
    }))
  }
  assert.deepEqual(validateMaterialReview(review, materialResult()), review)
  const incomparable = structuredClone(materialResult())
  incomparable.materialCheck!.fields = incomparable.materialCheck!.fields.map(field => field.key === "quantity"
    ? {
      ...field,
      observedValue: "25 kg",
      expectedValue: "10 袋",
      status: "unknown",
      note: "缺少每袋重量，不能比较"
    }
    : field)
  assert.deepEqual(validateResult(incomparable, input()), incomparable)
  const incomparableReview = {
    fields: incomparable.materialCheck!.fields.map(field => ({
      key: field.key,
      observedValue: field.observedValue,
      expectedValue: field.expectedValue,
      status: field.status,
      note: field.note
    }))
  }
  assert.deepEqual(validateMaterialReview(incomparableReview, incomparable), incomparableReview)
  const occluded = structuredClone(materialResult())
  occluded.materialCheck!.fields = occluded.materialCheck!.fields.map(field => field.key === "model"
    ? {
      ...field,
      observedValue: "",
      expectedValue: "X8-PRO",
      status: "unknown",
      observedSourceIds: ["r1"],
      expectedSourceIds: ["agreement1"],
      note: "已检查标签照片，但型号被完全遮挡"
    }
    : field)
  assert.deepEqual(validateResult(occluded, input()), occluded)
  assert.throws(() => validateMaterialReview({
    fields: review.fields.map(field => field.key === "model"
      ? { ...field, status: "unknown", note: "", observedValue: "误填" }
      : field)
  }, materialResult()))
  assert.throws(() => validateResult({
    ...materialResult(),
    materialCheck: {
      ...materialResult().materialCheck,
      fields: materialResult().materialCheck!.fields.map(field => field.key === "model"
        ? {
          ...field,
          status: "expected_only",
          expectedValue: "采购记录中的型号",
          expectedSourceIds: ["m1"],
          note: ""
        }
        : field)
    }
  }, input()))
})

test("SQLite retains original snapshots and marks interrupted jobs without replay", () => {
  const dir = mkdtempSync(join(tmpdir(), "renovation-ai-"))
  try {
    const path = join(dir, "test.sqlite")
    const first = new Repository(path)
    const job = first.begin("owner", input(), "fake").job
    first.close()
    const second = new Repository(path)
    try {
      assert.equal(second.get("owner", job.id).status, "failed")
      assert.equal(second.sources("owner", job.id).sources[0].version, "1")
      assert.equal(second.begin("owner", input(), "fake").fresh, false)
    } finally { second.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("AI 项目日限额计入失败和重试任务且不会静默追加调用", () => {
  const repo = new Repository(":memory:")
  try {
    for (let index = 0; index < 20; index++) {
      const job = repo.begin("owner", {
        ...input(), requestId: "limited-" + index, projectId: "limited-project"
      }, "fake").job
      repo.finish(job.id, undefined, "模拟失败")
    }
    assert.throws(() => repo.begin("owner", {
      ...input(), requestId: "limited-overflow", projectId: "limited-project"
    }, "fake"), /今日已发起 20 次/)
  } finally { repo.close() }
})

test("provider uses JSON mode and sanitizes missing key/network errors", async () => {
  let called = false
  const fakeFetch: typeof fetch = async (_url, options) => {
    called = true
    const body = JSON.parse(String(options?.body))
    assert.equal(body.response_format.type, "json_object")
    assert.match(body.messages[0].content, /逐字段核对/)
    assert.match(body.messages[0].content, /禁止使用单数 sourceId/)
    assert.match(body.messages[0].content, /unknowns 的每一项只能是字符串/)
    assert.equal(body.thinking.type, "disabled")
    assert.equal(body.temperature, 0.1)
    return new Response(JSON.stringify({
      id: "provider-1",
      model: "deepseek-flash-current",
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify(materialResult()) } }],
      usage: {
        prompt_tokens: 120,
        prompt_cache_hit_tokens: 20,
        prompt_cache_miss_tokens: 100,
        completion_tokens: 40,
        total_tokens: 160,
        completion_tokens_details: { reasoning_tokens: 0 }
      }
    }))
  }
  await assert.rejects(deepSeekProvider("", "fake", fakeFetch).run(input(), []), /尚未配置/)
  assert.equal(called, false)
  assert.deepEqual(await deepSeekProvider("test-placeholder", "fake", fakeFetch).run(input(), []), {
    output: materialResult(),
    providerRequestId: "provider-1",
    responseModel: "deepseek-flash-current",
    usage: {
      promptTokens: 120,
      cacheHitPromptTokens: 20,
      cacheMissPromptTokens: 100,
      completionTokens: 40,
      totalTokens: 160,
      reasoningTokens: 0
    }
  })
  await assert.rejects(deepSeekProvider("test-placeholder", "fake", async () => {
    throw new Error("sensitive upstream error")
  }).run(input(), []), /模型请求失败或超时/)
  await assert.rejects(
    deepSeekProvider("test-placeholder", "fake", async () => new Response(JSON.stringify({
      id: "provider-invalid",
      model: "deepseek-flash-current",
      choices: [{ finish_reason: "stop", message: { content: "not-json" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }))).run(input(), []),
    (error: unknown) => {
      assert.equal(error instanceof ProviderRunFailure, true)
      const failure = error as ProviderRunFailure
      assert.equal(failure.providerRequestId, "provider-invalid")
      assert.equal(failure.usage?.totalTokens, 15)
      return true
    }
  )
})
