import type { GoogleGenAI } from "@google/genai";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";

const TRANSCRIPTION_PROMPT = `Transcribe the following audio recording verbatim.
Include timestamps in [MM:SS] format every 30 seconds or at speaker changes.
If multiple speakers are present, label them as Speaker 1, Speaker 2, etc.
Output only the transcript text, no additional commentary.
If the audio is silence or contains no speech, respond with "[no speech detected]".`;

const MAX_CONCURRENT = 3;
const MAX_RETRIES = 3;

export class AudioTranscriber {
  private genai: GoogleGenAI;
  private model = "gemini-2.5-flash";

  constructor(genai: GoogleGenAI) {
    this.genai = genai;
  }

  /**
   * Transcribe all audio files from the given session directories.
   * Returns concatenated transcript text, or empty string if no audio.
   */
  async transcribeSessions(sessionDirs: string[], model?: string): Promise<string> {
    this.model = model ?? "gemini-2.5-flash";
    const audioFiles = await this.collectAudioFiles(sessionDirs);
    if (audioFiles.length === 0) return "";

    console.log(`[Transcriber] Found ${audioFiles.length} audio files to process`);

    // Transcribe with concurrency limit
    const transcripts: { file: string; text: string }[] = [];
    for (let i = 0; i < audioFiles.length; i += MAX_CONCURRENT) {
      const batch = audioFiles.slice(i, i + MAX_CONCURRENT);
      const results = await Promise.allSettled(
        batch.map((f) => this.transcribeFile(f))
      );
      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        const file = batch[j];
        if (result.status === "fulfilled") {
          transcripts.push({ file, text: result.value });
        } else {
          console.warn(`[Transcriber] Failed to transcribe ${path.basename(file)}:`, result.reason);
          transcripts.push({ file, text: "[transcription failed]" });
        }
      }
    }

    // Concatenate chronologically (files are already sorted by timestamp)
    const combined = transcripts
      .filter((t) => t.text && t.text !== "[no speech detected]")
      .map((t) => {
        const basename = path.basename(t.file, ".webm");
        // Extract timestamp from filename like "recording-1712520000000"
        const tsMatch = basename.match(/(\d+)$/);
        const ts = tsMatch ? new Date(parseInt(tsMatch[1], 10)).toISOString() : basename;
        return `### Audio segment: ${ts}\n${t.text}`;
      })
      .join("\n\n");

    console.log(`[Transcriber] Transcription complete: ${combined.length} chars from ${transcripts.length} files`);
    return combined;
  }

  /**
   * Transcribe a single audio file. Uses cached transcript if available.
   */
  private async transcribeFile(filePath: string): Promise<string> {
    const cacheFile = filePath + ".transcript.txt";

    // Check cache
    if (fs.existsSync(cacheFile)) {
      const cached = await fsp.readFile(cacheFile, "utf-8");
      if (cached.trim()) {
        console.log(`[Transcriber] Cache hit: ${path.basename(filePath)}`);
        return cached.trim();
      }
    }

    // Read audio file and convert to base64
    const buffer = await fsp.readFile(filePath);
    const base64 = buffer.toString("base64");

    console.log(`[Transcriber] Transcribing ${path.basename(filePath)} (${(buffer.length / 1024).toFixed(0)} KB)`);

    // Send to Gemini with retries
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await this.genai.models.generateContent({
          model: this.model,
          contents: [
            {
              role: "user",
              parts: [
                { text: TRANSCRIPTION_PROMPT },
                {
                  inlineData: {
                    mimeType: "audio/webm",
                    data: base64,
                  },
                },
              ],
            },
          ],
        });

        const text = (response.text ?? "").trim();

        // Cache the result
        await fsp.writeFile(cacheFile, text, "utf-8");

        return text;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES - 1) {
          const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
          console.warn(`[Transcriber] Retry ${attempt + 1}/${MAX_RETRIES} for ${path.basename(filePath)} in ${delay}ms`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError ?? new Error("Transcription failed");
  }

  /**
   * Collect all .webm audio files from session directories, sorted chronologically.
   */
  private async collectAudioFiles(sessionDirs: string[]): Promise<string[]> {
    const files: string[] = [];
    for (const dir of sessionDirs) {
      const audioDir = path.join(dir, "audio");
      if (!fs.existsSync(audioDir)) continue;
      const entries = await fsp.readdir(audioDir);
      for (const entry of entries) {
        if (entry.endsWith(".webm")) {
          files.push(path.join(audioDir, entry));
        }
      }
    }
    // Sort by filename (which contains timestamp)
    files.sort();
    return files;
  }
}
