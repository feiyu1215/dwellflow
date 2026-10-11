import {
  portablePlanContentPreview,
  type PortableContentPreviewSection,
  type PortableExportPlan,
  type PortablePackage
} from "../../core/portable-package"
import {
  createFullPortablePlan,
  createLimitedPortablePlan,
  deletePortableTask,
  generatePortableExport,
  hasRestoredPortablePackage,
  inspectLegacyProjectBundle,
  inspectPortablePlan,
  listPortableTasks,
  readPortablePackageFile,
  restorePortablePackage,
  sharePortableTask
} from "../../core/portable-files"
import { currentProject, loadState, restoreProjectBundle } from "../../core/store"
import { formatTime } from "../../core/view"

let pendingPlan: PortableExportPlan | undefined
let pendingImport: PortablePackage | undefined
let pendingRestoreOperationId = ""
let pendingLegacyText = ""
let taskDisplayLimit = 20
let activePageProjectId = ""

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

Page({
  data: {
    projectId: "",
    projectName: "",
    projectStatus: "",
    hasProject: false,
    mode: "full" as "full" | "limited",
    recordOptions: [] as Array<{ id: string; title: string; value: string }>,
    issueOptions: [] as Array<{ id: string; title: string; value: string }>,
    selectedResources: [] as string[],
    previewReady: false,
    previewMeta: "",
    previewSections: [] as PortableContentPreviewSection[],
    previewItems: [] as Array<{ key: string; name: string; statusLabel: string; statusClass: string; sizeLabel: string }>,
    previewBlocked: false,
    busy: false,
    tasks: [] as Array<{
      id: string
      title: string
      meta: string
      statusLabel: string
      statusClass: string
      canShareHtml: boolean
      canShareJson: boolean
      canDelete: boolean
      errorNote: string
    }>,
    taskCount: 0,
    hasMoreTasks: false,
    importReady: false,
    importMeta: "",
    importRestorable: false,
    importAlreadyRestored: false,
    legacyText: "",
    legacyReady: false,
    legacyMeta: "",
    legacyMissingCount: 0
  },
  onLoad() {
    taskDisplayLimit = 20
    activePageProjectId = ""
  },
  onShow() { this.refresh() },
  onUnload() {
    pendingPlan = undefined
    pendingImport = undefined
    pendingRestoreOperationId = ""
    pendingLegacyText = ""
    activePageProjectId = ""
  },
  refresh() {
    const state = loadState()
    const project = currentProject(state)
    const nextProjectId = project?.id || ""
    const projectChanged = activePageProjectId !== nextProjectId
    if (projectChanged) {
      pendingPlan = undefined
      activePageProjectId = nextProjectId
    }
    const allTasks = listPortableTasks().map(item => ({
      id: item.id,
      title: item.purpose === "full_backup" ? "完整项目备份" : "限定阅读资料",
      meta: `${item.projectName} · ${formatTime(item.createdAt)} · ${item.fileCount} 个原件 · ${formatBytes(item.totalBytes)}${item.missingCount ? ` · 缺 ${item.missingCount}` : ""} · 本机文件：${[item.htmlPath ? "阅读页" : "", item.jsonPath ? "数据包" : ""].filter(Boolean).join("、") || "无"}`,
      statusLabel: item.status === "complete" ? "完整"
        : item.status === "partial" ? "部分"
          : item.status === "generating" ? "生成中"
            : item.errorCode === "interrupted" ? "已中断" : "生成失败",
      statusClass: item.status === "complete" ? "pill-green"
        : item.status === "partial" || item.status === "generating" ? "pill-amber" : "pill-red",
      canShareHtml: Boolean(item.htmlPath) && (item.status === "complete" || item.status === "partial"),
      canShareJson: Boolean(item.jsonPath) && (item.status === "complete" || item.status === "partial"),
      canDelete: item.status !== "generating",
      errorNote: item.status !== "failed" ? ""
        : item.errorCode === "interrupted" ? "上次生成在应用关闭前没有完成，可删除后重新生成。"
          : "文件没有成功生成，可删除任务后重新检查。"
    }))
    this.setData({
      projectId: project?.id || "",
      projectName: project?.name || "",
      projectStatus: project?.status === "archived" ? "已归档，只读" : project ? "进行中" : "没有当前项目",
      hasProject: Boolean(project),
      recordOptions: project ? state.records.filter(item => item.projectId === project.id)
        .map(item => ({ id: item.id, title: item.title, value: `record:${item.id}` })) : [],
      issueOptions: project ? state.issues.filter(item => item.projectId === project.id)
        .map(item => ({ id: item.id, title: item.title, value: `issue:${item.id}` })) : [],
      selectedResources: projectChanged ? [] : this.data.selectedResources,
      previewReady: projectChanged ? false : this.data.previewReady,
      previewItems: projectChanged ? [] : this.data.previewItems,
      previewSections: projectChanged ? [] : this.data.previewSections,
      tasks: allTasks.slice(0, taskDisplayLimit),
      taskCount: allTasks.length,
      hasMoreTasks: allTasks.length > taskDisplayLimit
    })
  },
  showMoreTasks() {
    taskDisplayLimit += 20
    this.refresh()
  },
  chooseMode(e: WechatMiniprogram.TouchEvent) {
    pendingPlan = undefined
    this.setData({ mode: e.currentTarget.dataset.mode as "full" | "limited", previewReady: false, previewItems: [], previewSections: [] })
  },
  onResources(e: WechatMiniprogram.CheckboxGroupChange) {
    pendingPlan = undefined
    this.setData({ selectedResources: e.detail.value, previewReady: false, previewItems: [], previewSections: [] })
  },
  async previewExport() {
    if (!this.data.projectId || this.data.busy) return
    this.setData({ busy: true })
    wx.showLoading({ title: "正在检查原件" })
    try {
      const plan = this.data.mode === "full"
        ? createFullPortablePlan(this.data.projectId)
        : createLimitedPortablePlan({
          projectId: this.data.projectId,
          recordIds: this.data.selectedResources.filter(value => value.startsWith("record:")).map(value => value.slice(7)),
          issueIds: this.data.selectedResources.filter(value => value.startsWith("issue:")).map(value => value.slice(6))
        })
      const result = await inspectPortablePlan(plan)
      pendingPlan = plan
      this.setData({
        previewReady: true,
        previewBlocked: result.overLimit,
        previewMeta: `${this.data.mode === "full" ? "完整备份" : "限定阅读"} · ${result.fileCount} 个原件 · ${formatBytes(result.totalBytes)} · ${result.missingCount} 个缺失`,
        previewSections: portablePlanContentPreview(plan),
        previewItems: result.items.map((item, index) => ({
          key: `${index}-${item.name}`,
          name: item.name,
          statusLabel: item.status === "available" ? "可读取" : item.status === "missing" ? "缺失" : "超出容量",
          statusClass: item.status === "available" ? "pill-green" : "pill-amber",
          sizeLabel: item.byteLength === undefined ? "" : formatBytes(item.byteLength)
        }))
      })
    } catch (error) {
      pendingPlan = undefined
      wx.showToast({ title: error instanceof Error ? error.message : "检查失败", icon: "none" })
    } finally {
      wx.hideLoading()
      this.setData({ busy: false })
    }
  },
  async generateExport() {
    if (!pendingPlan || this.data.previewBlocked || this.data.busy) return
    this.setData({ busy: true })
    wx.showLoading({ title: "正在生成资料" })
    try {
      const task = await generatePortableExport(pendingPlan)
      pendingPlan = undefined
      this.setData({ previewReady: false, previewItems: [], previewSections: [] })
      this.refresh()
      wx.showToast({ title: task.status === "complete" ? "资料包已生成" : "已生成部分资料", icon: "none" })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "生成失败", icon: "none" })
    } finally {
      wx.hideLoading()
      this.setData({ busy: false })
    }
  },
  async shareTask(e: WechatMiniprogram.TouchEvent) {
    try {
      await sharePortableTask(e.currentTarget.dataset.id as string, e.currentTarget.dataset.kind as "json" | "html")
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "未发送文件", icon: "none" })
    }
  },
  async removeTask(e: WechatMiniprogram.TouchEvent) {
    const result = await wx.showModal({ title: "删除本机导出文件？", content: "只删除本功能生成的文件，不会删除项目或现场原件。" })
    if (!result.confirm) return
    try {
      await deletePortableTask(e.currentTarget.dataset.id as string)
      this.refresh()
      wx.showToast({ title: "导出文件已删除" })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "删除失败", icon: "none" })
    }
  },
  async chooseImport() {
    try {
      const chosen = await wx.chooseMessageFile({ count: 1, type: "file", extension: ["json"] })
      const result = await readPortablePackageFile(chosen.tempFiles[0].path)
      pendingImport = result.pkg
      pendingRestoreOperationId = ""
      const importAlreadyRestored = result.summary.restorable && hasRestoredPortablePackage(result.pkg)
      this.setData({
        importReady: true,
        importRestorable: result.summary.restorable,
        importAlreadyRestored,
        importMeta: `${result.summary.projectName} · ${result.summary.purposeLabel} · ${result.summary.statusLabel} · ${result.summary.recordCount} 条记录 · ${result.summary.issueCount} 个问题 · ${result.summary.fileCount} 个原件 · ${formatBytes(result.summary.totalBytes)}`
      })
    } catch (error) {
      pendingImport = undefined
      pendingRestoreOperationId = ""
      this.setData({ importReady: false, importRestorable: false, importAlreadyRestored: false, importMeta: "" })
      wx.showToast({ title: error instanceof Error ? error.message : "未选择资料包", icon: "none" })
    }
  },
  async restoreSelected() {
    if (!pendingImport || !this.data.importRestorable || this.data.busy) return
    const confirmation = await wx.showModal({
      title: this.data.importAlreadyRestored ? "再恢复一份只读副本？" : "恢复为只读副本？",
      content: this.data.importAlreadyRestored
        ? "此资料包已恢复过。继续会明确新建另一个只读副本；不会覆盖已有副本。"
        : "不会覆盖已有项目；旧成员、分享、咨询发布和监控授权不会恢复。"
    })
    if (!confirmation.confirm) return
    this.setData({ busy: true })
    wx.showLoading({ title: "正在校验并恢复" })
    try {
      if (this.data.importAlreadyRestored && !pendingRestoreOperationId) {
        pendingRestoreOperationId = `${pendingImport.manifest.packageId}_copy_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      }
      await restorePortablePackage(pendingImport, {
        restoreOperationId: pendingRestoreOperationId || undefined
      })
      pendingImport = undefined
      pendingRestoreOperationId = ""
      this.setData({ importReady: false, importRestorable: false, importAlreadyRestored: false, importMeta: "" })
      this.refresh()
      wx.showToast({ title: "已恢复为只读副本", icon: "none" })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "恢复失败", icon: "none" })
    } finally {
      wx.hideLoading()
      this.setData({ busy: false })
    }
  },
  onLegacyText(e: WechatMiniprogram.TextareaInput) {
    pendingLegacyText = ""
    this.setData({ legacyText: e.detail.value, legacyReady: false, legacyMeta: "", legacyMissingCount: 0 })
  },
  pasteLegacy() {
    wx.getClipboardData({
      success: result => {
        pendingLegacyText = ""
        this.setData({ legacyText: result.data, legacyReady: false, legacyMeta: "", legacyMissingCount: 0 })
      }
    })
  },
  async inspectLegacy() {
    if (this.data.busy) return
    this.setData({ busy: true })
    wx.showLoading({ title: "正在检查旧备份" })
    try {
      const raw = this.data.legacyText.trim()
      const result = await inspectLegacyProjectBundle(raw)
      pendingLegacyText = raw
      this.setData({
        legacyReady: true,
        legacyMissingCount: result.missingFileCount,
        legacyMeta: `${result.projectName} · ${result.schema.endsWith("v2") ? "v2" : "v1"} · ${result.recordCount} 条记录 · ${result.issueCount} 个问题 · ${result.uniqueFileCount} 个本机文件路径 · ${result.missingFileCount} 个当前不可读`
      })
    } catch (error) {
      pendingLegacyText = ""
      this.setData({ legacyReady: false, legacyMeta: "", legacyMissingCount: 0 })
      wx.showToast({ title: error instanceof Error ? error.message : "检查失败", icon: "none" })
    } finally {
      wx.hideLoading()
      this.setData({ busy: false })
    }
  },
  async restoreLegacy() {
    if (!pendingLegacyText || !this.data.legacyReady || this.data.busy) return
    const confirmation = await wx.showModal({
      title: "恢复旧版只读副本？",
      content: this.data.legacyMissingCount
        ? `有 ${this.data.legacyMissingCount} 个本机文件路径当前不可读；恢复后仍保留缺口，且不会把同名文件当作原件。`
        : "旧版只保存本机路径，不会复制原件；路径日后仍可能失效。"
    })
    if (!confirmation.confirm) return
    try {
      restoreProjectBundle(pendingLegacyText)
      pendingLegacyText = ""
      this.setData({ legacyText: "", legacyReady: false, legacyMeta: "", legacyMissingCount: 0 })
      this.refresh()
      wx.showToast({ title: "旧备份已恢复为只读副本", icon: "none" })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "恢复失败", icon: "none" })
    }
  }
})
