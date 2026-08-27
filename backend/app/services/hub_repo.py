"""Physical hub_repo layout + always-updated catalog index.

Layout (data branch):
  hub_repo/data/{modality}/{ontology}/{format}/{source_name}/{filename}

Index:
  hub_repo/index/dimensions.json  — extensible dimension schema
  hub_repo/index/catalog.json     — full file↔dimension catalog (rewritten on change)
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO

from ..config import settings
from .dimensions import (
    load_dimension_schema,
    save_dimension_schema,
)
from .disk_repository import MODALITIES, ONTOLOGIES

_SAFE_RE = re.compile(r"[^\w\u4e00-\u9fff\-_.]+", re.UNICODE)


def hub_root() -> Path:
    root = Path(settings.hub_repo_root)
    ensure_hub_skeleton(root)
    return root


def ensure_hub_skeleton(root: Path | None = None) -> Path:
    root = Path(root or settings.hub_repo_root)
    (root / "index").mkdir(parents=True, exist_ok=True)
    for ont in ONTOLOGIES:
        (root / "3d_model" / ont).mkdir(parents=True, exist_ok=True)
        (root / "data" / ont).mkdir(parents=True, exist_ok=True)
    # seed schema if missing
    load_dimension_schema(root)
    catalog_path(root)
    if not catalog_path(root).is_file():
        write_catalog(root, {"version": 1, "updated_at": _utcnow_iso(), "files": []})
    return root


def catalog_path(root: Path | None = None) -> Path:
    return Path(root or settings.hub_repo_root) / "index" / "catalog.json"


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def sanitize_name(name: str, fallback: str = "upload") -> str:
    base = Path(name or "").name
    if base.lower().endswith(".zip"):
        base = base[:-4]
    base = base.strip().strip(".")
    base = _SAFE_RE.sub("_", base)
    base = re.sub(r"_+", "_", base).strip("_")
    return base or fallback


def infer_format(filename: str) -> str:
    name = (filename or "").lower()
    if name.endswith(".ser.pkl"):
        return "ser.pkl"
    ext = Path(name).suffix.lower().lstrip(".")
    return ext or "bin"


def repo_rel_path(modality: str, ontology: str, fmt: str, source_name: str, filename: str) -> str:
    safe_src = sanitize_name(source_name)
    safe_fmt = sanitize_name(fmt, fallback="bin")
    safe_file = Path(filename).name or "file.bin"
    # keep original basename when possible; collide → handled by caller
    return str(Path("data") / modality / ontology / safe_fmt / safe_src / safe_file)


def absolute_repo_path(rel: str) -> Path:
    return hub_root() / rel


def checksum_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _unique_dest(dest: Path) -> Path:
    if not dest.exists():
        return dest
    stem, suffix = dest.stem, dest.suffix
    n = 2
    while True:
        cand = dest.with_name(f"{stem}_{n}{suffix}")
        if not cand.exists():
            return cand
        n += 1


def save_bytes_to_repo(
    content: bytes,
    *,
    modality: str,
    ontology: str,
    fmt: str,
    source_name: str,
    filename: str,
) -> tuple[str, str, Path]:
    """Write file into hub_repo. Returns (rel_path, checksum, abs_path)."""
    modality = modality.strip().lower()
    ontology = ontology.strip().lower()
    if modality not in MODALITIES:
        raise ValueError(f"modality 无效: {modality}")
    if ontology not in ONTOLOGIES:
        raise ValueError(f"ontology 无效: {ontology}")
    fmt = (fmt or infer_format(filename)).strip().lower().lstrip(".")
    root = hub_root()
    rel = repo_rel_path(modality, ontology, fmt, source_name, filename)
    dest = root / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest = _unique_dest(dest)
    dest.write_bytes(content)
    rel = str(dest.relative_to(root))
    return rel, checksum_file(dest), dest


def save_stream_to_repo(
    file_obj: BinaryIO,
    *,
    modality: str,
    ontology: str,
    fmt: str,
    source_name: str,
    filename: str,
) -> tuple[str, str, Path]:
    modality = modality.strip().lower()
    ontology = ontology.strip().lower()
    if modality not in MODALITIES:
        raise ValueError(f"modality 无效: {modality}")
    if ontology not in ONTOLOGIES:
        raise ValueError(f"ontology 无效: {ontology}")
    fmt = (fmt or infer_format(filename)).strip().lower().lstrip(".")
    root = hub_root()
    rel = repo_rel_path(modality, ontology, fmt, source_name, filename)
    dest = root / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest = _unique_dest(dest)
    h = hashlib.sha256()
    with dest.open("wb") as out:
        while True:
            chunk = file_obj.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
            h.update(chunk)
    rel = str(dest.relative_to(root))
    return rel, h.hexdigest(), dest


def copy_path_to_repo(
    src: Path,
    *,
    modality: str,
    ontology: str,
    fmt: str | None = None,
    source_name: str,
) -> tuple[str, str, Path]:
    if not src.is_file():
        raise FileNotFoundError(str(src))
    fmt = fmt or infer_format(src.name)
    with src.open("rb") as f:
        return save_stream_to_repo(
            f,
            modality=modality,
            ontology=ontology,
            fmt=fmt,
            source_name=source_name,
            filename=src.name,
        )


def relocate_repo_file(
    old_rel: str,
    *,
    modality: str,
    ontology: str,
    fmt: str,
    source_name: str,
    filename: str,
) -> str:
    """Move/rename a file inside hub_repo. Returns new relative path."""
    root = hub_root()
    src = (root / old_rel).resolve()
    if not str(src).startswith(str(root.resolve())):
        raise ValueError("非法路径")
    if not src.is_file():
        raise FileNotFoundError(old_rel)
    new_rel = repo_rel_path(modality, ontology, fmt, source_name, filename)
    dest = root / new_rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.resolve() == src:
        return old_rel
    dest = _unique_dest(dest)
    src.rename(dest)
    # best-effort cleanup of empty source dirs
    parent = src.parent
    for _ in range(4):
        if parent == root or not parent.is_dir():
            break
        try:
            parent.rmdir()
        except OSError:
            break
        parent = parent.parent
    return str(dest.relative_to(root))


def read_catalog(root: Path | None = None) -> dict[str, Any]:
    path = catalog_path(root)
    if not path.is_file():
        return {"version": 1, "updated_at": _utcnow_iso(), "files": []}
    return json.loads(path.read_text(encoding="utf-8"))


def write_catalog(root: Path, catalog: dict[str, Any]) -> None:
    path = catalog_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    catalog = dict(catalog)
    catalog["updated_at"] = _utcnow_iso()
    catalog["version"] = int(catalog.get("version") or 1)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def upsert_catalog_entry(entry: dict[str, Any], root: Path | None = None) -> dict[str, Any]:
    root = Path(root or settings.hub_repo_root)
    ensure_hub_skeleton(root)
    catalog = read_catalog(root)
    files: list[dict[str, Any]] = list(catalog.get("files") or [])
    eid = entry.get("id")
    path = entry.get("path")
    replaced = False
    for i, f in enumerate(files):
        if (eid is not None and f.get("id") == eid) or (
            path and f.get("path") == path
        ):
            files[i] = {**f, **entry}
            replaced = True
            break
    if not replaced:
        files.append(entry)
    catalog["files"] = files
    catalog["version"] = int(catalog.get("version") or 1) + 1
    write_catalog(root, catalog)
    return catalog


def remove_catalog_entry(*, file_id: int | None = None, path: str | None = None, root: Path | None = None) -> dict[str, Any]:
    root = Path(root or settings.hub_repo_root)
    catalog = read_catalog(root)
    files = [
        f
        for f in (catalog.get("files") or [])
        if not (
            (file_id is not None and f.get("id") == file_id)
            or (path and f.get("path") == path)
        )
    ]
    catalog["files"] = files
    catalog["version"] = int(catalog.get("version") or 1) + 1
    write_catalog(root, catalog)
    return catalog


def rebuild_catalog_from_db(entries: list[dict[str, Any]], root: Path | None = None) -> dict[str, Any]:
    root = Path(root or settings.hub_repo_root)
    ensure_hub_skeleton(root)
    catalog = {
        "version": 1,
        "updated_at": _utcnow_iso(),
        "files": entries,
    }
    write_catalog(root, catalog)
    return catalog


def extract_zip_members(zip_source, dest_dir: Path) -> list[Path]:
    """Extract zip to dest_dir, return list of extracted file paths."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    with zipfile.ZipFile(zip_source) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            name = Path(info.filename).name
            if not name or name.startswith("."):
                continue
            target = dest_dir / name
            # avoid path traversal: only basename
            with zf.open(info) as src, target.open("wb") as out:
                shutil.copyfileobj(src, out)
            paths.append(target)
    return paths


def group_files_by_format(paths: list[Path]) -> dict[str, list[Path]]:
    buckets: dict[str, list[Path]] = {}
    for p in paths:
        if not p.is_file():
            continue
        fmt = infer_format(p.name)
        buckets.setdefault(fmt, []).append(p)
    return buckets
