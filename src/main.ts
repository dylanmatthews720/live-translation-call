import "./style.css";

const SERVER_URL = "http://localhost:3000";

interface Notes {
  summary: string;
  keyPoints: string[];
  actionItems: string[];
  sentiment: "positive" | "neutral" | "negative" | "mixed";
  topics: string[];
}

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

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <div class="container">
    <h1>Live Translation Call</h1>
    <p class="subtitle">Real-time translated phone calls between any two languages</p>

    <div class="card">
      <h2 class="section-label">You</h2>
      <div class="form-row">
        <div class="form-group">
          <label for="phoneA">Phone Number</label>
          <input type="tel" id="phoneA" placeholder="+15551234567">
        </div>
        <div class="form-group">
          <label for="languageA">Language</label>
          <select id="languageA">${langOptions}</select>
        </div>
      </div>

      <div class="divider"><span>translates to</span></div>

      <h2 class="section-label">Other Person</h2>
      <div class="form-row">
        <div class="form-group">
          <label for="phoneB">Phone Number</label>
          <input type="tel" id="phoneB" placeholder="+15559876543">
        </div>
        <div class="form-group">
          <label for="languageB">Language</label>
          <select id="languageB">${langOptions}</select>
        </div>
      </div>

      <button id="startCall" class="btn-primary">Start Translated Call</button>
      <button id="endCall" class="btn-danger" hidden>End Call</button>
    </div>

    <p id="status" class="status">Ready</p>

    <div id="notesPanel" class="notes-panel" hidden>
      <div class="notes-header">
        <div class="notes-header-left">
          <div class="notes-icon">✦</div>
          <h2>AI Call Notes</h2>
        </div>
        <span id="sentimentBadge" class="sentiment-badge"></span>
      </div>

      <div id="notesLoading" class="notes-loading">
        <div class="spinner"></div>
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

// Default the second language to English
document.querySelector<HTMLSelectElement>("#languageB")!.value = "English";

let currentSessionId: string | null = null;
let pollInterval: number | null = null;
let notesPollInterval: number | null = null;

const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;
const startBtn = document.querySelector<HTMLButtonElement>("#startCall")!;
const endBtn = document.querySelector<HTMLButtonElement>("#endCall")!;
const notesPanel = document.querySelector<HTMLDivElement>("#notesPanel")!;
const notesLoading = document.querySelector<HTMLDivElement>("#notesLoading")!;
const notesContent = document.querySelector<HTMLDivElement>("#notesContent")!;

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
        }
      } catch {}
    }, 2000);
  } catch (err: any) {
    statusEl.textContent = `Error: ${err.message}`;
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
  } catch {}

  clearPolling();
  currentSessionId = null;
  statusEl.textContent = "Call ended";
  resetUI();
  startNotesPoll(sid);
};

function clearPolling() {
  if (pollInterval !== null) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function clearNotesPoll() {
  if (notesPollInterval !== null) {
    clearInterval(notesPollInterval);
    notesPollInterval = null;
  }
}

function resetUI() {
  startBtn.hidden = false;
  endBtn.hidden = true;
  currentSessionId = null;
  // Hide notes panel when starting a new call
  notesPanel.hidden = true;
  notesContent.hidden = true;
  notesLoading.hidden = false;
}

function startNotesPoll(sessionId: string) {
  clearNotesPoll();
  notesPanel.hidden = false;
  notesLoading.hidden = false;
  notesContent.hidden = true;

  // Reset sentiment badge
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
    } catch {}
  }, 2000);
}

function renderNotes(notes: Notes) {
  notesLoading.hidden = true;
  notesContent.hidden = false;

  // Summary
  document.querySelector<HTMLParagraphElement>("#notesSummary")!.textContent =
    notes.summary || "No summary available.";

  // Sentiment badge
  const badge = document.querySelector<HTMLSpanElement>("#sentimentBadge")!;
  const sentimentMap: Record<string, { label: string; cls: string }> = {
    positive: { label: "Positive", cls: "sentiment-positive" },
    negative: { label: "Negative", cls: "sentiment-negative" },
    mixed: { label: "Mixed", cls: "sentiment-mixed" },
    neutral: { label: "Neutral", cls: "sentiment-neutral" },
  };
  const s = sentimentMap[notes.sentiment] ?? sentimentMap.neutral;
  badge.textContent = s.label;
  badge.className = `sentiment-badge ${s.cls}`;

  // Key points
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

  // Action items
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

  // Topics
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
