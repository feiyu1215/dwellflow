import type {
  AppState,
  EvidenceAsset,
  EvidenceLink,
  EvidenceTargetRef
} from "./domain"

export interface EvidenceAssociationView {
  id: string
  version: number
  target: EvidenceTargetRef
  targetLabel: string
  targetMeta: string
  relationLabel: string
  protected: boolean
}

export interface EvidenceAssociationCandidate {
  key: string
  target: EvidenceTargetRef
  label: string
}

const RELATION_LABEL: Record<EvidenceLink["relationKind"], string> = {
  original: "项目原件",
  supporting: "支持材料",
  before: "整改前",
  after: "整改后",
  delivery_document: "到货单据",
  observes: "现场观察",
  created_from: "来源附件",
  other: "其他关联"
}

export function evidenceTargetKey(target: EvidenceTargetRef): string {
  return `${target.type}:${target.id}:${target.version || ""}`
}

export function describeEvidenceTarget(
  state: AppState,
  projectId: string,
  target: EvidenceTargetRef
): { label: string; meta: string } {
  if (target.type === "project") {
    const item = state.projects.find(value => value.id === target.id && value.id === projectId)
    return { label: item?.name || "项目", meta: "项目" }
  }
  if (target.type === "record") {
    const item = state.records.find(value => value.id === target.id && value.projectId === projectId)
    return { label: item?.title || "记录已不可用", meta: item ? `${item.room} · ${item.stage}` : "历史关联" }
  }
  if (target.type === "record_revision") {
    const item = state.recordRevisions.find(value => value.id === target.id && value.projectId === projectId)
    return { label: item ? `${item.title} · v${item.version}` : "记录版本已不可用", meta: "历史版本" }
  }
  if (target.type === "issue") {
    const item = state.issues.find(value => value.id === target.id && value.projectId === projectId)
    return { label: item?.title || "问题已不可用", meta: item ? `${item.room} · ${item.stage}` : "历史关联" }
  }
  if (target.type === "material") {
    const item = state.materials.find(value => value.id === target.id && value.projectId === projectId)
    return { label: item?.name || "材料已不可用", meta: item?.specification || "历史关联" }
  }
  if (target.type === "receipt_batch") {
    const item = state.receiptBatches.find(value => value.id === target.id && value.projectId === projectId)
    const material = item && state.materials.find(value => value.id === item.materialId && value.projectId === projectId)
    return { label: material ? `${material.name}到货` : "到货批次", meta: item?.occurredAt || "历史关联" }
  }
  return { label: "业务关联", meta: target.type }
}

export function buildEvidenceAssociations(
  state: AppState,
  projectId: string,
  evidenceId: string
): EvidenceAssociationView[] {
  return state.evidenceLinks
    .filter(item => item.projectId === projectId && item.evidenceId === evidenceId && item.status === "active")
    .map(item => {
      const target = describeEvidenceTarget(state, projectId, item.target)
      return {
        id: item.id,
        version: item.version,
        target: { ...item.target },
        targetLabel: target.label,
        targetMeta: target.meta,
        relationLabel: RELATION_LABEL[item.relationKind],
        protected: item.relationKind === "original" || item.relationKind === "created_from"
      }
    })
}

export function buildEvidenceAssociationCandidates(
  state: AppState,
  projectId: string,
  evidenceId: string
): EvidenceAssociationCandidate[] {
  const linked = new Set(state.evidenceLinks
    .filter(item => item.projectId === projectId && item.evidenceId === evidenceId && item.status === "active")
    .map(item => `${item.target.type}:${item.target.id}`))
  const result: EvidenceAssociationCandidate[] = []
  const push = (target: EvidenceTargetRef, label: string) => {
    if (!linked.has(`${target.type}:${target.id}`)) result.push({ key: evidenceTargetKey(target), target, label })
  }
  state.records.filter(item => item.projectId === projectId).forEach(item =>
    push({ type: "record", id: item.id, version: item.version }, `记录 · ${item.title}`))
  state.issues.filter(item => item.projectId === projectId).forEach(item =>
    push({ type: "issue", id: item.id }, `问题 · ${item.title}`))
  state.materials.filter(item => item.projectId === projectId).forEach(item =>
    push({ type: "material", id: item.id }, `材料 · ${item.name}`))
  state.receiptBatches.filter(item => item.projectId === projectId).forEach(item => {
    const material = state.materials.find(value => value.id === item.materialId && value.projectId === projectId)
    push({ type: "receipt_batch", id: item.id, version: item.version }, `到货 · ${material?.name || item.id}`)
  })
  return result
}

export function evidencePreviewState(asset: EvidenceAsset): {
  available: boolean
  localPath: string
  reason: string
} {
  if (asset.status !== "ready") {
    const reason = asset.status === "hidden" ? "该证据已隐藏，请在证据清单恢复后查看原件。"
      : asset.status === "missing" ? "原件已无法读取，请返回证据清单重新校验。"
        : asset.status === "failed" ? "原件完整性校验异常，暂不展示内容。"
          : "原件仍在处理中。"
    return { available: false, localPath: "", reason }
  }
  if (!asset.storageRef) return { available: false, localPath: "", reason: "尚未保存可读取的原件位置。" }
  if (asset.storageRef.kind !== "local_file") {
    return { available: false, localPath: "", reason: "该原件保存在服务端，当前本地模式暂不能打开。" }
  }
  return { available: true, localPath: asset.storageRef.localPath, reason: "" }
}

