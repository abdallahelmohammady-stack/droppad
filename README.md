# DropPad

A clean, dark-mode **Progressive Web App** that acts as a real-time, cross-device
sync buffer for **text / code** and **images & files** between a PC and a phone.
No account, no backend to run — open the same room link on two devices and they
stay in sync instantly.

## Features

- **Real-time sync** over MQTT (secure WebSocket). Every edit in the text buffer
  or every file dropped is published as a *retained* message, so a device that
  joins later instantly receives the current state.
- **Pairing** by a short room code (e.g. `K7P2Q9`) or by scanning a QR code that
  opens the app already joined to the room.
- **Text / Code tab** — large live-synced `<textarea>`, word/char counter,
  Copy to Clipboard (toast), Generate QR of the text, Format JSON, Clear Buffer.
- **Images & Files tab** — drag-and-drop, paste-from-clipboard, or file picker.
  Live preview of images, MP3, MP4, PDF, and Word docs. Per-file Copy / Download
  / Fullscreen, plus global action buttons acting on the selected file.
- **Offline-ready PWA** — installable to the home screen, service worker caches
  all assets so the UI loads with no network. (Live sync resumes when back online.)
- Modern dark UI (slate gray, cyan/emerald accents), fully responsive.

## How the sync works

```
PC (room K7P2Q9)  ──publish──▶  MQTT broker (public, wss)  ──publish──▶  Phone (room K7P2Q9)
   ▲                                                                          │
   └────────────────────── retained messages ◀───────────────────────────────┘
```

- `droppad/<ROOM>/text`  → current text buffer (retained)
- `droppad/<ROOM>/files` → file manifest `[{id,name,type,size,ts}]` (retained)
- `droppad/<ROOM>/file/<id>` → file body as a data URL (retained)
- `droppad/<ROOM>/presence/<id>` → heartbeat so the header shows device count

Images are auto-compressed client-side (max 1600px, JPEG 0.82) before sending to
keep payloads small. Files are capped at 8 MB for the public broker.

## Run it

Any static file server works (service worker + install require `http(s)`, not `file://`):

```bash
cd droppad
python3 -m http.server 8080
# open http://localhost:8080  (use a real browser, not the sandboxed preview)
```

For **real cross-device use** the app must be served over **HTTPS** (browsers
require HTTPS for service workers, clipboard, and installability). Easy options:

- Deploy the `droppad/` folder to **Netlify / Vercel / GitHub Pages / Cloudflare Pages**.
- Or `npx serve` behind a tunnel such as `ngrok http 8080` / `cloudflared tunnel`.

Open the same URL (or scan the Pair QR) on both PC and phone, and they sync.

## Configuration

Edit the constants at the top of `app.js`:

- `BROKERS` — list of `wss://` MQTT endpoints. The default uses the free public
  **EMQX** broker with a **Mosquitto** fallback. Swap in your own broker
  (e.g. a self-hosted EMQX, HiveMQ Cloud, or EMQX Cloud) for privacy/scale.
- `MAX_FILE_BYTES`, `IMG_MAX_DIM`, `IMG_QUALITY` — payload/quality limits.

## Project layout

```
droppad/
  index.html        UI markup
  styles.css        dark-mode theme
  app.js            sync engine + all interactions
  sw.js             offline service worker
  manifest.json     PWA manifest
  vendor/
    mqtt.min.js     MQTT.js (real-time transport)
    qrcode.js       QR code generator
  icons/            generated PWA icons (192 / 512 / maskable)
  gen_icons.py      icon generator (Pillow)
```

## Notes / limitations

- The public broker is shared infrastructure; rooms use a random high-entropy
  code, but treat synced content as semi-public. Use a private broker for
  sensitive data.
- Very large videos may exceed the payload cap; for big media, a WebRTC/P2P
  relay (host-and-peer model) would be the next step.
- PDF/Word preview is best-effort: PDFs render in an embed; Word docs show a card
  with a download button (browsers can't inline-preview `.docx`).
