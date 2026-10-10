<p align="center">
  <img src="public/assets/icon.png" width="128" alt="Rich Downloader logo">
</p>

# Rich Downloader

A browser-ready, installable media downloader (PWA) with a constrained same-origin HTTP and download gateway. The application supports media analysis for TikTok, Instagram, YouTube, Twitter/X, Spotify, Apple Music, Pinterest, Facebook, Threads, Bandcamp, Pixiv, Bilibili, Douyin, RedNote, Reddit, and TeraBox.

This web distribution is based on [Mori](https://github.com/coflyn/Mori) and remains licensed under GPL-3.0-or-later.

## Features

- Responsive browser UI and installable PWA
- Multi-platform media analysis
- Browser downloads with Blob and direct-link fallbacks
- Same-origin HTTP and media gateway for browser CORS compatibility
- HTTPS hostname allowlist, private-network blocking, redirect limits, and response-size limits
- Local history, settings, themes, languages, and PIN privacy lock
- Zero runtime npm dependencies
- Ready for Vercel Functions deployment

## Requirements

- Node.js 22 or later
- A current Chromium, Firefox, or Safari browser

## Local development

```bash
npm run dev
```

Open `http://localhost:4173`.

## Production build

```bash
npm run build
npm run preview
```

The deployable static output is generated in `dist/`. The Node server is still required for the same-origin gateway.

## Deploy to Vercel

The repository includes `vercel.json` and three Node.js functions under `api/`.

```bash
npm install --global vercel
vercel login
vercel        # Preview deployment
vercel --prod # Production deployment
```

No GitHub integration is required when deploying with the Vercel CLI. The CLI uploads the current local directory.

Optional environment variables:

- `MORI_PROXY_HOSTS`: comma-separated additional trusted hostname suffixes.
- `MORI_MAX_DOWNLOAD_BYTES`: maximum gateway download size in bytes.
- `PORT`: local server port; defaults to `4173`.

Large proxied downloads remain subject to the duration and transfer limits of the deployment provider. The frontend attempts a direct browser download when the gateway is unavailable.

## Project structure

```text
api/               Vercel Function entry points
public/            Browser application and PWA assets
web/build.mjs      Dependency-free production build
server.js          Local server and shared gateway handler
vercel.json        Vercel build/function configuration
```

## Browser limitations

Browsers cannot automatically scan the Downloads directory, so the in-app Gallery does not list files downloaded by the browser. Use the browser download manager for saved files and the History page for previously analyzed sources.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
