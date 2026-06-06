import type { Renderable } from "../Renderable.js"
import type { AccessibilityNode, AccessibilityRole, AccessibilitySnapshot } from "./types.js"

function getRole(renderable: Renderable): AccessibilityRole {
  if (renderable.id === "__root__") {
    return renderable.accessibilityRole ?? "application"
  }

  return renderable.accessibilityRole ?? "generic"
}

function getNode(renderable: Renderable, parentId: string | null): AccessibilityNode {
  const state = {
    ...renderable.accessibilityState,
    focused: renderable.focused || undefined,
    focusable: renderable.focusable || undefined,
    hidden: renderable.accessibilityHidden || undefined,
  }

  return {
    id: renderable.id,
    parentId,
    role: getRole(renderable),
    label: renderable.accessibilityLabel,
    description: renderable.accessibilityDescription,
    value: renderable.accessibilityValue,
    live: renderable.accessibilityLive,
    bounds: {
      x: renderable.screenX,
      y: renderable.screenY,
      width: renderable.width,
      height: renderable.height,
    },
    state,
    children: [],
  }
}

export function buildAccessibilitySnapshot(
  root: Renderable,
  focusedRenderable: Renderable | null = null,
): AccessibilitySnapshot {
  const nodes: AccessibilityNode[] = []
  const includedIds = new Set<string>()

  const visit = (renderable: Renderable, parentNode: AccessibilityNode | null): void => {
    if (!renderable.visible || renderable.isDestroyed || renderable.accessibilityHidden) {
      return
    }

    const node = getNode(renderable, parentNode?.id ?? null)
    nodes.push(node)
    includedIds.add(node.id)
    parentNode?.children.push(node.id)

    for (const child of renderable.getChildren()) {
      visit(child, node)
    }
  }

  visit(root, null)

  const focusedId = focusedRenderable && includedIds.has(focusedRenderable.id) ? focusedRenderable.id : null

  return {
    rootId: root.id,
    focusedId,
    nodes,
  }
}
