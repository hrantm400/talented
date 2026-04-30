"""
Face-tracking 9:16 vertical crop — OpenCV-only implementation.

Pass 1: sample frames at ~5fps, run OpenCV's Haar cascade face detector,
record the center-x of the largest detected face per sampled frame.

Pass 2: smooth the trajectory (moving average over ~0.8s) and linearly
interpolate to every frame. Read source frames again, crop a 9:16 window
centered on the smoothed x (clamped to frame bounds), resize to 1080x1920,
write via OpenCV's mp4v VideoWriter.

Usage:
  python smart-crop.py <input> <output> [target_height=1920] [target_width=1080]

Stdout: JSON {"duration": float, "fps": float, "faces_found": int, "frames": int, ...}
"""
import os
os.environ["OPENCV_LOG_LEVEL"] = "ERROR"

import sys
import json
import cv2
import numpy as np


def smooth_trajectory(samples, total_frames, window_frames):
    """samples: list of (frame_idx, x_center). Returns ndarray length total_frames."""
    if not samples:
        return None
    xs = np.full(total_frames, np.nan, dtype=np.float64)
    for f, x in samples:
        if 0 <= f < total_frames:
            xs[f] = x
    valid_idx = np.where(~np.isnan(xs))[0]
    if len(valid_idx) == 0:
        return None
    first, last = valid_idx[0], valid_idx[-1]
    xs[:first] = xs[first]
    xs[last + 1:] = xs[last]
    nan_mask = np.isnan(xs)
    if nan_mask.any():
        valid = ~nan_mask
        xs[nan_mask] = np.interp(
            np.flatnonzero(nan_mask), np.flatnonzero(valid), xs[valid]
        )
    if window_frames > 1:
        kernel = np.ones(window_frames) / window_frames
        xs = np.convolve(xs, kernel, mode="same")
    return xs


def detect_faces(gray, cascade):
    """Return list of (x, y, w, h) bboxes."""
    return cascade.detectMultiScale(
        gray, scaleFactor=1.15, minNeighbors=5, minSize=(60, 60)
    )


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: smart-crop.py <input> <output> [h=1920] [w=1080]"}))
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]
    target_h = int(sys.argv[3]) if len(sys.argv) > 3 else 1920
    target_w = int(sys.argv[4]) if len(sys.argv) > 4 else 1080

    cascade_xml = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    cascade = cv2.CascadeClassifier(cascade_xml)
    if cascade.empty():
        print(json.dumps({"error": f"Cannot load Haar cascade: {cascade_xml}"}))
        sys.exit(1)

    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        print(json.dumps({"error": f"Cannot open input: {input_path}"}))
        sys.exit(1)

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    if src_w <= 0 or src_h <= 0:
        print(json.dumps({"error": "Invalid source dimensions"}))
        sys.exit(1)

    aspect = target_w / target_h
    crop_w = int(round(src_h * aspect))
    if crop_w >= src_w:
        crop_h = int(round(src_w / aspect))
        crop_w = src_w
        crop_y = max(0, (src_h - crop_h) // 2)
        crop_height_mode = True
    else:
        crop_h = src_h
        crop_y = 0
        crop_height_mode = False

    detect_fps = 5.0
    sample_every = max(1, int(round(fps / detect_fps)))

    samples = []
    faces_found = 0
    i = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if i % sample_every == 0:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = detect_faces(gray, cascade)
            if len(faces) > 0:
                # Pick largest face
                best = max(faces, key=lambda f: f[2] * f[3])
                x, y, w, h = best
                cx = x + w / 2.0
                samples.append((i, cx))
                faces_found += 1
        i += 1
    cap.release()

    actual_frames = i
    if actual_frames == 0:
        print(json.dumps({"error": "No frames read from input"}))
        sys.exit(1)

    window_frames = max(3, int(round(fps * 0.8)))
    if samples:
        smoothed_x = smooth_trajectory(samples, actual_frames, window_frames)
    else:
        smoothed_x = np.full(actual_frames, src_w / 2.0)

    cap = cv2.VideoCapture(input_path)
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(output_path, fourcc, fps, (target_w, target_h))
    if not out.isOpened():
        print(json.dumps({"error": "Cannot open output writer (codec mp4v failed)"}))
        sys.exit(1)

    written = 0
    j = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if crop_height_mode:
            cropped = frame[crop_y:crop_y + crop_h, 0:crop_w]
        else:
            cx = smoothed_x[j] if j < len(smoothed_x) else src_w / 2.0
            x0 = int(round(cx - crop_w / 2.0))
            x0 = max(0, min(src_w - crop_w, x0))
            cropped = frame[:, x0:x0 + crop_w]
        if cropped.shape[1] != target_w or cropped.shape[0] != target_h:
            cropped = cv2.resize(cropped, (target_w, target_h), interpolation=cv2.INTER_LANCZOS4)
        out.write(cropped)
        written += 1
        j += 1
    cap.release()
    out.release()

    duration = actual_frames / fps if fps > 0 else 0.0
    print(json.dumps({
        "duration": round(duration, 2),
        "fps": round(fps, 2),
        "faces_found": faces_found,
        "frames": written,
        "src_width": src_w,
        "src_height": src_h,
        "out_width": target_w,
        "out_height": target_h,
        "tracked": faces_found > 0 and not crop_height_mode,
        "detector": "opencv-haar",
    }))


if __name__ == "__main__":
    main()
