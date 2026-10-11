import assert from "node:assert/strict"
import test from "node:test"
import {
  ACTIVE_STATE_SCHEMA_KEY,
  LEGACY_STATE_STORAGE_KEY,
  PRE_R8_EXPORT_REGISTRATION_KEY,
  R8_MIGRATION_JOURNAL_KEY,
  V2_STATE_STORAGE_KEY,
  executeR8StateMigration,
  type LocalStateV2Envelope,
  type R8MigrationJournal,
  type StateStorageWriter
} from "../miniprogram/core/state-migration.ts"

class MemoryStorage implements StateStorageWriter {
  readonly values: Map<string, unknown>
  readonly writes = new Map<string, number>()
  failOnKey?: string
  corruptV2Read = false

  constructor(entries: Array<[string, unknown]> = []) {
    this.values = new Map(entries)
  }

  getStorageSync<T>(key: string): T {
    if (key === V2_STATE_STORAGE_KEY && this.corruptV2Read && this.values.has(key)) {
      return { schema: "renovation-sync-local-v2", state: {} } as T
    }
    return structuredClone(this.values.get(key)) as T
  }

  setStorageSync(key: string, value: unknown): void {
    this.writes.set(key, (this.writes.get(key) || 0) + 1)
    if (this.failOnKey === key) throw new Error(`simulated write failure: ${key}`)
    this.values.set(key, structuredClone(value))
  }

  getStorageInfoSync() {
    return { currentSize: 1, limitSize: 10_240 }
  }
}

function legacyState(name = "旧项目") {
  return {
    currentProjectId: "project-a",
    projects: [{ id: "project-a", name, stage: "水电", status: "active" }],
    records: [],
    issues: [],
    members: []
  }
}

const fixedTimes = () => {
  let index = 0
  return () => `2026-10-08T10:00:0${Math.min(index++, 9)}.000Z`
}

test("迁移写入并二次读取 v2 后才切换指针，同时保留 v1", () => {
  const source = legacyState()
  const storage = new MemoryStorage([[LEGACY_STATE_STORAGE_KEY, source]])
  const result = executeR8StateMigration({
    storage,
    now: fixedTimes(),
    freshState: () => legacyState("新项目"),
    transformLegacyState: value => ({ ...(value as ReturnType<typeof legacyState>), migratedMarker: true })
  })

  assert.equal(result.status, "migrated")
  assert.equal(storage.values.get(ACTIVE_STATE_SCHEMA_KEY), "v2")
  assert.deepEqual(storage.values.get(LEGACY_STATE_STORAGE_KEY), source)
  const envelope = storage.values.get(V2_STATE_STORAGE_KEY) as LocalStateV2Envelope<Record<string, unknown>>
  assert.equal(envelope.state.migratedMarker, true)
  assert.equal((storage.values.get(R8_MIGRATION_JOURNAL_KEY) as R8MigrationJournal).status, "switched")
  assert.equal((storage.values.get(PRE_R8_EXPORT_REGISTRATION_KEY) as { sourceKey: string }).sourceKey, LEGACY_STATE_STORAGE_KEY)
})

test("相同来源重试幂等，已切换状态不重复写候选", () => {
  const storage = new MemoryStorage([[LEGACY_STATE_STORAGE_KEY, legacyState()]])
  const first = executeR8StateMigration({ storage, now: fixedTimes(), freshState: legacyState })
  const writesAfterFirst = storage.writes.get(V2_STATE_STORAGE_KEY)
  const second = executeR8StateMigration({ storage, now: fixedTimes(), freshState: legacyState })
  assert.equal(first.status, "migrated")
  assert.equal(second.status, "already_v2")
  assert.equal(storage.writes.get(V2_STATE_STORAGE_KEY), writesAfterFirst)
  assert.equal(second.migrationId, first.migrationId)
})

test("候选写入失败或二次读取损坏时不切换 v1 指针", () => {
  const writeFailure = new MemoryStorage([[LEGACY_STATE_STORAGE_KEY, legacyState()]])
  writeFailure.failOnKey = V2_STATE_STORAGE_KEY
  const failedWrite = executeR8StateMigration({ storage: writeFailure, now: fixedTimes(), freshState: legacyState })
  assert.equal(failedWrite.status, "blocked")
  assert.notEqual(writeFailure.values.get(ACTIVE_STATE_SCHEMA_KEY), "v2")

  const corruptRead = new MemoryStorage([[LEGACY_STATE_STORAGE_KEY, legacyState()]])
  corruptRead.corruptV2Read = true
  const failedRead = executeR8StateMigration({ storage: corruptRead, now: fixedTimes(), freshState: legacyState })
  assert.equal(failedRead.status, "blocked")
  assert.notEqual(corruptRead.values.get(ACTIVE_STATE_SCHEMA_KEY), "v2")
  assert.match(failedRead.errors[0], /二次读取校验失败/)
})

test("空间不足时留下失败日志但不写候选和指针", () => {
  const storage = new MemoryStorage([[LEGACY_STATE_STORAGE_KEY, legacyState()]])
  storage.getStorageInfoSync = () => ({ currentSize: 10, limitSize: 10 })
  const result = executeR8StateMigration({ storage, now: fixedTimes(), freshState: legacyState })
  assert.equal(result.status, "blocked")
  assert.equal(storage.values.has(V2_STATE_STORAGE_KEY), false)
  assert.notEqual(storage.values.get(ACTIVE_STATE_SCHEMA_KEY), "v2")
  assert.equal((storage.values.get(R8_MIGRATION_JOURNAL_KEY) as R8MigrationJournal).status, "failed")
})

test("在切指针前中断后复用已校验候选继续，不重复生成状态", () => {
  const storage = new MemoryStorage([[LEGACY_STATE_STORAGE_KEY, legacyState()]])
  storage.failOnKey = ACTIVE_STATE_SCHEMA_KEY
  const interrupted = executeR8StateMigration({ storage, now: fixedTimes(), freshState: legacyState })
  assert.equal(interrupted.status, "blocked")
  assert.equal(storage.values.has(V2_STATE_STORAGE_KEY), true)
  assert.notEqual(storage.values.get(ACTIVE_STATE_SCHEMA_KEY), "v2")
  const candidateWrites = storage.writes.get(V2_STATE_STORAGE_KEY)

  storage.failOnKey = undefined
  const resumed = executeR8StateMigration({ storage, now: fixedTimes(), freshState: legacyState })
  assert.equal(resumed.status, "migrated")
  assert.equal(storage.values.get(ACTIVE_STATE_SCHEMA_KEY), "v2")
  assert.equal(storage.writes.get(V2_STATE_STORAGE_KEY), candidateWrites)
})

test("新安装可直接建立 fresh-v2，普通读写随后只更新 v2", async () => {
  const storage = new MemoryStorage()
  Object.defineProperty(globalThis, "wx", { configurable: true, value: storage })
  const store = await import("../miniprogram/core/store.ts")
  const migration = store.activateV2State()
  assert.equal(migration.status, "migrated")
  assert.equal(storage.values.get(ACTIVE_STATE_SCHEMA_KEY), "v2")
  assert.equal(storage.values.has(LEGACY_STATE_STORAGE_KEY), false)

  const state = store.loadState()
  store.saveState({ ...state, projects: state.projects.map(project => ({ ...project, name: "v2 新名称" })) })
  assert.equal(store.loadState().projects[0].name, "v2 新名称")
  assert.equal(storage.values.has(LEGACY_STATE_STORAGE_KEY), false)
})

test("合法的零项目 v1 状态可以迁移，不被误判为数据损坏", () => {
  const emptyLegacy = { ...legacyState(), currentProjectId: "", projects: [] }
  const storage = new MemoryStorage([[LEGACY_STATE_STORAGE_KEY, emptyLegacy]])
  const result = executeR8StateMigration({ storage, now: fixedTimes(), freshState: legacyState })
  assert.equal(result.status, "migrated")
  const envelope = storage.values.get(V2_STATE_STORAGE_KEY) as LocalStateV2Envelope<typeof emptyLegacy>
  assert.deepEqual(envelope.state.projects, [])
})
