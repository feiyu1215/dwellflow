import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { DomainError } from "../miniprogram/core/domain-error.ts"

export type BusinessArea =
  | "records"
  | "agreements"
  | "materials"
  | "issues"
  | "expenses"
  | "ai"
  | "camera"

export interface MemberScopes {
  areas: BusinessArea[]
  recordIds?: string[]
  agreementIds?: string[]
  materialIds?: string[]
  issueIds?: string[]
  expenseIds?: string[]
}

export interface BusinessProject {
  id: string
  name: string
  ownerId: string
  status: "active" | "archived"
  version: number
  createdAt: string
  updatedAt: string
}

export interface BusinessMembership {
  projectId: string
  userId: string
  displayName: string
  role: "owner" | "family" | "collaborator"
  scopes: MemberScopes
  status: "active" | "revoked"
  version: number
  createdAt: string
  updatedAt: string
}

export type BusinessObjectKind =
  | "agreement"
  | "purchase_line"
  | "receipt"
  | "inventory_ledger"
  | "issue"
  | "finance_ledger"
  | "change_request"
  | "owner_transfer"

export interface StoredBusinessObject<T = unknown> {
  projectId: string
  kind: BusinessObjectKind
  id: string
  rowVersion: number
  value: T
  updatedAt: string
}

export interface BusinessAuditEvent {
  id: string
  projectId: string
  actorId: string
  action: string
  objectKind: string
  objectId: string
  beforeVersion?: number
  afterVersion?: number
  requestId: string
  metadata: Record<string, unknown>
  createdAt: string
}

export interface StoredCommandResult {
  principalId: string
  requestId: string
  projectId?: string
  requestHash: string
  response: unknown
}

type FaultInjector = (point: string) => void

export interface BusinessRepositoryContract {
  transaction<T>(work: () => T): T
  checkpoint(point: string): void
  createProject(project: BusinessProject, owner: BusinessMembership): void
  getProject(id: string): BusinessProject | undefined
  listProjects(userId: string): BusinessProject[]
  saveProject(project: BusinessProject, expectedVersion: number): void
  getMembership(projectId: string, userId: string): BusinessMembership | undefined
  listMemberships(projectId: string): BusinessMembership[]
  putMembership(membership: BusinessMembership, expectedVersion?: number): void
  createObject<T>(
    projectId: string,
    kind: BusinessObjectKind,
    id: string,
    value: T,
    now: string
  ): StoredBusinessObject<T>
  getObject<T>(
    projectId: string,
    kind: BusinessObjectKind,
    id: string
  ): StoredBusinessObject<T> | undefined
  listObjects<T>(
    projectId: string,
    kind: BusinessObjectKind,
    limit?: number
  ): Array<StoredBusinessObject<T>>
  saveObject<T>(
    object: Omit<StoredBusinessObject<T>, "rowVersion">,
    expectedRowVersion: number
  ): StoredBusinessObject<T>
  getCommand(principalId: string, requestId: string): StoredCommandResult | undefined
  saveCommand(result: StoredCommandResult, now: string): void
  appendAudit(input: Omit<BusinessAuditEvent, "id">): BusinessAuditEvent
  listAudit(projectId: string, limit?: number): BusinessAuditEvent[]
}

export class BusinessRepository implements BusinessRepositoryContract {
  readonly db: DatabaseSync
  private readonly faultInjector?: FaultInjector

  constructor(path: string, options: { faultInjector?: FaultInjector } = {}) {
    this.db = new DatabaseSync(path)
    this.faultInjector = options.faultInjector
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS business_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS business_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS business_memberships (
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(project_id, user_id),
        FOREIGN KEY(project_id) REFERENCES business_projects(id)
      );
      CREATE TABLE IF NOT EXISTS business_objects (
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        row_version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(project_id, kind, id),
        FOREIGN KEY(project_id) REFERENCES business_projects(id)
      );
      CREATE TABLE IF NOT EXISTS business_commands (
        principal_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        project_id TEXT,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(principal_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS business_audit (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        object_kind TEXT NOT NULL,
        object_id TEXT NOT NULL,
        before_version INTEGER,
        after_version INTEGER,
        request_id TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES business_projects(id)
      );
      CREATE INDEX IF NOT EXISTS business_audit_project_idx
        ON business_audit(project_id, created_at);
      INSERT OR IGNORE INTO business_schema_migrations(version, applied_at)
        VALUES(1, CURRENT_TIMESTAMP);
    `)
  }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const result = work()
      this.db.exec("COMMIT")
      return result
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  checkpoint(point: string): void {
    this.faultInjector?.(point)
  }

  createProject(project: BusinessProject, owner: BusinessMembership): void {
    this.db.prepare(`
      INSERT INTO business_projects
        (id,name,owner_id,status,version,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)
    `).run(project.id, project.name, project.ownerId, project.status, project.version,
      project.createdAt, project.updatedAt)
    this.insertMembership(owner)
  }

  getProject(id: string): BusinessProject | undefined {
    const row = this.db.prepare("SELECT * FROM business_projects WHERE id=?").get(id)
    if (!row) return undefined
    return {
      id: String(row.id),
      name: String(row.name),
      ownerId: String(row.owner_id),
      status: String(row.status) as BusinessProject["status"],
      version: Number(row.version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }
  }

  listProjects(userId: string): BusinessProject[] {
    return this.db.prepare(`
      SELECT p.* FROM business_projects p
      JOIN business_memberships m ON m.project_id=p.id
      WHERE m.user_id=? AND m.status='active'
      ORDER BY p.updated_at DESC
    `).all(userId).map(row => ({
      id: String(row.id),
      name: String(row.name),
      ownerId: String(row.owner_id),
      status: String(row.status) as BusinessProject["status"],
      version: Number(row.version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }))
  }

  saveProject(project: BusinessProject, expectedVersion: number): void {
    const result = this.db.prepare(`
      UPDATE business_projects
      SET name=?, owner_id=?, status=?, version=?, updated_at=?
      WHERE id=? AND version=?
    `).run(project.name, project.ownerId, project.status, project.version,
      project.updatedAt, project.id, expectedVersion)
    if (result.changes !== 1) {
      throw new DomainError("VERSION_CONFLICT", "项目已被更新，请核对最新版本后重试")
    }
  }

  private insertMembership(membership: BusinessMembership): void {
    this.db.prepare(`
      INSERT INTO business_memberships
        (project_id,user_id,display_name,role,scopes_json,status,version,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)
    `).run(membership.projectId, membership.userId, membership.displayName,
      membership.role, JSON.stringify(membership.scopes), membership.status,
      membership.version, membership.createdAt, membership.updatedAt)
  }

  getMembership(projectId: string, userId: string): BusinessMembership | undefined {
    const row = this.db.prepare(`
      SELECT * FROM business_memberships WHERE project_id=? AND user_id=?
    `).get(projectId, userId)
    if (!row) return undefined
    return {
      projectId: String(row.project_id),
      userId: String(row.user_id),
      displayName: String(row.display_name),
      role: String(row.role) as BusinessMembership["role"],
      scopes: JSON.parse(String(row.scopes_json)) as MemberScopes,
      status: String(row.status) as BusinessMembership["status"],
      version: Number(row.version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }
  }

  listMemberships(projectId: string): BusinessMembership[] {
    return this.db.prepare(`
      SELECT user_id FROM business_memberships WHERE project_id=? ORDER BY rowid
    `).all(projectId).map(row => this.getMembership(projectId, String(row.user_id))!)
  }

  putMembership(membership: BusinessMembership, expectedVersion?: number): void {
    const existing = this.getMembership(membership.projectId, membership.userId)
    if (!existing) {
      if (expectedVersion !== undefined) {
        throw new DomainError("VERSION_CONFLICT", "成员关系不存在或已变化")
      }
      this.insertMembership(membership)
      return
    }
    if (expectedVersion === undefined || existing.version !== expectedVersion) {
      throw new DomainError("VERSION_CONFLICT", "成员关系已被更新，请核对后重试")
    }
    const result = this.db.prepare(`
      UPDATE business_memberships
      SET display_name=?, role=?, scopes_json=?, status=?, version=?, updated_at=?
      WHERE project_id=? AND user_id=? AND version=?
    `).run(membership.displayName, membership.role, JSON.stringify(membership.scopes),
      membership.status, membership.version, membership.updatedAt,
      membership.projectId, membership.userId, expectedVersion)
    if (result.changes !== 1) throw new DomainError("VERSION_CONFLICT", "成员关系已被更新")
  }

  createObject<T>(
    projectId: string,
    kind: BusinessObjectKind,
    id: string,
    value: T,
    now: string
  ): StoredBusinessObject<T> {
    try {
      this.db.prepare(`
        INSERT INTO business_objects(project_id,kind,id,row_version,payload,updated_at)
        VALUES(?,?,?,?,?,?)
      `).run(projectId, kind, id, 1, JSON.stringify(value), now)
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) {
        throw new DomainError("STATE_CONFLICT", "对象标识已存在")
      }
      throw error
    }
    return { projectId, kind, id, rowVersion: 1, value, updatedAt: now }
  }

  getObject<T>(
    projectId: string,
    kind: BusinessObjectKind,
    id: string
  ): StoredBusinessObject<T> | undefined {
    const row = this.db.prepare(`
      SELECT * FROM business_objects WHERE project_id=? AND kind=? AND id=?
    `).get(projectId, kind, id)
    if (!row) return undefined
    return {
      projectId: String(row.project_id),
      kind: String(row.kind) as BusinessObjectKind,
      id: String(row.id),
      rowVersion: Number(row.row_version),
      value: JSON.parse(String(row.payload)) as T,
      updatedAt: String(row.updated_at)
    }
  }

  listObjects<T>(
    projectId: string,
    kind: BusinessObjectKind,
    limit = 100
  ): Array<StoredBusinessObject<T>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new DomainError("INVALID_INPUT", "列表数量必须在 1 到 200 之间")
    }
    return this.db.prepare(`
      SELECT id FROM business_objects
      WHERE project_id=? AND kind=?
      ORDER BY rowid DESC LIMIT ?
    `).all(projectId, kind, limit)
      .map(row => this.getObject<T>(projectId, kind, String(row.id))!)
  }

  saveObject<T>(
    object: Omit<StoredBusinessObject<T>, "rowVersion">,
    expectedRowVersion: number
  ): StoredBusinessObject<T> {
    const nextRowVersion = expectedRowVersion + 1
    const result = this.db.prepare(`
      UPDATE business_objects
      SET row_version=?, payload=?, updated_at=?
      WHERE project_id=? AND kind=? AND id=? AND row_version=?
    `).run(nextRowVersion, JSON.stringify(object.value), object.updatedAt,
      object.projectId, object.kind, object.id, expectedRowVersion)
    if (result.changes !== 1) {
      throw new DomainError("VERSION_CONFLICT", "对象已被更新，请核对最新版本后重试")
    }
    return { ...object, rowVersion: nextRowVersion }
  }

  getCommand(principalId: string, requestId: string): StoredCommandResult | undefined {
    const row = this.db.prepare(`
      SELECT * FROM business_commands WHERE principal_id=? AND request_id=?
    `).get(principalId, requestId)
    if (!row) return undefined
    return {
      principalId: String(row.principal_id),
      requestId: String(row.request_id),
      projectId: row.project_id === null ? undefined : String(row.project_id),
      requestHash: String(row.request_hash),
      response: JSON.parse(String(row.response_json))
    }
  }

  saveCommand(result: StoredCommandResult, now: string): void {
    this.db.prepare(`
      INSERT INTO business_commands
        (principal_id,request_id,project_id,request_hash,response_json,created_at)
      VALUES(?,?,?,?,?,?)
    `).run(result.principalId, result.requestId, result.projectId || null,
      result.requestHash, JSON.stringify(result.response), now)
  }

  appendAudit(input: Omit<BusinessAuditEvent, "id">): BusinessAuditEvent {
    const event: BusinessAuditEvent = { id: randomUUID(), ...input }
    this.db.prepare(`
      INSERT INTO business_audit
        (id,project_id,actor_id,action,object_kind,object_id,before_version,
         after_version,request_id,metadata_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `).run(event.id, event.projectId, event.actorId, event.action,
      event.objectKind, event.objectId, event.beforeVersion ?? null,
      event.afterVersion ?? null, event.requestId, JSON.stringify(event.metadata),
      event.createdAt)
    return event
  }

  listAudit(projectId: string, limit = 100): BusinessAuditEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new DomainError("INVALID_INPUT", "审计列表数量必须在 1 到 500 之间")
    }
    return this.db.prepare(`
      SELECT * FROM business_audit
      WHERE project_id=? ORDER BY rowid DESC LIMIT ?
    `).all(projectId, limit).map(row => ({
      id: String(row.id),
      projectId: String(row.project_id),
      actorId: String(row.actor_id),
      action: String(row.action),
      objectKind: String(row.object_kind),
      objectId: String(row.object_id),
      beforeVersion: row.before_version === null ? undefined : Number(row.before_version),
      afterVersion: row.after_version === null ? undefined : Number(row.after_version),
      requestId: String(row.request_id),
      metadata: JSON.parse(String(row.metadata_json)) as Record<string, unknown>,
      createdAt: String(row.created_at)
    }))
  }

  close(): void {
    this.db.close()
  }
}
