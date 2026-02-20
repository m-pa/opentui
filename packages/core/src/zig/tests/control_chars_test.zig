const std = @import("std");
const text_buffer = @import("../text-buffer.zig");
const text_buffer_view = @import("../text-buffer-view.zig");
const buffer = @import("../buffer.zig");
const gp = @import("../grapheme.zig");

const TextBuffer = text_buffer.TextBuffer;
const TextBufferView = text_buffer_view.TextBufferView;
const OptimizedBuffer = buffer.OptimizedBuffer;

// Test that control character 0x7f (DEL) is properly stored and rendered
// This verifies the textrenderable-like behavior where content containing
// 0x7f ends up in the buffer exactly as set
test "control char 0x7f - stored in text buffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    // Set text containing 0x7f (DEL character)
    const text_with_del = "helloworld\x7f";
    try tb.setText(text_with_del);

    // Verify the buffer contains the text with 0x7f by retrieving it
    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        20,
        1,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    try opt_buffer.clear(.{ 0.0, 0.0, 0.0, 1.0 }, 32);
    try opt_buffer.drawTextBuffer(view, 0, 0);

    // Check that "helloworld" is in positions 0-9
    const cell_h = opt_buffer.get(0, 0);
    try std.testing.expect(cell_h != null);
    try std.testing.expectEqual(@as(u32, 'h'), cell_h.?.char);

    const cell_d = opt_buffer.get(9, 0);
    try std.testing.expect(cell_d != null);
    try std.testing.expectEqual(@as(u32, 'd'), cell_d.?.char);

    // 0x7f (DEL) is a control character with width -1, so it should be
    // stored as a grapheme reference (using grapheme pool encoding)
    const cell_del = opt_buffer.get(10, 0);
    try std.testing.expect(cell_del != null);
    // The DEL character should be present (encoded as grapheme)
    try std.testing.expect(gp.isGraphemeChar(cell_del.?.char));

    // Verify the actual grapheme bytes are 0x7f
    const grapheme_id = gp.graphemeIdFromChar(cell_del.?.char);
    const global_pool = gp.initGlobalPool(std.testing.allocator);
    const grapheme_bytes = try global_pool.get(grapheme_id);
    try std.testing.expectEqual(@as(usize, 1), grapheme_bytes.len);
    try std.testing.expectEqual(@as(u8, 0x7f), grapheme_bytes[0]);
}

test "control char 0x7f - width calculation returns 0" {
    const utf8 = @import("../utf8.zig");

    // 0x7f should have width 0 (control character)
    const width = utf8.getWidthAt("\x7f", 0, 8, .unicode);
    try std.testing.expectEqual(@as(u32, 0), width);
}

test "control char 0x7f - does not advance column" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, pool, .unicode);
    defer tb.deinit();

    // Text with DEL between two words
    try tb.setText("hello\x7fworld");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        20,
        1,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    try opt_buffer.clear(.{ 0.0, 0.0, 0.0, 1.0 }, 32);
    try opt_buffer.drawTextBuffer(view, 0, 0);

    // "hello" should be at positions 0-4
    const cell_o = opt_buffer.get(4, 0);
    try std.testing.expect(cell_o != null);
    try std.testing.expectEqual(@as(u32, 'o'), cell_o.?.char);

    // 0x7f at position 5 (width 0)
    const cell_del = opt_buffer.get(5, 0);
    try std.testing.expect(cell_del != null);

    // "world" should start at position 6 (after the 0-width control char)
    const cell_w = opt_buffer.get(6, 0);
    try std.testing.expect(cell_w != null);
    try std.testing.expectEqual(@as(u32, 'w'), cell_w.?.char);
}
