'use strict';

/* ---------------------------------------------------------------
   TagInfo — app 100% offline-first. Todo vive en IndexedDB.
   Store "tags": keyPath "tag" (código normalizado en mayúsculas).
   Store "documents": keyPath autoIncrement "id", index "tag".
   Store "projectDocuments": texto y metadatos extraídos.
   Store "projectFiles": archivos originales, separados para que una
   búsqueda no tenga que cargar todos los binarios en memoria.
   Los archivos se guardan como ArrayBuffer (no Blob) por
   compatibilidad con versiones antiguas de Safari/iOS que no
   soportaban clonar Blobs dentro de IndexedDB.
------------------------------------------------------------------ */

const DB_NAME = 'taginfo-db';
const DB_VERSION = 2;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tags')) {
        db.createObjectStore('tags', { keyPath: 'tag' });
      }
      if (!db.objectStoreNames.contains('documents')) {
        const docStore = db.createObjectStore('documents', { keyPath: 'id', autoIncrement: true });
        docStore.createIndex('tag', 'tag', { unique: false });
      }
      if (!db.objectStoreNames.contains('projectDocuments')) {
        const projectDocStore = db.createObjectStore('projectDocuments', { keyPath: 'id', autoIncrement: true });
        projectDocStore.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('projectFiles')) {
        db.createObjectStore('projectFiles', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeNames, mode) {
  return openDB().then((db) => db.transaction(storeNames, mode));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ---------------- Data access: tags ---------------- */

async function putTag(tagData) {
  const t = await tx('tags', 'readwrite');
  const store = t.objectStore('tags');
  await reqToPromise(store.put(tagData));
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

async function getAllTags() {
  const t = await tx('tags', 'readonly');
  const store = t.objectStore('tags');
  return reqToPromise(store.getAll());
}

async function getTag(tagCode) {
  const t = await tx('tags', 'readonly');
  const store = t.objectStore('tags');
  return reqToPromise(store.get(tagCode));
}

async function deleteTag(tagCode) {
  const t = await tx(['tags', 'documents'], 'readwrite');
  const tagStore = t.objectStore('tags');
  const docStore = t.objectStore('documents');
  const docIndex = docStore.index('tag');
  const docs = await reqToPromise(docIndex.getAllKeys(tagCode));
  docs.forEach((id) => docStore.delete(id));
  tagStore.delete(tagCode);
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/* ---------------- Data access: documents ---------------- */

async function addDocument(tagCode, file) {
  const buffer = await file.arrayBuffer();
  const doc = {
    tag: tagCode,
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    data: buffer,
    createdAt: Date.now(),
  };
  const t = await tx('documents', 'readwrite');
  const store = t.objectStore('documents');
  await reqToPromise(store.add(doc));
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

async function getDocumentsForTag(tagCode) {
  const t = await tx('documents', 'readonly');
  const store = t.objectStore('documents');
  const index = store.index('tag');
  return reqToPromise(index.getAll(tagCode));
}

async function deleteDocument(id) {
  const t = await tx('documents', 'readwrite');
  const store = t.objectStore('documents');
  store.delete(id);
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

async function getAllDocuments() {
  const t = await tx('documents', 'readonly');
  const store = t.objectStore('documents');
  return reqToPromise(store.getAll());
}

/* ---------------- Data access: project library ---------------- */

async function addProjectDocument(metadata, data) {
  const t = await tx(['projectDocuments', 'projectFiles'], 'readwrite');
  const metadataStore = t.objectStore('projectDocuments');
  const fileStore = t.objectStore('projectFiles');
  const completed = new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('La transacción fue cancelada.'));
  });
  completed.catch(() => {}); // evita "unhandled rejection" si add() falla antes de llegar al await de abajo
  const id = await reqToPromise(metadataStore.add(metadata));
  try {
    fileStore.put({ id, data });
  } catch (err) {
    t.abort();
    throw err;
  }
  await completed;
  return id;
}

async function getAllProjectDocuments() {
  const t = await tx('projectDocuments', 'readonly');
  return reqToPromise(t.objectStore('projectDocuments').getAll());
}

async function getProjectDocument(id) {
  const t = await tx('projectDocuments', 'readonly');
  return reqToPromise(t.objectStore('projectDocuments').get(id));
}

async function getProjectFile(id) {
  const t = await tx('projectFiles', 'readonly');
  return reqToPromise(t.objectStore('projectFiles').get(id));
}

async function deleteProjectDocument(id) {
  const t = await tx(['projectDocuments', 'projectFiles'], 'readwrite');
  t.objectStore('projectDocuments').delete(id);
  t.objectStore('projectFiles').delete(id);
  return new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

/* ---------------- UI state & helpers ---------------- */

const el = (id) => document.getElementById(id);

const listView = el('listView');
const emptyState = el('emptyState');
const searchInput = el('searchInput');
const toast = el('toast');

let currentDetailTag = null;
let toastTimer = null;

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2600);
}

function normalizeTagCode(raw) {
  return raw.trim().toUpperCase().replace(/\s+/g, ' ');
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('es', { year: 'numeric', month: 'short', day: 'numeric' });
}

/* ---------------- Render: list ---------------- */

const DIACRITICS_RE = new RegExp('[' + String.fromCharCode(0x0300) + '-' + String.fromCharCode(0x036f) + ']', 'g');
function normalizeForSearch(str) {
  return String(str || '').toLowerCase().normalize('NFD').replace(DIACRITICS_RE, '');
}

/* ---------------- Project document extraction ---------------- */

const projectFileInput = el('projectFileInput');
const libraryFileInput = el('libraryFileInput');
const processingPanel = el('processingPanel');
const processingText = el('processingText');
const processingBar = el('processingBar');
const documentResultsSection = el('documentResultsSection');
const documentResultsTitle = el('documentResultsTitle');
const documentResults = el('documentResults');
const tagsTitle = el('tagsTitle');
const libraryBackdrop = el('libraryBackdrop');
const libraryList = el('libraryList');
const sourceBackdrop = el('sourceBackdrop');
const sourceTitle = el('sourceTitle');
const sourceMeta = el('sourceMeta');
const sourceContent = el('sourceContent');

let projectDocsCache = [];
let pdfJsPromise = null;
let searchTimer = null;

function fileExtension(name) {
  const dot = String(name).lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function documentFormatLabel(format) {
  const labels = { pdf: 'PDF', excel: 'Excel', word: 'Word', text: 'Texto' };
  return labels[format] || 'Documento';
}

function statusLabel(doc) {
  if (doc.status === 'ready') return { text: 'Texto extraído', className: 'status-ok' };
  if (doc.status === 'needs-ocr') return { text: 'PDF escaneado: requiere OCR', className: 'status-warning' };
  return { text: 'No se pudo extraer', className: 'status-error' };
}

async function getPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = import('./vendor/pdf.min.mjs').then((pdfjsLib) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';
      return pdfjsLib;
    });
  }
  return pdfJsPromise;
}

async function extractPdf(buffer) {
  const pdfjsLib = await getPdfJs();
  // PDF.js transfiere este ArrayBuffer al worker y puede dejarlo inutilizable.
  // Se entrega una copia para conservar intacto el archivo original.
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer.slice(0)) });
  const pdf = await loadingTask.promise;
  const passages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      if (!item.str) continue;
      text += item.str;
      text += item.hasEOL ? '\n' : ' ';
    }
    text = text.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
    if (text) passages.push({ locator: `Página ${pageNumber}`, text });
    page.cleanup();
  }

  const textLength = passages.reduce((sum, passage) => sum + passage.text.length, 0);
  return {
    format: 'pdf',
    passages,
    status: textLength >= 20 ? 'ready' : 'needs-ocr',
    extractionMessage: textLength >= 20
      ? `${pdf.numPages} página${pdf.numPages === 1 ? '' : 's'} procesada${pdf.numPages === 1 ? '' : 's'}.`
      : 'El PDF parece contener imágenes sin texto digital.',
  };
}

function rowToText(row, headers, useHeaders) {
  const cells = row.map((value) => String(value ?? '').trim());
  if (!useHeaders) return cells.filter(Boolean).join(' | ');
  return cells
    .map((value, index) => {
      if (!value) return '';
      const header = String(headers[index] ?? '').trim();
      return header && header !== value ? `${header}: ${value}` : value;
    })
    .filter(Boolean)
    .join(' | ');
}

function detectHeaderIndex(rows) {
  const sampleSize = Math.min(rows.length, 5);
  let bestIndex = -1;
  let bestCount = 1;
  for (let i = 0; i < sampleSize; i += 1) {
    const count = rows[i].filter((value) => String(value).trim()).length;
    if (count > bestCount) {
      bestCount = count;
      bestIndex = i;
    }
  }
  return bestIndex;
}

async function extractSpreadsheet(buffer) {
  if (!window.XLSX) throw new Error('No se cargó el lector de Excel.');
  const workbook = window.XLSX.read(buffer, { type: 'array', cellDates: true });
  const passages = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = window.XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: false,
    });
    // La fila con más celdas llenas entre las primeras es el encabezado real;
    // evita que una fila de título/banner (pocas celdas) se detecte como tal.
    const headerIndex = detectHeaderIndex(rows);
    const headers = headerIndex >= 0 ? rows[headerIndex] : [];

    rows.forEach((row, index) => {
      const text = rowToText(row, headers, headerIndex >= 0 && index > headerIndex);
      if (text) passages.push({ locator: `Hoja “${sheetName}”, fila ${index + 1}`, text });
    });
  }

  return {
    format: 'excel',
    passages,
    status: passages.length ? 'ready' : 'error',
    extractionMessage: `${workbook.SheetNames.length} hoja${workbook.SheetNames.length === 1 ? '' : 's'} procesada${workbook.SheetNames.length === 1 ? '' : 's'}.`,
  };
}

async function extractWord(buffer) {
  if (!window.mammoth) throw new Error('No se cargó el lector de Word.');
  const result = await window.mammoth.extractRawText({ arrayBuffer: buffer });
  const paragraphs = result.value
    .split(/\n{2,}/)
    .map((text) => text.trim())
    .filter(Boolean);
  return {
    format: 'word',
    passages: paragraphs.map((text, index) => ({ locator: `Sección ${index + 1}`, text })),
    status: paragraphs.length ? 'ready' : 'error',
    extractionMessage: paragraphs.length
      ? `${paragraphs.length} sección${paragraphs.length === 1 ? '' : 'es'} procesada${paragraphs.length === 1 ? '' : 's'}.`
      : 'El documento no contiene texto extraíble.',
  };
}

async function extractTextFile(file) {
  const text = await file.text();
  const blocks = text.split(/\n{2,}/).map((value) => value.trim()).filter(Boolean);
  return {
    format: 'text',
    passages: blocks.map((value, index) => ({ locator: `Bloque ${index + 1}`, text: value })),
    status: blocks.length ? 'ready' : 'error',
    extractionMessage: blocks.length ? 'Texto procesado.' : 'El archivo está vacío.',
  };
}

async function extractProjectFile(file, buffer) {
  const extension = fileExtension(file.name);
  if (extension === 'pdf') return extractPdf(buffer);
  if (['xlsx', 'xls', 'xlsm', 'csv'].includes(extension)) return extractSpreadsheet(buffer);
  if (extension === 'docx') return extractWord(buffer);
  if (['txt', 'md'].includes(extension)) return extractTextFile(file);
  throw new Error(`Formato .${extension || '?'} no compatible.`);
}

async function reloadProjectDocsCache() {
  projectDocsCache = await getAllProjectDocuments();
  projectDocsCache.sort((a, b) => b.createdAt - a.createdAt);
  for (const doc of projectDocsCache) {
    doc._normalizedName = normalizeForSearch(doc.name);
    doc._normalizedPassages = (doc.passages || []).map((passage) => normalizeForSearch(passage.text));
  }
  el('libraryBtn').textContent = `Documentos (${projectDocsCache.length})`;
  el('librarySummary').textContent = `${projectDocsCache.length} archivo${projectDocsCache.length === 1 ? '' : 's'} cargado${projectDocsCache.length === 1 ? '' : 's'}`;
}

async function processProjectFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  processingPanel.classList.remove('hidden');
  processingBar.style.width = '0%';
  let readyCount = 0;
  let warningCount = 0;
  let failedCount = 0;

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    processingText.textContent = `Leyendo ${index + 1} de ${files.length}: ${file.name}`;
    processingBar.style.width = `${Math.round((index / files.length) * 100)}%`;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    try {
      const buffer = await file.arrayBuffer();
      let extraction;
      try {
        extraction = await extractProjectFile(file, buffer);
      } catch (err) {
        console.error(`No se pudo extraer ${file.name}:`, err);
        extraction = {
          format: fileExtension(file.name) || 'document',
          passages: [],
          status: 'error',
          extractionMessage: err.message || 'Error de extracción.',
        };
      }
      await addProjectDocument({
        name: file.name,
        type: file.type || 'application/octet-stream',
        size: file.size,
        createdAt: Date.now(),
        extractedAt: Date.now(),
        format: extraction.format,
        status: extraction.status,
        extractionMessage: extraction.extractionMessage,
        passages: extraction.passages,
      }, buffer);
      if (extraction.status === 'ready') readyCount += 1;
      else if (extraction.status === 'needs-ocr') warningCount += 1;
      else failedCount += 1;
    } catch (err) {
      console.error(`No se pudo guardar ${file.name}:`, err);
      failedCount += 1;
    }
  }

  processingBar.style.width = '100%';
  processingText.textContent = 'Actualizando el índice de búsqueda...';
  await reloadProjectDocsCache();
  renderLibrary();
  await renderSearch();
  setTimeout(() => processingPanel.classList.add('hidden'), 700);
  const parts = [];
  if (readyCount) parts.push(`${readyCount} con texto extraído`);
  if (warningCount) parts.push(`${warningCount} requiere OCR`);
  if (failedCount) parts.push(`${failedCount} con error`);
  showToast(parts.join(' · ') || 'Proceso terminado.');
}

function matchingPassages(doc, query) {
  const normalizedQuery = normalizeForSearch(query).trim();
  if (!normalizedQuery) return doc.passages || [];
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  const normalizedPassages = doc._normalizedPassages || (doc.passages || []).map((passage) => normalizeForSearch(passage.text));
  const exactMatches = [];
  const termMatches = [];
  normalizedPassages.forEach((text, index) => {
    if (text.includes(normalizedQuery)) exactMatches.push(doc.passages[index]);
    else if (terms.every((term) => text.includes(term))) termMatches.push(doc.passages[index]);
  });
  return exactMatches.length ? exactMatches : termMatches;
}

function findMatchRanges(normalizedText, normalizedQuery) {
  const ranges = [];
  if (!normalizedQuery) return ranges;
  const terms = normalizedQuery.includes(' ')
    ? [normalizedQuery, ...normalizedQuery.split(/\s+/).filter(Boolean)]
    : [normalizedQuery];

  for (const term of terms) {
    if (!term) continue;
    let start = 0;
    let idx = normalizedText.indexOf(term, start);
    while (idx !== -1) {
      ranges.push([idx, idx + term.length]);
      start = idx + term.length;
      idx = normalizedText.indexOf(term, start);
    }
  }

  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

function appendHighlighted(container, text, query) {
  const normalizedQuery = normalizeForSearch(query).trim();
  const ranges = normalizedQuery ? findMatchRanges(normalizeForSearch(text), normalizedQuery) : [];
  if (!ranges.length) {
    container.appendChild(document.createTextNode(text));
    return;
  }
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) container.appendChild(document.createTextNode(text.slice(cursor, start)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(start, end);
    container.appendChild(mark);
    cursor = end;
  }
  if (cursor < text.length) container.appendChild(document.createTextNode(text.slice(cursor)));
}

function snippetAroundQuery(text, query, maxLength = 430) {
  if (text.length <= maxLength) return text;
  const normalizedText = normalizeForSearch(text);
  const normalizedQuery = normalizeForSearch(query).trim();
  let index = normalizedQuery ? normalizedText.indexOf(normalizedQuery) : -1;
  if (index < 0) {
    const firstTerm = normalizedQuery.split(/\s+/).find(Boolean);
    index = firstTerm ? normalizedText.indexOf(firstTerm) : 0;
  }
  if (index < 0) index = 0;
  const start = Math.max(0, index - Math.floor(maxLength * 0.38));
  const end = Math.min(text.length, start + maxLength);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

function projectDocumentMatches(doc, query) {
  const q = normalizeForSearch(query).trim();
  if (!q) return false;
  const terms = q.split(/\s+/).filter(Boolean);
  if (doc._normalizedName.includes(q)) return true;
  return (doc._normalizedPassages || []).some((text) =>
    text.includes(q) || terms.every((term) => text.includes(term))
  );
}

function createButton(text, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = text;
  button.addEventListener('click', onClick);
  return button;
}

async function openProjectFile(id) {
  const [doc, storedFile] = await Promise.all([getProjectDocument(id), getProjectFile(id)]);
  if (!doc || !storedFile) {
    showToast('No se encontró el archivo original.');
    return;
  }
  const blob = new Blob([storedFile.data], { type: doc.type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = doc.name;
  anchor.target = '_blank';
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function openSourceView(doc, query = '') {
  const passages = query ? matchingPassages(doc, query) : (doc.passages || []);
  sourceTitle.textContent = doc.name;
  sourceMeta.textContent = query
    ? `${passages.length} sección${passages.length === 1 ? '' : 'es'} relacionada${passages.length === 1 ? '' : 's'} con “${query}”`
    : `${documentFormatLabel(doc.format)} · ${doc.passages.length} sección${doc.passages.length === 1 ? '' : 'es'} extraída${doc.passages.length === 1 ? '' : 's'}`;
  sourceContent.textContent = '';
  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.appendChild(createButton('Abrir archivo original', 'secondary', () => openProjectFile(doc.id)));
  sourceContent.appendChild(actions);

  if (!passages.length) {
    const message = document.createElement('p');
    message.className = 'empty-state';
    message.textContent = doc.extractionMessage || 'No hay texto extraído disponible.';
    sourceContent.appendChild(message);
  } else {
    for (const passage of passages) {
      const block = document.createElement('div');
      block.className = 'source-passage';
      const locator = document.createElement('span');
      locator.className = 'locator';
      locator.textContent = passage.locator;
      const text = document.createElement('span');
      if (query) appendHighlighted(text, passage.text, query);
      else text.textContent = passage.text;
      block.appendChild(locator);
      block.appendChild(text);
      sourceContent.appendChild(block);
    }
  }
  sourceBackdrop.classList.remove('hidden');
}

function renderDocumentResults(query) {
  const q = query.trim();
  documentResults.textContent = '';
  if (!q) {
    documentResultsSection.classList.add('hidden');
    return 0;
  }
  const matches = projectDocsCache.filter((doc) => projectDocumentMatches(doc, q));
  documentResultsSection.classList.remove('hidden');
  documentResultsTitle.textContent = `${matches.length} documento${matches.length === 1 ? '' : 's'} con información relacionada`;

  for (const doc of matches) {
    const passages = matchingPassages(doc, q);
    const card = document.createElement('article');
    card.className = 'result-card';
    const title = document.createElement('div');
    title.className = 'result-title';
    title.textContent = doc.name;
    const meta = document.createElement('div');
    meta.className = 'result-meta';
    meta.textContent = `${documentFormatLabel(doc.format)} · ${formatSize(doc.size)} · ${passages.length} coincidencia${passages.length === 1 ? '' : 's'}`;
    card.appendChild(title);
    card.appendChild(meta);

    passages.slice(0, 3).forEach((passage) => {
      const match = document.createElement('div');
      match.className = 'match';
      const locator = document.createElement('span');
      locator.className = 'locator';
      locator.textContent = passage.locator;
      const text = document.createElement('span');
      appendHighlighted(text, snippetAroundQuery(passage.text, q), q);
      match.appendChild(locator);
      match.appendChild(text);
      card.appendChild(match);
    });
    if (!passages.length && doc._normalizedName.includes(normalizeForSearch(q))) {
      const match = document.createElement('div');
      match.className = 'match';
      match.textContent = 'La búsqueda coincide con el nombre del archivo.';
      card.appendChild(match);
    }

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.appendChild(createButton(
      passages.length ? `Ver toda la información (${passages.length})` : 'Ver extracción',
      'secondary',
      () => openSourceView(doc, q)
    ));
    actions.appendChild(createButton('Abrir original', 'secondary', () => openProjectFile(doc.id)));
    card.appendChild(actions);
    documentResults.appendChild(card);
  }
  return matches.length;
}

function renderLibrary() {
  libraryList.textContent = '';
  if (!projectDocsCache.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'Todavía no hay documentos cargados.';
    libraryList.appendChild(empty);
    return;
  }
  for (const doc of projectDocsCache) {
    const item = document.createElement('div');
    item.className = 'library-item';
    const name = document.createElement('div');
    name.className = 'library-name';
    name.textContent = doc.name;
    const meta = document.createElement('div');
    meta.className = 'result-meta';
    meta.textContent = `${documentFormatLabel(doc.format)} · ${formatSize(doc.size)} · ${formatDate(doc.createdAt)}`;
    const status = document.createElement('div');
    const statusInfo = statusLabel(doc);
    status.className = `result-meta ${statusInfo.className}`;
    status.textContent = `${statusInfo.text}. ${doc.extractionMessage || ''}`.trim();
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.appendChild(createButton('Ver texto', 'secondary', () => openSourceView(doc)));
    actions.appendChild(createButton('Abrir', 'secondary', () => openProjectFile(doc.id)));
    actions.appendChild(createButton('Eliminar', 'danger', async () => {
      if (!confirm(`¿Eliminar “${doc.name}” de la biblioteca?`)) return;
      await deleteProjectDocument(doc.id);
      await reloadProjectDocsCache();
      renderLibrary();
      await renderSearch();
      showToast('Documento eliminado.');
    }));
    item.appendChild(name);
    item.appendChild(meta);
    item.appendChild(status);
    item.appendChild(actions);
    libraryList.appendChild(item);
  }
}

projectFileInput.addEventListener('change', async () => {
  const files = Array.from(projectFileInput.files || []);
  projectFileInput.value = '';
  await processProjectFiles(files);
});
libraryFileInput.addEventListener('change', async () => {
  const files = Array.from(libraryFileInput.files || []);
  libraryFileInput.value = '';
  await processProjectFiles(files);
});
el('libraryBtn').addEventListener('click', () => {
  renderLibrary();
  libraryBackdrop.classList.remove('hidden');
});
el('closeLibraryBtn').addEventListener('click', () => libraryBackdrop.classList.add('hidden'));
libraryBackdrop.addEventListener('click', (event) => {
  if (event.target === libraryBackdrop) libraryBackdrop.classList.add('hidden');
});
el('closeSourceBtn').addEventListener('click', () => sourceBackdrop.classList.add('hidden'));
sourceBackdrop.addEventListener('click', (event) => {
  if (event.target === sourceBackdrop) sourceBackdrop.classList.add('hidden');
});

async function renderSearch() {
  const query = searchInput.value.trim();
  const documentMatchCount = renderDocumentResults(query);
  const tagStats = await renderList(query);
  if (query) {
    if (documentMatchCount + tagStats.filtered === 0) {
      emptyState.classList.remove('hidden');
      emptyState.textContent = `No se encontró información para “${query}”.`;
    } else {
      emptyState.classList.add('hidden');
    }
  } else if (tagStats.total === 0) {
    emptyState.classList.remove('hidden');
    emptyState.textContent = projectDocsCache.length
      ? 'Escribe un tag, equipo o dato para buscar en los documentos.'
      : 'Carga documentos del proyecto o crea un tag para comenzar.';
  } else {
    emptyState.classList.add('hidden');
  }
}

async function renderList(filterText = '') {
  const tags = await getAllTags();
  tags.sort((a, b) => a.tag.localeCompare(b.tag));

  const q = normalizeForSearch(filterText.trim());
  const filtered = q
    ? tags.filter((t) =>
        normalizeForSearch(t.tag).includes(q) ||
        normalizeForSearch(t.name || '').includes(q) ||
        normalizeForSearch(t.category || '').includes(q) ||
        normalizeForSearch(t.location || '').includes(q)
      )
    : tags;

  listView.textContent = '';
  tagsTitle.classList.toggle('hidden', filtered.length === 0);

  for (const t of filtered) {
    const card = document.createElement('div');
    card.className = 'tag-card';
    card.addEventListener('click', () => openDetail(t.tag));

    const code = document.createElement('div');
    code.className = 'code';
    code.textContent = t.tag;
    card.appendChild(code);

    if (t.name) {
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = t.name;
      card.appendChild(name);
    }

    const metaParts = [t.category, t.location].filter(Boolean);
    if (metaParts.length) {
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = metaParts.join(' · ');
      card.appendChild(meta);
    }

    listView.appendChild(card);
  }
  return { total: tags.length, filtered: filtered.length };
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderSearch, 160);
});

/* ---------------- Detail sheet ---------------- */

const detailBackdrop = el('detailBackdrop');
const detailCode = el('detailCode');
const detailName = el('detailName');
const detailMeta = el('detailMeta');
const docList = el('docList');
const docFileInput = el('docFileInput');

async function openDetail(tagCode) {
  const t = await getTag(tagCode);
  if (!t) return;
  currentDetailTag = tagCode;

  detailCode.textContent = t.tag;
  detailName.textContent = t.name || '';

  const lines = [];
  if (t.category) lines.push(`Categoría: ${t.category}`);
  if (t.location) lines.push(`Ubicación: ${t.location}`);
  if (t.notes) lines.push(`Notas: ${t.notes}`);
  detailMeta.textContent = lines.join('\n');

  await renderDocList(tagCode);
  detailBackdrop.classList.remove('hidden');
}

function closeDetail() {
  detailBackdrop.classList.add('hidden');
  currentDetailTag = null;
}

el('closeDetailBtn').addEventListener('click', closeDetail);
detailBackdrop.addEventListener('click', (e) => {
  if (e.target === detailBackdrop) closeDetail();
});

async function renderDocList(tagCode) {
  const docs = await getDocumentsForTag(tagCode);
  docs.sort((a, b) => b.createdAt - a.createdAt);
  docList.textContent = '';

  if (docs.length === 0) {
    const empty = document.createElement('p');
    empty.style.color = 'var(--text-dim)';
    empty.style.fontSize = '0.85rem';
    empty.style.margin = '0';
    empty.textContent = 'Sin documentos adjuntos.';
    docList.appendChild(empty);
    return;
  }

  for (const doc of docs) {
    const item = document.createElement('div');
    item.className = 'doc-item';

    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('div');
    name.className = 'doc-name';
    name.textContent = doc.name;
    const meta = document.createElement('div');
    meta.className = 'doc-meta';
    meta.textContent = `${formatSize(doc.size)} · ${formatDate(doc.createdAt)}`;
    info.appendChild(name);
    info.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'doc-actions';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.textContent = 'Abrir';
    openBtn.addEventListener('click', () => openDocument(doc));

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove';
    removeBtn.textContent = 'Borrar';
    removeBtn.addEventListener('click', async () => {
      if (!confirm(`¿Eliminar "${doc.name}"?`)) return;
      await deleteDocument(doc.id);
      await renderDocList(tagCode);
    });

    actions.appendChild(openBtn);
    actions.appendChild(removeBtn);

    item.appendChild(info);
    item.appendChild(actions);
    docList.appendChild(item);
  }
}

function openDocument(doc) {
  const blob = new Blob([doc.data], { type: doc.type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = doc.name;
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

docFileInput.addEventListener('change', async () => {
  const files = Array.from(docFileInput.files || []);
  if (!files.length || !currentDetailTag) return;
  for (const file of files) {
    await addDocument(currentDetailTag, file);
  }
  docFileInput.value = '';
  await renderDocList(currentDetailTag);
  showToast(files.length === 1 ? 'Documento agregado.' : `${files.length} documentos agregados.`);
});

/* ---------------- Form: create / edit tag ---------------- */

const formBackdrop = el('formBackdrop');
const formTitle = el('formTitle');
const tagForm = el('tagForm');
const fieldTag = el('fieldTag');
const fieldName = el('fieldName');
const fieldCategory = el('fieldCategory');
const fieldLocation = el('fieldLocation');
const fieldNotes = el('fieldNotes');

let editingOriginalTag = null;

function openForm(existing) {
  editingOriginalTag = existing ? existing.tag : null;
  formTitle.textContent = existing ? 'Editar tag' : 'Nuevo tag';
  fieldTag.value = existing ? existing.tag : '';
  fieldTag.disabled = Boolean(existing);
  fieldName.value = existing ? existing.name || '' : '';
  fieldCategory.value = existing ? existing.category || '' : '';
  fieldLocation.value = existing ? existing.location || '' : '';
  fieldNotes.value = existing ? existing.notes || '' : '';
  formBackdrop.classList.remove('hidden');
  setTimeout(() => fieldTag.focus(), 50);
}

function closeForm() {
  formBackdrop.classList.add('hidden');
  tagForm.reset();
  fieldTag.disabled = false;
  editingOriginalTag = null;
}

el('newTagBtn').addEventListener('click', () => openForm(null));
el('cancelFormBtn').addEventListener('click', closeForm);
formBackdrop.addEventListener('click', (e) => {
  if (e.target === formBackdrop) closeForm();
});

el('editTagBtn').addEventListener('click', async () => {
  if (!currentDetailTag) return;
  const t = await getTag(currentDetailTag);
  closeDetail();
  openForm(t);
});

el('deleteTagBtn').addEventListener('click', async () => {
  if (!currentDetailTag) return;
  if (!confirm(`¿Eliminar el tag "${currentDetailTag}" y todos sus documentos?`)) return;
  await deleteTag(currentDetailTag);
  closeDetail();
  await renderSearch();
  showToast('Tag eliminado.');
});

tagForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const tagCode = normalizeTagCode(fieldTag.value);
  if (!tagCode) return;

  if (!editingOriginalTag) {
    const existing = await getTag(tagCode);
    if (existing) {
      showToast('Ya existe un tag con ese código.');
      return;
    }
  }

  const now = Date.now();
  const existingForDates = editingOriginalTag ? await getTag(editingOriginalTag) : null;

  await putTag({
    tag: tagCode,
    name: fieldName.value.trim(),
    category: fieldCategory.value.trim(),
    location: fieldLocation.value.trim(),
    notes: fieldNotes.value.trim(),
    createdAt: existingForDates ? existingForDates.createdAt : now,
    updatedAt: now,
  });

  closeForm();
  await renderSearch();
  showToast('Tag guardado.');
});

/* ---------------- Menu: export / import ---------------- */

const menuBackdrop = el('menuBackdrop');
el('menuBtn').addEventListener('click', () => menuBackdrop.classList.remove('hidden'));
el('closeMenuBtn').addEventListener('click', () => menuBackdrop.classList.add('hidden'));
menuBackdrop.addEventListener('click', (e) => {
  if (e.target === menuBackdrop) menuBackdrop.classList.add('hidden');
});

function bufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

el('exportBtn').addEventListener('click', async () => {
  showToast('Generando respaldo...');
  const tags = await getAllTags();
  const docs = await getAllDocuments();
  const projectDocuments = await getAllProjectDocuments();
  const projectLibrary = [];
  for (const metadata of projectDocuments) {
    const storedFile = await getProjectFile(metadata.id);
    if (!storedFile) continue;
    const { id, ...portableMetadata } = metadata;
    projectLibrary.push({
      ...portableMetadata,
      dataBase64: bufferToBase64(storedFile.data),
    });
  }

  const payload = {
    app: 'taginfo',
    version: 2,
    exportedAt: new Date().toISOString(),
    tags,
    documents: docs.map((d) => ({
      tag: d.tag,
      name: d.name,
      type: d.type,
      size: d.size,
      createdAt: d.createdAt,
      dataBase64: bufferToBase64(d.data),
    })),
    projectDocuments: projectLibrary,
  };

  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const a = document.createElement('a');
  a.href = url;
  a.download = `taginfo-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  showToast('Respaldo descargado.');
});

el('importFileInput').addEventListener('change', async () => {
  const file = el('importFileInput').files[0];
  el('importFileInput').value = '';
  if (!file) return;

  if (!confirm('Esto combinará el respaldo con los datos actuales (los tags con el mismo código se sobrescriben). ¿Continuar?')) {
    return;
  }

  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    if (payload.app !== 'taginfo' || !Array.isArray(payload.tags)) {
      showToast('El archivo no parece ser un respaldo válido de TagInfo.');
      return;
    }

    for (const t of payload.tags) {
      await putTag(t);
    }

    // Los documentos se insertan directamente (traen ArrayBuffer, no File),
    // por eso no se reusa addDocument() aquí.
    for (const d of payload.documents || []) {
      const buffer = base64ToBuffer(d.dataBase64);
      const t = await tx('documents', 'readwrite');
      const store = t.objectStore('documents');
      store.add({
        tag: d.tag,
        name: d.name,
        type: d.type,
        size: d.size,
        data: buffer,
        createdAt: d.createdAt || Date.now(),
      });
      await new Promise((resolve, reject) => {
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      });
    }

    for (const projectDoc of payload.projectDocuments || []) {
      const { dataBase64, id, ...metadata } = projectDoc;
      if (!dataBase64) continue;
      await addProjectDocument(metadata, base64ToBuffer(dataBase64));
    }

    menuBackdrop.classList.add('hidden');
    await reloadProjectDocsCache();
    await renderSearch();
    showToast('Respaldo importado.');
  } catch (err) {
    console.error(err);
    showToast('No se pudo leer el respaldo (JSON inválido).');
  }
});

/* ---------------- Online/offline indicator ---------------- */

function updateOnlineStatus() {
  el('statusDot').classList.toggle('offline', !navigator.onLine);
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

/* ---------------- Install prompt (Chrome/Android/desktop) ---------------- */

let deferredInstallPrompt = null;
const installBtn = el('installBtn');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  installBtn.classList.remove('hidden');
});

installBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installBtn.classList.add('hidden');
});

window.addEventListener('appinstalled', () => {
  installBtn.classList.add('hidden');
  deferredInstallPrompt = null;
});

/* ---------------- Service worker registration ---------------- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.error('No se pudo registrar el service worker:', err);
    });
  });
}

/* ---------------- Init ---------------- */

updateOnlineStatus();
reloadProjectDocsCache()
  .then(() => renderSearch())
  .catch((err) => {
    console.error('No se pudo iniciar TagInfo:', err);
    showToast('No se pudo abrir la base de datos.');
  });
