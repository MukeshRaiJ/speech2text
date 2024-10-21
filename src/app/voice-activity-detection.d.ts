// voice-activity-detection.d.ts
declare module "voice-activity-detection" {
  interface VADOptions {
    onVoiceStart: () => void;
    onVoiceStop: () => void;
    minNoiseLevel?: number;
    maxNoiseLevel?: number;
    noiseCaptureDuration?: number;
  }

  class VAD {
    constructor(
      audioContext: AudioContext,
      stream: MediaStream,
      options: VADOptions
    );
    destroy(): void;
  }

  export default VAD;
}
