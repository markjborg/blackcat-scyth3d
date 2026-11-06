import { crc32, deflateSync } from "node:zlib";

/** Uncompressed-filter PNG, RGB, no external image library. */
export function encodeRgbPng(width: number, height: number, rgb: Uint8Array): Buffer {
  if (rgb.length !== width * height * 3) {
    throw new Error("PNG buffer size does not match the image.");
  }
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const dest = y * (width * 3 + 1);
    raw[dest] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, dest + 1);
  }
  const idat = deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = crc32(Buffer.concat([head.subarray(4), data]));
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([head, data, tail]);
}
