/* Analyst Office — a pixel-office where each analyst is a crab agent that
 * really follows the analysis pipeline:
 *  - clocks in through the door when the planner selects it
 *  - walks to the data station while its data is being fetched
 *  - types at its desk while running (bubbles show the REAL step text)
 *  - delivers its result to the results board (bubble = REAL headline)
 *  - joins the synthesis meeting at the whiteboard
 *  - gathers to hear the final decision, then goes back to ambient office life
 *
 * window.AnalystOffice(container) ->
 *   { upsert(info), setRegistry(list), setStep(label, detail, status),
 *     celebrate(text, classification), clear(), destroy() }
 */
(function () {
  // roundRect fallback for older browsers (Safari < 16, old Chromium).
  if (typeof CanvasRenderingContext2D !== 'undefined' && !CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h) { this.rect(x, y, w, h); };
  }

  // -- crab sprite (16x16, two leg frames) -----------------------------------
  const TOP = [
    '................',
    '....WW....WW....',
    '....WK....WK....',
    '....WW....WW....',
    '.....W....W.....',
    '.....OOOOOO.....',
    '....OOOOOOOO....',
    '...OOOOOOOOOO...',
    '.CC.OOOOOOOO.CC.',
    'CCCOOOOOOOOOOCCC',
    'CCOOOOOOOOOOOOCC',
    '..OOOOOOOOOOOO..',
    '...OOOOOOOOOO...',
  ];
  const LEGS_A = [
    '.LL.......LL....',  // row 13: pairs 1&3 forward (power stroke)
    '.....LL.......LL',  // row 14: pairs 2&4 back (recovery)
  ];
  const LEGS_B = [
    '.....LL.......LL',  // row 13: pairs 2&4 forward
    '.LL.......LL....',  // row 14: pairs 1&3 back
  ];
  const BOTTOM = ['................', '................'];
  const FRAME_A = TOP.concat(LEGS_A, BOTTOM);
  const FRAME_B = TOP.concat(LEGS_B, BOTTOM);

  // Each analyst gets a distinct skin + accessory from a stable hash of its id.
  const SKINS = [
    { O: '#E56F4C', C: '#F0927A', L: '#A8401F' }, // coral
    { O: '#4C8DE5', C: '#7AB0F0', L: '#1F5BA8' }, // blue
    { O: '#3FA96F', C: '#6FC895', L: '#1F7040' }, // green
    { O: '#9A6FD0', C: '#B894E0', L: '#5F3A90' }, // purple
    { O: '#D9A03F', C: '#E8BE72', L: '#8A5F1F' }, // amber
    { O: '#3FAAB5', C: '#72CCD6', L: '#1F6E77' }, // teal
    { O: '#E56FA8', C: '#F092C0', L: '#A8406B' }, // pink
    { O: '#D95F5F', C: '#E88A8A', L: '#8A2F2F' }, // red
  ];
  const ACCESSORIES = ['none', 'cap', 'glasses', 'headset', 'tie', 'coffee', 'hardhat', 'bow'];

  function hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(h, 31) + str.charCodeAt(i)) >>> 0;
    return h;
  }

  // Ambient chatter (used when no real task text is available).
  const TASK_LINES = {
    statistical: ['computing mean…', 'σ running high', 'median first…'],
    trend: ['slope turning up', 'low R², be careful', 'trend weakening…'],
    anomaly: ['outlier found!', 'zscore 3.2 👀', 'this looks off…'],
    correlation: ['r=0.98 btw', 'strong positive', 'check lag first…'],
    forecasting: ['wide intervals…', 'linear first', '30-point horizon'],
    comparative: ['who is leading?', 'normalize base=100', 'spread narrowing'],
    regime: ['regime shift?', 'volatility up', 'new phase'],
    levels: ['strong support', 'resistance above', 'ATR 2× watch'],
    causal: ['correlation ≠ causation', 'test the hypothesis first'],
    technical: ['RSI neutral…', 'MACD negative', 'ADX weak', 'bollinger squeeze'],
    'onchain-whale': ['whale moving 🐋', 'netflow out!', 'exchange inflow up'],
    sentiment: ['quiet news…', 'bullish headline', 'mixed sentiment'],
    macro: ['DXY flat', 'risk-off tone', 'check calendar…'],
    'market-risk': ['ATR 2.1%', 'stop at support', 'risk/reward ok'],
    'game-performance': ['FPS drop here', 'frametime spike!', 'change point found'],
    'game-dependency': ['circular dep!', 'deep graph…'],
  };
  const GENERIC_TASK = ['crunching data…', 'waiting on fetch…', 'hmm…', 'checking tables first'];
  const CHAT_LINES = [
    ['coffee first ☕', 'go', 'how is your chart?', 'tired of fetching'],
    ['data looks odd today', 'yeah, lots of noise', '5-min meeting?', 'right after this'],
    ['check the whiteboard', 'one sec', 'nice chart 📈', 'thanks 🦀'],
  ];
  const CHILL_LINES = ['work done ✓', '☕ chilling…', 'report sent', 'waiting for new tasks'];
  const FAIL_LINES = ['thin data…', 'fetch failed 😤', 'retry later', 'source offline…'];
  const MEETING_LINES = ['agreed 👍', 'data backs it', 'something looks off…', 'strong evidence', 'objection: small sample', 'noted the decision', 'r is significant', 'check anomalies first', 'ok, moving on', 'how would this invalidate?'];

  const CRAB_SCALE = 2.2;
  const WALK_SPEED = 52; // px/s

  class AnalystOffice {
    constructor(container) {
      this.container = container;
      this.container.innerHTML = '';
      this.canvas = document.createElement('canvas');
      this.canvas.style.cssText = 'width:100%;height:100%;display:block';
      container.appendChild(this.canvas);
      this.ctx = this.canvas.getContext('2d');
      this.crabs = new Map();
      this.registry = new Map(); // lowercase name or id -> canonical id
      this.planSteps = null;     // pipeline rail (real plan steps)
      this.packets = [];         // data-flow particles synced to phases
      this.evidenceCount = 0;    // pinned on the results board, live
      // Cinematic camera: smooth zoom toward a focus point.
      this.camera = { zoom: 1, targetZoom: 1, focus: { x: 0, y: 0 }, hold: 0 };
      // Verdict flood: the whole room flashes the decision color.
      this.flood = null; // { color: 'r,g,b', t: seconds remaining }
      // Slow motion (whale moment): time scale for crab updates.
      this.timeScale = 1;
      this.slowMo = 0;   // seconds of slow-mo remaining
      // Ambient life: dust motes, screen glints, idle chatter particles.
      this.ambient = [];
      this._destroyed = false;
      this.now = performance.now() / 1000;
      this.resize();
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(container);
      this._last = performance.now();
      this._raf = requestAnimationFrame((t) => this.loop(t));
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      if (!w || !h) return;
      this.w = w;
      this.h = h;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.layoutDesks();
    }

    // -- public API -----------------------------------------------------------
    setRegistry(list) {
      this.registry.clear();
      for (const a of list) {
        this.registry.set(String(a.id).toLowerCase(), a.id);
        if (a.name) this.registry.set(String(a.name).toLowerCase(), a.id);
      }
    }

    resolveId(key) {
      const k = String(key).toLowerCase();
      if (this.registry.has(k)) return this.registry.get(k);
      for (const [name, id] of this.registry) {
        if (k.includes(name) || name.includes(k)) return id;
      }
      return key;
    }

    clear() {
      this.crabs.clear();
      this.layoutDesks(); // resync panel height back to the empty state
    }

    /** New analysis starting: keep the staff, just send everyone back to idle.
     *  Selected analysts are re-activated via upsert() — no respawn flicker. */
    idleAll() {
      for (const crab of this.crabs.values()) {
        crab.status = 'idle';
        crab.taskText = null;
        crab.bubbleText = null;
        if (crab.state !== 'walk') this.walkHome(crab);
      }
    }

    upsert(info) {
      const id = this.resolveId(info.id);
      let crab = this.crabs.get(id);
      if (!crab) {
        const h = hash(id);
        crab = {
          id,
          skin: SKINS[h % SKINS.length],
          accessory: ACCESSORIES[(h >> 4) % ACCESSORIES.length],
          // Clock-in position is set after layoutDesks() syncs panel height.
          x: -24,
          y: 0,
          flip: false,
          state: 'arrive',
          timer: 0,
          bubbleText: null,
          bubbleKind: 'task',
          bubbleUntil: 0,
          frame: 0,
          frameT: 0,
          status: 'running',
          taskText: null,
          chatWith: null,
          chatTimer: 0,
          chatIdx: 0,
          workLog: null,
          workLogIdx: 0,
          workLogTimer: 0,
          pendingHeadline: null,
          finalSaid: false,
          speed: 0,
          target: null,
          onArrive: null,
          meta: {},
        };
        this.crabs.set(id, crab);
        this.layoutDesks(); // syncs panel height -> this.h is now final
        // Enter through the IN door (bottom-left), then walk to the desk.
        crab.x = -24;
        crab.y = this.h - 45;
        this.retarget(crab, { x: crab.desk.x, y: crab.desk.y + 26 }, () => {
          crab.state = 'work';
          crab.timer = 3 + Math.random() * 4;
        });
        crab.state = 'walk';
      }
      const prev = crab.status;
      crab.status = info.status;
      crab.meta = info;
      if (info.status === 'ok' && prev !== 'ok') {
        // Freeze the real duration the moment the result arrives.
        if (crab.startedAt !== undefined) crab.finalMs = (this.now - crab.startedAt) * 1000;
        // Deliver: the crab reads out what it ACTUALLY computed (real evidence
        // labels), then its headline — its bubble stays in sync with its job.
        crab.workLog = (info.evidenceLabels || []).slice(0, 4).map((t) => truncate(t, 46));
        crab.workLogIdx = 0;
        crab.workLogTimer = 0.4;
        crab.pendingHeadline = info.headline ? truncate(info.headline, 52) : 'done ✓';
        crab.finalSaid = false;
        const slot = [...this.crabs.keys()].indexOf(crab.id);
        const rp = this.resultsPoint();
        this.retarget(crab, { x: rp.x + ((slot % 5) - 2) * 20, y: rp.y + Math.floor(slot / 5) * 14 }, () => {
          crab.state = 'deliver';
          crab.timer = 1 + crab.workLog.length * 1.9 + 3.4;
        });
        crab.state = 'walk';
      } else if (info.status === 'fail' && prev !== 'fail') {
        const slot = [...this.crabs.keys()].indexOf(crab.id);
        const rp = this.resultsPoint();
        this.retarget(crab, { x: rp.x + ((slot % 5) - 2) * 20, y: rp.y }, () => {
          crab.state = 'deliver';
          crab.timer = 2.6;
          this.say(crab, info.headline ? truncate(info.headline, 46) : pick(FAIL_LINES), 'fail', 3.2);
        });
        crab.state = 'walk';
      }
    }

    /** Pipeline rail: the real plan steps, rendered above the office. */
    setPlan(steps) {
      this.planSteps = (steps || []).map((s) => ({ label: s.label, status: s.status || 'pending' }));
      this.evidenceCount = 0; // new run: the results board starts empty
      this.packets = [];
    }

    /** Spawn a stream of data packets from one point to another.
     *  from/to may be points or functions (evaluated per packet, so packets
     *  track moving targets like a crab's desk). */
    flow(from, to, kind) {
      const n = kind === 'evidence' ? 10 : 6;
      for (let i = 0; i < n; i++) {
        this.packets.push({
          from, to, kind,
          t: -i * 0.12, // staggered launch
          dur: 1.1 + Math.random() * 0.5,
        });
      }
      if (this.packets.length > 160) this.packets.splice(0, this.packets.length - 160);
    }

    /** One piece of evidence was pinned (called as the crab reads it aloud). */
    pinEvidence() {
      this.evidenceCount++;
    }

    /** Cinematic zoom toward a point; auto-returns after `hold` seconds. */
    zoomTo(point, zoom, hold) {
      this.camera.focus = { x: point.x, y: point.y };
      this.camera.targetZoom = zoom;
      this.camera.hold = hold;
    }

    /** Whale moment: slow everything down and have a crab shout. */
    whaleAlert(value) {
      if (this.slowMo > 0) return; // one moment at a time
      this.slowMo = 2.2;
      const crabs = [...this.crabs.values()];
      if (crabs.length) {
        const spotter = crabs[Math.floor(Math.random() * crabs.length)];
        this.say(spotter, `🐋 WHALE ${value}!`, 'task', 2.4);
      }
    }

    /** Route the office from a REAL pipeline step. */
    setStep(label, detail, status) {
      // Keep the rail in sync with the live step stream.
      if (this.planSteps) {
        const node = this.planSteps.find((s) => s.label === label);
        if (node) node.status = status;
      }
      const runningCrabs = () => [...this.crabs.values()].filter((c) => c.status === 'running');

      let m = /^(?:fetch data from|collect data from:?|collect data)\s*(.*)/i.exec(label || '');
      if (m) {
        if (status === 'running') {
          // Everyone still working walks to the data station to help fetch.
          for (const crab of runningCrabs()) {
            this.retarget(crab, this.stationPoint(), () => { crab.state = 'fetching'; crab.timer = 6; });
            // Data packets fly from the station toward each fetching crab.
            this.flow(this.stationPoint(), () => crab.desk, 'data');
          }
          const first = runningCrabs()[0];
          if (first) this.say(first, m[1] ? `fetch ${truncate(m[1], 28)}…` : 'collect data…', 'task', 3);
        } else {
          for (const crab of this.crabs.values()) if (crab.state === 'fetching') this.walkHome(crab);
        }
        return;
      }

      m = /^run analyst: (.+)/i.exec(label || '');
      if (m) {
        const crab = this.crabs.get(this.resolveId(m[1].trim()));
        if (crab && status === 'running') {
          crab.taskText = m[1].trim();
          crab.startedAt = this.now; // live duration timer starts NOW
          crab.finalMs = null;
          this.retarget(crab, { x: crab.desk.x, y: crab.desk.y + 26 }, () => { crab.state = 'work'; crab.timer = 8; });
          this.say(crab, `mulai: ${m[1].trim()}`, 'task', 2.6);
        }
        return;
      }

      if (/synthesize evidence/i.test(label || '')) {
        if (status === 'running') {
          // All-hands meeting at the meeting room; evidence streams converge.
          const crabs = [...this.crabs.values()];
          for (const crab of crabs) this.flow(() => crab.desk, () => this.meetingTable(), 'evidence');
          this.zoomTo(this.meetingTable(), 1.28, 12); // cinematic push-in
          crabs.forEach((crab, i) => {
            this.retarget(crab, this.meetingPoint(i, crabs.length), () => { crab.state = 'meeting'; crab.timer = 14; });
            crab.state = 'walk';
          });
          const lead = crabs[0];
          if (lead) this.say(lead, detail ? truncate(detail, 40) : 'rapat synthesis!', 'chat', 3.2);
        } else {
          for (const crab of this.crabs.values()) if (crab.state === 'meeting') this.walkHome(crab);
        }
        return;
      }

      if (/select visualizations|compose decision/i.test(label || '')) {
        if (status === 'running') {
          const crabs = [...this.crabs.values()];
          const lead = crabs[crabs.length - 1];
          if (lead) this.say(lead, detail ? truncate(detail, 40) : label, 'chat', 3);
        }
        return;
      }
    }

    /** Final result: everyone gathers mid-office for the decision. */
    celebrate(text, classification) {
      const crabs = [...this.crabs.values()];
      if (!crabs.length) return;
      const kind = classification === 'insufficient-evidence' ? 'fail' : 'ok';
      crabs.forEach((crab, i) => {
        this.retarget(crab, this.meetingPoint(i, crabs.length), () => {
          crab.state = 'celebrate';
          crab.timer = 9;
        });
      });
      // Verdict flood: the room itself announces the outcome in color.
      const floodColor = classification === 'improving' ? '63,185,111'
        : classification === 'declining' ? '224,82,82'
        : classification === 'insufficient-evidence' ? '224,163,82'
        : '88,166,255';
      this.flood = { color: floodColor, t: 3.2, max: 3.2 };
      this.zoomTo(this.meetingTable(), 1.25, 8);
      const speaker = crabs[Math.floor(Math.random() * crabs.length)];
      setTimeout(() => {
        if (!this._destroyed && speaker) this.say(speaker, text ? truncate(text, 56) : 'analysis complete!', kind, 4.2);
      }, 900);
    }

    // -- movement helpers -------------------------------------------------------
    layoutDesks() {
      const cols = Math.max(1, Math.min(4, Math.floor((this.w - 40) / 150)));
      let i = 0;
      for (const crab of this.crabs.values()) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        crab.desk = { x: 40 + col * ((this.w - 80) / Math.max(1, cols)) + 40, y: 126 + row * 86 };
        i++;
      }
      this.syncHeight(cols);
    }

    /** Panel height follows headcount: more analysts -> more desk rows. */
    syncHeight(cols) {
      if (!this.w) return;
      const n = this.crabs.size;
      const rows = Math.max(1, Math.ceil(n / Math.max(1, cols || 1)));
      // Extra bottom strip keeps the meeting room clear of the desk rows.
      // The office is the main stage — give it generous vertical room.
      const target = n === 0 ? 210 : Math.min(760, 110 + rows * 96 + 120);
      const px = `${Math.round(target)}px`;
      if (this.container.style.height !== px) {
        this.container.style.height = px;
        // No CSS transition -> clientHeight is already the new value; keep the
        // office geometry (door, meeting room, spawn points) in sync NOW.
        this.resize();
      }
    }

    stationPoint() { return { x: 66, y: 88 }; }         // whiteboard = data station
    resultsPoint() { return { x: this.w / 2 - 20, y: 88 }; } // results board
    coffeePoint() { return { x: this.w - 64, y: 88 }; }
    meetingTable() { return { x: this.w / 2, y: this.h - 62 }; }
    /** Seats arranged around the meeting-room table perimeter. */
    meetingPoint(i, n) {
      const t = this.meetingTable();
      const a = (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2;
      return { x: t.x + 62 * Math.cos(a), y: t.y + 30 * Math.sin(a) };
    }

    /** User intervention: call every crab into the meeting room and announce it. */
    intervene(text) {
      const crabs = [...this.crabs.values()];
      if (!crabs.length) return;
      crabs.forEach((crab, i) => {
        this.retarget(crab, this.meetingPoint(i, crabs.length), () => { crab.state = 'meeting'; crab.timer = 12; });
        crab.speed = 95; // urgency: hustle to the meeting room
      });
      this.zoomTo(this.meetingTable(), 1.32, 10); // the boss is speaking
      const speaker = crabs[Math.floor(Math.random() * crabs.length)];
      setTimeout(() => {
        if (!this._destroyed) this.say(speaker, `BOSS: ${truncate(text, 44)}`, 'task', 4.5);
      }, 800);
    }

    retarget(crab, point, onArrive) {
      // Break up any chat in progress.
      if (crab.chatWith && this.crabs.get(crab.chatWith)) {
        const other = this.crabs.get(crab.chatWith);
        other.chatWith = null;
        if (other.state === 'chat') this.walkHome(other);
        crab.chatWith = null;
      }
      crab.speed = 0; // reset urgency; intervene() re-raises it
      crab.target = point;
      crab.onArrive = onArrive;
      crab.state = 'walk';
    }

    goTo(crab, point, nextState) {
      this.retarget(crab, point, () => {
        crab.state = nextState;
        crab.timer = nextState === 'wander' ? 1 + Math.random() * 2 : 2.5 + Math.random() * 2;
      });
    }

    walkHome(crab) {
      this.retarget(crab, { x: crab.desk.x, y: crab.desk.y + 26 }, () => {
        crab.state = 'work';
        crab.timer = 4 + Math.random() * 5;
      });
    }

    say(crab, text, kind, secs) {
      crab.bubbleText = text;
      crab.bubbleKind = kind;
      crab.bubbleUntil = this.now + secs;
    }

    chooseActivity(crab) {
      // Ambient office life (only when not mid-pipeline).
      const others = [...this.crabs.values()].filter((c) => c !== crab && c.state === 'work');
      const roll = Math.random();
      if (roll < 0.3) return this.goTo(crab, this.coffeePoint(), 'coffee');
      if (roll < 0.45) return this.goTo(crab, this.stationPoint(), 'whiteboard');
      if (roll < 0.7 && others.length) return this.startChat(crab, others[Math.floor(Math.random() * others.length)]);
      return this.goTo(crab, { x: 40 + Math.random() * (this.w - 80), y: 70 + Math.random() * (this.h - 150) }, 'wander');
    }

    startChat(crab, other) {
      const mid = { x: (crab.x + other.x) / 2, y: Math.min(crab.y, other.y) - 6 };
      const lines = CHAT_LINES[Math.floor(Math.random() * CHAT_LINES.length)];
      this.retarget(crab, { x: mid.x - 16, y: mid.y }, () => { crab.state = 'chat'; crab.chatTimer = 0; crab.chatIdx = 0; crab.chatLines = lines; crab.flip = false; });
      this.retarget(other, { x: mid.x + 16, y: mid.y }, () => { other.state = 'chat'; other.chatTimer = 0; other.chatIdx = 0; other.chatLines = lines; other.flip = true; });
      crab.chatWith = other.id;
      other.chatWith = crab.id;
    }

    update(crab, dt) {
      if (crab.state === 'walk' || crab.state === 'work') {
        crab.frameT += dt;
        if (crab.frameT > 0.24) { // ~4 fps natural crab gait
          crab.frameT = 0;
          crab.frame ^= 1; // 0/1 -> LEGS_A/LEGS_B
        }
      }
      if (crab.bubbleText && this.now > crab.bubbleUntil) crab.bubbleText = null;

      switch (crab.state) {
        case 'walk': {
          const dx = crab.target.x - crab.x;
          const dy = crab.target.y - crab.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 3) { const cb = crab.onArrive; crab.onArrive = null; if (cb) cb(); break; }
          crab.flip = dx < 0;
          const step = Math.min(dist, (crab.speed || WALK_SPEED) * dt);
          crab.x += (dx / dist) * step;
          crab.y += (dy / dist) * step;
          // Leg animation while walking: alternate between the two leg frames
          // ~6 fps (crab.frame 0/1 -> LEGS_A/LEGS_B).
          if (!crab.frameT) crab.frameT = 0;
          crab.frameT += dt;
          break;
        }
        case 'work': {
          crab.timer -= dt;
          // Leg animation while standing at desk.
          // Standing crabs shift weight ~2s on/off; the slow frame flip keeps them alive.
          // (walk gait is handled by the frame flip above; no per-leg override here)
          // Bubble animation.
          if (crab.bubbleText && (crab.bubbleAlpha === undefined || crab.bubbleAlpha < 1)) {
            crab.bubbleAlpha = Math.min(1, (crab.bubbleAlpha || 0) + dt * 8);
          } else if (!crab.bubbleText) {
            crab.bubbleAlpha = 0;
          }
          // Occasional idle animations: stretch, look around, tilt head.
          if (!crab.idleAnimTimer) crab.idleAnimTimer = 0;
          crab.idleAnimTimer += dt;
          if (crab.idleAnimTimer > 3 + Math.random() * 5) {
            crab.idleAnimTimer = 0;
            const r = Math.random();
            if (r < 0.3) {
              // Stretch up
              this.say(crab, '🦀 *stretch*', 'chat', 1.5);
            } else if (r < 0.55) {
              // Look around
              this.say(crab, '👀', 'chat', 1.2);
            } else if (r < 0.75) {
              // Tap claw on desk
              this.say(crab, 'tap tap…', 'task', 1.0);
            }
          }
          if (crab.status === 'running' && !crab.bubbleText && Math.random() < dt * 0.4) {
            this.say(crab, crab.taskText ? `menganalisis: ${crab.taskText}…` : pick(TASK_LINES[crab.id] || GENERIC_TASK), 'task', 2.6);
          }
          if (crab.status === 'ok' && !crab.bubbleText && Math.random() < dt * 0.12) {
            this.say(crab, pick(CHILL_LINES), 'chat', 2.4);
          }
          if (crab.status === 'fail' && !crab.bubbleText && Math.random() < dt * 0.12) {
            this.say(crab, pick(FAIL_LINES), 'fail', 2.4);
          }
          if (crab.status === 'idle' && !crab.bubbleText && Math.random() < dt * 0.06) {
            this.say(crab, pick(CHILL_LINES), 'chat', 2.2);
          }
          if (crab.timer <= 0) this.chooseActivity(crab);
          break;
        }
        case 'fetching': {
          crab.timer -= dt;
          if (!crab.bubbleText && Math.random() < dt * 0.3) this.say(crab, 'ambil data…', 'task', 1.8);
          if (crab.timer <= 0) this.walkHome(crab);
          break;
        }
        case 'deliver': {
          crab.timer -= dt;
          // Read out the real evidence labels one by one, then the headline.
          if (crab.workLog && crab.workLogIdx < crab.workLog.length) {
            crab.workLogTimer -= dt;
            if (crab.workLogTimer <= 0) {
              this.say(crab, crab.workLog[crab.workLogIdx], 'ok', 1.8);
              this.pinEvidence(); // one real evidence pinned per read-out
              crab.workLogIdx++;
              crab.workLogTimer = 1.9;
            }
          } else if (crab.workLog && !crab.finalSaid) {
            crab.finalSaid = true;
            this.say(crab, crab.pendingHeadline, 'ok', 3);
          }
          if (crab.timer <= 0) {
            crab.workLog = null;
            crab.finalSaid = false;
            this.walkHome(crab);
          }
          break;
        }
        case 'meeting': {
          crab.timer -= dt;
          // Lively discussion while seated around the table.
          if (!crab.bubbleText && Math.random() < dt * 0.55) this.say(crab, pick(MEETING_LINES), 'chat', 1.8);
          if (crab.timer <= 0) this.walkHome(crab);
          break;
        }
        case 'celebrate': {
          crab.timer -= dt;
          // Confetti burst on first frame.
          if (crab.timer > 0 && crab.celebrated !== true) {
            crab.celebrated = true;
            const cx = crab.x;
            const cy = crab.y - 20 * CRAB_SCALE;
            for (let i = 0; i < 18; i++) {
              this.ambient.push({
                type: 'confetti',
                x: cx, y: cy,
                vx: (Math.random() - 0.5) * 120,
                vy: -40 - Math.random() * 60,
                angle: Math.random() * Math.PI * 2,
                spin: (Math.random() - 0.5) * 10,
                life: 0, maxLife: 1.5 + Math.random() * 1.5,
                size: 4 + Math.random() * 4,
                color: pick(['#3fb96f', '#e0a352', '#58a6ff', '#e05252', '#a371f7']),
                alpha: 0.9,
              });
            }
            // Victory shout.
            this.say(crab, pick(['🎉 BULLISH!', '🚀 TO THE MOON!', '💎 DIAMOND HANDS!', '✅ APPROVED!']), 'ok', 2.5);
          }
          if (crab.timer <= 0) this.walkHome(crab);
          break;
        }
        case 'coffee':
        case 'whiteboard': {
          crab.timer -= dt;
          if (!crab.bubbleText && Math.random() < dt * 0.35) {
            this.say(crab, crab.state === 'coffee' ? '☕' : 'hmm… 📊', 'chat', 1.6);
          }
          if (crab.timer <= 0) this.walkHome(crab);
          break;
        }
        case 'wander': {
          crab.timer -= dt;
          if (crab.timer <= 0) this.walkHome(crab);
          break;
        }
        case 'chat': {
          crab.chatTimer -= dt;
          if (crab.chatTimer <= 0) {
            const lines = crab.chatLines || CHAT_LINES[0];
            if (crab.chatIdx < lines.length) {
              this.say(crab, lines[crab.chatIdx], 'chat', 1.4);
              crab.chatIdx++;
              crab.chatTimer = 0.9;
            } else {
              crab.chatWith = null;
              this.walkHome(crab);
            }
          }
          break;
        }
      }
    }

    // -- drawing --------------------------------------------------------------
    drawCrab(crab) {
      const ctx = this.ctx;
      const s = CRAB_SCALE;
      const palette = { W: '#f7f4f2', K: '#2b2624', ...crab.skin };
      const grid = crab.frame === 0 ? FRAME_A : FRAME_B;
      // Bobbing animation - different for each state.
      let bob = 0;
      let scale = 1;
      let rotation = 0;
      if (crab.state === 'walk') {
        bob = Math.sin(this.now * 14) * 1.5 * s;
      } else if (crab.state === 'work' && crab.status === 'running') {
        // Subtle breathing while working.
        bob = Math.sin(this.now * 3) * 0.5 * s;
        scale = 1 + 0.02 * Math.sin(this.now * 2.5);
      } else if (crab.state === 'meeting') {
        // Gentle lean during discussion.
        bob = Math.sin(this.now * 2 + crab.id * 0.7) * 0.8 * s;
      } else if (crab.state === 'celebrate') {
        // Bouncy celebration.
        bob = -Math.abs(Math.sin(this.now * 8)) * 4 * s;
        scale = 1 + 0.05 * Math.sin(this.now * 6);
      } else if (crab.state === 'idle') {
        // Occasional blink/shake.
        if (crab.blinkTimer !== undefined && crab.blinkTimer > 0) {
          crab.blinkTimer -= this._dt || 0.016;
        } else if (Math.random() < 0.003) {
          crab.blinkTimer = 0.15;
        }
      }
      // Ground shadow (soft ellipse under the sprite).
      ctx.save();
      ctx.globalAlpha = 0.32;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(Math.round(crab.x), Math.round(crab.y) + 2, 13 * s * scale, 4 * s * scale, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.translate(Math.round(crab.x), Math.round(crab.y - 16 * s + bob));
      if (crab.flip) ctx.scale(-1, 1);
      ctx.scale(scale, scale);
      if (rotation) ctx.rotate(rotation);
      ctx.translate(-8 * s, 0);
      for (let y = 0; y < grid.length; y++) {
        const row = grid[y];
        for (let x = 0; x < row.length; x++) {
          const color = palette[row[x]];
          if (color) {
            ctx.fillStyle = color;
            ctx.fillRect(Math.round(x * s), Math.round(y * s), Math.ceil(s), Math.ceil(s));
          }
        }
      }
      this.drawAccessory(crab, s);
      ctx.restore();
      // Status glow: a soft colored halo while working / after a result.
      if (crab.status === 'running' || crab.status === 'ok' || crab.status === 'fail') {
        const glowColor = crab.status === 'ok' ? '63,185,111' : crab.status === 'fail' ? '224,82,82' : '224,163,82';
        const pulse = crab.status === 'running' ? 0.10 + 0.05 * Math.sin(this.now * 5) : 0.08;
        const gg = ctx.createRadialGradient(crab.x, crab.y - 8, 2, crab.x, crab.y - 8, 26);
        gg.addColorStop(0, `rgba(${glowColor},${pulse})`);
        gg.addColorStop(1, `rgba(${glowColor},0)`);
        ctx.fillStyle = gg;
        ctx.beginPath();
        ctx.arc(crab.x, crab.y - 8, 26, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    drawAccessory(crab, s) {
      const ctx = this.ctx;
      const px = (x, y, w, h, color) => {
        ctx.fillStyle = color;
        ctx.fillRect(Math.round(x * s), Math.round(y * s), Math.round(w * s), Math.ceil(h * s));
      };
      switch (crab.accessory) {
        case 'cap':
          px(4, -0.4, 8, 1.6, '#2f81f7');
          px(11.4, 0.4, 2.6, 0.8, '#2f81f7');
          break;
        case 'glasses':
          px(3.6, 1.4, 2.8, 2, '#111');
          px(9.6, 1.4, 2.8, 2, '#111');
          px(6.4, 2.1, 3.2, 0.6, '#111');
          break;
        case 'headset':
          px(3.4, -0.2, 9.2, 0.8, '#8b949e');
          px(2.8, 0.8, 1.2, 2.6, '#58a6ff');
          px(12, 0.8, 1.2, 2.6, '#58a6ff');
          break;
        case 'tie':
          px(7.2, 11.4, 1.6, 1.6, '#8b1e2d');
          break;
        case 'coffee':
          px(12.6, 9.4, 2, 2.2, '#f7f4f2');
          px(14.4, 9.8, 0.8, 1.2, '#f7f4f2');
          px(12.6, 9.4, 2, 0.7, '#6f4e2f');
          break;
        case 'hardhat':
          px(3.8, -0.4, 8.4, 1.8, '#e0a352');
          px(3, 1, 10, 0.7, '#e0a352');
          break;
        case 'bow':
          px(10.6, -0.6, 1.8, 1.4, '#e05252');
          px(12.2, -0.6, 1.8, 1.4, '#e05252');
          px(11.7, -0.3, 0.8, 0.8, '#a82c2c');
          break;
        default:
          break;
      }
    }

    drawBubble(crab) {
      if (!crab.bubbleText) return;
      const ctx = this.ctx;
      const text = crab.bubbleText;
      ctx.font = '9px "SF Mono", ui-monospace, monospace';
      const tw = ctx.measureText(text).width;
      const bw = tw + 12;
      const bh = 16;
      let bx = crab.x - bw / 2;
      bx = Math.max(4, Math.min(this.w - bw - 4, bx));
      // Default above; flip below near the ceiling OR while standing at a
      // wall station (fetching/delivering) so it never covers the boards.
      const crabTop = crab.y - 16 * CRAB_SCALE;
      let by = crabTop - bh - 8;
      const atStation = crab.state === 'fetching' || crab.state === 'deliver' || crab.state === 'coffee';
      const below = by < 4 || (atStation && by < 96);
      if (below) by = crab.y + 8;
      const border = crab.bubbleKind === 'ok' ? '#3fb96f' : crab.bubbleKind === 'fail' ? '#e05252' : crab.bubbleKind === 'chat' ? '#58a6ff' : '#3a3f4d';
      const alpha = crab.bubbleAlpha || 1;
      // Soft drop shadow.
      ctx.globalAlpha = alpha * 0.35;
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.roundRect(bx + 1.5, by + 2, bw, bh, 5);
      ctx.fill();
      // Bubble body.
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#171a21';
      ctx.strokeStyle = border;
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, 5);
      ctx.fill();
      ctx.stroke();
      // Bubble tail.
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#171a21';
      const tx = Math.max(bx + 8, Math.min(bx + bw - 8, crab.x));
      ctx.beginPath();
      if (below) {
        ctx.moveTo(tx - 3, by + 1);
        ctx.lineTo(tx + 3, by + 1);
        ctx.lineTo(tx, by - 4);
      } else {
        ctx.moveTo(tx - 3, by + bh - 1);
        ctx.lineTo(tx + 3, by + bh - 1);
        ctx.lineTo(tx, by + bh + 4);
      }
      ctx.closePath();
      ctx.fill();
      // Text.
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#e6e9ef';
      ctx.fillText(text, bx + 6, by + 11);
      ctx.globalAlpha = 1;
    }

    drawDesk(desk, crab) {
      const ctx = this.ctx;
      const x = desk.x - 34;
      const y = desk.y - 14;
      // Desk shadow.
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(desk.x, y + 13, 38, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      // Desk body with a lighter top edge (fake depth).
      ctx.fillStyle = '#1a1e27';
      ctx.strokeStyle = '#262b36';
      ctx.beginPath();
      ctx.roundRect(x, y, 68, 12, 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#232936';
      ctx.fillRect(x + 2, y + 1, 64, 2);
      // Monitor: bezel, animated screen content, stand.
      ctx.fillStyle = '#0b0d12';
      ctx.fillRect(desk.x - 11, y - 15, 22, 13);
      const screen = crab.status === 'ok' ? '#3fb96f' : crab.status === 'fail' ? '#e05252' : crab.status === 'running' ? (Math.sin(this.now * 6) > 0 ? '#e0a352' : '#8a6524') : '#3a3f4d';
      ctx.fillStyle = screen;
      ctx.fillRect(desk.x - 9, y - 13, 18, 9);
      // Screen content: scrolling code lines while running, flat otherwise.
      if (crab.status === 'running') {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        const off = Math.floor(this.now * 8) % 4;
        for (let i = 0; i < 3; i++) ctx.fillRect(desk.x - 8, y - 12 + i * 3 + (off % 2), 6 + ((i * 7 + off) % 9), 1);
      } else if (crab.status === 'ok') {
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.fillRect(desk.x - 6, y - 10, 3, 1); ctx.fillRect(desk.x - 4, y - 8, 2, 1); ctx.fillRect(desk.x - 2, y - 11, 6, 1); // ✓-ish
      }
      ctx.fillStyle = '#262b36';
      ctx.fillRect(desk.x - 2, y - 2, 4, 4);
      // Keyboard.
      ctx.fillStyle = '#232833';
      ctx.fillRect(desk.x - 13, y + 3, 26, 3);
      ctx.fillStyle = '#2d3442';
      ctx.fillRect(desk.x - 11, y + 4, 22, 1);
      // Mug.
      ctx.fillStyle = '#8b5e34';
      ctx.fillRect(x + 6, y - 4, 5, 4);
      // Name tag + status dot — BELOW the desk legs so it never collides
      // with the wall stations when a desk sits on the top row.
      ctx.font = '8px "SF Mono", ui-monospace, monospace';
      ctx.fillStyle = '#6e7681';
      ctx.fillText(crab.id, desk.x - ctx.measureText(crab.id).width / 2, y + 34);
      const dot = crab.status === 'ok' ? '#3fb96f' : crab.status === 'fail' ? '#e05252' : crab.status === 'idle' ? '#3a3f4d' : '#e0a352';
      ctx.fillStyle = dot;
      ctx.beginPath();
      ctx.arc(desk.x + ctx.measureText(crab.id).width / 2 + 5, y + 31, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    drawProps() {
      const ctx = this.ctx;
      ctx.font = '7px "SF Mono", ui-monospace, monospace';
      // Door (left edge) where analysts clock in — with a lit frame + mat.
      ctx.fillStyle = '#12151c';
      ctx.strokeStyle = '#2d3342';
      ctx.beginPath();
      ctx.roundRect(2, this.h - 78, 20, 66, 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#0b0d12';
      ctx.fillRect(5, this.h - 74, 14, 58);
      ctx.fillStyle = 'rgba(224,163,82,0.16)'; // warm light spilling out
      ctx.fillRect(22, this.h - 74, 6, 58);
      ctx.fillStyle = '#161a22'; // door mat
      ctx.fillRect(4, this.h - 14, 26, 6);
      ctx.fillStyle = '#6e7681';
      ctx.fillText('IN', 8, this.h - 64);
      // Wall clock above the door — shows REAL local time, second hand ticks.
      const now = new Date();
      const sec = now.getSeconds() + now.getMilliseconds() / 1000;
      const min = now.getMinutes() + sec / 60;
      const hr = (now.getHours() % 12) + min / 60;
      const cy = this.h - 92;
      ctx.strokeStyle = '#3a3f4d';
      ctx.fillStyle = '#141820';
      ctx.beginPath();
      ctx.arc(13, cy, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      const hand = (angle, len, color, width) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(13, cy);
        ctx.lineTo(13 + Math.cos(angle - Math.PI / 2) * len, cy + Math.sin(angle - Math.PI / 2) * len);
        ctx.stroke();
      };
      hand((hr / 12) * Math.PI * 2, 3.4, '#c9d1d9', 1.4);
      hand((min / 60) * Math.PI * 2, 5, '#8b949e', 1);
      hand((sec / 60) * Math.PI * 2, 5.6, '#e0a352', 0.6);
      ctx.lineWidth = 1;
      // Whiteboard / data station (top-left) with a live squiggle.
      ctx.fillStyle = '#141820';
      ctx.strokeStyle = '#2d3342';
      ctx.beginPath();
      ctx.roundRect(24, 44, 84, 36, 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#0f1319';
      ctx.fillRect(28, 48, 76, 26);
      ctx.strokeStyle = '#58a6ff';
      ctx.beginPath();
      const sq = this.now * 2;
      ctx.moveTo(32, 70);
      for (let i = 0; i <= 16; i++) ctx.lineTo(32 + i * 4, 66 - Math.sin(sq + i * 0.8) * 7);
      ctx.stroke();
      ctx.fillStyle = '#6e7681';
      ctx.fillText('DATA STATION', 30, 51);
      // Results board (top-center) with pinned notes + a blinking LED.
      const rx = this.w / 2 - 62;
      ctx.fillStyle = '#141820';
      ctx.strokeStyle = '#2d3342';
      ctx.beginPath();
      ctx.roundRect(rx, 44, 84, 36, 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#0f1319';
      ctx.fillRect(rx + 4, 48, 76, 26);
      ctx.fillStyle = '#3fb96f';
      ctx.fillRect(rx + 8, 52, 12, 9);
      ctx.fillStyle = '#e0a352';
      ctx.fillRect(rx + 26, 56, 12, 9);
      ctx.fillStyle = '#58a6ff';
      ctx.fillRect(rx + 44, 50, 12, 9);
      ctx.fillStyle = '#e05252';
      ctx.fillRect(rx + 62, 57, 10, 8);
      ctx.fillStyle = Math.sin(this.now * 3) > 0 ? '#3fb96f' : '#1c3a28';
      ctx.beginPath();
      ctx.arc(rx + 78, 50, 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#6e7681';
      ctx.fillText('RESULTS', rx + 8, 75);
      // Live evidence counter — climbs as crabs pin their real findings.
      if (this.evidenceCount > 0) {
        ctx.font = '8px "SF Mono", ui-monospace, monospace';
        const label = `📌 ${this.evidenceCount}`;
        ctx.fillStyle = '#58a6ff';
        ctx.fillText(label, rx + 84 + 6, 60);
        ctx.font = '7px "SF Mono", ui-monospace, monospace';
      }
      // Coffee machine (top-right) with animated steam.
      const cx = this.w - 88;
      ctx.fillStyle = '#141820';
      ctx.strokeStyle = '#2d3342';
      ctx.beginPath();
      ctx.roundRect(cx, 42, 52, 40, 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#e0a352';
      ctx.fillRect(cx + 8, 50, 10, 8);
      ctx.fillStyle = '#f7f4f2';
      ctx.fillRect(cx + 24, 62, 8, 8);
      ctx.strokeStyle = 'rgba(200,205,214,0.5)';
      for (let i = 0; i < 2; i++) {
        const sy = 60 - ((this.now * 14 + i * 9) % 14);
        ctx.globalAlpha = Math.max(0, 0.5 - (60 - sy) * 0.04);
        ctx.beginPath();
        ctx.moveTo(cx + 26 + i * 4, sy);
        ctx.quadraticCurveTo(cx + 24 + i * 4, sy - 3, cx + 27 + i * 4, sy - 6);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#6e7681';
      ctx.fillText('COFFEE', cx + 8, 77);
      // Potted plant next to the coffee machine.
      const px0 = cx + 62;
      ctx.fillStyle = '#5c3a24';
      ctx.beginPath();
      ctx.moveTo(px0, 74); ctx.lineTo(px0 + 12, 74); ctx.lineTo(px0 + 10, 82); ctx.lineTo(px0 + 2, 82);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#2f7d46';
      ctx.beginPath();
      ctx.arc(px0 + 6, 68, 6, 0, Math.PI * 2);
      ctx.arc(px0 + 2, 72, 4, 0, Math.PI * 2);
      ctx.arc(px0 + 10, 72, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    /** Conference corner: rug, big table, chairs. */
    drawMeetingRoom() {
      const ctx = this.ctx;
      const t = this.meetingTable();
      ctx.font = '7px "SF Mono", ui-monospace, monospace';
      // Rug with a subtle border pattern.
      ctx.fillStyle = '#10131a';
      ctx.strokeStyle = '#232936';
      ctx.beginPath();
      ctx.roundRect(t.x - 92, t.y - 36, 184, 74, 9);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = '#1a1e27';
      ctx.beginPath();
      ctx.roundRect(t.x - 86, t.y - 30, 172, 62, 7);
      ctx.stroke();
      // Chairs.
      ctx.fillStyle = '#1d222c';
      const seats = 6;
      for (let i = 0; i < seats; i++) {
        const a = (i / seats) * Math.PI * 2 - Math.PI / 2;
        ctx.beginPath();
        ctx.roundRect(t.x + 62 * Math.cos(a) - 5, t.y + 30 * Math.sin(a) - 5, 10, 10, 3);
        ctx.fill();
      }
      // Table.
      ctx.fillStyle = '#1a1e27';
      ctx.strokeStyle = '#2d3342';
      ctx.beginPath();
      ctx.roundRect(t.x - 52, t.y - 15, 104, 30, 10);
      ctx.fill();
      ctx.stroke();
      // Papers on the table.
      ctx.fillStyle = '#3a3f4d';
      ctx.fillRect(t.x - 30, t.y - 6, 12, 8);
      ctx.fillRect(t.x + 14, t.y - 4, 12, 8);
      ctx.fillStyle = '#6e7681';
      const label = 'MEETING ROOM';
      ctx.fillText(label, t.x - ctx.measureText(label).width / 2, t.y + 30);
    }

    /** Floor: checkerboard tiles + ambient glow + vignette. */
    drawFloor() {
      const ctx = this.ctx;
      const g = ctx.createLinearGradient(0, 0, 0, this.h);
      g.addColorStop(0, '#0d1016');
      g.addColorStop(1, '#0a0c10');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, this.w, this.h);
      // Checkerboard tiles below the wall line.
      const tile = 28;
      for (let ty = 92, row = 0; ty < this.h; ty += tile, row++) {
        for (let tx = 0, col = 0; tx < this.w; tx += tile, col++) {
          ctx.fillStyle = (row + col) % 2 ? '#0e1117' : '#0c0f14';
          ctx.fillRect(tx, ty, tile, tile);
        }
      }
      // Wall line.
      ctx.fillStyle = '#151a22';
      ctx.fillRect(0, 88, this.w, 4);
      // Ambient glow under the ceiling stations.
      const glow = ctx.createRadialGradient(this.w / 2, 30, 10, this.w / 2, 30, this.w * 0.6);
      glow.addColorStop(0, 'rgba(88,166,255,0.05)');
      glow.addColorStop(1, 'rgba(88,166,255,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, this.w, 120);
      // Vignette.
      const v = ctx.createRadialGradient(this.w / 2, this.h / 2, this.h * 0.35, this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.75);
      v.addColorStop(0, 'rgba(0,0,0,0)');
      v.addColorStop(1, 'rgba(0,0,0,0.38)');
      ctx.fillStyle = v;
      ctx.fillRect(0, 0, this.w, this.h);
    }

    /** Pipeline rail: real plan steps as a node chain along the top (2 rows). */
    drawRail() {
      if (!this.planSteps || !this.planSteps.length) return;
      const ctx = this.ctx;
      const steps = this.planSteps;
      const rows = steps.length > 7 ? 2 : 1;
      const perRow = Math.ceil(steps.length / rows);
      const maxW = this.w - 16;
      const nodeW = Math.min(104, (maxW - (perRow - 1) * 5) / perRow);
      ctx.font = '6.5px "SF Mono", ui-monospace, monospace';
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        const row = Math.floor(i / perRow);
        const col = i % perRow;
        const inRow = Math.min(perRow, steps.length - row * perRow);
        const rowW = inRow * nodeW + (inRow - 1) * 5;
        const x = (this.w - rowW) / 2 + col * (nodeW + 5);
        const y = 3 + row * 17;
        const color = s.status === 'done' ? '#3fb96f'
          : s.status === 'failed' ? '#e05252'
          : s.status === 'running' ? (Math.sin(this.now * 6) > 0 ? '#e0a352' : '#8a6524')
          : '#262b36';
        // Connector to the previous node (same row only).
        if (col > 0) {
          ctx.strokeStyle = steps[i - 1].status === 'done' ? '#2a5c3d' : '#1c2028';
          ctx.beginPath();
          ctx.moveTo(x - 5, y + 6);
          ctx.lineTo(x, y + 6);
          ctx.stroke();
        }
        ctx.fillStyle = '#12151c';
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.roundRect(x, y, nodeW, 12, 3);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = s.status === 'pending' ? '#4a4f5c' : '#c9d1d9';
        const label = truncate(s.label.replace(/^run analyst: /i, ''), Math.floor(nodeW / 4));
        ctx.fillText(label, x + 3, y + 8.5);
      }
    }

    /** Data packets flying between stations, desks, and the meeting room. */
    drawPackets(dt) {
      const ctx = this.ctx;
      for (let i = this.packets.length - 1; i >= 0; i--) {
        const p = this.packets[i];
        p.t += dt;
        if (p.t < 0) continue;
        const k = p.t / p.dur;
        if (k >= 1) {
          this.packets.splice(i, 1);
          continue;
        }
        const a = typeof p.from === 'function' ? p.from() : p.from;
        const b = typeof p.to === 'function' ? p.to() : p.to;
        const x = a.x + (b.x - a.x) * k;
        const y = a.y + (b.y - a.y) * k - Math.sin(k * Math.PI) * 14; // slight arc
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = p.kind === 'evidence' ? '#58a6ff' : '#e0a352';
        ctx.fillRect(Math.round(x) - 1.5, Math.round(y) - 1.5, 3, 3);
      }
      ctx.globalAlpha = 1;
    }

    /** Live duration timer above a working crab; frozen green when done. */
    drawTimer(crab) {
      const ctx = this.ctx;
      let text = null;
      let color = '#e0a352';
      if (crab.status === 'running' && crab.startedAt !== undefined) {
        text = `${((this.now - crab.startedAt)).toFixed(1)}s`;
      } else if (crab.finalMs !== undefined && crab.finalMs !== null) {
        text = `✓ ${(crab.finalMs / 1000).toFixed(1)}s`;
        color = '#3fb96f';
      }
      if (!text) return;
      ctx.font = '8px "SF Mono", ui-monospace, monospace';
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(10,12,16,0.75)';
      ctx.beginPath();
      ctx.roundRect(crab.x - tw / 2 - 4, crab.y - 16 * CRAB_SCALE - 22, tw + 8, 11, 3);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.fillText(text, crab.x - tw / 2, crab.y - 16 * CRAB_SCALE - 13.5);
    }

    draw() {
      const ctx = this.ctx;
      // Cinematic camera: zoom around the focus point, clamped to office bounds.
      const cam = this.camera;
      ctx.save();
      if (cam.zoom > 1.005) {
        // Clamp focus so the viewport (canvas/zoom) never shows outside [0,w]x[0,h].
        const vw = this.w / cam.zoom;
        const vh = this.h / cam.zoom;
        const minX = vw / 2;
        const maxX = this.w - vw / 2;
        const minY = vh / 2;
        const maxY = this.h - vh / 2;
        const fx = Math.max(minX, Math.min(maxX, cam.focus.x));
        const fy = Math.max(minY, Math.min(maxY, cam.focus.y));
        ctx.translate(this.w / 2, this.h / 2);
        ctx.scale(cam.zoom, cam.zoom);
        ctx.translate(-fx, -fy);
      }
      this.drawFloor();

      this.drawProps();
      this.drawMeetingRoom();
      this.drawRail();

      if (!this.crabs.size) {
        ctx.fillStyle = '#4a4f5c';
        ctx.font = '11px "SF Mono", ui-monospace, monospace';
        const msg = 'office empty — run an analysis to summon the analysts 🦀';
        ctx.fillText(msg, this.w / 2 - ctx.measureText(msg).width / 2, 38);
        return;
      }

      for (const crab of this.crabs.values()) this.drawDesk(crab.desk, crab);
      this.drawPackets(this._dt || 0.016);
      this.drawAmbient();
      const sorted = [...this.crabs.values()].sort((a, b) => a.y - b.y);
      for (const crab of sorted) this.drawCrab(crab);
      for (const crab of sorted) this.drawTimer(crab);
      for (const crab of sorted) this.drawBubble(crab);
      ctx.restore(); // camera

      // Verdict flood overlay (screen space, above everything).
      if (this.flood) {
        const k = this.flood.t / this.flood.max;
        const alpha = 0.22 * Math.sin(Math.min(1, k * 2) * Math.PI); // ease in-out
        ctx.fillStyle = `rgba(${this.flood.color},${Math.max(0, alpha)})`;
        ctx.fillRect(0, 0, this.w, this.h);
      }
      // Slow-mo tint: the room cools down while time is slow.
      if (this.timeScale < 1) {
        ctx.fillStyle = 'rgba(88,166,255,0.07)';
        ctx.fillRect(0, 0, this.w, this.h);
      }
      // Overtime mode: after 18:00 local, the office lights dim warm.
      const hour = new Date().getHours();
      if (hour >= 18 || hour < 6) {
        ctx.fillStyle = 'rgba(10,8,20,0.28)';
        ctx.fillRect(0, 0, this.w, this.h);
        const warm = ctx.createRadialGradient(this.w / 2, 60, 20, this.w / 2, 60, this.w * 0.55);
        warm.addColorStop(0, 'rgba(224,163,82,0.10)');
        warm.addColorStop(1, 'rgba(224,163,82,0)');
        ctx.fillStyle = warm;
        ctx.fillRect(0, 0, this.w, this.h);
      }
    }

    loop(t) {
      if (this._destroyed) return;
      // One bad frame must never kill the animation loop.
      try {
        const dt = Math.min(0.1, (t - this._last) / 1000);
        this._last = t;
        this._dt = dt;
        this.now = t / 1000;
        // Slow motion (whale moment): crabs move in syrup, timers tick slowly.
        if (this.slowMo > 0) {
          this.slowMo -= dt;
          this.timeScale = 0.35;
        } else {
          this.timeScale = 1;
        }
        const sdt = dt * this.timeScale;
        for (const crab of this.crabs.values()) this.update(crab, sdt);
        // Spawn ambient particles (dust, screen glints, idle sparks).
        this.spawnAmbient(dt);
        this.updateAmbient(dt);
        // Camera easing + auto-return.
        const cam = this.camera;
        if (cam.hold > 0) cam.hold -= dt;
        else cam.targetZoom = 1;
        cam.zoom += (cam.targetZoom - cam.zoom) * Math.min(1, dt * 3.2);
        if (this.flood) {
          this.flood.t -= dt;
          if (this.flood.t <= 0) this.flood = null;
        }
        this.draw();
      } catch (err) {
        if (!this._frameErrLogged) {
          this._frameErrLogged = true;
          if (typeof console !== 'undefined') console.error('office frame error', err);
        }
      }
      this._raf = requestAnimationFrame((tt) => this.loop(tt));
    }

    /** Spawn ambient life: dust motes, screen glints, idle sparks. */
    spawnAmbient(dt) {
      // Dust motes - gentle drift across the whole office.
      if (Math.random() < dt * 0.8) {
        this.ambient.push({
          type: 'dust',
          x: Math.random() * this.w,
          y: Math.random() * this.h,
          vx: (Math.random() - 0.5) * 8,
          vy: (Math.random() - 0.5) * 4 - 2,
          life: 0,
          maxLife: 8 + Math.random() * 12,
          size: 0.5 + Math.random() * 1.2,
          color: '#ffffff',
          alpha: 0.15 + Math.random() * 0.25,
        });
      }
      // Screen glints - brief bright flashes on active monitors.
      for (const crab of this.crabs.values()) {
        if (crab.status === 'running' && Math.random() < dt * 0.6) {
          const dx = crab.desk.x - 9;
          const dy = crab.desk.y - 13;
          this.ambient.push({
            type: 'glint',
            x: dx + 2 + Math.random() * 14,
            y: dy + 2 + Math.random() * 5,
            vx: (Math.random() - 0.5) * 30,
            vy: -10 - Math.random() * 20,
            life: 0,
            maxLife: 0.3 + Math.random() * 0.4,
            size: 3 + Math.random() * 4,
            color: '#58a6ff',
            alpha: 0.8,
          });
        }
        // Idle sparks - tiny golden particles when crab finishes a task.
        if (crab.status === 'ok' && crab.finalMs && Math.random() < dt * 0.4) {
          this.ambient.push({
            type: 'spark',
            x: crab.x + (Math.random() - 0.5) * 40,
            y: crab.y - 16 * CRAB_SCALE + (Math.random() - 0.5) * 30,
            vx: (Math.random() - 0.5) * 40,
            vy: -5 - Math.random() * 30,
            life: 0,
            maxLife: 0.6 + Math.random() * 0.8,
            size: 1.5 + Math.random() * 2,
            color: '#e0a352',
            alpha: 0.7,
          });
        }
      }
      // Meeting room paper flutter when synthesis is running.
      if (this.planSteps && this.planSteps.some(s => s.label.includes('Synthesize') && s.status === 'running')) {
        if (Math.random() < dt * 0.5) {
          const t = this.meetingTable();
          this.ambient.push({
            type: 'paper',
            x: t.x + (Math.random() - 0.5) * 80,
            y: t.y + (Math.random() - 0.5) * 25,
            vx: (Math.random() - 0.5) * 15,
            vy: -2 - Math.random() * 8,
            angle: Math.random() * Math.PI * 2,
            spin: (Math.random() - 0.5) * 3,
            life: 0,
            maxLife: 2 + Math.random() * 3,
            size: 4 + Math.random() * 3,
            color: '#c9d1d9',
            alpha: 0.5,
          });
        }
      }
      // Cap total ambient particles.
      if (this.ambient.length > 200) this.ambient.splice(0, this.ambient.length - 200);
    }

    /** Update ambient particle physics. */
    updateAmbient(dt) {
      for (let i = this.ambient.length - 1; i >= 0; i--) {
        const p = this.ambient[i];
        p.life += dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.type === 'paper' || p.type === 'confetti') {
          p.angle += p.spin * dt;
          p.vy += 5 * dt; // gentle gravity
        }
        if (p.life >= p.maxLife) {
          this.ambient.splice(i, 1);
        }
      }
    }

    /** Draw ambient particles (dust, glints, sparks, paper). */
    drawAmbient() {
      const ctx = this.ctx;
      for (const p of this.ambient) {
        const k = p.life / p.maxLife;
        const alpha = p.alpha * (1 - k * 0.7);
        if (alpha <= 0) continue;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.color;
        if (p.type === 'paper') {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.angle);
          ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
          ctx.restore();
        } else if (p.type === 'confetti') {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.angle);
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
          ctx.restore();
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * (1 - k * 0.3), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    destroy() {
      this._destroyed = true;
      cancelAnimationFrame(this._raf);
      this.ro.disconnect();
      this.container.innerHTML = '';
    }
  }

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  window.AnalystOffice = AnalystOffice;
})();
