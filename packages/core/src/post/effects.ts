import type { OptimizedBuffer } from "../buffer"

interface ActiveGlitch {
  y: number
  type: "shift" | "flip" | "color"
  amount: number
}

export class DistortionEffect {
  // --- Configurable Parameters ---
  public glitchChancePerSecond: number = 0.5
  public maxGlitchLines: number = 3
  public minGlitchDuration: number = 0.05
  public maxGlitchDuration: number = 0.2
  public maxShiftAmount: number = 10
  public shiftFlipRatio: number = 0.6
  public colorGlitchChance: number = 0.2

  // --- Internal State ---
  private lastGlitchTime: number = 0
  private glitchDuration: number = 0
  private activeGlitches: ActiveGlitch[] = []

  constructor(options?: Partial<DistortionEffect>) {
    if (options) {
      Object.assign(this, options)
    }
  }

  /**
   * Applies the animated distortion/glitch effect to the buffer.
   */
  public apply(buffer: OptimizedBuffer, deltaTime: number): void {
    const width = buffer.width
    const height = buffer.height
    const buf = buffer.buffers
    // Note: Using internal timer based on deltaTime is more reliable than Date.now()

    // Update glitch timer
    this.lastGlitchTime += deltaTime

    // End current glitch if duration is over
    if (this.activeGlitches.length > 0 && this.lastGlitchTime >= this.glitchDuration) {
      this.activeGlitches = []
      this.glitchDuration = 0
    }

    // Chance to start a new glitch
    if (this.activeGlitches.length === 0 && Math.random() < this.glitchChancePerSecond * deltaTime) {
      this.lastGlitchTime = 0
      this.glitchDuration = this.minGlitchDuration + Math.random() * (this.maxGlitchDuration - this.minGlitchDuration)
      const numGlitches = 1 + Math.floor(Math.random() * this.maxGlitchLines)

      for (let i = 0; i < numGlitches; i++) {
        const y = Math.floor(Math.random() * height)
        let type: ActiveGlitch["type"]
        let amount = 0

        const typeRoll = Math.random()
        if (typeRoll < this.colorGlitchChance) {
          type = "color"
        } else {
          // Determine shift or flip based on remaining probability
          const shiftRoll = (typeRoll - this.colorGlitchChance) / (1 - this.colorGlitchChance)
          if (shiftRoll < this.shiftFlipRatio) {
            type = "shift"
            amount = Math.floor((Math.random() - 0.5) * 2 * this.maxShiftAmount)
          } else {
            type = "flip"
          }
        }

        // Avoid glitching the same line twice in one burst
        if (!this.activeGlitches.some((g) => g.y === y)) {
          this.activeGlitches.push({ y, type, amount })
        }
      }
    }

    // Apply active glitches
    if (this.activeGlitches.length > 0) {
      // Create temporary arrays lazily if needed (minor optimization for shift/flip)
      let tempChar: Uint32Array | null = null
      let tempFg: Float32Array | null = null
      let tempBg: Float32Array | null = null
      let tempAttr: Uint8Array | null = null

      for (const glitch of this.activeGlitches) {
        const y = glitch.y
        // Ensure y is within bounds (safer)
        if (y < 0 || y >= height) continue
        const baseIndex = y * width

        if (glitch.type === "shift" || glitch.type === "flip") {
          // Lazily create temp buffers only when needed for shift/flip
          if (!tempChar) {
            tempChar = new Uint32Array(width)
            tempFg = new Float32Array(width * 4)
            tempBg = new Float32Array(width * 4)
            tempAttr = new Uint8Array(width)
          }

          // 1. Copy original row data to temp buffers
          try {
            tempChar.set(buf.char.subarray(baseIndex, baseIndex + width))
            tempFg!.set(buf.fg.subarray(baseIndex * 4, (baseIndex + width) * 4))
            tempBg!.set(buf.bg.subarray(baseIndex * 4, (baseIndex + width) * 4))
            tempAttr!.set(buf.attributes.subarray(baseIndex, baseIndex + width))
          } catch (e) {
            // Handle potential range errors if buffer size changes unexpectedly
            console.error(`Error copying row ${y} for distortion:`, e)
            continue
          }

          if (glitch.type === "shift") {
            const shift = glitch.amount
            for (let x = 0; x < width; x++) {
              const srcX = (x - shift + width) % width // Wrap around shift
              const destIndex = baseIndex + x
              const srcTempIndex = srcX

              buf.char[destIndex] = tempChar[srcTempIndex]
              buf.attributes[destIndex] = tempAttr![srcTempIndex]

              const destColorIndex = destIndex * 4
              const srcTempColorIndex = srcTempIndex * 4

              buf.fg.set(tempFg!.subarray(srcTempColorIndex, srcTempColorIndex + 4), destColorIndex)
              buf.bg.set(tempBg!.subarray(srcTempColorIndex, srcTempColorIndex + 4), destColorIndex)
            }
          } else {
            // type === 'flip'
            for (let x = 0; x < width; x++) {
              const srcX = width - 1 - x // Flipped index
              const destIndex = baseIndex + x
              const srcTempIndex = srcX

              buf.char[destIndex] = tempChar[srcTempIndex]
              buf.attributes[destIndex] = tempAttr![srcTempIndex]

              const destColorIndex = destIndex * 4
              const srcTempColorIndex = srcTempIndex * 4

              buf.fg.set(tempFg!.subarray(srcTempColorIndex, srcTempColorIndex + 4), destColorIndex)
              buf.bg.set(tempBg!.subarray(srcTempColorIndex, srcTempColorIndex + 4), destColorIndex)
            }
          }
        } else if (glitch.type === "color") {
          const glitchStart = Math.floor(Math.random() * width)
          // Make glitch length at least 1 pixel, up to the rest of the line
          const maxPossibleLength = width - glitchStart
          // Introduce more variability: sometimes short, sometimes long, but not always full width
          let glitchLength = Math.floor(Math.random() * maxPossibleLength) + 1
          if (Math.random() < 0.2) {
            // 20% chance of a shorter, more intense glitch segment
            glitchLength = Math.floor(Math.random() * (width / 4)) + 1
          }
          glitchLength = Math.min(glitchLength, maxPossibleLength)

          for (let x = glitchStart; x < glitchStart + glitchLength; x++) {
            if (x >= width) break // Boundary check

            const destIndex = baseIndex + x
            const destColorIndex = destIndex * 4

            let rFg, gFg, bFg, rBg, gBg, bBg

            // More varied and "glitchy" colors
            const colorMode = Math.random()
            if (colorMode < 0.33) {
              // Pure random
              rFg = Math.random()
              gFg = Math.random()
              bFg = Math.random()
              rBg = Math.random()
              gBg = Math.random()
              bBg = Math.random()
            } else if (colorMode < 0.66) {
              // Single channel emphasis or block color
              const emphasis = Math.random()
              if (emphasis < 0.25) {
                rFg = Math.random()
                gFg = 0
                bFg = 0
              } // Red
              else if (emphasis < 0.5) {
                rFg = 0
                gFg = Math.random()
                bFg = 0
              } // Green
              else if (emphasis < 0.75) {
                rFg = 0
                gFg = 0
                bFg = Math.random()
              } // Blue
              else {
                // Bright glitch color
                const glitchColorRoll = Math.random()
                if (glitchColorRoll < 0.33) {
                  rFg = 1
                  gFg = 0
                  bFg = 1
                } // Magenta
                else if (glitchColorRoll < 0.66) {
                  rFg = 0
                  gFg = 1
                  bFg = 1
                } // Cyan
                else {
                  rFg = 1
                  gFg = 1
                  bFg = 0
                } // Yellow
              }
              // Background can be inverted or similar to FG
              if (Math.random() < 0.5) {
                rBg = 1 - rFg
                gBg = 1 - gFg
                bBg = 1 - bFg
              } else {
                rBg = rFg * (Math.random() * 0.5 + 0.2) // Darker shade of fg
                gBg = gFg * (Math.random() * 0.5 + 0.2)
                bBg = bFg * (Math.random() * 0.5 + 0.2)
              }
            } else {
              // Inverted or high contrast
              rFg = Math.random() > 0.5 ? 1 : 0
              gFg = Math.random() > 0.5 ? 1 : 0
              bFg = Math.random() > 0.5 ? 1 : 0
              rBg = 1 - rFg
              gBg = 1 - gFg
              bBg = 1 - bFg
            }

            buf.fg[destColorIndex] = rFg
            buf.fg[destColorIndex + 1] = gFg
            buf.fg[destColorIndex + 2] = bFg
            // Keep alpha buf.fg[destColorIndex + 3]

            buf.bg[destColorIndex] = rBg
            buf.bg[destColorIndex + 1] = gBg
            buf.bg[destColorIndex + 2] = bBg
            // Keep alpha buf.bg[destColorIndex + 3]
          }
        }
      }
    }
  }
}

/**
 * Applies a vignette effect by darkening the corners, optimized with precomputation.
 * Uses native colorMatrix with a zero matrix for attenuation.
 */
export class VignetteEffect {
  private _strength: number
  // Stores packed cell masks [x, y, attenuation] per pixel
  private precomputedAttenuationCellMask: Float32Array | null = null
  private cachedWidth: number = -1
  private cachedHeight: number = -1
  // Zero matrix for attenuation (maps everything toward black based on strength)
  private static zeroMatrix = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])

  constructor(strength: number = 0.5) {
    this._strength = strength
  }

  public set strength(newStrength: number) {
    this._strength = Math.max(0, newStrength) // Ensure strength is non-negative
    // Invalidate cached cell masks when strength changes
    this.cachedWidth = -1
    this.cachedHeight = -1
    this.precomputedAttenuationCellMask = null
  }

  public get strength(): number {
    return this._strength
  }

  private _computeFactors(width: number, height: number): void {
    this.precomputedAttenuationCellMask = new Float32Array(width * height * 3)
    const centerX = width / 2
    const centerY = height / 2
    const maxDistSq = centerX * centerX + centerY * centerY
    const safeMaxDistSq = maxDistSq === 0 ? 1 : maxDistSq // Avoid division by zero
    const strength = this._strength
    let i = 0

    for (let y = 0; y < height; y++) {
      const dy = y - centerY
      const dySq = dy * dy
      for (let x = 0; x < width; x++) {
        const dx = x - centerX
        const distSq = dx * dx + dySq
        // Calculate base attenuation (0 to 1 based on distance)
        const baseAttenuation = Math.min(1, distSq / safeMaxDistSq)
        // Precompute final attenuation value including strength
        const attenuation = baseAttenuation * strength
        this.precomputedAttenuationCellMask[i++] = x
        this.precomputedAttenuationCellMask[i++] = y
        this.precomputedAttenuationCellMask[i++] = attenuation
      }
    }
    this.cachedWidth = width
    this.cachedHeight = height
  }

  /**
   * Applies the vignette effect using native colorMatrix with a zero matrix.
   * The zero matrix maps all colors to black, and the attenuation cell masks
   * control how much of the effect is applied (strength-based blending).
   */
  public apply(buffer: OptimizedBuffer): void {
    const width = buffer.width
    const height = buffer.height

    // Recompute attenuation cell masks if dimensions changed, strength changed,
    // or factors haven't been computed yet
    if (width !== this.cachedWidth || height !== this.cachedHeight || !this.precomputedAttenuationCellMask) {
      this._computeFactors(width, height)
    }

    // Use colorMatrix with zero matrix to apply attenuation
    // colorMatrix blends: result = original + (transformed - original) × strength
    // With zero matrix: transformed = 0
    // Result = original + (0 - original) × attenuation = original × (1 - attenuation)
    buffer.colorMatrix(VignetteEffect.zeroMatrix, this.precomputedAttenuationCellMask!, 1.0, 3)
  }
}
