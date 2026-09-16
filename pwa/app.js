'use strict';

const SOUNDS = [
  { name: 'rain',         title: 'Rain',         category: 'Nature',    emoji: '🌧️' },
  { name: 'storm',        title: 'Storm',        category: 'Nature',    emoji: '⛈️' },
  { name: 'wind',         title: 'Wind',         category: 'Nature',    emoji: '💨' },
  { name: 'waves',        title: 'Waves',        category: 'Nature',    emoji: '🌊' },
  { name: 'stream',       title: 'Stream',       category: 'Nature',    emoji: '🏞️' },
  { name: 'birds',        title: 'Birds',        category: 'Nature',    emoji: '🐦' },
  { name: 'summer-night', title: 'Summer Night', category: 'Nature',    emoji: '🌙' },
  { name: 'train',        title: 'Train',        category: 'Travel',    emoji: '🚂' },
  { name: 'boat',         title: 'Boat',         category: 'Travel',    emoji: '⛵' },
  { name: 'city',         title: 'City',         category: 'Travel',    emoji: '🏙️' },
  { name: 'coffee-shop',  title: 'Coffee Shop',  category: 'Interiors', emoji: '☕' },
  { name: 'fireplace',    title: 'Fireplace',    category: 'Interiors', emoji: '🔥' },
  { name: 'pink-noise',   title: 'Pink Noise',   category: 'Noise',     emoji: '🎵' },
  { name: 'white-noise',  title: 'White Noise',  category: 'Noise',     emoji: '📻' },
];

const SOUND_PATH   = '../data/resources/sounds/';
const PRESETS_KEY  = 'blanket_presets';
const SETTINGS_KEY = 'blanket_settings';

// Durée gardée en mémoire pour un son importé. Les bruits intégrés sont coupés
// à 45 s sans que ça s'entende ; un fichier importé doit être joué en entier.
// La limite ne sert qu'à borner la mémoire : 10 min ≈ 115 Mo de PCM à 48 kHz,
// plus le pic transitoire du décodage (le fichier entier en stéréo).
const CUSTOM_MAX_SECONDS = 10 * 60;

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
  remove(id)  { return this._tx('readwrite', s => s.delete(id)); }
}

// ─── App ─────────────────────────────────────────────────────────────────────

class BlanketApp {
  constructor() {
    this.states       = {};
    this.titles       = {};
    this.isPlaying    = false;
    this.masterVol    = 0.8;
    this.presets      = this._loadJSON(PRESETS_KEY, []);
    this.activePreset = null;
    this._toastTimer  = null;
    this._db          = new SoundDB();
    this.engine       = new AudioEngine();

    this._native = this._resolveNative();

    this._initAudio();
    this._buildUI();
    this._attachEvents();
    this._initMediaSession();
    this._initNative();
    this._registerSW();

    // Async: charge les sons perso puis restaure l'état
    this._loadCustomSounds().then(() => this._restoreSettings());
  }

  // ─── Audio ────────────────────────────────────────

  _initAudio() {
    this.engine.setMasterVolume(this.masterVol);
    SOUNDS.forEach(({ name, title }) => {
      this.states[name] = { active: false, volume: 0.5 };
      this.titles[name] = title;
      this.engine.register(name, { url: SOUND_PATH + name + '.ogg' });
    });
  }

  _playSound(name) {
    this.engine.setVolume(name, this.states[name].volume);
    this.engine.play(name);
  }

  _pauseSound(name) {
    this.engine.stop(name);
  }

  // ─── UI (sons intégrés) ────────────────────────────

  _buildUI() {
    const grid       = document.getElementById('soundGrid');
    const categories = [...new Set(SOUNDS.map(s => s.category))];

    categories.forEach(cat => {
      const wrap  = document.createElement('div');
      wrap.className = 'category';

      const lbl   = document.createElement('div');
      lbl.className = 'category-title';
      lbl.textContent = cat;

      const row   = document.createElement('div');
      row.className = 'sound-grid';
      SOUNDS.filter(s => s.category === cat).forEach(s => row.appendChild(this._makeCard(s)));

      wrap.append(lbl, row);
      grid.appendChild(wrap);
    });

    // Section "My Sounds"
    this._buildCustomSection();
  }

  _makeCard({ name, title, emoji }) {
    const card = document.createElement('div');
    card.className   = 'sound-card';
    card.dataset.name = name;

    const dot  = document.createElement('div');
    dot.className = 'active-dot hidden';
    dot.id        = 'dot-' + name;

    const em   = document.createElement('span');
    em.className  = 'sound-emoji';
    em.textContent = emoji;

    const lbl  = document.createElement('div');
    lbl.className  = 'sound-name';
    lbl.textContent = title;

    const vol  = this._makeVolumeSlider(name);

    card.append(dot, em, lbl, vol);
    card.addEventListener('click', () => this._toggleSound(name));
    return card;
  }

  _makeVolumeSlider(name) {
    const vol       = document.createElement('input');
    vol.type        = 'range';
    vol.className   = 'sound-volume';
    vol.id          = 'vol-' + name;
    vol.min = 0; vol.max = 100; vol.value = 50;

    vol.addEventListener('input', e => {
      e.stopPropagation();
      if (!this.states[name]) return;
      this.states[name].volume = e.target.value / 100;
      this.engine.setVolume(name, this.states[name].volume);
    });
    vol.addEventListener('change',     () => this._saveSettings());
    vol.addEventListener('click',       e => e.stopPropagation());
    vol.addEventListener('touchstart',  e => e.stopPropagation(), { passive: true });
    vol.addEventListener('touchmove',   e => e.stopPropagation(), { passive: true });
    return vol;
  }

  // ─── UI (sons personnalisés) ───────────────────────

  _buildCustomSection() {
    const grid = document.getElementById('soundGrid');

    const wrap  = document.createElement('div');
    wrap.className = 'category';
    wrap.id        = 'customCategory';

    const lbl   = document.createElement('div');
    lbl.className  = 'category-title';
    lbl.textContent = 'My Sounds';

    const row   = document.createElement('div');
    row.className = 'sound-grid';
    row.id        = 'customGrid';

    // Carte "+"
    const addCard = document.createElement('div');
    addCard.className = 'sound-card add-card';
    addCard.id        = 'addSoundCard';
    addCard.innerHTML = `<span class="add-icon">＋</span><div class="sound-name">Add Sound</div>`;
    addCard.addEventListener('click', () => document.getElementById('customSoundFile').click());

    row.appendChild(addCard);
    wrap.append(lbl, row);
    grid.appendChild(wrap);
  }

  _makeCustomCard({ id, name }) {
    const card = document.createElement('div');
    card.className    = 'sound-card';
    card.dataset.name = id;
    card.dataset.custom = 'true';

    const dot = document.createElement('div');
    dot.className = 'active-dot hidden';
    dot.id        = 'dot-' + id;

    const del = document.createElement('button');
    del.className  = 'sound-delete';
    del.textContent = '×';
    del.setAttribute('aria-label', 'Delete');
    del.addEventListener('click', e => { e.stopPropagation(); this._deleteCustomSound(id); });

    const em  = document.createElement('span');
    em.className  = 'sound-emoji';
    em.textContent = '🎵';

    const lbl = document.createElement('div');
    lbl.className  = 'sound-name custom-sound-name';
    lbl.textContent = name;

    const vol = this._makeVolumeSlider(id);

    card.append(dot, del, em, lbl, vol);
    card.addEventListener('click', () => this._toggleSound(id));
    return card;
  }

  // ─── Custom sound CRUD ─────────────────────────────

  async _loadCustomSounds() {
    try {
      const records = await this._db.getAll();
      records.forEach(({ id, name, blob }) => this._mountCustomSound(id, name, blob));
    } catch (e) {
      console.warn('IndexedDB load failed:', e);
    }
  }

  _mountCustomSound(id, name, blob) {
    this.states[id] = { active: false, volume: 0.5 };
    this.titles[id] = name;
    this.engine.register(id, { blob }, {
      maxSeconds: CUSTOM_MAX_SECONDS,
      onTrim: () => this._toast(`"${name}" trimmed to ${CUSTOM_MAX_SECONDS / 60} min`),
    });

    const card = this._makeCustomCard({ id, name });
    const grid = document.getElementById('customGrid');
    grid.insertBefore(card, document.getElementById('addSoundCard'));
  }

  async _addCustomSound(file) {
    const id   = 'custom_' + Date.now();
    const name = file.name.replace(/\.[^/.]+$/, ''); // retire l'extension

    try {
      await this._db.add({ id, name, blob: file });
    } catch (_) {
      this._toast('Could not save sound');
      return;
    }

    this._mountCustomSound(id, name, file);
    this._toast(`"${name}" added`);
  }

  async _deleteCustomSound(id) {
    // Arrête la lecture, libère le buffer PCM et purge son cache
    this.engine.unregister(id);
    delete this.states[id];
    delete this.titles[id];

    try { await this._db.remove(id); } catch (_) {}

    document.querySelector(`.sound-card[data-name="${id}"]`)?.remove();
    this._saveSettings();
    this._updateMediaSession();
    this._toast('Sound removed');
  }

  // ─── Toggle ────────────────────────────────────────

  _toggleSound(name) {
    if (!this.states[name]) return;
    const state = this.states[name];
    state.active = !state.active;

    const card = document.querySelector(`.sound-card[data-name="${name}"]`);
    const dot  = document.getElementById('dot-' + name);

    if (state.active) {
      card?.classList.add('active');
      dot?.classList.remove('hidden');
      if (this.isPlaying) this._playSound(name);
    } else {
      card?.classList.remove('active');
      dot?.classList.add('hidden');
      this._pauseSound(name);
    }
    this._saveSettings();
    this._updateMediaSession();
  }

  // ─── Play / Pause ──────────────────────────────────

  async _setPlaying(playing) {
    this.isPlaying = playing;
    document.getElementById('playIcon').classList.toggle('hidden', playing);
    document.getElementById('pauseIcon').classList.toggle('hidden', !playing);
    document.getElementById('playBtn').classList.toggle('playing', playing);

    const active = Object.entries(this.states)
      .filter(([, s]) => s.active)
      .map(([name]) => name);

    if (playing) {
      clearTimeout(this._suspendTimer);
      try {
        // Doit partir d'un geste utilisateur la première fois (autoplay).
        await this.engine.ensureContext();
      } catch (_) {
        this.isPlaying = false;
        document.getElementById('playIcon').classList.remove('hidden');
        document.getElementById('pauseIcon').classList.add('hidden');
        document.getElementById('playBtn').classList.remove('playing');
        this._toast('Audio unavailable on this device');
        return;
      }
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
        title:   active.length ? active.join(' + ') : 'No sounds selected',
        artist:  preset ? preset.name : 'Ambient mix',
        album:   'Blanket',
        artwork: [{ src: this._artwork(), sizes: '512x512', type: 'image/png' }],
      });
    } catch (_) {}

    ms.playbackState = this.isPlaying ? 'playing' : 'paused';
  }

  /**
   * Vignette de la notification. Générée au canvas plutôt que livrée en asset :
   * Android ne rend pas les artworks SVG, et le seul logo du dépôt est un SVG.
   */
  _artwork() {
    if (this._artworkUrl) return this._artworkUrl;

    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const g = canvas.getContext('2d');

    const grad = g.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, '#2f3147');
    grad.addColorStop(1, '#1c1c2a');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);

    g.font = `${Math.round(size * 0.46)}px serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('🌿', size / 2, size / 2 + size * 0.02);

    this._artworkUrl = canvas.toDataURL('image/png');
    return this._artworkUrl;
  }

  // ─── Service natif (APK Android) ────────────────────

  _activeTitles() {
    return Object.entries(this.states)
      .filter(([, s]) => s.active)
      .map(([name]) => this.titles[name] || name);
  }

  /**
   * L'app ne charge pas @capacitor/core : le bridge injecté dans la WebView
   * n'expose donc ni `registerPlugin` ni `Capacitor.Plugins` proxifié, mais les
   * primitives `nativePromise` / `addListener`. On appelle le plugin par là.
   */
  _resolveNative() {
    const cap = window.Capacitor;
    if (!cap || typeof cap.nativePromise !== 'function') return null;
    if (typeof cap.isNativePlatform === 'function' && !cap.isNativePlatform()) return null;

    return {
      call:   (method, options) => cap.nativePromise('BlanketPlayback', method, options ?? {}),
      listen: (event, callback)  => cap.addListener('BlanketPlayback', event, callback),
    };
  }

  _initNative() {
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

  // ─── Presets ───────────────────────────────────────

  _savePreset(name) {
    const preset = {
      id: Date.now().toString(), name,
      masterVol: this.masterVol,
      sounds: Object.fromEntries(
        Object.entries(this.states).map(([n, s]) => [n, { active: s.active, volume: s.volume }])
      ),
    };
    this.presets.push(preset);
    this._saveJSON(PRESETS_KEY, this.presets);
    this._renderPresets();
    this._toast(`"${name}" saved`);
  }

  _loadPreset(preset) {
    this.activePreset = preset.id;
    this.masterVol    = preset.masterVol ?? 0.8;
    document.getElementById('masterVolume').value = this.masterVol * 100;
    this.engine.setMasterVolume(this.masterVol);

    Object.keys(this.states).forEach(name => {
      if (this.states[name].active) {
        this.states[name].active = false;
        this._pauseSound(name);
        document.querySelector(`.sound-card[data-name="${name}"]`)?.classList.remove('active');
        document.getElementById('dot-' + name)?.classList.add('hidden');
      }
    });

    Object.entries(preset.sounds ?? {}).forEach(([name, s]) => {
      if (!this.states[name]) return;
      this.states[name] = { active: s.active, volume: s.volume };
      const slider = document.getElementById('vol-' + name);
      if (slider) slider.value = s.volume * 100;
      if (s.active) {
        document.querySelector(`.sound-card[data-name="${name}"]`)?.classList.add('active');
        document.getElementById('dot-' + name)?.classList.remove('hidden');
        if (this.isPlaying) this._playSound(name);
      }
    });

    this._renderPresets();
    this._closeModal('presetsModal');
    this._toast(`"${preset.name}" loaded`);
    this._saveSettings();
    this._updateMediaSession();
  }

  _deletePreset(id) {
    this.presets = this.presets.filter(p => p.id !== id);
    this._saveJSON(PRESETS_KEY, this.presets);
    this._renderPresets();
  }

  _renderPresets() {
    const list = document.getElementById('presetList');
    list.innerHTML = '';
    if (this.presets.length === 0) {
      list.innerHTML = '<div class="no-presets">No presets yet.<br>Save your current mix!</div>';
      return;
    }
    this.presets.forEach(preset => {
      const item = document.createElement('div');
      item.className = 'preset-item' + (preset.id === this.activePreset ? ' active' : '');

      const name = document.createElement('span');
      name.className  = 'preset-name';
      name.textContent = preset.name;

      const del = document.createElement('button');
      del.className  = 'preset-delete';
      del.textContent = '×';
      del.addEventListener('click', e => { e.stopPropagation(); this._deletePreset(preset.id); });

      item.append(name, del);
      item.addEventListener('click', () => this._loadPreset(preset));
      list.appendChild(item);
    });
  }

  // ─── Persistence ───────────────────────────────────

  _saveSettings() {
    this._saveJSON(SETTINGS_KEY, {
      isPlaying: this.isPlaying,
      masterVol: this.masterVol,
      sounds: Object.fromEntries(
        Object.entries(this.states).map(([n, s]) => [n, { active: s.active, volume: s.volume }])
      ),
    });
  }

  _restoreSettings() {
    const s = this._loadJSON(SETTINGS_KEY, null);
    if (!s) return;

    if (s.masterVol !== undefined) {
      this.masterVol = s.masterVol;
      document.getElementById('masterVolume').value = this.masterVol * 100;
      this.engine.setMasterVolume(this.masterVol);
    }

    Object.entries(s.sounds ?? {}).forEach(([name, state]) => {
      if (!this.states[name]) return;
      this.states[name] = { active: state.active, volume: state.volume };
      this.engine.setVolume(name, state.volume);
      const slider = document.getElementById('vol-' + name);
      if (slider) slider.value = state.volume * 100;
      if (state.active) {
        document.querySelector(`.sound-card[data-name="${name}"]`)?.classList.add('active');
        document.getElementById('dot-' + name)?.classList.remove('hidden');
      }
    });

    this._updateMediaSession();
  }

  _saveJSON(key, data) {
    try { localStorage.setItem(key, JSON.stringify(data)); } catch (_) {}
  }

  _loadJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (_) { return fallback; }
  }

  // ─── Modals ────────────────────────────────────────

  _openModal(id)  { document.getElementById(id).classList.remove('hidden'); }
  _closeModal(id) { document.getElementById(id).classList.add('hidden'); }

  // ─── Toast ─────────────────────────────────────────

  _toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
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

  // ─── Events ────────────────────────────────────────

  _attachEvents() {
    document.getElementById('playBtn').addEventListener('click', () => {
      this._setPlaying(!this.isPlaying);
    });

    document.getElementById('masterVolume').addEventListener('input', e => {
      this.masterVol = e.target.value / 100;
      this.engine.setMasterVolume(this.masterVol);
    });
    document.getElementById('masterVolume').addEventListener('change', () => this._saveSettings());

    document.getElementById('presetsBtn').addEventListener('click', () => {
      this._renderPresets();
      this._openModal('presetsModal');
    });
    document.getElementById('closePresetsBtn').addEventListener('click', () => this._closeModal('presetsModal'));
    document.getElementById('presetsModal').addEventListener('click', e => {
      if (e.target === e.currentTarget) this._closeModal('presetsModal');
    });

    document.getElementById('savePresetBtn').addEventListener('click', () => {
      document.getElementById('presetNameInput').value = '';
      this._openModal('saveModal');
      setTimeout(() => document.getElementById('presetNameInput').focus(), 120);
    });
    document.getElementById('closeSaveBtn').addEventListener('click', () => this._closeModal('saveModal'));
    document.getElementById('saveModal').addEventListener('click', e => {
      if (e.target === e.currentTarget) this._closeModal('saveModal');
    });
    document.getElementById('confirmSaveBtn').addEventListener('click', () => {
      const name = document.getElementById('presetNameInput').value.trim();
      if (name) { this._savePreset(name); this._closeModal('saveModal'); }
    });
    document.getElementById('presetNameInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('confirmSaveBtn').click();
    });

    // Ajout de sons personnalisés
    document.getElementById('customSoundFile').addEventListener('change', e => {
      const file = e.target.files[0];
      if (file) { this._addCustomSound(file); e.target.value = ''; }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this._saveSettings();
      } else if (this.isPlaying) {
        // Filet de sécurité : le système a pu suspendre le contexte pendant
        // que l'app était en arrière-plan.
        this.engine.resume();
      }
    });
  }
}

window.addEventListener('DOMContentLoaded', () => { window.app = new BlanketApp(); });
