// Self-contained multi-timeframe candlestick renderer with indicators + volume (no external chart library).
(function () {
  // Interval string ('1m','15m','1h','2h','4h') -> bucket duration in ms.
  function intervalMs(iv) {
    const m = /^(\d+)([mhd])$/.exec(iv || '');
    if (!m) return 60_000;
    const n = Number(m[1]);
    if (m[2] === 'm') return n * 60_000;
    if (m[2] === 'h') return n * 3_600_000;
    return n * 86_400_000;
  }

  // Simple EMA calculator (incremental).
  class EMA {
    constructor(period) {
      this.period = period;
      this.k = 2 / (period + 1);
      this.value = null;
    }
    update(price) {
      if (this.value === null) this.value = price;
      else this.value = price * this.k + this.value * (1 - this.k);
      return this.value;
    }
    reset() { this.value = null; }
  }

  class CandleChart {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.candles = [];
      this.symbol = '';
      this.range = '1h';
      this.rangeLabel = '1H (1m)';
      this.interval = '1m';
      this.limit = 60;
      this.showVolume = true;
      this.showEMA20 = true;
      this.showEMA50 = true;
      this.ema20 = new EMA(20);
      this.ema50 = new EMA(50);
      this._resize = () => this.draw();
      window.addEventListener('resize', this._resize);
    }

    setSymbol(symbol) {
      if (symbol !== this.symbol) { this.candles = []; this.ema20.reset(); this.ema50.reset(); }
      this.symbol = symbol;
    }

    /** Set visible range: '1h' | '24h' | '7d' | '14d' | '30d' | custom interval like '1m','5m','15m','1h','4h','1d'. */
    setRange(range) {
      if (range === this.range) return false;
      this.range = range;
      const cfg = RANGE_CFG[range] ?? RANGE_CFG['1h'];
      this.interval = cfg.interval;
      this.limit = cfg.limit;
      this.rangeLabel = cfg.label;
      this.candles = [];
      this.ema20.reset();
      this.ema50.reset();
      return true;
    }

    /** Set custom interval directly (for custom timeframe picker). */
    setCustomInterval(interval, limit) {
      this.interval = interval;
      this.limit = limit || this.limit;
      this.rangeLabel = interval.toUpperCase();
      this.candles = [];
      this.ema20.reset();
      this.ema50.reset();
      this.draw();
    }

    setCandles(list) {
      this.candles = list.slice(-this.limit);
      this.ema20.reset();
      this.ema50.reset();
      for (const c of this.candles) {
        this.ema20.update(c.c);
        this.ema50.update(c.c);
      }
      this.draw();
    }

    pushTick(tick) {
      const size = intervalMs(this.interval);
      const bucketT = Math.floor(tick.t / size) * size;
      const last = this.candles[this.candles.length - 1];
      if (last && last.t === bucketT) {
        this.candles[this.candles.length - 1] = {
          t: bucketT,
          o: last.o,
          h: Math.max(last.h, tick.h),
          l: Math.min(last.l, tick.l),
          c: tick.c,
          v: (last.v || 0) + (tick.v || 0),
          closed: false,
        };
      } else if (!last || bucketT > last.t) {
        this.candles.push({
          t: bucketT,
          o: tick.o,
          h: tick.h,
          l: tick.l,
          c: tick.c,
          v: tick.v || 0,
          closed: false,
        });
        if (this.candles.length > this.limit) this.candles.shift();
      }
      // Update EMAs incrementally with the latest tick close.
      this.ema20.update(tick.c);
      this.ema50.update(tick.c);
      this.draw();
    }

    toggleVolume(show) { this.showVolume = show; this.draw(); }
    toggleEMA20(show) { this.showEMA20 = show; this.draw(); }
    toggleEMA50(show) { this.showEMA50 = show; this.draw(); }

    draw() {
      const ctx = this.ctx;
      const canvas = this.canvas;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#0f1115';
      ctx.fillRect(0, 0, w, h);

      if (this.candles.length === 0) {
        ctx.fillStyle = '#7d8594';
        ctx.font = '12px monospace';
        ctx.fillText(`menunggu data ${this.rangeLabel || ''}…`.trim(), 12, 22);
        return;
      }

      const pad = { top: 12, right: 66, bottom: 20, left: 8 };
      const plotW = w - pad.left - pad.right;
      const plotH = h - pad.top - pad.bottom;
      const lows = this.candles.map((c) => c.l);
      const highs = this.candles.map((c) => c.h);
      let min = Math.min.apply(null, lows);
      let max = Math.max.apply(null, highs);
      if (min === max) { min -= 1; max += 1; }
      const padRange = (max - min) * 0.06;
      min -= padRange;
      max += padRange;
      const y = (price) => pad.top + ((max - price) / (max - min)) * plotH;
      const step = plotW / this.candles.length;
      const bodyW = Math.max(1, Math.min(step * 0.7, 14));

      // Horizontal grid + price labels.
      ctx.font = '10px monospace';
      ctx.strokeStyle = '#1c2028';
      ctx.fillStyle = '#7d8594';
      const lines = 5;
      for (let i = 0; i <= lines; i++) {
        const price = min + ((max - min) * i) / lines;
        const yy = y(price);
        ctx.beginPath();
        ctx.moveTo(pad.left, yy);
        ctx.lineTo(w - pad.right, yy);
        ctx.stroke();
        ctx.fillText(price.toFixed(2), w - pad.right + 6, yy + 3);
      }

      // Candles + volume.
      for (let i = 0; i < this.candles.length; i++) {
        const c = this.candles[i];
        const x = pad.left + i * step + step / 2;
        const up = c.c >= c.o;
        const color = up ? '#3fb96f' : '#e05252';
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(x, y(c.h));
        ctx.lineTo(x, y(c.l));
        ctx.stroke();
        const yO = y(c.o);
        const yC = y(c.c);
        const top = Math.min(yO, yC);
        const bodyH = Math.max(1, Math.abs(yO - yC));
        ctx.fillStyle = color;
        ctx.fillRect(x - bodyW / 2, top, bodyW, bodyH);
        // Volume bar (bottom 15% of the plot).
        if (this.showVolume && c.v !== undefined) {
          const volH = plotH * 0.15;
          const volTop = pad.top + plotH - volH;
          const maxVol = Math.max.apply(null, this.candles.map((cc) => cc.v || 0)) || 1;
          const yVol = (vol) => volTop + volH - (vol / maxVol) * volH;
          ctx.fillStyle = up ? 'rgba(63,185,111,0.5)' : 'rgba(224,82,82,0.5)';
          ctx.fillRect(x - bodyW / 2, yVol(c.v), bodyW, volTop + volH - yVol(c.v));
        }
      }

      // EMA lines (calculated from close).
      if (this.showEMA20 || this.showEMA50) {
        const ema20 = new EMA(20);
        const ema50 = new EMA(50);
        const pts20 = [];
        const pts50 = [];
        for (let i = 0; i < this.candles.length; i++) {
          const c = this.candles[i];
          pts20.push(ema20.update(c.c));
          pts50.push(ema50.update(c.c));
        }
        const drawLine = (pts, color) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          for (let i = 0; i < pts.length; i++) {
            const x = pad.left + i * step + step / 2;
            const yy = y(pts[i]);
            if (i === 0) ctx.moveTo(x, yy);
            else ctx.lineTo(x, yy);
          }
          ctx.stroke();
          ctx.lineWidth = 1;
        };
        if (this.showEMA20) drawLine(pts20, '#4f8cff');
        if (this.showEMA50) drawLine(pts50, '#e0a352');
      }

      // Live price line (dashed) + label.
      const lastC = this.candles[this.candles.length - 1];
      if (lastC) {
        const liveY = y(lastC.c);
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = lastC.c >= lastC.o ? 'rgba(63,185,111,0.8)' : 'rgba(224,82,82,0.8)';
        ctx.beginPath();
        ctx.moveTo(pad.left, liveY);
        ctx.lineTo(w - pad.right, liveY);
        ctx.stroke();
        ctx.setLineDash([]);
        const label = lastC.c.toFixed(2);
        ctx.font = '10px monospace';
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = lastC.c >= lastC.o ? '#3fb96f' : '#e05252';
        ctx.fillRect(w - pad.right + 2, liveY - 8, tw + 8, 16);
        ctx.fillStyle = '#0f1115';
        ctx.fillText(label, w - pad.right + 6, liveY + 3);
      }

      // Time labels (first and last candle).
      ctx.fillStyle = '#7d8594';
      ctx.font = '10px monospace';
      const fmt = (t) => {
        const d = new Date(t);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      };
      const fmtDay = (t) => {
        const d = new Date(t);
        return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth()+1).padStart(2, '0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      };
      const showDate = this.candles.length && (this.candles[this.candles.length-1].t - this.candles[0].t > 24*60*60*1000);
      ctx.fillStyle = '#7d8594';
      ctx.fillText(showDate ? fmtDay(this.candles[0].t) : fmt(this.candles[0].t), pad.left, h - 6);
      const lastLabel = showDate ? fmtDay(this.candles[this.candles.length - 1].t) : fmt(this.candles[this.candles.length - 1].t);
      ctx.fillText(lastLabel, w - pad.right - ctx.measureText(lastLabel).width, h - 6);
    }
  }

  // Range -> { interval (binance), limit (candles), label (display) }
  const RANGE_CFG = {
    '1h':  { interval: '1m',  limit: 60,  label: '1H (1m)'  },  // 60 batang 1m = 1 jam, tick live tiap detik
    '24h': { interval: '15m', limit: 96,  label: '24H (15m)' }, // 96 batang 15m = 24 jam
    '7d':  { interval: '1h',  limit: 168, label: '7D (1h)'  },  // 168 batang 1h = 7 hari
    '14d': { interval: '2h',  limit: 168, label: '14D (2h)' },  // 168 batang 2h = 14 hari
    '30d': { interval: '4h',  limit: 180, label: '30D (4h)' },  // 180 batang 4h = 30 hari
  };

  window.CandleChart = CandleChart;
})();
