import "./style.css";

const SERVER_URL = "http://localhost:3000";

const languages = [
  "Spanish",
  "English",
  "French",
  "German",
  "Italian",
  "Portuguese",
  "Chinese (Mandarin)",
  "Japanese",
  "Korean",
  "Arabic",
  "Hindi",
  "Russian",
  "Dutch",
  "Polish",
  "Turkish",
  "Vietnamese",
  "Thai",
  "Indonesian",
  "Tagalog",
  "Swahili",
  "Hebrew",
];

const langOptions = languages
  .map((l) => `<option value="${l}">${l}</option>`)
  .join("");

interface TranscriptEntry {
  id: string;
  direction: string;
  fromLang: string;
  toLang: string;
  original: string;
  translation: string;
  timestamp: number;
}

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <div class="container">
    <h1 class="headline">Live Translation Call</h1>
    <p class="subtitle">Real-time translated phone calls between any two languages</p>

    <div class="caller-blocks">
      <div class="caller-card caller-you">
        <h2 class="caller-label">You</h2>
        <div class="caller-fields">
          <div class="form-group">
            <label for="phoneA">Phone</label>
            <input type="tel" id="phoneA" placeholder="+15551234567" autocomplete="tel">
          </div>
          <div class="form-group">
            <label for="languageA">Language</label>
            <select id="languageA" aria-label="Your language">${langOptions}</select>
          </div>
        </div>
      </div>

      <div class="caller-divider" aria-hidden="true">
        <span>→</span>
      </div>

      <div class="caller-card caller-other">
        <h2 class="caller-label">Other person</h2>
        <div class="caller-fields">
          <div class="form-group">
            <label for="phoneB">Phone</label>
            <input type="tel" id="phoneB" placeholder="+15559876543" autocomplete="tel">
          </div>
          <div class="form-group">
            <label for="languageB">Language</label>
            <select id="languageB" aria-label="Other person language">${langOptions}</select>
          </div>
        </div>
      </div>
    </div>

    <div class="actions">
      <button id="startCall" class="btn-primary">Start translated call</button>
      <button id="endCall" class="btn-danger" hidden>End call</button>
    </div>

    <p id="status" class="status" role="status" aria-live="polite">Ready</p>

    <section class="transcript-section" aria-label="Live transcript">
      <h2 class="transcript-title">Translation feed</h2>
      <div class="transcript-feed">
        <p class="transcript-placeholder" id="transcriptPlaceholder">Transcriptions will appear here once both parties are connected.</p>
        <div class="transcript-list" id="transcriptList"></div>
      </div>
    </section>
  </div>
`;

document.querySelector<HTMLSelectElement>("#languageB")!.value = "English";

let currentSessionId: string | null = null;
let pollInterval: number | null = null;
let transcriptEventSource: EventSource | null = null;
const transcriptEntries: TranscriptEntry[] = [];

const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;
const startBtn = document.querySelector<HTMLButtonElement>("#startCall")!;
const endBtn = document.querySelector<HTMLButtonElement>("#endCall")!;
const transcriptListEl = document.querySelector<HTMLDivElement>("#transcriptList")!;
const transcriptPlaceholderEl = document.querySelector<HTMLParagraphElement>("#transcriptPlaceholder")!;

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function renderTranscripts(): void {
  transcriptListEl.innerHTML = "";
  if (transcriptEntries.length === 0) {
    transcriptPlaceholderEl.hidden = false;
    return;
  }
  transcriptPlaceholderEl.hidden = true;
  for (const entry of transcriptEntries) {
    const isA2B = entry.direction === "A→B";
    const block = document.createElement("div");
    block.className = `transcript-entry ${isA2B ? "transcript-entry-you" : "transcript-entry-other"}`;
    block.setAttribute("data-direction", entry.direction);
    const who = isA2B ? "You" : "Other";
    const origLabel = `${who} (${escapeHtml(entry.fromLang)})`;
    const transLabel = `Translation (${escapeHtml(entry.toLang)})`;
    block.innerHTML = `
      <div class="transcript-meta">${origLabel}</div>
      <p class="transcript-original">${escapeHtml(entry.original)}</p>
      <div class="transcript-arrow" aria-hidden="true">↓</div>
      <p class="transcript-translation">${escapeHtml(entry.translation)}</p>
    `;
    transcriptListEl.appendChild(block);
  }
  transcriptListEl.scrollTop = transcriptListEl.scrollHeight;
}

function openTranscriptStream(sessionId: string): void {
  if (transcriptEventSource) {
    transcriptEventSource.close();
    transcriptEventSource = null;
  }
  transcriptEntries.length = 0;
  renderTranscripts();

  const url = `${SERVER_URL}/api/session/${sessionId}/events`;
  const es = new EventSource(url);
  transcriptEventSource = es;

  es.onmessage = (event) => {
    try {
      const entry = JSON.parse(event.data) as TranscriptEntry;
      transcriptEntries.push(entry);
      renderTranscripts();
    } catch {
      // ignore parse errors
    }
  };

  es.onerror = () => {
    es.close();
    transcriptEventSource = null;
  };
}

function closeTranscriptStream(): void {
  if (transcriptEventSource) {
    transcriptEventSource.close();
    transcriptEventSource = null;
  }
}

startBtn.onclick = async () => {
  const phoneA = document.querySelector<HTMLInputElement>("#phoneA")!.value.trim();
  const phoneB = document.querySelector<HTMLInputElement>("#phoneB")!.value.trim();
  const languageA = document.querySelector<HTMLSelectElement>("#languageA")!.value;
  const languageB = document.querySelector<HTMLSelectElement>("#languageB")!.value;

  if (!phoneA || !phoneB) {
    statusEl.textContent = "Please enter both phone numbers (E.164 format: +1XXXXXXXXXX)";
    return;
  }

  if (languageA === languageB) {
    statusEl.textContent = "Languages must be different for translation to work";
    return;
  }

  try {
    startBtn.hidden = true;
    statusEl.textContent = "Calling both parties...";

    const res = await fetch(`${SERVER_URL}/api/start-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phoneA, phoneB, languageA, languageB }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    currentSessionId = data.sessionId;
    statusEl.textContent = "Ringing... waiting for both parties to answer";
    endBtn.hidden = false;

    openTranscriptStream(currentSessionId);

    pollInterval = window.setInterval(async () => {
      if (!currentSessionId) return;
      try {
        const r = await fetch(`${SERVER_URL}/api/session/${currentSessionId}`);
        if (!r.ok) {
          clearPolling();
          statusEl.textContent = "Call ended";
          resetUI();
          return;
        }
        const s = await r.json();
        if (s.bothConnected) {
          statusEl.textContent = "Both parties connected — translating live";
        }
        if (!s.active) {
          clearPolling();
          statusEl.textContent = "Call ended";
          resetUI();
        }
      } catch {
        // ignore
      }
    }, 2000);
  } catch (err: unknown) {
    statusEl.textContent = `Error: ${err instanceof Error ? err.message : "Unknown error"}`;
    resetUI();
  }
};

endBtn.onclick = async () => {
  if (!currentSessionId) return;

  statusEl.textContent = "Ending call...";
  endBtn.hidden = true;

  try {
    await fetch(`${SERVER_URL}/api/end-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: currentSessionId }),
    });
  } catch {
    // ignore
  }

  clearPolling();
  currentSessionId = null;
  statusEl.textContent = "Call ended";
  resetUI();
};

function clearPolling(): void {
  if (pollInterval !== null) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function resetUI(): void {
  startBtn.hidden = false;
  endBtn.hidden = true;
  currentSessionId = null;
  closeTranscriptStream();
  transcriptEntries.length = 0;
  renderTranscripts();
}
