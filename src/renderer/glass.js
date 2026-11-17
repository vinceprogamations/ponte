'use strict';
// Liquid Glass: refração nas bordas dos painéis de vidro.
//
// Para cada elemento com [data-liquid], gera um mapa de deslocamento do
// tamanho dele (um retângulo arredondado em que só a faixa da borda desvia a
// luz, como uma lente) e usa esse mapa num filtro SVG aplicado ao que está
// atrás (backdrop-filter: url(#...)). Isso funciona no Chromium, que é o
// motor do Electron. Se o filtro falhar, o vidro continua só desfocado.
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const host = document.createElementNS(NS, 'svg');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  const defs = document.createElementNS(NS, 'defs');
  host.append(defs);
  document.body.append(host);

  let seq = 0;

  /** Mapa de deslocamento: vermelho = desvio em x, verde = desvio em y, 128 = nenhum. */
  function displacementMap(w, h, radius, bezel) {
    const scale = 0.5;
    const cw = Math.max(2, Math.round(w * scale));
    const ch = Math.max(2, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(cw, ch);
    const r = Math.min(radius, w / 2, h / 2);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const px = (x + 0.5) / scale;
        const py = (y + 0.5) / scale;
        const qx = Math.abs(px - w / 2) - (w / 2 - r);
        const qy = Math.abs(py - h / 2) - (h / 2 - r);
        const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
        const inside = Math.min(Math.max(qx, qy), 0);
        const depth = r - (outside + inside); // distância até a borda, para dentro
        let nx = 0;
        let ny = 0;
        if (qx > 0 && qy > 0) {
          const l = Math.hypot(qx, qy) || 1;
          nx = qx / l;
          ny = qy / l;
        } else if (qx > qy) nx = 1;
        else ny = 1;
        nx *= Math.sign(px - w / 2) || 1;
        ny *= Math.sign(py - h / 2) || 1;
        const t = Math.max(0, Math.min(1, 1 - depth / bezel));
        const m = t * t * (3 - 2 * t); // suaviza a curva da lente
        const i = (y * cw + x) * 4;
        img.data[i] = 128 + nx * m * 127;
        img.data[i + 1] = 128 + ny * m * 127;
        img.data[i + 2] = 128;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL();
  }

  function build(el) {
    const rect = el.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w < 8 || h < 8) return;
    if (el._liquid && el._liquid.w === w && el._liquid.h === h) return;
    const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    const bezel = Number(el.dataset.bezel) || Math.min(28, h / 2.2);
    const strength = Number(el.dataset.liquid) || 40;
    const id = el._liquid ? el._liquid.id : `liquid-${++seq}`;

    let filter = defs.querySelector(`#${id}`);
    if (!filter) {
      filter = document.createElementNS(NS, 'filter');
      filter.id = id;
      filter.setAttribute('color-interpolation-filters', 'sRGB');
      filter.innerHTML = '<feImage result="map" preserveAspectRatio="none" x="0" y="0"/>'
        + '<feDisplacementMap in="SourceGraphic" in2="map" xChannelSelector="R" yChannelSelector="G"/>';
      defs.append(filter);
    }
    filter.setAttribute('x', '0');
    filter.setAttribute('y', '0');
    filter.setAttribute('width', String(w));
    filter.setAttribute('height', String(h));
    filter.setAttribute('filterUnits', 'userSpaceOnUse');
    const image = filter.querySelector('feImage');
    image.setAttribute('width', String(w));
    image.setAttribute('height', String(h));
    image.setAttribute('href', displacementMap(w, h, radius, bezel));
    filter.querySelector('feDisplacementMap').setAttribute('scale', String(-strength));

    el._liquid = { id, w, h };
    el.style.setProperty('--liquid', `url(#${id})`);
    el.classList.add('liquid-on');
  }

  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      clearTimeout(e.target._liquidTimer);
      e.target._liquidTimer = setTimeout(() => build(e.target), 120);
    }
  });

  function attach(el) {
    if (el._liquidAttached) return;
    el._liquidAttached = true;
    ro.observe(el);
    build(el);
  }

  function scan(root = document) {
    root.querySelectorAll('[data-liquid]').forEach(attach);
  }

  window.liquidGlass = { scan, attach };
  scan();
})();
