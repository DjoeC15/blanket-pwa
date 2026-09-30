'use strict';

const SOUNDS = [
  { name: 'rain',         category: 'Nature',    icon: 'rainy' },
  { name: 'storm',        category: 'Nature',    icon: 'thunderstorm' },
  { name: 'wind',         category: 'Nature',    icon: 'air' },
  { name: 'waves',        category: 'Nature',    icon: 'waves' },
  { name: 'stream',       category: 'Nature',    icon: 'water' },
  { name: 'birds',        category: 'Nature',    icon: 'flutter_dash' },
  { name: 'summer-night', category: 'Nature',    icon: 'nights_stay' },
  { name: 'train',        category: 'Travel',    icon: 'train' },
  { name: 'boat',         category: 'Travel',    icon: 'sailing' },
  { name: 'city',         category: 'Travel',    icon: 'location_city' },
  { name: 'coffee-shop',  category: 'Interiors', icon: 'local_cafe' },
  { name: 'fireplace',    category: 'Interiors', icon: 'fireplace' },
  { name: 'pink-noise',   category: 'Noise',     icon: 'graphic_eq' },
  { name: 'white-noise',  category: 'Noise',     icon: 'blur_on' },
];

const CUSTOM_CATEGORY = 'My sounds';
const CATEGORIES      = [...new Set(SOUNDS.map(s => s.category)), CUSTOM_CATEGORY];

const SOUND_PATH   = '../data/resources/sounds/';
const PRESETS_KEY  = 'blanket_presets';
const SETTINGS_KEY = 'blanket_settings';
const UI_KEY       = 'blanket_ui';          // lu aussi par le script en tête d'index.html

const APP_VERSION = '1.1.0';

// Durée gardée en mémoire pour un son importé. Les bruits intégrés sont coupés
// à 45 s sans que ça s'entende ; un fichier importé doit être joué en entier.
// La limite ne sert qu'à borner la mémoire : 10 min ≈ 115 Mo de PCM à 48 kHz,
// plus le pic transitoire du décodage (le fichier entier en stéréo).
const CUSTOM_MAX_SECONDS = 10 * 60;

const CUSTOM_ICONS = [
  'music_note', 'forest', 'water_drop', 'air', 'nights_stay', 'graphic_eq',
  'spa', 'pets', 'piano', 'landscape', 'cloud', 'local_fire_department',
];

// Doit correspondre aux blocs [data-palette] de style.css (noms : i18n.js).
const PALETTES = ['navy', 'sage', 'lavender', 'amber', 'rose', 'slate'];

const MODES = [
  { id: 'dark',   icon: 'dark_mode' },
  { id: 'light',  icon: 'light_mode' },
  { id: 'system', icon: 'contrast' },
];

const TIMER_CHOICES = [15, 30, 45, 60, 120];
const TIMER_FADE_MS = 60 * 1000;

const DEFAULT_UI = {
  mode: 'dark', palette: 'navy', black: false, haptics: true, lang: 'system', seenHelp: false,
  timerMinutes: 30, timerFade: true,
};

// ─── Petits utilitaires DOM ──────────────────────────────────────────────────

const $ = id => document.getElementById(id);

/** h('button.pressable.chip', { onclick, 'aria-label': … }, enfants…) */
function h(spec, props, ...children) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on'))    el.addEventListener(key.slice(2), value);
    else if (key === 'dataset')  Object.assign(el.dataset, value);
    else if (key === 'style')    el.style.cssText = value;
    else if (key in el && typeof value !== 'string') el[key] = value;
    else                         el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter(c => c !== null && c !== undefined && c !== false));
  return el;
}

const icon = (name, filled = false) => h('span.icon' + (filled ? '.filled' : ''), { 'aria-hidden': 'true' }, name);

function spinner() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'spinner');
  svg.setAttribute('viewBox', '0 0 48 48');
  const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  c.setAttribute('cx', '24'); c.setAttribute('cy', '24'); c.setAttribute('r', '20');
  svg.appendChild(c);
  return svg;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const pad = n => String(n).padStart(2, '0');
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

const minutesLabel = m => (m % 60 === 0 ? `${m / 60} h` : `${m} min`);

const catLabel = cat => t(cat === CUSTOM_CATEGORY ? 'cat.custom' : 'cat.' + cat);

/** « sand_drawing-v2.mp3 » → « Sand Drawing V2 » */
function cleanFileName(fileName) {
  const base = fileName.replace(/\.[^/.]+$/, '').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!base) return t('mySound');
  return base === base.toLowerCase()
    ? base.replace(/\b\p{L}/gu, c => c.toUpperCase())
    : base;
}

// ─── IndexedDB (stockage des sons personnalisés) ─────────────────────────────

class SoundDB {
  constructor() {
    this._ready = new Promise((resolve, reject) => {
      const req = indexedDB.open('blanket_db', 1);
      req.onupgradeneeded = e => {
        e.target.result.createObjectStore('custom_sounds', { keyPath: 'id' });
      };
      req.onsuccess = e => { this._db = e.target.result; resolve(); };
      req.onerror   = () => reject(req.error);
    });
  }

  _tx(mode, fn) {
    return this._ready.then(() => new Promise((resolve, reject) => {
      const store = this._db.transaction('custom_sounds', mode).objectStore('custom_sounds');
      const req   = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    }));
  }

  getAll()    { return this._tx('readonly',  s => s.getAll()); }
  add(record) { return this._tx('readwrite', s => s.add(record)); }
  put(record) { return this._tx('readwrite', s => s.put(record)); }
  remove(id)  { return this._tx('readwrite', s => s.delete(id)); }
}

// ─── App ─────────────────────────────────────────────────────────────────────

class BlanketApp {
  constructor() {
    this.states       = {};
    this.meta         = {};          // id → { title, icon, category, custom }
    this.rows         = {};          // id → références DOM de la ligne
    this.custom       = new Map();   // id → enregistrement IndexedDB
    this.isPlaying    = false;
    this.masterVol    = 0.8;
    this.presets      = this._loadJSON(PRESETS_KEY, []);
    this.activePreset = null;
    this.filter       = 'All';
    this.ui           = { ...DEFAULT_UI, ...this._loadJSON(UI_KEY, {}) };
    this.timer        = null;        // { endAt, minutes, fade, fading }
    this._stack       = [];          // calques ouverts (menu, feuille, dialogue, écran)
    this._db          = new SoundDB();
    this.engine       = new AudioEngine();

    setLanguage(this.ui.lang);

    this._native = this._resolveNative('BlanketPlayback');
    this._nativeUi = this._resolveNative('BlanketUi');

    this._applyTheme();
    this._translateStatic();
    this._initAudio();
    this._buildUI();
    this._attachEvents();
    this._initMediaSession();
    this._initNative();
    this._registerSW();

    // Async : sons perso, état restauré, police d'icônes — puis on lève l'écran
    // de chargement (et le splash natif, retenu jusque-là).
    Promise.all([
      this._loadCustomSounds().then(() => this._restoreSettings()),
      this._iconFontReady(),
    ]).finally(() => this._reveal());
  }

  // ─── Audio ────────────────────────────────────────

  _initAudio() {
    this.engine.setMasterVolume(this.masterVol);
    SOUNDS.forEach(({ name, icon, category }) => {
      this.states[name] = { active: false, volume: 0.5 };
      this.meta[name]   = { icon, category, custom: false };
      this.engine.register(name, { url: SOUND_PATH + name + '.ogg' });
    });
  }

  /** Nom affiché : traduit pour les sons intégrés, choisi par l'utilisateur sinon. */
  _title(id) {
    const m = this.meta[id];
    if (!m) return id;
    return m.custom ? m.title : t('sound.' + id);
  }

  _playSound(name) {
    this.engine.setVolume(name, this.states[name].volume);
    const row = this.rows[name]?.row;
    // Premier lancement d'un son : décodage de quelques centaines de ms.
    // L'indicateur n'apparaît que si ça dure, pour ne pas clignoter.
    const slow = setTimeout(() => row?.classList.add('loading'), 150);
    this.engine.play(name)
      .catch(() => this._snack(t('couldntLoad', { name: this._title(name) })))
      .finally(() => { clearTimeout(slow); row?.classList.remove('loading'); });
  }

  _pauseSound(name) {
    this.engine.stop(name);
    this.rows[name]?.row.classList.remove('loading');
  }

  // ─── Construction de l'interface ───────────────────

  _buildFilters() {
    $('filters').replaceChildren(...['All', ...CATEGORIES].map(cat =>
      h('button.chip.pressable', {
        dataset: { filter: cat },
        onclick: () => this._setFilter(cat),
      }, icon('check'), cat === 'All' ? t('cat.All') : catLabel(cat))));
  }

  _buildUI() {
    this._buildFilters();

    const groups = $('soundGroups');
    CATEGORIES.forEach(cat => {
      const rows = h('div.sound-rows');
      const group = h('section.sound-group', { dataset: { category: cat } },
        h('h2.section-label', {}, catLabel(cat)), rows);
      if (cat === CUSTOM_CATEGORY) {
        rows.id = 'customRows';
        group.appendChild(h('button.add-row.pressable', { onclick: () => this._pickFile() },
          h('span.icon-wrap', {}, icon('add')), h('span.add-label', {}, t('importASound'))));
      } else {
        SOUNDS.filter(s => s.category === cat).forEach(s => rows.appendChild(this._makeRow(s.name)));
      }
      groups.appendChild(group);
    });

    this._setFilter(this.filter);
    this._renderChips();
  }

  _makeRow(id) {
    const { icon: iconName, custom } = this.meta[id];
    const title = this._title(id);
    const state = this.states[id];

    const glyph  = icon(iconName);
    const name   = h('div.sound-name', {}, title);
    const slider = h('input.m3-slider', {
      type: 'range', min: '0', max: '100', value: String(Math.round(state.volume * 100)),
      'aria-label': t('volumeOf', { name: title }),
    });
    const label  = h('span.volume-label', {}, `${Math.round(state.volume * 100)}%`);
    const toggle = h('button.sound-toggle.pressable', {
      'aria-label': title, 'aria-pressed': 'false',
      onclick: () => this._toggleSound(id),
    });

    const row = h('div.sound-row' + (custom ? '.custom' : ''), { dataset: { id } },
      toggle,
      h('span.sound-icon', {}, glyph, spinner()),
      h('div.sound-content', {}, name, slider),
      label,
      custom && h('button.row-more.icon-button.pressable', {
        'aria-label': t('optionsOf', { name: title }),
        onclick: e => this._customSoundMenu(id, e.currentTarget),
      }, icon('more_vert')),
    );
    const more = row.querySelector('.row-more');

    slider.style.setProperty('--value', slider.value + '%');
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      slider.style.setProperty('--value', v + '%');
      label.textContent = v + '%';
      if (!this.states[id]) return;
      this.states[id].volume = v / 100;
      this.engine.setVolume(id, v / 100);
      // Toucher le curseur d'un son éteint l'allume, comme sur l'app d'origine.
      if (!this.states[id].active && v > 0) this._setActive(id, true);
      const chip = this._chipLabels?.get(id);
      if (chip) chip.textContent = v + '%';
    });
    slider.addEventListener('change', () => this._saveSettings());

    this.rows[id] = { row, slider, label, glyph, name, toggle, more };
    return row;
  }

  _renderRow(id) {
    const r = this.rows[id];
    const s = this.states[id];
    if (!r || !s) return;
    const v = Math.round(s.volume * 100);
    r.row.classList.toggle('active', s.active);
    r.toggle.setAttribute('aria-pressed', String(s.active));
    r.glyph.classList.toggle('filled', s.active);
    r.slider.value = v;
    r.slider.style.setProperty('--value', v + '%');
    r.label.textContent = v + '%';
  }

  _renderChips() {
    const wrap = $('activeChips');
    wrap.replaceChildren();
    this._chipLabels = new Map();

    const active = Object.keys(this.states).filter(id => this.states[id].active);
    if (!active.length) {
      wrap.appendChild(h('p.empty', {}, t('nothingPlaying')));
      return;
    }
    active.forEach(id => {
      const pct = h('b', {}, Math.round(this.states[id].volume * 100) + '%');
      this._chipLabels.set(id, pct);
      wrap.appendChild(h('button.chip.input-chip.pressable', {
        'aria-label': t('stopSound', { name: this._title(id) }),
        onclick: () => this._toggleSound(id),
      }, icon(this.meta[id].icon, true), h('span', {}, this._title(id)), pct, icon('close')));
    });
  }

  _setFilter(cat) {
    this.filter = cat;
    document.querySelectorAll('#filters .chip').forEach(chip => {
      chip.classList.toggle('selected', chip.dataset.filter === cat);
    });
    document.querySelectorAll('.sound-group').forEach(group => {
      group.classList.toggle('filtered-out', cat !== 'All' && group.dataset.category !== cat);
    });
  }

  // ─── Sons personnalisés ────────────────────────────

  async _loadCustomSounds() {
    try {
      const records = await this._db.getAll();
      records.forEach(record => this._mountCustomSound(record));
    } catch (e) {
      console.warn('IndexedDB load failed:', e);
    }
  }

  _mountCustomSound(record) {
    const { id, name, blob } = record;
    const iconName = record.icon || 'music_note';
    this.custom.set(id, { ...record, icon: iconName });
    this.states[id] = { active: false, volume: 0.5 };
    this.meta[id]   = { title: name, icon: iconName, category: CUSTOM_CATEGORY, custom: true };
    this.engine.register(id, { blob }, {
      maxSeconds: CUSTOM_MAX_SECONDS,
      onTrim: () => this._snack(t('trimmed', { name: this._title(id), n: CUSTOM_MAX_SECONDS / 60 })),
    });
    $('customRows').appendChild(this._makeRow(id));
  }

  _pickFile() {
    $('customSoundFile').click();
  }

  _importDialog(file) {
    let chosen = 'music_note';
    const input = h('input', { type: 'text', value: cleanFileName(file.name), maxlength: '40', autocomplete: 'off' });
    const grid  = this._iconGrid(chosen, v => { chosen = v; });
    const ext   = (file.name.match(/\.([^.]+)$/)?.[1] || 'audio').toUpperCase();
    const size  = file.size >= 1e6 ? `${(file.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1e3))} KB`;

    const dlg = this._dialog({
      title: t('importSound'),
      body: [
        h('div.picked-file', {}, icon('audio_file'),
          h('span', {}, h('strong', {}, file.name), h('small', {}, t('audioFile', { ext, size })))),
        h('label.outlined-field', {}, input, h('span', {}, t('displayName'))),
        h('p.dialog-label', {}, t('icon')),
        grid,
      ],
      actions: [
        { label: t('cancel') },
        { label: t('import'), id: 'ok', onClick: () => this._addCustomSound(file, input.value.trim() || cleanFileName(file.name), chosen) },
      ],
    });
    input.addEventListener('input', () => { dlg.buttons.ok.disabled = !input.value.trim(); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && input.value.trim()) dlg.buttons.ok.click(); });
  }

  async _addCustomSound(file, name, iconName) {
    const record = { id: 'custom_' + Date.now(), name, blob: file, icon: iconName };
    try {
      await this._db.add(record);
    } catch (_) {
      this._snack(t('couldNotSave'));
      return;
    }
    this._mountCustomSound(record);
    this._renderRow(record.id);
    this._setFilter(this.filter === 'All' ? 'All' : CUSTOM_CATEGORY);
    this._snack(t('added', { name }));
    this.rows[record.id]?.row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  _customSoundMenu(id, anchor) {
    this._menu(anchor, [
      { icon: 'edit',    label: t('rename'),     action: () => this._renameSoundDialog(id) },
      { icon: 'palette', label: t('changeIcon'), action: () => this._iconDialog(id) },
      { icon: 'delete',  label: t('delete'),     action: () => this._deleteSoundDialog(id), danger: true },
    ]);
  }

  _renameSoundDialog(id) {
    this._textDialog({
      title: t('renameSound'), label: t('displayName'), value: this._title(id),
      onSave: name => {
        this.meta[id].title = name;
        this._relabelRow(id);
        this._persistCustom(id, { name });
        this._renderChips();
        this._updateMediaSession();
      },
    });
  }

  _iconDialog(id) {
    let chosen = this.meta[id].icon;
    this._dialog({
      title: t('changeIcon'),
      body: [this._iconGrid(chosen, v => { chosen = v; })],
      actions: [
        { label: t('cancel') },
        { label: t('save'), onClick: () => {
          this.meta[id].icon = chosen;
          this.rows[id].glyph.textContent = chosen;
          this._persistCustom(id, { icon: chosen });
          this._renderChips();
        } },
      ],
    });
  }

  _deleteSoundDialog(id) {
    this._dialog({
      icon: 'delete',
      title: t('deleteSoundQ'),
      body: [h('p.dialog-body', {}, t('deleteSoundBody', { name: this._title(id) }))],
      actions: [
        { label: t('cancel') },
        { label: t('delete'), danger: true, onClick: () => this._deleteCustomSound(id) },
      ],
    });
  }

  _persistCustom(id, changes) {
    const record = this.custom.get(id);
    if (!record) return;
    Object.assign(record, changes);
    this._db.put(record).catch(() => this._snack(t('couldNotSaveChanges')));
  }

  async _deleteCustomSound(id) {
    const title = this._title(id);
    // Arrête la lecture, libère le buffer PCM et purge son cache
    this.engine.unregister(id);
    delete this.states[id];
    delete this.meta[id];
    this.custom.delete(id);

    try { await this._db.remove(id); } catch (_) {}

    this.rows[id]?.row.remove();
    delete this.rows[id];
    if (this.isPlaying && !this._activeIds().length) this._setPlaying(false);
    this._afterStateChange();
    this._snack(t('deleted', { name: title }));
  }

  _iconGrid(selected, onPick) {
    const grid = h('div.icon-grid', { role: 'radiogroup' });
    CUSTOM_ICONS.forEach(name => {
      grid.appendChild(h('button.pressable' + (name === selected ? '.selected' : ''), {
        role: 'radio', 'aria-label': name.replace(/_/g, ' '),
        onclick: e => {
          grid.querySelectorAll('.selected').forEach(b => b.classList.remove('selected'));
          e.currentTarget.classList.add('selected');
          onPick(name);
          this._haptic('tick');
        },
      }, icon(name)));
    });
    return grid;
  }

  // ─── Activation des sons ───────────────────────────

  _toggleSound(name) {
    if (!this.states[name]) return;
    this._setActive(name, !this.states[name].active);
    this._haptic('tick');
  }

  _setActive(name, active) {
    const state = this.states[name];
    if (!state || state.active === active) return;
    const wasSilent = !this._activeIds().length;
    state.active = active;
    this.activePreset = null;

    if (active) {
      // « Tap a sound to start » : le premier son lancé démarre la lecture.
      if (this.isPlaying) this._playSound(name);
      else if (wasSilent) this._setPlaying(true);
    } else {
      this._pauseSound(name);
      if (this.isPlaying && !this._activeIds().length) this._setPlaying(false);
    }
    this._renderRow(name);
    this._afterStateChange();
  }

  _afterStateChange() {
    this._renderChips();
    this._saveSettings();
    this._updateMediaSession();
  }

  _activeIds() {
    return Object.keys(this.states).filter(id => this.states[id].active);
  }

  // ─── Play / Pause ──────────────────────────────────

  async _setPlaying(playing) {
    this.isPlaying = playing;
    this._renderPlayButton();

    const active = this._activeIds();

    if (playing) {
      clearTimeout(this._suspendTimer);
      try {
        // Doit partir d'un geste utilisateur la première fois (autoplay).
        await this.engine.ensureContext();
      } catch (_) {
        this.isPlaying = false;
        this._renderPlayButton();
        this._snack(t('audioUnavailable'));
        return;
      }
      if (!this.timer?.fading) this.engine.setMasterVolume(this.masterVol);
      active.forEach(name => this._playSound(name));
    } else {
      active.forEach(name => this._pauseSound(name));
      // Laisse le fondu se terminer, puis gèle le thread audio : CPU nul.
      clearTimeout(this._suspendTimer);
      this._suspendTimer = setTimeout(() => {
        if (!this.isPlaying) this.engine.suspend();
      }, 400);
    }

    this._saveSettings();
    this._updateMediaSession();
  }

  _renderPlayButton() {
    const btn = $('playBtn');
    btn.classList.toggle('playing', this.isPlaying);
    btn.setAttribute('aria-label', t(this.isPlaying ? 'pause' : 'play'));
    $('playIcon').textContent = this.isPlaying ? 'pause' : 'play_arrow';
  }

  _togglePlay() {
    if (!this.isPlaying && !this._activeIds().length) {
      this._snack(t('tapToStart'));
      return;
    }
    this._haptic('confirm');
    this._setPlaying(!this.isPlaying);
  }

  // ─── Minuteur de sommeil ───────────────────────────

  _startTimer(minutes, fade) {
    this._cancelTimer(true);
    this.timer = { endAt: Date.now() + minutes * 60000, minutes, fade, fading: false };
    // Un tick par seconde suffit ; quand l'app est masquée on ne touche pas au
    // DOM, et Chrome ne bride pas les timers d'une page qui joue du son.
    this._timerTick = setInterval(() => this._tickTimer(), 1000);
    this._tickTimer();
    this._snack(t('timerSet', { time: minutesLabel(minutes) }));
  }

  _extendTimer(minutes) {
    if (!this.timer) return;
    if (this.timer.fading) {
      this.timer.fading = false;
      this.engine.setMasterVolume(this.masterVol);
    }
    this.timer.endAt += minutes * 60000;
    this._tickTimer();
  }

  _cancelTimer(silent = false) {
    if (!this.timer) return;
    clearInterval(this._timerTick);
    if (this.timer.fading) this.engine.setMasterVolume(this.masterVol);
    this.timer = null;
    this._renderTimer();
    if (!silent) this._snack(t('timerOff'));
  }

  _tickTimer() {
    const t = this.timer;
    if (!t) return;
    const left = t.endAt - Date.now();

    if (left <= 0) {
      clearInterval(this._timerTick);
      this.timer = null;
      this._renderTimer();
      if (this.isPlaying) this._setPlaying(false);
      // Rétablit le volume après l'arrêt : la prochaine lecture repart normale.
      setTimeout(() => this.engine.setMasterVolume(this.masterVol), 600);
      return;
    }
    if (t.fade && !t.fading && left <= TIMER_FADE_MS && this.isPlaying) {
      t.fading = true;
      this.engine.fadeMaster(0, left / 1000);
    }
    if (!document.hidden) this._renderTimer(left);
  }

  _renderTimer(left = this.timer ? this.timer.endAt - Date.now() : 0) {
    const label = $('timerLabel');
    const btn   = $('timerBtn');
    const on    = Boolean(this.timer);
    btn.classList.toggle('running', on);
    btn.firstElementChild.classList.toggle('filled', on);
    label.classList.toggle('hidden', !on);
    if (on) {
      const text = t('stopsIn', { time: formatDuration(left) });
      if (label.dataset.text !== text) {
        label.dataset.text = text;
        label.replaceChildren(icon('bedtime', true), text);
      }
    }
    if (this._timerSheetClock) this._timerSheetClock.textContent = on ? formatDuration(left) : '';
  }

  _openTimerSheet() {
    this._sheet(t('sleepTimer'), (body, close) => {
      if (this.timer) {
        const clock = h('strong', {}, formatDuration(this.timer.endAt - Date.now()));
        this._timerSheetClock = clock;
        const at = new Date(this.timer.endAt).toLocaleTimeString(currentLang, { hour: '2-digit', minute: '2-digit' });
        body.append(
          h('div.timer-status', {}, icon('bedtime', true),
            h('div', {}, clock, h('small', {}, t('stopsAt', { time: at }) + (this.timer.fade ? ' · ' + t('fadesOut') : '')))),
          h('div.sheet-actions', {},
            h('button.outlined-button.wide.pressable', { onclick: () => { this._extendTimer(15); this._haptic('tick'); } },
              icon('more_time'), t('add15')),
            h('button.filled-button.wide.pressable', { onclick: () => { this._cancelTimer(); close(); } },
              icon('timer_off'), t('turnOffTimer'))),
        );
        return () => { this._timerSheetClock = null; };
      }

      let minutes = this.ui.timerMinutes;
      let fade    = this.ui.timerFade;
      const isCustom = !TIMER_CHOICES.includes(minutes);

      const customInput = h('input', { type: 'text', inputmode: 'numeric', value: String(minutes), maxlength: '3' });
      const customField = h('div' + (isCustom ? '' : '.hidden'), { style: 'padding: 16px 8px 0' },
        h('label.outlined-field', {}, customInput, h('span', {}, t('minutes'))));

      const chips = h('div.choice-grid', { role: 'radiogroup' });
      const select = (chip, value) => {
        chips.querySelectorAll('.selected').forEach(c => c.classList.remove('selected'));
        chip.classList.add('selected');
        customField.classList.toggle('hidden', value !== 'custom');
        if (value === 'custom') { customInput.focus(); customInput.select(); }
        else minutes = value;
        this._haptic('tick');
      };
      [...TIMER_CHOICES, 'custom'].forEach(value => {
        const selected = value === 'custom' ? isCustom : value === minutes;
        const chip = h('button.chip.pressable' + (selected ? '.selected' : ''), { role: 'radio' },
          icon('check'), value === 'custom' ? t('custom') : minutesLabel(value));
        chip.addEventListener('click', () => select(chip, value));
        chips.appendChild(chip);
      });

      const sw = h('span.switch' + (fade ? '.on' : ''));
      const fadeItem = h('button.list-item.two-line.pressable', {
        role: 'switch', 'aria-checked': String(fade),
        onclick: () => { fade = !fade; sw.classList.toggle('on', fade); fadeItem.setAttribute('aria-checked', String(fade)); this._haptic('tick'); },
      }, icon('trending_down'), h('span.text', {}, h('strong', {}, t('fadeOut')), h('small', {}, t('fadeOutSub'))), sw);

      const start = () => {
        if (!customField.classList.contains('hidden')) {
          const m = parseInt(customInput.value, 10);
          if (!(m >= 1 && m <= 720)) { this._snack(t('minutesRange')); return; }
          minutes = m;
        }
        this.ui.timerMinutes = minutes;
        this.ui.timerFade = fade;
        this._saveUi();
        this._startTimer(minutes, fade);
        this._haptic('confirm');
        close();
      };
      customInput.addEventListener('keydown', e => { if (e.key === 'Enter') start(); });

      body.append(chips, customField, h('div', { style: 'height: 8px' }), fadeItem,
        h('div.sheet-actions', {}, h('button.filled-button.wide.pressable', { onclick: start }, icon('bedtime'), t('startTimer'))));
    });
  }

  // ─── Mixes (presets) ───────────────────────────────

  _openMixesSheet() {
    this._sheet(t('mixes'), body => {
      const save = h('button.tonal-button.save-mix.pressable', { onclick: () => this._saveMixDialog() },
        icon('add'), t('saveCurrentMix'));
      const list = h('div.mix-list');
      body.append(save, list);
      this._mixList = list;
      this._renderMixes();
      return () => { this._mixList = null; };
    });
  }

  _renderMixes() {
    const list = this._mixList;
    if (!list) return;
    list.replaceChildren();
    if (!this.presets.length) {
      list.appendChild(h('div.mix-empty', {}, icon('library_music'),
        t('noMixes'), h('br'), t('noMixesHint')));
      return;
    }
    [...this.presets].sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0)).forEach(preset => {
      const ids = Object.entries(preset.sounds ?? {}).filter(([id, s]) => s.active && this.meta[id]).map(([id]) => id);
      const current = preset.id === this.activePreset;
      list.appendChild(h('div.mix-row.pressable' + (current ? '.current' : ''), {
        role: 'button', tabindex: '0',
        onclick: () => this._loadPreset(preset),
      },
        h('span.mix-avatar', {}, current ? icon('graphic_eq', true) : (preset.name.trim()[0] || '?').toUpperCase()),
        h('span.mix-copy', {},
          h('strong', {}, preset.name),
          h('span.mix-meta', {},
            h('span.mix-icons', {}, ids.slice(0, 5).map(id => icon(this.meta[id].icon))),
            h('span.mix-sub', {}, `${t('sounds', { n: ids.length })} · ${relativeDay(preset.usedAt)}`))),
        h('button.row-more.icon-button.pressable', {
          'aria-label': t('optionsOf', { name: preset.name }),
          onclick: e => { e.stopPropagation(); this._mixMenu(preset, e.currentTarget); },
        }, icon('more_vert')),
      ));
    });
  }

  _mixMenu(preset, anchor) {
    this._menu(anchor, [
      { icon: 'edit',    label: t('rename'),             action: () => this._renameMixDialog(preset) },
      { icon: 'save_as', label: t('replaceWithCurrent'), action: () => this._overwriteMix(preset) },
      { icon: 'delete',  label: t('delete'),             action: () => this._deletePreset(preset), danger: true },
    ]);
  }

  _currentSounds() {
    return Object.fromEntries(
      Object.entries(this.states).map(([n, s]) => [n, { active: s.active, volume: s.volume }])
    );
  }

  _saveMixDialog() {
    if (!this._activeIds().length) {
      this._snack(t('turnOnFirst'));
      return;
    }
    this._textDialog({
      title: t('saveCurrentMix'), label: t('mixName'), value: '', action: t('save'),
      onSave: name => this._savePreset(name),
    });
  }

  _savePreset(name) {
    const preset = {
      id: Date.now().toString(), name,
      masterVol: this.masterVol,
      sounds: this._currentSounds(),
      usedAt: Date.now(),
    };
    this.presets.push(preset);
    this.activePreset = preset.id;
    this._saveJSON(PRESETS_KEY, this.presets);
    this._renderMixes();
    this._updateMediaSession();
    this._snack(t('mixSaved', { name }));
  }

  _renameMixDialog(preset) {
    this._textDialog({
      title: t('renameMix'), label: t('mixName'), value: preset.name,
      onSave: name => {
        preset.name = name;
        this._saveJSON(PRESETS_KEY, this.presets);
        this._renderMixes();
        this._updateMediaSession();
      },
    });
  }

  _overwriteMix(preset) {
    if (!this._activeIds().length) { this._snack(t('turnOnFirst')); return; }
    preset.sounds = this._currentSounds();
    preset.masterVol = this.masterVol;
    preset.usedAt = Date.now();
    this.activePreset = preset.id;
    this._saveJSON(PRESETS_KEY, this.presets);
    this._renderMixes();
    this._snack(t('mixUpdated', { name: preset.name }));
  }

  _loadPreset(preset) {
    this.masterVol = preset.masterVol ?? 0.8;
    this._renderMaster();
    if (!this.timer?.fading) this.engine.setMasterVolume(this.masterVol);

    const wasSilent = !this._activeIds().length;
    Object.keys(this.states).forEach(name => {
      const wanted = preset.sounds?.[name];
      const s = this.states[name];
      const nextActive = Boolean(wanted?.active);
      if (wanted) s.volume = wanted.volume;
      this.engine.setVolume(name, s.volume);
      if (s.active && !nextActive) this._pauseSound(name);
      if (!s.active && nextActive && this.isPlaying) this._playSound(name);
      s.active = nextActive;
      this._renderRow(name);
    });

    preset.usedAt = Date.now();
    this.activePreset = preset.id;
    this._saveJSON(PRESETS_KEY, this.presets);
    this._closeTop();
    this._afterStateChange();
    this._haptic('confirm');
    this._snack(t('mixApplied', { name: preset.name }));
    // Appliquer un mix est un geste utilisateur : on lance la lecture si rien ne jouait.
    if (!this.isPlaying && wasSilent && this._activeIds().length) this._setPlaying(true);
  }

  _deletePreset(preset) {
    const index = this.presets.indexOf(preset);
    if (index < 0) return;
    this.presets.splice(index, 1);
    if (this.activePreset === preset.id) this.activePreset = null;
    this._saveJSON(PRESETS_KEY, this.presets);
    this._renderMixes();
    this._snack(t('mixDeleted'), {
      action: t('undo'),
      onAction: () => {
        this.presets.splice(Math.min(index, this.presets.length), 0, preset);
        this._saveJSON(PRESETS_KEY, this.presets);
        this._renderMixes();
      },
    });
  }

  // ─── Paramètres ────────────────────────────────────

  _openSettings() {
    this._screen('settings', body => {
      const modeRow = h('div.segmented', { role: 'radiogroup', 'aria-label': t('theme') });
      MODES.forEach(m => {
        modeRow.appendChild(h('button.pressable' + (this.ui.mode === m.id ? '.selected' : ''), {
          role: 'radio', 'aria-checked': String(this.ui.mode === m.id),
          onclick: e => {
            modeRow.querySelectorAll('button').forEach(b => { b.classList.remove('selected'); b.setAttribute('aria-checked', 'false'); });
            e.currentTarget.classList.add('selected');
            e.currentTarget.setAttribute('aria-checked', 'true');
            this._setUi({ mode: m.id });
          },
        }, icon(m.icon), t('mode.' + m.id)));
      });

      const swatches = h('div.swatches', { role: 'radiogroup', 'aria-label': t('color') });
      PALETTES.forEach(id => {
        const p = { id };
        swatches.appendChild(h('button.swatch.pressable' + (this.ui.palette === p.id ? '.selected' : ''), {
          role: 'radio', 'aria-checked': String(this.ui.palette === p.id),
          onclick: e => {
            swatches.querySelectorAll('.swatch').forEach(b => { b.classList.remove('selected'); b.setAttribute('aria-checked', 'false'); });
            e.currentTarget.classList.add('selected');
            e.currentTarget.setAttribute('aria-checked', 'true');
            this._setUi({ palette: p.id });
          },
        }, h('span.swatch-dot', { dataset: { palette: p.id } }, icon('check')), t('palette.' + p.id)));
      });

      const langName = this.ui.lang === 'system'
        ? `${t('languageSystem')} (${LANGUAGES.find(l => l.id === currentLang).name})`
        : LANGUAGES.find(l => l.id === this.ui.lang)?.name;

      body.append(
        h('h2.section-label', {}, t('appearance')),
        h('div.list-item.two-line', {}, icon('palette'),
          h('span.text', {}, h('strong', {}, t('theme')), h('small', {}, t('themeSub')))),
        modeRow,
        h('div.list-item', {}, icon('format_paint'), h('span.text', {}, h('strong', {}, t('color')))),
        swatches,
        this._switchItem('contrast', t('pureBlack'), t('pureBlackSub'), this.ui.black,
          v => this._setUi({ black: v })),
        h('button.list-item.two-line.pressable', { onclick: () => this._languageDialog() },
          icon('language'), h('span.text', {}, h('strong', {}, t('language')), h('small', {}, langName))),
        h('hr'),
        h('h2.section-label', {}, t('behavior')),
        this._switchItem('vibration', t('haptics'), t('hapticsSub'), this.ui.haptics,
          v => this._setUi({ haptics: v })),
        h('hr'),
        h('h2.section-label', {}, t('about')),
        h('button.list-item.pressable', { onclick: () => this._openHelp() },
          icon('help'), h('span.text', {}, h('strong', {}, t('howToUse')))),
        h('div.about-card', {}, h('img', { src: 'icons/icon-192.png', alt: '' }),
          h('div', {}, h('strong', {}, 'Blanket'), h('small', {}, t('version', { v: APP_VERSION })))),
        h('p.credit', {}, t('credit')),
      );
    });
  }

  // ─── Langue ────────────────────────────────────────

  _languageDialog() {
    const options = [{ id: 'system', name: t('languageSystem') }, ...LANGUAGES];
    let dlg;
    const list = h('div.radio-list', { role: 'radiogroup' },
      options.map(o => h('button.radio-row.pressable' + (this.ui.lang === o.id ? '.selected' : ''), {
        role: 'radio', 'aria-checked': String(this.ui.lang === o.id), lang: o.id === 'system' ? null : o.id,
        onclick: () => {
          dlg.close();
          if (o.id === this.ui.lang) return;
          this._setUi({ lang: o.id });
          this._applyLanguage();
        },
      }, h('span.radio'), o.name)));
    dlg = this._dialog({ title: t('language'), body: [list], actions: [{ label: t('cancel') }] });
  }

  /** Textes posés en dur dans index.html (data-i18n / data-i18n-label). */
  _translateStatic() {
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-label]').forEach(el => el.setAttribute('aria-label', t(el.dataset.i18nLabel)));
  }

  _relabelRow(id) {
    const r = this.rows[id];
    if (!r) return;
    const title = this._title(id);
    r.name.textContent = title;
    r.toggle.setAttribute('aria-label', title);
    r.slider.setAttribute('aria-label', t('volumeOf', { name: title }));
    r.more?.setAttribute('aria-label', t('optionsOf', { name: title }));
  }

  /** Change de langue sans recharger la page : la lecture ne doit pas s'interrompre. */
  _applyLanguage() {
    setLanguage(this.ui.lang);
    this._translateStatic();
    this._buildFilters();
    this._setFilter(this.filter);
    document.querySelectorAll('.sound-group').forEach(g => {
      g.querySelector('.section-label').textContent = catLabel(g.dataset.category);
    });
    document.querySelector('.add-label').textContent = t('importASound');
    Object.keys(this.rows).forEach(id => this._relabelRow(id));
    this._renderChips();
    this._renderPlayButton();
    $('timerLabel').dataset.text = '';
    this._renderTimer();
    this._updateMediaSession();
    // Les écrans ouverts (Paramètres, mode d'emploi) se reconstruisent.
    this._stack.forEach(l => l.rebuild?.());
  }

  // ─── Mode d'emploi ─────────────────────────────────

  _openHelp() {
    const sections = [
      ['touch_app',     'start'],
      ['tune',          'mix'],
      ['library_music', 'save'],
      ['bedtime',       'timer'],
      ['audio_file',    'import'],
      ['lock',          'night'],
      ['battery_alert', 'battery'],
      ['eco',           'oled'],
    ];
    let layer;
    layer = this._screen('howToUse', body => {
      body.append(
        h('p.help-intro', {}, t('helpIntro')),
        ...sections.map(([iconName, key]) => h('div.help-item', {},
          h('span.help-icon', {}, icon(iconName)),
          h('div', {}, h('strong', {}, t(`help.${key}.t`)), h('p', {}, t(`help.${key}.d`))))),
        h('div.help-done', {}, h('button.filled-button.wide.pressable', { onclick: () => layer.close() }, t('gotIt'))),
      );
    });
    if (!this.ui.seenHelp) this._setUi({ seenHelp: true });
  }

  _switchItem(iconName, title, subtitle, value, onChange) {
    const sw = h('span.switch' + (value ? '.on' : ''));
    const item = h('button.list-item.two-line.pressable', {
      role: 'switch', 'aria-checked': String(value),
      onclick: () => {
        value = !value;
        sw.classList.toggle('on', value);
        item.setAttribute('aria-checked', String(value));
        onChange(value);
        this._haptic('tick');
      },
    }, icon(iconName), h('span.text', {}, h('strong', {}, title), h('small', {}, subtitle)), sw);
    return item;
  }

  _setUi(changes) {
    Object.assign(this.ui, changes);
    this._saveUi();
    this._applyTheme();
  }

  _saveUi() { this._saveJSON(UI_KEY, this.ui); }

  _applyTheme() {
    const d = document.documentElement;
    d.dataset.mode    = this.ui.mode;
    d.dataset.palette = this.ui.palette;
    if (this.ui.black) d.dataset.black = ''; else delete d.dataset.black;
    this._syncSystemBars();
  }

  _isLight() {
    return this.ui.mode === 'light'
      || (this.ui.mode === 'system' && matchMedia('(prefers-color-scheme: light)').matches);
  }

  /** Couleur de surface courante en #rrggbb (les rôles sont en oklch). */
  _surfaceHex() {
    const css = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim();
    try {
      const c = (this._colorCanvas ||= document.createElement('canvas')).getContext('2d', { willReadFrequently: true });
      c.clearRect(0, 0, 1, 1);
      c.fillStyle = css;
      c.fillRect(0, 0, 1, 1);
      const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
      return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    } catch (_) {
      return '#070f1f';
    }
  }

  _syncSystemBars() {
    const color = this._surfaceHex();
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
    this._nativeUi?.call('setSystemBars', { light: this._isLight(), color }).catch(() => {});
  }

  // ─── Calques : menus, feuilles, dialogues, écrans ──

  /** Empile un calque ; `close` le retire (animation de sortie comprise). */
  _pushLayer(el, { onClose, className = 'closing', duration = 220 } = {}) {
    document.body.appendChild(el);
    document.body.classList.add('overlay-open');
    const layer = { el, closed: false };
    layer.close = () => {
      if (layer.closed) return;
      layer.closed = true;
      this._stack = this._stack.filter(l => l !== layer);
      if (!this._stack.length) document.body.classList.remove('overlay-open');
      onClose?.();
      el.classList.add(className);
      setTimeout(() => el.remove(), duration);
      this._syncHistory();
    };
    this._stack.push(layer);
    this._syncHistory();
    return layer;
  }

  /**
   * Navigateur seulement (l'APK passe par le retour natif) : le bouton retour
   * doit fermer le calque du dessus, pas quitter la page. On tient pour ça UNE
   * entrée d'historique tant qu'un calque est ouvert. Une par calque ne marche
   * pas : history.back() est asynchrone, et fermer puis rouvrir aussitôt (menu
   * → dialogue) ferait reculer au-delà de la page.
   */
  _syncHistory() {
    if (this._nativeUi || this._pendingBack) return;
    if (this._stack.length && !this._hasSentinel) {
      history.pushState({ blanketLayer: true }, '');
      this._hasSentinel = true;
    } else if (!this._stack.length && this._hasSentinel) {
      this._hasSentinel = false;
      this._pendingBack = true;
      history.back();
    }
  }

  _onPopState() {
    if (this._pendingBack) {
      // Retour que nous avons demandé nous-mêmes ; un calque a pu s'ouvrir
      // entre-temps et doit retrouver son entrée.
      this._pendingBack = false;
      this._syncHistory();
      return;
    }
    // Retour de l'utilisateur : l'entrée sentinelle vient d'être consommée.
    this._hasSentinel = false;
    const top = this._stack[this._stack.length - 1];
    if (top) top.close();
    else this._syncHistory();
  }

  _closeTop() {
    const top = this._stack[this._stack.length - 1];
    if (top) { top.close(); return true; }
    return false;
  }

  _menu(anchor, items) {
    const menu = h('div.popup-menu', { role: 'menu' });
    const layerEl = h('div.menu-layer', {}, menu);
    let layer;
    layerEl.addEventListener('click', e => { if (e.target === layerEl) layer.close(); });
    items.forEach(item => {
      menu.appendChild(h('button.pressable' + (item.danger ? '.danger' : ''), {
        role: 'menuitem',
        onclick: () => { layer.close(); item.action(); },
      }, icon(item.icon), item.label));
    });

    layer = this._pushLayer(layerEl, { duration: 120 });
    menu.classList.remove('closing');
    layer.close = (orig => () => { menu.classList.add('closing'); orig(); })(layer.close);

    // Aligné sur le bord droit du bouton, ouvert vers le bas (ou le haut si
    // la place manque en bas de l'écran).
    const r  = anchor.getBoundingClientRect();
    const mh = menu.offsetHeight;
    const right = Math.max(8, window.innerWidth - r.right);
    menu.style.right = right + 'px';
    if (r.bottom + mh + 8 > window.innerHeight - 8) {
      menu.style.top = Math.max(8, r.top - mh) + 'px';
      menu.style.transformOrigin = 'bottom right';
    } else {
      menu.style.top = r.bottom - 8 + 'px';
    }
    menu.querySelector('button')?.focus({ preventScroll: true });
  }

  /** build(body, close) peut renvoyer une fonction de nettoyage. */
  _sheet(title, build) {
    const body   = h('div.sheet-body');
    const grab   = h('div.sheet-grab', {}, h('div.drag-handle'), h('h2.sheet-title', {}, title));
    const sheet  = h('div.bottom-sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, grab, body);
    const scrim  = h('div.scrim');
    const layerEl = h('div.overlay', {}, scrim, sheet);
    let cleanup;
    const layer = this._pushLayer(layerEl, { onClose: () => cleanup?.(), duration: 220 });
    scrim.addEventListener('click', () => layer.close());
    cleanup = build(body, () => layer.close());

    // Glisser vers le bas pour fermer, depuis la poignée ou le titre.
    let startY = null, lastY = 0, lastT = 0, velocity = 0;
    grab.addEventListener('pointerdown', e => {
      startY = lastY = e.clientY; lastT = e.timeStamp; velocity = 0;
      sheet.style.transition = 'none';
      grab.setPointerCapture(e.pointerId);
    });
    grab.addEventListener('pointermove', e => {
      if (startY === null) return;
      const dy = Math.max(0, e.clientY - startY);
      velocity = (e.clientY - lastY) / Math.max(1, e.timeStamp - lastT);
      lastY = e.clientY; lastT = e.timeStamp;
      sheet.style.transform = `translateY(${dy}px)`;
    });
    const release = e => {
      if (startY === null) return;
      const dy = Math.max(0, e.clientY - startY);
      startY = null;
      sheet.style.transition = '';
      if (dy > sheet.offsetHeight * 0.3 || velocity > 0.6) {
        sheet.style.transform = 'translateY(100%)';
        layer.close();
      } else {
        sheet.style.transform = '';
      }
    };
    grab.addEventListener('pointerup', release);
    grab.addEventListener('pointercancel', release);
    return layer;
  }

  /**
   * actions : [{ label, onClick?, danger?, id? }] — chaque bouton ferme le
   * dialogue ; onClick est appelé après la fermeture.
   */
  _dialog({ icon: iconName, title, body = [], actions = [] }) {
    const buttons = {};
    const actionsEl = h('div.dialog-actions');
    const dialog = h('div.dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      iconName && h('span.icon.dialog-icon', {}, iconName),
      h('h2', {}, title), ...body, actionsEl);
    const scrim = h('div.scrim');
    const layerEl = h('div.overlay.dialog-layer', {}, scrim, dialog);
    const layer = this._pushLayer(layerEl, { duration: 160 });
    scrim.addEventListener('click', () => layer.close());

    actions.forEach(a => {
      const btn = h('button.text-button.pressable' + (a.danger ? '.danger' : ''), {
        onclick: () => { layer.close(); a.onClick?.(); },
      }, a.label);
      if (a.id) buttons[a.id] = btn;
      actionsEl.appendChild(btn);
    });

    const input = dialog.querySelector('input[type="text"]');
    if (input) setTimeout(() => { input.focus(); input.select(); }, 80);
    return { ...layer, buttons, close: layer.close };
  }

  _textDialog({ title, label, value, action = 'Save', onSave }) {
    const input = h('input', { type: 'text', value, maxlength: '40', autocomplete: 'off', enterkeyhint: 'done' });
    const dlg = this._dialog({
      title,
      body: [h('label.outlined-field', {}, input, h('span', {}, label))],
      actions: [
        { label: t('cancel') },
        { label: action, id: 'ok', onClick: () => onSave(input.value.trim()) },
      ],
    });
    const sync = () => { dlg.buttons.ok.disabled = !input.value.trim(); };
    sync();
    input.addEventListener('input', sync);
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && input.value.trim()) dlg.buttons.ok.click(); });
  }

  /** titleKey : clé i18n du titre ; l'écran se reconstruit si la langue change. */
  _screen(titleKey, build) {
    const body  = h('div.screen-body');
    const title = h('h1');
    const back  = h('button.icon-button.pressable', { onclick: () => layer.close() }, icon('arrow_back'));
    const screen = h('section.screen', { role: 'dialog' }, h('header.screen-bar', {}, back, title), body);
    body.addEventListener('scroll', () => screen.classList.toggle('scrolled', body.scrollTop > 4), { passive: true });
    const layer = this._pushLayer(screen, { duration: 240 });
    layer.rebuild = () => {
      title.textContent = t(titleKey);
      screen.setAttribute('aria-label', t(titleKey));
      back.setAttribute('aria-label', t('back'));
      const scroll = body.scrollTop;
      body.replaceChildren();
      build(body);
      body.scrollTop = scroll;
    };
    layer.rebuild();
    return layer;
  }

  _about() {
    this._dialog({
      title: 'Blanket',
      body: [h('p.dialog-body', {},
        t('version', { v: APP_VERSION }), h('br'), h('br'),
        t('aboutBody'),
        h('br'), h('br'),
        t('basedOn'))],
      actions: [{ label: t('ok') }],
    });
  }

  // ─── Snackbar ──────────────────────────────────────

  _snack(text, { action, onAction, duration } = {}) {
    const bar = $('snackbar');
    const btn = $('snackbarAction');
    $('snackbarText').textContent = text;
    btn.classList.toggle('hidden', !action);
    btn.textContent = action || '';
    this._snackAction = onAction || null;
    bar.classList.add('show');
    clearTimeout(this._snackTimer);
    this._snackTimer = setTimeout(() => bar.classList.remove('show'), duration ?? (action ? 5000 : 2800));
  }

  // ─── Retour haptique ───────────────────────────────

  _haptic(kind = 'tick') {
    if (!this.ui.haptics) return;
    if (this._nativeUi) {
      this._nativeUi.call('haptic', { kind }).catch(() => {});
    } else if (navigator.vibrate && matchMedia('(pointer: coarse)').matches) {
      try { navigator.vibrate(kind === 'confirm' ? 12 : 6); } catch (_) {}
    }
  }

  // ─── Media Session (notification / écran verrouillé) ─

  _initMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms  = navigator.mediaSession;
    const set = (action, handler) => {
      try { ms.setActionHandler(action, handler); } catch (_) {}
    };

    set('play',  () => this._setPlaying(true));
    set('pause', () => this._setPlaying(false));
    set('stop',  () => this._setPlaying(false));

    // Pas de notion de piste ici : on retire les contrôles que le système
    // afficherait par défaut.
    ['previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'seekto']
      .forEach(action => set(action, null));

    this._updateMediaSession();
  }

  /** Publie l'état courant sur toutes les surfaces disponibles. */
  _updateMediaSession() {
    const active = this._activeTitles();
    this._syncNative(active);

    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;

    const preset = this.presets.find(p => p.id === this.activePreset);

    try {
      ms.metadata = new MediaMetadata({
        title:   active.length ? active.join(' + ') : t('noSounds'),
        artist:  preset ? preset.name : t('ambientMix'),
        album:   'Blanket',
        artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
      });
    } catch (_) {}

    ms.playbackState = this.isPlaying ? 'playing' : 'paused';
  }

  // ─── Pont natif (APK Android) ───────────────────────

  _activeTitles() {
    return this._activeIds().map(id => this.meta[id]?.title || id);
  }

  /**
   * L'app ne charge pas @capacitor/core : le bridge injecté dans la WebView
   * n'expose donc ni `registerPlugin` ni `Capacitor.Plugins` proxifié, mais les
   * primitives `nativePromise` / `addListener`. On appelle le plugin par là.
   */
  _resolveNative(plugin) {
    const cap = window.Capacitor;
    if (!cap || typeof cap.nativePromise !== 'function') return null;
    if (typeof cap.isNativePlatform === 'function' && !cap.isNativePlatform()) return null;

    return {
      call:   (method, options) => cap.nativePromise(plugin, method, options ?? {}),
      listen: (event, callback)  => cap.addListener(plugin, event, callback),
    };
  }

  _initNative() {
    if (this._nativeUi) {
      document.documentElement.classList.add('native');
      const applyInsets = insets => {
        if (!insets) return;
        const s = document.documentElement.style;
        s.setProperty('--inset-top',    (insets.top    || 0) + 'px');
        s.setProperty('--inset-bottom', (insets.bottom || 0) + 'px');
        s.setProperty('--ime',          (insets.ime    || 0) + 'px');
      };
      this._nativeUi.call('getInsets').then(applyInsets).catch(() => {});
      this._nativeUi.listen('insets', applyInsets);
      // Retour matériel : ferme le calque du dessus, sinon renvoie l'app en
      // arrière-plan — jamais finish(), qui couperait le son.
      this._nativeUi.listen('back', () => {
        if (!this._closeTop()) this._nativeUi.call('minimize').catch(() => {});
      });
    }

    if (!this._native) return;

    // Sans cette permission le service tourne quand même, seule la
    // notification est masquée : on ne bloque donc rien sur son refus.
    this._native.call('ensureNotificationPermission').catch(() => {});

    this._native.listen('transport', ({ play }) => {
      if (play !== this.isPlaying) this._setPlaying(play);
    });
  }

  /**
   * Le service ne sert que si un mix existe. Tant qu'il tourne, la
   * notification permet de reprendre depuis l'écran verrouillé même en pause.
   */
  _syncNative(active) {
    if (!this._native) return;

    if (!active.length) {
      this._native.call('stop').catch(() => {});
      return;
    }
    this._native
      .call('start', { playing: this.isPlaying, title: active.join(' + ') })
      .catch(err => console.warn('[blanket] service natif indisponible:', err));
  }

  // ─── Chargement ────────────────────────────────────

  /** Sans ça les ligatures s'affichent en toutes lettres (« bedtime »). */
  _iconFontReady() {
    if (!document.fonts?.load) return Promise.resolve();
    return Promise.race([
      document.fonts.load('24px "Material Symbols Rounded"', 'play_arrow'),
      new Promise(resolve => setTimeout(resolve, 2000)),
    ]).catch(() => {});
  }

  _reveal() {
    this._renderMaster();
    this._renderPlayButton();
    requestAnimationFrame(() => {
      $('splash').classList.add('done');
      setTimeout(() => $('splash')?.remove(), 400);
      this._nativeUi?.call('ready').catch(() => {});
    });
    // Le mode d'emploi s'ouvre une fois de lui-même (premier lancement, ou
    // première ouverture après la mise à jour qui l'a ajouté).
    if (!this.ui.seenHelp) setTimeout(() => this._openHelp(), 450);
  }

  // ─── Persistance ───────────────────────────────────

  _saveSettings() {
    this._saveJSON(SETTINGS_KEY, {
      isPlaying: this.isPlaying,
      masterVol: this.masterVol,
      activePreset: this.activePreset,
      sounds: this._currentSounds(),
    });
  }

  _restoreSettings() {
    const s = this._loadJSON(SETTINGS_KEY, null);
    if (!s) return;

    if (s.masterVol !== undefined) {
      this.masterVol = s.masterVol;
      this.engine.setMasterVolume(this.masterVol);
    }
    if (this.presets.some(p => p.id === s.activePreset)) this.activePreset = s.activePreset;

    Object.entries(s.sounds ?? {}).forEach(([name, state]) => {
      if (!this.states[name]) return;
      this.states[name] = { active: state.active, volume: state.volume };
      this.engine.setVolume(name, state.volume);
      this._renderRow(name);
    });

    this._renderChips();
    this._updateMediaSession();
  }

  _renderMaster() {
    const el = $('masterVolume');
    const v = Math.round(this.masterVol * 100);
    el.value = v;
    el.style.setProperty('--value', v + '%');
    $('masterIcon').textContent = v === 0 ? 'volume_off' : v < 40 ? 'volume_down' : 'volume_up';
  }

  _saveJSON(key, data) {
    try { localStorage.setItem(key, JSON.stringify(data)); } catch (_) {}
  }

  _loadJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (_) { return fallback; }
  }

  // ─── Service Worker ────────────────────────────────

  /**
   * Dans l'APK les assets sont déjà locaux : le service worker n'apporte aucun
   * bénéfice hors-ligne, mais son cache-first fige l'ancien JS à chaque mise à
   * jour. On le désenregistre donc et on purge ses caches côté natif.
   */
  _registerSW() {
    if (!('serviceWorker' in navigator)) return;

    if (this._native) {
      navigator.serviceWorker.getRegistrations()
        .then(regs => Promise.all(regs.map(r => r.unregister())))
        .then(() => caches.keys())
        .then(keys => Promise.all(keys.map(k => caches.delete(k))))
        .catch(() => {});
      return;
    }

    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // ─── Événements ────────────────────────────────────

  _attachEvents() {
    $('playBtn').addEventListener('click', () => this._togglePlay());
    $('timerBtn').addEventListener('click', () => this._openTimerSheet());
    $('mixesBtn').addEventListener('click', () => this._openMixesSheet());
    $('moreBtn').addEventListener('click', e => this._menu(e.currentTarget, [
      { icon: 'settings',   label: t('settings'),    action: () => this._openSettings() },
      { icon: 'audio_file', label: t('importSound'), action: () => this._pickFile() },
      { icon: 'help',       label: t('howToUse'),    action: () => this._openHelp() },
      { icon: 'info',       label: t('about'),       action: () => this._about() },
    ]));

    const master = $('masterVolume');
    master.addEventListener('input', () => {
      this.masterVol = master.value / 100;
      this._renderMaster();
      if (this.timer?.fading) return;          // le fondu du minuteur garde la main
      this.engine.setMasterVolume(this.masterVol);
    });
    master.addEventListener('change', () => this._saveSettings());

    $('snackbarAction').addEventListener('click', () => {
      $('snackbar').classList.remove('show');
      const fn = this._snackAction;
      this._snackAction = null;
      fn?.();
    });

    $('customSoundFile').addEventListener('change', e => {
      const file = e.target.files[0];
      if (file) { this._importDialog(file); e.target.value = ''; }
    });

    // Barre d'application : grande au repos, compacte dès qu'on défile.
    const scroll = $('scroll');
    let scrolled = false;
    scroll.addEventListener('scroll', () => {
      const next = scroll.scrollTop > 40;
      if (next !== scrolled) { scrolled = next; document.body.classList.toggle('scrolled', next); }
    }, { passive: true });

    // Ripple Material, parti du point de contact. Un seul écouteur pour toute
    // l'app ; rien ne tourne en dehors des interactions.
    document.addEventListener('pointerdown', e => {
      const target = e.target.closest('.pressable');
      if (!target || target.disabled) return;
      const r = target.getBoundingClientRect();
      const size = Math.hypot(r.width, r.height) * 2;
      const ripple = h('span.ripple', {
        style: `width:${size}px;height:${size}px;left:${e.clientX - r.left}px;top:${e.clientY - r.top}px`,
      });
      target.appendChild(ripple);
      ripple.addEventListener('animationend', () => ripple.remove());
    }, { passive: true });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') this._closeTop();
    });

    window.addEventListener('popstate', () => this._onPopState());

    matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => {
      if (this.ui.mode === 'system') this._syncSystemBars();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this._saveSettings();
      } else {
        if (this.isPlaying) {
          // Filet de sécurité : le système a pu suspendre le contexte pendant
          // que l'app était en arrière-plan.
          this.engine.resume();
        }
        this._tickTimer();
      }
    });
  }
}

window.addEventListener('DOMContentLoaded', () => { window.app = new BlanketApp(); });
