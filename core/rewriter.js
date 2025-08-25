import path, { posix } from 'path';

// 判斷是不是從包中引入的
export function isBareImport(spec) {
  return (
    !spec.startsWith('/') &&
    !spec.startsWith('./') &&
    !spec.startsWith('../') &&
    !spec.startsWith('http://') &&
    !spec.startsWith('https://')
  );
}

export function isRelativeImport(spec) {
  return spec.startsWith('./') || spec.startsWith('../');
}

// 改寫 import 成 /@modules/...
// ctx: { isModuleRequest?: boolean, urlBase?: string }
export function rewriteSpecifier(spec, ctx = {}) {
  if (ctx.isModuleRequest && isRelativeImport(spec)) {
    const base = ctx.urlBase || '/';
    const absUrl = posix.normalize(posix.join(base, spec));
    return absUrl;
  }

  if (isBareImport(spec)) {
    return `/@modules/${spec}`;
  }

  return spec;
}

export function rewriteImports(code, ctx) {
  const R = (s) => rewriteSpecifier(s, ctx);

  code = code.replace(
    /from\s+(['"])([^'"]+)\1/g,
    (m, q, s) => `from ${q}${R(s)}${q}`
  );
  // import "x"
  code = code.replace(
    /import\s+(['"])([^'"]+)\1/g,
    (m, q, s) => `import ${q}${R(s)}${q}`
  );
  // export ... from "x"
  code = code.replace(/export\s+[^;]*\s+from\s+(['"])([^'"]+)\1/g, (m, q, s) =>
    m.replace(s, R(s))
  );
  // dynamic import
  code = code.replace(
    /import\(\s*(['"])([^'"]+)\1\s*\)/g,
    (m, q, s) => `import(${q}${R(s)}${q})`
  );
  return code;
}

// JSON 包裝
export function wrapJsonAsJs(jsonText) {
  return `export default ${jsonText};\n`;
}

// CSS 包裝
export function wrapCssAsJs(cssText, id = '') {
  const cssStr = JSON.stringify(cssText);
  const idStr = JSON.stringify(id);
  return (
    `
    const css = ${cssStr};
    const id = ${idStr};
    let style = document.querySelector('style[data-mv-href=' + JSON.stringify(id) + ']');
    if (!style) {
      style = document.createElement('style');
      style.setAttribute('type', 'text/css');
      if (id) style.setAttribute('data-mv-href', id);
      document.head.appendChild(style);
    }
    style.innerHTML = css;
    export default css;
  `.trim() + '\n'
  );
}
