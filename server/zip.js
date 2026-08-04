'use strict';
/** 极简 ZIP 打包（deflate 压缩，失败/无收益自动回退 store，UTF-8 文件名）。files: [{path, data(Buffer)}] → Buffer */
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [time, date];
}

function makeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const [dosTime, dosDate] = dosDateTime(now);

  for (const f of files) {
    const nameBuf = Buffer.from(f.path, 'utf8');
    const data = f.data;
    const crc = crc32(data);

    // 尝试 deflate 压缩；压缩后更大（已压缩的图片/字体等）或压缩失败时回退 store
    let stored = data, method = 0;
    try {
      const deflated = zlib.deflateRawSync(data, { level: 6 });
      if (deflated.length < data.length) { stored = deflated; method = 8; }
    } catch (e) { /* 回退 store */ }

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);      // local file header signature
    lh.writeUInt16LE(20, 4);              // version needed
    lh.writeUInt16LE(0x0800, 6);          // flags: UTF-8 names
    lh.writeUInt16LE(method, 8);          // compression method: 8=deflate, 0=store
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(stored.length, 18);  // compressed size
    lh.writeUInt32LE(data.length, 22);    // uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, nameBuf, stored);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);      // central directory signature
    cd.writeUInt16LE(20, 4);              // version made by
    cd.writeUInt16LE(20, 6);              // version needed
    cd.writeUInt16LE(0x0800, 8);          // flags
    cd.writeUInt16LE(method, 10);         // method
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(stored.length, 20);  // compressed size
    cd.writeUInt32LE(data.length, 24);    // uncompressed size
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);              // extra len
    cd.writeUInt16LE(0, 32);              // comment len
    cd.writeUInt16LE(0, 34);              // disk number
    cd.writeUInt16LE(0, 36);              // internal attrs
    cd.writeUInt32LE(0, 38);              // external attrs
    cd.writeUInt32LE(offset, 42);         // local header offset
    central.push(cd, nameBuf);

    offset += 30 + nameBuf.length + stored.length;
  }

  const cdStart = offset;
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);               // disk
  eocd.writeUInt16LE(0, 6);               // cd disk
  eocd.writeUInt16LE(files.length, 8);    // entries this disk
  eocd.writeUInt16LE(files.length, 10);   // total entries
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, ...central, eocd]);
}

module.exports = { makeZip, crc32 };
