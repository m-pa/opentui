import type { Attributes, EventData } from "../../types.js"

export function mergeRequirement(target: EventData, name: string, value: unknown, source: string): void {
  if (Object.prototype.hasOwnProperty.call(target, name) && !Object.is(target[name], value)) {
    throw new Error(`Conflicting keymap requirement for "${name}" from ${source}`)
  }

  target[name] = value
}

export function mergeAttribute(target: Attributes, name: string, value: unknown, source: string): void {
  if (Object.prototype.hasOwnProperty.call(target, name) && !Object.is(target[name], value)) {
    throw new Error(`Conflicting keymap attribute for "${name}" from ${source}`)
  }

  target[name] = value
}
