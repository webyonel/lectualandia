import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

const DEFAULT_SPEED = 300;
const MIN_SPEED = 100;
const MAX_SPEED = 800;
const CONTEXT_WORD_COUNT = 6;
const SETTINGS_KEY = "lector-focal:velocidad";
const BOOK_STORAGE_PREFIX = "lector-focal:libro:";
const DATABASE_NAME = "lector-focal";
const DATABASE_VERSION = 1;
const BOOK_STORE_NAME = "books";
const LAST_BOOK_KEY = "lector-focal:ultimo-libro";
const numberFormatter = new Intl.NumberFormat("es-ES");

let databasePromise;

const uploadView = document.querySelector("#upload-view");
const readerView = document.querySelector("#reader-view");
const fileInput = document.querySelector("#pdf-input");
const uploadStatus = document.querySelector("#upload-status");
const bookTitle = document.querySelector("#book-title");
const bookMeta = document.querySelector("#book-meta");
const wordDisplay = document.querySelector("#word-display");
const previousContext = document.querySelector("#previous-context");
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
const tableOfContents = document.querySelector("#table-of-contents");
const tableOfContentsList = document.querySelector("#table-of-contents-list");

const state = {
  words: [],
  currentIndex: 0,
  wordsPerMinute: loadSavedSpeed(),
  isPlaying: false,
  timerId: null,
  storageKey: null,
  pageCount: 0,
  chapters: [],
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
void restoreLastBook();

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
    const pageWordStarts = [];
    let extractedWordCount = 0;

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      setUploadStatus(`Extrayendo texto de la página ${pageNumber} de ${pdfDocument.numPages}…`);
      const page = await pdfDocument.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const pageText = extractPageText(textContent.items);
      const pageWords = normalizeText(pageText).match(/\S+/gu) ?? [];

      pageWordStarts.push(extractedWordCount);
      extractedWordCount += pageWords.length;
      pageTexts.push(pageText);
      page.cleanup();
    }

    const normalizedText = normalizeText(pageTexts.join("\n"));
    const words = normalizedText.match(/\S+/gu) ?? [];

    if (words.length === 0) {
      throw new Error("NO_EXTRACTABLE_TEXT");
    }

    let chapters = [];

    try {
      const outline = await pdfDocument.getOutline();
      chapters = await buildChapterIndex(outline ?? [], pdfDocument, pageWordStarts);
    } catch (outlineError) {
      console.warn("No se pudo leer el índice del PDF:", outlineError);
    }

    const storageKey = createBookStorageKey(file);

    try {
      await saveBookRecord({
        id: storageKey,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        pageCount: pdfDocument.numPages,
        words,
        chapters,
      });
    } catch (storageError) {
      console.warn("No se pudo guardar el libro localmente:", storageError);
    }

    openBook(file, words, pdfDocument.numPages, storageKey, chapters);
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

async function buildChapterIndex(outline, pdfDocument, pageWordStarts) {
  return Promise.all(
    outline.map(async (item) => {
      const title = typeof item.title === "string"
        ? item.title.replace(/\s+/gu, " ").trim()
        : "";
      const [wordIndex, children] = await Promise.all([
        resolveChapterWordIndex(item.dest, pdfDocument, pageWordStarts),
        buildChapterIndex(item.items ?? [], pdfDocument, pageWordStarts),
      ]);

      return {
        title: title || "Sección sin título",
        wordIndex,
        children,
      };
    }),
  );
}

async function resolveChapterWordIndex(destination, pdfDocument, pageWordStarts) {
  if (!destination) {
    return null;
  }

  try {
    const resolvedDestination = typeof destination === "string"
      ? await pdfDocument.getDestination(destination)
      : destination;
    const pageReference = resolvedDestination?.[0];

    if (pageReference === undefined || pageReference === null) {
      return null;
    }

    const pageIndex = Number.isInteger(pageReference)
      ? pageReference
      : await pdfDocument.getPageIndex(pageReference);

    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageWordStarts.length) {
      return null;
    }

    return pageWordStarts[pageIndex];
  } catch {
    return null;
  }
}

function openBook(book, words, pageCount, storageKey = createBookStorageKey(book), chapters = []) {
  state.words = words;
  state.pageCount = pageCount;
  state.storageKey = storageKey;
  state.chapters = Array.isArray(chapters) ? chapters : [];
  state.currentIndex = loadBookProgress(state.storageKey, words.length);

  bookTitle.textContent = book.name.replace(/\.pdf$/iu, "");
  document.title = `${bookTitle.textContent} · Lector focal`;
  progressControl.max = String(words.length - 1);

  updateBookMetadata();
  renderTableOfContents();
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
  renderPreviousContext();
  positionLabel.textContent = `Palabra ${numberFormatter.format(state.currentIndex + 1)} de ${numberFormatter.format(totalWords)}`;
  progressPercent.textContent = `${Math.round(progress)} %`;
  progressControl.value = String(state.currentIndex);
  progressControl.style.setProperty("--progress", `${progress}%`);
  completionMessage.hidden = state.isPlaying || state.currentIndex < totalWords - 1;
  updatePlaybackButton();
}

function renderPreviousContext() {
  const contextStart = Math.max(0, state.currentIndex - CONTEXT_WORD_COUNT);
  const contextWords = state.words.slice(contextStart, state.currentIndex);

  previousContext.textContent = contextWords.join(" ");
  previousContext.hidden = contextWords.length === 0;
}

function renderTableOfContents() {
  tableOfContents.open = false;
  tableOfContentsList.replaceChildren();

  if (state.chapters.length === 0) {
    tableOfContents.hidden = true;
    return;
  }

  tableOfContentsList.append(createChapterList(state.chapters));
  tableOfContents.hidden = false;
}

function createChapterList(chapters) {
  const list = document.createElement("ul");
  list.className = "toc-list";

  for (const chapter of chapters) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    const hasDestination = Number.isInteger(chapter.wordIndex);

    item.className = "toc-item";
    button.className = "toc-button";
    button.type = "button";
    button.textContent = chapter.title;
    button.disabled = !hasDestination;

    if (hasDestination) {
      button.addEventListener("click", () => jumpToChapter(chapter.wordIndex));
    }

    item.append(button);

    if (Array.isArray(chapter.children) && chapter.children.length > 0) {
      item.append(createChapterList(chapter.children));
    }

    list.append(item);
  }

  return list;
}

function jumpToChapter(wordIndex) {
  pausePlayback();
  state.currentIndex = clamp(wordIndex, 0, state.words.length - 1);
  renderReader();
  saveBookProgress();
  tableOfContents.open = false;
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

async function restoreLastBook() {
  const storageKey = readLastBookId();

  if (!storageKey) {
    return;
  }

  uploadView.setAttribute("aria-busy", "true");
  fileInput.disabled = true;
  setUploadStatus("Restaurando tu último libro…");

  try {
    const record = await getBookRecord(storageKey);

    if (!record || !Array.isArray(record.words) || record.words.length === 0) {
      throw new Error("BOOK_NOT_FOUND");
    }

    const pageCount = Number.isInteger(record.pageCount) && record.pageCount > 0
      ? record.pageCount
      : 1;

    openBook(record, record.words, pageCount, storageKey, record.chapters ?? []);
  } catch (error) {
    console.warn("No se pudo restaurar el último libro:", error);
    clearLastBookId();
    setUploadStatus("No se pudo restaurar el libro. Selecciona el PDF de nuevo.", "error");
  } finally {
    uploadView.removeAttribute("aria-busy");
    fileInput.disabled = false;
    fileInput.value = "";
  }
}

function openBookDatabase() {
  if (databasePromise) {
    return databasePromise;
  }

  if (!("indexedDB" in window)) {
    return Promise.reject(new Error("INDEXED_DB_UNAVAILABLE"));
  }

  databasePromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(BOOK_STORE_NAME)) {
        database.createObjectStore(BOOK_STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return databasePromise;
}

async function saveBookRecord(record) {
  const database = await openBookDatabase();
  const previousBookId = readLastBookId();

  await new Promise((resolve, reject) => {
    const transaction = database.transaction(BOOK_STORE_NAME, "readwrite");
    const store = transaction.objectStore(BOOK_STORE_NAME);

    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);

    store.put(record);

    if (previousBookId && previousBookId !== record.id) {
      store.delete(previousBookId);
    }
  });

  try {
    window.localStorage.setItem(LAST_BOOK_KEY, record.id);

    if (previousBookId && previousBookId !== record.id) {
      window.localStorage.removeItem(previousBookId);
    }
  } catch (error) {
    console.warn("No se pudo marcar el último libro local:", error);
  }
}

function getBookRecord(storageKey) {
  return openBookDatabase().then(
    (database) =>
      new Promise((resolve, reject) => {
        const transaction = database.transaction(BOOK_STORE_NAME, "readonly");
        const request = transaction.objectStore(BOOK_STORE_NAME).get(storageKey);

        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      }),
  );
}

function readLastBookId() {
  try {
    return window.localStorage.getItem(LAST_BOOK_KEY);
  } catch (error) {
    console.warn("No se pudo leer el último libro local:", error);
    return null;
  }
}

function clearLastBookId() {
  try {
    window.localStorage.removeItem(LAST_BOOK_KEY);
  } catch (error) {
    console.warn("No se pudo borrar la referencia al libro local:", error);
  }
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
