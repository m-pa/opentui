import type { AccessibilityEvent } from "@opentui/core"
import type { AccessibilityIpcSession } from "../index.js"

export interface AccessibilityAdapter {
  readonly name: string
  start?(): void | Promise<void>
  stop?(): void | Promise<void>
  handleEvent(session: AccessibilityIpcSession, event: AccessibilityEvent): void | Promise<void>
}

export function formatAccessibilityEvent(session: AccessibilityIpcSession, event: AccessibilityEvent): string | null {
  switch (event.type) {
    case "live":
      return event.text
    case "focus": {
      if (!event.node) return null
      const parts = [event.node.label ?? event.node.value, event.node.role]
      return parts.filter(Boolean).join(", ") || null
    }
    case "value": {
      const label = event.node?.label
      const value = event.value
      if (label && value) return `${label}: ${value}`
      return value ?? null
    }
  }
}
