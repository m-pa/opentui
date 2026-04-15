const std = @import("std");
const c = @cImport({
    @cInclude("vendor/miniaudio/miniaudio.h");
});

pub const Status = struct {
    pub const ok: i32 = 0;
    pub const err_invalid: i32 = -1;
    pub const err_no_space: i32 = -2;
    pub const err_decode: i32 = -3;
    pub const err_not_found: i32 = -4;
    pub const err_device: i32 = -5;
};

pub const Bus = enum(u8) {
    master = 0,
    sfx = 1,
    music = 2,
    ui = 3,
};

pub const bus_count: usize = 4;
pub const max_voices: usize = 32;

pub const VoiceOptions = extern struct {
    volume: f32,
    pan: f32,
    looped: bool,
    bus: u8,
};

pub const Stats = extern struct {
    sounds_loaded: u32,
    voices_active: u32,
    frames_mixed: u64,
    underruns: u32,
    last_peak: f32,
    last_rms: f32,
};

const Sound = struct {
    channels: u16,
    sample_rate: u32,
    samples: []f32,
};

const Voice = struct {
    active: bool = false,
    sound_index: usize = 0,
    frame_pos: usize = 0,
    volume: f32 = 1,
    pan: f32 = 0,
    looped: bool = false,
    bus: u8 = @intFromEnum(Bus.sfx),
};

pub const Engine = struct {
    allocator: std.mem.Allocator,
    started: bool = false,
    lock: std.Thread.Mutex = .{},
    sounds: std.ArrayList(Sound),
    voices: [max_voices]Voice,
    bus_volumes: [bus_count]f32,
    stats: Stats,
    device: c.ma_device = undefined,
    has_device: bool = false,
    output_channels: u8 = 2,

    pub fn init(allocator: std.mem.Allocator) Engine {
        return .{
            .allocator = allocator,
            .started = false,
            .sounds = .empty,
            .voices = [_]Voice{.{}} ** max_voices,
            .bus_volumes = [_]f32{ 1, 1, 1, 1 },
            .stats = .{
                .sounds_loaded = 0,
                .voices_active = 0,
                .frames_mixed = 0,
                .underruns = 0,
                .last_peak = 0,
                .last_rms = 0,
            },
            .device = undefined,
            .has_device = false,
            .output_channels = 2,
        };
    }

    pub fn deinit(self: *Engine) void {
        if (self.has_device) {
            _ = c.ma_device_stop(&self.device);
            c.ma_device_uninit(&self.device);
            self.has_device = false;
        }
        for (self.sounds.items) |sound| {
            self.allocator.free(sound.samples);
        }
        self.sounds.deinit(self.allocator);
    }

    fn updateActiveVoiceCount(self: *Engine) void {
        var active: u32 = 0;
        for (self.voices) |voice| {
            if (voice.active) active += 1;
        }
        self.stats.voices_active = active;
    }
};

fn clamp(value: f32, min: f32, max: f32) f32 {
    return @max(min, @min(max, value));
}

fn decoderAsDataSource(decoder: *c.ma_decoder) *c.ma_data_source {
    return @ptrCast(decoder);
}

fn decodeSoundKnownLength(allocator: std.mem.Allocator, data_source: *c.ma_data_source, frame_count: c.ma_uint64) !Sound {
    const channels: usize = 2;
    const frame_count_usize = std.math.cast(usize, frame_count) orelse return error.OutOfMemory;
    const sample_count = try std.math.mul(usize, frame_count_usize, channels);

    const seek_result = c.ma_data_source_seek_to_pcm_frame(data_source, 0);
    if (seek_result != c.MA_SUCCESS) return error.DecodeFailed;

    var samples = try allocator.alloc(f32, sample_count);
    errdefer allocator.free(samples);

    var frames_read: c.ma_uint64 = 0;
    const result = c.ma_data_source_read_pcm_frames(data_source, samples.ptr, frame_count, &frames_read);
    if (result != c.MA_SUCCESS and result != c.MA_AT_END) return error.DecodeFailed;

    const frames_read_usize = std.math.cast(usize, frames_read) orelse return error.OutOfMemory;
    const final_sample_count = try std.math.mul(usize, frames_read_usize, channels);
    if (final_sample_count != sample_count) {
        samples = try allocator.realloc(samples, final_sample_count);
    }

    return .{
        .channels = @intCast(channels),
        .sample_rate = 48_000,
        .samples = samples,
    };
}

fn decodeSoundUnknownLength(allocator: std.mem.Allocator, data_source: *c.ma_data_source) !Sound {
    const channels: usize = 2;
    const chunk_frames: c.ma_uint64 = 4096;
    var chunk: [4096 * channels]f32 = undefined;
    var samples = std.ArrayList(f32).empty;
    errdefer samples.deinit(allocator);

    while (true) {
        var frames_read: c.ma_uint64 = 0;
        const result = c.ma_data_source_read_pcm_frames(data_source, chunk[0..].ptr, chunk_frames, &frames_read);
        if (result != c.MA_SUCCESS and result != c.MA_AT_END) return error.DecodeFailed;

        const frames_read_usize = std.math.cast(usize, frames_read) orelse return error.OutOfMemory;
        const sample_count = try std.math.mul(usize, frames_read_usize, channels);
        if (sample_count > 0) {
            try samples.appendSlice(allocator, chunk[0..sample_count]);
        }

        if (result == c.MA_AT_END or frames_read == 0) break;
    }

    return .{
        .channels = @intCast(channels),
        .sample_rate = 48_000,
        .samples = try samples.toOwnedSlice(allocator),
    };
}

fn decodeSoundFromMemory(allocator: std.mem.Allocator, bytes: []const u8) !Sound {
    var config = c.ma_decoder_config_init(c.ma_format_f32, 2, 48_000);
    var decoder: c.ma_decoder = undefined;
    const init_result = c.ma_decoder_init_memory(bytes.ptr, bytes.len, &config, &decoder);
    if (init_result != c.MA_SUCCESS) return error.DecodeFailed;
    defer _ = c.ma_decoder_uninit(&decoder);

    const data_source = decoderAsDataSource(&decoder);
    var frame_count: c.ma_uint64 = 0;
    const length_result = c.ma_data_source_get_length_in_pcm_frames(data_source, &frame_count);

    if (length_result == c.MA_SUCCESS) {
        return decodeSoundKnownLength(allocator, data_source, frame_count);
    }

    return decodeSoundUnknownLength(allocator, data_source);
}

pub fn create(allocator: std.mem.Allocator) ?*Engine {
    const engine = allocator.create(Engine) catch return null;
    engine.* = Engine.init(allocator);
    return engine;
}

pub fn destroy(engine: ?*Engine) void {
    if (engine == null) return;
    const e = engine.?;
    e.deinit();
    e.allocator.destroy(e);
}

pub fn start(engine: ?*Engine) i32 {
    if (engine == null) return Status.err_invalid;
    const e = engine.?;
    if (e.started) return Status.ok;

    if (!e.has_device) {
        var config = c.ma_device_config_init(c.ma_device_type_playback);
        config.sampleRate = 48000;
        config.playback.format = c.ma_format_f32;
        config.playback.channels = 2;
        config.dataCallback = audioCallback;
        config.pUserData = e;

        const init_result = c.ma_device_init(null, &config, &e.device);
        if (init_result != c.MA_SUCCESS) return Status.err_device;
        e.has_device = true;
        e.output_channels = @intCast(e.device.playback.channels);
    }

    const start_result = c.ma_device_start(&e.device);
    if (start_result != c.MA_SUCCESS) {
        return Status.err_device;
    }

    e.started = true;
    return Status.ok;
}

pub fn stop(engine: ?*Engine) i32 {
    if (engine == null) return Status.err_invalid;
    const e = engine.?;
    if (e.has_device) {
        _ = c.ma_device_stop(&e.device);
    }
    e.started = false;
    return Status.ok;
}

pub fn loadWav(engine: ?*Engine, data_ptr: ?[*]const u8, data_len: usize, out_sound_id: ?*u32) i32 {
    if (engine == null or data_ptr == null or out_sound_id == null or data_len == 0) return Status.err_invalid;
    const e = engine.?;
    const wav = @as([*]const u8, @ptrCast(data_ptr.?))[0..data_len];
    const sound = decodeSoundFromMemory(e.allocator, wav) catch return Status.err_decode;
    e.lock.lock();
    defer e.lock.unlock();
    e.sounds.append(e.allocator, sound) catch {
        e.allocator.free(sound.samples);
        return Status.err_no_space;
    };
    out_sound_id.?.* = @intCast(e.sounds.items.len);
    e.stats.sounds_loaded = @intCast(e.sounds.items.len);
    return Status.ok;
}

pub fn play(engine: ?*Engine, sound_id: u32, options_ptr: ?*const VoiceOptions, out_voice_id: ?*u32) i32 {
    if (engine == null or out_voice_id == null) return Status.err_invalid;
    const e = engine.?;
    e.lock.lock();
    defer e.lock.unlock();
    if (sound_id == 0 or sound_id > @as(u32, @intCast(e.sounds.items.len))) return Status.err_not_found;

    const options = if (options_ptr) |opts| opts.* else VoiceOptions{
        .volume = 1,
        .pan = 0,
        .looped = false,
        .bus = @intFromEnum(Bus.sfx),
    };

    if (options.bus >= bus_count) return Status.err_invalid;

    for (&e.voices, 0..) |*voice, idx| {
        if (!voice.active) {
            voice.* = .{
                .active = true,
                .sound_index = @intCast(sound_id - 1),
                .frame_pos = 0,
                .volume = clamp(options.volume, 0, 4),
                .pan = clamp(options.pan, -1, 1),
                .looped = options.looped,
                .bus = options.bus,
            };
            out_voice_id.?.* = @intCast(idx + 1);
            e.updateActiveVoiceCount();
            return Status.ok;
        }
    }

    return Status.err_no_space;
}

pub fn stopVoice(engine: ?*Engine, voice_id: u32) i32 {
    if (engine == null or voice_id == 0) return Status.err_invalid;
    const e = engine.?;
    e.lock.lock();
    defer e.lock.unlock();
    const idx: usize = @intCast(voice_id - 1);
    if (idx >= e.voices.len) return Status.err_not_found;
    e.voices[idx].active = false;
    e.updateActiveVoiceCount();
    return Status.ok;
}

pub fn setBusVolume(engine: ?*Engine, bus: u8, volume: f32) i32 {
    if (engine == null or bus >= bus_count) return Status.err_invalid;
    const e = engine.?;
    e.lock.lock();
    defer e.lock.unlock();
    e.bus_volumes[bus] = clamp(volume, 0, 4);
    return Status.ok;
}

fn mixLocked(engine: *Engine, out: []f32, frame_count: u32, channels: u8, allow_audio: bool) bool {
    @memset(out, 0);
    if (!allow_audio or frame_count == 0 or channels != 2) {
        engine.stats.last_peak = 0;
        engine.stats.last_rms = 0;
        return false;
    }

    var peak: f32 = 0;
    var rms_acc: f64 = 0;

    for (0..frame_count) |frame| {
        var dry_l: f32 = 0;
        var dry_r: f32 = 0;

        for (&engine.voices) |*voice| {
            if (!voice.active) continue;
            const sound = engine.sounds.items[voice.sound_index];
            const channel_count: usize = @intCast(sound.channels);
            const total_frames = sound.samples.len / channel_count;

            if (voice.frame_pos >= total_frames) {
                if (voice.looped) {
                    voice.frame_pos = 0;
                } else {
                    voice.active = false;
                    continue;
                }
            }

            const base = voice.frame_pos * channel_count;
            const mono = sound.channels == 1;
            const src_l = sound.samples[base];
            const src_r = if (mono) src_l else sound.samples[base + 1];

            const pan = voice.pan;
            const pan_l = if (pan > 0) 1 - pan else 1;
            const pan_r = if (pan < 0) 1 + pan else 1;
            const gain = voice.volume * engine.bus_volumes[voice.bus];

            const left = src_l * gain * pan_l;
            const right = src_r * gain * pan_r;

            dry_l += left;
            dry_r += right;

            voice.frame_pos += 1;
        }

        const master = engine.bus_volumes[@intFromEnum(Bus.master)];
        const out_l = clamp(dry_l * master, -1, 1);
        const out_r = clamp(dry_r * master, -1, 1);
        out[frame * 2] = out_l;
        out[frame * 2 + 1] = out_r;

        const abs_l = @abs(out_l);
        const abs_r = @abs(out_r);
        if (abs_l > peak) peak = abs_l;
        if (abs_r > peak) peak = abs_r;
        rms_acc += @as(f64, out_l) * @as(f64, out_l);
        rms_acc += @as(f64, out_r) * @as(f64, out_r);
    }

    engine.stats.frames_mixed += frame_count;
    engine.stats.last_peak = peak;
    const sample_count = @as(f64, @floatFromInt(frame_count)) * 2;
    engine.stats.last_rms = @floatCast(std.math.sqrt(rms_acc / @max(sample_count, 1)));
    engine.updateActiveVoiceCount();
    return true;
}

fn audioCallback(device_ptr: ?*c.ma_device, output_ptr: ?*anyopaque, input_ptr: ?*const anyopaque, frame_count: c.ma_uint32) callconv(.c) void {
    _ = input_ptr;
    if (device_ptr == null or output_ptr == null) return;
    const user_data = device_ptr.?.pUserData orelse return;
    const engine: *Engine = @ptrCast(@alignCast(user_data));

    engine.lock.lock();
    defer engine.lock.unlock();

    const aligned_output: *align(@alignOf(f32)) anyopaque = @alignCast(output_ptr.?);
    const out = @as([*]f32, @ptrCast(aligned_output))[0 .. @as(usize, frame_count) * @as(usize, engine.output_channels)];
    _ = mixLocked(engine, out, @intCast(frame_count), engine.output_channels, engine.started);
}

pub fn mixToBuffer(engine: ?*Engine, out_ptr: ?[*]f32, frame_count: u32, channels: u8) i32 {
    if (engine == null or out_ptr == null) return Status.err_invalid;
    if (channels != 2) return Status.err_invalid;

    const e = engine.?;
    e.lock.lock();
    defer e.lock.unlock();
    const out = @as([*]f32, @ptrCast(out_ptr.?))[0 .. @as(usize, frame_count) * @as(usize, channels)];
    _ = mixLocked(e, out, frame_count, channels, e.started);
    return Status.ok;
}

pub fn getStats(engine: ?*Engine, out_stats: ?*Stats) i32 {
    if (engine == null or out_stats == null) return Status.err_invalid;
    const e = engine.?;
    e.lock.lock();
    defer e.lock.unlock();
    e.updateActiveVoiceCount();
    out_stats.?.* = e.stats;
    return Status.ok;
}
