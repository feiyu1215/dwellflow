import { randomUUID } from "node:crypto"
import {
  addAgreementDraft,
  approveAgreementVersion,
  createAgreement,
  rejectAgreementVersion,
  resolveAgreementConflict,
  reviseAgreementDraft,
  submitAgreementVersion,
  withdrawAgreementVersion,
  type AgreementAggregate,
  type AgreementSourceConflict,
  type AgreementTerm
} from "../miniprogram/core/agreements.ts"
import { assertExpectedVersion, DomainError } from "../miniprogram/core/domain-error.ts"
import {
  allocateReceipt,
  appendInventoryEvent,
  appendUsageRecord,
  correctReceiptQuantity,
  createReceiptBatch,
  type MaterialInventoryEvent,
  type MaterialUsageRecord,
  type ReceiptBatch
} from "../miniprogram/core/material-flow.ts"
import { createPurchaseLine, type PurchaseLine } from "../miniprogram/core/procurement.ts"
import {
  addIssueProposal,
  createIssueWorkflow,
  reopenIssueWorkflow,
  reviewIssueTreatment,
  selectIssueProposal,
  submitIssueTreatment,
  type IssueWorkflow
} from "../miniprogram/core/issue-flow.ts"
import {
  appendApprovalEvent,
  createPaymentFact,
  createRefundFact,
  decidePaymentFact,
  decideRefundFact,
  type CostApprovalEvent,
  type PaymentFact,
  type RefundFact
} from "../miniprogram/core/finance.ts"
import type { Principal } from "./business-auth.ts"
import {
  ownerScopes,
  requireArea,
  requireAreaAction,
  requireOwner,
  requireProjectAccess,
  requireWritable,
  type ProjectAccess
} from "./business-access.ts"
import {
  type BusinessArea,
  type BusinessAuditEvent,
  type BusinessMembership,
  type BusinessObjectKind,
  type BusinessProject,
  type BusinessRepositoryContract,
  type StoredBusinessObject
} from "./business-repository.ts"
import { commandHash } from "./canonical-json.ts"
import { AppError } from "./validation.ts"
import {
  type BusinessCommandEnvelope,
  type BusinessCommandType,
  isObject,
  readId,
  readNonNegativeInteger,
  readOptionalText,
  readPositiveInteger,
  readStringArray,
  readText
} from "./business-validation.ts"

interface InventoryLedger {
  projectId: string
  materialId: string
  unit: string
  version: number
  events: MaterialInventoryEvent[]
  usages: MaterialUsageRecord[]
}

interface FinanceLedger {
  projectId: string
  costItemId: string
  version: number
  approvals: CostApprovalEvent[]
  payments: PaymentFact[]
  refunds: RefundFact[]
}

interface OwnerTransfer {
  id: string
  projectId: string
  fromOwnerId: string
  toUserId: string
  status: "pending" | "accepted"
  version: number
  createdAt: string
  acceptedAt?: string
}

interface ApprovedChangeRecord {
  id: string
  projectId: string
  agreementId: string
  agreementVersionId: string
  costItemId: string
  costAction: "increase" | "decrease"
  amountFen: number
  deliveryImpact?: string
  reason: string
  approvedBy: string
  approvedAt: string
}

interface DispatchResult {
  response: unknown
  audits: Array<Omit<BusinessAuditEvent, "id" | "projectId" | "actorId" | "requestId" | "createdAt">>
}

const OBJECT_AREA: Record<Exclude<BusinessObjectKind, "owner_transfer">, BusinessArea> = {
  agreement: "agreements",
  purchase_line: "materials",
  receipt: "materials",
  inventory_ledger: "materials",
  issue: "issues",
  finance_ledger: "expenses",
  change_request: "agreements"
}

function nowIso(): string {
  return new Date().toISOString()
}

export class BusinessService {
  readonly repo: BusinessRepositoryContract

  constructor(repo: BusinessRepositoryContract) {
    this.repo = repo
  }

  createProject(principal: Principal, input: { requestId: unknown; name: unknown }): BusinessProject {
    const requestId = readId(input.requestId, "requestId")
    const name = readText(input.name, "项目昵称", 100)
    const hash = commandHash({ type: "project.create", name })
    return this.repo.transaction(() => {
      const replay = this.repo.getCommand(principal.id, requestId)
      if (replay) {
        if (replay.requestHash !== hash) throw new AppError(409, "同一请求标识不能用于不同操作")
        return replay.response as BusinessProject
      }
      const now = nowIso()
      const project: BusinessProject = {
        id: randomUUID(), name, ownerId: principal.id, status: "active",
        version: 1, createdAt: now, updatedAt: now
      }
      const owner: BusinessMembership = {
        projectId: project.id,
        userId: principal.id,
        displayName: principal.displayName,
        role: "owner",
        scopes: ownerScopes(),
        status: "active",
        version: 1,
        createdAt: now,
        updatedAt: now
      }
      this.repo.createProject(project, owner)
      this.repo.checkpoint("project.create.after_save")
      this.repo.appendAudit({
        projectId: project.id,
        actorId: principal.id,
        action: "project.create",
        objectKind: "project",
        objectId: project.id,
        afterVersion: 1,
        requestId,
        metadata: {},
        createdAt: now
      })
      this.repo.saveCommand({
        principalId: principal.id, requestId, projectId: project.id,
        requestHash: hash, response: project
      }, now)
      return project
    })
  }

  listProjects(principal: Principal): BusinessProject[] {
    return this.repo.listProjects(principal.id)
  }

  getProject(principal: Principal, projectId: string) {
    const access = requireProjectAccess(this.repo, principal, readId(projectId, "projectId"))
    return {
      project: access.project,
      membership: access.membership,
      members: access.project.ownerId === principal.id
        ? this.repo.listMemberships(projectId)
        : undefined
    }
  }

  execute(
    principal: Principal,
    projectId: string,
    command: BusinessCommandEnvelope
  ): unknown {
    readId(projectId, "projectId")
    const hash = commandHash({ projectId, type: command.type, payload: command.payload })
    return this.repo.transaction(() => {
      const access = requireProjectAccess(this.repo, principal, projectId)
      this.authorize(access, principal, command)
      const replay = this.repo.getCommand(principal.id, command.requestId)
      if (replay) {
        if (replay.requestHash !== hash || replay.projectId !== projectId) {
          throw new AppError(409, "同一请求标识不能用于不同操作")
        }
        return replay.response
      }
      if (command.type !== "project.reopen") requireWritable(access)
      const now = nowIso()
      const result = this.dispatch(access, principal, command, now)
      const response = JSON.parse(JSON.stringify(result.response)) as unknown
      this.repo.checkpoint("business.before_audit")
      for (const audit of result.audits) {
        this.repo.appendAudit({
          ...audit,
          projectId,
          actorId: principal.id,
          requestId: command.requestId,
          createdAt: now
        })
      }
      this.repo.checkpoint("business.before_command_receipt")
      this.repo.saveCommand({
        principalId: principal.id,
        requestId: command.requestId,
        projectId,
        requestHash: hash,
        response
      }, now)
      return response
    })
  }

  getObject(
    principal: Principal,
    projectId: string,
    kind: BusinessObjectKind,
    objectId: string
  ): StoredBusinessObject {
    const access = requireProjectAccess(this.repo, principal, readId(projectId, "projectId"))
    if (kind === "owner_transfer") {
      requireOwner(access)
    } else {
      requireArea(access, OBJECT_AREA[kind])
    }
    const stored = this.repo.getObject(projectId, kind, readId(objectId, "objectId"))
    if (!stored) throw new AppError(404, "对象不存在或无权访问")
    this.requireObjectScope(access, stored)
    return stored
  }

  listObjects(
    principal: Principal,
    projectId: string,
    kind: Exclude<BusinessObjectKind, "owner_transfer">,
    limit = 100
  ): StoredBusinessObject[] {
    const access = requireProjectAccess(this.repo, principal, readId(projectId, "projectId"))
    requireArea(access, OBJECT_AREA[kind])
    return this.repo.listObjects(projectId, kind, limit)
      .filter(item => this.objectIsInScope(access, item))
  }

  listAudit(principal: Principal, projectId: string, limit = 100): BusinessAuditEvent[] {
    const access = requireProjectAccess(this.repo, principal, readId(projectId, "projectId"))
    requireOwner(access)
    return this.repo.listAudit(projectId, limit)
  }

  private authorize(
    access: ProjectAccess,
    _principal: Principal,
    command: BusinessCommandEnvelope
  ): void {
    const ownerOnly: BusinessCommandType[] = [
      "project.archive", "project.reopen", "member.put", "owner_transfer.initiate",
      "agreement.approve", "agreement.resolve_conflict", "agreement.reject",
      "receipt.allocate", "issue.select_proposal", "issue.review", "issue.reopen",
      "inventory.append", "cost.approval", "payment.decide", "refund.decide",
      "change.approve"
    ]
    if (ownerOnly.includes(command.type)) {
      requireOwner(access)
      return
    }
    if (command.type === "owner_transfer.accept") return
    if (command.type.startsWith("agreement.")) {
      const action = ["agreement.create", "agreement.add_draft", "agreement.revise"]
        .includes(command.type) ? "create_draft" : "submit_fact"
      const agreementId = command.type === "agreement.create"
        ? readId(command.payload.id, "agreementId")
        : readId(command.payload.agreementId, "agreementId")
      requireAreaAction(access, "agreements", action, agreementId)
      return
    }
    if (command.type === "receipt.correct") {
      const receiptId = readId(command.payload.receiptId, "receiptId")
      const receipt = this.repo.getObject<ReceiptBatch>(
        access.project.id, "receipt", receiptId
      )
      requireAreaAction(access, "materials", "submit_fact", receipt?.value.materialId)
      return
    }
    if (["purchase.create", "receipt.create", "usage.append"]
      .includes(command.type)) {
      const materialId = readId(command.payload.materialId, "materialId")
      requireAreaAction(access, "materials", "submit_fact", materialId)
      return
    }
    if (command.type.startsWith("issue.")) {
      const issueId = readId(command.payload.issueId || command.payload.id, "issueId")
      requireAreaAction(access, "issues", "submit_fact", issueId)
      return
    }
    if (["payment.create", "refund.create"].includes(command.type)) {
      const costItemId = readId(command.payload.costItemId, "costItemId")
      requireAreaAction(access, "expenses", "submit_fact", costItemId)
      return
    }
    throw new AppError(400, "不支持的业务命令")
  }

  private requireObjectScope(
    access: ProjectAccess,
    stored: StoredBusinessObject
  ): void {
    if (!this.objectIsInScope(access, stored)) {
      throw new AppError(404, "对象不存在或无权访问")
    }
  }

  private objectIsInScope(
    access: ProjectAccess,
    stored: StoredBusinessObject
  ): boolean {
    try {
      if (stored.kind === "purchase_line" || stored.kind === "receipt"
        || stored.kind === "inventory_ledger") {
        const value = stored.value as { materialId?: string }
        requireArea(access, "materials", value.materialId)
      } else if (stored.kind === "issue") {
        requireArea(access, "issues", stored.id)
      } else if (stored.kind === "agreement") {
        requireArea(access, "agreements", stored.id)
      } else if (stored.kind === "finance_ledger") {
        requireArea(access, "expenses", stored.id)
      } else if (stored.kind === "change_request") {
        const value = stored.value as {
          agreementId?: string
          costItemId?: string
        }
        requireArea(access, "agreements", value.agreementId)
        requireArea(access, "expenses", value.costItemId)
      }
      return true
    } catch (error) {
      if (error instanceof AppError && error.status === 403) return false
      throw error
    }
  }

  private loadObject<T>(
    projectId: string,
    kind: BusinessObjectKind,
    id: string
  ): StoredBusinessObject<T> {
    const stored = this.repo.getObject<T>(projectId, kind, id)
    if (!stored) throw new DomainError("NOT_FOUND", "业务对象不存在")
    return stored
  }

  private saveObject<T>(
    stored: StoredBusinessObject<T>,
    value: T,
    now: string
  ): StoredBusinessObject<T> {
    return this.repo.saveObject({
      projectId: stored.projectId,
      kind: stored.kind,
      id: stored.id,
      value,
      updatedAt: now
    }, stored.rowVersion)
  }

  private audit(
    action: string,
    objectKind: string,
    objectId: string,
    beforeVersion: number | undefined,
    afterVersion: number | undefined,
    metadata: Record<string, unknown> = {}
  ): DispatchResult["audits"][number] {
    return { action, objectKind, objectId, beforeVersion, afterVersion, metadata }
  }

  private dispatch(
    access: ProjectAccess,
    principal: Principal,
    command: BusinessCommandEnvelope,
    now: string
  ): DispatchResult {
    switch (command.type) {
      case "project.archive":
      case "project.reopen":
        return this.changeProjectStatus(access, command, now)
      case "member.put":
        return this.putMember(access, command, now)
      case "owner_transfer.initiate":
        return this.initiateOwnerTransfer(access, command, now)
      case "owner_transfer.accept":
        return this.acceptOwnerTransfer(access, principal, command, now)
      case "agreement.create":
      case "agreement.add_draft":
      case "agreement.revise":
      case "agreement.resolve_conflict":
      case "agreement.submit":
      case "agreement.approve":
      case "agreement.withdraw":
      case "agreement.reject":
        return this.handleAgreement(access, principal, command, now)
      case "purchase.create":
        return this.createPurchase(access, command, now)
      case "receipt.create":
        return this.createReceipt(access, principal, command, now)
      case "receipt.correct":
        return this.correctReceipt(access, principal, command, now)
      case "receipt.allocate":
        return this.allocateReceipt(access, principal, command, now)
      case "inventory.append":
      case "usage.append":
        return this.handleInventory(access, principal, command, now)
      case "issue.create":
      case "issue.add_proposal":
      case "issue.select_proposal":
      case "issue.submit_treatment":
      case "issue.review":
      case "issue.reopen":
        return this.handleIssue(access, principal, command, now)
      case "cost.approval":
      case "payment.create":
      case "payment.decide":
      case "refund.create":
      case "refund.decide":
        return this.handleFinance(access, principal, command, now)
      case "change.approve":
        return this.approveCombinedChange(access, principal, command, now)
    }
  }

  private changeProjectStatus(
    access: ProjectAccess,
    command: BusinessCommandEnvelope,
    now: string
  ): DispatchResult {
    const expectedVersion = readPositiveInteger(command.payload.expectedVersion, "expectedVersion")
    assertExpectedVersion(access.project.version, expectedVersion)
    const target = command.type === "project.archive" ? "archived" : "active"
    if (access.project.status === target) {
      throw new DomainError("STATE_CONFLICT", target === "archived" ? "项目已经归档" : "项目已经打开")
    }
    const next: BusinessProject = {
      ...access.project,
      status: target,
      version: access.project.version + 1,
      updatedAt: now
    }
    this.repo.saveProject(next, access.project.version)
    return {
      response: next,
      audits: [this.audit(command.type, "project", next.id,
        access.project.version, next.version)]
    }
  }

  private putMember(
    access: ProjectAccess,
    command: BusinessCommandEnvelope,
    now: string
  ): DispatchResult {
    const payload = command.payload
    const userId = readId(payload.userId, "userId")
    if (userId === access.project.ownerId) {
      throw new AppError(409, "当前负责人不能通过成员命令修改或撤销")
    }
    if (!["family", "collaborator"].includes(String(payload.role))) {
      throw new AppError(400, "成员角色格式不正确")
    }
    if (!["active", "revoked"].includes(String(payload.status))) {
      throw new AppError(400, "成员状态格式不正确")
    }
    const areas = readStringArray(payload.areas, "areas") as BusinessArea[]
    const allowedAreas = new Set<BusinessArea>([
      "records", "agreements", "materials", "issues", "expenses", "ai", "camera"
    ])
    if (!areas.length || areas.some(area => !allowedAreas.has(area))) {
      throw new AppError(400, "成员资料范围格式不正确")
    }
    const expectedVersion = readNonNegativeInteger(payload.expectedVersion, "expectedVersion")
    const existing = this.repo.getMembership(access.project.id, userId)
    if ((!existing && expectedVersion !== 0)
      || (existing && existing.version !== expectedVersion)) {
      throw new DomainError("VERSION_CONFLICT", "成员关系已被更新，请核对后重试")
    }
    const membership: BusinessMembership = {
      projectId: access.project.id,
      userId,
      displayName: readText(payload.displayName, "成员名称", 100),
      role: payload.role as BusinessMembership["role"],
      scopes: {
        areas,
        recordIds: payload.recordIds === undefined
          ? undefined : readStringArray(payload.recordIds, "recordIds"),
        agreementIds: payload.agreementIds === undefined
          ? undefined : readStringArray(payload.agreementIds, "agreementIds"),
        materialIds: payload.materialIds === undefined
          ? undefined : readStringArray(payload.materialIds, "materialIds"),
        issueIds: payload.issueIds === undefined
          ? undefined : readStringArray(payload.issueIds, "issueIds"),
        expenseIds: payload.expenseIds === undefined
          ? undefined : readStringArray(payload.expenseIds, "expenseIds")
      },
      status: payload.status as BusinessMembership["status"],
      version: existing ? existing.version + 1 : 1,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    }
    this.repo.putMembership(membership, existing?.version)
    return {
      response: membership,
      audits: [this.audit("member.put", "membership", userId,
        existing?.version, membership.version, { status: membership.status, role: membership.role })]
    }
  }

  private initiateOwnerTransfer(
    access: ProjectAccess,
    command: BusinessCommandEnvelope,
    now: string
  ): DispatchResult {
    const id = readId(command.payload.id, "transferId")
    const targetUserId = readId(command.payload.targetUserId, "targetUserId")
    const expectedProjectVersion = readPositiveInteger(
      command.payload.expectedProjectVersion, "expectedProjectVersion"
    )
    assertExpectedVersion(access.project.version, expectedProjectVersion)
    const target = this.repo.getMembership(access.project.id, targetUserId)
    if (!target || target.status !== "active" || target.role !== "family") {
      throw new AppError(409, "负责人只能移交给当前有效的家庭成员")
    }
    const transfer: OwnerTransfer = {
      id,
      projectId: access.project.id,
      fromOwnerId: access.project.ownerId,
      toUserId: targetUserId,
      status: "pending",
      version: 1,
      createdAt: now
    }
    const stored = this.repo.createObject(
      access.project.id, "owner_transfer", id, transfer, now
    )
    return {
      response: stored,
      audits: [this.audit("owner_transfer.initiate", "owner_transfer", id,
        undefined, stored.rowVersion, { targetUserId })]
    }
  }

  private acceptOwnerTransfer(
    access: ProjectAccess,
    principal: Principal,
    command: BusinessCommandEnvelope,
    now: string
  ): DispatchResult {
    const transferId = readId(command.payload.transferId, "transferId")
    const expectedVersion = readPositiveInteger(command.payload.expectedVersion, "expectedVersion")
    const expectedProjectVersion = readPositiveInteger(
      command.payload.expectedProjectVersion, "expectedProjectVersion"
    )
    const stored = this.loadObject<OwnerTransfer>(
      access.project.id, "owner_transfer", transferId
    )
    const transfer = stored.value
    assertExpectedVersion(transfer.version, expectedVersion)
    assertExpectedVersion(access.project.version, expectedProjectVersion)
    if (transfer.status !== "pending") throw new DomainError("STATE_CONFLICT", "负责人移交已处理")
    if (transfer.toUserId !== principal.id) throw new AppError(403, "只有指定家庭成员可以接受移交")
    if (transfer.fromOwnerId !== access.project.ownerId) {
      throw new DomainError("VERSION_CONFLICT", "项目负责人已变化，本次移交失效")
    }
    const oldOwner = this.repo.getMembership(access.project.id, transfer.fromOwnerId)
    const newOwner = this.repo.getMembership(access.project.id, transfer.toUserId)
    if (!oldOwner || !newOwner || newOwner.status !== "active" || newOwner.role !== "family") {
      throw new DomainError("STATE_CONFLICT", "移交双方成员状态已变化")
    }
    const nextProject: BusinessProject = {
      ...access.project,
      ownerId: transfer.toUserId,
      version: access.project.version + 1,
      updatedAt: now
    }
    this.repo.saveProject(nextProject, access.project.version)
    this.repo.checkpoint("owner_transfer.after_project")
    this.repo.putMembership({
      ...oldOwner, role: "family", scopes: ownerScopes(),
      version: oldOwner.version + 1, updatedAt: now
    }, oldOwner.version)
    this.repo.putMembership({
      ...newOwner, role: "owner", scopes: ownerScopes(),
      version: newOwner.version + 1, updatedAt: now
    }, newOwner.version)
    const nextTransfer: OwnerTransfer = {
      ...transfer, status: "accepted", version: transfer.version + 1, acceptedAt: now
    }
    const saved = this.saveObject(stored, nextTransfer, now)
    return {
      response: { project: nextProject, transfer: saved },
      audits: [
        this.audit("owner_transfer.accept", "project", nextProject.id,
          access.project.version, nextProject.version, {
            previousOwnerId: transfer.fromOwnerId,
            newOwnerId: transfer.toUserId
          }),
        this.audit("owner_transfer.accept", "owner_transfer", transfer.id,
          transfer.version, nextTransfer.version)
      ]
    }
  }

  private readAgreementTerms(value: unknown): AgreementTerm[] {
    if (!Array.isArray(value) || !value.length || value.length > 100) {
      throw new AppError(400, "约定条目格式不正确")
    }
    return value.map((item, index) => {
      if (!isObject(item)) throw new AppError(400, "约定条目格式不正确")
      return {
        key: readId(item.key, "约定条目 " + (index + 1) + " key"),
        label: readText(item.label, "约定条目名称", 100),
        value: readText(item.value, "约定条目值", 1000)
      }
    })
  }

  private readAgreementConflicts(value: unknown): AgreementSourceConflict[] | undefined {
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.length > 50) {
      throw new AppError(400, "来源冲突格式不正确")
    }
    return value.map(item => {
      if (!isObject(item) || !Array.isArray(item.alternatives)) {
        throw new AppError(400, "来源冲突格式不正确")
      }
      return {
        id: readId(item.id, "来源冲突 id"),
        termKey: readId(item.termKey, "来源冲突字段"),
        alternatives: item.alternatives.map(alternative => {
          if (!isObject(alternative)) throw new AppError(400, "来源冲突候选格式不正确")
          return {
            value: readText(alternative.value, "来源冲突候选值", 1000),
            sourceIds: readStringArray(alternative.sourceIds, "来源标识")
          }
        })
      }
    })
  }

  private handleAgreement(
    access: ProjectAccess,
    principal: Principal,
    command: BusinessCommandEnvelope,
    now: string
  ): DispatchResult {
    const payload = command.payload
    if (command.type === "agreement.create") {
      const id = readId(payload.id, "agreementId")
      if (!["material", "construction"].includes(String(payload.subject))) {
        throw new AppError(400, "约定对象类型不正确")
      }
      const aggregate = createAgreement({
        id,
        versionId: readId(payload.versionId, "versionId"),
        projectId: access.project.id,
        subject: payload.subject as "material" | "construction",
        subjectId: payload.subjectId === undefined ? undefined : readId(payload.subjectId, "subjectId"),
        title: readText(payload.title, "约定标题", 200),
        terms: this.readAgreementTerms(payload.terms),
        sourceIds: payload.sourceIds === undefined
          ? undefined : readStringArray(payload.sourceIds, "sourceIds"),
        sourceConflicts: this.readAgreementConflicts(payload.sourceConflicts),
        actorId: principal.id,
        now
      })
      const stored = this.repo.createObject(
        access.project.id, "agreement", id, aggregate, now
      )
      return {
        response: stored,
        audits: [this.audit(command.type, "agreement", id,
          undefined, aggregate.agreement.version)]
      }
    }
    const agreementId = readId(payload.agreementId, "agreementId")
    const stored = this.loadObject<AgreementAggregate>(
      access.project.id, "agreement", agreementId
    )
    const expectedVersion = readPositiveInteger(payload.expectedVersion, "expectedVersion")
    const versionId = readId(payload.versionId, "versionId")
    const candidate = stored.value.versions.find(item => item.id === versionId)
    if (command.type !== "agreement.add_draft" && !candidate) {
      throw new DomainError("NOT_FOUND", "约定版本不存在")
    }
    if (access.project.ownerId !== principal.id
      && ["agreement.revise", "agreement.submit", "agreement.withdraw"].includes(command.type)
      && candidate!.createdBy !== principal.id) {
      throw new AppError(403, "只能修改、送审或撤回自己创建的约定草稿")
    }
    let next: AgreementAggregate
    if (command.type === "agreement.add_draft") {
      next = addAgreementDraft(stored.value, {
        id: versionId,
        expectedVersion,
        terms: this.readAgreementTerms(payload.terms),
        sourceIds: payload.sourceIds === undefined
          ? undefined : readStringArray(payload.sourceIds, "sourceIds"),
        sourceConflicts: this.readAgreementConflicts(payload.sourceConflicts),
        actorId: principal.id,
        now
      })
    } else if (command.type === "agreement.revise") {
      next = reviseAgreementDraft(stored.value, {
        versionId,
        expectedVersion,
        terms: this.readAgreementTerms(payload.terms),
        sourceIds: payload.sourceIds === undefined
          ? undefined : readStringArray(payload.sourceIds, "sourceIds"),
        sourceConflicts: this.readAgreementConflicts(payload.sourceConflicts),
        now
      })
    } else if (command.type === "agreement.resolve_conflict") {
      next = resolveAgreementConflict(stored.value, {
        versionId,
        conflictId: readId(payload.conflictId, "conflictId"),
        selectedValue: readText(payload.selectedValue, "采用值", 1000),
        reason: readText(payload.reason, "基线选择原因", 1000),
        expectedVersion,
        actorId: principal.id,
        now
      })
    } else if (command.type === "agreement.submit") {
      next = submitAgreementVersion(
        stored.value, versionId, expectedVersion, now
      )
    } else if (command.type === "agreement.approve") {
      next = approveAgreementVersion(
        stored.value, versionId, expectedVersion, principal.id, now
      )
    } else if (command.type === "agreement.withdraw") {
      next = withdrawAgreementVersion(
        stored.value, versionId, expectedVersion, principal.id, now
      )
    } else {
      next = rejectAgreementVersion(
        stored.value, versionId, expectedVersion, principal.id, now
      )
    }
    const saved = this.saveObject(stored, next, now)
    return {
      response: saved,
      audits: [this.audit(command.type, "agreement", agreementId,
        stored.value.agreement.version, next.agreement.version)]
    }
  }

  private createPurchase(
    access: ProjectAccess,
    command: BusinessCommandEnvelope,
    now: string
  ): DispatchResult {
    const payload = command.payload
    const id = readId(payload.id, "purchaseLineId")
    const materialId = readId(payload.materialId, "materialId")
    const agreementVersionId = payload.agreementVersionId === undefined
      ? undefined : readId(payload.agreementVersionId, "agreementVersionId")
    if (agreementVersionId) {
      const agreementId = readId(payload.agreementId, "agreementId")
      const agreement = this.loadObject<AgreementAggregate>(
        access.project.id, "agreement", agreementId
      ).value
      if (!agreement.versions.some(item => item.id === agreementVersionId
        && item.status === "active")) {
        throw new AppError(409, "采购行关联的约定版本未生效或不存在")
      }
    }
    const line = createPurchaseLine({
      id,
      projectId: access.project.id,
      materialId,
      agreementVersionId,
      orderedQuantityMilli: readPositiveInteger(payload.orderedQuantityMilli, "订单数量"),
      unit: readText(payload.unit, "订单单位", 50),
      createdAt: now
    })
    const stored = this.repo.createObject(
      access.project.id, "purchase_line", id, line, now
    )
    return {
      response: stored,
      audits: [this.audit(command.type, "purchase_line", id, undefined, 1)]
    }
  }

  private createReceipt(
    access: ProjectAccess,
    principal: Principal,
    command: BusinessCommandEnvelope,
    now: string
  ): DispatchResult {
    const payload = command.payload
    const id = readId(payload.id, "receiptId")
    const materialId = readId(payload.materialId, "materialId")
    const purchaseLineId = payload.purchaseLineId === undefined
      ? undefined : readId(payload.purchaseLineId, "purchaseLineId")
    if (purchaseLineId) {
      const line = this.loadObject<PurchaseLine>(
        access.project.id, "purchase_line", purchaseLineId
      ).value
      if (line.materialId !== materialId) {
        throw new AppError(409, "到货批次与采购行材料不一致")
      }
    }
    const quantityMilli = payload.quantityMilli === undefined
      ? undefined : readPositiveInteger(payload.quantityMilli, "实到数量")
    const batch = createReceiptBatch({
      id,
      projectId: access.project.id,
      purchaseLineId,
      materialId,
      unit: readText(payload.unit, "到货单位", 50),
      occurredAt: readText(payload.occurredAt, "实际发生时间", 100),
      quantity: quantityMilli === undefined ? undefined : {
        id: randomUUID(),
        requestId: command.requestId,
        quantityMilli,
        actorId: principal.id,
        createdAt: now
      }
    })
    const stored = this.repo.createObject(
      access.project.id, "receipt", id, batch, now
    )
    return {
      response: stored,
      audits: [this.audit(command.type, "receipt", id, undefined, batch.version)]
    }
  }

  private correctReceipt(
    access: ProjectAccess,
    principal: Principal,
    command: BusinessCommandEnvelope,
    now: string
  ): DispatchResult {
    const receiptId = readId(command.payload.receiptId, "receiptId")
    const stored = this.loadObject<ReceiptBatch>(
      access.project.id, "receipt", receiptId
    )
    requireArea(access, "materials", stored.value.materialId)
    const next = correctReceiptQuantity(stored.value, {
      id: randomUUID(),
      requestId: command.requestId,
      expectedVersion: readPositiveInteger(
        command.payload.expectedVersion, "expectedVersion"
      ),
      quantityMilli: readPositiveInteger(command.payload.quantityMilli, "实到数量"),
      reason: readText(command.payload.reason, "数量更正原因", 1000),
      actorId: principal.id,
      createdAt: now
    })
    const saved = this.saveObject(stored, next, now)
    return {
      response: saved,
      audits: [this.audit(command.type, "receipt", receiptId,
        stored.value.version, next.version)]
    }
  }

  private allocateReceipt(
    access: ProjectAccess,
    principal: Principal,
    command: BusinessCommandEnvelope,
    now: string
  ): DispatchResult {
    const payload = command.payload
    const receiptId = readId(payload.receiptId, "receiptId")
    const stored = this.loadObject<ReceiptBatch>(
      access.project.id, "receipt", receiptId
    )
    if (!["accepted_available", "marked_return", "completed_return"]
      .includes(String(payload.kind))) {
      throw new AppError(400, "到货处理类型不正确")
    }
    const allocationId = randomUUID()
    const nextBatch = allocateReceipt(stored.value, {
      id: allocationId,
      requestId: command.requestId,
      expectedVersion: readPositiveInteger(payload.expectedVersion, "expectedVersion"),
      kind: payload.kind as "accepted_available" | "marked_return" | "completed_return",
      quantityMilli: readPositiveInteger(payload.quantityMilli, "处理数量"),
      actorId: principal.id,
      createdAt: now
    })
    const savedReceipt = this.saveObject(stored, nextBatch, now)
    this.repo.checkpoint("receipt.allocate.after_receipt")
    const audits: DispatchResult["audits"] = [
      this.audit(command.type, "receipt", receiptId,
        stored.value.version, nextBatch.version, { kind: payload.kind })
    ]
    let savedInventory: StoredBusinessObject<InventoryLedger> | undefined
    if (payload.kind === "accepted_available") {
      const expectedInventoryVersion = readNonNegativeInteger(
        payload.expectedInventoryVersion, "expectedInventoryVersion"
      )
      const current = this.repo.getObject<InventoryLedger>(
        access.project.id, "inventory_ledger", stored.value.materialId
      )
      const ledger: InventoryLedger = current?.value || {
        projectId: access.project.id,
        materialId: stored.value.materialId,
        unit: stored.value.unit,
        version: 0,
        events: [],
        usages: []
      }
      assertExpectedVersion(ledger.version, expectedInventoryVersion)
      if (ledger.unit !== stored.value.unit) {
        throw new DomainError("STATE_CONFLICT", "库存单位不同，需先确认单位换算")
      }
      const event: MaterialInventoryEvent = {
        id: randomUUID(),
        requestId: command.requestId,
        projectId: access.project.id,
        materialId: stored.value.materialId,
        unit: stored.value.unit,
        action: "available_received",
        quantityMilli: readPositiveInteger(payload.quantityMilli, "处理数量"),
        sourceReceiptAllocationId: allocationId,
        actorId: principal.id,
        createdAt: now
      }
      const nextLedger: InventoryLedger = {
        ...ledger,
        version: ledger.version + 1,
        events: appendInventoryEvent(ledger.events, ledger.usages, event)
      }
      savedInventory = current
        ? this.saveObject(current, nextLedger, now)
        : this.repo.createObject(
          access.project.id, "inventory_ledger", ledger.materialId, nextLedger, now
        )
      audits.push(this.audit("inventory.available_received", "inventory_ledger",
        ledger.materialId, ledger.version, nextLedger.version,
        { receiptId, allocationId }))
    }
    return {
      response: { receipt: savedReceipt, inventory: savedInventory },
      audits
    }
  }

  private handleInventory(
    access: ProjectAccess,
    principal: Principal,
    command: BusinessCommandEnvelope,
    now: string
  ): DispatchResult {
    const payload = command.payload
    const materialId = readId(payload.materialId, "materialId")
    const current = this.repo.getObject<InventoryLedger>(
      access.project.id, "inventory_ledger", materialId
    )
    if (!current) throw new DomainError("NOT_FOUND", "材料库存账不存在")
    const ledger = current.value
    const expectedVersion = readPositiveInteger(payload.expectedVersion, "expectedVersion")
    assertExpectedVersion(ledger.version, expectedVersion)
    if (command.type === "inventory.append") {
      const allowed = [
        "issued", "returned_site", "returned_supplier", "warehouse_waste",
        "adjustment_increase", "adjustment_decrease"
      ]
      if (!allowed.includes(String(payload.action))) {
        throw new AppError(400, "库存动作格式不正确")
      }
      if (String(payload.action).startsWith("adjustment_")) requireOwner(access)
      const unit = readText(payload.unit, "库存单位", 50)
      if (unit !== ledger.unit) {
        throw new DomainError("STATE_CONFLICT", "库存单位不同，需先确认单位换算")
      }
      const event: MaterialInventoryEvent = {
        id: randomUUID(),
        requestId: command.requestId,
        projectId: access.project.id,
        materialId,
        unit,
        action: payload.action as MaterialInventoryEvent["action"],
        quantityMilli: readPositiveInteger(payload.quantityMilli, "库存数量"),
        sourceEventId: payload.sourceEventId === undefined
          ? undefined : readId(payload.sourceEventId, "sourceEventId"),
        reason: readOptionalText(payload.reason, "原因", 1000),
        actorId: principal.id,
        createdAt: now
      }
      const next: InventoryLedger = {
        ...ledger,
        version: ledger.version + 1,
        events: appendInventoryEvent(ledger.events, ledger.usages, event)
      }
      const saved = this.saveObject(current, next, now)
      return {
        response: saved,
        audits: [this.audit(command.type, "inventory_ledger", materialId,
          ledger.version, next.version, { action: event.action })]
      }
    }
    const usage: MaterialUsageRecord = {
      id: randomUUID(),
      requestId: command.requestId,
      projectId: access.project.id,
      materialId,
      issuedEventId: readId(payload.issuedEventId, "issuedEventId"),
      quantityMilli: readPositiveInteger(payload.quantityMilli, "使用数量"),
      actorId: principal.id,
      createdAt: now
    }
    const next: InventoryLedger = {
      ...ledger,
      version: ledger.version + 1,
      usages: appendUsageRecord(ledger.events, ledger.usages, usage)
    }
    const saved = this.saveObject(current, next, now)
    return {
      response: saved,
      audits: [this.audit(command.type, "inventory_ledger", materialId,
        ledger.version, next.version)]
    }
  }

  private handleIssue(
    access: ProjectAccess,
    principal: Principal,
    command: BusinessCommandEnvelope,
    now: string
  ): DispatchResult {
    const payload = command.payload
    if (command.type === "issue.create") {
      const id = readId(payload.id, "issueId")
      const issue = createIssueWorkflow({
        id,
        projectId: access.project.id,
        title: readText(payload.title, "事项标题", 200),
        description: readText(payload.description, "事项原因", 4000),
        createdBy: principal.id,
        now
      })
      const stored = this.repo.createObject(access.project.id, "issue", id, issue, now)
      return {
        response: stored,
        audits: [this.audit(command.type, "issue", id, undefined, issue.version)]
      }
    }
    const issueId = readId(payload.issueId, "issueId")
    const stored = this.loadObject<IssueWorkflow>(access.project.id, "issue", issueId)
    const expectedVersion = readPositiveInteger(payload.expectedVersion, "expectedVersion")
    let next: IssueWorkflow
    if (command.type === "issue.add_proposal") {
      next = addIssueProposal(stored.value, {
        id: readId(payload.proposalId, "proposalId"),
        content: readText(payload.content, "处理预案", 4000),
        expectedVersion,
        submittedBy: principal.id,
        now
      })
    } else if (command.type === "issue.select_proposal") {
      next = selectIssueProposal(stored.value, {
        proposalId: readId(payload.proposalId, "proposalId"),
        expectedVersion,
        reason: readOptionalText(payload.reason, "替换原因", 1000),
        actorId: principal.id,
        now
      })
    } else if (command.type === "issue.submit_treatment") {
      next = submitIssueTreatment(stored.value, {
        id: readId(payload.treatmentId, "treatmentId"),
        expectedVersion,
        note: typeof payload.note === "string" ? payload.note : "",
        evidenceSourceIds: payload.evidenceSourceIds === undefined
          ? undefined : readStringArray(payload.evidenceSourceIds, "evidenceSourceIds"),
        submittedBy: principal.id,
        now
      })
    } else if (command.type === "issue.review") {
      if (!["returned", "closed"].includes(String(payload.decision))) {
        throw new AppError(400, "复查决定格式不正确")
      }
      if (!["evidence", "on_site", "reported"].includes(String(payload.method))) {
        throw new AppError(400, "复查方式格式不正确")
      }
      if (payload.closeReason !== undefined
        && !["resolved", "not_required", "duplicate", "false_positive"]
          .includes(String(payload.closeReason))) {
        throw new AppError(400, "关闭原因格式不正确")
      }
      next = reviewIssueTreatment(stored.value, {
        id: readId(payload.reviewId, "reviewId"),
        treatmentId: readId(payload.treatmentId, "treatmentId"),
        expectedVersion,
        decision: payload.decision as "returned" | "closed",
        note: readText(payload.note, "复查依据", 4000),
        method: payload.method as "evidence" | "on_site" | "reported",
        evidenceSourceIds: payload.evidenceSourceIds === undefined
          ? undefined : readStringArray(payload.evidenceSourceIds, "evidenceSourceIds"),
        closeReason: payload.closeReason as
          | "resolved" | "not_required" | "duplicate" | "false_positive" | undefined,
        duplicateOfIssueId: payload.duplicateOfIssueId === undefined
          ? undefined : readId(payload.duplicateOfIssueId, "duplicateOfIssueId"),
        actorId: principal.id,
        now
      })
      if (next.reviews.at(-1)?.duplicateOfIssueId) {
        const main = this.repo.getObject<IssueWorkflow>(
          access.project.id, "issue", next.reviews.at(-1)!.duplicateOfIssueId!
        )
        if (!main) throw new AppError(409, "关联的主事项不存在于当前项目")
      }
    } else {
      next = reopenIssueWorkflow(stored.value, {
        id: readId(payload.reopeningId, "reopeningId"),
        expectedVersion,
        reason: readText(payload.reason, "重新打开原因", 1000),
        actorId: principal.id,
        now
      })
    }
    const saved = this.saveObject(stored, next, now)
    return {
      response: saved,
      audits: [this.audit(command.type, "issue", issueId,
        stored.value.version, next.version)]
    }
  }

  private financeLedger(
    projectId: string,
    costItemId: string,
    expectedVersion: number
  ): { stored?: StoredBusinessObject<FinanceLedger>; ledger: FinanceLedger } {
    const stored = this.repo.getObject<FinanceLedger>(
      projectId, "finance_ledger", costItemId
    )
    const ledger = stored?.value || {
      projectId,
      costItemId,
      version: 0,
      approvals: [],
      payments: [],
      refunds: []
    }
    assertExpectedVersion(ledger.version, expectedVersion)
    return { stored, ledger }
  }

  private saveFinanceLedger(
    current: { stored?: StoredBusinessObject<FinanceLedger>; ledger: FinanceLedger },
    next: FinanceLedger,
    now: string
  ): StoredBusinessObject<FinanceLedger> {
    return current.stored
      ? this.saveObject(current.stored, next, now)
      : this.repo.createObject(
        next.projectId, "finance_ledger", next.costItemId, next, now
      )
  }

  private handleFinance(
    access: ProjectAccess,
    principal: Principal,
    command: BusinessCommandEnvelope,
    now: string
  ): DispatchResult {
    const payload = command.payload
    const costItemId = readId(payload.costItemId, "costItemId")
    const expectedVersion = readNonNegativeInteger(payload.expectedVersion, "expectedVersion")
    const current = this.financeLedger(
      access.project.id, costItemId, expectedVersion
    )
    let next: FinanceLedger
    if (command.type === "cost.approval") {
      if (!["initial", "increase", "decrease"].includes(String(payload.action))) {
        throw new AppError(400, "费用批准动作格式不正确")
      }
      const event: CostApprovalEvent = {
        id: randomUUID(),
        requestId: command.requestId,
        projectId: access.project.id,
        costItemId,
        action: payload.action as CostApprovalEvent["action"],
        amountFen: readPositiveInteger(payload.amountFen, "批准金额"),
        reason: typeof payload.reason === "string" ? payload.reason : "",
        actorId: principal.id,
        createdAt: now
      }
      next = {
        ...current.ledger,
        version: current.ledger.version + 1,
        approvals: appendApprovalEvent(current.ledger.approvals, event)
      }
    } else if (command.type === "payment.create") {
      const payment = createPaymentFact({
        id: readId(payload.paymentId, "paymentId"),
        requestId: command.requestId,
        projectId: access.project.id,
        costItemId,
        amountFen: readPositiveInteger(payload.amountFen, "付款金额"),
        submittedBy: principal.id,
        occurredAt: readText(payload.occurredAt, "付款发生时间", 100),
        createdAt: now
      })
      if (current.ledger.payments.some(item => item.id === payment.id)) {
        throw new DomainError("STATE_CONFLICT", "付款标识已存在")
      }
      next = {
        ...current.ledger,
        version: current.ledger.version + 1,
        payments: [...current.ledger.payments, payment]
      }
    } else if (command.type === "payment.decide") {
      if (!["confirmed", "rejected"].includes(String(payload.decision))) {
        throw new AppError(400, "付款决定格式不正确")
      }
      const paymentId = readId(payload.paymentId, "paymentId")
      const payment = current.ledger.payments.find(item => item.id === paymentId)
      if (!payment) throw new DomainError("NOT_FOUND", "付款事实不存在")
      const decided = decidePaymentFact(payment, {
        decision: payload.decision as "confirmed" | "rejected",
        expectedVersion: readPositiveInteger(payload.paymentVersion, "paymentVersion"),
        actorId: principal.id,
        now
      })
      next = {
        ...current.ledger,
        version: current.ledger.version + 1,
        payments: current.ledger.payments.map(item => item.id === paymentId ? decided : item)
      }
    } else if (command.type === "refund.create") {
      const paymentId = readId(payload.paymentId, "paymentId")
      const payment = current.ledger.payments.find(item => item.id === paymentId)
      if (!payment) throw new DomainError("NOT_FOUND", "原付款不存在")
      const refund = createRefundFact(payment, current.ledger.refunds, {
        id: readId(payload.refundId, "refundId"),
        requestId: command.requestId,
        projectId: access.project.id,
        costItemId,
        paymentId,
        amountFen: readPositiveInteger(payload.amountFen, "退款金额"),
        submittedBy: principal.id,
        occurredAt: readText(payload.occurredAt, "退款发生时间", 100),
        createdAt: now
      })
      if (current.ledger.refunds.some(item => item.id === refund.id)) {
        throw new DomainError("STATE_CONFLICT", "退款标识已存在")
      }
      next = {
        ...current.ledger,
        version: current.ledger.version + 1,
        refunds: [...current.ledger.refunds, refund]
      }
    } else {
      if (!["confirmed", "rejected"].includes(String(payload.decision))) {
        throw new AppError(400, "退款决定格式不正确")
      }
      const refundId = readId(payload.refundId, "refundId")
      const refund = current.ledger.refunds.find(item => item.id === refundId)
      if (!refund) throw new DomainError("NOT_FOUND", "退款事实不存在")
      const decided = decideRefundFact(refund, {
        decision: payload.decision as "confirmed" | "rejected",
        expectedVersion: readPositiveInteger(payload.refundVersion, "refundVersion"),
        actorId: principal.id,
        now
      })
      next = {
        ...current.ledger,
        version: current.ledger.version + 1,
        refunds: current.ledger.refunds.map(item => item.id === refundId ? decided : item)
      }
    }
    const saved = this.saveFinanceLedger(current, next, now)
    return {
      response: saved,
      audits: [this.audit(command.type, "finance_ledger", costItemId,
        current.ledger.version, next.version)]
    }
  }

  private approveCombinedChange(
    access: ProjectAccess,
    principal: Principal,
    command: BusinessCommandEnvelope,
    now: string
  ): DispatchResult {
    const payload = command.payload
    const changeId = readId(payload.changeId, "changeId")
    const agreementId = readId(payload.agreementId, "agreementId")
    const storedAgreement = this.loadObject<AgreementAggregate>(
      access.project.id, "agreement", agreementId
    )
    const nextAgreement = approveAgreementVersion(
      storedAgreement.value,
      readId(payload.versionId, "versionId"),
      readPositiveInteger(payload.agreementExpectedVersion, "agreementExpectedVersion"),
      principal.id,
      now
    )
    if (!["increase", "decrease"].includes(String(payload.costAction))) {
      throw new AppError(400, "组合变更的费用动作必须是调增或调减")
    }
    const costItemId = readId(payload.costItemId, "costItemId")
    const currentFinance = this.financeLedger(
      access.project.id,
      costItemId,
      readNonNegativeInteger(payload.financeExpectedVersion, "financeExpectedVersion")
    )
    const approval: CostApprovalEvent = {
      id: randomUUID(),
      requestId: command.requestId,
      projectId: access.project.id,
      costItemId,
      action: payload.costAction as "increase" | "decrease",
      amountFen: readPositiveInteger(payload.amountFen, "费用变化金额"),
      reason: readText(payload.reason, "组合变更原因", 1000),
      actorId: principal.id,
      createdAt: now
    }
    const nextFinance: FinanceLedger = {
      ...currentFinance.ledger,
      version: currentFinance.ledger.version + 1,
      approvals: appendApprovalEvent(currentFinance.ledger.approvals, approval)
    }
    const savedAgreement = this.saveObject(storedAgreement, nextAgreement, now)
    this.repo.checkpoint("change.approve.after_agreement")
    const savedFinance = this.saveFinanceLedger(currentFinance, nextFinance, now)
    const deliveryImpact = readOptionalText(payload.deliveryImpact, "交期影响", 1000)
    const change: ApprovedChangeRecord = {
      id: changeId,
      projectId: access.project.id,
      agreementId,
      agreementVersionId: readId(payload.versionId, "versionId"),
      costItemId,
      costAction: payload.costAction as "increase" | "decrease",
      amountFen: approval.amountFen,
      ...(deliveryImpact ? { deliveryImpact } : {}),
      reason: approval.reason,
      approvedBy: principal.id,
      approvedAt: now
    }
    const savedChange = this.repo.createObject(
      access.project.id, "change_request", changeId, change, now
    )
    return {
      response: { agreement: savedAgreement, finance: savedFinance, change: savedChange },
      audits: [
        this.audit(command.type, "agreement", agreementId,
          storedAgreement.value.agreement.version, nextAgreement.agreement.version,
          { costItemId }),
        this.audit(command.type, "finance_ledger", costItemId,
          currentFinance.ledger.version, nextFinance.version,
          { agreementId }),
        this.audit(command.type, "change_request", changeId,
          undefined, 1, { agreementId, costItemId })
      ]
    }
  }
}
