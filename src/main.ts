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

interface Notes {
  summary: string;
  keyPoints: string[];
  actionItems: string[];
  sentiment: "positive" | "neutral" | "negative" | "mixed";
  topics: string[];
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

    <div id="notesPanel" class="notes-panel" hidden>
      <div class="notes-header">
        <div class="notes-header-left">
          <div class="notes-icon" aria-hidden="true">✦</div>
          <h2>AI Call Notes</h2>
        </div>
      
      </div>

      <div id="notesLoading" class="notes-loading">
        <div class="spinner" aria-hidden="true"></div>
        <span>Generating AI notes…</span>
      </div>

      <div id="notesContent" class="notes-content" hidden>
        <section class="notes-section">
          <h3>Summary</h3>
          <p id="notesSummary"></p>
        </section>
        <div class="notes-grid">
          <section class="notes-section" id="keyPointsSection">
            <h3>Key Points</h3>
            <ul id="notesKeyPoints" class="notes-list"></ul>
          </section>
          <section class="notes-section" id="actionItemsSection">
            <h3>Action Items</h3>
            <ul id="notesActionItems" class="notes-list action-list"></ul>
          </section>
        </div>
        <section class="notes-section" id="topicsSection">
          <h3>Topics Discussed</h3>
          <div id="notesTopics" class="topics-tags"></div>
        </section>
      </div>
    </div>
  </div>
`;

document.querySelector<HTMLSelectElement>("#languageB")!.value = "English";

let currentSessionId: string | null = null;
let pollInterval: number | null = null;
let notesPollInterval: number | null = null;
let transcriptEventSource: EventSource | null = null;
const transcriptEntries: TranscriptEntry[] = [];

const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;
const startBtn = document.querySelector<HTMLButtonElement>("#startCall")!;
const endBtn = document.querySelector<HTMLButtonElement>("#endCall")!;
const transcriptListEl =
  document.querySelector<HTMLDivElement>("#transcriptList")!;
const transcriptPlaceholderEl = document.querySelector<HTMLParagraphElement>(
  "#transcriptPlaceholder",
)!;
const notesPanel = document.querySelector<HTMLDivElement>("#notesPanel")!;
const notesLoading = document.querySelector<HTMLDivElement>("#notesLoading")!;
const notesContent = document.querySelector<HTMLDivElement>("#notesContent")!;

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
      const data = typeof event.data === "string" ? event.data : "";
      if (!data.trim()) return;
      const entry = JSON.parse(data) as TranscriptEntry;
      if (
        entry &&
        typeof entry.id === "string" &&
        typeof entry.original === "string" &&
        typeof entry.translation === "string"
      ) {
        if (!transcriptEntries.some((e) => e.id === entry.id)) {
          transcriptEntries.push(entry);
          renderTranscripts();
        }
      }
    } catch {
      // ignore parse errors
    }
  };

  es.onerror = () => {
    // Don't close on first error; EventSource may reconnect
    if (es.readyState === EventSource.CLOSED) {
      transcriptEventSource = null;
    }
  };
}

function closeTranscriptStream(): void {
  if (transcriptEventSource) {
    transcriptEventSource.close();
    transcriptEventSource = null;
  }
}

startBtn.onclick = async () => {
  const phoneA = document
    .querySelector<HTMLInputElement>("#phoneA")!
    .value.trim();
  const phoneB = document
    .querySelector<HTMLInputElement>("#phoneB")!
    .value.trim();
  const languageA =
    document.querySelector<HTMLSelectElement>("#languageA")!.value;
  const languageB =
    document.querySelector<HTMLSelectElement>("#languageB")!.value;

  if (!phoneA || !phoneB) {
    statusEl.textContent =
      "Please enter both phone numbers (E.164 format: +1XXXXXXXXXX)";
    return;
  }

  if (languageA === languageB) {
    statusEl.textContent =
      "Languages must be different for translation to work";
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

    openTranscriptStream(currentSessionId ?? "");

    pollInterval = window.setInterval(async () => {
      if (!currentSessionId) return;
      try {
        const r = await fetch(`${SERVER_URL}/api/session/${currentSessionId}`);
        if (!r.ok) {
          clearPolling();
          statusEl.textContent = "Call ended";
          const sid = currentSessionId;
          resetUI();
          startNotesPoll(sid);
          return;
        }
        const s = await r.json();
        if (s.bothConnected) {
          statusEl.textContent = "Both parties connected — translating live";
        }
        if (!s.active) {
          clearPolling();
          statusEl.textContent = "Call ended";
          const sid = currentSessionId;
          resetUI();
          startNotesPoll(sid);
          return;
        }
        // Poll transcript as fallback if SSE didn't deliver
        const txRes = await fetch(
          `${SERVER_URL}/api/session/${currentSessionId}/transcript`,
        );
        if (txRes.ok) {
          const { entries } = (await txRes.json()) as {
            entries: TranscriptEntry[];
          };
          const knownIds = new Set(transcriptEntries.map((e) => e.id));
          let changed = false;
          for (const e of entries) {
            if (!knownIds.has(e.id)) {
              transcriptEntries.push(e);
              knownIds.add(e.id);
              changed = true;
            }
          }
          if (changed) renderTranscripts();
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

  const sid = currentSessionId;

  try {
    await fetch(`${SERVER_URL}/api/end-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sid }),
    });
  } catch {
    // ignore
  }

  clearPolling();
  currentSessionId = null;
  statusEl.textContent = "Call ended";
  resetUI();
  startNotesPoll(sid);
};

function clearPolling(): void {
  if (pollInterval !== null) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function clearNotesPoll(): void {
  if (notesPollInterval !== null) {
    clearInterval(notesPollInterval);
    notesPollInterval = null;
  }
}

function resetUI(): void {
  startBtn.hidden = false;
  endBtn.hidden = true;
  currentSessionId = null;
  closeTranscriptStream();
  // Hide stale notes when a new call starts
  notesPanel.hidden = true;
  notesContent.hidden = true;
  notesLoading.hidden = false;
}

function startNotesPoll(sessionId: string): void {
  clearNotesPoll();
  notesPanel.hidden = false;
  notesLoading.hidden = false;
  notesContent.hidden = true;

  const badge = document.querySelector<HTMLSpanElement>("#sentimentBadge")!;
  badge.textContent = "";
  badge.className = "sentiment-badge";

  notesPollInterval = window.setInterval(async () => {
    try {
      const r = await fetch(`${SERVER_URL}/api/session/${sessionId}/notes`);
      if (!r.ok) {
        clearNotesPoll();
        return;
      }
      const data = await r.json();
      if (data.status === "ready") {
        clearNotesPoll();
        renderNotes(data.notes as Notes);
      }
    } catch {
      // ignore
    }
  }, 2000);
}

function renderNotes(notes: Notes): void {
  notesLoading.hidden = true;
  notesContent.hidden = false;

  document.querySelector<HTMLParagraphElement>("#notesSummary")!.textContent =
    notes.summary || "No summary available.";

  const sentimentMap: Record<string, { label: string; cls: string }> = {
    positive: { label: "Positive", cls: "sentiment-positive" },
    negative: { label: "Negative", cls: "sentiment-negative" },
    mixed: { label: "Mixed", cls: "sentiment-mixed" },
    neutral: { label: "Neutral", cls: "sentiment-neutral" },
  };
  const badge = document.querySelector<HTMLSpanElement>("#sentimentBadge")!;
  const s = sentimentMap[notes.sentiment] ?? sentimentMap.neutral;
  badge.textContent = s.label;
  badge.className = `sentiment-badge ${s.cls}`;

  const keyPointsSection =
    document.querySelector<HTMLElement>("#keyPointsSection")!;
  const keyPointsList =
    document.querySelector<HTMLUListElement>("#notesKeyPoints")!;
  if (notes.keyPoints?.length) {
    keyPointsList.innerHTML = notes.keyPoints
      .map((p) => `<li>${escapeHtml(p)}</li>`)
      .join("");
    keyPointsSection.hidden = false;
  } else {
    keyPointsSection.hidden = true;
  }

  const actionSection = document.querySelector<HTMLElement>(
    "#actionItemsSection",
  )!;
  const actionList =
    document.querySelector<HTMLUListElement>("#notesActionItems")!;
  if (notes.actionItems?.length) {
    actionList.innerHTML = notes.actionItems
      .map((a) => `<li>${escapeHtml(a)}</li>`)
      .join("");
    actionSection.hidden = false;
  } else {
    actionSection.hidden = true;
  }

  const topicsSection = document.querySelector<HTMLElement>("#topicsSection")!;
  const topicsEl = document.querySelector<HTMLDivElement>("#notesTopics")!;
  if (notes.topics?.length) {
    topicsEl.innerHTML = notes.topics
      .map((t) => `<span class="topic-tag">${escapeHtml(t)}</span>`)
      .join("");
    topicsSection.hidden = false;
  } else {
    topicsSection.hidden = true;
  }
}
