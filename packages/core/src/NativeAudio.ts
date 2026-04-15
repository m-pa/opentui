import type { Pointer } from "bun:ffi"
import { resolveRenderLib, type RenderLib } from "./zig.js"
import type { AudioStats, AudioVoiceOptions } from "./zig-structs.js"

interface NativeAudioBackend {
  createAudioEngine: () => Pointer | null
  destroyAudioEngine: (engine: Pointer) => void
  audioStart: (engine: Pointer) => number
  audioStop: (engine: Pointer) => number
  audioLoadWav: (engine: Pointer, data: Uint8Array) => { status: number; soundId: number | null }
  audioPlay: (engine: Pointer, soundId: number, options?: AudioVoiceOptions) => { status: number; voiceId: number | null }
  audioStopVoice: (engine: Pointer, voiceId: number) => number
  audioCreateGroup: (engine: Pointer, name: string) => { status: number; groupId: number | null }
  audioSetGroupVolume: (engine: Pointer, groupId: number, volume: number) => number
  audioSetMasterVolume: (engine: Pointer, volume: number) => number
  audioMixToBuffer: (engine: Pointer, outBuffer: Float32Array, frameCount: number, channels: number) => number
  audioGetStats: (engine: Pointer) => AudioStats | null
}

export interface NativeAudioSetupOptions {
  autoStart?: boolean
  allowMissingBackend?: boolean
}

export interface NativeAudioPlayOptions {
  volume?: number
  pan?: number
  looped?: boolean
  group?: NativeAudioSoundGroup
}

export class NativeAudioSoundGroup {
  constructor(
    readonly id: number,
    readonly name: string,
    private readonly setVolumeImpl: (volume: number) => void,
  ) {}

  setVolume(volume: number): void {
    this.setVolumeImpl(volume)
  }
}

function hasAudioBackend(lib: RenderLib): lib is RenderLib & NativeAudioBackend {
  const maybe = lib as RenderLib & Partial<NativeAudioBackend>
  return (
    typeof maybe.createAudioEngine === "function" &&
    typeof maybe.destroyAudioEngine === "function" &&
    typeof maybe.audioStart === "function" &&
    typeof maybe.audioStop === "function" &&
    typeof maybe.audioLoadWav === "function" &&
    typeof maybe.audioPlay === "function" &&
    typeof maybe.audioStopVoice === "function" &&
    typeof maybe.audioCreateGroup === "function" &&
    typeof maybe.audioSetGroupVolume === "function" &&
    typeof maybe.audioSetMasterVolume === "function" &&
    typeof maybe.audioMixToBuffer === "function" &&
    typeof maybe.audioGetStats === "function"
  )
}

function statusToError(action: string, status: number): Error {
  return new Error(`NativeAudio ${action} failed: ${status}`)
}

function toBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data)
}


export class NativeAudio {
  static create(options: NativeAudioSetupOptions = {}): NativeAudio {
    return new NativeAudio(resolveRenderLib(), options)
  }

  readonly available: boolean
  private readonly lib: (RenderLib & NativeAudioBackend) | null
  private engine: Pointer | null = null
  private readonly groups = new Map<string, NativeAudioSoundGroup>()
  private started = false

  private constructor(lib: RenderLib, options: NativeAudioSetupOptions) {
    const allowMissingBackend = options.allowMissingBackend ?? false

    if (!hasAudioBackend(lib)) {
      if (!allowMissingBackend) {
        throw new Error(
          "NativeAudio backend missing. Rebuild native core with audio exports or set allowMissingBackend=true.",
        )
      }
      this.available = false
      this.lib = null
      return
    }

    this.available = true
    this.lib = lib
    this.engine = lib.createAudioEngine()
    if (!this.engine) {
      throw new Error("NativeAudio createAudioEngine returned null")
    }

    if (options.autoStart ?? true) {
      this.start()
    }
  }

  start(): void {
    if (!this.available || !this.lib || !this.engine || this.started) return
    const status = this.lib.audioStart(this.engine)
    if (status !== 0) {
      throw statusToError("start", status)
    }
    this.started = true
  }

  stop(): void {
    if (!this.available || !this.lib || !this.engine || !this.started) return
    const status = this.lib.audioStop(this.engine)
    if (status !== 0) {
      throw statusToError("stop", status)
    }
    this.started = false
  }

  isStarted(): boolean {
    return this.started
  }

  loadWav(data: Uint8Array | ArrayBuffer): number {
    if (!this.available || !this.lib || !this.engine) {
      throw new Error("NativeAudio backend unavailable")
    }
    const result = this.lib.audioLoadWav(this.engine, toBytes(data))
    if (result.status !== 0 || result.soundId == null) {
      throw statusToError("loadWav", result.status)
    }
    return result.soundId
  }

  async loadWavFile(filePath: string): Promise<number> {
    const bytes = await Bun.file(filePath).arrayBuffer()
    return this.loadWav(bytes)
  }

  soundGroup(name: string): NativeAudioSoundGroup {
    if (!this.available || !this.lib || !this.engine) {
      throw new Error("NativeAudio backend unavailable")
    }

    const existing = this.groups.get(name)
    if (existing) {
      return existing
    }

    const result = this.lib.audioCreateGroup(this.engine, name)
    if (result.status !== 0 || result.groupId == null) {
      throw statusToError("soundGroup", result.status)
    }

    const group = new NativeAudioSoundGroup(result.groupId, name, (volume) => {
      this.setGroupVolumeById(result.groupId!, volume)
    })
    this.groups.set(name, group)
    return group
  }

  play(soundId: number, options?: NativeAudioPlayOptions): number {
    if (!this.available || !this.lib || !this.engine) {
      throw new Error("NativeAudio backend unavailable")
    }

    const rawOptions = options
      ? {
          volume: options.volume,
          pan: options.pan,
          looped: options.looped,
          groupId: options.group?.id ?? 0,
        }
      : undefined

    const result = this.lib.audioPlay(this.engine, soundId, rawOptions)
    if (result.status !== 0 || result.voiceId == null) {
      throw statusToError("play", result.status)
    }
    return result.voiceId
  }

  stopVoice(voiceId: number): void {
    if (!this.available || !this.lib || !this.engine) return
    const status = this.lib.audioStopVoice(this.engine, voiceId)
    if (status !== 0) {
      throw statusToError("stopVoice", status)
    }
  }

  setMasterVolume(volume: number): void {
    if (!this.available || !this.lib || !this.engine) return
    const status = this.lib.audioSetMasterVolume(this.engine, volume)
    if (status !== 0) {
      throw statusToError("setMasterVolume", status)
    }
  }

  mixFrames(frameCount: number, channels: number = 2): Float32Array {
    if (!this.available || !this.lib || !this.engine) {
      throw new Error("NativeAudio backend unavailable")
    }
    const output = new Float32Array(frameCount * channels)
    const status = this.lib.audioMixToBuffer(this.engine, output, frameCount, channels)
    if (status !== 0) {
      throw statusToError("mixFrames", status)
    }
    return output
  }

  getStats(): AudioStats | null {
    if (!this.available || !this.lib || !this.engine) return null
    return this.lib.audioGetStats(this.engine)
  }

  dispose(): void {
    if (!this.available || !this.lib || !this.engine) return
    if (this.started) {
      this.stop()
    }
    this.groups.clear()
    this.lib.destroyAudioEngine(this.engine)
    this.engine = null
  }

  private setGroupVolumeById(groupId: number, volume: number): void {
    if (!this.available || !this.lib || !this.engine) return
    const status = this.lib.audioSetGroupVolume(this.engine, groupId, volume)
    if (status !== 0) {
      throw statusToError("setGroupVolume", status)
    }
  }
}

export function setupNativeAudio(options: NativeAudioSetupOptions = {}): NativeAudio {
  return NativeAudio.create(options)
}
