import { Buffer } from "node:buffer"
import { StdinParser, type StdinEvent } from "../src/lib/stdin-parser.js"

const parser = new StdinParser({ armTimeouts: false })
const prefixEvents: StdinEvent[] = []
const continuationEvents: StdinEvent[] = []

try {
  parser.push(Buffer.from("\x1b["))
  parser.flushTimeout(Number.MAX_SAFE_INTEGER)
  parser.drain((event) => prefixEvents.push(event))

  parser.push(Buffer.from("<65;68;29M"))
  parser.drain((event) => continuationEvents.push(event))
} finally {
  parser.destroy()
}

console.log("Events after timing out ESC[:")
console.dir(prefixEvents, { depth: null })
console.log("Events after the delayed continuation:")
console.dir(continuationEvents, { depth: null })

const leakedText = continuationEvents
  .filter((event) => event.type === "key")
  .map((event) => event.raw)
  .join("")

if (leakedText === "<65;68;29M") {
  throw new Error("Reproduced: the delayed SGR mouse continuation leaked as keyboard input")
}

const recoveredMouse = continuationEvents.find(
  (event) => event.type === "mouse" && event.encoding === "sgr" && event.raw === "\x1b[<65;68;29M",
)

if (!recoveredMouse) {
  throw new Error("Unexpected result: the continuation was neither leaked text nor a recovered SGR mouse event")
}

console.log("Not reproduced: the delayed continuation was recovered as an SGR mouse event")
