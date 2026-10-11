import test from "node:test"
import assert from "node:assert/strict"
import {
  OfflineDraftQueue,
  assertOfflineDraftAllowed,
  type DraftStorage,
  type OfflineDraft
} from "../miniprogram/core/offline-drafts.ts"

class MemoryDraftStorage implements DraftStorage {
  private drafts: OfflineDraft[] = []

  load(): OfflineDraft[] {
    return JSON.parse(JSON.stringify(this.drafts)) as OfflineDraft[]
  }

  save(drafts: OfflineDraft[]): void {
    this.drafts = JSON.parse(JSON.stringify(drafts)) as OfflineDraft[]
  }
}

function draftInput() {
  return {
    id: "draft-1",
    projectId: "project-1",
    commandType: "record.create",
    path: "/v1/projects/project-1/commands",
    method: "POST" as const,
    body: {
      requestId: "record-create-1",
      type: "record.create",
      payload: {
        id: "record-1",
        expectedVersion: 0,
        note: "断网期间记录的现场情况"
      }
    },
    attachmentFiles: [{
      id: "attachment-1",
      localPath: "wxfile://usr/renovation-drafts/draft-1/photo.jpg",
      fileName: "现场.jpg",
      mediaType: "image/jpeg",
      durable: true
    }]
  }
}

test("离线草稿在版本冲突和撤权时保留正文及持久附件", async () => {
  let tick = 0
  const queue = new OfflineDraftQueue(
    new MemoryDraftStorage(),
    () => "2026-09-25T10:00:0" + tick++ + ".000Z"
  )
  const created = queue.create(draftInput())
  assert.equal(created.status, "local")

  const conflicted = await queue.sync(created.id, async () => {
    throw {
      status: 409,
      code: "VERSION_CONFLICT",
      message: "云端版本已更新"
    }
  })
  assert.equal(conflicted.status, "conflict")
  assert.equal(conflicted.body.payload && (
    conflicted.body.payload as { note: string }
  ).note, "断网期间记录的现场情况")
  assert.equal(conflicted.attachmentFiles[0].durable, true)

  const denied = await queue.sync(created.id, async () => {
    throw {
      status: 404,
      code: "NOT_FOUND",
      message: "项目不存在或无权访问"
    }
  })
  assert.equal(denied.status, "permission_denied")
  assert.equal(queue.get(created.id)?.attachmentFiles.length, 1)

  const synced = await queue.sync(created.id, async draft => ({
    acceptedRequestId: draft.body.requestId
  }))
  assert.equal(synced.status, "synced")
  assert.deepEqual(synced.serverResult, {
    acceptedRequestId: "record-create-1"
  })
})

test("不可恢复临时文件和高影响决定不能进入离线队列", () => {
  const queue = new OfflineDraftQueue(new MemoryDraftStorage())
  assert.throws(
    () => queue.create({
      ...draftInput(),
      attachmentFiles: [{
        ...draftInput().attachmentFiles[0],
        durable: false,
        localPath: "wxfile://tmp/photo.jpg"
      }]
    }),
    /不能标记草稿可恢复/
  )
  for (const command of [
    "agreement.approve",
    "receipt.allocate",
    "cost.approval",
    "owner_transfer.accept"
  ]) {
    assert.throws(() => assertOfflineDraftAllowed(command), /必须联网/)
  }
  assert.doesNotThrow(() => assertOfflineDraftAllowed("issue.add_proposal"))
  assert.throws(
    () => queue.create({
      ...draftInput(),
      id: "mismatched-command",
      commandType: "record.create",
      body: {
        requestId: "hidden-approval",
        type: "cost.approval",
        payload: {}
      }
    }),
    /命令类型与提交内容不一致/
  )
})

test("小程序重启后将中断中的同步恢复为可重试失败状态", () => {
  const storage = new MemoryDraftStorage()
  storage.save([{
    ...draftInput(),
    status: "syncing",
    createdAt: "2026-09-25T10:00:00.000Z",
    updatedAt: "2026-09-25T10:00:01.000Z"
  }])
  const queue = new OfflineDraftQueue(
    storage,
    () => "2026-09-25T10:05:00.000Z"
  )
  const recovered = queue.get("draft-1")
  assert.equal(recovered?.status, "failed")
  assert.equal(recovered?.errorCode, "SYNC_INTERRUPTED")
  assert.equal(recovered?.attachmentFiles[0].durable, true)
})
