import { render } from "@opentui/solid"
import { createSignal } from "solid-js"

function App() {
  const [selected, setSelected] = createSignal("worktree")
  const [lastAction, setLastAction] = createSignal("Click a session below")

  const selectSession = (name: string) => {
    setSelected(name)
    setLastAction(`Opened ${name}`)
  }

  return (
    <box flexDirection="column" padding={1} gap={1}>
      <text fg="#7dd3fc">Session sidebar</text>
      <text>Current session: {selected()}</text>

      <box border borderStyle="rounded" flexShrink={0} height={6} width={32} overflow="hidden">
        <box flexDirection="column">
          <box flexDirection="row" paddingLeft={1}>
            <text fg="#94a3b8">Recent sessions</text>
          </box>
          <box flexDirection="column" paddingLeft={1}>
            <box flexDirection="row" flexShrink={0} onMouseDown={() => selectSession("worktree")}>
              <text>{selected() === "worktree" ? "> " : "  "}worktree</text>
            </box>
            <box flexDirection="row" flexShrink={0} onMouseDown={() => selectSession("release-check")}>
              <text>{selected() === "release-check" ? "> " : "  "}release-check</text>
            </box>
            <box flexDirection="row" flexShrink={0} onMouseDown={() => selectSession("bug-1231")}>
              <text>{selected() === "bug-1231" ? "> " : "  "}bug-1231</text>
            </box>
          </box>
        </box>
      </box>

      <text>Last action: {lastAction()}</text>
      <text fg="#94a3b8">The first two sessions respond. The visible bottom session does not. Ctrl+C exits.</text>
    </box>
  )
}

render(App)
