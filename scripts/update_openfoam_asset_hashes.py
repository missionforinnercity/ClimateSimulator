#!/usr/bin/env python3
"""Add content digests for converted CFD field and mask assets."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def update(directory: Path) -> bool:
    manifest_path = directory / "volume.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    fields = directory / manifest["fields"]
    mask = directory / manifest["valid_mask"]
    hashes = {"fields_sha256": sha256(fields), "valid_mask_sha256": sha256(mask)}
    changed = manifest.get("asset_hashes") != hashes
    if changed:
        manifest["asset_hashes"] = hashes
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return changed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directories", nargs="*", type=Path,
                        help="CFD case directories (defaults to public/assets/cfd/*)")
    args = parser.parse_args()
    directories = args.directories or sorted((PROJECT_ROOT / "public/assets/cfd").glob("*/"))
    updated = 0
    for directory in directories:
        if (directory / "volume.json").is_file():
            updated += update(directory)
    print(f"Updated {updated} CFD asset manifest(s) across {len(directories)} case directorie(s).")


if __name__ == "__main__":
    main()
