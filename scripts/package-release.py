#!/usr/bin/env python3
"""Build clean Agetra release ZIPs using only Python's standard library.

This script never imports application code, runs npm, or calls a wallet.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parent.parent
ROOT_FILES = (
    ".env.example", ".gitignore", "package.json", "package-lock.json",
    "README.md", "CHANGELOG.md", "THIRD_PARTY_NOTICES.md",
    "使用教程.txt", "版本说明.txt", "启动.cmd", "演示.cmd",
)
SCRIPT_FILES = (
    "scripts/launch-windows.mjs", "scripts/verify-chain.mjs",
    "scripts/package-release.py", ".github/workflows/test.yml",
)
SOURCE_TREES = {
    "src": {".mjs"},
    "abi": {".json"},
    "config": {".json"},
    "public": {".html", ".css", ".js", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico", ".woff", ".woff2"},
    "test": {".mjs"},
    "docs/images": {".jpg", ".png", ".webp", ".svg"},
}
RUNTIME_FILES = (
    "runtime/node.exe", "runtime/LICENSE",
    "runtime/SHASUMS256.txt", "runtime/SOURCE.txt",
)
EXCLUDED_PARTS = {
    ".git", ".runtime", ".baw", ".agentic-wallet", ".aws", ".ssh",
    "__pycache__", ".cache", ".DS_Store", "Thumbs.db",
}
TEMP_SUFFIXES = {".pyc", ".pyo", ".log", ".tmp", ".bak"}
# Fixed metadata makes repeat builds of the same files independent of mtimes.
ZIP_TIMESTAMP = (2026, 10, 24, 0, 0, 0)


def excluded(relative):
    # Dependency packages legitimately use dist/ and may keep notices there.
    if relative.parts and relative.parts[0] in {"dist", "coverage"}:
        return True
    for part in relative.parts:
        if part in EXCLUDED_PARTS or (part.startswith(".env") and part != ".env.example"):
            return True
    return relative.suffix.lower() in TEMP_SUFFIXES


def checked_file(relative):
    path = ROOT / relative
    # Reject links at every level, including a symlinked tree root.
    current = ROOT
    for part in Path(relative).parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("Refusing symlink in release input: " + str(relative))
    if not path.is_file():
        raise ValueError("Required release file is missing: " + str(relative))
    if not path.resolve().is_relative_to(ROOT):
        raise ValueError("Release input escapes project root: " + str(relative))
    return path


def collect_tree(name, suffixes=None):
    directory = ROOT / name
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("Required release directory is missing or linked: " + name)
    result = []
    for base, directories, filenames in os.walk(directory, followlinks=False):
        kept_directories = []
        for item in sorted(directories):
            child = Path(base) / item
            relative = child.relative_to(ROOT)
            if excluded(relative):
                continue
            if child.is_symlink():
                raise ValueError("Refusing symlink in release input: " + str(relative))
            kept_directories.append(item)
        directories[:] = kept_directories
        for item in sorted(filenames):
            relative = (Path(base) / item).relative_to(ROOT)
            if excluded(relative):
                continue
            if suffixes is not None and relative.suffix.lower() not in suffixes:
                continue
            checked_file(relative)
            result.append(relative)
    if not result:
        raise ValueError("Release directory has no eligible files: " + name)
    return result


def release_version():
    package = json.loads(checked_file("package.json").read_text(encoding="utf-8"))
    lock = json.loads(checked_file("package-lock.json").read_text(encoding="utf-8"))
    version = package.get("version", "")
    if package.get("name") != "agetra-terminal":
        raise ValueError("package.json name must be agetra-terminal")
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version):
        raise ValueError("Invalid package version")
    lock_root = lock.get("packages", {}).get("", {})
    for label, data in (("lockfile", lock), ("lockfile root package", lock_root)):
        if data.get("name") != package["name"] or data.get("version") != version:
            raise ValueError(label + " name/version differs from package.json")
    return version


def source_files():
    result = [Path(name) for name in ROOT_FILES + SCRIPT_FILES]
    for name in result:
        checked_file(name)
    for directory, suffixes in SOURCE_TREES.items():
        result.extend(collect_tree(directory, suffixes))
    # Preserve any explicit future project license without inventing one.
    for name in ("LICENSE", "LICENSE.md", "LICENSE.txt", "NOTICE", "NOTICE.txt"):
        if (ROOT / name).exists():
            checked_file(name)
            result.append(Path(name))
    for name in ("abi/Core.json", "abi/Registry.json", "abi/Runtime.json", "abi/Tools.json"):
        checked_file(name)
    return sorted(set(result), key=lambda path: path.as_posix())


def portable_files(source):
    for name in RUNTIME_FILES:
        checked_file(name)
    dependencies = collect_tree("node_modules")
    for name in ("node_modules/@binance/agentic-wallet/package.json",
                 "node_modules/@binance/agentic-wallet/dist/index.js",
                 "node_modules/ethers/package.json"):
        checked_file(name)
    return sorted(set(source + [Path(name) for name in RUNTIME_FILES] + dependencies),
                  key=lambda path: path.as_posix())


def write_archive(destination, top_directory, files):
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for relative in files:
            source = checked_file(relative)
            info = zipfile.ZipInfo(top_directory + "/" + relative.as_posix(), ZIP_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            with source.open("rb") as incoming, archive.open(info, "w", force_zip64=True) as outgoing:
                while True:
                    chunk = incoming.read(1024 * 1024)
                    if not chunk:
                        break
                    outgoing.write(chunk)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-only", action="store_true", help="Build only the source ZIP; no bundled runtime/dependencies required")
    args = parser.parse_args()
    version = release_version()
    base = "Agetra-Terminal-v" + version
    source = source_files()
    # Collect and validate all inputs before creating any release output.
    plans = [(base + "-Source", source)]
    if not args.source_only:
        plans.insert(0, (base + "-Windows-x64", portable_files(source)))
    output = ROOT / "dist"
    if output.is_symlink():
        raise ValueError("Refusing symlinked dist directory")
    output.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".agetra-release-", dir=output) as temporary:
        staging = Path(temporary)
        checksums = []
        for archive_name, files in plans:
            filename = archive_name + ".zip"
            target = staging / filename
            write_archive(target, archive_name, files)
            checksums.append(sha256(target) + "  " + filename)
        (staging / "SHA256SUMS.txt").write_text("\n".join(checksums) + "\n", encoding="utf-8")
        for archive_name, files in plans:
            filename = archive_name + ".zip"
            os.replace(staging / filename, output / filename)
            print("Created " + str(output / filename) + " (" + str(len(files)) + " files)")
        os.replace(staging / "SHA256SUMS.txt", output / "SHA256SUMS.txt")
    print("Created " + str(output / "SHA256SUMS.txt"))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        raise SystemExit("Packaging failed: " + str(error))
