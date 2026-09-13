/* Evidence Graph — interactive, auditable reasoning structure.
 * Renders conclusion → analyst → finding → evidence → source as a layered
 * node-link diagram. Clicking a node highlights its neighborhood.
 *
 * window.EvidenceGraph.render(container, graph, opts) -> { destroy(), redraw() }
 */
(function () {
  const KIND_COLOR = {
    conclusion: '#e0a352',
    finding: '#58a6ff',
    evidence: '#3fb96f',
    metric: '#79c0ff',
    anomaly: '#e05252',
    analyst: '#c678dd',
    source: '#7d8594',
    scenario: '#56d4dd',
    assumption: '#8b949e',
    forecast: '#d2a8ff',
  };
  // Left → right column order by kind.
  const KIND_COLUMN = {
    source: 0,
    metric: 1,
    evidence: 1,
    anomaly: 2,
    finding: 2,
    analyst: 3,
    scenario: 4,
    forecast: 4,
    assumption: 4,
    conclusion: 5,
  };
  const EDGE_STYLE = {
    supports: { color: '#3fb96f', dash: [] },
    contradicts: { color: '#e05252', dash: [5, 4] },
    'derived-from': { color: '#3a3f4d', dash: [] },
    'correlates-with': { color: '#56d4dd', dash: [3, 3] },
    'caused-by': { color: '#e0a352', dash: [4, 3] },
    'depends-on': { color: '#8b949e', dash: [2, 3] },
    'contributes-to': { color: '#58a6ff', dash: [] },
  };

  function render(container, graph, opts) {
    opts = opts || {};
    container.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100%;height:100%;display:block;cursor:pointer';
    const tooltip = document.createElement('div');
    tooltip.style.cssText =
      'position:absolute;pointer-events:none;display:none;background:#171a21;border:1px solid #262b36;' +
      'border-radius:6px;padding:4px 8px;font:11px monospace;color:#c9d1d9;z-index:5;max-width:280px;white-space:pre-wrap';
    container.appendChild(canvas);
    container.appendChild(tooltip);
    const ctx = canvas.getContext('2d');

    const nodes = graph.nodes || [];
    const edges = graph.edges || [];
    const pos = new Map();
    let selected = null;

    function layout() {
      pos.clear();
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (!w || !h) return;
      const cols = new Map();
      for (const n of nodes) {
        const c = KIND_COLUMN[n.kind] ?? 3;
        if (!cols.has(c)) cols.set(c, []);
        cols.get(c).push(n);
      }
      const colIds = [...cols.keys()].sort((a, b) => a - b);
      const padX = 40;
      const padY = 24;
      for (const c of colIds) {
        const x = padX + (c / Math.max(1, colIds[colIds.length - 1])) * (w - padX * 2 - 60);
        const list = cols.get(c);
        list.forEach((n, i) => {
          const y = padY + ((i + 0.5) / list.length) * (h - padY * 2);
          pos.set(n.id, { x, y });
        });
      }
    }

    function draw() {
      const dpr = window.devicePixelRatio || 1;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (!w || !h) return;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#0f1115';
      ctx.fillRect(0, 0, w, h);

      if (!nodes.length) {
        ctx.fillStyle = '#7d8594';
        ctx.font = '12px monospace';
        ctx.fillText('no evidence graph', 14, 22);
        return;
      }

      layout();

      const connected = new Set();
      if (selected) {
        connected.add(selected);
        for (const e of edges) {
          if (e.from === selected) connected.add(e.to);
          if (e.to === selected) connected.add(e.from);
        }
      }

      // Edges.
      for (const e of edges) {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) continue;
        const style = EDGE_STYLE[e.kind] || { color: '#2a2f3a', dash: [] };
        const active = !selected || (connected.has(e.from) && connected.has(e.to));
        ctx.strokeStyle = active ? style.color : '#22262f';
        ctx.setLineDash(style.dash);
        ctx.globalAlpha = active ? 0.9 : 0.25;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        const mx = (a.x + b.x) / 2;
        ctx.bezierCurveTo(mx, a.y, mx, b.y, b.x, b.y);
        ctx.stroke();
        // Arrowhead.
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x - 7 * Math.cos(ang - 0.4), b.y - 7 * Math.sin(ang - 0.4));
        ctx.lineTo(b.x - 7 * Math.cos(ang + 0.4), b.y - 7 * Math.sin(ang + 0.4));
        ctx.closePath();
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
      }

      // Nodes.
      ctx.font = '9px monospace';
      for (const n of nodes) {
        const p = pos.get(n.id);
        if (!p) continue;
        const active = !selected || connected.has(n.id);
        ctx.globalAlpha = active ? 1 : 0.25;
        ctx.fillStyle = KIND_COLOR[n.kind] || '#7d8594';
        ctx.beginPath();
        ctx.arc(p.x, p.y, n.kind === 'conclusion' ? 9 : 6, 0, Math.PI * 2);
        ctx.fill();
        if (n.id === selected) {
          ctx.strokeStyle = '#e6edf3';
          ctx.beginPath();
          ctx.arc(p.x, p.y, n.kind === 'conclusion' ? 12 : 9, 0, Math.PI * 2);
          ctx.stroke();
        }
        let label = String(n.label || n.id);
        if (label.length > 22) label = label.slice(0, 21) + '…';
        ctx.fillStyle = active ? '#7d8594' : '#3a3f4d';
        ctx.fillText(label, p.x + 10, p.y + 3);
        ctx.globalAlpha = 1;
      }
    }

    function nodeAt(mx, my) {
      for (const n of nodes) {
        const p = pos.get(n.id);
        if (p && Math.hypot(p.x - mx, p.y - my) < 11) return n;
      }
      return null;
    }

    canvas.onmousemove = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const n = nodeAt(mx, my);
      if (n) {
        tooltip.textContent = `${n.kind}: ${n.label}${n.detail ? `\n${n.detail}` : ''}`;
        tooltip.style.display = 'block';
        tooltip.style.left = Math.min(mx + 12, container.clientWidth - 200) + 'px';
        tooltip.style.top = Math.max(4, my - 30) + 'px';
        canvas.style.cursor = 'pointer';
      } else {
        tooltip.style.display = 'none';
        canvas.style.cursor = 'default';
      }
    };
    canvas.onmouseleave = () => { tooltip.style.display = 'none'; };
    canvas.onclick = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const n = nodeAt(ev.clientX - rect.left, ev.clientY - rect.top);
      selected = n ? (selected === n.id ? null : n.id) : null;
      if (n && selected && opts.onSelect) opts.onSelect(n);
      draw();
    };

    const ro = new ResizeObserver(draw);
    ro.observe(container);
    draw();

    return {
      redraw: draw,
      destroy() {
        ro.disconnect();
        container.innerHTML = '';
      },
    };
  }

  window.EvidenceGraph = { render };
})();
