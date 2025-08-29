import { posix } from 'path';

export function scanImports(code) {
  const specs = new Set();

  const reFrom = /(?:import|export)\s+[^'";]*?\bfrom\s*(['"])([^'"]+)\1/g;
  const reBare = /\bimport\s*(['"])([^'"]+)\1/g;
  const reDyn = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

  let m;
  while ((m = reFrom.exec(code))) specs.add(m[2]);
  while ((m = reBare.exec(code))) specs.add(m[2]);
  while ((m = reDyn.exec(code))) specs.add(m[2]);

  return Array.from(specs);
}

function isAbs(u) {
  return u.startsWith('/');
}

function isRel(u) {
  return u.startsWith('./') || u.startsWith('../');
}

function isHttp(u) {
  return u.startsWith('http://') || u.startsWith('https://');
}

export function normalizeImport(spec, importerUrlPath) {
  if (isHttp(spec)) return null;
  if (isAbs(spec)) return spec;
  if (isRel(spec)) {
    const base = posix.dirname(importerUrlPath);
    const joined = posix.normalize(posix.join(base, spec));
    return joined.startsWith('/') ? joined : '/' + joined;
  }
  return '/@modules/' + spec;
}

class ModuleNode {
  constructor(url) {
    this.url = url;
    // 這個模組 import 了那些模組
    this.deps = new Set();
    // 哪寫模組 import 了這個模組
    this.importers = new Set();
  }
}

export class ModuleGraph {
  constructor() {
    this.nodes = new Map();
  }

  ensure(url) {
    let n = this.nodes.get(url);
    if (!n) {
      n = new ModuleNode(url);
      this.nodes.set(url, n);
    }
    return n;
  }

  setDeps(url, depList) {
    const node = this.ensure(url);
    const next = new Set(depList);

    for (const d of node.deps) {
      if (!next.has(d)) {
        const depNode = this.nodes.get(d);
        if (depNode) depNode.importers.delete(url);
        node.deps.delete(d);
      }
    }

    for (const d of next) {
      node.deps.add(d);
      this.ensure(d).importers.add(url);
    }
  }

  recordFromCode(url, transformedCode) {
    const specs = scanImports(transformedCode);
    const deps = specs
      .map(s => normalizeImport(s, url))
      .filter(s => Boolean(s));

    this.setDeps(url, deps);
  }

  toJSON() {
    return {
      nodes: Array.from(this.nodes.values()).map(n => ({
        url: n.url,
        deps: Array.from(n.deps),
        importers: Array.from(n.importers)
      }))
    };
  }
}
