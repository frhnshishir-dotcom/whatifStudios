"""Shared fixtures: a throwaway project root with a tiny cut config and synthetic PNG frames. No Blender needed."""
import random
import sys
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "pipeline"))

from common import validate_config  # noqa: E402

W, H = 36, 64       # tiny 9:16, even dimensions


class Cut:
    def __init__(self, root: Path, **overrides):
        self.root = root
        self.cfg = validate_config({"cut": "test_cut", "frame_start": 1, "frame_end": 10, "fps": 30,
                                    "width": W, "height": H, "audio": "forbidden", **overrides})
        self.frames = root / "episodes" / "test_cut" / "frames"
        self.frames.mkdir(parents=True)

    def path(self, n, digits=4):
        return self.frames / f"frame_{n:0{digits}d}.png"

    def frame(self, n, size=(W, H), mode="RGB", flat=None, digits=4):
        """Write a noisy (non-black, normal-sized) frame, or a flat-colour one if flat=(r, g, b)."""
        if flat is not None:
            im = Image.new("RGB", size, flat)
        else:
            rnd = random.Random(n)
            im = Image.frombytes("RGB", size, bytes(rnd.randrange(40, 256) for _ in range(size[0] * size[1] * 3)))
        im.convert(mode).save(self.path(n, digits))
        return self.path(n, digits)

    def fill(self, a=None, b=None, skip=()):
        for n in range((a or self.cfg["frame_start"]), (b or self.cfg["frame_end"]) + 1):
            if n not in skip:
                self.frame(n)


@pytest.fixture
def cut(tmp_path):
    return Cut(tmp_path)


@pytest.fixture
def make_cut(tmp_path):
    return lambda **kw: Cut(tmp_path, **kw)


# ---------------------------------------------------------------- ffmpeg helpers (tests skip if ffmpeg is absent)
import shutil as _shutil  # noqa: E402
import subprocess  # noqa: E402

FFMPEG, FFPROBE = _shutil.which("ffmpeg"), _shutil.which("ffprobe")
needs_ffmpeg = pytest.mark.skipif(not (FFMPEG and FFPROBE), reason="ffmpeg/ffprobe not on PATH")


@pytest.fixture
def tools():
    if not (FFMPEG and FFPROBE):
        pytest.skip("ffmpeg/ffprobe not on PATH")
    return FFMPEG, FFPROBE


def make_mp4(path, frames=10, fps=30, size=(W, H), codec="libx264", pix_fmt="yuv420p", audio_s=None):
    """Synthetic test clip (testsrc), optionally with a sine-tone audio track of audio_s seconds."""
    cmd = [FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc=size={size[0]}x{size[1]}:rate={fps}"]
    if audio_s:
        cmd += ["-f", "lavfi", "-t", str(audio_s), "-i", "sine=frequency=440:sample_rate=48000"]
    cmd += ["-frames:v", str(frames), "-c:v", codec, "-pix_fmt", pix_fmt]
    if audio_s:
        cmd += ["-c:a", "aac"]
    subprocess.run(cmd + [str(path)], check=True)
    return path


def make_wav(path, seconds=1.0):
    subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-t", str(seconds), "-i",
                    "sine=frequency=440:sample_rate=48000", str(path)], check=True)
    return path


def decoded_means(mp4, size=(W, H)):
    """Mean red value of every decoded frame, in order."""
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", str(mp4), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         capture_output=True, check=True).stdout
    n = size[0] * size[1] * 3
    return [sum(raw[i:i + n][0::3]) / (n / 3) for i in range(0, len(raw), n)]
