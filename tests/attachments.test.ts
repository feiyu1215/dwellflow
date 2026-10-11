import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Repository } from "../server/repository.ts"
import { createApi } from "../server/app.ts"
import { StaticBearerAuthenticator } from "../server/business-auth.ts"
import { BusinessRepository } from "../server/business-repository.ts"
import { BusinessService } from "../server/business-service.ts"
import { AttachmentRepository } from "../server/attachment-repository.ts"
import { AttachmentService } from "../server/attachment-service.ts"
import { LocalAttachmentStorage } from "../server/attachment-storage.ts"

const sha256 = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex")

test("附件逐个上传、失败重试、私有读取和撤权均由服务端判定", async () => {
  const directory = mkdtempSync(join(tmpdir(), "renovation-attachments-"))
  const aiRepo = new Repository(":memory:")
  const businessRepo = new BusinessRepository(":memory:")
  const business = new BusinessService(businessRepo)
  const ownerToken = "attachment-owner-token-".repeat(2)
  const collaboratorToken = "attachment-collaborator-token-".repeat(2)
  const outsiderToken = "attachment-outsider-token-".repeat(2)
  const attachments = new AttachmentService(
    businessRepo,
    new AttachmentRepository(businessRepo.db),
    new LocalAttachmentStorage(directory)
  )
  const server = createApi(aiRepo, {
    model: "unused",
    async run() { throw new Error("not used") }
  }, "legacy-ai-token-".repeat(3), {
    business,
    attachments,
    businessAuthenticator: new StaticBearerAuthenticator([
      {
        token: ownerToken,
        principal: { id: "attachment-owner", displayName: "负责人" }
      },
      {
        token: collaboratorToken,
        principal: { id: "attachment-collaborator", displayName: "协作者" }
      },
      {
        token: outsiderToken,
        principal: { id: "attachment-outsider", displayName: "无关用户" }
      }
    ])
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address() as { port: number }
  const base = "http://127.0.0.1:" + address.port
  const jsonRequest = (
    token: string,
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST"
  ) => fetch(base + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json"
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const upload = (
    token: string,
    path: string,
    index: number,
    offset: number,
    content: Buffer
  ) => fetch(base + path + "/chunks/" + index, {
    method: "PUT",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/octet-stream",
      "x-chunk-offset": String(offset),
      "x-chunk-sha256": sha256(content)
    },
    body: content as unknown as BodyInit
  })
  try {
    const project = await (await jsonRequest(ownerToken, "/v1/projects", {
      requestId: "attachment-project",
      name: "附件项目"
    })).json() as { id: string }
    const projectPath = "/v1/projects/" + project.id
    assert.equal((await jsonRequest(ownerToken, projectPath + "/commands", {
      requestId: "attachment-member",
      type: "member.put",
      payload: {
        userId: "attachment-collaborator",
        displayName: "协作者",
        role: "collaborator",
        status: "active",
        areas: ["issues", "records"],
        recordIds: ["record-1"],
        issueIds: ["issue-1"],
        expectedVersion: 0
      }
    })).status, 200)

    const first = Buffer.from("first-")
    const second = Buffer.from("second")
    const original = Buffer.concat([first, second])
    const attachmentPath = projectPath + "/attachments/attachment-1"
    const reservedResponse = await jsonRequest(
      collaboratorToken, projectPath + "/attachments", {
        requestId: "reserve-attachment-1",
        id: "attachment-1",
        area: "issues",
        resourceId: "issue-1",
        fileName: "现场.jpg",
        mediaType: "image/jpeg",
        category: "image",
        sizeBytes: original.length,
        sha256: sha256(original),
        capturedAt: "2026-09-25T09:00:00.000Z"
      }
    )
    assert.equal(reservedResponse.status, 201)
    assert.equal((await reservedResponse.text()).includes("storageKey"), false)
    assert.equal((await upload(
      collaboratorToken, attachmentPath, 0, 0, first
    )).status, 200)
    const duplicated = await (await upload(
      collaboratorToken, attachmentPath, 0, 0, first
    )).json() as { uploadedBytes: number }
    assert.equal(duplicated.uploadedBytes, first.length)
    assert.equal((await upload(
      collaboratorToken, attachmentPath, 1, first.length, second
    )).status, 200)

    const completedResponse = await jsonRequest(
      collaboratorToken, attachmentPath + "/complete", {
        requestId: "complete-attachment-1",
        expectedVersion: 1
      }
    )
    assert.equal(completedResponse.status, 200)
    const completed = await completedResponse.json() as {
      status: string
      actualSha256: string
      uploadedBytes: number
      version: number
    }
    assert.equal(completed.status, "ready")
    assert.equal(completed.actualSha256, sha256(original))
    assert.equal(completed.uploadedBytes, original.length)
    assert.equal(completed.version, 2)

    const download = await fetch(base + attachmentPath + "/content", {
      headers: { Authorization: "Bearer " + collaboratorToken }
    })
    assert.equal(download.status, 200)
    assert.equal(download.headers.get("x-content-type-options"), "nosniff")
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), original)
    assert.equal((await fetch(base + attachmentPath + "/content", {
      headers: { Authorization: "Bearer " + outsiderToken }
    })).status, 404)

    const correct = Buffer.from("right")
    const wrong = Buffer.from("wrong")
    const failedPath = projectPath + "/attachments/attachment-failed"
    assert.equal((await jsonRequest(
      collaboratorToken, projectPath + "/attachments", {
        requestId: "reserve-failed",
        id: "attachment-failed",
        area: "issues",
        resourceId: "issue-1",
        fileName: "核对.txt",
        mediaType: "text/plain",
        category: "document",
        sizeBytes: correct.length,
        sha256: sha256(correct)
      }
    )).status, 201)
    assert.equal((await upload(
      collaboratorToken, failedPath, 0, 0, wrong
    )).status, 200)
    const failed = await (await jsonRequest(
      collaboratorToken, failedPath + "/complete", {
        requestId: "complete-failed-1",
        expectedVersion: 1
      }
    )).json() as { status: string; failureCode: string; version: number }
    assert.equal(failed.status, "failed")
    assert.equal(failed.failureCode, "CHECKSUM_MISMATCH")
    assert.equal(failed.version, 2)
    assert.equal((await fetch(base + failedPath + "/content", {
      headers: { Authorization: "Bearer " + collaboratorToken }
    })).status, 409)

    const partialList = await (await jsonRequest(
      collaboratorToken,
      projectPath + "/attachments?area=issues&resourceId=issue-1"
    )).json() as Array<{ id: string; status: string }>
    assert.deepEqual(
      partialList.map(item => [item.id, item.status]),
      [["attachment-1", "ready"], ["attachment-failed", "failed"]]
    )

    assert.equal((await upload(
      collaboratorToken, failedPath, 0, 0, correct
    )).status, 200)
    const retried = await (await jsonRequest(
      collaboratorToken, failedPath + "/complete", {
        requestId: "complete-failed-2",
        expectedVersion: 2
      }
    )).json() as { status: string; version: number }
    assert.equal(retried.status, "ready")
    assert.equal(retried.version, 3)
    assert.deepEqual(
      Buffer.from(await (await fetch(base + failedPath + "/content", {
        headers: { Authorization: "Bearer " + collaboratorToken }
      })).arrayBuffer()),
      correct
    )

    assert.equal((await jsonRequest(
      collaboratorToken, projectPath + "/attachments", {
        requestId: "outside-scope",
        id: "attachment-outside",
        area: "issues",
        resourceId: "issue-2",
        fileName: "越权.jpg",
        mediaType: "image/jpeg",
        category: "image",
        sizeBytes: 10
      }
    )).status, 403)
    assert.equal((await jsonRequest(
      collaboratorToken, projectPath + "/attachments", {
        requestId: "outside-record-scope",
        id: "attachment-outside-record",
        area: "records",
        resourceId: "record-2",
        fileName: "越权记录.jpg",
        mediaType: "image/jpeg",
        category: "image",
        sizeBytes: 10
      }
    )).status, 403)

    assert.equal((await jsonRequest(ownerToken, projectPath + "/commands", {
      requestId: "revoke-attachment-member",
      type: "member.put",
      payload: {
        userId: "attachment-collaborator",
        displayName: "协作者",
        role: "collaborator",
        status: "revoked",
        areas: ["issues", "records"],
        recordIds: ["record-1"],
        issueIds: ["issue-1"],
        expectedVersion: 1
      }
    })).status, 200)
    assert.equal((await fetch(base + attachmentPath + "/content", {
      headers: { Authorization: "Bearer " + collaboratorToken }
    })).status, 404)
    const ownerDownload = await fetch(base + attachmentPath + "/content", {
      headers: { Authorization: "Bearer " + ownerToken }
    })
    assert.equal(ownerDownload.status, 200)
    assert.deepEqual(Buffer.from(await ownerDownload.arrayBuffer()), original)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()))
    businessRepo.close()
    aiRepo.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("附件完成故障时元数据、审计和幂等回执回滚，重试可恢复", () => {
  const directory = mkdtempSync(join(tmpdir(), "renovation-attachment-fault-"))
  let failing = false
  const businessRepo = new BusinessRepository(":memory:", {
    faultInjector(point) {
      if (failing && point === "attachment.complete.after_storage") {
        throw new Error("simulated attachment database failure")
      }
    }
  })
  const attachmentRepo = new AttachmentRepository(businessRepo.db)
  const service = new AttachmentService(
    businessRepo,
    attachmentRepo,
    new LocalAttachmentStorage(directory)
  )
  const owner = { id: "fault-owner", displayName: "负责人" }
  try {
    const project = new BusinessService(businessRepo).createProject(owner, {
      requestId: "fault-attachment-project",
      name: "附件事务项目"
    })
    const content = Buffer.from("transactional attachment")
    service.reserve(owner, project.id, {
      requestId: "fault-reserve",
      id: "fault-attachment",
      area: "records",
      resourceId: "record-1",
      fileName: "现场.txt",
      mediaType: "text/plain",
      category: "document",
      sizeBytes: content.length,
      sha256: sha256(content)
    })
    service.putChunk(owner, project.id, "fault-attachment", {
      index: 0,
      offsetBytes: 0,
      sha256: sha256(content),
      content
    })
    const complete = {
      requestId: "fault-complete",
      expectedVersion: 1
    }
    failing = true
    assert.throws(
      () => service.complete(owner, project.id, "fault-attachment", complete),
      /simulated attachment database failure/
    )
    failing = false
    assert.equal(
      attachmentRepo.get(project.id, "fault-attachment")?.status,
      "pending_upload"
    )
    assert.equal(businessRepo.getCommand(owner.id, "fault-complete"), undefined)
    assert.equal(businessRepo.listAudit(project.id).some(item =>
      item.requestId === "fault-complete"), false)

    const retried = service.complete(
      owner, project.id, "fault-attachment", complete
    )
    assert.equal(retried.status, "ready")
    assert.deepEqual(
      service.readContent(owner, project.id, "fault-attachment").content,
      content
    )
  } finally {
    businessRepo.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
