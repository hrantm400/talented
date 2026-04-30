"""
Real vocal isolation with Demucs (Facebook's source separator).

Runs htdemucs (the default 4-stem model) but only writes the vocals + accompaniment
two-stem split to keep things compact. Output is two WAV files. The caller chooses
which one to keep based on user intent.

This is CPU-only and takes roughly real-time × 6 on this 12-core box for the htdemucs
model. For a 1-minute clip expect ~6 minutes of processing — log progress to stderr.

Usage:
  python vocal-isolate.py <input> <output_dir> [model=htdemucs]

Outputs into output_dir:
  vocals.wav        — isolated vocal track
  no_vocals.wav     — instrumental (everything else)

Stdout: JSON {"vocals": path, "no_vocals": path, "duration": float}
"""
import os
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
os.environ["OMP_NUM_THREADS"] = "8"

import sys
import json
import shutil
import subprocess
import tempfile
import wave
import contextlib
from pathlib import Path


def wav_duration(path):
    try:
        with contextlib.closing(wave.open(path, "rb")) as f:
            frames = f.getnframes()
            rate = f.getframerate()
            return frames / float(rate) if rate else 0.0
    except Exception:
        return 0.0


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: vocal-isolate.py <input> <output_dir> [model]"}))
        sys.exit(1)

    input_path = sys.argv[1]
    output_dir = sys.argv[2]
    model = sys.argv[3] if len(sys.argv) > 3 else "htdemucs"

    if not os.path.exists(input_path):
        print(json.dumps({"error": f"Input not found: {input_path}"}))
        sys.exit(1)

    os.makedirs(output_dir, exist_ok=True)

    # Demucs writes to <out>/<model>/<basename>/{vocals,no_vocals}.wav. We use a temp
    # area to keep that structure isolated, then move the two WAVs into output_dir.
    with tempfile.TemporaryDirectory(prefix="demucs_") as tmp:
        cmd = [
            sys.executable, "-m", "demucs",
            "--two-stems=vocals",
            "-d", "cpu",
            "-n", model,
            "-o", tmp,
            input_path,
        ]
        print(f"[demucs] running: {' '.join(cmd)}", file=sys.stderr, flush=True)
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            print(json.dumps({
                "error": "demucs failed",
                "stderr": proc.stderr[-2000:],
                "stdout": proc.stdout[-2000:],
            }))
            sys.exit(1)

        # Find produced files
        basename = Path(input_path).stem
        produced = Path(tmp) / model / basename
        vocals_src = produced / "vocals.wav"
        no_vocals_src = produced / "no_vocals.wav"
        if not vocals_src.exists() or not no_vocals_src.exists():
            # Demucs sometimes nests differently — search
            wavs = list(Path(tmp).rglob("*.wav"))
            vocals_src = next((w for w in wavs if w.name == "vocals.wav"), None)
            no_vocals_src = next((w for w in wavs if w.name == "no_vocals.wav"), None)
        if not vocals_src or not no_vocals_src:
            print(json.dumps({"error": "demucs output files missing"}))
            sys.exit(1)

        vocals_dst = os.path.join(output_dir, "vocals.wav")
        no_vocals_dst = os.path.join(output_dir, "no_vocals.wav")
        shutil.move(str(vocals_src), vocals_dst)
        shutil.move(str(no_vocals_src), no_vocals_dst)

    print(json.dumps({
        "vocals": vocals_dst,
        "no_vocals": no_vocals_dst,
        "duration": round(wav_duration(vocals_dst), 2),
        "model": model,
    }))


if __name__ == "__main__":
    main()
