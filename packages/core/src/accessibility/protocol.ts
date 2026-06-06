import type { AccessibilityEvent, AccessibilitySnapshot } from "./types.js"

export const ACCESSIBILITY_IPC_PROTOCOL_VERSION = 1

export interface AccessibilityIpcSessionMetadata {
  sessionId: string
  appName?: string
  pid?: number
  token?: string
}

export interface AccessibilityIpcHelloMessage extends AccessibilityIpcSessionMetadata {
  type: "hello"
  protocolVersion: typeof ACCESSIBILITY_IPC_PROTOCOL_VERSION
}

export interface AccessibilityIpcSnapshotMessage {
  type: "snapshot"
  sessionId: string
  snapshot: AccessibilitySnapshot
}

export interface AccessibilityIpcEventMessage {
  type: "event"
  sessionId: string
  event: AccessibilityEvent
}

export type AccessibilityIpcScrollDirection = "up" | "down" | "left" | "right"

export type AccessibilityIpcAction =
  | { type: "focus"; nodeId: string }
  | { type: "activate"; nodeId: string }
  | { type: "setValue"; nodeId: string; value: string }
  | { type: "scroll"; nodeId: string; direction: AccessibilityIpcScrollDirection; amount?: number }
  | { type: "snapshot" }

export interface AccessibilityIpcActionMessage {
  type: "action"
  sessionId: string
  actionId: string
  action: AccessibilityIpcAction
}

export interface AccessibilityIpcActionResultMessage {
  type: "actionResult"
  sessionId: string
  actionId: string
  ok: boolean
  error?: string
}

export interface AccessibilityIpcGoodbyeMessage {
  type: "goodbye"
  sessionId: string
}

export type AccessibilityIpcClientMessage =
  | AccessibilityIpcHelloMessage
  | AccessibilityIpcSnapshotMessage
  | AccessibilityIpcEventMessage
  | AccessibilityIpcActionResultMessage
  | AccessibilityIpcGoodbyeMessage

export type AccessibilityIpcServerMessage = AccessibilityIpcActionMessage

export type AccessibilityIpcMessage = AccessibilityIpcClientMessage | AccessibilityIpcServerMessage

export function encodeAccessibilityIpcMessage(message: AccessibilityIpcMessage): string {
  return `${JSON.stringify(message)}\n`
}

export function decodeAccessibilityIpcMessage(line: string): AccessibilityIpcMessage {
  const message = JSON.parse(line) as AccessibilityIpcMessage
  if (!message || typeof message !== "object" || typeof message.type !== "string") {
    throw new Error("Invalid accessibility IPC message")
  }
  return message
}

export function createAccessibilityIpcSessionId(prefix: string = "opentui"): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function createAccessibilityIpcToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

export function getDefaultAccessibilityIpcSocketPath(sessionId: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\${sessionId}`
  }

  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9._-]/g, "-")
  return `/tmp/${safeSessionId}.sock`
}
