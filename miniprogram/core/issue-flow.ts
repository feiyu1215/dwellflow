import { assertExpectedVersion, DomainError } from "./domain-error"

export type IssueWorkflowStatus =
  | "pending_confirmation"
  | "pending_action"
  | "pending_review"
  | "closed"

export type IssueProposalStatus = "pending" | "active" | "superseded"

export interface IssueProposalVersion {
  id: string
  content: string
  status: IssueProposalStatus
  submittedBy: string
  createdAt: string
  decidedBy?: string
  decidedAt?: string
  decisionReason?: string
}

export interface IssueTreatmentSubmission {
  id: string
  activeProposalId: string
  note: string
  evidenceSourceIds: string[]
  submittedBy: string
  submittedAt: string
}

export type IssueCloseReason = "resolved" | "not_required" | "duplicate" | "false_positive"

export interface IssueReviewRecord {
  id: string
  treatmentId: string
  decision: "returned" | "closed"
  note: string
  method: "evidence" | "on_site" | "reported"
  evidenceSourceIds: string[]
  closeReason?: IssueCloseReason
  duplicateOfIssueId?: string
  reviewedBy: string
  reviewedAt: string
}

export interface IssueReopeningRecord {
  id: string
  reason: string
  reopenedBy: string
  reopenedAt: string
}

export interface IssueWorkflow {
  id: string
  projectId: string
  title: string
  description: string
  status: IssueWorkflowStatus
  version: number
  proposals: IssueProposalVersion[]
  treatments: IssueTreatmentSubmission[]
  reviews: IssueReviewRecord[]
  reopenings: IssueReopeningRecord[]
  createdBy: string
  createdAt: string
  updatedAt: string
}

function normalizedIds(ids: string[]): string[] {
  return [...new Set(ids.map(item => item.trim()).filter(Boolean))]
}

export function createIssueWorkflow(input: {
  id: string
  projectId: string
  title: string
  description: string
  createdBy: string
  now: string
}): IssueWorkflow {
  if (!input.title.trim()) throw new DomainError("INVALID_INPUT", "事项标题不能为空")
  if (!input.description.trim()) throw new DomainError("INVALID_INPUT", "事项原因不能为空")
  return {
    id: input.id,
    projectId: input.projectId,
    title: input.title.trim(),
    description: input.description.trim(),
    status: "pending_confirmation",
    version: 1,
    proposals: [],
    treatments: [],
    reviews: [],
    reopenings: [],
    createdBy: input.createdBy,
    createdAt: input.now,
    updatedAt: input.now
  }
}

export function addIssueProposal(
  issue: IssueWorkflow,
  input: {
    id: string
    content: string
    expectedVersion: number
    submittedBy: string
    now: string
  }
): IssueWorkflow {
  assertExpectedVersion(issue.version, input.expectedVersion)
  if (issue.status !== "pending_confirmation" && issue.status !== "pending_action") {
    throw new DomainError("STATE_CONFLICT", "当前事项状态不能新增处理预案")
  }
  if (!input.content.trim()) throw new DomainError("INVALID_INPUT", "处理预案不能为空")
  if (issue.proposals.some(item => item.id === input.id)) {
    throw new DomainError("INVALID_INPUT", "处理预案标识不能重复")
  }
  return {
    ...issue,
    version: issue.version + 1,
    proposals: [...issue.proposals, {
      id: input.id,
      content: input.content.trim(),
      status: "pending",
      submittedBy: input.submittedBy,
      createdAt: input.now
    }],
    updatedAt: input.now
  }
}

export function selectIssueProposal(
  issue: IssueWorkflow,
  input: {
    proposalId: string
    expectedVersion: number
    reason?: string
    actorId: string
    now: string
  }
): IssueWorkflow {
  assertExpectedVersion(issue.version, input.expectedVersion)
  if (issue.status !== "pending_confirmation" && issue.status !== "pending_action") {
    throw new DomainError("STATE_CONFLICT", "当前事项状态不能选择处理预案")
  }
  const candidate = issue.proposals.find(item => item.id === input.proposalId)
  if (!candidate) throw new DomainError("NOT_FOUND", "处理预案不存在")
  if (candidate.status === "active") {
    throw new DomainError("STATE_CONFLICT", "该处理预案已经生效")
  }
  const current = issue.proposals.find(item => item.status === "active")
  if (current && !input.reason?.trim()) {
    throw new DomainError("INVALID_INPUT", "替换当前处理预案必须填写原因")
  }
  return {
    ...issue,
    status: "pending_action",
    version: issue.version + 1,
    proposals: issue.proposals.map(item => {
      if (item.id === candidate.id) {
        return {
          ...item,
          status: "active",
          decidedBy: input.actorId,
          decidedAt: input.now,
          decisionReason: input.reason?.trim()
        }
      }
      if (item.status === "active") {
        return {
          ...item,
          status: "superseded",
          decidedBy: input.actorId,
          decidedAt: input.now,
          decisionReason: input.reason!.trim()
        }
      }
      return item
    }),
    updatedAt: input.now
  }
}

export function submitIssueTreatment(
  issue: IssueWorkflow,
  input: {
    id: string
    expectedVersion: number
    note: string
    evidenceSourceIds?: string[]
    submittedBy: string
    now: string
  }
): IssueWorkflow {
  assertExpectedVersion(issue.version, input.expectedVersion)
  if (issue.status !== "pending_action") {
    throw new DomainError("STATE_CONFLICT", "只有待处理事项可以提交处理结果")
  }
  const activeProposal = issue.proposals.find(item => item.status === "active")
  if (!activeProposal) throw new DomainError("STATE_CONFLICT", "事项没有当前生效的处理预案")
  const evidenceSourceIds = normalizedIds(input.evidenceSourceIds || [])
  if (!input.note.trim() && evidenceSourceIds.length === 0) {
    throw new DomainError("INVALID_INPUT", "处理结果至少需要文字说明或证据")
  }
  if (issue.treatments.some(item => item.id === input.id)) {
    throw new DomainError("INVALID_INPUT", "处理提交标识不能重复")
  }
  return {
    ...issue,
    status: "pending_review",
    version: issue.version + 1,
    treatments: [...issue.treatments, {
      id: input.id,
      activeProposalId: activeProposal.id,
      note: input.note.trim(),
      evidenceSourceIds,
      submittedBy: input.submittedBy,
      submittedAt: input.now
    }],
    updatedAt: input.now
  }
}

export function reviewIssueTreatment(
  issue: IssueWorkflow,
  input: {
    id: string
    treatmentId: string
    expectedVersion: number
    decision: "returned" | "closed"
    note: string
    method: IssueReviewRecord["method"]
    evidenceSourceIds?: string[]
    closeReason?: IssueCloseReason
    duplicateOfIssueId?: string
    actorId: string
    now: string
  }
): IssueWorkflow {
  assertExpectedVersion(issue.version, input.expectedVersion)
  if (issue.status !== "pending_review") {
    throw new DomainError("STATE_CONFLICT", "只有待复查事项可以复查")
  }
  const latestTreatment = issue.treatments.at(-1)
  if (!latestTreatment || latestTreatment.id !== input.treatmentId) {
    throw new DomainError("VERSION_CONFLICT", "处理结果已变化，请复查最新提交")
  }
  if (!input.note.trim()) throw new DomainError("INVALID_INPUT", "复查必须填写实际依据")
  if (input.decision === "closed" && !input.closeReason) {
    throw new DomainError("INVALID_INPUT", "关闭事项必须选择关闭原因")
  }
  if (input.closeReason === "duplicate" && !input.duplicateOfIssueId?.trim()) {
    throw new DomainError("INVALID_INPUT", "重复事项必须关联主事项")
  }
  const review: IssueReviewRecord = {
    id: input.id,
    treatmentId: input.treatmentId,
    decision: input.decision,
    note: input.note.trim(),
    method: input.method,
    evidenceSourceIds: normalizedIds(input.evidenceSourceIds || []),
    closeReason: input.decision === "closed" ? input.closeReason : undefined,
    duplicateOfIssueId: input.closeReason === "duplicate"
      ? input.duplicateOfIssueId?.trim()
      : undefined,
    reviewedBy: input.actorId,
    reviewedAt: input.now
  }
  return {
    ...issue,
    status: input.decision === "closed" ? "closed" : "pending_action",
    version: issue.version + 1,
    reviews: [...issue.reviews, review],
    updatedAt: input.now
  }
}

export function reopenIssueWorkflow(
  issue: IssueWorkflow,
  input: {
    id: string
    expectedVersion: number
    reason: string
    actorId: string
    now: string
  }
): IssueWorkflow {
  assertExpectedVersion(issue.version, input.expectedVersion)
  if (issue.status !== "closed") {
    throw new DomainError("STATE_CONFLICT", "只有已关闭事项可以重新打开")
  }
  if (!input.reason.trim()) throw new DomainError("INVALID_INPUT", "重新打开必须填写原因")
  return {
    ...issue,
    status: "pending_action",
    version: issue.version + 1,
    reopenings: [...issue.reopenings, {
      id: input.id,
      reason: input.reason.trim(),
      reopenedBy: input.actorId,
      reopenedAt: input.now
    }],
    updatedAt: input.now
  }
}
