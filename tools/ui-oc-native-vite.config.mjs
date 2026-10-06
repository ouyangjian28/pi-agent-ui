// Compile the literal original App with the bounded behavior overlays.
// This is NOT owner bootstrap, a running UI, an OpenCode backend or acceptance.
import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import original from '../vendor/openchamber-frontend/packages/web/vite.config.ts';
import { nativeModelControlsTransform } from './ui-oc-native-model-transform.mjs';
import { nativeMessageOrderTransform } from './ui-oc-native-order-transform.mjs';
import { nativeRuntimeFetchTransform } from './ui-oc-native-fetch-transform.mjs';
import { nativeOriginalEntryTransform, nativeReadOnlyComposerTransform, nativeCompanionEventsTransform } from './ui-oc-native-startup-transform.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshot = path.join(root, 'vendor/openchamber-frontend');
const cache = createRequire(path.join(snapshot, 'package.json'));
const output = process.env.PI_OC_NATIVE_BUILD_DIR;
const outputRoot = path.join(root, '.pi/oc-bridge-checks');
if (!output || !path.isAbsolute(output) || !path.resolve(output).startsWith(outputRoot + path.sep)) {
  throw new Error('PI_OC_NATIVE_BUILD_DIR must be an absolute fresh ignored candidate output below .pi/oc-bridge-checks');
}
if (existsSync(output)) throw new Error('Refuse overwrite of original-App build evidence');
// All source and native overlay imports share the ORIGINAL cached React.
// Exact matches avoid appending /jsx-runtime to index.js. Other react-dom
// subpaths retain Vite's browser export conditions, not Node's server alias.
const reactSpecifiers = [
  'react/jsx-runtime', 'react/jsx-dev-runtime', 'react/compiler-runtime',
  'react-dom/client', 'react-dom', 'react',
];
const reactAliases = reactSpecifiers.map(specifier => ({
  find: new RegExp('^' + specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
  replacement: realpathSync(cache.resolve(specifier)),
}));
const targets = new Map([
  [path.join(snapshot, 'packages/ui/src/components/chat/ModelControls.tsx'), nativeModelControlsTransform],
  [path.join(snapshot, 'packages/ui/src/sync/message-ordering.ts'), nativeMessageOrderTransform],
  [path.join(snapshot, 'packages/ui/src/lib/runtime-fetch.ts'), nativeRuntimeFetchTransform],
  [path.join(snapshot, 'packages/ui/src/lib/openchamberEvents.ts'), nativeCompanionEventsTransform],
  [path.join(snapshot, 'packages/ui/src/components/chat/ChatInput.tsx'), nativeReadOnlyComposerTransform],
  [path.join(snapshot, 'packages/web/src/main.tsx'), source => nativeOriginalEntryTransform(source, 'desktop')],
  [path.join(snapshot, 'packages/web/src/mobile-main.tsx'), source => nativeOriginalEntryTransform(source, 'mobile')],
  [path.join(snapshot, 'packages/web/src/mini-chat-main.tsx'), source => nativeOriginalEntryTransform(source, 'mini')],
]);
const transformed = new Map();
const nativeOverlay = {
  name: 'pi-literal-original-native-behavior-overlays',
  enforce: 'pre',
  transform(source, id) {
    const clean = id.split('?')[0];
    const apply = targets.get(clean);
    if (!apply) return null;
    if (transformed.has(clean)) throw new Error('Duplicate original native-overlay module transform');
    const code = apply(source); transformed.set(clean, true);
    return { code, map: null };
  },
  generateBundle() {
    const moduleIds = [...this.getModuleIds()].map(id => id.replace(/^\0/, '').split('?')[0]);
    const packageRoots = name => [...new Set(moduleIds.flatMap(id => {
      const marker = '/node_modules/' + name + '/';
      const index = id.lastIndexOf(marker);
      return index < 0 ? [] : [id.slice(0, index + marker.length - 1)];
    }))];
    const reactRoots = packageRoots('react');
    const reactDomRoots = packageRoots('react-dom');
    if (reactRoots.length !== 1 || reactDomRoots.length !== 1) throw new Error('Original/native App must collect exactly one React and ReactDOM package root');
    for (const target of targets.keys()) {
      if (!transformed.has(target)) throw new Error('Original App did not collect native-overlay target: ' + path.relative(snapshot, target));
    }
    this.emitFile({ type: 'asset', fileName: 'native-overlays.json', source: JSON.stringify({
      compiledOriginalApp: true,
      nativeOwnerMounted: false,
      nativeComposerActionsMounted: false,
      nativeSdkFetchOverlayCompiled: true,
      nativeSdkFetchInstalled: false,
      nativeOriginalEntryCompiled: true,
      nativeSourceComposerReadOnly: true,
      nativeCompanionEventsInactiveCompiled: true,
      originalSourceModified: false,
      backendStarted: false,
      overlayTargets: [...transformed.keys()].map(file => path.relative(snapshot, file)),
      reactAliases: reactSpecifiers,
      reactPackageRootCount: reactRoots.length,
      reactDomPackageRootCount: reactDomRoots.length,
      proofScope: 'Compiler/collection only. Not native-connected App or UI send proof.',
    }, null, 2) + '\n' });
  },
};

export default {
  ...original,
  base: './',
  // Before React compiler, so literal once-anchors see untouched source.
  plugins: [nativeOverlay, ...original.plugins],
  resolve: {
    ...original.resolve,
    alias: [
      ...reactAliases,
      { find: '@pi-native/model-controls', replacement: path.join(root, 'apps/web/src/oc-bridge/native-model-controls.tsx') },
      { find: '@pi-native/message-ordering', replacement: path.join(root, 'apps/web/src/oc-bridge/native-message-ordering.ts') },
      { find: '@pi-native/sdk-fetch', replacement: path.join(root, 'apps/web/src/oc-bridge/native-sdk-fetch.ts') },
      { find: '@pi-native/surface-host', replacement: path.join(root, 'apps/web/src/oc-bridge/native-surface-host.ts') },
      { find: '@pi-native/original-startup', replacement: path.join(root, 'apps/web/src/oc-bridge/native-original-startup.ts') },
      { find: '@pi-native/original-renderer', replacement: path.join(root, 'tools/ui-oc-native-renderer.tsx') },
      ...original.resolve.alias,
    ],
    dedupe: [...new Set([...(original.resolve.dedupe ?? []), 'react', 'react-dom'])],
  },
  // No original OpenCode proxy is available in this candidate configuration.
  server: { ...original.server, proxy: {}, host: '127.0.0.1' },
  build: { ...original.build, outDir: output, emptyOutDir: false },
};
