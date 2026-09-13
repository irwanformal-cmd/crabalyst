/* Universal visualization renderer — dependency-free canvas renderers for
 * structured VisualizationSpecs produced by the intelligence engine.
 *
 * window.Viz.render(container, spec, opts) -> { destroy(), redraw() }
 */
(function () {
  const PALETTE = ['#58a6ff', '#3fb96f', '#e0a352', '#c678dd', '#56d4dd', '#e05252'];
  const BG = '#0f1115';
  const GRID = '#1c2028';
  const TEXT = '#7d8594';
  const UP = '#3fb96f';
  const DOWN = '#e05252';

  function render(container, spec, opts) {
    opts = opts || {};
    container.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100%;height:100%;display:block';
    const tooltip = document.createElement('div');
    tooltip.style.cssText =
      'position:absolute;pointer-events:none;display:none;background:#171a21;border:1px solid #262b36;' +
      'border-radius:6px;padding:4px 8px;font:11px monospace;color:#c9d1d9;z-index:5;white-space:pre';
    container.appendChild(canvas);
    container.appendChild(tooltip);
    const ctx = canvas.getContext('2d');

    // View state for zoom/pan (fractional x-range 0..1).
    const view = { x0: 0, x1: 1 };

    function fit() {
      const dpr = window.devicePixelRatio || 1;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (!w || !h) return false;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return true;
    }

    function showTip(x, y, text) {
      tooltip.textContent = text;
      tooltip.style.display = 'block';
      const tw = tooltip.offsetWidth;
      const th = tooltip.offsetHeight;
      tooltip.style.left = Math.min(x + 12, container.clientWidth - tw - 4) + 'px';
      tooltip.style.top = Math.max(4, y - th - 8) + 'px';
    }
    function hideTip() { tooltip.style.display = 'none'; }

    // -- scales -------------------------------------------------------------
    function xLabel(x) {
      if (spec.xType === 'time' || (typeof x === 'number' && x > 1e12)) {
        const d = new Date(x);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
      }
      return String(Math.round(x * 100) / 100);
    }

    function drawEmpty() {
      ctx.fillStyle = TEXT;
      ctx.font = '12px monospace';
      ctx.fillText('no data', 14, 22);
    }

    function gridLines(pad, w, h, minY, maxY, fmt) {
      ctx.font = '10px monospace';
      ctx.strokeStyle = GRID;
      ctx.fillStyle = TEXT;
      for (let i = 0; i <= 4; i++) {
        const v = minY + ((maxY - minY) * i) / 4;
        const yy = pad.top + ((maxY - v) / (maxY - minY)) * (h - pad.top - pad.bottom);
        ctx.beginPath();
        ctx.moveTo(pad.left, yy);
        ctx.lineTo(w - pad.right, yy);
        ctx.stroke();
        ctx.fillText(fmt ? fmt(v) : String(Math.round(v * 100) / 100), w - pad.right + 4, yy + 3);
      }
    }

    function drawLevels(pad, w, yOf, h) {
      const levels = (spec.data && spec.data.levels) || [];
      const styleFor = (kind) =>
        kind === 'support' ? { color: UP, dash: [6, 4] }
        : kind === 'resistance' ? { color: DOWN, dash: [6, 4] }
        : kind === 'invalidation' ? { color: '#e0a352', dash: [3, 3] }
        : kind === 'current' ? { color: PALETTE[0], dash: [] }
        : { color: '#8b949e', dash: [2, 4] }; // baseline
      ctx.font = '9px monospace';
      for (const lvl of levels) {
        if (!Number.isFinite(lvl.value)) continue;
        const yy = yOf(lvl.value);
        if (!Number.isFinite(yy) || (h !== undefined && (yy < 4 || yy > h - 4))) continue;
        const st = styleFor(lvl.kind);
        ctx.strokeStyle = st.color;
        ctx.setLineDash(st.dash);
        ctx.lineWidth = lvl.kind === 'current' ? 1.4 : 1;
        ctx.beginPath();
        ctx.moveTo(pad.left, yy);
        ctx.lineTo(w - pad.right, yy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        // Label pill at the left edge: "R1 79,800".
        const short = String(lvl.label).replace('Resistance', 'R').replace('Support', 'S').replace('Baseline mean', 'BASE');
        const text = `${short} ${fmtLevelPrice(lvl.value)}`;
        const tw = ctx.measureText(text).width;
        ctx.fillStyle = '#0f1115ee';
        ctx.fillRect(pad.left + 3, yy - 8, tw + 8, 12);
        ctx.strokeStyle = st.color;
        ctx.strokeRect(pad.left + 3, yy - 8, tw + 8, 12);
        ctx.fillStyle = st.color;
        ctx.fillText(text, pad.left + 7, yy + 1);
      }
    }

    function fmtLevelPrice(v) {
      if (Math.abs(v) >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
      if (Math.abs(v) >= 10) return String(Math.round(v * 100) / 100);
      return String(Math.round(v * 10000) / 10000);
    }

    // -- line / area ----------------------------------------------------------
    function drawLine() {
      const series = (spec.data.series || []).filter((s) => s.points && s.points.length);
      if (!series.length) return drawEmpty();
      const pad = { top: 10, right: 60, bottom: 18, left: 8 };
      const w = canvas.clientWidth, h = canvas.clientHeight;
      let allX = [];
      let allY = [];
      for (const s of series) for (const p of s.points) { allX.push(p[0]); allY.push(p[1]); }
      let xMin = Math.min.apply(null, allX);
      let xMax = Math.max.apply(null, allX);
      if (xMin === xMax) { xMin -= 1; xMax += 1; }
      // Apply zoom window.
      const fullMin = xMin, fullMax = xMax;
      xMin = fullMin + (fullMax - fullMin) * view.x0;
      xMax = fullMin + (fullMax - fullMin) * view.x1;
      const visibleY = [];
      for (const s of series) for (const p of s.points) if (p[0] >= xMin && p[0] <= xMax) visibleY.push(p[1]);
      let yMin = visibleY.length ? Math.min.apply(null, visibleY) : Math.min.apply(null, allY);
      let yMax = visibleY.length ? Math.max.apply(null, visibleY) : Math.max.apply(null, allY);
      if (yMin === yMax) { yMin -= 1; yMax += 1; }
      const margin = (yMax - yMin) * 0.08;
      yMin -= margin; yMax += margin;

      gridLines(pad, w, h, yMin, yMax);
      const xOf = (x) => pad.left + ((x - xMin) / (xMax - xMin)) * (w - pad.left - pad.right);
      const yOf = (y) => pad.top + ((yMax - y) / (yMax - yMin)) * (h - pad.top - pad.bottom);

      series.forEach((s, si) => {
        const color = s.color || PALETTE[si % PALETTE.length];
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        let started = false;
        for (const p of s.points) {
          if (p[0] < xMin || p[0] > xMax) continue;
          const x = xOf(p[0]), y = yOf(p[1]);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        if (spec.type === 'area' && si === 0) {
          ctx.lineTo(xOf(Math.min(xMax, s.points[s.points.length - 1][0])), yOf(yMin));
          ctx.lineTo(xOf(Math.max(xMin, s.points[0][0])), yOf(yMin));
          ctx.closePath();
          ctx.fillStyle = color + '22';
          ctx.fill();
        }
      });
      ctx.lineWidth = 1;

      // Anomalies.
      for (const a of spec.data.anomalies || []) {
        if (a.x < xMin || a.x > xMax) continue;
        const x = xOf(a.x), y = yOf(a.y);
        ctx.fillStyle = a.severity === 'high' ? DOWN : a.severity === 'medium' ? '#e0a352' : TEXT;
        ctx.beginPath();
        ctx.moveTo(x, y - 6); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 5, y);
        ctx.closePath(); ctx.fill();
      }

      drawLevels(pad, w, yOf, h);

      // Legend.
      ctx.font = '10px monospace';
      series.forEach((s, si) => {
        ctx.fillStyle = s.color || PALETTE[si % PALETTE.length];
        ctx.fillText(s.label || s.id, pad.left + 6 + si * 110, 12);
      });
      ctx.fillStyle = TEXT;
      ctx.fillText(xLabel(xMin), pad.left, h - 4);
      const last = xLabel(xMax);
      ctx.fillText(last, w - pad.right - ctx.measureText(last).width, h - 4);

      // Hover: nearest point.
      canvas.onmousemove = (ev) => {
        const rect = canvas.getBoundingClientRect();
        const mx = ev.clientX - rect.left;
        const dataX = xMin + ((mx - pad.left) / (w - pad.left - pad.right)) * (xMax - xMin);
        let best = null;
        for (const s of series) {
          for (const p of s.points) {
            const d = Math.abs(p[0] - dataX);
            if (!best || d < best.d) best = { d, s, p };
          }
        }
        if (best && best.d < (xMax - xMin) / 20) {
          showTip(ev.clientX - rect.left, ev.clientY - rect.top, `${best.s.label || best.s.id}\n${xLabel(best.p[0])}: ${Math.round(best.p[1] * 100) / 100}`);
        } else hideTip();
      };
      canvas.onmouseleave = hideTip;
      enableZoomPan();
    }

    // -- candlestick ----------------------------------------------------------
    function drawCandles() {
      const candles = (spec.data.candles || []).filter((c) => Number.isFinite(c.c));
      if (!candles.length) return drawEmpty();
      const pad = { top: 10, right: 66, bottom: 18, left: 8 };
      const w = canvas.clientWidth, h = canvas.clientHeight;
      const n = candles.length;
      const i0 = Math.max(0, Math.floor(view.x0 * n));
      const i1 = Math.min(n - 1, Math.ceil(view.x1 * n));
      const slice = candles.slice(i0, i1 + 1);
      let lo = Infinity, hi = -Infinity, vMax = 0;
      for (const c of slice) { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); vMax = Math.max(vMax, c.v || 0); }
      if (lo === hi) { lo -= 1; hi += 1; }
      const m = (hi - lo) * 0.06; lo -= m; hi += m;
      const plotH = (h - pad.top - pad.bottom) * 0.82;
      const volH = (h - pad.top - pad.bottom) * 0.14;
      gridLines(pad, w, pad.top + plotH + pad.bottom, lo, hi, (v) => v.toPrecision(6).replace(/\.?0+$/, ''));
      const step = (w - pad.left - pad.right) / Math.max(1, slice.length);
      const bodyW = Math.max(1, Math.min(step * 0.65, 12));
      const yOf = (p) => pad.top + ((hi - p) / (hi - lo)) * plotH;

      slice.forEach((c, i) => {
        const x = pad.left + i * step + step / 2;
        const up = c.c >= c.o;
        const color = up ? UP : DOWN;
        ctx.strokeStyle = color;
        ctx.beginPath(); ctx.moveTo(x, yOf(c.h)); ctx.lineTo(x, yOf(c.l)); ctx.stroke();
        const yO = yOf(c.o), yC = yOf(c.c);
        ctx.fillStyle = color;
        ctx.fillRect(x - bodyW / 2, Math.min(yO, yC), bodyW, Math.max(1, Math.abs(yO - yC)));
        if (vMax > 0) {
          ctx.fillStyle = color + '44';
          const vh = ((c.v || 0) / vMax) * volH;
          ctx.fillRect(x - bodyW / 2, pad.top + plotH + volH - vh + 6, bodyW, vh);
        }
      });

      drawLevels(pad, w, yOf, h);

      ctx.fillStyle = TEXT;
      ctx.font = '10px monospace';
      ctx.fillText(xLabel(slice[0].t), pad.left, h - 4);
      const last = xLabel(slice[slice.length - 1].t);
      ctx.fillText(last, w - pad.right - ctx.measureText(last).width, h - 4);

      canvas.onmousemove = (ev) => {
        const rect = canvas.getBoundingClientRect();
        const i = Math.round(((ev.clientX - rect.left - pad.left) / (w - pad.left - pad.right)) * slice.length - 0.5);
        const c = slice[Math.max(0, Math.min(slice.length - 1, i))];
        if (c) showTip(ev.clientX - rect.left, ev.clientY - rect.top, `${xLabel(c.t)}\nO ${c.o}  H ${c.h}\nL ${c.l}  C ${c.c}`);
      };
      canvas.onmouseleave = hideTip;
      enableZoomPan();
    }

    // -- bar / grouped-bar ------------------------------------------------------
    function drawBar() {
      const cats = spec.data.categories || [];
      const sers = spec.data.series || [];
      if (!cats.length || !sers.length) return drawEmpty();
      const pad = { top: 12, right: 12, bottom: 26, left: 44 };
      const w = canvas.clientWidth, h = canvas.clientHeight;
      let lo = 0, hi = 0;
      for (const s of sers) for (const v of s.values || []) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      if (lo === hi) { lo -= 1; hi += 1; }
      const m = (hi - lo) * 0.1; lo -= m; hi += m;
      const yOf = (v) => pad.top + ((hi - v) / (hi - lo)) * (h - pad.top - pad.bottom);
      const groupW = (w - pad.left - pad.right) / cats.length;
      const barW = Math.min(groupW / (sers.length + 0.5), 40);

      ctx.font = '10px monospace';
      ctx.strokeStyle = GRID; ctx.fillStyle = TEXT;
      for (let i = 0; i <= 4; i++) {
        const v = lo + ((hi - lo) * i) / 4;
        const yy = yOf(v);
        ctx.beginPath(); ctx.moveTo(pad.left, yy); ctx.lineTo(w - pad.right, yy); ctx.stroke();
        ctx.fillText(String(Math.round(v * 10) / 10), 4, yy + 3);
      }
      // Zero line.
      if (lo < 0 && hi > 0) {
        ctx.strokeStyle = TEXT;
        ctx.beginPath(); ctx.moveTo(pad.left, yOf(0)); ctx.lineTo(w - pad.right, yOf(0)); ctx.stroke();
      }
      cats.forEach((cat, ci) => {
        const gx = pad.left + ci * groupW + groupW / 2;
        sers.forEach((s, si) => {
          const v = (s.values || [])[ci];
          if (!Number.isFinite(v)) return;
          const x = gx + (si - (sers.length - 1) / 2) * (barW + 2) - barW / 2;
          const y0 = yOf(Math.max(0, v));
          const y1 = yOf(Math.min(0, v));
          ctx.fillStyle = v >= 0 ? (s.color || PALETTE[si % PALETTE.length]) : DOWN;
          ctx.fillRect(x, y0, barW, Math.max(1, y1 - y0));
        });
        ctx.fillStyle = TEXT;
        const label = String(cat).slice(0, 12);
        ctx.fillText(label, Math.min(gx - ctx.measureText(label).width / 2, w - pad.right - ctx.measureText(label).width), h - 12);
      });

      canvas.onmousemove = (ev) => {
        const rect = canvas.getBoundingClientRect();
        const ci = Math.floor(((ev.clientX - rect.left - pad.left) / (w - pad.left - pad.right)) * cats.length);
        if (ci >= 0 && ci < cats.length) {
          const parts = sers.map((s) => `${s.label}: ${(s.values || [])[ci]}`);
          showTip(ev.clientX - rect.left, ev.clientY - rect.top, `${cats[ci]}\n${parts.join('\n')}`);
        }
      };
      canvas.onmouseleave = hideTip;
    }

    // -- scatter ---------------------------------------------------------------
    function drawScatter() {
      const pts = (spec.data.points || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
      if (!pts.length) return drawEmpty();
      const pad = { top: 12, right: 14, bottom: 22, left: 48 };
      const w = canvas.clientWidth, h = canvas.clientHeight;
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      let xMin = Math.min.apply(null, xs), xMax = Math.max.apply(null, xs);
      let yMin = Math.min.apply(null, ys), yMax = Math.max.apply(null, ys);
      if (xMin === xMax) { xMin -= 1; xMax += 1; }
      if (yMin === yMax) { yMin -= 1; yMax += 1; }
      const mx = (xMax - xMin) * 0.06, my = (yMax - yMin) * 0.06;
      xMin -= mx; xMax += mx; yMin -= my; yMax += my;
      const xOf = (x) => pad.left + ((x - xMin) / (xMax - xMin)) * (w - pad.left - pad.right);
      const yOf = (y) => pad.top + ((yMax - y) / (yMax - yMin)) * (h - pad.top - pad.bottom);
      gridLines(pad, w, h, yMin, yMax);

      ctx.fillStyle = PALETTE[0];
      for (const p of pts) {
        ctx.beginPath(); ctx.arc(xOf(p.x), yOf(p.y), 3, 0, Math.PI * 2); ctx.fill();
      }

      // Least-squares regression line.
      if (pts.length >= 3) {
        const n = pts.length;
        const meanX = xs.reduce((a, b) => a + b, 0) / n;
        const meanY = ys.reduce((a, b) => a + b, 0) / n;
        let sxy = 0, sxx = 0;
        for (const p of pts) { sxy += (p.x - meanX) * (p.y - meanY); sxx += (p.x - meanX) ** 2; }
        if (sxx > 0) {
          const slope = sxy / sxx;
          const intercept = meanY - slope * meanX;
          ctx.strokeStyle = '#e0a352';
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(xOf(xMin), yOf(intercept + slope * xMin));
          ctx.lineTo(xOf(xMax), yOf(intercept + slope * xMax));
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      ctx.fillStyle = TEXT;
      ctx.font = '10px monospace';
      if (spec.data.correlation !== undefined) ctx.fillText(`r = ${spec.data.correlation}`, pad.left + 6, 14);
      if (spec.data.xLabel) ctx.fillText(spec.data.xLabel, w / 2 - 20, h - 4);
      if (spec.data.yLabel) { ctx.save(); ctx.translate(10, h / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(spec.data.yLabel, 0, 0); ctx.restore(); }

      canvas.onmousemove = (ev) => {
        const rect = canvas.getBoundingClientRect();
        const mxp = ev.clientX - rect.left, myp = ev.clientY - rect.top;
        let best = null;
        for (const p of pts) {
          const d = Math.hypot(xOf(p.x) - mxp, yOf(p.y) - myp);
          if (!best || d < best.d) best = { d, p };
        }
        if (best && best.d < 14) showTip(mxp, myp, `${best.p.label || ''}\nx ${Math.round(best.p.x * 100) / 100}  y ${Math.round(best.p.y * 100) / 100}`);
        else hideTip();
      };
      canvas.onmouseleave = hideTip;
    }

    // -- histogram --------------------------------------------------------------
    function drawHistogram() {
      const bins = spec.data.bins || [];
      if (!bins.length) return drawEmpty();
      const pad = { top: 12, right: 12, bottom: 22, left: 40 };
      const w = canvas.clientWidth, h = canvas.clientHeight;
      const maxCount = Math.max.apply(null, bins.map((b) => b.count)) || 1;
      const bw = (w - pad.left - pad.right) / bins.length;
      ctx.font = '10px monospace';
      ctx.strokeStyle = GRID; ctx.fillStyle = TEXT;
      for (let i = 0; i <= 4; i++) {
        const v = (maxCount * i) / 4;
        const yy = pad.top + (1 - i / 4) * (h - pad.top - pad.bottom);
        ctx.beginPath(); ctx.moveTo(pad.left, yy); ctx.lineTo(w - pad.right, yy); ctx.stroke();
        ctx.fillText(String(Math.round(v)), 8, yy + 3);
      }
      bins.forEach((b, i) => {
        const bh = (b.count / maxCount) * (h - pad.top - pad.bottom);
        ctx.fillStyle = PALETTE[0] + 'aa';
        ctx.fillRect(pad.left + i * bw + 1, h - pad.bottom - bh, bw - 2, bh);
      });
      ctx.fillStyle = TEXT;
      ctx.fillText(String(bins[0].x0), pad.left, h - 6);
      const last = String(bins[bins.length - 1].x1);
      ctx.fillText(last, w - pad.right - ctx.measureText(last).width, h - 6);
    }

    // -- heatmap / correlation-matrix --------------------------------------------
    function drawHeatmap() {
      const labels = spec.data.labels || [];
      const values = spec.data.values || [];
      if (!labels.length || !values.length) return drawEmpty();
      const corr = spec.type === 'correlation-matrix';
      const pad = { top: 46, right: 8, bottom: 6, left: 70 };
      const w = canvas.clientWidth, h = canvas.clientHeight;
      const cw = (w - pad.left - pad.right) / labels.length;
      const ch = (h - pad.top - pad.bottom) / labels.length;
      ctx.font = '9px monospace';

      function colorFor(v) {
        if (corr) {
          const t = Math.max(-1, Math.min(1, v));
          if (t >= 0) {
            const a = Math.round(t * 200);
            return `rgb(${63 - a / 8},${110 + a / 3},${80 + a / 8})`;
          }
          const a = Math.round(-t * 200);
          return `rgb(${140 + a / 3},${70 - a / 10},${70 - a / 10})`;
        }
        const t = Math.max(0, Math.min(1, v));
        return `rgb(${15 + t * 220},${30 + t * 160},${60 + t * 120})`;
      }

      values.forEach((row, ri) => {
        row.forEach((v, ci) => {
          ctx.fillStyle = colorFor(v);
          ctx.fillRect(pad.left + ci * cw, pad.top + ri * ch, cw - 1, ch - 1);
          if (corr && cw > 26 && ch > 14) {
            ctx.fillStyle = '#e6edf3';
            ctx.fillText(String(v), pad.left + ci * cw + 3, pad.top + ri * ch + ch / 2 + 3);
          }
        });
      });
      ctx.fillStyle = TEXT;
      labels.forEach((l, i) => {
        ctx.fillText(String(l).slice(0, 10), 2, pad.top + i * ch + ch / 2 + 3);
        ctx.save();
        ctx.translate(pad.left + i * cw + 8, pad.top - 4);
        ctx.rotate(-Math.PI / 5);
        ctx.fillText(String(l).slice(0, 10), 0, 0);
        ctx.restore();
      });
    }

    // -- network -----------------------------------------------------------------
    function drawNetwork() {
      const nodes = spec.data.nodes || [];
      const edges = spec.data.edges || [];
      if (!nodes.length) return drawEmpty();
      const w = canvas.clientWidth, h = canvas.clientHeight;
      const sorted = [...nodes].sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const cx = w / 2, cy = h / 2;
      const R = Math.max(40, Math.min(w, h) / 2 - 46);
      const pos = new Map();
      sorted.forEach((n, i) => {
        const a = (i / sorted.length) * Math.PI * 2 - Math.PI / 2;
        pos.set(n.id, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
      });
      const kindColor = {};
      let ki = 0;

      for (const e of edges) {
        const a = pos.get(e.from), b = pos.get(e.to);
        if (!a || !b) continue;
        ctx.strokeStyle = '#3a3f4d';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        // Slight curve via quadratic control offset.
        const mx2 = (a.x + b.x) / 2 + (b.y - a.y) * 0.08;
        const my2 = (a.y + b.y) / 2 - (b.x - a.x) * 0.08;
        ctx.quadraticCurveTo(mx2, my2, b.x, b.y);
        ctx.stroke();
        // Arrowhead.
        const ang = Math.atan2(b.y - my2, b.x - mx2);
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x - 7 * Math.cos(ang - 0.4), b.y - 7 * Math.sin(ang - 0.4));
        ctx.lineTo(b.x - 7 * Math.cos(ang + 0.4), b.y - 7 * Math.sin(ang + 0.4));
        ctx.closePath();
        ctx.fillStyle = '#3a3f4d';
        ctx.fill();
      }

      ctx.font = '9px monospace';
      for (const n of sorted) {
        const p = pos.get(n.id);
        if (!(n.kind in kindColor)) kindColor[n.kind] = PALETTE[ki++ % PALETTE.length];
        ctx.fillStyle = kindColor[n.kind];
        ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = TEXT;
        const label = String(n.label || n.id).slice(0, 14);
        ctx.fillText(label, p.x - ctx.measureText(label).width / 2, p.y + 16);
      }

      canvas.onmousemove = (ev) => {
        const rect = canvas.getBoundingClientRect();
        const mxp = ev.clientX - rect.left, myp = ev.clientY - rect.top;
        for (const n of sorted) {
          const p = pos.get(n.id);
          if (Math.hypot(p.x - mxp, p.y - myp) < 10) {
            showTip(mxp, myp, `${n.kind || 'node'}: ${n.label || n.id}`);
            return;
          }
        }
        hideTip();
      };
      canvas.onmouseleave = hideTip;
      canvas.onclick = (ev) => {
        const rect = canvas.getBoundingClientRect();
        const mxp = ev.clientX - rect.left, myp = ev.clientY - rect.top;
        for (const n of sorted) {
          const p = pos.get(n.id);
          if (Math.hypot(p.x - mxp, p.y - myp) < 10) {
            if (opts.onSelect) opts.onSelect({ kind: 'node', id: n.id, label: n.label });
            return;
          }
        }
      };
    }

    // -- zoom / pan ---------------------------------------------------------------
    let panState = null;
    function enableZoomPan() {
      canvas.onwheel = (ev) => {
        ev.preventDefault();
        const zoom = ev.deltaY > 0 ? 1.15 : 1 / 1.15;
        const center = (view.x0 + view.x1) / 2;
        let half = ((view.x1 - view.x0) / 2) * zoom;
        half = Math.min(0.5, Math.max(0.05, half));
        view.x0 = Math.max(0, center - half);
        view.x1 = Math.min(1, center + half);
        const span = view.x1 - view.x0;
        if (view.x0 === 0) view.x1 = span;
        if (view.x1 === 1) view.x0 = 1 - span;
        draw();
      };
      canvas.ondblclick = () => { view.x0 = 0; view.x1 = 1; draw(); };
      canvas.onmousedown = (ev) => { panState = { x: ev.clientX, v0: view.x0, v1: view.x1 }; };
      canvas.onmousemove_wrap = null;
      canvas.onmousemove_pan = null;
      canvas.addEventListener('mousemove', panMove);
      canvas.addEventListener('mouseup', panEnd);
    }
    function panMove(ev) {
      if (!panState) return;
      const span = panState.v1 - panState.v0;
      const dx = (ev.clientX - panState.x) / Math.max(1, canvas.clientWidth);
      let nx0 = panState.v0 - dx * span;
      let nx1 = panState.v1 - dx * span;
      if (nx0 < 0) { nx1 -= nx0; nx0 = 0; }
      if (nx1 > 1) { nx0 -= nx1 - 1; nx1 = 1; }
      view.x0 = Math.max(0, nx0);
      view.x1 = Math.min(1, nx1);
      draw();
    }
    function panEnd() { panState = null; }

    // -- dispatch -----------------------------------------------------------------
    function draw() {
      if (!fit()) return;
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      try {
        switch (spec.type) {
          case 'line':
          case 'area': drawLine(); break;
          case 'candlestick': drawCandles(); break;
          case 'bar':
          case 'grouped-bar':
          case 'stacked-bar': drawBar(); break;
          case 'scatter': drawScatter(); break;
          case 'histogram': drawHistogram(); break;
          case 'heatmap':
          case 'correlation-matrix': drawHeatmap(); break;
          case 'network': drawNetwork(); break;
          default: drawEmpty();
        }
      } catch (err) {
        ctx.fillStyle = DOWN;
        ctx.font = '11px monospace';
        ctx.fillText(`render error: ${err.message}`, 10, 20);
      }
    }

    const ro = new ResizeObserver(draw);
    ro.observe(container);
    draw();

    return {
      redraw: draw,
      destroy() {
        ro.disconnect();
        canvas.removeEventListener('mousemove', panMove);
        canvas.removeEventListener('mouseup', panEnd);
        container.innerHTML = '';
      },
    };
  }

  window.Viz = { render };
})();
