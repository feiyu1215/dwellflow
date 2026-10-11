import type {
  AppState,
  Attachment,
  EvidenceAsset,
  EvidenceCategory,
  EvidenceLink,
  EvidenceTargetRef
} from "./domain"

const SHA256_PATTERN = /^[a-f0-9]{64}$/

export interface LegacyEvidenceCandidate {
  projectId: string
  sourceType: "record" | "record_revision"
  sourceId: string
  sourceTitle: string
  attachment: Attachment
  existingEvidenceId?: string
  alreadyLinked: boolean
}

export function evidenceCategoryForAttachment(type: Attachment["type"]): EvidenceCategory {
  if (type === "image") return "image"
  if (type === "audio") return "audio"
  return "document"
}

export function normalizeSha256(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!SHA256_PATTERN.test(normalized)) throw new Error("SHA-256 格式不正确")
  return normalized
}

export function validateReadyEvidence(input: Pick<EvidenceAsset,
  "projectId" | "fileName" | "mediaType" | "storageRef" | "actualSizeBytes" | "actualSha256" | "status" | "origin" | "syntheticDisclosure"
>): void {
  if (!input.projectId.trim()) throw new Error("证据必须属于项目")
  if (!input.fileName.trim() || input.fileName.trim().length > 200) throw new Error("证据名称应为 1～200 个字符")
  if (!input.mediaType.trim()) throw new Error("证据媒体类型不能为空")
  if (input.status !== "ready") throw new Error("新登记证据必须先完成原件校验")
  if (!input.storageRef) throw new Error("证据缺少持久原件")
  if (input.storageRef.kind === "local_file" && !input.storageRef.localPath.trim()) throw new Error("本地原件路径不能为空")
  if (input.storageRef.kind === "server_attachment" && !input.storageRef.attachmentId.trim()) throw new Error("服务端附件标识不能为空")
  if (!Number.isSafeInteger(input.actualSizeBytes) || Number(input.actualSizeBytes) < 0) throw new Error("证据文件大小不正确")
  normalizeSha256(input.actualSha256 || "")
  if (input.origin === "generated_demo" && !input.syntheticDisclosure?.trim()) {
    throw new Error("合成演示证据必须明确披露")
  }
}

export function evidenceTargetExists(state: AppState, projectId: string, target: EvidenceTargetRef): boolean {
  if (target.type === "project") return target.id === projectId && state.projects.some(item => item.id === target.id)
  if (target.type === "record") return state.records.some(item => item.projectId === projectId && item.id === target.id
    && (target.version === undefined || target.version === item.version))
  if (target.type === "record_revision") return state.recordRevisions.some(item => item.projectId === projectId && item.id === target.id
    && (target.version === undefined || target.version === item.version))
  if (target.type === "issue") return state.issues.some(item => item.projectId === projectId && item.id === target.id)
    || state.issueWorkflows.some(item => item.projectId === projectId && item.id === target.id)
  if (target.type === "material") return state.materials.some(item => item.projectId === projectId && item.id === target.id)
  if (target.type === "receipt_batch") return state.receiptBatches.some(item => item.projectId === projectId && item.id === target.id)
  if (target.type === "consultation") return state.consultations.some(item => item.projectId === projectId && item.id === target.id)
  if (target.type === "issue_treatment") return state.issueWorkflows.some(item => item.projectId === projectId
    && item.treatments.some(treatment => treatment.id === target.id))
  if (target.type === "issue_review") return state.issueWorkflows.some(item => item.projectId === projectId
    && item.reviews.some(review => review.id === target.id))
  return false
}

export function assertEvidenceLinkAllowed(state: AppState, input: Pick<EvidenceLink,
  "projectId" | "evidenceId" | "target" | "relationKind" | "spaceId"
>): EvidenceLink | undefined {
  const evidence = state.evidenceAssets.find(item => item.id === input.evidenceId && item.projectId === input.projectId)
  if (!evidence) throw new Error("证据不存在或不属于当前项目")
  if (!evidenceTargetExists(state, input.projectId, input.target)) throw new Error("证据目标不存在或不属于当前项目")
  if (input.spaceId && !state.spaces.some(item => item.id === input.spaceId
    && item.projectId === input.projectId)) {
    throw new Error("证据空间必须属于当前项目")
  }
  return state.evidenceLinks.find(item => item.projectId === input.projectId
    && item.evidenceId === input.evidenceId && item.status === "active"
    && item.target.type === input.target.type && item.target.id === input.target.id
    && item.target.version === input.target.version
    && item.relationKind === input.relationKind)
}

export function buildLegacyEvidenceCandidates(state: AppState, projectId: string): LegacyEvidenceCandidate[] {
  const candidates: LegacyEvidenceCandidate[] = []
  const push = (sourceType: LegacyEvidenceCandidate["sourceType"], sourceId: string, sourceTitle: string,
    attachment: Attachment) => {
    const existing = state.evidenceAssets.find(item => item.projectId === projectId
      && item.sourceAttachmentId === attachment.id)
    const alreadyLinked = Boolean(existing && state.evidenceLinks.some(item => item.projectId === projectId
      && item.evidenceId === existing.id && item.target.type === sourceType && item.target.id === sourceId
      && item.relationKind === "created_from" && item.status === "active"))
    candidates.push({ projectId, sourceType, sourceId, sourceTitle, attachment: { ...attachment },
      existingEvidenceId: existing?.id, alreadyLinked })
  }
  state.records.filter(item => item.projectId === projectId).forEach(record =>
    record.attachments.forEach(attachment => push("record", record.id, record.title, attachment)))
  state.recordRevisions.filter(item => item.projectId === projectId).forEach(revision =>
    revision.attachments.forEach(attachment => push("record_revision", revision.id,
      `${revision.title} · v${revision.version}`, attachment)))
  const byAttachment = new Map<string, LegacyEvidenceCandidate>()
  for (const candidate of candidates) {
    const current = byAttachment.get(candidate.attachment.id)
    if (!current || current.sourceType === "record_revision" && candidate.sourceType === "record") {
      byAttachment.set(candidate.attachment.id, candidate)
    }
  }
  return [...byAttachment.values()].filter(item => !item.alreadyLinked)
}
