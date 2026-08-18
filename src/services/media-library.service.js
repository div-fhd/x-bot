'use strict';
const fs = require('fs');
const path = require('path');

const ROOTS = {
  posts: path.resolve(process.cwd(), 'data', 'media'),
  profiles: path.resolve(process.cwd(), 'data', 'uploads'),
};

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4',
  '.mov': 'video/quicktime', '.webm': 'video/webm', '.avi': 'video/x-msvideo',
};

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
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.max(1, Math.min(+limit || 250, 500)));
}

function resolve(id) {
  const decoded = decodeId(id);
  if (!decoded || !fs.existsSync(decoded.fullPath) || !fs.statSync(decoded.fullPath).isFile()) return null;
  const mime = MIME[path.extname(decoded.filename).toLowerCase()];
  return mime ? { ...decoded, mime } : null;
}

module.exports = { list, resolve };
