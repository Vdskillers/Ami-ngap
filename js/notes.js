// ─────────────────────────────────────────────────────────────
//  notes.js
//  Gestion des notes par patient
//  Catégories : général | accès | médical | urgent
//  CRUD complet : ajout, modification, suppression avec confirmation
// ─────────────────────────────────────────────────────────────

const NOTE_CATEGORIES = {
  general: { label: 'Général',  cssClass: 'cat-general' },
  acces:   { label: 'Accès',    cssClass: 'cat-acces'   },
  medical: { label: 'Médical',  cssClass: 'cat-medical' },
  urgent:  { label: 'Urgent',   cssClass: 'cat-urgent'  },
};

// ─────────────────────────────────────────────────────────────
//  RENDU — afficher toutes les notes d'un patient
// ─────────────────────────────────────────────────────────────
function renderNotes(patient, containerId = 'notes-container') {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = '';

  if (!patient.notes || patient.notes.length === 0) {
    container.innerHTML = `
      <p class="notes-empty">Aucune note pour ce patient.</p>`;
    return;
  }

  patient.notes.forEach(note => {
    const block = createNoteBlock(patient.id, note);
    container.appendChild(block);
  });
}

// ─────────────────────────────────────────────────────────────
//  Création d'un bloc note DOM
// ─────────────────────────────────────────────────────────────
function createNoteBlock(patientId, note) {
  const cat   = NOTE_CATEGORIES[note.cat] || NOTE_CATEGORIES.general;
  const block = document.createElement('div');
  block.className = 'note-block';
  block.id        = 'note-' + note.id;

  block.innerHTML = `
    <div class="note-meta">
      <span class="note-cat ${cat.cssClass}">${cat.label}</span>
      <span class="note-date">${note.date || ''}</span>
    </div>

    <div class="note-text" id="notetext-${note.id}">${escapeHtml(note.text)}</div>

    <div class="note-edit-area" id="editarea-${note.id}" style="display:none">
      <textarea class="note-edit-input" id="editinput-${note.id}">${escapeHtml(note.text)}</textarea>
      <div class="note-edit-actions">
        <button class="btn-note save"
                onclick="saveNoteEdit('${patientId}', '${note.id}')">
          Enregistrer
        </button>
        <button class="btn-note cancel"
                onclick="cancelNoteEdit('${note.id}')">
          Annuler
        </button>
      </div>
    </div>

    <div class="note-actions" id="actions-${note.id}">
      <button class="btn-note edit"
              onclick="startNoteEdit('${note.id}')">
        Modifier
      </button>
      <button class="btn-note delete"
              onclick="confirmNoteDelete('${patientId}', '${note.id}')">
        Supprimer
      </button>
    </div>

    <div class="note-confirm-delete" id="confirm-${note.id}" style="display:none">
      <p class="confirm-msg">Supprimer cette note définitivement ?</p>
      <div class="confirm-btns">
        <button class="btn-note delete"
                onclick="doNoteDelete('${patientId}', '${note.id}')">
          Oui, supprimer
        </button>
        <button class="btn-note cancel"
                onclick="cancelNoteDelete('${note.id}')">
          Annuler
        </button>
      </div>
    </div>
  `;

  return block;
}

// ─────────────────────────────────────────────────────────────
//  MODIFIER une note
// ─────────────────────────────────────────────────────────────
function startNoteEdit(noteId) {
  // masquer texte + boutons, afficher zone édition
  const textEl    = document.getElementById('notetext-'  + noteId);
  const editEl    = document.getElementById('editarea-'  + noteId);
  const actionsEl = document.getElementById('actions-'   + noteId);

  if (textEl)    textEl.style.display    = 'none';
  if (actionsEl) actionsEl.style.display = 'none';
  if (editEl)    editEl.style.display    = 'block';

  // focus textarea + curseur à la fin
  const input = document.getElementById('editinput-' + noteId);
  if (input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function cancelNoteEdit(noteId) {
  const textEl    = document.getElementById('notetext-'  + noteId);
  const editEl    = document.getElementById('editarea-'  + noteId);
  const actionsEl = document.getElementById('actions-'   + noteId);

  if (textEl)    textEl.style.display    = 'block';
  if (editEl)    editEl.style.display    = 'none';
  if (actionsEl) actionsEl.style.display = 'flex';
}

async function saveNoteEdit(patientId, noteId) {
  const input = document.getElementById('editinput-' + noteId);
  if (!input) return;

  const newText = input.value.trim();
  if (!newText) {
    input.focus();
    return;
  }

  // mise à jour en mémoire
  const patients = await loadSecure('patients', 'list') || [];
  const patient  = patients.find(p => p.id === patientId);
  if (!patient) return;

  const note = patient.notes.find(n => n.id === noteId);
  if (!note) return;

  note.text = newText;
  note.date = new Date().toLocaleDateString('fr-FR');
  note.edited = true;

  await saveSecure('patients', 'list', patients);

  // mise à jour DOM sans re-render complet
  const textEl    = document.getElementById('notetext-'  + noteId);
  const editEl    = document.getElementById('editarea-'  + noteId);
  const actionsEl = document.getElementById('actions-'   + noteId);
  const dateEl    = document.querySelector('#note-' + noteId + ' .note-date');

  if (textEl)    { textEl.textContent    = newText; textEl.style.display = 'block'; }
  if (editEl)    editEl.style.display    = 'none';
  if (actionsEl) actionsEl.style.display = 'flex';
  if (dateEl)    dateEl.textContent      = note.date;

  showToast('Note modifiée');
}

// ─────────────────────────────────────────────────────────────
//  SUPPRIMER une note
// ─────────────────────────────────────────────────────────────
function confirmNoteDelete(patientId, noteId) {
  // masquer boutons normaux, afficher confirmation
  const actionsEl = document.getElementById('actions-' + noteId);
  const confirmEl = document.getElementById('confirm-' + noteId);

  if (actionsEl) actionsEl.style.display = 'none';
  if (confirmEl) confirmEl.style.display = 'block';
}

function cancelNoteDelete(noteId) {
  const actionsEl = document.getElementById('actions-' + noteId);
  const confirmEl = document.getElementById('confirm-' + noteId);

  if (actionsEl) actionsEl.style.display = 'flex';
  if (confirmEl) confirmEl.style.display = 'none';
}

async function doNoteDelete(patientId, noteId) {
  const patients = await loadSecure('patients', 'list') || [];
  const patient  = patients.find(p => p.id === patientId);
  if (!patient) return;

  patient.notes  = patient.notes.filter(n => n.id !== noteId);

  await saveSecure('patients', 'list', patients);

  // suppression DOM
  const block = document.getElementById('note-' + noteId);
  if (block) block.remove();

  // si plus aucune note, afficher message vide
  const container = document.getElementById('notes-container');
  if (container && !container.querySelector('.note-block')) {
    container.innerHTML = '<p class="notes-empty">Aucune note pour ce patient.</p>';
  }

  // mettre à jour le compteur dans le titre si présent
  updateNotesCount(patientId, patient.notes.length);

  showToast('Note supprimée');
}

// ─────────────────────────────────────────────────────────────
//  AJOUTER une note
// ─────────────────────────────────────────────────────────────

// catégorie sélectionnée dans le formulaire d'ajout
let _selectedNoteCategory = 'general';

function selectNoteCategory(cat, patientId) {
  _selectedNoteCategory = cat;

  // mettre à jour l'UI des boutons catégorie
  Object.keys(NOTE_CATEGORIES).forEach(c => {
    const btn = document.getElementById(`catbtn-${c}-${patientId}`);
    if (!btn) return;
    btn.className = `cat-btn ${c}` + (c === cat ? ' selected' : '');
  });
}

function toggleAddNoteForm(patientId) {
  const form = document.getElementById('add-note-form-' + patientId);
  if (!form) return;

  const isVisible = form.style.display !== 'none';
  form.style.display = isVisible ? 'none' : 'block';

  if (!isVisible) {
    // reset
    const ta = document.getElementById('newnote-' + patientId);
    if (ta) ta.value = '';
    _selectedNoteCategory = 'general';
    Object.keys(NOTE_CATEGORIES).forEach(c => {
      const btn = document.getElementById(`catbtn-${c}-${patientId}`);
      if (btn) btn.className = `cat-btn ${c}` + (c === 'general' ? ' selected' : '');
    });
    if (ta) ta.focus();
  }
}

async function addNote(patientId) {
  const ta = document.getElementById('newnote-' + patientId);
  if (!ta) return;

  const text = ta.value.trim();
  if (!text) { ta.focus(); return; }

  const patients = await loadSecure('patients', 'list') || [];
  const patient  = patients.find(p => p.id === patientId);
  if (!patient) return;

  if (!patient.notes) patient.notes = [];

  const newNote = {
    id:   Date.now().toString(),
    cat:  _selectedNoteCategory,
    text,
    date: new Date().toLocaleDateString('fr-FR'),
  };

  // insérer en tête (note la plus récente en premier)
  patient.notes.unshift(newNote);

  await saveSecure('patients', 'list', patients);

  // ajout dans le DOM
  const container = document.getElementById('notes-container');
  if (container) {
    // supprimer le message "aucune note" si présent
    const empty = container.querySelector('.notes-empty');
    if (empty) empty.remove();

    const block = createNoteBlock(patientId, newNote);
    container.insertBefore(block, container.firstChild);
  }

  updateNotesCount(patientId, patient.notes.length);

  ta.value = '';
  toggleAddNoteForm(patientId);
  showToast('Note ajoutée');
}

// ─────────────────────────────────────────────────────────────
//  Utilitaires
// ─────────────────────────────────────────────────────────────
function updateNotesCount(patientId, count) {
  const el = document.getElementById('notes-count-' + patientId);
  if (el) el.textContent = `Notes (${count})`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

// ─────────────────────────────────────────────────────────────
//  HTML du formulaire d'ajout de note (à injecter dans la fiche)
// ─────────────────────────────────────────────────────────────
function getNoteFormHTML(patientId) {
  const cats = Object.entries(NOTE_CATEGORIES).map(([key, val]) =>
    `<button class="cat-btn ${key}${key === 'general' ? ' selected' : ''}"
             id="catbtn-${key}-${patientId}"
             onclick="selectNoteCategory('${key}', '${patientId}')">
       ${val.label}
     </button>`
  ).join('');

  return `
    <div class="notes-section">
      <div class="notes-header">
        <span id="notes-count-${patientId}">Notes (0)</span>
        <button class="btn-add-note"
                onclick="toggleAddNoteForm('${patientId}')">
          + Ajouter une note
        </button>
      </div>

      <div id="notes-container"></div>

      <div class="add-note-form" id="add-note-form-${patientId}" style="display:none">
        <div class="cat-row">${cats}</div>
        <textarea id="newnote-${patientId}"
                  placeholder="Saisir la note (digicode, accès, allergie, consigne…)">
        </textarea>
        <div class="add-note-actions">
          <button class="btn-note cancel"
                  onclick="toggleAddNoteForm('${patientId}')">
            Annuler
          </button>
          <button class="btn-note save"
                  onclick="addNote('${patientId}')">
            Ajouter
          </button>
        </div>
      </div>
    </div>
  `;
}
