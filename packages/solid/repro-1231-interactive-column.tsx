import { render } from "@opentui/solid"
import { createSignal } from "solid-js"

function App() {
  const [lastAction, setLastAction] = createSignal("Click the session name or its X button")

  return (
    <box flexDirection="column" padding={1} gap={1}>
      <text fg="#7dd3fc">Session header</text>

      <box border borderStyle="rounded" flexShrink={0} width={32} height={4} paddingBottom={1} overflow="hidden">
        <box flexDirection="row">
          <box flexGrow={1} onMouseDown={() => setLastAction("Selected bug-1231")}>
            <text> bug-1231</text>
          </box>
          <box width={1} flexShrink={0} onMouseDown={() => setLastAction("Closed bug-1231")}>
            <text>X</text>
          </box>
        </box>
      </box>

      <text>Last action: {lastAction()}</text>
      <text fg="#94a3b8">The session name responds. The visible X in the last column does not. Ctrl+C exits.</text>
    </box>
  )
}

render(App)
