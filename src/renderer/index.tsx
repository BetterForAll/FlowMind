import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Background audio system — mic level monitoring + recording
let monitorStream: MediaStream | null = null;
let analyser: AnalyserNode | null = null;
let monitorInterval: ReturnType<typeof setInterval> | null = null;
let mediaRecorder: MediaRecorder | null = null;
let recordStream: MediaStream | null = null;

// Request mic permission early so it's ready when needed
navigator.mediaDevices.getUserMedia({ audio: true })
  .then((stream) => {
    stream.getTracks().forEach((t) => t.stop()); // Release immediately
    console.log("[FlowMind] Mic permission granted");
  })
  .catch((err) => {
    console.error("[FlowMind] Mic permission denied:", err);
  });

// Mic level monitoring — detects speech, reports levels to main process
window.flowmind.onAudioStartMonitoring(async () => {
  try {
    monitorStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(monitorStream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    monitorInterval = setInterval(() => {
      if (!analyser) return;
      analyser.getByteFrequencyData(dataArray);
      // Calculate RMS level (0 to 1)
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const v = dataArray[i] / 255;
        sum += v * v;
      }
      const level = Math.sqrt(sum / dataArray.length);
      window.flowmind.sendMicLevel(level);
    }, 500); // Check every 500ms

    console.log("[FlowMind] Mic monitoring started — polling levels every 500ms");
  } catch (err) {
    console.error("[FlowMind] Failed to start mic monitoring:", err);
  }
});

console.log("[FlowMind] Audio listeners registered");

window.flowmind.onAudioStopMonitoring(() => {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
  if (monitorStream) {
    monitorStream.getTracks().forEach((t) => t.stop());
    monitorStream = null;
  }
  analyser = null;
  console.log("[FlowMind] Mic monitoring stopped");
});

// Actual recording — started/stopped by main process based on mic levels
let recordedChunks: Blob[] = [];

window.flowmind.onAudioStartRecording(async () => {
  try {
    recordedChunks = [];
    recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(recordStream, {
      mimeType: "audio/webm;codecs=opus",
    });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        recordedChunks.push(e.data);
        // Don't send individual chunks — wait for onstop to combine them
      }
    };
    mediaRecorder.onstop = async () => {
      // Combine all chunks into one valid WebM file and send to main
      if (recordedChunks.length > 0) {
        const blob = new Blob(recordedChunks, { type: "audio/webm;codecs=opus" });
        const buffer = await blob.arrayBuffer();
        window.flowmind.sendAudioChunk(buffer);
        console.log(`[FlowMind] Audio saved: ${(buffer.byteLength / 1024).toFixed(1)} KB`);
      }
      recordedChunks = [];
    };
    mediaRecorder.start(5_000); // 5-second internal chunks (combined on stop)
    console.log("[FlowMind] Audio recording started");
  } catch (err) {
    console.error("[FlowMind] Failed to start recording:", err);
  }
});

window.flowmind.onAudioStopRecording(() => {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop(); // triggers onstop which saves the combined file
  }
  if (recordStream) {
    recordStream.getTracks().forEach((t) => t.stop());
    recordStream = null;
  }
  mediaRecorder = null;
  console.log("[FlowMind] Audio recording stopped");
});

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
