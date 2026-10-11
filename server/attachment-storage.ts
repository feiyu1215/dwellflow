import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { DomainError } from "../miniprogram/core/domain-error.ts"
import type { AttachmentChunk } from "./attachment-repository.ts"

export interface FinalizedAttachment {
  storageKey: string
  sizeBytes: number
  sha256: string
}

export interface AttachmentStorage {
  writeChunk(
    projectId: string,
    attachmentId: string,
    index: number,
    content: Buffer
  ): void
  finalize(
    projectId: string,
    attachmentId: string,
    chunks: AttachmentChunk[]
  ): FinalizedAttachment
  read(storageKey: string): Buffer
  removeChunks(projectId: string, attachmentId: string): void
}

function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) {
    throw new DomainError("INVALID_INPUT", "存储对象标识格式不正确")
  }
  return value
}

export class LocalAttachmentStorage implements AttachmentStorage {
  private readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
    mkdirSync(this.root, { recursive: true })
  }

  writeChunk(
    projectId: string,
    attachmentId: string,
    index: number,
    content: Buffer
  ): void {
    const target = this.chunkPath(projectId, attachmentId, index)
    mkdirSync(dirname(target), { recursive: true })
    const temporary = target + "." + randomUUID() + ".tmp"
    writeFileSync(temporary, content, { flag: "wx" })
    renameSync(temporary, target)
  }

  finalize(
    projectId: string,
    attachmentId: string,
    chunks: AttachmentChunk[]
  ): FinalizedAttachment {
    const safeProject = safeSegment(projectId)
    const safeAttachment = safeSegment(attachmentId)
    const storageKey = safeProject + "/" + safeAttachment + "/original"
    const target = join(this.root, "objects", storageKey)
    mkdirSync(dirname(target), { recursive: true })
    const temporary = target + "." + randomUUID() + ".tmp"
    const descriptor = openSync(temporary, "wx")
    const hash = createHash("sha256")
    let total = 0
    try {
      for (const chunk of chunks) {
        const content = readFileSync(this.chunkPath(
          projectId, attachmentId, chunk.index
        ))
        const actualChunkHash = createHash("sha256").update(content).digest("hex")
        if (content.length !== chunk.sizeBytes || actualChunkHash !== chunk.sha256) {
          throw new DomainError("STATE_CONFLICT", "附件分块损坏，请重新上传")
        }
        writeSync(descriptor, content)
        hash.update(content)
        total += content.length
      }
    } catch (error) {
      closeSync(descriptor)
      rmSync(temporary, { force: true })
      throw error
    }
    closeSync(descriptor)
    renameSync(temporary, target)
    return { storageKey, sizeBytes: total, sha256: hash.digest("hex") }
  }

  read(storageKey: string): Buffer {
    const parts = storageKey.split("/")
    if (parts.length !== 3 || parts[2] !== "original") {
      throw new DomainError("NOT_FOUND", "附件原件不存在")
    }
    parts.slice(0, 2).forEach(safeSegment)
    try {
      return readFileSync(join(this.root, "objects", ...parts))
    } catch {
      throw new DomainError("NOT_FOUND", "附件原件不存在")
    }
  }

  removeChunks(projectId: string, attachmentId: string): void {
    const directory = join(
      this.root, "chunks", safeSegment(projectId), safeSegment(attachmentId)
    )
    rmSync(directory, { recursive: true, force: true })
  }

  private chunkPath(projectId: string, attachmentId: string, index: number): string {
    if (!Number.isSafeInteger(index) || index < 0 || index > 10_000) {
      throw new DomainError("INVALID_INPUT", "附件分块序号不正确")
    }
    return join(
      this.root,
      "chunks",
      safeSegment(projectId),
      safeSegment(attachmentId),
      index + ".part"
    )
  }
}
