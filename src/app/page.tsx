"use client";
import React, { useState, useRef, useEffect } from "react";
import { CobraWorker } from "@picovoice/cobra-web";
import { WebVoiceProcessor } from "@picovoice/web-voice-processor";

interface Timestamps {
  words: string[];
  start_time_seconds: number[];
  end_time_seconds: number[];
}

interface TranscriptionResponse {
  transcript: string;
  timestamps: Timestamps | null;
}

// Environment variable type declarations
declare global {
  interface Window {
    ENV: {
      PICOVOICE_ACCESS_KEY: string;
      ASSEMBLY_API_KEY: string;
      SARVAM_API_KEY: string;
    };
  }
}

// Constants for voice detection and silence handling
const VOICE_PROBABILITY_THRESHOLD = 0.5;
const SILENCE_DURATION_THRESHOLD = 1500; // 1.5 seconds of silence before stopping
const MIN_RECORDING_DURATION = 500; // Minimum recording duration of 0.5 seconds
const DEBUG = true;

// Get environment variables
const getEnvVariables = () => ({
  PICOVOICE_ACCESS_KEY: process.env.NEXT_PUBLIC_PICOVOICE_ACCESS_KEY,
  ASSEMBLY_API_KEY: process.env.NEXT_PUBLIC_ASSEMBLY_API_KEY,
  SARVAM_API_KEY: process.env.NEXT_PUBLIC_API_KEY,
});

// Helper function to convert float32 to 16-bit PCM
function floatTo16BitPCM(
  output: DataView,
  offset: number,
  input: Float32Array
) {
  for (let i = 0; i < input.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
}

// Helper function to write string to DataView
function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

// Convert AudioBuffer to WAV Blob
function bufferToWav(audioBuffer: AudioBuffer): Blob {
  const numOfChan = audioBuffer.numberOfChannels;
  const length = audioBuffer.length * numOfChan * 2;
  const buffer = new ArrayBuffer(44 + length);
  const view = new DataView(buffer);
  let pos = 0;

  // write WAVE header
  writeString(view, pos, "RIFF");
  pos += 4;
  view.setUint32(pos, 36 + length, true);
  pos += 4;
  writeString(view, pos, "WAVE");
  pos += 4;
  writeString(view, pos, "fmt ");
  pos += 4;
  view.setUint32(pos, 16, true);
  pos += 4;
  view.setUint16(pos, 1, true);
  pos += 2;
  view.setUint16(pos, numOfChan, true);
  pos += 2;
  view.setUint32(pos, audioBuffer.sampleRate, true);
  pos += 4;
  view.setUint32(pos, audioBuffer.sampleRate * numOfChan * 2, true);
  pos += 4;
  view.setUint16(pos, numOfChan * 2, true);
  pos += 2;
  view.setUint16(pos, 16, true);
  pos += 2;
  writeString(view, pos, "data");
  pos += 4;
  view.setUint32(pos, length, true);
  pos += 4;

  // write PCM data
  const data = new Float32Array(audioBuffer.length * numOfChan);
  let offset = 0;

  for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
    data.set(audioBuffer.getChannelData(i), offset);
    offset += audioBuffer.length;
  }

  floatTo16BitPCM(view, 44, data);

  return new Blob([buffer], { type: "audio/wav" });
}

// Convert Blob to AudioBuffer
async function blobToAudioBuffer(
  blob: Blob,
  audioContext: AudioContext
): Promise<AudioBuffer> {
  const arrayBuffer = await blob.arrayBuffer();
  return await audioContext.decodeAudioData(arrayBuffer);
}

const RealtimeSpeechToText = () => {
  const [isInitialized, setIsInitialized] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcription, setTranscription] =
    useState<TranscriptionResponse | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastResponseTime, setLastResponseTime] = useState<number | null>(null);

  // Refs for managing state across callbacks
  const isListeningRef = useRef(false);
  const isRecordingRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const silenceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cobraRef = useRef<CobraWorker | null>(null);
  const recordingStartTimeRef = useRef<number | null>(null);

  // Initialize voice detector and audio setup
  const initializeVoiceDetector = async () => {
    try {
      const env = getEnvVariables();

      if (!env.PICOVOICE_ACCESS_KEY) {
        throw new Error(
          "Picovoice access key is not configured in environment variables"
        );
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000,
          channelCount: 1,
        },
      });

      streamRef.current = stream;

      const handleVoiceProbability = (probability: number) => {
        if (DEBUG) {
          console.log("Voice probability:", probability);
        }
        if (probability >= VOICE_PROBABILITY_THRESHOLD) {
          void handleVoiceDetected();
        } else {
          handleSilenceDetected();
        }
      };

      const cobraInstance = await CobraWorker.create(
        env.PICOVOICE_ACCESS_KEY,
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

  const handleVoiceDetected = async () => {
    if (silenceTimeoutRef.current) {
      clearTimeout(silenceTimeoutRef.current);
      silenceTimeoutRef.current = null;
    }

    if (
      !isRecordingRef.current &&
      isListeningRef.current &&
      streamRef.current &&
      !isProcessing
    ) {
      if (DEBUG) console.log("Voice detected, starting recording");
      await startRecording();
    }
  };

  const handleSilenceDetected = () => {
    if (!silenceTimeoutRef.current && isRecordingRef.current) {
      silenceTimeoutRef.current = setTimeout(() => {
        if (DEBUG) console.log("Silence detected, stopping recording");
        stopRecording();
        silenceTimeoutRef.current = null;
      }, SILENCE_DURATION_THRESHOLD);
    }
  };

  const processAndSendAudio = async (audioBlob: Blob) => {
    try {
      const env = getEnvVariables();

      if (!env.SARVAM_API_KEY) {
        throw new Error(
          "Sarvam API key is not configured in environment variables"
        );
      }

      if (DEBUG) {
        console.log("Processing audio:", {
          originalSize: audioBlob.size,
          originalType: audioBlob.type,
        });
      }

      // Create AudioContext with specific sample rate
      const audioContext = new (window.AudioContext ||
        (window as any).webkitAudioContext)({
        sampleRate: 16000,
      });

      // Convert blob to AudioBuffer
      const audioBuffer = await blobToAudioBuffer(audioBlob, audioContext);

      // Convert to WAV
      const wavBlob = bufferToWav(audioBuffer);

      if (DEBUG) {
        console.log("Converted audio:", {
          wavSize: wavBlob.size,
          wavType: wavBlob.type,
          sampleRate: audioBuffer.sampleRate,
          channels: audioBuffer.numberOfChannels,
          duration: audioBuffer.duration,
        });
      }

      const formData = new FormData();
      formData.append("file", wavBlob, "recording.wav");
      formData.append("language_code", "hi-IN");
      formData.append("model", "saarika:v1");
      formData.append("with_timestamps", "true");

      const response = await fetch("https://api.sarvam.ai/speech-to-text", {
        method: "POST",
        headers: {
          "api-subscription-key": env.SARVAM_API_KEY,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API Error (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      setLastResponseTime(Date.now());

      if (DEBUG) {
        console.log("API Response:", data);
      }

      setTranscription((prev) => ({
        transcript: prev
          ? prev.transcript + " " + data.transcript
          : data.transcript,
        timestamps: data.timestamps,
      }));
    } catch (err) {
      console.error("API Error:", err);
      setError(err instanceof Error ? err.message : "Transcription failed");
    }
  };

  const startRecording = async () => {
    if (
      !streamRef.current ||
      mediaRecorderRef.current?.state === "recording" ||
      isProcessing
    ) {
      return;
    }

    setIsProcessing(true);

    try {
      const options = {
        mimeType: "audio/webm;codecs=opus",
        bitsPerSecond: 16000,
      };

      const mediaRecorder = new MediaRecorder(streamRef.current, options);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      const startTime = Date.now();
      recordingStartTimeRef.current = startTime;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        try {
          const duration = Date.now() - (recordingStartTimeRef.current || 0);

          if (
            duration >= MIN_RECORDING_DURATION &&
            chunksRef.current.length > 0
          ) {
            const audioBlob = new Blob(chunksRef.current, {
              type: "audio/webm;codecs=opus",
            });
            await processAndSendAudio(audioBlob);
          }
        } catch (err) {
          console.error("Error processing recording:", err);
          setError("Failed to process recording");
        } finally {
          chunksRef.current = [];
          isRecordingRef.current = false;
          recordingStartTimeRef.current = null;
          setIsRecording(false);
          setIsProcessing(false);
        }
      };

      mediaRecorder.start(500); // Record in 500ms chunks
      isRecordingRef.current = true;
      setIsRecording(true);
    } catch (err) {
      console.error("Recording error:", err);
      setError("Failed to start recording");
      setIsProcessing(false);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state === "recording") {
      if (DEBUG) console.log("Stopping recording");
      mediaRecorderRef.current.stop();
    }
  };

  const startListening = async () => {
    if (!isInitialized || !cobraRef.current) return;

    try {
      await WebVoiceProcessor.subscribe(cobraRef.current);
      isListeningRef.current = true;
      setIsListening(true);
      setError(null);
      if (DEBUG) console.log("Started listening for voice activity");
    } catch (err) {
      console.error("Start listening error:", err);
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
      if (DEBUG) console.log("Stopped listening for voice activity");
    } catch (err) {
      console.error("Stop listening error:", err);
      setError("Failed to stop listening");
    }
  };

  useEffect(() => {
    void initializeVoiceDetector();

    return () => {
      if (isListeningRef.current && cobraRef.current) {
        void WebVoiceProcessor.unsubscribe(cobraRef.current);
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (cobraRef.current) {
        void cobraRef.current.release();
      }
    };
  }, []);

  return (
    <div className="p-4">
      {error && (
        <div className="mb-4 p-4 bg-red-100 text-red-700 rounded">{error}</div>
      )}

      <div className="mb-4 flex items-center gap-4">
        {isListening ? (
          <button
            onClick={() => void stopListening()}
            className="bg-red-500 text-white px-4 py-2 rounded hover:bg-red-600 transition-colors"
          >
            Stop Listening
          </button>
        ) : (
          <button
            onClick={() => void startListening()}
            className="bg-green-500 text-white px-4 py-2 rounded hover:bg-green-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={!isInitialized}
          >
            Start Listening
          </button>
        )}

        {isRecording && (
          <div className="flex items-center text-yellow-600">
            <div className="w-2 h-2 bg-yellow-600 rounded-full animate-pulse mr-2"></div>
            Recording...
          </div>
        )}

        {isProcessing && !isRecording && (
          <div className="flex items-center text-blue-600">
            <div className="w-2 h-2 bg-blue-600 rounded-full animate-pulse mr-2"></div>
            Processing...
          </div>
        )}
      </div>

      {transcription && (
        <div className="mt-4 space-y-4">
          <div>
            <h3 className="font-bold text-lg mb-2">Transcription:</h3>
            <p className="p-4 bg-gray-50 rounded shadow-sm">
              {transcription.transcript}
            </p>
          </div>

          {lastResponseTime && (
            <div className="text-sm text-gray-500">
              Last updated: {new Date(lastResponseTime).toLocaleTimeString()}
            </div>
          )}

          {transcription.timestamps && (
            <div>
              <h4 className="font-bold mb-2">Word Timestamps:</h4>
              <div className="flex flex-wrap gap-2">
                {transcription.timestamps.words.map((word, index) => (
                  <span
                    key={index}
                    className="inline-block bg-gray-100 px-2 py-1 rounded text-sm"
                  >
                    {word} (
                    {transcription.timestamps!.start_time_seconds[
                      index
                    ].toFixed(2)}
                    s -
                    {transcription.timestamps!.end_time_seconds[index].toFixed(
                      2
                    )}
                    s)
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default RealtimeSpeechToText;
