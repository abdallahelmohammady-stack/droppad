/* =====================================================================
   DropPad — real-time cross-device sync buffer (PWA)
   Transport: MQTT over secure WebSocket (public broker, swappable).
   Rooms are topic namespaces; text + files are published as RETAINED
   messages so late joiners instantly receive the current buffer.
   ===================================================================== */
(() => {
  'use strict';

  /* ---------- Config ---------- */
  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',     // primary, public, no account
    'wss://test.mosquitto.org:8081/mqtt'  // fallback
  ];
  const PREFIX = 'droppad';
  const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MB safety cap per file
  const IMG_MAX_DIM = 1600;
  const IMG_QUALITY = 0.82;
  const HEARTBEAT_MS = 4000;
  const PEER_TTL_MS = 11000;
  const TEXT_DEBOUNCE = 140;

  const CLIENT_ID = 'dp_' + Math.random().toString(36).slice(2, 10);

  /* ---------- DOM ---------- */
  const $ = (s) => document.querySelector(s);
  const el = {
    status: $('#status'), statusLabel: $('#statusLabel'),
    pairBtn: $('#pairBtn'),
    tabText: $('#tabText'), tabFiles: $('#tabFiles'),
    panelText: $('#panelText'), panelFiles: $('#panelFiles'),
    buffer: $('#buffer'), wordCount: $('#wordCount'), charCount: $('#charCount'), syncedFlag: $('#syncedFlag'),
    copyTextBtn: $('#copyTextBtn'), qrTextBtn: $('#qrTextBtn'), formatBtn: $('#formatBtn'), clearBtn: $('#clearBtn'),
    dropzone: $('#dropzone'), fileInput: $('#fileInput'),
    copyImgBtn: $('#copyImgBtn'), downloadBtn: $('#downloadBtn'), fullscreenBtn: $('#fullscreenBtn'),
    filesGrid: $('#filesGrid'), filesEmpty: $('#filesEmpty'),
    pairModal: $('#pairModal'), pairQr: $('#pairQr'), pairPin: $('#pairPin'),
    copyPinBtn: $('#copyPinBtn'), pairLink: $('#pairLink'), copyLinkBtn: $('#copyLinkBtn'),
    joinInput: $('#joinInput'), joinBtn: $('#joinBtn'), newRoomBtn: $('#newRoomBtn'), closePairBtn: $('#closePairBtn'),
    qrModal: $('#qrModal'), textQr: $('#textQr'), closeQrBtn: $('#closeQrBtn'),
    fsStage: $('#fsStage'), fsContent: $('#fsContent'), fsClose: $('#fsClose'),
    toasts: $('#toasts')
  };

  /* ---------- State ---------- */
  let room = null;
  let client = null;
  let connected = false;
  let applyingRemote = false;     // guard against echo loops
  let textDirty = false;          // local edit pending publish
  const peers = new Map();        // clientId -> lastSeen
  const fileBodies = new Map();   // id -> dataURL
  let manifest = [];              // [{id,name,type,size,ts}]
  let selectedFileId = null;
  let urlIdx = 0;
  let reconnectTimer = null;
  let manualClose = false;

  /* =====================================================================
     Utilities
     ===================================================================== */
  function genRoom() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
    let s = '';
    const a = new Uint32Array(6);
    crypto.getRandomValues(a);
    for (let i = 0; i < 6; i++) s += alphabet[a[i] % alphabet.length];
    return s;
  }

  function topics() {
    return {
      text: `${PREFIX}/${room}/text`,
      files: `${PREFIX}/${room}/files`,
      file: (id) => `${PREFIX}/${room}/file/${id}`,
      presence: `${PREFIX}/${room}/presence/${CLIENT_ID}`,
      presenceWild: `${PREFIX}/${room}/presence/+`
    };
  }

  function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(2) + ' MB';
  }

  function toast(msg, kind = '') {
    const icons = {
      ok: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
      err: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'
    };
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.innerHTML = (icons[kind] || '') + '<span></span>';
    t.querySelector('span').textContent = msg;
    el.toasts.appendChild(t);
    setTimeout(() => {
      t.style.animation = 'toastOut 0.2s ease forwards';
      setTimeout(() => t.remove(), 220);
    }, 2200);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch {}
      ta.remove();
      return ok;
    }
  }
  async function copyImage(dataUrl) {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      return true;
    } catch (e) { return false; }
  }

  /* =====================================================================
     Sync engine (MQTT)
     ===================================================================== */
  function setStatus(state, label) {
    el.status.className = 'status ' + state;
    el.statusLabel.textContent = label;
  }

  function connect() {
    if (typeof mqtt === 'undefined') {
      setStatus('offline', 'Offline (no lib)');
      toast('Sync library failed to load', 'err');
      return;
    }
    dial();
  }

  function dial() {
    if (manualClose) return;
    if (client) { try { client.end(true); } catch {} }
    const t = topics();
    const opts = {
      clientId: CLIENT_ID,
      clean: true,
      reconnectPeriod: 0,            // we manage reconnection/failover manually
      connectTimeout: 8000,
      keepalive: 30,
      will: { topic: t.presence, payload: '', qos: 0, retain: true }
    };
    setStatus('connecting', 'Connecting… (' + (urlIdx + 1) + '/' + BROKERS.length + ')');
    client = mqtt.connect(BROKERS[urlIdx], opts);

    client.on('connect', () => {
      connected = true;
      setStatus('online', 'Synced');
      client.subscribe([t.text, t.files, t.presenceWild], { qos: 0 }, (err) => {
        if (err) console.warn('sub err', err);
      });
      client.publish(t.presence, CLIENT_ID, { qos: 0, retain: true });
      startHeartbeat();
      toast('Connected — room ' + room, 'ok');
    });
    client.on('reconnect', () => { connected = false; setStatus('connecting', 'Reconnecting…'); });
    client.on('offline', () => { connected = false; setStatus('offline', 'Offline'); });
    client.on('error', (e) => { console.warn('mqtt error', e && e.message); });
    client.on('close', () => {
      connected = false;
      setStatus('offline', 'Offline');
      if (!manualClose) scheduleReconnect();
    });
    client.on('message', (topic, payload) => handleMessage(topic, payload));
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      urlIdx = (urlIdx + 1) % BROKERS.length;
      dial();
    }, 3000);
  }

  function handleMessage(topic, payload) {
    const t = topics();
    const str = payload.toString();
    if (topic === t.text) {
      applyingRemote = true;
      el.buffer.value = str;
      updateCounter();
      flashSynced();
      applyingRemote = false;
    } else if (topic === t.files) {
      try {
        const incoming = str ? JSON.parse(str) : [];
        // drop removed files
        const ids = new Set(incoming.map((f) => f.id));
        manifest = incoming;
        // remove bodies no longer present
        for (const id of [...fileBodies.keys()]) if (!ids.has(id)) fileBodies.delete(id);
        renderFiles(true);
      } catch (e) { console.warn('bad files manifest', e); }
    } else if (topic.startsWith(`${PREFIX}/${room}/file/`)) {
      const id = topic.split('/').pop();
      fileBodies.set(id, str);
      renderFiles(false);
    } else if (topic.startsWith(`${PREFIX}/${room}/presence/`)) {
      const pid = topic.split('/').pop();
      if (pid === CLIENT_ID) return;
      if (str === '') { peers.delete(pid); }
      else { peers.set(pid, Date.now()); }
      updatePeerCount();
    }
  }

  function startHeartbeat() {
    clearInterval(startHeartbeat._h);
    startHeartbeat._h = setInterval(() => {
      if (connected && client) {
        client.publish(topics().presence, CLIENT_ID, { qos: 0, retain: true });
      }
    }, HEARTBEAT_MS);

    clearInterval(startHeartbeat._p);
    startHeartbeat._p = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [k, v] of peers) if (now - v > PEER_TTL_MS) { peers.delete(k); changed = true; }
      if (changed) updatePeerCount();
    }, 3000);
  }

  function updatePeerCount() {
    const n = peers.size + (connected ? 1 : 0);
    if (connected) {
      el.statusLabel.textContent = n > 1 ? `Synced · ${n} devices` : 'Synced · solo';
    }
  }

  function publishText(text) {
    if (!connected || !client) return;
    client.publish(topics().text, text, { qos: 0, retain: true });
  }
  function publishManifest() {
    if (!connected || !client) return;
    client.publish(topics().files, JSON.stringify(manifest), { qos: 0, retain: true });
  }
  function publishFileBody(id, dataUrl) {
    if (!connected || !client) return;
    client.publish(topics().file(id), dataUrl, { qos: 0, retain: true });
  }

  /* =====================================================================
     Text mode
     ===================================================================== */
  function updateCounter() {
    const v = el.buffer.value;
    const chars = v.length;
    const words = v.trim() ? v.trim().split(/\s+/).length : 0;
    el.wordCount.textContent = words;
    el.charCount.textContent = chars;
  }
  function flashSynced() {
    el.syncedFlag.classList.add('show');
    clearTimeout(flashSynced._t);
    flashSynced._t = setTimeout(() => el.syncedFlag.classList.remove('show'), 1200);
  }

  let textTimer = null;
  el.buffer.addEventListener('input', () => {
    updateCounter();
    if (applyingRemote) return;
    textDirty = true;
    clearTimeout(textTimer);
    textTimer = setTimeout(() => {
      textDirty = false;
      publishText(el.buffer.value);
    }, TEXT_DEBOUNCE);
  });

  el.copyTextBtn.addEventListener('click', async () => {
    const ok = await copyText(el.buffer.value);
    toast(ok ? 'Copied to clipboard' : 'Copy failed', ok ? 'ok' : 'err');
  });

  el.formatBtn.addEventListener('click', () => {
    const raw = el.buffer.value;
    if (!raw.trim()) { toast('Buffer is empty', 'err'); return; }
    try {
      const parsed = JSON.parse(raw);
      el.buffer.value = JSON.stringify(parsed, null, 2);
      updateCounter();
      if (!applyingRemote) publishText(el.buffer.value);
      toast('JSON formatted', 'ok');
    } catch {
      toast('Not valid JSON', 'err');
    }
  });

  el.clearBtn.addEventListener('click', () => {
    if (!el.buffer.value && manifest.length === 0) { toast('Buffer already empty'); return; }
    if (!confirm('Clear the buffer on ALL connected devices?')) return;
    el.buffer.value = '';
    updateCounter();
    publishText('');
    // clear files
    manifest = [];
    fileBodies.clear();
    publishManifest();
    renderFiles(true);
    toast('Buffer cleared', 'ok');
  });

  el.qrTextBtn.addEventListener('click', () => {
    const text = el.buffer.value;
    if (!text.trim()) { toast('Nothing to encode', 'err'); return; }
    renderQR(el.textQr, text);
    el.qrModal.classList.add('show');
  });
  el.closeQrBtn.addEventListener('click', () => el.qrModal.classList.remove('show'));

  /* =====================================================================
     Files mode
     ===================================================================== */
  async function fileToDataUrl(file) {
    if (file.size > MAX_FILE_BYTES) {
      toast(`"${file.name}" exceeds 8 MB limit`, 'err');
      return null;
    }
    if (file.type.startsWith('image/')) {
      try {
        const compressed = await compressImage(file);
        return compressed;
      } catch { /* fall back to raw */ }
    }
    return await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }

  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        const scale = Math.min(1, IMG_MAX_DIM / Math.max(width, height));
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        URL.revokeObjectURL(url);
        // PNG if transparency, else JPEG
        const isPng = file.type === 'image/png' || file.type === 'image/webp';
        canvas.toBlob(
          (blob) => {
            if (!blob) return reject(new Error('compress failed'));
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = reject;
            r.readAsDataURL(blob);
          },
          isPng ? 'image/png' : 'image/jpeg',
          IMG_QUALITY
        );
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('img load failed')); };
      img.src = url;
    });
  }

  async function addFiles(fileList) {
    for (const file of fileList) {
      const dataUrl = await fileToDataUrl(file);
      if (!dataUrl) continue;
      const id = 'f_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const meta = { id, name: file.name, type: file.type || 'application/octet-stream', size: file.size, ts: Date.now() };
      fileBodies.set(id, dataUrl);
      manifest.push(meta);
      publishFileBody(id, dataUrl);
      publishManifest();
      renderFiles(true, id);
    }
  }

  function iconFor(type, name) {
    if (type.startsWith('image/')) return 'IMG';
    if (type.startsWith('audio/')) return 'MP3';
    if (type.startsWith('video/')) return 'MP4';
    if (type === 'application/pdf') return 'PDF';
    if (/\.(docx?|word)$/i.test(name) || type.includes('word')) return 'DOC';
    return 'FILE';
  }

  function renderFiles(relayout, freshId) {
    el.filesEmpty.style.display = manifest.length ? 'none' : 'block';
    // remove stale cards
    [...el.filesGrid.querySelectorAll('.file-card')].forEach((c) => {
      const id = c.dataset.id;
      if (!manifest.find((m) => m.id === id)) c.remove();
    });

    manifest.forEach((m) => {
      let card = el.filesGrid.querySelector(`.file-card[data-id="${m.id}"]`);
      const body = fileBodies.get(m.id);
      const ready = !!body;
      if (!card) {
        card = document.createElement('div');
        card.className = 'file-card';
        card.dataset.id = m.id;
        el.filesGrid.appendChild(card);
      }
      if (freshId === m.id) card.classList.add('fresh');
      card.classList.toggle('selected', selectedFileId === m.id);

      let inner = '';
      const tag = iconFor(m.type, m.name);
      if (ready && m.type.startsWith('image/')) {
        inner = `<img src="${body}" alt="${escapeHtml(m.name)}" loading="lazy" />`;
      } else if (ready && m.type.startsWith('audio/')) {
        inner = `<audio controls src="${body}"></audio>`;
      } else if (ready && m.type.startsWith('video/')) {
        inner = `<video controls src="${body}" playsinline></video>`;
      } else if (ready && m.type === 'application/pdf') {
        inner = `<iframe class="pdf-embed" src="${body}"></iframe>`;
      } else if (ready && tag === 'DOC') {
        inner = `<div class="filetype">DOC</div>`;
      } else if (!ready) {
        inner = `<div class="filetype" style="color:var(--muted)">…</div>`;
      } else {
        inner = `<div class="filetype">${tag}</div>`;
      }

      card.innerHTML = `
        <span class="badge-new">NEW</span>
        <div class="thumb">${inner}</div>
        <div class="meta">
          <div class="name">${escapeHtml(m.name)}</div>
          <div class="size">${tag} · ${fmtBytes(m.size)}</div>
        </div>
        <div class="card-actions">
          <button class="btn dl" title="Download">↓</button>
          <button class="btn fs" title="Fullscreen">⤢</button>
          ${m.type.startsWith('image/') ? '<button class="btn cp" title="Copy">⧉</button>' : ''}
        </div>`;

      card.onclick = (e) => {
        if (e.target.closest('button')) return;
        selectFile(m.id);
      };
      card.querySelector('.dl').onclick = (e) => { e.stopPropagation(); downloadFile(m); };
      card.querySelector('.fs').onclick = (e) => { e.stopPropagation(); openFullscreen(m); };
      const cp = card.querySelector('.cp');
      if (cp) cp.onclick = async (e) => { e.stopPropagation(); selectFile(m.id); const ok = await copyImage(body); toast(ok ? 'Image copied' : 'Copy failed', ok ? 'ok' : 'err'); };
    });

    updateFileButtons();
  }

  function selectFile(id) {
    selectedFileId = id;
    el.filesGrid.querySelectorAll('.file-card').forEach((c) => c.classList.toggle('selected', c.dataset.id === id));
    updateFileButtons();
  }

  function updateFileButtons() {
    const m = manifest.find((x) => x.id === selectedFileId);
    const ready = m && fileBodies.get(m.id);
    el.copyImgBtn.disabled = !(m && m.type.startsWith('image/') && ready);
    el.downloadBtn.disabled = !ready;
    el.fullscreenBtn.disabled = !(m && ready && (m.type.startsWith('image/') || m.type.startsWith('video/')));
  }

  function downloadFile(m) {
    const body = fileBodies.get(m.id);
    if (!body) return;
    const a = document.createElement('a');
    a.href = body; a.download = m.name || 'droppad-file';
    document.body.appendChild(a); a.click(); a.remove();
    toast('Download started', 'ok');
  }

  function openFullscreen(m) {
    const body = fileBodies.get(m.id);
    if (!body) return;
    let node;
    if (m.type.startsWith('image/')) node = `<img src="${body}" alt="" />`;
    else if (m.type.startsWith('video/')) node = `<video src="${body}" controls autoplay playsinline></video>`;
    else return;
    el.fsContent.innerHTML = node;
    el.fsStage.classList.add('show');
    const elx = el.fsContent.firstElementChild;
    if (elx && elx.requestFullscreen) {
      el.fsStage.requestFullscreen?.().catch(() => {});
    }
  }
  el.fsClose.addEventListener('click', () => {
    el.fsStage.classList.remove('show');
    el.fsContent.innerHTML = '';
    if (document.fullscreenElement) document.exitFullscreen?.();
  });

  el.copyImgBtn.addEventListener('click', async () => {
    const m = manifest.find((x) => x.id === selectedFileId);
    if (!m) return;
    const ok = await copyImage(fileBodies.get(m.id));
    toast(ok ? 'Image copied to clipboard' : 'Copy failed', ok ? 'ok' : 'err');
  });
  el.downloadBtn.addEventListener('click', () => {
    const m = manifest.find((x) => x.id === selectedFileId);
    if (m) downloadFile(m);
  });
  el.fullscreenBtn.addEventListener('click', () => {
    const m = manifest.find((x) => x.id === selectedFileId);
    if (m) openFullscreen(m);
  });

  /* dropzone + picker + paste */
  el.dropzone.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', (e) => { addFiles(e.target.files); el.fileInput.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) =>
    el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.remove('drag'); }));
  el.dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
  // paste anywhere
  window.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const it of items) {
      if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); }
    }
    if (files.length) { addFiles(files); toast('Pasted ' + files.length + ' file(s)', 'ok'); }
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* =====================================================================
     Tabs
     ===================================================================== */
  function switchTab(name) {
    const isText = name === 'text';
    el.tabText.classList.toggle('active', isText);
    el.tabFiles.classList.toggle('active', !isText);
    el.panelText.classList.toggle('active', isText);
    el.panelFiles.classList.toggle('active', !isText);
  }
  el.tabText.addEventListener('click', () => switchTab('text'));
  el.tabFiles.addEventListener('click', () => switchTab('files'));

  /* =====================================================================
     Pair / Join modal + QR
     ===================================================================== */
  function renderQR(container, text) {
    container.innerHTML = '';
    try {
      // typeNumber 0 = automatic sizing (handles long URLs/text)
      const qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      container.innerHTML = qr.createImgTag(6, 8);
    } catch (e) {
      container.innerHTML = '<div style="color:#0f172a;padding:20px;font-size:12px">Text too large for QR</div>';
    }
  }

  function joinUrl(r) {
    const u = new URL(location.href);
    u.searchParams.set('room', r);
    return u.toString();
  }

  function openPair() {
    el.pairPin.textContent = room;
    el.pairLink.value = joinUrl(room);
    renderQR(el.pairQr, joinUrl(room));
    el.pairModal.classList.add('show');
  }
  function closePair() { el.pairModal.classList.remove('show'); }

  el.pairBtn.addEventListener('click', openPair);
  el.closePairBtn.addEventListener('click', closePair);
  el.pairModal.addEventListener('click', (e) => { if (e.target === el.pairModal) closePair(); });

  el.copyPinBtn.addEventListener('click', async () => {
    const link = joinUrl(room);
    const ok = await copyText(link);
    toast(ok ? 'Room link copied' : 'Copy failed', ok ? 'ok' : 'err');
  });
  el.copyLinkBtn.addEventListener('click', async () => {
    const ok = await copyText(el.pairLink.value);
    toast(ok ? 'Room link copied' : 'Copy failed', ok ? 'ok' : 'err');
  });

  el.joinBtn.addEventListener('click', () => {
    const v = (el.joinInput.value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (v.length < 4) { toast('Enter a valid room code', 'err'); return; }
    joinRoom(v);
    closePair();
  });
  el.joinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.joinBtn.click(); });

  el.newRoomBtn.addEventListener('click', () => {
    const nr = genRoom();
    joinRoom(nr);
    openPair();
    toast('New room: ' + nr, 'ok');
  });

  /* =====================================================================
     Room lifecycle
     ===================================================================== */
  function joinRoom(r) {
    room = r;
    localStorage.setItem('droppad_room', room);
    // update URL without reload
    const u = new URL(location.href);
    u.searchParams.set('room', room);
    history.replaceState(null, '', u);
    // reset state, avoid a stray reconnect racing the new connection
    clearTimeout(reconnectTimer);
    if (client) { manualClose = true; try { client.end(true); } catch {} manualClose = false; }
    connected = false;
    peers.clear();
    fileBodies.clear();
    manifest = [];
    selectedFileId = null;
    renderFiles(true);
    el.buffer.value = ''; updateCounter();
    connect();
  }

  function initRoom() {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('room');
    const fromStore = localStorage.getItem('droppad_room');
    const r = (fromUrl || fromStore || genRoom()).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || genRoom();
    joinRoom(r);
  }

  /* =====================================================================
     Boot
     ===================================================================== */
  function boot() {
    updateCounter();
    initRoom();
    // service worker
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW register failed', e));
      });
    }
    // install prompt
    let deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; });
    // online/offline network hints
    window.addEventListener('offline', () => { if (!connected) setStatus('offline', 'Offline'); });
  }

  boot();
})();
