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
const CATEGORIES_KEY = "lector-focal:categorias";
const DEFAULT_CATEGORIES = [
  { id: "blue", label: "Para recordar" },
  { id: "green", label: "Ideas clave" },
  { id: "yellow", label: "Importante" },
  { id: "pink", label: "Frases favoritas" },
  { id: "red", label: "No estoy de acuerdo" },
];
const DEFAULT_BOOKMARK_COLOR = "blue";
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
const openWordListButton = document.querySelector("#open-word-list");
const closeWordListButton = document.querySelector("#close-word-list");
const wordListPanel = document.querySelector("#word-list");
const wordListBackdrop = document.querySelector("#word-list-backdrop");
const wordListBody = document.querySelector("#word-list-body");
const wordListSearch = document.querySelector("#word-list-search");
const wordListStatus = document.querySelector("#word-list-status");
const wordListTitle = document.querySelector("#word-list-title");
const openBookmarksButton = document.querySelector("#open-bookmarks");
const closeBookmarksButton = document.querySelector("#close-bookmarks");
const bookmarksBackdrop = document.querySelector("#bookmarks-backdrop");
const bookmarksPanel = document.querySelector("#bookmarks-panel");
const bookmarksBody = document.querySelector("#bookmarks-body");
const bookmarksEmpty = document.querySelector("#bookmarks-empty");
const editCategoriesButton = document.querySelector("#edit-categories");
const bookmarkFab = document.querySelector("#bookmark-fab");
const colorPicker = document.querySelector("#color-picker");
const colorPickerSwatches = document.querySelector(".color-picker__swatches");
const colorPickerCancel = document.querySelector("#color-picker-cancel");
const categoryEditor = document.querySelector("#category-editor");
const categoryEditorForm = document.querySelector("#category-editor-form");
const categoryEditorCancel = document.querySelector("#category-editor-cancel");

const state = {
  words: [],
  currentIndex: 0,
  wordsPerMinute: loadSavedSpeed(),
  isPlaying: false,
  timerId: null,
  storageKey: null,
  pageCount: 0,
  chapters: [],
  wordListOpen: false,
  paragraphs: [],
  paragraphNodes: new Map(),
  paragraphObserver: null,
  hydrated: new Set(),
  currentWordElement: null,
  searchQuery: "",
  bookmarks: [],
  bookmarkPanelOpen: false,
  selectionRange: null,
  categories: loadCategories(),
  colorPickerCallback: null,
};

speedControl.value = String(state.wordsPerMinute);
updateSpeedInterface();

fileInput.addEventListener("change", handleFileSelection);
playButton.addEventListener("click", togglePlayback);
backButton.addEventListener("click", () => seekBy(-10));
forwardButton.addEventListener("click", () => seekBy(10));
changeBookButton.addEventListener("click", () => fileInput.click());

openWordListButton.addEventListener("click", openWordList);
closeWordListButton.addEventListener("click", closeWordList);
wordListBackdrop.addEventListener("click", closeWordList);
wordListSearch.addEventListener("input", handleWordListSearch);
wordListBody.addEventListener("click", handleWordListClick);

openBookmarksButton.addEventListener("click", openBookmarksPanel);
closeBookmarksButton.addEventListener("click", closeBookmarksPanel);
bookmarksBackdrop.addEventListener("click", closeBookmarksPanel);
bookmarksBody.addEventListener("click", handleBookmarksBodyClick);
editCategoriesButton.addEventListener("click", openCategoryEditor);
bookmarkFab.addEventListener("mousedown", (event) => {
  // Evita que el clic sobre el FAB colapse la selección de texto del usuario.
  event.preventDefault();
});
bookmarkFab.addEventListener("click", handleBookmarkFabClick);
colorPickerCancel.addEventListener("click", hideColorPicker);
colorPickerSwatches.addEventListener("click", handleColorPickerClick);
categoryEditorCancel.addEventListener("click", closeCategoryEditor);
categoryEditorForm.addEventListener("submit", handleCategoryEditorSubmit);
document.addEventListener("selectionchange", handleSelectionChange);

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
    const words = [];
    const paragraphs = [];
    const pageWordStarts = [];

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      setUploadStatus(`Extrayendo texto de la página ${pageNumber} de ${pdfDocument.numPages}…`);
      const page = await pdfDocument.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const pageContent = splitIntoParagraphs(extractPageText(textContent.items));

      pageWordStarts.push(words.length);
      appendPageContent(words, paragraphs, pageContent);
      page.cleanup();
    }

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
        paragraphs,
        chapters,
      });
    } catch (storageError) {
      console.warn("No se pudo guardar el libro localmente:", storageError);
    }

    openBook(file, words, pdfDocument.numPages, storageKey, chapters, paragraphs);
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
  let lineStartX = null;
  let maxLineEndX = 0;

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
        pageText += startsNewParagraph(previousItem, item, lineStartX, maxLineEndX)
          ? "\n\n"
          : "\n";
        lineStartX = item.transform?.[4] ?? null;
      } else if (hasWordGap(previousItem, item)) {
        pageText += " ";
      }
    } else {
      lineStartX = item.transform?.[4] ?? null;
    }

    pageText += item.str;
    previousItem = item;
    maxLineEndX = Math.max(maxLineEndX, lineEnd(item));
  }

  return pageText.trim();
}

function lineEnd(item) {
  const x = item.transform?.[4];
  return Number.isFinite(x) ? x + (item.width || 0) : 0;
}

// Un párrafo nuevo se reconoce por la sangría de su primera línea o porque la
// línea anterior terminó muy lejos del margen derecho. Los umbrales se calibran
// con la propia página (lineStartX / maxLineEndX), así que no dependen del
// tamaño de fuente ni de los márgenes concretos del PDF.
function startsNewParagraph(previousItem, currentItem, lineStartX, maxLineEndX) {
  const currentX = currentItem.transform?.[4];
  const textHeight = Math.max(previousItem.height || 0, currentItem.height || 0, 1);

  if (Number.isFinite(currentX) && Number.isFinite(lineStartX)) {
    if (currentX > lineStartX + textHeight * 0.6) {
      return true;
    }
  }

  const previousEnd = lineEnd(previousItem);

  if (maxLineEndX > 0 && previousEnd > 0) {
    return previousEnd < maxLineEndX - textHeight * 2;
  }

  return false;
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

// Une las palabras cortadas a final de línea ("pala-\nbra". Se limita a espacios
// y tabuladores alrededor del salto: con \s* se tragaría el segundo salto de un
// cambio de párrafo y pegaría el final de un párrafo con el principio del otro.
function dehyphenate(text) {
  return text.replace(/([\p{L}\p{N}])-[ \t]*\n[ \t]*([\p{L}\p{N}])/gu, "$1$2");
}

// Convierte el texto extraído en el array plano de palabras que usa toda la app
// (direccionado por índice global) más los límites de cada párrafo.
function splitIntoParagraphs(text) {
  const words = [];
  const paragraphs = [];

  for (const block of dehyphenate(text).split(/\n\s*\n\s*/u)) {
    const blockWords = block.replace(/\s+/gu, " ").trim().match(/\S+/gu) ?? [];

    if (blockWords.length === 0) {
      continue;
    }

    paragraphs.push({ start: words.length, length: blockWords.length });
    words.push(...blockWords);
  }

  return { words, paragraphs };
}

// Acumula el contenido de una página sobre el del libro. Si la página anterior
// quedó a media frase, su último párrafo continúa en el primero de esta página:
// se fusionan para que un párrafo partido por el salto de página se lea entero.
function appendPageContent(words, paragraphs, pageContent) {
  const offset = words.length;
  const lastWord = words.at(-1);
  const continuesParagraph =
    paragraphs.length > 0 &&
    pageContent.paragraphs.length > 0 &&
    typeof lastWord === "string" &&
    !/[.!?…:][”’"'»\)\]]*$/u.test(lastWord);

  pageContent.paragraphs.forEach((paragraph, index) => {
    if (index === 0 && continuesParagraph) {
      paragraphs.at(-1).length += paragraph.length;
      return;
    }

    paragraphs.push({ start: offset + paragraph.start, length: paragraph.length });
  });

  for (const word of pageContent.words) {
    words.push(word);
  }
}

function buildChapterIndex(outline, pdfDocument, pageWordStarts) {
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

function openBook(
  book,
  words,
  pageCount,
  storageKey = createBookStorageKey(book),
  chapters = [],
  paragraphs = null,
) {
  state.words = words;
  state.pageCount = pageCount;
  state.storageKey = storageKey;
  state.chapters = Array.isArray(chapters) ? chapters : [];
  state.paragraphs = normalizeParagraphs(paragraphs, words.length);
  state.bookmarks = normalizeBookmarks(book?.bookmarks);
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

const FALLBACK_PARAGRAPH_WORDS = 120;

// Los libros guardados antes de que se extrajeran los párrafos solo tienen el
// array plano de palabras. Para esos se trocea en bloques de tamaño fijo: no
// coincide con los párrafos del PDF, pero se lee de corrido y la carga
// progresiva sigue funcionando. Al volver a abrir el PDF se regenera bien.
function normalizeParagraphs(paragraphs, wordCount) {
  if (wordCount === 0) {
    return [];
  }

  const last = Array.isArray(paragraphs) ? paragraphs.at(-1) : null;
  const isUsable =
    last && last.start + last.length === wordCount && paragraphs[0].start === 0;

  if (isUsable) {
    return paragraphs;
  }

  const fallback = [];

  for (let start = 0; start < wordCount; start += FALLBACK_PARAGRAPH_WORDS) {
    fallback.push({
      start,
      length: Math.min(FALLBACK_PARAGRAPH_WORDS, wordCount - start),
    });
  }

  return fallback;
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
  if (state.wordListOpen) {
    updateWordListCurrent();
  }
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

function openWordList() {
  if (state.words.length === 0) {
    return;
  }

  state.wordListOpen = true;
  wordListPanel.hidden = false;
  wordListBackdrop.hidden = false;
  wordListPanel.setAttribute("aria-hidden", "false");
  wordListPanel.setAttribute("aria-modal", "true");
  document.body.classList.add("no-scroll");
  wordListTitle.textContent = bookTitle.textContent || "Palabras";
  wordListSearch.value = "";
  state.searchQuery = "";
  renderWordList();
  scrollWordListTo(state.currentIndex);
  // El foco va al texto, no al buscador: se abre para leer, y en el móvil
  // enfocar el buscador levantaría el teclado tapando media pantalla.
  wordListBody.focus();
}

function closeWordList() {
  if (!state.wordListOpen) {
    return;
  }

  state.wordListOpen = false;
  wordListPanel.hidden = true;
  wordListBackdrop.hidden = true;
  wordListPanel.setAttribute("aria-hidden", "true");
  wordListPanel.removeAttribute("aria-modal");
  document.body.classList.remove("no-scroll");
  wordListSearch.value = "";
  state.searchQuery = "";
  state.paragraphObserver?.disconnect();
  state.paragraphObserver = null;
  renderWordList();
  playButton.focus();
}

// El panel se monta entero, pero cada párrafo empieza como un simple nodo de
// texto: barato de crear y ya ocupa su altura real, así que el scroll es
// correcto desde el primer momento. Solo los párrafos cercanos a la vista se
// "hidratan" a palabras clicables (ver setupParagraphObserver).
function renderWordList() {
  if (!state.wordListOpen) {
    wordListBody.replaceChildren();
    state.paragraphNodes.clear();
    state.hydrated.clear();
    state.currentWordElement = null;
    wordListStatus.textContent = "";
    return;
  }

  const fragment = document.createDocumentFragment();

  state.paragraphNodes.clear();
  state.hydrated.clear();
  state.currentWordElement = null;

  for (const paragraph of state.paragraphs) {
    const paragraphElement = document.createElement("p");

    paragraphElement.className = "word-text__paragraph";
    paragraphElement.dataset.paragraphStart = String(paragraph.start);
    paragraphElement.textContent = flattenParagraph(paragraph);

    state.paragraphNodes.set(paragraph.start, paragraphElement);
    fragment.append(paragraphElement);
  }

  wordListBody.replaceChildren(fragment);
  setupParagraphObserver();
  updateWordListStatus();
  updateWordListCurrent();
}

function flattenParagraph(paragraph) {
  return state.words
    .slice(paragraph.start, paragraph.start + paragraph.length)
    .join(" ");
}

function updateWordListStatus() {
  const query = state.searchQuery;

  if (!query) {
    wordListStatus.textContent = `${numberFormatter.format(state.words.length)} palabras`;
    return;
  }

  // Una sola pasada sobre el texto completo en vez de recorrer las 70.000
  // palabras una a una, para que teclear en el buscador no bloquee la interfaz.
  const matches = state.words.join(" ").match(new RegExp(escapeRegExp(query), "giu"));
  const total = matches ? matches.length : 0;

  wordListStatus.textContent = total === 1
    ? "1 coincidencia"
    : `${numberFormatter.format(total)} coincidencias`;
}

function setupParagraphObserver() {
  state.paragraphObserver?.disconnect();

  state.paragraphObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const start = Number(entry.target.dataset.paragraphStart);

        if (entry.isIntersecting) {
          hydrateParagraph(start);
        } else {
          dehydrateParagraph(start);
        }
      }
    },
    { root: wordListBody, rootMargin: "1500px 0px" },
  );

  for (const paragraphElement of state.paragraphNodes.values()) {
    state.paragraphObserver.observe(paragraphElement);
  }
}

function hydrateParagraph(start) {
  const paragraphElement = state.paragraphNodes.get(start);
  const paragraph = state.paragraphs[findParagraphIndex(start)];

  if (!paragraphElement || !paragraph) {
    return null;
  }

  const queryChanged = paragraphElement.dataset.query !== state.searchQuery;
  const bookmarksChanged = paragraphElement.dataset.bookmarksHash !== bookmarkHash();

  if (state.hydrated.has(start) && !queryChanged && !bookmarksChanged) {
    return paragraphElement;
  }

  const fragment = document.createDocumentFragment();

  for (let offset = 0; offset < paragraph.length; offset += 1) {
    const globalIndex = paragraph.start + offset;
    const wrapper = document.createElement("span");

    wrapper.className = "word-text__word";
    wrapper.dataset.wordIndex = String(globalIndex);
    wrapper.setAttribute("role", "button");
    wrapper.tabIndex = 0;
    appendWordContent(wrapper, state.words[globalIndex]);

    if (globalIndex === state.currentIndex) {
      wrapper.classList.add("word-text__word--current");
      wrapper.setAttribute("aria-current", "true");
      state.currentWordElement = wrapper;
    }

    fragment.append(wrapper);
    fragment.append(document.createTextNode(" "));
  }

  paragraphElement.replaceChildren(fragment);
  paragraphElement.dataset.query = state.searchQuery;
  applyBookmarkHighlights(paragraphElement, paragraph);
  paragraphElement.dataset.bookmarksHash = bookmarkHash();
  state.hydrated.add(start);

  return paragraphElement;
}

function dehydrateParagraph(start) {
  const paragraph = state.paragraphs[findParagraphIndex(start)];

  if (!state.hydrated.has(start) || !paragraph) {
    return;
  }

  // El párrafo que se está leyendo se queda hidratado para no perder el
  // resaltado de la palabra actual mientras avanza la lectura.
  if (
    state.currentIndex >= paragraph.start &&
    state.currentIndex < paragraph.start + paragraph.length
  ) {
    return;
  }

  const paragraphElement = state.paragraphNodes.get(start);

  if (!paragraphElement) {
    return;
  }

  if (state.currentWordElement?.closest("p") === paragraphElement) {
    state.currentWordElement = null;
  }

  paragraphElement.textContent = flattenParagraph(paragraph);
  delete paragraphElement.dataset.query;
  state.hydrated.delete(start);
}

// Reparte la palabra en trozos resaltados y sin resaltar recorriendo una sola
// vez el texto original: mezclar el texto en minúsculas con el original era lo
// que descuadraba el resaltado.
function appendWordContent(wrapper, word) {
  const query = state.searchQuery;

  if (!query) {
    wrapper.textContent = word;
    return;
  }

  const pattern = new RegExp(escapeRegExp(query), "giu");
  let lastIndex = 0;

  for (const match of word.matchAll(pattern)) {
    if (match.index > lastIndex) {
      wrapper.append(word.slice(lastIndex, match.index));
    }

    const mark = document.createElement("mark");

    mark.className = "word-text__mark";
    mark.textContent = match[0];
    wrapper.append(mark);
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex === 0) {
    wrapper.textContent = word;
    return;
  }

  if (lastIndex < word.length) {
    wrapper.append(word.slice(lastIndex));
  }
}

function handleWordListSearch() {
  const query = wordListSearch.value.trim();

  if (query === state.searchQuery) {
    return;
  }

  state.searchQuery = query;
  updateWordListStatus();

  // Solo hay que repintar lo que se está viendo; el resto se repinta al
  // hidratarse, porque hydrateParagraph compara contra data-query.
  for (const start of [...state.hydrated]) {
    hydrateParagraph(start);
  }
}

// Búsqueda binaria del párrafo que contiene una palabra concreta.
function findParagraphIndex(wordIndex) {
  let low = 0;
  let high = state.paragraphs.length - 1;

  while (low <= high) {
    const middle = (low + high) >> 1;
    const paragraph = state.paragraphs[middle];

    if (wordIndex < paragraph.start) {
      high = middle - 1;
    } else if (wordIndex >= paragraph.start + paragraph.length) {
      low = middle + 1;
    } else {
      return middle;
    }
  }

  return -1;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function handleWordListClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const word = target.closest("[data-word-index]");
  if (!word) {
    return;
  }
  const wordIndex = Number(word.dataset.wordIndex);
  if (!Number.isInteger(wordIndex)) {
    return;
  }
  jumpToChapter(wordIndex);
  closeWordList();
}

function scrollWordListTo(wordIndex) {
  if (!state.wordListOpen) {
    return;
  }

  const paragraphIndex = findParagraphIndex(wordIndex);

  if (paragraphIndex === -1) {
    return;
  }

  const paragraph = state.paragraphs[paragraphIndex];
  const paragraphElement = hydrateParagraph(paragraph.start);
  const element =
    paragraphElement?.querySelector(`[data-word-index="${wordIndex}"]`) ??
    state.paragraphNodes.get(paragraph.start);

  element?.scrollIntoView({ block: "center", behavior: "auto" });
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

function updateWordListCurrent() {
  if (!state.wordListOpen) {
    return;
  }

  if (state.currentWordElement) {
    state.currentWordElement.classList.remove("word-text__word--current");
    state.currentWordElement.removeAttribute("aria-current");
    state.currentWordElement = null;
  }

  const paragraphIndex = findParagraphIndex(state.currentIndex);

  if (paragraphIndex === -1) {
    return;
  }

  const paragraphElement = hydrateParagraph(state.paragraphs[paragraphIndex].start);
  const current = paragraphElement?.querySelector(
    `[data-word-index="${state.currentIndex}"]`,
  );

  if (current) {
    current.classList.add("word-text__word--current");
    current.setAttribute("aria-current", "true");
    state.currentWordElement = current;
  }
}

function handleKeyboardShortcut(event) {
  if (readerView.hidden) {
    return;
  }

  const target = event.target;
  const isRangeInput = target instanceof HTMLInputElement && target.type === "range";
  const isTextInput = target instanceof HTMLInputElement && (target.type === "text" || target.type === "search");

  if (isRangeInput || isTextInput) {
    return;
  }

  if (event.code === "Space" && !(target instanceof HTMLButtonElement)) {
    event.preventDefault();
    togglePlayback();
  } else if (event.code === "Escape") {
    if (state.bookmarkPanelOpen) {
      event.preventDefault();
      closeBookmarksPanel();
    } else if (state.wordListOpen) {
      event.preventDefault();
      closeWordList();
    } else if (!colorPicker.hidden) {
      event.preventDefault();
      hideColorPicker();
    } else if (!categoryEditor.hidden) {
      event.preventDefault();
      closeCategoryEditor();
    }
  } else if (event.code === "ArrowLeft") {
    event.preventDefault();
    seekBy(-10);
  } else if (event.code === "ArrowRight") {
    event.preventDefault();
    seekBy(10);
  } else if (event.code === "KeyB" && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    addQuickBookmark();
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

    openBook(
      record,
      record.words,
      pageCount,
      storageKey,
      record.chapters ?? [],
      record.paragraphs ?? null,
    );
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

// ---------- Marcadores ----------

function loadCategories() {
  try {
    const raw = window.localStorage.getItem(CATEGORIES_KEY);
    if (!raw) return DEFAULT_CATEGORIES.map((c) => ({ ...c }));

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return DEFAULT_CATEGORIES.map((c) => ({ ...c }));
    }

    return DEFAULT_CATEGORIES.map((def) => {
      const found = parsed.find((c) => c && c.id === def.id);
      return {
        id: def.id,
        label: found && typeof found.label === "string" && found.label.trim()
          ? found.label.trim()
          : def.label,
      };
    });
  } catch (error) {
    console.warn("No se pudieron cargar las categorías:", error);
    return DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  }
}

function persistCategories() {
  try {
    window.localStorage.setItem(CATEGORIES_KEY, JSON.stringify(state.categories));
  } catch (error) {
    console.warn("No se pudieron guardar las categorías:", error);
  }
}

function normalizeBookmarks(raw) {
  if (!Array.isArray(raw) || state.words.length === 0) {
    return [];
  }

  const validIds = new Set(state.categories.map((c) => c.id));
  const max = state.words.length - 1;

  return raw
    .filter((b) => b && Number.isInteger(b.startIndex) && Number.isInteger(b.endIndex))
    .map((b) => {
      const start = clamp(Math.min(b.startIndex, b.endIndex), 0, max);
      const end = clamp(Math.max(b.startIndex, b.endIndex), 0, max);
      return {
        id: typeof b.id === "string" && b.id ? b.id : crypto.randomUUID(),
        startIndex: start,
        endIndex: end,
        color: validIds.has(b.color) ? b.color : DEFAULT_BOOKMARK_COLOR,
        createdAt: typeof b.createdAt === "number" ? b.createdAt : Date.now(),
      };
    })
    .sort((a, b) => a.startIndex - b.startIndex);
}

async function persistBookmarks() {
  if (!state.storageKey) return;

  try {
    const database = await openBookDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(BOOK_STORE_NAME, "readwrite");
      const store = transaction.objectStore(BOOK_STORE_NAME);
      const request = store.get(state.storageKey);

      request.onsuccess = () => {
        const record = request.result;
        if (!record) {
          resolve();
          return;
        }
        record.bookmarks = state.bookmarks;
        const updateRequest = store.put(record);
        updateRequest.onsuccess = () => resolve();
        updateRequest.onerror = () => reject(updateRequest.error);
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.warn("No se pudieron guardar los marcadores:", error);
  }
}

function bookmarkHash() {
  if (state.bookmarks.length === 0) return "";
  return state.bookmarks
    .map((b) => `${b.id}:${b.color}:${b.startIndex}-${b.endIndex}`)
    .join("|");
}

function invalidateBookmarkCaches() {
  for (const paragraphElement of state.paragraphNodes.values()) {
    delete paragraphElement.dataset.bookmarksHash;
  }
}

function rehydrateVisibleParagraphs() {
  // Forzar rehidratación para que los cambios en marcadores se reflejen en pantalla.
  if (!state.wordListOpen) return;
  renderWordList();
}

function addBookmark(startIndex, endIndex, color) {
  if (state.words.length === 0) return null;

  const validColor = state.categories.some((c) => c.id === color)
    ? color
    : DEFAULT_BOOKMARK_COLOR;
  const max = state.words.length - 1;

  const bookmark = {
    id: crypto.randomUUID(),
    startIndex: clamp(Math.min(startIndex, endIndex), 0, max),
    endIndex: clamp(Math.max(startIndex, endIndex), 0, max),
    color: validColor,
    createdAt: Date.now(),
  };

  state.bookmarks.push(bookmark);
  state.bookmarks.sort((a, b) => a.startIndex - b.startIndex);
  invalidateBookmarkCaches();
  void persistBookmarks();

  if (state.bookmarkPanelOpen) {
    renderBookmarksPanel();
  }
  rehydrateVisibleParagraphs();

  return bookmark;
}

function removeBookmark(id) {
  const before = state.bookmarks.length;
  state.bookmarks = state.bookmarks.filter((b) => b.id !== id);
  if (state.bookmarks.length === before) return;

  invalidateBookmarkCaches();
  void persistBookmarks();

  if (state.bookmarkPanelOpen) {
    renderBookmarksPanel();
  }
  rehydrateVisibleParagraphs();
}

function changeBookmarkColor(id, color) {
  const bookmark = state.bookmarks.find((b) => b.id === id);
  if (!bookmark) return;
  if (!state.categories.some((c) => c.id === color)) return;
  if (bookmark.color === color) return;

  bookmark.color = color;
  invalidateBookmarkCaches();
  void persistBookmarks();

  if (state.bookmarkPanelOpen) {
    renderBookmarksPanel();
  }
  rehydrateVisibleParagraphs();
}

function addQuickBookmark() {
  if (state.words.length === 0) return;
  pausePlayback();
  addBookmark(state.currentIndex, state.currentIndex, DEFAULT_BOOKMARK_COLOR);
}

// ---------- Selección nativa y botón flotante ----------

let selectionChangePending = false;

function handleSelectionChange() {
  if (selectionChangePending) return;
  selectionChangePending = true;
  window.requestAnimationFrame(() => {
    selectionChangePending = false;
    updateFloatingActionButton();
  });
}

function getWordIndexFromNode(node) {
  if (!node) return null;
  let element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  while (element && element !== wordListBody) {
    if (element instanceof HTMLElement && element.dataset.wordIndex !== undefined) {
      const idx = Number(element.dataset.wordIndex);
      if (Number.isInteger(idx)) return idx;
    }
    element = element?.parentElement ?? null;
  }
  return null;
}

function findBookmarkRange(selection) {
  const anchorIndex = getWordIndexFromNode(selection.anchorNode);
  const focusIndex = getWordIndexFromNode(selection.focusNode);
  if (anchorIndex === null && focusIndex === null) return null;
  const a = anchorIndex ?? focusIndex;
  const b = focusIndex ?? anchorIndex;
  return { startIndex: Math.min(a, b), endIndex: Math.max(a, b) };
}

function updateFloatingActionButton() {
  if (!state.wordListOpen) {
    hideFloatingActionButton();
    return;
  }

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    hideFloatingActionButton();
    return;
  }

  const range = selection.getRangeAt(0);
  if (
    !wordListBody.contains(range.commonAncestorContainer) &&
    !wordListBody.contains(range.startContainer) &&
    !wordListBody.contains(range.endContainer)
  ) {
    hideFloatingActionButton();
    return;
  }

  const bookmarkRange = findBookmarkRange(selection);
  if (!bookmarkRange) {
    hideFloatingActionButton();
    return;
  }

  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    hideFloatingActionButton();
    return;
  }

  state.selectionRange = bookmarkRange;
  showFloatingActionButton(rect);
}

function showFloatingActionButton(rect) {
  bookmarkFab.hidden = false;
  bookmarkFab.style.visibility = "hidden";
  // Medir una vez pintado para evitar solapar el cálculo
  window.requestAnimationFrame(() => {
    const fabRect = bookmarkFab.getBoundingClientRect();
    let top = rect.top - fabRect.height - 14;
    let placeAbove = true;
    if (top < 8) {
      top = rect.bottom + 14;
      placeAbove = false;
    }
    const left = clamp(
      rect.left + rect.width / 2,
      fabRect.width / 2 + 12,
      window.innerWidth - fabRect.width / 2 - 12,
    );
    bookmarkFab.style.top = `${top}px`;
    bookmarkFab.style.left = `${left}px`;
    bookmarkFab.dataset.place = placeAbove ? "above" : "below";
    bookmarkFab.style.visibility = "visible";
  });
}

function hideFloatingActionButton() {
  bookmarkFab.hidden = true;
  state.selectionRange = null;
}

function handleBookmarkFabClick() {
  if (!state.selectionRange) return;
  const capturedRange = state.selectionRange;
  showColorPicker({
    anchorEl: bookmarkFab,
    currentColor: DEFAULT_BOOKMARK_COLOR,
    onSelect: (color) => {
      addBookmark(capturedRange.startIndex, capturedRange.endIndex, color);
      window.getSelection()?.removeAllRanges();
      hideFloatingActionButton();
    },
    onCancel: () => {
      hideFloatingActionButton();
    },
  });
}

// ---------- Color picker ----------

function showColorPicker({ anchorEl, onSelect, currentColor, onCancel }) {
  state.colorPickerCallback = { onSelect, onCancel };
  colorPickerSwatches.replaceChildren();
  for (const category of state.categories) {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = `color-picker__swatch color-picker__swatch--${category.id}`;
    swatch.dataset.color = category.id;
    swatch.dataset.label = category.label;
    swatch.setAttribute("aria-label", category.label);
    swatch.title = category.label;
    if (category.id === currentColor) {
      swatch.classList.add("color-picker__swatch--selected");
    }
    colorPickerSwatches.append(swatch);
  }

  colorPicker.hidden = false;
  colorPicker.style.visibility = "hidden";
  window.requestAnimationFrame(() => {
    positionColorPicker(anchorEl);
    colorPicker.style.visibility = "visible";
  });
}

function hideColorPicker() {
  colorPicker.hidden = true;
  const callback = state.colorPickerCallback;
  state.colorPickerCallback = null;
  if (callback && callback.onCancel) callback.onCancel();
}

function positionColorPicker(anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  const pickerRect = colorPicker.getBoundingClientRect();
  const margin = 8;

  let top = rect.bottom + margin;
  if (top + pickerRect.height > window.innerHeight - margin) {
    top = rect.top - pickerRect.height - margin;
  }
  top = Math.max(margin, top);

  let left = rect.left + rect.width / 2;
  left = clamp(left, pickerRect.width / 2 + margin, window.innerWidth - pickerRect.width / 2 - margin);

  colorPicker.style.top = `${top}px`;
  colorPicker.style.left = `${left}px`;
}

function handleColorPickerClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const swatch = target.closest(".color-picker__swatch");
  if (!swatch) return;
  const color = swatch.dataset.color;
  const callback = state.colorPickerCallback;
  colorPicker.hidden = true;
  state.colorPickerCallback = null;
  if (callback && callback.onSelect && color) callback.onSelect(color);
}

// ---------- Resaltado de palabras marcadas ----------

function applyBookmarkHighlights(paragraphElement, paragraph) {
  if (state.bookmarks.length === 0) return;

  const wordSpans = Array.from(paragraphElement.querySelectorAll(":scope > [data-word-index]"));
  if (wordSpans.length === 0) return;

  // Mapa: span → color del bookmark que la cubre. Si una palabra cae en varios
  // marcadores solapados, gana el último creado (consistente con addBookmark).
  const colorBySpan = new Map();
  for (const bookmark of state.bookmarks) {
    if (bookmark.endIndex < paragraph.start) continue;
    if (bookmark.startIndex >= paragraph.start + paragraph.length) continue;
    for (const span of wordSpans) {
      const idx = Number(span.dataset.wordIndex);
      if (idx >= bookmark.startIndex && idx <= bookmark.endIndex) {
        colorBySpan.set(span, bookmark.color);
      }
    }
  }

  // Recorre los hijos del párrafo en orden y agrupa runs consecutivos del mismo
  // color. Las palabras se intercalan con nodos de texto (espacios); los
  // espacios entre dos palabras del MISMO color se incluyen en el run para que
  // el fondo no se vea cortado.
  const children = Array.from(paragraphElement.childNodes);
  const segments = [];
  let currentRun = null;

  const flushRun = () => {
    if (currentRun) {
      segments.push({ kind: "run", color: currentRun.color, nodes: currentRun.nodes });
      currentRun = null;
    }
  };

  for (let i = 0; i < children.length; i += 1) {
    const node = children[i];
    const isWordSpan =
      node instanceof HTMLElement && node.dataset.wordIndex !== undefined;
    const color = isWordSpan ? colorBySpan.get(node) || null : null;

    if (color) {
      if (currentRun && currentRun.color === color) {
        currentRun.nodes.push(node);
      } else {
        flushRun();
        currentRun = { color, nodes: [node] };
      }
      continue;
    }

    if (
      currentRun &&
      node.nodeType === Node.TEXT_NODE &&
      /^\s+$/u.test(node.textContent || "")
    ) {
      const next = children[i + 1];
      const nextIsSameColor =
        next instanceof HTMLElement &&
        next.dataset.wordIndex !== undefined &&
        colorBySpan.get(next) === currentRun.color;
      if (nextIsSameColor) {
        currentRun.nodes.push(node);
        continue;
      }
    }

    flushRun();
    segments.push({ kind: "plain", node });
  }
  flushRun();

  // Si no se generó ningún run, no tocamos el DOM.
  if (segments.every((segment) => segment.kind === "plain")) return;

  const fragment = document.createDocumentFragment();
  for (const segment of segments) {
    if (segment.kind === "plain") {
      fragment.append(segment.node);
    } else {
      const mark = document.createElement("mark");
      mark.className = `word-text__mark word-text__mark--bookmark word-text__mark--${segment.color}`;
      for (const inner of segment.nodes) {
        mark.append(inner);
      }
      fragment.append(mark);
    }
  }
  paragraphElement.replaceChildren(fragment);
}

// ---------- Panel "Marcadores" ----------

function openBookmarksPanel() {
  if (state.words.length === 0) return;
  // Asegurar que el panel de texto queda cerrado para no apilar dos paneles a la vez
  if (state.wordListOpen) closeWordList();

  state.bookmarkPanelOpen = true;
  bookmarksPanel.hidden = false;
  bookmarksBackdrop.hidden = false;
  bookmarksPanel.setAttribute("aria-hidden", "false");
  bookmarksPanel.setAttribute("aria-modal", "true");
  document.body.classList.add("no-scroll");
  renderBookmarksPanel();
  bookmarksBody.focus();
}

function closeBookmarksPanel() {
  if (!state.bookmarkPanelOpen) return;

  state.bookmarkPanelOpen = false;
  bookmarksPanel.hidden = true;
  bookmarksBackdrop.hidden = true;
  bookmarksPanel.setAttribute("aria-hidden", "true");
  bookmarksPanel.removeAttribute("aria-modal");
  document.body.classList.remove("no-scroll");
  if (!playButton.hidden) playButton.focus();
}

function renderBookmarksPanel() {
  if (state.bookmarks.length === 0) {
    bookmarksEmpty.hidden = false;
    bookmarksBody.replaceChildren();
    return;
  }
  bookmarksEmpty.hidden = true;

  const fragment = document.createDocumentFragment();
  const grouped = new Map();

  for (const bookmark of state.bookmarks) {
    const category = state.categories.find((c) => c.id === bookmark.color) || {
      id: bookmark.color,
      label: bookmark.color,
    };
    if (!grouped.has(category.id)) grouped.set(category.id, { category, items: [] });
    grouped.get(category.id).items.push(bookmark);
  }

  // Orden de colores: el orden natural de DEFAULT_CATEGORIES
  const order = DEFAULT_CATEGORIES.map((c) => c.id);
  const orderedGroups = Array.from(grouped.values()).sort((a, b) => {
    return order.indexOf(a.category.id) - order.indexOf(b.category.id);
  });

  for (const group of orderedGroups) {
    const groupElement = document.createElement("section");
    groupElement.className = "bookmarks-group";
    groupElement.dataset.color = group.category.id;

    const title = document.createElement("h3");
    title.className = "bookmarks-group__title";

    const chip = document.createElement("span");
    chip.className = `bookmarks-group__chip bookmark-item__chip--${group.category.id}`;
    title.append(chip);

    const label = document.createElement("span");
    label.textContent = group.category.label;
    title.append(label);

    const count = document.createElement("span");
    count.className = "bookmarks-group__count";
    count.textContent = group.items.length === 1
      ? "1 marcador"
      : `${group.items.length} marcadores`;
    title.append(count);

    groupElement.append(title);

    const list = document.createElement("ul");
    list.className = "bookmarks-list";
    for (const bookmark of group.items) {
      list.append(createBookmarkItem(bookmark));
    }
    groupElement.append(list);
    fragment.append(groupElement);
  }

  bookmarksBody.replaceChildren(fragment);
}

function createBookmarkItem(bookmark) {
  const item = document.createElement("li");
  item.className = "bookmark-item";
  item.dataset.bookmarkId = bookmark.id;

  const colorChip = document.createElement("button");
  colorChip.type = "button";
  colorChip.className = `bookmark-item__chip bookmark-item__chip--${bookmark.color}`;
  colorChip.dataset.action = "change-color";
  colorChip.setAttribute("aria-label", "Cambiar color del marcador");
  colorChip.title = "Cambiar color";
  item.append(colorChip);

  const body = document.createElement("div");
  body.className = "bookmark-item__body";
  body.dataset.action = "jump";

  const text = document.createElement("p");
  text.className = "bookmark-item__text";
  text.textContent = bookmarkText(bookmark);
  body.append(text);

  const meta = document.createElement("span");
  meta.className = "bookmark-item__meta";
  const position = bookmark.startIndex + 1;
  meta.textContent = `Palabra ${numberFormatter.format(position)}`;
  body.append(meta);

  item.append(body);

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "bookmark-item__delete";
  deleteButton.dataset.action = "delete";
  deleteButton.setAttribute("aria-label", "Eliminar marcador");
  deleteButton.title = "Eliminar";
  deleteButton.textContent = "×";
  item.append(deleteButton);

  return item;
}

function bookmarkText(bookmark) {
  const slice = state.words.slice(bookmark.startIndex, bookmark.endIndex + 1);
  const text = slice.join(" ");
  return text.length > 240 ? `${text.slice(0, 237)}…` : text;
}

function handleBookmarksBodyClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const item = target.closest(".bookmark-item");
  if (!item) return;
  const id = item.dataset.bookmarkId;
  const bookmark = state.bookmarks.find((b) => b.id === id);
  if (!bookmark) return;

  if (target.closest('[data-action="delete"]')) {
    const confirmed = window.confirm("¿Eliminar este marcador?");
    if (confirmed) removeBookmark(id);
    return;
  }

  if (target.closest('[data-action="change-color"]')) {
    const swatch = colorPickerSwatches;
    const wasOpen = !colorPicker.hidden;
    if (wasOpen) hideColorPicker();
    showColorPicker({
      anchorEl: target,
      currentColor: bookmark.color,
      onSelect: (color) => changeBookmarkColor(id, color),
      onCancel: () => {},
    });
    return;
  }

  if (target.closest('[data-action="jump"]')) {
    jumpToBookmark(bookmark);
  }
}

function jumpToBookmark(bookmark) {
  closeBookmarksPanel();
  openWordList();
  // El panel ya está abierto: saltamos a la palabra del marcador.
  state.currentIndex = clamp(bookmark.startIndex, 0, state.words.length - 1);
  renderReader();
  saveBookProgress();
  scrollWordListTo(state.currentIndex);
}

// ---------- Editor de categorías ----------

function openCategoryEditor() {
  categoryEditor.hidden = false;
  categoryEditorForm.replaceChildren();
  for (const category of state.categories) {
    const row = document.createElement("div");
    row.className = "category-editor__row";

    const chip = document.createElement("span");
    chip.className = `category-editor__row__chip category-editor__row__chip--${category.id}`;
    chip.setAttribute("aria-hidden", "true");
    row.append(chip);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "category-editor__row__input";
    input.value = category.label;
    input.maxLength = 40;
    input.dataset.categoryId = category.id;
    input.setAttribute("aria-label", `Etiqueta para ${category.id}`);
    row.append(input);

    categoryEditorForm.append(row);
  }
  const firstInput = categoryEditorForm.querySelector("input");
  if (firstInput) firstInput.focus();
}

function closeCategoryEditor() {
  categoryEditor.hidden = true;
}

function handleCategoryEditorSubmit(event) {
  event.preventDefault();
  const inputs = categoryEditorForm.querySelectorAll("input[data-category-id]");
  const updated = DEFAULT_CATEGORIES.map((def) => ({ ...def }));

  for (const input of inputs) {
    const id = input.dataset.categoryId;
    const value = input.value.trim();
    const target = updated.find((c) => c.id === id);
    if (target) {
      target.label = value || DEFAULT_CATEGORIES.find((d) => d.id === id).label;
    }
  }

  state.categories = updated;
  persistCategories();

  if (state.bookmarkPanelOpen) {
    renderBookmarksPanel();
  }
  closeCategoryEditor();
}
