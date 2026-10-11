import assert from "node:assert/strict"
import test from "node:test"
import {
  ACTIVE_STATE_SCHEMA_KEY,
  LEGACY_STATE_STORAGE_KEY,
  V2_STATE_STORAGE_KEY,
  buildR8MigrationDryRun,
  createLocalStateV2Envelope,
  readActiveStateSelection,
  stateSourceFingerprint,
  validateLocalStateV2Envelope,
  type StateStorageReader
} from "../miniprogram/core/state-migration.ts"

class MemoryReader implements StateStorageReader {
  private readonly values: Map<string, unknown>

  constructor(values = new Map<string, unknown>()) {
    this.values = values
  }

  getStorageSync<T>(key: string): T {
    return this.values.get(key) as T
  }
}

function legacyState() {
  return {
    currentProjectId: "project_a",
    projects: [{ id: "project_a", name: "A", status: "active" }],
    projectLifecycleEvents: [],
    records: [{
      id: "record_a",
      projectId: "project_a",
      room: " 厨房 ",
      attachments: [
        { id: "attachment_ok", localPath: "wxfile://ok.jpg" },
        { id: "attachment_missing", localPath: "" }
      ]
    }],
    recordRevisions: [{ id: "revision_a", projectId: "project_a", room: "厨房", attachments: [] }],
    issues: [{ id: "issue_a", projectId: "project_a", room: "全屋" }],
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
    members: [{ id: "member_a", projectId: "project_a", scopes: ["records"] }],
    shares: [],
    consultations: [],
    consultationResponses: [],
    cameras: [{ id: "camera_a", projectId: "project_a", room: "厨房" }],
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

test("活动 schema 缺省读取 v1，但无效指针不会静默回退", () => {
  const state = legacyState()
  const v1 = readActiveStateSelection(new MemoryReader(new Map<string, unknown>([[LEGACY_STATE_STORAGE_KEY, state]])))
  assert.equal(v1.status, "ready")
  assert.equal(v1.effectiveSchema, "v1")

  const invalid = readActiveStateSelection(new MemoryReader(new Map<string, unknown>([
    [ACTIVE_STATE_SCHEMA_KEY, "v3"],
    [LEGACY_STATE_STORAGE_KEY, state]
  ])))
  assert.equal(invalid.status, "blocked")
  assert.equal(invalid.effectiveSchema, undefined)
  assert.match(invalid.errors[0], /阻止自动回退/)
})

test("v2 指针只接受完整 envelope，损坏状态不会回退为空项目", () => {
  const selection = readActiveStateSelection(new MemoryReader(new Map<string, unknown>([
    [ACTIVE_STATE_SCHEMA_KEY, "v2"],
    [LEGACY_STATE_STORAGE_KEY, legacyState()],
    [V2_STATE_STORAGE_KEY, { schema: "renovation-sync-local-v2", state: { projects: [] } }]
  ])))
  assert.equal(selection.status, "blocked")
  assert.equal(selection.requestedSchema, "v2")
  assert.ok(selection.errors.length >= 4)
})

test("迁移 dry-run 稳定归并房间候选并明确缺原件和旧权限", () => {
  const values = new Map<string, unknown>([[LEGACY_STATE_STORAGE_KEY, legacyState()]])
  const first = buildR8MigrationDryRun(new MemoryReader(values))
  const second = buildR8MigrationDryRun(new MemoryReader(values))

  assert.equal(first.status, "ready")
  assert.equal(first.canWriteCandidate, true)
  assert.equal(first.sourceFingerprint, second.sourceFingerprint)
  assert.equal(first.migrationIdCandidate, second.migrationIdCandidate)
  assert.deepEqual(first.spaceCandidates.map(item => [item.normalizedName, item.occurrenceCount]), [
    ["厨房", 3],
    ["全屋", 1]
  ])
  assert.equal(first.spaceCandidates.find(item => item.normalizedName === "全屋")?.participatesInTopology, false)
  assert.ok(first.findings.some(item => item.code === "missing_original" && !item.blocking))
  assert.ok(first.findings.some(item => item.code === "legacy_member_scope" && !item.blocking))
})

test("跨项目引用阻止生成 v2 候选", () => {
  const state = legacyState()
  state.records[0].projectId = "project_missing"
  const report = buildR8MigrationDryRun(new MemoryReader(new Map<string, unknown>([[LEGACY_STATE_STORAGE_KEY, state]])))
  assert.equal(report.status, "blocked")
  assert.equal(report.canWriteCandidate, false)
  assert.ok(report.findings.some(item => item.code === "cross_project_reference" && item.blocking))
})

test("v2 envelope 可独立创建和校验，R8-1A 不写入存储", () => {
  const state = legacyState()
  const fingerprint = stateSourceFingerprint(state)
  const envelope = createLocalStateV2Envelope({
    state,
    migrationId: "migration_test",
    migratedFrom: LEGACY_STATE_STORAGE_KEY,
    sourceFingerprint: fingerprint,
    migratedAt: "2026-10-08T00:00:00.000Z",
    validatedAt: "2026-10-08T00:00:01.000Z"
  })
  assert.deepEqual(validateLocalStateV2Envelope(envelope), [])
  assert.equal(envelope.state, state)

  const already = buildR8MigrationDryRun(new MemoryReader(new Map<string, unknown>([
    [ACTIVE_STATE_SCHEMA_KEY, "v2"],
    [V2_STATE_STORAGE_KEY, envelope]
  ])))
  assert.equal(already.status, "already_v2")
  assert.equal(already.canWriteCandidate, false)
})
