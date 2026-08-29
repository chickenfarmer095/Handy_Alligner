#!/usr/bin/env python3
"""
Hand Tracker Server for Word-Syllable Annotator

Runs MediaPipe hand tracking and communicates with web interface via WebSocket.
Detects hand positions and gestures, broadcasts to connected clients.

Usage: python hand_tracker_server.py [--port 5000] [--camera 0]
"""

import eventlet
eventlet.monkey_patch()

import argparse
import cv2
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision
import numpy as np
import time
import threading
import os
from flask import Flask, send_from_directory, request, jsonify
from flask_socketio import SocketIO, emit
import json

app = Flask(__name__, static_folder='static')
socketio = SocketIO(app, cors_allowed_origins="*")

# Global state for hand tracking
class HandTrackerState:
    def __init__(self):
        self.left_hand = None
        self.right_hand = None
        self.running = False
        self.camera_index = 0
        self.pause_duration = 500  # ms
        self.gesture_sensitivity = 0.05
        self.deadzone_threshold = 0.02
        self.last_gesture_time = 0
        self.gesture_cooldown = 0.5

state = HandTrackerState()

# MediaPipe setup
base_options = python.BaseOptions(model_asset_path='hand_landmarker.task')
hand_options = vision.HandLandmarkerOptions(
    base_options=base_options,
    num_hands=2,
    running_mode=vision.RunningMode.VIDEO
)

def download_model():
    """Ensure hand landmarker model is available"""
    model_path = 'hand_landmarker.task'
    if not os.path.exists(model_path):
        print("Downloading hand landmarker model...")
        try:
            with vision.HandLandmarker.create_from_options(hand_options) as landmarker:
                pass
            print("Model ready")
        except Exception as e:
            print(f"Download model manually from MediaPipe docs: {e}")
            raise

class GestureDetector:
    """Detects double grow/shrink gestures from hand width changes"""
    
    def __init__(self, sensitivity=0.05, deadzone=0.02):
        self.sensitivity = sensitivity
        self.deadzone = deadzone
        self.width_history = []
        self.last_peak_time = 0
        self.last_peak_type = None
        self.cooldown = 0.5
        
    def add_width(self, width):
        if width is None:
            return None
            
        current_time = time.time()
        self.width_history.append((current_time, width))
        
        if len(self.width_history) > 20:
            self.width_history.pop(0)
            
        return self.detect_gesture()
    
    def detect_gesture(self):
        if len(self.width_history) < 3:
            return None
            
        current_time = time.time()
        if current_time - self.last_peak_time < self.cooldown:
            return None
            
        times, widths = zip(*self.width_history)
        widths = list(widths)
        
        # Calculate rate of change
        changes = []
        for i in range(1, len(widths)):
            change = widths[i] - widths[i-1]
            changes.append(abs(change))
            
        # Find significant changes above threshold
        significant_changes = []
        for i, change in enumerate(changes):
            if change > self.deadzone:
                direction = 1 if widths[i+1] > widths[i] else -1
                significant_changes.append((i, direction, change))
                
        # Look for double movements in same direction
        if len(significant_changes) >= 2:
            last_two = significant_changes[-2:]
            if (last_two[0][1] == last_two[1][1] and 
                last_two[1][0] - last_two[0][0] < 10):  # within ~10 frames
                
                # Check if this is part of a double movement
                if len(significant_changes) >= 4:
                    prev_two = significant_changes[-4:-2]
                    if (prev_two[0][1] == prev_two[1][1] == last_two[0][1] and
                        last_two[0][0] - prev_two[1][0] < 15):
                        
                        gesture_type = "double_grow" if last_two[0][1] < 0 else "double_shrink"
                        self.last_peak_time = current_time
                        return gesture_type
                        
        return None

gesture_detector = GestureDetector()

def normalize_hand(hand_landmarks, width, height):
    """Normalize hand position to [0,1] range"""
    if not hand_landmarks:
        return None
        
    x_min, y_min = float('inf'), float('inf')
    x_max, y_max = 0, 0
    
    for lm in hand_landmarks:
        x_min = min(x_min, lm.x * width)
        y_min = min(y_min, lm.y * height)
        x_max = max(x_max, lm.x * width)
        y_max = max(y_max, lm.y * height)
        
    bbox_width = x_max - x_min
    bbox_height = y_max - y_min
    center_x = ((x_min + x_max) / 2) / width
    center_y = ((y_min + y_max) / 2) / height
    
    return {
        'x': center_x,
        'y': center_y,
        'width': bbox_width / width,
        'visible': True
    }

def determine_hand_side(hand_landmarks, width):
    """Determine if hand is left or right"""
    if not hand_landmarks:
        return None
        
    # Use first landmark (wrist) to determine side
    wrist_x = hand_landmarks[0].x * width
    return 'left' if wrist_x < width / 2 else 'right'

def process_frame(frame, landmarker, frame_timestamp_ms):
    """Process frame to detect hands"""
    global state
    
    if frame is None:
        return None
        
    h, w, _ = frame.shape
    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
    
    try:
        result = landmarker.detect_for_video(mp_image, frame_timestamp_ms)
    except Exception as e:
        return None
        
    left_hand = None
    right_hand = None
    
    if result.hand_landmarks:
        for i, hand_landmarks in enumerate(result.hand_landmarks):
            side = determine_hand_side(hand_landmarks, w)
            hand_data = normalize_hand(hand_landmarks, w, h)
            
            if side == 'left':
                left_hand = hand_data
            elif side == 'right':
                right_hand = hand_data
            else:
                # Fallback: assign based on position
                if hand_data and hand_data['x'] < 0.5:
                    if left_hand is None:
                        left_hand = hand_data
                else:
                    if right_hand is None:
                        right_hand = hand_data
                        
        # If we have exactly 2 hands but no sides assigned
        if left_hand is None and right_hand is None and len(result.hand_landmarks) == 2:
            hand1 = normalize_hand(result.hand_landmarks[0], w, h)
            hand2 = normalize_hand(result.hand_landmarks[1], w, h)
            if hand1 and hand2:
                if hand1['x'] < hand2['x']:
                    left_hand, right_hand = hand1, hand2
                else:
                    left_hand, right_hand = hand2, hand1
        
        # Update gesture detector with average width
        if left_hand and right_hand:
            avg_width = (left_hand['width'] + right_hand['width']) / 2
            gesture = gesture_detector.add_width(avg_width)
            if gesture:
                return {'type': 'gesture', 'gesture': gesture}
        elif left_hand or right_hand:
            # Use single hand width
            hand = left_hand or right_hand
            gesture_detector.add_width(hand['width'])
            
    # Update state
    state.left_hand = left_hand
    state.right_hand = right_hand
    
    return {'type': 'hand_positions', 'left': left_hand, 'right': right_hand}

def hand_tracking_loop(camera_index=0):
    """Main hand tracking loop"""
    global state
    
    cap = cv2.VideoCapture(camera_index)
    if not cap.isOpened():
        print(f"Error: Could not open camera {camera_index}")
        socketio.emit('error', {'message': f'Camera {camera_index} not available'})
        return
        
    print(f"Camera {camera_index} started")
    
    with vision.HandLandmarker.create_from_options(hand_options) as landmarker:
        frame_timestamp_ms = 0
        last_emit = 0
        
        while state.running:
            success, frame = cap.read()
            if not success:
                time.sleep(0.03)
                continue
                
            frame = cv2.flip(frame, 1)  # Mirror
            current_time = time.time()
            
            result = process_frame(frame, landmarker, frame_timestamp_ms)
            frame_timestamp_ms += 33  # ~30fps
            
            if result and current_time - last_emit > 1/30:
                socketio.emit('hand_data', result)
                last_emit = current_time
                
            time.sleep(0.01)
        
        cap.release()

# WebSocket handlers
@socketio.on('connect')
def handle_connect():
    print(f"Client connected: {request.sid}")

@socketio.on('disconnect')
def handle_disconnect():
    print(f"Client disconnected: {request.sid}")

@socketio.on('settings')
def handle_settings(data):
    global state
    if 'cameraIndex' in data:
        state.camera_index = int(data['cameraIndex'])
    if 'pauseDuration' in data:
        state.pause_duration = int(data['pauseDuration'])
    if 'gestureSensitivity' in data:
        state.gesture_sensitivity = float(data['gestureSensitivity'])
        gesture_detector.sensitivity = state.gesture_sensitivity
    if 'deadzoneThreshold' in data:
        state.deadzone_threshold = float(data['deadzoneThreshold'])
        gesture_detector.deadzone = state.deadzone_threshold

@socketio.on('toggle_hand_tracking')
def handle_toggle(data):
    global state
    enabled = data.get('enabled', False)
    if enabled:
        if not state.running:
            state.running = True
            threading.Thread(target=hand_tracking_loop, args=(state.camera_index,), daemon=True).start()
    else:
        state.running = False

# HTTP routes
@app.route('/')
def serve_index():
    return send_from_directory('static', 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory('static', path)

@app.route('/api/cameras')
def list_cameras():
    cameras = []
    for i in range(10):
        cap = cv2.VideoCapture(i)
        if cap.isOpened():
            success, _ = cap.read()
            if success:
                cameras.append(i)
        cap.release()
    return jsonify({'cameras': cameras})

def main():
    parser = argparse.ArgumentParser(description='Hand Tracker Server')
    parser.add_argument('--port', type=int, default=5000)
    parser.add_argument('--camera', type=int, default=0)
    args = parser.parse_args()
    
    state.camera_index = args.camera
    
    try:
        download_model()
    except:
        pass
    
    print(f"Starting server on port {args.port}")
    print(f"Using camera {args.camera}")
    print(f"Open http://localhost:{args.port}")
    
    try:
        socketio.run(app, host='0.0.0.0', port=args.port, debug=True)
    except KeyboardInterrupt:
        print("Shutting down...")
        state.running = False

if __name__ == '__main__':
    main()
