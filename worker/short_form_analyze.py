#!/usr/bin/env python3
"""Local scene and face evidence for vertical short-form crops."""

import argparse
import json
import os
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("video")
    parser.add_argument("--fps", type=float, default=5.0)
    args = parser.parse_args()

    try:
        import cv2
        import mediapipe as mp
        from scenedetect import ContentDetector, ThresholdDetector, detect
    except Exception as exc:
        print(f"short-form visual dependencies unavailable: {exc}", file=sys.stderr)
        return 2

    capture = cv2.VideoCapture(args.video)
    source_fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    frame_count = capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    duration = frame_count / source_fps if source_fps > 0 else 0
    step = max(1, round(source_fps / max(0.1, args.fps)))

    hard_cut_scenes = detect(args.video, ContentDetector())
    fade_scenes = detect(args.video, ThresholdDetector())
    scene_cuts = sorted(
        {
            round(scene[0].get_seconds(), 6)
            for scenes in (hard_cut_scenes, fade_scenes)
            for scene in scenes[1:]
        }
    )
    faces = []
    coverage = []
    model_path = os.environ.get(
        "MEDIAPIPE_FACE_LANDMARKER_MODEL", "/worker/face_landmarker.task"
    )
    base_options = mp.tasks.BaseOptions(model_asset_path=model_path)
    options = mp.tasks.vision.FaceLandmarkerOptions(
        base_options=base_options,
        running_mode=mp.tasks.vision.RunningMode.VIDEO,
        num_faces=5,
        min_face_detection_confidence=0.35,
        min_face_presence_confidence=0.35,
        min_tracking_confidence=0.35,
        output_face_blendshapes=True,
    )
    detector = mp.tasks.vision.FaceLandmarker.create_from_options(options)
    previous_opening = []
    previous_scene = -1
    frame_index = 0
    sample_duration = step / source_fps
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        if frame_index % step:
            frame_index += 1
            continue
        time = frame_index / source_fps
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        result = detector.detect_for_video(image, round(time * 1000))
        scene = sum(1 for cut in scene_cuts if cut <= time)
        if scene != previous_scene:
            previous_opening = []
            previous_scene = scene
        found = []
        next_opening = []
        for face_index, landmarks in enumerate(result.face_landmarks or []):
            xs = [landmark.x for landmark in landmarks]
            ys = [landmark.y for landmark in landmarks]
            xmin, xmax = max(0.0, min(xs)), min(1.0, max(xs))
            ymin, ymax = max(0.0, min(ys)), min(1.0, max(ys))
            face_height = max(0.001, ymax - ymin)
            opening = abs(landmarks[14].y - landmarks[13].y) / face_height
            next_opening.append(opening)
            mouth_motion = (
                abs(opening - previous_opening[face_index])
                if face_index < len(previous_opening)
                else 0.0
            )
            confidence = 0.8
            found.append(
                {
                    "time": time,
                    "x": xmin,
                    "y": ymin,
                    "width": xmax - xmin,
                    "height": ymax - ymin,
                    "confidence": confidence,
                    "mouthMotion": mouth_motion,
                    "scene": scene,
                }
            )
        previous_opening = next_opening
        faces.extend(found)
        coverage.append(
            {
                "start": time,
                "end": min(duration, time + sample_duration),
                "confidence": max((item["confidence"] for item in found), default=0.0),
            }
        )
        frame_index += 1

    detector.close()
    capture.release()
    print(json.dumps({"sceneCuts": scene_cuts, "faces": faces, "faceCoverage": coverage}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
