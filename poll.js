/* Live-poll widget (classic script, uses globals: supabase, qrcode, POLLS, SB_URL, SB_KEY).
   Presenter view mounts in a reveal slide; student view mounts in vote.html.
   Transport: Supabase Realtime Broadcast — ephemeral, no table, nothing stored.
   Each device sends {clientId, choices:[...]}; presenter tallies clientId -> choices,
   so single-select replaces, multi-select toggles, and re-votes update in place. */
(function (w) {
  function client() { return supabase.createClient(w.SB_URL, w.SB_KEY) }
  function channel(sb, room, pollId) { return sb.channel('poll-' + room + '-' + pollId, { config: { broadcast: { self: true } } }) }
  function randId() {
    return 'x' + Math.abs((Date.now() ^ (performance.now() * 1e6)) | 0).toString(36) +
      (w.crypto && crypto.getRandomValues ? crypto.getRandomValues(new Uint32Array(1))[0].toString(36) : '')
  }
  function qrDataUrl(text) {
    var qr = qrcode(0, 'M'); qr.addData(text); qr.make(); return qr.createDataURL(6, 8)
  }

  // ---- Shared numeric-vote feed: the single source of truth for a numeric poll's
  // values, so a widget on a later slide can overlay the class's guesses live even
  // though it never opened its own channel. numericPresenter writes here; a widget
  // reads via Poll.onValues(room, pollId, cb). ----
  var FEEDS = {}
  function feed(room, pollId) {
    var k = room + ':' + pollId
    return FEEDS[k] || (FEEDS[k] = { values: new Map(), listeners: [] })
  }
  function feedNotify(f) {
    var arr = Array.from(f.values.values())
    f.listeners.forEach(function (cb) { cb(arr) })
  }
  function onValues(room, pollId, cb) {
    var f = feed(room, pollId)
    f.listeners.push(cb)
    cb(Array.from(f.values.values()))                 // deliver current state immediately
    return function () { var i = f.listeners.indexOf(cb); if (i >= 0) f.listeners.splice(i, 1) }
  }

  // ---- Presenter: QR + live bars ----
  function presenter(el, poll, pollId, room, voteUrl) {
    if (poll.type === 'numeric') return numericPresenter(el, poll, pollId, room, voteUrl)
    if (poll.type === 'text') return textPresenter(el, poll, pollId, room, voteUrl)
    if (poll.type === 'choicetext') return choicetextPresenter(el, poll, pollId, room, voteUrl)
    el.classList.add('poll')
    var t = txt(), tag = poll.type === 'quiz' ? t.tagQuiz : (poll.multi ? t.tagMulti : t.tagPoll)
    el.innerHTML =
      '<div class="qwrap">' +
        '<div class="tag">' + tag + '</div>' +
        '<h2>' + poll.question + '</h2>' +
        (poll.desc ? '<p class="poll-desc">' + poll.desc + '</p>' : '') +
        '<div class="bars"></div>' +
        '<div class="foot"><span>' + t.responses + ' <b class="total">0</b></span>' +
          '<button class="reveal-results">' + t.resultsShow + '</button>' +
          (poll.type === 'quiz' ? '<button class="reveal-ans">' + t.revealAnswer + '</button>' : '') +
        '</div>' +
      '</div>' +
      '<div class="join"><img alt="Scan to vote"><div class="code">' + room + '</div>' +
        '<div class="hint">' + t.scanVote + '</div></div>'
    el.querySelector('.join img').src = qrDataUrl(voteUrl)

    // hidden by default: the class votes without seeing the distribution, so peers
    // can't be swayed. Presenter reveals with the button or the R key (Poll.deck).
    var votes = new Map(), revealed = false, shown = false   // clientId -> array of chosen keys
    var barsEl = el.querySelector('.bars'), totalEl = el.querySelector('.total')
    function render() {
      var counts = {}; poll.options.forEach(function (o) { counts[o.key] = 0 })
      votes.forEach(function (arr) { arr.forEach(function (c) { if (c in counts) counts[c]++ }) })
      var total = votes.size, max = Math.max(1, ...Object.values(counts))
      totalEl.textContent = total
      barsEl.innerHTML = ''
      poll.options.forEach(function (o) {
        var n = counts[o.key], pct = total ? Math.round(100 * n / total) : 0
        var d = document.createElement('div')
        d.className = 'bar' + (revealed && poll.correct === o.key ? ' correct' : '') + (shown ? '' : ' masked')
        d.innerHTML = '<div class="top"><span class="lab"><span class="k">' + o.key + '</span><span>' +
          o.text + (revealed && poll.correct === o.key ? '  ✓' : '') + '</span></span>' +
          '<span class="n">' + n + ' · ' + pct + '%</span></div>' +
          '<div class="track"><div class="fill" style="width:' + (shown ? (n / max * 100) : 0) + '%"></div></div>'
        barsEl.appendChild(d)
      })
    }
    render()
    var rbtn = el.querySelector('.reveal-results')
    function toggle() { shown = !shown; rbtn.textContent = shown ? t.resultsHide : t.resultsShow; render() }
    rbtn.onclick = toggle
    el._toggleResults = toggle                          // Poll.deck binds the R key to this
    var btn = el.querySelector('.reveal-ans')
    if (btn) btn.onclick = function () { revealed = !revealed; render() }

    var ch = channel(client(), room, pollId)
    ch.on('broadcast', { event: 'vote' }, function (m) {
      var p = m.payload
      if (p && p.clientId) {
        var arr = p.choices || (p.choice ? [p.choice] : [])
        votes.set(p.clientId, arr); render()
      }
    })
    ch.subscribe()
    return { reset: function () { votes.clear(); render() }, toggleResults: toggle }
  }

  // ---- Numeric (slider) poll: student drags a value, presenter shows a live histogram ----
  // Payload {clientId, value:Number}; presenter bins values into a histogram and can
  // reveal a marker at poll.correct. This is the "Predict" step for a widget slide —
  // students commit a number before the tool that computes it appears.
  function numericPresenter(el, poll, pollId, room, voteUrl) {
    el.classList.add('poll', 'poll-num')
    var t = txt()
    el.innerHTML =
      '<div class="qwrap">' +
        '<div class="tag">' + t.tagNumeric + '</div>' +
        '<h2>' + poll.question + '</h2>' +
        '<div class="hist"></div>' +
        '<div class="foot"><span>' + t.responses + ' <b class="total">0</b></span>' +
          '<span>' + t.mean + ' <b class="mean">–</b></span>' +
          '<button class="reveal-results">' + t.resultsShow + '</button>' +
          (poll.correct != null ? '<button class="reveal-ans">' + t.revealAnswer + '</button>' : '') +
        '</div>' +
      '</div>' +
      '<div class="join"><img alt="Scan to vote"><div class="code">' + room + '</div>' +
        '<div class="hint">' + t.scanDrag + '</div></div>'
    el.querySelector('.join img').src = qrDataUrl(voteUrl)

    // hidden by default (see presenter()): histogram + mean stay masked until reveal.
    var f = feed(room, pollId), votes = f.values, revealed = false, shown = false   // shared store: clientId -> number
    var histEl = el.querySelector('.hist'), totalEl = el.querySelector('.total'), meanEl = el.querySelector('.mean')
    var min = poll.min, max = poll.max, N = poll.bins || 24, unit = poll.unit || ''
    function render() {
      var vals = Array.from(votes.values()), total = vals.length
      totalEl.textContent = total
      meanEl.textContent = !shown ? '–' : (total ? (vals.reduce(function (a, b) { return a + b }, 0) / total).toFixed(1) + unit : '–')
      var bins = new Array(N).fill(0)
      vals.forEach(function (v) { var i = Math.floor((v - min) / (max - min) * N); if (i === N) i = N - 1; if (i >= 0 && i < N) bins[i]++ })
      var maxc = Math.max(1, ...bins)
      var W = 760, H = 300, l = 40, r = 14, t = 16, b = 40, bw = (W - l - r) / N
      function sx(x) { return l + (x - min) / (max - min) * (W - l - r) }
      function sy(c) { return t + (1 - c / maxc) * (H - t - b) }
      var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="histsvg">'
      s += '<line x1="' + l + '" y1="' + sy(0) + '" x2="' + (W - r) + '" y2="' + sy(0) + '" class="h-axis"/>'
      if (shown) for (var i = 0; i < N; i++) {
        if (!bins[i]) continue
        var x = l + i * bw, y = sy(bins[i])
        s += '<rect x="' + (x + 1).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + (bw - 2).toFixed(1) + '" height="' + (sy(0) - y).toFixed(1) + '" class="h-bar"/>'
      }
      ;[min, (min + max) / 2, max].forEach(function (tk) {
        s += '<text x="' + sx(tk).toFixed(1) + '" y="' + (H - 14) + '" class="h-tick" text-anchor="middle">' + tk + '</text>'
      })
      if (shown && revealed && poll.correct != null) {
        s += '<line x1="' + sx(poll.correct).toFixed(1) + '" y1="' + t + '" x2="' + sx(poll.correct).toFixed(1) + '" y2="' + sy(0) + '" class="h-correct"/>'
        s += '<text x="' + sx(poll.correct).toFixed(1) + '" y="' + (t + 13) + '" class="h-correctlab" text-anchor="middle">' + (poll.answerLabel || ('answer ' + poll.correct)) + '</text>'
      }
      histEl.innerHTML = s + '</svg>'
    }
    render()
    var rbtn = el.querySelector('.reveal-results')
    function toggle() { shown = !shown; rbtn.textContent = shown ? t.resultsHide : t.resultsShow; render() }
    rbtn.onclick = toggle
    el._toggleResults = toggle
    var btn = el.querySelector('.reveal-ans')
    if (btn) btn.onclick = function () { revealed = !revealed; render() }
    var ch = channel(client(), room, pollId)
    ch.on('broadcast', { event: 'vote' }, function (m) {
      var p = m.payload
      if (p && p.clientId && typeof p.value === 'number') { votes.set(p.clientId, p.value); render(); feedNotify(f) }
    })
    ch.subscribe()
    return { reset: function () { votes.clear(); revealed = false; render(); feedNotify(f) }, toggleResults: toggle }
  }

  function numericStudent(el, poll, pollId, room) {
    var cid = sessionStorage.getItem('poll_cid_' + room + '_' + pollId)
    if (!cid) { cid = randId(); sessionStorage.setItem('poll_cid_' + room + '_' + pollId, cid) }
    var S = txt(), unit = poll.unit || '', mid = (poll.min + poll.max) / 2
    el.innerHTML = '<div class="status" id="st">' + S.connecting + '</div><h1 id="q"></h1>' +
      '<div class="numwrap">' +
        '<div class="numentry"><input type="number" id="nv" class="numval" min="' + poll.min + '" max="' + poll.max +
          '" step="' + (poll.step || 1) + '" placeholder="—">' + (unit ? '<span class="numunit">' + unit + '</span>' : '') + '</div>' +
        '<input type="range" id="rng" min="' + poll.min + '" max="' + poll.max + '" step="' + (poll.step || 1) + '" value="' + mid + '">' +
        '<div class="numscale"><span>' + poll.min + '</span><span>' + poll.max + '</span></div>' +
      '</div>' +
      '<div class="done" id="done">' + S.numHint + '</div>'
    el.querySelector('#q').textContent = poll.question
    var rng = el.querySelector('#rng'), nv = el.querySelector('#nv'), done = el.querySelector('#done')
    var ready = false, touched = false, last = 0, timer = null
    var sb = client(), ch = channel(sb, room, pollId)
    function clamp(v) { return Math.max(poll.min, Math.min(poll.max, v)) }
    function send(v) {
      ch.send({ type: 'broadcast', event: 'vote', payload: { clientId: cid, value: v } })
      done.innerHTML = S.numAnswer(v + unit)
    }
    function sendThrottled(v) {
      if (!ready) return
      var now = Date.now()
      if (now - last > 120) { last = now; send(v) }
      else { clearTimeout(timer); timer = setTimeout(function () { last = Date.now(); send(v) }, 130) }
    }
    // drag the slider → mirror into the number box and send live
    rng.addEventListener('input', function () { touched = true; nv.value = rng.value; sendThrottled(+rng.value) })
    rng.addEventListener('change', function () { if (ready) send(+rng.value) })
    // type a number → move the slider live; send when committed (blur / Enter)
    nv.addEventListener('input', function () { touched = true; if (nv.value !== '') rng.value = clamp(+nv.value) })
    nv.addEventListener('change', function () {
      if (nv.value === '') return
      var v = clamp(+nv.value); nv.value = v; rng.value = v; if (ready) send(v)
    })
    ch.subscribe(function (s) {
      var st = el.querySelector('#st')
      if (s === 'SUBSCRIBED') { ready = true; st.innerHTML = S.connected(room); if (touched) send(clamp(+rng.value)) }
      else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') { st.textContent = S.connProblem }
      else st.textContent = s.toLowerCase().replace('_', ' ') + '…'
    })
    return { destroy: function () { try { sb.removeChannel(ch) } catch (e) {} } }
  }

  // English defaults for the free-text poll's fixed UI strings. A course overrides
  // any of these via window.POLL_I18N.text (set in its own polls.js) — e.g. Norwegian
  // for ELE3786 — while MST0035 keeps English by defining nothing.
  var TEXT_STR = {
    tag: 'Live poll · free text', responses: 'Responses:',
    show: 'Show responses', hide: 'Hide responses', scan: 'scan to join &amp; answer',
    waiting: 'Waiting for responses…', none: 'No responses yet',
    hidden: function (n) { return n + ' response' + (n === 1 ? '' : 's') + ' — hidden (press R to reveal)' },
    placeholder: 'Type your answer…', send: 'Send answer',
    hint: 'Type your answer and press Send. You can change it any time.',
    sent: 'Your answer was sent — you can edit and resend.', cleared: 'Your answer was removed.',
    numHint: 'Type a number or drag the slider. You can change it any time.',
    numAnswer: function (v) { return 'Your answer: <b>' + v + '</b> — recorded.' },
    connected: function (room) { return 'Room <b>' + room + '</b> · connected' },
    // choice / quiz / numeric poll chrome
    tagQuiz: 'Quiz', tagPoll: 'Live poll', tagMulti: 'Live poll · select all that apply',
    tagNumeric: 'Live poll · drag to answer',
    resultsShow: 'Show results', resultsHide: 'Hide results', revealAnswer: 'Reveal answer',
    scanVote: 'scan to join &amp; vote', scanDrag: 'scan to join &amp; drag', mean: 'Mean:',
    tapOne: 'Tap an option. You can change it any time.',
    tapMulti: 'Tap all that apply. You can change your selection any time.',
    choiceAnswer: function (a) { return 'Your answer: <b>' + a + '</b> — recorded.' },
    tapAddRemove: ' Tap to add or remove.', connProblem: 'connection problem — reload',
    connecting: 'connecting…', waitingPresenter: 'Waiting for the presenter to start a poll…',
    noPoll: 'No active poll right now — hang tight.',
    // room-code entry (vote page opened without a room, e.g. via the site link)
    joinTitle: 'Join the poll', joinCode: 'Room code', joinBtn: 'Join',
    joinHint: 'Enter the room code shown on the screen.'
  }
  function txt() { return Object.assign({}, TEXT_STR, (w.POLL_I18N && w.POLL_I18N.text) || {}) }

  // ---- Free-text poll: student types a short answer, presenter shows the answers ----
  // Payload {clientId, text}; presenter keeps clientId -> text so a re-submit replaces
  // in place and an empty submit removes. Answers stay masked (count only) until the
  // presenter reveals with the button or the R key — same Predict → Reveal pattern.
  function textPresenter(el, poll, pollId, room, voteUrl) {
    var t = txt()
    el.classList.add('poll', 'poll-text')
    el.innerHTML =
      '<div class="qwrap">' +
        '<div class="tag">' + t.tag + '</div>' +
        '<h2>' + poll.question + '</h2>' +
        (poll.desc ? '<p class="poll-desc">' + poll.desc + '</p>' : '') +
        '<div class="answers"></div>' +
        '<div class="foot"><span>' + t.responses + ' <b class="total">0</b></span>' +
          '<button class="reveal-results">' + t.show + '</button></div>' +
      '</div>' +
      '<div class="join"><img alt="Scan to answer"><div class="code">' + room + '</div>' +
        '<div class="hint">' + t.scan + '</div></div>'
    el.querySelector('.join img').src = qrDataUrl(voteUrl)
    var answers = new Map(), shown = false   // clientId -> text
    var ansEl = el.querySelector('.answers'), totalEl = el.querySelector('.total')
    function render() {
      totalEl.textContent = answers.size
      ansEl.style.maxHeight = ''; ansEl.style.overflowY = ''   // reset scroll floor
      el.style.setProperty('--txtf', '1')                      // reset chip shrink
      if (!shown) {
        ansEl.innerHTML = '<div class="answers-masked">' + (answers.size ? t.hidden(answers.size) : t.waiting) + '</div>'
        return
      }
      ansEl.innerHTML = ''
      if (!answers.size) { ansEl.innerHTML = '<div class="answers-masked">' + t.none + '</div>'; return }
      answers.forEach(function (ans) {
        var d = document.createElement('div'); d.className = 'answer'; d.textContent = ans; ansEl.appendChild(d)
      })
      fitAnswers()
    }
    // Keep every submitted answer on the slide: shrink the shared chip font (and
    // gap/padding, via --txtf in CSS) until the whole slide fits within the 720px
    // canvas. If even the floor overflows (very many or very long answers), cap the
    // answer area so it scrolls instead of pushing the footer/QR off-screen. No-op
    // while the slide is offscreen (clientHeight 0), so it runs only when showing.
    function fitAnswers() {
      var sec = el.closest('section')
      if (!sec || !ansEl.clientHeight) return
      var s
      for (s = 1; s >= 0.55; s -= 0.05) {
        el.style.setProperty('--txtf', s.toFixed(2))
        if (sec.scrollHeight <= 720) return
      }
      var others = sec.scrollHeight - ansEl.offsetHeight   // slide height minus the chips
      ansEl.style.maxHeight = Math.max(140, 700 - others) + 'px'
      ansEl.style.overflowY = 'auto'
    }
    render()
    var rbtn = el.querySelector('.reveal-results')
    function toggle() { shown = !shown; rbtn.textContent = shown ? t.hide : t.show; render() }
    rbtn.onclick = toggle
    el._toggleResults = toggle                          // Poll.deck binds the R key to this
    var ch = channel(client(), room, pollId)
    ch.on('broadcast', { event: 'vote' }, function (m) {
      var p = m.payload
      if (p && p.clientId && typeof p.text === 'string') {
        var t = p.text.trim()
        if (t) answers.set(p.clientId, t); else answers.delete(p.clientId)
        render()
      }
    })
    ch.subscribe()
    return { reset: function () { answers.clear(); render() }, toggleResults: toggle }
  }

  function textStudent(el, poll, pollId, room) {
    var cid = sessionStorage.getItem('poll_cid_' + room + '_' + pollId)
    if (!cid) { cid = randId(); sessionStorage.setItem('poll_cid_' + room + '_' + pollId, cid) }
    var S = txt()
    el.innerHTML = '<div class="status" id="st">' + S.connecting + '</div><h1 id="q"></h1>' +
      (poll.desc ? '<p class="poll-desc" id="qd"></p>' : '') +
      '<div class="textwrap"><textarea id="ta" rows="4" maxlength="' + (poll.maxlen || 240) + '" placeholder="' +
        (poll.placeholder || S.placeholder) + '"></textarea>' +
      '<button class="opt send" id="send">' + S.send + '</button></div>' +
      '<div class="done" id="done">' + S.hint + '</div>'
    el.querySelector('#q').textContent = poll.question
    var qd = el.querySelector('#qd'); if (qd) qd.textContent = poll.desc
    var ta = el.querySelector('#ta'), send = el.querySelector('#send'), done = el.querySelector('#done')
    var ready = false, sb = client(), ch = channel(sb, room, pollId)
    function submit() {
      if (!ready) return
      var t = ta.value.trim()
      ch.send({ type: 'broadcast', event: 'vote', payload: { clientId: cid, text: t } })
      done.innerHTML = t ? S.sent : S.cleared
    }
    send.onclick = submit
    ch.subscribe(function (s) {
      var st = el.querySelector('#st')
      if (s === 'SUBSCRIBED') { ready = true; st.innerHTML = S.connected(room) }
      else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') { st.textContent = S.connProblem }
      else st.textContent = s.toLowerCase().replace('_', ' ') + '…'
    })
    return { destroy: function () { try { sb.removeChannel(ch) } catch (e) {} } }
  }

  // ---- choicetext: pick an option AND explain in free text. Presenter groups
  //      the explanations into one colored column per option (text cards hidden
  //      until revealed with the R key).
  //      Default: one response per person (re-submit replaces), vote count per
  //      option shown in the header — a tally-able pick-and-explain poll.
  //      With `multi:true`: an ARGUMENT BOARD — each Send appends a new argument,
  //      one person may add several to either/both sides, and no vote count is
  //      shown (we're collecting arguments, not tallying sides). ----
  var CT_PALETTE = ['good', 'bad', 'bar', 'accent3']
  function ctCols(poll) {
    return poll.options.map(function (o, i) {
      return { key: o.key, text: o.text, color: o.color || CT_PALETTE[i % CT_PALETTE.length] }
    })
  }

  function choicetextPresenter(el, poll, pollId, room, voteUrl) {
    var t = txt(), cols = ctCols(poll)
    el.classList.add('poll', 'poll-choicetext')
    // Full-width columns with a compact QR (caption to the LEFT of the code) tucked
    // in the top-right, so the colored columns use the whole slide — including the
    // area under the QR — instead of being boxed into the left half.
    el.innerHTML =
      '<div class="ct-top">' +
        '<div class="ct-intro">' +
          '<div class="tag">' + t.tagPoll + '</div>' +
          '<h2>' + poll.question + '</h2>' +
          (poll.desc ? '<p class="poll-desc">' + poll.desc + '</p>' : '') +
        '</div>' +
        '<div class="join"><div class="join-cap"><div class="hint">' + t.scanVote + '</div>' +
          '<div class="code">' + room + '</div></div><img alt="Scan to answer"></div>' +
      '</div>' +
      '<div class="ctcols" style="grid-template-columns:repeat(' + cols.length + ',1fr)">' +
        cols.map(function (c) {
          return '<div class="ctcol" style="--c:var(--' + c.color + ')">' +
            '<div class="cthead">' + c.text +
              (poll.multi ? '' : ' <b class="ctn" data-k="' + c.key + '">0</b>') + '</div>' +
            '<div class="ctlist" data-k="' + c.key + '"></div></div>'
        }).join('') +
      '</div>'
    // No footer: results toggle is the R key (bound by Poll.deck to _toggleResults),
    // and the presenter can just eyeball the count — one less thing on the slide.
    el.querySelector('.join img').src = qrDataUrl(voteUrl)
    var answers = new Map(), shown = false        // clientId -> {choice, text}
    function render() {
      var counts = {}, lists = {}
      cols.forEach(function (c) { counts[c.key] = 0; lists[c.key] = [] })
      answers.forEach(function (a) {
        if (counts[a.choice] == null) return
        counts[a.choice]++
        if (a.text) lists[a.choice].push(a.text)
      })
      cols.forEach(function (c) {
        var ctn = el.querySelector('.ctn[data-k="' + c.key + '"]'); if (ctn) ctn.textContent = counts[c.key]
        var box = el.querySelector('.ctlist[data-k="' + c.key + '"]'); box.innerHTML = ''
        if (!shown) {
          box.innerHTML = '<div class="answers-masked">' +
            (lists[c.key].length ? t.hidden(lists[c.key].length) : t.waiting) + '</div>'
          return
        }
        if (!lists[c.key].length) { box.innerHTML = '<div class="answers-masked">' + t.none + '</div>'; return }
        lists[c.key].forEach(function (tx) {
          var d = document.createElement('div'); d.className = 'answer'; d.textContent = tx; box.appendChild(d)
        })
      })
      if (shown) fitBoard()
    }
    // Keep the whole board on screen: pack each side into more sub-columns as it
    // fills, then shrink the shared font until nothing overflows (down to a floor;
    // past that the sides scroll — see CSS). No-op when the slide is offscreen
    // (clientHeight 0) so it only runs while the deck is showing this poll.
    function fitBoard() {
      var wrap = el.querySelector('.ctcols'), boxes = [].slice.call(el.querySelectorAll('.ctlist'))
      if (!boxes.length || !boxes[0].clientHeight) return
      boxes.forEach(function (b) {
        var n = b.querySelectorAll('.answer').length
        b.style.setProperty('--ctn', n > 14 ? 3 : (n > 6 ? 2 : 1))
      })
      var s
      for (s = 1; s > 0.44; s -= 0.05) {
        wrap.style.setProperty('--ctf', s.toFixed(2))
        var overflow = boxes.some(function (b) { return b.scrollHeight > b.clientHeight + 1 })
        if (!overflow) break
      }
    }
    render()
    function toggle() { shown = !shown; render() }
    el._toggleResults = toggle                    // Poll.deck binds R to this (no on-slide button)
    var ch = channel(client(), room, pollId)
    ch.on('broadcast', { event: 'vote' }, function (m) {
      var p = m.payload
      if (p && p.clientId && p.choice != null) {
        answers.set(p.clientId, { choice: p.choice, text: (typeof p.text === 'string' ? p.text.trim() : '') })
        render()
      }
    })
    ch.subscribe()
    return { reset: function () { answers.clear(); render() }, toggleResults: toggle }
  }

  function choicetextStudent(el, poll, pollId, room) {
    var cid = sessionStorage.getItem('poll_cid_' + room + '_' + pollId)
    if (!cid) { cid = randId(); sessionStorage.setItem('poll_cid_' + room + '_' + pollId, cid) }
    var S = txt(), pickHint = poll.pickHint || S.tapOne
    el.innerHTML = '<div class="status" id="st">' + S.connecting + '</div><h1 id="q"></h1>' +
      (poll.desc ? '<p class="poll-desc" id="qd"></p>' : '') +
      '<div class="opts" id="opts"></div>' +
      '<div class="textwrap"><textarea id="ta" rows="3" maxlength="' + (poll.maxlen || 180) + '" placeholder="' +
        (poll.placeholder || S.placeholder) + '"></textarea>' +
      '<button class="opt send" id="send">' + S.send + '</button></div>' +
      '<div class="done" id="done">' + pickHint + '</div>'
    el.querySelector('#q').textContent = poll.question
    var qd = el.querySelector('#qd'); if (qd) qd.textContent = poll.desc
    var box = el.querySelector('#opts'), ta = el.querySelector('#ta')
    var send = el.querySelector('#send'), done = el.querySelector('#done')
    var choice = null, ready = false, subN = 0, sb = client(), ch = channel(sb, room, pollId)
    poll.options.forEach(function (o) {
      var b = document.createElement('button'); b.className = 'opt'; b.setAttribute('aria-pressed', 'false')
      b.innerHTML = '<span class="k">' + o.key + '</span><span>' + o.text + '</span>'
      b.onclick = function () {
        choice = o.key
        box.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)) })
      }
      box.appendChild(b)
    })
    function submit() {
      if (!ready) return
      if (choice == null) { done.textContent = pickHint; return }
      var text = ta.value.trim()
      if (poll.multi && !text) { done.textContent = pickHint; return }   // board: no empty arguments
      // multi → a fresh id per submission so arguments accumulate (one person may
      // add several, to either side); single → stable id so a re-submit replaces.
      var id = poll.multi ? (cid + '-' + (++subN)) : cid
      ch.send({ type: 'broadcast', event: 'vote', payload: { clientId: id, choice: choice, text: text } })
      if (poll.multi) { ta.value = ''; done.innerHTML = poll.moreHint || S.sent }   // ready for another
      else done.innerHTML = S.sent
    }
    send.onclick = submit
    ch.subscribe(function (s) {
      var st = el.querySelector('#st')
      if (s === 'SUBSCRIBED') { ready = true; st.innerHTML = S.connected(room) }
      else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') { st.textContent = S.connProblem }
      else st.textContent = s.toLowerCase().replace('_', ' ') + '…'
    })
    return { destroy: function () { try { sb.removeChannel(ch) } catch (e) {} } }
  }

  // ---- Student: tappable options (single-select replaces, multi-select toggles) ----
  function student(el, poll, pollId, room) {
    if (poll.type === 'numeric') return numericStudent(el, poll, pollId, room)
    if (poll.type === 'text') return textStudent(el, poll, pollId, room)
    if (poll.type === 'choicetext') return choicetextStudent(el, poll, pollId, room)
    var cid = sessionStorage.getItem('poll_cid_' + room + '_' + pollId)
    if (!cid) { cid = randId(); sessionStorage.setItem('poll_cid_' + room + '_' + pollId, cid) }
    var S = txt()
    var hint = poll.multi ? S.tapMulti : S.tapOne
    el.innerHTML = '<div class="status" id="st">' + S.connecting + '</div><h1 id="q"></h1><div class="opts" id="opts"></div>' +
      '<div class="done" id="done">' + hint + '</div>'
    el.querySelector('#q').textContent = poll.question
    var selected = {}, ready = false
    var sb = client(), ch = channel(sb, room, pollId)
    function draw() {
      var box = el.querySelector('#opts'); box.innerHTML = ''
      poll.options.forEach(function (o) {
        var b = document.createElement('button'); b.className = 'opt'
        b.setAttribute('aria-pressed', String(!!selected[o.key]))
        b.innerHTML = '<span class="k">' + o.key + '</span><span>' + o.text + '</span>'
        b.onclick = function () { vote(o.key) }
        box.appendChild(b)
      })
    }
    function vote(key) {
      if (!ready) return
      if (poll.multi) { if (selected[key]) delete selected[key]; else selected[key] = 1 }
      else { selected = {}; selected[key] = 1 }
      draw()
      var choices = Object.keys(selected)
      ch.send({ type: 'broadcast', event: 'vote', payload: { clientId: cid, choices: choices } })
      var done = el.querySelector('#done')
      done.innerHTML = choices.length
        ? S.choiceAnswer(choices.join(', ')) + (poll.multi ? S.tapAddRemove : '')
        : hint
    }
    draw()
    ch.subscribe(function (s) {
      var st = el.querySelector('#st')
      if (s === 'SUBSCRIBED') { ready = true; st.innerHTML = S.connected(room) }
      else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') { st.textContent = S.connProblem }
      else st.textContent = s.toLowerCase().replace('_', ' ') + '…'
    })
    return { destroy: function () { try { sb.removeChannel(ch) } catch (e) {} } }
  }

  // ---- Presenter control channel: announces which poll is currently on screen,
  // so a phone that scanned once (follow mode) auto-switches to the live poll.
  // Sticky: setActive is called only on poll slides, so the last poll stays up
  // through interstitial slides. Late joiners send 'hello' and get the current
  // poll replayed. Channel name reuses the scheme with a reserved id. ----
  function control(room) {
    var ch = channel(client(), room, '__ctl__'), last = null
    ch.on('broadcast', { event: 'hello' }, function () {
      ch.send({ type: 'broadcast', event: 'active', payload: { pollId: last } })
    })
    ch.subscribe()
    return { setActive: function (pollId) { last = pollId; ch.send({ type: 'broadcast', event: 'active', payload: { pollId: pollId } }) } }
  }

  // ---- Student follow mode: one scan for the whole lecture. Subscribes to the
  // room control channel and renders whatever poll the presenter is showing,
  // tearing down the previous poll's channel on each switch. ----
  function follow(el, room) {
    var S = txt()
    el.innerHTML = '<div class="status" id="st">' + S.connecting + '</div>' +
      '<div id="stage"><div class="done">' + S.waitingPresenter + '</div></div>'
    var stage = el.querySelector('#stage'), st = el.querySelector('#st')
    var curId = null, inst = null
    function show(pollId) {
      if (pollId === curId) return
      if (inst && inst.destroy) inst.destroy()
      inst = null; curId = pollId; stage.innerHTML = ''
      if (!pollId || !w.POLLS || !w.POLLS[pollId]) {
        stage.innerHTML = '<div class="done">' + S.noPoll + '</div>'; return
      }
      var sub = document.createElement('div'); stage.appendChild(sub)
      inst = student(sub, w.POLLS[pollId], pollId, room)
    }
    var ch = channel(client(), room, '__ctl__')
    ch.on('broadcast', { event: 'active' }, function (m) { show((m.payload && m.payload.pollId) || null) })
    ch.subscribe(function (s) {
      if (s === 'SUBSCRIBED') {
        st.innerHTML = S.connected(room)
        ch.send({ type: 'broadcast', event: 'hello', payload: {} })   // ask presenter for the current poll
      } else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') { st.textContent = S.connProblem }
      else st.textContent = s.toLowerCase().replace('_', ' ') + '…'
    })
  }

  // ---- Room-code entry: shown by the vote page when it is opened without a room
  // (e.g. a student clicks the "join poll" link on the course site and types the
  // code from the screen). Calls onSubmit(code); the page reloads into follow mode. ----
  function joinPrompt(el, onSubmit) {
    var S = txt()
    el.innerHTML =
      '<form class="joinform" novalidate>' +
        '<h1>' + S.joinTitle + '</h1>' +
        '<input class="roomin" type="text" inputmode="latin" autocomplete="off" ' +
          'autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="4" ' +
          'placeholder="' + S.joinCode + '" aria-label="' + S.joinCode + '">' +
        '<button class="joinbtn" type="submit">' + S.joinBtn + '</button>' +
        '<p class="joinhint">' + S.joinHint + '</p>' +
      '</form>'
    var form = el.querySelector('.joinform'), input = el.querySelector('.roomin')
    input.addEventListener('input', function () {
      input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '')
    })
    form.addEventListener('submit', function (e) {
      e.preventDefault()
      var code = input.value.trim()
      if (code) onSubmit(code)
    })
    try { input.focus() } catch (e) {}
  }

  // Phone-only "back to the roadmap" affordance. A deck is a full-screen reveal page
  // with no app chrome, so in the installed app (or any phone) there is otherwise no
  // way back to the course home. Suppressed on desktop (browser back / tabs handle it)
  // and during live follow (?room), where the deck isn't served under the student site.
  function mountHome() {
    try {
      var narrow = w.matchMedia && w.matchMedia('(max-width: 820px), (pointer: coarse)').matches
      if (!narrow) return
      if (new URLSearchParams(w.location.search).has('room')) return
      if (w.document.querySelector('.deck-home')) return
      var b = w.document.createElement('button')
      b.className = 'deck-home'
      b.type = 'button'
      b.setAttribute('aria-label', w.DECK_HOME_LABEL || 'Tilbake til oversikt')
      b.innerHTML = '←'
      b.addEventListener('click', function () {
        var ref = w.document.referrer
        if (ref && ref.indexOf(w.location.origin) === 0) w.history.back()   // return to prior scroll
        else w.location.href = '../index.html'                              // roadmap lives one level up
      })
      w.document.body.appendChild(b)
    } catch (e) { /* never let deck chrome break a deck */ }
  }

  // ---- Deck wiring: mount every .pollmount with ONE room-level QR (identical on
  // every slide → scan once, and a latecomer scanning any slide joins & syncs),
  // then announce the active poll on each slide change via the control channel. ----
  function deck(room) {
    if (w.__pollDeckBooted) return                       // idempotent: autoboot + a stray explicit call can't double-mount
    w.__pollDeckBooted = true
    mountHome()
    document.querySelectorAll('.pollmount').forEach(function (el) {
      var id = el.getAttribute('data-poll')
      var voteUrl = new URL('vote.html', location.href)
      voteUrl.searchParams.set('room', room)              // no poll param → phone runs follow mode
      presenter(el, w.POLLS[id], id, room, voteUrl.href)
    })
    var ctl = control(room)
    function announce() {
      var R = w.Reveal, cur = R && R.getCurrentSlide && R.getCurrentSlide()
      var mount = cur && cur.querySelector && cur.querySelector('.pollmount')
      if (mount) ctl.setActive(mount.getAttribute('data-poll'))   // sticky: only (re)announce on poll slides
    }
    if (w.Reveal && w.Reveal.on) {
      w.Reveal.on('slidechanged', announce)
      w.Reveal.on('ready', announce)
      if (w.Reveal.isReady && w.Reveal.isReady()) announce()      // deck() called after init already fired
    }
    // Press R to show/hide the current slide's poll results (results start hidden so
    // the projector can't sway votes). 'h' is reveal's own left-nav, so we use 'r'.
    if (w.Reveal && w.Reveal.addKeyBinding) {
      w.Reveal.addKeyBinding({ keyCode: 82, key: 'R', description: 'Show / hide poll results' }, function () {
        var cur = w.Reveal.getCurrentSlide()
        var mount = cur && cur.querySelector && cur.querySelector('.pollmount')
        if (mount && mount._toggleResults) mount._toggleResults()
      })
    }
  }

  w.Poll = { presenter: presenter, student: student, follow: follow, control: control, deck: deck, joinPrompt: joinPrompt, qrDataUrl: qrDataUrl, onValues: onValues }

  // ---- Self-boot: a presenter deck needs no inline poll wiring ----
  // Any page that mounts polls (has a .pollmount) IS a presenter deck, so wire it
  // up automatically — QR/room + phone sync + the R-key results toggle. This lives
  // here, once, instead of being copy-pasted into every deck's inline <script>
  // (which is how some decks drifted into a hand-rolled loop that never bound R).
  // vote.html (the phone page) has no .pollmount, so it opts out. deck() is
  // idempotent, so a legacy deck that still calls Poll.deck(room) itself is fine.
  // Runs on DOMContentLoaded, after the deck's own end-of-body Reveal.initialize().
  function autoboot() {
    if (w.__pollDeckBooted) return                       // an explicit Poll.deck(room) already ran
    if (!w.Reveal || !w.document.querySelector('.pollmount')) return
    var room = (new URLSearchParams(w.location.search).get('room') ||
      Array.from({ length: 4 }, function () { return 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)] }).join('')
    ).toUpperCase()
    deck(room)
  }
  if (w.document.readyState === 'loading') w.document.addEventListener('DOMContentLoaded', autoboot)
  else autoboot()
})(window)
