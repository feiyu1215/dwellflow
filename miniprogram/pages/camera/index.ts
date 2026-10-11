import { CAMERA_PROVIDERS, cameraReadiness, requestViewingSession } from "../../core/camera"
import type { CameraProviderKey } from "../../core/domain"
import {
  createCameraBinding,
  currentProject,
  loadState,
  revokeCameraBinding
} from "../../core/store"

const STATUS_LABEL = {
  pending_configuration: "待配置",
  pending_authorization: "待授权",
  ready: "可观看",
  offline: "离线",
  revoked: "已解绑",
  verification_failed: "验证失败"
}

Page({
  data: {
    hasProject: false,
    projectName: "",
    cameras: [] as Array<{ id: string; name: string; meta: string; statusLabel: string; active: boolean; missingText: string }>,
    readOnly: false,
    providers: CAMERA_PROVIDERS,
    providerIndex: 0,
    showForm: false,
    displayName: "",
    room: "",
    externalDeviceId: ""
  },
  onShow() { this.refresh() },
  noop() {},
  manageProject() { wx.navigateTo({ url: "/pages/project/index" }) },
  refresh() {
    const state = loadState()
    const project = currentProject(state)
    if (!project) {
      this.setData({ hasProject: false, projectName: "", readOnly: false, cameras: [], showForm: false })
      return
    }
    this.setData({
      hasProject: true,
      projectName: project.name,
      readOnly: project.status === "archived",
      cameras: state.cameras.filter(item => item.projectId === project.id).map(item => {
        const provider = CAMERA_PROVIDERS.find(providerItem => providerItem.key === item.provider)
        const readiness = cameraReadiness(item)
        return {
          id: item.id,
          name: item.displayName,
          meta: `${item.room || "未指定房间"} · ${provider?.name || item.provider}`,
          statusLabel: STATUS_LABEL[item.status],
          active: item.status !== "revoked",
          missingText: readiness.missing.join("、")
        }
      })
    })
  },
  openForm() {
    if (!this.data.hasProject || this.data.readOnly) return
    this.setData({ showForm: true })
  },
  closeForm() { this.setData({ showForm: false }) },
  onProvider(e: WechatMiniprogram.PickerChange) { this.setData({ providerIndex: Number(e.detail.value) }) },
  onDisplayName(e: WechatMiniprogram.Input) { this.setData({ displayName: e.detail.value }) },
  onRoom(e: WechatMiniprogram.Input) { this.setData({ room: e.detail.value }) },
  onDeviceId(e: WechatMiniprogram.Input) { this.setData({ externalDeviceId: e.detail.value }) },
  submit() {
    const project = currentProject()
    const displayName = this.data.displayName.trim()
    if (!project || project.status !== "active") return wx.showToast({ title: "当前项目不能新增设备", icon: "none" })
    if (!displayName) return wx.showToast({ title: "请填写设备名称", icon: "none" })
    try {
      createCameraBinding({
        projectId: project.id,
        provider: CAMERA_PROVIDERS[this.data.providerIndex].key as CameraProviderKey,
        displayName,
        room: this.data.room.trim(),
        externalDeviceId: this.data.externalDeviceId.trim()
      })
      this.setData({ showForm: false, displayName: "", room: "", externalDeviceId: "" })
      this.refresh()
      wx.showToast({ title: "已保存接入项" })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "保存失败", icon: "none" })
    }
  },
  async watch(e: WechatMiniprogram.TouchEvent) {
    const camera = loadState().cameras.find(item => item.id === e.currentTarget.dataset.id)
    if (!camera) return
    try {
      await requestViewingSession(camera)
    } catch (error) {
      wx.showModal({
        title: "暂时无法观看",
        content: error instanceof Error ? error.message : "设备尚未配置",
        showCancel: false
      })
    }
  },
  revoke(e: WechatMiniprogram.TouchEvent) {
    try {
      revokeCameraBinding(e.currentTarget.dataset.id as string)
      this.refresh()
      wx.showToast({ title: "设备已解绑" })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "解绑失败", icon: "none" })
    }
  },
  copyProviderSource() {
    wx.setClipboardData({ data: CAMERA_PROVIDERS[this.data.providerIndex].officialUrl })
  }
})
