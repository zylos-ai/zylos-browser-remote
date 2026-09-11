#!/usr/bin/env python3
"""Turn a record-bilibili.js capture into something the owner can just watch.

There is no ffmpeg in this container, so there is no mp4 to hand over. What
this builds instead:

  index.html  an auto-playing frame player -- the JPEG frames replayed at the
              timings they were actually captured at, with the run's real step
              log alongside. This is the primary artifact: it is crisp, it
              scrubs, and it stays honest because every frame keeps its
              timestamp.
  run.gif     one file to drag into a chat window, for when a link is not
              wanted. Coarser and heavier per second than the player, so it is
              offered second rather than first.

Frames are sampled, not all kept: a screencast emits on every repaint, which is
27 MB for 17 seconds. Sampling is time-based with the step boundaries protected,
so nothing that the run's narration points at can be dropped.

Usage: python3 tools/build-recording.py [capture_dir] [out_dir]
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

CAP = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/br-rec")
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/br-rec-out")

PLAYER_WIDTH = 960          # the capture is 1024 wide; this keeps text readable
PLAYER_QUALITY = 58
PLAYER_MIN_GAP_MS = 110     # ~9 fps ceiling for the player
PLAYER_MAX_FRAMES = 170

GIF_WIDTH = 720
GIF_MIN_GAP_MS = 180        # ~5.5 fps ceiling for the gif
GIF_MAX_FRAMES = 110
GIF_COLORS = 96
STEP_GRACE_MS = 500         # frames this soon after a step are never dropped


def sample(frames, steps, min_gap, max_frames):
    """Thin `frames` by time, protecting the first frame after each step.

    Two passes on purpose: a plain every-Nth-ms walk can drop exactly the frame
    that shows what a step did (the moment the query appears in the box), which
    is the one frame worth keeping.
    """
    protected = set()
    for s in steps:
        after = [f for f in frames if s["t"] <= f["t"] <= s["t"] + STEP_GRACE_MS]
        if after:
            protected.add(after[0]["file"])

    kept, last_t = [], None
    for f in frames:
        if f["file"] in protected or last_t is None or f["t"] - last_t >= min_gap:
            kept.append(f)
            last_t = f["t"]

    # Still too many: drop evenly, never touching a protected frame.
    if len(kept) > max_frames:
        droppable = [i for i, f in enumerate(kept) if f["file"] not in protected]
        excess = len(kept) - max_frames
        if excess >= len(droppable):
            drop = set(droppable)
        else:
            step = len(droppable) / excess
            drop = {droppable[int(i * step)] for i in range(excess)}
        kept = [f for i, f in enumerate(kept) if i not in drop]
    return kept


def durations(frames, total_ms):
    """Per-frame on-screen time, from arrival gaps rather than a fixed rate.

    The last frame has no successor, so it gets whatever is left of the run,
    floored at 700ms so the final state is readable before the loop restarts.
    """
    out = []
    for i, f in enumerate(frames):
        nxt = frames[i + 1]["t"] if i + 1 < len(frames) else max(total_ms, f["t"] + 700)
        out.append(max(40, min(2000, nxt - f["t"])))
    return out


def main():
    manifest = json.loads((CAP / "manifest.json").read_text())
    frames, steps = manifest["frames"], manifest["steps"]
    total = manifest["durationMs"]
    if not frames:
        sys.exit("no frames in the capture; nothing to build")

    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "frames").mkdir(parents=True)

    # ---------------------------------------------------------------- player
    pf = sample(frames, steps, PLAYER_MIN_GAP_MS, PLAYER_MAX_FRAMES)
    pdur = durations(pf, total)
    player_frames, bytes_out = [], 0
    for f, d in zip(pf, pdur):
        img = Image.open(CAP / "frames" / f["file"])
        if img.width > PLAYER_WIDTH:
            img = img.resize((PLAYER_WIDTH, round(img.height * PLAYER_WIDTH / img.width)),
                             Image.LANCZOS)
        dest = OUT / "frames" / f["file"]
        img.convert("RGB").save(dest, "JPEG", quality=PLAYER_QUALITY, optimize=True)
        bytes_out += dest.stat().st_size
        player_frames.append({"file": f"frames/{f['file']}", "t": f["t"], "hold": d})
    size = Image.open(OUT / "frames" / pf[0]["file"]).size

    # ------------------------------------------------------------------- gif
    gf = sample(frames, steps, GIF_MIN_GAP_MS, GIF_MAX_FRAMES)
    gdur = durations(gf, total)
    imgs = []
    for f in gf:
        img = Image.open(CAP / "frames" / f["file"]).convert("RGB")
        if img.width > GIF_WIDTH:
            img = img.resize((GIF_WIDTH, round(img.height * GIF_WIDTH / img.width)), Image.LANCZOS)
        imgs.append(img.quantize(colors=GIF_COLORS, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG))
    gif_path = OUT / "run.gif"
    imgs[0].save(gif_path, save_all=True, append_images=imgs[1:],
                 duration=gdur, loop=0, optimize=True, disposal=1)
    gif_bytes = gif_path.stat().st_size

    # ------------------------------------------------------------------ page
    data = {
        "recordedAt": manifest["recordedAt"],
        "query": manifest["query"],
        "home": manifest["home"],
        "resultsUrl": manifest["resultsUrl"],
        "resultsTitle": manifest["resultsTitle"],
        "how": manifest["how"],
        "durationMs": total,
        "capturedFrames": len(frames),
        "steps": steps,
        "resultLinks": manifest["resultLinks"],
        "frames": player_frames,
        "size": {"width": size[0], "height": size[1]},
        "gifBytes": gif_bytes,
    }
    (OUT / "run.json").write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n")
    (OUT / "index.html").write_text(
        (Path(__file__).parent / "recording-player.html").read_text()
        .replace("__RUN_DATA__", json.dumps(data, ensure_ascii=False)), encoding="utf-8")

    print(f"player: {len(player_frames)} frames, {bytes_out / 1e6:.1f} MB, {size[0]}x{size[1]}")
    print(f"gif:    {len(imgs)} frames, {gif_bytes / 1e6:.1f} MB, {imgs[0].size[0]}x{imgs[0].size[1]}")
    print(f"out:    {OUT}  ({subprocess.run(['du', '-sh', str(OUT)], capture_output=True, text=True).stdout.split()[0]})")


if __name__ == "__main__":
    main()
