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
      `[${sessionId}] Calling A: ${phoneA} (${languageA}), B: ${phoneB} (${languageB})`
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
  if (!session) return res.status(404).json({ error: "Not found" });
  res.json({
    active: session.active,
    bothConnected: !!(session.streamA && session.streamB),
  });
});

// ---------------------------------------------------------------------------
// TwiML — Twilio fetches this when each call connects
// ---------------------------------------------------------------------------

app.post("/twiml/connect", (req, res) => {
  const { sessionId, role } = req.query;
  const twiml = new Twilio.twiml.VoiceResponse();

  twiml.say(
    { voice: "Polly.Amy" },
    "Connected to translation service. Please wait while we connect the other party."
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
          `[${sessionId}] Stream connected: role=${role}, streamSid=${streamSid}`
        );

        if (role === "a") {
          session.streamA = { ws, streamSid };
        } else {
          session.streamB = { ws, streamSid };
        }

        if (session.streamA && session.streamB && !session.openaiA2B) {
          console.log(
            `[${sessionId}] Both parties connected — starting translation`
          );
          startTranslation(session, sessionId);
        }
        break;
      }

      case "media": {
        const session = sessions.get(sessionId);
        if (!session) return;

        const audio = msg.media.payload;

        if (role === "a" && session.openaiA2B?.readyState === WebSocket.OPEN) {
          // Don't forward A's audio while B→A is playing translated audio
          // (prevents A's microphone from picking up its own speaker output)
          if (session.b2aOutputting) return;
          session.openaiA2B.send(
            JSON.stringify({ type: "input_audio_buffer.append", audio })
          );
        } else if (
          role === "b" &&
          session.openaiB2A?.readyState === WebSocket.OPEN
        ) {
          // Don't forward B's audio while A→B is playing translated audio
          // (prevents B's microphone from picking up its own speaker output)
          if (session.a2bOutputting) return;
          session.openaiB2A.send(
            JSON.stringify({ type: "input_audio_buffer.append", audio })
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
    onOutputStart: () => {
      session.a2bOutputting = true;
      // Clear any echo already buffered in B→A
      if (session.openaiB2A?.readyState === WebSocket.OPEN) {
        session.openaiB2A.send(
          JSON.stringify({ type: "input_audio_buffer.clear" })
        );
      }
    },
    onOutputEnd: () => {
      session.a2bOutputting = false;
    },
  });

  session.openaiB2A = connectOpenAI({
    fromLang: session.languageB,
    toLang: session.languageA,
    outputStream: session.streamA,
    sessionId,
    direction: "B→A",
    onOutputStart: () => {
      session.b2aOutputting = true;
      // Clear any echo already buffered in A→B
      if (session.openaiA2B?.readyState === WebSocket.OPEN) {
        session.openaiA2B.send(
          JSON.stringify({ type: "input_audio_buffer.clear" })
        );
      }
    },
    onOutputEnd: () => {
      session.b2aOutputting = false;
    },
  });
}

function connectOpenAI({
  fromLang,
  toLang,
  outputStream,
  sessionId,
  direction,
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
    }
  );

  let isSpeaking = false;

  ws.on("open", () => {
    console.log(`[${sessionId}] OpenAI session opened: ${direction}`);
    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: "coral",
          instructions: `You are a simultaneous interpreter. You are NOT an assistant. You do NOT converse. You are completely invisible.

Your ONLY job: hear ${fromLang}, speak the ${toLang} translation. Nothing else.

RULES:
- Output ONLY the direct translation of what was spoken. Word for word meaning.
- NEVER add your own words, opinions, greetings, or responses.
- NEVER say things like "sure", "okay", "hello", "how can I help", etc.
- NEVER answer questions — just translate them.
- If someone says "How are you?" in ${fromLang}, you say the ${toLang} translation of "How are you?" — you do NOT answer the question.
- Speak naturally in ${toLang} as if the original speaker were saying it themselves.
- Match the speaker's tone — casual, formal, excited, serious.
- Preserve all names, numbers, and places exactly.
- If you hear silence or noise, say absolutely nothing.`,
          turn_detection: {
            type: "server_vad",
            threshold: 0.6,
            prefix_padding_ms: 200,
            silence_duration_ms: 500,
          },
        },
      })
    );
  });

  ws.on("message", (raw) => {
    const event = JSON.parse(raw.toString());

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
          })
        );
      }
    }

    if (event.type === "response.audio.done" || event.type === "response.done") {
      if (isSpeaking) {
        isSpeaking = false;
        onOutputEnd();
      }
    }

    if (event.type === "error") {
      console.error(
        `[${sessionId}] OpenAI error (${direction}):`,
        event.error
      );
    }
  });

  ws.on("error", (err) => {
    console.error(
      `[${sessionId}] OpenAI WS error (${direction}):`,
      err.message
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

  sessions.delete(sessionId);
  console.log(`[${sessionId}] Session ended`);
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
