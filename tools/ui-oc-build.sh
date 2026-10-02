#!/usr/bin/env bash
# Build literal frontend only; no install, upstream lifecycle scripts or server.
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
SOURCE=/home/yyj/ai/repos/openchamber
SNAPSHOT="$ROOT/vendor/openchamber-frontend"
NODE_BIN=/home/yyj/.nvm/versions/node/v24.18.0/bin
LOG=${1:-"$ROOT/.pi/ui-oc-source/build.log"}
if [[ -e "$LOG" ]]; then printf 'Refuse overwrite of build evidence: %s\n' "$LOG" >&2; exit 1; fi
mkdir -p "$ROOT/.pi/ui-oc-source/home" "$(dirname -- "$LOG")"
# Every copied input remains original. Prepared dependency links are ignored.
python3 "$ROOT/tools/ui-oc-import.py" --source "$SOURCE" --verify
# Babel resolves configured plugins from cwd, so use the original monorepo root.
cd -- "$SNAPSHOT"
env -i HOME="$ROOT/.pi/ui-oc-source/home" PATH="$NODE_BIN:/usr/bin:/bin" CI=1 \
  "$NODE_BIN/node" --input-type=module - <<'JS'
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
const root = createRequire(process.cwd() + '/package.json');
const web = createRequire(process.cwd() + '/packages/web/package.json');
for (const [name, req] of [['babel-plugin-react-compiler', root], ['vite-plugin-pwa', web], ['@vitejs/plugin-react', web]]) {
  console.log('Cached dependency resolved: ' + name + ' → ' + req.resolve(name));
}
// Original Vite uses this explicit alias, not CJS package-subpath resolution.
if (!existsSync('node_modules/@opencode-ai/sdk/dist/v2/client.js')) throw new Error('Missing original SDK browser alias');
JS
# Separate log per trial; callers choose a fresh path to retain previous failures.
env -i HOME="$ROOT/.pi/ui-oc-source/home" PATH="$NODE_BIN:/usr/bin:/bin" CI=1 \
  "$NODE_BIN/node" node_modules/vite/bin/vite.js build \
  --config packages/web/vite.config.ts --configLoader runner > "$LOG" 2>&1
python3 "$ROOT/tools/ui-oc-import.py" --source "$SOURCE" --verify
