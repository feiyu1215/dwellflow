import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import test from "node:test"

import { spaceIllustrationFor } from "../miniprogram/core/space-illustration.ts"

test("核心房间拥有不同的确定性空间示意且资源随项目交付", () => {
  const kinds = ["living_room", "bedroom", "kitchen", "bathroom"] as const
  const descriptors = kinds.map(spaceIllustrationFor)

  assert.equal(new Set(descriptors.map(item => item.assetPath)).size, kinds.length)
  for (const descriptor of descriptors) {
    assert.match(descriptor.label, /空间示意/)
    assert.ok(
      existsSync(`miniprogram${descriptor.assetPath}`),
      `${descriptor.assetPath} 没有随小程序交付`
    )
  }
})

test("非核心空间使用明确的通用示意，不生成或伪造用户户型", () => {
  const custom = spaceIllustrationFor("custom")
  const other = spaceIllustrationFor("other")
  const wholeProject = spaceIllustrationFor("whole_project")

  assert.equal(custom.assetPath, other.assetPath)
  assert.equal(wholeProject.assetPath, other.assetPath)
  assert.match(custom.label, /自定义空间示意/)
})
