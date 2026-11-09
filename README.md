<p align="center">
  <h1 align="center">Desktop Photo Gallery</h1>
</p>

<p align="center">
  <b>A purely client-side photo and video browser for a folder on your own machine.</b><br>
  Pick a folder. It reads your images locally, parses capture metadata, builds thumbnails,<br>
  then gets out of the way so you can look at them.
</p>

<p align="center">
  <img alt="Client-side only" src="https://img.shields.io/badge/Client--side-zero%20dependencies-4CAF50?style=flat-square">
  <img alt="Privacy" src="https://img.shields.io/badge/Privacy-local--first%C2%B7no%20uploads-4285F4?style=flat-square">
  <img alt="IndexedDB" src="https://img.shields.io/badge/IndexedDB-local%20storage-F4B400?style=flat-square">
  <img alt="Web Worker" src="https://img.shields.io/badge/Web%20Worker-thread%20pool-0EA5E9?style=flat-square">
  <img alt="License" src="https://img.shields.io/badge/License-all%20rights%20reserved-9E9E9E?style=flat-square">
</p>

<p align="center">
  <sub>The application UI is currently in Chinese only (静照 · 本地相册). This README describes it in English.</sub>
</p>

---

## What this is

Desktop Photo Gallery is a static web app with no build step, no backend and no dependencies. You point it at a folder; it scans recursively, reads each file's header to recover dimensions and EXIF, renders thumbnails in worker threads, and lays the whole thing out in a virtualized grid.

Nothing is uploaded and nothing is sent over the network. All state — the thumbnail cache, favorites, and the handle for the library you last opened — lives in your browser's local storage.

### What it does

- **Reads photos locally** — recursively scans the folder you choose, extracting dimensions and EXIF (capture time, body, lens, aperture, shutter, ISO, focal length, orientation, GPS) and generating thumbnails
- **Plays video** — MP4 / WebM / MOV and friends are interleaved with photos in the same grid; thumbnails come from a frame at the 10% mark, click to play, space to pause
- **Browses at scale** — thousands of photos lay out instantly, with only the rows inside the viewport ever mounted in the DOM
- **Stays out of the way while you look** — zoom and pan, slideshow, EXIF panel, favorites, fullscreen; the chrome fades out after the mouse rests for 2.5 seconds

### What it doesn't do

- **No uploads** — no image or metadata ever leaves your computer. There is no server and no account.
- **No network access** — it makes no external requests at all
- **Read-only** — it will never modify, move or delete a single one of your files

## Getting started

Double-click **`start.bat`**. It starts a local static server and opens your browser.

> It has to run over a local server — you can't just double-click `index.html`. ES modules, Web Workers and IndexedDB are all blocked by browsers under `file://`.
> `start.bat` looks for Python or Node in turn; either one works.

Chrome or Edge is recommended, because they support the File System Access API, which is what lets the app remember your library and restore it in one click next time. Other browsers fall back to a folder `<input>` plus drag-and-drop; everything works the same, it just can't be remembered.

## Importing photos

Three routes, all equivalent:

- Click **Open folder** in the top right (Chrome and Edge show a native directory picker)
- **Drag a folder** into the window
- Use **Choose folder** on the empty-state screen

Subdirectories are read recursively. Hidden files and directories like `node_modules`, `.git`, `@eaDir` and the recycle bin are skipped automatically.

Supported formats are JPEG / PNG / WebP / AVIF / GIF / BMP / TIFF / HEIC for images, and MP4 / WebM / MOV / MKV / AVI for video. HEIC files yield their dimensions and EXIF, but most browsers can't decode the pixels, so those photos render as placeholder tiles. Video behaves the same way: what the browser can decode (MP4/H.264, WebM) plays directly, and what it can't (commonly MKV and AVI) is flagged as such.

## Using it

**Browsing**

| Key | Action |
| --- | --- |
| `/` | Search by file name or folder |
| `[` | Collapse or expand the sidebar |
| `T` | Toggle light / dark theme |
| `← ↑ ↓ →` | Move the selection |
| `Enter` | Open the selected item |
| `− / +` | Thumbnail size |
| `?` | Show the shortcut reference |

**Viewing**

| Key | Action |
| --- | --- |
| `← →` | Previous / next |
| `Space` | Slideshow (with a slow drift); play / pause when viewing video |
| `I` | Photo info (EXIF) |
| `S` | Favorite |
| `M` | Mute / unmute (video) |
| `F` | Fullscreen |
| `Wheel` / `double-click` | Zoom; drag to pan once zoomed in (video is excluded from zoom) |
| `0` | Fit to window |
| `Home` / `End` | First / last |
| `Esc` | Exit |

When not zoomed in, dragging left or right also turns the page, and touch screens support two-finger pinch zoom. The UI fades out 2.5 seconds after the mouse stops and returns on any movement.

Sorting (capture time / modified time / file name / size) and grouping (day / month / year / folder / none) live in the sort menu in the top bar. When grouping by time, a year scale appears along the right edge of the grid — click a year to jump straight to it.

## Structure and design

```
index.html            Shell, SVG icon sprite
start.bat             Local server launcher
server.py             Static server that adds no-store to every response
styles/
  base.css            Design tokens, light/dark themes, shared controls
  shell.css           Top bar, sidebar, empty state, drop overlay
  grid.css            Photo grid
  viewer.css          Viewer
src/
  app.js              Boot and wiring: import flow, sidebar, shortcuts
  store.js            State: filter → search → sort → group
  library.js          Three import paths (directory handle / input / drop) + folder tree
  media.js            Worker pool, two-level priority queue, LRU for object URLs
  grid.js             Virtualized grid: equal-height row layout, viewport rows only
  viewer.js           Viewer: zoom and pan, navigation, filmstrip, slideshow, EXIF panel
  db.js               IndexedDB: settings / directory handles / metadata / thumbnails / favorites
  util.js             Formatting and small helpers
workers/
  media-worker.js     File-header parsing (dimensions + EXIF) and thumbnail encoding
```

### A few decisions worth calling out

**Only the header is read.** During a scan each file contributes just its first 192 KB. The app parses JPEG SOF/APP1, PNG IHDR, WebP VP8/VP8L/VP8X, GIF and BMP by hand, along with the `ispe` box for HEIC and AVIF, pulling EXIF (capture time, body, lens, aperture, shutter, ISO, focal length, orientation, GPS) out in the same pass. No full-image decode happens, which is why thousands of photos can be laid out quickly. Photos with an EXIF orientation of 5–8 have their width and height corrected at this stage, so the layout doesn't visibly flip from landscape to portrait a moment later.

**Thumbnails are built off the main thread.** `createImageBitmap` produces the small image directly — when the source dimensions are already known, the decoder is asked to downscale as it goes, which keeps memory down — and `OffscreenCanvas` encodes it to WebP. The main thread never touches a pixel. Results are keyed in IndexedDB by `path|byteLength|modifiedTime`, so editing a file changes the fingerprint and invalidates that entry on its own; there is no expiry logic to maintain.

**The grid is virtualized.** Layout is a single O(n) pure computation, and only the rows inside the viewport exist in the DOM. Measured on 2,000 photos: the grid appeared in 0.9 s, metadata finished parsing in 9.9 s, against a 96,554 px canvas height holding just 36 tiles and 229 DOM nodes, with a 5 MB JS heap.

**A two-level priority queue.** Thumbnails you are looking at right now jump the queue (LIFO, so scrolling favors what is on screen), while background prefetching waits its turn (FIFO). When a tile scrolls out of the viewport its task is demoted rather than cancelled — the same image may be awaited elsewhere, and the work has to happen eventually anyway.

## Privacy and security

- No uploads, no network access, no account. All data (thumbnail cache, favorites, last-opened library) stays in your browser's local storage.
- Read-only. The app never modifies, moves or deletes your files.
- "Remember my last library" depends on the File System Access API (Chromium only). Restoring a library triggers a one-time permission prompt from the browser — that is a browser security requirement, not something the app can suppress.

## Known limitations

- HEIC support is metadata-only; whether the image displays depends on your browser's decoder.
- "Remember my last library" requires the File System Access API, which only Chromium-based browsers ship. Everywhere else you re-pick the folder each session.

## License

No open-source license has been declared for this project; all rights are reserved. Contact the author if you want to use it for another purpose.
