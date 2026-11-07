/**
 * 打包成可分发 zip：只装扩展真正需要的文件（manifest + src + icons），
 * 不把 tests / tools / node_modules / 开发文档塞进去。
 *
 * 不引 archiver / jszip，自己写 ZIP 结构（deflateRaw + CRC32），保持零依赖。
 * 用法：npm run build
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

const INCLUDE = ['manifest.json', 'src', 'icons'];
const DIST = path.join(root, 'dist');

/* ------------------------------------------------------------------ ZIP */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function walk(relPath, out = []) {
  const abs = path.join(root, relPath);
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) {
      if (name.startsWith('.')) continue;
      walk(path.join(relPath, name), out);
    }
  } else {
    out.push(relPath.split(path.sep).join('/'));
  }
  return out;
}

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const name of entries) {
    const data = fs.readFileSync(path.join(root, name));
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const method = useDeflate ? 8 : 0;
    const mtime = 0; // 固定时间戳，让打包结果可复现

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);       // version needed
    local.writeUInt16LE(0x0800, 6);   // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);       // time
    local.writeUInt16LE(0x21, 12);    // date(1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);

    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, cdBuf, end]);
}

/* ------------------------------------------------------------------- 主 */

const entries = INCLUDE.flatMap((p) => walk(p));
if (!entries.includes('manifest.json')) {
  console.error('打包失败：manifest.json 没进去');
  process.exit(1);
}

const zip = buildZip(entries);
fs.mkdirSync(DIST, { recursive: true });
const out = path.join(DIST, `bing-clean-${manifest.version}.zip`);
fs.writeFileSync(out, zip);

const size = (n) => (n / 1024).toFixed(1) + ' KB';
console.log(`打包完成：${path.relative(root, out)}  (${size(zip.length)})`);
console.log(`包含 ${entries.length} 个文件：`);
for (const e of entries) {
  const s = fs.statSync(path.join(root, e)).size;
  console.log(`  ${e.padEnd(42)} ${size(s).padStart(9)}`);
}
