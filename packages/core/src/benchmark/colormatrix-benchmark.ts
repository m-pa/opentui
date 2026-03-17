#!/usr/bin/env bun

import { performance } from "node:perf_hooks"
import { OptimizedBuffer } from "../buffer"
import { colorMatrix, colorMatrixUniform } from "../zig"

// Sepia color matrix (4x4 RGBA in row-major order)
const sepiaMatrix = new Float32Array([
  0.393,
  0.769,
  0.189,
  0, // Row 0: Red output
  0.349,
  0.686,
  0.168,
  0, // Row 1: Green output
  0.272,
  0.534,
  0.131,
  0, // Row 2: Blue output
  0,
  0,
  0,
  1, // Row 3: Alpha output (identity)
])

const ITERATIONS = 1000
const WARMUP_ITERATIONS = 100

// Generate a cell mask with random cell positions (poor locality)
function generateRandomCellMask(width: number, height: number, density: number): Float32Array {
  const totalCells = width * height
  const numCells = Math.floor(totalCells * density)
  const mask = new Float32Array(numCells * 3) // x, y, strength for each cell

  for (let i = 0; i < numCells; i++) {
    const x = Math.floor(Math.random() * width)
    const y = Math.floor(Math.random() * height)
    const strength = 0.5 + Math.random() * 0.5 // Random strength 0.5-1.0
    mask[i * 3] = x
    mask[i * 3 + 1] = y
    mask[i * 3 + 2] = strength
  }

  return mask
}

// Generate a cell mask with sequential positions (excellent locality - row-major order)
function generateSequentialCellMask(width: number, height: number, density: number): Float32Array {
  const totalCells = width * height
  const numCells = Math.floor(totalCells * density)
  const mask = new Float32Array(numCells * 3)

  for (let i = 0; i < numCells; i++) {
    const x = i % width
    const y = Math.floor(i / width)
    mask[i * 3] = x
    mask[i * 3 + 1] = y
    mask[i * 3 + 2] = 1.0
  }

  return mask
}

// Generate a cell mask grouped by spatial locality (good locality)
function generateSpatialCellMask(width: number, height: number, density: number): Float32Array {
  const totalCells = width * height
  const numCells = Math.floor(totalCells * density)
  const mask = new Float32Array(numCells * 3)

  // Generate cells in small spatial clusters
  const clusterSize = 4 // Process 4x4 blocks at a time
  let idx = 0

  for (let cy = 0; cy < height && idx < numCells; cy += clusterSize) {
    for (let cx = 0; cx < width && idx < numCells; cx += clusterSize) {
      // Add cells within this cluster
      for (let dy = 0; dy < clusterSize && idx < numCells; dy++) {
        for (let dx = 0; dx < clusterSize && idx < numCells; dx++) {
          const x = cx + dx
          const y = cy + dy
          if (x < width && y < height) {
            mask[idx * 3] = x
            mask[idx * 3 + 1] = y
            mask[idx * 3 + 2] = 1.0
            idx++
          }
        }
      }
    }
  }

  return mask
}

// Sort mask by memory index (y * width + x) for optimal cache locality
function generateSortedCellMask(width: number, height: number, density: number): Float32Array {
  const totalCells = width * height
  const numCells = Math.floor(totalCells * density)

  // Generate random cells first
  const cells: Array<{ x: number; y: number; strength: number; index: number }> = []
  for (let i = 0; i < numCells; i++) {
    const x = Math.floor(Math.random() * width)
    const y = Math.floor(Math.random() * height)
    const index = y * width + x
    cells.push({ x, y, strength: 0.5 + Math.random() * 0.5, index })
  }

  // Sort by memory index for cache-friendly access
  cells.sort((a, b) => a.index - b.index)

  const mask = new Float32Array(numCells * 3)
  for (let i = 0; i < numCells; i++) {
    mask[i * 3] = cells[i].x
    mask[i * 3 + 1] = cells[i].y
    mask[i * 3 + 2] = cells[i].strength
  }

  return mask
}

function calculateStats(samples: number[]): {
  avgMs: number
  medianMs: number
  minMs: number
  maxMs: number
  variance: number
} {
  const sorted = [...samples].sort((a, b) => a - b)
  const total = samples.reduce((sum, value) => sum + value, 0)
  const avgMs = total / samples.length
  const variance = samples.reduce((sum, value) => sum + Math.pow(value - avgMs, 2), 0) / samples.length

  return {
    avgMs,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    variance,
  }
}

interface BenchmarkResult {
  name: string
  bufferSize: string
  cellCount: number
  avgMs: number
  medianMs: number
  minMs: number
  maxMs: number
  variance: number
  cellsPerMs: number
  timePerCellNs: number
  stdDevNs: number // Standard deviation in nanoseconds per cell
  cacheEfficiency: "poor" | "fair" | "good" | "excellent"
}

function runBenchmark(
  name: string,
  width: number,
  height: number,
  cellMask: Float32Array,
  localityType: string,
): BenchmarkResult {
  const buffer = OptimizedBuffer.create(width, height, "unicode", {
    id: `colormatrix-bench-${width}x${height}`,
  })
  const { fg, bg } = buffer.buffers

  // Fill with color data
  for (let i = 0; i < fg.length; i += 4) {
    fg[i] = Math.random()
    fg[i + 1] = Math.random()
    fg[i + 2] = Math.random()
    fg[i + 3] = 1
    bg[i] = Math.random()
    bg[i + 1] = Math.random()
    bg[i + 2] = Math.random()
    bg[i + 3] = 1
  }

  // Warmup
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    colorMatrix(buffer, sepiaMatrix, cellMask, 1.0, 3)
  }

  // Benchmark
  const samples = new Array<number>(ITERATIONS)
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now()
    colorMatrix(buffer, sepiaMatrix, cellMask, 1.0, 3)
    samples[i] = performance.now() - start
  }

  buffer.destroy()

  const stats = calculateStats(samples)
  const cellCount = cellMask.length / 3
  const timePerCellNs = (stats.avgMs * 1_000_000) / cellCount
  const stdDevNs = (Math.sqrt(stats.variance) * 1_000_000) / cellCount

  // Estimate cache efficiency based on variance and timing
  // High variance often indicates cache misses (inconsistent timing)
  let cacheEfficiency: "poor" | "fair" | "good" | "excellent"
  const cv = stdDevNs / timePerCellNs // Coefficient of variation
  if (cv > 0.5) cacheEfficiency = "poor"
  else if (cv > 0.3) cacheEfficiency = "fair"
  else if (cv > 0.15) cacheEfficiency = "good"
  else cacheEfficiency = "excellent"

  return {
    name: `${name} (${localityType})`,
    bufferSize: `${width}x${height}`,
    cellCount,
    avgMs: stats.avgMs,
    medianMs: stats.medianMs,
    minMs: stats.minMs,
    maxMs: stats.maxMs,
    variance: stats.variance,
    cellsPerMs: cellCount / stats.avgMs,
    timePerCellNs,
    stdDevNs,
    cacheEfficiency,
  }
}

function runUniformBenchmark(width: number, height: number): BenchmarkResult {
  const buffer = OptimizedBuffer.create(width, height, "unicode", {
    id: `uniform-bench-${width}x${height}`,
  })
  const { fg, bg } = buffer.buffers

  // Fill with color data
  for (let i = 0; i < fg.length; i += 4) {
    fg[i] = Math.random()
    fg[i + 1] = Math.random()
    fg[i + 2] = Math.random()
    fg[i + 3] = 1
    bg[i] = Math.random()
    bg[i + 1] = Math.random()
    bg[i + 2] = Math.random()
    bg[i + 3] = 1
  }

  // Warmup
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    colorMatrixUniform(buffer, sepiaMatrix, 1.0, 3)
  }

  // Benchmark
  const samples = new Array<number>(ITERATIONS)
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now()
    colorMatrixUniform(buffer, sepiaMatrix, 1.0, 3)
    samples[i] = performance.now() - start
  }

  buffer.destroy()

  const stats = calculateStats(samples)
  const cellCount = width * height
  const timePerCellNs = (stats.avgMs * 1_000_000) / cellCount
  const stdDevNs = (Math.sqrt(stats.variance) * 1_000_000) / cellCount

  return {
    name: "Uniform (Full Buffer, SIMD)",
    bufferSize: `${width}x${height}`,
    cellCount,
    avgMs: stats.avgMs,
    medianMs: stats.medianMs,
    minMs: stats.minMs,
    maxMs: stats.maxMs,
    variance: stats.variance,
    cellsPerMs: cellCount / stats.avgMs,
    timePerCellNs,
    stdDevNs,
    cacheEfficiency: "excellent",
  }
}

console.log("═".repeat(90))
console.log("  Cache Locality Analysis: colorMatrix Performance vs Memory Access Patterns")
console.log("  Tests whether prefetching would help by comparing random vs sequential access")
console.log("═".repeat(90))
console.log()
console.log(`Configuration: ${ITERATIONS} iterations per test, ${WARMUP_ITERATIONS} warmup iterations`)
console.log()
console.log("Locality Types:")
console.log("  • RANDOM    - Randomly scattered cells (worst cache locality)")
console.log("  • SORTED    - Random cells sorted by memory address (improved locality)")
console.log("  • SPATIAL   - Cells grouped in 4x4 spatial clusters (spatial locality)")
console.log("  • SEQUENTIAL- Row-major order (best cache locality)")
console.log()

const results: BenchmarkResult[] = []

// Test different buffer sizes
const configs = [
  { width: 80, height: 24, name: "Small Terminal" },
  { width: 120, height: 40, name: "Medium Terminal" },
  { width: 200, height: 60, name: "Large Terminal" },
]

for (const config of configs) {
  console.log(`\n┌${"─".repeat(88)}┐`)
  console.log(`│ ${config.name.padEnd(86)} │`)
  console.log(`└${"─".repeat(88)}┘`)

  // 1. Full buffer (uniform) - sequential access with SIMD (baseline)
  console.log("\n  [BASELINE] Testing colorMatrixUniform (full buffer, SIMD, sequential)...")
  results.push(runUniformBenchmark(config.width, config.height))

  // 2. 25% density - RANDOM (worst locality)
  console.log("  [RANDOM] Testing with 25% density, random positions...")
  const randomMask = generateRandomCellMask(config.width, config.height, 0.25)
  results.push(runBenchmark("25% Mask", config.width, config.height, randomMask, "RANDOM"))

  // 3. 25% density - SORTED (better locality)
  console.log("  [SORTED] Testing with 25% density, memory-sorted positions...")
  const sortedMask = generateSortedCellMask(config.width, config.height, 0.25)
  results.push(runBenchmark("25% Mask", config.width, config.height, sortedMask, "SORTED"))

  // 4. 25% density - SPATIAL (clustered locality)
  console.log("  [SPATIAL] Testing with 25% density, spatially clustered positions...")
  const spatialMask = generateSpatialCellMask(config.width, config.height, 0.25)
  results.push(runBenchmark("25% Mask", config.width, config.height, spatialMask, "SPATIAL"))

  // 5. 25% density - SEQUENTIAL (best locality)
  console.log("  [SEQUENTIAL] Testing with 25% density, row-major positions...")
  const sequentialMask = generateSequentialCellMask(config.width, config.height, 0.25)
  results.push(runBenchmark("25% Mask", config.width, config.height, sequentialMask, "SEQUENTIAL"))

  // 6. 100% density - RANDOM (full buffer, random)
  console.log("  [RANDOM 100%] Testing with 100% density, random positions...")
  const fullRandomMask = generateRandomCellMask(config.width, config.height, 1.0)
  results.push(runBenchmark("100% Mask", config.width, config.height, fullRandomMask, "RANDOM"))
}

// Print summary table
console.log("\n" + "═".repeat(90))
console.log("  RESULTS SUMMARY: Cache Locality Impact")
console.log("═".repeat(90))
console.log()

console.log("  Buffer    | Test Case               | Locality   | Cells | Time/Cell | Cache Eff.")
console.log("  " + "-".repeat(88))

for (const r of results) {
  const locality = r.name.match(/\(([^)]+)\)/)?.[1] ?? "N/A"
  const testCase = r.name.replace(/\s*\([^)]+\)/, "").padEnd(23)
  const line = `  ${r.bufferSize.padEnd(9)} | ${testCase} | ${locality.padEnd(10)} | ${r.cellCount.toString().padStart(5)} | ${r.timePerCellNs.toFixed(1).padStart(9)}ns | ${r.cacheEfficiency.padStart(10)}`
  console.log(line)
}

console.log()
console.log("═".repeat(90))
console.log("  Key Metrics:")
console.log()
console.log("  Time/Cell = Average nanoseconds to process one cell")
console.log("  Cache Efficiency = Estimated based on timing consistency (lower variance = better)")
console.log()

// Find speedup of sorted vs random
console.log("  Cache Locality Speedup Analysis:")
console.log()

for (const config of configs) {
  const configResults = results.filter(
    (r) => r.bufferSize === `${config.width}x${config.height}` && r.name.includes("25% Mask"),
  )
  const random = configResults.find((r) => r.name.includes("RANDOM"))
  const sorted = configResults.find((r) => r.name.includes("SORTED"))
  const spatial = configResults.find((r) => r.name.includes("SPATIAL"))
  const sequential = configResults.find((r) => r.name.includes("SEQUENTIAL"))

  if (random && sorted && spatial && sequential) {
    const randomTime = random.timePerCellNs
    console.log(`  ${config.name}:`)
    console.log(
      `    RANDOM → SORTED:     ${(randomTime / sorted.timePerCellNs).toFixed(2)}x faster (${((randomTime - sorted.timePerCellNs) / 1000).toFixed(2)}μs saved)`,
    )
    console.log(
      `    RANDOM → SPATIAL:    ${(randomTime / spatial.timePerCellNs).toFixed(2)}x faster (${((randomTime - spatial.timePerCellNs) / 1000).toFixed(2)}μs saved)`,
    )
    console.log(
      `    RANDOM → SEQUENTIAL: ${(randomTime / sequential.timePerCellNs).toFixed(2)}x faster (${((randomTime - sequential.timePerCellNs) / 1000).toFixed(2)}μs saved)`,
    )
  }
}

console.log()
console.log("═".repeat(90))
console.log("  Prefetching Recommendation:")
console.log()

// Analyze if prefetching would help
const allRandom = results.filter((r) => r.name.includes("RANDOM"))
const allSequential = results.filter((r) => r.name.includes("SEQUENTIAL"))
const avgRandomTime = allRandom.reduce((sum, r) => sum + r.timePerCellNs, 0) / allRandom.length
const avgSequentialTime = allSequential.reduce((sum, r) => sum + r.timePerCellNs, 0) / allSequential.length
const potentialGain = avgRandomTime - avgSequentialTime

console.log(`  Average time per cell (random access):     ${avgRandomTime.toFixed(1)}ns`)
console.log(`  Average time per cell (sequential access): ${avgSequentialTime.toFixed(1)}ns`)
console.log(
  `  Potential gain from prefetching:           ${potentialGain.toFixed(1)}ns (${((potentialGain / avgRandomTime) * 100).toFixed(1)}%)`,
)
console.log()

if (potentialGain > 20) {
  console.log("  ✓ VERDICT: Prefetching would likely provide significant benefit")
  console.log(
    `    Memory latency appears to be ${potentialGain.toFixed(1)}ns per cell (${((potentialGain / avgRandomTime) * 100).toFixed(0)}% of total time)`,
  )
} else {
  console.log("  ✗ VERDICT: Prefetching unlikely to help significantly")
  console.log("    The overhead may be dominated by computation, not memory latency")
}

console.log()
console.log("  Note: This is an estimate based on timing differences. Actual cache miss")
console.log("  profiling requires CPU performance counters (not available in JavaScript).")
console.log("═".repeat(90))
