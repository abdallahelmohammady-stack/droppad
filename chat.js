/* =====================================================================
   DropPad Chat — group chat over the existing WebRTC mesh (PeerJS).
   ---------------------------------------------------------------------
   يشتغل جنب app.js من غير ما يلمسه: بيركب نفسه على نفس اتصالات
   PeerJS عن طريق جسر (window.DropPadBus) وبيتعامل مع رسائل الشات
   بأنواع خاصة (chat:*) — أي نوع تاني بيسيبه لمنطق البافر الأصلي.

   بروتوكول الشات (كله عبر نفس الـ DataConnection):
     chat:msg      رسالة جديدة  { m }
     chat:edit     تعديل نص     { id, text, editedAt }
     chat:del      حذف          { id }
     chat:react    تفاعل        { id, emoji, by }
     chat:typing   بيكتب الآن   { name, on }
     chat:read     علامة قراءة  { ids[], by }
     chat:state    مزامنة كاملة للداخل الجديد { messages, peers }
     chat:file:meta بداية ملف مجزأ { fid, name, type, size, mid }
     chat:file:chunk جزء        { fid, i, total, b64 }
     chat:file:done اكتمال      { fid }
   ===================================================================== */
(() => {
  'use strict';

  /* ---------- إعدادات ---------- */
  const CHUNK_SIZE   = 48 * 1024;   // 48KB لكل جزء — آمن على قناة WebRTC
  const TYPING_MS    = 2200;
  const MAX_TEXT     = 8000;
  const NAME_KEY     = 'droppad_name';
  const EMOJIS       = ['👍', '❤️', '😂', '🔥', '👏', '😮'];

  /* ---------- أدوات ---------- */
  const $  = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const uid = () => 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }
  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
  }
  function fmtDay(ts) {
    const d = new Date(ts), t = new Date();
    const same = (a, b) => a.toDateString() === b.toDateString();
    if (same(d, t)) return 'اليوم';
    const y = new Date(t.getTime() - 864e5);
    if (same(d, y)) return 'أمس';
    return d.toLocaleDateString('ar-EG', { day: 'numeric', month: 'long' });
  }

  /* ---------- اسم الجهاز: تلقائي + قابل للتعديل ---------- */
  function guessDeviceName() {
    const ua = navigator.userAgent;
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua)) return 'iPad';
    if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android Phone' : 'Android Tablet';
    if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
    if (/Windows/i.test(ua)) return 'Windows PC';
    if (/Linux/i.test(ua)) return 'Linux PC';
    return 'Device';
  }
  let myName = localStorage.getItem(NAME_KEY) || guessDeviceName();

  /* ---------- الحالة ---------- */
  let messages = [];                 // [{id, from, name, ts, kind, text?, file?, replyTo?, edited?, reactions{}, readBy[]}]
  const incoming = new Map();        // fid -> {meta, parts[], got}
  const outgoing = new Map();        // fid -> {sent,total}
  const typingPeers = new Map();     // name -> timeout
  let replyTarget = null;
  let searchQuery = '';

  /* =====================================================================
     الجسر مع app.js — بنستنى DropPadBus يتعرّف
     ===================================================================== */
  const Bus = {
    ready: false,
    send: () => {},
    myId: () => 'local',
    peerCount: () => 0
  };

  function hookBus() {
    if (!window.DropPadBus) return false;
    Bus.ready = true;
    Bus.send = window.DropPadBus.broadcast;
    Bus.myId = window.DropPadBus.myId;
    Bus.peerCount = window.DropPadBus.peerCount;
    window.DropPadBus.onChat = handleRemote;
    window.DropPadBus.onPeerJoin = (conn) => {
      // ابعت للداخل الجديد كل الرسائل (بلا أجسام الملفات — بتتطلب عند الفتح)
      try {
        conn.send({
          t: 'chat:state',
          from: Bus.myId(),
          messages: messages.map(stripBody)
        });
      } catch (e) { /* الاتصال قافل */ }
    };
    return true;
  }

  function stripBody(m) {
    if (m.kind !== 'file' || !m.file) return m;
    const f = { ...m.file };
    delete f.body;          // الجسم بيتبعت مجزأ لوحده
    return { ...m, file: f };
  }

  /* =====================================================================
     الإرسال
     ===================================================================== */
  function pushLocal(m) {
    messages.push(m);
    render();
    scrollToEnd();
  }

  function sendText(text) {
    const t = text.trim();
    if (!t) return;
    if (t.length > MAX_TEXT) { toast('الرسالة طويلة أوي', 'err'); return; }
    const m = {
      id: uid(), from: Bus.myId(), name: myName, ts: Date.now(),
      kind: 'text', text: t,
      replyTo: replyTarget ? { id: replyTarget.id, name: replyTarget.name, text: preview(replyTarget) } : null,
      reactions: {}, readBy: []
    };
    pushLocal(m);
    Bus.send({ t: 'chat:msg', m });
    clearReply();
    setTyping(false);
  }

  function preview(m) {
    if (m.kind === 'file') return '📎 ' + (m.file?.name || 'ملف');
    return String(m.text || '').slice(0, 60);
  }

  /* ---------- إرسال ملف مجزأ (بلا حد حجم) ---------- */
  async function sendFile(file) {
    const fid = 'f_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const mid = uid();
    const total = Math.ceil(file.size / CHUNK_SIZE) || 1;

    const m = {
      id: mid, from: Bus.myId(), name: myName, ts: Date.now(),
      kind: 'file',
      file: { fid, name: file.name, type: file.type || 'application/octet-stream', size: file.size, url: URL.createObjectURL(file) },
      replyTo: replyTarget ? { id: replyTarget.id, name: replyTarget.name, text: preview(replyTarget) } : null,
      reactions: {}, readBy: [], progress: 1
    };
    pushLocal(m);
    clearReply();

    Bus.send({ t: 'chat:file:meta', from: Bus.myId(), fid, mid, name: file.name, type: m.file.type, size: file.size, ts: m.ts, sender: myName, replyTo: m.replyTo });
    outgoing.set(fid, { sent: 0, total });

    for (let i = 0; i < total; i++) {
      const slice = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const buf = await slice.arrayBuffer();
      Bus.send({ t: 'chat:file:chunk', from: Bus.myId(), fid, i, total, b64: toB64(buf) });
      const o = outgoing.get(fid);
      if (o) { o.sent = i + 1; }
      // نفس فرصة للمتصفح يتنفس (مايتعلقش على ملف كبير)
      if (i % 8 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    Bus.send({ t: 'chat:file:done', from: Bus.myId(), fid });
    outgoing.delete(fid);
  }

  function toB64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(s);
  }
  function fromB64(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  /* =====================================================================
     الاستقبال
     ===================================================================== */
  function handleRemote(d) {
    if (!d || typeof d !== 'object') return false;
    if (typeof d.t !== 'string' || !d.t.startsWith('chat:')) return false;
    if (d.from && d.from === Bus.myId()) return true;

    switch (d.t) {
      case 'chat:msg': {
        if (!d.m || messages.some((x) => x.id === d.m.id)) break;
        messages.push(d.m);
        sortMsgs(); render();
        if (nearBottom()) scrollToEnd();
        bump();
        break;
      }
      case 'chat:edit': {
        const m = messages.find((x) => x.id === d.id);
        if (m) { m.text = d.text; m.edited = d.editedAt || Date.now(); render(); }
        break;
      }
      case 'chat:del': {
        const m = messages.find((x) => x.id === d.id);
        if (m) { m.deleted = true; m.text = ''; m.file = null; render(); }
        break;
      }
      case 'chat:react': {
        const m = messages.find((x) => x.id === d.id);
        if (m) {
          m.reactions = m.reactions || {};
          const arr = m.reactions[d.emoji] || [];
          const i = arr.indexOf(d.by);
          if (i >= 0) arr.splice(i, 1); else arr.push(d.by);
          if (arr.length) m.reactions[d.emoji] = arr; else delete m.reactions[d.emoji];
          render();
        }
        break;
      }
      case 'chat:typing': {
        if (d.on) {
          clearTimeout(typingPeers.get(d.name));
          typingPeers.set(d.name, setTimeout(() => { typingPeers.delete(d.name); paintTyping(); }, TYPING_MS + 600));
        } else {
          clearTimeout(typingPeers.get(d.name));
          typingPeers.delete(d.name);
        }
        paintTyping();
        break;
      }
      case 'chat:read': {
        (d.ids || []).forEach((id) => {
          const m = messages.find((x) => x.id === id);
          if (m && m.from === Bus.myId()) {
            m.readBy = m.readBy || [];
            if (!m.readBy.includes(d.by)) m.readBy.push(d.by);
          }
        });
        render();
        break;
      }
      case 'chat:state': {
        // دمج بدل استبدال — عشان مانفقدش رسائل محلية
        (d.messages || []).forEach((rm) => {
          if (!messages.some((x) => x.id === rm.id)) messages.push(rm);
        });
        sortMsgs(); render();
        break;
      }
      case 'chat:file:meta': {
        incoming.set(d.fid, { meta: d, parts: [], got: 0 });
        if (!messages.some((x) => x.id === d.mid)) {
          messages.push({
            id: d.mid, from: d.from, name: d.sender || 'Device', ts: d.ts || Date.now(),
            kind: 'file',
            file: { fid: d.fid, name: d.name, type: d.type, size: d.size, url: null },
            replyTo: d.replyTo || null, reactions: {}, readBy: [], progress: 0
          });
          sortMsgs(); render();
          if (nearBottom()) scrollToEnd();
        }
        break;
      }
      case 'chat:file:chunk': {
        const rec = incoming.get(d.fid);
        if (!rec) break;
        rec.parts[d.i] = fromB64(d.b64);
        rec.got++;
        const m = messages.find((x) => x.kind === 'file' && x.file && x.file.fid === d.fid);
        if (m) { m.progress = rec.got / d.total; paintProgress(m); }
        break;
      }
      case 'chat:file:done': {
        const rec = incoming.get(d.fid);
        if (!rec) break;
        const blob = new Blob(rec.parts, { type: rec.meta.type || 'application/octet-stream' });
        const m = messages.find((x) => x.kind === 'file' && x.file && x.file.fid === d.fid);
        if (m) { m.file.url = URL.createObjectURL(blob); m.progress = 1; render(); }
        incoming.delete(d.fid);
        bump();
        break;
      }
      default: break;
    }
    return true;   // اتعاملنا معاها — app.js مايشوفهاش
  }

  function sortMsgs() { messages.sort((a, b) => a.ts - b.ts); }

  /* =====================================================================
     الرسم
     ===================================================================== */
  let listEl, inputEl, typingEl, replyBarEl;

  function nearBottom() {
    if (!listEl) return true;
    return listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 140;
  }
  function scrollToEnd() {
    if (!listEl) return;
    requestAnimationFrame(() => { listEl.scrollTop = listEl.scrollHeight; });
  }

  function render() {
    if (!listEl) return;
    const q = searchQuery.trim().toLowerCase();
    const view = q
      ? messages.filter((m) => !m.deleted && ((m.text || '').toLowerCase().includes(q) || (m.file?.name || '').toLowerCase().includes(q)))
      : messages;

    if (!view.length) {
      listEl.innerHTML = '<div class="ch-empty">' +
        (q ? 'مفيش نتائج للبحث' : 'مفيش رسائل لسه — ابعت أول رسالة 👋') + '</div>';
      return;
    }

    let html = '';
    let lastDay = '';
    view.forEach((m) => {
      const day = fmtDay(m.ts);
      if (day !== lastDay) { html += '<div class="ch-day"><span>' + esc(day) + '</span></div>'; lastDay = day; }
      html += bubble(m);
    });
    listEl.innerHTML = html;
    if (window.lucide) window.lucide.createIcons();
  }

  function bubble(m) {
    const mine = m.from === Bus.myId();
    const cls = 'ch-msg' + (mine ? ' mine' : '');

    if (m.deleted) {
      return '<div class="' + cls + '" data-id="' + esc(m.id) + '">' +
        '<div class="ch-bub deleted"><i>🚫 الرسالة اتمسحت</i>' +
        '<span class="ch-time">' + fmtTime(m.ts) + '</span></div></div>';
    }

    let inner = '';
    if (m.replyTo) {
      inner += '<div class="ch-reply-q" onclick="DropPadChat.jump(\'' + esc(m.replyTo.id) + '\')">' +
        '<b>' + esc(m.replyTo.name) + '</b><span>' + esc(m.replyTo.text) + '</span></div>';
    }
    if (m.kind === 'file' && m.file) inner += fileBody(m);
    if (m.text) inner += '<p class="ch-text">' + linkify(esc(m.text)) + '</p>';

    // التفاعلات
    let reacts = '';
    const rk = Object.keys(m.reactions || {});
    if (rk.length) {
      reacts = '<div class="ch-reacts">' + rk.map((e) =>
        '<button class="ch-react" onclick="DropPadChat.react(\'' + esc(m.id) + '\',\'' + e + '\')">' +
        e + '<b>' + m.reactions[e].length + '</b></button>').join('') + '</div>';
    }

    const readMark = mine
      ? '<span class="ch-ticks' + ((m.readBy || []).length ? ' seen' : '') + '">' +
        ((m.readBy || []).length ? '✓✓' : '✓') + '</span>'
      : '';

    return '<div class="' + cls + '" data-id="' + esc(m.id) + '">' +
      (mine ? '' : '<div class="ch-who">' + esc(m.name) + '</div>') +
      '<div class="ch-bub">' + inner +
        '<div class="ch-meta"><span class="ch-time">' + fmtTime(m.ts) +
        (m.edited ? ' · معدّلة' : '') + '</span>' + readMark + '</div>' +
        reacts +
        '<div class="ch-tools">' +
          '<button title="رد" onclick="DropPadChat.reply(\'' + esc(m.id) + '\')">↩</button>' +
          '<button title="تفاعل" onclick="DropPadChat.pickReact(\'' + esc(m.id) + '\',event)">😊</button>' +
          '<button title="إعادة توجيه" onclick="DropPadChat.forward(\'' + esc(m.id) + '\')">➦</button>' +
          (m.kind === 'text' ? '<button title="نسخ" onclick="DropPadChat.copy(\'' + esc(m.id) + '\')">⧉</button>' : '') +
          (mine && m.kind === 'text' ? '<button title="تعديل" onclick="DropPadChat.edit(\'' + esc(m.id) + '\')">✎</button>' : '') +
          (mine ? '<button class="del" title="حذف" onclick="DropPadChat.del(\'' + esc(m.id) + '\')">🗑</button>' : '') +
        '</div>' +
      '</div></div>';
  }

  function fileBody(m) {
    const f = m.file;
    const pct = Math.round((m.progress ?? 1) * 100);
    const loading = pct < 100;
    const isImg = (f.type || '').startsWith('image/');
    const isVid = (f.type || '').startsWith('video/');
    const isAud = (f.type || '').startsWith('audio/');

    let media = '';
    if (!loading && f.url) {
      if (isImg) media = '<img class="ch-img" src="' + f.url + '" alt="" loading="lazy" onclick="DropPadChat.zoom(\'' + esc(m.id) + '\')">';
      else if (isVid) media = '<video class="ch-vid" src="' + f.url + '" controls preload="metadata"></video>';
      else if (isAud) media = '<audio class="ch-aud" src="' + f.url + '" controls preload="metadata"></audio>';
    }

    const bar = loading
      ? '<div class="ch-prog"><i style="width:' + pct + '%"></i></div><span class="ch-pct">' + pct + '%</span>'
      : '<a class="ch-dl" href="' + (f.url || '#') + '" download="' + esc(f.name) + '">تحميل</a>';

    return '<div class="ch-file">' + media +
      '<div class="ch-file-row">' +
        '<span class="ch-file-ic">' + iconFor(f.type, f.name) + '</span>' +
        '<span class="ch-file-nm">' + esc(f.name) + '</span>' +
        '<span class="ch-file-sz">' + fmtBytes(f.size) + '</span>' +
        bar +
      '</div></div>';
  }

  function iconFor(type, name) {
    type = type || '';
    if (type.startsWith('image/')) return 'IMG';
    if (type.startsWith('audio/')) return 'MP3';
    if (type.startsWith('video/')) return 'VID';
    if (type === 'application/pdf') return 'PDF';
    if (/\.(docx?)$/i.test(name || '')) return 'DOC';
    if (/\.(zip|rar|7z|tar|gz)$/i.test(name || '')) return 'ZIP';
    return 'FILE';
  }

  function linkify(s) {
    return s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  }

  function paintProgress(m) {
    const node = listEl && listEl.querySelector('.ch-msg[data-id="' + m.id + '"]');
    if (!node) return;
    const bar = node.querySelector('.ch-prog i');
    const pct = node.querySelector('.ch-pct');
    const v = Math.round((m.progress || 0) * 100);
    if (bar) bar.style.width = v + '%';
    if (pct) pct.textContent = v + '%';
  }

  function paintTyping() {
    if (!typingEl) return;
    const names = [...typingPeers.keys()];
    typingEl.textContent = names.length
      ? (names.length === 1 ? names[0] + ' بيكتب…' : names.length + ' أجهزة بيكتبوا…')
      : '';
    typingEl.classList.toggle('on', names.length > 0);
  }

  function bump() {
    // صوت/اهتزاز خفيف عند وصول رسالة (لو التاب مش شغّال)
    if (document.hidden && navigator.vibrate) { try { navigator.vibrate(30); } catch (e) {} }
  }

  /* ---------- typing ---------- */
  let typingOn = false, typingTimer = null;
  function setTyping(on) {
    if (on === typingOn) return;
    typingOn = on;
    Bus.send({ t: 'chat:typing', from: Bus.myId(), name: myName, on });
  }

  /* =====================================================================
     الواجهة العامة (onclick)
     ===================================================================== */
  const API = {
    reply(id) {
      const m = messages.find((x) => x.id === id);
      if (!m) return;
      replyTarget = m;
      if (replyBarEl) {
        replyBarEl.innerHTML = '<div class="ch-rb-in"><b>رد على ' + esc(m.name) + '</b>' +
          '<span>' + esc(preview(m)) + '</span></div>' +
          '<button onclick="DropPadChat.clearReply()">✕</button>';
        replyBarEl.classList.add('on');
      }
      inputEl && inputEl.focus();
    },
    clearReply() { clearReply(); },
    del(id) {
      const m = messages.find((x) => x.id === id);
      if (!m) return;
      if (!confirm('تمسح الرسالة دي عند الكل؟')) return;
      m.deleted = true; m.text = ''; m.file = null;
      render();
      Bus.send({ t: 'chat:del', from: Bus.myId(), id });
    },
    edit(id) {
      const m = messages.find((x) => x.id === id);
      if (!m || m.from !== Bus.myId()) return;
      const t = prompt('عدّل الرسالة:', m.text || '');
      if (t === null) return;
      const v = t.trim();
      if (!v) return;
      m.text = v; m.edited = Date.now();
      render();
      Bus.send({ t: 'chat:edit', from: Bus.myId(), id, text: v, editedAt: m.edited });
    },
    copy(id) {
      const m = messages.find((x) => x.id === id);
      if (!m) return;
      navigator.clipboard.writeText(m.text || '').then(() => toast('اتنسخت ✓', 'ok'));
    },
    forward(id) {
      const m = messages.find((x) => x.id === id);
      if (!m) return;
      const fw = {
        id: uid(), from: Bus.myId(), name: myName, ts: Date.now(),
        kind: m.kind, text: m.text, file: m.file ? { ...m.file } : null,
        forwarded: m.name, reactions: {}, readBy: []
      };
      pushLocal(fw);
      Bus.send({ t: 'chat:msg', m: fw });
      toast('اتبعتت تاني ✓', 'ok');
    },
    react(id, emoji) {
      const m = messages.find((x) => x.id === id);
      if (!m) return;
      const me = Bus.myId();
      m.reactions = m.reactions || {};
      const arr = m.reactions[emoji] || [];
      const i = arr.indexOf(me);
      if (i >= 0) arr.splice(i, 1); else arr.push(me);
      if (arr.length) m.reactions[emoji] = arr; else delete m.reactions[emoji];
      render();
      Bus.send({ t: 'chat:react', from: me, id, emoji, by: me });
    },
    pickReact(id, ev) {
      if (ev) ev.stopPropagation();
      const old = document.querySelector('.ch-emoji-pop');
      if (old) old.remove();
      const pop = document.createElement('div');
      pop.className = 'ch-emoji-pop';
      pop.innerHTML = EMOJIS.map((e) =>
        '<button onclick="DropPadChat.react(\'' + id + '\',\'' + e + '\');this.parentNode.remove()">' + e + '</button>').join('');
      document.body.appendChild(pop);
      const r = ev.target.getBoundingClientRect();
      pop.style.top = (r.bottom + 6 + window.scrollY) + 'px';
      pop.style.left = Math.max(8, r.left - 60) + 'px';
      setTimeout(() => {
        document.addEventListener('click', function h() { pop.remove(); document.removeEventListener('click', h); }, { once: true });
      }, 10);
    },
    jump(id) {
      const n = listEl && listEl.querySelector('.ch-msg[data-id="' + id + '"]');
      if (!n) return;
      n.scrollIntoView({ behavior: 'smooth', block: 'center' });
      n.classList.add('flash');
      setTimeout(() => n.classList.remove('flash'), 1200);
    },
    zoom(id) {
      const m = messages.find((x) => x.id === id);
      if (!m || !m.file || !m.file.url) return;
      const st = document.getElementById('fsStage');
      const ct = document.getElementById('fsContent');
      if (!st || !ct) { window.open(m.file.url, '_blank'); return; }
      ct.innerHTML = '<img src="' + m.file.url + '" alt="">';
      st.classList.add('show');
    },
    setName(n) {
      const v = String(n || '').trim().slice(0, 24);
      if (!v) return;
      myName = v;
      localStorage.setItem(NAME_KEY, v);
      render();
      toast('الاسم بقى: ' + v, 'ok');
    },
    getName() { return myName; },
    search(q) { searchQuery = q || ''; render(); },
    clearAll() {
      if (!confirm('تمسح كل الرسائل من الجهاز ده؟ (مش هتتمسح عند الباقيين)')) return;
      messages = [];
      render();
      toast('اتمسحت المحادثة محليًا', 'ok');
    },
    _debug() { return { messages, myName, peers: Bus.peerCount() }; }
  };

  function clearReply() {
    replyTarget = null;
    if (replyBarEl) { replyBarEl.classList.remove('on'); replyBarEl.innerHTML = ''; }
  }

  function toast(msg, kind) {
    if (window.DropPadBus && window.DropPadBus.toast) return window.DropPadBus.toast(msg, kind);
    console.log('[chat]', msg);
  }

  /* =====================================================================
     التركيب
     ===================================================================== */
  function mount() {
    listEl     = $('#chatList');
    inputEl    = $('#chatInput');
    typingEl   = $('#chatTyping');
    replyBarEl = $('#chatReplyBar');
    if (!listEl || !inputEl) return;

    const sendBtn = $('#chatSend');
    const fileBtn = $('#chatAttach');
    const fileIn  = $('#chatFile');
    const nameBtn = $('#chatName');
    const searchIn = $('#chatSearch');

    const doSend = () => {
      sendText(inputEl.value);
      inputEl.value = '';
      inputEl.style.height = 'auto';
    };

    sendBtn && sendBtn.addEventListener('click', doSend);
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
      setTyping(true);
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => setTyping(false), TYPING_MS);
    });

    fileBtn && fileBtn.addEventListener('click', () => fileIn && fileIn.click());
    fileIn && fileIn.addEventListener('change', async (e) => {
      for (const f of e.target.files) await sendFile(f);
      fileIn.value = '';
    });

    // سحب وإفلات على منطقة الشات
    const panel = $('#panelChat');
    if (panel) {
      ['dragenter', 'dragover'].forEach((ev) => panel.addEventListener(ev, (e) => {
        e.preventDefault(); panel.classList.add('drag');
      }));
      ['dragleave', 'drop'].forEach((ev) => panel.addEventListener(ev, (e) => {
        e.preventDefault(); if (ev === 'dragleave' && panel.contains(e.relatedTarget)) return;
        panel.classList.remove('drag');
      }));
      panel.addEventListener('drop', async (e) => {
        const fs = e.dataTransfer && e.dataTransfer.files;
        if (fs) for (const f of fs) await sendFile(f);
      });
    }

    // لصق صورة
    document.addEventListener('paste', async (e) => {
      if (!document.getElementById('panelChat')?.classList.contains('active')) return;
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const it of items) {
        if (it.kind === 'file') {
          const f = it.getAsFile();
          if (f) await sendFile(f);
        }
      }
    });

    nameBtn && nameBtn.addEventListener('click', () => {
      const n = prompt('اسم الجهاز في الشات:', myName);
      if (n !== null) API.setName(n);
    });

    searchIn && searchIn.addEventListener('input', (e) => API.search(e.target.value));

    // علامات القراءة: لما الشات يبان
    listEl.addEventListener('scroll', markRead);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) markRead(); });

    render();
    paintTyping();
  }

  let readTimer = null;
  function markRead() {
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      const unseen = messages.filter((m) => m.from !== Bus.myId() && !m._read).map((m) => { m._read = true; return m.id; });
      if (unseen.length) Bus.send({ t: 'chat:read', from: Bus.myId(), ids: unseen, by: Bus.myId() });
    }, 400);
  }

  /* ---------- إقلاع ---------- */
  window.DropPadChat = API;

  const boot = () => {
    mount();
    let tries = 0;
    const iv = setInterval(() => {
      if (hookBus() || ++tries > 100) clearInterval(iv);
    }, 100);
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
