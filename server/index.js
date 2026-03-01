import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import Twilio from "twilio";
import cors from "cors";
import { randomUUID } from "node:crypto";

const {
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  PUBLIC_URL,
} = process.env;

if (
  !OPENAI_API_KEY ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER ||
  !PUBLIC_URL
) {
  console.error("Missing required environment variables. See .env.example");
  process.exit(1);
}

const twilioClient = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const httpServer = createServer(app);

const wss = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (req, socket, head) => {
  if (req.url === "/media-stream") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------
const sessions = new Map();
const sessionNotes = new Map(); // persists after session ends
const ECHO_COOLDOWN_MS = 2000;

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

app.post("/api/start-call", async (req, res) => {
  const { phoneA, phoneB, languageA, languageB } = req.body;

  if (!phoneA || !phoneB || !languageA || !languageB) {
    return res.status(400).json({ error: "All fields are required" });
  }

  const sessionId = randomUUID();
  sessions.set(sessionId, {
    languageA,
    languageB,
    streamA: null,
    streamB: null,
    openaiA2B: null,
    openaiB2A: null,
    callSidA: null,
    callSidB: null,
    active: true,
    a2bOutputting: false,
    b2aOutputting: false,
    a2bOutputEndTime: 0,
    b2aOutputEndTime: 0,
    transcript: [], // { role: 'A'|'B', lang: string, text: string, ts: number }
  });

  try {
    const [callA, callB] = await Promise.all([
      twilioClient.calls.create({
        to: phoneA,
        from: TWILIO_PHONE_NUMBER,
        url: `${PUBLIC_URL}/twiml/connect?sessionId=${sessionId}&role=a`,
      }),
      twilioClient.calls.create({
        to: phoneB,
        from: TWILIO_PHONE_NUMBER,
        url: `${PUBLIC_URL}/twiml/connect?sessionId=${sessionId}&role=b`,
      }),
    ]);

    const session = sessions.get(sessionId);
    session.callSidA = callA.sid;
    session.callSidB = callB.sid;

    console.log(
      `[${sessionId}] Calling A: ${phoneA} (${languageA}), B: ${phoneB} (${languageB})`,
    );
    res.json({ sessionId, status: "calling" });
  } catch (err) {
    sessions.delete(sessionId);
    console.error("Failed to create calls:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/end-call", async (req, res) => {
  const { sessionId } = req.body;
  await endSession(sessionId);
  res.json({ status: "ended" });
});

app.get("/api/session/:id", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    // Session may have ended — check if notes exist
    const notes = sessionNotes.get(req.params.id);
    if (notes !== undefined) {
      return res.json({
        active: false,
        bothConnected: false,
        notesReady: notes !== null,
      });
    }
    return res.status(404).json({ error: "Not found" });
  }
  res.json({
    active: session.active,
    bothConnected: !!(session.streamA && session.streamB),
    notesReady: false,
  });
});

app.get("/api/session/:id/notes", (req, res) => {
  const notes = sessionNotes.get(req.params.id);
  if (notes === undefined) return res.status(404).json({ error: "Not found" });
  if (notes === null) return res.json({ status: "generating" });
  res.json({ status: "ready", notes });
});

// ---------------------------------------------------------------------------
// TwiML — Twilio fetches this when each call connects
// ---------------------------------------------------------------------------

app.post("/twiml/connect", (req, res) => {
  const { sessionId, role } = req.query;
  const twiml = new Twilio.twiml.VoiceResponse();

  twiml.say(
    { voice: "Polly.Amy" },
    "Connected to translation service. Please wait while we connect the other party.",
  );
  twiml.pause({ length: 1 });

  const connect = twiml.connect();
  const stream = connect.stream({
    url: `wss://${new URL(PUBLIC_URL).host}/media-stream`,
  });
  stream.parameter({ name: "sessionId", value: sessionId });
  stream.parameter({ name: "role", value: role });

  res.type("text/xml").send(twiml.toString());
});

// ---------------------------------------------------------------------------
// WebSocket — Twilio Media Streams
// ---------------------------------------------------------------------------

wss.on("connection", (ws) => {
  let sessionId = null;
  let role = null;
  let streamSid = null;

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    switch (msg.event) {
      case "start": {
        const params = msg.start.customParameters || {};
        sessionId = params.sessionId;
        role = params.role;
        streamSid = msg.start.streamSid;

        const session = sessions.get(sessionId);
        if (!session || !session.active) {
          console.warn(`[${sessionId}] Session not found or inactive`);
          ws.close();
          return;
        }

        console.log(
          `[${sessionId}] Stream connected: role=${role}, streamSid=${streamSid}`,
        );

        if (role === "a") {
          session.streamA = { ws, streamSid };
        } else {
          session.streamB = { ws, streamSid };
        }

        if (session.streamA && session.streamB && !session.openaiA2B) {
          console.log(
            `[${sessionId}] Both parties connected — starting translation`,
          );
          startTranslation(session, sessionId);
        }
        break;
      }

      case "media": {
        const session = sessions.get(sessionId);
        if (!session) return;

        const audio = msg.media.payload;
        const now = Date.now();

        if (role === "a" && session.openaiA2B?.readyState === WebSocket.OPEN) {
          if (session.b2aOutputting) return;
          if (now - session.b2aOutputEndTime < ECHO_COOLDOWN_MS) return;
          session.openaiA2B.send(
            JSON.stringify({ type: "input_audio_buffer.append", audio }),
          );
        } else if (
          role === "b" &&
          session.openaiB2A?.readyState === WebSocket.OPEN
        ) {
          if (session.a2bOutputting) return;
          if (now - session.a2bOutputEndTime < ECHO_COOLDOWN_MS) return;
          session.openaiB2A.send(
            JSON.stringify({ type: "input_audio_buffer.append", audio }),
          );
        }
        break;
      }

      case "stop": {
        console.log(`[${sessionId}] Stream stopped: role=${role}`);
        endSession(sessionId);
        break;
      }
    }
  });

  ws.on("close", () => {
    console.log(`[${sessionId}] WebSocket closed: role=${role}`);
  });
});

// ---------------------------------------------------------------------------
// OpenAI Realtime translation bridge
// ---------------------------------------------------------------------------

function startTranslation(session, sessionId) {
  session.openaiA2B = connectOpenAI({
    fromLang: session.languageA,
    toLang: session.languageB,
    outputStream: session.streamB,
    sessionId,
    direction: "A→B",
    onTranscript: (text) => {
      session.transcript.push({
        role: "A",
        lang: session.languageA,
        text,
        ts: Date.now(),
      });
    },
    onOutputStart: () => {
      session.a2bOutputting = true;
      if (session.openaiB2A?.readyState === WebSocket.OPEN) {
        session.openaiB2A.send(
          JSON.stringify({ type: "input_audio_buffer.clear" }),
        );
      }
    },
    onOutputEnd: () => {
      session.a2bOutputting = false;
      session.a2bOutputEndTime = Date.now();
      if (session.openaiB2A?.readyState === WebSocket.OPEN) {
        session.openaiB2A.send(
          JSON.stringify({ type: "input_audio_buffer.clear" }),
        );
      }
    },
  });

  session.openaiB2A = connectOpenAI({
    fromLang: session.languageB,
    toLang: session.languageA,
    outputStream: session.streamA,
    sessionId,
    direction: "B→A",
    onTranscript: (text) => {
      session.transcript.push({
        role: "B",
        lang: session.languageB,
        text,
        ts: Date.now(),
      });
    },
    onOutputStart: () => {
      session.b2aOutputting = true;
      if (session.openaiA2B?.readyState === WebSocket.OPEN) {
        session.openaiA2B.send(
          JSON.stringify({ type: "input_audio_buffer.clear" }),
        );
      }
    },
    onOutputEnd: () => {
      session.b2aOutputting = false;
      session.b2aOutputEndTime = Date.now();
      if (session.openaiA2B?.readyState === WebSocket.OPEN) {
        session.openaiA2B.send(
          JSON.stringify({ type: "input_audio_buffer.clear" }),
        );
      }
    },
  });
}

const LANGUAGE_CODES = {
  English: "en",
  Spanish: "es",
  French: "fr",
  German: "de",
  Italian: "it",
  Portuguese: "pt",
  "Chinese (Mandarin)": "zh",
  Japanese: "ja",
  Korean: "ko",
  Arabic: "ar",
  Hindi: "hi",
  Russian: "ru",
  Dutch: "nl",
  Polish: "pl",
  Turkish: "tr",
  Vietnamese: "vi",
  Thai: "th",
  Indonesian: "id",
  Tagalog: "tl",
  Swahili: "sw",
  Hebrew: "he",
};

const WHISPER_HALLUCINATIONS = new Set([
  "thank you",
  "thank you.",
  "thanks.",
  "thank you for watching.",
  "thank you for your time and attention.",
  "thank you for watching",
  "thank you for your time and attention",
  "thanks for watching.",
  "thanks for watching",
  "please subscribe.",
  "please subscribe",
  "like and subscribe.",
  "like and subscribe",
  "bye.",
  "bye",
  "you",
  "the end.",
  "the end",
  "let me know if you need any help.",
  "let me know if you need any help",
  "let me check.",
  "let me check",
  "how can i help you?",
  "how can i help you",
  "how can i assist you?",
  "how can i assist you",
  "sure.",
  "sure",
  "of course.",
  "of course",
  "i understand.",
  "i understand",
]);

function isWhisperHallucination(text) {
  return WHISPER_HALLUCINATIONS.has(text.toLowerCase());
}

function connectOpenAI({
  fromLang,
  toLang,
  outputStream,
  sessionId,
  direction,
  onTranscript,
  onOutputStart,
  onOutputEnd,
}) {
  const ws = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    },
  );

  let isSpeaking = false;
  let lastOutputEndTime = 0;
  let awaitingManualResponse = false;

  ws.on("open", () => {
    console.log(`[${sessionId}] OpenAI session opened: ${direction}`);
    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_transcription: {
            model: "whisper-1",
            language: LANGUAGE_CODES[fromLang] || undefined,
          },
          voice: "coral",
          temperature: 0.6,
          instructions: `You translate ${fromLang} to ${toLang}. Output ONLY the translation.`,
          turn_detection: {
            type: "server_vad",
            threshold: 0.8,
            prefix_padding_ms: 300,
            silence_duration_ms: 700,
          },
        },
      }),
    );
  });

  ws.on("message", (raw) => {
    const event = JSON.parse(raw.toString());

    // Cancel EVERY auto-response. Only manual responses are allowed.
    if (event.type === "response.created") {
      if (!awaitingManualResponse) {
        ws.send(JSON.stringify({ type: "response.cancel" }));
        return;
      }
      awaitingManualResponse = false;
    }

    // When transcription arrives, validate and create a manual translation.
    if (
      event.type === "conversation.item.input_audio_transcription.completed"
    ) {
      const transcript = (event.transcript || "").trim();
      console.log(`[${sessionId}] ${direction} HEARD: "${transcript}"`);

      if (transcript.length < 2) {
        console.log(`[${sessionId}] ${direction} SKIP (empty/noise)`);
        return;
      }

      if (isWhisperHallucination(transcript)) {
        console.log(`[${sessionId}] ${direction} SKIP (Whisper hallucination)`);
        return;
      }

      const timeSinceOutput = Date.now() - lastOutputEndTime;
      if (lastOutputEndTime > 0 && timeSinceOutput < ECHO_COOLDOWN_MS) {
        console.log(
          `[${sessionId}] ${direction} SKIP (echo cooldown, ${timeSinceOutput}ms)`,
        );
        return;
      }

      onTranscript?.(transcript);

      console.log(`[${sessionId}] ${direction} TRANSLATING to ${toLang}`);
      awaitingManualResponse = true;
      ws.send(
        JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            instructions: `Translate the following text to ${toLang}. Speak ONLY the ${toLang} translation. Do not add any extra words, do not answer questions, do not respond — just translate:\n\n"${transcript}"`,
          },
        }),
      );
    }

    if (event.type === "response.audio.delta" && event.delta) {
      if (!isSpeaking) {
        isSpeaking = true;
        onOutputStart();
      }

      if (outputStream?.ws?.readyState === WebSocket.OPEN) {
        outputStream.ws.send(
          JSON.stringify({
            event: "media",
            streamSid: outputStream.streamSid,
            media: { payload: event.delta },
          }),
        );
      }
    }

    if (
      event.type === "response.audio.done" ||
      event.type === "response.done"
    ) {
      if (isSpeaking) {
        isSpeaking = false;
        lastOutputEndTime = Date.now();
        onOutputEnd();
      }
    }

    if (event.type === "response.audio_transcript.done") {
      console.log(`[${sessionId}] ${direction} SAID: "${event.transcript}"`);
    }

    if (event.type === "error") {
      if (event.error?.code !== "response_cancel_not_active") {
        console.error(
          `[${sessionId}] OpenAI error (${direction}):`,
          event.error,
        );
      }
    }
  });

  ws.on("error", (err) => {
    console.error(
      `[${sessionId}] OpenAI WS error (${direction}):`,
      err.message,
    );
  });

  ws.on("close", () => {
    console.log(`[${sessionId}] OpenAI session closed: ${direction}`);
  });

  return ws;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function endSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.active = false;

  for (const ws of [session.openaiA2B, session.openaiB2A]) {
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
  }

  for (const sid of [session.callSidA, session.callSidB]) {
    if (!sid) continue;
    try {
      await twilioClient.calls(sid).update({ status: "completed" });
    } catch {}
  }

  const transcript = session.transcript || [];
  sessions.delete(sessionId);
  console.log(`[${sessionId}] Session ended`);

  // Generate AI notes asynchronously; null = generating, string = ready
  if (transcript.length > 0) {
    sessionNotes.set(sessionId, null);
    generateNotes(sessionId, transcript, session.languageA, session.languageB);
  } else {
    sessionNotes.set(sessionId, {
      summary: "No conversation was recorded.",
      keyPoints: [],
      actionItems: [],
      sentiment: "neutral",
    });
  }

  // Clean up notes after 1 hour to avoid memory leaks
  setTimeout(() => sessionNotes.delete(sessionId), 60 * 60 * 1000);
}

async function generateNotes(sessionId, transcript, languageA, languageB) {
  try {
    const formatted = transcript
      .map(
        (t) =>
          `[${t.role === "A" ? `Party A (${languageA})` : `Party B (${languageB})`}]: ${t.text}`,
      )
      .join("\n");

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are a professional meeting notes assistant. Analyze the following phone call transcript (which was translated in real-time between ${languageA} and ${languageB}) and produce structured notes in JSON format.

Return ONLY valid JSON with this exact structure:
{
  "summary": "2-3 sentence summary of the conversation",
  "keyPoints": ["point 1", "point 2", ...],
  "actionItems": ["action 1", "action 2", ...],
  "sentiment": "positive" | "neutral" | "negative" | "mixed",
  "topics": ["topic 1", "topic 2", ...]
}

Keep all output in English regardless of the call languages.`,
          },
          {
            role: "user",
            content: `Here is the call transcript:\n\n${formatted}`,
          },
        ],
        temperature: 0.3,
        response_format: { type: "json_object" },
      }),
    });

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    const notes = JSON.parse(content);
    sessionNotes.set(sessionId, notes);
    console.log(`[${sessionId}] AI notes generated`);
  } catch (err) {
    console.error(`[${sessionId}] Failed to generate notes:`, err.message);
    sessionNotes.set(sessionId, {
      summary: "Notes could not be generated for this call.",
      keyPoints: [],
      actionItems: [],
      sentiment: "neutral",
      topics: [],
    });
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Public URL: ${PUBLIC_URL}`);
  console.log(`Waiting for calls...`);
});
