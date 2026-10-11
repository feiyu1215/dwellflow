import assert from "node:assert/strict"
import test from "node:test"

class MemoryStorage {
  values = new Map<string, unknown>()
  getStorageSync<T>(key: string): T { return structuredClone(this.values.get(key)) as T }
  setStorageSync(key: string, value: unknown): void { this.values.set(key, structuredClone(value)) }
  getStorageInfoSync() { return { currentSize: 1, limitSize: 10_240 } }
}

const storage = new MemoryStorage()
Object.defineProperty(globalThis, "wx", { configurable: true, value: storage })
const store = await import("../miniprogram/core/store.ts")
const sha = "b".repeat(64)

test("R8-2B 原件、关联、隐藏、复核与解除关联保持独立", () => {
  store.activateV2State()
  const project = store.loadState().projects[0]
  const registered = store.registerLocalEvidence({ projectId: project.id, origin: "manual_upload", category: "image",
    fileName: "现场.jpg", mediaType: "image/jpeg", localPath: "wxfile://evidence.jpg", sizeBytes: 120, sha256: sha })
  assert.equal(registered.asset.status, "ready")
  assert.equal(registered.link.target.type, "project")

  const duplicate = store.createEvidenceLink({ projectId: project.id, evidenceId: registered.asset.id,
    target: { type: "project", id: project.id }, relationKind: "original" })
  assert.equal(duplicate.id, registered.link.id)
  assert.equal(store.loadState().evidenceLinks.length, 1)

  const hidden = store.setEvidenceHidden(registered.asset.id, registered.asset.version, true)
  assert.equal(hidden.status, "hidden")
  const restored = store.setEvidenceHidden(hidden.id, hidden.version, false)
  assert.equal(restored.status, "ready")
  const failed = store.updateEvidenceIntegrity({ evidenceId: restored.id, expectedVersion: restored.version,
    inspection: { sizeBytes: 121, sha256: sha } })
  assert.equal(failed.status, "failed")
  assert.equal(failed.failureCode, "size_mismatch")
  const ready = store.updateEvidenceIntegrity({ evidenceId: failed.id, expectedVersion: failed.version,
    inspection: { sizeBytes: 120, sha256: sha } })
  assert.equal(ready.status, "ready")

  assert.throws(() => store.removeEvidenceLink(registered.link.id, registered.link.version), /来源关联/)
  const supporting = store.createEvidenceLink({ projectId: project.id, evidenceId: registered.asset.id,
    target: { type: "project", id: project.id }, relationKind: "supporting" })
  const removed = store.removeEvidenceLink(supporting.id, supporting.version)
  assert.equal(removed.status, "removed")
  assert.ok(store.loadState().evidenceAssets.some(item => item.id === registered.asset.id), "解除关联不能删除原件")
})

test("旧附件缺失仍登记 missing，重复登记不重复资产或关联", () => {
  const state = store.loadState()
  const project = state.projects[0]
  store.saveState({ ...state, records: [{ id: "r1", projectId: project.id, version: 1, title: "旧现场", note: "",
    room: "厨房", stage: "水电", creatorName: "负责人", occurredAt: "2026-10-09T08:00:00.000Z",
    createdAt: "2026-10-09T08:00:00.000Z", attachments: [{ id: "old-a", name: "旧图.jpg", type: "image", localPath: "wxfile://missing.jpg" }] }] })
  const first = store.registerLegacyAttachmentEvidence({ projectId: project.id, sourceType: "record", sourceId: "r1",
    attachmentId: "old-a" })
  assert.equal(first.asset.status, "missing")
  const linkCountAfterFirst = store.loadState().evidenceLinks
    .filter(item => item.evidenceId === first.asset.id && item.status === "active").length
  const second = store.registerLegacyAttachmentEvidence({ projectId: project.id, sourceType: "record", sourceId: "r1",
    attachmentId: "old-a" })
  assert.equal(second.asset.id, first.asset.id)
  assert.equal(second.link.id, first.link.id)
  const after = store.loadState()
  assert.equal(after.evidenceAssets.filter(item => item.sourceAttachmentId === "old-a").length, 1)
  assert.equal(after.evidenceLinks.filter(item => item.evidenceId === first.asset.id && item.status === "active").length,
    linkCountAfterFirst, "重复登记不应增加记录及其历史版本的关联")
})

test("过期版本和跨项目目标不能覆盖证据状态", () => {
  const state = store.loadState()
  const evidence = state.evidenceAssets[0]
  assert.throws(() => store.updateEvidenceIntegrity({ evidenceId: evidence.id, expectedVersion: 99,
    inspection: { sizeBytes: evidence.actualSizeBytes || 0, sha256: evidence.actualSha256 || sha } }), /已更新/)
  assert.throws(() => store.createEvidenceLink({ projectId: evidence.projectId, evidenceId: evidence.id,
    target: { type: "record", id: "not-in-project" }, relationKind: "supporting" }), /目标不存在/)
})
