const std = @import("std");
const math = std.math;
const ansi = @import("ansi.zig");

const RGBA = ansi.RGBA;
const Vec4 = @Vector(4, f32);

/// Convert 3x3 RGB matrix to 4x4 RGBA matrix (pads with identity for alpha)
fn padMatrix3x3To4x4(matrix: []const f32) [16]f32 {
    var result: [16]f32 = undefined;
    // Row 0: R coefficients
    result[0] = matrix[0]; // m00: R->R
    result[1] = matrix[1]; // m01: G->R
    result[2] = matrix[2]; // m02: B->R
    result[3] = 0.0; // A->R (no alpha influence on red)
    // Row 1: G coefficients
    result[4] = matrix[3]; // m10: R->G
    result[5] = matrix[4]; // m11: G->G
    result[6] = matrix[5]; // m12: B->G
    result[7] = 0.0; // A->G (no alpha influence on green)
    // Row 2: B coefficients
    result[8] = matrix[6]; // m20: R->B
    result[9] = matrix[7]; // m21: G->B
    result[10] = matrix[8]; // m22: B->B
    result[11] = 0.0; // A->B (no alpha influence on blue)
    // Row 3: A coefficients (identity - alpha passes through)
    result[12] = 0.0; // R->A
    result[13] = 0.0; // G->A
    result[14] = 0.0; // B->A
    result[15] = 1.0; // A->A (preserve alpha)
    return result;
}

/// Apply 4x4 RGBA matrix to 4 pixels using SIMD
/// matrix: 16 floats in row-major order
/// pixels: array of 4 RGBA values (each is [4]f32)
/// strength: blend factor
/// result: output array of 4 RGBA values
fn applyMatrix4x4SIMD(matrix: *const [16]f32, r_vec: Vec4, g_vec: Vec4, b_vec: Vec4, a_vec: Vec4, strength_vec: Vec4) struct { r: Vec4, g: Vec4, b: Vec4, a: Vec4 } {
    // Load matrix rows as vectors
    const row0 = Vec4{ matrix[0], matrix[1], matrix[2], matrix[3] };
    const row1 = Vec4{ matrix[4], matrix[5], matrix[6], matrix[7] };
    const row2 = Vec4{ matrix[8], matrix[9], matrix[10], matrix[11] };
    const row3 = Vec4{ matrix[12], matrix[13], matrix[14], matrix[15] };

    // Matrix multiply: new_color = M * color
    // For each output channel, dot product of matrix row with input color
    const new_r = r_vec * @as(Vec4, @splat(row0[0])) + g_vec * @as(Vec4, @splat(row0[1])) + b_vec * @as(Vec4, @splat(row0[2])) + a_vec * @as(Vec4, @splat(row0[3]));
    const new_g = r_vec * @as(Vec4, @splat(row1[0])) + g_vec * @as(Vec4, @splat(row1[1])) + b_vec * @as(Vec4, @splat(row1[2])) + a_vec * @as(Vec4, @splat(row1[3]));
    const new_b = r_vec * @as(Vec4, @splat(row2[0])) + g_vec * @as(Vec4, @splat(row2[1])) + b_vec * @as(Vec4, @splat(row2[2])) + a_vec * @as(Vec4, @splat(row2[3]));
    const new_a = r_vec * @as(Vec4, @splat(row3[0])) + g_vec * @as(Vec4, @splat(row3[1])) + b_vec * @as(Vec4, @splat(row3[2])) + a_vec * @as(Vec4, @splat(row3[3]));

    // Blend: original + (new - original) * strength
    const out_r = r_vec + (new_r - r_vec) * strength_vec;
    const out_g = g_vec + (new_g - g_vec) * strength_vec;
    const out_b = b_vec + (new_b - b_vec) * strength_vec;
    const out_a = a_vec + (new_a - a_vec) * strength_vec;

    return .{ .r = out_r, .g = out_g, .b = out_b, .a = out_a };
}

/// Apply 4x4 RGBA matrix to single pixel (scalar fallback)
fn applyMatrix4x4Scalar(matrix: *const [16]f32, r: f32, g: f32, b: f32, a: f32, strength: f32) struct { r: f32, g: f32, b: f32, a: f32 } {
    const new_r = matrix[0] * r + matrix[1] * g + matrix[2] * b + matrix[3] * a;
    const new_g = matrix[4] * r + matrix[5] * g + matrix[6] * b + matrix[7] * a;
    const new_b = matrix[8] * r + matrix[9] * g + matrix[10] * b + matrix[11] * a;
    const new_a = matrix[12] * r + matrix[13] * g + matrix[14] * b + matrix[15] * a;

    return .{
        .r = r + (new_r - r) * strength,
        .g = g + (new_g - g) * strength,
        .b = b + (new_b - b) * strength,
        .a = a + (new_a - a) * strength,
    };
}

/// Apply 3x3 color matrix transformation to RGB values at specified cell coordinates.
/// matrix: [m00, m01, m02, m10, m11, m12, m20, m21, m22] - 9 values in row-major order
/// Internally converted to 4x4 RGBA matrix for SIMD optimization
/// cellMask format: [x, y, strength, x, y, strength, ...]
/// globalStrength: global multiplier applied to each cell's strength value (1.0 = no change)
/// No clamping is performed - output values may exceed [0, 1] range
pub fn colorMatrix(self: anytype, matrix: []const f32, cellMask: []const f32, globalStrength: f32) void {
    if (matrix.len < 9 or cellMask.len < 3) return;

    const width = self.width;
    const height = self.height;
    const width_f: f32 = @floatFromInt(width);
    const height_f: f32 = @floatFromInt(height);
    const fg = self.buffer.fg;
    const bg = self.buffer.bg;

    // Convert 3x3 to 4x4 for SIMD
    const mat4 = padMatrix3x3To4x4(matrix);

    const len = cellMask.len - (cellMask.len % 3);
    var i: usize = 0;
    while (i < len) : (i += 3) {
        const x_f = cellMask[i];
        const y_f = cellMask[i + 1];
        const cellStrength = cellMask[i + 2] * globalStrength;

        if (!math.isFinite(x_f) or !math.isFinite(y_f) or !math.isFinite(cellStrength)) continue;
        if (x_f < 0 or y_f < 0 or x_f >= width_f or y_f >= height_f) continue;
        if (cellStrength == 0.0) continue;

        const x: u32 = @intFromFloat(x_f);
        const y: u32 = @intFromFloat(y_f);
        const index = y * width + x;

        // Apply color matrix to foreground
        const fg_result = applyMatrix4x4Scalar(&mat4, fg[index][0], fg[index][1], fg[index][2], fg[index][3], cellStrength);
        fg[index][0] = fg_result.r;
        fg[index][1] = fg_result.g;
        fg[index][2] = fg_result.b;
        fg[index][3] = fg_result.a;

        // Apply color matrix to background
        const bg_result = applyMatrix4x4Scalar(&mat4, bg[index][0], bg[index][1], bg[index][2], bg[index][3], cellStrength);
        bg[index][0] = bg_result.r;
        bg[index][1] = bg_result.g;
        bg[index][2] = bg_result.b;
        bg[index][3] = bg_result.a;
    }
}

/// Apply 3x3 color matrix transformation uniformly to all pixels using SIMD.
/// matrix: [m00, m01, m02, m10, m11, m12, m20, m21, m22] - 9 values in row-major order
/// Internally converted to 4x4 RGBA matrix for SIMD optimization
/// strength: multiplier applied to matrix effect (0.0 = no effect, 1.0 = full matrix)
/// This uses 4-wide SIMD to process pixels in batches for maximum throughput.
/// No clamping is performed - output values may exceed [0, 1] range
pub fn colorMatrixUniform(self: anytype, matrix: []const f32, strength: f32) void {
    if (matrix.len < 9 or strength == 0.0) return;

    const width = self.width;
    const height = self.height;
    const size = width * height;
    const fg = self.buffer.fg;
    const bg = self.buffer.bg;

    // Convert 3x3 to 4x4 for SIMD
    const mat4 = padMatrix3x3To4x4(matrix);

    // Process 4 pixels at a time using SIMD
    const strength_vec: Vec4 = @splat(strength);
    var i: usize = 0;
    const simd_end = size - (size % 4);

    while (i < simd_end) : (i += 4) {
        // Load 4 pixels' RGBA values into separate channel vectors
        const fg_r = Vec4{ fg[i][0], fg[i + 1][0], fg[i + 2][0], fg[i + 3][0] };
        const fg_g = Vec4{ fg[i][1], fg[i + 1][1], fg[i + 2][1], fg[i + 3][1] };
        const fg_b = Vec4{ fg[i][2], fg[i + 1][2], fg[i + 2][2], fg[i + 3][2] };
        const fg_a = Vec4{ fg[i][3], fg[i + 1][3], fg[i + 2][3], fg[i + 3][3] };

        // Apply matrix transformation
        const fg_result = applyMatrix4x4SIMD(&mat4, fg_r, fg_g, fg_b, fg_a, strength_vec);

        // Store results back
        inline for (0..4) |j| {
            fg[i + j][0] = fg_result.r[j];
            fg[i + j][1] = fg_result.g[j];
            fg[i + j][2] = fg_result.b[j];
            fg[i + j][3] = fg_result.a[j];
        }

        // Process background
        const bg_r = Vec4{ bg[i][0], bg[i + 1][0], bg[i + 2][0], bg[i + 3][0] };
        const bg_g = Vec4{ bg[i][1], bg[i + 1][1], bg[i + 2][1], bg[i + 3][1] };
        const bg_b = Vec4{ bg[i][2], bg[i + 1][2], bg[i + 2][2], bg[i + 3][2] };
        const bg_a = Vec4{ bg[i][3], bg[i + 1][3], bg[i + 2][3], bg[i + 3][3] };

        const bg_result = applyMatrix4x4SIMD(&mat4, bg_r, bg_g, bg_b, bg_a, strength_vec);

        inline for (0..4) |j| {
            bg[i + j][0] = bg_result.r[j];
            bg[i + j][1] = bg_result.g[j];
            bg[i + j][2] = bg_result.b[j];
            bg[i + j][3] = bg_result.a[j];
        }
    }

    // Handle remaining pixels (0-3) with scalar fallback
    while (i < size) : (i += 1) {
        const fg_result = applyMatrix4x4Scalar(&mat4, fg[i][0], fg[i][1], fg[i][2], fg[i][3], strength);
        fg[i][0] = fg_result.r;
        fg[i][1] = fg_result.g;
        fg[i][2] = fg_result.b;
        fg[i][3] = fg_result.a;

        const bg_result = applyMatrix4x4Scalar(&mat4, bg[i][0], bg[i][1], bg[i][2], bg[i][3], strength);
        bg[i][0] = bg_result.r;
        bg[i][1] = bg_result.g;
        bg[i][2] = bg_result.b;
        bg[i][3] = bg_result.a;
    }
}
