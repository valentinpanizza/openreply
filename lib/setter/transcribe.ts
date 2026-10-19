/**
 * Voice notes to text, with Groq's Whisper. Claude cannot take audio, so the
 * setter reads the transcription like any other message.
 */

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 1500;

export function transcriptionEnabled(): boolean {
  return Boolean(process.env.GROQ_API_KEY?.trim());
}

function transcriptionModel(): string {
  return process.env.TRANSCRIPTION_MODEL?.trim() || "whisper-large-v3-turbo";
}

/**
 * The text of the voice note at `url`, or null when it cannot be read (not
 * configured, too big, a failed download or request, nothing intelligible).
 * The caller hands the chat to the owner on null.
 */
export async function transcribeAudio(url: string | undefined): Promise<string | null> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey || !url || !/^https:\/\//.test(url)) return null;
  try {
    const audio = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!audio.ok) return null;
    const bytes = await audio.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUDIO_BYTES) return null;

    const form = new FormData();
    form.set("file", new Blob([bytes], { type: audio.headers.get("content-type") || "audio/mp4" }), "audio.m4a");
    form.set("model", transcriptionModel());
    form.set("language", "es");
    form.set("response_format", "json");
    form.set("temperature", "0");

    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      console.error("[Setter] Transcription failed:", response.status, (await response.text()).slice(0, 200));
      return null;
    }
    const text = ((await response.json()) as { text?: unknown }).text;
    if (typeof text !== "string") return null;
    const clean = text.replace(/\s+/g, " ").trim();
    // Whisper answers silence or music with nothing, or with a few stray characters.
    if (!/[\p{L}\p{N}]{2}/u.test(clean)) return null;
    return clean.slice(0, MAX_TRANSCRIPT_CHARS);
  } catch (error) {
    console.error("[Setter] Transcription failed:", error instanceof Error ? error.message : error);
    return null;
  }
}
