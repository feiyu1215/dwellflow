import type { CameraBinding, CameraProviderKey } from "./domain"

export interface CameraProviderDefinition {
  key: CameraProviderKey
  name: string
  description: string
  authorizationMode: string
  officialUrl: string
}

export const CAMERA_PROVIDERS: CameraProviderDefinition[] = [
  {
    key: "ezviz_hosted",
    name: "萤石设备托管",
    description: "设备所有者在萤石授权中间页选择设备和权限，平台服务端换取并保管授权令牌。",
    authorizationMode: "供应商账号授权",
    officialUrl: "https://open.ys7.com/cn/s/device"
  },
  {
    key: "gb28181_cloud",
    name: "GB28181 云平台",
    description: "由已选定的国标云平台接入设备，再通过该平台的服务端接口创建观看会话。",
    authorizationMode: "云平台设备绑定",
    officialUrl: "https://open.ys7.com/cn/s/index"
  }
]

export interface CameraRuntimeConfig {
  apiBaseUrl: string
  miniProgramAppId: string
  providerEnabled: Partial<Record<CameraProviderKey, boolean>>
}

export const CAMERA_RUNTIME: CameraRuntimeConfig = {
  apiBaseUrl: "",
  miniProgramAppId: "",
  providerEnabled: {}
}

export function cameraReadiness(binding: CameraBinding, runtime = CAMERA_RUNTIME) {
  const missing: string[] = []
  if (!runtime.miniProgramAppId) missing.push("真实微信小程序 AppID")
  if (!runtime.apiBaseUrl) missing.push("服务端 API 地址")
  if (!runtime.providerEnabled[binding.provider]) missing.push("供应商应用与服务端授权")
  if (!binding.externalDeviceId) missing.push("已授权设备标识")
  return { ready: missing.length === 0 && binding.status === "ready", missing }
}

export async function requestViewingSession(binding: CameraBinding): Promise<never> {
  const readiness = cameraReadiness(binding)
  if (!readiness.ready) throw new Error(`监控尚未完成实机配置：${readiness.missing.join("、")}`)
  throw new Error("观看会话必须由已配置服务端签发，当前开发环境未连接服务端")
}
