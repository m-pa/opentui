import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"

import {
  AccessibilityIpcClient,
  createAccessibilityIpcSessionId,
  createAccessibilityIpcToken,
  type AccessibilityEvent,
  type AccessibilitySnapshot,
} from "@opentui/core"
import { AccessibilityIpcServer, type AccessibilityAdapter, type AccessibilityIpcSession } from "./index.js"

let server: AccessibilityIpcServer
let client: AccessibilityIpcClient

function waitFor<T>(subscribe: (resolve: (value: T) => void) => void, timeoutMs: number = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for event")), timeoutMs)
    subscribe((value) => {
      clearTimeout(timeout)
      resolve(value)
    })
  })
}

function createSnapshot(label: string): AccessibilitySnapshot {
  return {
    rootId: "__root__",
    focusedId: "button",
    nodes: [
      {
        id: "__root__",
        parentId: null,
        role: "application",
        bounds: { x: 0, y: 0, width: 80, height: 24 },
        state: {},
        children: ["button"],
      },
      {
        id: "button",
        parentId: "__root__",
        role: "button",
        label,
        bounds: { x: 1, y: 1, width: 10, height: 1 },
        state: { focused: true },
        children: [],
      },
    ],
  }
}

function createSocketPath(sessionId: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\${sessionId}`
  }
  return join("/tmp/opencode", `${sessionId}.sock`)
}

describe("AccessibilityIpcServer", () => {
  beforeEach(() => {
    client = undefined as unknown as AccessibilityIpcClient
    server = undefined as unknown as AccessibilityIpcServer
  })

  afterEach(async () => {
    client?.disconnect()
    await server?.stop()
  })

  test("registers sessions and stores snapshots", async () => {
    const sessionId = createAccessibilityIpcSessionId("a11y-test")
    const token = createAccessibilityIpcToken()
    const socketPath = createSocketPath(sessionId)
    const snapshot = createSnapshot("Run")

    server = new AccessibilityIpcServer({ socketPath, token, enableDefaultSpeechAdapter: false })
    await server.start()

    const snapshotPromise = waitFor<[string, AccessibilitySnapshot]>((resolve) => {
      server.once("snapshot", (receivedSessionId, receivedSnapshot) => {
        resolve([receivedSessionId, receivedSnapshot])
      })
    })

    client = new AccessibilityIpcClient({
      socketPath,
      sessionId,
      token,
      appName: "test-app",
      getSnapshot: () => snapshot,
    })
    await client.connect()

    const [receivedSessionId, receivedSnapshot] = await snapshotPromise
    expect(receivedSessionId).toBe(sessionId)
    expect(receivedSnapshot).toEqual(snapshot)
    expect(server.getSession(sessionId)).toMatchObject({
      sessionId,
      appName: "test-app",
      connected: true,
      snapshot,
    })
  })

  test("stores accessibility events from clients", async () => {
    const sessionId = createAccessibilityIpcSessionId("a11y-test")
    const socketPath = createSocketPath(sessionId)
    const event: AccessibilityEvent = {
      type: "live",
      text: "Build complete",
      politeness: "polite",
    }

    server = new AccessibilityIpcServer({ socketPath, enableDefaultSpeechAdapter: false })
    await server.start()

    const eventPromise = waitFor<[string, AccessibilityEvent]>((resolve) => {
      server.once("event", (receivedSessionId, receivedEvent) => {
        resolve([receivedSessionId, receivedEvent])
      })
    })

    client = new AccessibilityIpcClient({
      socketPath,
      sessionId,
      getSnapshot: () => createSnapshot("Run"),
    })
    await client.connect()
    client.sendEvent(event)

    const [receivedSessionId, receivedEvent] = await eventPromise
    expect(receivedSessionId).toBe(sessionId)
    expect(receivedEvent).toEqual(event)
    expect(server.getSession(sessionId)?.events).toEqual([event])
  })

  test("routes server actions to clients", async () => {
    const sessionId = createAccessibilityIpcSessionId("a11y-test")
    const socketPath = createSocketPath(sessionId)
    const actions: unknown[] = []

    server = new AccessibilityIpcServer({ socketPath, enableDefaultSpeechAdapter: false })
    await server.start()

    const snapshotPromise = waitFor<void>((resolve) => {
      server.once("snapshot", () => resolve())
    })

    client = new AccessibilityIpcClient({
      socketPath,
      sessionId,
      getSnapshot: () => createSnapshot("Run"),
      handleAction: (action) => {
        actions.push(action)
      },
    })
    await client.connect()
    await snapshotPromise

    const result = await server.sendAction(sessionId, { type: "focus", nodeId: "button" })

    expect(result).toMatchObject({ ok: true, sessionId })
    expect(actions).toEqual([{ type: "focus", nodeId: "button" }])
  })

  test("dispatches accessibility events to adapters", async () => {
    const sessionId = createAccessibilityIpcSessionId("a11y-test")
    const socketPath = createSocketPath(sessionId)
    const handled: Array<[AccessibilityIpcSession, AccessibilityEvent]> = []
    const adapter: AccessibilityAdapter = {
      name: "test-adapter",
      handleEvent: (session, event) => {
        handled.push([session, event])
      },
    }
    const event: AccessibilityEvent = { type: "live", text: "Ready", politeness: "polite" }

    server = new AccessibilityIpcServer({ socketPath, adapters: [adapter], enableDefaultSpeechAdapter: false })
    await server.start()

    client = new AccessibilityIpcClient({
      socketPath,
      sessionId,
      getSnapshot: () => createSnapshot("Run"),
    })
    await client.connect()
    client.sendEvent(event)

    await waitFor<void>((resolve) => {
      server.once("event", () => resolve())
    })

    expect(handled).toHaveLength(1)
    expect(handled[0][0]).toMatchObject({ sessionId })
    expect(handled[0][1]).toEqual(event)
  })

  test("provides semantic review commands", async () => {
    const sessionId = createAccessibilityIpcSessionId("a11y-test")
    const socketPath = createSocketPath(sessionId)
    const actions: unknown[] = []

    server = new AccessibilityIpcServer({ socketPath, enableDefaultSpeechAdapter: false })
    await server.start()

    const snapshotPromise = waitFor<void>((resolve) => {
      server.once("snapshot", () => resolve())
    })

    client = new AccessibilityIpcClient({
      socketPath,
      sessionId,
      getSnapshot: () => createSnapshot("Run"),
      handleAction: (action) => {
        actions.push(action)
      },
    })
    await client.connect()
    await snapshotPromise

    expect(await server.review(sessionId, "currentFocus")).toMatchObject({
      nodeId: "button",
      text: "Run, button",
    })
    expect(await server.review(sessionId, "screenSummary")).toMatchObject({
      text: "Run, button",
    })
    expect(await server.review(sessionId, "nextControl")).toMatchObject({
      nodeId: "button",
      text: "Run, button",
    })

    const activation = await server.review(sessionId, "activate")
    expect(activation).toMatchObject({ nodeId: "button" })
    expect(activation.text).toContain("Activated")
    expect(actions).toContainEqual({ type: "activate", nodeId: "button" })
  })
})
