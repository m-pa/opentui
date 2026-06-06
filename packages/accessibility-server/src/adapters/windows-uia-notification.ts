import type { AccessibilityEvent } from "@opentui/core"
import type { AccessibilityIpcSession } from "../index.js"
import { type AccessibilityAdapter } from "./types.js"

export interface WindowsUiaNotificationAdapterOptions {
  fallback?: AccessibilityAdapter
}

export class WindowsUiaNotificationAdapter implements AccessibilityAdapter {
  public readonly name = "windows-uia-notification"

  constructor(private readonly options: WindowsUiaNotificationAdapterOptions = {}) {}

  public isAvailable(): boolean {
    return process.platform === "win32" && false
  }

  public async handleEvent(session: AccessibilityIpcSession, event: AccessibilityEvent): Promise<void> {
    // UIA Notification events require a real UIA provider/peer. A terminal child
    // process cannot raise them into Windows Terminal's accessibility tree by
    // itself, so this adapter is intentionally a scaffold until the native helper
    // window/provider exists. Keep the adapter in the pipeline so server config
    // can target it and fall back predictably today.
    await this.options.fallback?.handleEvent(session, event)
  }
}
