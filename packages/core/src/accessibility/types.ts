export type AccessibilityRole =
  | "application"
  | "generic"
  | "text"
  | "button"
  | "textbox"
  | "listbox"
  | "option"
  | "tablist"
  | "tab"
  | "region"
  | "link"
  | "status"
  | "alert"

export type AccessibilityLive = "off" | "polite" | "assertive"

export type AccessibilityStateValue = boolean | number | string

export interface AccessibilityState {
  [key: string]: AccessibilityStateValue | undefined
}

export interface AccessibilityOptions {
  accessibilityRole?: AccessibilityRole
  accessibilityLabel?: string
  accessibilityDescription?: string
  accessibilityValue?: string
  accessibilityHidden?: boolean
  accessibilityLive?: AccessibilityLive
  accessibilityState?: AccessibilityState
}

export interface AccessibilityBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface AccessibilityNode {
  id: string
  parentId: string | null
  role: AccessibilityRole
  label?: string
  description?: string
  value?: string
  live?: AccessibilityLive
  bounds: AccessibilityBounds
  state: AccessibilityState
  children: string[]
}

export interface AccessibilitySnapshot {
  rootId: string
  focusedId: string | null
  nodes: AccessibilityNode[]
}

export interface AccessibilityAnnounceOptions {
  politeness?: AccessibilityLive
  nodeId?: string
}

export interface AccessibilityFocusEvent {
  type: "focus"
  nodeId: string | null
  previousNodeId: string | null
  node?: AccessibilityNode
}

export interface AccessibilityValueEvent {
  type: "value"
  nodeId: string
  value?: string
  node?: AccessibilityNode
}

export interface AccessibilityLiveEvent {
  type: "live"
  nodeId?: string
  politeness: Exclude<AccessibilityLive, "off">
  text: string
}

export type AccessibilityEvent = AccessibilityFocusEvent | AccessibilityValueEvent | AccessibilityLiveEvent
