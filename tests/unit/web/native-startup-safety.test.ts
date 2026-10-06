import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { nativeInitialProjectPromptTransform, nativeProviderLogoTransform } from '../../../tools/ui-oc-native-startup-transform.mjs';
const ROOT = process.cwd();
const ts: typeof import('typescript') = createRequire(resolve(ROOT, 'package.json'))('typescript');
const base = resolve(ROOT, 'vendor/openchamber-frontend/packages/ui/src');
const dialogs = readFileSync(resolve(base, 'components/session/SessionDialogs.tsx'), 'utf8');
const logos = readFileSync(resolve(base, 'hooks/useProviderLogo.ts'), 'utf8');
function prompt(host: object | null, shown = false, ready = true, projects: unknown[] = []) {
  const source = nativeInitialProjectPromptTransform(dialogs);
  const file = ts.createSourceFile('SessionDialogs.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  expect(ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true }).diagnostics ?? []).toEqual([]);
  const callbacks: string[] = [];
  const visit = (node: import('typescript').Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'React.useEffect' && node.arguments[0]?.getText(file).includes('if (hasShownInitialDirectoryPrompt ||')) {
      callbacks.push(node.arguments[0].getText(file));
      expect(node.arguments[1]?.getText(file).replace(/\s/g, '')).toBe('[hasShownInitialDirectoryPrompt,isHomeReady,projects.length,]');
    }
    ts.forEachChild(node, visit);
  };
  visit(file); expect(callbacks).toHaveLength(1);
  const shownSetter = vi.fn(); const dialogSetter = vi.fn();
  runInNewContext('(' + callbacks[0] + ')()', { piGetNativeHost: () => host, hasShownInitialDirectoryPrompt: shown, isHomeReady: ready, projects, setHasShownInitialDirectoryPrompt: shownSetter, setIsDirectoryDialogOpen: dialogSetter });
  return { shownSetter, dialogSetter };
}
function logo(host: object | null) {
  // Only Vite's glob result is substituted; execute the actual overlaid Source
  // hook/resolver/preloader body in VM. This is not real React/Vite/DOM proof.
  const glob = "const localLogoModules = import.meta.glob<string>('../assets/provider-logos/*.svg', {\n    eager: true,\n    import: 'default',\n});";
  expect(logos.split(glob)).toHaveLength(2);
  const source = nativeProviderLogoTransform(logos).replace(glob, "const localLogoModules = {'../assets/provider-logos/openai.svg':'/assets/owned-openai.svg'};");
  const imageSources: string[] = []; const effects: unknown[] = [];
  let state: string | undefined;
  const setState = (value: string | ((old: string) => string)) => { state = typeof value === 'function' ? value(state!) : value; };
  const exports: { useProviderLogo?: (id: string) => { src: string | null; hasLogo: boolean; onError(): void }; preloadProviderLogos?: (ids: string[]) => void } = {};
  const modules: Record<string, unknown> = {
    '@pi-native/surface-host': { getNativeSurfaceHost: () => host },
    react: { useState: (value: string) => { state ??= value; return [state, setState]; }, useCallback: (fn: unknown) => fn, useEffect: (_fn: unknown, deps: unknown) => { effects.push(deps); } },
  };
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, require: (name: string) => { if (!(name in modules)) throw new Error('Unmocked Source dependency: ' + name); return modules[name]; }, Image: class { set src(value: string) { imageSources.push(value); } } });
  return { render: (id: string) => exports.useProviderLogo!(id), preload: (ids: string[]) => exports.preloadProviderLogos!(ids), imageSources, effects };
}
describe('actual Source startup boundaries (AST callback/VM, not component browser)', () => {
  it('native active/closed never auto-opens first-project modal and keeps effect deps', () => {
    for (const host of [{}, { closed: true }]) { const p = prompt(host); expect(p.shownSetter).not.toHaveBeenCalled(); expect(p.dialogSetter).not.toHaveBeenCalled(); }
  });
  it('unbound web retains first-project prompt and each original readiness guard', () => {
    const p = prompt(null); expect(p.shownSetter).toHaveBeenCalledExactlyOnceWith(true); expect(p.dialogSetter).toHaveBeenCalledExactlyOnceWith(true);
    for (const [shown, ready, projects] of [[true, true, []], [false, false, []], [false, true, ['owned-project']]] as const) {
      const guarded = prompt(null, shown, ready, [...projects]); expect(guarded.shownSetter).not.toHaveBeenCalled(); expect(guarded.dialogSetter).not.toHaveBeenCalled();
    }
  });
  it('prompt overlay is bounded: explicit user directory callback untouched and drift rejected', () => {
    const out = nativeInitialProjectPromptTransform(dialogs);
    const user = 'return sessionEvents.onDirectoryRequest(() => {\n            setIsDirectoryDialogOpen(true);\n        });';
    expect(dialogs).toContain(user); expect(out).toContain(user);
    expect(() => nativeInitialProjectPromptTransform(out)).toThrow('already applied');
    expect(() => nativeInitialProjectPromptTransform(dialogs.replace('hasShownInitialDirectoryPrompt || !isHomeReady', 'changed || !isHomeReady'))).toThrow('anchor');
  });
  it('native bundled SVG and codex alias retain local rendering/preload/dedup', () => {
    const p = logo({}); expect(p.render('codex').src).toBe('/assets/owned-openai.svg'); p.preload(['codex', 'openai']); expect(p.imageSources).toEqual(['/assets/owned-openai.svg']);
  });
  it('native remote-only logo never returns image src or starts preload', () => {
    const p = logo({}); const r = p.render('deepseek'); expect(r.src).toBeNull(); expect(r.hasLogo).toBe(false); p.preload(['deepseek', 'xai']); expect(p.imageSources).toEqual([]);
  });
  it('native local-image failure cannot fall back to external image', () => {
    const p = logo({}); const r = p.render('openai'); expect(r.hasLogo).toBe(true); r.onError(); const failed = p.render('openai'); expect(failed.src).toBeNull(); expect(failed.hasLogo).toBe(false);
  });
  it('closed native host also suppresses remote resolver and hook fallback', () => {
    const p = logo({ closed: true }); expect(p.render('hyper').src).toBeNull(); p.preload(['hyper']); expect(p.imageSources).toEqual([]);
  });
  it('unbound original web retains remote rendering/preload and error transition', () => {
    const p = logo(null); const r = p.render('deepseek'); expect(r.src).toBe('https://models.dev/logos/deepseek.svg'); p.preload(['deepseek', 'deepseek']); expect(p.imageSources).toEqual(['https://models.dev/logos/deepseek.svg']); r.onError(); expect(p.render('deepseek').hasLogo).toBe(false);
  });
  it('native and unbound hooks keep effect call order and candidate deps, without early return', () => {
    for (const host of [{}, null]) { const p = logo(host); p.render('openai'); expect(p.effects).toEqual([[true, 'openai', 'openai']]); }
  });
  it('logo exact resolver/hook anchors reject drift, duplicate and reapplication', () => {
    expect(() => nativeProviderLogoTransform(nativeProviderLogoTransform(logos))).toThrow('already applied');
    expect(() => nativeProviderLogoTransform(logos.replace("    if (source === 'remote' && remoteResolvedId) {", '    if (false) {'))).toThrow('anchor');
    expect(() => nativeProviderLogoTransform(logos.replace('    return remoteResolvedId ?', '    return changed ?'))).toThrow('anchor');
    expect(() => nativeProviderLogoTransform(logos + "\n    if (source === 'remote' && remoteResolvedId) {\n")).toThrow('anchor');
  });
});
