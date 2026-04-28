import type { BindingInput, Bindings, KeymapEvent, ParsedBindingInput } from "../../types.js"
import { cloneKeySequence } from "../keys.js"

export function normalizeBindingInputs<TTarget extends object, TEvent extends KeymapEvent>(
  bindings: Bindings<TTarget, TEvent>,
): BindingInput<TTarget, TEvent>[] {
  if (Array.isArray(bindings)) {
    return bindings
  }

  const normalized: BindingInput<TTarget, TEvent>[] = []
  for (const [key, cmd] of Object.entries(bindings)) {
    if (typeof cmd !== "string" && typeof cmd !== "function") {
      throw new Error(`Invalid keymap binding for "${key}": shorthand bindings must map to string or function commands`)
    }

    normalized.push({ key, cmd })
  }

  return normalized
}

export function snapshotBindingInputs<TTarget extends object, TEvent extends KeymapEvent>(
  bindings: Bindings<TTarget, TEvent>,
): BindingInput<TTarget, TEvent>[] {
  return normalizeBindingInputs(bindings).map((binding) => ({
    ...binding,
    key: typeof binding.key === "string" ? binding.key : { ...binding.key },
  }))
}

export function snapshotParsedBindingInput<TTarget extends object, TEvent extends KeymapEvent>(
  binding: ParsedBindingInput<TTarget, TEvent>,
): ParsedBindingInput<TTarget, TEvent> {
  return {
    ...binding,
    sequence: cloneKeySequence(binding.sequence),
  }
}
