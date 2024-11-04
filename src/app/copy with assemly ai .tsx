"use client";
import React, { useEffect, useState, useRef } from "react";
import { AssemblyAI } from "assemblyai";
import { CobraWorker } from "@picovoice/cobra-web";
import { WebVoiceProcessor } from "@picovoice/web-voice-processor";

const PICOVOICE_ACCESS_KEY = process.env.NEXT_PUBLIC_PICOVOICE_ACCESS_KEY;
const ASSEMBLY_API_KEY = process.env.NEXT_PUBLIC_ASSEMBLY_API_KEY;

const VOICE_PROBABILITY_THRESHOLD = 0.2;
const SILENCE_DURATION_THRESHOLD = 1500;
const MIN_RECORDING_DURATION = 500;

interface AudioClip {
  id: number;
  url: string;
  timestamp: Date;
  duration: number;
  transcription?: string;
  isTranscribing?: boolean;
  transcriptionError?: string;
  speakers?: { speaker: string; text: string }[];
}

const VoiceDetector: React.FC = () => {
  const [isInitialized, setIsInitialized] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [audioClips, setAudioClips] = useState<AudioClip[]>([]);
  const [latestClip, setLatestClip] = useState<AudioClip | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const isListeningRef = useRef(false);
  const isRecordingRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const silenceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const recordingStartTimeRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cobraRef = useRef<CobraWorker | null>(null);
  const assemblyClientRef = useRef<AssemblyAI | null>(null);

  useEffect(() => {
    if (ASSEMBLY_API_KEY) {
      assemblyClientRef.current = new AssemblyAI({
        apiKey: ASSEMBLY_API_KEY,
      });
    }
  }, []);

  const updateClipTranscription = (
    clipId: number,
    updates: Partial<AudioClip>
  ) => {
    setAudioClips((prevClips) =>
      prevClips.map((clip) =>
        clip.id === clipId ? { ...clip, ...updates } : clip
      )
    );
    setLatestClip((prevClip) =>
      prevClip?.id === clipId ? { ...prevClip, ...updates } : prevClip
    );
  };

  const transcribeAudio = async (
    audioBlob: Blob,
    clipId: number
  ): Promise<void> => {
    if (!ASSEMBLY_API_KEY || !assemblyClientRef.current) {
      throw new Error("AssemblyAI client is not configured");
    }

    updateClipTranscription(clipId, { isTranscribing: true });

    try {
      // Convert the blob to a File object
      const audioFile = new File([audioBlob], "recording.webm", {
        type: "audio/webm",
      });

      // Set up transcription parameters
      const params = {
        audio: audioFile,
        speaker_labels: true, // Enable speaker diarization
      };

      // Start the transcription
      const transcript = await assemblyClientRef.current.transcripts.transcribe(
        params
      );

      if (transcript.status === "error") {
        throw new Error(transcript.error);
      }

      // Extract speakers and their utterances if available
      const speakers = transcript.utterances?.map((utterance) => ({
        speaker: utterance.speaker,
        text: utterance.text,
      }));

      // Update the clip with transcription and speaker information
      updateClipTranscription(clipId, {
        transcription: transcript.text,
        speakers: speakers,
        isTranscribing: false,
      });
    } catch (error) {
      console.error("Transcription error:", error);
      const errorMessage =
        error instanceof Error ? error.message : "Transcription failed";
      updateClipTranscription(clipId, {
        transcriptionError: errorMessage,
        isTranscribing: false,
      });
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
      try {
        await startRecording();
      } catch (err) {
        console.error("Voice detection error:", err);
        setError("Error detecting voice");
      }
    }
  };

  const handleSilenceDetected = () => {
    if (!silenceTimeoutRef.current && isRecordingRef.current && !isProcessing) {
      silenceTimeoutRef.current = setTimeout(() => {
        stopRecording();
        silenceTimeoutRef.current = null;
      }, SILENCE_DURATION_THRESHOLD);
    }
  };

  const initializeVoiceDetector = async () => {
    try {
      if (!PICOVOICE_ACCESS_KEY) {
        throw new Error("Picovoice access key is not configured");
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
    if (
      !streamRef.current ||
      mediaRecorderRef.current?.state === "recording" ||
      isProcessing
    ) {
      return;
    }

    setIsProcessing(true);

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

      mediaRecorder.onstop = async () => {
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

            const newClip: AudioClip = {
              id: Date.now(),
              url: audioUrl,
              timestamp: new Date(),
              duration: duration / 1000,
              isTranscribing: true,
            };

            setLatestClip(newClip);
            setAudioClips((prev) => [newClip, ...prev]);

            // Start transcription in the background
            void transcribeAudio(audioBlob, newClip.id);
          } catch (err) {
            console.error("Failed to create audio clip:", err);
            setError("Failed to create audio clip");
          }
        }

        audioChunksRef.current = [];
        isRecordingRef.current = false;
        recordingStartTimeRef.current = null;
        setIsRecording(false);
        setIsProcessing(false);
      };

      mediaRecorder.start(500);
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
      try {
        mediaRecorderRef.current.stop();
      } catch (err) {
        console.error("Stop recording error:", err);
        setError("Failed to stop recording");
        setIsProcessing(false);
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
      audioClips.forEach((clip) => URL.revokeObjectURL(clip.url));
    };
  }, []);

  return (
    <div className="p-4">
      {error && (
        <div className="mb-4 p-4 bg-red-100 text-red-700 rounded">{error}</div>
      )}

      <div className="mb-4">
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
      </div>

      {isRecording && (
        <div className="mb-4 p-2 bg-yellow-50 text-yellow-600 rounded flex items-center">
          <div className="w-2 h-2 bg-yellow-600 rounded-full animate-pulse mr-2"></div>
          Recording...
        </div>
      )}

      {latestClip && (
        <div className="mb-4 p-4 bg-gray-100 rounded shadow-sm">
          <h3 className="text-lg font-semibold mb-2">Latest Recording</h3>
          <audio controls src={latestClip.url} className="w-full mb-2" />
          <p className="mb-2 text-gray-700">
            <strong>Duration:</strong> {latestClip.duration.toFixed(2)} seconds
          </p>
          {latestClip.isTranscribing ? (
            <div className="flex items-center text-yellow-600">
              <div className="w-2 h-2 bg-yellow-600 rounded-full animate-pulse mr-2"></div>
              Transcribing...
            </div>
          ) : latestClip.transcriptionError ? (
            <p className="text-red-600">
              Transcription error: {latestClip.transcriptionError}
            </p>
          ) : (
            <>
              {latestClip.transcription && (
                <div className="mb-4">
                  <h4 className="font-semibold mb-1">Full Transcription:</h4>
                  <p className="text-gray-800 bg-white p-2 rounded">
                    {latestClip.transcription}
                  </p>
                </div>
              )}
              {latestClip.speakers && latestClip.speakers.length > 0 && (
                <div>
                  <h4 className="font-semibold mb-2">Speakers:</h4>
                  <ul className="space-y-2">
                    {latestClip.speakers.map((utterance, index) => (
                      <li key={index} className="bg-white p-2 rounded">
                        <span className="font-medium text-blue-600">
                          Speaker {utterance.speaker}:
                        </span>{" "}
                        <span className="text-gray-800">{utterance.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {audioClips.length > 0 && (
        <div className="mb-4">
          <h2 className="text-xl font-bold mb-4">Previous Recordings</h2>
          <ul className="space-y-4">
            {audioClips.map((clip) => (
              <li key={clip.id} className="p-4 bg-gray-50 rounded shadow-sm">
                <audio controls src={clip.url} className="w-full mb-2" />
                <p className="mb-2 text-gray-700">
                  <strong>Duration:</strong> {clip.duration.toFixed(2)} seconds
                </p>
                {clip.isTranscribing ? (
                  <div className="flex items-center text-yellow-600">
                    <div className="w-2 h-2 bg-yellow-600 rounded-full animate-pulse mr-2"></div>
                    Transcribing...
                  </div>
                ) : clip.transcriptionError ? (
                  <p className="text-red-600">
                    Transcription error: {clip.transcriptionError}
                  </p>
                ) : (
                  <>
                    {clip.transcription && (
                      <div className="mb-4">
                        <h4 className="font-semibold mb-1">
                          Full Transcription:
                        </h4>
                        <p className="text-gray-800 bg-white p-2 rounded">
                          {clip.transcription}
                        </p>
                      </div>
                    )}
                    {clip.speakers && clip.speakers.length > 0 && (
                      <div>
                        <h4 className="font-semibold mb-2">Speakers:</h4>
                        <ul className="space-y-2">
                          {clip.speakers.map((utterance, index) => (
                            <li key={index} className="bg-white p-2 rounded">
                              <span className="font-medium text-blue-600">
                                Speaker {utterance.speaker}:
                              </span>{" "}
                              <span className="text-gray-800">
                                {utterance.text}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default VoiceDetector;
