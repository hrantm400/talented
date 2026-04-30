"""
Real motion tracking — OpenCV-only.

Initialization: Haar cascade face detection on the first ~30 frames; if a face
is found, seed a CSRT tracker on it. Otherwise the user can pass an initial
bbox (x,y,w,h). The CSRT tracker output drives the overlay text position
through every subsequent frame.

Output: a video where the supplied overlay text follows the tracked subject.
Text rendered with PIL so unicode/emoji characters work; falls back to a sans
font when no emoji font is installed.

Usage:
  python motion-track.py <input> <output> <text> [bbox=auto|"x,y,w,h"]

Stdout: JSON {"duration": float, "fps": float, "tracked_frames": int, ...}
"""
import os
os.environ["OPENCV_LOG_LEVEL"] = "ERROR"

import sys
import json
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont


TEXT_FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
]
EMOJI_FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
    "/usr/share/fonts/noto/NotoColorEmoji.ttf",
    "/System/Library/Fonts/Apple Color Emoji.ttc",
]


def load_font(size):
    for candidate in TEXT_FONT_CANDIDATES:
        if os.path.exists(candidate):
            try:
                return ImageFont.truetype(candidate, size)
            except Exception:
                continue
    return ImageFont.load_default()


def detect_initial_bbox(cap, cascade, max_frames=30):
    bbox = None
    seen = 0
    while seen < max_frames:
        ret, frame = cap.read()
        if not ret:
            break
        seen += 1
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = cascade.detectMultiScale(gray, scaleFactor=1.15, minNeighbors=5, minSize=(60, 60))
        if len(faces) > 0:
            best = max(faces, key=lambda f: f[2] * f[3])
            x, y, w, h = best
            bbox = (int(x), int(y), int(w), int(h))
            break
    return bbox, seen


def make_tracker():
    if hasattr(cv2, "TrackerCSRT_create"):
        return cv2.TrackerCSRT_create()
    if hasattr(cv2, "legacy") and hasattr(cv2.legacy, "TrackerCSRT_create"):
        return cv2.legacy.TrackerCSRT_create()
    if hasattr(cv2, "TrackerKCF_create"):
        return cv2.TrackerKCF_create()
    return None


def draw_text(frame, text, cx, cy, font_size=64):
    pil_img = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(pil_img, "RGBA")
    font = load_font(font_size)
    try:
        bbox = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    except Exception:
        tw, th = font.getsize(text) if hasattr(font, "getsize") else (len(text) * font_size // 2, font_size)
    pad = 14
    x0 = int(cx - tw / 2) - pad
    y0 = int(cy - th / 2) - pad
    x1 = x0 + tw + 2 * pad
    y1 = y0 + th + 2 * pad
    draw.rectangle([x0, y0, x1, y1], fill=(0, 0, 0, 140))
    draw.text((x0 + pad, y0 + pad), text, fill=(255, 255, 255, 255), font=font)
    return cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)


def main():
    if len(sys.argv) < 4:
        print(json.dumps({"error": "Usage: motion-track.py <input> <output> <text> [bbox]"}))
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]
    overlay_text = sys.argv[3]
    bbox_arg = sys.argv[4] if len(sys.argv) > 4 else "auto"

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

    init_bbox = None
    if bbox_arg != "auto":
        try:
            parts = [int(p) for p in bbox_arg.split(",")]
            if len(parts) == 4:
                init_bbox = tuple(parts)
        except Exception:
            init_bbox = None
    if init_bbox is None:
        init_bbox, _ = detect_initial_bbox(cap, cascade)
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)

    tracker = None
    if init_bbox is not None:
        tracker = make_tracker()
        if tracker is None:
            print(json.dumps({"error": "OpenCV has no CSRT/KCF tracker available"}))
            sys.exit(1)
        ret, first = cap.read()
        if not ret:
            print(json.dumps({"error": "Cannot read first frame"}))
            sys.exit(1)
        tracker.init(first, init_bbox)
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(output_path, fourcc, fps, (src_w, src_h))
    if not out.isOpened():
        print(json.dumps({"error": "Cannot open output writer"}))
        sys.exit(1)

    smoothed = None
    alpha = 0.3
    tracked_frames = 0
    written = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        cx, cy = src_w / 2.0, src_h / 2.0
        if tracker is not None:
            ok, bb = tracker.update(frame)
            if ok:
                bx, by, bw, bh = bb
                cx_t, cy_t = bx + bw / 2.0, by + bh / 2.0
                if smoothed is None:
                    smoothed = (cx_t, cy_t)
                else:
                    smoothed = (
                        smoothed[0] * (1 - alpha) + cx_t * alpha,
                        smoothed[1] * (1 - alpha) + cy_t * alpha,
                    )
                cx, cy = smoothed
                tracked_frames += 1
            elif smoothed is not None:
                cx, cy = smoothed
        text_cy = max(80, cy - max(40, src_h * 0.08))
        font_size = max(36, min(80, int(src_h * 0.05)))
        rendered = draw_text(frame, overlay_text, cx, text_cy, font_size=font_size)
        out.write(rendered)
        written += 1

    cap.release()
    out.release()

    print(json.dumps({
        "duration": round(written / fps, 2) if fps > 0 else 0.0,
        "fps": round(fps, 2),
        "frames": written,
        "tracked_frames": tracked_frames,
        "init_bbox": list(init_bbox) if init_bbox else None,
        "tracking_method": "csrt" if init_bbox else "static_center",
        "detector": "opencv-haar",
    }))


if __name__ == "__main__":
    main()
