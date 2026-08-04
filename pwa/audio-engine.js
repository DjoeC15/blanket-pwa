'use strict';

/**
 * Moteur audio Web Audio pour Blanket.
 *
 * Remplace les N éléments <audio> — un décodeur Vorbis par son, actif en
 * permanence — par un graphe unique :
 *
 *   AudioBufferSourceNode ─┐
 *   AudioBufferSourceNode ─┼─→ GainNode (par son) ─→ masterGain ─→ sortie
 *   AudioBufferSourceNode ─┘
 *
 * Chaque son est décodé UNE seule fois vers du PCM mono au sampleRate du
 * contexte, puis bouclé depuis la mémoire. Pendant la lecture il ne reste
 * qu'une lecture mémoire, une multiplication et une somme : plus aucun
 * décodage ni rééchantillonnage, et un seul flux remis à l'OS au lieu de N.
 */

// Longueur maximale d'une boucle gardée en mémoire. Au-delà le son est coupé.
// À 48 kHz mono float32, 45 s ≈ 8,6 Mo par son.
const MAX_LOOP_SECONDS = 45;

// Crossfade appliqué à la jointure de boucle. Long quand on coupe un son
// (il faut recréer un point de bouclage), court sinon — là il ne sert qu'à
// absorber l'atténuation que le rééchantillonneur peut laisser en fin de
// buffer, qui produirait un clic toutes les N secondes.
const TRIM_CROSSFADE_SECONDS = 1.5;
const SEAM_CROSSFADE_SECONDS = 0.08;

// Fondu au démarrage / à l'arrêt d'un son, pour éviter les clics.
const FADE_SECONDS = 0.25;

// Version du format de cache PCM. À incrémenter si l'une des constantes
// ci-dessus ou le down-mix changent, afin d'invalider les caches existants.
const PCM_CACHE_VERSION = 1;

/**
 * Sortie audio.
 *
 *   'direct' (défaut)  → master → ctx.destination
 *      Un seul flux remis à l'OS.
 *
 *   'element'          → master → MediaStreamAudioDestinationNode → <audio>
 *      Android y voit un vrai élément média, ce qui rend la notification
 *      MediaSession fiable *dans un navigateur*.
 *
 * Mesuré sur Galaxy S21 / Android 15 (dumpsys audio, 2 sons actifs) :
 * 'element' ouvre DEUX flux AAudio simultanés en état `started` — celui de
 * l'AudioContext et celui de l'<audio> — là où 'direct' n'en ouvre qu'un.
 * C'est exactement le surcoût que ce moteur cherche à éliminer.
 *
 * Et dans l'APK Capacitor, la contrepartie est nulle : une WebView ne
 * remonte pas MediaSession vers la notification système (c'est une
 * fonctionnalité de Chrome, pas de WebView). 'element' n'y coûte donc que le
 * flux supplémentaire. D'où le défaut 'direct'.
 *
 * Bascule dans la console : localStorage.blanket_sink = 'element'
 * puis recharger. Un échec de 'element' retombe automatiquement sur 'direct'.
 */
const SINK_MODE = (() => {
  try { return localStorage.getItem('blanket_sink') || 'direct'; }
  catch (_) { return 'element'; }
})();

// ─── Cache PCM (IndexedDB) ───────────────────────────────────────────────────
//
// Base distincte de `blanket_db` (sons personnalisés) pour ne pas toucher au
// schéma ni à la version de celle-ci. Le cache est best-effort : toute erreur
// est avalée, on retombe simplement sur un décodage complet.

class PcmCache {
  constructor() {
    this._db = null;
    this._ready = new Promise(resolve => {
      let req;
      try { req = indexedDB.open('blanket_pcm', 1); }
      catch (_) { return resolve(); }

      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('pcm')) {
          db.createObjectStore('pcm', { keyPath: 'key' });
        }
      };
      req.onsuccess = e => { this._db = e.target.result; resolve(); };
      req.onerror   = () => resolve();
      req.onblocked = () => resolve();
    });
  }

  async _run(mode, fn) {
    await this._ready;
    if (!this._db) return null;
    return new Promise(resolve => {
      let req;
      try { req = fn(this._db.transaction('pcm', mode).objectStore('pcm')); }
      catch (_) { return resolve(null); }
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = () => resolve(null);
    });
  }

  get(key)    { return this._run('readonly',  s => s.get(key)); }
  put(record) { return this._run('readwrite', s => s.put(record)); }
  remove(key) { return this._run('readwrite', s => s.delete(key)); }
}

// ─── Moteur ──────────────────────────────────────────────────────────────────

class AudioEngine {
  constructor() {
    this.ctx          = null;
    this.master       = null;
    this.masterVolume = 0.8;
    this.entries      = new Map();
    this._cache       = new PcmCache();
    this._sinkEl      = null;
    this._streamDest  = null;
  }

  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }

  /**
   * Crée / réveille le contexte. DOIT être appelé depuis un geste utilisateur
   * la première fois (politique d'autoplay).
   */
  async ensureContext() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) throw new Error('Web Audio non disponible');

      // latencyHint 'playback' demande les plus gros buffers possibles :
      // moins de réveils du CPU par seconde, donc moins de batterie.
      this.ctx = new Ctor({ latencyHint: 'playback' });

      this.master = this.ctx.createGain();
      this.master.gain.value = this.masterVolume;
      this._connectSink();
    }

    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch (_) {}
    }
    if (this._sinkEl && this._sinkEl.paused) {
      try { await this._sinkEl.play(); }
      catch (_) { this._fallbackToDirectSink(); }
    }
    return this.ctx;
  }

  _connectSink() {
    const canStream = typeof this.ctx.createMediaStreamDestination === 'function';

    if (SINK_MODE === 'element' && canStream) {
      this._streamDest = this.ctx.createMediaStreamDestination();
      this.master.connect(this._streamDest);

      const el = document.createElement('audio');
      el.srcObject = this._streamDest.stream;
      el.preload   = 'auto';
      el.setAttribute('playsinline', '');
      el.style.display = 'none';
      document.body.appendChild(el);
      this._sinkEl = el;
    } else {
      this.master.connect(this.ctx.destination);
    }
  }

  /** Le sink <audio> a échoué : on repasse sur la sortie directe. */
  _fallbackToDirectSink() {
    if (!this._sinkEl) return;
    console.warn('[blanket] sink <audio> indisponible, bascule sur ctx.destination');
    try { this.master.disconnect(this._streamDest); } catch (_) {}
    try { this._sinkEl.srcObject = null; this._sinkEl.remove(); } catch (_) {}
    this._sinkEl = this._streamDest = null;
    this.master.connect(this.ctx.destination);
  }

  // ─── Enregistrement des sons ───────────────────────

  /** @param {{url?: string, blob?: Blob}} source */
  register(id, source) {
    if (this.entries.has(id)) return;
    this.entries.set(id, {
      source,
      gain:    null,
      buffer:  null,
      node:    null,
      volume:  0.5,
      wanted:  false,
      loading: null,
    });
  }

  unregister(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.stop(id);
    if (entry.gain) { try { entry.gain.disconnect(); } catch (_) {} }
    entry.buffer = null;
    this.entries.delete(id);
    this._cache.remove(this._cacheKey(id)).catch(() => {});
  }

  // ─── Lecture ───────────────────────────────────────

  async play(id) {
    const entry = this.entries.get(id);
    if (!entry) return;

    entry.wanted = true;
    await this.ensureContext();

    const buffer = await this._buffer(id, entry);
    // L'utilisateur a pu désactiver le son pendant le chargement,
    // ou une lecture a déjà démarré entre-temps.
    if (!buffer || !entry.wanted || entry.node) return;

    const gain = this._gainFor(entry);
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    node.loop   = true;
    node.connect(gain);

    const now = this.ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(entry.volume, now + FADE_SECONDS);
    node.start();

    entry.node = node;
  }

  stop(id) {
    const entry = this.entries.get(id);
    if (!entry) return;

    entry.wanted = false;
    const node = entry.node;
    if (!node || !this.ctx) return;
    entry.node = null;

    const now = this.ctx.currentTime;
    const g   = entry.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + FADE_SECONDS);

    node.onended = () => { try { node.disconnect(); } catch (_) {} };
    try { node.stop(now + FADE_SECONDS + 0.05); } catch (_) {}
  }

  isPlaying(id) { return Boolean(this.entries.get(id)?.node); }

  /** Met en pause le thread audio : consommation CPU nulle. */
  async suspend() {
    if (!this.ctx) return;
    if (this._sinkEl) this._sinkEl.pause();
    try { await this.ctx.suspend(); } catch (_) {}
  }

  async resume() {
    if (!this.ctx) return;
    try { await this.ctx.resume(); } catch (_) {}
    if (this._sinkEl && this._sinkEl.paused) {
      try { await this._sinkEl.play(); }
      catch (_) { this._fallbackToDirectSink(); }
    }
  }

  // ─── Volumes ───────────────────────────────────────

  setVolume(id, volume) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.volume = volume;
    if (entry.node && entry.gain) {
      const now = this.ctx.currentTime;
      entry.gain.gain.cancelScheduledValues(now);
      entry.gain.gain.setTargetAtTime(volume, now, 0.03);
    }
  }

  setMasterVolume(volume) {
    this.masterVolume = volume;
    if (!this.master) return;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(volume, now, 0.03);
  }

  _gainFor(entry) {
    if (!entry.gain) {
      entry.gain = this.ctx.createGain();
      entry.gain.gain.value = 0;
      entry.gain.connect(this.master);
    }
    return entry.gain;
  }

  // ─── Chargement & traitement ───────────────────────

  _cacheKey(id) { return `${id}@${this.sampleRate}@v${PCM_CACHE_VERSION}`; }

  _buffer(id, entry) {
    if (entry.buffer) return Promise.resolve(entry.buffer);

    if (!entry.loading) {
      entry.loading = this._load(id, entry)
        .then(buf => { entry.buffer = buf; return buf; })
        .catch(err => {
          console.warn('[blanket] chargement audio échoué:', id, err);
          entry.loading = null;   // autorise une nouvelle tentative
          return null;
        });
    }
    return entry.loading;
  }

  async _load(id, entry) {
    const rate = this.ctx.sampleRate;
    const key  = this._cacheKey(id);

    // 1. PCM déjà traité lors d'une session précédente ?
    const cached = await this._cache.get(key);
    if (cached?.pcm?.length) {
      const buf = this.ctx.createBuffer(1, cached.pcm.length, rate);
      buf.copyToChannel(cached.pcm, 0);
      return buf;
    }

    // 2. Octets compressés
    const bytes = entry.source.blob
      ? await entry.source.blob.arrayBuffer()
      : await fetch(entry.source.url).then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status} sur ${entry.source.url}`);
          return r.arrayBuffer();
        });

    // 3. Décodage — l'opération coûteuse, faite une seule fois
    const decoded = await this._decode(bytes);

    // 4. Mono, au sampleRate du contexte, coupé si trop long
    const processed = await this._process(decoded);

    // 5. Mise en cache (best-effort, ne doit jamais bloquer la lecture)
    this._cache
      .put({ key, rate, pcm: processed.getChannelData(0).slice() })
      .catch(() => {});

    return processed;
  }

  /** decodeAudioData en version promesse, avec repli sur l'ancienne signature. */
  _decode(bytes) {
    return new Promise((resolve, reject) => {
      const ret = this.ctx.decodeAudioData(bytes, resolve, reject);
      if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
    });
  }

  /**
   * Down-mix mono + rééchantillonnage vers le sampleRate du contexte, via un
   * OfflineAudioContext à 1 canal (le mixage stéréo→mono est fait par Web
   * Audio). Les sons plus longs que MAX_LOOP_SECONDS sont coupés.
   */
  async _process(buffer) {
    const rate     = this.ctx.sampleRate;
    const trimming = buffer.duration > MAX_LOOP_SECONDS;
    const crossfade = trimming ? TRIM_CROSSFADE_SECONDS : SEAM_CROSSFADE_SECONDS;
    const seconds  = trimming ? MAX_LOOP_SECONDS + crossfade : buffer.duration;
    const frames   = Math.floor(Math.min(seconds, buffer.duration) * rate);

    const Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const off  = new Ctor(1, frames, rate);
    const src  = off.createBufferSource();
    src.buffer = buffer;
    src.connect(off.destination);
    src.start(0);

    const rendered = await off.startRendering();
    return this._foldLoop(rendered, crossfade);
  }

  /**
   * Recoud la fin du buffer sur son début pour garantir une boucle sans clic.
   *
   * Le buffer rendu fait N trames ; on en produit L = N - X, où les X
   * premières trames sont un fondu à puissance constante entre le début et la
   * queue :
   *
   *   out[j] = src[j]·sin(θ) + src[L+j]·cos(θ),  θ = (j+½)/X · π/2,  j < X
   *   out[i] = src[i],                                               i ≥ X
   *
   * Au rebouclage, out[L-1] = src[L-1] enchaîne sur out[0] ≈ src[L] : la
   * continuité de la source est préservée. sin²+cos² = 1 conserve l'énergie,
   * ce qui est le bon choix pour des bruits d'ambiance non corrélés (un fondu
   * linéaire creuserait un trou de volume audible à chaque boucle).
   */
  _foldLoop(rendered, crossfadeSeconds) {
    const rate = rendered.sampleRate;
    const N    = rendered.length;
    const X    = Math.min(Math.floor(crossfadeSeconds * rate), Math.floor(N / 2));
    const L    = N - X;
    if (X < 1 || L < 1) return rendered;

    const src = rendered.getChannelData(0);
    const out = new Float32Array(L);
    out.set(src.subarray(0, L));

    for (let j = 0; j < X; j++) {
      const theta = ((j + 0.5) / X) * (Math.PI / 2);
      out[j] = src[j] * Math.sin(theta) + src[L + j] * Math.cos(theta);
    }

    const buf = this.ctx.createBuffer(1, L, rate);
    buf.copyToChannel(out, 0);
    return buf;
  }
}

window.AudioEngine = AudioEngine;
