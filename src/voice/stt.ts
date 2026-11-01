/**
 * Server-side speech-to-text for browsers without the Web Speech API (Firefox, some
 * mobile WebViews). Any OpenAI-compatible /audio/transcriptions endpoint works:
 * OpenAI Whisper, Groq whisper-large-v3, a local faster-whisper server…
 */
export class SpeechToText {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "mp4" : mimeType.includes("wav") ? "wav" : "webm";
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), `speech.${ext}`);
    form.append("model", this.model);
    form.append("language", "ru");
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`STT HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { text?: string };
    return (json.text ?? "").trim();
  }
}
