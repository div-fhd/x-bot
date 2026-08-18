'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOTS = {
  posts: path.resolve(process.cwd(), 'data', 'media'),
  profiles: path.resolve(process.cwd(), 'data', 'uploads'),
};

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4',
  '.mov': 'video/quicktime', '.webm': 'video/webm', '.avi': 'video/x-msvideo',
};

const FILE_HASH_CACHE = new Map();

function encodeId(bucket, filename) {
  return Buffer.from(`${bucket}:${filename}`, 'utf8').toString('base64url');
}

function decodeId(id) {
  let decoded;
  try { decoded = Buffer.from(String(id || ''), 'base64url').toString('utf8'); } catch { return null; }
  const separator = decoded.indexOf(':');
  if (separator < 1) return null;
  const bucket = decoded.slice(0, separator);
  const filename = decoded.slice(separator + 1);
  if (!ROOTS[bucket] || !filename || path.basename(filename) !== filename) return null;
  const fullPath = path.resolve(ROOTS[bucket], filename);
  if (path.dirname(fullPath) !== ROOTS[bucket]) return null;
  return { bucket, filename, fullPath };
}

function classify(bucket, filename, mime) {
  if (bucket === 'posts') return mime.startsWith('video/') ? 'video' : 'post';
  if (filename.startsWith('avatar_')) return 'avatar';
  if (filename.startsWith('banner_')) return 'banner';
  return 'profile';
}

function contentHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function fileHash(fullPath) {
  const stat = fs.statSync(fullPath);
  const signature = `${stat.size}:${stat.mtimeMs}`;
  const cached = FILE_HASH_CACHE.get(fullPath);
  if (cached?.signature === signature) return cached.hash;
  const hash = contentHash(fs.readFileSync(fullPath));
  FILE_HASH_CACHE.set(fullPath, { signature, hash });
  return hash;
}

function buildContentIndex() {
  const index = new Map();
  for (const root of Object.values(ROOTS)) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const mime = MIME[path.extname(entry.name).toLowerCase()];
      if (!entry.isFile() || !mime?.startsWith('image/')) continue;
      const fullPath = path.join(root, entry.name);
      try { index.set(fileHash(fullPath), fullPath); } catch {}
    }
  }
  return index;
}

function saveUniqueBuffer({ bucket, buffer, filename, index = buildContentIndex() }) {
  if (!ROOTS[bucket]) throw new Error(`Unknown media bucket: ${bucket}`);
  const hash = contentHash(buffer);
  const existingPath = index.get(hash);
  if (existingPath && fs.existsSync(existingPath)) {
    return { path: existingPath, reused: true, hash };
  }
  fs.mkdirSync(ROOTS[bucket], { recursive: true });
  const safeName = path.basename(filename);
  const fullPath = path.join(ROOTS[bucket], safeName);
  fs.writeFileSync(fullPath, buffer);
  const stat = fs.statSync(fullPath);
  FILE_HASH_CACHE.set(fullPath, { signature:`${stat.size}:${stat.mtimeMs}`, hash });
  index.set(hash, fullPath);
  return { path: fullPath, reused: false, hash };
}

function list({ kind = 'all', limit = 250 } = {}) {
  const items = [];
  for (const [bucket, root] of Object.entries(ROOTS)) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      const mime = MIME[ext];
      if (!mime) continue;
      const fullPath = path.join(root, entry.name);
      const stat = fs.statSync(fullPath);
      const mediaKind = classify(bucket, entry.name, mime);
      if (kind === 'images' && !mime.startsWith('image/')) continue;
      if (kind === 'videos' && !mime.startsWith('video/')) continue;
      if (!['all', 'images', 'videos'].includes(kind) && mediaKind !== kind) continue;
      items.push({
        id: encodeId(bucket, entry.name),
        name: entry.name,
        path: fullPath,
        kind: mediaKind,
        mime,
        size: stat.size,
        createdAt: stat.mtime.toISOString(),
      });
    }
  }
  const unique = [];
  const seenHashes = new Set();
  for (const item of items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (!item.mime.startsWith('image/')) {
      unique.push(item);
      continue;
    }
    try {
      const hash = fileHash(item.path);
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);
      unique.push({ ...item, hash });
    } catch {}
  }
  return unique.slice(0, Math.max(1, Math.min(+limit || 250, 500)));
}

function resolve(id) {
  const decoded = decodeId(id);
  if (!decoded || !fs.existsSync(decoded.fullPath) || !fs.statSync(decoded.fullPath).isFile()) return null;
  const mime = MIME[path.extname(decoded.filename).toLowerCase()];
  return mime ? { ...decoded, mime } : null;
}

function remove(id) {
  const media = resolve(id);
  if (!media) return false;
  fs.unlinkSync(media.fullPath);
  FILE_HASH_CACHE.delete(media.fullPath);
  return true;
}

module.exports = { list, resolve, remove, buildContentIndex, saveUniqueBuffer };
