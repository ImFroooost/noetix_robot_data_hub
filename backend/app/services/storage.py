import hashlib
import shutil
import uuid
from pathlib import Path

from ..config import settings


def data_root() -> Path:
    root = Path(settings.data_root)
    for sub in (
        "human",
        "robot",
        "previews",
        "thumbnails",
        "robot_models",
        "import",
        "slice",
        "video",
    ):
        (root / sub).mkdir(parents=True, exist_ok=True)
    return root


def checksum_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def save_upload(kind: str, clip_id: int, filename: str, content: bytes) -> tuple[str, str]:
    """Save bytes under data_root/kind/clip_id/. Returns (relative_path, checksum)."""
    root = data_root()
    ext = Path(filename).suffix.lower()
    safe_name = f"{uuid.uuid4().hex}{ext}"
    dest_dir = root / kind / str(clip_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / safe_name
    dest.write_bytes(content)
    rel = str(dest.relative_to(root))
    return rel, checksum_file(dest)


def save_upload_stream(kind: str, clip_id: int, filename: str, file_obj) -> tuple[str, str]:
    root = data_root()
    ext = Path(filename).suffix.lower()
    safe_name = f"{uuid.uuid4().hex}{ext}"
    dest_dir = root / kind / str(clip_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / safe_name
    h = hashlib.sha256()
    with dest.open("wb") as out:
        while True:
            chunk = file_obj.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
            h.update(chunk)
    rel = str(dest.relative_to(root))
    return rel, h.hexdigest()


def absolute_path(relative: str) -> Path:
    return data_root() / relative


def copy_into_storage(src: Path, kind: str, clip_id: int) -> tuple[str, str]:
    root = data_root()
    if not src.is_file():
        raise FileNotFoundError(str(src))
    safe_name = f"{uuid.uuid4().hex}{src.suffix.lower()}"
    dest_dir = root / kind / str(clip_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / safe_name
    shutil.copy2(src, dest)
    return str(dest.relative_to(root)), checksum_file(dest)


def extract_zip_to_robot_model(name: str, zip_source) -> tuple[str, str, str]:
    """Extract robot package zip from path/bytes/fileobj. Returns (package_rel, urdf_rel, name)."""
    import zipfile
    from io import BytesIO

    root = data_root()
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in name) or "robot"
    package_rel = f"robot_models/{uuid.uuid4().hex}_{safe}"
    package_dir = root / package_rel
    package_dir.mkdir(parents=True, exist_ok=True)

    try:
        if isinstance(zip_source, (bytes, bytearray)):
            zf_ctx = zipfile.ZipFile(BytesIO(zip_source))
        else:
            zf_ctx = zipfile.ZipFile(zip_source)
        with zf_ctx as zf:
            zf.extractall(package_dir)
    except zipfile.BadZipFile as e:
        raise ValueError(f"无效的 zip 文件：{e}") from e

    urdfs = list(package_dir.rglob("*.urdf"))
    if not urdfs:
        urdfs = list(package_dir.rglob("*.xacro"))
    if not urdfs:
        raise ValueError("压缩包中未找到 .urdf 文件，请确认 zip 内包含机器人 URDF")
    # prefer shorter path (usually package root)
    urdf = sorted(urdfs, key=lambda p: len(str(p)))[0]
    urdf_rel = str(urdf.relative_to(root))
    return package_rel, urdf_rel, urdf.name


def save_upload_to_temp(file_obj, suffix: str = ".zip") -> Path:
    """Stream upload to a temp file under data_root/tmp."""
    root = data_root()
    tmp_dir = root / "tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    dest = tmp_dir / f"{uuid.uuid4().hex}{suffix}"
    with dest.open("wb") as out:
        while True:
            chunk = file_obj.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
    return dest


def import_robot_model_from_dir(name: str, source_dir: str | Path) -> tuple[str, str, str]:
    """Copy a local robot asset directory into storage. Returns (package_rel, urdf_rel, urdf_name)."""
    import shutil

    src = Path(source_dir).expanduser().resolve()
    if not src.is_dir():
        raise ValueError(f"目录不存在：{src}")

    root = data_root()
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in name) or "robot"
    package_rel = f"robot_models/{uuid.uuid4().hex}_{safe}"
    package_dir = root / package_rel
    shutil.copytree(src, package_dir / src.name)

    # also accept flat layouts where urdf sits at root
    search_root = package_dir
    urdfs = list(search_root.rglob("*.urdf"))
    if not urdfs:
        urdfs = list(search_root.rglob("*.xacro"))
    if not urdfs:
        raise ValueError(f"目录中未找到 .urdf 文件：{src}")
    urdf = sorted(urdfs, key=lambda p: len(str(p)))[0]
    return package_rel, str(urdf.relative_to(root)), urdf.name


