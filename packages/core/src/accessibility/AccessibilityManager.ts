import { EventEmitter } from "events"
import type { Renderable } from "../Renderable.js"
import type {
  AccessibilityAnnounceOptions,
  AccessibilityEvent,
  AccessibilityLive,
  AccessibilityNode,
  AccessibilitySnapshot,
} from "./types.js"

export interface AccessibilityManagerOptions {
  getSnapshot: () => AccessibilitySnapshot
}

export class AccessibilityManager extends EventEmitter {
  private events: AccessibilityEvent[] = []
  private lastValues = new Map<string, string | undefined>()

  constructor(private readonly options: AccessibilityManagerOptions) {
    super()
  }

  public getSnapshot(): AccessibilitySnapshot {
    return this.options.getSnapshot()
  }

  public getFocusedNode(): AccessibilityNode | null {
    const snapshot = this.getSnapshot()
    if (!snapshot.focusedId) return null
    return snapshot.nodes.find((node) => node.id === snapshot.focusedId) ?? null
  }

  public getEvents(): AccessibilityEvent[] {
    return [...this.events]
  }

  public clearEvents(): void {
    this.events = []
  }

  public announce(text: string, options: AccessibilityAnnounceOptions = {}): void {
    const politeness = this.normalizePoliteness(options.politeness)
    if (!text || politeness === "off") return

    this.record({
      type: "live",
      nodeId: options.nodeId,
      politeness,
      text,
    })
  }

  public notifyFocusChanged(current: Renderable | null, previous: Renderable | null): void {
    const snapshot = this.getSnapshot()
    const node = current ? snapshot.nodes.find((candidate) => candidate.id === current.id) : undefined

    this.record({
      type: "focus",
      nodeId: node?.id ?? null,
      previousNodeId: previous?.id ?? null,
      node,
    })
  }

  public notifyValueChanged(renderable: Renderable): void {
    const snapshot = this.getSnapshot()
    const node = snapshot.nodes.find((candidate) => candidate.id === renderable.id)
    if (!node) return
    if (this.lastValues.get(node.id) === node.value) return
    this.lastValues.set(node.id, node.value)

    this.record({
      type: "value",
      nodeId: node.id,
      value: node.value,
      node,
    })
  }

  private normalizePoliteness(politeness: AccessibilityLive | undefined): Exclude<AccessibilityLive, "off"> | "off" {
    if (!politeness) return "polite"
    return politeness
  }

  private record(event: AccessibilityEvent): void {
    this.events.push(event)
    this.emit("event", event)
  }
}
