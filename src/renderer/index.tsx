import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Background audio recorder — invisible, runs when main process requests
let mediaRecorder: MediaRecorder | null = null;
let audioStream: MediaStream | null = null;

window.flowmind.onAudioStart(async () => {
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(audioStream, {
      mimeType: "audio/webm;codecs=opus",
    });

    // Send chunks to main process every 60 seconds
    mediaRecorder.ondataavailable = async (e) => {
      if (e.data.size > 0) {
        const buffer = await e.data.arrayBuffer();
        window.flowmind.sendAudioChunk(buffer);
      }
    };

    mediaRecorder.start(60_000); // 1-minute chunks
    console.log("[FlowMind] Audio recording started");
  } catch (err) {
    console.error("[FlowMind] Failed to start audio:", err);
  }
});

window.flowmind.onAudioStop(() => {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  if (audioStream) {
    audioStream.getTracks().forEach((t) => t.stop());
    audioStream = null;
  }
  mediaRecorder = null;
  console.log("[FlowMind] Audio recording stopped");
});

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
