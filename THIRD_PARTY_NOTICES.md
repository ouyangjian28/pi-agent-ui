# Third-party notices

## OpenChamber frontend

The UI-rework candidate directly reuses OpenChamber's frontend source, layout, styles, components, and desktop/mobile shells. We do not claim these as an original pi-agent-ui UI design.

- Upstream copyright: **Copyright (c) 2025 Bohdan Triapitsyn**.
- License: **MIT**. The original copyright, grant, conditions, and disclaimer are retained in [vendor/openchamber-frontend/LICENSE](vendor/openchamber-frontend/LICENSE).
- Source snapshot and byte-identification record: [vendor/openchamber-frontend/SOURCE-MANIFEST.json](vendor/openchamber-frontend/SOURCE-MANIFEST.json). Its `sourceRevision` is `null`; the actual imported bytes are identified by the recorded hashes, not by an invented upstream revision.
- Adaptation work: connecting this frontend to the existing pi runtime and retaining native conversation-state/delivery/recovery ownership. Native end-to-end UI integration is still in progress.
- Affiliation: this project is not affiliated with or endorsed by OpenChamber. Upstream identifiers retained in the source snapshot do not imply endorsement.

MIT permits copying, modifying, publishing, and distributing the licensed software, provided its copyright and permission notice accompany copies or substantial portions. Those notices must remain in source and release distributions, even after visual changes. This file supplements, and does not replace, the complete licenses.

## Additional notices and publication boundary

The imported tree contains additional notices, including:

- [packages/sdk/LICENSE](vendor/openchamber-frontend/packages/sdk/LICENSE)
- [ghostty/vendor/LICENSE](vendor/openchamber-frontend/packages/ui/src/lib/ghostty/vendor/LICENSE)
- [ghostty/fonts/LICENSE](vendor/openchamber-frontend/packages/ui/src/lib/ghostty/fonts/LICENSE)
- [ghostty/LICENSE-T3CODE](vendor/openchamber-frontend/packages/ui/src/lib/ghostty/LICENSE-T3CODE)

Retain applicable notices for any portions actually distributed. This is not a completed audit of every dependency, font, icon, image, or other asset. Before a public release, verify the exact distributed files and dependencies, include all applicable notices, and review/remove unnecessary upstream branding. A code license is not a blanket trademark or endorsement permission.

A similar appearance can still be recognizable as OpenChamber-derived. Attribution addresses provenance; it does not create visual differentiation. Later UI restyling must not erase the origin of retained code.
