import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ASCIIFontRenderable } from "../renderables/ASCIIFont.js"
import { BoxRenderable } from "../renderables/Box.js"
import { InputRenderable } from "../renderables/Input.js"
import { ScrollBoxRenderable } from "../renderables/ScrollBox.js"
import { SelectRenderable } from "../renderables/Select.js"
import { TabSelectRenderable } from "../renderables/TabSelect.js"
import { TextRenderable } from "../renderables/Text.js"
import { TextareaRenderable } from "../renderables/Textarea.js"
import { CliRenderEvents } from "../renderer.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"

let renderer: TestRenderer
let renderOnce: () => Promise<void>

beforeEach(async () => {
  ;({ renderer, renderOnce } = await createTestRenderer({ width: 40, height: 12 }))
})

afterEach(() => {
  renderer?.destroy()
})

function getNode(id: string) {
  const snapshot = renderer.getAccessibilitySnapshot()
  const node = snapshot.nodes.find((node) => node.id === id)
  if (!node) {
    throw new Error(`Accessibility node not found: ${id}`)
  }
  return node
}

describe("accessibility snapshots", () => {
  test("includes explicit accessibility metadata", () => {
    const panel = new BoxRenderable(renderer, {
      id: "panel",
      width: 20,
      height: 4,
      accessibilityRole: "region",
      accessibilityLabel: "Build output",
      accessibilityDescription: "Latest compiler output",
      accessibilityValue: "No errors",
      accessibilityLive: "polite",
      accessibilityState: { busy: false },
    })

    renderer.root.add(panel)

    const node = getNode("panel")
    expect(node).toMatchObject({
      id: "panel",
      parentId: "__root__",
      role: "region",
      label: "Build output",
      description: "Latest compiler output",
      value: "No errors",
      live: "polite",
      state: { busy: false },
    })
  })

  test("preserves tree order and omits accessibility-hidden subtrees", () => {
    const visibleParent = new BoxRenderable(renderer, {
      id: "visible-parent",
      width: 20,
      height: 4,
      accessibilityRole: "region",
    })
    const visibleChild = new BoxRenderable(renderer, {
      id: "visible-child",
      width: 10,
      height: 2,
      accessibilityRole: "button",
      accessibilityLabel: "Run",
    })
    const hiddenParent = new BoxRenderable(renderer, {
      id: "hidden-parent",
      width: 20,
      height: 4,
      accessibilityHidden: true,
    })
    const hiddenChild = new BoxRenderable(renderer, {
      id: "hidden-child",
      width: 10,
      height: 2,
      accessibilityRole: "button",
      accessibilityLabel: "Hidden Run",
    })

    visibleParent.add(visibleChild)
    hiddenParent.add(hiddenChild)
    renderer.root.add(visibleParent)
    renderer.root.add(hiddenParent)

    const snapshot = renderer.getAccessibilitySnapshot()
    expect(snapshot.nodes.map((node) => node.id)).toEqual(["__root__", "visible-parent", "visible-child"])
    expect(getNode("visible-parent").children).toEqual(["visible-child"])
  })

  test("reports focused accessibility node", () => {
    const button = new BoxRenderable(renderer, {
      id: "run-button",
      width: 10,
      height: 1,
      focusable: true,
      accessibilityRole: "button",
      accessibilityLabel: "Run build",
    })

    renderer.root.add(button)
    button.focus()

    expect(renderer.getAccessibilitySnapshot().focusedId).toBe("run-button")
    expect(renderer.getFocusedAccessibilityNode()).toMatchObject({
      id: "run-button",
      role: "button",
      label: "Run build",
      state: { focused: true, focusable: true },
    })
  })

  test("captures layout bounds after render", async () => {
    const panel = new BoxRenderable(renderer, {
      id: "positioned-panel",
      width: 12,
      height: 3,
      marginLeft: 4,
      marginTop: 2,
      accessibilityRole: "region",
    })

    renderer.root.add(panel)
    await renderOnce()

    expect(getNode("positioned-panel").bounds).toEqual({
      x: 4,
      y: 2,
      width: 12,
      height: 3,
    })
  })

  test("assigns default roles and values for built-in renderables", () => {
    const text = new TextRenderable(renderer, {
      id: "message",
      content: "Hello world",
    })
    const input = new InputRenderable(renderer, {
      id: "search",
      value: "query",
      width: 20,
    })
    const textarea = new TextareaRenderable(renderer, {
      id: "notes",
      initialValue: "line one\nline two",
      width: 20,
      height: 3,
    })
    const select = new SelectRenderable(renderer, {
      id: "files",
      width: 20,
      height: 3,
      selectedIndex: 1,
      options: [
        { name: "README.md", description: "Docs" },
        { name: "package.json", description: "Manifest" },
      ],
    })
    const tabs = new TabSelectRenderable(renderer, {
      id: "sections",
      width: 30,
      options: [
        { name: "Code", description: "Code view" },
        { name: "Preview", description: "Preview view" },
      ],
    })
    tabs.setSelectedIndex(1)
    const scrollbox = new ScrollBoxRenderable(renderer, {
      id: "results",
      width: 20,
      height: 4,
    })
    const ascii = new ASCIIFontRenderable(renderer, {
      id: "banner",
      text: "OK",
    })

    renderer.root.add(text)
    renderer.root.add(input)
    renderer.root.add(textarea)
    renderer.root.add(select)
    renderer.root.add(tabs)
    renderer.root.add(scrollbox)
    renderer.root.add(ascii)

    expect(getNode("message")).toMatchObject({ role: "text", value: "Hello world" })
    expect(getNode("search")).toMatchObject({ role: "textbox", value: "query", state: { multiline: false } })
    expect(getNode("notes")).toMatchObject({ role: "textbox", value: "line one\nline two", state: { multiline: true } })
    expect(getNode("files")).toMatchObject({
      role: "listbox",
      value: "package.json",
      state: { selectedIndex: 1, optionCount: 2 },
    })
    expect(getNode("sections")).toMatchObject({
      role: "tablist",
      value: "Preview",
      state: { selectedIndex: 1, optionCount: 2 },
    })
    expect(getNode("results")).toMatchObject({ role: "region" })
    expect(getNode("banner")).toMatchObject({ role: "text", value: "OK" })
  })

  test("keeps explicit accessibility metadata ahead of built-in defaults", () => {
    const text = new TextRenderable(renderer, {
      id: "custom-text",
      content: "Visible text",
      accessibilityRole: "status",
      accessibilityValue: "Custom status value",
    })
    const input = new InputRenderable(renderer, {
      id: "custom-input",
      value: "actual value",
      accessibilityValue: "redacted value",
      width: 20,
    })

    renderer.root.add(text)
    renderer.root.add(input)

    expect(getNode("custom-text")).toMatchObject({ role: "status", value: "Custom status value" })
    expect(getNode("custom-input")).toMatchObject({ role: "textbox", value: "redacted value" })
  })

  test("reports updated dynamic values for input and selection controls", () => {
    const input = new InputRenderable(renderer, {
      id: "dynamic-input",
      value: "initial",
      width: 20,
    })
    const select = new SelectRenderable(renderer, {
      id: "dynamic-select",
      width: 20,
      height: 3,
      options: [
        { name: "First", description: "First item" },
        { name: "Second", description: "Second item" },
      ],
    })

    renderer.root.add(input)
    renderer.root.add(select)

    input.value = "updated"
    select.setSelectedIndex(1)

    expect(getNode("dynamic-input")).toMatchObject({ value: "updated" })
    expect(getNode("dynamic-select")).toMatchObject({ value: "Second", state: { selectedIndex: 1 } })
  })

  test("emits accessibility focus events", () => {
    const emitted: unknown[] = []
    renderer.on(CliRenderEvents.ACCESSIBILITY, (event) => emitted.push(event))

    const button = new BoxRenderable(renderer, {
      id: "focus-button",
      width: 10,
      height: 1,
      focusable: true,
      accessibilityRole: "button",
      accessibilityLabel: "Focus me",
    })

    renderer.root.add(button)
    button.focus()

    expect(renderer.getAccessibilityEvents()).toContainEqual({
      type: "focus",
      nodeId: "focus-button",
      previousNodeId: null,
      node: expect.objectContaining({ id: "focus-button", role: "button", label: "Focus me" }),
    })
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: "focus",
        nodeId: "focus-button",
        previousNodeId: null,
      }),
    )
  })

  test("emits live announcement events", () => {
    renderer.announce("Build complete", { politeness: "assertive", nodeId: "status" })
    renderer.announce("Ignored", { politeness: "off" })

    expect(renderer.getAccessibilityEvents()).toEqual([
      {
        type: "live",
        nodeId: "status",
        politeness: "assertive",
        text: "Build complete",
      },
    ])
  })

  test("emits accessibility value events for dynamic controls", () => {
    const input = new InputRenderable(renderer, {
      id: "event-input",
      value: "initial",
      width: 20,
    })
    const select = new SelectRenderable(renderer, {
      id: "event-select",
      width: 20,
      height: 3,
      options: [
        { name: "First", description: "First item" },
        { name: "Second", description: "Second item" },
      ],
    })

    renderer.root.add(input)
    renderer.root.add(select)
    renderer.clearAccessibilityEvents()

    input.value = "updated"
    select.setSelectedIndex(1)

    expect(renderer.getAccessibilityEvents()).toEqual([
      expect.objectContaining({
        type: "value",
        nodeId: "event-input",
        value: "updated",
      }),
      expect.objectContaining({
        type: "value",
        nodeId: "event-select",
        value: "Second",
      }),
    ])
  })

  test("handles accessibility focus and setValue actions", () => {
    const input = new InputRenderable(renderer, {
      id: "action-input",
      value: "initial",
      width: 20,
    })

    renderer.root.add(input)

    renderer.handleAccessibilityAction({ type: "focus", nodeId: "action-input" })
    renderer.handleAccessibilityAction({ type: "setValue", nodeId: "action-input", value: "updated" })

    expect(input.focused).toBe(true)
    expect(input.value).toBe("updated")
    expect(getNode("action-input")).toMatchObject({ value: "updated" })
  })

  test("handles accessibility activate actions for select controls", () => {
    const select = new SelectRenderable(renderer, {
      id: "action-select",
      width: 20,
      height: 3,
      options: [
        { name: "First", description: "First item" },
        { name: "Second", description: "Second item" },
      ],
    })
    const selected: string[] = []
    select.on("itemSelected", (_index, option) => selected.push(option.name))

    renderer.root.add(select)
    select.setSelectedIndex(1)
    renderer.handleAccessibilityAction({ type: "activate", nodeId: "action-select" })

    expect(selected).toEqual(["Second"])
  })
})
