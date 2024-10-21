"use client";

import React, { useState, useRef, useCallback, useEffect } from "react";
import VAD from "voice-activity-detection";

const Index: React.FC = () => {
  // State variables to manage listening and recording status
  const [isListening, setIsListening] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [audioPackets, setAudioPackets] = useState<string[]>([]);

  // Refs to store media-related objects
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const vadRef = useRef<VAD | null>(null);

  // Function to start listening for voice activity
  const startListening = useCallback(async () => {
    try {
      // Request access to the user's microphone
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Create a new AudioContext
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      // Initialize the Voice Activity Detection
      const vad = new VAD(audioContext, stream, {
        onVoiceStart: () => {
          console.log("Voice started");
          startRecording();
        },
        onVoiceStop: () => {
          console.log("Voice stopped");
          stopRecording();
        },
        minNoiseLevel: 0.1,
        maxNoiseLevel: 0.5,
        noiseCaptureDuration: 1000,
      });
      vadRef.current = vad;

      setIsListening(true);
    } catch (error) {
      console.error("Error starting listening:", error);
    }
  }, []);

  // Function to stop listening and clean up resources
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
    setIsListening(false);
    setIsRecording(false);
  }, []);

  // Function to start recording audio
  const startRecording = useCallback(() => {
    if (!streamRef.current) return;

    const mediaRecorder = new MediaRecorder(streamRef.current);
    mediaRecorderRef.current = mediaRecorder;
    audioChunksRef.current = [];

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        console.log("Data available:", event.data);
        audioChunksRef.current.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      const audioBlob = new Blob(audioChunksRef.current, { type: "audio/wav" });
      console.log("Audio Blob created:", audioBlob);

      if (audioBlob.size > 0) {
        const audioUrl = URL.createObjectURL(audioBlob);
        setAudioPackets((prev) => [...prev, audioUrl]);
        console.log("Audio URL:", audioUrl);
      } else {
        console.error("Error: Empty audio blob.");
      }
    };

    mediaRecorder.start();
    setIsRecording(true);
  }, []);

  // Function to stop recording audio
  const stopRecording = useCallback(() => {
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state === "recording"
    ) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }, []);

  // Clean up resources when component unmounts
  useEffect(() => {
    return () => {
      stopListening();
      // Clean up Blob URLs when unmounting
      audioPackets.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [stopListening, audioPackets]);

  return (
    <div>
      <button onClick={isListening ? stopListening : startListening}>
        {isListening ? "Stop Listening" : "Start Listening"}
      </button>
      <p>
        Status:{" "}
        {isListening ? (isRecording ? "Recording" : "Listening") : "Idle"}
      </p>
      <div>
        {audioPackets.map((packet, index) => (
          <div key={index}>
            <p>Packet {index + 1}:</p>
            <audio
              src={packet}
              controls
              onError={() => console.error("Error loading audio packet")}
            />
          </div>
        ))}
      </div>
    </div>
  );
};

export default Index;
