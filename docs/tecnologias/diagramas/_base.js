/*
 * Ajudantes dos diagramas (veja _base.css). Dois recursos:
 *
 * 1. Setas entre caixas:
 *      Diagrama.link('#a', '#b', { label: 'publica', dashed: true, both: true,
 *        color: 'yellow', from: 'right', to: 'left', fromAt: 0.5, toAt: 0.5, curve: 0.5 })
 *    `from` e `to` são o lado da caixa (top, right, bottom, left); sem eles, o
 *    lado sai da posição relativa das caixas. `fromAt`/`toAt` escolhem o ponto
 *    ao longo do lado (0 a 1). `elbow: true` faz uma seta em L em vez de curva.
 *
 * 2. Diagrama de sequência, a partir do HTML:
 *      <div class="seq" data-seq>
 *        <div class="lane" data-cor="kafka">Kafka<small>broker</small></div>
 *        ...
 *        <div class="phase">Pagamento</div>
 *        <div class="m" data-de="0" data-para="2">texto</div>       (seta)
 *        <div class="m reply" data-de="2" data-para="0">texto</div> (resposta, tracejada)
 *        <div class="m" data-de="1" data-para="1">texto</div>       (nota na raia)
 *      </div>
 *    As mensagens são numeradas na ordem; `data-sem-numero` tira o número.
 *
 * Quando tudo está desenhado, `window.__diagramaPronto` vira true: é o que o
 * scripts/diagramas/render.mjs espera antes da foto.
 */
(function () {
  const COLORS = {
    muted: '#ABA4B5',
    yellow: '#FFD23F',
    pink: '#FF4D8D',
    green: '#3DDC84',
    red: '#FF5A5A',
    sky: '#59C3FF',
    lilac: '#B6A4FF',
    orange: '#FF7A1A',
    mongo: '#4FD1A5',
    redis: '#FF6B6B',
    text: '#F4EFE6',
  };
  const LANE_COLORS = {
    kafka: '#FFD23F',
    rabbit: '#FF4D8D',
    redis: '#FF6B6B',
    'redis-cache': '#FFB86B',
    pg: '#B6A4FF',
    mongo: '#4FD1A5',
    keycloak: '#59C3FF',
    otel: '#FF7A1A',
    ok: '#3DDC84',
  };
  const links = [];

  function el(target) {
    return typeof target === 'string' ? document.querySelector(target) : target;
  }

  function point(rect, side, at) {
    switch (side) {
      case 'top':
        return { x: rect.left + rect.width * at, y: rect.top, dx: 0, dy: -1 };
      case 'bottom':
        return { x: rect.left + rect.width * at, y: rect.bottom, dx: 0, dy: 1 };
      case 'left':
        return { x: rect.left, y: rect.top + rect.height * at, dx: -1, dy: 0 };
      default:
        return { x: rect.right, y: rect.top + rect.height * at, dx: 1, dy: 0 };
    }
  }

  function autoSides(a, b) {
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    const horizontalGap = Math.max(b.left - a.right, a.left - b.right);
    const verticalGap = Math.max(b.top - a.bottom, a.top - b.bottom);
    if (horizontalGap >= verticalGap) {
      return bx >= ax ? ['right', 'left'] : ['left', 'right'];
    }
    return by >= ay ? ['bottom', 'top'] : ['top', 'bottom'];
  }

  function draw() {
    for (const canvas of document.querySelectorAll('.canvas')) {
      const mine = links.filter((l) => canvas.contains(el(l.a)));
      if (mine.length === 0) continue;
      const base = canvas.getBoundingClientRect();
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'links');
      svg.setAttribute('width', base.width);
      svg.setAttribute('height', base.height);
      const defs = document.createElementNS(svg.namespaceURI, 'defs');
      svg.appendChild(defs);
      const markers = new Set();
      const marker = (color) => {
        const id = 'm' + color.replace('#', '');
        if (!markers.has(id)) {
          markers.add(id);
          defs.insertAdjacentHTML(
            'beforeend',
            `<marker id="${id}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker>`,
          );
        }
        return `url(#${id})`;
      };
      for (const l of mine) {
        const a = el(l.a);
        const b = el(l.b);
        if (!a || !b) {
          console.error('seta sem caixa', l.a, l.b);
          continue;
        }
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const rel = (r) => ({
          left: r.left - base.left,
          top: r.top - base.top,
          right: r.right - base.left,
          bottom: r.bottom - base.top,
          width: r.width,
          height: r.height,
        });
        const A = rel(ra);
        const B = rel(rb);
        const [fs, ts] = autoSides(A, B);
        const o = l.opts;
        const p1 = point(A, o.from ?? fs, o.fromAt ?? 0.5);
        const p2 = point(B, o.to ?? ts, o.toAt ?? 0.5);
        const gap = 4;
        p1.x += p1.dx * gap;
        p1.y += p1.dy * gap;
        p2.x += p2.dx * gap;
        p2.y += p2.dy * gap;
        let d;
        let mid;
        if (o.straight) {
          d = `M${p1.x},${p1.y} L${p2.x},${p2.y}`;
          mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
        } else if (o.elbow) {
          // Em L: sai na direção do lado de saída e dobra uma vez.
          const r = 14;
          if (p1.dx !== 0) {
            const sx = Math.sign(p2.x - p1.x) || 1;
            const sy = Math.sign(p2.y - p1.y) || 1;
            const cx = p2.x;
            d = `M${p1.x},${p1.y} L${cx - sx * r},${p1.y} Q${cx},${p1.y} ${cx},${p1.y + sy * r} L${p2.x},${p2.y}`;
            mid = { x: (p1.x + cx) / 2, y: p1.y };
          } else {
            const sx = Math.sign(p2.x - p1.x) || 1;
            const sy = Math.sign(p2.y - p1.y) || 1;
            const cy = p2.y;
            d = `M${p1.x},${p1.y} L${p1.x},${cy - sy * r} Q${p1.x},${cy} ${p1.x + sx * r},${cy} L${p2.x},${p2.y}`;
            mid = { x: p1.x, y: (p1.y + cy) / 2 };
          }
        } else {
          const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
          const k = Math.max(30, dist * (o.curve ?? 0.4));
          const c1 = { x: p1.x + p1.dx * k, y: p1.y + p1.dy * k };
          const c2 = { x: p2.x + p2.dx * k, y: p2.y + p2.dy * k };
          d = `M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`;
          const t = o.labelAt ?? 0.5;
          const u = 1 - t;
          mid = {
            x: u ** 3 * p1.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * p2.x,
            y: u ** 3 * p1.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * p2.y,
          };
        }
        const color = COLORS[o.color] ?? o.color ?? COLORS.muted;
        const path = document.createElementNS(svg.namespaceURI, 'path');
        path.setAttribute('d', d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', color);
        path.setAttribute('stroke-width', o.width ?? 2);
        path.setAttribute('stroke-linecap', 'round');
        if (o.dashed) path.setAttribute('stroke-dasharray', '6 6');
        if (o.head !== false) path.setAttribute('marker-end', marker(color));
        if (o.both) path.setAttribute('marker-start', marker(color));
        svg.appendChild(path);
        if (o.label) {
          const tag = document.createElement('div');
          tag.className = 'link-label';
          tag.textContent = o.label;
          tag.style.left = `${mid.x + (o.labelDx ?? 0)}px`;
          tag.style.top = `${mid.y + (o.labelDy ?? 0)}px`;
          if (o.labelColor) {
            tag.style.borderColor = COLORS[o.labelColor] ?? o.labelColor;
            tag.style.color = COLORS[o.labelColor] ?? o.labelColor;
          }
          canvas.appendChild(tag);
        }
      }
      canvas.appendChild(svg);
    }
  }

  function buildSequences() {
    for (const seq of document.querySelectorAll('[data-seq]')) {
      const lanes = [...seq.querySelectorAll(':scope > .lane')];
      const n = lanes.length;
      seq.style.gridTemplateColumns = `repeat(${n * 2}, minmax(0, 1fr))`;
      lanes.forEach((lane, i) => {
        lane.classList.add('lane-head');
        lane.style.gridColumn = `${2 * i + 1} / span 2`;
        lane.style.gridRow = '1';
        const cor = LANE_COLORS[lane.dataset.cor];
        if (cor) {
          lane.classList.add('solid');
          lane.style.background = cor;
        }
      });
      let row = 2;
      let count = 0;
      for (const item of seq.querySelectorAll(':scope > .m, :scope > .phase')) {
        item.style.gridRow = String(row++);
        if (item.classList.contains('phase')) continue;
        const from = Number(item.dataset.de);
        const to = Number(item.dataset.para);
        const numbered = !('semNumero' in item.dataset);
        const html = item.innerHTML;
        const num = numbered ? `<span class="num">${++count}</span>` : '';
        if (from === to) {
          item.className = 'self';
          item.style.gridColumn = `${2 * from + 1} / span 2`;
          item.innerHTML = `${num}<span>${html}</span>`;
          continue;
        }
        const lo = Math.min(from, to);
        const hi = Math.max(from, to);
        item.classList.add('msg', to > from ? 'to-right' : 'to-left');
        item.style.gridColumn = `${2 * lo + 2} / ${2 * hi + 2}`;
        item.innerHTML = `<div class="txt">${num}<span>${html}</span></div><div class="line"></div>`;
      }
      // Linhas de vida, atrás de tudo, no centro de cada raia.
      requestAnimationFrame(() => {
        const base = seq.getBoundingClientRect();
        lanes.forEach((lane) => {
          const r = lane.getBoundingClientRect();
          const line = document.createElement('div');
          line.className = 'lifeline';
          line.style.left = `${r.left - base.left + r.width / 2}px`;
          line.style.top = `${r.bottom - base.top}px`;
          seq.appendChild(line);
        });
      });
    }
  }

  window.Diagrama = {
    link(a, b, opts = {}) {
      links.push({ a, b, opts });
    },
  };

  window.addEventListener('DOMContentLoaded', () => {
    buildSequences();
    document.fonts.ready.then(() =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          draw();
          window.__diagramaPronto = true;
        }),
      ),
    );
  });
})();
