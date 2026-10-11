import { assertExpectedVersion, DomainError } from "./domain-error"

export type AgreementSubject = "material" | "construction"
export type AgreementVersionStatus =
  | "draft"
  | "pending_confirmation"
  | "active"
  | "rejected"
  | "withdrawn"
  | "superseded"

export interface AgreementTerm {
  key: string
  label: string
  value: string
}

export interface AgreementConflictAlternative {
  value: string
  sourceIds: string[]
}

export interface AgreementSourceConflict {
  id: string
  termKey: string
  alternatives: AgreementConflictAlternative[]
  selectedValue?: string
  selectedBy?: string
  selectedAt?: string
  selectionReason?: string
}

export interface Agreement {
  id: string
  projectId: string
  subject: AgreementSubject
  subjectId?: string
  title: string
  activeVersionId?: string
  version: number
}

export interface AgreementVersion {
  id: string
  agreementId: string
  revision: number
  status: AgreementVersionStatus
  baseActiveVersionId?: string
  terms: AgreementTerm[]
  sourceIds: string[]
  sourceConflicts: AgreementSourceConflict[]
  createdBy: string
  createdAt: string
  updatedAt: string
  decidedBy?: string
  decidedAt?: string
}

export interface AgreementAggregate {
  agreement: Agreement
  versions: AgreementVersion[]
}

function normalizedTerms(terms: AgreementTerm[]): AgreementTerm[] {
  if (!terms.length) throw new DomainError("INVALID_INPUT", "约定至少需要一个条目")
  const keys = new Set<string>()
  return terms.map(term => {
    const key = term.key.trim()
    const label = term.label.trim()
    const value = term.value.trim()
    if (!key || !label || !value) throw new DomainError("INVALID_INPUT", "约定条目不能为空")
    if (keys.has(key)) throw new DomainError("INVALID_INPUT", "约定条目键不能重复")
    keys.add(key)
    return { key, label, value }
  })
}

function normalizedSourceConflicts(
  conflicts: AgreementSourceConflict[] = []
): AgreementSourceConflict[] {
  const ids = new Set<string>()
  return conflicts.map(conflict => {
    const id = conflict.id.trim()
    const termKey = conflict.termKey.trim()
    if (!id || !termKey) throw new DomainError("INVALID_INPUT", "来源冲突标识和字段不能为空")
    if (ids.has(id)) throw new DomainError("INVALID_INPUT", "来源冲突标识不能重复")
    ids.add(id)
    if (conflict.alternatives.length < 2) {
      throw new DomainError("INVALID_INPUT", "来源冲突至少需要两个候选值")
    }
    const values = new Set<string>()
    const alternatives = conflict.alternatives.map(alternative => {
      const value = alternative.value.trim()
      if (!value) throw new DomainError("INVALID_INPUT", "来源冲突候选值不能为空")
      if (values.has(value)) throw new DomainError("INVALID_INPUT", "来源冲突候选值不能重复")
      values.add(value)
      return { value, sourceIds: [...new Set(alternative.sourceIds)] }
    })
    if (conflict.selectedValue && !values.has(conflict.selectedValue.trim())) {
      throw new DomainError("INVALID_INPUT", "来源冲突采用值必须来自候选值")
    }
    return {
      ...conflict,
      id,
      termKey,
      alternatives,
      selectedValue: conflict.selectedValue?.trim(),
      selectionReason: conflict.selectionReason?.trim()
    }
  })
}

export function createAgreement(input: {
  id: string
  versionId: string
  projectId: string
  subject: AgreementSubject
  subjectId?: string
  title: string
  terms: AgreementTerm[]
  sourceIds?: string[]
  sourceConflicts?: AgreementSourceConflict[]
  actorId: string
  now: string
}): AgreementAggregate {
  if (!input.title.trim()) throw new DomainError("INVALID_INPUT", "约定标题不能为空")
  const agreement: Agreement = {
    id: input.id,
    projectId: input.projectId,
    subject: input.subject,
    subjectId: input.subjectId,
    title: input.title.trim(),
    version: 1
  }
  const version: AgreementVersion = {
    id: input.versionId,
    agreementId: input.id,
    revision: 1,
    status: "draft",
    terms: normalizedTerms(input.terms),
    sourceIds: [...new Set(input.sourceIds || [])],
    sourceConflicts: normalizedSourceConflicts(input.sourceConflicts),
    createdBy: input.actorId,
    createdAt: input.now,
    updatedAt: input.now
  }
  return { agreement, versions: [version] }
}

export function addAgreementDraft(
  aggregate: AgreementAggregate,
  input: {
    id: string
    expectedVersion: number
    terms: AgreementTerm[]
    sourceIds?: string[]
    sourceConflicts?: AgreementSourceConflict[]
    actorId: string
    now: string
  }
): AgreementAggregate {
  assertExpectedVersion(aggregate.agreement.version, input.expectedVersion)
  const revision = Math.max(...aggregate.versions.map(item => item.revision)) + 1
  const version: AgreementVersion = {
    id: input.id,
    agreementId: aggregate.agreement.id,
    revision,
    status: "draft",
    baseActiveVersionId: aggregate.agreement.activeVersionId,
    terms: normalizedTerms(input.terms),
    sourceIds: [...new Set(input.sourceIds || [])],
    sourceConflicts: normalizedSourceConflicts(input.sourceConflicts),
    createdBy: input.actorId,
    createdAt: input.now,
    updatedAt: input.now
  }
  return {
    agreement: { ...aggregate.agreement, version: aggregate.agreement.version + 1 },
    versions: [...aggregate.versions, version]
  }
}

export function reviseAgreementDraft(
  aggregate: AgreementAggregate,
  input: {
    versionId: string
    expectedVersion: number
    terms: AgreementTerm[]
    sourceIds?: string[]
    sourceConflicts?: AgreementSourceConflict[]
    now: string
  }
): AgreementAggregate {
  assertExpectedVersion(aggregate.agreement.version, input.expectedVersion)
  const candidate = aggregate.versions.find(item => item.id === input.versionId)
  if (!candidate) throw new DomainError("NOT_FOUND", "约定版本不存在")
  if (candidate.status !== "draft") {
    throw new DomainError("STATE_CONFLICT", "只有草稿可以直接修改；待确认版本需先撤回")
  }
  return {
    agreement: { ...aggregate.agreement, version: aggregate.agreement.version + 1 },
    versions: aggregate.versions.map(item => item.id === input.versionId
      ? {
        ...item,
        terms: normalizedTerms(input.terms),
        sourceIds: [...new Set(input.sourceIds || [])],
        sourceConflicts: normalizedSourceConflicts(input.sourceConflicts),
        updatedAt: input.now
      }
      : item)
  }
}

export function resolveAgreementConflict(
  aggregate: AgreementAggregate,
  input: {
    versionId: string
    conflictId: string
    selectedValue: string
    reason: string
    expectedVersion: number
    actorId: string
    now: string
  }
): AgreementAggregate {
  assertExpectedVersion(aggregate.agreement.version, input.expectedVersion)
  const candidate = aggregate.versions.find(item => item.id === input.versionId)
  if (!candidate) throw new DomainError("NOT_FOUND", "约定版本不存在")
  if (candidate.status !== "draft") {
    throw new DomainError("STATE_CONFLICT", "只有草稿可以确认来源冲突")
  }
  const conflict = candidate.sourceConflicts.find(item => item.id === input.conflictId)
  if (!conflict) throw new DomainError("NOT_FOUND", "来源冲突不存在")
  const selectedValue = input.selectedValue.trim()
  if (!conflict.alternatives.some(item => item.value === selectedValue)) {
    throw new DomainError("INVALID_INPUT", "采用值必须来自冲突候选值")
  }
  if (!input.reason.trim()) throw new DomainError("INVALID_INPUT", "确认来源基线必须填写原因")
  if (!candidate.terms.some(item => item.key === conflict.termKey)) {
    throw new DomainError("INVALID_INPUT", "来源冲突字段必须对应约定条目")
  }
  return {
    agreement: { ...aggregate.agreement, version: aggregate.agreement.version + 1 },
    versions: aggregate.versions.map(item => item.id === input.versionId
      ? {
        ...item,
        terms: item.terms.map(term => term.key === conflict.termKey
          ? { ...term, value: selectedValue }
          : term),
        sourceConflicts: item.sourceConflicts.map(entry => entry.id === input.conflictId
          ? {
            ...entry,
            selectedValue,
            selectedBy: input.actorId,
            selectedAt: input.now,
            selectionReason: input.reason.trim()
          }
          : entry),
        updatedAt: input.now
      }
      : item)
  }
}

export function submitAgreementVersion(
  aggregate: AgreementAggregate,
  versionId: string,
  expectedVersion: number,
  now: string
): AgreementAggregate {
  assertExpectedVersion(aggregate.agreement.version, expectedVersion)
  const candidate = aggregate.versions.find(item => item.id === versionId)
  if (!candidate) throw new DomainError("NOT_FOUND", "约定版本不存在")
  if (candidate.status !== "draft") throw new DomainError("STATE_CONFLICT", "只有草稿可以送审")
  if (candidate.sourceConflicts.some(item => !item.selectedValue)) {
    throw new DomainError("STATE_CONFLICT", "仍有来源冲突未确认，不能送审")
  }
  return {
    agreement: { ...aggregate.agreement, version: aggregate.agreement.version + 1 },
    versions: aggregate.versions.map(item => item.id === versionId
      ? { ...item, status: "pending_confirmation", updatedAt: now }
      : item)
  }
}

export function withdrawAgreementVersion(
  aggregate: AgreementAggregate,
  versionId: string,
  expectedVersion: number,
  actorId: string,
  now: string
): AgreementAggregate {
  assertExpectedVersion(aggregate.agreement.version, expectedVersion)
  const candidate = aggregate.versions.find(item => item.id === versionId)
  if (!candidate) throw new DomainError("NOT_FOUND", "约定版本不存在")
  if (candidate.status !== "draft" && candidate.status !== "pending_confirmation") {
    throw new DomainError("STATE_CONFLICT", "只有草稿或待确认版本可以撤回")
  }
  return {
    agreement: { ...aggregate.agreement, version: aggregate.agreement.version + 1 },
    versions: aggregate.versions.map(item => item.id === versionId
      ? {
        ...item,
        status: "withdrawn",
        decidedBy: actorId,
        decidedAt: now,
        updatedAt: now
      }
      : item)
  }
}

export function rejectAgreementVersion(
  aggregate: AgreementAggregate,
  versionId: string,
  expectedVersion: number,
  actorId: string,
  now: string
): AgreementAggregate {
  assertExpectedVersion(aggregate.agreement.version, expectedVersion)
  const candidate = aggregate.versions.find(item => item.id === versionId)
  if (!candidate) throw new DomainError("NOT_FOUND", "约定版本不存在")
  if (candidate.status !== "pending_confirmation") {
    throw new DomainError("STATE_CONFLICT", "只有待确认版本可以拒绝")
  }
  return {
    agreement: { ...aggregate.agreement, version: aggregate.agreement.version + 1 },
    versions: aggregate.versions.map(item => item.id === versionId
      ? {
        ...item,
        status: "rejected",
        decidedBy: actorId,
        decidedAt: now,
        updatedAt: now
      }
      : item)
  }
}

export function approveAgreementVersion(
  aggregate: AgreementAggregate,
  versionId: string,
  expectedVersion: number,
  actorId: string,
  now: string
): AgreementAggregate {
  assertExpectedVersion(aggregate.agreement.version, expectedVersion)
  const candidate = aggregate.versions.find(item => item.id === versionId)
  if (!candidate) throw new DomainError("NOT_FOUND", "约定版本不存在")
  if (candidate.status !== "pending_confirmation") {
    throw new DomainError("STATE_CONFLICT", "只有待确认版本可以批准")
  }
  if (candidate.baseActiveVersionId !== aggregate.agreement.activeVersionId) {
    throw new DomainError("VERSION_CONFLICT", "生效约定已变化，请基于最新版本重新提交")
  }
  return {
    agreement: {
      ...aggregate.agreement,
      activeVersionId: candidate.id,
      version: aggregate.agreement.version + 1
    },
    versions: aggregate.versions.map(item => {
      if (item.id === candidate.id) {
        return { ...item, status: "active", decidedBy: actorId, decidedAt: now, updatedAt: now }
      }
      if (item.id === aggregate.agreement.activeVersionId && item.status === "active") {
        return { ...item, status: "superseded", updatedAt: now }
      }
      return item
    })
  }
}
