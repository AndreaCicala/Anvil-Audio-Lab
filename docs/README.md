# docs/ — Anvil Audio Lab landing page

Static site served by GitHub Pages at:
**https://andreacicala.github.io/Anvil-Audio-Lab/**

## Structure

```
docs/
├── index.html          The whole landing page (single-file, no build)
├── images/             Screenshots referenced from index.html
│   ├── mix-analysis.png
│   ├── stems.png
│   ├── master.png
│   └── release.png
└── README.md           This file
```

## Adding / replacing screenshots

The landing page references four screenshots by exact filename. Drop your
PNGs in `images/` with these names:

| Filename                 | What to capture                                   |
|--------------------------|---------------------------------------------------|
| `images/mix-analysis.png` | Main mix analysis page after a real analysis     |
| `images/stems.png`        | Stem masking page with the matrix heatmap showing |
| `images/master.png`       | Mastering page with M/S checks + EQ visible      |
| `images/release.png`      | Release check page with pass/warn statuses       |

### Screenshot tips

- **Resolution**: aim for 1400×900 or larger. The page scales them down;
  oversized source gives a sharper look on retina displays.
- **Format**: PNG preferred (sharper UI text). JPEG is fine for file size.
- **Browser chrome**: crop it out — just the page content.
- **Content**: use a real analyzed mix, not an empty page. Populated UI
  looks much more convincing than empty state.
- **File size**: under 500 KB each ideally. Use TinyPNG or similar to
  compress without visible loss.

The page has graceful fallback: if an image is missing, a placeholder box
appears in its place (not a broken-image icon).

## Local preview

Just open `index.html` in your browser. No server needed.

For a slightly more accurate preview (file:// can behave oddly with fetch):

```powershell
cd docs
python -m http.server 8000
```

Then open `http://localhost:8000`.

## Deploying

GitHub Pages is configured (via repo Settings → Pages) to serve from
`main` branch, `/docs` folder. Every push to `main` rebuilds and republishes
the site within 1–2 minutes.

## Updating release info

The page auto-fetches the latest release from the GitHub API on page load,
so the version number, release date, and download button URL update
automatically whenever you publish a new release. No manual page update
needed per release.

If the fetch fails (rate limit, network), the page falls back to the
hardcoded `v0.2.0` defaults.
