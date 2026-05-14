import { EventEmitter } from "events"
import { readFile } from "node:fs/promises"
import type { Pointer } from "./platform/ffi.js"
import { resolveRenderLib, type RenderLib } from "./zig.js"
import type { AudioStats } from "./zig-structs.js"

const DEFAULT_AUDIO_SAMPLE_RATE = 48_000
const DEFAULT_FFT_SIZE = 2048
const playSound = Symbol("Audio.playSound")

export interface AudioSetupOptions {
  autoStart?: boolean
  sampleRate?: number
  playbackChannels?: number
  startOptions?: AudioStartOptions
}

export interface AudioStartOptions {
  periodSizeInFrames?: number
  periodSizeInMilliseconds?: number
  periods?: number
  performanceProfile?: number
  shareMode?: number
  noPreSilencedOutputBuffer?: boolean
  noClip?: boolean
  noDisableDenormals?: boolean
  noFixedSizedCallback?: boolean
  wasapiNoAutoConvertSrc?: boolean
  wasapiNoDefaultQualitySrc?: boolean
  alsaNoMMap?: boolean
  alsaNoAutoFormat?: boolean
  alsaNoAutoChannels?: boolean
  alsaNoAutoResample?: boolean
}

export interface AudioPlayOptions {
  volume?: number
  pan?: number
  loop?: boolean
  group?: AudioGroup
}

export interface AudioSpectrumOptions {
  fftSize?: number
}

export interface AudioSpectrum {
  magnitudes: Float32Array
  framesRead: number
  sampleRate: number
  binFrequency: number
}

export class AudioSound {
  private active = true

  constructor(
    private readonly owner: Audio,
    private readonly id: number,
  ) {}

  get isLoaded(): boolean {
    return this.active
  }

  unload(): boolean {
    return this.owner.unloadSound(this)
  }

  play(options?: AudioPlayOptions): AudioVoice | null {
    return this.owner[playSound](this, options)
  }

  resolveId(owner: Audio): number | null {
    if (owner !== this.owner || !this.active) return null
    return this.id
  }

  markUnloaded(): void {
    this.active = false
  }
}

export class AudioGroup {
  private active = true

  constructor(
    private readonly owner: Audio,
    private readonly id: number,
    readonly name: string,
  ) {}

  get isActive(): boolean {
    return this.active
  }

  setVolume(volume: number): boolean {
    return this.owner.setGroupVolume(this, volume)
  }

  resolveId(owner: Audio): number | null {
    if (owner !== this.owner || !this.active) return null
    return this.id
  }

  markDisposed(): void {
    this.active = false
  }
}

export class AudioVoice {
  private active = true

  constructor(
    private readonly owner: Audio,
    private readonly id: number,
    readonly sound: AudioSound,
  ) {}

  get isActive(): boolean {
    return this.active
  }

  stop(): boolean {
    return this.owner.stopVoice(this)
  }

  setGroup(group: AudioGroup): boolean {
    return this.owner.setVoiceGroup(this, group)
  }

  resolveId(owner: Audio): number | null {
    if (owner !== this.owner || !this.active) return null
    return this.id
  }

  markStopped(): void {
    this.active = false
  }
}

export interface AudioPlaybackDevice {
  index: number
  name: string
  isDefault: boolean
}

export type AudioAction =
  | "createAudioEngine"
  | "start"
  | "startMixer"
  | "stop"
  | "loadSound"
  | "loadSoundFile"
  | "unloadSound"
  | "group"
  | "play"
  | "stopVoice"
  | "setVoiceGroup"
  | "setGroupVolume"
  | "setMasterVolume"
  | "mixFrames"
  | "enableTap"
  | "readTapFrames"
  | "analyzeSpectrum"
  | "listPlaybackDevices"
  | "selectPlaybackDevice"
  | "clearPlaybackDeviceSelection"
  | "getStats"

export interface AudioErrorContext {
  action: AudioAction
  status?: number
}

export interface AudioEvents {
  error: [error: Error, context: AudioErrorContext]
  started: []
  mixerStarted: []
  stopped: []
  disposed: []
}

function statusToError(action: string, status: number): Error {
  return new Error(`Audio ${action} failed: ${status}`)
}

function toBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data)
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && Number.isInteger(Math.log2(value))
}

export class Audio extends EventEmitter<AudioEvents> {
  static create(options: AudioSetupOptions = {}): Audio {
    return new Audio(resolveRenderLib(), options)
  }

  private readonly lib: RenderLib
  private readonly defaultStartOptions: AudioStartOptions | undefined
  private readonly sampleRate: number
  private engine: Pointer | null = null
  private readonly groups = new Map<string, AudioGroup>()
  private readonly sounds = new Set<AudioSound>()
  private readonly voices = new Set<AudioVoice>()
  private playbackStarted = false
  private mixerStarted = false

  private constructor(lib: RenderLib, options: AudioSetupOptions) {
    super()
    this.lib = lib
    this.defaultStartOptions = options.startOptions
    const sampleRate = options.sampleRate == null ? DEFAULT_AUDIO_SAMPLE_RATE : Math.max(0, Math.trunc(options.sampleRate))
    this.sampleRate = sampleRate === 0 ? DEFAULT_AUDIO_SAMPLE_RATE : sampleRate
    const createOptions =
      options.sampleRate == null && options.playbackChannels == null
        ? undefined
        : {
            sampleRate: options.sampleRate == null ? undefined : this.sampleRate,
            playbackChannels:
              options.playbackChannels == null ? undefined : Math.max(0, Math.trunc(options.playbackChannels)),
          }
    this.engine = this.lib.createAudioEngine(createOptions)
    if (!this.engine) {
      this.emitError("createAudioEngine", undefined, "Audio createAudioEngine returned null")
      return
    }

    if (options.autoStart ?? false) {
      this.start(this.defaultStartOptions)
    }
  }

  private emitError(action: AudioAction, status?: number, message?: string, cause?: unknown): void {
    const error = message ? new Error(message) : statusToError(action, status ?? -1)
    if (cause) (error as Error & { cause?: unknown }).cause = cause
    this.emit("error", error, { action, status })
  }

  private getSoundId(action: AudioAction, sound: AudioSound): number | null {
    if (!(sound instanceof AudioSound)) {
      this.emitError(action, undefined, "Audio sound handle must be an AudioSound object")
      return null
    }
    const id = sound.resolveId(this)
    if (id == null) {
      this.emitError(action, undefined, "Audio sound handle is invalid")
    }
    return id
  }

  private getVoiceId(action: AudioAction, voice: AudioVoice): number | null {
    if (!(voice instanceof AudioVoice)) {
      this.emitError(action, undefined, "Audio voice handle must be an AudioVoice object")
      return null
    }
    const id = voice.resolveId(this)
    if (id == null) {
      this.emitError(action, undefined, "Audio voice handle is invalid")
    }
    return id
  }

  private getGroupId(action: AudioAction, group: AudioGroup): number | null {
    if (!(group instanceof AudioGroup)) {
      this.emitError(action, undefined, "Audio group handle must be an AudioGroup object")
      return null
    }
    const id = group.resolveId(this)
    if (id == null) {
      this.emitError(action, undefined, "Audio group handle is invalid")
    }
    return id
  }

  start(options?: AudioStartOptions): boolean {
    if (this.playbackStarted) return true
    const engine = this.engine
    if (!engine) {
      this.emitError("start", undefined, "Audio engine unavailable during start")
      return false
    }
    const startOptions = options ?? this.defaultStartOptions
    const status = this.lib.audioStart(engine, startOptions)
    if (status !== 0) {
      this.emitError("start", status)
      return false
    }
    this.playbackStarted = true
    this.mixerStarted = true
    this.emit("started")
    return true
  }

  startMixer(): boolean {
    if (this.mixerStarted) return true
    const engine = this.engine
    if (!engine) {
      this.emitError("startMixer", undefined, "Audio engine unavailable during startMixer")
      return false
    }
    const status = this.lib.audioStartMixer(engine)
    if (status !== 0) {
      this.emitError("startMixer", status)
      return false
    }
    this.mixerStarted = true
    this.emit("mixerStarted")
    return true
  }

  stop(): boolean {
    if (!this.mixerStarted) return true
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
    this.playbackStarted = false
    this.mixerStarted = false
    this.emit("stopped")
    return true
  }

  isStarted(): boolean {
    return this.playbackStarted
  }

  isMixerStarted(): boolean {
    return this.mixerStarted
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
    const sound = new AudioSound(this, result.soundId)
    this.sounds.add(sound)
    return sound
  }

  async loadSoundFile(filePath: string): Promise<AudioSound | null> {
    const bytes = await readFile(filePath).catch((err) => {
      this.emitError("loadSoundFile", undefined, `Failed to read file '${filePath}': ${err.message}`, err)
      return null
    })
    if (bytes == null) return null
    return this.loadSound(bytes)
  }

  unloadSound(sound: AudioSound): boolean {
    const engine = this.engine
    if (!engine) {
      this.emitError("unloadSound", undefined, "Audio engine unavailable during unloadSound")
      return false
    }

    const soundId = this.getSoundId("unloadSound", sound)
    if (soundId == null) return false

    const status = this.lib.audioUnload(engine, soundId)
    if (status !== 0) {
      this.emitError("unloadSound", status)
      return false
    }
    sound.markUnloaded()
    this.sounds.delete(sound)
    for (const voice of this.voices) {
      if (voice.sound === sound) {
        voice.markStopped()
        this.voices.delete(voice)
      }
    }
    return true
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

    const group = new AudioGroup(this, result.groupId, name)
    this.groups.set(name, group)
    return group
  }

  [playSound](sound: AudioSound, options?: AudioPlayOptions): AudioVoice | null {
    const soundId = this.getSoundId("play", sound)
    if (soundId == null) return null

    const groupId = options?.group == null ? 0 : this.getGroupId("play", options.group)
    if (groupId == null) return null

    const rawOptions = options
      ? {
          volume: options.volume,
          pan: options.pan,
          loop: options.loop,
          groupId,
        }
      : undefined

    const engine = this.engine
    if (!engine) {
      this.emitError("play", undefined, "Audio engine unavailable during play")
      return null
    }
    const result = this.lib.audioPlay(engine, soundId, rawOptions)
    if (result.status !== 0 || result.voiceId == null) {
      this.emitError("play", result.status)
      return null
    }

    const voice = new AudioVoice(this, result.voiceId, sound)
    this.voices.add(voice)
    return voice
  }

  stopVoice(voice: AudioVoice): boolean {
    const engine = this.engine
    if (!engine) {
      this.emitError("stopVoice", undefined, "Audio engine unavailable during stopVoice")
      return false
    }
    const voiceId = this.getVoiceId("stopVoice", voice)
    if (voiceId == null) return false

    const status = this.lib.audioStopVoice(engine, voiceId)
    if (status !== 0) {
      this.emitError("stopVoice", status)
      return false
    }
    voice.markStopped()
    this.voices.delete(voice)
    return true
  }

  setVoiceGroup(voice: AudioVoice, group: AudioGroup): boolean {
    const engine = this.engine
    if (!engine) {
      this.emitError("setVoiceGroup", undefined, "Audio engine unavailable during setVoiceGroup")
      return false
    }
    const voiceId = this.getVoiceId("setVoiceGroup", voice)
    if (voiceId == null) return false
    const groupId = this.getGroupId("setVoiceGroup", group)
    if (groupId == null) return false

    const status = this.lib.audioSetVoiceGroup(engine, voiceId, groupId)
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
    const groupId = this.getGroupId("setGroupVolume", group)
    if (groupId == null) return false

    const status = this.lib.audioSetGroupVolume(engine, groupId, volume)
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

  enableTap(capacityFrames: number = 8192): boolean {
    const engine = this.engine
    if (!engine) {
      this.emitError("enableTap", undefined, "Audio engine unavailable during enableTap")
      return false
    }
    const status = this.lib.audioEnableTap(engine, true, capacityFrames)
    if (status !== 0) {
      this.emitError("enableTap", status)
      return false
    }
    return true
  }

  disableTap(): boolean {
    const engine = this.engine
    if (!engine) {
      this.emitError("enableTap", undefined, "Audio engine unavailable during disableTap")
      return false
    }
    const status = this.lib.audioEnableTap(engine, false, 0)
    if (status !== 0) {
      this.emitError("enableTap", status)
      return false
    }
    return true
  }

  readTapFrames(frameCount: number, channels: number = 2): { frames: Float32Array; framesRead: number } | null {
    const engine = this.engine
    if (!engine) {
      this.emitError("readTapFrames", undefined, "Audio engine unavailable during readTapFrames")
      return null
    }
    const output = new Float32Array(frameCount * channels)
    const result = this.lib.audioReadTap(engine, output, frameCount, channels)
    if (result.status !== 0) {
      this.emitError("readTapFrames", result.status)
      return null
    }
    return { frames: output, framesRead: result.framesRead }
  }

  analyzeSpectrum(options: AudioSpectrumOptions = {}): AudioSpectrum | null {
    const engine = this.engine
    if (!engine) {
      this.emitError("analyzeSpectrum", undefined, "Audio engine unavailable during analyzeSpectrum")
      return null
    }

    const fftSize = Math.trunc(options.fftSize ?? DEFAULT_FFT_SIZE)
    if (!Number.isSafeInteger(fftSize) || fftSize < 2 || !isPowerOfTwo(fftSize)) {
      this.emitError("analyzeSpectrum", undefined, `Invalid FFT size ${options.fftSize ?? DEFAULT_FFT_SIZE}`)
      return null
    }

    const magnitudes = new Float32Array(fftSize / 2)
    const result = this.lib.audioAnalyzeSpectrum(engine, magnitudes, fftSize, magnitudes.length)
    if (result.status !== 0) {
      this.emitError("analyzeSpectrum", result.status)
      return null
    }

    return {
      magnitudes,
      framesRead: result.framesRead,
      sampleRate: this.sampleRate,
      binFrequency: this.sampleRate / fftSize,
    }
  }

  listPlaybackDevices(): AudioPlaybackDevice[] | null {
    const engine = this.engine
    if (!engine) {
      this.emitError("listPlaybackDevices", undefined, "Audio engine unavailable during listPlaybackDevices")
      return null
    }

    const refreshStatus = this.lib.audioRefreshPlaybackDevices(engine)
    if (refreshStatus !== 0) {
      this.emitError("listPlaybackDevices", refreshStatus)
      return null
    }

    const count = this.lib.audioGetPlaybackDeviceCount(engine)
    const devices: AudioPlaybackDevice[] = []
    for (let index = 0; index < count; index += 1) {
      devices.push({
        index,
        name: this.lib.audioGetPlaybackDeviceName(engine, index),
        isDefault: this.lib.audioIsPlaybackDeviceDefault(engine, index),
      })
    }

    return devices
  }

  selectPlaybackDevice(index: number): boolean {
    const engine = this.engine
    if (!engine) {
      this.emitError("selectPlaybackDevice", undefined, "Audio engine unavailable during selectPlaybackDevice")
      return false
    }

    const refreshStatus = this.lib.audioRefreshPlaybackDevices(engine)
    if (refreshStatus !== 0) {
      this.emitError("selectPlaybackDevice", refreshStatus)
      return false
    }

    const status = this.lib.audioSelectPlaybackDevice(engine, index)
    if (status !== 0) {
      this.emitError("selectPlaybackDevice", status)
      return false
    }

    return true
  }

  clearPlaybackDeviceSelection(): void {
    const engine = this.engine
    if (!engine) {
      this.emitError(
        "clearPlaybackDeviceSelection",
        undefined,
        "Audio engine unavailable during clearPlaybackDeviceSelection",
      )
      return
    }
    this.lib.audioClearPlaybackDeviceSelection(engine)
  }

  getStats(): AudioStats | null {
    const engine = this.engine
    if (!engine) {
      this.emitError("getStats", undefined, "Audio engine unavailable during getStats")
      return null
    }
    const stats = this.lib.audioGetStats(engine)
    if (stats == null) {
      this.emitError("getStats", undefined, "Failed to retrieve audio stats")
    }
    return stats
  }

  dispose(): void {
    if (!this.engine) return
    if (this.mixerStarted) {
      this.stop()
    }
    for (const sound of this.sounds) sound.markUnloaded()
    for (const voice of this.voices) voice.markStopped()
    for (const group of this.groups.values()) group.markDisposed()
    this.sounds.clear()
    this.voices.clear()
    this.groups.clear()
    this.lib.destroyAudioEngine(this.engine)
    this.engine = null
    this.emit("disposed")
  }
}

export function setupAudio(options: AudioSetupOptions = {}): Audio {
  return Audio.create(options)
}
