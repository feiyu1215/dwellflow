import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

const storage = new Map<string, unknown>()
const files = new Map<string, Buffer>()
const directories = new Set<string>()
const blockedUnlinks = new Set<string>()
const sharedPaths: string[] = []
const TASKS_KEY = "renovation-sync-portable-tasks-v1"

function fail(option: { fail?: (result: { errMsg: string }) => void }, message: string): void {
  option.fail?.({ errMsg: message })
}

const fileSystem = {
  getFileInfo(option: {
    filePath: string
    success?: (result: { size: number; digest: string; errMsg: string }) => void
    fail?: (result: { errMsg: string }) => void
  }) {
    const content = files.get(option.filePath)
    if (!content) return fail(option, "getFileInfo:fail no such file")
    option.success?.({
      size: content.length,
      digest: createHash("sha256").update(content).digest("hex"),
      errMsg: "getFileInfo:ok"
    })
  },
  readFile(option: {
    filePath: string
    encoding?: string
    success?: (result: { data: string; errMsg: string }) => void
    fail?: (result: { errMsg: string }) => void
  }) {
    const content = files.get(option.filePath)
    if (!content) return fail(option, "readFile:fail no such file")
    option.success?.({
      data: option.encoding === "base64" ? content.toString("base64") : content.toString("utf8"),
      errMsg: "readFile:ok"
    })
  },
  writeFile(option: {
    filePath: string
    data: string
    encoding?: string
    success?: () => void
    fail?: (result: { errMsg: string }) => void
  }) {
    if (option.filePath.includes("write-failure")) return fail(option, "writeFile:fail simulated")
    files.set(option.filePath, option.encoding === "base64"
      ? Buffer.from(option.data, "base64")
      : Buffer.from(option.data, "utf8"))
    option.success?.()
  },
  mkdir(option: { dirPath: string; success?: () => void }) {
    directories.add(option.dirPath)
    option.success?.()
  },
  unlink(option: { filePath: string; success?: () => void; fail?: (result: { errMsg: string }) => void }) {
    if (blockedUnlinks.has(option.filePath)) return fail(option, "unlink:fail permission denied")
    if (!files.delete(option.filePath)) return fail(option, "unlink:fail no such file")
    option.success?.()
  },
  rmdir(option: { dirPath: string; success?: () => void }) {
    for (const path of [...files.keys()]) {
      if (path.startsWith(`${option.dirPath}/`)) files.delete(path)
    }
    directories.delete(option.dirPath)
    option.success?.()
  }
}

Object.assign(globalThis, {
  wx: {
    env: { USER_DATA_PATH: "wxfile://userdata" },
    getStorageSync<T>(key: string): T | undefined { return storage.get(key) as T | undefined },
    setStorageSync(key: string, value: unknown) { storage.set(key, structuredClone(value)) },
    getFileSystemManager: () => fileSystem,
    shareFileMessage: async (option: { filePath: string }) => {
      sharedPaths.push(option.filePath)
      return { errMsg: "shareFileMessage:ok" }
    }
  }
})

const store = await import("../miniprogram/core/store.ts")
const portableFiles = await import("../miniprogram/core/portable-files.ts")

test("平台适配生成可移植文件并恢复附件到只读新副本", async () => {
  storage.clear()
  files.clear()
  directories.clear()
  blockedUnlinks.clear()
  sharedPaths.length = 0
  const project = store.loadState().projects[0]
  const sourcePath = "wxfile://source/photo.jpg"
  const sourceBytes = Buffer.from("portable-original-image")
  files.set(sourcePath, sourceBytes)
  store.createRecord({
    projectId: project.id,
    title: "带原件的记录",
    note: "用于恢复验证",
    room: "厨房",
    stage: "水电",
    creatorName: "项目负责人",
    occurredAt: "2026-09-26T08:00:00.000Z",
    attachments: [{ id: "attachment-platform", name: "现场.jpg", type: "image", localPath: sourcePath }]
  })

  const plan = portableFiles.createFullPortablePlan(project.id)
  const inspection = await portableFiles.inspectPortablePlan(plan)
  assert.equal(inspection.availableCount, 1)
  assert.equal(inspection.missingCount, 0)

  const task = await portableFiles.generatePortableExport(plan)
  assert.equal(task.status, "complete")
  assert.equal(task.restorable, true)
  assert.ok(task.jsonPath && files.has(task.jsonPath))
  assert.ok(task.htmlPath && files.has(task.htmlPath))
  const exportFileCount = [...files.keys()].filter(path => path.includes("/exports/")).length
  const replayedTask = await portableFiles.generatePortableExport(plan)
  assert.equal(replayedTask.id, task.id)
  assert.equal([...files.keys()].filter(path => path.includes("/exports/")).length, exportFileCount)
  const conflictingPlan = structuredClone(plan)
  ;(conflictingPlan.data.records as Array<Record<string, unknown>>)[0].title = "被替换的导出范围"
  await assert.rejects(() => portableFiles.generatePortableExport(conflictingPlan), /同一资料包标识不能用于不同导出范围/)

  const imported = await portableFiles.readPortablePackageFile(task.jsonPath!)
  const restored = await portableFiles.restorePortablePackage(imported.pkg)
  assert.equal(restored.status, "archived")
  const projectCountAfterRestore = store.loadState().projects.length
  const restoredAgain = await portableFiles.restorePortablePackage(imported.pkg)
  assert.equal(restoredAgain.id, restored.id)
  assert.equal(store.loadState().projects.length, projectCountAfterRestore, "同一资料包重试不能创建第二个副本")
  assert.equal(portableFiles.hasRestoredPortablePackage(imported.pkg), true)
  const explicitCopy = await portableFiles.restorePortablePackage(imported.pkg, {
    restoreOperationId: `${imported.pkg.manifest.packageId}_copy_test`
  })
  assert.notEqual(explicitCopy.id, restored.id)
  assert.equal(store.loadState().projects.length, projectCountAfterRestore + 1)
  const explicitCopyRetry = await portableFiles.restorePortablePackage(imported.pkg, {
    restoreOperationId: `${imported.pkg.manifest.packageId}_copy_test`
  })
  assert.equal(explicitCopyRetry.id, explicitCopy.id, "明确再恢复的同一次操作仍需幂等")
  assert.equal(store.loadState().projects.length, projectCountAfterRestore + 1)
  const restoredRecord = store.loadState().records.find(item =>
    item.projectId === restored.id && item.title === "带原件的记录")!
  assert.notEqual(restoredRecord.attachments[0].localPath, sourcePath)
  assert.deepEqual(files.get(restoredRecord.attachments[0].localPath), sourceBytes)

  const conflictingPackage = structuredClone(imported.pkg)
  ;(conflictingPackage.data.project as Record<string, unknown>).name = "同标识的另一份内容"
  await assert.rejects(() => portableFiles.restorePortablePackage(conflictingPackage), /标识已被另一份内容使用/)
})

test("篡改附件的可移植包不会创建半项目并清理暂存文件", async () => {
  storage.clear()
  files.clear()
  directories.clear()
  blockedUnlinks.clear()
  sharedPaths.length = 0
  const project = store.loadState().projects[0]
  const sourcePath = "wxfile://source/tamper.jpg"
  files.set(sourcePath, Buffer.from("original"))
  store.createRecord({
    projectId: project.id,
    title: "篡改校验记录",
    note: "",
    room: "厨房",
    stage: "水电",
    creatorName: "项目负责人",
    occurredAt: "2026-09-26T08:00:00.000Z",
    attachments: [{ id: "attachment-tamper", name: "篡改.jpg", type: "image", localPath: sourcePath }]
  })
  const task = await portableFiles.generatePortableExport(portableFiles.createFullPortablePlan(project.id))
  const imported = await portableFiles.readPortablePackageFile(task.jsonPath!)
  imported.pkg.files[0].contentBase64 = Buffer.from("tampered").toString("base64")
  imported.pkg.files[0].byteLength = Buffer.from("tampered").length
  imported.pkg.manifest.totalBytes = imported.pkg.files[0].byteLength
  const projectCount = store.loadState().projects.length

  await assert.rejects(() => portableFiles.restorePortablePackage(imported.pkg), /原项目未被修改/)
  assert.equal(store.loadState().projects.length, projectCount)
  assert.equal([...files.keys()].some(path => path.includes("/restored-files/")), false)
})

test("读取任务不改写运行状态，只有应用启动恢复会标记中断且不截断历史", () => {
  storage.clear()
  const tasks = Array.from({ length: 25 }, (_, index) => ({
    id: `task-${index}`,
    projectId: "project-a",
    projectName: "测试项目",
    purpose: "full_backup" as const,
    status: index === 0 ? "generating" as const : "complete" as const,
    createdAt: timestampForTest(index),
    fileCount: 0,
    missingCount: 0,
    totalBytes: 0,
    restorable: false
  }))
  storage.set(TASKS_KEY, tasks)

  assert.equal(portableFiles.listPortableTasks()[0].status, "generating")
  assert.equal((storage.get(TASKS_KEY) as typeof tasks)[0].status, "generating")
  assert.equal(portableFiles.recoverInterruptedPortableTasks("2026-09-26T12:00:00.000Z"), 1)

  const recovered = portableFiles.listPortableTasks()
  assert.equal(recovered.length, 25)
  assert.equal(recovered[0].status, "failed")
  assert.equal(recovered[0].errorCode, "interrupted")
  assert.equal(recovered[0].finishedAt, "2026-09-26T12:00:00.000Z")
})

test("删除本机文件失败时保留任务，重试成功后再删除元数据", async () => {
  storage.clear()
  files.clear()
  blockedUnlinks.clear()
  const jsonPath = "wxfile://userdata/renovation-sync/exports/to-delete.renosync.json"
  const htmlPath = "wxfile://userdata/renovation-sync/exports/to-delete.html"
  files.set(jsonPath, Buffer.from("backup"))
  files.set(htmlPath, Buffer.from("reading page"))
  storage.set(TASKS_KEY, [{
    id: "task-delete",
    projectId: "project-a",
    projectName: "测试项目",
    purpose: "full_backup",
    status: "complete",
    createdAt: "2026-09-26T08:00:00.000Z",
    jsonPath,
    htmlPath,
    fileCount: 0,
    missingCount: 0,
    totalBytes: 0,
    restorable: true
  }])
  blockedUnlinks.add(htmlPath)

  await assert.rejects(() => portableFiles.deletePortableTask("task-delete"), /阅读页删除失败.*数据包已删除/)
  const [remainingTask] = portableFiles.listPortableTasks()
  assert.equal(remainingTask.jsonPath, undefined)
  assert.equal(remainingTask.htmlPath, htmlPath)
  assert.equal(files.has(jsonPath), false)
  assert.equal(files.has(htmlPath), true)

  blockedUnlinks.clear()
  await portableFiles.deletePortableTask("task-delete")
  assert.equal(portableFiles.listPortableTasks().length, 0)
  assert.equal(files.has(jsonPath), false)
  assert.equal(files.has(htmlPath), false)
})

test("发送前重新校验项目和本机文件", async () => {
  storage.clear()
  files.clear()
  sharedPaths.length = 0
  const project = store.loadState().projects[0]
  const htmlPath = "wxfile://userdata/renovation-sync/exports/share.html"
  storage.set(TASKS_KEY, [{
    id: "task-share",
    projectId: project.id,
    projectName: project.name,
    purpose: "limited_read",
    status: "complete",
    createdAt: "2026-09-26T08:00:00.000Z",
    htmlPath,
    fileCount: 0,
    missingCount: 0,
    totalBytes: 0,
    restorable: false
  }])

  await assert.rejects(() => portableFiles.sharePortableTask("task-share", "html"), /文件已缺失/)
  assert.equal(sharedPaths.length, 0)

  files.set(htmlPath, Buffer.from("<html></html>"))
  await portableFiles.sharePortableTask("task-share", "html")
  assert.deepEqual(sharedPaths, [htmlPath])

  store.trashProject(project.id, "测试发送前状态校验")
  await assert.rejects(() => portableFiles.sharePortableTask("task-share", "html"), /项目已不存在或在回收站/)
  assert.equal(sharedPaths.length, 1)
})

test("旧版备份恢复前区分可读路径和资料缺口", async () => {
  storage.clear()
  files.clear()
  const project = store.loadState().projects[0]
  const availablePath = "wxfile://legacy/available.jpg"
  const missingPath = "wxfile://legacy/missing.jpg"
  files.set(availablePath, Buffer.alloc(0))
  store.createRecord({
    projectId: project.id,
    title: "旧版路径检查",
    note: "",
    room: "厨房",
    stage: "水电",
    creatorName: "项目负责人",
    occurredAt: "2026-09-26T08:00:00.000Z",
    attachments: [
      { id: "legacy-a", name: "可读.jpg", type: "image", localPath: availablePath },
      { id: "legacy-b", name: "缺失.jpg", type: "image", localPath: missingPath }
    ]
  })

  const inspection = await portableFiles.inspectLegacyProjectBundle(store.exportProjectBundle(project.id))
  assert.equal(inspection.recordCount, 1)
  assert.equal(inspection.attachmentReferenceCount, 4, "当前记录与历史版本各保留一份附件引用")
  assert.equal(inspection.uniqueFileCount, 2)
  assert.equal(inspection.availableFileCount, 1)
  assert.equal(inspection.missingFileCount, 1)
  await assert.rejects(() => portableFiles.inspectLegacyProjectBundle("not-json"), /不是有效 JSON/)
})

function timestampForTest(index: number): string {
  return new Date(Date.UTC(2026, 8, 26, 8, index)).toISOString()
}
