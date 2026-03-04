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
/// strength: multiplier applied to saturation value
/// This is much faster than saturate() when applying uniform saturation.
pub fn saturateUniform(self: anytype, saturation: f32, strength: f32) void {
    if (strength == 0 or saturation == 1.0) return;

    const width = self.width;
    const height = self.height;
    const size = width * height;
    const fg = self.buffer.fg;
    const bg = self.buffer.bg;

    var i: usize = 0;
    while (i < size) : (i += 1) {
        const adjusted_sat = 1.0 + (saturation - 1.0) * strength;

        // Apply saturation to foreground
        const fg_r = fg[i][0];
        const fg_g = fg[i][1];
        const fg_b = fg[i][2];
        const fg_lum = 0.299 * fg_r + 0.587 * fg_g + 0.114 * fg_b;
        fg[i][0] = fg_lum + (fg_r - fg_lum) * adjusted_sat;
        fg[i][1] = fg_lum + (fg_g - fg_lum) * adjusted_sat;
        fg[i][2] = fg_lum + (fg_b - fg_lum) * adjusted_sat;

        // Apply saturation to background
        const bg_r = bg[i][0];
        const bg_g = bg[i][1];
        const bg_b = bg[i][2];
        const bg_lum = 0.299 * bg_r + 0.587 * bg_g + 0.114 * bg_b;
        bg[i][0] = bg_lum + (bg_r - bg_lum) * adjusted_sat;
        bg[i][1] = bg_lum + (bg_g - bg_lum) * adjusted_sat;
        bg[i][2] = bg_lum + (bg_b - bg_lum) * adjusted_sat;
    }
}

/// Apply gain to RGB values at specified cell coordinates.
/// triplets format: [x, y, gain_factor, x, y, gain_factor, ...]
/// gain_factor can be any f32 value: <1.0 darkens, 1.0 unchanged, >1.0 brightens, negative inverts
/// strength: multiplier applied to all gain values
/// No clamping is performed - values can exceed [0, 1] range or go negative
pub fn gain(self: anytype, triplets: []const f32, strength: f32) void {
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
        const base_gain = triplets[i + 2];

        if (!math.isFinite(x_f) or !math.isFinite(y_f) or !math.isFinite(base_gain)) continue;
        if (x_f < 0 or y_f < 0 or x_f >= width_f or y_f >= height_f) continue;

        const gain_factor = base_gain * strength;
        if (gain_factor == 1.0) continue;

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

/// Apply brightness adjustment to RGB values at specified cell coordinates with clamping.
/// triplets format: [x, y, brightness_factor, x, y, brightness_factor, ...]
/// brightness_factor: <1.0 darkens, 1.0 unchanged, >1.0 brightens
/// strength: multiplier applied to all brightness values
/// Values are clamped to [0, 1] range after adjustment.
pub fn brightness(self: anytype, triplets: []const f32, strength: f32) void {
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
        const base_brightness = triplets[i + 2];

        if (!math.isFinite(x_f) or !math.isFinite(y_f) or !math.isFinite(base_brightness)) continue;
        if (x_f < 0 or y_f < 0 or x_f >= width_f or y_f >= height_f) continue;

        const brightness_factor = base_brightness * strength;
        if (brightness_factor == 1.0) continue;

        const x: u32 = @intFromFloat(x_f);
        const y: u32 = @intFromFloat(y_f);
        const index = y * width + x;

        // Apply brightness with clamping to [0, 1]
        fg[index][0] = @min(1.0, @max(0.0, fg[index][0] * brightness_factor));
        fg[index][1] = @min(1.0, @max(0.0, fg[index][1] * brightness_factor));
        fg[index][2] = @min(1.0, @max(0.0, fg[index][2] * brightness_factor));

        bg[index][0] = @min(1.0, @max(0.0, bg[index][0] * brightness_factor));
        bg[index][1] = @min(1.0, @max(0.0, bg[index][1] * brightness_factor));
        bg[index][2] = @min(1.0, @max(0.0, bg[index][2] * brightness_factor));
    }
}

/// Apply brightness adjustment uniformly to all pixels in the buffer.
/// brightness_factor: <1.0 darkens, 1.0 unchanged, >1.0 brightens
/// strength: multiplier applied to brightness value
/// Values are clamped to [0, 1] range after adjustment.
/// This is much faster than brightness() when applying uniform brightness.
pub fn brightnessUniform(self: anytype, brightness_factor: f32, strength: f32) void {
    if (strength == 0 or brightness_factor == 1.0) return;

    const width = self.width;
    const height = self.height;
    const size = width * height;
    const fg = self.buffer.fg;
    const bg = self.buffer.bg;

    var i: usize = 0;
    while (i < size) : (i += 1) {
        const adjusted_brightness = 1.0 + (brightness_factor - 1.0) * strength;

        // Apply brightness with clamping to [0, 1] for foreground
        fg[i][0] = @min(1.0, @max(0.0, fg[i][0] * adjusted_brightness));
        fg[i][1] = @min(1.0, @max(0.0, fg[i][1] * adjusted_brightness));
        fg[i][2] = @min(1.0, @max(0.0, fg[i][2] * adjusted_brightness));

        // Apply brightness with clamping to [0, 1] for background
        bg[i][0] = @min(1.0, @max(0.0, bg[i][0] * adjusted_brightness));
        bg[i][1] = @min(1.0, @max(0.0, bg[i][1] * adjusted_brightness));
        bg[i][2] = @min(1.0, @max(0.0, bg[i][2] * adjusted_brightness));
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

/// Apply 3x3 color matrix transformation to RGB values at specified cell coordinates.
/// matrix: [m00, m01, m02, m10, m11, m12, m20, m21, m22] - 9 values in row-major order
/// triplets format: [x, y, strength, x, y, strength, ...]
/// strength: multiplier applied to matrix effect (0.0 = no effect, 1.0 = full matrix)
/// No clamping is performed - output values may exceed [0, 1] range
pub fn colorMatrix(self: anytype, matrix: []const f32, triplets: []const f32) void {
    if (matrix.len < 9 or triplets.len < 3) return;

    const width = self.width;
    const height = self.height;
    const width_f: f32 = @floatFromInt(width);
    const height_f: f32 = @floatFromInt(height);
    const fg = self.buffer.fg;
    const bg = self.buffer.bg;

    // Unpack matrix coefficients
    const m00 = matrix[0];
    const m01 = matrix[1];
    const m02 = matrix[2];
    const m10 = matrix[3];
    const m11 = matrix[4];
    const m12 = matrix[5];
    const m20 = matrix[6];
    const m21 = matrix[7];
    const m22 = matrix[8];

    const len = triplets.len - (triplets.len % 3);
    var i: usize = 0;
    while (i < len) : (i += 3) {
        const x_f = triplets[i];
        const y_f = triplets[i + 1];
        const strength = triplets[i + 2];

        if (!math.isFinite(x_f) or !math.isFinite(y_f) or !math.isFinite(strength)) continue;
        if (x_f < 0 or y_f < 0 or x_f >= width_f or y_f >= height_f) continue;
        if (strength == 0.0) continue;

        const x: u32 = @intFromFloat(x_f);
        const y: u32 = @intFromFloat(y_f);
        const index = y * width + x;

        // Apply color matrix to foreground with strength blending
        const fg_r = fg[index][0];
        const fg_g = fg[index][1];
        const fg_b = fg[index][2];

        const new_fg_r = m00 * fg_r + m01 * fg_g + m02 * fg_b;
        const new_fg_g = m10 * fg_r + m11 * fg_g + m12 * fg_b;
        const new_fg_b = m20 * fg_r + m21 * fg_g + m22 * fg_b;

        // Blend between original and transformed based on strength
        fg[index][0] = fg_r + (new_fg_r - fg_r) * strength;
        fg[index][1] = fg_g + (new_fg_g - fg_g) * strength;
        fg[index][2] = fg_b + (new_fg_b - fg_b) * strength;

        // Apply color matrix to background with strength blending
        const bg_r = bg[index][0];
        const bg_g = bg[index][1];
        const bg_b = bg[index][2];

        const new_bg_r = m00 * bg_r + m01 * bg_g + m02 * bg_b;
        const new_bg_g = m10 * bg_r + m11 * bg_g + m12 * bg_b;
        const new_bg_b = m20 * bg_r + m21 * bg_g + m22 * bg_b;

        // Blend between original and transformed based on strength
        bg[index][0] = bg_r + (new_bg_r - bg_r) * strength;
        bg[index][1] = bg_g + (new_bg_g - bg_g) * strength;
        bg[index][2] = bg_b + (new_bg_b - bg_b) * strength;
    }
}

/// Apply 3x3 color matrix transformation uniformly to all pixels.
/// matrix: [m00, m01, m02, m10, m11, m12, m20, m21, m22] - 9 values in row-major order
/// strength: multiplier applied to matrix effect (0.0 = no effect, 1.0 = full matrix)
/// This is much faster than colorMatrix() when applying uniform transformation.
/// No clamping is performed - output values may exceed [0, 1] range
pub fn colorMatrixUniform(self: anytype, matrix: []const f32, strength: f32) void {
    if (matrix.len < 9 or strength == 0.0) return;

    const width = self.width;
    const height = self.height;
    const size = width * height;
    const fg = self.buffer.fg;
    const bg = self.buffer.bg;

    // Unpack matrix coefficients
    const m00 = matrix[0];
    const m01 = matrix[1];
    const m02 = matrix[2];
    const m10 = matrix[3];
    const m11 = matrix[4];
    const m12 = matrix[5];
    const m20 = matrix[6];
    const m21 = matrix[7];
    const m22 = matrix[8];

    var i: usize = 0;
    while (i < size) : (i += 1) {
        // Apply color matrix to foreground with strength blending
        const fg_r = fg[i][0];
        const fg_g = fg[i][1];
        const fg_b = fg[i][2];

        const new_fg_r = m00 * fg_r + m01 * fg_g + m02 * fg_b;
        const new_fg_g = m10 * fg_r + m11 * fg_g + m12 * fg_b;
        const new_fg_b = m20 * fg_r + m21 * fg_g + m22 * fg_b;

        fg[i][0] = fg_r + (new_fg_r - fg_r) * strength;
        fg[i][1] = fg_g + (new_fg_g - fg_g) * strength;
        fg[i][2] = fg_b + (new_fg_b - fg_b) * strength;

        // Apply color matrix to background with strength blending
        const bg_r = bg[i][0];
        const bg_g = bg[i][1];
        const bg_b = bg[i][2];

        const new_bg_r = m00 * bg_r + m01 * bg_g + m02 * bg_b;
        const new_bg_g = m10 * bg_r + m11 * bg_g + m12 * bg_b;
        const new_bg_b = m20 * bg_r + m21 * bg_g + m22 * bg_b;

        bg[i][0] = bg_r + (new_bg_r - bg_r) * strength;
        bg[i][1] = bg_g + (new_bg_g - bg_g) * strength;
        bg[i][2] = bg_b + (new_bg_b - bg_b) * strength;
    }
}
