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

("use client");
import React, { useEffect, useState, useRef } from "react";
import { CobraWorker } from "@picovoice/cobra-web";
import { WebVoiceProcessor } from "@picovoice/web-voice-processor";

const PICOVOICE_ACCESS_KEY =
  "KQFW1maCtiLd2xAeMMwttKqPzLH5k+QK6N3pfi9p83dGFDu0QlVxMA==";
const VOICE_PROBABILITY_THRESHOLD = 0.2;
const SILENCE_DURATION_THRESHOLD = 1500; // 1.5 seconds

interface VoiceDetectorProps {
  onVoiceDetected?: (probability: number) => void;
}

interface AudioClip {
  id: number;
  blob: Blob;
  url: string;
  timestamp: Date;
  duration: number;
}

const VoiceDetector: React.FC<VoiceDetectorProps> = ({ onVoiceDetected }) => {
  const [isInitialized, setIsInitialized] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cobra, setCobra] = useState<CobraWorker | null>(null);
  const [audioClips, setAudioClips] = useState<AudioClip[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [currentProbability, setCurrentProbability] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const silenceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const recordingStartTimeRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    initializeVoiceDetector();
    return () => {
      releaseResources();
    };
  }, []);

  const initializeVoiceDetector = async () => {
    try {
      const handleVoiceProbability = (probability: number) => {
        setCurrentProbability(probability);

        if (probability > VOICE_PROBABILITY_THRESHOLD) {
          onVoiceDetected?.(probability);
          handleVoiceDetected();
        } else {
          handleSilenceDetected();
        }
      };

      const cobraInstance = await CobraWorker.create(
        PICOVOICE_ACCESS_KEY,
        handleVoiceProbability
      );

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      setCobra(cobraInstance);
      setIsInitialized(true);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to initialize voice detector"
      );
      console.error("Initialization error:", err);
    }
  };

  const startRecording = async () => {
    if (!streamRef.current || mediaRecorderRef.current?.state === "recording") {
      return;
    }

    try {
      const mediaRecorder = new MediaRecorder(streamRef.current);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        if (audioChunksRef.current.length > 0) {
          const audioBlob = new Blob(audioChunksRef.current, {
            type: "audio/wav",
          });
          const audioUrl = URL.createObjectURL(audioBlob);
          const duration = recordingStartTimeRef.current
            ? (Date.now() - recordingStartTimeRef.current) / 1000
            : 0;

          setAudioClips((prev) => [
            ...prev,
            {
              id: Date.now(),
              blob: audioBlob,
              url: audioUrl,
              timestamp: new Date(),
              duration,
            },
          ]);
        }
        audioChunksRef.current = [];
      };

      mediaRecorder.start(1000);
      recordingStartTimeRef.current = Date.now();
      setIsRecording(true);
    } catch (err) {
      console.error("Error starting recording:", err);
      setError(
        "Failed to start recording: " +
          (err instanceof Error ? err.message : String(err))
      );
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      recordingStartTimeRef.current = null;
    }
  };

  const handleVoiceDetected = () => {
    if (silenceTimeoutRef.current) {
      clearTimeout(silenceTimeoutRef.current);
      silenceTimeoutRef.current = null;
    }

    if (!isRecording && isListening) {
      console.log("Voice detected, starting recording...");
      startRecording();
    }
  };

  const handleSilenceDetected = () => {
    if (!silenceTimeoutRef.current && isRecording) {
      console.log("Silence detected, stopping recording...");
      silenceTimeoutRef.current = setTimeout(() => {
        stopRecording();
        silenceTimeoutRef.current = null;
      }, SILENCE_DURATION_THRESHOLD);
    }
  };

  const startListening = async () => {
    if (!isListening && cobra) {
      try {
        await WebVoiceProcessor.subscribe(cobra);
        setIsListening(true);
        setError(null);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to start voice detection"
        );
        console.error("Start error:", err);
      }
    }
  };

  const stopListening = async () => {
    if (isListening && cobra) {
      try {
        await WebVoiceProcessor.unsubscribe(cobra);
        setIsListening(false);
        if (isRecording) {
          stopRecording();
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to stop voice detection"
        );
        console.error("Stop error:", err);
      }
    }
  };

  const clearRecordings = () => {
    audioClips.forEach((clip) => URL.revokeObjectURL(clip.url));
    setAudioClips([]);
  };

  const releaseResources = async () => {
    if (cobra) {
      try {
        if (isListening) {
          await WebVoiceProcessor.unsubscribe(cobra);
        }
        if (isRecording) {
          stopRecording();
        }
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }
        await cobra.release();
        clearRecordings();
        setCobra(null);
        setIsListening(false);
        setIsInitialized(false);
      } catch (err) {
        console.error("Error releasing resources:", err);
      }
    }
  };

  return (
    <div className="p-4">
      <h1 className="text-2xl font-bold mb-4">Voice Detector</h1>

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          <p>{error}</p>
        </div>
      )}

      <div className="space-x-4">
        <button
          onClick={startListening}
          disabled={!isInitialized || isListening}
          className={`px-4 py-2 rounded ${
            !isInitialized || isListening
              ? "bg-gray-300 cursor-not-allowed"
              : "bg-green-500 hover:bg-green-600 text-white"
          }`}
        >
          Start Listening
        </button>

        <button
          onClick={stopListening}
          disabled={!isListening}
          className={`px-4 py-2 rounded ${
            !isListening
              ? "bg-gray-300 cursor-not-allowed"
              : "bg-red-500 hover:bg-red-600 text-white"
          }`}
        >
          Stop Listening
        </button>

        {audioClips.length > 0 && (
          <button
            onClick={clearRecordings}
            className="px-4 py-2 rounded bg-gray-500 hover:bg-gray-600 text-white"
          >
            Clear All Recordings
          </button>
        )}
      </div>

      <div className="mt-4">
        <div className="flex items-center space-x-2">
          <div
            className={`w-3 h-3 rounded-full ${
              isListening ? "bg-green-500" : "bg-gray-500"
            }`}
          />
          <span className={isListening ? "text-green-500" : "text-gray-500"}>
            {isListening
              ? isRecording
                ? "Recording voice..."
                : "Listening for voice..."
              : "Not listening"}
          </span>
        </div>

        <div className="mt-2 text-sm text-gray-600">
          Voice Probability: {(currentProbability * 100).toFixed(1)}%
          <div className="w-full bg-gray-200 h-2 mt-1 rounded-full">
            <div
              className="bg-blue-500 h-2 rounded-full transition-all duration-200"
              style={{ width: `${currentProbability * 100}%` }}
            />
          </div>
        </div>
      </div>

      {audioClips.length > 0 && (
        <div className="mt-6">
          <h2 className="text-xl font-semibold mb-3">Recorded Audio Clips</h2>
          <div className="space-y-4">
            {audioClips.map((clip) => (
              <div key={clip.id} className="bg-gray-100 p-4 rounded">
                <div className="flex justify-between items-center mb-2">
                  <p className="text-sm text-gray-600">
                    {clip.timestamp.toLocaleTimeString()} (
                    {clip.duration.toFixed(1)}s)
                  </p>
                </div>
                <audio controls src={clip.url} className="w-full" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default VoiceDetector;
