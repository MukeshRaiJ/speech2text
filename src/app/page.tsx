"use client";

import React, { useState, useRef, useEffect } from "react";
import { CobraWorker } from "@picovoice/cobra-web";
import { WebVoiceProcessor } from "@picovoice/web-voice-processor";
import { WaveFile } from "wavefile";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Mic, MicOff, Loader2, Volume2, Settings2 } from "lucide-react";

interface Timestamps {
  words: string[];
  start_time_seconds: number[];
  end_time_seconds: number[];
}

interface TranscriptionResponse {
  transcript: string;
  timestamps: Timestamps | null;
}

// Configuration constants
const VOICE_PROBABILITY_THRESHOLD = 0.4;
const SILENCE_DURATION_THRESHOLD = 750;
const MIN_RECORDING_DURATION = 250;
const MAX_RECORDING_DURATION = 3000;
const RECORDING_CHUNK_SIZE = 250;

// Audio Visualizer Component
const AudioVisualizer = ({ isListening }: { isListening: boolean }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number>();
  const analyzerRef = useRef<AnalyserNode | null>(null);

  useEffect(() => {
    if (!isListening || !canvasRef.current) return;

    const audioContext = new (window.AudioContext ||
      (window as any).webkitAudioContext)();
    const analyzer = audioContext.createAnalyser();
    analyzerRef.current = analyzer;
    analyzer.fftSize = 256;

    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyzer);

      const bufferLength = analyzer.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      const canvas = canvasRef.current!;
      const ctx = canvas.getContext("2d")!;

      const draw = () => {
        const width = canvas.width;
        const height = canvas.height;

        analyzer.getByteFrequencyData(dataArray);

        ctx.fillStyle = "rgb(23, 23, 23)";
        ctx.fillRect(0, 0, width, height);

        const barWidth = (width / bufferLength) * 2.5;
        let barHeight;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
          barHeight = dataArray[i] / 2;

          const gradient = ctx.createLinearGradient(0, 0, 0, height);
          gradient.addColorStop(0, "#3b82f6");
          gradient.addColorStop(1, "#1d4ed8");

          ctx.fillStyle = gradient;
          ctx.fillRect(x, height - barHeight, barWidth, barHeight);

          x += barWidth + 1;
        }

        animationFrameRef.current = requestAnimationFrame(draw);
      };

      draw();
    });

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (audioContext.state !== "closed") {
        audioContext.close();
      }
    };
  }, [isListening]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-32 rounded-lg bg-background"
      width={800}
      height={128}
    />
  );
};

const getEnvVariables = () => ({
  PICOVOICE_ACCESS_KEY:
    "KQFW1maCtiLd2xAeMMwttKqPzLH5k+QK6N3pfi9p83dGFDu0QlVxMA==",
  SARVAM_API_KEY: "10d6bcd2-3f43-4527-9159-98c31f0d487b",
});

async function audioBufferToWav(audioBuffer: AudioBuffer): Promise<Blob> {
  const wav = new WaveFile();
  const samples = new Int16Array(audioBuffer.length);
  const leftChannel = audioBuffer.getChannelData(0);

  for (let i = 0; i < leftChannel.length; i++) {
    const s = Math.max(-1, Math.min(1, leftChannel[i]));
    samples[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  wav.fromScratch(1, audioBuffer.sampleRate, "16", samples);
  return new Blob([wav.toBuffer()], { type: "audio/wav" });
}

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
  const [partialTranscript, setPartialTranscript] = useState<string>("");

  const isListeningRef = useRef(false);
  const isRecordingRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const silenceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const recordingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cobraRef = useRef<CobraWorker | null>(null);
  const recordingStartTimeRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processingQueueRef = useRef<Promise<void>>(Promise.resolve());

  const processAndSendAudio = async (audioBlob: Blob) => {
    const newProcessing = async () => {
      try {
        setIsProcessing(true);
        const env = getEnvVariables();
        if (!env.SARVAM_API_KEY || !audioContextRef.current) return;

        const audioBuffer = await blobToAudioBuffer(
          audioBlob,
          audioContextRef.current
        );
        const wavBlob = await audioBufferToWav(audioBuffer);

        const formData = new FormData();
        formData.append("file", wavBlob, "recording.wav");
        formData.append("language_code", "hi-IN");
        formData.append("model", "saarika:v1");
        formData.append("with_timestamps", "true");

        console.log("Sending request to speech-to-text API...");

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
        console.log("Received response:", data);

        setLastResponseTime(Date.now());
        setTranscription((prev) => ({
          transcript: prev
            ? `${prev.transcript} ${data.transcript}`
            : data.transcript,
          timestamps: data.timestamps,
        }));
        setPartialTranscript("");
        setIsProcessing(false);
      } catch (err) {
        console.error("Transcription error:", err);
        setError(err instanceof Error ? err.message : "Transcription failed");
        setIsProcessing(false);
      }
    };

    processingQueueRef.current = processingQueueRef.current.then(newProcessing);
  };

  const initializeVoiceDetector = async () => {
    try {
      const env = getEnvVariables();
      if (!env.PICOVOICE_ACCESS_KEY) {
        throw new Error("Picovoice access key not configured");
      }

      audioContextRef.current = new (window.AudioContext ||
        (window as any).webkitAudioContext)({
        sampleRate: 16000,
      });

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

      const cobraInstance = await CobraWorker.create(
        env.PICOVOICE_ACCESS_KEY,
        (probability: number) => {
          if (probability >= VOICE_PROBABILITY_THRESHOLD) {
            void handleVoiceDetected();
          } else {
            handleSilenceDetected();
          }
        }
      );

      cobraRef.current = cobraInstance;
      setIsInitialized(true);
      setError(null);
    } catch (err) {
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
      streamRef.current
    ) {
      await startRecording();
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

  const startRecording = async () => {
    if (!streamRef.current || mediaRecorderRef.current?.state === "recording")
      return;

    try {
      const options = {
        mimeType: "audio/webm;codecs=opus",
        bitsPerSecond: 128000,
        audioBitsPerSecond: 128000,
        videoBitsPerSecond: 0,
      };

      const mediaRecorder = new MediaRecorder(streamRef.current, options);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      recordingStartTimeRef.current = Date.now();

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const duration = Date.now() - (recordingStartTimeRef.current || 0);
        if (
          duration >= MIN_RECORDING_DURATION &&
          chunksRef.current.length > 0
        ) {
          const audioBlob = new Blob(chunksRef.current, {
            type: "audio/webm;codecs=opus",
          });
          void processAndSendAudio(audioBlob);
        }
        chunksRef.current = [];
        isRecordingRef.current = false;
        recordingStartTimeRef.current = null;
        setIsRecording(false);
      };

      mediaRecorder.start(RECORDING_CHUNK_SIZE);
      isRecordingRef.current = true;
      setIsRecording(true);

      recordingTimeoutRef.current = setTimeout(() => {
        if (mediaRecorder.state === "recording") {
          stopRecording();
        }
      }, MAX_RECORDING_DURATION);
    } catch (err) {
      setError("Failed to start recording");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    if (recordingTimeoutRef.current) {
      clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
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
      if (audioContextRef.current) {
        void audioContextRef.current.close();
      }
    };
  }, []);

  return (
    <div className="p-4 space-y-6">
      <Card className="w-full max-w-4xl mx-auto bg-gradient-to-br from-background to-muted/50">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Volume2 className="w-6 h-6 text-primary" />
              Real-time Speech to Text
            </CardTitle>
            <Button variant="ghost" size="icon">
              <Settings2 className="w-5 h-5" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              {isListening ? (
                <Button
                  onClick={() => void stopListening()}
                  variant="destructive"
                  className="w-40 relative overflow-hidden group"
                >
                  <div className="absolute inset-0 bg-red-500/20 group-hover:bg-red-500/30 transition-colors" />
                  <MicOff className="mr-2 h-4 w-4" />
                  Stop Listening
                </Button>
              ) : (
                <Button
                  onClick={() => void startListening()}
                  variant="default"
                  className="w-40 relative overflow-hidden group"
                  disabled={!isInitialized}
                >
                  <div className="absolute inset-0 bg-primary/20 group-hover:bg-primary/30 transition-colors" />
                  <Mic className="mr-2 h-4 w-4" />
                  Start Listening
                </Button>
              )}

              {isRecording && (
                <Badge variant="warning" className="animate-pulse">
                  <div className="w-2 h-2 bg-yellow-600 rounded-full mr-2"></div>
                  Recording...
                </Badge>
              )}
            </div>

            <div className="relative">
              <AudioVisualizer isListening={isListening} />
              {!isListening && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-sm rounded-lg">
                  <p className="text-muted-foreground">
                    Start listening to see audio visualization
                  </p>
                </div>
              )}
            </div>

            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold mb-2 flex items-center gap-2">
                  <span>Transcription</span>
                  {isProcessing && <Loader2 className="w-4 h-4 animate-spin" />}
                </h3>
                <Card className="bg-muted/30">
                  <CardContent className="pt-6 min-h-[100px]">
                    {transcription?.transcript}
                    {partialTranscript && (
                      <span className="text-muted-foreground">
                        {" "}
                        {partialTranscript}
                      </span>
                    )}
                    {!transcription?.transcript && !partialTranscript && (
                      <p className="text-muted-foreground italic">
                        Your transcription will appear here...
                      </p>
                    )}
                  </CardContent>
                </Card>
              </div>

              {lastResponseTime && (
                <p className="text-sm text-muted-foreground flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-500"></span>
                  Last updated:{" "}
                  {new Date(lastResponseTime).toLocaleTimeString()}
                </p>
              )}

              {transcription?.timestamps && (
                <div className="border-t pt-4">
                  <h4 className="font-semibold mb-2">Word Timestamps</h4>
                  <div className="flex flex-wrap gap-2">
                    {transcription.timestamps.words.map((word, index) => (
                      <Badge
                        key={index}
                        variant="secondary"
                        className="text-xs hover:bg-primary/20 transition-colors cursor-default"
                      >
                        {word}{" "}
                        <span className="ml-1 opacity-70">
                          (
                          {transcription.timestamps!.start_time_seconds[
                            index
                          ].toFixed(2)}
                          s -
                          {transcription.timestamps!.end_time_seconds[
                            index
                          ].toFixed(2)}
                          s)
                        </span>
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default RealtimeSpeechToText;
