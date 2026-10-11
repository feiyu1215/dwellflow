import test from "node:test"
import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Repository } from "../server/repository.ts"
import { createApi } from "../server/app.ts"
import {
  StaticBearerAuthenticator,
  type Principal
} from "../server/business-auth.ts"
import {
  BusinessRepository,
  type BusinessMembership
} from "../server/business-repository.ts"
import { BusinessService } from "../server/business-service.ts"

const principals = {
  owner: { id: "owner-user", displayName: "负责人" },
  family: { id: "family-user", displayName: "家人" },
  collaborator: { id: "collaborator-user", displayName: "外部协作者" },
  nextOwner: { id: "next-owner", displayName: "新负责人" },
  outsider: { id: "outsider-user", displayName: "其他项目用户" }
} satisfies Record<string, Principal>

const tokens = {
  owner: "owner-token-".repeat(4),
  family: "family-token-".repeat(4),
  collaborator: "collaborator-token-".repeat(3),
  nextOwner: "next-owner-token-".repeat(3),
  outsider: "outsider-token-".repeat(4)
}

test("业务 HTTP：服务端身份、范围权限、版本、撤销和负责人移交", async () => {
  const aiRepo = new Repository(":memory:")
  const businessRepo = new BusinessRepository(":memory:")
  const business = new BusinessService(businessRepo)
  const authenticator = new StaticBearerAuthenticator(
    (Object.keys(principals) as Array<keyof typeof principals>).map(key => ({
      token: tokens[key],
      principal: principals[key]
    }))
  )
  const server = createApi(aiRepo, {
    model: "unused",
    async run() { throw new Error("not used") }
  }, "legacy-ai-token-".repeat(3), { business, businessAuthenticator: authenticator })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address() as { port: number }
  const base = "http://127.0.0.1:" + address.port
  const request = (
    token: string,
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST"
  ) => fetch(base + path, {
    method,
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  try {
    assert.equal((await request(
      "legacy-ai-token-".repeat(3), "/v1/projects"
    )).status, 401)

    const createdResponse = await request(tokens.owner, "/v1/projects", {
      requestId: "create-project-1",
      name: "新家装修"
    })
    assert.equal(createdResponse.status, 201)
    const project = await createdResponse.json() as { id: string; version: number }
    const path = "/v1/projects/" + project.id
    const command = (token: string, value: unknown) =>
      request(token, path + "/commands", value)

    for (const [key, role, areas, extra] of [
      ["family", "family", ["agreements", "materials", "issues", "expenses"], {}],
      ["collaborator", "collaborator", ["issues"], { issueIds: ["issue-1"] }],
      ["nextOwner", "family", ["agreements", "materials", "issues", "expenses"], {}]
    ] as const) {
      const principal = principals[key]
      const response = await command(tokens.owner, {
        requestId: "member-" + key,
        type: "member.put",
        payload: {
          userId: principal.id,
          displayName: principal.displayName,
          role,
          status: "active",
          areas,
          ...extra,
          expectedVersion: 0
        }
      })
      assert.equal(response.status, 200)
    }

    const createIssueCommand = {
      requestId: "issue-create-1",
      type: "issue.create",
      payload: {
        id: "issue-1",
        title: "墙面渗水",
        description: "卫生间外墙出现水印"
      }
    }
    const issueResponse = await command(tokens.family, createIssueCommand)
    assert.equal(issueResponse.status, 200)
    const replay = await (await command(tokens.family, {
      requestId: "issue-create-1",
      type: "issue.create",
      payload: {
        description: "卫生间外墙出现水印",
        title: "墙面渗水",
        id: "issue-1"
      }
    })).json() as { id: string }
    const issue = await issueResponse.json() as { id: string }
    assert.equal(replay.id, issue.id)
    assert.equal((await command(tokens.family, {
      ...createIssueCommand,
      payload: { ...createIssueCommand.payload, title: "改成另一件事" }
    })).status, 409)

    assert.equal((await command(tokens.collaborator, {
      requestId: "proposal-collaborator",
      type: "issue.add_proposal",
      payload: {
        issueId: "issue-1", proposalId: "proposal-a",
        content: "先排查防水层", expectedVersion: 1
      }
    })).status, 200)
    assert.equal((await command(tokens.family, {
      requestId: "proposal-stale",
      type: "issue.add_proposal",
      payload: {
        issueId: "issue-1", proposalId: "proposal-b",
        content: "检查管道接口", expectedVersion: 1
      }
    })).status, 409)

    const fakeOwner = await command(tokens.collaborator, {
      requestId: "fake-owner-select",
      type: "issue.select_proposal",
      payload: {
        issueId: "issue-1", proposalId: "proposal-a",
        expectedVersion: 2, role: "owner"
      }
    })
    assert.equal(fakeOwner.status, 403)
    assert.equal((await command(tokens.owner, {
      requestId: "owner-select",
      type: "issue.select_proposal",
      payload: {
        issueId: "issue-1", proposalId: "proposal-a", expectedVersion: 2
      }
    })).status, 200)

    assert.equal((await request(
      tokens.outsider, path + "/objects/issue/issue-1"
    )).status, 404)
    const outsiderProject = await (await request(tokens.outsider, "/v1/projects", {
      requestId: "outsider-project",
      name: "无关项目"
    })).json() as { id: string }
    assert.equal((await request(
      tokens.family,
      "/v1/projects/" + outsiderProject.id + "/objects/issue/issue-1"
    )).status, 404)

    assert.equal((await command(tokens.owner, {
      requestId: "archive",
      type: "project.archive",
      payload: { expectedVersion: 1 }
    })).status, 200)
    assert.equal((await command(tokens.family, {
      requestId: "archived-write",
      type: "issue.add_proposal",
      payload: {
        issueId: "issue-1", proposalId: "proposal-c",
        content: "归档后提交", expectedVersion: 3
      }
    })).status, 409)
    assert.equal((await command(tokens.owner, {
      requestId: "reopen",
      type: "project.reopen",
      payload: { expectedVersion: 2 }
    })).status, 200)

    assert.equal((await command(tokens.owner, {
      requestId: "revoke-family",
      type: "member.put",
      payload: {
        userId: principals.family.id,
        displayName: principals.family.displayName,
        role: "family",
        status: "revoked",
        areas: ["agreements", "materials", "issues", "expenses"],
        expectedVersion: 1
      }
    })).status, 200)
    assert.equal((await command(tokens.family, createIssueCommand)).status, 404)
    assert.equal((await request(
      tokens.family, path + "/objects/issue/issue-1"
    )).status, 404)

    assert.equal((await command(tokens.owner, {
      requestId: "transfer-init",
      type: "owner_transfer.initiate",
      payload: {
        id: "transfer-1",
        targetUserId: principals.nextOwner.id,
        expectedProjectVersion: 3
      }
    })).status, 200)
    assert.equal((await command(tokens.nextOwner, {
      requestId: "transfer-accept",
      type: "owner_transfer.accept",
      payload: {
        transferId: "transfer-1",
        expectedVersion: 1,
        expectedProjectVersion: 3
      }
    })).status, 200)

    assert.equal((await command(tokens.owner, {
      requestId: "old-owner-approval",
      type: "cost.approval",
      payload: {
        costItemId: "cost-1", expectedVersion: 0,
        action: "initial", amountFen: 1000, reason: ""
      }
    })).status, 403)
    assert.equal((await command(tokens.nextOwner, {
      requestId: "new-owner-approval",
      type: "cost.approval",
      payload: {
        costItemId: "cost-1", expectedVersion: 0,
        action: "initial", amountFen: 1000, reason: ""
      }
    })).status, 200)
    assert.equal((await request(tokens.owner, path + "/audit")).status, 403)
    assert.equal((await request(tokens.nextOwner, path + "/audit")).status, 200)

    const members = businessRepo.listMemberships(project.id)
    assert.equal(members.filter((item: BusinessMembership) =>
      item.status === "active" && item.role === "owner").length, 1)
    assert.equal(businessRepo.getProject(project.id)?.ownerId, principals.nextOwner.id)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()))
    businessRepo.close()
    aiRepo.close()
  }
})

test("组合变更故障时约定、费用、审计和幂等回执整体回滚", () => {
  let failing = false
  const repo = new BusinessRepository(":memory:", {
    faultInjector(point) {
      if (failing && point === "change.approve.after_agreement") {
        throw new Error("simulated storage failure")
      }
    }
  })
  const service = new BusinessService(repo)
  try {
    const owner = principals.owner
    const project = service.createProject(owner, {
      requestId: "project-for-rollback",
      name: "事务测试"
    })
    service.execute(owner, project.id, {
      requestId: "agreement-create",
      type: "agreement.create",
      payload: {
        id: "agreement-1",
        versionId: "agreement-v1",
        subject: "material",
        subjectId: "material-1",
        title: "瓷砖型号",
        terms: [{ key: "model", label: "型号", value: "B" }]
      }
    })
    service.execute(owner, project.id, {
      requestId: "agreement-submit",
      type: "agreement.submit",
      payload: {
        agreementId: "agreement-1",
        versionId: "agreement-v1",
        expectedVersion: 1
      }
    })

    const combined = {
      requestId: "combined-change",
      type: "change.approve" as const,
      payload: {
        changeId: "change-1",
        agreementId: "agreement-1",
        versionId: "agreement-v1",
        agreementExpectedVersion: 2,
        costItemId: "cost-1",
        financeExpectedVersion: 0,
        costAction: "increase",
        amountFen: 20_000,
        reason: "接受替换增加费用"
      }
    }
    failing = true
    assert.throws(() => service.execute(owner, project.id, combined), /simulated storage failure/)
    failing = false

    const agreementAfterFailure = repo.getObject<{
      agreement: { version: number; activeVersionId?: string }
      versions: Array<{ id: string; status: string }>
    }>(project.id, "agreement", "agreement-1")!
    assert.equal(agreementAfterFailure.value.agreement.version, 2)
    assert.equal(agreementAfterFailure.value.agreement.activeVersionId, undefined)
    assert.equal(agreementAfterFailure.value.versions[0].status, "pending_confirmation")
    assert.equal(repo.getObject(project.id, "finance_ledger", "cost-1"), undefined)
    assert.equal(repo.getObject(project.id, "change_request", "change-1"), undefined)
    assert.equal(repo.getCommand(owner.id, combined.requestId), undefined)
    assert.equal(repo.listAudit(project.id).some(item =>
      item.requestId === combined.requestId), false)

    const succeeded = service.execute(owner, project.id, combined) as {
      agreement: { value: { agreement: { activeVersionId?: string } } }
      finance: { value: { approvals: Array<{ amountFen: number }> } }
      change: { value: { reason: string } }
    }
    assert.equal(succeeded.agreement.value.agreement.activeVersionId, "agreement-v1")
    assert.equal(succeeded.finance.value.approvals[0].amountFen, 20_000)
    assert.equal(succeeded.change.value.reason, "接受替换增加费用")
    assert.deepEqual(service.execute(owner, project.id, combined), succeeded)
    assert.equal(repo.listAudit(project.id).filter(item =>
      item.requestId === combined.requestId).length, 3)
  } finally {
    repo.close()
  }
})

test("确认可用入库故障时到货、库存和审计整体回滚", () => {
  let failing = false
  const repo = new BusinessRepository(":memory:", {
    faultInjector(point) {
      if (failing && point === "receipt.allocate.after_receipt") {
        throw new Error("simulated receipt failure")
      }
    }
  })
  const service = new BusinessService(repo)
  try {
    const owner = principals.owner
    const project = service.createProject(owner, {
      requestId: "project-for-receipt",
      name: "到货事务测试"
    })
    service.execute(owner, project.id, {
      requestId: "receipt-create",
      type: "receipt.create",
      payload: {
        id: "receipt-1",
        materialId: "material-1",
        unit: "片",
        occurredAt: "2026-09-25T10:00:00.000Z",
        quantityMilli: 10_000
      }
    })
    const accept = {
      requestId: "receipt-accept",
      type: "receipt.allocate" as const,
      payload: {
        receiptId: "receipt-1",
        expectedVersion: 1,
        expectedInventoryVersion: 0,
        kind: "accepted_available",
        quantityMilli: 10_000
      }
    }
    failing = true
    assert.throws(() => service.execute(owner, project.id, accept), /simulated receipt failure/)
    failing = false
    const afterFailure = repo.getObject<{
      version: number
      allocationEvents: unknown[]
    }>(project.id, "receipt", "receipt-1")!
    assert.equal(afterFailure.value.version, 1)
    assert.equal(afterFailure.value.allocationEvents.length, 0)
    assert.equal(repo.getObject(project.id, "inventory_ledger", "material-1"), undefined)
    assert.equal(repo.getCommand(owner.id, accept.requestId), undefined)

    const result = service.execute(owner, project.id, accept) as {
      receipt: { value: { version: number } }
      inventory: { value: { version: number; events: unknown[] } }
    }
    assert.equal(result.receipt.value.version, 2)
    assert.equal(result.inventory.value.version, 1)
    assert.equal(result.inventory.value.events.length, 1)
  } finally {
    repo.close()
  }
})

test("业务数据库重启后保留项目、对象、审计和幂等回执", () => {
  const dir = mkdtempSync(join(tmpdir(), "renovation-business-"))
  const path = join(dir, "business.sqlite")
  try {
    const first = new BusinessRepository(path)
    const service = new BusinessService(first)
    const project = service.createProject(principals.owner, {
      requestId: "persistent-project",
      name: "持久化测试"
    })
    const command = {
      requestId: "persistent-issue",
      type: "issue.create" as const,
      payload: {
        id: "issue-persisted",
        title: "重启后仍存在",
        description: "检查 SQLite 持久化"
      }
    }
    const before = service.execute(principals.owner, project.id, command)
    first.close()

    const second = new BusinessRepository(path)
    try {
      const afterService = new BusinessService(second)
      assert.equal(second.getProject(project.id)?.name, "持久化测试")
      assert.equal(
        second.getObject(project.id, "issue", "issue-persisted")?.id,
        "issue-persisted"
      )
      assert.deepEqual(
        afterService.execute(principals.owner, project.id, command),
        before
      )
      assert.equal(second.listAudit(project.id).filter(item =>
        item.requestId === command.requestId).length, 1)
      assert.equal(
        second.db.prepare(
          "SELECT COUNT(*) AS count FROM business_schema_migrations WHERE version = 1"
        ).get()!.count,
        1
      )
    } finally {
      second.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
