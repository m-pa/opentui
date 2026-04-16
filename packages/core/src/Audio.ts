import type { Pointer } from "bun:ffi"
import { resolveRenderLib, type RenderLib } from "./zig.js"
import type { AudioStats, AudioVoiceOptions } from "./zig-structs.js"

interface AudioBackend {
  createAudioEngine: () => Pointer | null
  destroyAudioEngine: (engine: Pointer) => void
  audioStart: (engine: Pointer) => number
  audioStop: (engine: Pointer) => number
  audioLoad: (engine: Pointer, data: Uint8Array) => { status: number; soundId: number | null }
  audioPlay: (engine: Pointer, soundId: number, options?: AudioVoiceOptions) => { status: number; voiceId: number | null }
  audioStopVoice: (engine: Pointer, voiceId: number) => number
  audioSetVoiceGroup: (engine: Pointer, voiceId: number, groupId: number) => number
  audioCreateGroup: (engine: Pointer, name: string) => { status: number; groupId: number | null }
  audioSetGroupVolume: (engine: Pointer, groupId: number, volume: number) => number
  audioSetMasterVolume: (engine: Pointer, volume: number) => number
  audioMixToBuffer: (engine: Pointer, outBuffer: Float32Array, frameCount: number, channels: number) => number
  audioGetStats: (engine: Pointer) => AudioStats | null
}

export interface AudioSetupOptions {
  autoStart?: boolean
}

export interface AudioPlayOptions {
  volume?: number
  pan?: number
  loop?: boolean
  groupId?: number
}

export type AudioGroup = number
export type AudioVoice = number
export type AudioSound = number

function statusToError(action: string, status: number): Error {
  return new Error(`Audio ${action} failed: ${status}`)
}

function toBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data)
}

export class Audio {
  static create(options: AudioSetupOptions = {}): Audio {
    return new Audio(resolveRenderLib(), options)
  }

  private readonly lib: RenderLib & AudioBackend
  private engine: Pointer | null = null
  private readonly groups = new Map<string, number>()
  private started = false

  private constructor(lib: RenderLib, options: AudioSetupOptions) {
    this.lib = lib as RenderLib & AudioBackend
    this.engine = this.lib.createAudioEngine()
    if (!this.engine) {
      throw new Error("Audio createAudioEngine returned null")
    }

    if (options.autoStart ?? true) {
      this.start()
    }
  }

  private requireEngine(action: string): Pointer {
    if (!this.engine) {
      throw new Error(`Audio engine unavailable during ${action}`)
    }
    return this.engine
  }

  start(): void {
    if (this.started) return
    const status = this.lib.audioStart(this.requireEngine("start"))
    if (status !== 0) {
      throw statusToError("start", status)
    }
    this.started = true
  }

  stop(): void {
    if (!this.started) return
    const status = this.lib.audioStop(this.requireEngine("stop"))
    if (status !== 0) {
      throw statusToError("stop", status)
    }
    this.started = false
  }

  isStarted(): boolean {
    return this.started
  }

  loadSound(data: Uint8Array | ArrayBuffer): AudioSound {
    const result = this.lib.audioLoad(this.requireEngine("loadSound"), toBytes(data))
    if (result.status !== 0 || result.soundId == null) {
      throw statusToError("loadSound", result.status)
    }
    return result.soundId
  }

  async loadSoundFile(filePath: string): Promise<AudioSound> {
    const bytes = await Bun.file(filePath).arrayBuffer()
    return this.loadSound(bytes)
  }

  group(name: string): AudioGroup {
    const existing = this.groups.get(name)
    if (existing != null) {
      return existing
    }

    const result = this.lib.audioCreateGroup(this.requireEngine("group"), name)
    if (result.status !== 0 || result.groupId == null) {
      throw statusToError("group", result.status)
    }

    this.groups.set(name, result.groupId)
    return result.groupId
  }

  play(sound: AudioSound, options?: AudioPlayOptions): AudioVoice {
    const rawOptions = options
      ? {
          volume: options.volume,
          pan: options.pan,
          loop: options.loop,
          groupId: options.groupId ?? 0,
        }
      : undefined

    const result = this.lib.audioPlay(this.requireEngine("play"), sound, rawOptions)
    if (result.status !== 0 || result.voiceId == null) {
      throw statusToError("play", result.status)
    }

    return result.voiceId
  }

  stopVoice(voice: AudioVoice): void {
    const status = this.lib.audioStopVoice(this.requireEngine("stopVoice"), voice)
    if (status !== 0) {
      throw statusToError("stopVoice", status)
    }
  }

  setVoiceGroup(voice: AudioVoice, group: AudioGroup): void {
    const status = this.lib.audioSetVoiceGroup(this.requireEngine("setVoiceGroup"), voice, group)
    if (status !== 0) {
      throw statusToError("setVoiceGroup", status)
    }
  }

  setGroupVolume(group: AudioGroup, volume: number): void {
    const status = this.lib.audioSetGroupVolume(this.requireEngine("setGroupVolume"), group, volume)
    if (status !== 0) {
      throw statusToError("setGroupVolume", status)
    }
  }

  setMasterVolume(volume: number): void {
    const status = this.lib.audioSetMasterVolume(this.requireEngine("setMasterVolume"), volume)
    if (status !== 0) {
      throw statusToError("setMasterVolume", status)
    }
  }

  mixFrames(frameCount: number, channels: number = 2): Float32Array {
    const output = new Float32Array(frameCount * channels)
    const status = this.lib.audioMixToBuffer(this.requireEngine("mixFrames"), output, frameCount, channels)
    if (status !== 0) {
      throw statusToError("mixFrames", status)
    }
    return output
  }

  getStats(): AudioStats | null {
    return this.lib.audioGetStats(this.requireEngine("getStats"))
  }

  dispose(): void {
    if (!this.engine) return
    if (this.started) {
      this.stop()
    }
    this.groups.clear()
    this.lib.destroyAudioEngine(this.engine)
    this.engine = null
  }
}

export function setupAudio(options: AudioSetupOptions = {}): Audio {
  return Audio.create(options)
}
