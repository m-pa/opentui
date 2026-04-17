import type { Pointer } from "bun:ffi"
import { EventEmitter } from "events"
import { resolveRenderLib, type RenderLib } from "./zig.js"
import type { AudioStats } from "./zig-structs.js"

export interface AudioSetupOptions {
  autoStart?: boolean
  noDevice?: boolean
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

export type AudioAction =
  | "createAudioEngine"
  | "start"
  | "stop"
  | "loadSound"
  | "group"
  | "play"
  | "stopVoice"
  | "setVoiceGroup"
  | "setGroupVolume"
  | "setMasterVolume"
  | "mixFrames"
  | "getStats"

export interface AudioErrorContext {
  action: AudioAction
  status?: number
}

export interface AudioEvents {
  error: [error: Error, context: AudioErrorContext]
  started: []
  stopped: []
  disposed: []
}

function statusToError(action: string, status: number): Error {
  return new Error(`Audio ${action} failed: ${status}`)
}

function toBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data)
}

export class Audio extends EventEmitter<AudioEvents> {
  static create(options: AudioSetupOptions = {}): Audio {
    return new Audio(resolveRenderLib(), options)
  }

  private readonly lib: RenderLib
  private readonly noDevice: boolean
  private engine: Pointer | null = null
  private readonly groups = new Map<string, number>()
  private started = false

  private constructor(lib: RenderLib, options: AudioSetupOptions) {
    super()
    this.lib = lib
    this.noDevice = options.noDevice ?? false
    this.engine = this.lib.createAudioEngine()
    if (!this.engine) {
      this.emitError("createAudioEngine", undefined, "Audio createAudioEngine returned null")
      return
    }

    if (options.autoStart ?? true) {
      this.start()
    }
  }

  private emitError(action: AudioAction, status?: number, message?: string): void {
    if (this.listenerCount("error") === 0) return
    const error = message ? new Error(message) : statusToError(action, status ?? -1)
    this.emit("error", error, { action, status })
  }

  start(): boolean {
    if (this.started) return true
    const engine = this.engine
    if (!engine) {
      this.emitError("start", undefined, "Audio engine unavailable during start")
      return false
    }
    const status = this.lib.audioStart(engine, this.noDevice)
    if (status !== 0) {
      this.emitError("start", status)
      return false
    }
    this.started = true
    this.emit("started")
    return true
  }

  stop(): boolean {
    if (!this.started) return true
    const engine = this.engine
    if (!engine) {
      this.emitError("stop", undefined, "Audio engine unavailable during stop")
      return false
    }
    const status = this.lib.audioStop(engine)
    if (status !== 0) {
      this.emitError("stop", status)
      return false
    }
    this.started = false
    this.emit("stopped")
    return true
  }

  isStarted(): boolean {
    return this.started
  }

  loadSound(data: Uint8Array | ArrayBuffer): AudioSound | null {
    const engine = this.engine
    if (!engine) {
      this.emitError("loadSound", undefined, "Audio engine unavailable during loadSound")
      return null
    }
    const result = this.lib.audioLoad(engine, toBytes(data))
    if (result.status !== 0 || result.soundId == null) {
      this.emitError("loadSound", result.status)
      return null
    }
    return result.soundId
  }

  async loadSoundFile(filePath: string): Promise<AudioSound | null> {
    const bytes = await Bun.file(filePath).arrayBuffer()
    return this.loadSound(bytes)
  }

  group(name: string): AudioGroup | null {
    const existing = this.groups.get(name)
    if (existing != null) {
      return existing
    }

    const engine = this.engine
    if (!engine) {
      this.emitError("group", undefined, "Audio engine unavailable during group")
      return null
    }
    const result = this.lib.audioCreateGroup(engine, name)
    if (result.status !== 0 || result.groupId == null) {
      this.emitError("group", result.status)
      return null
    }

    this.groups.set(name, result.groupId)
    return result.groupId
  }

  play(sound: AudioSound, options?: AudioPlayOptions): AudioVoice | null {
    const rawOptions = options
      ? {
        volume: options.volume,
        pan: options.pan,
        loop: options.loop,
        groupId: options.groupId ?? 0,
      }
      : undefined

    const engine = this.engine
    if (!engine) {
      this.emitError("play", undefined, "Audio engine unavailable during play")
      return null
    }
    const result = this.lib.audioPlay(engine, sound, rawOptions)
    if (result.status !== 0 || result.voiceId == null) {
      this.emitError("play", result.status)
      return null
    }

    return result.voiceId
  }

  stopVoice(voice: AudioVoice): boolean {
    const engine = this.engine
    if (!engine) {
      this.emitError("stopVoice", undefined, "Audio engine unavailable during stopVoice")
      return false
    }
    const status = this.lib.audioStopVoice(engine, voice)
    if (status !== 0) {
      this.emitError("stopVoice", status)
      return false
    }
    return true
  }

  setVoiceGroup(voice: AudioVoice, group: AudioGroup): boolean {
    const engine = this.engine
    if (!engine) {
      this.emitError("setVoiceGroup", undefined, "Audio engine unavailable during setVoiceGroup")
      return false
    }
    const status = this.lib.audioSetVoiceGroup(engine, voice, group)
    if (status !== 0) {
      this.emitError("setVoiceGroup", status)
      return false
    }
    return true
  }

  setGroupVolume(group: AudioGroup, volume: number): boolean {
    const engine = this.engine
    if (!engine) {
      this.emitError("setGroupVolume", undefined, "Audio engine unavailable during setGroupVolume")
      return false
    }
    const status = this.lib.audioSetGroupVolume(engine, group, volume)
    if (status !== 0) {
      this.emitError("setGroupVolume", status)
      return false
    }
    return true
  }

  setMasterVolume(volume: number): boolean {
    const engine = this.engine
    if (!engine) {
      this.emitError("setMasterVolume", undefined, "Audio engine unavailable during setMasterVolume")
      return false
    }
    const status = this.lib.audioSetMasterVolume(engine, volume)
    if (status !== 0) {
      this.emitError("setMasterVolume", status)
      return false
    }
    return true
  }

  mixFrames(frameCount: number, channels: number = 2): Float32Array | null {
    const engine = this.engine
    if (!engine) {
      this.emitError("mixFrames", undefined, "Audio engine unavailable during mixFrames")
      return null
    }
    const output = new Float32Array(frameCount * channels)
    const status = this.lib.audioMixToBuffer(engine, output, frameCount, channels)
    if (status !== 0) {
      this.emitError("mixFrames", status)
      return null
    }
    return output
  }

  getStats(): AudioStats | null {
    const engine = this.engine
    if (!engine) {
      this.emitError("getStats", undefined, "Audio engine unavailable during getStats")
      return null
    }
    return this.lib.audioGetStats(engine)
  }

  dispose(): void {
    if (!this.engine) return
    if (this.started) {
      this.stop()
    }
    this.groups.clear()
    this.lib.destroyAudioEngine(this.engine)
    this.engine = null
    this.emit("disposed")
  }
}

export function setupAudio(options: AudioSetupOptions = {}): Audio {
  return Audio.create(options)
}
