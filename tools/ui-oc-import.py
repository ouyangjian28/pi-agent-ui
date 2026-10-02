#!/usr/bin/env python3
"""Copy only the selected OpenChamber browser sources, without executing upstream scripts."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "vendor" / "openchamber-frontend"
TREES = ("packages/ui/src", "packages/sdk/src", "packages/web/src", "packages/web/public")
FILES = (
    "LICENSE", "package.json", "bun.lock", "tsconfig.json", "postcss.config.js",
    "vite-theme-plugin.ts", "packages/ui/package.json", "packages/ui/tsconfig.json",
    "packages/sdk/package.json", "packages/sdk/tsconfig.json", "packages/sdk/LICENSE", "packages/web/package.json",
    "packages/web/tsconfig.json", "packages/web/vite.config.ts", "packages/web/index.html",
    "packages/web/mobile.html", "packages/web/mini-chat.html",
)
EXCLUDED = {"node_modules", ".git", ".env", ".openchamber", "server", "dist"}


def selected(source: Path) -> list[str]:
    paths = list(FILES)
    for tree in TREES:
        folder = source / tree
        if not folder.is_dir() or folder.is_symlink():
            raise RuntimeError(f"Missing/nonliteral source directory: {tree}")
        for directory, dirs, names in os.walk(folder, followlinks=False):
            for name in dirs + names:
                item = Path(directory) / name
                if item.is_symlink() or name in EXCLUDED or name.startswith(".env"):
                    raise RuntimeError(f"Refuse excluded/symlink source: {item.relative_to(source)}")
            paths.extend(str((Path(directory) / name).relative_to(source)) for name in names)
    return sorted(paths)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(source: Path) -> None:
    manifest = json.loads((TARGET / "SOURCE-MANIFEST.json").read_text())
    rows = manifest["files"]
    expected = {row["path"] for row in rows}
    actual = {str(p.relative_to(TARGET)) for p in TARGET.rglob("*")
              if p.is_file() and not any(part in {"node_modules", "dist", ".pi"}
                                        for part in p.relative_to(TARGET).parts)}
    if actual != expected | {"SOURCE-MANIFEST.json"}:
        raise RuntimeError("Imported snapshot file set changed")
    if set(selected(source)) != expected:
        raise RuntimeError("Reference source file set changed")
    for row in rows:
        relative = row["path"]
        if ((TARGET / relative).is_symlink() or (source / relative).is_symlink()
                or digest(TARGET / relative) != row["sha256"] or digest(source / relative) != row["sha256"]):
            raise RuntimeError(f"Imported/reference source differs: {relative}")
    print(json.dumps({"verifiedFiles": len(rows), "bytes": sum(row["bytes"] for row in rows),
                      "sourceBytesIdentical": True, "backendStarted": False}))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    if args.verify:
        verify(source)
        return
    if TARGET.exists():
        raise RuntimeError("Refuse overwrite; use --verify or a fresh candidate")
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix="oc-import-", dir=TARGET.parent))
    rows = []
    try:
        for relative in selected(source):
            original = source / relative
            if original.is_symlink() or not original.is_file():
                raise RuntimeError(f"Not a literal regular source file: {relative}")
            raw = original.read_bytes()
            copied = stage / relative
            copied.parent.mkdir(parents=True, exist_ok=True)
            copied.write_bytes(raw)
            rows.append({"path": relative, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()})
        manifest = {"format": 1, "referenceDirectory": str(source), "sourceRevision": None,
                    "revisionNote": "File hashes identify the actual local snapshot; no guessed upstream revision.",
                    "purpose": "Literal browser UI first; no OpenCode server/engine, credentials or dependency installation.",
                    "files": rows}
        (stage / "SOURCE-MANIFEST.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        # Recheck the reference before publishing the snapshot.
        for row in rows:
            if digest(source / row["path"]) != row["sha256"]:
                raise RuntimeError(f"Source changed during import: {row['path']}")
        stage.rename(TARGET)
    except Exception:
        # Only the private staging directory created by this invocation is removable.
        shutil.rmtree(stage)
        raise
    verify(source)


if __name__ == "__main__":
    main()
