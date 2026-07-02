'use strict';

/* ---------------------------------------------------------------
   TagInfo — app 100% offline-first. Todo vive en IndexedDB.
   Store "tags": keyPath "tag" (código normalizado en mayúsculas).
   Store "documents": keyPath autoIncrement "id", index "tag".
   Los archivos se guardan como ArrayBuffer (no Blob) por
   compatibilidad con versiones antiguas de Safari/iOS que no
   soportaban clonar Blobs dentro de IndexedDB.
------------------------------------------------------------------ */

const DB_NAME = 'taginfo-db';
const DB_VERSION = 1;
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
  return str.toLowerCase().normalize('NFD').replace(DIACRITICS_RE, '');
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

  if (tags.length === 0) {
    emptyState.classList.remove('hidden');
    emptyState.textContent = 'No hay tags guardados todavía. Toca "+ Tag" para crear el primero.';
    return;
  }

  if (filtered.length === 0) {
    emptyState.classList.remove('hidden');
    emptyState.textContent = 'Sin resultados para esa búsqueda.';
    return;
  }

  emptyState.classList.add('hidden');

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
}

searchInput.addEventListener('input', () => renderList(searchInput.value));

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
  await renderList(searchInput.value);
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
  await renderList(searchInput.value);
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

  const payload = {
    app: 'taginfo',
    version: 1,
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

    menuBackdrop.classList.add('hidden');
    await renderList(searchInput.value);
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
renderList();
