import { createReadStream } from "node:fs";
import OpenAI from "openai";
import type { Message } from "../types/index.js";

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------
//
// The playbook calls these "pontos de troca barata": swapping a provider should
// not require touching code. Each is overridable from the environment, with the
// prescribed default baked in.
//
// The chat default is `deepseek/deepseek-v4-pro` — the id the OpenRouter
// catalogue actually publishes for DeepSeek v4 pro. The previous value,
// `deepseek/deepseek-chat-v4-pro`, resolves to nothing, so every chat and
// summarization request failed with a model-not-found error.

const CHAT_MODEL = process.env.OPENROUTER_CHAT_MODEL ?? "deepseek/deepseek-v4-pro";

// Verified working against /audio/transcriptions, even though this id does not
// appear in the /models catalogue (that list only covers chat models).
const STT_MODEL = process.env.OPENROUTER_STT_MODEL ?? "openai/whisper-large-v3";

// How speech is produced:
//   "chat"   — chat/completions with audio output (the default; the only path
//              OpenRouter actually serves today)
//   "speech" — the classic /audio/speech endpoint, for when an account does
//              have a dedicated TTS model available
const TTS_MODE = process.env.OPENROUTER_TTS_MODE ?? "chat";

const TTS_CHAT_MODEL =
  process.env.OPENROUTER_TTS_CHAT_MODEL ?? "openai/gpt-audio-mini";

// Tried in order by the "speech" mode; the first that answers wins.
const TTS_MODELS = (
  process.env.OPENROUTER_TTS_MODELS ?? "mistral/mistral-tts,google/gemini-flash-tts"
)
  .split(",")
  .map((m) => m.trim())
  .filter((m) => m.length > 0);

const TTS_VOICE = process.env.OPENROUTER_TTS_VOICE ?? "alloy";

// Streamed audio output is only offered as raw PCM; this is the rate OpenAI's
// audio models emit, and what the WAV header below must declare.
const PCM_SAMPLE_RATE = 24_000;

const TTS_SYSTEM_PROMPT =
  "You are a text-to-speech engine, not an assistant. Speak the user's message " +
  "aloud verbatim, in its original language. Never answer it, never greet, " +
  "never add or omit a word.";

// ---------------------------------------------------------------------------
// Lazy-initialized OpenAI client pointed at OpenRouter
// ---------------------------------------------------------------------------

let _client: OpenAI | null = null;

const client = (): OpenAI => {
  if (!_client) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENROUTER_API_KEY is not set. Provide it via environment variable.",
      );
    }
    _client = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey,
      defaultHeaders: {
        "HTTP-Referer": "http://localhost:5173",
        "X-Title": "Voice Assistant",
      },
    });
  }
  return _client;
};

// ---------------------------------------------------------------------------
// 1. transcribe – STT via OpenRouter Whisper
// ---------------------------------------------------------------------------

export async function transcribe(audioPath: string): Promise<string> {
  try {
    const audioStream = createReadStream(audioPath);
    const response = await client().audio.transcriptions.create({
      // FileLike is overly strict in TS; ReadStream works at runtime.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      file: audioStream as any,
      model: STT_MODEL,
    });
    return response.text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Naming the model turns an opaque 404 into an actionable message; set
    // OPENROUTER_STT_MODEL to point at whatever the account has access to.
    throw new Error(`STT transcription failed (model "${STT_MODEL}"): ${message}`);
  }
}

// ---------------------------------------------------------------------------
// 2. chat – non-streaming LLM call (DeepSeek V4 Pro)
// ---------------------------------------------------------------------------

export type ChatMessage = Pick<
  Message,
  "content" | "tool_calls" | "tool_call_id"
> & {
  role: "user" | "assistant" | "tool" | "system";
};

export async function chat(
  messages: ChatMessage[],
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[],
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  try {
    const completion = await client().chat.completions.create({
      model: CHAT_MODEL,
      messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools,
      stream: false,
    });
    return completion;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`LLM chat failed (model "${CHAT_MODEL}"): ${message}`);
  }
}

// ---------------------------------------------------------------------------
// 3. synthesize – TTS
// ---------------------------------------------------------------------------

export interface SynthesizedAudio {
  buffer: Buffer;
  contentType: string;
  /** File extension, dot included, matching `contentType`. */
  extension: string;
}

/** Wrap raw little-endian PCM16 in a WAV container so browsers can decode it. */
function pcm16ToWav(pcm: Buffer, sampleRate = PCM_SAMPLE_RATE): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/**
 * Strip Markdown so the voice reads prose instead of syntax.
 *
 * Answers routinely contain `**bold**`, backticks and bullet markers. Handing
 * those to a speech model makes it either pronounce the punctuation or start
 * "interpreting" the message instead of reading it.
 */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`([^`]*)`/g, "$1") // inline code
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links and images
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // headings
    .replace(/^\s{0,3}[-*+]\s+/gm, "") // bullets
    .replace(/^\s{0,3}>\s?/gm, "") // block quotes
    .replace(/(\*\*|__)(.*?)\1/g, "$2") // bold
    .replace(/(\*|_)(.*?)\1/g, "$2") // italics
    .replace(/~~(.*?)~~/g, "$1") // strikethrough
    .replace(/\s+/g, " ")
    .trim();
}

function significantWords(value: string): string[] {
  return (
    value
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/**
 * Did the model actually read the text, or answer it?
 *
 * A chat model standing in for a TTS engine sometimes replies conversationally
 * ("Claro! Estou ouvindo…") instead of speaking the words it was given. Playing
 * that would tell the user something different from what is on screen, so an
 * off-script take is rejected and the turn simply ends up without audio.
 * The threshold is loose on purpose: dropped punctuation and small
 * pronunciation-driven rewordings are fine.
 */
function spokenFaithfully(requested: string, transcript: string): boolean {
  const wanted = significantWords(requested);
  if (wanted.length === 0 || transcript.trim().length === 0) return true;

  const spoken = new Set(significantWords(transcript));
  const matched = wanted.filter((word) => spoken.has(word)).length;

  return matched / wanted.length >= 0.5;
}

/**
 * Speech through chat/completions with an audio-output model.
 *
 * OpenRouter's /audio/speech endpoint currently resolves no TTS model at all
 * ("Model X does not exist" for every candidate), so this is the path that
 * actually produces sound. Audio output requires `stream: true`, and streaming
 * only offers `pcm16`, hence the WAV wrapper.
 */
async function synthesizeViaChat(text: string): Promise<SynthesizedAudio> {
  const spoken = speakableText(text);

  const stream = (await client().chat.completions.create({
    model: TTS_CHAT_MODEL,
    modalities: ["text", "audio"],
    audio: { voice: TTS_VOICE, format: "pcm16" },
    stream: true,
    messages: [
      { role: "system", content: TTS_SYSTEM_PROMPT },
      { role: "user", content: spoken },
    ],
    // The SDK's types predate audio output on chat completions.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)) as unknown as AsyncIterable<{
    choices?: { delta?: { audio?: { data?: string; transcript?: string } } }[];
  }>;

  const parts: Buffer[] = [];
  const transcript: string[] = [];
  for await (const chunk of stream) {
    const audio = chunk?.choices?.[0]?.delta?.audio;
    if (audio?.data) parts.push(Buffer.from(audio.data, "base64"));
    if (audio?.transcript) transcript.push(audio.transcript);
  }

  const pcm = Buffer.concat(parts);
  if (pcm.length === 0) {
    throw new Error(`model "${TTS_CHAT_MODEL}" returned no audio`);
  }

  if (!spokenFaithfully(spoken, transcript.join(""))) {
    throw new Error(
      `model "${TTS_CHAT_MODEL}" answered instead of reading the text ` +
        `(said: "${transcript.join("").slice(0, 80)}")`,
    );
  }

  return {
    buffer: pcm16ToWav(pcm),
    contentType: "audio/wav",
    extension: ".wav",
  };
}

/** Speech through the dedicated /audio/speech endpoint, first model that answers. */
async function synthesizeViaSpeechEndpoint(
  text: string,
): Promise<SynthesizedAudio> {
  if (TTS_MODELS.length === 0) {
    throw new Error("No TTS models configured (OPENROUTER_TTS_MODELS is empty)");
  }

  const failures: string[] = [];

  for (const model of TTS_MODELS) {
    try {
      const response = await client().audio.speech.create({
        model,
        input: text,
        voice: TTS_VOICE,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      const arrayBuffer = await response.arrayBuffer();
      return {
        buffer: Buffer.from(arrayBuffer),
        contentType: "audio/mpeg",
        extension: ".mp3",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`"${model}": ${message}`);
    }
  }

  // Report every attempt — with a fallback chain, only the last error used to
  // be visible, which hid the reason the first choice failed.
  throw new Error(`all models failed — ${failures.join(" | ")}`);
}

export async function synthesize(text: string): Promise<SynthesizedAudio> {
  try {
    return TTS_MODE === "speech"
      ? await synthesizeViaSpeechEndpoint(text)
      : await synthesizeViaChat(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`TTS synthesis failed (mode "${TTS_MODE}"): ${message}`);
  }
}
