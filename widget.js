/* Parametric-plot widget engine (classic script; shared toolkit, source of truth
   in teach/slides/, vendored into each course like poll.js).

   The SPLIT mirrors the poll stack: this file is the ENGINE, each course's
   `widgets.js` holds the WIDGET DEFINITIONS (window.WIDGETS), exactly as
   `poll.js` : `polls.js`.

   A widget is a declarative spec: an x-axis, a draggable cursor, optional
   parameter sliders, one or more curves y=f(x, params), optional mode toggle.
   The engine renders an inline-SVG plot (no CDN, offline-safe), a legend, live
   readouts at the cursor, and auto-generated slider controls, and recomputes on
   any input. Pedagogy: the motion IS the content — dragging a parameter makes a
   comparative static something the student does, not a claim they're told.

   Mount in a deck slide:
     <section><div class="widgetmount" data-widget="care_curve"></div></section>
   and in the deck init (mirrors the pollmount loop):
     document.querySelectorAll('.widgetmount').forEach(function (el) {
       Widget.mount(el, WIDGETS[el.getAttribute('data-widget')]);
     });

   Spec shape (all fields but xAxis/cursor/curves optional):
     xAxis  : { label, min, max }
     cursor : { label, value, step }                       // the evaluated x
     sliders: [{ key, label, min, max, step, value, modes? }]
     consts : { ... }                                      // fixed params
     modes  : [{ key, label }]                             // optional toggle
     curves : [{ key, label, color, width?, dash?, modes?, optimum?, choose?,
                 f:(x, P) => y }]                           // P = consts+sliders
   color is one of: accent | good | muted | bad (mapped to theme vars).
   optimum:true  -> engine marks argmin of that curve as x*.
   choose:true   -> engine marks argmin of that curve as the agent's choice. */
(function (w) {
  var NS = 'http://www.w3.org/2000/svg';
  var COLORS = { accent: 'var(--accent)', good: 'var(--good)', muted: 'var(--muted)', bad: 'var(--bad)' };
  var DEFAULT_PLOT = { w: 960, h: 270, l: 58, r: 16, t: 16, b: 38 };  // SVG user units; wide-and-short so the plot + legend + readout + up to 3 sliders all fit inside the 720px slide canvas alongside a heading. A widget may override with spec.plot (e.g. a squarer plot when spec.layout:'side' puts the sliders in a right-hand column).

  function fmt(v) {
    if (!isFinite(v)) return '—';
    var r = Math.round(v * 10) / 10;
    return (Math.abs(r) < 1e-9 ? 0 : r).toString();
  }
  function el(tag, attrs, kids) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    (kids || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }
  function argmin(f, lo, hi) {                 // dense sample; good enough for lecture curves
    var best = lo, bv = Infinity, N = 600;
    for (var i = 0; i <= N; i++) {
      var x = lo + (hi - lo) * i / N, y = f(x);
      if (y < bv) { bv = y; best = x; }
    }
    return best;
  }

  function mount(root, spec, opts) {
    if (!spec) { root.innerHTML = '<div class="w-err">unknown widget</div>'; return; }
    root.classList.add('widget');
    if (spec.layout) root.classList.add('w-' + spec.layout);   // opt-in layout, e.g. 'side' → sliders in a right column
    var PLOT = spec.plot || DEFAULT_PLOT;                        // per-widget plot geometry
    var mode = (opts && opts.mode) || (spec.modes ? spec.modes[0].key : null);

    // --- state: current parameter values ---
    var vals = {};
    for (var c in (spec.consts || {})) vals[c] = spec.consts[c];
    (spec.sliders || []).forEach(function (s) { vals[s.key] = s.value; });
    var cursor = spec.cursor ? spec.cursor.value : (spec.xAxis.min + spec.xAxis.max) / 2;

    function activeCurves() {
      return spec.curves.filter(function (c) { return !c.modes || c.modes.indexOf(mode) >= 0; });
    }
    function activeSliders() {
      return (spec.sliders || []).filter(function (s) { return !s.modes || s.modes.indexOf(mode) >= 0; });
    }
    function P() { var o = {}; for (var k in vals) o[k] = vals[k]; o.mode = mode; return o; }

    // --- scales ---
    var xmin = spec.xAxis.min, xmax = spec.xAxis.max;
    function sx(x) { return PLOT.l + (x - xmin) / (xmax - xmin) * (PLOT.w - PLOT.l - PLOT.r); }
    function yrange() {                      // [min, max] over visible curves; always includes 0
      var lo = 0, hi = 0, p = P();
      activeCurves().forEach(function (c) {
        for (var i = 0; i <= 60; i++) { var x = xmin + (xmax - xmin) * i / 60, y = c.f(x, p);
          if (isFinite(y)) { if (y > hi) hi = y; if (y < lo) lo = y; } }
      });
      if (hi === lo) hi = lo + 1;
      var pad = (hi - lo) * 0.08;
      return [lo < 0 ? lo - pad : 0, hi + pad];
    }
    // sy depends on the y-range; recomputed each render into closure vars. When every
    // curve is >= 0, YMIN stays 0 and sy is identical to the old zero-based mapping.
    var YMIN = 0, YMAX = 1, BOT = PLOT.h - PLOT.b;
    // clamp to the plot band so a curve that leaves a FIXED y-range (see spec.yAxis)
    // never draws over the heading; auto-ranged widgets always fit, so it's a no-op there.
    function sy(y) { var v = PLOT.t + (YMAX - y) / (YMAX - YMIN) * (BOT - PLOT.t); return v < PLOT.t ? PLOT.t : (v > BOT ? BOT : v); }

    // --- skeleton DOM ---
    root.innerHTML = '';
    var bar = document.createElement('div'); bar.className = 'w-bar';
    if (spec.modes) spec.modes.forEach(function (m) {
      var b = document.createElement('button'); b.className = 'w-mode' + (m.key === mode ? ' on' : '');
      b.textContent = m.label; b.dataset.mode = m.key;
      b.onclick = function () { mode = m.key; syncControls(); render(); };
      bar.appendChild(b);
    });
    var svg = el('svg', { viewBox: '0 0 ' + PLOT.w + ' ' + PLOT.h, class: 'w-plot' });
    var legend = document.createElement('div'); legend.className = 'w-legend';
    var read = document.createElement('div'); read.className = 'w-read';
    var ctrls = document.createElement('div'); ctrls.className = 'w-ctrls';

    if (spec.modes) root.appendChild(bar);
    if (spec.layout === 'side') {   // plot+legend on the left, sliders on the right, readout across the bottom
      var main = document.createElement('div'); main.className = 'w-main';
      main.appendChild(svg); main.appendChild(legend);
      root.appendChild(main); root.appendChild(ctrls); root.appendChild(read);
    } else {
      root.appendChild(svg); root.appendChild(legend); root.appendChild(read); root.appendChild(ctrls);
    }

    // --- controls (cursor + sliders), rebuilt when mode changes visibility ---
    var sliderInputs = {};
    function syncControls() {
      ctrls.innerHTML = ''; sliderInputs = {};
      var rows = [];
      if (spec.cursor) rows.push({ key: '__cursor', label: spec.cursor.label, min: xmin, max: xmax,
        step: spec.cursor.step || (xmax - xmin) / 100, value: cursor });
      activeSliders().forEach(function (s) { rows.push(s); });
      rows.forEach(function (s) {
        var ss = String(s.step), di = ss.indexOf('.'), dec = di < 0 ? 0 : ss.length - di - 1;
        var show = function (v) { return String(parseFloat((+v).toFixed(dec))); }   // step-precision, trailing zeros trimmed
        var row = document.createElement('label'); row.className = 'w-row';
        var name = document.createElement('span'); name.className = 'w-lab'; name.innerHTML = s.label;
        var out = document.createElement('b'); out.className = 'w-val';
        var inp = document.createElement('input');
        inp.type = 'range'; inp.min = s.min; inp.max = s.max; inp.step = s.step;
        inp.value = (s.key === '__cursor') ? cursor : vals[s.key];
        out.textContent = show(+inp.value);
        inp.oninput = function () {
          var v = +inp.value; out.textContent = show(v);
          if (s.key === '__cursor') cursor = v; else vals[s.key] = v;
          render();
        };
        sliderInputs[s.key] = { inp: inp, out: out };
        row.appendChild(name); row.appendChild(inp); row.appendChild(out);
        ctrls.appendChild(row);
      });
    }
    syncControls();

    // --- overlay: live class guesses from a numeric poll (poll -> widget hand-off) ---
    var overlay = [];
    if (spec.poll && opts && opts.room && w.Poll && w.Poll.onValues) {
      w.Poll.onValues(opts.room, spec.poll, function (vals) { overlay = vals; render(); });
    }

    // --- render ---
    function render() {
      // Fixed y-domain when the spec declares one, else auto-fit. Fixing it keeps the
      // frame still as sliders move, so the motion the student sees is the curve
      // changing shape (e.g. pS tilting), not the axis rescaling under it.
      var p = P();
      if (spec.yAxis) { YMIN = spec.yAxis.min; YMAX = spec.yAxis.max; }
      else { var yr = yrange(); YMIN = yr[0]; YMAX = yr[1]; }
      var gmean = overlay.length ? overlay.reduce(function (a, b) { return a + b }, 0) / overlay.length : null;
      while (svg.firstChild) svg.removeChild(svg.firstChild);

      // axes
      svg.appendChild(el('line', { x1: PLOT.l, y1: sy(0), x2: PLOT.w - PLOT.r, y2: sy(0), class: 'w-axis' }));
      svg.appendChild(el('line', { x1: PLOT.l, y1: PLOT.t, x2: PLOT.l, y2: BOT, class: 'w-axis' }));
      var xlab = el('text', { x: (PLOT.l + PLOT.w - PLOT.r) / 2, y: PLOT.h - 8, class: 'w-axlab', 'text-anchor': 'middle' });
      xlab.textContent = spec.xAxis.label; svg.appendChild(xlab);

      // opt-in numeric tick labels (spec.xAxis.ticks / spec.yAxis.ticks = value arrays;
      // optional tickFmt(v) formats the label). Only drawn for widgets that declare them.
      (spec.xAxis.ticks || []).forEach(function (v) {
        var xx = sx(v);
        svg.appendChild(el('line', { x1: xx, y1: sy(0), x2: xx, y2: sy(0) + 5, class: 'w-axis' }));
        var t = el('text', { x: xx, y: sy(0) + 20, class: 'w-tick', 'text-anchor': 'middle' });
        t.textContent = spec.xAxis.tickFmt ? spec.xAxis.tickFmt(v) : fmt(v); svg.appendChild(t);
      });
      if (spec.yAxis && spec.yAxis.ticks) spec.yAxis.ticks.forEach(function (v) {
        var yy = sy(v);
        svg.appendChild(el('line', { x1: PLOT.l - 5, y1: yy, x2: PLOT.l, y2: yy, class: 'w-axis' }));
        var t = el('text', { x: PLOT.l - 8, y: yy + 4, class: 'w-tick', 'text-anchor': 'end' });
        t.textContent = spec.yAxis.tickFmt ? spec.yAxis.tickFmt(v) : fmt(v); svg.appendChild(t);
      });

      var curves = activeCurves();

      // optimum / choice markers (draw under curves)
      curves.forEach(function (c) {
        if (c.optimum) {
          var xs = argmin(function (x) { return c.f(x, p); }, xmin, xmax);
          svg.appendChild(el('line', { x1: sx(xs), y1: PLOT.t, x2: sx(xs), y2: BOT, class: 'w-opt' }));
          var tl = el('text', { x: sx(xs), y: PLOT.t + 4, class: 'w-optlab', 'text-anchor': 'middle' });
          tl.textContent = 'x* = ' + fmt(xs); svg.appendChild(tl);
        }
      });
      // legal standard line (any slider flagged as a threshold via key 'xstd')
      if (activeSliders().some(function (s) { return s.key === 'xstd'; })) {
        svg.appendChild(el('line', { x1: sx(vals.xstd), y1: PLOT.t, x2: sx(vals.xstd), y2: BOT, class: 'w-std' }));
        var sl = el('text', { x: sx(vals.xstd), y: sy(0) + 15, class: 'w-stdlab', 'text-anchor': 'middle' });
        sl.textContent = 'x̃ = ' + fmt(vals.xstd); svg.appendChild(sl);
      }

      // curves
      curves.forEach(function (c) {
        var d = '', N = 240, moved = false;
        for (var i = 0; i <= N; i++) {
          var x = xmin + (xmax - xmin) * i / N, y = c.f(x, p);
          // break the path where the curve leaves the (fixed) y-range instead of
          // clamping it to a flat line along the edge. No-op for auto-fit widgets,
          // whose range always contains their curves.
          if (!isFinite(y) || y > YMAX + 1e-9 || y < YMIN - 1e-9) { moved = false; continue; }
          d += (moved ? 'L' : 'M') + sx(x).toFixed(1) + ' ' + sy(y).toFixed(1) + ' '; moved = true;
        }
        svg.appendChild(el('path', { d: d, fill: 'none', style: 'stroke:' + (COLORS[c.color] || COLORS.accent),
          'stroke-width': c.width || 2.5, 'stroke-dasharray': c.dash ? '7 6' : null, 'stroke-linejoin': 'round' }));
      });

      // agent's chosen x (argmin of a 'choose' curve) — a highlighted dot
      curves.forEach(function (c) {
        if (c.choose) {
          var xc = argmin(function (x) { return c.f(x, p); }, xmin, xmax);
          svg.appendChild(el('circle', { cx: sx(xc), cy: sy(c.f(xc, p)), r: 8, class: 'w-choose' }));
        }
      });

      // crossing marker: where two named curves intersect (e.g. Becker deterrence S* : pS = B)
      if (spec.crossing) {
        var ca = curves.filter(function (c) { return c.key === spec.crossing.of[0]; })[0];
        var cb = curves.filter(function (c) { return c.key === spec.crossing.of[1]; })[0];
        if (ca && cb) {
          var diff = function (x) { return ca.f(x, p) - cb.f(x, p) }, prev = diff(xmin), xc = null;
          for (var ci = 1; ci <= 400; ci++) {
            var xx = xmin + (xmax - xmin) * ci / 400, cur = diff(xx);
            if (prev === 0 || (prev < 0) !== (cur < 0)) { xc = xx; break }
            prev = cur;
          }
          if (xc != null) {
            svg.appendChild(el('line', { x1: sx(xc), y1: PLOT.t, x2: sx(xc), y2: BOT, class: 'w-opt' }));
            var xt = el('text', { x: sx(xc), y: PLOT.t + 4, class: 'w-optlab', 'text-anchor': 'middle' });
            xt.textContent = (spec.crossing.label || 'x') + ' = ' + fmt(xc); svg.appendChild(xt);
          }
        }
      }

      // live class guesses (from the paired numeric poll) as a short band on the x-axis
      if (overlay.length) {
        var NB = 30, gb = new Array(NB).fill(0);
        overlay.forEach(function (v) { var i = Math.floor((v - xmin) / (xmax - xmin) * NB); if (i === NB) i = NB - 1; if (i >= 0 && i < NB) gb[i]++; });
        var gmax = Math.max(1, ...gb), band = 46, gbw = (PLOT.w - PLOT.l - PLOT.r) / NB;
        for (var gi = 0; gi < NB; gi++) {
          if (!gb[gi]) continue;
          var gh = gb[gi] / gmax * band, gx = PLOT.l + gi * gbw;
          svg.appendChild(el('rect', { x: (gx + 0.5).toFixed(1), y: (sy(0) - gh).toFixed(1),
            width: (gbw - 1).toFixed(1), height: gh.toFixed(1), class: 'w-guess' }));
        }
        svg.appendChild(el('line', { x1: sx(gmean), y1: sy(0) - band - 6, x2: sx(gmean), y2: sy(0), class: 'w-guessmean' }));
        var gl = el('text', { x: sx(gmean), y: sy(0) - band - 11, class: 'w-guesslab', 'text-anchor': 'middle' });
        gl.textContent = 'class: ' + fmt(gmean) + ' (n=' + overlay.length + ')'; svg.appendChild(gl);
      }

      // cursor line + dots + readout
      svg.appendChild(el('line', { x1: sx(cursor), y1: PLOT.t, x2: sx(cursor), y2: BOT, class: 'w-cursor' }));
      var items = [];
      curves.forEach(function (c) {
        var y = c.f(cursor, p);
        if (isFinite(y)) svg.appendChild(el('circle', { cx: sx(cursor), cy: sy(y), r: 5,
          style: 'fill:' + (COLORS[c.color] || COLORS.accent) }));
        items.push('<span class="w-chip" style="border-color:' + (COLORS[c.color] || COLORS.accent) + '">' +
          c.label + ' = <b>' + fmt(y) + '</b></span>');
      });

      // legend + readout panel
      legend.innerHTML = curves.map(function (c) {
        return '<span class="w-key"><i style="background:' + (COLORS[c.color] || COLORS.accent) +
          (c.dash ? ';height:0;border-top:3px dashed ' + (COLORS[c.color] || COLORS.accent) : '') + '"></i>' + c.label + '</span>';
      }).join('');

      var headline = '';
      var opt = curves.filter(function (c) { return c.optimum; })[0];
      var chz = curves.filter(function (c) { return c.choose; })[0];
      if (spec.verdict) {                                  // model-supplied outcome at the cursor
        var v = spec.verdict(cursor, p) || {};
        headline = '<span class="' + (v.ok ? 'w-ok' : 'w-bad') + '">' + (v.text || '') + '</span>';
      } else if (chz) {
        var xc = argmin(function (x) { return chz.f(x, p); }, xmin, xmax);
        var complies = Math.abs(xc - vals.xstd) < (xmax - xmin) * 0.02;
        headline = 'Injurer chooses <b>x = ' + fmt(xc) + '</b> — ' +
          (complies ? '<span class="w-ok">meets the standard, no liability</span>'
                    : '<span class="w-bad">below the standard: negligent, pays harm</span>');
      } else if (opt) {
        var xs = argmin(function (x) { return opt.f(x, p); }, xmin, xmax);
        headline = 'Socially optimal precaution <b>x* = ' + fmt(xs) + '</b>';
      }
      var classline = overlay.length
        ? '<div class="w-class">Class predicted <b>' + fmt(gmean) + '</b> on average (n=' + overlay.length +
          ') — vs the answer above.</div>' : '';
      read.innerHTML = (headline ? '<div class="w-head">' + headline + '</div>' : '') + classline +
        '<div class="w-at">At x = <b>' + fmt(cursor) + '</b>: ' + items.join(' ') + '</div>';
    }

    // drag the cursor directly on the plot
    function xFromEvent(ev) {
      var r = svg.getBoundingClientRect();
      var px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
      var ux = px / r.width * PLOT.w;                          // client px -> user units
      var x = xmin + (ux - PLOT.l) / (PLOT.w - PLOT.l - PLOT.r) * (xmax - xmin);
      return Math.max(xmin, Math.min(xmax, x));
    }
    function drag(ev) {
      ev.preventDefault(); cursor = xFromEvent(ev);
      var ci = sliderInputs.__cursor; if (ci) { ci.inp.value = cursor; ci.out.textContent = fmt(cursor); }
      render();
    }
    svg.addEventListener('mousedown', function (ev) {
      drag(ev);
      function up() { window.removeEventListener('mousemove', drag); window.removeEventListener('mouseup', up); }
      window.addEventListener('mousemove', drag); window.addEventListener('mouseup', up);
    });
    svg.addEventListener('touchstart', drag, { passive: false });
    svg.addEventListener('touchmove', drag, { passive: false });

    render();
    return { render: render };
  }

  w.Widget = { mount: mount };
})(window);
