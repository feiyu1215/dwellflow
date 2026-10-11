import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import type { AppState } from "../miniprogram/core/domain.ts"
import {
  buildPortableReports,
  createFullBackupPlan,
  createLimitedReadPlan,
  finalizePortablePackage,
  hydrateRestorableBundle,
  parsePortablePackage,
  portablePlanContentPreview,
  renderPortableHtml
} from "../miniprogram/core/portable-package.ts"

const timestamp = "2026-09-26T08:00:00.000Z"

function emptyState(): AppState {
  return {
    currentProjectId: "project-a",
    projects: [{
      id: "project-a",
      name: "测试项目",
      stage: "水电",
      ownerName: "项目负责人",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp
    }, {
      id: "project-private",
      name: "私密项目",
      stage: "泥瓦",
      ownerName: "项目负责人",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp
    }],
    projectLifecycleEvents: [],
    spaces: [],
    spaceRelations: [],
    spaceStageStates: [],
    legacyRoomMappings: [],
    evidenceAssets: [],
    evidenceLinks: [],
    records: [],
    recordRevisions: [],
    issues: [],
    issueWorkflows: [],
    materials: [],
    inventory: [],
    expenses: [],
    agreements: [],
    purchaseLines: [],
    receiptBatches: [],
    unitConversions: [],
    materialInventoryEvents: [],
    materialUsageRecords: [],
    costItems: [],
    costApprovals: [],
    paymentFacts: [],
    refundFacts: [],
    members: [],
    shares: [],
    consultations: [],
    consultationResponses: [],
    cameras: [],
    analyses: [],
    materialChecks: [],
    recordReviewApplications: [],
    imageObservationApplications: [],
    rectificationApplications: [],
    consultationApplications: [],
    budgetEstimateApplications: [],
    projectSummaryApplications: []
  }
}

function fullBundle(): string {
  const state = emptyState()
  const attachment = {
    id: "attachment-1",
    name: "现场<script>alert(1)</script>.jpg",
    type: "image" as const,
    localPath: "wxfile://private-device-path/photo.jpg"
  }
  state.records.push({
    id: "record-1",
    projectId: "project-a",
    version: 2,
    title: "=SUM(1,1)",
    note: "现场记录",
    room: "厨房",
    stage: "水电",
    creatorName: "项目负责人",
    occurredAt: timestamp,
    createdAt: timestamp,
    attachments: [attachment]
  })
  state.recordRevisions.push({
    ...state.records[0],
    id: "revision-1",
    recordId: "record-1",
    version: 1,
    changeReason: "初始记录",
    attachments: [{ ...attachment }]
  })
  state.materials.push({
    id: "material-1", projectId: "project-a", name: "电线", specification: "2.5 平方",
    unit: "卷", plannedQuantity: 10, createdAt: timestamp
  })
  state.purchaseLines.push({
    id: "purchase-1", projectId: "project-a", materialId: "material-1",
    orderedQuantityMilli: 10000, unit: "卷", status: "ordered", createdAt: timestamp
  })
  state.receiptBatches.push({
    id: "receipt-1", projectId: "project-a", purchaseLineId: "purchase-1", materialId: "material-1",
    unit: "卷", occurredAt: timestamp, version: 1,
    quantityEvents: [{
      id: "quantity-1", requestId: "request-1", kind: "submitted", quantityMilli: 9000,
      actorId: "owner", createdAt: timestamp
    }],
    allocationEvents: []
  })
  state.materialChecks.push({
    id: "material-check-1", projectId: "project-a", materialId: "material-1",
    receiptBatchId: "receipt-1", aiJobId: "ai-job-1", model: "fake-vision",
    promptVersion: "prompt-1", summary: "数量少 1 卷，型号待补拍",
    originalResult: {
      materialSourceId: "material-1", receiptSourceId: "receipt-1",
      fields: [
        { key: "brand", label: "品牌", observedValue: "", expectedValue: "", status: "unknown", observedSourceIds: [], expectedSourceIds: [], note: "未看清" },
        { key: "model", label: "型号", observedValue: "", expectedValue: "", status: "unknown", observedSourceIds: [], expectedSourceIds: [], note: "未看清" },
        { key: "specification", label: "规格", observedValue: "2.5 平方", expectedValue: "", status: "observed_only", observedSourceIds: ["record-1"], expectedSourceIds: [], note: "" },
        { key: "quantity", label: "数量", observedValue: "9 卷", expectedValue: "", status: "observed_only", observedSourceIds: ["receipt-1"], expectedSourceIds: [], note: "" }
      ]
    },
    review: {
      fields: [
        { key: "brand", observedValue: "", expectedValue: "", status: "unknown", note: "未看清" },
        { key: "model", observedValue: "", expectedValue: "", status: "unknown", note: "未看清" },
        { key: "specification", observedValue: "2.5 平方", expectedValue: "", status: "observed_only", note: "" },
        { key: "quantity", observedValue: "9 卷", expectedValue: "", status: "observed_only", note: "" }
      ]
    },
    confirmedBy: "项目负责人",
    confirmedAt: timestamp
  })
  const { projects, currentProjectId: _currentProjectId, ...collections } = state
  return JSON.stringify({
    schema: "renovation-sync-backup-v2",
    exportedAt: timestamp,
    project: projects[0],
    ...collections
  })
}

test("完整可移植包携带原始字节、去除设备路径并生成安全阅读页", () => {
  const plan = createFullBackupPlan({ rawBundle: fullBundle(), packageId: "package-1", createdAt: timestamp })
  assert.equal(plan.sources.length, 1, "历史版本引用同一原件时只携带一份字节")
  const bytes = Buffer.from("fake-jpeg-bytes")
  const digest = createHash("sha256").update(bytes).digest("hex")
  const pkg = finalizePortablePackage(plan, [{
    sourcePath: plan.sources[0].sourcePath,
    byteLength: bytes.length,
    sha256: digest,
    contentBase64: bytes.toString("base64")
  }])
  const serialized = JSON.stringify(pkg)
  assert.equal(pkg.manifest.restorable, true)
  assert.doesNotMatch(serialized, /wxfile:\/\/private-device-path/)
  assert.match(serialized, /renosync:\/\/attachments\/file_0001\.bin/)
  assert.match(pkg.reports["记录.csv"], /'=SUM\(1,1\)/)

  const checked = parsePortablePackage(serialized)
  const hydrated = hydrateRestorableBundle(checked, {
    "attachments/file_0001.bin": "wxfile://restored/attachment.bin"
  })
  assert.match(hydrated, /wxfile:\/\/restored\/attachment\.bin/)
  assert.doesNotMatch(hydrated, /private-device-path/)

  const html = renderPortableHtml(checked)
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(html, /关联：记录：=SUM\(1,1\)/)
  assert.doesNotMatch(html, /https?:\/\//)
  assert.ok(pkg.reports["记录历史.csv"])
  assert.ok(pkg.reports["约定.csv"])
  assert.ok(pkg.reports["咨询回复.csv"])
  assert.ok(pkg.reports["AI估算.csv"])
  assert.ok(pkg.reports["项目总结.csv"])
  assert.match(pkg.reports["材料核对.csv"], /数量少 1 卷|quantity/)
  assert.match(html, /材料到货核对/)
  assert.match(html, /9 卷/)
})

test("R8-2E 空间拓扑与一等证据可打包、阅读并恢复本地原件", () => {
  const bundle = JSON.parse(fullBundle()) as Record<string, unknown>
  bundle.spaces = [{
    id: "space-kitchen", projectId: "project-a", name: "厨房", kind: "kitchen", order: 1,
    participatesInTopology: true, status: "active", createdBy: { id: "owner", name: "负责人" },
    createdAt: timestamp, updatedAt: timestamp, version: 1
  }, {
    id: "space-balcony", projectId: "project-a", name: "阳台", kind: "balcony", order: 2,
    participatesInTopology: true, status: "active", createdBy: { id: "owner", name: "负责人" },
    createdAt: timestamp, updatedAt: timestamp, version: 1
  }]
  bundle.spaceRelations = [{
    id: "relation-1", projectId: "project-a", fromSpaceId: "space-kitchen", toSpaceId: "space-balcony",
    kind: "access", directionHint: "right", status: "active",
    confirmedBy: { id: "owner", name: "负责人" }, confirmedAt: timestamp,
    createdAt: timestamp, updatedAt: timestamp, version: 1
  }]
  bundle.evidenceAssets = [{
    id: "evidence-1", projectId: "project-a", origin: "photo_library", category: "image",
    fileName: "厨房水管原件.jpg", mediaType: "image/jpeg",
    storageRef: { kind: "local_file", localPath: "wxfile://evidence/kitchen.jpg" },
    occurredAt: timestamp, timeSource: "device", status: "ready",
    createdBy: { id: "owner", name: "负责人" }, createdAt: timestamp, updatedAt: timestamp, version: 1
  }]
  bundle.evidenceLinks = [{
    id: "evidence-link-1", projectId: "project-a", evidenceId: "evidence-1",
    target: { type: "record", id: "record-1", version: 2 }, relationKind: "original",
    spaceId: "space-kitchen", stageId: "水电", note: "水管走向原件", status: "active",
    createdBy: { id: "owner", name: "负责人" }, createdAt: timestamp, version: 1
  }]
  bundle.spaceStageStates = [{
    id: "space-stage-1", projectId: "project-a", spaceId: "space-kitchen", stageId: "水电",
    status: "pending_review", sourceEvidenceIds: ["evidence-1"], note: "等待负责人复查",
    updatedAt: timestamp, version: 1
  }]
  bundle.legacyRoomMappings = []

  const plan = createFullBackupPlan({ rawBundle: JSON.stringify(bundle), packageId: "package-r8", createdAt: timestamp })
  assert.equal(plan.sources.length, 2)
  assert.ok(plan.reports["空间与阶段.csv"])
  assert.ok(plan.reports["证据原件与关联.csv"])
  assert.match(plan.reports["空间与阶段.csv"], /厨房/)
  assert.match(plan.reports["证据原件与关联.csv"], /厨房水管原件\.jpg/)
  assert.ok(portablePlanContentPreview(plan).some(section => section.key === "spaces"))
  assert.ok(portablePlanContentPreview(plan).some(section => section.key === "evidenceAssets"))

  const results = plan.sources.map((source, index) => {
    const bytes = Buffer.from(index === 0 ? "legacy-record-image" : "r8-evidence-image")
    return {
      sourcePath: source.sourcePath,
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      contentBase64: bytes.toString("base64")
    }
  })
  const checked = parsePortablePackage(JSON.stringify(finalizePortablePackage(plan, results)))
  const localPaths = Object.fromEntries(checked.files.map((file, index) => [file.packagePath, `wxfile://restored/${index + 1}.bin`]))
  const hydrated = JSON.parse(hydrateRestorableBundle(checked, localPaths)) as Record<string, unknown>
  const evidence = (hydrated.evidenceAssets as Array<Record<string, unknown>>)[0]
  assert.match(JSON.stringify(evidence.storageRef), /wxfile:\/\/restored\//)
  assert.doesNotMatch(JSON.stringify(hydrated), /wxfile:\/\/evidence\/kitchen\.jpg/)
  const html = renderPortableHtml(checked)
  assert.match(html, /空间 × 阶段进度/)
  assert.match(html, /证据原件清单/)
  assert.match(html, /水管走向原件/)
  assert.match(html, /关联：证据原件：厨房水管原件\.jpg/)
})

test("离线阅读页明确展示约定、费用和咨询的版本化正文", () => {
  const plan = createFullBackupPlan({ rawBundle: fullBundle(), packageId: "package-rich-html", createdAt: timestamp })
  const bytes = Buffer.from("fake-jpeg-bytes")
  const pkg = finalizePortablePackage(plan, [{
    sourcePath: plan.sources[0].sourcePath,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentBase64: bytes.toString("base64")
  }])
  pkg.data.agreements = [{
    agreement: { id: "a", title: "瓷砖到货约定", subject: "material" },
    versions: [{ id: "av", revision: 2, status: "active", terms: [{ label: "色号", value: "暖灰 03" }], sourceIds: ["record-1"] }]
  }]
  pkg.data.costItems = [{ id: "c", title: "泥瓦人工", category: "labor", quotedAmountFen: 120000, note: "按节点结算", createdAt: timestamp }]
  pkg.data.costApprovals = [{ id: "ca", costItemId: "c", action: "initial", amountFen: 100000, reason: "负责人批准", createdAt: timestamp }]
  pkg.data.paymentFacts = [{ id: "p", costItemId: "c", status: "confirmed", amountFen: 50000, occurredAt: timestamp }]
  pkg.data.refundFacts = []
  pkg.data.consultations = [{
    id: "q",
    title: "请师傅确认空鼓",
    status: "published",
    versions: [{ id: "qv", revision: 1, status: "published", question: "这处是否需要返工？", knownFacts: ["已拍照"], gaps: ["未敲击"], answerQuestions: ["处理建议"] }]
  }]
  pkg.data.consultationResponses = [{
    id: "qr",
    respondentName: "王师傅",
    source: "manual_relay",
    channel: "电话",
    originalText: "建议现场复核",
    summary: "待复核",
    status: "pending",
    receivedAt: timestamp
  }]

  const html = renderPortableHtml(pkg)
  assert.match(html, /约定及版本/)
  assert.match(html, /暖灰 03/)
  assert.match(html, /费用、批准、付款与退款/)
  assert.match(html, /¥1200\.00/)
  assert.match(html, /对外咨询版本/)
  assert.match(html, /这处是否需要返工？/)
  assert.match(html, /咨询回复/)
  assert.match(html, /建议现场复核/)
})

test("缺失附件形成部分包且不能恢复", () => {
  const plan = createFullBackupPlan({ rawBundle: fullBundle(), packageId: "package-2", createdAt: timestamp })
  const pkg = finalizePortablePackage(plan, [{ sourcePath: plan.sources[0].sourcePath, error: "missing" }])
  assert.equal(pkg.manifest.status, "partial")
  assert.equal(pkg.manifest.restorable, false)
  assert.equal(pkg.missingFiles.length, 1)
  assert.throws(() => hydrateRestorableBundle(pkg, {}), /不包含完整可恢复项目/)
})

test("零字节附件保留为真实文件，CSV 对空白后的公式前缀做转义", () => {
  const plan = createFullBackupPlan({ rawBundle: fullBundle(), packageId: "package-empty", createdAt: timestamp })
  const emptyDigest = createHash("sha256").update(Buffer.alloc(0)).digest("hex")
  const pkg = finalizePortablePackage(plan, [{
    sourcePath: plan.sources[0].sourcePath,
    byteLength: 0,
    sha256: emptyDigest,
    contentBase64: ""
  }])
  assert.equal(pkg.files.length, 1)
  assert.equal(pkg.missingFiles.length, 0)
  assert.equal(parsePortablePackage(JSON.stringify(pkg)).files[0].byteLength, 0)

  const report = buildPortableReports({
    records: [{ id: "r", version: 1, title: " \t=SUM(1,1)", attachments: [] }]
  })["记录.csv"]
  assert.match(report, /' \t=SUM\(1,1\)/)
})

test("限定阅读只包含明确选择的项目资料", () => {
  const state = emptyState()
  state.records.push({
    id: "record-public",
    projectId: "project-a",
    version: 1,
    title: "公开现场记录",
    note: "可供外部查看",
    room: "厨房",
    stage: "水电",
    creatorName: "项目负责人",
    occurredAt: timestamp,
    createdAt: timestamp,
    attachments: []
  }, {
    id: "record-secret",
    projectId: "project-a",
    version: 1,
    title: "绝密合同哨兵",
    note: "不得外发",
    room: "全屋",
    stage: "水电",
    creatorName: "项目负责人",
    occurredAt: timestamp,
    createdAt: timestamp,
    attachments: []
  }, {
    id: "other-project-record",
    projectId: "project-private",
    version: 1,
    title: "另一个项目",
    note: "不得出现",
    room: "全屋",
    stage: "泥瓦",
    creatorName: "项目负责人",
    occurredAt: timestamp,
    createdAt: timestamp,
    attachments: []
  })
  state.issues.push({
    id: "issue-public",
    projectId: "project-a",
    title: "待核对",
    description: "仅引用未选择的私密记录",
    room: "厨房",
    stage: "水电",
    recordId: "record-secret",
    status: "pending_confirmation",
    proposals: [],
    createdAt: timestamp,
    updatedAt: timestamp
  })
  const plan = createLimitedReadPlan({
    state,
    projectId: "project-a",
    recordIds: ["record-public"],
    issueIds: ["issue-public"],
    packageId: "package-3",
    createdAt: timestamp
  })
  const serialized = JSON.stringify(finalizePortablePackage(plan, []))
  const preview = JSON.stringify(portablePlanContentPreview(plan))
  assert.match(serialized, /公开现场记录/)
  assert.match(serialized, /待核对/)
  assert.doesNotMatch(serialized, /绝密合同哨兵/)
  assert.doesNotMatch(serialized, /other-project-record/)
  assert.doesNotMatch(serialized, /record-secret/)
  assert.match(preview, /公开现场记录/)
  assert.match(preview, /可供外部查看/)
  assert.match(preview, /待核对/)
  assert.doesNotMatch(preview, /绝密合同哨兵/)
  assert.doesNotMatch(preview, /另一个项目/)
})

test("生成前正文预览明确标出展示上限且不影响实际导出范围", () => {
  const state = emptyState()
  for (let index = 0; index < 3; index += 1) {
    state.records.push({
      id: `record-preview-${index}`,
      projectId: "project-a",
      version: 1,
      title: `预览记录 ${index + 1}`,
      note: `正文 ${index + 1}`,
      room: "厨房",
      stage: "水电",
      creatorName: "项目负责人",
      occurredAt: timestamp,
      createdAt: timestamp,
      attachments: []
    })
  }
  const plan = createLimitedReadPlan({
    state,
    projectId: "project-a",
    recordIds: state.records.map(item => item.id),
    issueIds: [],
    packageId: "package-preview",
    createdAt: timestamp
  })
  const [section] = portablePlanContentPreview(plan, 2)
  assert.equal(section.totalCount, 3)
  assert.equal(section.shownCount, 2)
  assert.equal(section.omittedCount, 1)
  assert.match(JSON.stringify(plan.data), /预览记录 3/, "省略只影响页面预览，不裁剪实际导出数据")
})

test("导入预检拒绝大小、路径和状态矛盾", () => {
  const plan = createFullBackupPlan({ rawBundle: fullBundle(), packageId: "package-4", createdAt: timestamp })
  const bytes = Buffer.from("abc")
  const digest = createHash("sha256").update(bytes).digest("hex")
  const pkg = finalizePortablePackage(plan, [{
    sourcePath: plan.sources[0].sourcePath,
    byteLength: bytes.length,
    sha256: digest,
    contentBase64: bytes.toString("base64")
  }])
  const wrongSize = structuredClone(pkg)
  wrongSize.files[0].byteLength += 1
  assert.throws(() => parsePortablePackage(JSON.stringify(wrongSize)), /大小与清单/)

  const unsafePath = structuredClone(pkg)
  unsafePath.files[0].packagePath = "attachments/../escape.bin"
  assert.throws(() => parsePortablePackage(JSON.stringify(unsafePath)), /附件清单/)

  const contradictory = structuredClone(pkg)
  contradictory.manifest.status = "complete"
  contradictory.missingFiles.push({
    packagePath: "attachments/file_9999.bin",
    displayName: "缺失文件",
    reason: "missing",
    references: ["$.records[0]"]
  })
  assert.throws(() => parsePortablePackage(JSON.stringify(contradictory)), /完整状态与缺失清单矛盾/)
})

test("导入预检拒绝跨项目对象和断裂的业务关联", () => {
  const plan = createFullBackupPlan({ rawBundle: fullBundle(), packageId: "package-relations", createdAt: timestamp })
  const bytes = Buffer.from("abc")
  const pkg = finalizePortablePackage(plan, [{
    sourcePath: plan.sources[0].sourcePath,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentBase64: bytes.toString("base64")
  }])

  const orphanRevision = structuredClone(pkg)
  ;(orphanRevision.data.recordRevisions as Array<Record<string, unknown>>)[0].recordId = "missing-record"
  assert.throws(() => parsePortablePackage(JSON.stringify(orphanRevision)), /记录历史关联不存在/)

  const invalidVersion = structuredClone(pkg)
  ;(invalidVersion.data.records as Array<Record<string, unknown>>)[0].version = 0
  assert.throws(() => parsePortablePackage(JSON.stringify(invalidVersion)), /记录版本不正确/)

  const crossProject = structuredClone(pkg)
  ;(crossProject.data.records as Array<Record<string, unknown>>)[0].projectId = "another-project"
  assert.throws(() => parsePortablePackage(JSON.stringify(crossProject)), /records 不属于当前项目/)

  const brokenAgreement = structuredClone(pkg)
  ;(brokenAgreement.data.agreements as Array<Record<string, unknown>>).push({
    agreement: {
      id: "agreement-broken",
      projectId: "project-a",
      subject: "construction",
      title: "断裂约定",
      activeVersionId: "missing-version",
      version: 1
    },
    versions: []
  })
  assert.throws(() => parsePortablePackage(JSON.stringify(brokenAgreement)), /生效约定版本关联不存在/)

  const orphanRefund = structuredClone(pkg)
  ;(orphanRefund.data.refundFacts as Array<Record<string, unknown>>).push({
    id: "refund-broken",
    projectId: "project-a",
    costItemId: "missing-cost",
    paymentId: "missing-payment"
  })
  assert.throws(() => parsePortablePackage(JSON.stringify(orphanRefund)), /退款费用关联不存在/)

  const duplicateNestedEvent = structuredClone(pkg)
  ;(duplicateNestedEvent.data.materials as Array<Record<string, unknown>>).push({
    id: "material-duplicate-event",
    projectId: "project-a",
    name: "测试材料",
    specification: "",
    unit: "件",
    plannedQuantity: 1
  })
  ;(duplicateNestedEvent.data.receiptBatches as Array<Record<string, unknown>>).push({
    id: "receipt-duplicate-event",
    projectId: "project-a",
    materialId: "material-duplicate-event",
    unit: "件",
    version: 1,
    quantityEvents: [
      { id: "same-event", kind: "submitted", quantityMilli: 1000 },
      { id: "same-event", kind: "corrected", quantityMilli: 1000 }
    ],
    allocationEvents: []
  })
  assert.throws(() => parsePortablePackage(JSON.stringify(duplicateNestedEvent)), /到货数量事件 ID 不正确/)
})

test("导入预检拒绝异常深度的数据结构", () => {
  const plan = createFullBackupPlan({ rawBundle: fullBundle(), packageId: "package-depth", createdAt: timestamp })
  const bytes = Buffer.from("abc")
  const pkg = finalizePortablePackage(plan, [{
    sourcePath: plan.sources[0].sourcePath,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentBase64: bytes.toString("base64")
  }])
  const root: Record<string, unknown> = {}
  let cursor = root
  for (let index = 0; index < 70; index += 1) {
    const child: Record<string, unknown> = {}
    cursor.child = child
    cursor = child
  }
  ;(pkg.data.project as Record<string, unknown>).unexpectedDepth = root
  assert.throws(() => parsePortablePackage(JSON.stringify(pkg)), /嵌套层级过深/)
})
