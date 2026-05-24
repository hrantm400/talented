import os
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"

import sys
import json
from faster_whisper import WhisperModel

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: whisper-transcribe.py <audio_path>"}))
        sys.exit(1)

    audio_path = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else "base"

    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, info = model.transcribe(audio_path, word_timestamps=True)

    words = []
    full_text_parts = []
    for segment in segments:
        full_text_parts.append(segment.text.strip())
        if segment.words:
            for w in segment.words:
                words.append({
                    "word": w.word.strip(),
                    "start": round(w.start, 2),
                    "end": round(w.end, 2),
                })

    result = {
        "text": " ".join(full_text_parts),
        "words": words,
        "language": info.language,
        "duration": round(info.duration, 2),
    }
    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    main()
