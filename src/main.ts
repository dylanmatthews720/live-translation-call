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
  </div>
`;

// Default the second language to English
document.querySelector<HTMLSelectElement>("#languageB")!.value = "English";

let currentSessionId: string | null = null;
let pollInterval: number | null = null;

const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;
const startBtn = document.querySelector<HTMLButtonElement>("#startCall")!;
const endBtn = document.querySelector<HTMLButtonElement>("#endCall")!;

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

  try {
    await fetch(`${SERVER_URL}/api/end-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: currentSessionId }),
    });
  } catch {}

  clearPolling();
  currentSessionId = null;
  statusEl.textContent = "Call ended";
  resetUI();
};

function clearPolling() {
  if (pollInterval !== null) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function resetUI() {
  startBtn.hidden = false;
  endBtn.hidden = true;
  currentSessionId = null;
}
