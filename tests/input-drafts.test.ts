import assert from "node:assert/strict"
import test from "node:test"
import {
  RecordInputDraftRepository,
  type RecordInputDraft,
  type RecordInputDraftStorage
} from "../miniprogram/core/input-drafts.ts"

class MemoryDraftStorage implements RecordInputDraftStorage {
  drafts: RecordInputDraft[] = []
  load() { return this.drafts.map(item => ({ ...item })) }
  save(drafts: RecordInputDraft[]) { this.drafts = drafts.map(item => ({ ...item })) }
}

const editing = {
  id: "draft_a",
  projectId: "project_a",
  originalText: "厨房水管已经到场。包装型号还需要核对。",
  occurredDate: "2026-10-12",
  room: "厨房",
  spaceId: "space_kitchen",
  stage: "水电" as const,
  origin: "origin-a"
}

test("录入草稿从编辑进入核对并保留原始文字", () => {
  const storage = new MemoryDraftStorage()
  const times = [
    "2026-10-12T08:00:00.000Z",
    "2026-10-12T08:01:00.000Z"
  ]
  const repository = new RecordInputDraftRepository(storage, () => times.shift()!)

  const saved = repository.saveEditing(editing)
  assert.equal(saved.status, "editing")
  assert.equal(saved.revision, 1)
  assert.equal(saved.note, editing.originalText)

  const review = repository.prepareReview(saved.id, saved.projectId)
  assert.equal(review.status, "review")
  assert.equal(review.revision, 2)
  assert.equal(review.title, "厨房水管已经到场")
  assert.equal(review.originalText, editing.originalText)
})

test("草稿按项目隔离且只恢复本项目最近的未完成草稿", () => {
  const storage = new MemoryDraftStorage()
  let tick = 0
  const repository = new RecordInputDraftRepository(
    storage,
    () => `2026-10-12T08:00:0${tick++}.000Z`
  )
  repository.saveEditing(editing)
  repository.saveEditing({ ...editing, id: "draft_b", projectId: "project_b", originalText: "另一个房子的记录" })
  repository.saveEditing({ ...editing, id: "draft_c", originalText: "厨房第二条记录" })

  assert.equal(repository.latestOpen("project_a")?.id, "draft_c")
  assert.equal(repository.latestOpen("project_b")?.id, "draft_b")
  assert.equal(repository.getForProject("draft_b", "project_a"), undefined)
  assert.throws(
    () => repository.updateReview({
      id: "draft_b",
      projectId: "project_a",
      title: "越权",
      note: "不应允许",
      occurredDate: "2026-10-12",
      room: "厨房",
      stage: "水电"
    }),
    /不属于当前项目/
  )
})

test("正式记录保存后写入回执且不再作为待恢复草稿", () => {
  const storage = new MemoryDraftStorage()
  const repository = new RecordInputDraftRepository(storage, () => "2026-10-12T08:00:00.000Z")
  repository.saveEditing(editing)
  const receipt = repository.markSaved("draft_a", "project_a", "record_1")

  assert.equal(receipt.status, "saved")
  assert.equal(receipt.savedRecordId, "record_1")
  assert.equal(repository.latestOpen("project_a"), undefined)
})

test("空描述和超长描述不能进入草稿仓库", () => {
  const repository = new RecordInputDraftRepository(new MemoryDraftStorage())
  assert.throws(() => repository.saveEditing({ ...editing, originalText: "  " }), /先描述/)
  assert.throws(() => repository.saveEditing({ ...editing, originalText: "字".repeat(5001) }), /过长/)
})
