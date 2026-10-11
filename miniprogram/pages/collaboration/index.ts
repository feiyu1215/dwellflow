import type { MemberScope } from "../../core/domain"
import {
  addProjectMember,
  createShareSnapshot,
  currentProject,
  loadState,
  revokeProjectMember,
  revokeShareSnapshot,
  sharePackage
} from "../../core/store"
import { formatTime } from "../../core/view"

const SCOPE_OPTIONS: Array<{ value: MemberScope; label: string }> = [
  { value: "records", label: "记录" },
  { value: "issues", label: "待办" },
  { value: "materials", label: "材料" },
  { value: "expenses", label: "费用" }
]

Page({
  data: {
    hasProject: false,
    projectName: "",
    readOnly: false,
    members: [] as Array<{ id: string; name: string; meta: string; active: boolean }>,
    shares: [] as Array<{ id: string; title: string; meta: string; statusLabel: string; active: boolean }>,
    recordOptions: [] as Array<{ id: string; title: string; value: string }>,
    issueOptions: [] as Array<{ id: string; title: string; value: string }>,
    showForm: "" as "" | "member" | "share",
    memberName: "",
    roleIndex: 0,
    roles: [{ value: "family", label: "家庭成员" }, { value: "collaborator", label: "外部协作者" }],
    scopeOptions: SCOPE_OPTIONS.map(item => ({ ...item, checked: item.value === "records" || item.value === "issues" })),
    selectedScopes: ["records", "issues"] as MemberScope[],
    shareTitle: "",
    selectedResources: [] as string[],
    allowDownload: false
  },
  onShow() { this.refresh() },
  noop() {},
  manageProject() { wx.navigateTo({ url: "/pages/project/index" }) },
  openConsultation() { wx.navigateTo({ url: "/pages/consultation/index" }) },
  openBackup() { wx.navigateTo({ url: "/pages/backup/index" }) },
  refresh() {
    const state = loadState()
    const project = currentProject(state)
    if (!project) {
      this.setData({
        hasProject: false,
        projectName: "",
        readOnly: false,
        members: [],
        shares: [],
        recordOptions: [],
        issueOptions: [],
        showForm: "",
        selectedResources: []
      })
      return
    }
    const currentTime = Date.now()
    this.setData({
      hasProject: true,
      projectName: project.name,
      readOnly: project.status === "archived",
      members: state.members.filter(item => item.projectId === project.id).map(item => ({
        id: item.id,
        name: item.name,
        meta: `${item.role === "family" ? "家庭成员" : "外部协作者"} · ${item.scopes.map(scope => SCOPE_OPTIONS.find(option => option.value === scope)?.label).join("、") || "无访问范围"}`,
        active: item.status === "active"
      })),
      shares: state.shares.filter(item => item.projectId === project.id).map(item => {
        const expired = new Date(item.expiresAt).getTime() <= currentTime
        const active = item.status === "active" && !expired
        return {
          id: item.id,
          title: item.title,
          meta: `${item.recordCopies.length} 条记录 · ${item.issueCopies.length} 个待办 · ${item.allowDownload ? "允许另行发送原件" : "不提供原件"} · 到期 ${formatTime(item.expiresAt)}`,
          active,
          statusLabel: active ? "有效" : item.status === "revoked" ? "已撤销" : "已过期"
        }
      }),
      recordOptions: state.records.filter(item => item.projectId === project.id).map(item => ({
        id: item.id, title: item.title, value: `record:${item.id}`
      })),
      issueOptions: state.issues.filter(item => item.projectId === project.id).map(item => ({
        id: item.id, title: item.title, value: `issue:${item.id}`
      }))
    })
  },
  openMember() { this.setData({ showForm: "member" }) },
  openShare() { this.setData({ showForm: "share" }) },
  closeForm() { this.setData({ showForm: "" }) },
  onMemberName(e: WechatMiniprogram.Input) { this.setData({ memberName: e.detail.value }) },
  onRole(e: WechatMiniprogram.PickerChange) { this.setData({ roleIndex: Number(e.detail.value) }) },
  onScopes(e: WechatMiniprogram.CheckboxGroupChange) { this.setData({ selectedScopes: e.detail.value as MemberScope[] }) },
  onShareTitle(e: WechatMiniprogram.Input) { this.setData({ shareTitle: e.detail.value }) },
  onResources(e: WechatMiniprogram.CheckboxGroupChange) { this.setData({ selectedResources: e.detail.value }) },
  onAllowDownload(e: WechatMiniprogram.SwitchChange) { this.setData({ allowDownload: e.detail.value }) },
  submitMember() {
    const project = currentProject()
    const name = this.data.memberName.trim()
    if (!project || !name) return wx.showToast({ title: "请填写成员名称", icon: "none" })
    try {
      addProjectMember({
        projectId: project.id,
        name,
        role: this.data.roles[this.data.roleIndex].value as "family" | "collaborator",
        scopes: this.data.selectedScopes
      })
      this.setData({ showForm: "", memberName: "" })
      this.refresh()
      wx.showToast({ title: "参与范围已记录" })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "记录失败", icon: "none" })
    }
  },
  revokeMember(e: WechatMiniprogram.TouchEvent) {
    try {
      revokeProjectMember(e.currentTarget.dataset.id as string)
      this.refresh()
      wx.showToast({ title: "权限已撤销" })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "撤销失败", icon: "none" })
    }
  },
  submitShare() {
    const project = currentProject()
    if (!project) return
    const title = this.data.shareTitle.trim() || `${project.name}资料`
    const recordIds = this.data.selectedResources.filter(value => value.startsWith("record:")).map(value => value.slice(7))
    const issueIds = this.data.selectedResources.filter(value => value.startsWith("issue:")).map(value => value.slice(6))
    try {
      createShareSnapshot({
        projectId: project.id,
        title,
        recordIds,
        issueIds,
        allowDownload: this.data.allowDownload
      })
      this.setData({ showForm: "", shareTitle: "", selectedResources: [], allowDownload: false })
      this.refresh()
      wx.showToast({ title: "分享快照已创建" })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "创建失败", icon: "none" })
    }
  },
  copyShare(e: WechatMiniprogram.TouchEvent) {
    try {
      wx.setClipboardData({ data: sharePackage(e.currentTarget.dataset.id as string) })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "复制失败", icon: "none" })
    }
  },
  revokeShare(e: WechatMiniprogram.TouchEvent) {
    try {
      revokeShareSnapshot(e.currentTarget.dataset.id as string)
      this.refresh()
      wx.showToast({ title: "分享已撤销" })
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "撤销失败", icon: "none" })
    }
  }
})
