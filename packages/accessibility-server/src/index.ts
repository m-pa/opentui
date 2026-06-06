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
  AccessibilitySnapshot,
} from "@opentui/core"
import {
  ACCESSIBILITY_IPC_PROTOCOL_VERSION,
  decodeAccessibilityIpcMessage,
  encodeAccessibilityIpcMessage,
} from "@opentui/core"

export interface AccessibilityIpcServerOptions {
  socketPath: string
  token?: string
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

export class AccessibilityIpcServer extends EventEmitter {
  private server: Server | null = null
  private readonly sessions = new Map<string, AccessibilityIpcSession>()
  private readonly socketsBySession = new Map<string, Socket>()
  private readonly connectionStates = new WeakMap<Socket, ConnectionState>()
  private readonly pendingActions = new Map<string, PendingAction>()
  private actionCounter = 0

  constructor(private readonly options: AccessibilityIpcServerOptions) {
    super()
  }

  public async start(): Promise<void> {
    if (this.server) return

    await this.prepareSocketPath()

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
}

export type { AccessibilityIpcMessage }
