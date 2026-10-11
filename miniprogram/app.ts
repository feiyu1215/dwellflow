import { activateV2State, purgeExpiredProjects } from "./core/store"
import { recoverInterruptedPortableTasks } from "./core/portable-files"

App({
  onLaunch() {
    const migration = activateV2State()
    if (migration.status === "blocked") {
      console.error("R8 本地状态迁移未完成", migration.errors)
    }
    recoverInterruptedPortableTasks()
    purgeExpiredProjects()
  },
  globalData: {
    currentProjectId: ""
  }
})
