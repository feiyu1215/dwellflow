import assert from "node:assert/strict"
import test from "node:test"
import { ACTIVE_STATE_SCHEMA_KEY, V2_STATE_STORAGE_KEY } from "../miniprogram/core/state-migration.ts"

class MemoryStorage {
  values = new Map<string, unknown>()
  getStorageSync<T>(key: string): T { return structuredClone(this.values.get(key)) as T }
  setStorageSync(key: string, value: unknown): void { this.values.set(key, structuredClone(value)) }
  getStorageInfoSync() { return { currentSize: 1, limitSize: 10_240 } }
}

const storage = new MemoryStorage()
Object.defineProperty(globalThis, "wx", { configurable: true, value: storage })
const store = await import("../miniprogram/core/store.ts")

test("R8-2A 空间写入 v2、旧标签映射幂等且重启可读", () => {
  store.activateV2State()
  const base = store.loadState()
  const project = base.projects[0]
  store.saveState({
    ...base,
    records: [{
      id: "legacy-record", projectId: project.id, version: 1, title: "旧记录", note: "",
      room: " 主卧 ", stage: "水电", creatorName: "负责人",
      occurredAt: "2026-10-08T10:00:00.000Z", createdAt: "2026-10-08T10:00:00.000Z", attachments: []
    }]
  })
  const main = store.createSpace({ projectId: project.id, name: "主卧", kind: "bedroom" })
  const kitchen = store.createSpace({ projectId: project.id, name: "厨房", kind: "kitchen" })
  store.mapLegacyRoomLabel({ projectId: project.id, sourceLabel: "主卧", spaceId: main.id })
  store.mapLegacyRoomLabel({ projectId: project.id, sourceLabel: " 主卧 ", spaceId: main.id })
  const mapped = store.loadState()
  assert.equal(mapped.records[0].spaceId, main.id)
  assert.equal(mapped.legacyRoomMappings.length, 1)
  assert.equal(storage.values.get(ACTIVE_STATE_SCHEMA_KEY), "v2")
  assert.ok((storage.values.get(V2_STATE_STORAGE_KEY) as { state: { spaces: unknown[] } }).state.spaces.length === 2)

  store.saveState({ ...mapped, records: [...mapped.records, {
    id: "later-record", projectId: project.id, version: 1, title: "后续导入旧记录", note: "",
    room: "主卧", stage: "水电", creatorName: "负责人",
    occurredAt: "2026-10-08T11:00:00.000Z", createdAt: "2026-10-08T11:00:00.000Z", attachments: []
  }] })
  store.mapLegacyRoomLabel({ projectId: project.id, sourceLabel: "主卧", spaceId: main.id })
  const remapped = store.loadState()
  assert.equal(remapped.records.find(item => item.id === "later-record")?.spaceId, main.id)
  assert.equal(remapped.legacyRoomMappings.length, 1, "沿用已确认映射不应产生新版本")

  store.createSpaceRelation({ projectId: project.id, fromSpaceId: main.id, toSpaceId: kitchen.id,
    kind: "adjacent", directionHint: "none" })
  const stage = store.setSpaceStageStatus({ projectId: project.id, spaceId: main.id, stageId: "水电",
    status: "confirmed_complete", note: "负责人现场确认，证据待补", expectedVersion: 0 })
  assert.equal(stage.version, 1)
  assert.equal(store.loadState().spaceRelations.length, 1)

  const inactive = store.setSpaceActive(main.id, main.version, false)
  const afterInactive = store.loadState()
  assert.equal(inactive.status, "inactive")
  assert.equal(afterInactive.spaceRelations[0].status, "inactive")
  assert.equal(afterInactive.records[0].spaceId, main.id, "停用空间不应改写历史归属")
})

test("过期版本不能覆盖空间或阶段状态", () => {
  const state = store.loadState()
  const space = state.spaces.find(item => item.status === "active")!
  assert.throws(() => store.updateSpace({ spaceId: space.id, expectedVersion: 99, name: "新厨房",
    kind: "kitchen", participatesInTopology: true }), /已更新/)
  store.setSpaceStageStatus({ projectId: space.projectId, spaceId: space.id, stageId: "水电",
    status: "in_progress", note: "开始", expectedVersion: 0 })
  assert.throws(() => store.setSpaceStageStatus({ projectId: space.projectId, spaceId: space.id, stageId: "水电",
    status: "pending_review", note: "旧页面提交", expectedVersion: 0 }), /已更新/)
})
