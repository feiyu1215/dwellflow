import { STATUS_META, type Issue } from "./domain"

export function issueView(issue: Issue) {
  const meta = STATUS_META[issue.status]
  return {
    ...issue,
    statusLabel: meta.label,
    statusClass: meta.tone === "green" ? "pill pill-green" : meta.tone === "amber" ? "pill pill-amber" : "pill",
    proposalCount: issue.proposals.length,
    acceptedProposal: issue.proposals.find(item => item.decision === "accepted"),
    nextActionLabel: issue.status === "pending_confirmation"
      ? "确认后进入处理"
      : issue.status === "pending_action"
        ? "提交复查"
        : issue.status === "pending_review"
          ? "负责人关闭"
          : "重新打开"
  }
}

export function formatTime(value: string): string {
  const date = new Date(value)
  const pad = (num: number) => String(num).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
