import { createHash } from "node:crypto"
import type { Principal } from "./business-auth.ts"
import {
  requireArea,
  requireProjectAccess,
  requireWritable,
  type ProjectAccess
} from "./business-access.ts"
import {
  type BusinessArea,
  type BusinessRepositoryContract
} from "./business-repository.ts"
import { commandHash } from "./canonical-json.ts"
import {
  readId,
  readNonNegativeInteger,
  readPositiveInteger,
  readText
} from "./business-validation.ts"
import {
  AttachmentRepository,
  type AttachmentCategory,
  type AttachmentRecord
} from "./attachment-repository.ts"
import type { AttachmentStorage } from "./attachment-storage.ts"
import { AppError } from "./validation.ts"

const ATTACHMENT_AREAS = new Set<BusinessArea>([
  "records", "agreements", "materials", "issues", "expenses"
])
const MAX_CHUNK_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_FILE_BYTES = 50 * 1024 * 1024

export interface PublicAttachment {
  projectId: string
  id: string
  createdBy: string
  area: BusinessArea
  resourceId: string
  fileName: string
  mediaType: string
  category: AttachmentCategory
  sizeBytes: number
  uploadedBytes: number
  expectedSha256?: string
  actualSizeBytes?: number
  actualSha256?: string
  durationMs?: number
  occurredAt?: string
  capturedAt?: string
  receivedAt?: string
  status: AttachmentRecord["status"]
  failureCode?: AttachmentRecord["failureCode"]
  version: number
  createdAt: string
  updatedAt: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function optionalDate(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) {
    throw new AppError(400, label + "格式不正确")
  }
  return new Date(value).toISOString()
}

function readSha256(value: unknown, required = false): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new AppError(400, "SHA-256 格式不正确")
  }
  return value
}

function readCategory(value: unknown): AttachmentCategory {
  if (!["image", "audio", "document"].includes(String(value))) {
    throw new AppError(400, "附件类别格式不正确")
  }
  return value as AttachmentCategory
}

function readArea(value: unknown): BusinessArea {
  if (!ATTACHMENT_AREAS.has(value as BusinessArea)) {
    throw new AppError(400, "附件资料范围不正确")
  }
  return value as BusinessArea
}

function requireAttachmentScope(
  access: ProjectAccess,
  record: AttachmentRecord,
  hideExistence: boolean
): void {
  try {
    requireArea(access, record.area, record.resourceId)
  } catch (error) {
    if (hideExistence && error instanceof AppError && error.status === 403) {
      throw new AppError(404, "附件不存在或无权访问")
    }
    throw error
  }
}

export class AttachmentService {
  private readonly businessRepo: BusinessRepositoryContract
  private readonly repo: AttachmentRepository
  private readonly storage: AttachmentStorage

  constructor(
    businessRepo: BusinessRepositoryContract,
    repo: AttachmentRepository,
    storage: AttachmentStorage
  ) {
    this.businessRepo = businessRepo
    this.repo = repo
    this.storage = storage
  }

  reserve(
    principal: Principal,
    projectIdInput: string,
    input: Record<string, unknown>
  ): PublicAttachment {
    const projectId = readId(projectIdInput, "projectId")
    const requestId = readId(input.requestId, "requestId")
    const id = readId(input.id, "attachmentId")
    const area = readArea(input.area)
    const resourceId = readId(input.resourceId, "resourceId")
    const fileName = readText(input.fileName, "文件名", 255)
    if (/[\\/]/.test(fileName)) throw new AppError(400, "文件名不能包含路径")
    const mediaType = readText(input.mediaType, "媒体类型", 100).toLowerCase()
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mediaType)) {
      throw new AppError(400, "媒体类型格式不正确")
    }
    const category = readCategory(input.category)
    if (category === "image" && !mediaType.startsWith("image/")) {
      throw new AppError(400, "图片附件的媒体类型不匹配")
    }
    if (category === "audio" && !mediaType.startsWith("audio/")) {
      throw new AppError(400, "音频附件的媒体类型不匹配")
    }
    const sizeBytes = readPositiveInteger(input.sizeBytes, "附件大小")
    const maximum = category === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES
    if (sizeBytes > maximum) throw new AppError(413, "附件超过首版大小限制")
    const durationMs = input.durationMs === undefined
      ? undefined : readPositiveInteger(input.durationMs, "音频时长")
    if (category === "audio" && (durationMs === undefined || durationMs > 300_000)) {
      throw new AppError(400, "音频必须提供不超过 5 分钟的时长")
    }
    const expectedSha256 = readSha256(input.sha256)
    const occurredAt = optionalDate(input.occurredAt, "发生时间")
    const capturedAt = optionalDate(input.capturedAt, "拍摄时间")
    const normalized = {
      id, area, resourceId, fileName, mediaType, category, sizeBytes,
      durationMs, expectedSha256, occurredAt, capturedAt
    }
    const hash = commandHash({ type: "attachment.reserve", projectId, ...normalized })

    return this.businessRepo.transaction(() => {
      const access = requireProjectAccess(this.businessRepo, principal, projectId)
      requireWritable(access)
      requireArea(access, area, resourceId)
      const replay = this.businessRepo.getCommand(principal.id, requestId)
      if (replay) {
        if (replay.projectId !== projectId || replay.requestHash !== hash) {
          throw new AppError(409, "同一请求标识不能用于不同操作")
        }
        return replay.response as PublicAttachment
      }
      if (category === "image" && area === "records"
        && this.repo.countVisibleImages(projectId, area, resourceId) >= 9) {
        throw new AppError(409, "每条记录最多保存 9 张图片")
      }
      const now = nowIso()
      const record = this.repo.create({
        projectId, id, createdBy: principal.id, area, resourceId,
        fileName, mediaType, category, sizeBytes, expectedSha256, durationMs,
        occurredAt, capturedAt, status: "pending_upload", version: 1,
        createdAt: now, updatedAt: now
      })
      const response = this.toPublic(record)
      this.businessRepo.appendAudit({
        projectId, actorId: principal.id, action: "attachment.reserve",
        objectKind: "attachment", objectId: id, afterVersion: 1,
        requestId, metadata: { area, resourceId, category, sizeBytes },
        createdAt: now
      })
      this.businessRepo.saveCommand({
        principalId: principal.id, requestId, projectId,
        requestHash: hash, response
      }, now)
      return response
    })
  }

  putChunk(
    principal: Principal,
    projectIdInput: string,
    attachmentIdInput: string,
    input: {
      index: unknown
      offsetBytes: unknown
      sha256: unknown
      content: Buffer
    }
  ): PublicAttachment {
    const projectId = readId(projectIdInput, "projectId")
    const attachmentId = readId(attachmentIdInput, "attachmentId")
    const index = readNonNegativeInteger(input.index, "分块序号")
    const offsetBytes = readNonNegativeInteger(input.offsetBytes, "分块偏移")
    const suppliedSha256 = readSha256(input.sha256)
    if (!Buffer.isBuffer(input.content) || input.content.length < 1
      || input.content.length > MAX_CHUNK_BYTES) {
      throw new AppError(413, "附件分块必须在 1 字节到 5MB 之间")
    }
    const actualHash = createHash("sha256").update(input.content).digest("hex")
    if (suppliedSha256 && actualHash !== suppliedSha256) {
      throw new AppError(400, "附件分块校验失败")
    }

    const access = requireProjectAccess(this.businessRepo, principal, projectId)
    requireWritable(access)
    const record = this.loadVisible(access, projectId, attachmentId, false)
    this.requireUploader(access, principal, record)
    if (!["pending_upload", "failed"].includes(record.status)) {
      throw new AppError(409, "附件已完成或不可继续上传")
    }
    if (offsetBytes + input.content.length > record.sizeBytes) {
      throw new AppError(409, "附件分块超出声明大小")
    }
    this.storage.writeChunk(projectId, attachmentId, index, input.content)
    this.repo.putChunk({
      projectId, attachmentId, index, offsetBytes,
      sizeBytes: input.content.length, sha256: actualHash, updatedAt: nowIso()
    })
    return this.toPublic(record)
  }

  complete(
    principal: Principal,
    projectIdInput: string,
    attachmentIdInput: string,
    input: Record<string, unknown>
  ): PublicAttachment {
    const projectId = readId(projectIdInput, "projectId")
    const attachmentId = readId(attachmentIdInput, "attachmentId")
    const requestId = readId(input.requestId, "requestId")
    const expectedVersion = readPositiveInteger(
      input.expectedVersion, "附件版本"
    )
    const hash = commandHash({
      type: "attachment.complete", projectId, attachmentId, expectedVersion
    })
    const response = this.businessRepo.transaction(() => {
      const access = requireProjectAccess(this.businessRepo, principal, projectId)
      requireWritable(access)
      const record = this.loadVisible(access, projectId, attachmentId, false)
      this.requireUploader(access, principal, record)
      const replay = this.businessRepo.getCommand(principal.id, requestId)
      if (replay) {
        if (replay.projectId !== projectId || replay.requestHash !== hash) {
          throw new AppError(409, "同一请求标识不能用于不同操作")
        }
        return replay.response as PublicAttachment
      }
      if (record.version !== expectedVersion) {
        throw new AppError(409, "附件状态已变化，请刷新后重试")
      }
      if (record.status === "ready" || record.status === "hidden") {
        throw new AppError(409, "附件已完成或不可继续上传")
      }
      const chunks = this.repo.listChunks(projectId, attachmentId)
      let offset = 0
      for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index]
        if (chunk.index !== index || chunk.offsetBytes !== offset) {
          throw new AppError(409, "附件分块不连续，请补传后重试")
        }
        offset += chunk.sizeBytes
      }
      if (!chunks.length || offset !== record.sizeBytes) {
        throw new AppError(409, "附件尚未完整上传")
      }
      const finalized = this.storage.finalize(projectId, attachmentId, chunks)
      this.businessRepo.checkpoint("attachment.complete.after_storage")
      const now = nowIso()
      const failureCode = finalized.sizeBytes !== record.sizeBytes
        ? "SIZE_MISMATCH" as const
        : record.expectedSha256 && finalized.sha256 !== record.expectedSha256
          ? "CHECKSUM_MISMATCH" as const
          : undefined
      const saved = this.repo.save({
        ...record,
        actualSizeBytes: finalized.sizeBytes,
        actualSha256: finalized.sha256,
        storageKey: finalized.storageKey,
        receivedAt: failureCode ? undefined : now,
        status: failureCode ? "failed" : "ready",
        failureCode,
        updatedAt: now
      }, expectedVersion)
      const publicRecord = this.toPublic(saved)
      this.businessRepo.appendAudit({
        projectId, actorId: principal.id,
        action: failureCode ? "attachment.verify_failed" : "attachment.ready",
        objectKind: "attachment", objectId: attachmentId,
        beforeVersion: expectedVersion, afterVersion: saved.version,
        requestId, metadata: {
          sizeBytes: finalized.sizeBytes,
          sha256: finalized.sha256,
          failureCode: failureCode || null
        },
        createdAt: now
      })
      this.businessRepo.saveCommand({
        principalId: principal.id, requestId, projectId,
        requestHash: hash, response: publicRecord
      }, now)
      return publicRecord
    })
    if (response.status === "ready") {
      try {
        this.storage.removeChunks(projectId, attachmentId)
      } catch {
        // The verified original is authoritative; stale chunks are cleanup-only.
      }
    }
    return response
  }

  get(
    principal: Principal,
    projectIdInput: string,
    attachmentIdInput: string
  ): PublicAttachment {
    const projectId = readId(projectIdInput, "projectId")
    const attachmentId = readId(attachmentIdInput, "attachmentId")
    const access = requireProjectAccess(this.businessRepo, principal, projectId)
    return this.toPublic(this.loadVisible(access, projectId, attachmentId, true))
  }

  list(
    principal: Principal,
    projectIdInput: string,
    areaInput: unknown,
    resourceIdInput: unknown
  ): PublicAttachment[] {
    const projectId = readId(projectIdInput, "projectId")
    const area = readArea(areaInput)
    const resourceId = readId(resourceIdInput, "resourceId")
    const access = requireProjectAccess(this.businessRepo, principal, projectId)
    try {
      requireArea(access, area, resourceId)
    } catch (error) {
      if (error instanceof AppError && error.status === 403) {
        throw new AppError(404, "附件不存在或无权访问")
      }
      throw error
    }
    return this.repo.list(projectId, area, resourceId)
      .filter(item => item.status !== "hidden")
      .map(item => this.toPublic(item))
  }

  readContent(
    principal: Principal,
    projectIdInput: string,
    attachmentIdInput: string
  ): { attachment: PublicAttachment; content: Buffer } {
    const projectId = readId(projectIdInput, "projectId")
    const attachmentId = readId(attachmentIdInput, "attachmentId")
    const access = requireProjectAccess(this.businessRepo, principal, projectId)
    const record = this.loadVisible(access, projectId, attachmentId, true)
    if (record.status !== "ready" || !record.storageKey) {
      throw new AppError(409, "附件原件尚未完整保存")
    }
    return {
      attachment: this.toPublic(record),
      content: this.storage.read(record.storageKey)
    }
  }

  private loadVisible(
    access: ProjectAccess,
    projectId: string,
    attachmentId: string,
    hideExistence: boolean
  ): AttachmentRecord {
    const record = this.repo.get(projectId, attachmentId)
    if (!record || record.status === "hidden") {
      throw new AppError(404, "附件不存在或无权访问")
    }
    requireAttachmentScope(access, record, hideExistence)
    return record
  }

  private requireUploader(
    access: ProjectAccess,
    principal: Principal,
    record: AttachmentRecord
  ): void {
    const isOwner = access.project.ownerId === principal.id
      && access.membership.role === "owner"
    if (!isOwner && record.createdBy !== principal.id) {
      throw new AppError(403, "只有附件创建者或项目负责人可以继续上传")
    }
  }

  private toPublic(record: AttachmentRecord): PublicAttachment {
    const uploadedBytes = record.status === "ready"
      ? record.actualSizeBytes || record.sizeBytes
      : this.repo.listChunks(record.projectId, record.id)
        .reduce((sum, chunk) => sum + chunk.sizeBytes, 0)
    return {
      projectId: record.projectId,
      id: record.id,
      createdBy: record.createdBy,
      area: record.area,
      resourceId: record.resourceId,
      fileName: record.fileName,
      mediaType: record.mediaType,
      category: record.category,
      sizeBytes: record.sizeBytes,
      uploadedBytes,
      expectedSha256: record.expectedSha256,
      actualSizeBytes: record.actualSizeBytes,
      actualSha256: record.actualSha256,
      durationMs: record.durationMs,
      occurredAt: record.occurredAt,
      capturedAt: record.capturedAt,
      receivedAt: record.receivedAt,
      status: record.status,
      failureCode: record.failureCode,
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    }
  }
}
