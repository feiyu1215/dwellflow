import type { EvidenceAsset } from "../../core/domain"
import {
  buildEvidenceAssociationCandidates,
  buildEvidenceAssociations,
  evidencePreviewState,
  type EvidenceAssociationCandidate,
  type EvidenceAssociationView
} from "../../core/evidence-viewer"
import { parseOriginContext, type OriginContext } from "../../core/project-navigation"
import { createEvidenceLink, currentProject, loadState, removeEvidenceLink } from "../../core/store"

const STATUS_LABEL: Record<EvidenceAsset["status"], string> = {
  pending: "处理中", ready: "原件可用", failed: "完整性异常", hidden: "已隐藏", missing: "原件缺失"
}
const CATEGORY_LABEL: Record<EvidenceAsset["category"], string> = {
  image: "图片", audio: "语音", video: "视频", document: "文件"
}
const TIME_SOURCE_LABEL: Record<EvidenceAsset["timeSource"], string> = {
  device: "设备时间", provider: "服务商时间", user_entered: "用户填写",
  document: "文档时间", imported: "导入时间", unknown: "来源未知"
}
const ORIGIN_LABEL: Record<EvidenceAsset["origin"], string> = {
  camera: "相机拍摄",
  photo_library: "相册选择",
  file_import: "文件导入",
  voice_recording: "现场录音",
  camera_capture: "监控截帧",
  manual_upload: "用户上传",
  legacy_attachment: "旧附件登记",
  generated_demo: "合成演示"
}

function timeLabel(value?: string): string {
  if (!value) return "未提供"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "时间格式异常" : date.toLocaleString("zh-CN", { hour12: false })
}

function sizeLabel(value?: number): string {
  if (value === undefined) return "未知"
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

type AssetView = EvidenceAsset & {
  categoryLabel: string; statusLabel: string; timeSourceLabel: string; originLabel: string; sizeLabel: string
  occurredLabel: string; capturedLabel: string; receivedLabel: string
  expectedHashLabel: string; actualHashLabel: string
}

function toAssetView(asset: EvidenceAsset): AssetView {
  return {
    ...asset,
    categoryLabel: CATEGORY_LABEL[asset.category], statusLabel: STATUS_LABEL[asset.status],
    timeSourceLabel: TIME_SOURCE_LABEL[asset.timeSource], originLabel: ORIGIN_LABEL[asset.origin],
    sizeLabel: sizeLabel(asset.actualSizeBytes),
    occurredLabel: timeLabel(asset.occurredAt), capturedLabel: timeLabel(asset.capturedAt),
    receivedLabel: timeLabel(asset.receivedAt), expectedHashLabel: asset.expectedSha256 || "未提供",
    actualHashLabel: asset.actualSha256 || "未取得"
  }
}

let audio: WechatMiniprogram.InnerAudioContext | undefined

Page({
  data: {
    evidenceId: "", projectId: "", projectName: "", invalid: false, readonly: false,
    locationLabel: "位置未确认",
    asset: null as AssetView | null, previewAvailable: false, previewPath: "", previewReason: "",
    isPlaying: false, associations: [] as EvidenceAssociationView[],
    candidates: [] as EvidenceAssociationCandidate[], candidateIndex: 0,
    showMetadata: false
  },
  originContext: undefined as OriginContext | undefined,
  onLoad(options: Record<string, string | undefined>) {
    this.originContext = options.origin ? parseOriginContext(options.origin) : undefined
    this.setData({ evidenceId: options.evidenceId || "" })
    this.refresh()
  },
  onShow() { if (this.data.evidenceId) this.refresh() },
  onUnload() { this.destroyAudio() },
  refresh() {
    const state = loadState()
    const project = currentProject(state)
    const asset = state.evidenceAssets.find(item => item.id === this.data.evidenceId)
    const validOrigin = !this.originContext || (this.originContext.projectId === asset?.projectId
      && (!this.originContext.evidenceId || this.originContext.evidenceId === asset?.id))
    if (!project || !asset || asset.projectId !== project.id || !validOrigin) {
      this.destroyAudio()
      this.setData({ invalid: true, asset: null, associations: [], candidates: [], previewAvailable: false })
      return
    }
    const preview = evidencePreviewState(asset)
    const positions = state.evidenceLinks
      .filter(item => item.projectId === project.id && item.evidenceId === asset.id && item.status === "active"
        && (item.spaceId || item.stageId))
      .map(item => {
        const space = item.spaceId
          ? state.spaces.find(candidate => candidate.id === item.spaceId && candidate.projectId === project.id)?.name
          : undefined
        return [space, item.stageId].filter(Boolean).join(" × ")
      })
      .filter((item, index, all) => item && all.indexOf(item) === index)
    this.setData({
      invalid: false, projectId: project.id, projectName: project.name, readonly: project.status !== "active",
      locationLabel: positions[0] || "位置未确认",
      asset: toAssetView(asset), previewAvailable: preview.available, previewPath: preview.localPath,
      previewReason: preview.reason, associations: buildEvidenceAssociations(state, project.id, asset.id),
      candidates: buildEvidenceAssociationCandidates(state, project.id, asset.id), candidateIndex: 0
    })
  },
  goBack() {
    this.destroyAudio()
    if (getCurrentPages().length > 1) {
      wx.navigateBack({ delta: 1, fail: () => this.fallbackToOrigin() })
      return
    }
    this.fallbackToOrigin()
  },
  fallbackToOrigin() {
    const target = this.originContext?.originView === "patrol"
      ? "/pages/dashboard/index"
      : "/pages/evidence/index"
    wx.redirectTo({ url: target })
  },
  showMore() {
    wx.showActionSheet({
      itemList: ["返回证据清单"],
      success: () => this.goEvidenceList()
    })
  },
  goEvidenceList() { wx.redirectTo({ url: "/pages/evidence/index" }) },
  toggleMetadata() { this.setData({ showMetadata: !this.data.showMetadata }) },
  previewImage() {
    if (!this.data.previewAvailable || this.data.asset?.category !== "image") return
    wx.previewImage({ current: this.data.previewPath, urls: [this.data.previewPath] })
  },
  toggleAudio() {
    if (!this.data.previewAvailable || this.data.asset?.category !== "audio") return
    if (!audio) {
      audio = wx.createInnerAudioContext()
      audio.src = this.data.previewPath
      audio.onPlay(() => this.setData({ isPlaying: true }))
      audio.onPause(() => this.setData({ isPlaying: false }))
      audio.onStop(() => this.setData({ isPlaying: false }))
      audio.onEnded(() => this.setData({ isPlaying: false }))
      audio.onError(() => { this.setData({ isPlaying: false }); wx.showToast({ title: "语音无法播放", icon: "none" }) })
    }
    if (this.data.isPlaying) audio.pause()
    else audio.play()
  },
  destroyAudio() {
    if (audio) { audio.stop(); audio.destroy(); audio = undefined }
    if (this.data.isPlaying) this.setData({ isPlaying: false })
  },
  openDocument() {
    if (!this.data.previewAvailable || this.data.asset?.category !== "document") return
    wx.openDocument({ filePath: this.data.previewPath, showMenu: true,
      fail: () => wx.showToast({ title: "微信暂不支持打开此文件", icon: "none" }) })
  },
  onCandidateChange(e: WechatMiniprogram.PickerChange) { this.setData({ candidateIndex: Number(e.detail.value) }) },
  addAssociation() {
    if (this.data.readonly) return
    const candidate = this.data.candidates[this.data.candidateIndex]
    if (!candidate || !this.data.asset) return
    try {
      createEvidenceLink({ projectId: this.data.projectId, evidenceId: this.data.asset.id,
        target: candidate.target, relationKind: "supporting" })
      this.refresh(); wx.showToast({ title: "已关联", icon: "success" })
    } catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "关联失败", icon: "none" }) }
  },
  removeAssociation(e: WechatMiniprogram.TouchEvent) {
    if (this.data.readonly) return
    const link = this.data.associations.find(item => item.id === e.currentTarget.dataset.id)
    if (!link || link.protected) return
    try {
      removeEvidenceLink(link.id, link.version)
      this.refresh(); wx.showToast({ title: "已解除，原件仍保留", icon: "none" })
    } catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "解除失败", icon: "none" }) }
  },
  openAssociation(e: WechatMiniprogram.TouchEvent) {
    const link = this.data.associations.find(item => item.id === e.currentTarget.dataset.id)
    if (!link) return
    const state = loadState()
    const target = link.target
    if (target.type === "project") {
      wx.redirectTo({ url: "/pages/dashboard/index" })
      return
    }
    if (target.type === "record") {
      wx.navigateTo({ url: `/pages/records/index?id=${encodeURIComponent(target.id)}` })
      return
    }
    if (target.type === "record_revision") {
      const revision = state.recordRevisions.find(item => item.id === target.id && item.projectId === this.data.projectId)
      if (revision) wx.navigateTo({ url: `/pages/records/index?id=${encodeURIComponent(revision.recordId)}` })
      else wx.showToast({ title: "记录版本已不可用", icon: "none" })
      return
    }
    if (target.type === "issue") {
      wx.navigateTo({ url: `/pages/issues/index?id=${encodeURIComponent(target.id)}` })
      return
    }
    if (target.type === "material") {
      wx.navigateTo({ url: `/pages/material/index?id=${encodeURIComponent(target.id)}` })
      return
    }
    if (target.type === "receipt_batch") {
      const receipt = state.receiptBatches.find(item => item.id === target.id && item.projectId === this.data.projectId)
      if (receipt) wx.navigateTo({ url: `/pages/material/index?id=${encodeURIComponent(receipt.materialId)}&batchId=${encodeURIComponent(receipt.id)}` })
      else wx.showToast({ title: "到货批次已不可用", icon: "none" })
      return
    }
    wx.showToast({ title: "该关联暂不支持直接打开", icon: "none" })
  }
})
