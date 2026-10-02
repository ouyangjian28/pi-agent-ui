# OpenChamber literal frontend candidate

Current scope: copy the original browser UI first, let the user inspect/click it, then connect the existing pi backend. This is not a new visual interpretation of OpenChamber, and it is not a switch to the OpenCode engine.

## Source and license

- Actual reference: `/home/yyj/ai/repos/openchamber`, package metadata 1.23.2.
- `openchamber-frontend/SOURCE-MANIFEST.json` identifies every imported file by original byte length and SHA-256. No guessed upstream revision.
- Original frontend sources/styles/assets and browser runtime entrypoints are unchanged. UI and guest SDK sources plus the minimal original build inputs are copied; OpenChamber web server, OpenCode engine, Electron/mobile backend, `.env`, local state and credentials are not copied.
- Original MIT license: `openchamber-frontend/LICENSE`; guest SDK license: `openchamber-frontend/packages/sdk/LICENSE`. Third-party dependencies remain separate dependencies.
- This import is not proof that its OpenCode-oriented API clients or state models already work with pi.

## Reproduce and verify

```sh
python3 tools/ui-oc-import.py --source /home/yyj/ai/repos/openchamber --verify
```

Initial import is allowed only into a fresh target; overwrite, source symlinks, excluded/private files and source changes during copying fail closed. Verification checks the exact source/import file set and hashes. The script never installs dependencies, runs upstream scripts or starts a backend.

Initial snapshot: 2,951 files, 26,893,071 bytes; source/import hashes match. The original root TypeScript config also references `packages/electron/tsconfig.json`; only this 426-byte configuration was subsequently added (no native source). Current snapshot: 2,952 files, 26,893,497 bytes; all original hashes still match. Importer syntax and byte verification passed; frontend build, browser clicks, visuals and user acceptance are separate checks, not yet implied.

Build trials keep separate logs in `.pi/ui-oc-source/`: the first stopped before compilation because root cached dependencies did not include the web-workspace `vite-plugin-pwa`; workspace cache links fixed resolution without installation. The second stopped at the missing referenced Electron type configuration, not UI compilation. Build uses an isolated HOME/environment and `--configLoader runner`; neither failure is counted as a build pass.

## Runtime boundary

The original browser entry creates `RuntimeAPIs`, then renders the original UI. Its development Vite config proxies `/auth`, `/health`, `/linear` and `/api` to an OpenChamber server by default. Do **not** launch that config as a connected dev server or start the upstream CLI. The initial candidate must use isolated preview data/explicit unavailable actions and must not reach production, reuse credentials, start OpenCode or claim a successful send.

No root dependency/lockfile, existing pi protocol, server or old UI entrypoint has been changed. The previous functional candidate remains available at `beeec28dd56f974892069678a00f3bb251f2c3cc`.
