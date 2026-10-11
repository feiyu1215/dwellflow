import type { ProjectStage } from "./domain"
import type { RecordInputExtractionResult, RecordInputFieldKey } from "./record-input-contract"

export const INPUT_DRAFT_SCHEMA_VERSION = 1
const INPUT_DRAFT_STORAGE_KEY = "renovation-input-drafts-v1"
const MAX_SOURCE_LENGTH = 5000

export type RecordInputDraftStatus = "editing" | "extracting" | "review" | "conflict" | "failed" | "saved"

export interface RecordInputDraft {
  id: string
  projectId: string
  schemaVersion: typeof INPUT_DRAFT_SCHEMA_VERSION
  revision: number
  status: RecordInputDraftStatus
  originalText: string
  title: string
  note: string
  occurredDate: string
  room: string
  spaceId?: string
  stage: ProjectStage
  origin?: string
  extractionRequestId?: string
  extractionInputRevision?: number
  extraction?: RecordInputExtractionResult
  failureMessage?: string
  savedRecordId?: string
  createdAt: string
  updatedAt: string
}

export interface RecordInputDraftStorage {
  load(): RecordInputDraft[]
  save(drafts: RecordInputDraft[]): void
}

export class WxRecordInputDraftStorage implements RecordInputDraftStorage {
  load(): RecordInputDraft[] {
    const value = wx.getStorageSync<RecordInputDraft[]>(INPUT_DRAFT_STORAGE_KEY)
    return Array.isArray(value) ? value : []
  }

  save(drafts: RecordInputDraft[]): void {
    wx.setStorageSync(INPUT_DRAFT_STORAGE_KEY, drafts)
  }
}

function clone(draft: RecordInputDraft): RecordInputDraft {
  return { ...draft }
}

function compactTitle(text: string): string {
  const firstLine = text.trim().split(/[\n。！？!?]/)[0]?.replace(/\s+/g, " ").trim() || ""
  return firstLine.slice(0, 28)
}

function assertDraft(draft: RecordInputDraft): void {
  if (!draft.id || !draft.projectId) throw new Error("草稿标识和项目不能为空")
  if (draft.schemaVersion !== INPUT_DRAFT_SCHEMA_VERSION) throw new Error("草稿版本不兼容")
  if (!Number.isInteger(draft.revision) || draft.revision < 1) throw new Error("草稿版本不正确")
  if (!draft.originalText.trim()) throw new Error("先描述现在发生的事")
  if (draft.originalText.length > MAX_SOURCE_LENGTH) throw new Error("描述内容过长，请拆成多条记录")
}

export class RecordInputDraftRepository {
  private readonly storage: RecordInputDraftStorage
  private readonly now: () => string

  constructor(
    storage: RecordInputDraftStorage,
    now: () => string = () => new Date().toISOString()
  ) {
    this.storage = storage
    this.now = now
  }

  list(projectId?: string): RecordInputDraft[] {
    return this.storage.load()
      .filter(item => !projectId || item.projectId === projectId)
      .map(clone)
  }

  getForProject(id: string, projectId: string): RecordInputDraft | undefined {
    const draft = this.storage.load().find(item => item.id === id && item.projectId === projectId)
    return draft ? clone(draft) : undefined
  }

  latestOpen(projectId: string): RecordInputDraft | undefined {
    const draft = this.storage.load()
      .filter(item => item.projectId === projectId && item.status !== "saved")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
    return draft ? clone(draft) : undefined
  }

  saveEditing(input: {
    id: string
    projectId: string
    originalText: string
    occurredDate: string
    room: string
    spaceId?: string
    stage: ProjectStage
    origin?: string
  }): RecordInputDraft {
    const existing = this.storage.load().find(item => item.id === input.id)
    if (existing && existing.projectId !== input.projectId) throw new Error("不能把其他项目的草稿写入当前项目")
    const timestamp = this.now()
    const draft: RecordInputDraft = {
      id: input.id,
      projectId: input.projectId,
      schemaVersion: INPUT_DRAFT_SCHEMA_VERSION,
      revision: (existing?.revision || 0) + 1,
      status: "editing",
      originalText: input.originalText,
      title: existing?.originalText === input.originalText ? existing.title : "",
      note: input.originalText,
      occurredDate: input.occurredDate,
      room: input.room,
      spaceId: input.spaceId,
      stage: input.stage,
      origin: input.origin,
      extractionRequestId: undefined,
      extractionInputRevision: undefined,
      extraction: undefined,
      failureMessage: undefined,
      savedRecordId: undefined,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp
    }
    assertDraft(draft)
    return this.replace(draft)
  }

  prepareReview(id: string, projectId: string): RecordInputDraft {
    const current = this.requireForProject(id, projectId)
    const next: RecordInputDraft = {
      ...current,
      revision: current.revision + 1,
      status: "review",
      title: current.title.trim() || compactTitle(current.originalText),
      note: current.note.trim() || current.originalText.trim(),
      updatedAt: this.now()
    }
    assertDraft(next)
    return this.replace(next)
  }

  markExtracting(id: string, projectId: string, requestId: string): RecordInputDraft {
    if (!requestId) throw new Error("提取请求标识不能为空")
    const current = this.requireForProject(id, projectId)
    const nextRevision = current.revision + 1
    return this.replace({
      ...current,
      revision: nextRevision,
      status: "extracting",
      extractionRequestId: requestId,
      extractionInputRevision: nextRevision,
      extraction: undefined,
      failureMessage: undefined,
      updatedAt: this.now()
    })
  }

  applyExtraction(input: {
    id: string
    projectId: string
    requestId: string
    inputRevision: number
    result: RecordInputExtractionResult
  }): RecordInputDraft {
    const current = this.requireForProject(input.id, input.projectId)
    if (current.status !== "extracting"
      || current.extractionRequestId !== input.requestId
      || current.extractionInputRevision !== input.inputRevision
      || current.revision !== input.inputRevision) {
      throw new Error("原话已经变化，旧的整理结果不会覆盖当前草稿")
    }
    const fields = [input.result.title, input.result.note, input.result.room,
      input.result.stage, input.result.occurredDate]
    const hasConflict = fields.some(field => field.status === "conflict")
    const next: RecordInputDraft = {
      ...current,
      revision: current.revision + 1,
      status: hasConflict ? "conflict" : "review",
      title: input.result.title.value || current.title,
      note: input.result.note.value || current.note,
      room: input.result.room.value || current.room,
      stage: (input.result.stage.value || current.stage) as ProjectStage,
      occurredDate: input.result.occurredDate.value || current.occurredDate,
      extraction: input.result,
      failureMessage: undefined,
      updatedAt: this.now()
    }
    assertDraft(next)
    return this.replace(next)
  }

  markFailed(input: {
    id: string
    projectId: string
    requestId: string
    inputRevision: number
    message: string
  }): RecordInputDraft {
    const current = this.requireForProject(input.id, input.projectId)
    if (current.extractionRequestId !== input.requestId
      || current.extractionInputRevision !== input.inputRevision
      || current.revision !== input.inputRevision) return current
    return this.replace({
      ...current,
      revision: current.revision + 1,
      status: "failed",
      failureMessage: input.message.slice(0, 300),
      updatedAt: this.now()
    })
  }

  resolveConflict(input: {
    id: string
    projectId: string
    field: RecordInputFieldKey
    value: string
  }): RecordInputDraft {
    const current = this.requireForProject(input.id, input.projectId)
    const field = current.extraction?.[input.field]
    if (!current.extraction || !field || field.status !== "conflict") throw new Error("该字段没有待选择冲突")
    const candidate = field.candidates.find(item => item.value === input.value)
    if (!candidate) throw new Error("选择值不在冲突候选内")
    const extraction: RecordInputExtractionResult = {
      ...current.extraction,
      [input.field]: {
        value: candidate.value,
        status: "needs_confirmation",
        sources: candidate.sources.map(item => ({ ...item })),
        candidates: []
      }
    }
    const stillConflicted = [extraction.title, extraction.note, extraction.room,
      extraction.stage, extraction.occurredDate].some(item => item.status === "conflict")
    const next: RecordInputDraft = {
      ...current,
      revision: current.revision + 1,
      status: stillConflicted ? "conflict" : "review",
      title: input.field === "title" ? candidate.value : current.title,
      note: input.field === "note" ? candidate.value : current.note,
      room: input.field === "room" ? candidate.value : current.room,
      stage: (input.field === "stage" ? candidate.value : current.stage) as ProjectStage,
      occurredDate: input.field === "occurredDate" ? candidate.value : current.occurredDate,
      extraction,
      updatedAt: this.now()
    }
    assertDraft(next)
    return this.replace(next)
  }

  updateReview(input: {
    id: string
    projectId: string
    title: string
    note: string
    occurredDate: string
    room: string
    spaceId?: string
    stage: ProjectStage
  }): RecordInputDraft {
    const current = this.requireForProject(input.id, input.projectId)
    const next: RecordInputDraft = {
      ...current,
      ...input,
      revision: current.revision + 1,
      status: "review",
      failureMessage: undefined,
      updatedAt: this.now()
    }
    assertDraft(next)
    return this.replace(next)
  }

  markSaved(id: string, projectId: string, recordId: string): RecordInputDraft {
    if (!recordId) throw new Error("正式记录标识不能为空")
    const current = this.requireForProject(id, projectId)
    return this.replace({
      ...current,
      status: "saved",
      savedRecordId: recordId,
      revision: current.revision + 1,
      updatedAt: this.now()
    })
  }

  private requireForProject(id: string, projectId: string): RecordInputDraft {
    const draft = this.storage.load().find(item => item.id === id)
    if (!draft) throw new Error("录入草稿不存在")
    if (draft.projectId !== projectId) throw new Error("录入草稿不属于当前项目")
    if (draft.schemaVersion !== INPUT_DRAFT_SCHEMA_VERSION) throw new Error("草稿版本不兼容")
    return clone(draft)
  }

  private replace(next: RecordInputDraft): RecordInputDraft {
    const drafts = this.storage.load()
    const index = drafts.findIndex(item => item.id === next.id)
    const updated = index < 0 ? [...drafts, clone(next)] : drafts.map((item, itemIndex) => itemIndex === index ? clone(next) : item)
    this.storage.save(updated)
    return clone(next)
  }
}

