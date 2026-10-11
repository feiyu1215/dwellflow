import type { EvidenceAsset, EvidenceCategory } from "../../core/domain"
import { buildLegacyEvidenceCandidates, type LegacyEvidenceCandidate } from "../../core/evidence"
import { inspectEvidenceFile, persistEvidenceFile } from "../../core/evidence-files"
import { ORIGIN_CONTEXT_SCHEMA_VERSION, serializeOriginContext } from "../../core/project-navigation"
import {
  currentProject,
  loadState,
  registerLegacyAttachmentEvidence,
  registerLocalEvidence,
  setEvidenceHidden,
  updateEvidenceIntegrity
} from "../../core/store"

const STATUS_LABEL: Record<EvidenceAsset["status"], string> = {
  pending: "处理中",
  ready: "原件可用",
  failed: "完整性异常",
  hidden: "已隐藏",
  missing: "原件缺失"
}

const CATEGORY_LABEL: Record<EvidenceAsset["category"], string> = {
  image: "图片",
  audio: "语音",
  video: "视频",
  document: "文件"
}

function sizeLabel(value?: number): string {
  if (value === undefined) return "大小未知"
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function timeLabel(value?: string): string {
  if (!value) return "时间未知"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { hour12: false })
}

function removeLocalFile(localPath: string): void {
  wx.getFileSystemManager().unlink({ filePath: localPath, fail: () => undefined })
}

function toView(asset: EvidenceAsset, linkCount: number) {
  return {
    ...asset,
    statusLabel: STATUS_LABEL[asset.status],
    categoryLabel: CATEGORY_LABEL[asset.category],
    sizeLabel: sizeLabel(asset.actualSizeBytes),
    hashLabel: asset.actualSha256 ? asset.actualSha256.slice(0, 12) : "未取得摘要",
    receivedLabel: timeLabel(asset.receivedAt),
    linkCount,
    tone: asset.status === "ready" ? "ready" : asset.status === "hidden" ? "hidden" : "warning"
  }
}

type EvidenceView = ReturnType<typeof toView>

Page({
  data: {
    projectId: "", projectName: "", readonly: false, busy: false,
    readyCount: 0, warningCount: 0,
    assets: [] as EvidenceView[], hiddenAssets: [] as EvidenceView[],
    legacyCandidates: [] as Array<LegacyEvidenceCandidate & { candidateKey: string }>
  },
  goBack() {
    if (getCurrentPages().length > 1) wx.navigateBack({ delta: 1 })
    else wx.redirectTo({ url: "/pages/dashboard/index" })
  },
  onShow() { this.refresh() },
  refresh() {
    const state = loadState()
    const project = currentProject(state)
    if (!project) {
      this.setData({ projectId: "", projectName: "", assets: [], hiddenAssets: [], legacyCandidates: [] })
      return
    }
    const assets = state.evidenceAssets.filter(item => item.projectId === project.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(asset => toView(asset, state.evidenceLinks.filter(link => link.projectId === project.id
        && link.evidenceId === asset.id && link.status === "active").length))
    this.setData({
      projectId: project.id,
      projectName: project.name,
      readonly: project.status !== "active",
      readyCount: assets.filter(item => item.status === "ready").length,
      warningCount: assets.filter(item => item.status === "missing" || item.status === "failed").length,
      assets: assets.filter(item => item.status !== "hidden"),
      hiddenAssets: assets.filter(item => item.status === "hidden"),
      legacyCandidates: buildLegacyEvidenceCandidates(state, project.id).map(item => ({
        ...item,
        candidateKey: `${item.sourceType}:${item.sourceId}:${item.attachment.id}`
      }))
    })
  },
  async registerPickedFile(input: {
    tempFilePath: string
    fileName: string
    category: EvidenceCategory
    mediaType: string
    origin: "manual_upload" | "file_import"
  }): Promise<boolean> {
    let localPath = ""
    try {
      localPath = await persistEvidenceFile(input.tempFilePath)
      const inspection = await inspectEvidenceFile(localPath)
      registerLocalEvidence({ projectId: this.data.projectId, origin: input.origin, category: input.category,
        fileName: input.fileName, mediaType: input.mediaType, localPath,
        sizeBytes: inspection.sizeBytes, sha256: inspection.sha256 })
      return true
    } catch {
      if (localPath) removeLocalFile(localPath)
      return false
    }
  },
  async addPhotos() {
    if (this.data.readonly || this.data.busy) return
    try {
      const selection = await wx.chooseMedia({ count: 9, mediaType: ["image"], sourceType: ["album", "camera"] })
      this.setData({ busy: true })
      let completed = 0
      for (let index = 0; index < selection.tempFiles.length; index += 1) {
        const item = selection.tempFiles[index]
        if (await this.registerPickedFile({ tempFilePath: item.tempFilePath,
          fileName: `现场照片 ${Date.now()}-${index + 1}.jpg`, category: "image",
          mediaType: "image/jpeg", origin: "manual_upload" })) completed += 1
      }
      this.refresh()
      wx.showToast({ title: completed === selection.tempFiles.length ? `已添加 ${completed} 项` : `成功 ${completed} 项，部分失败`, icon: completed ? "success" : "none" })
    } catch {
      // 用户取消选择时不产生证据对象。
    } finally { this.setData({ busy: false }) }
  },
  async addFiles() {
    if (this.data.readonly || this.data.busy) return
    try {
      const selection = await wx.chooseMessageFile({ count: 9, type: "file" })
      this.setData({ busy: true })
      let completed = 0
      for (const item of selection.tempFiles) {
        if (await this.registerPickedFile({ tempFilePath: item.path, fileName: item.name,
          category: "document", mediaType: "application/octet-stream", origin: "file_import" })) completed += 1
      }
      this.refresh()
      wx.showToast({ title: completed === selection.tempFiles.length ? `已添加 ${completed} 项` : `成功 ${completed} 项，部分失败`, icon: completed ? "success" : "none" })
    } catch {
      // 用户取消选择时不产生证据对象。
    } finally { this.setData({ busy: false }) }
  },
  async registerLegacy(e: WechatMiniprogram.TouchEvent) {
    if (this.data.readonly || this.data.busy) return
    const candidate = this.data.legacyCandidates.find(item => item.attachment.id === e.currentTarget.dataset.attachmentId)
    if (!candidate) return
    this.setData({ busy: true })
    try {
      let inspection: { sizeBytes: number; sha256: string } | undefined
      try { inspection = await inspectEvidenceFile(candidate.attachment.localPath) } catch { inspection = undefined }
      registerLegacyAttachmentEvidence({ projectId: candidate.projectId, sourceType: candidate.sourceType,
        sourceId: candidate.sourceId, attachmentId: candidate.attachment.id, inspection })
      this.refresh()
      wx.showToast({ title: inspection ? "旧附件已登记" : "已登记为原件缺失", icon: inspection ? "success" : "none" })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "登记失败", icon: "none" })
    } finally { this.setData({ busy: false }) }
  },
  async recheck(e: WechatMiniprogram.TouchEvent) {
    if (this.data.readonly || this.data.busy) return
    const asset = loadState().evidenceAssets.find(item => item.id === e.currentTarget.dataset.id)
    if (!asset || asset.storageRef?.kind !== "local_file") return
    this.setData({ busy: true })
    try {
      let inspection: { sizeBytes: number; sha256: string } | undefined
      try { inspection = await inspectEvidenceFile(asset.storageRef.localPath) } catch { inspection = undefined }
      const next = updateEvidenceIntegrity({ evidenceId: asset.id, expectedVersion: asset.version, inspection })
      this.refresh()
      wx.showToast({ title: next.status === "ready" ? "原件校验一致" : next.status === "missing" ? "原件不可读取" : "原件已发生变化", icon: "none" })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "复核失败", icon: "none" })
    } finally { this.setData({ busy: false }) }
  },
  toggleHidden(e: WechatMiniprogram.TouchEvent) {
    if (this.data.readonly || this.data.busy) return
    try {
      const hidden = e.currentTarget.dataset.hidden === "true"
      setEvidenceHidden(e.currentTarget.dataset.id as string, Number(e.currentTarget.dataset.version), hidden)
      this.refresh(); wx.showToast({ title: hidden ? "已隐藏" : "已恢复" })
    } catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "操作失败", icon: "none" }) }
  },
  openViewer(e: WechatMiniprogram.TouchEvent) {
    const evidenceId = e.currentTarget.dataset.id as string
    const asset = loadState().evidenceAssets.find(item => item.id === evidenceId && item.projectId === this.data.projectId)
    if (!asset) { wx.showToast({ title: "证据已变化，请刷新", icon: "none" }); return }
    const origin = serializeOriginContext({
      projectId: this.data.projectId,
      originView: "evidence",
      evidenceId,
      anchorId: `evidence-${evidenceId}`,
      returnToken: `evidence-${Date.now()}`,
      schemaVersion: ORIGIN_CONTEXT_SCHEMA_VERSION
    })
    wx.navigateTo({ url: `/pages/evidence-viewer/index?evidenceId=${encodeURIComponent(evidenceId)}&origin=${origin}` })
  }
})
