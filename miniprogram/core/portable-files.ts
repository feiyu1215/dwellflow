import type { Project } from "./domain"
import {
  PORTABLE_MAX_FILES,
  PORTABLE_MAX_SOURCE_BYTES,
  createFullBackupPlan,
  createLimitedReadPlan,
  finalizePortablePackage,
  hydrateRestorableBundle,
  parsePortablePackage,
  portablePackageSummary,
  renderPortableHtml,
  type PortableExportPlan,
  type PortablePackage,
  type PortableReadResult,
  type PortablePurpose
} from "./portable-package"
import { exportProjectBundle, loadState, restoreProjectBundle } from "./store"

const TASKS_KEY = "renovation-sync-portable-tasks-v1"
const EXPORT_DIRECTORY = `${wx.env.USER_DATA_PATH}/renovation-sync/exports`
const RESTORE_DIRECTORY = `${wx.env.USER_DATA_PATH}/renovation-sync/restored-files`
const MAX_PACKAGE_BYTES = 48 * 1024 * 1024
const MAX_LEGACY_CHARACTERS = 8 * 1024 * 1024
const MAX_LEGACY_OBJECTS = 10_000
const MAX_LEGACY_DEPTH = 64

export interface PortableTask {
  id: string
  projectId: string
  projectName: string
  purpose: PortablePurpose
  status: "generating" | "complete" | "partial" | "failed"
  createdAt: string
  finishedAt?: string
  jsonPath?: string
  htmlPath?: string
  fileCount: number
  missingCount: number
  totalBytes: number
  restorable: boolean
  inputFingerprint?: string
  errorCode?: "generation_failed" | "interrupted"
}

export interface PortablePlanInspection {
  fileCount: number
  availableCount: number
  missingCount: number
  totalBytes: number
  overLimit: boolean
  items: Array<{
    name: string
    status: "available" | "missing" | "too_large"
    byteLength?: number
  }>
}

export interface LegacyBundleInspection {
  schema: "renovation-sync-backup-v1" | "renovation-sync-backup-v2"
  projectName: string
  recordCount: number
  issueCount: number
  attachmentReferenceCount: number
  uniqueFileCount: number
  availableFileCount: number
  missingFileCount: number
}

function taskId(): string {
  return `portable_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function safeFileStem(value: string): string {
  const stem = value.trim().replace(/[^A-Za-z0-9_\-\u4e00-\u9fff]/g, "_").slice(0, 32)
  return stem || "装修项目"
}

function textFingerprint(value: string): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `${value.length.toString(36)}-${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`
}

function planFingerprint(plan: PortableExportPlan): string {
  return textFingerprint(JSON.stringify({
    purpose: plan.purpose,
    projectId: plan.projectId,
    projectName: plan.projectName,
    createdAt: plan.createdAt,
    data: plan.data,
    sources: plan.sources,
    reports: plan.reports
  }))
}

function packageFingerprint(pkg: PortablePackage): string {
  return textFingerprint(JSON.stringify({
    manifest: pkg.manifest,
    data: pkg.data,
    reports: pkg.reports,
    files: pkg.files.map(file => ({
      packagePath: file.packagePath,
      displayName: file.displayName,
      attachmentType: file.attachmentType,
      byteLength: file.byteLength,
      sha256: file.sha256,
      references: file.references
    })),
    missingFiles: pkg.missingFiles
  }))
}

function existingRestoredProject(
  packageId: string,
  fingerprint: string,
  restoreOperationId: string
): Project | undefined {
  const projects = loadState().projects
  const conflictingSource = projects.find(item => item.restoredFromPackageId === packageId
    && item.restoredFromPackageFingerprint !== fingerprint)
  if (conflictingSource) throw new Error("资料包标识已被另一份内容使用，不能重复恢复")
  const existing = projects.find(item => item.restoreOperationId === restoreOperationId
    || (!item.restoreOperationId && item.restoredFromPackageId === restoreOperationId))
  if (!existing) return undefined
  if (existing.status === "trashed") throw new Error("该资料包已恢复过，副本目前在回收站中")
  return existing
}

export function hasRestoredPortablePackage(pkg: PortablePackage): boolean {
  const fingerprint = packageFingerprint(pkg)
  const matching = loadState().projects.filter(item => item.restoredFromPackageId === pkg.manifest.packageId)
  if (matching.some(item => item.restoredFromPackageFingerprint !== fingerprint)) {
    throw new Error("资料包标识已被另一份内容使用，不能重复恢复")
  }
  return matching.length > 0
}

function loadTasks(): PortableTask[] {
  const saved = wx.getStorageSync<PortableTask[]>(TASKS_KEY)
  return Array.isArray(saved) ? saved : []
}

function saveTasks(tasks: PortableTask[]): void {
  // Task metadata is the only durable reference to generated files. Silently
  // trimming it would leave files behind that the user can no longer remove.
  wx.setStorageSync(TASKS_KEY, tasks)
}

function putTask(task: PortableTask): void {
  const tasks = loadTasks()
  saveTasks([task, ...tasks.filter(item => item.id !== task.id)])
}

export function listPortableTasks(projectId?: string): PortableTask[] {
  const tasks = loadTasks()
  return projectId ? tasks.filter(item => item.projectId === projectId) : tasks
}

/**
 * A task can only be known to be interrupted after a new app process starts.
 * Page refreshes must not mutate an export that is still running.
 */
export function recoverInterruptedPortableTasks(finishedAt = new Date().toISOString()): number {
  let recoveredCount = 0
  const tasks = loadTasks().map(item => {
    if (item.status !== "generating") return item
    recoveredCount += 1
    return { ...item, status: "failed" as const, errorCode: "interrupted" as const, finishedAt }
  })
  if (recoveredCount) saveTasks(tasks)
  return recoveredCount
}

function getFileInfo(filePath: string): Promise<{ size: number; digest: string }> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().getFileInfo({
      filePath,
      digestAlgorithm: "sha256",
      success: result => resolve({ size: result.size, digest: result.digest.toLowerCase() }),
      fail: () => reject(new Error("file_unavailable"))
    })
  })
}

function readFile(filePath: string, encoding: "base64" | "utf8"): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      encoding,
      success: result => typeof result.data === "string"
        ? resolve(result.data)
        : reject(new Error("file_encoding_failed")),
      fail: () => reject(new Error("file_read_failed"))
    })
  })
}

function writeFile(filePath: string, data: string, encoding: "base64" | "utf8"): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().writeFile({
      filePath,
      data,
      encoding,
      success: () => resolve(),
      fail: () => reject(new Error("file_write_failed"))
    })
  })
}

function mkdir(directory: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().mkdir({
      dirPath: directory,
      recursive: true,
      success: () => resolve(),
      fail: result => result.errMsg.includes("exist") ? resolve() : reject(new Error("directory_create_failed"))
    })
  })
}

function isMissingFileError(message: string): boolean {
  return /no such file|not found|does not exist/i.test(message)
}

function unlinkFile(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().unlink({
      filePath,
      success: () => resolve(),
      fail: result => isMissingFileError(result.errMsg)
        ? resolve()
        : reject(new Error("file_delete_failed"))
    })
  })
}

function removeDirectory(directory: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().rmdir({
      dirPath: directory,
      recursive: true,
      success: () => resolve(),
      fail: result => isMissingFileError(result.errMsg)
        ? resolve()
        : reject(new Error("directory_delete_failed"))
    })
  })
}

function assertProjectExportable(projectId: string): Project {
  const project = loadState().projects.find(item => item.id === projectId)
  if (!project || project.status === "trashed") {
    throw new Error("项目已不存在或在回收站中，不能继续导出")
  }
  return project
}

export function createFullPortablePlan(projectId: string): PortableExportPlan {
  const createdAt = new Date().toISOString()
  return createFullBackupPlan({
    rawBundle: exportProjectBundle(projectId),
    packageId: taskId(),
    createdAt
  })
}

export function createLimitedPortablePlan(input: {
  projectId: string
  recordIds: string[]
  issueIds: string[]
}): PortableExportPlan {
  const createdAt = new Date().toISOString()
  return createLimitedReadPlan({
    state: loadState(),
    ...input,
    packageId: taskId(),
    createdAt
  })
}

export async function inspectPortablePlan(plan: PortableExportPlan): Promise<PortablePlanInspection> {
  if (plan.sources.length > PORTABLE_MAX_FILES) {
    throw new Error(`当前版本最多携带 ${PORTABLE_MAX_FILES} 个附件`)
  }
  const items: PortablePlanInspection["items"] = []
  let totalBytes = 0
  let availableCount = 0
  let missingCount = 0
  for (const source of plan.sources) {
    try {
      const info = await getFileInfo(source.sourcePath)
      totalBytes += info.size
      const tooLarge = totalBytes > PORTABLE_MAX_SOURCE_BYTES
      items.push({ name: source.displayName, status: tooLarge ? "too_large" : "available", byteLength: info.size })
      if (!tooLarge) availableCount += 1
    } catch {
      missingCount += 1
      items.push({ name: source.displayName, status: "missing" })
    }
  }
  return {
    fileCount: plan.sources.length,
    availableCount,
    missingCount,
    totalBytes,
    overLimit: totalBytes > PORTABLE_MAX_SOURCE_BYTES,
    items
  }
}

async function readSourceFiles(plan: PortableExportPlan): Promise<PortableReadResult[]> {
  if (plan.sources.length > PORTABLE_MAX_FILES) throw new Error("附件数量超过当前导出上限")
  const results: PortableReadResult[] = []
  let acceptedBytes = 0
  for (const source of plan.sources) {
    let before: { size: number; digest: string }
    try {
      before = await getFileInfo(source.sourcePath)
    } catch {
      results.push({ sourcePath: source.sourcePath, error: "missing" })
      continue
    }
    if (acceptedBytes + before.size > PORTABLE_MAX_SOURCE_BYTES) {
      results.push({ sourcePath: source.sourcePath, error: "too_large" })
      continue
    }
    try {
      const contentBase64 = await readFile(source.sourcePath, "base64")
      const after = await getFileInfo(source.sourcePath)
      if (before.size !== after.size || before.digest !== after.digest) {
        results.push({ sourcePath: source.sourcePath, error: "changed" })
        continue
      }
      acceptedBytes += after.size
      results.push({
        sourcePath: source.sourcePath,
        byteLength: after.size,
        sha256: after.digest,
        contentBase64
      })
    } catch {
      results.push({ sourcePath: source.sourcePath, error: "read_failed" })
    }
  }
  return results
}

export async function generatePortableExport(plan: PortableExportPlan): Promise<PortableTask> {
  const project = assertProjectExportable(plan.projectId)
  if (plan.projectName !== project.name) throw new Error("导出计划与当前项目不一致，请重新检查范围")
  const inputFingerprint = planFingerprint(plan)
  const existing = loadTasks().find(item => item.id === plan.packageId)
  if (existing?.inputFingerprint && existing.inputFingerprint !== inputFingerprint) {
    throw new Error("同一资料包标识不能用于不同导出范围，请重新检查")
  }
  if (existing?.status === "complete" || existing?.status === "partial") return existing
  if (existing?.status === "generating") throw new Error("同一资料包正在生成，请勿重复提交")
  const task: PortableTask = {
    id: plan.packageId,
    projectId: plan.projectId,
    projectName: plan.projectName,
    purpose: plan.purpose,
    status: "generating",
    createdAt: plan.createdAt,
    fileCount: 0,
    missingCount: 0,
    totalBytes: 0,
    restorable: false,
    inputFingerprint
  }
  putTask(task)
  let jsonPath = ""
  let htmlPath = ""
  try {
    const results = await readSourceFiles(plan)
    assertProjectExportable(plan.projectId)
    const pkg = finalizePortablePackage(plan, results)
    const serializedPackage = JSON.stringify(pkg)
    parsePortablePackage(serializedPackage)
    await mkdir(EXPORT_DIRECTORY)
    const suffix = `${Date.now()}_${plan.packageId.slice(-6)}`
    const stem = safeFileStem(plan.projectName)
    jsonPath = `${EXPORT_DIRECTORY}/${stem}_${suffix}.renosync.json`
    htmlPath = `${EXPORT_DIRECTORY}/${stem}_${suffix}.html`
    putTask({ ...task, jsonPath, htmlPath })
    await writeFile(jsonPath, serializedPackage, "utf8")
    await writeFile(htmlPath, renderPortableHtml(pkg), "utf8")
    assertProjectExportable(plan.projectId)
    const completed: PortableTask = {
      ...task,
      status: pkg.manifest.status,
      finishedAt: new Date().toISOString(),
      jsonPath,
      htmlPath,
      fileCount: pkg.files.length,
      missingCount: pkg.missingFiles.length,
      totalBytes: pkg.manifest.totalBytes,
      restorable: pkg.manifest.restorable
    }
    putTask(completed)
    return completed
  } catch (error) {
    let remainingJsonPath = jsonPath || undefined
    let remainingHtmlPath = htmlPath || undefined
    if (jsonPath) {
      try {
        await unlinkFile(jsonPath)
        remainingJsonPath = undefined
      } catch {
        // Keep the path in task metadata so the user can retry cleanup.
      }
    }
    if (htmlPath) {
      try {
        await unlinkFile(htmlPath)
        remainingHtmlPath = undefined
      } catch {
        // Keep the path in task metadata so the user can retry cleanup.
      }
    }
    const failed: PortableTask = {
      ...task,
      status: "failed",
      finishedAt: new Date().toISOString(),
      jsonPath: remainingJsonPath,
      htmlPath: remainingHtmlPath,
      errorCode: "generation_failed"
    }
    putTask(failed)
    if (error instanceof Error && error.message.includes("项目已不存在")) throw error
    throw new Error("资料包生成失败，请检查本机存储空间后重试")
  }
}

export async function deletePortableTask(taskIdValue: string): Promise<void> {
  const tasks = loadTasks()
  const task = tasks.find(item => item.id === taskIdValue)
  if (!task) throw new Error("导出任务不存在")
  if (task.status === "generating") throw new Error("资料正在生成，暂时不能删除")
  let remainingTask = { ...task }
  const outputs: Array<{ field: "jsonPath" | "htmlPath"; path?: string; label: string }> = [
    { field: "jsonPath", path: task.jsonPath, label: "数据包" },
    { field: "htmlPath", path: task.htmlPath, label: "阅读页" }
  ]
  for (const output of outputs) {
    const path = output.path
    if (!path) continue
    if (!path.startsWith(`${EXPORT_DIRECTORY}/`)) {
      putTask(remainingTask)
      throw new Error(`${output.label}路径异常，任务记录已保留`)
    }
    try {
      await unlinkFile(path)
    } catch {
      putTask(remainingTask)
      const alreadyDeleted = [
        remainingTask.jsonPath ? "" : "数据包已删除",
        remainingTask.htmlPath ? "" : "阅读页已删除"
      ].filter(Boolean).join("，")
      throw new Error(`${output.label}删除失败，任务记录已保留${alreadyDeleted ? `；${alreadyDeleted}` : ""}`)
    }
    remainingTask = output.field === "jsonPath"
      ? { ...remainingTask, jsonPath: undefined }
      : { ...remainingTask, htmlPath: undefined }
    putTask(remainingTask)
  }
  saveTasks(tasks.filter(item => item.id !== taskIdValue))
}

export async function sharePortableTask(taskIdValue: string, kind: "json" | "html"): Promise<void> {
  const task = loadTasks().find(item => item.id === taskIdValue)
  const filePath = kind === "json" ? task?.jsonPath : task?.htmlPath
  if (!task || !filePath || (task.status !== "complete" && task.status !== "partial")) {
    throw new Error("导出文件不可用，请重新生成")
  }
  assertProjectExportable(task.projectId)
  if (!filePath.startsWith(`${EXPORT_DIRECTORY}/`)) throw new Error("导出文件路径异常，请重新生成")
  await getFileInfo(filePath).catch(() => { throw new Error("本机导出文件已缺失，请删除任务后重新生成") })
  await wx.shareFileMessage({
    filePath,
    fileName: filePath.split("/").pop()
  })
}

export async function readPortablePackageFile(filePath: string): Promise<{
  pkg: PortablePackage
  summary: ReturnType<typeof portablePackageSummary>
}> {
  const info = await getFileInfo(filePath).catch(() => { throw new Error("无法读取所选资料包") })
  if (info.size > MAX_PACKAGE_BYTES) throw new Error("资料包超过当前可导入上限")
  const raw = await readFile(filePath, "utf8").catch(() => { throw new Error("无法读取所选资料包") })
  const pkg = parsePortablePackage(raw)
  return { pkg, summary: portablePackageSummary(pkg) }
}

export async function inspectLegacyProjectBundle(raw: string): Promise<LegacyBundleInspection> {
  if (!raw.trim()) throw new Error("请先粘贴旧版备份 JSON")
  if (raw.length > MAX_LEGACY_CHARACTERS) throw new Error("旧版备份业务数据超过当前检查上限")
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("旧版备份不是有效 JSON")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("旧版备份格式不正确")
  const root = parsed as Record<string, unknown>
  if ((root.schema !== "renovation-sync-backup-v1" && root.schema !== "renovation-sync-backup-v2")
    || !root.project || typeof root.project !== "object" || Array.isArray(root.project)
    || typeof (root.project as Record<string, unknown>).name !== "string") {
    throw new Error("旧版备份格式不正确")
  }
  let objectCount = 0
  let attachmentReferenceCount = 0
  const paths = new Set<string>()
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_LEGACY_DEPTH) throw new Error("旧版备份嵌套层级过深")
    if (Array.isArray(value)) {
      value.forEach(item => visit(item, depth + 1))
      return
    }
    if (!value || typeof value !== "object") return
    objectCount += 1
    if (objectCount > MAX_LEGACY_OBJECTS) throw new Error("旧版备份对象数量超过当前检查上限")
    const item = value as Record<string, unknown>
    if (typeof item.id === "string" && typeof item.name === "string"
      && (item.type === "image" || item.type === "audio" || item.type === "file")
      && typeof item.localPath === "string") {
      attachmentReferenceCount += 1
      paths.add(item.localPath)
      return
    }
    Object.values(item).forEach(child => visit(child, depth + 1))
  }
  visit(root, 0)
  let availableFileCount = 0
  let missingFileCount = 0
  for (const path of paths) {
    if (!path) {
      missingFileCount += 1
      continue
    }
    try {
      await getFileInfo(path)
      availableFileCount += 1
    } catch {
      missingFileCount += 1
    }
  }
  return {
    schema: root.schema,
    projectName: (root.project as Record<string, unknown>).name as string,
    recordCount: Array.isArray(root.records) ? root.records.length : 0,
    issueCount: Array.isArray(root.issues) ? root.issues.length : 0,
    attachmentReferenceCount,
    uniqueFileCount: paths.size,
    availableFileCount,
    missingFileCount
  }
}

function extensionFromName(name: string): string {
  const match = name.toLowerCase().match(/\.[a-z0-9]{1,8}$/)
  return match ? match[0] : ".bin"
}

export async function restorePortablePackage(
  pkg: PortablePackage,
  options: { restoreOperationId?: string } = {}
): Promise<Project> {
  const checkedPackage = parsePortablePackage(JSON.stringify(pkg))
  if (!checkedPackage.manifest.restorable) throw new Error("该资料包不完整，不能恢复项目")
  const fingerprint = packageFingerprint(checkedPackage)
  const restoreOperationId = options.restoreOperationId || checkedPackage.manifest.packageId
  const existing = existingRestoredProject(checkedPackage.manifest.packageId, fingerprint, restoreOperationId)
  if (existing) return existing
  const safePackageId = restoreOperationId.replace(/[^A-Za-z0-9_-]/g, "").slice(-28) || "package"
  const restoreId = `${safePackageId}_${fingerprint.replace(/[^A-Za-z0-9_-]/g, "").slice(-28)}`
  const directory = `${RESTORE_DIRECTORY}/${restoreId}`
  const localPaths: Record<string, string> = {}
  await mkdir(directory)
  try {
    for (let index = 0; index < checkedPackage.files.length; index += 1) {
      const file = checkedPackage.files[index]
      const localPath = `${directory}/file_${String(index + 1).padStart(4, "0")}${extensionFromName(file.displayName)}`
      await writeFile(localPath, file.contentBase64, "base64")
      const info = await getFileInfo(localPath)
      if (info.size !== file.byteLength || info.digest !== file.sha256.toLowerCase()) {
        throw new Error("attachment_checksum_mismatch")
      }
      localPaths[file.packagePath] = localPath
    }
    const bundle = hydrateRestorableBundle(checkedPackage, localPaths)
    const completedByAnotherAttempt = existingRestoredProject(
      checkedPackage.manifest.packageId,
      fingerprint,
      restoreOperationId
    )
    if (completedByAnotherAttempt) return completedByAnotherAttempt
    return restoreProjectBundle(bundle, {
      sourcePackageId: checkedPackage.manifest.packageId,
      sourcePackageFingerprint: fingerprint,
      restoreOperationId
    })
  } catch {
    try {
      await removeDirectory(directory)
    } catch {
      throw new Error("资料包恢复失败，原项目未被修改；暂存文件清理失败，请检查本机空间")
    }
    throw new Error("资料包校验或恢复失败，原项目未被修改")
  }
}
