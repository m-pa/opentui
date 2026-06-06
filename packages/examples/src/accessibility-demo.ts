import {
  BoxRenderable,
  CliRenderEvents,
  createAccessibilityIpcSessionId,
  createAccessibilityIpcToken,
  createCliRenderer,
  getDefaultAccessibilityIpcSocketPath,
  InputRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextareaRenderable,
  TextRenderable,
  type AccessibilityEvent,
  type AccessibilityIpcAction,
  type AccessibilityIpcClient,
  type AccessibilityIpcSessionMetadata,
  type CliRenderer,
  type KeyEvent,
  type SelectOption,
} from "@opentui/core"
import { AccessibilityIpcServer, type AccessibilityReviewResult } from "@opentui/accessibility-server"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

let renderer: CliRenderer | null = null
let root: BoxRenderable | null = null
let nameInput: InputRenderable | null = null
let notesInput: TextareaRenderable | null = null
let actionSelect: SelectRenderable | null = null
let statusText: TextRenderable | null = null
let eventText: TextRenderable | null = null
let snapshotText: TextRenderable | null = null
let keyboardHandler: ((key: KeyEvent) => void) | null = null
let server: AccessibilityIpcServer | null = null
let client: AccessibilityIpcClient | null = null
let session: AccessibilityIpcSessionMetadata | null = null
let lastReviewedNodeId: string | undefined
let bridgeStatus = "Starting accessibility bridge..."
let lastReview = "No review command run yet."
let selectedAction = "Inspect"

const eventLog: string[] = []
const focusables: Array<InputRenderable | TextareaRenderable | SelectRenderable> = []
let focusedIndex = 0

const actions: SelectOption[] = [
  { name: "Inspect", description: "Show the latest accessibility snapshot summary", value: "inspect" },
  { name: "Announce", description: "Emit a polite live accessibility announcement", value: "announce" },
  { name: "Set Value", description: "Set the Name field through an IPC action", value: "set-value" },
  { name: "Review Next", description: "Move the server semantic review cursor to the next control", value: "review-next" },
]

function pushEvent(message: string): void {
  eventLog.unshift(message)
  eventLog.length = Math.min(eventLog.length, 8)
  updateDisplays()
}

function describeAccessibilityEvent(event: AccessibilityEvent): string {
  switch (event.type) {
    case "focus":
      return `focus: ${event.nodeId ?? "none"}`
    case "live":
      return `live(${event.politeness}): ${event.text}`
    case "value":
      return `value: ${event.nodeId} = ${event.value ?? ""}`
  }
}

function getSnapshotSummary(): string {
  if (!renderer) return "No renderer"
  const snapshot = renderer.getAccessibilitySnapshot()
  const nodes = snapshot.nodes.filter((node) => node.id !== snapshot.rootId)
  const lines = nodes.slice(0, 10).map((node) => {
    const label = node.label ?? node.value ?? node.id
    const state = node.state.selectedIndex !== undefined ? ` (${Number(node.state.selectedIndex) + 1}/${node.state.optionCount})` : ""
    return `${node.id}: ${node.role} ${label}${state}`
  })
  return [`nodes: ${snapshot.nodes.length}`, `focused: ${snapshot.focusedId ?? "none"}`, ...lines].join("\n")
}

function updateDisplays(): void {
  if (!statusText || !eventText || !snapshotText) return

  const sessionStatus = session ? `session: ${session.sessionId}` : "session: none"
  const socketStatus = server && session ? `socket: ${getDefaultAccessibilityIpcSocketPath(session.sessionId)}` : "socket: none"
  const currentFocus = renderer?.currentFocusedRenderable?.id ?? "none"
  const selectedOption = actionSelect?.getSelectedOption()
  selectedAction = selectedOption?.name ?? selectedAction

  statusText.content = [
    "Accessibility Demo",
    "",
    bridgeStatus,
    sessionStatus,
    socketStatus,
    `focused renderable: ${currentFocus}`,
    `review cursor: ${lastReviewedNodeId ?? "none"}`,
    `selected action: ${selectedAction}`,
    "",
    "Controls:",
    "Tab / Shift+Tab: cycle focus",
    "A: renderer.announce()",
    "N / P: review next/previous control",
    "F: focus reviewed node via IPC action",
    "X: activate reviewed node via review action",
    "V: set Name via IPC action",
    "S: send fresh snapshot",
    "C: clear event log",
  ].join("\n")

  eventText.content = ["Event Log", "", ...(eventLog.length ? eventLog : ["No events yet."])].join("\n")
  snapshotText.content = ["Snapshot", "", getSnapshotSummary(), "", "Last Review", lastReview].join("\n")
}

function focusAt(index: number): void {
  const current = focusables[focusedIndex]
  current?.blur()
  focusedIndex = (index + focusables.length) % focusables.length
  focusables[focusedIndex]?.focus()
  updateDisplays()
}

async function runReview(command: "currentFocus" | "screenSummary" | "nextControl" | "previousControl" | "activate"): Promise<void> {
  if (!server || !session) return
  try {
    const result: AccessibilityReviewResult = await server.review(session.sessionId, command)
    lastReview = result.text
    lastReviewedNodeId = result.nodeId ?? lastReviewedNodeId
    pushEvent(`review(${command}): ${result.text}`)
  } catch (error) {
    pushEvent(`review(${command}) failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function sendAction(action: AccessibilityIpcAction): Promise<void> {
  if (!server || !session) return
  try {
    const result = await server.sendAction(session.sessionId, action)
    pushEvent(`action(${action.type}): ${result.ok ? "ok" : result.error}`)
  } catch (error) {
    pushEvent(`action(${action.type}) failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function runSelectedAction(): void {
  const value = actionSelect?.getSelectedOption()?.value
  switch (value) {
    case "inspect":
      void runReview("screenSummary")
      return
    case "announce":
      renderer?.announce("Accessibility demo announcement", { nodeId: "a11y-status", politeness: "polite" })
      return
    case "set-value":
      void sendAction({ type: "setValue", nodeId: "a11y-name-input", value: `Ada ${Date.now().toString().slice(-4)}` })
      return
    case "review-next":
      void runReview("nextControl")
      return
  }
}

async function startBridge(): Promise<void> {
  if (!renderer) return

  const sessionId = createAccessibilityIpcSessionId("opentui-a11y-demo")
  const token = createAccessibilityIpcToken()
  const socketPath = getDefaultAccessibilityIpcSocketPath(sessionId)
  session = { sessionId, token, appName: "OpenTUI Accessibility Demo", pid: process.pid }
  server = new AccessibilityIpcServer({
    socketPath,
    token,
    enableDefaultSpeechAdapter: process.env.OPENTUI_A11Y_DEMO_SPEECH === "true",
  })

  server.on("event", (_sessionId: string, event: AccessibilityEvent) => {
    pushEvent(`server ${describeAccessibilityEvent(event)}`)
  })
  server.on("snapshot", () => {
    bridgeStatus = "Accessibility bridge connected."
    updateDisplays()
  })
  server.on("error", (error: Error) => {
    bridgeStatus = `Accessibility bridge error: ${error instanceof Error ? error.message : String(error)}`
    updateDisplays()
  })

  await server.start()
  client = renderer.createAccessibilityIpcClient({ socketPath, sessionId, token, appName: session.appName })
  client.on("error", (error) => {
    bridgeStatus = `Accessibility client error: ${error instanceof Error ? error.message : String(error)}`
    updateDisplays()
  })
  await client.connect()
  client.sendSnapshot()
  bridgeStatus = "Accessibility bridge connected."
  updateDisplays()
}

export function run(rendererInstance: CliRenderer): void {
  renderer = rendererInstance
  renderer.setBackgroundColor("#0F172A")

  root = new BoxRenderable(renderer, {
    id: "a11y-demo-root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    padding: 1,
    gap: 1,
    accessibilityRole: "application",
    accessibilityLabel: "OpenTUI accessibility demo",
  })
  renderer.root.add(root)

  const topRow = new BoxRenderable(renderer, {
    id: "a11y-top-row",
    flexDirection: "row",
    height: 11,
    gap: 2,
    accessibilityRole: "region",
    accessibilityLabel: "Interactive controls",
  })
  root.add(topRow)

  const leftPanel = new BoxRenderable(renderer, {
    id: "a11y-left-panel",
    flexDirection: "column",
    width: 36,
    gap: 1,
    border: true,
    borderColor: "#334155",
    title: "Controls",
    accessibilityRole: "region",
    accessibilityLabel: "Editable controls",
  })
  topRow.add(leftPanel)

  nameInput = new InputRenderable(renderer, {
    id: "a11y-name-input",
    width: 32,
    value: "Ada",
    placeholder: "Name",
    accessibilityLabel: "Name",
    accessibilityDescription: "Single line editable name field",
    backgroundColor: "transparent",
    focusedTextColor: "#FFFFFF",
    textColor: "#CBD5E1",
    cursorColor: "#38BDF8",
  })
  leftPanel.add(nameInput)

  notesInput = new TextareaRenderable(renderer, {
    id: "a11y-notes-input",
    width: 32,
    height: 4,
    initialValue: "Use this demo to inspect\naccessibility events.",
    accessibilityLabel: "Notes",
    accessibilityDescription: "Multiline editable notes field",
    backgroundColor: "transparent",
    focusedTextColor: "#FFFFFF",
    textColor: "#CBD5E1",
    cursorColor: "#38BDF8",
  })
  leftPanel.add(notesInput)

  actionSelect = new SelectRenderable(renderer, {
    id: "a11y-action-select",
    width: 44,
    height: 9,
    options: actions,
    accessibilityLabel: "Demo actions",
    backgroundColor: "transparent",
    focusedBackgroundColor: "#1E293B",
    selectedBackgroundColor: "#2563EB",
    selectedTextColor: "#FFFFFF",
    textColor: "#CBD5E1",
    descriptionColor: "#94A3B8",
    selectedDescriptionColor: "#DBEAFE",
    showDescription: true,
  })
  topRow.add(actionSelect)

  statusText = new TextRenderable(renderer, {
    id: "a11y-status",
    width: "100%",
    height: 18,
    content: "",
    fg: "#CBD5E1",
    accessibilityRole: "status",
    accessibilityLabel: "Accessibility demo status",
    accessibilityLive: "polite",
  })
  root.add(statusText)

  const bottomRow = new BoxRenderable(renderer, {
    id: "a11y-bottom-row",
    flexDirection: "row",
    flexGrow: 1,
    gap: 2,
  })
  root.add(bottomRow)

  eventText = new TextRenderable(renderer, {
    id: "a11y-events",
    width: "50%",
    height: "100%",
    content: "",
    fg: "#A7F3D0",
    accessibilityRole: "region",
    accessibilityLabel: "Accessibility event log",
  })
  bottomRow.add(eventText)

  snapshotText = new TextRenderable(renderer, {
    id: "a11y-snapshot",
    width: "50%",
    height: "100%",
    content: "",
    fg: "#BAE6FD",
    accessibilityRole: "region",
    accessibilityLabel: "Accessibility snapshot summary",
  })
  bottomRow.add(snapshotText)

  focusables.length = 0
  focusables.push(nameInput, notesInput, actionSelect)

  nameInput.on("input", () => updateDisplays())
  notesInput.on("line-info-change", () => updateDisplays())
  actionSelect.on(SelectRenderableEvents.SELECTION_CHANGED, (_index, option) => {
    selectedAction = option?.name ?? selectedAction
    updateDisplays()
  })
  actionSelect.on(SelectRenderableEvents.ITEM_SELECTED, () => runSelectedAction())
  renderer.on(CliRenderEvents.ACCESSIBILITY, (event: AccessibilityEvent) => {
    pushEvent(`renderer ${describeAccessibilityEvent(event)}`)
  })

  keyboardHandler = (key: KeyEvent) => {
    if (key.name === "tab") {
      focusAt(focusedIndex + (key.shift ? -1 : 1))
    } else if (key.name === "a") {
      renderer?.announce("Manual accessibility announcement from the demo", { nodeId: "a11y-status" })
    } else if (key.name === "n") {
      void runReview("nextControl")
    } else if (key.name === "p") {
      void runReview("previousControl")
    } else if (key.name === "f" && lastReviewedNodeId) {
      void sendAction({ type: "focus", nodeId: lastReviewedNodeId })
    } else if (key.name === "x") {
      void runReview("activate")
    } else if (key.name === "v") {
      void sendAction({ type: "setValue", nodeId: "a11y-name-input", value: `Grace ${Date.now().toString().slice(-4)}` })
    } else if (key.name === "s") {
      client?.sendSnapshot()
      pushEvent("snapshot sent")
    } else if (key.name === "c") {
      eventLog.length = 0
      updateDisplays()
    } else if (key.name === "return" && actionSelect?.focused) {
      runSelectedAction()
    }
  }
  renderer.keyInput.on("keypress", keyboardHandler)

  focusAt(0)
  updateDisplays()
  void startBridge().catch((error) => {
    bridgeStatus = `Accessibility bridge failed: ${error instanceof Error ? error.message : String(error)}`
    updateDisplays()
  })
}

export function destroy(rendererInstance: CliRenderer): void {
  if (keyboardHandler) {
    rendererInstance.keyInput.off("keypress", keyboardHandler)
    keyboardHandler = null
  }

  client?.disconnect()
  client = null
  void server?.stop()
  server = null

  if (root) {
    rendererInstance.root.remove(root.id)
    root.destroyRecursively()
    root = null
  }

  focusables.length = 0
  nameInput = null
  notesInput = null
  actionSelect = null
  statusText = null
  eventText = null
  snapshotText = null
  session = null
  lastReviewedNodeId = undefined
  bridgeStatus = "Starting accessibility bridge..."
  lastReview = "No review command run yet."
  eventLog.length = 0
  renderer = null
}

if (import.meta.main) {
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  run(renderer)
  setupCommonDemoKeys(renderer)
  renderer.start()
}
