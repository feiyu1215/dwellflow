import { registerHooks } from "node:module"

// 微信开发者工具要求 TypeScript 源码使用无扩展名的相对导入；
// Node 直接执行 .ts 测试时则不会自动补全扩展名。本钩子只在测试进程中
// 为无扩展名的相对导入尝试同名 .ts 文件，不改变产品运行时代码。
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      const missingRelativeModule = error?.code === "ERR_MODULE_NOT_FOUND"
        && (specifier.startsWith("./") || specifier.startsWith("../"))
        && !specifier.match(/\.[cm]?[jt]sx?$/)
      if (!missingRelativeModule) throw error
      return nextResolve(`${specifier}.ts`, context)
    }
  }
})
