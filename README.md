# TrueSpeak.ai

TrueSpeak.ai is a real-time translated phone call platform.
It lets two people speak in different languages over a normal phone call while each side hears translated speech in near real time.

## What It Does

- Calls two phone numbers through Twilio.
- Streams both call audio to a Node.js backend.
- Uses OpenAI Realtime to transcribe + translate speech in both directions.
- Sends translated audio back to the opposite caller during the same live call.

## Core Use Cases

- Cross-language support calls between agents and customers.
- Family calls across countries where both parties prefer native languages.
- Emergency coordination when participants do not share a language.
- International business calls without requiring app installs.

## How It Works (Technical Flow)

1. The frontend collects:
- Caller A phone + language
- Caller B phone + language

2. The frontend sends `POST /api/start-call` to the backend.

3. The backend:
- Creates an in-memory session (`sessionId`).
- Starts two outbound Twilio calls in parallel.
- Gives Twilio a callback URL: `/twiml/connect?sessionId=...&role=a|b`.

4. Twilio fetches TwiML from `/twiml/connect` and opens a media stream to:
- `wss://<PUBLIC_URL_HOST>/media-stream`

5. Once both streams connect, backend opens two OpenAI Realtime sockets:
- `A -> B` translation path
- `B -> A` translation path

6. Audio processing loop:
- Twilio sends G.711 u-law audio frames (`media` events).
- Backend forwards frames to the corresponding OpenAI socket.
- OpenAI returns translated audio deltas.
- Backend sends those deltas back to the opposite Twilio stream.

7. Session end:
- User presses End Call (`POST /api/end-call`) or Twilio stream stops.
- Backend closes OpenAI sockets, completes both Twilio calls, and deletes session state.

## Architecture

### Frontend (`/`)

- Stack: Vite + TypeScript
- Main file: `src/main.ts`
- Responsibilities:
- Render call setup UI
- Validate inputs
- Start/end calls via REST
- Poll session status (`/api/session/:id`) every 2 seconds

### Backend (`/server`)

- Stack: Node.js, Express, ws, Twilio SDK
- Main file: `server/index.js`
- Responsibilities:
- REST APIs (`/api/start-call`, `/api/end-call`, `/api/session/:id`)
- TwiML generation (`/twiml/connect`)
- WebSocket server for Twilio media streams (`/media-stream`)
- OpenAI Realtime bridging and translation in both directions
- Echo mitigation and cleanup lifecycle

## Translation and Audio Details

- OpenAI Realtime model: `gpt-4o-realtime-preview`
- Formats:
- Input audio: `g711_ulaw`
- Output audio: `g711_ulaw`
- Transcription:
- Whisper (`whisper-1`) with per-language hints
- Translation control:
- Cancels unsolicited auto-responses
- Triggers manual `response.create` only after validated transcripts
- Echo mitigation:
- Directional output flags (`a2bOutputting`, `b2aOutputting`)
- `input_audio_buffer.clear` on opposite stream while speaking
- Cooldown window (`ECHO_COOLDOWN_MS = 2000`)
- Noise filtering:
- Skips short/noise transcripts
- Skips known Whisper hallucination phrases

## Project Structure

```text
.
├── index.html                 # Frontend entry HTML
├── package.json               # Frontend scripts/deps (Vite + TS)
├── src/
│   ├── main.ts                # Frontend app logic
│   └── style.css              # Frontend styles
└── server/
    ├── index.js               # Backend API + Twilio/OpenAI bridge
    ├── package.json           # Backend scripts/deps
    └── .env.example           # Required environment variables
```

## Environment Variables

Create `server/.env` from `server/.env.example`:

```env
OPENAI_API_KEY=sk-...
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token_here
TWILIO_PHONE_NUMBER=+1234567890
PUBLIC_URL=https://your-subdomain.ngrok-free.app
```

`PUBLIC_URL` must be a public HTTPS URL that Twilio can reach (ngrok is recommended during development).

## Local Setup

### 1) Install dependencies

```bash
# Frontend deps
npm install

# Backend deps
cd server && npm install
```

### 2) Configure backend env

```bash
cd server
cp .env.example .env
# Fill in real OpenAI and Twilio credentials
```

### 3) Start backend

```bash
cd server
npm run dev
```

### 4) Start ngrok tunnel to backend

```bash
ngrok http 3000
```

Copy the HTTPS forwarding URL and set it as `PUBLIC_URL` in `server/.env`, then restart backend.

### 5) Start frontend

```bash
npm run dev
```

Open the local Vite URL (typically `http://localhost:5173`), enter both numbers/languages, and start a translated call.

## API Endpoints

- `POST /api/start-call`
- Body: `{ phoneA, phoneB, languageA, languageB }`
- Returns: `{ sessionId, status }`

- `POST /api/end-call`
- Body: `{ sessionId }`
- Returns: `{ status: "ended" }`

- `GET /api/session/:id`
- Returns session state:
- `active`
- `bothConnected`

## Current Constraints

- Session state is in-memory (no persistence after server restart).
- No auth/rate limiting yet (development-stage).
- Twilio call costs and OpenAI realtime usage costs apply.
- ngrok URL changes each run unless you use a reserved domain.

## Suggested Next Steps

- Add persistent session/call logs (Postgres + Redis).
- Add auth + abuse protections.
- Add call recording/transcript review tooling (with consent controls).
- Add observability dashboards (latency, drop rate, translation quality).

