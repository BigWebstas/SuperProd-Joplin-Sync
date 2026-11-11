#!/usr/bin/env python3
"""Build the release zip and print the Super Productivity community-plugins.json entry.

Usage: python3 scripts/community-entry.py
Writes joplin-notes-sync-<version>.zip in the repo root (flat, manifest.json at
the root, as Super Productivity requires), then prints the entry to paste into
super-productivity/src/assets/community-plugins.json (new listing or version bump).
"""
import hashlib, json, pathlib, zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILES = ["manifest.json", "config-schema.json", "plugin.js", "index.html", "icon.svg"]
REPO = "BigWebstas/SuperProd-Joplin-Sync"

manifest = json.loads((ROOT / "manifest.json").read_text())
version = manifest["version"]
zip_path = ROOT / f"joplin-notes-sync-{version}.zip"

with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
    for name in FILES:
        # Fixed timestamp: the hash must match the zip uploaded to the release,
        # so build once here and upload this exact file.
        info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        z.writestr(info, (ROOT / name).read_bytes())

sha = hashlib.sha256(zip_path.read_bytes()).hexdigest()
entry = {
    "name": manifest["name"],
    "shortDescription": "Sync project notes, task notes, tags, due dates and done state into Joplin notebooks via Joplin's Web Clipper API. Desktop only.",
    "url": f"https://github.com/{REPO}",
    "author": "BigWebstas",
    "authorUrl": "https://github.com/BigWebstas",
    "id": manifest["id"],
    "release": {
        "version": version,
        "downloadUrl": f"https://github.com/{REPO}/releases/download/v{version}/{zip_path.name}",
        "sha256": sha,
    },
}
print(f"Built {zip_path.name}")
print(json.dumps(entry, indent=2))
