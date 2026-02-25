const std = @import("std");
const math = std.math;
const ansi = @import("ansi.zig");

const RGBA = ansi.RGBA;

/// Apply saturation adjustment to RGB values at specified cell coordinates.
/// triplets format: [x, y, saturation, x, y, saturation, ...]
/// saturation: 0.0 = grayscale, 1.0 = unchanged
/// strength: multiplier applied to all saturation values
pub fn saturate(self: anytype, triplets: []const f32, strength: f32) void {
    if (strength == 1.0 or triplets.len < 3) return;

    const width = self.width;
    const height = self.height;
    const width_f: f32 = @floatFromInt(width);
    const height_f: f32 = @floatFromInt(height);
    const fg = self.buffer.fg;
    const bg = self.buffer.bg;

    const len = triplets.len - (triplets.len % 3);
    var i: usize = 0;
    while (i < len) : (i += 3) {
        const x_f = triplets[i];
        const y_f = triplets[i + 1];
        const base_sat = triplets[i + 2];

        if (!math.isFinite(x_f) or !math.isFinite(y_f) or !math.isFinite(base_sat)) continue;
        if (x_f < 0 or y_f < 0 or x_f >= width_f or y_f >= height_f) continue;

        const saturation = base_sat * strength;
        const x: u32 = @intFromFloat(x_f);
        const y: u32 = @intFromFloat(y_f);
        const index = y * width + x;

        // Apply saturation to foreground
        const fg_r = fg[index][0];
        const fg_g = fg[index][1];
        const fg_b = fg[index][2];
        const fg_lum = 0.299 * fg_r + 0.587 * fg_g + 0.114 * fg_b;
        fg[index][0] = fg_lum + (fg_r - fg_lum) * saturation;
        fg[index][1] = fg_lum + (fg_g - fg_lum) * saturation;
        fg[index][2] = fg_lum + (fg_b - fg_lum) * saturation;

        // Apply saturation to background
        const bg_r = bg[index][0];
        const bg_g = bg[index][1];
        const bg_b = bg[index][2];
        const bg_lum = 0.299 * bg_r + 0.587 * bg_g + 0.114 * bg_b;
        bg[index][0] = bg_lum + (bg_r - bg_lum) * saturation;
        bg[index][1] = bg_lum + (bg_g - bg_lum) * saturation;
        bg[index][2] = bg_lum + (bg_b - bg_lum) * saturation;
    }
}

/// Apply saturation adjustment uniformly to all pixels in the buffer.
/// saturation: 0.0 = grayscale, 1.0 = unchanged
/// This is much faster than saturate() when applying uniform saturation.
pub fn saturateUniform(self: anytype, saturation: f32) void {
    if (saturation == 1.0) return;

    const width = self.width;
    const height = self.height;
    const size = width * height;
    const fg = self.buffer.fg;
    const bg = self.buffer.bg;

    var i: usize = 0;
    while (i < size) : (i += 1) {
        // Apply saturation to foreground
        const fg_r = fg[i][0];
        const fg_g = fg[i][1];
        const fg_b = fg[i][2];
        const fg_lum = 0.299 * fg_r + 0.587 * fg_g + 0.114 * fg_b;
        fg[i][0] = fg_lum + (fg_r - fg_lum) * saturation;
        fg[i][1] = fg_lum + (fg_g - fg_lum) * saturation;
        fg[i][2] = fg_lum + (fg_b - fg_lum) * saturation;

        // Apply saturation to background
        const bg_r = bg[i][0];
        const bg_g = bg[i][1];
        const bg_b = bg[i][2];
        const bg_lum = 0.299 * bg_r + 0.587 * bg_g + 0.114 * bg_b;
        bg[i][0] = bg_lum + (bg_r - bg_lum) * saturation;
        bg[i][1] = bg_lum + (bg_g - bg_lum) * saturation;
        bg[i][2] = bg_lum + (bg_b - bg_lum) * saturation;
    }
}

/// Apply gain to RGB values at specified cell coordinates.
/// triplets format: [x, y, gain_factor, x, y, gain_factor, ...]
/// gain_factor can be any f32 value: <1.0 darkens, 1.0 unchanged, >1.0 brightens, negative inverts
/// No clamping is performed - values can exceed [0, 1] range or go negative
pub fn gain(self: anytype, triplets: []const f32) void {
    if (triplets.len < 3) return;

    const width = self.width;
    const height = self.height;
    const width_f: f32 = @floatFromInt(width);
    const height_f: f32 = @floatFromInt(height);
    const fg = self.buffer.fg;
    const bg = self.buffer.bg;

    const len = triplets.len - (triplets.len % 3);
    var i: usize = 0;
    while (i < len) : (i += 3) {
        const x_f = triplets[i];
        const y_f = triplets[i + 1];
        const gain_factor = triplets[i + 2];

        if (!math.isFinite(x_f) or !math.isFinite(y_f) or !math.isFinite(gain_factor)) continue;
        if (x_f < 0 or y_f < 0 or x_f >= width_f or y_f >= height_f) continue;

        const x: u32 = @intFromFloat(x_f);
        const y: u32 = @intFromFloat(y_f);
        const index = y * width + x;

        fg[index][0] *= gain_factor;
        fg[index][1] *= gain_factor;
        fg[index][2] *= gain_factor;

        bg[index][0] *= gain_factor;
        bg[index][1] *= gain_factor;
        bg[index][2] *= gain_factor;
    }
}

/// Attenuate (dim) RGB values at specified cell coordinates.
/// triplets format: [x, y, attenuation, x, y, attenuation, ...]
/// attenuation: 0.0 = unchanged, 1.0 = black
/// strength: multiplier applied to all attenuation values
pub fn attenuate(self: anytype, triplets: []const f32, strength: f32) void {
    if (strength == 0 or triplets.len < 3) return;

    const width = self.width;
    const height = self.height;
    const width_f: f32 = @floatFromInt(width);
    const height_f: f32 = @floatFromInt(height);
    const fg = self.buffer.fg;
    const bg = self.buffer.bg;

    const len = triplets.len - (triplets.len % 3);
    var i: usize = 0;
    while (i < len) : (i += 3) {
        const x_f = triplets[i];
        const y_f = triplets[i + 1];
        const base_att = triplets[i + 2];

        if (!math.isFinite(x_f) or !math.isFinite(y_f) or !math.isFinite(base_att)) continue;
        if (x_f < 0 or y_f < 0 or x_f >= width_f or y_f >= height_f) continue;
        if (base_att <= 0) continue;

        const attenuation = base_att * strength;
        if (attenuation <= 0) continue;
        const factor: f32 = if (attenuation >= 1.0) 0.0 else 1.0 - attenuation;

        const x: u32 = @intFromFloat(x_f);
        const y: u32 = @intFromFloat(y_f);
        const index = y * width + x;

        fg[index][0] *= factor;
        fg[index][1] *= factor;
        fg[index][2] *= factor;

        bg[index][0] *= factor;
        bg[index][1] *= factor;
        bg[index][2] *= factor;
    }
}
