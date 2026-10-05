"""Build the distributable DSH plugin tarball from the repository root.

The DSH plugin format expects the payload under a `package/` prefix inside the
tarball, so this script walks the repo and re-roots everything it packs. The
file set matches the `files` whitelist in package.json (lib, assets, docs,
cordis.patch.yml, README.md, LICENSE); development-only directories (test/,
tools/, .github/, dist/) and local junk are skipped.

Usage (from the repository root):

    python tools/build_tgz.py            # -> dist/dsh-corner-anim-<version>.tgz
"""

import re
import tarfile
import os

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(REPO_ROOT)

# Version comes from package.json so the output name always matches the build.
with open("package.json", encoding="utf-8") as fh:
    version = re.search(r'"version"\s*:\s*"([^"]+)"', fh.read()).group(1)

out_dir = "dist"
out = os.path.join(out_dir, f"dsh-corner-anim-{version}.tgz")
os.makedirs(out_dir, exist_ok=True)

# What ships to `dsh plugin add` — same whitelist as package.json's `files`.
INCLUDE_DIRS = ("lib", "assets", "docs")
INCLUDE_FILES = ("cordis.patch.yml", "package.json", "README.md", "LICENSE")

files = []
for d in INCLUDE_DIRS:
    for dirpath, dirnames, filenames in os.walk(d):
        for fn in filenames:
            files.append(os.path.join(dirpath, fn).replace(os.sep, "/"))
for fn in INCLUDE_FILES:
    if os.path.isfile(fn):
        files.append(fn)
files.sort()

with tarfile.open(out, "w:gz") as tf:
    for f in files:
        arcname = "package/" + f
        ti = tf.gettarinfo(f, arcname=arcname)
        ti.uid = 0
        ti.gid = 0
        ti.uname = ""
        ti.gname = ""
        ti.mtime = 489027300  # normalized timestamps like the original 1985 ones
        with open(f, "rb") as fh:
            tf.addfile(ti, fh)
print("packed", len(files), "files ->", out)
