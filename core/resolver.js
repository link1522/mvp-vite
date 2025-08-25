import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 解析 /@modules/<包>
export function parseModuleRequest(urlPath) {
  const after = urlPath.slice('/@modules/'.length);
  const segs = after.split('/').filter((s) => Boolean(s));
  if (segs.length === 0) throw new Error('Invalid /@modules request');

  let moduleName, subPath;

  if (segs[0].startsWith('@')) {
    moduleName = segs.slice(0, 2).join('/');
    subPath = segs.slice(2).join('/');
  } else {
    moduleName = segs[0];
    subPath = segs.slice(1).join('/');
  }

  return { moduleName, subPath };
}

export function ensureJsLike(p) {
  if (path.extname(p)) return p;
  if (fs.existsSync(p + '.js')) return p + '.js';
  else if (fs.existsSync(p + '.mjs')) return p + '.mjs';
  else if (fs.existsSync(p + '.ts')) return p + '.ts';
}

export function resolveModuleEntry(moduleName, subPath) {
  const projectRoot = path.resolve(__dirname, '..');
  const pkgDir = path.join(projectRoot, 'node_modules', moduleName);
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(`Cannot find package.json for ${moduleName}`);
  }
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));

  // 如果有子路徑，加上副檔名直接指向檔案
  if (subPath) {
    return ensureJsLike(path.join(pkgDir, subPath));
  }

  // 無子路徑，挑 ESM 友善的欄位
  let candidate = null;
  if (typeof pkg.exports === 'string') candidate = pkg.exports;
  else if (
    pkg.exports &&
    typeof pkg.exports === 'object' &&
    typeof pkg.exports['.'] === 'string'
  )
    candidate = pkg.exports['.'];
  else if (pkg.module) candidate = pkg.module;
  else if (typeof pkg.browser === 'string') candidate = pkg.browser;
  else if (typeof pkg.main === 'string') candidate = pkg.main;
  else candidate = 'index.js';

  return path.join(pkgDir, candidate);
}

// 防止跳脫到專案外
export function safeJoin(root, urlPath) {
  const normalized = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/g, '');
  return path.join(root, normalized);
}
