"use client";
import React, { useEffect, useState, useRef } from "react";
import { CobraWorker } from "@picovoice/cobra-web";
import { WebVoiceProcessor } from "@picovoice/web-voice-processor";

const PICOVOICE_ACCESS_KEY = process.env.NEXT_PUBLIC_PICOVOICE_ACCESS_KEY;

const VOICE_PROBABILITY_THRESHOLD = 0.2;
const SILENCE_DURATION_THRESHOLD = 1500;
const MIN_RECORDING_DURATION = 500;

interface AudioClip {
  id: number;
  url: string;
  timestamp: Date;
  duration: number;
}

const VoiceDetector: React.FC = () => {
  const [isInitialized, setIsInitialized] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [audioClips, setAudioClips] = useState<AudioClip[]>([]);
  const [latestClip, setLatestClip] = useState<AudioClip | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isListeningRef = useRef(false);
  const isRecordingRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const silenceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const recordingStartTimeRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cobraRef = useRef<CobraWorker | null>(null);

  const handleVoiceDetected = async () => {
    if (silenceTimeoutRef.current) {
      clearTimeout(silenceTimeoutRef.current);
      silenceTimeoutRef.current = null;
    }

    if (
      !isRecordingRef.current &&
      isListeningRef.current &&
      streamRef.current
    ) {
      try {
        await startRecording();
      } catch (err) {
        console.error("Voice detection error:", err);
        setError("Error detecting voice");
      }
    }
  };

  const handleSilenceDetected = () => {
    if (!silenceTimeoutRef.current && isRecordingRef.current) {
      silenceTimeoutRef.current = setTimeout(() => {
        stopRecording();
        silenceTimeoutRef.current = null;
      }, SILENCE_DURATION_THRESHOLD);
    }
  };

  const initializeVoiceDetector = async () => {
    try {
      if (!PICOVOICE_ACCESS_KEY) {
        throw new Error(
          "Picovoice access key is not configured in environment variables"
        );
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      streamRef.current = stream;

      const handleVoiceProbability = (probability: number) => {
        if (probability >= VOICE_PROBABILITY_THRESHOLD) {
          void handleVoiceDetected();
        } else {
          handleSilenceDetected();
        }
      };

      const cobraInstance = await CobraWorker.create(
        PICOVOICE_ACCESS_KEY,
        handleVoiceProbability
      );

      cobraRef.current = cobraInstance;
      setIsInitialized(true);
      setError(null);
    } catch (err) {
      console.error("Initialization error:", err);
      setError(
        err instanceof Error
          ? err.message
          : "Failed to initialize voice detector"
      );
    }
  };

  const startRecording = async () => {
    if (!streamRef.current || mediaRecorderRef.current?.state === "recording") {
      return;
    }

    try {
      const options = { mimeType: "audio/webm;codecs=opus" };
      if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        throw new Error(`MIME type ${options.mimeType} is not supported`);
      }

      const mediaRecorder = new MediaRecorder(streamRef.current, options);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      const startTime = Date.now();
      recordingStartTimeRef.current = startTime;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const endTime = Date.now();
        const duration = startTime ? endTime - startTime : 0;

        if (
          duration >= MIN_RECORDING_DURATION &&
          audioChunksRef.current.length > 0
        ) {
          try {
            const audioBlob = new Blob(audioChunksRef.current, {
              type: "audio/webm",
            });
            const audioUrl = URL.createObjectURL(audioBlob);

            const newClip = {
              id: Date.now(),
              url: audioUrl,
              timestamp: new Date(),
              duration: duration / 1000,
            };

            setLatestClip(newClip);
            setAudioClips((prev) => [newClip, ...prev]);
          } catch (err) {
            console.error("Failed to create audio clip:", err);
            setError("Failed to create audio clip");
          }
        }

        audioChunksRef.current = [];
        isRecordingRef.current = false;
        recordingStartTimeRef.current = null;
        setIsRecording(false);
      };

      mediaRecorder.start(500);
      isRecordingRef.current = true;
      setIsRecording(true);
    } catch (err) {
      console.error("Recording error:", err);
      setError("Failed to start recording");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state === "recording") {
      try {
        mediaRecorderRef.current.stop();
      } catch (err) {
        console.error("Stop recording error:", err);
        setError("Failed to stop recording");
      }
    }
  };

  const startListening = async () => {
    if (!isInitialized || !cobraRef.current) return;

    try {
      await WebVoiceProcessor.subscribe(cobraRef.current);
      isListeningRef.current = true;
      setIsListening(true);
      setError(null);
    } catch (err) {
      console.error("Start error:", err);
      setError("Failed to start listening");
    }
  };

  const stopListening = async () => {
    if (!isListeningRef.current || !cobraRef.current) return;

    try {
      await WebVoiceProcessor.unsubscribe(cobraRef.current);
      if (isRecordingRef.current) {
        stopRecording();
      }
      isListeningRef.current = false;
      setIsListening(false);
      setError(null);
    } catch (err) {
      console.error("Stop error:", err);
      setError("Failed to stop listening");
    }
  };

  const clearRecordings = () => {
    audioClips.forEach((clip) => URL.revokeObjectURL(clip.url));
    setAudioClips([]);
    setLatestClip(null);
  };

  useEffect(() => {
    initializeVoiceDetector();

    return () => {
      if (isListeningRef.current && cobraRef.current) {
        WebVoiceProcessor.unsubscribe(cobraRef.current).catch(console.error);
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (cobraRef.current) {
        cobraRef.current.release().catch(console.error);
      }
      audioClips.forEach((clip) => URL.revokeObjectURL(clip.url));
    };
  }, []);

  return (
    <div className="p-4">
      {error && (
        <div className="mb-4 p-4 bg-red-100 text-red-700 rounded">{error}</div>
      )}

      <div className="space-x-4 mb-4">
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
            Clear Recordings
          </button>
        )}
      </div>

      <div className="mb-4">
        <div className="flex items-center space-x-2">
          <div
            className={`w-3 h-3 rounded-full ${
              isListening
                ? isRecording
                  ? "animate-pulse bg-red-500"
                  : "bg-green-500"
                : "bg-gray-500"
            }`}
          />
          <span>
            {isListening
              ? isRecording
                ? "Recording..."
                : "Listening..."
              : "Not active"}
          </span>
        </div>
      </div>

      {latestClip && (
        <div className="mb-6 border-b pb-4">
          <h2 className="text-lg font-semibold mb-2">Latest Recording</h2>
          <div className="bg-blue-50 p-4 rounded shadow-sm">
            <div className="mb-2">
              <span className="text-sm text-blue-600">
                {latestClip.timestamp.toLocaleTimeString()} (
                {latestClip.duration.toFixed(1)}s)
              </span>
            </div>
            <audio controls src={latestClip.url} className="w-full" />
          </div>
        </div>
      )}

      {audioClips.length > 1 && (
        <div>
          <h2 className="text-lg font-semibold mb-2">Previous Recordings</h2>
          <div className="space-y-4">
            {audioClips.slice(1).map((clip) => (
              <div key={clip.id} className="bg-gray-100 p-4 rounded">
                <div className="mb-2">
                  <span className="text-sm text-gray-600">
                    {clip.timestamp.toLocaleTimeString()} (
                    {clip.duration.toFixed(1)}s)
                  </span>
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
