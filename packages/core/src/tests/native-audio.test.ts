import { afterEach, expect, test } from "bun:test"
import { NativeAudio } from "../NativeAudio.js"

const SAMPLE_RATE = 48_000

function buildMonoPcm16Wav(samples: number[]): Uint8Array {
  const channels = 1
  const bitsPerSample = 16
  const bytesPerSample = bitsPerSample / 8
  const dataSize = samples.length * bytesPerSample
  const byteRate = SAMPLE_RATE * channels * bytesPerSample
  const blockAlign = channels * bytesPerSample
  const totalSize = 44 + dataSize
  const out = new Uint8Array(totalSize)
  const view = new DataView(out.buffer)

  out.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
  view.setUint32(4, totalSize - 8, true)
  out.set([0x57, 0x41, 0x56, 0x45], 8) // WAVE
  out.set([0x66, 0x6d, 0x74, 0x20], 12) // fmt 
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  out.set([0x64, 0x61, 0x74, 0x61], 36) // data
  view.setUint32(40, dataSize, true)

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true)
  }

  return out
}

const instances: NativeAudio[] = []

afterEach(() => {
  for (const instance of instances.splice(0)) {
    instance.dispose()
  }
})

test("NativeAudio loads wav and mixes frames", () => {
  const audio = NativeAudio.create({ autoStart: false })
  instances.push(audio)

  const wav = buildMonoPcm16Wav([0, 0.25, -0.25, 0.5, -0.5, 0])
  const soundId = audio.loadWav(wav)
  const sfx = audio.soundGroup("sfx")

  audio.start()
  audio.play(soundId, { group: sfx, volume: 1, pan: 0, looped: false })
  const mixed = audio.mixFrames(6, 2)

  expect(mixed.length).toBe(12)
  expect(mixed.some((sample) => Math.abs(sample) > 0.001)).toBe(true)
  expect(audio.getStats()?.soundsLoaded).toBe(1)
})
