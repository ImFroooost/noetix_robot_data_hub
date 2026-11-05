"""把 SMPL npz 收成 30fps 的 135 维特征，写成一块内存映射。"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")

import numpy as np

from smpl_kf.geometry import FEAT_DIM, DST_FPS, load_npz_motion

FEATURE_VERSION = 2

REPO = Path(__file__).resolve().parents[2]
DEFAULT_ROOT = REPO / "data" / "hub_repo" / "data" / "human" / "motion" / "smpl"
DEFAULT_CACHE = Path.home() / "smpl_kf_cache"


def _init_worker():
    os.environ["OMP_NUM_THREADS"] = "1"
    os.environ["OPENBLAS_NUM_THREADS"] = "1"
    os.environ["MKL_NUM_THREADS"] = "1"


def relative_source(path: Path, root: Path) -> str:
    try:
        return str(path.resolve().relative_to(root.resolve()))
    except ValueError:
        return str(path.resolve())


def clip_id(rel: str) -> str:
    return hashlib.sha1(rel.encode()).hexdigest()[:16]


def split_of(rel: str, val_mod: int) -> str:
    if val_mod <= 0:
        return "train"
    digest = int(hashlib.sha1(rel.encode()).hexdigest(), 16)
    return "val" if digest % val_mod == 0 else "train"


def group_of(rel: str) -> str:
    return "amass" if "AMASS_Complete" in Path(rel).parts else "inhouse"


def process_one(task: tuple) -> dict:
    src, dest, val_mod, root = task
    try:
        motion = load_npz_motion(src)
    except ValueError as exc:
        return {"ok": False, "reason": str(exc), "src": src}
    except Exception as exc:
        return {"ok": False, "reason": f"err:{type(exc).__name__}", "src": src}
    feat = motion["feat"]
    Path(dest).parent.mkdir(parents=True, exist_ok=True)
    np.save(dest, feat)
    rel = relative_source(Path(src), Path(root))
    return {
        "ok": True,
        "id": Path(dest).stem,
        "src": rel,
        "frames": int(feat.shape[0]),
        "group": group_of(rel),
        "split": split_of(rel, int(val_mod)),
    }


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    records = []
    seen = set()
    with path.open() as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            if record["id"] in seen:
                continue
            seen.add(record["id"])
            records.append(record)
    return records


def _cache_is_ready(cache: Path, val_mod: int) -> bool:
    ready_path = cache / "ready.json"
    if not ready_path.exists() or not (cache / "data.npy").exists():
        return False
    ready = json.loads(ready_path.read_text())
    return (
        ready.get("version") == FEATURE_VERSION
        and ready.get("val_mod") == val_mod
        and ready.get("fps") == DST_FPS
        and ready.get("feat_dim") == FEAT_DIM
        and int(ready.get("clips", 0)) > 0
        and (cache / "offsets.npy").exists()
    )


def _finalize(cache: Path, records: list[dict], val_mod: int):
    usable = []
    for record in records:
        npy = cache / "clips" / f"{record['id']}.npy"
        if npy.exists():
            usable.append(record)
    if not usable:
        raise RuntimeError("没有可用的片段")
    total = sum(int(record["frames"]) for record in usable)
    data = np.lib.format.open_memmap(
        cache / "data.npy", mode="w+", dtype=np.float32, shape=(total, FEAT_DIM)
    )
    offsets = np.zeros(len(usable) + 1, np.int64)
    groups = np.zeros(len(usable), np.uint8)
    splits = np.zeros(len(usable), np.uint8)
    cursor = 0
    for index, record in enumerate(usable):
        feat = np.load(cache / "clips" / f"{record['id']}.npy")
        if feat.ndim != 2 or feat.shape[1] != FEAT_DIM or feat.shape[0] != int(record["frames"]):
            raise RuntimeError(f"片段形状异常: {record['src']}")
        data[cursor : cursor + feat.shape[0]] = feat
        cursor += feat.shape[0]
        offsets[index + 1] = cursor
        groups[index] = 1 if record["group"] == "inhouse" else 0
        splits[index] = 1 if record["split"] == "val" else 0
        if (index + 1) % 2000 == 0:
            print(f"  合并 {index + 1}/{len(usable)}", flush=True)
    data.flush()
    del data
    np.save(cache / "offsets.npy", offsets)
    np.save(cache / "groups.npy", groups)
    np.save(cache / "splits.npy", splits)
    hours = cursor / DST_FPS / 3600.0
    summary = {
        "clips": len(usable),
        "frames": int(cursor),
        "hours": round(hours, 3),
        "train": int((splits == 0).sum()),
        "val": int((splits == 1).sum()),
        "amass": int((groups == 0).sum()),
        "inhouse": int((groups == 1).sum()),
        "fps": DST_FPS,
        "feat_dim": FEAT_DIM,
        "val_mod": val_mod,
        "version": FEATURE_VERSION,
    }
    (cache / "summary.json").write_text(json.dumps(summary, indent=2))
    (cache / "ready.json").write_text(json.dumps(summary))
    print(
        f"缓存完成: {summary['clips']} 条, {summary['hours']:.2f} 小时, "
        f"训练 {summary['train']} / 验证 {summary['val']}, "
        f"AMASS {summary['amass']} / 自采 {summary['inhouse']}",
        flush=True,
    )


def iter_sources(root: Path, files: list[str] | None, limit: int) -> list[Path]:
    if files:
        return [Path(item).resolve() for item in files]
    found = []
    for path in sorted(root.rglob("*.npz")):
        if path.name == "shape.npz" or "Motion_Dataset_Human" in path.parts:
            continue
        found.append(path)
        if limit and len(found) >= limit:
            break
    return found


def build_cache(
    root: Path = DEFAULT_ROOT,
    cache: Path = DEFAULT_CACHE,
    workers: int = 4,
    limit: int = 0,
    files: list[str] | None = None,
    val_mod: int = 20,
    force: bool = False,
    refresh: bool = False,
):
    root = Path(root)
    cache = Path(cache)
    if force and cache.exists():
        shutil.rmtree(cache)
    cache.mkdir(parents=True, exist_ok=True)
    previous_config = cache / "prepare_config.json"
    if previous_config.exists():
        previous = json.loads(previous_config.read_text())
        if previous.get("version") != FEATURE_VERSION:
            print(f"特征版本变为 {FEATURE_VERSION}，重建缓存", flush=True)
            for name in (
                "clips",
                "data.npy",
                "offsets.npy",
                "groups.npy",
                "splits.npy",
                "meta.jsonl",
                "ready.json",
                "stats.npz",
                "summary.json",
                "prepare_config.json",
            ):
                path = cache / name
                if path.is_dir():
                    shutil.rmtree(path)
                elif path.exists():
                    path.unlink()
    if not force and not refresh and _cache_is_ready(cache, val_mod):
        print(f"已有缓存 {cache}", flush=True)
        return cache
    if not root.is_dir() and not files:
        raise FileNotFoundError(f"找不到动作目录 {root}")

    config = {"val_mod": val_mod, "fps": DST_FPS, "feat_dim": FEAT_DIM, "version": FEATURE_VERSION}
    config_path = cache / "prepare_config.json"
    if config_path.exists():
        previous = json.loads(config_path.read_text())
        if previous.get("val_mod") != val_mod and not force:
            raise RuntimeError("验证集划分和已有缓存不一致，加 --force 重建")
    config_path.write_text(json.dumps(config))

    print(f"扫描 {root}", flush=True)
    sources = iter_sources(root, files, limit)
    print(f"候选文件 {len(sources)}", flush=True)
    jsonl = cache / "meta.jsonl"
    records = _read_jsonl(jsonl)
    done = {record["id"] for record in records}
    clips = cache / "clips"
    clips.mkdir(parents=True, exist_ok=True)

    tasks = []
    recovered = 0
    for path in sources:
        rel = relative_source(path, root)
        ident = clip_id(rel)
        dest = clips / f"{ident}.npy"
        if ident in done and dest.exists():
            continue
        if dest.exists() and ident not in done:
            feat = np.load(dest, mmap_mode="r")
            record = {
                "ok": True,
                "id": ident,
                "src": rel,
                "frames": int(feat.shape[0]),
                "group": group_of(rel),
                "split": split_of(rel, val_mod),
            }
            with jsonl.open("a") as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            records.append(record)
            done.add(ident)
            recovered += 1
            continue
        tasks.append((str(path), str(dest), val_mod, str(root)))
    if recovered:
        print(f"从已有 npy 恢复 {recovered} 条记录", flush=True)

    reasons = Counter()
    if tasks:
        import smpl_kf.prepare as prepare_mod

        print(f"转换 {len(tasks)} 个文件，{workers} 进程", flush=True)
        done_count = 0
        with jsonl.open("a") as handle, ProcessPoolExecutor(
            max_workers=workers, initializer=_init_worker
        ) as pool:
            for record in pool.map(prepare_mod.process_one, tasks, chunksize=4):
                done_count += 1
                if record["ok"]:
                    handle.write(json.dumps(record, ensure_ascii=False) + "\n")
                    handle.flush()
                    records.append(record)
                else:
                    reasons[record["reason"]] += 1
                if done_count % 200 == 0 or done_count == len(tasks):
                    print(
                        f"  已处理 {done_count}/{len(tasks)}，跳过 {sum(reasons.values())}",
                        flush=True,
                    )
    if reasons:
        print("跳过原因:", dict(reasons), flush=True)
    print("合并成分片内存映射", flush=True)
    _finalize(cache, _read_jsonl(jsonl), val_mod)
    return cache


def main():
    parser = argparse.ArgumentParser(description="预处理 SMPL npz，供关键帧扩散模型训练")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--limit", type=int, default=0, help="只处理前 N 个文件，调试用")
    parser.add_argument("--files", nargs="*", default=None, help="只处理这些 npz")
    parser.add_argument("--val-mod", type=int, default=20, help="哈希取模为 0 的进验证集；0 表示全部训练")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--refresh", action="store_true", help="缓存已建好时仍扫描新增文件")
    args = parser.parse_args()
    build_cache(
        root=args.root,
        cache=args.cache,
        workers=args.workers,
        limit=args.limit,
        files=args.files,
        val_mod=args.val_mod,
        force=args.force,
        refresh=args.refresh,
    )


if __name__ == "__main__":
    main()
