import { spawn } from "node:child_process"

import type { AccessibilityEvent } from "@opentui/core"
import type { AccessibilityIpcSession } from "../index.js"
import { formatAccessibilityEvent, type AccessibilityAdapter } from "./types.js"

export interface CommandSpeechAdapterOptions {
  name: string
  command: string
  args: (text: string) => string[]
  enabled?: boolean
}

export class CommandSpeechAdapter implements AccessibilityAdapter {
  public readonly name: string
  private queue: string[] = []
  private speaking = false

  constructor(private readonly options: CommandSpeechAdapterOptions) {
    this.name = options.name
  }

  public async handleEvent(session: AccessibilityIpcSession, event: AccessibilityEvent): Promise<void> {
    if (this.options.enabled === false) return
    const text = formatAccessibilityEvent(session, event)
    if (!text) return

    if (event.type === "live" && event.politeness === "assertive") {
      this.queue = []
    }

    this.queue.push(text)
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.speaking) return
    this.speaking = true
    try {
      while (this.queue.length > 0) {
        const text = this.queue.shift()
        if (!text) continue
        await this.speak(text)
      }
    } finally {
      this.speaking = false
    }
  }

  private speak(text: string): Promise<void> {
    return new Promise((resolve) => {
      const child = spawn(this.options.command, this.options.args(text), { stdio: "ignore" })
      child.on("error", () => resolve())
      child.on("close", () => resolve())
    })
  }
}

export function createMacOsSpeechAdapter(): CommandSpeechAdapter {
  return new CommandSpeechAdapter({
    name: "macos-say",
    command: "say",
    args: (text) => [text],
  })
}

export function createLinuxSpeechAdapter(): CommandSpeechAdapter {
  return new CommandSpeechAdapter({
    name: "linux-spd-say",
    command: "spd-say",
    args: (text) => [text],
  })
}

export function createWindowsSpeechAdapter(): CommandSpeechAdapter {
  return new CommandSpeechAdapter({
    name: "windows-sapi",
    command: "powershell.exe",
    args: (text) => [
      "-NoProfile",
      "-Command",
      `$voice = New-Object -ComObject SAPI.SpVoice; $voice.Speak(${JSON.stringify(text)}) | Out-Null`,
    ],
  })
}

export function createDefaultSpeechAdapter(): CommandSpeechAdapter | null {
  switch (process.platform) {
    case "darwin":
      return createMacOsSpeechAdapter()
    case "linux":
      return createLinuxSpeechAdapter()
    case "win32":
      return createWindowsSpeechAdapter()
    default:
      return null
  }
}
