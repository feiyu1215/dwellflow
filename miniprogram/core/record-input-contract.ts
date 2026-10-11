export const RECORD_INPUT_SCHEMA_VERSION = 1
export const RECORD_INPUT_PROMPT_VERSION = "record-input-2026-10-12.1"
export const RECORD_INPUT_CONTRACT_VERSION = "record-input-contract-1"

export type RecordInputFieldStatus = "extracted" | "unknown" | "conflict" | "needs_confirmation"
export type RecordInputSourceKind = "user_statement" | "context_default" | "model_suggestion"
export type RecordInputFieldKey = "title" | "note" | "room" | "stage" | "occurredDate"

export interface RecordInputFieldSource {
  kind: RecordInputSourceKind
  ref: string
  quote: string
}

export interface RecordInputFieldCandidate {
  value: string
  sources: RecordInputFieldSource[]
}

export interface RecordInputField {
  value: string
  status: RecordInputFieldStatus
  sources: RecordInputFieldSource[]
  candidates: RecordInputFieldCandidate[]
}

export interface RecordInputExtractionResult {
  schemaVersion: typeof RECORD_INPUT_SCHEMA_VERSION
  title: RecordInputField
  note: RecordInputField
  room: RecordInputField
  stage: RecordInputField
  occurredDate: RecordInputField
  unknowns: string[]
}

export interface RecordInputExtractionRequest {
  requestId: string
  projectId: string
  inputRevision: number
  originalText: string
  context: {
    currentRoom: string
    currentStage: string
    currentDate: string
    roomOptions: string[]
    stageOptions: string[]
  }
}

export interface RecordInputExtractionResponse {
  requestId: string
  projectId: string
  inputRevision: number
  promptVersion: typeof RECORD_INPUT_PROMPT_VERSION
  contractVersion: typeof RECORD_INPUT_CONTRACT_VERSION
  result: RecordInputExtractionResult
  metrics?: {
    durationMs: number
    providerRequestId?: string
    responseModel?: string
  }
}

