import cv2
import argparse
import sys
import json
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision

def find_available_cameras(max_index=10):
    working_cameras = []
    for i in range(max_index):
        cap = cv2.VideoCapture(i, cv2.CAP_V4L2) 
        if cap.isOpened():
            success, _ = cap.read()
            if success:
                working_cameras.append(i)
        cap.release()
    return working_cameras

def main():
    parser = argparse.ArgumentParser(description="Hand Tracking Peripheral Mode.")
    parser.add_argument('-c', '--camera', type=int, default=None, help='Camera index')
    args = parser.parse_args()

    cam_index = args.camera
    if cam_index is None:
        available = find_available_cameras()
        if not available:
            print(json.dumps({"error": "No cameras found"}), file=sys.stderr)
            return
        cam_index = available[0]

    base_options = python.BaseOptions(model_asset_path='hand_landmarker.task')
    options = vision.HandLandmarkerOptions(
        base_options=base_options,
        num_hands=2,
        running_mode=vision.RunningMode.VIDEO
    )

    with vision.HandLandmarker.create_from_options(options) as landmarker:
        cap = cv2.VideoCapture(cam_index)
        if not cap.isOpened():
            print(json.dumps({"error": f"Could not open camera {cam_index}"}), file=sys.stderr)
            return

        frame_timestamp_ms = 0

        while cap.isOpened():
            success, frame = cap.read()
            if not success:
                break

            frame = cv2.flip(frame, 1)
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            h, w, _ = frame.shape
            
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
            frame_timestamp_ms += 33  
            result = landmarker.detect_for_video(mp_image, frame_timestamp_ms)

            # Store boxes for the current frame
            frame_boxes = []

            if result.hand_landmarks:
                for hand_landmarks in result.hand_landmarks:
                    x_min, y_min = w, h
                    x_max, y_max = 0, 0
                    
                    for lm in hand_landmarks:
                        x, y = int(lm.x * w), int(lm.y * h)
                        if x < x_min: x_min = x
                        if x > x_max: x_max = x
                        if y < y_min: y_min = y
                        if y > y_max: y_max = y
                    
                    padding = 20
                    x_min = max(0, x_min - padding)
                    y_min = max(0, y_min - padding)
                    x_max = min(w, x_max + padding)
                    y_max = min(h, y_max + padding)
                    
                    # Package each box neatly
                    frame_boxes.append({
                        "x": x_min,
                        "y": y_min,
                        "w": x_max - x_min,
                        "h": y_max - y_min
                    })

            # Stream data out immediately via stdout
            print(json.dumps({"hands": frame_boxes}))
            sys.stdout.flush()

            # Optional: Add break check if needed, otherwise close via process killer
            if cv2.waitKey(1) & 0xFF == ord('q'):
                break

        cap.release()

if __name__ == "__main__":
    main()

