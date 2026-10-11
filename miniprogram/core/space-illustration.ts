import type { SpaceKind } from "./domain"

export interface SpaceIllustrationDescriptor {
  assetPath: string
  label: string
}

const ILLUSTRATIONS: Record<SpaceKind, SpaceIllustrationDescriptor> = {
  living_room: { assetPath: "/assets/space-illustrations/living-room.png", label: "客厅空间示意" },
  bedroom: { assetPath: "/assets/space-illustrations/bedroom.png", label: "卧室空间示意" },
  kitchen: { assetPath: "/assets/space-illustrations/kitchen.png", label: "厨房空间示意" },
  bathroom: { assetPath: "/assets/space-illustrations/bathroom.png", label: "卫生间空间示意" },
  balcony: { assetPath: "/assets/space-illustrations/balcony.png", label: "阳台空间示意" },
  corridor: { assetPath: "/assets/space-illustrations/corridor.png", label: "走廊空间示意" },
  whole_project: { assetPath: "/assets/space-illustrations/other.png", label: "项目空间示意" },
  other: { assetPath: "/assets/space-illustrations/other.png", label: "通用空间示意" },
  custom: { assetPath: "/assets/space-illustrations/other.png", label: "自定义空间示意" }
}

export function spaceIllustrationFor(kind: SpaceKind): SpaceIllustrationDescriptor {
  return ILLUSTRATIONS[kind]
}
