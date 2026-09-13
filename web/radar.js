/* =================================================================
 * WHALE RADAR — every real Binance trade becomes a particle.
 * Buoys: 🐟 < $10k · 🦈 $10k–100k · 🐋 ≥ $100k (glowing, labeled).
 * Green particles swim in from the left (taker buys), red from the
 * right (taker sells). Also renders the scrolling trade tape below.
 * All data comes from gateway 'trades' messages; mock is badged.
 * ================================================================= */
(function () {
  const BUY = '#3fb96f';
  const SELL = '#e05252';
  const WHALE_USD = 100000;
  const SHARK_USD = 10000;

  function fmtUsd(v) {
    if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `$${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k`;
    return `$${v.toFixed(0)}`;
  }

  class WhaleRadar {
    constructor(canvas, tapeEl, badgeEl) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.tape = tapeEl;
      this.badge = badgeEl;
      this.particles = [];
      this.splashes = []; // whale impact rings
      this.last = 0;
      this._raf = 0;
      this._destroyed = false;
      this.resize = this.resize.bind(this);
      this.loop = this.loop.bind(this);
      this.ro = new ResizeObserver(this.resize);
      this.ro.observe(canvas.parentElement || canvas);
      this.resize();
      this._raf = requestAnimationFrame(this.loop);
    }

    destroy() {
      this._destroyed = true;
      cancelAnimationFrame(this._raf);
      this.ro.disconnect();
    }

    resize() {
      const host = this.canvas.parentElement;
      const w = host ? host.clientWidth : this.canvas.clientWidth;
      const h = host ? host.clientHeight : this.canvas.clientHeight;
      if (!w || !h) return;
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = w;
      this.h = h;
    }

    /** Ingest a batch of trades from the gateway. */
    ingest(trades, mock) {
      if (this.badge) this.badge.classList.toggle('hidden', !mock);
      for (const t of trades) {
        const tier = t.v >= WHALE_USD ? 'whale' : t.v >= SHARK_USD ? 'shark' : 'fish';
        const size = tier === 'whale'
          ? 16 + Math.min(18, Math.log10(t.v / WHALE_USD) * 14)
          : tier === 'shark'
            ? 7 + Math.min(6, Math.log10(t.v / SHARK_USD) * 4)
            : 2 + Math.min(3, Math.log10(Math.max(10, t.v)) * 0.9);
        const dir = t.s === 'buy' ? 1 : -1;
        const y = 18 + Math.random() * (this.h - 36);
        this.particles.push({
          x: dir === 1 ? -size * 2 : this.w + size * 2,
          y,
          vx: dir * (tier === 'whale' ? 26 : 34 + Math.random() * 42) / 60,
          size,
          color: t.s === 'buy' ? BUY : SELL,
          tier,
          value: t.v,
          life: 1,
          wobble: Math.random() * Math.PI * 2,
        });
        if (tier === 'whale') {
          this.splashes.push({ x: dir === 1 ? 30 : this.w - 30, y, r: 6, life: 1 });
        }
        this.addTapeRow(t);
      }
      // Hard caps keep the scene readable under heavy flow.
      if (this.particles.length > 260) this.particles.splice(0, this.particles.length - 260);
      while (this.tape && this.tape.children.length > 14) this.tape.removeChild(this.tape.lastChild);
    }

    addTapeRow(t) {
      if (!this.tape) return;
      const row = document.createElement('div');
      row.className = `tape-row ${t.s}`;
      const icon = t.v >= WHALE_USD ? '🐋' : t.v >= SHARK_USD ? '🦈' : '';
      row.textContent = `${icon} ${t.s === 'buy' ? 'BELI' : 'JUAL'} ${fmtUsd(t.v)} @ ${t.p.toLocaleString('en-US', { maximumFractionDigits: 1 })}`;
      this.tape.prepend(row);
    }

    loop(t) {
      if (this._destroyed) return;
      this._raf = requestAnimationFrame(this.loop);
      const dt = Math.min(0.05, this.last ? (t - this.last) / 1000 : 0.016);
      this.last = t;
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);

      // Water columns: buy side / sell side tint.
      ctx.fillStyle = 'rgba(63,185,111,0.035)';
      ctx.fillRect(0, 0, this.w / 2, this.h);
      ctx.fillStyle = 'rgba(224,82,82,0.035)';
      ctx.fillRect(this.w / 2, 0, this.w / 2, this.h);
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.beginPath();
      ctx.moveTo(this.w / 2, 0);
      ctx.lineTo(this.w / 2, this.h);
      ctx.stroke();

      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        p.wobble += dt * 3;
        p.x += p.vx * dt * 60;
        p.y += Math.sin(p.wobble) * dt * 9;
        const margin = p.size * 3;
        if (p.x < -margin || p.x > this.w + margin) {
          this.particles.splice(i, 1);
          continue;
        }
        ctx.globalAlpha = p.tier === 'fish' ? 0.55 : 0.9;
        if (p.tier === 'whale') {
          ctx.shadowColor = p.color;
          ctx.shadowBlur = 18;
        }
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        if (p.tier !== 'fish') {
          ctx.globalAlpha = 1;
          ctx.font = `${p.tier === 'whale' ? 11 : 9}px "SF Mono", ui-monospace, monospace`;
          ctx.fillStyle = p.tier === 'whale' ? '#e6e9ef' : '#9aa0aa';
          const label = `${p.tier === 'whale' ? '🐋' : '🦈'} ${fmtUsd(p.value)}`;
          const lx = p.vx > 0 ? p.x + p.size + 4 : p.x - p.size - 4 - ctx.measureText(label).width;
          ctx.fillText(label, lx, p.y + 3);
        }
      }
      ctx.globalAlpha = 1;

      // Whale splash rings.
      for (let i = this.splashes.length - 1; i >= 0; i--) {
        const s = this.splashes[i];
        s.r += dt * 120;
        s.life -= dt * 1.4;
        if (s.life <= 0) {
          this.splashes.splice(i, 1);
          continue;
        }
        ctx.globalAlpha = s.life * 0.5;
        ctx.strokeStyle = '#e6e9ef';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Idle hint until the first trade arrives.
      if (!this.particles.length) {
        ctx.fillStyle = '#4a4f5c';
        ctx.font = '10px "SF Mono", ui-monospace, monospace';
        const msg = 'menunggu aliran trade…';
        ctx.fillText(msg, this.w / 2 - ctx.measureText(msg).width / 2, this.h / 2);
      }
    }
  }

  window.WhaleRadar = WhaleRadar;
})();
