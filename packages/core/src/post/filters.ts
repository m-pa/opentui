import type { OptimizedBuffer } from "../buffer"

// Re-export effects from effects.ts
export { DistortionEffect, VignetteEffect } from "./effects"

/**
 * Applies a scanline effect by darkening every nth row.
 */
export function applyScanlines(buffer: OptimizedBuffer, strength: number = 0.8, step: number = 2): void {
  const width = buffer.width
  const height = buffer.height
  const bg = buffer.buffers.bg

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x++) {
      const colorIndex = (y * width + x) * 4
      bg[colorIndex] *= strength // R
      bg[colorIndex + 1] *= strength // G
      bg[colorIndex + 2] *= strength // B
      // Keep Alpha the same
    }
  }
}

/**
 * Inverts the colors in the buffer.
 */
export function applyInvert(buffer: OptimizedBuffer): void {
  const size = buffer.width * buffer.height
  const fg = buffer.buffers.fg
  const bg = buffer.buffers.bg

  for (let i = 0; i < size; i++) {
    const colorIndex = i * 4
    fg[colorIndex] = 1.0 - fg[colorIndex]
    fg[colorIndex + 1] = 1.0 - fg[colorIndex + 1]
    fg[colorIndex + 2] = 1.0 - fg[colorIndex + 2]

    bg[colorIndex] = 1.0 - bg[colorIndex]
    bg[colorIndex + 1] = 1.0 - bg[colorIndex + 1]
    bg[colorIndex + 2] = 1.0 - bg[colorIndex + 2]
  }
}

/**
 * Adds random noise to the buffer colors.
 */
export function applyNoise(buffer: OptimizedBuffer, strength: number = 0.1): void {
  const size = buffer.width * buffer.height
  const fg = buffer.buffers.fg
  const bg = buffer.buffers.bg

  for (let i = 0; i < size; i++) {
    const colorIndex = i * 4
    const noise = (Math.random() - 0.5) * strength

    fg[colorIndex] = Math.max(0, Math.min(1, fg[colorIndex] + noise))
    fg[colorIndex + 1] = Math.max(0, Math.min(1, fg[colorIndex + 1] + noise))
    fg[colorIndex + 2] = Math.max(0, Math.min(1, fg[colorIndex + 2] + noise))

    bg[colorIndex] = Math.max(0, Math.min(1, bg[colorIndex] + noise))
    bg[colorIndex + 1] = Math.max(0, Math.min(1, bg[colorIndex + 1] + noise))
    bg[colorIndex + 2] = Math.max(0, Math.min(1, bg[colorIndex + 2] + noise))
  }
}

/**
 * Applies a simplified chromatic aberration effect.
 */
export function applyChromaticAberration(buffer: OptimizedBuffer, strength: number = 1): void {
  const width = buffer.width
  const height = buffer.height
  const srcFg = Float32Array.from(buffer.buffers.fg) // Copy original fg data
  const destFg = buffer.buffers.fg
  const centerX = width / 2
  const centerY = height / 2

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - centerX
      const dy = y - centerY
      const offset = Math.round((Math.sqrt(dx * dx + dy * dy) / Math.max(centerX, centerY)) * strength)

      const rX = Math.max(0, Math.min(width - 1, x - offset))
      const bX = Math.max(0, Math.min(width - 1, x + offset))

      const rIndex = (y * width + rX) * 4
      const gIndex = (y * width + x) * 4 // Green from original position
      const bIndex = (y * width + bX) * 4
      const destIndex = (y * width + x) * 4

      destFg[destIndex] = srcFg[rIndex] // Red from left offset
      destFg[destIndex + 1] = srcFg[gIndex + 1] // Green from center
      destFg[destIndex + 2] = srcFg[bIndex + 2] // Blue from right offset
      // Keep original Alpha
    }
  }
}

/**
 * Converts the buffer to ASCII art based on background brightness.
 */
export function applyAsciiArt(buffer: OptimizedBuffer, ramp: string = " .:-=+*#%@"): void {
  const width = buffer.width
  const height = buffer.height
  const chars = buffer.buffers.char
  const bg = buffer.buffers.bg
  const rampLength = ramp.length

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      const colorIndex = index * 4
      const bgR = bg[colorIndex]
      const bgG = bg[colorIndex + 1]
      const bgB = bg[colorIndex + 2]
      const lum = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB // Luminance
      const rampIndex = Math.min(rampLength - 1, Math.floor(lum * rampLength))
      chars[index] = ramp[rampIndex].charCodeAt(0)
    }
  }
}

/**
 * Adjusts the brightness of the buffer using color matrix transformation.
 * Brightness multiplies all RGB channels by the brightness factor with clamping to [0, 1].
 * @param buffer - The buffer to apply the effect to
 * @param brightness - brightness factor: <1.0 darkens, 1.0 unchanged, >1.0 brightens
 * @param triplets - Optional array of [x, y, strength] triplets for selective brightness.
 *                   If not provided, applies uniform brightness to entire buffer.
 */
export function brightness(buffer: OptimizedBuffer, brightness: number = 1.0, triplets?: Float32Array): void {
  // No need to process if brightness is 1 (no change)
  if (brightness === 1.0) return

  const b = Math.max(0, brightness)
  const matrix = new Float32Array([
    b,
    0,
    0, // Row 0 (Red output)
    0,
    b,
    0, // Row 1 (Green output)
    0,
    0,
    b, // Row 2 (Blue output)
  ])

  if (!triplets || triplets.length === 0) {
    buffer.colorMatrixUniform(matrix, 1.0)
  } else {
    const tripletCount = Math.floor(triplets.length / 3)
    buffer.colorMatrix(matrix, triplets, 1.0)
  }
}

/**
 * Adjusts the gain of the buffer using color matrix transformation.
 * Gain multiplies all RGB channels by the gain factor (no clamping).
 * @param buffer - The buffer to apply the effect to
 * @param gain - gain factor: <1.0 reduces, 1.0 unchanged, >1.0 amplifies
 * @param triplets - Optional array of [x, y, strength] triplets for selective gain.
 *                   If not provided, applies uniform gain to entire buffer.
 */
export function gain(buffer: OptimizedBuffer, gain: number = 1.0, triplets?: Float32Array): void {
  // No need to process if gain is 1 (no change)
  if (gain === 1.0) return

  const g = Math.max(0, gain)
  const matrix = new Float32Array([
    g,
    0,
    0, // Row 0 (Red output)
    0,
    g,
    0, // Row 1 (Green output)
    0,
    0,
    g, // Row 2 (Blue output)
  ])

  if (!triplets || triplets.length === 0) {
    buffer.colorMatrixUniform(matrix, 1.0)
  } else {
    const tripletCount = Math.floor(triplets.length / 3)
    buffer.colorMatrix(matrix, triplets, 1.0)
  }
}

/**
 * Generates a saturation color matrix.
 * @param saturation - 0.0 = grayscale, 1.0 = unchanged
 * @returns 3x3 color matrix as Float32Array
 */
function createSaturationMatrix(saturation: number): Float32Array {
  const s = Math.max(0, saturation)
  const sr = 0.299 * (1 - s)
  const sg = 0.587 * (1 - s)
  const sb = 0.114 * (1 - s)

  // Row 0 (Red output)
  const m00 = sr + s // 0.299 + 0.701*s
  const m01 = sg // 0.587 * (1 - s)
  const m02 = sb // 0.114 * (1 - s)

  // Row 1 (Green output)
  const m10 = sr // 0.299 * (1 - s)
  const m11 = sg + s // 0.587 + 0.413*s
  const m12 = sb // 0.114 * (1 - s)

  // Row 2 (Blue output)
  const m20 = sr // 0.299 * (1 - s)
  const m21 = sg // 0.587 * (1 - s)
  const m22 = sb + s // 0.114 + 0.886*s

  return new Float32Array([m00, m01, m02, m10, m11, m12, m20, m21, m22])
}

/**
 * Applies a saturation adjustment to the buffer.
 * @param buffer - The buffer to apply the effect to
 * @param triplets - Optional array of [x, y, strength] triplets for selective saturation.
 *                   If not provided, applies uniform saturation to entire buffer.
 * @param strength - Saturation factor: 0.0 = grayscale, 1.0 = unchanged, >1.0 = oversaturated
 */
export function saturate(buffer: OptimizedBuffer, triplets?: Float32Array, strength: number = 1.0): void {
  // No need to process if saturation is 1 (no change) or strength is 0
  if (strength === 1.0 || strength === 0) {
    return
  }

  const matrix = createSaturationMatrix(strength)

  // If no triplets provided, use uniform saturation (much faster)
  if (!triplets || triplets.length === 0) {
    buffer.colorMatrixUniform(matrix, 1.0)
  } else {
    buffer.colorMatrix(matrix, triplets, 1.0)
  }
}

/**
 * Converts the buffer colors to grayscale using native colorMatrixUniform.
 * Much faster than SaturationEffect as it skips triplet creation and iteration.
 */
export class GrayscaleEffect {
  private _strength: number
  private grayscaleMatrix: Float32Array

  constructor(strength: number = 1.0) {
    this._strength = Math.max(0, Math.min(1, strength))
    this.grayscaleMatrix = this._createGrayscaleMatrix(this._strength)
  }

  private _createGrayscaleMatrix(strength: number): Float32Array {
    // Grayscale matrix: each output channel is the luminance
    const s = strength
    const t = 1 - s // To blend with identity matrix

    // Blend identity with grayscale matrix based on strength
    // For full strength (s=1): pure grayscale
    // For no strength (s=0): identity matrix (no change)

    // m00 = t*1 + s*0.299, m01 = s*0.587, m02 = s*0.114
    // m10 = s*0.299, m11 = t*1 + s*0.587, m12 = s*0.114
    // m20 = s*0.299, m21 = s*0.587, m22 = t*1 + s*0.114

    const m00 = t + s * 0.299
    const m01 = s * 0.587
    const m02 = s * 0.114

    const m10 = s * 0.299
    const m11 = t + s * 0.587
    const m12 = s * 0.114

    const m20 = s * 0.299
    const m21 = s * 0.587
    const m22 = t + s * 0.114

    return new Float32Array([m00, m01, m02, m10, m11, m12, m20, m21, m22])
  }

  public set strength(newStrength: number) {
    this._strength = Math.max(0, Math.min(1, newStrength))
    this.grayscaleMatrix = this._createGrayscaleMatrix(this._strength)
  }

  public get strength(): number {
    return this._strength
  }

  /**
   * Applies the grayscale effect using native colorMatrixUniform.
   */
  public apply(buffer: OptimizedBuffer): void {
    // Skip if no effect
    if (this._strength === 0) {
      return
    }
    buffer.colorMatrixUniform(this.grayscaleMatrix, 1.0)
  }
}

/**
 * Applies a simple box blur. (Expensive and may look bad with text).
 */
export class BlurEffect {
  private _radius: number

  constructor(radius: number = 1) {
    this._radius = Math.max(0, Math.round(radius)) // Radius should be a non-negative integer
  }

  public set radius(newRadius: number) {
    this._radius = Math.max(0, Math.round(newRadius))
  }

  public get radius(): number {
    return this._radius
  }

  /**
   * Applies an optimized separable box blur using a moving average (sliding window).
   */
  public apply(buffer: OptimizedBuffer): void {
    const radius = this._radius
    if (radius <= 0) return // No blur if radius is 0 or less

    const width = buffer.width
    const height = buffer.height
    const buf = buffer.buffers // Get the full buffer object
    const srcFg = buf.fg
    const srcBg = buf.bg
    const destFg = buf.fg // We'll write back to the original buffer
    const destBg = buf.bg
    const chars = buf.char // Get reference to character buffer
    const size = width * height
    const numChannels = 4 // RGBA

    // Temporary buffer for the horizontal pass result
    const tempBufferFg = new Float32Array(size * numChannels)
    const tempBufferBg = new Float32Array(size * numChannels)

    const windowSize = radius * 2 + 1

    // --- Horizontal Pass --- Fg
    for (let y = 0; y < height; y++) {
      let sumR = 0,
        sumG = 0,
        sumB = 0,
        sumA = 0
      const baseRowIndex = y * width

      // Initialize sum for the first window
      for (let x = -radius; x <= radius; x++) {
        const sampleX = Math.max(0, Math.min(width - 1, x))
        const srcIndex = (baseRowIndex + sampleX) * numChannels
        sumR += srcFg[srcIndex]
        sumG += srcFg[srcIndex + 1]
        sumB += srcFg[srcIndex + 2]
        sumA += srcFg[srcIndex + 3]
      }

      // Slide the window across the row
      for (let x = 0; x < width; x++) {
        const destIndex = (baseRowIndex + x) * numChannels
        tempBufferFg[destIndex] = sumR / windowSize
        tempBufferFg[destIndex + 1] = sumG / windowSize
        tempBufferFg[destIndex + 2] = sumB / windowSize
        tempBufferFg[destIndex + 3] = sumA / windowSize

        // Subtract pixel leaving the window (left edge)
        const leavingX = Math.max(0, Math.min(width - 1, x - radius))
        const leavingIndex = (baseRowIndex + leavingX) * numChannels
        sumR -= srcFg[leavingIndex]
        sumG -= srcFg[leavingIndex + 1]
        sumB -= srcFg[leavingIndex + 2]
        sumA -= srcFg[leavingIndex + 3]

        // Add pixel entering the window (right edge)
        const enteringX = Math.max(0, Math.min(width - 1, x + radius + 1))
        const enteringIndex = (baseRowIndex + enteringX) * numChannels
        sumR += srcFg[enteringIndex]
        sumG += srcFg[enteringIndex + 1]
        sumB += srcFg[enteringIndex + 2]
        sumA += srcFg[enteringIndex + 3]
      }
    }

    // --- Horizontal Pass --- Bg
    for (let y = 0; y < height; y++) {
      let sumR = 0,
        sumG = 0,
        sumB = 0,
        sumA = 0
      const baseRowIndex = y * width
      for (let x = -radius; x <= radius; x++) {
        const sampleX = Math.max(0, Math.min(width - 1, x))
        const srcIndex = (baseRowIndex + sampleX) * numChannels
        sumR += srcBg[srcIndex]
        sumG += srcBg[srcIndex + 1]
        sumB += srcBg[srcIndex + 2]
        sumA += srcBg[srcIndex + 3]
      }
      for (let x = 0; x < width; x++) {
        const destIndex = (baseRowIndex + x) * numChannels
        tempBufferBg[destIndex] = sumR / windowSize
        tempBufferBg[destIndex + 1] = sumG / windowSize
        tempBufferBg[destIndex + 2] = sumB / windowSize
        tempBufferBg[destIndex + 3] = sumA / windowSize
        const leavingX = Math.max(0, Math.min(width - 1, x - radius))
        const leavingIndex = (baseRowIndex + leavingX) * numChannels
        sumR -= srcBg[leavingIndex]
        sumG -= srcBg[leavingIndex + 1]
        sumB -= srcBg[leavingIndex + 2]
        sumA -= srcBg[leavingIndex + 3]
        const enteringX = Math.max(0, Math.min(width - 1, x + radius + 1))
        const enteringIndex = (baseRowIndex + enteringX) * numChannels
        sumR += srcBg[enteringIndex]
        sumG += srcBg[enteringIndex + 1]
        sumB += srcBg[enteringIndex + 2]
        sumA += srcBg[enteringIndex + 3]
      }
    }

    // --- Vertical Pass --- Fg
    for (let x = 0; x < width; x++) {
      let sumR = 0,
        sumG = 0,
        sumB = 0,
        sumA = 0

      // Initialize sum for the first window
      for (let y = -radius; y <= radius; y++) {
        const sampleY = Math.max(0, Math.min(height - 1, y))
        const srcIndex = (sampleY * width + x) * numChannels
        sumR += tempBufferFg[srcIndex]
        sumG += tempBufferFg[srcIndex + 1]
        sumB += tempBufferFg[srcIndex + 2]
        sumA += tempBufferFg[srcIndex + 3]
      }

      // Slide the window down the column
      for (let y = 0; y < height; y++) {
        const destIndex = (y * width + x) * numChannels
        destFg[destIndex] = sumR / windowSize
        destFg[destIndex + 1] = sumG / windowSize
        destFg[destIndex + 2] = sumB / windowSize
        destFg[destIndex + 3] = sumA / windowSize

        // Subtract pixel leaving the window (top edge)
        const leavingY = Math.max(0, Math.min(height - 1, y - radius))
        const leavingIndex = (leavingY * width + x) * numChannels
        sumR -= tempBufferFg[leavingIndex]
        sumG -= tempBufferFg[leavingIndex + 1]
        sumB -= tempBufferFg[leavingIndex + 2]
        sumA -= tempBufferFg[leavingIndex + 3]

        // Add pixel entering the window (bottom edge)
        const enteringY = Math.max(0, Math.min(height - 1, y + radius + 1))
        const enteringIndex = (enteringY * width + x) * numChannels
        sumR += tempBufferFg[enteringIndex]
        sumG += tempBufferFg[enteringIndex + 1]
        sumB += tempBufferFg[enteringIndex + 2]
        sumA += tempBufferFg[enteringIndex + 3]
      }
    }

    // --- Vertical Pass --- Bg
    for (let x = 0; x < width; x++) {
      let sumR = 0,
        sumG = 0,
        sumB = 0,
        sumA = 0
      for (let y = -radius; y <= radius; y++) {
        const sampleY = Math.max(0, Math.min(height - 1, y))
        const srcIndex = (sampleY * width + x) * numChannels
        sumR += tempBufferBg[srcIndex]
        sumG += tempBufferBg[srcIndex + 1]
        sumB += tempBufferBg[srcIndex + 2]
        sumA += tempBufferBg[srcIndex + 3]
      }
      for (let y = 0; y < height; y++) {
        const destIndex = (y * width + x) * numChannels
        destBg[destIndex] = sumR / windowSize
        destBg[destIndex + 1] = sumG / windowSize
        destBg[destIndex + 2] = sumB / windowSize
        destBg[destIndex + 3] = sumA / windowSize
        const leavingY = Math.max(0, Math.min(height - 1, y - radius))
        const leavingIndex = (leavingY * width + x) * numChannels
        sumR -= tempBufferBg[leavingIndex]
        sumG -= tempBufferBg[leavingIndex + 1]
        sumB -= tempBufferBg[leavingIndex + 2]
        sumA -= tempBufferBg[leavingIndex + 3]
        const enteringY = Math.max(0, Math.min(height - 1, y + radius + 1))
        const enteringIndex = (enteringY * width + x) * numChannels
        sumR += tempBufferBg[enteringIndex]
        sumG += tempBufferBg[enteringIndex + 1]
        sumB += tempBufferBg[enteringIndex + 2]
        sumA += tempBufferBg[enteringIndex + 3]
      }
    }

    // --- Character Pass (Based on blurred FG Alpha) ---
    const charRamp = [" ", "░", "▒", "▓", " "] // Space, Light, Medium, Dark, Full
    const rampLength = charRamp.length

    for (let i = 0; i < size; i++) {
      const alphaIndex = i * numChannels + 3
      const fgAlpha = destFg[alphaIndex] // Get the final blurred FG alpha

      // Clamp alpha just in case, although blur should keep it in [0, 1]
      const clampedAlpha = Math.max(0, Math.min(1, fgAlpha))

      // Map alpha to character ramp
      // Ensure index doesn't exceed ramp bounds if alpha is exactly 1.0
      const rampIndex = Math.min(rampLength - 1, Math.floor(clampedAlpha * rampLength))

      chars[i] = charRamp[rampIndex].charCodeAt(0)
    }
  }
}

/**
 * Applies a bloom effect based on bright areas (Simplified).
 */
export class BloomEffect {
  private _threshold: number
  private _strength: number
  private _radius: number

  constructor(threshold: number = 0.8, strength: number = 0.2, radius: number = 2) {
    this._threshold = Math.max(0, Math.min(1, threshold))
    this._strength = Math.max(0, strength)
    this._radius = Math.max(0, Math.round(radius))
  }

  public set threshold(newThreshold: number) {
    this._threshold = Math.max(0, Math.min(1, newThreshold))
  }
  public get threshold(): number {
    return this._threshold
  }

  public set strength(newStrength: number) {
    this._strength = Math.max(0, newStrength)
  }
  public get strength(): number {
    return this._strength
  }

  public set radius(newRadius: number) {
    this._radius = Math.max(0, Math.round(newRadius))
  }
  public get radius(): number {
    return this._radius
  }

  public apply(buffer: OptimizedBuffer): void {
    const threshold = this._threshold
    const strength = this._strength
    const radius = this._radius

    if (strength <= 0 || radius <= 0) return // No bloom if strength or radius is non-positive

    const width = buffer.width
    const height = buffer.height
    // Operate directly on the buffer's data for bloom, but need a source copy temporarily
    const srcFg = Float32Array.from(buffer.buffers.fg)
    const srcBg = Float32Array.from(buffer.buffers.bg)
    const destFg = buffer.buffers.fg
    const destBg = buffer.buffers.bg

    const brightPixels: { x: number; y: number; intensity: number }[] = []

    // 1. Find bright pixels based on original data
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = (y * width + x) * 4
        // Consider max component brightness, or luminance? Using luminance.
        const fgLum = 0.299 * srcFg[index] + 0.587 * srcFg[index + 1] + 0.114 * srcFg[index + 2]
        const bgLum = 0.299 * srcBg[index] + 0.587 * srcBg[index + 1] + 0.114 * srcBg[index + 2]
        const lum = Math.max(fgLum, bgLum)
        if (lum > threshold) {
          const intensity = (lum - threshold) / (1 - threshold + 1e-6) // Add epsilon to avoid div by zero
          brightPixels.push({ x, y, intensity: Math.max(0, intensity) })
        }
      }
    }

    // If no bright pixels found, exit early
    if (brightPixels.length === 0) return

    // Initialize destination buffers by copying original state before applying bloom
    // This prevents bloom from compounding on itself within one frame pass
    destFg.set(srcFg)
    destBg.set(srcBg)

    // 2. Apply bloom spread from bright pixels onto the destination buffers
    for (const bright of brightPixels) {
      for (let ky = -radius; ky <= radius; ky++) {
        for (let kx = -radius; kx <= radius; kx++) {
          if (kx === 0 && ky === 0) continue // Don't bloom self

          const sampleX = bright.x + kx
          const sampleY = bright.y + ky

          if (sampleX >= 0 && sampleX < width && sampleY >= 0 && sampleY < height) {
            const distSq = kx * kx + ky * ky // Use squared distance for falloff calculation
            const radiusSq = radius * radius
            if (distSq <= radiusSq) {
              // Simple linear falloff based on squared distance
              const falloff = 1 - distSq / radiusSq
              const bloomAmount = bright.intensity * strength * falloff
              const destIndex = (sampleY * width + sampleX) * 4

              // Add bloom to both fg and bg, clamping at 1.0
              destFg[destIndex] = Math.min(1.0, destFg[destIndex] + bloomAmount)
              destFg[destIndex + 1] = Math.min(1.0, destFg[destIndex + 1] + bloomAmount)
              destFg[destIndex + 2] = Math.min(1.0, destFg[destIndex + 2] + bloomAmount)

              destBg[destIndex] = Math.min(1.0, destBg[destIndex] + bloomAmount)
              destBg[destIndex + 1] = Math.min(1.0, destBg[destIndex + 1] + bloomAmount)
              destBg[destIndex + 2] = Math.min(1.0, destBg[destIndex + 2] + bloomAmount)
            }
          }
        }
      }
    }
  }
}
