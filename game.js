// The Floor: Family Edition
// One page, two roles:
//   TV / host  -> runs the game, shows the board, photos and clocks. Can be driven by mouse/keyboard alone.
//   Producer   -> phone remote (?remote=CODE). Sees the answer, taps Correct / Pass. Connects to the TV via PeerJS.
(() => {
  'use strict';

  const TOPICS = (window.FLOOR_TOPICS || []).slice();
  const TOPIC = Object.fromEntries(TOPICS.map(t => [t.id, t]));
  const PEER_PREFIX = 'famfloor-v1-';
  const STATE_KEY = 'famfloor-state';
  const CODE_KEY = 'famfloor-code';
  const DRAFT_KEY = 'famfloor-draft';
  const COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5',
    '#0d9488', '#c026d3', '#ca8a04', '#dc2626', '#0284c7', '#9333ea', '#059669', '#b45309', '#be123c', '#1d4ed8',
    '#15803d', '#a21caf', '#0e7490', '#c2410c', '#6d28d9', '#4d7c0f', '#be185d', '#0369a1', '#a16207', '#7e22ce'];
  const LEVEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

  const app = document.getElementById('app');
  const params = new URLSearchParams(location.search);

  // ---------- helpers ----------
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* storage blocked */ } }
  };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const clone = o => JSON.parse(JSON.stringify(o));
  const now = () => Date.now();
  const fmt = ms => { const s = Math.max(0, ms) / 1000; return s < 10 ? s.toFixed(1) : String(Math.ceil(s)); };
  const genCode = () => Array.from({ length: 4 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ'[Math.floor(Math.random() * 23)]).join('');
  const remoteUrl = code => location.origin + location.pathname + '?remote=' + code;
  const topicName = id => (TOPIC[id] ? TOPIC[id].name : '?');

  function topicOptions(selected) {
    const groups = {};
    TOPICS.forEach(t => { (groups[t.group] = groups[t.group] || []).push(t); });
    let html = `<option value="">Pick a topic...</option><option value="__random"${selected === '__random' ? ' selected' : ''}>Surprise me (random)</option>`;
    Object.keys(groups).sort().forEach(g => {
      html += `<optgroup label="${esc(g)}">` + groups[g].map(t =>
        `<option value="${t.id}"${t.id === selected ? ' selected' : ''}>${esc(t.name)} (${LEVEL[t.level] || t.level})</option>`).join('') + '</optgroup>';
    });
    return html;
  }

  // ---------- sound ----------
  const Sound = {
    ctx: null, enabled: true,
    tone(freq, dur, type = 'sine', vol = 0.2, when = 0) {
      if (!this.enabled) return;
      try {
        this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
        const t0 = this.ctx.currentTime + when;
        const o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = type; o.frequency.value = freq;
        g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
        o.connect(g); g.connect(this.ctx.destination); o.start(t0); o.stop(t0 + dur);
      } catch (e) { /* audio unavailable */ }
    },
    correct() { this.tone(880, 0.12, 'sine', 0.25); this.tone(1320, 0.2, 'sine', 0.25, 0.1); },
    pass() { this.tone(330, 0.25, 'triangle', 0.25); },
    tick() { this.tone(1000, 0.05, 'square', 0.08); },
    warn() { this.tone(660, 0.08, 'square', 0.12); },
    buzzer() { this.tone(140, 0.9, 'sawtooth', 0.3); this.tone(147, 0.9, 'sawtooth', 0.2); },
    win() { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.25, 'triangle', 0.25, i * 0.13)); }
  };

  // ---------- answer matching (voice) ----------
  const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ').replace(/\b(the|a|an)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const sing = s => s.split(' ').map(w => (w.length > 3 ? w.replace(/(es|s)$/, '') : w)).join(' ');
  function heardMatches(heard, item) {
    const h = ' ' + sing(norm(heard)) + ' ';
    return [item.a].concat(item.alt || []).some(c => { const n = sing(norm(c)); return n && h.includes(' ' + n + ' '); });
  }

  // ---------- relay (backup link) ----------
  // Direct phone-to-TV (PeerJS) often fails when the phone is on cell data or a guest network.
  // Every message also goes through two public MQTT relays, so the phone connects either way.
  const Relay = {
    brokers: ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'],
    clients: [], base: '',
    start(code, sub, onMsg) {
      this.stop();
      this.base = 'famfloor-v1/' + code + '/';
      if (!window.mqtt) return;
      this.brokers.forEach(url => {
        let c;
        try { c = mqtt.connect(url, { clientId: 'ff' + Math.random().toString(36).slice(2, 12), reconnectPeriod: 3000, connectTimeout: 8000, clean: true }); } catch (e) { return; }
        c.on('connect', () => c.subscribe(this.base + sub));
        c.on('message', (t, buf) => { try { onMsg(JSON.parse(buf.toString())); } catch (e) { /* bad message */ } });
        c.on('error', () => { /* reconnects on its own */ });
        this.clients.push(c);
      });
    },
    stop() { this.clients.forEach(c => { try { c.end(true); } catch (e) { /* ignore */ } }); this.clients = []; },
    pub(ch, m) { const s = JSON.stringify(m); this.clients.forEach(c => { try { if (c.connected) c.publish(this.base + ch, s); } catch (e) { /* ignore */ } }); },
    up() { return this.clients.some(c => c.connected); }
  };
  const msgId = () => Math.random().toString(36).slice(2, 12);

  // =====================================================================
  // HOST (TV)
  // =====================================================================
  const Host = {
    S: null, peer: null, conns: [], code: null, net: 'connecting', tickTimer: null, lastTick: 0, spinRunning: false, heard: '',
    phones: {}, seen: [], seq: Date.now(),

    start(resume) {
      const saved = store.get(STATE_KEY);
      this.S = resume && saved ? saved : { phase: 'setup', settings: null, players: [], grid: null, used: {} };
      document.body.classList.add('host');
      this.code = store.get(CODE_KEY) || genCode();
      store.set(CODE_KEY, this.code);
      this.startPeer(0);
      this.startRelay();
      setInterval(() => { this.broadcast(); this.renderNet(); }, 3000);
      this.render();
      clearInterval(this.tickTimer);
      this.lastTick = now();
      this.tickTimer = setInterval(() => this.tick(), 100);
      document.addEventListener('keydown', e => this.key(e));
      setInterval(() => this.save(), 1000);
    },

    // ----- networking -----
    startPeer(attempt) {
      if (!window.Peer) { this.net = 'offline (remote unavailable)'; this.renderNet(); return; }
      try { if (this.peer) this.peer.destroy(); } catch (e) { /* ignore */ }
      const peer = new Peer(PEER_PREFIX + this.code, { debug: 0 });
      this.peer = peer;
      peer.on('open', () => { this.net = 'ready'; this.renderNet(); });
      peer.on('connection', c => {
        c.on('open', () => { this.conns.push(c); this.renderNet(); c.send({ t: 'state', n: ++this.seq, s: this.pub() }); });
        c.on('data', m => this.incoming(m));
        c.on('close', () => { this.conns = this.conns.filter(x => x !== c); this.renderNet(); });
        c.on('error', () => { this.conns = this.conns.filter(x => x !== c); this.renderNet(); });
      });
      peer.on('disconnected', () => { this.net = 'reconnecting'; this.renderNet(); setTimeout(() => { try { peer.reconnect(); } catch (e) { /* ignore */ } }, 1500); });
      peer.on('error', err => {
        if (err.type === 'unavailable-id') {
          // Usually the previous tab's registration has not expired yet. Keep the same code for a while.
          this.net = 'reserving code';
          this.renderNet();
          if (attempt >= 12) { this.code = genCode(); store.set(CODE_KEY, this.code); attempt = -1; this.startRelay(); this.render(); Setup.drawQR(); }
          setTimeout(() => this.startPeer(attempt + 1), 4000);
        } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' || err.type === 'socket-closed') {
          this.net = 'reconnecting';
          this.renderNet();
          setTimeout(() => this.startPeer(attempt + 1), 4000);
        }
      });
    },
    startRelay() { Relay.start(this.code, 'cmd', m => this.incoming(m)); },
    // Commands and hellos arrive over PeerJS and both relays; act on each one once.
    incoming(m) {
      if (!m) return;
      if (m.pid) { const fresh = !this.phones[m.pid] || now() - this.phones[m.pid] > 12000; this.phones[m.pid] = now(); if (fresh) this.renderNet(); }
      if (m.t === 'hello') { this.broadcast(); return; }
      if (m.t !== 'cmd') return;
      if (m.id) { if (this.seen.includes(m.id)) return; this.seen.push(m.id); if (this.seen.length > 200) this.seen.shift(); }
      this.dispatch(m.c, m.v);
    },
    broadcast() {
      const msg = { t: 'state', n: ++this.seq, s: this.pub() };
      this.conns.forEach(c => { try { if (c.open) c.send(msg); } catch (e) { /* ignore */ } });
      Relay.pub('state', msg);
    },
    phoneCount() { return Object.values(this.phones).filter(t => now() - t < 12000).length; },
    netText() {
      const n = this.phoneCount();
      if (n) return `Producer phone connected${n > 1 ? ' (' + n + ')' : ''}`;
      if (this.net === 'ready' || Relay.up()) return 'Waiting for producer phone';
      return 'Remote: ' + this.net;
    },
    renderNet() {
      document.querySelectorAll('[data-net]').forEach(el => { el.textContent = this.netText(); el.classList.toggle('ok', this.phoneCount() > 0); });
      document.querySelectorAll('[data-code]').forEach(el => { el.textContent = this.code; });
    },

    save() { if (this.S) store.set(STATE_KEY, this.S); },

    // Public state for the producer phone.
    pub() {
      const S = this.S, d = S.duel;
      const item = d ? this.item() : null;
      return {
        phase: S.phase, code: this.code, settings: S.settings, players: S.players, grid: S.grid,
        challenger: S.challenger, defender: S.defender, topicMode: S.topicMode, randomTopic: S.randomTopic,
        duelTopic: S.duelTopic, duelTopicName: S.duelTopic ? topicName(S.duelTopic) : (S.defender ? this.readyTopicName() : ''),
        options: S.phase === 'choose' ? this.eligible(S.challenger) : [],
        result: S.result, canRedo: !!S.preDuel,
        duel: d ? {
          active: d.active, clocks: d.clocks, pos: d.pos, answer: item && item.a, alt: (item && item.alt) || [],
          text: item && item.text, img: item && item.img, revealing: now() < d.revealUntil, paused: d.paused,
          countdown: Math.max(0, Math.ceil((d.countdownUntil - now()) / 1000)), canUndo: d.history.length > 0
        } : null
      };
    },

    player(id) { return this.S.players.find(p => p.id === id); },
    alive() { return this.S.players.filter(p => p.alive); },
    readyTopicName() { const S = this.S; return S.topicMode === 'random' ? topicName(S.randomTopic) : topicName(this.player(S.defender).topic); },

    // ----- grid -----
    buildGrid(ids) {
      const n = ids.length, cols = Math.ceil(Math.sqrt(n * 1.15)), rows = Math.ceil(n / cols);
      const order = shuffle(ids), cells = [];
      for (let i = 0; i < cols * rows; i++) cells.push(order[i] || null);
      // Spread empty squares out so the last row is centered instead of left-heavy.
      const empty = cols * rows - n;
      if (empty > 1) {
        const last = cells.slice((rows - 1) * cols).filter(Boolean);
        const pad = Math.floor((cols - last.length) / 2);
        const row = Array(cols).fill(null);
        last.forEach((id, i) => { row[pad + i] = id; });
        cells.splice((rows - 1) * cols, cols, ...row);
      }
      return { cols, rows, cells };
    },
    neighbors(i) {
      const { cols, rows } = this.S.grid, r = Math.floor(i / cols), c = i % cols, out = [];
      if (r > 0) out.push(i - cols); if (r < rows - 1) out.push(i + cols);
      if (c > 0) out.push(i - 1); if (c < cols - 1) out.push(i + 1);
      return out;
    },
    cellsOf(id) { return this.S.grid.cells.map((o, i) => (o === id ? i : -1)).filter(i => i >= 0); },
    eligible(chId) {
      const S = this.S, others = this.alive().filter(p => p.id !== chId).map(p => p.id);
      if (!S.settings.adjacent) return others;
      const set = new Set();
      this.cellsOf(chId).forEach(i => this.neighbors(i).forEach(j => { const o = S.grid.cells[j]; if (o && o !== chId) set.add(o); }));
      const adj = others.filter(id => set.has(id));
      return adj.length ? adj : others;
    },

    // ----- the game -----
    newGame(cfg) {
      const settings = Object.assign({ seconds: 45, penalty: 3, lives: 1, adjacent: true, sound: true, voice: false }, cfg.settings);
      const taken = new Set(cfg.players.map(p => p.topic).filter(t => TOPIC[t]));
      const players = cfg.players.map((p, i) => {
        let topic = p.topic;
        if (!TOPIC[topic]) { topic = pick(TOPICS.filter(t => !taken.has(t.id)).map(t => t.id)) || pick(TOPICS).id; taken.add(topic); }
        return { id: 'p' + (i + 1), name: p.name.trim().slice(0, 18) || 'Player ' + (i + 1), topic, bonus: +p.bonus || 0, lives: settings.lives, alive: true, color: COLORS[i % COLORS.length] };
      });
      this.S = { phase: 'board', settings, players, grid: this.buildGrid(players.map(p => p.id)), used: {}, history: [] };
      Sound.enabled = settings.sound;
      this.setVoice(settings.voice);
      this.changed();
    },

    dispatch(c, v) {
      const S = this.S;
      switch (c) {
        case 'setup': this.newGame(v); return;
        case 'spin': if (S.phase === 'board' && this.alive().length > 1) { S.phase = 'spin'; S.spinPick = pick(this.alive()).id; this.changed(); } return;
        case 'pickChallenger': if ((S.phase === 'board' || S.phase === 'choose') && this.player(v) && this.player(v).alive) { S.challenger = v; this.toChoose(); } return;
        case 'pickOpponent': if (S.phase === 'choose' && this.eligible(S.challenger).includes(v)) { S.defender = v; this.toReady(); } return;
        case 'topicMode':
          if (S.phase === 'ready') { S.topicMode = v === 'random' ? 'random' : 'defender'; if (S.topicMode === 'random') S.randomTopic = pick(TOPICS.filter(t => t.id !== this.player(S.defender).topic)).id; this.changed(); }
          return;
        case 'first': if (S.phase === 'ready' && (v === S.challenger || v === S.defender)) this.startDuel(v); return;
        case 'correct': this.correct(); return;
        case 'pass': this.pass(); return;
        case 'skip': this.skip(); return;
        case 'undoTap': this.undoTap(); return;
        case 'pause': if (S.phase === 'duel') { S.duel.paused = !S.duel.paused; this.changed(); } return;
        case 'goAgain': if (S.phase === 'result') { S.challenger = S.result.winner; this.toChoose(); } return;
        case 'toBoard': if (S.phase === 'result' || S.phase === 'choose' || S.phase === 'ready') { S.phase = 'board'; S.challenger = S.defender = null; this.changed(); } return;
        case 'redoDuel': if (S.preDuel && ['duel', 'result', 'over'].includes(S.phase)) { this.S = Object.assign(clone(S.preDuel), { preDuel: null }); this.changed(); } return;
        case 'rematch': this.newGame({ settings: S.settings, players: S.players.map(p => ({ name: p.name, topic: '__random', bonus: p.bonus })) }); return;
        case 'restart': if (S.phase === 'setup') return; // falls through: same players, same starting topics
        case 'samePlayers': this.newGame({ settings: S.settings, players: S.players.map(p => ({ name: p.name, topic: p.startTopic || p.topic, bonus: p.bonus })) }); return;
        case 'endGame':
        case 'editSetup': {
          if (S.phase === 'setup') return;
          if (S.players && S.players.length) store.set(DRAFT_KEY, { settings: S.settings, players: S.players.map(p => ({ name: p.name, topic: p.startTopic || p.topic, bonus: p.bonus })) });
          this.S = { phase: 'setup', players: [], used: {} }; this.changed(); return;
        }
      }
    },

    toChoose() {
      const S = this.S;
      S.phase = 'choose'; S.defender = null; S.duel = null; S.duelTopic = null;
      const opts = this.eligible(S.challenger);
      if (opts.length === 1) { S.defender = opts[0]; this.toReady(); return; }
      this.changed();
    },
    toReady() {
      const S = this.S;
      S.phase = 'ready'; S.topicMode = 'defender'; S.randomTopic = null; S.duel = null; S.duelTopic = null;
      this.preload(this.player(S.defender).topic, 12);
      this.changed();
    },
    buildDeck(topicId) {
      const n = TOPIC[topicId].items.length, used = new Set(this.S.used[topicId] || []);
      const all = [...Array(n).keys()];
      return shuffle(all.filter(i => !used.has(i))).concat(shuffle(all.filter(i => used.has(i))));
    },
    startDuel(firstId) {
      const S = this.S;
      S.players.forEach(p => { if (!p.startTopic) p.startTopic = p.topic; });
      const snap = clone(S); delete snap.preDuel;
      const topicId = S.topicMode === 'random' ? S.randomTopic : this.player(S.defender).topic;
      const clocks = {};
      [S.challenger, S.defender].forEach(id => { clocks[id] = (S.settings.seconds + (this.player(id).bonus || 0)) * 1000; });
      S.preDuel = snap;
      S.duelTopic = topicId;
      S.challengerTopic = this.player(S.challenger).topic;
      S.defenderTopic = this.player(S.defender).topic;
      S.duel = { active: firstId, clocks, deck: this.buildDeck(topicId), pos: 0, revealUntil: 0, flash: null, countdownUntil: now() + 3000, paused: false, history: [] };
      S.phase = 'duel';
      this.lastBeep = 4;
      this.preloadDeck();
      this.changed();
    },
    item() { const d = this.S.duel; return TOPIC[this.S.duelTopic].items[d.deck[d.pos]]; },
    duelLive() { const d = this.S.duel; return this.S.phase === 'duel' && d && !d.paused && now() >= d.countdownUntil && now() >= d.revealUntil; },
    other(id) { return id === this.S.challenger ? this.S.defender : this.S.challenger; },
    markUsed() { const S = this.S, d = S.duel, u = (S.used[S.duelTopic] = S.used[S.duelTopic] || []); const i = d.deck[d.pos]; if (!u.includes(i)) u.push(i); },
    advance() {
      const d = this.S.duel;
      d.pos++;
      if (d.pos >= d.deck.length) { d.deck = shuffle(d.deck); d.pos = 0; }
      this.preloadDeck();
    },
    pushHistory() { const d = this.S.duel; d.history.push({ active: d.active, clocks: clone(d.clocks), pos: d.pos, deck: d.deck.slice() }); if (d.history.length > 10) d.history.shift(); },
    correct() {
      if (!this.duelLive()) return;
      const d = this.S.duel;
      this.pushHistory();
      d.flash = { text: this.item().a, until: now() + 900 };
      this.markUsed();
      d.active = this.other(d.active);
      this.advance();
      Sound.correct();
      this.changed();
    },
    pass() {
      if (!this.duelLive()) return;
      const d = this.S.duel;
      this.pushHistory();
      d.revealUntil = now() + this.S.settings.penalty * 1000;
      d.revealText = this.item().a;
      Sound.pass();
      this.changed();
    },
    // Skip a broken or bad photo with no penalty.
    skip() {
      const d = this.S.duel;
      if (this.S.phase !== 'duel' || !d || now() < d.revealUntil) return;
      this.advance();
      this.changed();
    },
    undoTap() {
      const d = this.S.duel;
      if (this.S.phase !== 'duel' || !d || !d.history.length) return;
      const h = d.history.pop();
      Object.assign(d, { active: h.active, clocks: h.clocks, pos: h.pos, deck: h.deck, revealUntil: 0, flash: null });
      this.changed();
    },
    tick() {
      const t = now(), dt = t - this.lastTick;
      this.lastTick = t;
      const S = this.S;
      if (!S || S.phase !== 'duel') return;
      const d = S.duel;
      if (t < d.countdownUntil) {
        const n = Math.ceil((d.countdownUntil - t) / 1000);
        if (n !== this.lastCount) { this.lastCount = n; Sound.tick(); this.render(); }
        return;
      }
      if (this.lastCount !== 0) { this.lastCount = 0; this.render(); }
      if (d.paused) return;
      d.clocks[d.active] -= dt;
      if (d.revealUntil && t >= d.revealUntil) {
        d.revealUntil = 0;
        this.markUsed();
        this.advance();
        this.changed();
      }
      const left = d.clocks[d.active];
      const sec = Math.ceil(left / 1000);
      if (left > 0 && sec <= 5 && sec !== this.lastBeep) { this.lastBeep = sec; Sound.warn(); }
      if (sec > 5) this.lastBeep = 6;
      if (left <= 0) { d.clocks[d.active] = 0; this.finishDuel(this.other(d.active), d.active); return; }
      if (d.flash && t > d.flash.until) { d.flash = null; this.renderBanner(); }
      this.updateClocks();
      if (!this.lastSend || t - this.lastSend > 250) { this.lastSend = t; this.broadcast(); }
    },
    finishDuel(winnerId, loserId) {
      const S = this.S, W = this.player(winnerId), L = this.player(loserId);
      Sound.buzzer();
      L.lives -= 1;
      let eliminated = L.lives <= 0, moved = 0;
      if (eliminated) {
        L.alive = false; L.lives = 0;
        S.grid.cells = S.grid.cells.map(o => { if (o === loserId) { moved++; return winnerId; } return o; });
        // The winner keeps whichever topic was NOT just played.
        if (S.duelTopic === S.defenderTopic) W.topic = S.challengerTopic;
      } else {
        const lc = this.cellsOf(loserId);
        if (lc.length > 1) {
          const wc = new Set(this.cellsOf(winnerId).flatMap(i => this.neighbors(i)));
          const near = lc.filter(i => wc.has(i));
          S.grid.cells[pick(near.length ? near : lc)] = winnerId;
          moved = 1;
        }
      }
      S.result = { winner: winnerId, loser: loserId, eliminated, moved, livesLeft: L.lives };
      S.phase = this.alive().length <= 1 ? 'over' : 'result';
      S.duel.revealUntil = 0;
      if (S.phase === 'over') setTimeout(() => Sound.win(), 900);
      this.changed();
    },

    changed() { this.save(); this.render(); this.broadcast(); },

    // ----- preloading -----
    preload(topicId, n) {
      const t = TOPIC[topicId]; if (!t) return;
      const deck = this.buildDeck(topicId);
      deck.slice(0, n).forEach(i => { const it = t.items[i]; if (it.img) { const im = new Image(); im.src = it.img; } });
    },
    preloadDeck() {
      const d = this.S.duel, t = TOPIC[this.S.duelTopic];
      for (let k = 0; k < 8; k++) { const it = t.items[d.deck[(d.pos + k) % d.deck.length]]; if (it && it.img) { const im = new Image(); im.src = it.img; } }
    },

    // ----- voice -----
    setVoice(on) {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (this.rec) { this.voiceOn = false; try { this.rec.abort(); } catch (e) { /* ignore */ } this.rec = null; }
      if (!on || !SR) return;
      const rec = new SR();
      rec.continuous = true; rec.interimResults = true; rec.lang = 'en-US';
      rec.onresult = e => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const txt = e.results[i][0].transcript;
          this.heard = txt; this.renderHeard();
          if (!this.duelLive()) continue;
          if (heardMatches(txt, this.item())) { this.correct(); try { rec.abort(); } catch (x) { /* restarts on end */ } return; }
          if (/\bpass\b/i.test(txt)) { this.pass(); try { rec.abort(); } catch (x) { /* restarts on end */ } return; }
        }
      };
      rec.onend = () => { if (this.voiceOn && this.rec === rec) setTimeout(() => { try { rec.start(); } catch (e) { /* already started */ } }, 150); };
      rec.onerror = () => { /* onend restarts it */ };
      this.rec = rec; this.voiceOn = true;
      try { rec.start(); } catch (e) { /* ignore */ }
    },
    renderHeard() { const el = document.getElementById('heard'); if (el) { el.textContent = 'Heard: ' + this.heard; el.style.display = this.heard ? '' : 'none'; } },

    // ----- keyboard -----
    key(e) {
      if (e.target.closest && e.target.closest('input, select, textarea')) return;
      const S = this.S, k = e.key.toLowerCase();
      if (S.phase === 'duel') {
        if (k === ' ' || k === 'enter' || k === 'c') { e.preventDefault(); this.correct(); }
        else if (k === 'p') this.pass();
        else if (k === 's') this.skip();
        else if (k === 'z' || k === 'backspace') this.undoTap();
        else if (k === 'escape') this.dispatch('pause');
      } else if (S.phase === 'board' && (k === ' ' || k === 'enter')) { e.preventDefault(); this.dispatch('spin'); }
      else if (S.phase === 'result' && k === 'enter') this.dispatch('toBoard');
      if (k === 'f' && S.phase !== 'setup') { try { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); } catch (x) { /* ignore */ } }
    },

    // ----- rendering -----
    render() {
      const S = this.S;
      if (S.phase === 'setup') { if (!document.querySelector('.setup.host-setup')) Setup.mount(app, true); this.renderNet(); return; }
      const views = { board: this.vBoard, spin: this.vBoard, choose: this.vBoard, ready: this.vReady, duel: this.vDuel, result: this.vResult, over: this.vOver };
      app.innerHTML = `<div class="stage">${this.vTop()}${views[S.phase].call(this)}<div class="controls ${S.phase === 'duel' ? 'dim-ctl' : ''}">${controls(this.pub(), false)}</div></div>`;
      this.renderNet();
      if (S.phase === 'spin') this.runSpin();
      if (S.phase === 'duel') { this.updateClocks(); this.renderHeard(); }
      fitCells();
    },
    vTop() {
      const S = this.S, msg = {
        board: 'Spin the randomizer to pick a challenger',
        spin: 'Spinning...',
        choose: S.phase === 'choose' ? `${esc(this.player(S.challenger).name)}, pick who you want to challenge` : '',
        ready: 'Get ready', duel: '', result: '', over: ''
      }[S.phase];
      return `<div class="topbar"><div class="brand">THE FLOOR</div><div class="status">${msg}</div>
        <div class="topright">${gameMenu()}<div class="badge">Producer code <b data-code>${esc(this.code)}</b><br><span data-net class="net"></span></div></div></div>`;
    },
    vBoard() {
      const S = this.S, g = S.grid, lives = S.settings.lives > 1;
      const opts = S.phase === 'choose' ? new Set(this.eligible(S.challenger)) : null;
      const cellsHtml = g.cells.map((id, i) => {
        if (!id) return '<div class="cell void"></div>';
        const p = this.player(id);
        const cls = ['cell'];
        if (opts) { if (id === S.challenger) cls.push('ch'); else if (opts.has(id)) cls.push('pick'); else cls.push('dim'); }
        const attrs = opts && opts.has(id) ? ` data-cmd="pickOpponent" data-v="${id}"` : (S.phase === 'board' ? ` data-cmd="pickChallenger" data-v="${id}" title="Click to make ${esc(p.name)} the challenger"` : '');
        return `<div class="${cls.join(' ')}" data-cell="${i}" data-owner="${id}" style="background:${p.color}"${attrs}>
          <div class="cn">${esc(p.name)}</div><div class="ct">${esc(topicName(p.topic))}</div>
          ${lives ? `<div class="hearts">${'&#9829;'.repeat(p.lives)}</div>` : ''}</div>`;
      }).join('');
      return `<div class="floor-wrap"><div class="floor" style="grid-template-columns:repeat(${g.cols},1fr);--ratio:${(g.cols * 1.6 / g.rows).toFixed(3)}">${cellsHtml}</div></div>`;
    },
    runSpin() {
      if (this.spinRunning) return;
      this.spinRunning = true;
      const S = this.S, target = S.spinPick;
      const aliveIds = this.alive().map(p => p.id);
      let steps = 20 + Math.floor(Math.random() * 7), delay = 70;
      const order = [];
      for (let i = 0; i < steps - 1; i++) order.push(pick(aliveIds));
      order.push(target);
      let k = 0;
      const step = () => {
        document.querySelectorAll('.cell').forEach(c => c.classList.toggle('hi', c.dataset.owner === order[k]));
        Sound.tick();
        k++;
        if (k < order.length) { delay *= 1.06; setTimeout(step, delay); }
        else setTimeout(() => { this.spinRunning = false; if (this.S.phase === 'spin') { this.S.challenger = target; this.toChoose(); } }, 900);
      };
      setTimeout(step, 50);
    },
    vReady() {
      const S = this.S, a = this.player(S.challenger), b = this.player(S.defender);
      return `<div class="vs">
        <div class="vs-p" style="background:${a.color}"><div class="nm">${esc(a.name)}</div><div class="tp">Challenger</div></div>
        <div class="vs-x">VS</div>
        <div class="vs-p" style="background:${b.color}"><div class="nm">${esc(b.name)}</div><div class="tp">Defender</div></div>
      </div><div class="vs-topic">Category<b>${esc(this.readyTopicName())}</b></div>`;
    },
    vDuel() {
      const S = this.S, d = S.duel, it = this.item();
      const side = id => { const p = this.player(id); return `<div class="clock" id="clk-${id}" style="background:${p.color}"><div class="nm">${esc(p.name)}</div><div class="t">--</div></div>`; };
      const count = Math.ceil((d.countdownUntil - now()) / 1000);
      const media = it.text ? `<div class="txt">${esc(it.text)}</div>` : `<img src="${esc(it.img)}" alt="" onerror="window.__floorImgFail && window.__floorImgFail()">`;
      return `<div class="duel">
        <div class="clocks">${side(S.challenger)}<div class="duel-topic">${esc(topicName(S.duelTopic))}</div>${side(S.defender)}</div>
        <div class="pic">${media}<div id="banner"></div>
          ${count > 0 ? `<div class="overlay">${count}</div>` : ''}
          ${d.paused ? '<div class="overlay small">PAUSED</div>' : ''}
          <div class="heard" id="heard" style="display:none"></div></div>
      </div>`;
    },
    renderBanner() {
      const el = document.getElementById('banner'); if (!el) return;
      const d = this.S.duel, t = now();
      if (t < d.revealUntil) el.innerHTML = `<div class="banner reveal">${esc(d.revealText)}</div>`;
      else if (d.flash && t < d.flash.until) el.innerHTML = `<div class="banner right">&#10003; ${esc(d.flash.text)}</div>`;
      else el.innerHTML = '';
    },
    updateClocks() {
      const d = this.S.duel; if (!d) return;
      Object.keys(d.clocks).forEach(id => {
        const el = document.getElementById('clk-' + id); if (!el) return;
        el.querySelector('.t').textContent = fmt(d.clocks[id]);
        el.classList.toggle('on', id === d.active);
        el.classList.toggle('low', id === d.active && d.clocks[id] < 10000);
      });
      this.renderBanner();
    },
    vResult() {
      const S = this.S, r = S.result, W = this.player(r.winner), L = this.player(r.loser);
      const sub = r.eliminated ? `${esc(L.name)} is off the floor. ${esc(W.name)} takes the territory.`
        : `${esc(L.name)} loses a life (${r.livesLeft} left)${r.moved ? ' and a square' : ''}.`;
      return `<div class="result"><div><div class="big" style="color:${W.color}">${esc(W.name)} wins!</div><div class="sub">${sub}</div>
        <div class="sub">${esc(W.name)}, go again or head back to the floor?</div></div></div>`;
    },
    vOver() {
      const W = this.player(this.S.result.winner);
      return `<div class="result"><div><div class="sub">Champion of the Floor</div><div class="champ">${esc(W.name)}</div></div></div>`;
    }
  };
  window.__floorImgFail = () => Host.skip();

  // Size cell text to the cell.
  function fitCells() {
    const cell = document.querySelector('.cell:not(.void)');
    if (!cell) return;
    const w = cell.getBoundingClientRect().width;
    document.querySelectorAll('.cell').forEach(c => c.style.setProperty('--fs', Math.max(12, w / 6) + 'px'));
  }
  window.addEventListener('resize', fitCells);

  // Restart / End game, always available once a game is running (TV top bar and phone footer).
  const gameMenu = () => `<div class="gamemenu">
      <button class="ghost" data-cmd="restart" data-confirm="Restart from the beginning with the same players and categories?">Restart game</button>
      <button class="ghost" data-cmd="endGame" data-confirm="End this game and go back to the player setup screen?">End game</button></div>`;

  // Context buttons, shared by the TV control strip and the producer phone.
  function controls(s, phone) {
    const P = id => s.players.find(p => p.id === id) || { name: '?' };
    const b = (cmd, label, cls = '', v) => `<button class="${cls}" data-cmd="${cmd}"${v != null ? ` data-v="${esc(v)}"` : ''}>${label}</button>`;
    switch (s.phase) {
      case 'board':
        return b('spin', 'Spin the randomizer', 'primary') + (phone ? '' : ' <span class="muted">or click a square to pick the challenger yourself</span>');
      case 'spin': return '<span class="muted">Spinning...</span>';
      case 'choose':
        return phone ? '' : `<span class="muted">Click a flashing square to challenge them</span> ${b('toBoard', 'Back', 'ghost')}`;
      case 'ready':
        return `<span class="muted">Who goes first?</span> ${b('first', esc(P(s.challenger).name), 'good', s.challenger)} ${b('first', esc(P(s.defender).name), 'good', s.defender)}
          ${s.topicMode === 'random' ? b('topicMode', "Use defender's category", 'ghost', 'defender') : b('topicMode', 'Random category instead', 'ghost', 'random')}
          ${b('toBoard', 'Cancel', 'ghost')}`;
      case 'duel':
        return `${b('correct', 'Correct (Space)', 'good')} ${b('pass', 'Pass (P)', 'warn')} ${b('skip', 'Skip bad photo (S)', 'ghost')}
          ${b('undoTap', 'Undo tap (Z)', 'ghost')} ${b('pause', s.duel && s.duel.paused ? 'Resume' : 'Pause (Esc)', 'ghost')} ${b('redoDuel', 'Redo duel', 'ghost')}
          <span class="muted">F = full screen</span>`;
      case 'result':
        return `${b('goAgain', esc(P(s.result.winner).name) + ' goes again', 'good')} ${b('toBoard', 'Back to the floor (Enter)', 'primary')} ${b('redoDuel', 'Redo that duel', 'ghost')}`;
      case 'over':
        return `${b('samePlayers', 'Play again, same topics', 'primary')} ${b('rematch', 'Play again, random topics', 'good')} ${b('editSetup', 'Change players', 'ghost')} ${b('redoDuel', 'Redo last duel', 'ghost')}`;
    }
    return '';
  }

  // =====================================================================
  // SETUP FORM (TV and phone)
  // =====================================================================
  const Setup = {
    draft: null, isHost: true,
    mount(el, isHost) {
      this.isHost = isHost;
      this.el = el;
      this.draft = store.get(DRAFT_KEY) || {
        settings: { seconds: 45, penalty: 3, lives: 1, adjacent: true, sound: true, voice: false },
        players: [1, 2, 3, 4].map(() => ({ name: '', topic: '', bonus: 0 }))
      };
      this.render();
    },
    saveDraft() { store.set(DRAFT_KEY, this.draft); },
    render() {
      const d = this.draft, st = d.settings;
      const rows = d.players.map((p, i) => `<div class="prow">
          <div class="num">${i + 1}</div>
          <input class="pname" data-i="${i}" data-f="name" placeholder="Name" maxlength="18" value="${esc(p.name)}">
          <select data-i="${i}" data-f="topic">${topicOptions(p.topic)}</select>
          <select data-i="${i}" data-f="bonus" title="Extra seconds on this player's clock (great for little kids)">
            ${[0, 10, 20, 30].map(v => `<option value="${v}"${+p.bonus === v ? ' selected' : ''}>${v ? '+' + v + ' sec' : 'No boost'}</option>`).join('')}
          </select>
          <button class="ghost" data-act="remove" data-i="${i}" title="Remove">&#10005;</button>
        </div>`).join('');
      const opt = (val, cur, label) => `<option value="${val}"${String(val) === String(cur) ? ' selected' : ''}>${label}</option>`;
      const join = this.isHost ? `<div class="card"><h3>Producer phone</h3><div class="qrbox"><div class="qr" id="qr"></div>
          <div><div class="muted">Scan with the producer's phone, or go to this page on the phone and enter</div><div class="code" data-code>${esc(Host.code)}</div>
          <div class="net" data-net></div></div></div></div>` : '';
      this.el.innerHTML = `<div class="setup ${this.isHost ? 'host-setup' : 'phone-setup'}">
        <div class="setup-head"><h1>${this.isHost ? 'The Floor: Family Edition' : 'Game setup'}</h1>
          <div class="row"><button class="primary" data-act="start">Start the game</button></div></div>
        <div class="err" id="err"></div>
        <div class="setup-grid">
          <div class="card"><h3>Players (${d.players.length})</h3>${rows}
            <div class="row" style="margin-top:12px"><button data-act="add">+ Add player</button><button class="ghost" data-act="randomAll">Random topics for anyone without one</button><button class="ghost" data-act="clear">Clear list</button></div>
            <p class="muted" style="font-size:14px">Each player picks a category. The "boost" adds seconds to that player's clock in every duel, so a 5-year-old can hold their own against the adults.</p></div>
          <div>
            ${join}
            <div class="card" style="margin-top:${this.isHost ? '20px' : '0'}"><h3>Rules</h3>
              <div class="setting"><label>Game mode</label><select data-s="lives">
                ${opt(1, st.lives, 'Classic: lose a duel and you are out')}${opt(2, st.lives, 'Two lives')}${opt(3, st.lives, 'Three lives')}${opt(5, st.lives, 'Five lives')}</select></div>
              <div class="setting"><label>Clock per player, per duel</label><select data-s="seconds">
                ${[30, 45, 60, 90].map(v => opt(v, st.seconds, v + ' seconds')).join('')}</select></div>
              <div class="setting"><label>Pass penalty (answer shows while your clock keeps running)</label><select data-s="penalty">
                ${[2, 3, 5].map(v => opt(v, st.penalty, v + ' seconds')).join('')}</select></div>
              <label class="check"><input type="checkbox" data-s="adjacent"${st.adjacent ? ' checked' : ''}> Challengers can only pick a neighbor (like the show)</label>
              <label class="check"><input type="checkbox" data-s="sound"${st.sound ? ' checked' : ''}> Sound effects</label>
              <label class="check"><input type="checkbox" data-s="voice"${st.voice ? ' checked' : ''}> Voice answers (Chrome on the TV computer, needs a microphone)</label>
            </div>
          </div>
        </div></div>`;
      this.el.oninput = this.el.onchange = e => this.onInput(e);
      this.el.onclick = e => this.onClick(e);
      if (this.isHost) this.drawQR();
    },
    drawQR() {
      const box = document.getElementById('qr');
      if (!box || !window.QRCode) return;
      box.innerHTML = '';
      try { new QRCode(box, { text: remoteUrl(Host.code), width: 116, height: 116, correctLevel: QRCode.CorrectLevel.M }); } catch (e) { /* ignore */ }
    },
    onInput(e) {
      const t = e.target, d = this.draft;
      if (t.dataset.f) { d.players[+t.dataset.i][t.dataset.f] = t.dataset.f === 'bonus' ? +t.value : t.value; }
      if (t.dataset.s) { d.settings[t.dataset.s] = t.type === 'checkbox' ? t.checked : +t.value; }
      this.saveDraft();
    },
    onClick(e) {
      const btn = e.target.closest('[data-act]'); if (!btn) return;
      const d = this.draft, act = btn.dataset.act;
      if (act === 'add' && d.players.length < 30) d.players.push({ name: '', topic: '', bonus: 0 });
      if (act === 'remove') d.players.splice(+btn.dataset.i, 1);
      if (act === 'clear') d.players = [1, 2, 3, 4].map(() => ({ name: '', topic: '', bonus: 0 }));
      if (act === 'randomAll') {
        const taken = new Set(d.players.map(p => p.topic));
        d.players.forEach(p => { if (!TOPIC[p.topic]) { const t = pick(TOPICS.filter(x => !taken.has(x.id))); if (t) { p.topic = t.id; taken.add(t.id); } } });
      }
      if (act === 'start') return this.start();
      this.saveDraft();
      this.render();
    },
    start() {
      const d = this.draft, err = document.getElementById('err');
      const players = d.players.filter(p => p.name.trim());
      if (players.length < 2) { err.textContent = 'Add at least two players with names.'; return; }
      const names = players.map(p => p.name.trim().toLowerCase());
      if (new Set(names).size !== names.length) { err.textContent = 'Two players have the same name. Add a last initial so the board is clear.'; return; }
      const topics = players.map(p => p.topic).filter(t => TOPIC[t]);
      if (new Set(topics).size !== topics.length) { err.textContent = 'Two players picked the same category. Each player needs their own.'; return; }
      const cfg = { settings: d.settings, players: players.map(p => ({ name: p.name.trim(), topic: p.topic, bonus: p.bonus })) };
      if (this.isHost) Host.newGame(cfg); else Remote.send('setup', cfg);
    }
  };

  // =====================================================================
  // PRODUCER REMOTE (phone)
  // =====================================================================
  const Remote = {
    peer: null, conn: null, code: '', s: null, status: 'Connecting...', ok: false, key: '', setupOpen: false,
    pid: msgId(), lastN: 0, lastState: 0, connAt: 0,
    start(code) {
      document.body.classList.add('phone');
      this.setCode(code);
      if (window.Peer) {
        this.peer = new Peer({ debug: 0 });
        this.peer.on('open', () => this.connect());
        this.peer.on('error', () => { /* the 2-second check below retries */ });
        this.peer.on('disconnected', () => { setTimeout(() => { try { this.peer.reconnect(); } catch (e) { /* ignore */ } }, 1500); });
      }
      if (!window.Peer && !window.mqtt) this.setStatus('Could not load the connection library. Check internet.', false);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) { this.hello(); if (!(this.conn && this.conn.open)) this.connect(); } });
      // Every 2 seconds: say hello over the relays, refresh the status, and retry the direct link if it stalled.
      setInterval(() => {
        this.hello();
        this.updateStatus();
        if (this.peer && !(this.conn && this.conn.open) && now() - this.connAt > 10000) this.connect();
      }, 2000);
      app.addEventListener('click', e => {
        const b = e.target.closest('[data-cmd]');
        if (b) { if (b.dataset.confirm && !confirm(b.dataset.confirm)) return; if (navigator.vibrate) navigator.vibrate(30); this.send(b.dataset.cmd, b.dataset.v); }
        const a = e.target.closest('[data-ract]');
        if (a && a.dataset.ract === 'setup') { this.setupOpen = true; this.key = ''; this.render(); }
        if (a && a.dataset.ract === 'closeSetup') { this.setupOpen = false; this.key = ''; this.render(); }
        if (a && a.dataset.ract === 'recode') {
          const c = (document.getElementById('rcode').value || '').trim().toUpperCase();
          if (c.length === 4) { history.replaceState(null, '', '?remote=' + c); this.setCode(c); this.connect(); }
        }
      });
    },
    setCode(code) {
      this.code = code.toUpperCase();
      this.s = null; this.lastN = 0; this.lastState = 0; this.key = '';
      this.setStatus('Looking for the TV...', false);
      Relay.start(this.code, 'state', m => this.onState(m));
      this.render();
      setTimeout(() => this.hello(), 1500);
    },
    hello() { Relay.pub('cmd', { t: 'hello', pid: this.pid }); },
    // State arrives over PeerJS and both relays; keep only the newest.
    onState(m) {
      if (!m || m.t !== 'state' || !m.s) return;
      this.lastState = now();
      if (m.n && m.n <= this.lastN) { this.updateStatus(); return; }
      this.lastN = m.n || this.lastN;
      this.s = m.s; if (m.s.phase !== 'setup') this.setupOpen = false;
      this.updateStatus();
      this.render();
    },
    updateStatus() {
      if ((this.conn && this.conn.open) || now() - this.lastState < 8000) this.setStatus('Connected', true);
      else if (this.s) this.setStatus('Lost the TV, reconnecting...', false);
      else this.setStatus(`Looking for the TV with code ${this.code}...`, false);
    },
    connect() {
      if (!this.peer || this.peer.destroyed) return;
      this.connAt = now();
      if (this.peer.disconnected) { try { this.peer.reconnect(); } catch (e) { /* ignore */ } return; }
      if (!this.peer.open) return;
      const old = this.conn;
      this.conn = null;
      if (old) { try { old.removeAllListeners(); old.close(); } catch (e) { /* ignore */ } }
      const c = this.peer.connect(PEER_PREFIX + this.code, { reliable: true });
      this.conn = c;
      c.on('open', () => { if (this.conn === c) { c.send({ t: 'hello', pid: this.pid }); this.updateStatus(); } });
      c.on('data', m => { if (this.conn === c) this.onState(m); });
      c.on('close', () => { if (this.conn === c) this.updateStatus(); });
    },
    setStatus(t, ok) { this.status = t; this.ok = ok; const el = document.getElementById('conn'); if (el) { el.textContent = t; el.className = 'conn ' + (ok ? 'ok' : 'bad'); } },
    send(c, v) {
      const m = { t: 'cmd', c, v, id: msgId(), pid: this.pid };
      let sent = false;
      if (this.conn && this.conn.open) { try { this.conn.send(m); sent = true; } catch (e) { /* use relay */ } }
      if (Relay.up()) { Relay.pub('cmd', m); sent = true; }
      if (!sent) this.setStatus('Not connected to the TV', false);
    },
    render() {
      const s = this.s;
      if (this.setupOpen || (s && s.phase === 'setup' && this.setupOpen)) {
        if (!document.querySelector('.phone-setup')) {
          Setup.mount(app, false);
          app.querySelector('.setup-head .row').insertAdjacentHTML('afterbegin', '<button class="ghost" data-ract="closeSetup">Back</button>');
        }
        return;
      }
      // Rebuild the screen only when something other than the clocks changed, so taps are never lost.
      const key = JSON.stringify(s ? [s.phase, s.challenger, s.defender, s.topicMode, s.randomTopic, s.options, s.result, s.duel && [s.duel.pos, s.duel.active, s.duel.revealing, s.duel.paused, s.duel.countdown > 0, s.duel.canUndo, s.duel.answer]] : null);
      if (key !== this.key || !document.querySelector('.remote')) { this.key = key; app.innerHTML = this.view(); }
      this.updateClocks();
    },
    updateClocks() {
      const d = this.s && this.s.duel; if (!d) return;
      Object.keys(d.clocks).forEach(id => { const el = document.getElementById('rc-' + id); if (el) el.textContent = fmt(d.clocks[id]); });
    },
    view() {
      const s = this.s;
      const head = `<div class="rhead"><div class="display">Producer</div><div id="conn" class="conn ${this.ok ? 'ok' : 'bad'}">${esc(this.status)}</div></div>`;
      if (!s) return `<div class="remote">${head}<div class="rnote"><div class="display">Code ${esc(this.code)}</div><p class="muted">Open the game on the TV computer. This phone connects on its own within a few seconds.</p>
        <p class="muted">Wrong code? Type the code shown on the TV:</p>
        <div class="row join-box" style="justify-content:center;margin-top:0"><input id="rcode" maxlength="4" autocomplete="off" autocapitalize="characters" value="${esc(this.code)}"><button class="primary" data-ract="recode">Connect</button></div></div></div>`;
      const P = id => s.players.find(p => p.id === id) || { name: '?', color: '#333' };
      let body = '';
      switch (s.phase) {
        case 'setup':
          body = `<div class="rnote"><div class="display">Setting up</div><p class="muted">Enter players on the TV, or set up the whole game from this phone.</p>
            <button class="primary" data-ract="setup">Set up players from this phone</button></div>`;
          break;
        case 'board': {
          body = `<div class="bigbtns"><button class="primary correct" data-cmd="spin">SPIN</button></div>
            <div class="muted">Or pick the challenger yourself:</div>
            <div class="rlist">${s.players.filter(p => p.alive).map(p => `<button data-cmd="pickChallenger" data-v="${p.id}" style="background:${p.color}"><span>${esc(p.name)}</span><small>${esc(topicName(p.topic))}</small></button>`).join('')}</div>`;
          break;
        }
        case 'spin': body = '<div class="rnote"><div class="display">Spinning...</div></div>'; break;
        case 'choose':
          body = `<div class="rnote"><div class="display">${esc(P(s.challenger).name)} is the challenger</div><p class="muted">Who do they challenge? (Duel is in the defender's category.)</p></div>
            <div class="rlist">${s.options.map(id => `<button data-cmd="pickOpponent" data-v="${id}" style="background:${P(id).color}"><span>${esc(P(id).name)}</span><small>${esc(topicName(P(id).topic))}</small></button>`).join('')}</div>
            <button class="ghost" data-cmd="toBoard">Back to the floor</button>`;
          break;
        case 'ready':
          body = `<div class="rnote"><div class="display">${esc(P(s.challenger).name)} vs ${esc(P(s.defender).name)}</div><p>Category: <b>${esc(s.duelTopicName)}</b></p></div>
            <div class="muted">Who goes first? (starts the 3-2-1)</div>
            <div class="rlist">${[s.challenger, s.defender].map(id => `<button data-cmd="first" data-v="${id}" style="background:${P(id).color}"><span>${esc(P(id).name)}</span><small>${id === s.challenger ? 'Challenger' : 'Defender'}</small></button>`).join('')}</div>
            <div class="row">${s.topicMode === 'random' ? '<button class="ghost" data-cmd="topicMode" data-v="defender">Use defender\'s category</button>' : '<button class="ghost" data-cmd="topicMode" data-v="random">Random category instead</button>'}
            <button class="ghost" data-cmd="toBoard">Cancel</button></div>`;
          break;
        case 'duel': {
          const d = s.duel;
          const clk = id => `<div class="rclock ${d.active === id ? 'on' : ''}" style="background:${P(id).color}"><div class="nm">${esc(P(id).name)}</div><div class="t" id="rc-${id}">${fmt(d.clocks[id])}</div></div>`;
          const thumb = d.text ? `<div class="thumb">${esc(d.text)}</div>` : `<div class="thumb" style="background-image:url('${esc(d.img)}')"></div>`;
          const state = d.countdown > 0 ? 'Get ready...' : d.paused ? 'PAUSED' : d.revealing ? 'Passed, showing answer' : '';
          body = `<div class="rclocks">${clk(s.challenger)}${clk(s.defender)}</div>
            <div class="answer">${thumb}<div><div class="a">${esc(d.answer)}</div>${d.alt.length ? `<div class="alt">Also OK: ${esc(d.alt.join(', '))}</div>` : ''}${state ? `<div class="alt" style="color:var(--warn)">${state}</div>` : ''}</div></div>
            <div class="bigbtns"><button class="good correct" data-cmd="correct">CORRECT</button><button class="warn pass" data-cmd="pass">PASS</button></div>
            <div class="smallbtns"><button data-cmd="undoTap"${d.canUndo ? '' : ' disabled'}>Undo tap</button><button data-cmd="skip">Bad photo, skip</button><button data-cmd="pause">${d.paused ? 'Resume' : 'Pause'}</button></div>
            <button class="ghost" data-cmd="redoDuel">Redo this duel from the start</button>`;
          break;
        }
        case 'result': {
          const r = s.result;
          body = `<div class="rnote"><div class="display" style="color:${P(r.winner).color}">${esc(P(r.winner).name)} wins</div>
            <p class="muted">${r.eliminated ? esc(P(r.loser).name) + ' is out.' : esc(P(r.loser).name) + ' has ' + r.livesLeft + ' ' + (r.livesLeft === 1 ? 'life' : 'lives') + ' left.'}</p></div>
            <div class="rlist"><button class="good" data-cmd="goAgain">${esc(P(r.winner).name)} goes again</button><button class="primary" data-cmd="toBoard">Back to the floor</button></div>
            <button class="ghost" data-cmd="redoDuel">Redo that duel</button>`;
          break;
        }
        case 'over':
          body = `<div class="rnote"><div class="display">Champion: ${esc(P(s.result.winner).name)}</div></div>
            <div class="rlist"><button class="primary" data-cmd="samePlayers">Play again, same topics</button><button class="good" data-cmd="rematch">Play again, random topics</button>
            <button class="ghost" data-cmd="editSetup">Change players</button><button class="ghost" data-cmd="redoDuel">Redo last duel</button></div>`;
          break;
      }
      return `<div class="remote">${head}${body}${s.phase !== 'setup' ? gameMenu() : ''}</div>`;
    }
  };

  // =====================================================================
  // HOME
  // =====================================================================
  function home() {
    const saved = store.get(STATE_KEY);
    const inProgress = saved && saved.phase && saved.phase !== 'setup';
    app.innerHTML = `<div class="home"><div class="home-card">
      <div class="logo">THE FLOOR</div><div class="logo-sub">Family Edition</div>
      <div class="home-choices">
        <button class="primary" id="go-tv">This is the TV screen<small>Runs the board, photos and clocks</small></button>
        <button id="go-phone">I'm the producer<small>Phone remote with the answers</small></button>
      </div>
      ${inProgress ? '<div style="margin-top:16px"><button class="good" id="go-resume">Resume the game in progress on this screen</button></div>' : ''}
      <div class="join-box" id="join" style="display:none"><p class="muted">Enter the code shown on the TV</p>
        <div class="row" style="justify-content:center"><input id="code" maxlength="4" autocomplete="off" autocapitalize="characters"><button class="primary" id="go-join">Connect</button></div></div>
      <p class="muted" style="margin-top:28px;font-size:14px">${TOPICS.length} categories, ${TOPICS.reduce((s, t) => s + t.items.length, 0)} pictures</p>
    </div></div>`;
    document.getElementById('go-tv').onclick = () => { if (inProgress && !confirm('Start a NEW game? (The game in progress will be replaced once you press Start.)')) return; history.replaceState(null, '', '?tv'); Host.start(false); };
    if (inProgress) document.getElementById('go-resume').onclick = () => { history.replaceState(null, '', '?tv'); Host.start(true); };
    document.getElementById('go-phone').onclick = () => { document.getElementById('join').style.display = ''; document.getElementById('code').focus(); };
    document.getElementById('go-join').onclick = () => {
      const c = document.getElementById('code').value.trim().toUpperCase();
      if (c.length === 4) { history.replaceState(null, '', '?remote=' + c); Remote.start(c); }
    };
  }

  // Clicks on [data-cmd] in the TV view go straight to the host.
  app.addEventListener('click', e => {
    if (!document.body.classList.contains('host')) return;
    const b = e.target.closest('[data-cmd]');
    if (b) { b.blur(); if (b.dataset.confirm) { const ok = confirm(b.dataset.confirm); Host.lastTick = now(); if (!ok) return; } Host.dispatch(b.dataset.cmd, b.dataset.v); }
  });

  if (params.get('remote')) Remote.start(params.get('remote'));
  else if (params.has('tv')) Host.start(true);
  else home();
})();
