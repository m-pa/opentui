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

pub const max_voices: usize = 32;

pub const VoiceOptions = extern struct {
    volume: f32,
    pan: f32,
    loop: bool,
    group_id: u32,
};

pub const Stats = extern struct {
    sounds_loaded: u32,
    voices_active: u32,
    frames_mixed: u64,
    lock_misses: u32,
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
    volume: f32 = 1,
    pan: f32 = 0,
    loop: bool = false,
    group_id: u32 = 0,
    buffer_ref: c.ma_audio_buffer_ref = undefined,
    buffer_ready: bool = false,
    sound: c.ma_sound = undefined,
    sound_ready: bool = false,
};

const SoundGroup = struct {
    name: []u8,
    volume: f32 = 1,
    node: c.ma_sound_group = undefined,
    initialized: bool = false,
};

pub const Engine = struct {
    allocator: std.mem.Allocator,
    started: bool = false,
    lock: std.Thread.Mutex = .{},
    core: c.ma_engine = undefined,
    core_initialized: bool = false,
    sounds: std.ArrayList(Sound),
    groups: std.ArrayList(*SoundGroup),
    voices: [max_voices]Voice,
    master_volume: f32,
    stats: Stats,
    device: c.ma_device = undefined,
    has_device: bool = false,
    output_channels: u8 = 2,
    lock_miss_count: u32 = 0,

    pub fn init(allocator: std.mem.Allocator) Engine {
        return .{
            .allocator = allocator,
            .started = false,
            .core = undefined,
            .core_initialized = false,
            .sounds = .empty,
            .groups = .empty,
            .voices = [_]Voice{.{}} ** max_voices,
            .master_volume = 1,
            .stats = .{
                .sounds_loaded = 0,
                .voices_active = 0,
                .frames_mixed = 0,
                .lock_misses = 0,
                .last_peak = 0,
                .last_rms = 0,
            },
            .device = undefined,
            .has_device = false,
            .output_channels = 2,
            .lock_miss_count = 0,
        };
    }

    pub fn deinit(self: *Engine) void {
        self.lock.lock();
        defer self.lock.unlock();

        if (self.has_device) {
            _ = c.ma_device_stop(&self.device);
            c.ma_device_uninit(&self.device);
            self.has_device = false;
        }

        for (&self.voices) |*voice| {
            clearVoice(voice);
        }

        for (self.groups.items) |group| {
            if (group.initialized) {
                c.ma_sound_group_uninit(&group.node);
                group.initialized = false;
            }
            self.allocator.free(group.name);
            self.allocator.destroy(group);
        }

        for (self.sounds.items) |sound| {
            self.allocator.free(sound.samples);
        }

        self.sounds.deinit(self.allocator);
        self.groups.deinit(self.allocator);

        if (self.core_initialized) {
            c.ma_engine_uninit(&self.core);
            self.core_initialized = false;
        }
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

const DecodedDataSourceFormat = struct {
    channels: u16,
    sample_rate: u32,
};

fn incrementLockMisses(engine: *Engine) void {
    _ = @atomicRmw(u32, &engine.lock_miss_count, .Add, 1, .monotonic);
}

fn loadLockMisses(engine: *Engine) u32 {
    return @atomicLoad(u32, &engine.lock_miss_count, .monotonic);
}

fn clearVoice(voice: *Voice) void {
    if (voice.sound_ready) {
        c.ma_sound_uninit(&voice.sound);
        voice.sound_ready = false;
    }
    if (voice.buffer_ready) {
        c.ma_audio_buffer_ref_uninit(&voice.buffer_ref);
        voice.buffer_ready = false;
    }
    voice.active = false;
    voice.sound_index = 0;
    voice.volume = 1;
    voice.pan = 0;
    voice.loop = false;
    voice.group_id = 0;
}

fn getDataSourceFormat(data_source: *c.ma_data_source) !DecodedDataSourceFormat {
    var format: c.ma_format = c.ma_format_unknown;
    var channels: c.ma_uint32 = 0;
    var sample_rate: c.ma_uint32 = 0;

    const format_result = c.ma_data_source_get_data_format(data_source, &format, &channels, &sample_rate, null, 0);
    if (format_result != c.MA_SUCCESS) return error.DecodeFailed;
    if (channels == 0 or sample_rate == 0) return error.DecodeFailed;

    return .{
        .channels = std.math.cast(u16, channels) orelse return error.DecodeFailed,
        .sample_rate = @intCast(sample_rate),
    };
}

// Fast path when data source reports total frame length: seek to frame 0,
// allocate once for exact sample count, then trim if decoder returns fewer
// frames than advertised.
fn decodeSoundKnownLength(allocator: std.mem.Allocator, data_source: *c.ma_data_source, frame_count: c.ma_uint64, channels: u16, sample_rate: u32) !Sound {
    const channel_count: usize = channels;
    const frame_count_usize = std.math.cast(usize, frame_count) orelse return error.OutOfMemory;
    const sample_count = try std.math.mul(usize, frame_count_usize, channel_count);

    const seek_result = c.ma_data_source_seek_to_pcm_frame(data_source, 0);
    if (seek_result != c.MA_SUCCESS) return error.DecodeFailed;

    var samples = try allocator.alloc(f32, sample_count);
    errdefer allocator.free(samples);

    var frames_read: c.ma_uint64 = 0;
    const result = c.ma_data_source_read_pcm_frames(data_source, samples.ptr, frame_count, &frames_read);
    if (result != c.MA_SUCCESS and result != c.MA_AT_END) return error.DecodeFailed;

    const frames_read_usize = std.math.cast(usize, frames_read) orelse return error.OutOfMemory;
    const final_sample_count = try std.math.mul(usize, frames_read_usize, channel_count);
    if (final_sample_count != sample_count) {
        samples = try allocator.realloc(samples, final_sample_count);
    }

    return .{
        .channels = channels,
        .sample_rate = sample_rate,
        .samples = samples,
    };
}

// Fallback path when total frame length unknown: read fixed-size chunks
// until MA_AT_END, then pack all chunks into one flat sample array.
fn decodeSoundUnknownLength(allocator: std.mem.Allocator, data_source: *c.ma_data_source, channels: u16, sample_rate: u32) !Sound {
    const channel_count: usize = channels;
    const chunk_frames: c.ma_uint64 = 4096;
    const chunk_frames_usize: usize = @intCast(chunk_frames);
    const chunk_sample_count = try std.math.mul(usize, chunk_frames_usize, channel_count);
    const chunk = try allocator.alloc(f32, chunk_sample_count);
    defer allocator.free(chunk);

    var samples = std.ArrayList(f32).empty;
    errdefer samples.deinit(allocator);

    while (true) {
        var frames_read: c.ma_uint64 = 0;
        const result = c.ma_data_source_read_pcm_frames(data_source, chunk.ptr, chunk_frames, &frames_read);
        if (result != c.MA_SUCCESS and result != c.MA_AT_END) return error.DecodeFailed;

        const frames_read_usize = std.math.cast(usize, frames_read) orelse return error.OutOfMemory;
        const sample_count = try std.math.mul(usize, frames_read_usize, channel_count);
        if (sample_count > 0) {
            try samples.appendSlice(allocator, chunk[0..sample_count]);
        }

        if (result == c.MA_AT_END or frames_read == 0) break;
    }

    return .{
        .channels = channels,
        .sample_rate = sample_rate,
        .samples = try samples.toOwnedSlice(allocator),
    };
}

fn decodeSoundFromMemory(allocator: std.mem.Allocator, bytes: []const u8) !Sound {
    var config = c.ma_decoder_config_init(c.ma_format_f32, 0, 0);
    var decoder: c.ma_decoder = undefined;
    const init_result = c.ma_decoder_init_memory(bytes.ptr, bytes.len, &config, &decoder);
    if (init_result != c.MA_SUCCESS) return error.DecodeFailed;
    defer _ = c.ma_decoder_uninit(&decoder);

    const data_source = decoderAsDataSource(&decoder);
    const decoded_format = try getDataSourceFormat(data_source);
    var frame_count: c.ma_uint64 = 0;
    const length_result = c.ma_data_source_get_length_in_pcm_frames(data_source, &frame_count);

    if (length_result == c.MA_SUCCESS) {
        return decodeSoundKnownLength(allocator, data_source, frame_count, decoded_format.channels, decoded_format.sample_rate);
    }

    return decodeSoundUnknownLength(allocator, data_source, decoded_format.channels, decoded_format.sample_rate);
}

fn initDefaultGroup(engine: *Engine) !void {
    const group = try engine.allocator.create(SoundGroup);
    errdefer engine.allocator.destroy(group);

    group.* = .{
        .name = try engine.allocator.dupe(u8, "default"),
    };
    errdefer engine.allocator.free(group.name);

    const result = c.ma_sound_group_init(&engine.core, 0, null, &group.node);
    if (result != c.MA_SUCCESS) return error.DeviceInitFailed;
    group.initialized = true;
    c.ma_sound_group_set_volume(&group.node, 1);

    try engine.groups.append(engine.allocator, group);
}

fn reapFinishedVoices(engine: *Engine) void {
    for (&engine.voices) |*voice| {
        if (!voice.active or !voice.sound_ready) continue;

        const playing = c.ma_sound_is_playing(&voice.sound) != c.MA_FALSE;
        const at_end = c.ma_sound_at_end(&voice.sound) != c.MA_FALSE;

        if (!playing and at_end) {
            clearVoice(voice);
        }
    }
    engine.updateActiveVoiceCount();
}

fn updateStatsFromBuffer(engine: *Engine, out: []const f32, frame_count: u32, channels: u8) void {
    engine.stats.frames_mixed += frame_count;
    engine.stats.lock_misses = loadLockMisses(engine);

    if (frame_count == 0 or channels == 0 or out.len == 0) {
        engine.stats.last_peak = 0;
        engine.stats.last_rms = 0;
        return;
    }

    var peak: f32 = 0;
    var rms_acc: f64 = 0;
    for (out) |sample| {
        const abs_value = @abs(sample);
        if (abs_value > peak) peak = abs_value;
        rms_acc += @as(f64, sample) * @as(f64, sample);
    }

    const sample_count = @as(f64, @floatFromInt(frame_count)) * @as(f64, @floatFromInt(channels));
    engine.stats.last_peak = peak;
    engine.stats.last_rms = @floatCast(std.math.sqrt(rms_acc / @max(sample_count, 1)));
}

fn readEngineStereo(engine: *Engine, out_stereo: []f32, frame_count: u32) i32 {
    if (out_stereo.len < @as(usize, frame_count) * 2) return Status.err_invalid;

    var frames_read: c.ma_uint64 = 0;
    const result = c.ma_engine_read_pcm_frames(&engine.core, out_stereo.ptr, frame_count, &frames_read);
    if (result != c.MA_SUCCESS and result != c.MA_AT_END) {
        return Status.err_device;
    }

    const frames_read_usize = std.math.cast(usize, frames_read) orelse return Status.err_device;
    const requested = @as(usize, frame_count);
    if (frames_read_usize < requested) {
        const zero_start = frames_read_usize * 2;
        const zero_end = requested * 2;
        @memset(out_stereo[zero_start..zero_end], 0);
    }

    return Status.ok;
}

pub fn create(allocator: std.mem.Allocator) ?*Engine {
    const engine = allocator.create(Engine) catch return null;
    errdefer allocator.destroy(engine);
    engine.* = Engine.init(allocator);

    var config = c.ma_engine_config_init();
    config.noDevice = c.MA_TRUE;
    config.channels = 2;
    config.sampleRate = 48_000;

    if (c.ma_engine_init(&config, &engine.core) != c.MA_SUCCESS) return null;
    engine.core_initialized = true;

    initDefaultGroup(engine) catch return null;
    return engine;
}

pub fn destroy(engine: *Engine) void {
    const e = engine;
    e.deinit();
    e.allocator.destroy(e);
}

// NOTE: no_device flag for test decoupling, can be removed with device selection support
pub fn start(engine: *Engine, no_device: bool) i32 {
    const e = engine;
    if (e.started) return Status.ok;

    if (no_device) {
        e.started = true;
        return Status.ok;
    }

    if (!e.has_device) {
        var config = c.ma_device_config_init(c.ma_device_type_playback);
        config.sampleRate = 48_000;
        config.playback.format = c.ma_format_f32;
        config.playback.channels = 2;
        config.dataCallback = audioCallback;
        config.pUserData = e;

        const init_result = c.ma_device_init(null, &config, &e.device);
        if (init_result != c.MA_SUCCESS) return Status.err_device;

        e.has_device = true;
        e.output_channels = 2;
    }

    const start_result = c.ma_device_start(&e.device);
    if (start_result != c.MA_SUCCESS) {
        return Status.err_device;
    }

    e.started = true;
    return Status.ok;
}

pub fn stop(engine: *Engine) i32 {
    const e = engine;
    if (e.has_device) {
        _ = c.ma_device_stop(&e.device);
    }
    e.started = false;
    return Status.ok;
}

pub fn load(engine: *Engine, data_ptr: ?[*]const u8, data_len: usize, out_sound_id: ?*u32) i32 {
    if (data_ptr == null or out_sound_id == null or data_len == 0) return Status.err_invalid;
    const e = engine;
    const encoded_audio = @as([*]const u8, @ptrCast(data_ptr.?))[0..data_len];
    const sound = decodeSoundFromMemory(e.allocator, encoded_audio) catch return Status.err_decode;

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

pub fn createGroup(engine: *Engine, name_ptr: ?[*]const u8, name_len: usize, out_group_id: ?*u32) i32 {
    if (name_ptr == null or out_group_id == null) return Status.err_invalid;
    const e = engine;
    const name = @as([*]const u8, @ptrCast(name_ptr.?))[0..name_len];

    e.lock.lock();
    defer e.lock.unlock();

    for (e.groups.items, 0..) |group, idx| {
        if (std.mem.eql(u8, group.name, name)) {
            out_group_id.?.* = @intCast(idx);
            return Status.ok;
        }
    }

    const group = e.allocator.create(SoundGroup) catch return Status.err_no_space;
    errdefer e.allocator.destroy(group);

    group.* = .{
        .name = e.allocator.dupe(u8, name) catch return Status.err_no_space,
    };
    errdefer e.allocator.free(group.name);

    const init_result = c.ma_sound_group_init(&e.core, 0, null, &group.node);
    if (init_result != c.MA_SUCCESS) return Status.err_device;
    group.initialized = true;
    c.ma_sound_group_set_volume(&group.node, 1);

    e.groups.append(e.allocator, group) catch {
        c.ma_sound_group_uninit(&group.node);
        e.allocator.free(group.name);
        e.allocator.destroy(group);
        return Status.err_no_space;
    };

    out_group_id.?.* = @intCast(e.groups.items.len - 1);
    return Status.ok;
}

pub fn play(engine: *Engine, sound_id: u32, options_ptr: ?*const VoiceOptions, out_voice_id: ?*u32) i32 {
    if (out_voice_id == null) return Status.err_invalid;
    const e = engine;

    e.lock.lock();
    defer e.lock.unlock();
    reapFinishedVoices(e);

    if (sound_id == 0 or sound_id > @as(u32, @intCast(e.sounds.items.len))) return Status.err_not_found;

    const options = if (options_ptr) |opts| opts.* else VoiceOptions{
        .volume = 1,
        .pan = 0,
        .loop = false,
        .group_id = 0,
    };

    const group_index: usize = @intCast(options.group_id);
    if (group_index >= e.groups.items.len) return Status.err_invalid;

    var free_index: ?usize = null;
    for (e.voices, 0..) |voice, idx| {
        if (!voice.active) {
            free_index = idx;
            break;
        }
    }
    if (free_index == null) return Status.err_no_space;

    const slot = &e.voices[free_index.?];
    clearVoice(slot);

    const sound = e.sounds.items[@intCast(sound_id - 1)];
    const frame_count: usize = sound.samples.len / @as(usize, sound.channels);

    if (c.ma_audio_buffer_ref_init(c.ma_format_f32, sound.channels, sound.samples.ptr, @intCast(frame_count), &slot.buffer_ref) != c.MA_SUCCESS) {
        return Status.err_device;
    }
    slot.buffer_ref.sampleRate = sound.sample_rate;
    slot.buffer_ready = true;

    const group_ptr = &e.groups.items[group_index].node;
    const data_source: *c.ma_data_source = @ptrCast(&slot.buffer_ref);
    const sound_flags: c.ma_uint32 = c.MA_SOUND_FLAG_NO_SPATIALIZATION | c.MA_SOUND_FLAG_NO_PITCH;
    if (c.ma_sound_init_from_data_source(&e.core, data_source, sound_flags, group_ptr, &slot.sound) != c.MA_SUCCESS) {
        clearVoice(slot);
        return Status.err_device;
    }
    slot.sound_ready = true;

    slot.active = true;
    slot.sound_index = @intCast(sound_id - 1);
    slot.volume = clamp(options.volume, 0, 4);
    slot.pan = clamp(options.pan, -1, 1);
    slot.loop = options.loop;
    slot.group_id = options.group_id;

    c.ma_sound_set_looping(&slot.sound, if (slot.loop) c.MA_TRUE else c.MA_FALSE);
    c.ma_sound_set_pan(&slot.sound, slot.pan);
    c.ma_sound_set_volume(&slot.sound, slot.volume);

    if (c.ma_sound_start(&slot.sound) != c.MA_SUCCESS) {
        clearVoice(slot);
        return Status.err_device;
    }

    out_voice_id.?.* = @intCast(free_index.? + 1);
    e.updateActiveVoiceCount();
    return Status.ok;
}

pub fn stopVoice(engine: *Engine, voice_id: u32) i32 {
    if (voice_id == 0) return Status.err_invalid;
    const e = engine;

    e.lock.lock();
    defer e.lock.unlock();

    const idx: usize = @intCast(voice_id - 1);
    if (idx >= e.voices.len) return Status.err_not_found;
    if (!e.voices[idx].active) return Status.err_not_found;

    _ = c.ma_sound_stop(&e.voices[idx].sound);
    clearVoice(&e.voices[idx]);
    e.updateActiveVoiceCount();
    return Status.ok;
}

pub fn setVoiceGroup(engine: *Engine, voice_id: u32, group_id: u32) i32 {
    if (voice_id == 0) return Status.err_invalid;
    const e = engine;

    e.lock.lock();
    defer e.lock.unlock();

    const voice_index: usize = @intCast(voice_id - 1);
    const group_index: usize = @intCast(group_id);
    if (voice_index >= e.voices.len or group_index >= e.groups.items.len) return Status.err_invalid;

    const voice = &e.voices[voice_index];
    if (!voice.active or !voice.sound_ready or !voice.buffer_ready) return Status.err_not_found;

    var cursor: c.ma_uint64 = 0;
    _ = c.ma_sound_get_cursor_in_pcm_frames(&voice.sound, &cursor);
    const was_playing = c.ma_sound_is_playing(&voice.sound) != c.MA_FALSE;

    c.ma_sound_uninit(&voice.sound);
    voice.sound_ready = false;

    const group_ptr = &e.groups.items[group_index].node;
    const data_source: *c.ma_data_source = @ptrCast(&voice.buffer_ref);
    const sound_flags: c.ma_uint32 = c.MA_SOUND_FLAG_NO_SPATIALIZATION | c.MA_SOUND_FLAG_NO_PITCH;
    if (c.ma_sound_init_from_data_source(&e.core, data_source, sound_flags, group_ptr, &voice.sound) != c.MA_SUCCESS) {
        clearVoice(voice);
        e.updateActiveVoiceCount();
        return Status.err_device;
    }

    voice.sound_ready = true;
    _ = c.ma_sound_seek_to_pcm_frame(&voice.sound, cursor);
    c.ma_sound_set_looping(&voice.sound, if (voice.loop) c.MA_TRUE else c.MA_FALSE);
    c.ma_sound_set_pan(&voice.sound, voice.pan);
    c.ma_sound_set_volume(&voice.sound, voice.volume);

    if (was_playing and c.ma_sound_start(&voice.sound) != c.MA_SUCCESS) {
        clearVoice(voice);
        e.updateActiveVoiceCount();
        return Status.err_device;
    }

    voice.group_id = group_id;
    return Status.ok;
}

pub fn setGroupVolume(engine: *Engine, group_id: u32, volume: f32) i32 {
    const e = engine;

    e.lock.lock();
    defer e.lock.unlock();

    const group_index: usize = @intCast(group_id);
    if (group_index >= e.groups.items.len) return Status.err_invalid;

    const clamped = clamp(volume, 0, 4);
    e.groups.items[group_index].volume = clamped;
    c.ma_sound_group_set_volume(&e.groups.items[group_index].node, clamped);
    return Status.ok;
}

pub fn setMasterVolume(engine: *Engine, volume: f32) i32 {
    const e = engine;

    e.lock.lock();
    defer e.lock.unlock();

    const clamped = clamp(volume, 0, 4);
    const result = c.ma_engine_set_volume(&e.core, clamped);
    if (result != c.MA_SUCCESS) return Status.err_device;

    e.master_volume = clamped;
    return Status.ok;
}

fn audioCallback(device_ptr: ?*c.ma_device, output_ptr: ?*anyopaque, input_ptr: ?*const anyopaque, frame_count: c.ma_uint32) callconv(.c) void {
    _ = input_ptr;
    if (device_ptr == null or output_ptr == null) return;

    const output_channels: usize = 2;
    const aligned_output: *align(@alignOf(f32)) anyopaque = @alignCast(output_ptr.?);
    const out = @as([*]f32, @ptrCast(aligned_output))[0 .. @as(usize, frame_count) * output_channels];

    const user_data = device_ptr.?.pUserData orelse {
        @memset(out, 0);
        return;
    };

    const engine: *Engine = @ptrCast(@alignCast(user_data));

    if (!engine.lock.tryLock()) {
        @memset(out, 0);
        incrementLockMisses(engine);
        return;
    }
    defer engine.lock.unlock();

    if (!engine.started) {
        @memset(out, 0);
        updateStatsFromBuffer(engine, out, @intCast(frame_count), 2);
        reapFinishedVoices(engine);
        return;
    }

    const status = readEngineStereo(engine, out, @intCast(frame_count));
    if (status != Status.ok) {
        @memset(out, 0);
    }

    updateStatsFromBuffer(engine, out, @intCast(frame_count), 2);
    reapFinishedVoices(engine);
}

pub fn mixToBuffer(engine: *Engine, out_ptr: ?[*]f32, frame_count: u32, channels: u8) i32 {
    if (out_ptr == null) return Status.err_invalid;
    if (channels == 0) return Status.err_invalid;

    const e = engine;
    e.lock.lock();
    defer e.lock.unlock();

    const out = @as([*]f32, @ptrCast(out_ptr.?))[0 .. @as(usize, frame_count) * @as(usize, channels)];
    @memset(out, 0);

    if (!e.started or frame_count == 0) {
        updateStatsFromBuffer(e, out, frame_count, channels);
        reapFinishedVoices(e);
        return Status.ok;
    }

    if (channels == 2) {
        const status = readEngineStereo(e, out, frame_count);
        if (status != Status.ok) return status;

        updateStatsFromBuffer(e, out, frame_count, channels);
        reapFinishedVoices(e);
        return Status.ok;
    }

    var remaining: usize = frame_count;
    var frame_offset: usize = 0;
    var temp_stereo: [2048]f32 = undefined;

    while (remaining > 0) {
        const chunk_frames: usize = @min(remaining, 1024);
        const stereo_slice = temp_stereo[0 .. chunk_frames * 2];
        const status = readEngineStereo(e, stereo_slice, @intCast(chunk_frames));
        if (status != Status.ok) return status;

        for (0..chunk_frames) |i| {
            const l = stereo_slice[i * 2];
            const r = stereo_slice[i * 2 + 1];
            const dst = (frame_offset + i) * @as(usize, channels);

            if (channels == 1) {
                out[dst] = clamp((l + r) * 0.5, -1, 1);
            } else {
                out[dst] = l;
                out[dst + 1] = r;
            }
        }

        frame_offset += chunk_frames;
        remaining -= chunk_frames;
    }

    updateStatsFromBuffer(e, out, frame_count, channels);
    reapFinishedVoices(e);
    return Status.ok;
}

pub fn getStats(engine: *Engine, out_stats: ?*Stats) i32 {
    if (out_stats == null) return Status.err_invalid;

    const e = engine;
    e.lock.lock();
    defer e.lock.unlock();

    e.stats.lock_misses = loadLockMisses(e);
    reapFinishedVoices(e);
    out_stats.?.* = e.stats;
    return Status.ok;
}
