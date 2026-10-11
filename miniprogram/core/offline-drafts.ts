const DRAFT_STORAGE_KEY = "renovation-offline-drafts-v1"

export type DraftStatus =
  | "local"
  | "syncing"
  | "conflict"
  | "permission_denied"
  | "failed"
  | "synced"

export interface DraftAttachmentFile {
  id: string
  localPath: string
  fileName: string
  mediaType: string
  durable: boolean
}

export interface OfflineDraft {
  id: string
  projectId: string
  commandType: string
  path: string
  method: "POST" | "PUT"
  body: Record<string, unknown>
  attachmentFiles: DraftAttachmentFile[]
  status: DraftStatus
  errorCode?: string
  errorMessage?: string
  serverResult?: unknown
  createdAt: string
  updatedAt: string
}

export interface DraftStorage {
  load(): OfflineDraft[]
  save(drafts: OfflineDraft[]): void
}

export interface DraftSyncFailure {
  status?: number
  code?: string
  message?: string
}

const ONLINE_ONLY_COMMANDS = new Set([
  "project.archive",
  "project.reopen",
  "member.put",
  "owner_transfer.initiate",
  "owner_transfer.accept",
  "agreement.approve",
  "agreement.resolve_conflict",
  "agreement.reject",
  "receipt.allocate",
  "inventory.append",
  "issue.select_proposal",
  "issue.review",
  "issue.reopen",
  "cost.approval",
  "payment.decide",
  "refund.decide",
  "change.approve"
])

export function assertOfflineDraftAllowed(commandType: string): void {
  if (ONLINE_ONLY_COMMANDS.has(commandType)) {
    throw new Error("批准、入库、复查和权限操作必须联网后直接提交")
  }
}

function assertDraftOperation(
  commandType: string,
  body: Record<string, unknown>
): void {
  const bodyType = typeof body.type === "string" ? body.type : undefined
  if (bodyType && bodyType !== commandType) {
    throw new Error("离线草稿命令类型与提交内容不一致")
  }
  assertOfflineDraftAllowed(commandType)
  if (bodyType) assertOfflineDraftAllowed(bodyType)
}

export class WxDraftStorage implements DraftStorage {
  load(): OfflineDraft[] {
    const value = wx.getStorageSync<OfflineDraft[]>(DRAFT_STORAGE_KEY)
    return Array.isArray(value) ? value : []
  }

  save(drafts: OfflineDraft[]): void {
    wx.setStorageSync(DRAFT_STORAGE_KEY, drafts)
  }
}

export class OfflineDraftQueue {
  private readonly storage: DraftStorage
  private readonly now: () => string

  constructor(
    storage: DraftStorage,
    now: () => string = () => new Date().toISOString()
  ) {
    this.storage = storage
    this.now = now
  }

  list(projectId?: string): OfflineDraft[] {
    return this.loadRecovered()
      .filter(item => !projectId || item.projectId === projectId)
      .map(item => this.clone(item))
  }

  get(id: string): OfflineDraft | undefined {
    const value = this.loadRecovered().find(item => item.id === id)
    return value ? this.clone(value) : undefined
  }

  create(input: Omit<OfflineDraft, "status" | "createdAt" | "updatedAt">): OfflineDraft {
    assertDraftOperation(input.commandType, input.body)
    if (!input.id || !input.projectId || !input.path) {
      throw new Error("离线草稿标识和提交路径不能为空")
    }
    if (input.attachmentFiles.some(file => !file.durable)) {
      throw new Error("临时附件尚未转为持久文件，不能标记草稿可恢复")
    }
    const drafts = this.loadRecovered()
    if (drafts.some(item => item.id === input.id)) {
      throw new Error("离线草稿标识已存在")
    }
    const timestamp = this.now()
    const draft: OfflineDraft = {
      ...input,
      body: { ...input.body },
      attachmentFiles: input.attachmentFiles.map(file => ({ ...file })),
      status: "local",
      createdAt: timestamp,
      updatedAt: timestamp
    }
    this.storage.save([...drafts, draft])
    return this.clone(draft)
  }

  async sync(
    id: string,
    send: (draft: OfflineDraft) => Promise<unknown>
  ): Promise<OfflineDraft> {
    const current = this.require(id)
    assertDraftOperation(current.commandType, current.body)
    const syncing = this.replace({
      ...current,
      status: "syncing",
      errorCode: undefined,
      errorMessage: undefined,
      updatedAt: this.now()
    })
    try {
      const serverResult = await send(this.clone(syncing))
      return this.replace({
        ...syncing,
        status: "synced",
        serverResult,
        updatedAt: this.now()
      })
    } catch (error) {
      const failure = error as DraftSyncFailure
      const status = failure.status === 409
        ? "conflict" as const
        : [401, 403, 404].includes(Number(failure.status))
          ? "permission_denied" as const
          : "failed" as const
      return this.replace({
        ...syncing,
        status,
        errorCode: failure.code || "SYNC_FAILED",
        errorMessage: failure.message || "同步失败，本地内容仍保留",
        updatedAt: this.now()
      })
    }
  }

  remove(id: string): void {
    const drafts = this.loadRecovered()
    this.storage.save(drafts.filter(item => item.id !== id))
  }

  private require(id: string): OfflineDraft {
    const draft = this.loadRecovered().find(item => item.id === id)
    if (!draft) throw new Error("离线草稿不存在")
    return draft
  }

  private replace(next: OfflineDraft): OfflineDraft {
    const drafts = this.storage.load()
    const index = drafts.findIndex(item => item.id === next.id)
    if (index < 0) throw new Error("离线草稿不存在")
    const updated = [...drafts]
    updated[index] = this.clone(next)
    this.storage.save(updated)
    return this.clone(next)
  }

  private clone(draft: OfflineDraft): OfflineDraft {
    return {
      ...draft,
      body: JSON.parse(JSON.stringify(draft.body)) as Record<string, unknown>,
      attachmentFiles: draft.attachmentFiles.map(file => ({ ...file }))
    }
  }

  private loadRecovered(): OfflineDraft[] {
    const drafts = this.storage.load()
    let changed = false
    const recovered = drafts.map(draft => {
      if (draft.status !== "syncing") return draft
      changed = true
      return {
        ...draft,
        status: "failed" as const,
        errorCode: "SYNC_INTERRUPTED",
        errorMessage: "上次同步被中断，本地内容仍保留",
        updatedAt: this.now()
      }
    })
    if (changed) this.storage.save(recovered)
    return recovered
  }
}
