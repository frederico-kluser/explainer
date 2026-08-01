import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "@/lib/api";
import {
  CLEAR_OUTPUT_AUDIO,
  DATA_CHANNEL_NAME,
  ITEM_ACK_EVENTS,
  REALTIME_CALLS_URL,
  RESPONSE_CREATE,
  functionCallsFrom,
  functionOutputEvent,
  userTextEvent,
  type RealtimeServerEvent,
} from "@/lib/realtime";
import type { AgentJob, AgentJobEvent, TranscriptEntry } from "@/types";

export type SessionStatus = "idle" | "connecting" | "live" | "error";

export interface RealtimeSessionState {
  status: SessionStatus;
  error: string | null;
  transcript: TranscriptEntry[];
  userSpeaking: boolean;
  assistantSpeaking: boolean;
  /** Name of the tool the model is waiting on right now, if any. */
  activeTool: string | null;
  jobs: AgentJob[];
  /** What this session has spent so far, in USD, priced by the server. */
  sessionUsd: number;
  connect: () => Promise<void>;
  disconnect: () => void;
  sendText: (text: string) => void;
  cancelJob: (jobId: string) => void;
  /** Playback speed, pushable mid-call (unlike the voice, which is frozen). */
  setSpeed: (speed: number) => void;
}

/** How long to wait for the server to acknowledge our items before asking for a response. */
const ACK_TIMEOUT_MS = 2_500;

function nowISO(): string {
  return new Date().toISOString();
}

/**
 * One live speech-to-speech session.
 *
 * Audio never touches our backend: the browser holds its own WebRTC peer
 * connection to OpenAI, so the model starts speaking while it is still
 * thinking. What *does* come back to us is every function call — those are run
 * on the server, where the filesystem and the keys live, and the result is
 * pushed into the conversation as a `function_call_output`.
 */
export function useRealtimeSession(
  conversationId: string | null,
): RealtimeSessionState {
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [userSpeaking, setUserSpeaking] = useState(false);
  const [assistantSpeaking, setAssistantSpeaking] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [sessionUsd, setSessionUsd] = useState(0);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const eventsRef = useRef<EventSource | null>(null);

  // The data channel handlers are installed once and live for the whole
  // session, so anything they need has to be reachable through a ref.
  const convRef = useRef<string | null>(conversationId);
  convRef.current = conversationId;

  const activeResponseRef = useRef(false);
  const wantResponseRef = useRef(false);
  // Read inside the event handler, where the state value would be a stale
  // closure capture.
  const assistantSpeakingRef = useRef(false);
  const pendingAcksRef = useRef<Set<string>>(new Set());
  const ackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modelRef = useRef<string>("");

  // ── Sending ────────────────────────────────────────────────────

  const send = useCallback((event: object) => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") return;
    dc.send(JSON.stringify(event));
  }, []);

  /**
   * Ask for a spoken response — but never while one is already running.
   *
   * Firing `response.create` on top of an active response is the classic way to
   * get "Conversation already has an active response" and lose the turn.
   */
  const requestResponse = useCallback(() => {
    if (activeResponseRef.current) {
      wantResponseRef.current = true;
      return;
    }
    send(RESPONSE_CREATE);
  }, [send]);

  const flushAcks = useCallback(() => {
    if (ackTimerRef.current) {
      clearTimeout(ackTimerRef.current);
      ackTimerRef.current = null;
    }
    pendingAcksRef.current.clear();
    requestResponse();
  }, [requestResponse]);

  // ── Transcript bookkeeping ─────────────────────────────────────

  const upsertEntry = useCallback(
    (
      id: string,
      role: TranscriptEntry["role"],
      mutate: (previous: string) => string,
      final = false,
    ) => {
      setTranscript((prev) => {
        const index = prev.findIndex((entry) => entry.id === id);
        if (index === -1) {
          return [
            ...prev,
            { id, role, text: mutate(""), final, timestamp: nowISO() },
          ];
        }
        const next = [...prev];
        const current = next[index]!;
        next[index] = { ...current, text: mutate(current.text), final };
        return next;
      });
    },
    [],
  );

  /** Persist a finished turn. A storage failure must never break the call. */
  const persist = useCallback(
    (role: "user" | "assistant" | "tool", content: string) => {
      const id = convRef.current;
      if (!id || !content.trim()) return;
      void api
        .appendMessages(id, [{ role, content }])
        .catch(() => {
          /* the conversation matters more than its archive */
        });
    },
    [],
  );

  // ── Tool bridge ────────────────────────────────────────────────

  const runToolCalls = useCallback(
    async (calls: ReturnType<typeof functionCallsFrom>) => {
      const id = convRef.current;
      if (!id || calls.length === 0) return;

      setActiveTool(calls[0]!.name);

      for (const call of calls) {
        upsertEntry(
          `tool-${call.call_id}`,
          "tool",
          () => `${call.name} — executando…`,
          false,
        );
      }

      const results = await Promise.all(
        calls.map(async (call) => {
          try {
            const result = await api.runTool(id, call);
            return { call, output: result.output };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { call, output: `A ferramenta falhou: ${message}` };
          }
        }),
      );

      for (const { call, output } of results) {
        upsertEntry(
          `tool-${call.call_id}`,
          "tool",
          () => `${call.name} — ${summarize(output)}`,
          true,
        );
        pendingAcksRef.current.add(call.call_id);
        send(functionOutputEvent(call.call_id, output));
      }

      setActiveTool(null);

      // Wait for the server to confirm the outputs before asking for a
      // response; the timer is the escape hatch if an ack never shows up.
      if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
      ackTimerRef.current = setTimeout(flushAcks, ACK_TIMEOUT_MS);
    },
    [flushAcks, send, upsertEntry],
  );

  // ── Server events ──────────────────────────────────────────────

  const handleEvent = useCallback(
    (event: RealtimeServerEvent) => {
      switch (event.type) {
        case "session.created":
          setStatus("live");
          break;

        case "response.created":
          activeResponseRef.current = true;
          break;

        case "response.done": {
          activeResponseRef.current = false;

          // Every response carries its own token usage. The server prices it,
          // so the meter in the sidebar is the real rate card and not a guess.
          const usage = (event.response as { usage?: unknown } | undefined)?.usage;
          const convId = convRef.current;
          if (usage && convId) {
            void api
              .reportRealtimeUsage(convId, usage, modelRef.current)
              .then((priced) => {
                if (priced) setSessionUsd((prev) => prev + priced.usd);
              });
          }

          const calls = functionCallsFrom(event);
          if (calls.length > 0) {
            void runToolCalls(calls);
            break;
          }

          if (wantResponseRef.current) {
            wantResponseRef.current = false;
            send(RESPONSE_CREATE);
          }
          break;
        }

        // ── the user's own words ──
        case "conversation.item.input_audio_transcription.delta": {
          const itemId = String(event.item_id ?? "user");
          const delta = String(event.delta ?? "");
          upsertEntry(itemId, "user", (prev) => prev + delta);
          break;
        }
        case "conversation.item.input_audio_transcription.completed": {
          const itemId = String(event.item_id ?? "user");
          const text = String(event.transcript ?? "");
          upsertEntry(itemId, "user", () => text, true);
          persist("user", text);
          break;
        }

        // ── what the model is saying ──
        case "response.output_audio_transcript.delta": {
          const itemId = String(event.item_id ?? event.response_id ?? "assistant");
          const delta = String(event.delta ?? "");
          upsertEntry(itemId, "assistant", (prev) => prev + delta);
          break;
        }
        case "response.output_audio_transcript.done": {
          const itemId = String(event.item_id ?? event.response_id ?? "assistant");
          const text = String(event.transcript ?? "");
          upsertEntry(itemId, "assistant", () => text, true);
          persist("assistant", text);
          break;
        }
        case "response.output_text.delta": {
          const itemId = String(event.item_id ?? "assistant-text");
          upsertEntry(itemId, "assistant", (prev) => prev + String(event.delta ?? ""));
          break;
        }

        // ── turn taking ──
        case "input_audio_buffer.speech_started":
          setUserSpeaking(true);
          // Barge-in: drop whatever the peer connection is still holding, so the
          // model stops mid-word instead of talking over the interruption.
          if (assistantSpeakingRef.current) send(CLEAR_OUTPUT_AUDIO);
          break;
        case "input_audio_buffer.speech_stopped":
          setUserSpeaking(false);
          break;
        case "output_audio_buffer.started":
          assistantSpeakingRef.current = true;
          setAssistantSpeaking(true);
          break;
        case "output_audio_buffer.stopped":
        case "output_audio_buffer.cleared":
          assistantSpeakingRef.current = false;
          setAssistantSpeaking(false);
          break;

        case "error": {
          const detail = event.error as { message?: string } | undefined;
          setError(detail?.message ?? "Erro na sessao de voz.");
          break;
        }

        default:
          if (ITEM_ACK_EVENTS.has(event.type)) {
            const item = event.item as { call_id?: string } | undefined;
            const callId = item?.call_id;
            if (callId && pendingAcksRef.current.delete(callId)) {
              if (pendingAcksRef.current.size === 0) flushAcks();
            }
          }
          break;
      }
    },
    [flushAcks, persist, runToolCalls, send, upsertEntry],
  );

  // ── Agent job stream ───────────────────────────────────────────

  const openJobStream = useCallback(
    (id: string) => {
      eventsRef.current?.close();
      const source = new EventSource(api.agentEventsUrl(id));
      eventsRef.current = source;

      source.onmessage = (message) => {
        let event: AgentJobEvent;
        try {
          event = JSON.parse(message.data) as AgentJobEvent;
        } catch {
          return;
        }

        setJobs((prev) => {
          const index = prev.findIndex((job) => job.id === event.job_id);
          const base: AgentJob =
            index === -1
              ? {
                  id: event.job_id,
                  conversation_id: id,
                  prompt: "",
                  cwd: "",
                  status: "running",
                  activity: "",
                  started_at: nowISO(),
                }
              : prev[index]!;

          const updated: AgentJob =
            event.type === "activity"
              ? { ...base, activity: event.activity }
              : event.type === "done"
                ? { ...base, status: "done", activity: "concluido", result: event.result, cost_usd: event.cost_usd }
                : { ...base, status: "error", activity: "falhou", error: event.error };

          const next = [...prev];
          if (index === -1) next.push(updated);
          else next[index] = updated;
          return next;
        });

        // A replay is the server catching this stream up on jobs that already
        // finished — often from a previous session. It belongs on screen, but
        // narrating a stale answer out loud on every reconnect does not.
        const replay = event.type !== "activity" && event.replay === true;

        if (event.type === "done") {
          upsertEntry(`agent-${event.job_id}`, "agent", () => event.result, true);
          if (replay) return;
          persist("tool", `[agente pi] ${event.result}`);

          // Hand the answer back to the model as a user turn and ask it to
          // speak. This is the whole reason a slow tool does not block a
          // conversation: the result arrives late and is simply spoken late.
          send(
            userTextEvent(
              "O agente de codigo terminou a investigacao. Resultado:\n\n" +
                `${event.result}\n\n` +
                "Explique isso para mim em voz alta, com suas palavras, de forma curta.",
            ),
          );
          requestResponse();
        }

        if (event.type === "error") {
          upsertEntry(
            `agent-${event.job_id}`,
            "agent",
            () => `O agente falhou: ${event.error}`,
            true,
          );
          if (replay) return;
          send(
            userTextEvent(
              `O agente de codigo falhou: ${event.error}. Me avise disso em uma frase.`,
            ),
          );
          requestResponse();
        }
      };

      source.onerror = () => {
        // EventSource reconnects on its own; a transient blip is not worth a toast.
      };
    },
    [persist, requestResponse, send, upsertEntry],
  );

  // ── Teardown ───────────────────────────────────────────────────

  const disconnect = useCallback(() => {
    if (ackTimerRef.current) {
      clearTimeout(ackTimerRef.current);
      ackTimerRef.current = null;
    }
    pendingAcksRef.current.clear();
    activeResponseRef.current = false;
    wantResponseRef.current = false;
    assistantSpeakingRef.current = false;

    eventsRef.current?.close();
    eventsRef.current = null;

    dcRef.current?.close();
    dcRef.current = null;

    // Stopping the tracks is what actually turns the microphone light off.
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    pcRef.current?.close();
    pcRef.current = null;

    if (audioRef.current) {
      audioRef.current.srcObject = null;
      audioRef.current.remove();
      audioRef.current = null;
    }

    setStatus("idle");
    setUserSpeaking(false);
    setAssistantSpeaking(false);
    setActiveTool(null);
  }, []);

  /**
   * Change how fast the model speaks, mid-call.
   *
   * `speed` is playback rate, so it can move at any time — unlike `voice`, which
   * the API freezes as soon as the session has emitted a single sample.
   */
  const setSpeed = useCallback(
    (speed: number) => {
      send({
        type: "session.update",
        session: { type: "realtime", audio: { output: { speed } } },
      });
    },
    [send],
  );

  // ── Connect ────────────────────────────────────────────────────

  const connect = useCallback(async () => {
    const id = convRef.current;
    if (!id) return;
    if (pcRef.current) disconnect();

    setError(null);
    setStatus("connecting");

    try {
      const token = await api.createRealtimeSession(id);
      modelRef.current = token.model;

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      // The model's voice arrives as a media track — no decoding, no buffering
      // in our code, no time-to-first-audio penalty.
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.style.display = "none";
      document.body.appendChild(audio);
      audioRef.current = audio;
      pc.ontrack = (event) => {
        audio.srcObject = event.streams[0] ?? null;
      };

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      const track = stream.getAudioTracks()[0];
      if (track) pc.addTrack(track, stream);

      const dc = pc.createDataChannel(DATA_CHANNEL_NAME);
      dcRef.current = dc;
      dc.addEventListener("message", (message: MessageEvent<string>) => {
        let parsed: RealtimeServerEvent;
        try {
          parsed = JSON.parse(message.data) as RealtimeServerEvent;
        } catch {
          return;
        }
        handleEvent(parsed);
      });
      dc.addEventListener("open", () => setStatus("live"));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResponse = await fetch(REALTIME_CALLS_URL, {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${token.value}`,
          "Content-Type": "application/sdp",
        },
      });

      if (!sdpResponse.ok) {
        throw new Error(
          `A OpenAI recusou a conexao (${sdpResponse.status}): ${(
            await sdpResponse.text()
          ).slice(0, 200)}`,
        );
      }

      await pc.setRemoteDescription({
        type: "answer",
        sdp: await sdpResponse.text(),
      });

      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          setStatus((current) => (current === "live" ? "idle" : current));
        }
      });

      openJobStream(id);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Nao foi possivel iniciar a sessao.";
      setError(
        /Permission denied|NotAllowedError/i.test(message)
          ? "Preciso do microfone para conversar. Libere o acesso e tente de novo."
          : message,
      );
      setStatus("error");
      disconnect();
    }
  }, [disconnect, handleEvent, openJobStream]);

  // ── Text input (same conversation, typed instead of spoken) ────

  const sendText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !dcRef.current) return;
      upsertEntry(`typed-${Date.now()}`, "user", () => trimmed, true);
      persist("user", trimmed);
      send(userTextEvent(trimmed));
      requestResponse();
    },
    [persist, requestResponse, send, upsertEntry],
  );

  const cancelJob = useCallback((jobId: string) => {
    void api.cancelAgentJob(jobId).catch(() => {});
  }, []);

  // Switching conversations tears the session down; a live call belongs to the
  // conversation it was opened for.
  useEffect(() => {
    setTranscript([]);
    setJobs([]);
    setSessionUsd(0);
    return () => disconnect();
  }, [conversationId, disconnect]);

  return {
    status,
    error,
    transcript,
    userSpeaking,
    assistantSpeaking,
    activeTool,
    jobs,
    sessionUsd,
    connect,
    disconnect,
    sendText,
    cancelJob,
    setSpeed,
  };
}

/** Tool output is for the model, not the sidebar — show just enough to trust it. */
function summarize(output: string): string {
  const firstLine = output.split("\n").find((line) => line.trim().length > 0) ?? "";
  return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
}
