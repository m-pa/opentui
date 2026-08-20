import { testRender } from "@opentui/solid"

const clicks: string[] = []

function Row(p: { label: string }) {
  return (
    <box flexDirection="column" flexShrink={0} onMouseDown={() => clicks.push(p.label)}>
      <box flexDirection="row">
        <text>{p.label}</text>
      </box>
    </box>
  )
}

function App() {
  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexGrow={1} />
      {/* overflow="hidden" is the trigger: remove it and row3 becomes clickable */}
      <box border borderStyle="rounded" flexShrink={0} height={6} overflow="hidden">
        <box flexDirection="column">
          <box flexDirection="row" paddingLeft={1} onMouseDown={() => clicks.push("name")}>
            <text>session-name</text>
          </box>
          <box flexDirection="column" paddingLeft={1}>
            <Row label="row1" />
            <Row label="row2" />
            <Row label="row3" />
          </box>
        </box>
      </box>
      <box flexGrow={1} />
    </box>
  )
}

const { renderOnce, captureCharFrame, mockMouse, mockInput } = await testRender(() => <App />, {
  width: 30,
  height: 14,
})

await renderOnce()
captureCharFrame()
  .split("\n")
  .forEach((l, i) => console.log(i, JSON.stringify(l.slice(0, 24))))

for (let y = 0; y < 12; y++) {
  clicks.length = 0
  await mockMouse.click(5, y)
  await renderOnce()
  console.log(`click y=${y} -> ${clicks.length ? clicks.join(",") : "(nothing)"}`)
}

// Same result through the real stdin path (raw SGR, 1-based coords):
for (const [label, sgrY] of [
  ["name", 6],
  ["row1", 7],
  ["row2", 8],
  ["row3", 9],
] as const) {
  clicks.length = 0
  mockInput.pressKey(`\x1b[<0;6;${sgrY}M`)
  mockInput.pressKey(`\x1b[<0;6;${sgrY}m`)
  await renderOnce()
  console.log(`SGR y=${sgrY} (${label}) -> ${clicks.length ? clicks.join(",") : "(nothing)"}`)
}
process.exit(0)
