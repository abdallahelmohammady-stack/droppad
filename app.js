/* =====================================================================
   DropPad — real-time cross-device sync buffer (PWA)
   Transport: WebRTC peer-to-peer via PeerJS (data channel).
   Devices in a "room" form a star: the first device to open the room
   becomes the host (its PeerJS id == room code) and relays to others.
   Data flows directly device↔device, so there are NO broker size caps
   and large files are auto-chunked by the WebRTC data channel.
   ===================================================================== */
(() => {
  'use strict';

  /* ---------- Config ---------- */
  // null = PeerJS public cloud (signaling only; data is P2P).
  // For self-hosting, set e.g. { host: 'signaling.example.com', port: 443, path: '/', secure: true }
  const SIGNALING = null;
  const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB (P2P chunks large files; raise further if needed)
  const IMG_MAX_DIM = 1600;
  const IMG_QUALITY = 0.82;
  const TEXT_DEBOUNCE = 120;
  const HOST_RETRY_MS = 3000;

  const CLIENT_ID = 'dp_' + Math.random().toString(36).slice(2, 10);

  /* ---------- DOM ---------- */
  const $ = (s) => document.querySelector(s);
  const el = {
    status: $('#status'), statusLabel: $('#statusLabel'),
    pairBtn: $('#pairBtn'),
    tabChat: $('#tabChat'), tabText: $('#tabText'), tabFiles: $('#tabFiles'),
    panelChat: $('#panelChat'), panelText: $('#panelText'), panelFiles: $('#panelFiles'),
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
  let peer = null;
  let myId = null;
  let iAmHost = false;
  let peerOnline = false;
  const conns = new Map();          // peerId -> DataConnection
  let applyingRemote = false;
  let textDirty = false;
  const fileBodies = new Map();     // id -> dataURL
  let manifest = [];                // [{id,name,type,size,ts}]
  let selectedFileId = null;
  let hostRetry = null;

  /* =====================================================================
     Utilities
     ===================================================================== */
  function genRoom() {
    // 🔢 رمز الغرفة أرقام بس (6 خانات) — أسهل في النطق والكتابة على الموبايل
    let s = '';
    const a = new Uint32Array(6);
    crypto.getRandomValues(a);
    for (let i = 0; i < 6; i++) s += String(a[i] % 10);
    return s;
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
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch {}
      ta.remove(); return ok;
    }
  }
  async function copyImage(dataUrl) {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      return true;
    } catch { return false; }
  }

  function peerOpen() { return peer && peer.open && myId; }

  /* =====================================================================
     Status / presence
     ===================================================================== */
  function setStatus(state, label) {
    el.status.className = 'status ' + state;
    el.statusLabel.textContent = label;
  }
  function updatePeerCount() {
    if (!peerOnline) { setStatus('offline', 'Offline'); return; }
    const n = conns.size + 1;
    if (iAmHost) {
      setStatus('online', n > 1 ? `Synced · ${n} devices` : 'Synced · solo');
    } else {
      const up = [...conns.values()].some((c) => c.open);
      if (up) setStatus('online', `Synced · ${n} devices`);
      else setStatus('connecting', 'Connecting…');
    }
  }

  /* =====================================================================
     WebRTC sync engine (PeerJS)
     ===================================================================== */
  function teardownPeer() {
    clearTimeout(hostRetry);
    for (const c of conns.values()) { try { c.close(); } catch {} }
    conns.clear();
    if (peer) { try { peer.destroy(); } catch {} }
    peer = null; myId = null; iAmHost = false; peerOnline = false;
  }

  function startPeer() {
    teardownPeer();
    setStatus('connecting', 'Connecting…');
    try {
      // Try to claim the room code as our PeerJS id → we become the host.
      peer = SIGNALING ? new Peer(room, SIGNALING) : new Peer(room);
    } catch (e) {
      becomeJoiner();
      return;
    }

    peer.on('open', (id) => {
      myId = id;
      peerOnline = true;
      if (id === room) {
        iAmHost = true;
        toast('Room ready — share the code', 'ok');
      } else {
        iAmHost = false;
        connectToHost(room);
      }
      updatePeerCount();
    });

    peer.on('connection', (conn) => setupConn(conn));

    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') {
        // Room id already taken → someone is hosting; become a joiner.
        try { peer.destroy(); } catch {}
        becomeJoiner();
      } else if (err.type === 'peer-unavailable') {
        scheduleReconnectHost();
      } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
        setStatus('offline', 'Offline');
        scheduleReconnectHost();
      } else {
        console.warn('peer error', err && err.type, err);
        scheduleReconnectHost();
      }
    });

    peer.on('disconnected', () => {
      // Lost signaling link; PeerJS can reconnect it.
      try { peer.reconnect(); } catch {}
    });
  }

  function becomeJoiner() {
    setStatus('connecting', 'Joining…');
    peer = SIGNALING ? new Peer(undefined, SIGNALING) : new Peer();
    peer.on('open', (id) => {
      myId = id; iAmHost = false; peerOnline = true;
      connectToHost(room);
      updatePeerCount();
    });
    peer.on('connection', (conn) => setupConn(conn));
    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') scheduleReconnectHost();
      else { console.warn('joiner peer error', err); setStatus('offline', 'Offline'); scheduleReconnectHost(); }
    });
    peer.on('disconnected', () => { try { peer.reconnect(); } catch {} });
  }

  function connectToHost() {
    if (!peerOpen()) return;
    const existing = conns.get(room);
    if (existing && existing.open) return;
    const conn = peer.connect(room, { reliable: true, metadata: { from: myId } });
    setupConn(conn);
    scheduleReconnectHost();
  }

  function scheduleReconnectHost() {
    clearTimeout(hostRetry);
    hostRetry = setTimeout(() => { if (!iAmHost) connectToHost(); }, HOST_RETRY_MS);
  }

  function setupConn(conn) {
    conn.on('open', () => {
      conns.set(conn.peer, conn);
      if (iAmHost) sendState(conn);            // late joiner gets the full buffer immediately
      else conn.send({ t: 'hello', from: myId });
      // 💬 الشات: ابعت سجل الرسائل للداخل الجديد
      if (window.DropPadBus && window.DropPadBus.onPeerJoin) window.DropPadBus.onPeerJoin(conn);
      updatePeerCount();
    });
    conn.on('data', (d) => handleData(d, conn));
    conn.on('close', () => { conns.delete(conn.peer); updatePeerCount(); });
    conn.on('error', (e) => console.warn('conn error', e));
  }

  // Host pushes current text + manifest, then every file body.
  function sendState(conn) {
    conn.send({ t: 'state', from: myId, text: el.buffer.value, manifest });
    for (const m of manifest) {
      const data = fileBodies.get(m.id);
      if (data) conn.send({ t: 'file', from: myId, id: m.id, data });
    }
  }

  function handleData(d, conn) {
    if (!d || typeof d !== 'object' || d.from === myId) return;
    // 💬 جسر الشات: أي رسالة chat:* بتروح لمحرك الشات، والهوست بيعيد بثها
    if (typeof d.t === 'string' && d.t.startsWith('chat:')) {
      if (window.DropPadBus && window.DropPadBus.onChat) window.DropPadBus.onChat(d);
      if (iAmHost) relay(d, conn);
      return;
    }
    switch (d.t) {
      case 'text':
        applyingRemote = true;
        el.buffer.value = d.v;
        updateCounter(); flashSynced(); applyingRemote = false;
        if (iAmHost) relay(d, conn);
        break;
      case 'files':
        manifest = Array.isArray(d.v) ? d.v : [];
        renderFiles(true);
        if (iAmHost) relay(d, conn);
        break;
      case 'file':
        fileBodies.set(d.id, d.data);
        renderFiles(false);
        if (iAmHost) relay(d, conn);
        break;
      case 'state':
        applyingRemote = true;
        el.buffer.value = d.text || '';
        updateCounter(); applyingRemote = false;
        manifest = Array.isArray(d.manifest) ? d.manifest : [];
        renderFiles(true);
        break;
      default: break;
    }
  }

  function relay(d, fromConn) {
    for (const [pid, c] of conns) if (c !== fromConn && c.open) c.send(d);
  }

  function broadcast(msg) {
    msg.from = myId;
    for (const c of conns.values()) if (c.open) c.send(msg);
  }
  function publishText(text) { broadcast({ t: 'text', v: text }); }
  function publishManifest() { broadcast({ t: 'files', v: manifest }); }
  function publishFileBody(id, data) { broadcast({ t: 'file', id, data }); }

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
    textTimer = setTimeout(() => { textDirty = false; publishText(el.buffer.value); }, TEXT_DEBOUNCE);
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
    } catch { toast('Not valid JSON', 'err'); }
  });

  el.clearBtn.addEventListener('click', () => {
    if (!el.buffer.value && manifest.length === 0) { toast('Buffer already empty'); return; }
    if (!confirm('Clear the buffer on ALL connected devices?')) return;
    el.buffer.value = '';
    updateCounter();
    publishText('');
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
    if (file.size > MAX_FILE_BYTES) { toast(`"${file.name}" exceeds ${fmtBytes(MAX_FILE_BYTES)} limit`, 'err'); return null; }
    if (file.type.startsWith('image/')) {
      try { return await compressImage(file); } catch { /* fall back to raw */ }
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
        const isPng = file.type === 'image/png' || file.type === 'image/webp';
        canvas.toBlob((blob) => {
          if (!blob) return reject(new Error('compress failed'));
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = reject;
          r.readAsDataURL(blob);
        }, isPng ? 'image/png' : 'image/jpeg', IMG_QUALITY);
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
      if (ready && m.type.startsWith('image/')) inner = `<img src="${body}" alt="${escapeHtml(m.name)}" loading="lazy" />`;
      else if (ready && m.type.startsWith('audio/')) inner = `<audio controls src="${body}"></audio>`;
      else if (ready && m.type.startsWith('video/')) inner = `<video controls src="${body}" playsinline></video>`;
      else if (ready && m.type === 'application/pdf') inner = `<iframe class="pdf-embed" src="${body}"></iframe>`;
      else if (ready && tag === 'DOC') inner = `<div class="filetype">DOC</div>`;
      else if (!ready) inner = `<div class="filetype" style="color:var(--muted)">…</div>`;
      else inner = `<div class="filetype">${tag}</div>`;

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
          <button class="btn del" title="Remove file">✕</button>
        </div>`;

      card.onclick = (e) => { if (e.target.closest('button')) return; selectFile(m.id); };
      card.querySelector('.dl').onclick = (e) => { e.stopPropagation(); downloadFile(m); };
      card.querySelector('.fs').onclick = (e) => { e.stopPropagation(); openFullscreen(m); };
      card.querySelector('.del').onclick = (e) => { e.stopPropagation(); removeFile(m); };
      const cp = card.querySelector('.cp');
      if (cp) cp.onclick = async (e) => {
        e.stopPropagation(); selectFile(m.id);
        const ok = await copyImage(body); toast(ok ? 'Image copied' : 'Copy failed', ok ? 'ok' : 'err');
      };
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

  function removeFile(m) {
    if (!confirm('Remove this file on all connected devices?')) return;
    manifest = manifest.filter((x) => x.id !== m.id);
    fileBodies.delete(m.id);
    if (selectedFileId === m.id) selectedFileId = null;
    publishManifest();
    renderFiles(true);
    updateFileButtons();
    toast('File removed', 'ok');
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
    if (el.fsStage.requestFullscreen) el.fsStage.requestFullscreen().catch(() => {});
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
  el.downloadBtn.addEventListener('click', () => { const m = manifest.find((x) => x.id === selectedFileId); if (m) downloadFile(m); });
  el.fullscreenBtn.addEventListener('click', () => { const m = manifest.find((x) => x.id === selectedFileId); if (m) openFullscreen(m); });

  /* dropzone + picker + paste */
  el.dropzone.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', (e) => { addFiles(e.target.files); el.fileInput.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.remove('drag'); }));
  el.dropzone.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
  window.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const it of items) if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); }
    if (files.length) { addFiles(files); toast('Pasted ' + files.length + ' file(s)', 'ok'); }
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* =====================================================================
     Tabs
     ===================================================================== */
  function switchTab(name) {
    // 💬 بقت 3 تبويبات: chat / text / files
    const map = {
      chat:  [el.tabChat,  el.panelChat],
      text:  [el.tabText,  el.panelText],
      files: [el.tabFiles, el.panelFiles]
    };
    for (const k of Object.keys(map)) {
      const [tab, panel] = map[k];
      const on = (k === name);
      if (tab) tab.classList.toggle('active', on);
      if (panel) panel.classList.toggle('active', on);
    }
  }
  if (el.tabChat) el.tabChat.addEventListener('click', () => switchTab('chat'));
  el.tabText.addEventListener('click', () => switchTab('text'));
  el.tabFiles.addEventListener('click', () => switchTab('files'));

  /* =====================================================================
     Pair / Join modal + QR
     ===================================================================== */
  function renderQR(container, text) {
    container.innerHTML = '';
    try {
      const qr = qrcode(0, 'M'); // 0 = auto size
      qr.addData(text);
      qr.make();
      container.innerHTML = qr.createImgTag(6, 8);
    } catch {
      container.innerHTML = '<div style="color:#0f172a;padding:20px;font-size:12px">Text too large for QR</div>';
    }
  }

  function joinUrl(r) { const u = new URL(location.href); u.searchParams.set('room', r); return u.toString(); }

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
    const ok = await copyText(joinUrl(room));
    toast(ok ? 'Room link copied' : 'Copy failed', ok ? 'ok' : 'err');
  });
  el.copyLinkBtn.addEventListener('click', async () => {
    const ok = await copyText(el.pairLink.value);
    toast(ok ? 'Room link copied' : 'Copy failed', ok ? 'ok' : 'err');
  });

  el.joinBtn.addEventListener('click', () => {
    const v = (el.joinInput.value || '').replace(/\D/g, '').slice(0, 6);
    if (!/^\d{6}$/.test(v)) { toast('اكتب رمز غرفة صحيح — 6 أرقام', 'err'); return; }
    joinRoom(v); closePair();
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
    const u = new URL(location.href);
    u.searchParams.set('room', room);
    history.replaceState(null, '', u);
    // reset state
    manifest = [];
    fileBodies.clear();
    selectedFileId = null;
    renderFiles(true);
    el.buffer.value = ''; updateCounter();
    startPeer();
  }

  function initRoom() {
    const fromUrl = new URLSearchParams(location.search).get('room');
    const fromStore = localStorage.getItem('droppad_room');
    const r = (fromUrl || fromStore || genRoom()).replace(/\D/g, '').slice(0, 6) || genRoom();
    joinRoom(r);
  }

  /* =====================================================================
     Boot
     ===================================================================== */
  /* 💬 جسر الشات — الواجهة اللي chat.js بيركب عليها */
  window.DropPadBus = {
    broadcast: (msg) => { msg.from = myId; for (const c of conns.values()) if (c.open) c.send(msg); },
    myId: () => myId || CLIENT_ID,
    peerCount: () => conns.size,
    toast: (m, k) => toast(m, k),
    onChat: null,
    onPeerJoin: null
  };

  function boot() {
    updateCounter();
    initRoom();
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW register failed', e));
      });
    }
    window.addEventListener('offline', () => { if (!peerOpen()) setStatus('offline', 'Offline'); });
    window.addEventListener('online', () => { if (peer && !peer.open) { try { peer.reconnect(); } catch {} } });
  }

  boot();
})();
