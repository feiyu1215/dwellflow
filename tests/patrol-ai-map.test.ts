import assert from "node:assert/strict"
import test from "node:test"
import { AI_TASKS } from "../miniprogram/core/ai-contract.ts"
import { mappedPatrolAiTasks, patrolAiMapping } from "../miniprogram/core/patrol-ai-map.ts"

test("五个巡场环节映射七类既有 AI 任务且不新增伪任务", () => {
  assert.deepEqual(
    new Set(mappedPatrolAiTasks()),
    new Set(AI_TASKS.map(item => item.id))
  )
})

test("处理与复查使用同一整改契约的不同模式", () => {
  const resolve = patrolAiMapping("resolve").shortcuts.find(item => item.task === "rectification")
  const review = patrolAiMapping("review").shortcuts.find(item => item.task === "rectification")
  assert.equal(resolve?.mode, "proposal")
  assert.equal(review?.mode, "review")
})

test("未知工作环节安全回到现场映射", () => {
  assert.equal(patrolAiMapping("water-electricity").stepId, "site")
  assert.equal(patrolAiMapping(undefined).stepId, "site")
})
