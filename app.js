import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

const DEFAULT_SPEED = 300;
const MIN_SPEED = 100;
const MAX_SPEED = 800;
const SETTINGS_KEY = "lector-focal:velocidad";
const BOOK_STORAGE_PREFIX = "lector-focal:libro:";
const numberFormatter = new Intl.NumberFormat("es-ES");

const uploadView = document.querySelector("#upload-view");
const readerView = document.querySelector("#reader-view");
const fileInput = document.querySelector("#pdf-input");
const uploadStatus = document.querySelector("#upload-status");
const bookTitle = document.querySelector("#book-title");
const bookMeta = document.querySelector("#book-meta");
const wordDisplay = document.querySelector("#word-display");
const completionMessage = document.querySelector("#completion-message");
const positionLabel = document.querySelector("#position-label");
const progressPercent = document.querySelector("#progress-percent");
const progressControl = document.querySelector("#progress-control");
const backButton = document.querySelector("#back-button");
const playButton = document.querySelector("#play-button");
const forwardButton = document.querySelector("#forward-button");
const speedControl = document.querySelector("#speed-control");
const speedOutput = document.querySelector("#speed-output");
const changeBookButton = document.querySelector("#change-book");

const state = {
  words: [],
  currentIndex: 0,
  wordsPerMinute: loadSavedSpeed(),
  isPlaying: false,
  timerId: null,
  storageKey: null,
  pageCount: 0,
};

speedControl.value = String(state.wordsPerMinute);
updateSpeedInterface();

fileInput.addEventListener("change", handleFileSelection);
playButton.addEventListener("click", togglePlayback);
backButton.addEventListener("click", () => seekBy(-10));
forwardButton.addEventListener("click", () => seekBy(10));
changeBookButton.addEventListener("click", () => fileInput.click());

progressControl.addEventListener("input", () => {
  pausePlayback();
  state.currentIndex = Number(progressControl.value);
  renderReader();
});

progressControl.addEventListener("change", saveBookProgress);

speedControl.addEventListener("input", () => {
  state.wordsPerMinute = Number(speedControl.value);
  updateSpeedInterface();
  updateBookMetadata();
  saveSpeed();

  if (state.isPlaying) {
    window.clearTimeout(state.timerId);
    scheduleNextWord();
  }
});

document.addEventListener("keydown", handleKeyboardShortcut);
document.addEventListener("visibilitychange", () => {
  if (document.hidden && state.isPlaying) {
    pausePlayback();
  }
});

window.addEventListener("beforeunload", saveBookProgress);

async function handleFileSelection(event) {
  const [file] = event.target.files;

  if (!file) {
    return;
  }

  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    setUploadStatus("El archivo seleccionado no es un PDF.", "error");
    fileInput.value = "";
    return;
  }

  stopPlayback();
  readerView.hidden = true;
  uploadView.hidden = false;
  uploadView.setAttribute("aria-busy", "true");
  fileInput.disabled = true;
  setUploadStatus("Abriendo el PDF…");

  let pdfDocument;

  try {
    const fileData = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: fileData });

    loadingTask.onProgress = ({ loaded, total }) => {
      if (total) {
        const percentage = Math.round((loaded / total) * 100);
        setUploadStatus(`Abriendo el PDF… ${percentage} %`);
      }
    };

    pdfDocument = await loadingTask.promise;
    const pageTexts = [];

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      setUploadStatus(`Extrayendo texto de la página ${pageNumber} de ${pdfDocument.numPages}…`);
      const page = await pdfDocument.getPage(pageNumber);
      const textContent = await page.getTextContent();
      pageTexts.push(extractPageText(textContent.items));
      page.cleanup();
    }

    const normalizedText = normalizeText(pageTexts.join("\n"));
    const words = normalizedText.match(/\S+/gu) ?? [];

    if (words.length === 0) {
      throw new Error("NO_EXTRACTABLE_TEXT");
    }

    openBook(file, words, pdfDocument.numPages);
  } catch (error) {
    console.error("No se pudo abrir el PDF:", error);

    if (error.message === "NO_EXTRACTABLE_TEXT") {
      setUploadStatus(
        "No encontramos texto seleccionable. Los PDF escaneados necesitarán OCR en una versión futura.",
        "error",
      );
    } else {
      setUploadStatus("No se pudo leer este PDF. Prueba con otro archivo.", "error");
    }
  } finally {
    if (pdfDocument) {
      await pdfDocument.destroy();
    }

    uploadView.removeAttribute("aria-busy");
    fileInput.disabled = false;
    fileInput.value = "";
  }
}

function extractPageText(items) {
  let pageText = "";
  let previousItem = null;

  for (const item of items) {
    if (typeof item.str !== "string") {
      continue;
    }

    if (item.str.length === 0) {
      if (item.hasEOL) {
        pageText += "\n";
        previousItem = null;
      }

      continue;
    }

    if (previousItem) {
      if (startsNewLine(previousItem, item)) {
        pageText += "\n";
      } else if (hasWordGap(previousItem, item)) {
        pageText += " ";
      }
    }

    pageText += item.str;
    previousItem = item;
  }

  return pageText.trim();
}

function startsNewLine(previousItem, currentItem) {
  if (previousItem.hasEOL) {
    return true;
  }

  const previousX = previousItem.transform?.[4];
  const previousY = previousItem.transform?.[5];
  const currentX = currentItem.transform?.[4];
  const currentY = currentItem.transform?.[5];

  if (![previousX, previousY, currentX, currentY].every(Number.isFinite)) {
    return false;
  }

  const textHeight = Math.max(previousItem.height || 0, currentItem.height || 0, 1);
  const changedLine = Math.abs(currentY - previousY) > textHeight * 0.5;
  const returnedToLineStart = currentX < previousX + (previousItem.width || 0);

  return changedLine && returnedToLineStart;
}

function hasWordGap(previousItem, currentItem) {
  if (/\s$/u.test(previousItem.str) || /^\s/u.test(currentItem.str)) {
    return false;
  }

  const previousX = previousItem.transform?.[4];
  const currentX = currentItem.transform?.[4];
  const previousWidth = previousItem.width;

  if (![previousX, currentX, previousWidth].every(Number.isFinite)) {
    return false;
  }

  const previousEnd = previousX + previousWidth;
  const gap = currentX - previousEnd;
  const textHeight = Math.max(previousItem.height || 0, currentItem.height || 0, 1);

  return gap > textHeight * 0.15;
}

function normalizeText(text) {
  return text
    .replace(/([\p{L}\p{N}])-\s*\n\s*([\p{L}\p{N}])/gu, "$1$2")
    .replace(/\s+/gu, " ")
    .trim();
}

function openBook(file, words, pageCount) {
  state.words = words;
  state.pageCount = pageCount;
  state.storageKey = createBookStorageKey(file);
  state.currentIndex = loadBookProgress(state.storageKey, words.length);

  bookTitle.textContent = file.name.replace(/\.pdf$/iu, "");
  document.title = `${bookTitle.textContent} · Lector focal`;
  progressControl.max = String(words.length - 1);

  updateBookMetadata();
  renderReader();
  setUploadStatus("");
  uploadView.hidden = true;
  readerView.hidden = false;
  playButton.focus();
}

function togglePlayback() {
  if (state.isPlaying) {
    pausePlayback();
    return;
  }

  if (state.words.length === 0) {
    return;
  }

  if (state.currentIndex >= state.words.length - 1) {
    state.currentIndex = 0;
    renderReader();
  }

  state.isPlaying = true;
  updatePlaybackButton();
  scheduleNextWord();
}

function scheduleNextWord() {
  const currentWord = state.words[state.currentIndex];
  const delay = getWordDelay(currentWord);

  state.timerId = window.setTimeout(() => {
    if (!state.isPlaying) {
      return;
    }

    if (state.currentIndex >= state.words.length - 1) {
      finishPlayback();
      return;
    }

    state.currentIndex += 1;
    renderReader();

    if (state.currentIndex % 10 === 0) {
      saveBookProgress();
    }

    scheduleNextWord();
  }, delay);
}

function getWordDelay(word) {
  const baseDelay = 60_000 / state.wordsPerMinute;

  if (/[.!?…][”’"'»\)\]]*$/u.test(word)) {
    return baseDelay * 2.2;
  }

  if (/[,;:][”’"'»\)\]]*$/u.test(word)) {
    return baseDelay * 1.45;
  }

  return baseDelay;
}

function pausePlayback() {
  if (!state.isPlaying) {
    return;
  }

  window.clearTimeout(state.timerId);
  state.timerId = null;
  state.isPlaying = false;
  updatePlaybackButton();
  saveBookProgress();
}

function stopPlayback() {
  window.clearTimeout(state.timerId);
  state.timerId = null;
  state.isPlaying = false;
}

function finishPlayback() {
  stopPlayback();
  renderReader();
  saveBookProgress();
}

function seekBy(offset) {
  if (state.words.length === 0) {
    return;
  }

  pausePlayback();
  state.currentIndex = clamp(
    state.currentIndex + offset,
    0,
    state.words.length - 1,
  );
  renderReader();
  saveBookProgress();
}

function renderReader() {
  const totalWords = state.words.length;

  if (totalWords === 0) {
    return;
  }

  const progress =
    totalWords === 1 ? 100 : (state.currentIndex / (totalWords - 1)) * 100;

  wordDisplay.textContent = state.words[state.currentIndex];
  positionLabel.textContent = `Palabra ${numberFormatter.format(state.currentIndex + 1)} de ${numberFormatter.format(totalWords)}`;
  progressPercent.textContent = `${Math.round(progress)} %`;
  progressControl.value = String(state.currentIndex);
  progressControl.style.setProperty("--progress", `${progress}%`);
  completionMessage.hidden = state.isPlaying || state.currentIndex < totalWords - 1;
  updatePlaybackButton();
}

function updatePlaybackButton() {
  if (state.isPlaying) {
    playButton.textContent = "Pausar";
    playButton.setAttribute("aria-label", "Pausar lectura");
    return;
  }

  if (state.words.length > 0 && state.currentIndex >= state.words.length - 1) {
    playButton.textContent = "Releer";
    playButton.setAttribute("aria-label", "Leer de nuevo desde el principio");
    return;
  }

  playButton.textContent = state.currentIndex > 0 ? "Continuar" : "Leer";
  playButton.setAttribute("aria-label", "Comenzar lectura");
}

function updateSpeedInterface() {
  const percentage = ((state.wordsPerMinute - MIN_SPEED) / (MAX_SPEED - MIN_SPEED)) * 100;
  speedOutput.value = `${state.wordsPerMinute} palabras/min`;
  speedControl.style.setProperty("--speed-progress", `${percentage}%`);
}

function updateBookMetadata() {
  if (state.words.length === 0) {
    return;
  }

  const pageLabel = state.pageCount === 1 ? "página" : "páginas";
  const estimatedMinutes = Math.max(1, Math.ceil(state.words.length / state.wordsPerMinute));

  bookMeta.textContent = `${numberFormatter.format(state.pageCount)} ${pageLabel} · ${numberFormatter.format(state.words.length)} palabras · ${estimatedMinutes} min aprox.`;
}

function handleKeyboardShortcut(event) {
  if (readerView.hidden) {
    return;
  }

  const target = event.target;
  const isRangeInput = target instanceof HTMLInputElement && target.type === "range";

  if (isRangeInput) {
    return;
  }

  if (event.code === "Space" && !(target instanceof HTMLButtonElement)) {
    event.preventDefault();
    togglePlayback();
  } else if (event.code === "ArrowLeft") {
    event.preventDefault();
    seekBy(-10);
  } else if (event.code === "ArrowRight") {
    event.preventDefault();
    seekBy(10);
  }
}

function setUploadStatus(message, status = "loading") {
  uploadStatus.textContent = message;

  if (message) {
    uploadStatus.dataset.state = status;
  } else {
    delete uploadStatus.dataset.state;
  }
}

function createBookStorageKey(file) {
  return `${BOOK_STORAGE_PREFIX}${file.name}:${file.size}:${file.lastModified}`;
}

function loadSavedSpeed() {
  try {
    const savedSpeed = Number(window.localStorage.getItem(SETTINGS_KEY));

    if (savedSpeed >= MIN_SPEED && savedSpeed <= MAX_SPEED) {
      return savedSpeed;
    }
  } catch (error) {
    console.warn("No se pudo recuperar la velocidad guardada:", error);
  }

  return DEFAULT_SPEED;
}

function saveSpeed() {
  try {
    window.localStorage.setItem(SETTINGS_KEY, String(state.wordsPerMinute));
  } catch (error) {
    console.warn("No se pudo guardar la velocidad:", error);
  }
}

function loadBookProgress(storageKey, totalWords) {
  try {
    const savedProgress = Number(window.localStorage.getItem(storageKey));

    if (Number.isInteger(savedProgress)) {
      return clamp(savedProgress, 0, totalWords - 1);
    }
  } catch (error) {
    console.warn("No se pudo recuperar el progreso guardado:", error);
  }

  return 0;
}

function saveBookProgress() {
  if (!state.storageKey || state.words.length === 0) {
    return;
  }

  try {
    window.localStorage.setItem(state.storageKey, String(state.currentIndex));
  } catch (error) {
    console.warn("No se pudo guardar el progreso:", error);
  }
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}
