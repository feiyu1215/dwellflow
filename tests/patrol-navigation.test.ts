import assert from "node:assert/strict"
import test from "node:test"
import {
  isPatrolWorkStepId,
  movePatrolCoordinate,
  PATROL_WORK_STEPS,
  patrolAvailable,
  patrolDirectionFromDelta
} from "../miniprogram/core/patrol-navigation.ts"

test("巡场手势只接受超过阈值且方向明确的单轴移动", () => {
  assert.equal(patrolDirectionFromDelta({ dx: -80, dy: 8 }), "next-space")
  assert.equal(patrolDirectionFromDelta({ dx: 80, dy: -8 }), "previous-space")
  assert.equal(patrolDirectionFromDelta({ dx: 5, dy: -80 }), "next-step")
  assert.equal(patrolDirectionFromDelta({ dx: -5, dy: 80 }), "previous-step")
  assert.equal(patrolDirectionFromDelta({ dx: 47, dy: 0 }), undefined)
  assert.equal(patrolDirectionFromDelta({ dx: 80, dy: 70 }), undefined)
})

test("巡场边界不循环并保留当前位置", () => {
  assert.deepEqual(movePatrolCoordinate({
    current: { spaceIndex: 0, stepIndex: 0 }, direction: "previous-space", spaceCount: 2, stepCount: 3
  }), { spaceIndex: 0, stepIndex: 0, moved: false, transition: "" })
  assert.deepEqual(movePatrolCoordinate({
    current: { spaceIndex: 1, stepIndex: 2 }, direction: "next-step", spaceCount: 2, stepCount: 3
  }), { spaceIndex: 1, stepIndex: 2, moved: false, transition: "" })
})

test("空间与工作环节移动只改变各自坐标并返回匹配动效", () => {
  assert.deepEqual(movePatrolCoordinate({
    current: { spaceIndex: 0, stepIndex: 1 }, direction: "next-space", spaceCount: 3, stepCount: 4
  }), { spaceIndex: 1, stepIndex: 1, moved: true, transition: "enter-left" })
  assert.deepEqual(movePatrolCoordinate({
    current: { spaceIndex: 1, stepIndex: 1 }, direction: "previous-step", spaceCount: 3, stepCount: 4
  }), { spaceIndex: 1, stepIndex: 0, moved: true, transition: "enter-down" })
})

test("巡场工作环节使用固定且可校验的五步语义", () => {
  assert.deepEqual(PATROL_WORK_STEPS.map(item => item.id), ["site", "record", "check", "resolve", "review"])
  assert.equal(isPatrolWorkStepId("check"), true)
  assert.equal(isPatrolWorkStepId("水电"), false)
})

test("归档、回收站或没有活动空间时不能恢复到巡场空白页", () => {
  assert.equal(patrolAvailable("active", 1), true)
  assert.equal(patrolAvailable("active", 0), false)
  assert.equal(patrolAvailable("archived", 2), false)
  assert.equal(patrolAvailable("trashed", 2), false)
})
