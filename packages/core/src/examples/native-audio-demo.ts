#!/usr/bin/env bun

import {
  BoxRenderable,
  CliRenderer,
  Audio,
  type AudioGroup,
  type AudioSound,
  type AudioVoice,
  TextRenderable,
  createCliRenderer,
  type KeyEvent,
} from "../index.js"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

type SoundPreset = {
  name: string
  frequency: number
  durationMs: number
  volume: number
  groupName: "sfx" | "ui"
  decay: number
}

type MixTarget = "effects" | "master" | "bgm"

const PRESETS: SoundPreset[] = [
  { name: "Jump", frequency: 540, durationMs: 120, volume: 0.8, groupName: "sfx", decay: 0.82 },
  { name: "Coin", frequency: 980, durationMs: 90, volume: 0.65, groupName: "ui", decay: 0.86 },
  { name: "Thud", frequency: 140, durationMs: 200, volume: 0.9, groupName: "sfx", decay: 0.75 },
]

const SAMPLE_RATE = 48_000
const MIX_TARGETS: MixTarget[] = ["effects", "master", "bgm"]
const VOLUME_STEP = 0.05
const PAN_STEP = 0.1
const MIN_VOLUME = 0
const MAX_VOLUME = 2

let root: BoxRenderable | null = null
let titleText: TextRenderable | null = null
let statusText: TextRenderable | null = null
let mixText: TextRenderable | null = null
let statsText: TextRenderable | null = null
let meterText: TextRenderable | null = null
let controlsText: TextRenderable | null = null
let outputText: TextRenderable | null = null

let keyHandler: ((event: KeyEvent) => void) | null = null

let audio: Audio | null = null
let groups: { sfx: AudioGroup; music: AudioGroup; ui: AudioGroup } | null = null
let sounds: AudioSound[] = []
let musicSound: AudioSound | null = null
let musicVoice: AudioVoice | null = null
let masterVolume = 1
let masterPan = 0
let effectsVolume = 1
let effectsPan = 0
let bgmVolume = 0.42
let bgmPan = 0
let selectedMixTargetIndex = 0

let lastAction = "Ready"

function buildMonoPcm16Wav(options: { frequency: number; durationMs: number; amplitude: number; decay: number }): Uint8Array {
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
    const envelope = Math.pow(Math.max(0, 1 - i / sampleCount), options.decay)
    const value = Math.sin(2 * Math.PI * options.frequency * t) * options.amplitude * envelope
    const sample = Math.round(Math.max(-1, Math.min(1, value)) * 32767)
    view.setInt16(44 + i * 2, sample, true)
  }

  return out
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function clampVolume(value: number): number {
  return clamp(value, MIN_VOLUME, MAX_VOLUME)
}

function clampPan(value: number): number {
  return clamp(value, -1, 1)
}

function selectedMixTarget(): MixTarget {
  return MIX_TARGETS[selectedMixTargetIndex] ?? "effects"
}

function mixTargetLabel(target: MixTarget): string {
  switch (target) {
    case "effects":
      return "Effects"
    case "master":
      return "Master"
    case "bgm":
      return "BGM"
  }
}

function formatSigned(value: number): string {
  const normalized = Math.abs(value) < 0.005 ? 0 : value
  return normalized >= 0 ? `+${normalized.toFixed(2)}` : normalized.toFixed(2)
}

function formatMixTarget(target: MixTarget, volume: number, pan: number): string {
  const marker = selectedMixTarget() === target ? ">" : " "
  return `${marker}${mixTargetLabel(target)} v${volume.toFixed(2)} p${formatSigned(pan)}`
}

function presetBasePan(index: number): number {
  return index === 0 ? -0.2 : index === 1 ? 0.2 : 0
}

function applyGroupVolumes(): void {
  if (!groups || !audio) return
  audio.setGroupVolume(groups.sfx, effectsVolume)
  audio.setGroupVolume(groups.ui, clampVolume(effectsVolume * 0.9))
  audio.setGroupVolume(groups.music, bgmVolume)
}

function playBgmVoice(): void {
  if (!musicSound || !groups || !audio) return
  musicVoice = audio.play(musicSound, {
    volume: 1,
    pan: clampPan(bgmPan + masterPan),
    loop: true,
    groupId: groups.music,
  })
}

function restartBgmVoiceIfPlaying(): void {
  if (!musicVoice || !audio) return
  audio.stopVoice(musicVoice)
  musicVoice = null
  playBgmVoice()
}

function selectMixTarget(step: number): void {
  selectedMixTargetIndex = (selectedMixTargetIndex + step + MIX_TARGETS.length) % MIX_TARGETS.length
  lastAction = `Selected ${mixTargetLabel(selectedMixTarget())}`
  updateHeader()
}

function adjustSelectedVolume(delta: number): void {
  if (!audio) return
  const target = selectedMixTarget()

  switch (target) {
    case "effects":
      effectsVolume = clampVolume(effectsVolume + delta)
      applyGroupVolumes()
      lastAction = `Effects volume ${effectsVolume.toFixed(2)}`
      break
    case "master":
      masterVolume = clampVolume(masterVolume + delta)
      audio.setMasterVolume(masterVolume)
      lastAction = `Master volume ${masterVolume.toFixed(2)}`
      break
    case "bgm":
      bgmVolume = clampVolume(bgmVolume + delta)
      applyGroupVolumes()
      lastAction = `BGM volume ${bgmVolume.toFixed(2)}`
      break
  }

  updateHeader()
}

function adjustSelectedPan(delta: number): void {
  const target = selectedMixTarget()

  switch (target) {
    case "effects":
      effectsPan = clampPan(effectsPan + delta)
      lastAction = `Effects pan ${formatSigned(effectsPan)}`
      break
    case "master":
      masterPan = clampPan(masterPan + delta)
      restartBgmVoiceIfPlaying()
      lastAction = `Master pan ${formatSigned(masterPan)}`
      break
    case "bgm":
      bgmPan = clampPan(bgmPan + delta)
      restartBgmVoiceIfPlaying()
      lastAction = `BGM pan ${formatSigned(bgmPan)}`
      break
  }

  updateHeader()
}

function meterBar(value: number, width = 28): string {
  const clamped = Math.max(0, Math.min(1, value))
  const filled = Math.floor(clamped * width)
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`
}

function updateHeader(): void {
  if (!statusText) return
  statusText.content = `Action: ${lastAction}`

  if (mixText) {
    const items = [
      formatMixTarget("effects", effectsVolume, effectsPan),
      formatMixTarget("master", masterVolume, masterPan),
      formatMixTarget("bgm", bgmVolume, bgmPan),
    ]
    mixText.content = `Select j/k item | h/l volume | H/L pan\n${items.join("  ")}`
  }

  if (outputText && audio) {
    outputText.content = `Output: ${audio.isStarted() ? "ON (miniaudio)" : "OFF"}`
  }
}

function triggerSound(index: number): void {
  if (!groups || !audio || index < 0 || index >= sounds.length) return
  const preset = PRESETS[index]
  audio.play(sounds[index], {
    volume: preset.volume,
    pan: clampPan(presetBasePan(index) + effectsPan + masterPan),
    loop: false,
    groupId: groups[preset.groupName],
  })
  lastAction = `${preset.name} trigger`
  updateHeader()
}

function updateAudioView(): void {
  if (!audio || !meterText || !statsText) return

  const stats = audio.getStats()
  if (!stats) {
    statsText.content = "Stats unavailable"
    meterText.content = "Peak [----------------------------] 0.000\nRMS  [----------------------------] 0.000"
    return
  }

  const peak = stats.lastPeak
  const rms = stats.lastRms

  meterText.content = `Peak ${meterBar(peak)} ${peak.toFixed(3)}\nRMS  ${meterBar(rms)} ${rms.toFixed(3)}`

  statsText.content =
    `sounds=${stats.soundsLoaded} voices=${stats.voicesActive} frames=${stats.framesMixed.toString()} lockMisses=${stats.lockMisses}`
}

export async function run(renderer: CliRenderer): Promise<void> {
  renderer.setBackgroundColor("#111319")
  renderer.start()

  audio = Audio.create({ autoStart: true })
  groups = {
    sfx: audio.group("sfx"),
    music: audio.group("music"),
    ui: audio.group("ui"),
  }

  masterVolume = 1
  masterPan = 0
  effectsVolume = 1
  effectsPan = 0
  bgmVolume = 0.42
  bgmPan = 0
  selectedMixTargetIndex = 0

  audio.setMasterVolume(masterVolume)
  applyGroupVolumes()

  sounds = PRESETS.map((preset) => {
    const wav = buildMonoPcm16Wav({
      frequency: preset.frequency,
      durationMs: preset.durationMs,
      amplitude: 0.95,
      decay: preset.decay,
    })
    return audio!.loadSound(wav)
  })

  const bgmUrl = new URL("../../dev/bgm2.wav", import.meta.url)
  musicSound = audio.loadSound(await Bun.file(bgmUrl).arrayBuffer())

  root = new BoxRenderable(renderer, {
    id: "native-audio-demo-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    padding: 1,
    backgroundColor: "#111319",
  })
  renderer.root.add(root)

  titleText = new TextRenderable(renderer, {
    id: "native-audio-demo-title",
    content: "Audio Demo - selectable mix controls",
    fg: "#93C5FD",
    height: 1,
  })
  root.add(titleText)

  statusText = new TextRenderable(renderer, {
    id: "native-audio-demo-status",
    content: "Action: Ready",
    fg: "#EAB308",
    height: 1,
  })
  root.add(statusText)

  mixText = new TextRenderable(renderer, {
    id: "native-audio-demo-mix",
    content: "Select j/k item | h/l volume | H/L pan",
    fg: "#67E8F9",
    height: 2,
    marginTop: 1,
  })
  root.add(mixText)

  meterText = new TextRenderable(renderer, {
    id: "native-audio-demo-meter",
    content: "Peak [----------------------------] 0.000\nRMS  [----------------------------] 0.000",
    fg: "#34D399",
    height: 2,
    marginTop: 1,
  })
  root.add(meterText)

  statsText = new TextRenderable(renderer, {
    id: "native-audio-demo-stats",
    content: "sounds=0 voices=0 frames=0 lockMisses=0",
    fg: "#A78BFA",
    height: 1,
    marginTop: 1,
  })
  root.add(statsText)

  outputText = new TextRenderable(renderer, {
    id: "native-audio-demo-output",
    content: "Output: OFF",
    fg: "#FCA5A5",
    height: 1,
    marginTop: 1,
  })
  root.add(outputText)

  controlsText = new TextRenderable(renderer, {
    id: "native-audio-demo-controls",
    content:
      "1/2/3 trigger effects | B bgm on/off | J/K select item | H/L vol | Shift+H/Shift+L pan | Esc back",
    fg: "#9CA3AF",
    height: 3,
    marginTop: 1,
  })
  root.add(controlsText)

  updateHeader()

  if (musicSound && groups) {
    playBgmVoice()
    lastAction = "BGM auto start"
    updateHeader()
  }

  updateAudioView()

  keyHandler = (event: KeyEvent) => {
    if (!audio) return
    switch (event.name) {
      case "1":
        triggerSound(0)
        break
      case "2":
        triggerSound(1)
        break
      case "3":
        triggerSound(2)
        break
      case "j":
        selectMixTarget(1)
        break
      case "k":
        selectMixTarget(-1)
        break
      case "h":
      case "l": {
        const delta = event.name === "h" ? -1 : 1
        if (event.shift) {
          adjustSelectedPan(delta * PAN_STEP)
        } else {
          adjustSelectedVolume(delta * VOLUME_STEP)
        }
        break
      }
      case "b":
        if (!musicSound) break
        if (musicVoice) {
          audio.stopVoice(musicVoice)
          musicVoice = null
          lastAction = "BGM stop"
        } else {
          playBgmVoice()
          lastAction = "BGM start"
        }
        updateHeader()
        break
    }
  }

  renderer.keyInput.on("keypress", keyHandler)

  renderer.setFrameCallback(async () => {
    updateAudioView()
  })
}

export function destroy(renderer: CliRenderer): void {
  renderer.clearFrameCallbacks()

  if (keyHandler) {
    renderer.keyInput.off("keypress", keyHandler)
    keyHandler = null
  }

  renderer.root.remove("native-audio-demo-root")
  root = null
  titleText = null
  statusText = null
  mixText = null
  statsText = null
  outputText = null
  meterText = null
  controlsText = null

  audio?.dispose()
  audio = null
  groups = null
  sounds = []
  musicSound = null
  musicVoice = null
  masterVolume = 1
  masterPan = 0
  effectsVolume = 1
  effectsPan = 0
  bgmVolume = 0.42
  bgmPan = 0
  selectedMixTargetIndex = 0
  lastAction = "Ready"
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 60,
  })
  await run(renderer)
  setupCommonDemoKeys(renderer)
}
