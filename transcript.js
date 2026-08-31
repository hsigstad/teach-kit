/* In-deck lecture transcript (classic script, mirrors poll.js conventions).
   Reveal.js overlay: a bottom-left toggle + a scrollable side panel that shows the
   current slide's lecture transcript. The data is a per-deck JSON array — one
   {title, html|null} entry per <section>, in order — built at site-assemble time
   (studentsite.build_deck_transcripts) and fetched by base name next to the deck.
   Lookup is by section index (Reveal.getIndices().h), so no runtime title matching.
   Coexists with Poll (both use Reveal.addKeyBinding / Reveal.on); no-op with no
   Reveal, and silent when the deck has no transcript JSON (decks without coverage
   get no button and no errors). */
(function (w) {
  function deckBase() {
    var f = (w.location.pathname.split('/').pop() || '');
    return f.replace(/\.html?$/i, '') || 'index';
  }

  function mount(R, data) {
    var t = {
      show: (w.TRANSCRIPT_LABEL || 'Vis transkript'),
      hide: (w.TRANSCRIPT_LABEL_HIDE || 'Skjul transkript'),
      empty: (w.TRANSCRIPT_EMPTY || '(Dette lysbildet har ingen egen tale.)'),
      close: (w.TRANSCRIPT_CLOSE || 'Lukk')
    };
    var open = false;

    var panel = w.document.createElement('div');
    panel.className = 'transcript-panel';
    panel.setAttribute('aria-hidden', 'true');
    panel.innerHTML =
      '<div class="tx-head"><span class="tx-title"></span>' +
      '<button class="tx-close" type="button" aria-label="' + t.close + '">✕</button></div>' +
      '<div class="tx-body"></div>';
    w.document.body.appendChild(panel);

    var btn = w.document.createElement('button');
    btn.className = 'transcript-toggle';
    btn.type = 'button';
    btn.textContent = t.show;
    w.document.body.appendChild(btn);

    // Reserve a slim strip at the deck's bottom edge (shrinks the reveal area, which
    // re-centres and re-scales its slides above the strip). The toggle lives in that
    // strip, so it is structurally impossible for it to overshadow slide text — on any
    // screen and whether or not the current slide has coverage.
    var deckEl = w.document.querySelector('.reveal');
    if (deckEl) deckEl.classList.add('tx-has-toggle');
    if (R.layout) { try { R.layout(); } catch (e) {} }

    var bodyEl = panel.querySelector('.tx-body');

    function fill() {
      var h = 0;
      try { h = R.getIndices().h || 0; } catch (e) { h = 0; }
      var entry = data[h] || null;
      if (entry && entry.html) {
        bodyEl.innerHTML = entry.html;
        bodyEl.classList.remove('tx-empty');
      } else {
        bodyEl.textContent = t.empty;
        bodyEl.classList.add('tx-empty');
      }
      bodyEl.scrollTop = 0;
    }
    // Per-slide: the button only exists where there is actually a transcript. During a
    // live lecture the slides not yet covered have no entry, so no button appears there
    // (and it auto-closes if you page onto a bare slide with the panel open).
    function syncToggle() {
      var h = 0;
      try { h = R.getIndices().h || 0; } catch (e) { h = 0; }
      var entry = data[h] || null;
      var has = !!(entry && entry.html);
      btn.style.display = has ? '' : 'none';
      if (!has && open) setOpen(false);
      else if (open) fill();
    }
    function setOpen(v) {
      open = v;                                   // module-level flag: persists across slides
      panel.classList.toggle('open', open);
      panel.setAttribute('aria-hidden', open ? 'false' : 'true');
      btn.classList.toggle('on', open);
      btn.textContent = open ? t.hide : t.show;
      if (open) fill();
    }
    // On iOS the click on this fixed button doesn't fire on the first tap (you had
    // to tap twice). Drive it from touchend instead — with preventDefault to cancel
    // the ghost click — and keep click for mouse/keyboard, de-duped so a real touch
    // doesn't toggle twice.
    function onTap(el, fn) {
      var t = 0;
      el.addEventListener('touchend', function (e) {
        e.preventDefault(); t = Date.now(); fn();
      }, { passive: false });
      el.addEventListener('click', function () {
        if (Date.now() - t < 700) return; fn();
      });
    }
    onTap(btn, function () { setOpen(!open); });
    onTap(panel.querySelector('.tx-close'), function () { setOpen(false); });

    // Panel is a body-level fixed element and Reveal binds its keys on document,
    // so navigation still works while it is open; refresh content on each move.
    if (R.on) {
      R.on('slidechanged', syncToggle);
      R.on('ready', syncToggle);
    }
    if (R.addKeyBinding) {
      R.addKeyBinding({ keyCode: 84, key: 'T', description: 'Vis/skjul transkript' },
        function () { setOpen(!open); });
    }
    syncToggle();                                 // set initial visibility + preload text
  }

  // Instructor run book (kjoreplan.html) reads these to offer a "fortsett" link per
  // deck: remember the last slide viewed, keyed by this deck's own path so it is
  // per-course, per-deck, per-browser (localStorage). Purely local; students never see it.
  function trackResume(R) {
    if (!w.localStorage) return;
    var key = 'revealResume:' + w.location.pathname;
    var save = function () {
      try { w.localStorage.setItem(key, w.location.hash || ('#/' + R.getIndices().h)); } catch (e) {}
    };
    if (R.on) { R.on('slidechanged', save); R.on('ready', save); }
  }

  function deck(opts) {
    var R = w.Reveal;
    if (!R) return;                               // guard: no reveal → nothing to do
    trackResume(R);                               // remember last slide for the run book
    var url = deckBase() + '.transcript.json';
    if (!w.fetch) return;
    w.fetch(url).then(function (r) {
      if (!r.ok) throw new Error('no transcript');
      return r.json();
    }).then(function (data) {
      if (Array.isArray(data) && data.length) mount(R, data);
    }).catch(function () { /* deck has no transcript coverage: stay silent */ });
  }

  w.Transcript = { deck: deck };
})(window);
