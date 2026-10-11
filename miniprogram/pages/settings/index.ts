import { saveServiceConfig, serviceConfig } from "../../core/ai-client"
import { currentProject, loadState } from "../../core/store"

const PROFILE_KEY = "renovation-personal-profile"

Page({
  data: {
    displayName: "项目负责人",
    avatarLabel: "项",
    baseUrl: "",
    serviceToken: "",
    tokenConfigured: false,
    projectName: "尚未创建项目",
    projectStage: "",
    projectRoleLabel: "负责人（本地体验身份）",
    projectStatusLabel: "",
    connectionLabel: "未配置",
    showConnectionDetails: false,
    message: "",
    error: ""
  },
  onShow() {
    const profile = wx.getStorageSync<{ displayName?: string }>(PROFILE_KEY) || {}
    const config = serviceConfig()
    const project = currentProject(loadState())
    this.setData({
      displayName: profile.displayName || "项目负责人",
      avatarLabel: (profile.displayName || "项目负责人").slice(0, 1),
      baseUrl: config.baseUrl,
      serviceToken: config.token,
      tokenConfigured: Boolean(config.baseUrl && config.token),
      projectName: project?.name || "尚未创建项目",
      projectStage: project?.stage || "",
      projectStatusLabel: project?.status === "archived" ? "已归档，只读" : project ? "进行中" : "等待创建",
      connectionLabel: config.baseUrl && config.token ? "连接信息已保存，尚未验证服务可用" : "尚未配置业务服务连接",
      message: "",
      error: ""
    })
  },
  onDisplayName(e: WechatMiniprogram.Input) {
    this.setData({
      displayName: e.detail.value,
      avatarLabel: e.detail.value.trim().slice(0, 1) || "我"
    })
  },
  onBaseUrl(e: WechatMiniprogram.Input) { this.setData({ baseUrl: e.detail.value }) },
  onToken(e: WechatMiniprogram.Input) { this.setData({ serviceToken: e.detail.value }) },
  saveProfile() {
    const displayName = this.data.displayName.trim()
    if (!displayName) return this.setData({ error: "请输入个人显示名称", message: "" })
    wx.setStorageSync(PROFILE_KEY, { displayName })
    this.setData({
      displayName,
      avatarLabel: displayName.slice(0, 1),
      message: "个人设置已保存",
      error: ""
    })
  },
  saveConnection() {
    try {
      const baseUrl = this.data.baseUrl.trim().replace(/\/$/, "")
      const token = this.data.serviceToken.trim()
      const configured = Boolean(baseUrl && token)
      saveServiceConfig({
        baseUrl,
        token
      })
      this.setData({
        baseUrl,
        serviceToken: token,
        tokenConfigured: configured,
        connectionLabel: configured ? "连接信息已保存，尚未验证服务可用" : "尚未配置业务服务连接",
        showConnectionDetails: false,
        message: configured ? "业务服务连接信息已保存" : "业务服务连接已清除",
        error: ""
      })
    } catch (error) {
      this.setData({ message: "", error: error instanceof Error ? error.message : "配置错误" })
    }
  },
  goBack() { wx.navigateBack({ fail: () => wx.reLaunch({ url: "/pages/dashboard/index" }) }) },
  toggleConnectionDetails() { this.setData({ showConnectionDetails: !this.data.showConnectionDetails }) },
  openAi() { wx.navigateTo({ url: "/pages/ai/index" }) },
  openProject() { wx.navigateTo({ url: "/pages/project/index" }) },
  openCollaboration() { wx.navigateTo({ url: "/pages/collaboration/index" }) },
  openBackup() { wx.navigateTo({ url: "/pages/backup/index" }) }
})
