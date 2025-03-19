// server.ts
import { WebSocketServer, WebSocket } from 'ws';
import express from 'express';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import FormData from 'form-data';
import { Readable } from 'stream';
import dotenv from 'dotenv';

dotenv.config();

interface Client {
  id: string;
  ws: WebSocket;
  isAlive: boolean;
  currentAudioBuffer: Buffer[];
}

interface WebSocketMessage {
  type: string;
  data: any;
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Map<string, Client>();
const PING_INTERVAL = 30000; // 30 seconds
const AUDIO_CHUNK_TIMEOUT = 500; // 500ms
const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB

// Helper function to decode base64 to buffer
function decodeBase64Audio(base64String: string): Buffer {
  return Buffer.from(base64String, 'base64');
}

// Helper function to create a readable stream from buffer
function bufferToStream(buffer: Buffer): Readable {
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}

// Function to process audio and get transcription from Sarvam AI
async function processAudio(audioBuffer: Buffer): Promise<any> {
  try {
    const formData = new FormData();
    const audioStream = bufferToStream(audioBuffer);
    
    formData.append('file', audioStream, {
      filename: 'audio.wav',
      contentType: 'audio/wav',
    });
    formData.append('language_code', 'hi-IN');
    formData.append('model', 'saarika:v1');
    formData.append('with_timestamps', 'true');

    const response = await fetch('https://api.sarvam.ai/speech-to-text', {
      method: 'POST',
      headers: {
        'api-subscription-key': process.env.SARVAM_API_KEY!,
        ...formData.getHeaders(),
      },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`API Error (${response.status})`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error processing audio:', error);
    throw error;
  }
}

// Handle client connection
wss.on('connection', (ws: WebSocket) => {
  const clientId = uuidv4();
  const client: Client = {
    id: clientId,
    ws,
    isAlive: true,
    currentAudioBuffer: [],
  };
  
  clients.set(clientId, client);

  // Send connected message
  ws.send(JSON.stringify({
    type: 'connected',
    data: { clientId },
  }));

  console.log(`Client connected: ${clientId}`);

  let audioProcessingTimeout: NodeJS.Timeout | null = null;

  // Handle incoming messages
  ws.on('message', async (message: string) => {
    try {
      const parsedMessage: WebSocketMessage = JSON.parse(message);

      switch (parsedMessage.type) {
        case 'audio':
          // Decode and add to buffer
          const audioChunk = decodeBase64Audio(parsedMessage.data);
          client.currentAudioBuffer.push(audioChunk);

          // Check buffer size
          const totalSize = client.currentAudioBuffer.reduce((acc, chunk) => acc + chunk.length, 0);
          if (totalSize > MAX_BUFFER_SIZE) {
            throw new Error('Audio buffer size exceeded');
          }

          // Reset timeout for processing
          if (audioProcessingTimeout) {
            clearTimeout(audioProcessingTimeout);
          }

          audioProcessingTimeout = setTimeout(async () => {
            try {
              // Combine audio chunks and process
              const completeAudioBuffer = Buffer.concat(client.currentAudioBuffer);
              client.currentAudioBuffer = []; // Clear buffer

              // Process audio
              const result = await processAudio(completeAudioBuffer);

              // Send back transcription
              ws.send(JSON.stringify({
                type: 'transcript',
                data: {
                  final: result.transcript,
                  timestamps: result.timestamps,
                },
              }));
            } catch (error) {
              console.error('Error processing audio chunk:', error);
              ws.send(JSON.stringify({
                type: 'error',
                data: 'Failed to process audio',
              }));
            }
          }, AUDIO_CHUNK_TIMEOUT);
          break;

        case 'ping':
          client.isAlive = true;
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
      }
    } catch (error) {
      console.error('Error handling message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        data: 'Failed to process message',
      }));
    }
  });

  // Handle client disconnect
  ws.on('close', () => {
    console.log(`Client disconnected: ${clientId}`);
    clients.delete(clientId);
  });

  // Handle errors
  ws.on('error', (error) => {
    console.error(`Client error (${clientId}):`, error);
    clients.delete(clientId);
  });
});

// Ping clients periodically to check connection
setInterval(() => {
  clients.forEach((client) => {
    if (!client.isAlive) {
      client.ws.terminate();
      clients.delete(client.id);
      return;
    }

    client.isAlive = false;
    client.ws.send(JSON.stringify({ type: 'ping' }));
  });
}, PING_INTERVAL);

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Closing WebSocket server...');
  wss.close(() => {
    console.log('WebSocket server closed');
    process.exit(0);
  });
});