#!/usr/bin/env bun

import { performance } from "node:perf_hooks"
import { OptimizedBuffer } from "../buffer"

const sepiaMatrix = new Float32Array([
  0.393, 0.769, 0.189, 0, 0.349, 0.686, 0.168, 0, 0.272, 0.534, 0.131, 0, 0, 0, 0, 1,
])

const ITERATIONS = 1000
const WARMUP_ITERATIONS = 100

function generateCellMask(width: number, height: number, density: number): Float32Array {
  const totalCells = width * height
  const numCells = Math.floor(totalCells * density)
  const mask = new Float32Array(numCells * 3)

  for (let i = 0; i < numCells; i++) {
    mask[i * 3] = i % width
    mask[i * 3 + 1] = Math.floor(i / width)
    mask[i * 3 + 2] = 1
  }

  return mask
}

function calculateStats(samples: number[]): {
  avgMs: number
  medianMs: number
  minMs: number
  maxMs: number
} {
  const sorted = [...samples].sort((a, b) => a - b)
  const total = samples.reduce((sum, value) => sum + value, 0)

  return {
    avgMs: total / samples.length,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
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
  cellsPerMs: number
  timePerCellNs: number
}

function fillBufferColors(buffer: OptimizedBuffer): void {
  const { fg, bg } = buffer.buffers

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
}

function runMaskBenchmark(name: string, width: number, height: number, cellMask: Float32Array): BenchmarkResult {
  const buffer = OptimizedBuffer.create(width, height, "unicode", {
    id: `colormatrix-bench-${width}x${height}`,
  })

  fillBufferColors(buffer)

  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    buffer.colorMatrix(sepiaMatrix, cellMask, 1.0, 3)
  }

  const samples = new Array<number>(ITERATIONS)
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now()
    buffer.colorMatrix(sepiaMatrix, cellMask, 1.0, 3)
    samples[i] = performance.now() - start
  }

  buffer.destroy()

  const stats = calculateStats(samples)
  const cellCount = cellMask.length / 3

  return {
    name,
    bufferSize: `${width}x${height}`,
    cellCount,
    avgMs: stats.avgMs,
    medianMs: stats.medianMs,
    minMs: stats.minMs,
    maxMs: stats.maxMs,
    cellsPerMs: cellCount / stats.avgMs,
    timePerCellNs: (stats.avgMs * 1_000_000) / cellCount,
  }
}

function runUniformBenchmark(width: number, height: number): BenchmarkResult {
  const buffer = OptimizedBuffer.create(width, height, "unicode", {
    id: `uniform-bench-${width}x${height}`,
  })

  fillBufferColors(buffer)

  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    buffer.colorMatrixUniform(sepiaMatrix, 1.0, 3)
  }

  const samples = new Array<number>(ITERATIONS)
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now()
    buffer.colorMatrixUniform(sepiaMatrix, 1.0, 3)
    samples[i] = performance.now() - start
  }

  buffer.destroy()

  const stats = calculateStats(samples)
  const cellCount = width * height

  return {
    name: "Uniform (full buffer, SIMD)",
    bufferSize: `${width}x${height}`,
    cellCount,
    avgMs: stats.avgMs,
    medianMs: stats.medianMs,
    minMs: stats.minMs,
    maxMs: stats.maxMs,
    cellsPerMs: cellCount / stats.avgMs,
    timePerCellNs: (stats.avgMs * 1_000_000) / cellCount,
  }
}

const results: BenchmarkResult[] = []

const configs = [
  { width: 80, height: 24 },
  { width: 120, height: 40 },
  { width: 200, height: 60 },
]

for (const config of configs) {
  results.push(runUniformBenchmark(config.width, config.height))

  const quarterMask = generateCellMask(config.width, config.height, 0.25)
  results.push(runMaskBenchmark("Mask 25%", config.width, config.height, quarterMask))

  const fullMask = generateCellMask(config.width, config.height, 1)
  results.push(runMaskBenchmark("Mask 100%", config.width, config.height, fullMask))
}

console.log(`colorMatrix benchmark (${ITERATIONS} iterations, ${WARMUP_ITERATIONS} warmup)`)
console.log("Buffer    | Test                  | Cells | Avg ms | Median | Min   | Max   | Time/Cell")
console.log("----------------------------------------------------------------------------------------")

for (const result of results) {
  const line =
    `${result.bufferSize.padEnd(9)} | ${result.name.padEnd(21)} | ${result.cellCount.toString().padStart(5)} | ` +
    `${result.avgMs.toFixed(4).padStart(6)} | ${result.medianMs.toFixed(4).padStart(6)} | ` +
    `${result.minMs.toFixed(4).padStart(5)} | ${result.maxMs.toFixed(4).padStart(5)} | ` +
    `${result.timePerCellNs.toFixed(1).padStart(9)}ns`

  console.log(line)
}
