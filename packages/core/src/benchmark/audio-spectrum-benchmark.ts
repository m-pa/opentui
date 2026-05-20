#!/usr/bin/env bun

import { performance } from "node:perf_hooks"
import { Audio, type AudioSound } from "../audio.js"

type AnalyzeScenario = {
  name: string
  fftSize: number
}

type PipelineScenario = {
  name: string
  fftSize: number
  mixFrameCount: number
}

type AnalyzeResult = {
  scenario: string
  fftSize: number
  bins: number
  framesRead: number
  avgMs: number
  medianMs: number
  p95Ms: number
  maxMs: number
  analysesPerSec: number
  nsPerBin: number
}

type PipelineResult = AnalyzeResult & {
  mixFrameCount: number
  deltaVsAnalyzeOnlyPct: number
}

const ITERATIONS = Number(process.env.AUDIO_FFT_BENCH_ITERS ?? 8000)
const WARMUP_ITERATIONS = Number(process.env.AUDIO_FFT_BENCH_WARMUP ?? 200)
const SAMPLE_RATE = 48_000
const MAX_FFT_SIZE = 8192
const MIX_FRAME_COUNT = 256

const analyzeScenarios: AnalyzeScenario[] = [
  { name: "fft_256", fftSize: 256 },
  { name: "fft_512", fftSize: 512 },
  { name: "fft_1024", fftSize: 1024 },
  { name: "fft_2048", fftSize: 2048 },
  { name: "fft_4096", fftSize: 4096 },
  { name: "fft_8192", fftSize: 8192 },
]

const pipelineScenarios: PipelineScenario[] = analyzeScenarios.map((scenario) => ({
  name: `${scenario.name}_mix_plus_analyze`,
  fftSize: scenario.fftSize,
  mixFrameCount: MIX_FRAME_COUNT,
}))

function buildMonoPcm16Wav(options: {
  frequency: number
  durationMs: number
  amplitude: number
}): Uint8Array {
  const sampleCount = Math.max(1, Math.floor((SAMPLE_RATE * options.durationMs) / 1000))
  const channels = 1
  const bitsPerSample = 16
  const bytesPerSample = bitsPerSample / 8
  const dataSize = sampleCount * channels * bytesPerSample
  const out = new Uint8Array(44 + dataSize)
  const view = new DataView(out.buffer)

  out.set([0x52, 0x49, 0x46, 0x46], 0)
  view.setUint32(4, out.length - 8, true)
  out.set([0x57, 0x41, 0x56, 0x45], 8)
  out.set([0x66, 0x6d, 0x74, 0x20], 12)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, bitsPerSample, true)
  out.set([0x64, 0x61, 0x74, 0x61], 36)
  view.setUint32(40, dataSize, true)

  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / SAMPLE_RATE
    const fundamental = Math.sin(2 * Math.PI * options.frequency * t)
    const harmonic = Math.sin(2 * Math.PI * options.frequency * 2 * t) * 0.35
    const value = (fundamental + harmonic) * options.amplitude
    const sample = Math.round(Math.max(-1, Math.min(1, value)) * 32767)
    view.setInt16(44 + i * 2, sample, true)
  }

  return out
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.floor((sorted.length - 1) * p)
  return sorted[index] ?? 0
}

function summarizeSamples(samples: number[]): { avgMs: number; medianMs: number; p95Ms: number; maxMs: number } {
  const avgMs = samples.reduce((sum, ms) => sum + ms, 0) / samples.length
  return {
    avgMs,
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    maxMs: Math.max(...samples),
  }
}

function fillTap(audio: Audio, frameCount: number): void {
  const mixed = audio.mixFrames(frameCount, 2)
  if (!mixed) {
    throw new Error(`audio.mixFrames(${frameCount}, 2) failed`)
  }
}

function runAnalyzeScenario(audio: Audio, scenario: AnalyzeScenario): AnalyzeResult {
  fillTap(audio, scenario.fftSize)

  for (let i = 0; i < WARMUP_ITERATIONS; i += 1) {
    const spectrum = audio.analyzeSpectrum({ fftSize: scenario.fftSize })
    if (!spectrum) {
      throw new Error(`analyzeSpectrum failed during warmup for '${scenario.name}'`)
    }
  }

  let framesRead = 0
  const samples = new Array<number>(ITERATIONS)
  for (let i = 0; i < ITERATIONS; i += 1) {
    const start = performance.now()
    const spectrum = audio.analyzeSpectrum({ fftSize: scenario.fftSize })
    samples[i] = performance.now() - start
    if (!spectrum) {
      throw new Error(`analyzeSpectrum failed in scenario '${scenario.name}'`)
    }
    framesRead = spectrum.framesRead
  }

  const bins = scenario.fftSize / 2
  const stats = summarizeSamples(samples)
  const analysesPerSec = 1 / (stats.avgMs / 1000)
  const nsPerBin = (stats.avgMs * 1_000_000) / bins

  return {
    scenario: scenario.name,
    fftSize: scenario.fftSize,
    bins,
    framesRead,
    avgMs: Number(stats.avgMs.toFixed(4)),
    medianMs: Number(stats.medianMs.toFixed(4)),
    p95Ms: Number(stats.p95Ms.toFixed(4)),
    maxMs: Number(stats.maxMs.toFixed(4)),
    analysesPerSec: Number(analysesPerSec.toFixed(0)),
    nsPerBin: Number(nsPerBin.toFixed(2)),
  }
}

function runPipelineScenario(
  audio: Audio,
  scenario: PipelineScenario,
  analyzeOnlyAvgMs: number,
): PipelineResult {
  fillTap(audio, scenario.fftSize)

  for (let i = 0; i < WARMUP_ITERATIONS; i += 1) {
    fillTap(audio, scenario.mixFrameCount)
    const spectrum = audio.analyzeSpectrum({ fftSize: scenario.fftSize })
    if (!spectrum) {
      throw new Error(`mix plus analyze failed during warmup for '${scenario.name}'`)
    }
  }

  let framesRead = 0
  const samples = new Array<number>(ITERATIONS)
  for (let i = 0; i < ITERATIONS; i += 1) {
    const start = performance.now()
    fillTap(audio, scenario.mixFrameCount)
    const spectrum = audio.analyzeSpectrum({ fftSize: scenario.fftSize })
    samples[i] = performance.now() - start
    if (!spectrum) {
      throw new Error(`mix plus analyze failed in scenario '${scenario.name}'`)
    }
    framesRead = spectrum.framesRead
  }

  const bins = scenario.fftSize / 2
  const stats = summarizeSamples(samples)
  const analysesPerSec = 1 / (stats.avgMs / 1000)
  const nsPerBin = (stats.avgMs * 1_000_000) / bins
  const deltaVsAnalyzeOnlyPct =
    analyzeOnlyAvgMs > 0 ? Number((((stats.avgMs - analyzeOnlyAvgMs) / analyzeOnlyAvgMs) * 100).toFixed(2)) : 0

  return {
    scenario: scenario.name,
    fftSize: scenario.fftSize,
    bins,
    framesRead,
    mixFrameCount: scenario.mixFrameCount,
    avgMs: Number(stats.avgMs.toFixed(4)),
    medianMs: Number(stats.medianMs.toFixed(4)),
    p95Ms: Number(stats.p95Ms.toFixed(4)),
    maxMs: Number(stats.maxMs.toFixed(4)),
    analysesPerSec: Number(analysesPerSec.toFixed(0)),
    nsPerBin: Number(nsPerBin.toFixed(2)),
    deltaVsAnalyzeOnlyPct,
  }
}

function createAudioFixture(): { audio: Audio; sound: AudioSound } {
  const audio = Audio.create({ autoStart: false, maxVoices: 1 })
  audio.on("error", (error, context) => {
    throw new Error(`${context.action}: ${error.message}`)
  })

  if (!audio.startMixer()) {
    throw new Error("audio.startMixer() failed")
  }
  if (!audio.enableTap(MAX_FFT_SIZE)) {
    throw new Error("audio.enableTap() failed")
  }

  const wav = buildMonoPcm16Wav({
    frequency: 440,
    durationMs: 1000,
    amplitude: 0.6,
  })
  const sound = audio.loadSound(wav)
  if (sound == null) {
    throw new Error("audio.loadSound() failed")
  }
  const voice = sound.play({ volume: 1, loop: true })
  if (voice == null) {
    throw new Error("sound.play() failed")
  }

  return { audio, sound }
}

function main(): void {
  const { audio } = createAudioFixture()

  try {
    const analyzeResults = analyzeScenarios.map((scenario) => runAnalyzeScenario(audio, scenario))
    const analyzeAvgByFftSize = new Map(analyzeResults.map((row) => [row.fftSize, row.avgMs]))
    const pipelineResults = pipelineScenarios.map((scenario) =>
      runPipelineScenario(audio, scenario, analyzeAvgByFftSize.get(scenario.fftSize) ?? 0),
    )

    console.log(`Audio spectrum analyze benchmark (${ITERATIONS} iterations, ${WARMUP_ITERATIONS} warmup)`)
    console.table(analyzeResults)

    console.log(
      `Audio spectrum mix plus analyze benchmark (${ITERATIONS} iterations, ${WARMUP_ITERATIONS} warmup, ${MIX_FRAME_COUNT} mixed frames per iteration)`,
    )
    console.table(pipelineResults)
  } finally {
    audio.dispose()
  }
}

main()
