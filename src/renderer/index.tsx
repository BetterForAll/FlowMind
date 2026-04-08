import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Background audio system — continuous system audio + mic recording
let mediaRecorder: MediaRecorder | null = null;
let micStream: MediaStream | null = null;
let systemStream: MediaStream | null = null;
let mixAudioCtx: AudioContext | null = null;
let flushInterval: ReturnType<typeof setInterval> | null = null;
let destinationStream: MediaStream | null = null; // keep ref for restart after flush

const FLUSH_INTERVAL_MS = 5 * 60 * 1000; // Flush audio to disk every 5 minutes

// Get system audio stream via desktopCapturer
async function getSystemAudioStream(): Promise<MediaStream | null> {
  try {
    // In Electron, desktopCapturer.getSources provides source IDs for getUserMedia
    // We need to use the chromeMediaSource constraint to capture system audio
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "desktop",
        },
      } as unknown as MediaTrackConstraints,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          maxWidth: 1,
          maxHeight: 1,
          maxFrameRate: 1,
        },
      } as unknown as MediaTrackConstraints,
    });
    // We only need audio — remove the video track
    stream.getVideoTracks().forEach((t) => t.stop());
    console.log("[FlowMind] System audio stream acquired");
    return new MediaStream(stream.getAudioTracks());
  } catch (err) {
    console.warn("[FlowMind] System audio capture not available:", err);
    return null;
  }
}

// Actual recording — captures system audio + mic mixed together
let recordedChunks: Blob[] = [];
let isFlushing = false; // true during stop/restart cycle for periodic flush

function startMediaRecorder(): void {
  if (!destinationStream) return;
  mediaRecorder = new MediaRecorder(destinationStream, {
    mimeType: "audio/webm;codecs=opus",
  });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      recordedChunks.push(e.data);
    }
  };
  mediaRecorder.onstop = async () => {
    // Send accumulated chunks to main process
    if (recordedChunks.length > 0) {
      const blob = new Blob(recordedChunks, { type: "audio/webm;codecs=opus" });
      const buffer = await blob.arrayBuffer();
      window.flowmind.sendAudioChunk(buffer);
      console.log(`[FlowMind] Audio flushed: ${(buffer.byteLength / 1024).toFixed(1)} KB`);
    }
    recordedChunks = [];

    // If this was a periodic flush (not a final stop), restart immediately
    if (isFlushing) {
      isFlushing = false;
      startMediaRecorder();
      console.log("[FlowMind] Audio recorder restarted after flush");
    }
  };
  mediaRecorder.start(5_000);
}

window.flowmind.onAudioStartRecording(async () => {
  try {
    recordedChunks = [];

    // Get both audio sources
    const [sysStream, micStr] = await Promise.all([
      getSystemAudioStream(),
      navigator.mediaDevices.getUserMedia({ audio: true }),
    ]);

    micStream = micStr;
    systemStream = sysStream;

    // Mix streams via Web Audio API
    mixAudioCtx = new AudioContext();
    const destination = mixAudioCtx.createMediaStreamDestination();

    // Connect mic
    const micSource = mixAudioCtx.createMediaStreamSource(micStream);
    micSource.connect(destination);

    // Connect system audio if available
    if (systemStream) {
      const sysSource = mixAudioCtx.createMediaStreamSource(systemStream);
      sysSource.connect(destination);
      console.log("[FlowMind] Recording: system audio + mic (mixed)");
    } else {
      console.log("[FlowMind] Recording: mic only (system audio unavailable)");
    }

    destinationStream = destination.stream;
    startMediaRecorder();

    // Periodic flush: stop recorder every 5 min, send data, restart
    flushInterval = setInterval(() => {
      if (mediaRecorder && mediaRecorder.state === "recording") {
        isFlushing = true;
        mediaRecorder.stop(); // triggers onstop which sends data + restarts
      }
    }, FLUSH_INTERVAL_MS);

    console.log("[FlowMind] Audio recording started (flush every 5 min)");
  } catch (err) {
    console.error("[FlowMind] Failed to start recording:", err);
  }
});

window.flowmind.onAudioStopRecording(() => {
  isFlushing = false;

  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
  }
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop(); // triggers onstop which sends remaining data
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  if (systemStream) {
    systemStream.getTracks().forEach((t) => t.stop());
    systemStream = null;
  }
  if (mixAudioCtx) {
    mixAudioCtx.close();
    mixAudioCtx = null;
  }
  destinationStream = null;
  mediaRecorder = null;
  console.log("[FlowMind] Audio recording stopped");
});

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
