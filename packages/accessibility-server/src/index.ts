import { EventEmitter } from "events"
import { mkdir, unlink } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { dirname } from "node:path"

import type {
  AccessibilityEvent,
  AccessibilityIpcAction,
  AccessibilityIpcActionMessage,
  AccessibilityIpcActionResultMessage,
  AccessibilityIpcClientMessage,
  AccessibilityIpcEventMessage,
  AccessibilityIpcHelloMessage,
  AccessibilityIpcMessage,
  AccessibilityIpcSessionMetadata,
  AccessibilityIpcSnapshotMessage,
  AccessibilityNode,
  AccessibilitySnapshot,
} from "@opentui/core"
import {
  ACCESSIBILITY_IPC_PROTOCOL_VERSION,
  decodeAccessibilityIpcMessage,
  encodeAccessibilityIpcMessage,
} from "@opentui/core"
import { createDefaultSpeechAdapter } from "./adapters/command-speech.js"
import type { AccessibilityAdapter } from "./adapters/types.js"

export interface AccessibilityIpcServerOptions {
  socketPath: string
  token?: string
  adapters?: AccessibilityAdapter[]
  enableDefaultSpeechAdapter?: boolean
}

export interface AccessibilityIpcSession extends AccessibilityIpcSessionMetadata {
  snapshot: AccessibilitySnapshot | null
  events: AccessibilityEvent[]
  connected: boolean
}

interface ConnectionState {
  buffer: string
  sessionId: string | null
}

interface PendingAction {
  resolve: (result: AccessibilityIpcActionResultMessage) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export type AccessibilityReviewCommand =
  | "currentFocus"
  | "screenSummary"
  | "nextControl"
  | "previousControl"
  | "activate"

export interface AccessibilityReviewResult {
  sessionId: string
  command: AccessibilityReviewCommand
  nodeId?: string
  text: string
}

const REVIEW_ROLES = new Set(["button", "textbox", "listbox", "tablist", "tab", "link", "status", "alert", "region"])

export class AccessibilityIpcServer extends EventEmitter {
  private server: Server | null = null
  private readonly sessions = new Map<string, AccessibilityIpcSession>()
  private readonly socketsBySession = new Map<string, Socket>()
  private readonly connectionStates = new WeakMap<Socket, ConnectionState>()
  private readonly pendingActions = new Map<string, PendingAction>()
  private readonly adapters: AccessibilityAdapter[]
  private readonly reviewIndexes = new Map<string, number>()
  private actionCounter = 0

  constructor(private readonly options: AccessibilityIpcServerOptions) {
    super()
    const defaultAdapter = options.enableDefaultSpeechAdapter === false ? null : createDefaultSpeechAdapter()
    this.adapters = [...(options.adapters ?? []), ...(defaultAdapter ? [defaultAdapter] : [])]
  }

  public async start(): Promise<void> {
    if (this.server) return

    await this.prepareSocketPath()

    for (const adapter of this.adapters) {
      await adapter.start?.()
    }

    this.server = createServer((socket) => this.handleConnection(socket))
    await new Promise<void>((resolve, reject) => {
      const server = this.server!
      const cleanup = () => {
        server.off("listening", onListening)
        server.off("error", onError)
      }
      const onListening = () => {
        cleanup()
        resolve()
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      server.once("listening", onListening)
      server.once("error", onError)
      server.listen(this.options.socketPath)
    })
  }

  public async stop(): Promise<void> {
    for (const pending of this.pendingActions.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error("Accessibility IPC server stopped"))
    }
    this.pendingActions.clear()

    for (const socket of this.socketsBySession.values()) {
      socket.destroy()
    }
    this.socketsBySession.clear()

    if (this.server) {
      const server = this.server
      this.server = null
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }

    for (const adapter of this.adapters) {
      await adapter.stop?.()
    }

    if (process.platform !== "win32") {
      await unlink(this.options.socketPath).catch(() => {})
    }
  }

  public getSession(sessionId: string): AccessibilityIpcSession | undefined {
    const session = this.sessions.get(sessionId)
    if (!session) return undefined
    return { ...session, events: [...session.events] }
  }

  public getSessions(): AccessibilityIpcSession[] {
    return [...this.sessions.values()].map((session) => ({ ...session, events: [...session.events] }))
  }

  public async sendAction(
    sessionId: string,
    action: AccessibilityIpcAction,
    timeoutMs: number = 5000,
  ): Promise<AccessibilityIpcActionResultMessage> {
    const socket = this.socketsBySession.get(sessionId)
    if (!socket || socket.destroyed) {
      throw new Error(`Accessibility IPC session is not connected: ${sessionId}`)
    }

    const actionId = `${sessionId}-${++this.actionCounter}`
    const message: AccessibilityIpcActionMessage = {
      type: "action",
      sessionId,
      actionId,
      action,
    }

    const resultPromise = new Promise<AccessibilityIpcActionResultMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingActions.delete(actionId)
        reject(new Error(`Accessibility IPC action timed out: ${actionId}`))
      }, timeoutMs)
      this.pendingActions.set(actionId, { resolve, reject, timeout })
    })

    socket.write(encodeAccessibilityIpcMessage(message))
    return resultPromise
  }

  public getFocusedNode(sessionId: string): AccessibilityNode | null {
    const snapshot = this.sessions.get(sessionId)?.snapshot
    if (!snapshot?.focusedId) return null
    return snapshot.nodes.find((node) => node.id === snapshot.focusedId) ?? null
  }

  public getReviewNodes(sessionId: string): AccessibilityNode[] {
    const snapshot = this.sessions.get(sessionId)?.snapshot
    if (!snapshot) return []
    return snapshot.nodes.filter((node) => node.id !== snapshot.rootId && REVIEW_ROLES.has(node.role))
  }

  public getScreenSummary(sessionId: string): string {
    const snapshot = this.sessions.get(sessionId)?.snapshot
    if (!snapshot) return "No accessibility session snapshot available."
    const nodes = snapshot.nodes.filter((node) => node.id !== snapshot.rootId)
    if (nodes.length === 0) return "No accessibility nodes."
    return nodes.map((node) => this.describeNode(node)).filter(Boolean).join(". ")
  }

  public async review(sessionId: string, command: AccessibilityReviewCommand): Promise<AccessibilityReviewResult> {
    const focusedNode = this.getFocusedNode(sessionId)
    const reviewNodes = this.getReviewNodes(sessionId)
    const currentIndex = this.clampReviewIndex(sessionId, reviewNodes, focusedNode?.id)

    switch (command) {
      case "currentFocus": {
        const text = focusedNode ? this.describeNode(focusedNode) : "No focused accessibility node."
        return { sessionId, command, nodeId: focusedNode?.id, text }
      }
      case "screenSummary":
        return { sessionId, command, text: this.getScreenSummary(sessionId) }
      case "nextControl": {
        const nextIndex = reviewNodes.length === 0 ? -1 : (currentIndex + 1) % reviewNodes.length
        this.reviewIndexes.set(sessionId, nextIndex)
        const node = nextIndex >= 0 ? reviewNodes[nextIndex] : undefined
        return { sessionId, command, nodeId: node?.id, text: node ? this.describeNode(node) : "No controls." }
      }
      case "previousControl": {
        const nextIndex = reviewNodes.length === 0 ? -1 : (currentIndex - 1 + reviewNodes.length) % reviewNodes.length
        this.reviewIndexes.set(sessionId, nextIndex)
        const node = nextIndex >= 0 ? reviewNodes[nextIndex] : undefined
        return { sessionId, command, nodeId: node?.id, text: node ? this.describeNode(node) : "No controls." }
      }
      case "activate": {
        const node = currentIndex >= 0 ? reviewNodes[currentIndex] : focusedNode
        if (!node) return { sessionId, command, text: "No control to activate." }
        const result = await this.sendAction(sessionId, { type: "activate", nodeId: node.id })
        return {
          sessionId,
          command,
          nodeId: node.id,
          text: result.ok ? `Activated ${this.describeNode(node)}.` : `Activation failed: ${result.error ?? "unknown error"}.`,
        }
      }
    }
  }

  private handleConnection(socket: Socket): void {
    this.connectionStates.set(socket, { buffer: "", sessionId: null })

    socket.on("data", (chunk) => {
      const state = this.connectionStates.get(socket)
      if (!state) return
      state.buffer += chunk.toString("utf8")
      this.drainConnection(socket, state)
    })

    socket.on("close", () => {
      const state = this.connectionStates.get(socket)
      if (!state?.sessionId) return
      const session = this.sessions.get(state.sessionId)
      if (session) {
        session.connected = false
      }
      this.socketsBySession.delete(state.sessionId)
      this.emit("disconnect", state.sessionId)
    })

    socket.on("error", (error) => {
      this.emit("error", error)
    })
  }

  private drainConnection(socket: Socket, state: ConnectionState): void {
    while (true) {
      const newlineIndex = state.buffer.indexOf("\n")
      if (newlineIndex === -1) return

      const line = state.buffer.slice(0, newlineIndex).trim()
      state.buffer = state.buffer.slice(newlineIndex + 1)
      if (!line) continue

      try {
        const message = decodeAccessibilityIpcMessage(line) as AccessibilityIpcClientMessage
        this.handleMessage(socket, state, message)
      } catch (error) {
        this.emit("error", error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  private handleMessage(socket: Socket, state: ConnectionState, message: AccessibilityIpcClientMessage): void {
    switch (message.type) {
      case "hello":
        this.handleHello(socket, state, message)
        return
      case "snapshot":
        this.handleSnapshot(message)
        return
      case "event":
        this.handleEvent(message)
        return
      case "actionResult":
        this.handleActionResult(message)
        return
      case "goodbye":
        socket.end()
        return
    }
  }

  private handleHello(socket: Socket, state: ConnectionState, message: AccessibilityIpcHelloMessage): void {
    if (message.protocolVersion !== ACCESSIBILITY_IPC_PROTOCOL_VERSION) {
      socket.destroy(new Error(`Unsupported accessibility IPC protocol version: ${message.protocolVersion}`))
      return
    }

    if (this.options.token !== undefined && message.token !== this.options.token) {
      socket.destroy(new Error("Invalid accessibility IPC token"))
      return
    }

    state.sessionId = message.sessionId
    const session: AccessibilityIpcSession = {
      sessionId: message.sessionId,
      appName: message.appName,
      pid: message.pid,
      token: message.token,
      snapshot: this.sessions.get(message.sessionId)?.snapshot ?? null,
      events: this.sessions.get(message.sessionId)?.events ?? [],
      connected: true,
    }
    this.sessions.set(message.sessionId, session)
    this.socketsBySession.set(message.sessionId, socket)
    this.emit("session", session)
  }

  private handleSnapshot(message: AccessibilityIpcSnapshotMessage): void {
    const session = this.sessions.get(message.sessionId)
    if (!session) return
    session.snapshot = message.snapshot
    this.emit("snapshot", message.sessionId, message.snapshot)
  }

  private handleEvent(message: AccessibilityIpcEventMessage): void {
    const session = this.sessions.get(message.sessionId)
    if (!session) return
    session.events.push(message.event)
    this.emit("event", message.sessionId, message.event)
    for (const adapter of this.adapters) {
      Promise.resolve(adapter.handleEvent(session, message.event)).catch((error) => this.emit("error", error))
    }
  }

  private handleActionResult(message: AccessibilityIpcActionResultMessage): void {
    const pending = this.pendingActions.get(message.actionId)
    if (!pending) return
    clearTimeout(pending.timeout)
    this.pendingActions.delete(message.actionId)
    pending.resolve(message)
    this.emit("actionResult", message.sessionId, message)
  }

  private async prepareSocketPath(): Promise<void> {
    if (process.platform === "win32") return
    await mkdir(dirname(this.options.socketPath), { recursive: true })
    await unlink(this.options.socketPath).catch(() => {})
  }

  private clampReviewIndex(sessionId: string, nodes: AccessibilityNode[], focusedId: string | undefined): number {
    if (nodes.length === 0) return -1
    const existing = this.reviewIndexes.get(sessionId)
    if (existing !== undefined && existing >= 0 && existing < nodes.length) return existing
    const focusedIndex = focusedId ? nodes.findIndex((node) => node.id === focusedId) : -1
    const nextIndex = focusedIndex >= 0 ? focusedIndex : 0
    this.reviewIndexes.set(sessionId, nextIndex)
    return nextIndex
  }

  private describeNode(node: AccessibilityNode): string {
    const parts = [node.label ?? node.value ?? node.id, node.role]
    if (node.value && node.label && node.value !== node.label) {
      parts.push(node.value)
    }
    if (typeof node.state.selectedIndex === "number" && typeof node.state.optionCount === "number") {
      parts.push(`${node.state.selectedIndex + 1} of ${node.state.optionCount}`)
    }
    return parts.filter(Boolean).join(", ")
  }
}

export type { AccessibilityIpcMessage }
export * from "./adapters/types.js"
export * from "./adapters/command-speech.js"
export * from "./adapters/windows-uia-notification.js"
