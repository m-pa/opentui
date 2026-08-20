import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot, useKeyboard } from "../../react/src/index.js"
import { createCliRenderer } from "../src/index.js"

const queryClient = new QueryClient()

function App() {
  useKeyboard((key) => {
    if (key.name === "`") {
      renderer.console.toggle()
    }
  })

  return (
    <QueryClientProvider client={queryClient}>
      <scrollbox>
        {Array.from({ length: 50 }).map((_, i) => (
          <box key={i} border borderStyle="rounded">
            <text>{i}</text>
          </box>
        ))}
      </scrollbox>
    </QueryClientProvider>
  )
}

const renderer = await createCliRenderer()
createRoot(renderer).render(<App />)
