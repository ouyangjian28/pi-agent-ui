import { build } from 'vite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = join(root, '.pi/hybrid-preview/dist');
await build({ configFile: false, root: join(root, 'apps/web'), build: {
  outDir: scratch, emptyOutDir: true,
  rollupOptions: { input: join(root, 'apps/web/hybrid-preview.html') },
} });
let html = await readFile(join(scratch, 'hybrid-preview.html'), 'utf8');
const jsTag = /<script[^>]+src="([^"]+)"[^>]*><\/script>/;
const cssTag = /<link[^>]+href="([^"]+)"[^>]*>/;
const jsFile = html.match(jsTag)?.[1];
const cssFile = html.match(cssTag)?.[1];
if (!jsFile || !cssFile) throw new Error('Expected isolated preview script and stylesheet');
const js = (await readFile(join(scratch, jsFile.replace(/^\//, '')), 'utf8')).replaceAll('</script', '<\\/script');
const css = await readFile(join(scratch, cssFile.replace(/^\//, '')), 'utf8');
html = html.replace(jsTag, () => `<script type="module">${js}</script>`).replace(cssTag, () => `<style>${css}</style>`);
const license = await readFile(join(root, 'node_modules/react/LICENSE'), 'utf8');
html = html.replace('</head>', `<!-- Bundled React / ReactDOM / Scheduler\n${license}\n-->\n</head>`);
const output = join(root, 'designs/previews/hybrid-core/index.html');
await mkdir(join(root, 'designs/previews/hybrid-core'), { recursive: true });
await writeFile(output, html);
console.log(output);
