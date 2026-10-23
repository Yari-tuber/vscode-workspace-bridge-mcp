'use strict';
const { BridgeError, assertSafeContent } = require('./security');
const MAX_FILE_BYTES = 512 * 1024;
function fail(code, message) { throw new BridgeError(code, message); }
function assertTextSize(text) {
  assertSafeContent(text);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail('INVALID_TEXT', 'Text must not contain an unpaired UTF-16 surrogate.');
    } else if (code >= 0xdc00 && code <= 0xdfff) fail('INVALID_TEXT', 'Text must not contain an unpaired UTF-16 surrogate.');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) fail('FILE_TOO_LARGE', 'The proposed file must stay within 512 KiB.');
}
function lineOffsets(text) {
  const lines = []; let start = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === '\n' || text[i] === '\r') {
    lines.push({ start, end: i });
    if (text[i] === '\r' && text[i + 1] === '\n') i++;
    start = i + 1;
  }
  lines.push({ start, end: text.length });
  return lines;
}
function offsetAt(text, lines, position) {
  if (!position || !Number.isInteger(position.line) || !Number.isInteger(position.character) || position.line < 0 || position.character < 0 || position.line >= lines.length) fail('INVALID_RANGE', 'Use a valid 0-based line and UTF-16 character position.');
  const line = lines[position.line];
  if (position.character > line.end - line.start) fail('INVALID_RANGE', 'The edit position is beyond the end of its line.');
  const offset = line.start + position.character;
  const before = text.charCodeAt(offset - 1), after = text.charCodeAt(offset);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) fail('INVALID_RANGE', 'An edit cannot split a UTF-16 surrogate pair.');
  return offset;
}
function applyTextEdits(text, edits) {
  assertTextSize(text);
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 50) fail('INVALID_EDITS', 'Supply 1 to 50 edits against the same original file snapshot.');
  const lines = lineOffsets(text);
  const normalized = edits.map(edit => {
    if (!edit || typeof edit.text !== 'string') fail('INVALID_EDITS', 'Every edit requires a range and replacement text.');
    assertTextSize(edit.text);
    const start = offsetAt(text, lines, edit.range?.start);
    const end = offsetAt(text, lines, edit.range?.end);
    if (end < start) fail('INVALID_RANGE', 'The edit range must not be reversed.');
    return { start, end, text: edit.text };
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < normalized.length; i++) {
    const previous = normalized[i - 1], current = normalized[i];
    if (current.start < previous.end || (current.start === previous.start && current.end === current.start && previous.end === previous.start)) fail('OVERLAPPING_EDITS', 'Edit ranges must not overlap or insert at the same position twice.');
  }
  let proposed = text;
  for (const edit of [...normalized].sort((a, b) => b.start - a.start || b.end - a.end)) proposed = proposed.slice(0, edit.start) + edit.text + proposed.slice(edit.end);
  assertTextSize(proposed);
  return proposed;
}
function replaceUniqueText(text, oldText, newText) {
  assertTextSize(text); assertTextSize(oldText); assertTextSize(newText);
  if (!oldText) fail('INVALID_MATCH', 'oldText must not be empty.');
  const start = text.indexOf(oldText);
  if (start < 0) fail('MATCH_NOT_FOUND', 'No exact match. Read the file again, preserving its line endings.');
  if (text.indexOf(oldText, start + 1) >= 0) fail('AMBIGUOUS_MATCH', 'The text occurs more than once. Supply a longer unique snippet or use apply_text_edits.');
  const proposed = text.slice(0, start) + newText + text.slice(start + oldText.length);
  assertTextSize(proposed);
  return proposed;
}
module.exports = { applyTextEdits, replaceUniqueText, assertTextSize };
