# DropPad

[![PWA](https://img.shields.io/badge/PWA-installable-blue)](manifest.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](#license)
[![Platform](https://img.shields.io/badge/platform-Web%20%2F%20Mobile-lightgrey)](#)

**DropPad** is a clean, dark-mode **Progressive Web App** that works as a real-time,
cross-device sync buffer for **text / code** and **images & files** between a PC and a phone.
No account, no app store — open the same room link on two devices and they stay in sync instantly.

---

## ✨ Features

- **Real-time sync** — every keystroke and every dropped file is pushed to all devices in the room.
- **Pairing** by a short room code (e.g. `K7P2Q9`) or by scanning a QR code that opens the app
  already joined to the room.
- **Text / Code tab** — large live-synced `<textarea>`, word/char counter, Copy to Clipboard (with
  toast), Generate-QR-of-text, Format-JSON, and Clear Buffer.
- **Images & Files tab** — drag-and-drop, paste-from-clipboard, or file picker. Live preview of
  images, MP3, MP4, PDF, and Word docs, with Copy / Download / Fullscreen per file.
- **Offline-ready PWA** — installable to the home screen; a service worker caches all assets so the
  UI loads with no network (live sync resumes automatically when back online).
- Modern dark UI (slate gray, cyan/emerald accents), fully responsive.

---

## 🧠 How the sync works (WebRTC, peer-to-peer)

Unlike a broker-based approach, DropPad transfers data **directly between devices** over a
WebRTC data channel (via [PeerJS](https://peerjs.com/)). There is **no message broker**, so there
are no payload-size caps and no shared-server throttling — large images and video stream straight
from one device to the other, automatically chunked by the data channel.

Devices in a room form a **star topology**:

```
        Phone ──┐
                ├──►  Host (room code = its PeerJS id)  ◄──► PC
        Tablet ─┘        relays every change to all peers
```

- The **first device** to open a room claims the room code as its PeerJS id and becomes the **host**.
- Every other device **joins** by connecting to that id. Whoever opens the room first is the host;
  if a second device also tries to claim the id, it automatically falls back to joiner mode.
- The **host relays** each change (text edit, file add, clear) to all other connected peers, so a
  2-device or N-device session stays consistent.
- A **late joiner** receives the full buffer (text + file manifest + every file body) the moment its
  connection opens, so it is instantly in sync — no designated "host buffer" to copy manually.
- **Presence/offline** is derived from live WebRTC connections; the header shows the device count and
  an Active-Sync / Connecting / Offline indicator.

> Signaling (the initial "hello, connect me") uses the PeerJS cloud by default. Only signaling goes
> through it — all buffer data is peer-to-peer. You can self-host the signaling server (see Config).

---

## 🚀 Quick start

```bash
cd droppad
python3 -m http.server 8080
# open http://localhost:8080 in a real browser (not a sandboxed preview iframe)
```

Open the same URL (or scan the **Pair Device** QR) on a second device and they sync.

---

## 🌐 Deployment

Service workers, clipboard, and installability require **HTTPS** (not `file://`, and not plain
`http://` on a phone). Easy hosting:

- **Static hosts:** Netlify, Vercel, GitHub Pages, Cloudflare Pages — drop the `droppad/` folder.
- **Tunnel:** `npx serve` behind `ngrok http 8080` or `cloudflared tunnel`.

Open the deployed HTTPS URL on both devices (or scan the Pair QR) and they sync.

---

## ⚙️ Configuration

Constants at the top of `app.js`:

| Constant | Default | Notes |
|----------|---------|-------|
| `SIGNALING` | `null` (PeerJS cloud) | Set to `{ host, port, path, secure }` to use your own PeerJS signaling server. |
| `MAX_FILE_BYTES` | `15 * 1024 * 1024` | Per-file cap (P2P can handle more; kept sane for mobile memory). |
| `IMG_MAX_DIM` | `1600` | Long-edge resize before upload. |
| `IMG_QUALITY` | `0.82` | JPEG compression quality. |
| `TEXT_DEBOUNCE` | `120` ms | Debounce before publishing text. |

---

## 📁 Project layout

```
droppad/
├── index.html          UI markup
├── styles.css          dark-mode theme (slate + cyan/emerald)
├── app.js              WebRTC sync engine + all interactions
├── sw.js               offline service worker
├── manifest.json       PWA manifest
├── vendor/
│   ├── peerjs.min.js   PeerJS — WebRTC signaling + data channel
│   └── qrcode.js       QR code generator
├── icons/              generated PWA icons (192 / 512 / maskable)
└── gen_icons.py        icon generator (Pillow)
```

---

## 📝 Known limitations

- **Star topology:** the host must stay online for peers to exchange updates. If the host leaves,
  joiners keep retrying and will reconnect automatically when a host returns. For always-on relay,
  keep one device (or a tiny headless peer) in the room.
- **Signaling dependency:** the default PeerJS cloud handles signaling only. Self-host
  `SIGNALING` for full control / privacy.
- **PDF/Word preview is best-effort:** PDFs render in an embed; Word docs show a card with a
  download button (browsers cannot inline-preview `.docx`).
- Treat synced content as private to the room; anyone with the room code can join.

---

## 📜 License

MIT — free to use, modify, and deploy.
