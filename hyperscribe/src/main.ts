import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { dirname, basename, join, downloadDir } from "@tauri-apps/api/path";
import { createElement, UploadCloud, FileMusic, Play, Download, Settings as SettingsIcon } from "lucide";

const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "ogg", "opus", "flac", "webm", "mp4"];

interface Utterance {
  speaker: number;
  transcript: string;
}

interface Balance {
  amount: number;
  units: string;
}

interface StoredSettings {
  apiKey: string;
}

let selectedPath: string | null = null;
let transcriptText = "";
let transcriptFileName = "";
let startBalance: number | null = null;
let lastUploadDir: string | null = null;
let lastDownloadDir: string | null = null;

const dropzone = document.querySelector<HTMLElement>("#dropzone")!;
const dropzoneIcon = document.querySelector<HTMLElement>("#dropzone-icon")!;
const dropzoneText = document.querySelector<HTMLElement>("#dropzone-text")!;
const dropzoneFile = document.querySelector<HTMLElement>("#dropzone-file")!;
const startBtn = document.querySelector<HTMLButtonElement>("#start-btn")!;
const startIcon = document.querySelector<HTMLElement>("#start-icon")!;
const downloadBtn = document.querySelector<HTMLButtonElement>("#download-btn")!;
const downloadIcon = document.querySelector<HTMLElement>("#download-icon")!;
const progress = document.querySelector<HTMLElement>("#progress")!;
const progressText = document.querySelector<HTMLElement>("#progress-text")!;
const progressError = document.querySelector<HTMLElement>("#progress-error")!;
const budgetUsedEl = document.querySelector<HTMLElement>("#budget-used")!;
const languageChips = document.querySelectorAll<HTMLButtonElement>(".chip");
const settingsBtn = document.querySelector<HTMLButtonElement>("#settings-btn")!;
const settingsIcon = document.querySelector<HTMLElement>("#settings-icon")!;
const settingsOverlay = document.querySelector<HTMLElement>("#settings-overlay")!;
const settingsApiKeyInput = document.querySelector<HTMLInputElement>("#settings-api-key")!;
const settingsErrorEl = document.querySelector<HTMLElement>("#settings-error")!;
const settingsCancelBtn = document.querySelector<HTMLButtonElement>("#settings-cancel")!;
const settingsSaveBtn = document.querySelector<HTMLButtonElement>("#settings-save")!;

startIcon.appendChild(createElement(Play));
downloadIcon.appendChild(createElement(Download));
dropzoneIcon.appendChild(createElement(UploadCloud));
settingsIcon.appendChild(createElement(SettingsIcon));

languageChips.forEach((chip) => {
  chip.addEventListener("click", () => {
    languageChips.forEach((c) => c.classList.remove("is-active"));
    chip.classList.add("is-active");
  });
});

function formatNumber(amount: number): string {
  return amount.toLocaleString("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

async function refreshBalance() {
  try {
    const balance = await invoke<Balance>("get_balance");
    if (startBalance === null) {
      startBalance = balance.amount;
    }
    const used = startBalance - balance.amount;
    budgetUsedEl.textContent = `Verbrauch: ${formatNumber(used)} (${formatNumber(balance.amount)}) ${balance.units.toUpperCase()}`;
  } catch (err) {
    budgetUsedEl.textContent = `Verbrauch: nicht verfügbar (${String(err)})`;
  }
}

function openSettings(forced: boolean, existing?: StoredSettings) {
  settingsApiKeyInput.value = existing?.apiKey ?? "";
  settingsErrorEl.classList.add("is-hidden");
  settingsCancelBtn.classList.toggle("is-hidden", forced);
  settingsOverlay.classList.remove("is-hidden");
}

function closeSettings() {
  settingsOverlay.classList.add("is-hidden");
}

settingsBtn.addEventListener("click", async () => {
  const existing = await invoke<StoredSettings | null>("load_settings");
  openSettings(false, existing ?? undefined);
});

settingsCancelBtn.addEventListener("click", () => closeSettings());

settingsSaveBtn.addEventListener("click", async () => {
  const apiKey = settingsApiKeyInput.value.trim();
  if (!apiKey) {
    settingsErrorEl.textContent = "Bitte einen API-Key eingeben.";
    settingsErrorEl.classList.remove("is-hidden");
    return;
  }
  await invoke("save_settings", { apiKey, projectId: null });
  closeSettings();
  startBalance = null;
  void refreshBalance();
});

async function initSettings() {
  const existing = await invoke<StoredSettings | null>("load_settings");
  if (!existing || !existing.apiKey) {
    openSettings(true, existing ?? undefined);
  } else {
    void refreshBalance();
  }
}

void initSettings();

function isAudioFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXTENSIONS.includes(ext);
}

async function selectFile(path: string) {
  if (!isAudioFile(path)) {
    dropzoneFile.textContent = "Nicht unterstütztes Format";
    return;
  }
  selectedPath = path;
  lastUploadDir = await dirname(path);
  dropzoneFile.textContent = await basename(path);
  dropzoneIcon.innerHTML = "";
  dropzoneIcon.appendChild(createElement(FileMusic));
  dropzoneText.textContent = "Andere Datei wählen";
  startBtn.disabled = false;
  downloadBtn.disabled = true;
  progressError.classList.add("is-hidden");
  resetSteps();
  activateDot("preparing");
}

dropzone.addEventListener("click", async () => {
  const result = await open({
    multiple: false,
    defaultPath: lastUploadDir ?? undefined,
    filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
  });
  if (typeof result === "string") {
    await selectFile(result);
  }
});

dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    dropzone.click();
  }
});

getCurrentWebview().onDragDropEvent((event) => {
  if (event.payload.type === "enter" || event.payload.type === "over") {
    dropzone.classList.add("is-dragover");
  } else if (event.payload.type === "leave") {
    dropzone.classList.remove("is-dragover");
  } else if (event.payload.type === "drop") {
    dropzone.classList.remove("is-dragover");
    const path = event.payload.paths[0];
    if (path) void selectFile(path);
  }
});

function getSelectedLanguage(): string {
  const active = document.querySelector<HTMLButtonElement>(".chip.is-active");
  return active?.dataset.lang ?? "auto";
}

const STEP_TEXT: Record<string, string> = {
  preparing: "Datei wird vorbereitet",
  transcribing: "Hochladen & Transkription läuft",
  done: "Fertig",
};

function activateDot(step: string) {
  progress.querySelector<HTMLElement>(`.dot[data-step="${step}"]`)?.classList.add("is-active");
}

function setStep(step: string) {
  activateDot(step);
  progressText.textContent = STEP_TEXT[step] ?? "";
}

function resetSteps() {
  progress.querySelectorAll<HTMLElement>(".dot").forEach((dot) => dot.classList.remove("is-active"));
  progressText.textContent = "";
}

startBtn.addEventListener("click", async () => {
  if (!selectedPath) return;
  startBtn.disabled = true;
  downloadBtn.disabled = true;
  progressError.classList.add("is-hidden");
  resetSteps();
  activateDot("preparing");

  const unlisten = await listen<string>("transcription-progress", (event) => {
    setStep(event.payload);
  });

  try {
    const utterances = await invoke<Utterance[]>("transcribe_audio", {
      path: selectedPath,
      language: getSelectedLanguage(),
    });
    transcriptText = utterances
      .map((u) => `[Sprecher ${u.speaker + 1}]\n${u.transcript}`)
      .join("\n\n");
    const fullName = await basename(selectedPath);
    const base = fullName.replace(/\.[^.]+$/, "");
    transcriptFileName = `${base}.txt`;
    downloadBtn.disabled = false;
    void refreshBalance();
    // start stays disabled after success, until a new file is selected
  } catch (err) {
    progressError.textContent = String(err);
    progressError.classList.remove("is-hidden");
    startBtn.disabled = false;
  } finally {
    unlisten();
  }
});

downloadBtn.addEventListener("click", async () => {
  if (!transcriptText || !selectedPath) return;
  const dir = lastDownloadDir ?? (await downloadDir());
  const defaultPath = await join(dir, transcriptFileName);
  const savePath = await save({
    defaultPath,
    filters: [{ name: "Text", extensions: ["txt"] }],
  });
  if (!savePath) return;
  await invoke("save_transcript", { path: savePath, content: transcriptText });
  lastDownloadDir = await dirname(savePath);
});
