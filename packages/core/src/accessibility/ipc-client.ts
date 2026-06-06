import { EventEmitter } from "events"
import { connect, type Socket } from "node:net"

import type { AccessibilityEvent, AccessibilitySnapshot } from "./types.js"
import {
  ACCESSIBILITY_IPC_PROTOCOL_VERSION,
  decodeAccessibilityIpcMessage,
  encodeAccessibilityIpcMessage,
  type AccessibilityIpcAction,
  type AccessibilityIpcActionMessage,
  type AccessibilityIpcActionResultMessage,
  type AccessibilityIpcClientMessage,
  type AccessibilityIpcMessage,
  type AccessibilityIpcServerMessage,
} from "./protocol.js"

export interface AccessibilityIpcEventSource {
  getAccessibilitySnapshot(): AccessibilitySnapshot
  on(event: "accessibility", listener: (event: AccessibilityEvent) => void): this
  off(event: "accessibility", listener: (event: AccessibilityEvent) => void): this
}

export interface AccessibilityIpcClientOptions {
  socketPath: string
  sessionId: string
  appName?: string
  pid?: number
  token?: string
  getSnapshot: () => AccessibilitySnapshot
  handleAction?: (action: AccessibilityIpcAction) => void | Promise<void>
}

export interface AccessibilityIpcClientEvents {
  connect: () => void
  disconnect: () => void
  error: (error: Error) => void
  message: (message: AccessibilityIpcMessage) => void
}

export class AccessibilityIpcClient extends EventEmitter {
  private socket: Socket | null = null
  private buffer = ""
  private boundSource: AccessibilityIpcEventSource | null = null
  private boundListener: ((event: AccessibilityEvent) => void) | null = null
  private connected = false

  constructor(private readonly options: AccessibilityIpcClientOptions) {
    super()
  }

  public async connect(): Promise<void> {
    if (this.socket) return

    await new Promise<void>((resolve, reject) => {
      const socket = connect(this.options.socketPath)
      this.socket = socket

      const cleanupInitial = () => {
        socket.off("connect", onConnect)
        socket.off("error", onInitialError)
      }

      const onConnect = () => {
        cleanupInitial()
        this.connected = true
        this.installSocketHandlers(socket)
        this.sendHello()
        this.sendSnapshot()
        this.emit("connect")
        resolve()
      }

      const onInitialError = (error: Error) => {
        cleanupInitial()
        this.socket = null
        this.emit("error", error)
        reject(error)
      }

      socket.once("connect", onConnect)
      socket.once("error", onInitialError)
    })
  }

  public disconnect(): void {
    this.unbindEvents()

    if (!this.socket) return
    this.send({ type: "goodbye", sessionId: this.options.sessionId })
    this.socket.end()
    this.socket.destroy()
    this.socket = null
    this.connected = false
    this.emit("disconnect")
  }

  public bindEvents(source: AccessibilityIpcEventSource): void {
    this.unbindEvents()
    this.boundSource = source
    this.boundListener = (event) => {
      this.sendEvent(event)
    }
    source.on("accessibility", this.boundListener)
  }

  public unbindEvents(): void {
    if (this.boundSource && this.boundListener) {
      this.boundSource.off("accessibility", this.boundListener)
    }
    this.boundSource = null
    this.boundListener = null
  }

  public sendSnapshot(): void {
    this.send({
      type: "snapshot",
      sessionId: this.options.sessionId,
      snapshot: this.options.getSnapshot(),
    })
  }

  public sendEvent(event: AccessibilityEvent): void {
    this.send({
      type: "event",
      sessionId: this.options.sessionId,
      event,
    })
  }

  public sendActionResult(result: Omit<AccessibilityIpcActionResultMessage, "type" | "sessionId">): void {
    this.send({
      type: "actionResult",
      sessionId: this.options.sessionId,
      ...result,
    })
  }

  private installSocketHandlers(socket: Socket): void {
    socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8")
      this.drainBuffer()
    })

    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = null
      }
      if (this.connected) {
        this.connected = false
        this.emit("disconnect")
      }
    })

    socket.on("error", (error) => {
      this.emit("error", error)
    })
  }

  private drainBuffer(): void {
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n")
      if (newlineIndex === -1) return

      const line = this.buffer.slice(0, newlineIndex).trim()
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (!line) continue

      try {
        const message = decodeAccessibilityIpcMessage(line)
        this.emit("message", message)
        this.handleMessage(message as AccessibilityIpcServerMessage)
      } catch (error) {
        this.emit("error", error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  private async handleMessage(message: AccessibilityIpcServerMessage): Promise<void> {
    if (message.type !== "action") return

    try {
      const action = (message as AccessibilityIpcActionMessage).action
      if (action.type === "snapshot") {
        this.sendSnapshot()
      } else {
        await this.options.handleAction?.(action)
      }
      this.sendActionResult({ actionId: message.actionId, ok: true })
    } catch (error) {
      this.sendActionResult({
        actionId: message.actionId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private sendHello(): void {
    this.send({
      type: "hello",
      protocolVersion: ACCESSIBILITY_IPC_PROTOCOL_VERSION,
      sessionId: this.options.sessionId,
      appName: this.options.appName,
      pid: this.options.pid ?? process.pid,
      token: this.options.token,
    })
  }

  private send(message: AccessibilityIpcClientMessage): void {
    if (!this.socket || this.socket.destroyed) return
    this.socket.write(encodeAccessibilityIpcMessage(message))
  }
}
