import type { DatabaseSync } from "node:sqlite"
import type { BusinessArea } from "./business-repository.ts"
import { DomainError } from "../miniprogram/core/domain-error.ts"

export type AttachmentCategory = "image" | "audio" | "document"
export type AttachmentStatus = "pending_upload" | "ready" | "failed" | "hidden"

export interface AttachmentRecord {
  projectId: string
  id: string
  createdBy: string
  area: BusinessArea
  resourceId: string
  fileName: string
  mediaType: string
  category: AttachmentCategory
  sizeBytes: number
  expectedSha256?: string
  actualSizeBytes?: number
  actualSha256?: string
  durationMs?: number
  occurredAt?: string
  capturedAt?: string
  receivedAt?: string
  storageKey?: string
  status: AttachmentStatus
  failureCode?: "CHECKSUM_MISMATCH" | "SIZE_MISMATCH"
  version: number
  createdAt: string
  updatedAt: string
}

export interface AttachmentChunk {
  projectId: string
  attachmentId: string
  index: number
  offsetBytes: number
  sizeBytes: number
  sha256: string
  updatedAt: string
}

export class AttachmentRepository {
  readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attachment_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attachments (
        project_id TEXT NOT NULL,
        id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        area TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        category TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        expected_sha256 TEXT,
        actual_size_bytes INTEGER,
        actual_sha256 TEXT,
        duration_ms INTEGER,
        occurred_at TEXT,
        captured_at TEXT,
        received_at TEXT,
        storage_key TEXT,
        status TEXT NOT NULL,
        failure_code TEXT,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(project_id,id),
        FOREIGN KEY(project_id) REFERENCES business_projects(id)
      );
      CREATE TABLE IF NOT EXISTS attachment_chunks (
        project_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        offset_bytes INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(project_id,attachment_id,chunk_index),
        FOREIGN KEY(project_id,attachment_id)
          REFERENCES attachments(project_id,id)
      );
      CREATE INDEX IF NOT EXISTS attachments_resource_idx
        ON attachments(project_id,area,resource_id);
      INSERT OR IGNORE INTO attachment_schema_migrations(version, applied_at)
        VALUES(1, CURRENT_TIMESTAMP);
    `)
  }

  create(record: AttachmentRecord): AttachmentRecord {
    try {
      this.db.prepare(`
        INSERT INTO attachments (
          project_id,id,created_by,area,resource_id,file_name,media_type,category,
          size_bytes,expected_sha256,actual_size_bytes,actual_sha256,duration_ms,
          occurred_at,captured_at,received_at,storage_key,status,failure_code,
          version,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        record.projectId, record.id, record.createdBy, record.area,
        record.resourceId, record.fileName, record.mediaType, record.category,
        record.sizeBytes, record.expectedSha256 || null,
        record.actualSizeBytes ?? null, record.actualSha256 || null,
        record.durationMs ?? null, record.occurredAt || null,
        record.capturedAt || null, record.receivedAt || null,
        record.storageKey || null, record.status, record.failureCode || null,
        record.version, record.createdAt, record.updatedAt
      )
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) {
        throw new DomainError("STATE_CONFLICT", "附件标识已存在")
      }
      throw error
    }
    return { ...record }
  }

  get(projectId: string, id: string): AttachmentRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM attachments WHERE project_id=? AND id=?
    `).get(projectId, id)
    return row ? this.mapRecord(row) : undefined
  }

  list(projectId: string, area: BusinessArea, resourceId: string): AttachmentRecord[] {
    return this.db.prepare(`
      SELECT * FROM attachments
      WHERE project_id=? AND area=? AND resource_id=?
      ORDER BY rowid
    `).all(projectId, area, resourceId).map(row => this.mapRecord(row))
  }

  countVisibleImages(projectId: string, area: BusinessArea, resourceId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM attachments
      WHERE project_id=? AND area=? AND resource_id=?
        AND category='image' AND status!='hidden'
    `).get(projectId, area, resourceId)
    return Number(row?.count || 0)
  }

  save(record: AttachmentRecord, expectedVersion: number): AttachmentRecord {
    const next = { ...record, version: expectedVersion + 1 }
    const result = this.db.prepare(`
      UPDATE attachments SET
        actual_size_bytes=?,actual_sha256=?,received_at=?,storage_key=?,
        status=?,failure_code=?,version=?,updated_at=?
      WHERE project_id=? AND id=? AND version=?
    `).run(
      next.actualSizeBytes ?? null, next.actualSha256 || null,
      next.receivedAt || null, next.storageKey || null, next.status,
      next.failureCode || null, next.version, next.updatedAt,
      next.projectId, next.id, expectedVersion
    )
    if (result.changes !== 1) {
      throw new DomainError("VERSION_CONFLICT", "附件状态已变化，请刷新后重试")
    }
    return next
  }

  putChunk(chunk: AttachmentChunk): AttachmentChunk {
    const existing = this.getChunk(
      chunk.projectId, chunk.attachmentId, chunk.index
    )
    if (existing && existing.offsetBytes === chunk.offsetBytes
      && existing.sizeBytes === chunk.sizeBytes
      && existing.sha256 === chunk.sha256) {
      return existing
    }
    this.db.prepare(`
      INSERT INTO attachment_chunks (
        project_id,attachment_id,chunk_index,offset_bytes,size_bytes,sha256,updated_at
      ) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(project_id,attachment_id,chunk_index) DO UPDATE SET
        offset_bytes=excluded.offset_bytes,
        size_bytes=excluded.size_bytes,
        sha256=excluded.sha256,
        updated_at=excluded.updated_at
    `).run(
      chunk.projectId, chunk.attachmentId, chunk.index, chunk.offsetBytes,
      chunk.sizeBytes, chunk.sha256, chunk.updatedAt
    )
    return { ...chunk }
  }

  getChunk(
    projectId: string,
    attachmentId: string,
    index: number
  ): AttachmentChunk | undefined {
    const row = this.db.prepare(`
      SELECT * FROM attachment_chunks
      WHERE project_id=? AND attachment_id=? AND chunk_index=?
    `).get(projectId, attachmentId, index)
    if (!row) return undefined
    return {
      projectId: String(row.project_id),
      attachmentId: String(row.attachment_id),
      index: Number(row.chunk_index),
      offsetBytes: Number(row.offset_bytes),
      sizeBytes: Number(row.size_bytes),
      sha256: String(row.sha256),
      updatedAt: String(row.updated_at)
    }
  }

  listChunks(projectId: string, attachmentId: string): AttachmentChunk[] {
    return this.db.prepare(`
      SELECT chunk_index FROM attachment_chunks
      WHERE project_id=? AND attachment_id=?
      ORDER BY chunk_index
    `).all(projectId, attachmentId).map(row =>
      this.getChunk(projectId, attachmentId, Number(row.chunk_index))!)
  }

  private mapRecord(row: Record<string, unknown>): AttachmentRecord {
    return {
      projectId: String(row.project_id),
      id: String(row.id),
      createdBy: String(row.created_by),
      area: String(row.area) as BusinessArea,
      resourceId: String(row.resource_id),
      fileName: String(row.file_name),
      mediaType: String(row.media_type),
      category: String(row.category) as AttachmentCategory,
      sizeBytes: Number(row.size_bytes),
      expectedSha256: row.expected_sha256 === null
        ? undefined : String(row.expected_sha256),
      actualSizeBytes: row.actual_size_bytes === null
        ? undefined : Number(row.actual_size_bytes),
      actualSha256: row.actual_sha256 === null
        ? undefined : String(row.actual_sha256),
      durationMs: row.duration_ms === null ? undefined : Number(row.duration_ms),
      occurredAt: row.occurred_at === null ? undefined : String(row.occurred_at),
      capturedAt: row.captured_at === null ? undefined : String(row.captured_at),
      receivedAt: row.received_at === null ? undefined : String(row.received_at),
      storageKey: row.storage_key === null ? undefined : String(row.storage_key),
      status: String(row.status) as AttachmentStatus,
      failureCode: row.failure_code === null
        ? undefined : String(row.failure_code) as AttachmentRecord["failureCode"],
      version: Number(row.version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }
  }
}
