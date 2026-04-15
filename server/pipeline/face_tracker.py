import cv2
import mediapipe as mp
import sys
import json

def get_face_center(video_path):
    mp_face_detection = mp.solutions.face_detection
    cap = cv2.VideoCapture(video_path)

    if not cap.isOpened():
        print(json.dumps({"error": "Cannot open video"}))
        sys.exit(1)

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS)

    centers = []

    with mp_face_detection.FaceDetection(model_selection=1, min_detection_confidence=0.5) as face_detection:
        while cap.isOpened():
            success, image = cap.read()
            if not success:
                break

            image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            results = face_detection.process(image_rgb)

            if results.detections:
                detection = results.detections[0] # take the most prominent face
                bboxC = detection.location_data.relative_bounding_box
                x_center = bboxC.xmin + bboxC.width / 2
                centers.append(x_center)
            else:
                # If no face, keep the last known position or center
                if centers:
                    centers.append(centers[-1])
                else:
                    centers.append(0.5)

    cap.release()

    if not centers:
        print(json.dumps({"error": "No frames processed"}))
        sys.exit(1)

    # Output a simplified smoothing logic: just take the median or average for now
    # More advanced: output a moving average or keyframes for ffmpeg, but for a single static crop, average is safe
    avg_x = sum(centers) / len(centers)
    pixel_x = int(avg_x * width)

    # Calculate crop coordinates for 9:16 aspect ratio
    crop_width = int(height * 9 / 16)

    # Ensure crop doesn't go out of bounds
    crop_x = max(0, min(pixel_x - crop_width // 2, width - crop_width))

    print(json.dumps({"crop_x": crop_x, "crop_width": crop_width, "height": height}))

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Missing video path"}))
        sys.exit(1)

    get_face_center(sys.argv[1])
