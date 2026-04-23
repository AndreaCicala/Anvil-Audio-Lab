# Anvil Audio Lab

> **Personal project — source is public for reference, but I'm not
> accepting contributions.** Feel free to fork it for your own use.
> See `CONTRIBUTING.md` and `LICENSE` for details.

Offline mix analyzer, mastering tool, and release check for post-rock,
prog, and metal producers. Drop in a WAV, get a full report on loudness,
spectral balance, stereo image, dynamics, phase health, and more — all
local, no uploads, no cloud.

**[📥 Download for Windows](https://github.com/AndreaCicala/Anvil-Audio-Lab/releases/latest)** · **[🌐 Landing page](https://andreacicala.github.io/Anvil-Audio-Lab/)**

---

## Install & run

### Option 1 — Windows download (easiest)

1. Download `AnvilAudioLab-v0.2.0-win-x64.zip` from the [latest release](https://github.com/AndreaCicala/Anvil-Audio-Lab/releases/latest).
2. Unzip anywhere (Desktop, Documents, Program Files — your choice).
3. Double-click `AnvilAudioLab\AnvilAudioLab.exe`.
4. A browser tab opens at `http://localhost:5000`.

No installer. No Python. No ffmpeg to install — it's all bundled.
First launch is slow (~20s) while Windows Defender scans the folder.
Subsequent launches are fast.

### Option 2 — Run from source (macOS, Linux, or development)

Requirements: Python 3.10+, ffmpeg in PATH.

```bash
# ffmpeg — one of the following:
winget install ffmpeg         # Windows
brew install ffmpeg           # macOS
sudo apt install ffmpeg       # Debian/Ubuntu

# Project
git clone https://github.com/AndreaCicala/Anvil-Audio-Lab.git
cd Anvil-Audio-Lab
pip install -r requirements.txt
python app.py
```

Open `http://localhost:5000`.

### Optional — enable the AI advisor

Copy `.env.example` to `.env` and add your Anthropic API key:

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

Without a key, the app works normally — the AI advisor card just hides itself.

---

## Workflow with Cubase (or any DAW)

1. **Export**: File → Export → Audio Mixdown
   - Format: WAV, 24-bit or 32-bit float
   - Sample rate: 44.1 or 48 kHz
   - Stereo interleaved

2. **Drop** the exported WAV on the mix analyzer page.

3. **Pick your genre** (or use auto-detect) for appropriate spectral targets.

4. **Optionally add a reference track** (a commercial release in your genre).

5. **Read the report** — fix issues in the DAW — re-export — compare versions.

---

## Pages

- **`/`** — Mix analysis. Full report with waveform+LUFS timeline, spectral
  balance vs genre targets, dynamics, stereo image, frequency cutoff
  detection, per-section breakdown, AI advice, and version diffing between
  exports.
- **`/stems`** — Stem masking. Drop multiple stems, see the masking matrix
  heatmap, per-band conflicts, and EQ cut recommendations scoped to each
  source track. Version diffing for fixes.
- **`/master`** — Offline mastering. Proposed chain (loudness, true-peak
  limiter, tilt shelf, M/S bass + air checks, 6-band EQ, reference match,
  genre match) with numeric controls. A/B against source, export 24-bit
  WAV with metadata tagging.
- **`/release`** — Release check. Verify a finished master against Spotify,
  YouTube, or Bandcamp delivery specs: LUFS, true peak, LRA, crest factor,
  L/R correlation, mono-bass, frequency cutoff.

---

## What it measures

| Section | What you get |
|---------|--------------|
| **Loudness** | Integrated LUFS, true peak, crest factor, LRA, streaming delta |
| **Spectrum** | Per-band character vs pink noise and vs genre norms (Sub / Bass / Low-mid / Mid / Presence / Air), plus 24 sub-bands and narrow-resonance detection |
| **Dynamics** | Transient density, headroom, K-weighted per-band crest factors |
| **Stereo** | L/R correlation, mid/side ratio, mono compatibility |
| **Frequency cutoff** | Effective audible bandwidth, % of Nyquist — catches upsampled or band-limited sources |
| **Sections** | Smart change-point detection; per-section LUFS and spectral character |
| **Reference** | Band-by-band delta vs your reference track |
| **Action summary** | 3-tier fix list: fix before bounce / worth fixing / polish |

### How spectrum numbers work

Per-band values are reported on a **"dB vs pink noise at the same overall loudness"** scale:

- **0 dB** = neutral (matches pink noise in that band)
- **+N dB** = brighter than neutral in that band
- **−N dB** = darker than neutral in that band

Genre targets are on the same scale. For example, `progrock.air = −5`
means "prog rock masters are typically 5 dB darker than neutral in the
air band." The delta you see is `vs_pink − target`, i.e. how your mix
compares to the genre norm.

This is independent of overall loudness — a mix at −14 LUFS and the same
mix at −20 LUFS produce the same spectrum readout.

---

## Updates

Click the **version chip** in the top-right nav (the `v0.2.0` pill) to
check GitHub for a newer release. If one's available, the modal shows
release notes and a download link.

The app never auto-downloads or auto-installs updates. You stay in
control of when to upgrade.

---

## Where your data lives

User data (saved reports, history, session state) is stored per-user so
it survives app updates:

- **Windows**: `%APPDATA%\AnvilAudioLab\`
- **macOS**: `~/Library/Application Support/AnvilAudioLab/`
- **Linux**: `~/.local/share/AnvilAudioLab/`

Inside:

```
AnvilAudioLab/
├── uploads/         # Temp files (auto-cleaned after each analysis)
├── reports/         # Saved mix and stem reports (JSON)
├── master_uploads/  # Mastering source files (24h TTL)
└── master_reports/  # Saved mastering reports (JSON)
```

To force project-local data paths during development, set
`ANVIL_DATA_MODE=project` before running `python app.py`.

---

## Project structure

```
anvil_audio_lab/
├── app.py                 # Flask server — all routes
├── mix_analyzer.py        # Mix analysis engine (LUFS, spectrum, dynamics, stereo, cutoff)
├── stem_analyzer.py       # Stem masking engine
├── master_engine.py       # Mastering DSP chain + release check + frequency cutoff
├── ai_advisor.py          # Claude API advice layer (optional)
├── version.py             # Single source of truth for __version__
├── requirements.txt
├── anvil_audio_lab.spec   # PyInstaller build config
├── build.ps1              # Windows build script (produces dist/AnvilAudioLab/)
├── templates/
│   ├── index.html         # Mix analysis page
│   ├── stems.html         # Stem masking page
│   ├── master.html        # Mastering page
│   └── release.html       # Release check page
├── static/
│   ├── css/style.css
│   └── js/
│       ├── app.js         # Mix page logic
│       ├── stems.js       # Stems page logic
│       ├── master.js      # Mastering page logic
│       ├── release.js     # Release check page logic
│       ├── anvil-picker.js  # Shared "sticky folder" file picker
│       └── anvil-version.js # Version chip + update checker
├── docs/                  # Landing page (served by GitHub Pages)
│   ├── index.html
│   └── images/
└── ffmpeg/                # Bundled ffmpeg.exe for Windows builds (not in git)
```

---

## Building the Windows executable

Requires: Python 3.10+ with `pyinstaller` installed, ffmpeg.exe placed at `ffmpeg/ffmpeg.exe`.

```powershell
pip install pyinstaller
./build.ps1
```

Output: `dist/AnvilAudioLab/` (842 MB folder, zips to ~307 MB).

Zip that folder, attach to a new GitHub release tagged `v{__version__}`, done.

---

## License

Source is visible for reference and learning. All rights reserved —
see [LICENSE](LICENSE) for details. Running the official compiled releases
is permitted for personal, non-commercial use.
