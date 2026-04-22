# Anvil Audio Lab

A web-based audio mix inspector and offline mastering tool for Cubase
(and any DAW). Drop in a WAV export, pick your genre, and get an instant
report on loudness, spectral balance, stereo image, dynamics, and phase
health. Then drop it on the Mastering page for reference-matched EQ,
tilt shaping, and loudness control.

---

## Setup

**1. Install Python 3.10+** if you don't have it: https://python.org

**2. Install ffmpeg** (for accurate true peak and LRA measurement):
- Windows: download from https://ffmpeg.org/download.html and add to PATH
- Or with winget: `winget install ffmpeg`

**3. Install Python dependencies:**
```bash
pip install -r requirements.txt
```

**3. Run the server:**
```bash
python app.py
```

**4. Open your browser at:**
```
http://localhost:5000
```

---

## Workflow with Cubase

1. In Cubase: **File → Export → Audio Mixdown**
   - Format: WAV, 32-bit float (or 24-bit)
   - Sample rate: 44.1 or 48 kHz
   - Stereo interleaved

2. Drop the exported WAV into Anvil Audio Lab.

3. Pick your genre for appropriate spectral targets.

4. Optionally add a reference track (a commercial release in your genre).

5. Read the report — fix issues in Cubase — re-export — repeat.

---

## What it measures

| Section | What you get |
|---------|-------------|
| **Loudness** | Integrated LUFS, true peak, crest factor, streaming delta |
| **Spectrum** | Per-band character vs pink noise and vs genre norms (Sub / Bass / Low-mid / Mid / Presence / Air) |
| **Dynamics** | RMS variance, transient density, headroom |
| **Stereo** | L/R correlation, mid/side ratio, mono compatibility |
| **Reference** | Band-by-band delta vs your reference track |

### How spectrum numbers work

Per-band values are reported on a **"dB vs pink noise at the same overall loudness"** scale:

- **0 dB** = neutral (matches pink noise in that band)
- **+N dB** = brighter than neutral in that band
- **−N dB** = darker than neutral in that band

Genre targets are on the same scale. For example, `progrock.air = −5` means "prog rock masters are typically 5 dB darker than neutral in the air band." The delta you see is `vs_pink − target`, i.e. how your mix compares to the genre norm.

This is independent of overall loudness — a mix at −14 LUFS and the same mix at −20 LUFS produce the same spectrum readout.

---

## Pages

- **`/`** — Mix analysis (main page). Drop a stereo bounce, get full report
  with waveform+LUFS timeline, spectral balance vs genre targets, dynamics,
  stereo image, frequency cutoff detection, per-section breakdown, AI
  advice, version diffing.
- **`/stems`** — Stem masking analysis. Drop multiple stems, see the masking
  matrix, band-level conflicts, per-channel EQ cut recommendations, version
  diffing.
- **`/master`** — Offline mastering. Drop a stereo bounce, get a proposed
  mastering chain (loudness, true-peak limiter, tilt, M/S bass + air,
  reference matching, genre matching), approve each step with numeric
  controls, A/B against source, export WAV 24-bit with metadata tagging.
- **`/release`** — Release check. Drop a finished master and verify it meets
  delivery specs for Spotify / YouTube / Bandcamp (LUFS, true peak, LRA,
  crest, correlation, mono-bass, frequency cutoff).

---

## Project structure

```
anvil_audio_lab/
├── app.py                 # Flask server — all routes
├── mix_analyzer.py        # Mix analysis engine (LUFS, spectrum, dynamics, stereo)
├── stem_analyzer.py       # Stem masking engine
├── master_engine.py       # Mastering DSP chain + release check + analyzers
├── ai_advisor.py          # Claude API advice layer (optional)
├── requirements.txt
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
│       └── anvil-picker.js # Shared "sticky folder" file picker utility
├── uploads/               # Temp files for /analyze + /analyze-stems (auto-cleaned)
├── reports/               # Saved mix + stem reports (JSON)
├── master_uploads/        # Mastering source files (24h TTL, auto-cleaned)
└── master_reports/        # Saved mastering reports (JSON)
```

---

## AI advice

Set the `ANTHROPIC_API_KEY` environment variable to enable the AI advisor
panel on the mix analysis page. Without a key, the rest of the app works
normally — just no AI suggestions.

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
python app.py
```
