"""Zip dist/plugin into releases/WavePlug_Studio_<version>_local.ccx (manifest at the archive root)."""
import json, pathlib, zipfile
root = pathlib.Path(__file__).resolve().parent.parent
src = root / "dist" / "plugin"
version = json.loads((src / "manifest.json").read_text(encoding="utf-8"))["version"]
out = root / "releases" / f"WavePlug_Studio_{version}_local.ccx"
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(src.rglob("*")):
        if f.is_file():
            z.write(f, f.relative_to(src).as_posix())
print(out)
