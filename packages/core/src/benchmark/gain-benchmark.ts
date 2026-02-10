#!/usr/bin/env bun

import { performance } from "node:perf_hooks"
import { OptimizedBuffer } from "../buffer"

type Scenario = { width: number; height: number; mode: "tuples" | "packed" }
type ScenarioResult = {
  size: string
  cells: number
  mode: "tuples" | "packed"
  avgMs: number
  medianMs: number
  p95Ms: number
}

const ITERATIONS = 25000
const WARMUP_ITERATIONS = 1000
const STRENGTH = 0.7
const baseScenarios: Array<{ width: number; height: number }> = [
  { width: 40, height: 20 },
  { width: 80, height: 24 },
  { width: 120, height: 40 },
  { width: 200, height: 60 },
]
const scenarios: Scenario[] = baseScenarios.flatMap((scenario) => [
  { ...scenario, mode: "tuples" },
  { ...scenario, mode: "packed" },
])

function buildCells(width: number, height: number): Array<[number, number, number]> {
  const cells = new Array<[number, number, number]>(width * height)
  const maxX = Math.max(1, width - 1)
  const maxY = Math.max(1, height - 1)
  let i = 0

  for (let y = 0; y < height; y++) {
    const yFactor = y / maxY
    for (let x = 0; x < width; x++) {
      const xFactor = x / maxX
      const baseAttenuation = xFactor * yFactor
      cells[i++] = [x, y, baseAttenuation]
    }
  }

  return cells
}

function buildTriplets(width: number, height: number): Float32Array {
  const triplets = new Float32Array(width * height * 3)
  const maxX = Math.max(1, width - 1)
  const maxY = Math.max(1, height - 1)
  let i = 0

  for (let y = 0; y < height; y++) {
    const yFactor = y / maxY
    for (let x = 0; x < width; x++) {
      const xFactor = x / maxX
      const baseAttenuation = xFactor * yFactor
      triplets[i++] = x
      triplets[i++] = y
      triplets[i++] = baseAttenuation
    }
  }

  return triplets
}

function calculateStats(samples: number[]): { avgMs: number; medianMs: number; p95Ms: number } {
  const sorted = [...samples].sort((a, b) => a - b)
  const total = samples.reduce((sum, value) => sum + value, 0)
  const avgMs = total / samples.length
  const mid = Math.floor(sorted.length / 2)
  const medianMs = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  const p95Index = Math.floor(0.95 * (sorted.length - 1))
  const p95Ms = sorted[p95Index]

  return { avgMs, medianMs, p95Ms }
}

function formatMs(value: number): number {
  return Number(value.toFixed(4))
}

function runScenario({ width, height, mode }: Scenario): ScenarioResult {
  const buffer = OptimizedBuffer.create(width, height, "unicode", { id: `gain-bench-${width}x${height}` })
  const cells = mode === "tuples" ? buildCells(width, height) : buildTriplets(width, height)
  const { fg, bg } = buffer.buffers
  fg.fill(1)
  bg.fill(1)

  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    buffer.gain(cells, STRENGTH)
  }

  const samples = new Array<number>(ITERATIONS)
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now()
    buffer.gain(cells, STRENGTH)
    samples[i] = performance.now() - start
  }

  buffer.destroy()

  const stats = calculateStats(samples)
  return {
    size: `${width}x${height}`,
    cells: width * height,
    mode,
    avgMs: formatMs(stats.avgMs),
    medianMs: formatMs(stats.medianMs),
    p95Ms: formatMs(stats.p95Ms),
  }
}

console.log(`Gain Benchmark (${ITERATIONS} iterations per scenario)`)
const results = scenarios.map(runScenario)
console.table(results)
