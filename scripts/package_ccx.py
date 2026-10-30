"""Zip dist/plugin into releases/WavePlug_Studio_<version>_local.ccx (manifest at the archive root).
`python package_ccx.py dev` packages the development loader (dist/dev) instead."""
import json, pathlib, sys, zipfile
root = pathlib.Path(__file__).resolve().parent.parent
dev = len(sys.argv) > 1 and sys.argv[1] == "dev"
src = root / "dist" / ("dev" if dev else "plugin")
version = json.loads((src / "manifest.json").read_text(encoding="utf-8"))["version"]
out = root / "releases" / (f"WavePlug_Studio_DEV_{version}_local.ccx" if dev else f"WavePlug_Studio_{version}_local.ccx")
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(src.rglob("*")):
        if f.is_file():
            z.write(f, f.relative_to(src).as_posix())
print(out)
