import type { FastifyInstance } from "fastify";
import { emit } from "./bus.js";
import { SentenceSplitter } from "./sentences.js";
import type { Sentence } from "./types.js";

const PUBLIC_URL = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
const VAPI_PRIVATE_KEY = process.env.VAPI_PRIVATE_KEY ?? "";
const VAPI_PUBLIC_KEY = process.env.VAPI_PUBLIC_KEY ?? "";
const ECHO_TAIL_MS = 500;

// ---------- call state ----------
const state = {
  callId: null as string | null,
  controlUrl: null as string | null,
  controlSource: null as string | null,
  assistantSpeaking: false,
  echoUntil: 0,
  lastFinalAt: 0,
};
const seenFinals = new Map<string, number>(); // dedupe webhook + client copies of the same final

// Late import avoids a circular-import crash (pipeline imports say from here).
let onSentence: (s: Sentence) => void = () => {};
import("./pipeline.js").then((m) => {
  onSentence = (s) => {
    m.pipeline.onSentence(s).catch((err) => console.error("[pipeline] error", err));
  };
});

const splitter = new SentenceSplitter((s) => {
  console.log(`[sentence ${s.id}] +${Date.now() - state.lastFinalAt}ms  "${s.text}"`);
  emit({ type: "transcript", id: s.id, text: s.text, final: true });
  onSentence(s);
});

// ---------- assistant config (transient, used by vapi.start) ----------
export function assistantConfig() {
  return {
    name: "Jamie",
    firstMessageMode: "assistant-waits-for-user",
    transcriber: {
      provider: "deepgram",
      model: "nova-3",
      language: "en",
      endpointing: Number(process.env.DG_ENDPOINTING_MS ?? 300),
    },
    // Our endpoint always returns an empty reply, so Jamie never answers on its own.
    model: {
      provider: "custom-llm",
      url: `${PUBLIC_URL}/silent`,
      model: "silent",
      messages: [{ role: "system", content: "Stay silent." }],
    },
    voice: {
      provider: process.env.VOICE_PROVIDER ?? "deepgram",
      voiceId: process.env.VOICE_ID ?? "asteria",
    },
    server: { url: `${PUBLIC_URL}/vapi/webhook` },
    serverMessages: ['transcript[transcriptType="final"]', "status-update", "speech-update"],
    clientMessages: ["transcript", "status-update", "speech-update"],
    monitorPlan: { listenEnabled: false, controlEnabled: true }, // needed for controlUrl
    silenceTimeoutSeconds: 600,
    maxDurationSeconds: 1800,
    messagePlan: { idleMessages: [] },
  };
}

// ---------- say ----------
export async function say(text: string): Promise<void> {
  if (!state.controlUrl) await tryFetchControlUrl();

  if (!state.controlUrl) {
    // Fallback (d): the browser speaks it through the Web SDK.
    console.warn("[say] no controlUrl -> asking client to speak");
    emit({ type: "jamie", text, status: "speaking", clientShouldSpeak: true });
    return;
  }

  emit({ type: "jamie", text, status: "speaking" });
  try {
    const res = await fetch(state.controlUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "say", content: text, interruptAssistantEnabled: true }),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    console.log(`[say] via ${state.controlSource}: "${text}"`);
  } catch (err) {
    console.error("[say] control POST failed, falling back to client:", err);
    emit({ type: "jamie", text, status: "speaking", clientShouldSpeak: true });
  }
  // "done" is emitted when speech-update(assistant, stopped) arrives.
}

function setControlUrl(url: string | undefined | null, source: string) {
  if (!url || state.controlUrl) return;
  state.controlUrl = url;
  state.controlSource = source;
  console.log(`[control] got controlUrl via ${source}`);
  emit({ type: "call", status: "in-progress", control: true });
}

// Fallback (b): GET /call/:id
async function tryFetchControlUrl() {
  if (!state.callId || !VAPI_PRIVATE_KEY) return;
  try {
    const res = await fetch(`https://api.vapi.ai/call/${state.callId}`, {
      headers: { authorization: `Bearer ${VAPI_PRIVATE_KEY}` },
    });
    const call = (await res.json()) as any;
    setControlUrl(call?.monitor?.controlUrl, "GET /call/:id");
  } catch (err) {
    console.error("[control] GET /call failed", err);
  }
}

// ---------- incoming messages (same handler for webhook + client relay) ----------
function handleMessage(msg: any, source: "webhook" | "client") {
  if (!msg?.type) return;

  const callId = msg.call?.id;
  if (callId && callId !== state.callId) newCall(callId);
  setControlUrl(msg.call?.monitor?.controlUrl, `${source}:${msg.type}`); // fallback (a)

  switch (msg.type) {
    case "status-update":
      if (msg.status === "in-progress") {
        emit({ type: "call", status: "in-progress", control: !!state.controlUrl });
        if (!state.controlUrl) void tryFetchControlUrl();
      }
      if (msg.status === "ended") emit({ type: "call", status: "ended", control: false });
      break;

    case "speech-update":
      if (msg.role !== "assistant") break;
      if (msg.status === "started") {
        state.assistantSpeaking = true;
      } else if (msg.status === "stopped") {
        state.assistantSpeaking = false;
        state.echoUntil = Date.now() + ECHO_TAIL_MS;
        emit({ type: "jamie", text: "", status: "done" });
      }
      break;

    case "transcript": {
      const text: string = (msg.transcript ?? "").trim();
      const isFinal = msg.transcriptType === "final";
      if (!text || msg.role !== "user") break;
      if (!isFinal) {
        emit({ type: "transcript", id: "partial", text, final: false });
        break;
      }
      // Echo guard: don't fact-check Jamie through the speakers.
      if (state.assistantSpeaking || Date.now() < state.echoUntil) {
        console.log(`[echo-guard] dropped "${text}"`);
        break;
      }
      const key = text.toLowerCase().replace(/[^a-z0-9 ]/g, "");
      const seen = seenFinals.get(key);
      if (seen && Date.now() - seen < 5000) break; // already got this one from the other source
      seenFinals.set(key, Date.now());
      state.lastFinalAt = Date.now();
      console.log(`[final:${source}] "${text}"`);
      splitter.push(text);
      break;
    }
  }
}

function newCall(callId: string) {
  console.log(`[call] new call ${callId}`);
  state.callId = callId;
  state.controlUrl = null;
  state.controlSource = null;
  state.assistantSpeaking = false;
  state.echoUntil = 0;
  seenFinals.clear();
  splitter.reset();
  emit({ type: "call", status: "starting", control: false });
}

// ---------- routes ----------
export function registerVapiRoutes(app: FastifyInstance) {
  // Config the browser passes to vapi.start(). Public key is safe to expose.
  app.get("/assistant", async () => ({ publicKey: VAPI_PUBLIC_KEY, assistant: assistantConfig() }));

  // Vapi server webhook
  app.post("/vapi/webhook", async (req, reply) => {
    try {
      handleMessage((req.body as any)?.message, "webhook");
    } catch (err) {
      console.error("[webhook] error", err);
    }
    return reply.send({});
  });

  // Client relay: the browser forwards Web SDK `message` events here (works even if the webhook doesn't).
  app.post("/vapi/client-message", async (req) => {
    const { callId, message } = req.body as any;
    if (callId && !message?.call) message.call = { id: callId };
    try {
      handleMessage(message, "client");
    } catch (err) {
      console.error("[client-message] error", err);
    }
    return {};
  });

  // Fallback (c): the browser posts what vapi.start() resolved to.
  app.post("/vapi/register", async (req) => {
    const { call } = req.body as any;
    if (call?.id && call.id !== state.callId) newCall(call.id);
    setControlUrl(call?.monitor?.controlUrl, "client vapi.start()");
    if (!state.controlUrl) await tryFetchControlUrl();
    return { controlUrl: !!state.controlUrl, source: state.controlSource };
  });

  // Silent LLM: OpenAI-shaped, always empty.
  app.post("/silent/chat/completions", async (req, reply) => {
    const body = req.body as any;
    const base = { id: `silent-${Date.now()}`, created: Math.floor(Date.now() / 1000), model: "silent" };
    if (body?.stream) {
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const chunk = {
        ...base,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "stop" }],
      };
      reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
      return reply;
    }
    return {
      ...base,
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
    };
  });

  // Debug / stage fallbacks
  app.post("/debug/say", async (req) => {
    await say((req.body as any)?.text ?? "Quick correction. This is a test.");
    return { ok: true, controlUrl: !!state.controlUrl, source: state.controlSource };
  });
  app.post("/debug/sentence", async (req) => {
    const text = String((req.body as any)?.text ?? "").trim();
    if (text) {
      state.lastFinalAt = Date.now();
      splitter.push(text.match(/[.!?]$/) ? text : `${text}.`);
      splitter.flush();
    }
    return { ok: true };
  });
  app.get("/debug/state", async () => state);
}
