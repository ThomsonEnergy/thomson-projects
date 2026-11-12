// The width and height of a JPEG, PNG or GIF from its bytes, without decoding it. Used by
// read-electricity-bill.js to turn away a bill photo too small to read before it is sent to the AI.
// Returns null for anything else (a PDF, a WebP) or a file it cannot make sense of: callers treat
// null as "size unknown" and let the file through.
function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG: the IHDR chunk holds width then height
  if (buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  // GIF: little-endian width and height after the header
  if (buf.toString('ascii', 0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  // JPEG: walk the segments to the frame header (SOF0 to SOF15, not DHT, JPG or DAC)
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      if (marker === 0xd9 || marker === 0xda) return null; // end of image or start of scan: no frame header found
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

module.exports = { imageSize };
