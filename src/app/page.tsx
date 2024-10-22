"use client";

import React, { useState, useRef, useCallback, useEffect } from "react";
import VAD from "voice-activity-detection";

const Index: React.FC = () => {
  const [isListening, setIsListening] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [audioPackets, setAudioPackets] = useState<string[]>([]);

  // Refs for media handling
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const vadRef = useRef<VAD | null>(null);

  // Refs for pause detection
  const silenceStartRef = useRef<number | null>(null);
  const isLongPauseRef = useRef(false);
  const pauseTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const currentRecordingStartTime = useRef<number>(0);

  // Configuration constants
  const PAUSE_THRESHOLD = 2000; // Time in ms to consider a pause as end of speech
  const NOISE_FLOOR = 0.1; // Minimum noise level to detect speech
  const VOICE_TIMEOUT = 500; // Time to wait before considering silence
  const MIN_RECORDING_LENGTH = 500; // Minimum recording length in ms to save

  const handlePause = useCallback(() => {
    if (!silenceStartRef.current) {
      silenceStartRef.current = Date.now();

      // Set a timeout to check if this is a long pause
      pauseTimeoutRef.current = setTimeout(() => {
        const pauseDuration = Date.now() - (silenceStartRef.current || 0);
        if (pauseDuration >= PAUSE_THRESHOLD) {
          isLongPauseRef.current = true;
          stopRecording();
        }
      }, PAUSE_THRESHOLD);
    }
  }, []);

  const handleSpeech = useCallback(() => {
    // Clear any existing pause detection
    if (pauseTimeoutRef.current) {
      clearTimeout(pauseTimeoutRef.current);
    }
    silenceStartRef.current = null;
    isLongPauseRef.current = false;
  }, []);

  const startListening = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      const vad = new VAD(audioContext, stream, {
        onVoiceStart: () => {
          console.log("Voice started");
          handleSpeech();
          if (!isRecording) {
            startRecording();
          }
        },
        onVoiceStop: () => {
          console.log("Voice paused");
          handlePause();
        },
        minNoiseLevel: NOISE_FLOOR,
        maxNoiseLevel: 0.5,
        noiseCaptureDuration: VOICE_TIMEOUT,
      });
      vadRef.current = vad;

      setIsListening(true);
    } catch (error) {
      console.error("Error starting listening:", error);
    }
  }, [handlePause, handleSpeech, isRecording]);

  const stopListening = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
    }
    if (vadRef.current) {
      vadRef.current.destroy();
    }
    if (pauseTimeoutRef.current) {
      clearTimeout(pauseTimeoutRef.current);
    }
    setIsListening(false);
    setIsRecording(false);
  }, []);

  const saveRecording = useCallback((chunks: Blob[]) => {
    const audioBlob = new Blob(chunks, { type: "audio/wav" });
    if (audioBlob.size > 0) {
      const audioUrl = URL.createObjectURL(audioBlob);
      setAudioPackets((prev) => [...prev, audioUrl]);
    }
  }, []);

  const startRecording = useCallback(() => {
    if (!streamRef.current) return;

    const mediaRecorder = new MediaRecorder(streamRef.current);
    mediaRecorderRef.current = mediaRecorder;
    audioChunksRef.current = [];
    currentRecordingStartTime.current = Date.now();

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunksRef.current.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      const recordingDuration = Date.now() - currentRecordingStartTime.current;

      // Only save recordings longer than MIN_RECORDING_LENGTH
      if (recordingDuration >= MIN_RECORDING_LENGTH) {
        saveRecording(audioChunksRef.current);
      }

      // Start a new recording immediately if still listening
      if (isListening && !isLongPauseRef.current) {
        const newMediaRecorder = new MediaRecorder(streamRef.current!);
        mediaRecorderRef.current = newMediaRecorder;
        audioChunksRef.current = [];
        currentRecordingStartTime.current = Date.now();

        newMediaRecorder.ondataavailable = mediaRecorder.ondataavailable;
        newMediaRecorder.onstop = mediaRecorder.onstop;
        newMediaRecorder.start(1000); // Get data every second
      }
    };

    // Start recording with a timeslice to get data periodically
    mediaRecorder.start(1000);
    setIsRecording(true);
  }, [isListening, saveRecording]);

  const stopRecording = useCallback(() => {
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state === "recording"
    ) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }, []);

  useEffect(() => {
    return () => {
      stopListening();
      audioPackets.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [stopListening, audioPackets]);

  return (
    <div className="p-4">
      <button
        className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
        onClick={isListening ? stopListening : startListening}
      >
        {isListening ? "Stop Listening" : "Start Listening"}
      </button>
      <p className="mt-4">
        Status:{" "}
        {isListening
          ? isRecording
            ? "Recording"
            : "Listening for speech..."
          : "Idle"}
      </p>
      <div className="mt-4 space-y-4">
        {audioPackets.map((packet, index) => (
          <div key={`${packet}-${index}`} className="border p-4 rounded">
            <p className="font-bold mb-2">Recording {index + 1}:</p>
            <audio
              src={packet}
              controls
              className="w-full"
              onError={() => console.error("Error loading audio packet")}
            />
          </div>
        ))}
      </div>
    </div>
  );
};

export default Index;
