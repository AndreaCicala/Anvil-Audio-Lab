"""
mix_analyzer.py
---------------
Analyzes a stereo audio file (WAV/AIFF) and returns a structured JSON report
covering loudness, dynamics, spectral balance, stereo image, and phase health.

Usage:
    python mix_analyzer.py my_mix.wav [--genre pop] [--ref reference.wav]

Output:
    JSON report printed to stdout (redirect to a file if needed)
"""

import sys
import os
import json
import argparse
import warnings
warnings.filterwarnings("ignore")

import numpy as np
import librosa
import soundfile as sf
import pyloudnorm as pyln


# ---------------------------------------------------------------------------
# Genre-typical spectral targets (dB, relative energy per band)
# These are rough reference points — real-world targets vary by engineer.
# ---------------------------------------------------------------------------
# NOTE: GENRE_TARGETS is defined further down, after the pink-noise reference
# machinery. It uses the "dB vs pink noise at same overall loudness" scale.
# See the large comment block near _compute_pink_offsets() for the full
# explanation of why the absolute-dBFS scale was replaced.


# ---------------------------------------------------------------------------
# Genre auto-detection profiles
# Each profile defines expected ranges for key audio features.
# Scoring: each feature match adds points; highest total wins.
# ---------------------------------------------------------------------------
# Genre profiles — tuned with 5 features:
# centroid, zcr, rolloff, spectral_contrast, tilt are the strongest discriminators.
# rolloff and contrast are KEY for separating prog/postrock from pop.
GENRE_PROFILES = {
    "metal": {
        "tempo":            (100, 240),  "tempo_w": 2,   # doom to thrash
        "centroid_hz":      (600, 3000), "centroid_w": 2,
        "rolloff_hz":       (1800, 8000),"rolloff_w": 2,
        "contrast":         (12, 42),    "contrast_w": 2, # wider: dense masters = low contrast
        "sub_energy":       (-24, -8),   "sub_w": 1,
        "low_mid_energy":   (-16, -3),   "low_mid_w": 3,  # KEY: heavy guitar low-mids
        "crest_factor":     (4, 20),     "crest_w": 2,    # wider ceiling
        "zcr":              (0.025, 0.14),"zcr_w": 3,     # KEY: distortion = high zcr
        "tilt":             (-20, -4),   "tilt_w": 1,
    },
    "postrock": {
        "tempo":            (55, 145),   "tempo_w": 1,
        "centroid_hz":      (350, 1500), "centroid_w": 3,  # warm/dark
        "rolloff_hz":       (800, 3500), "rolloff_w": 3,   # KEY: dark rolloff
        "contrast":         (18, 35),    "contrast_w": 2,
        "sub_energy":       (-28, -16),  "sub_w": 1,
        "low_mid_energy":   (-16, -6),   "low_mid_w": 2,
        "crest_factor":     (8, 28),     "crest_w": 3,     # wide dynamics
        "zcr":              (0.008, 0.045),"zcr_w": 3,     # KEY: low zcr = dark
        "tilt":             (-16, -5),   "tilt_w": 2,
    },
    "progrock": {
        "tempo":            (70, 200),   "tempo_w": 1,
        "centroid_hz":      (400, 2600), "centroid_w": 3,  # widened: modern prog can be bright
        "rolloff_hz":       (1000, 6000),"rolloff_w": 3,   # widened to match centroid
        "contrast":         (20, 38),    "contrast_w": 2,
        "sub_energy":       (-26, -14),  "sub_w": 1,
        "low_mid_energy":   (-22, -6),   "low_mid_w": 2,   # widened floor: instrumental prog can be thinner
        "crest_factor":     (6, 22),     "crest_w": 2,
        "zcr":              (0.010, 0.070),"zcr_w": 3,     # widened top for brighter prog
        "tilt":             (-14, -3),   "tilt_w": 2,
    },
    "instrumental": {
        "tempo":            (55, 170),   "tempo_w": 1,
        "centroid_hz":      (400, 1800), "centroid_w": 2,
        "rolloff_hz":       (1000, 4000),"rolloff_w": 2,
        "contrast":         (18, 35),    "contrast_w": 2,
        "sub_energy":       (-28, -14),  "sub_w": 1,
        "low_mid_energy":   (-18, -6),   "low_mid_w": 1,
        "crest_factor":     (7, 24),     "crest_w": 2,
        "zcr":              (0.008, 0.060),"zcr_w": 2,
        "tilt":             (-14, -4),   "tilt_w": 2,
    },
    "rock": {
        "tempo":            (95, 185),   "tempo_w": 2,
        "centroid_hz":      (700, 2500), "centroid_w": 2,
        "rolloff_hz":       (1800, 5500),"rolloff_w": 2,
        "contrast":         (22, 40),    "contrast_w": 2,
        "sub_energy":       (-26, -14),  "sub_w": 1,
        "low_mid_energy":   (-16, -6),   "low_mid_w": 2,
        "crest_factor":     (5, 18),     "crest_w": 2,
        "zcr":              (0.018, 0.08),"zcr_w": 2,
        "tilt":             (-14, -4),   "tilt_w": 1,
    },
    "pop": {
        "tempo":            (88, 142),   "tempo_w": 2,
        "centroid_hz":      (1200, 4000),"centroid_w": 3,  # KEY: bright
        "rolloff_hz":       (3000, 9000),"rolloff_w": 3,   # KEY: bright rolloff
        "contrast":         (10, 28),    "contrast_w": 1,
        "sub_energy":       (-22, -10),  "sub_w": 1,
        "low_mid_energy":   (-20, -10),  "low_mid_w": 1,
        "crest_factor":     (4, 12),     "crest_w": 2,
        "zcr":              (0.035, 0.14),"zcr_w": 3,      # KEY: high zcr = bright
        "tilt":             (-8, 0),     "tilt_w": 2,
    },
    "electronic": {
        "tempo":            (118, 178),  "tempo_w": 2,
        "centroid_hz":      (900, 4000), "centroid_w": 2,
        "rolloff_hz":       (2500, 9000),"rolloff_w": 2,
        "contrast":         (8, 25),     "contrast_w": 1,
        "sub_energy":       (-16, -4),   "sub_w": 3,       # KEY: heavy sub
        "low_mid_energy":   (-22, -12),  "low_mid_w": 1,
        "crest_factor":     (3, 10),     "crest_w": 2,
        "zcr":              (0.020, 0.10),"zcr_w": 1,
        "tilt":             (-8, 2),     "tilt_w": 2,
    },
    "hiphop": {
        "tempo":            (65, 115),   "tempo_w": 3,     # KEY: slow tempo
        "centroid_hz":      (700, 2500), "centroid_w": 1,
        "rolloff_hz":       (1800, 6000),"rolloff_w": 1,
        "contrast":         (12, 30),    "contrast_w": 1,
        "sub_energy":       (-14, -4),   "sub_w": 3,       # KEY: heavy sub
        "low_mid_energy":   (-20, -10),  "low_mid_w": 1,
        "crest_factor":     (4, 12),     "crest_w": 1,
        "zcr":              (0.015, 0.08),"zcr_w": 1,
        "tilt":             (-10, -2),   "tilt_w": 1,
    },
    "jazz": {
        "tempo":            (55, 220),   "tempo_w": 1,
        "centroid_hz":      (500, 2000), "centroid_w": 2,
        "rolloff_hz":       (1500, 5000),"rolloff_w": 2,
        "contrast":         (20, 40),    "contrast_w": 2,
        "sub_energy":       (-32, -18),  "sub_w": 1,
        "low_mid_energy":   (-22, -10),  "low_mid_w": 2,
        "crest_factor":     (10, 30),    "crest_w": 3,
        "zcr":              (0.010, 0.065),"zcr_w": 2,
        "tilt":             (-8, -1),    "tilt_w": 2,
    },
    "classical": {
        "tempo":            (35, 185),   "tempo_w": 1,
        "centroid_hz":      (350, 1800), "centroid_w": 2,
        "rolloff_hz":       (900, 4500), "rolloff_w": 2,
        "contrast":         (22, 45),    "contrast_w": 2,
        "sub_energy":       (-38, -20),  "sub_w": 2,
        "low_mid_energy":   (-26, -12),  "low_mid_w": 2,
        "crest_factor":     (14, 40),    "crest_w": 3,
        "zcr":              (0.005, 0.050),"zcr_w": 2,
        "tilt":             (-6, -1),    "tilt_w": 2,
    },
}


def detect_genre(y_mono, sr, spectrum, dynamics, loudness=None):
    """Score each genre against measured features and return best match."""
    # Extract features needed for classification
    onset_env = librosa.onset.onset_strength(y=y_mono, sr=sr)
    try:
        tempo = float(librosa.beat.tempo(onset_envelope=onset_env, sr=sr)[0])
    except Exception:
        tempo = 120.0

    centroid = float(np.mean(librosa.feature.spectral_centroid(y=y_mono, sr=sr)))
    zcr      = float(np.mean(librosa.feature.zero_crossing_rate(y_mono)))

    sub_energy   = spectrum["bands"]["sub"]["energy_db"]
    low_mid_energy = spectrum["bands"]["low_mid"]["energy_db"]
    tilt         = spectrum["spectral_tilt_db_per_decade"]
    # Use real crest factor from loudness if available, else RMS variance as fallback
    crest = (loudness.get("crest_factor_db") if loudness else None) or dynamics.get("rms_variance", 15.0)

    features = {
        "tempo":          tempo,
        "centroid_hz":    centroid,
        "sub_energy":     sub_energy,
        "low_mid_energy": low_mid_energy,
        "crest_factor":   crest,
        "zcr":            zcr,
        "tilt":           tilt,
    }

    scores = {}
    for genre, profile in GENRE_PROFILES.items():
        score = 0.0
        for feat, value in features.items():
            lo, hi = profile.get(feat, (None, None))
            weight = profile.get(feat + "_w", 1)
            if lo is not None and hi is not None:
                if lo <= value <= hi:
                    score += weight
                else:
                    # Partial score for near misses
                    dist = min(abs(value - lo), abs(value - hi))
                    span = (hi - lo) or 1
                    proximity = max(0.0, 1.0 - (dist / span))
                    score += weight * proximity * 0.4
        scores[genre] = round(score, 2)

    best = max(scores, key=scores.get)
    ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)

    print(f"  [genre] features: {{{', '.join(f'{k}={v:.2f}' for k,v in features.items())}}}", file=sys.stderr)
    print(f"  [genre] top3: {ranked[:3]}", file=sys.stderr)
    return {
        "detected":  best,
        "scores":    scores,
        "top3":      [(g, s) for g, s in ranked[:3]],
        "features":  {k: round(v, 2) for k, v in features.items()},
    }


BAND_RANGES = {
    "sub":      (20,   80),
    "bass":     (80,   250),
    "low_mid":  (250,  800),
    "mid":      (800,  2500),
    "presence": (2500, 6000),
    "air":      (6000, 20000),
}

# Sub-bands: each parent band divided into 4 log-spaced sub-bands.
# Naming: f"{parent}_{idx}" where idx is 0..3 from low to high frequency.
# Boundaries are log-spaced: f_k = fmin * (fmax/fmin)**(k/4) for k in 0..4
def _build_sub_bands():
    subs = {}
    parent_of = {}
    for parent, (fmin, fmax) in BAND_RANGES.items():
        log_ratio = (fmax / fmin) ** 0.25
        for i in range(4):
            lo = fmin * (log_ratio ** i)
            hi = fmin * (log_ratio ** (i + 1))
            key = f"{parent}_{i}"
            subs[key] = (round(lo, 1), round(hi, 1))
            parent_of[key] = parent
    return subs, parent_of

SUB_BANDS, SUB_BAND_PARENT = _build_sub_bands()


# ---------------------------------------------------------------------------
# Pink-noise band reference
# ---------------------------------------------------------------------------
# Band energies are computed as band-restricted RMS in dBFS. For a real mix,
# each individual band's dBFS value will be much lower than the overall RMS
# (energy is spread across bands). That makes raw per-band dBFS values hard
# to compare against fixed targets — a -14 LUFS mix will have completely
# different absolute band numbers from a -20 LUFS mix even if tonal shape
# is identical.
#
# Solution: use PINK NOISE as a neutral reference. Pink noise has equal power
# per octave — it's the canonical "tonally flat" signal in audio engineering.
# For every band, we compute the offset of pink noise from its overall RMS.
# Then any measured signal's band energy can be expressed as
#     vs_pink_db = measured_band_dBFS - overall_RMS_dBFS - pink_offset[band]
# which is 0 for pink, positive for bands louder than neutral, negative for
# bands quieter than neutral — independent of overall loudness.
#
# GENRE_TARGETS in the new scheme are expressed as "dB vs pink" — e.g.
# post-rock presence = -3 means "3 dB darker than neutral in presence band".

def _compute_pink_offsets():
    """Generate pink noise once and measure its per-band dB offset from
    overall RMS. These offsets depend only on BAND_RANGES and sample rate,
    so we cache them per-SR on first use.
    """
    # Paul Kellet's pink filter — fast, accurate enough for reference
    from scipy.signal import lfilter as _lfilter
    sr = 48000
    n = sr * 5
    rng = np.random.default_rng(0xC0FFEE)
    white = rng.standard_normal(n).astype(np.float64)
    b = [0.049922035, -0.095993537, 0.050612699, -0.004408786]
    a = [1, -2.494956002, 2.017265875, -0.522189400]
    pink = _lfilter(b, a, white)
    # Normalize to -14 dBFS RMS (doesn't affect offsets, but keeps numbers sane)
    target_rms = 10 ** (-14 / 20)
    pink = pink * (target_rms / np.sqrt(np.mean(pink ** 2)))
    overall_rms_db = 20 * np.log10(np.sqrt(np.mean(pink ** 2)))
    # Measure each band with the same pipeline the rest of the analyzer uses
    freqs, bin_power, norm = compute_stft_spectrum(pink, sr)
    offsets = {}
    for name, (fmin, fmax) in BAND_RANGES.items():
        e = stft_band_energy_db(freqs, bin_power, norm, fmin, fmax)
        offsets[name] = round(e - overall_rms_db, 2)
    return offsets


# Lazy cache — computed on first call to _ensure_pink_offsets()
_PINK_OFFSETS = None

def _ensure_pink_offsets():
    global _PINK_OFFSETS
    if _PINK_OFFSETS is None:
        _PINK_OFFSETS = _compute_pink_offsets()
    return _PINK_OFFSETS


def band_vs_pink_db(band_energy_db, overall_rms_db, band_name):
    """Convert absolute band dBFS into 'dB vs pink noise at same overall loudness'.
    Returns 0 for pink, positive for brighter-than-neutral, negative for darker.
    """
    offsets = _ensure_pink_offsets()
    return round(band_energy_db - overall_rms_db - offsets[band_name], 2)


# ---------------------------------------------------------------------------
# GENRE_TARGETS — "dB vs pink noise at same overall loudness"
# ---------------------------------------------------------------------------
# Semantics: for each band, a positive value means "this genre is typically
# brighter than neutral in this band", negative means "darker than neutral".
# Zero means tonally neutral in that band.
#
# These are NOT absolute dBFS values. Don't compare them to raw band_energy_db.
#
# Sources for each genre's profile (documented):
#
#   pop          — bright, controlled low end, bass boost ~80-150 Hz, modest
#                  air lift ~10 kHz. Typical modern pop masters (Billie Eilish,
#                  Taylor Swift) sit around this shape.
#   rock         — warm midrange, some bass weight, restrained air. Classic
#                  rock engineering school.
#   electronic   — heavy sub + bass, scooped mids, brittle presence + air.
#                  EDM/house/techno norm.
#   jazz         — natural, slightly scooped upper mids, airy top (acoustic
#                  tradition). Reference: ECM/Blue Note modern masters.
#   classical    — natural spectrum (near pink), occasionally slightly dark
#                  in the air band (orchestral hall acoustics absorb HF).
#   hiphop       — dominant sub and bass, thick low-mid, restrained mid and
#                  presence, some air lift for hi-hats.
#   postrock     — warm, lush low-mid (guitar body/swell), recessed presence
#                  and air (space, atmosphere). Reference: Mogwai, Explosions
#                  in the Sky, Godspeed.
#   progrock     — balanced full-range with slight low-mid weight from guitar
#                  thickness + keys, natural mids (vocals/solos), controlled
#                  but present air. Reference: Porcupine Tree, Leprous,
#                  modern prog masters. Checked against Virtue_Single_v5:
#                    measured: sub -0.2, bass +4.8, low_mid +2.2, mid -1.1,
#                              presence -2.9, air -11.5
#                  Virtue is darker-than-average on presence/air (consistent
#                  with atmospheric/warm prog subgenre) but otherwise in-range.
#   metal        — scooped mids for "V shape", heavy low-mid for guitars,
#                  prominent presence for pick attack, restrained air.
#   instrumental — natural mids prominent (lead guitar/keys), less bass
#                  weight than rock, restrained air.

GENRE_TARGETS = {
    "pop":         {"sub": +1, "bass": +3, "low_mid":  0, "mid":  0, "presence": +1, "air":  0},
    "rock":        {"sub":  0, "bass": +2, "low_mid": +2, "mid":  0, "presence":  0, "air": -2},
    "electronic":  {"sub": +4, "bass": +4, "low_mid": -2, "mid": -3, "presence":  0, "air": +1},
    "jazz":        {"sub": -1, "bass":  0, "low_mid":  0, "mid":  0, "presence": +1, "air": +2},
    "classical":   {"sub": -1, "bass":  0, "low_mid":  0, "mid":  0, "presence":  0, "air": -1},
    "hiphop":      {"sub": +5, "bass": +4, "low_mid":  0, "mid": -3, "presence": -2, "air": +1},
    "postrock":    {"sub":  0, "bass": +2, "low_mid": +3, "mid": -1, "presence": -4, "air": -6},
    "progrock":    {"sub":  0, "bass": +3, "low_mid": +2, "mid":  0, "presence": -2, "air": -5},
    "metal":       {"sub":  0, "bass": +2, "low_mid": +4, "mid": -2, "presence": +1, "air": -4},
    "instrumental":{"sub": -1, "bass":  0, "low_mid": +1, "mid": +1, "presence":  0, "air": -2},
}

# Delta status thresholds: how far off-target before we flag "high" or "low".
# On the vs-pink scale, ±3 dB is a clearly audible tonal issue.
DELTA_OK_DB   = 3.0    # within this, band status = "ok"
DELTA_WARN_DB = 6.0    # beyond this, warning is worth flagging to user

LUFS_TARGETS = {
    "streaming": -14.0,   # Spotify / Apple Music normalized level
    "cd":        -9.0,
    "broadcast": -23.0,
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_audio(path):
    """Load audio file, return (y_stereo [2, N], y_mono [N], sr)."""
    y, sr = librosa.load(path, sr=None, mono=False)
    if y.ndim == 1:
        y = np.stack([y, y])          # treat mono as dual-mono
    y_mono = librosa.to_mono(y)
    return y, y_mono, sr


def rms_db(signal):
    rms = np.sqrt(np.mean(signal ** 2))
    if rms < 1e-10:
        return -96.0
    return float(20 * np.log10(rms))


def compute_stft_spectrum(y_mono, sr, n_fft=4096, hop_length=1024):
    """Compute magnitude spectrum averaged over time.

    Returns (freqs_hz, bin_power, norm_factor) where:
      - freqs_hz[i] is the center frequency of FFT bin i
      - bin_power[i] is the time-averaged linear power for that bin
        (not yet normalized — see stft_band_energy_db for the normalization)
      - norm_factor is the scaling such that
            RMS^2 = sum(bin_power_one_sided_doubled) / norm_factor
        for a signal restricted to the full Nyquist band. This lets us compute
        band-limited RMS in dB for any frequency range.

    This is the shared backbone for all spectral analysis. Call once, slice
    into whatever band structure you need.
    """
    from scipy.signal.windows import hann
    stft = librosa.stft(y_mono, n_fft=n_fft, hop_length=hop_length, window="hann")
    # Power spectrogram: |X|^2 per bin per frame
    power = np.abs(stft) ** 2
    # Time-averaged power per bin (power, not magnitude — for additivity)
    bin_power = np.mean(power, axis=1)
    # Normalization: true_RMS^2 = sum(one_sided_doubled_power) / (n_fft * sum(w^2))
    win = hann(n_fft)
    norm_factor = float(n_fft * np.sum(win ** 2))
    # Frequency bins
    freqs = librosa.fft_frequencies(sr=sr, n_fft=n_fft)
    return freqs, bin_power, norm_factor


def stft_band_energy_db(freqs, bin_power, norm_factor, fmin, fmax):
    """Aggregate STFT bins within [fmin, fmax] into a band-restricted RMS in dB.

    The result matches what a Butterworth bandpass + RMS would give you,
    but is derived from the already-computed STFT. This lets one STFT pass
    serve arbitrary band structures cheaply.
    """
    mask = (freqs >= fmin) & (freqs < fmax)
    if not np.any(mask):
        return -96.0
    # One-sided spectrum doubling: bins other than DC and Nyquist carry the
    # negative-frequency image, so double them. Skip if the mask only includes
    # DC or Nyquist (rare edge case).
    full = bin_power.copy()
    # Only double non-edge bins
    if len(full) > 2:
        full[1:-1] *= 2.0
    band_power = float(np.sum(full[mask]))
    # Convert to band-restricted RMS^2 via the calibrated normalization
    rms_sq = band_power / norm_factor
    if rms_sq <= 1e-20:
        return -96.0
    return float(10 * np.log10(rms_sq))


def true_peak_db(signal):
    """Approximate true peak (4x oversampled)."""
    from scipy.signal import resample_poly
    oversampled = resample_poly(signal, 4, 1)
    peak = np.max(np.abs(oversampled))
    if peak < 1e-10:
        return -96.0
    return float(20 * np.log10(peak))


# ---------------------------------------------------------------------------
# Analysis modules
# ---------------------------------------------------------------------------

def _resolve_ffmpeg_binary():
    """Return the path (or bare name) to use when invoking ffmpeg.

    Lookup order:
      1. ANVIL_FFMPEG env var — explicit override, wins over everything.
      2. Bundled binary next to the executable (PyInstaller) or next to the
         main script (dev). On Windows that's `ffmpeg/ffmpeg.exe`, on
         macOS/Linux `ffmpeg/ffmpeg`. We ship ffmpeg this way in packaged
         builds so users don't need a separate install.
      3. Bare "ffmpeg" — assumes it's on PATH. The fallback for dev machines
         that have ffmpeg installed system-wide.

    The result is cached in a module-level so we don't hit the filesystem
    on every measurement call.
    """
    global _FFMPEG_CACHED
    try:
        return _FFMPEG_CACHED
    except NameError:
        pass

    # 1. Env var override
    env = os.environ.get("ANVIL_FFMPEG")
    if env and os.path.exists(env):
        _FFMPEG_CACHED = env
        return _FFMPEG_CACHED

    # 2. Bundled ffmpeg
    # In a PyInstaller onedir bundle, sys.executable points at the exe and
    # sys._MEIPASS / os.path.dirname(sys.executable) is where data files
    # get placed. In dev, we use the project root (the folder containing
    # mix_analyzer.py).
    if getattr(sys, "frozen", False):
        # Running inside PyInstaller
        base = os.path.dirname(sys.executable)
    else:
        base = os.path.abspath(os.path.dirname(__file__))

    exe_name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    bundled = os.path.join(base, "ffmpeg", exe_name)
    if os.path.exists(bundled):
        _FFMPEG_CACHED = bundled
        return _FFMPEG_CACHED

    # 3. System PATH fallback
    _FFMPEG_CACHED = "ffmpeg"
    return _FFMPEG_CACHED


def measure_ffmpeg(filepath):
    """Use ffmpeg ebur128 for accurate LUFS, LRA, and true peak (BS.1770-4 compliant)."""
    import subprocess, re
    ffmpeg_bin = _resolve_ffmpeg_binary()
    try:
        result = subprocess.run(
            [ffmpeg_bin, "-i", filepath, "-af", "ebur128=peak=true", "-f", "null", "-"],
            capture_output=True, text=True, timeout=120
        )
        output = result.stderr + result.stdout
        lufs  = re.search(r"\n\s+I:\s+([-\d.]+)\s+LUFS", output)
        lra   = re.search(r"\n\s+LRA:\s+([\d.]+)\s+LU", output)
        peak  = re.search(r"Peak:\s+([-\d.]+)\s+dBFS", output)
        return {
            "lufs": float(lufs.group(1)) if lufs else None,
            "lra":  float(lra.group(1))  if lra  else None,
            "peak": float(peak.group(1)) if peak else None,
        }
    except Exception as e:
        print(f"  ffmpeg measurement failed: {e}", file=sys.stderr)
        return {"lufs": None, "lra": None, "peak": None}


def analyze_loudness(y_mono, y_stereo, sr, genre="pop", filepath=None):
    """Integrated LUFS, LRA, true peak, crest factor.
    Uses ffmpeg for LUFS/LRA/true peak when filepath is available (more accurate).
    Falls back to pyloudnorm if ffmpeg is unavailable.
    """
    # --- ffmpeg path (preferred) ---
    ffmpeg_data = {"lufs": None, "lra": None, "peak": None}
    if filepath:
        ffmpeg_data = measure_ffmpeg(filepath)

    # --- pyloudnorm fallback for LUFS ---
    if ffmpeg_data["lufs"] is None:
        meter = pyln.Meter(sr)
        block = y_stereo.T if y_stereo.shape[0] == 2 else y_mono.reshape(-1, 1)
        try:
            ffmpeg_data["lufs"] = float(meter.integrated_loudness(block))
        except Exception:
            pass

    # --- fallback true peak via scipy oversampling ---
    if ffmpeg_data["peak"] is None:
        ffmpeg_data["peak"] = true_peak_db(y_mono)

    integrated_lufs = ffmpeg_data["lufs"]
    lra             = ffmpeg_data["lra"]
    peak            = ffmpeg_data["peak"]

    # Crest factor (peak vs RMS — always computed from signal)
    rms          = rms_db(y_mono)
    crest_factor = round(peak - rms, 1) if peak is not None else None
    streaming_delta = round(integrated_lufs - LUFS_TARGETS["streaming"], 1) if integrated_lufs else None

    return {
        "integrated_lufs":      round(integrated_lufs, 1) if integrated_lufs else None,
        "true_peak_dbfs":       round(peak, 1) if peak is not None else None,
        "crest_factor_db":      crest_factor,
        "loudness_range_lra":   round(lra, 1) if lra is not None else None,
        "streaming_delta_lufs": streaming_delta,
        "warnings": _loudness_warnings(integrated_lufs, peak, crest_factor, genre),
    }


def _loudness_warnings(lufs, peak, crest, genre="pop"):
    w = []
    # Genre-aware LUFS thresholds
    loud_genres = {"metal", "hiphop", "electronic"}
    dynamic_genres = {"postrock", "classical", "instrumental", "jazz"}
    loud_floor = -9 if genre in loud_genres else -8
    quiet_floor = -22 if genre in dynamic_genres else -20
    crest_min = 5 if genre in loud_genres else 6
    crest_max = 25 if genre in dynamic_genres else 20

    if peak is not None and peak > -0.5:
        w.append("True peak exceeds -0.5 dBFS — clipping risk after codec encoding.")
    if lufs is not None and lufs > loud_floor:
        w.append(f"Mix is very loud (over-compressed). Streaming platforms will turn it down.")
    if lufs is not None and lufs < quiet_floor:
        if genre in dynamic_genres:
            w.append("Mix is quiet — but wide dynamic range is normal for this genre. Check against streaming targets.")
        else:
            w.append("Mix is quiet for modern releases. Consider gentle limiting.")
    if crest is not None and crest < crest_min:
        w.append("Low crest factor — dynamics may be over-compressed.")
    if crest is not None and crest > crest_max:
        w.append("Very high crest factor — peaks may be too transient-heavy for streaming.")
    return w


def analyze_spectrum(y_mono, sr, genre):
    """Per-band energy and deviation from genre targets.

    Uses a single STFT pass for both parent bands and finer sub-bands.
    Sub-bands (4 per parent) expose narrower resonances and enable more
    actionable EQ advice.
    """
    targets = GENRE_TARGETS.get(genre, GENRE_TARGETS["pop"])

    # Single STFT pass, reused for every band query
    freqs_hz, bin_power, norm_factor = compute_stft_spectrum(y_mono, sr)

    # Overall RMS in dBFS — used to convert absolute band energy to "vs pink"
    overall_rms_db = rms_db(y_mono)

    # Pink offsets (cached after first call)
    pink_offsets = _ensure_pink_offsets()

    # Parent bands (6)
    # energy_db: absolute band-restricted RMS in dBFS (unchanged — useful for raw inspection)
    # vs_pink_db: how bright/dark this band is vs pink noise at same overall loudness
    #             (0 = neutral, + = brighter, - = darker)
    # target_db: genre target, expressed on the same "vs pink" scale
    # delta_db: vs_pink_db - target_db
    #           (0 = on-target for this genre, + = brighter than genre norm,
    #            - = darker than genre norm)
    bands = {}
    for name, (fmin, fmax) in BAND_RANGES.items():
        energy = stft_band_energy_db(freqs_hz, bin_power, norm_factor, fmin, fmax)
        vs_pink = round(energy - overall_rms_db - pink_offsets[name], 1)
        target  = targets[name]
        delta   = round(vs_pink - target, 1)
        if abs(delta) < DELTA_OK_DB:
            status = "ok"
        elif delta > 0:
            status = "high"
        else:
            status = "low"
        bands[name] = {
            "energy_db":   round(energy, 1),     # absolute (unchanged)
            "vs_pink_db":  vs_pink,              # new: tonal character
            "target_db":   target,               # now on "vs pink" scale
            "delta_db":    delta,                # now "vs genre target, vs pink"
            "status":      status,
        }

    # Sub-bands (24) — finer resolution, 4 per parent, log-spaced
    sub_bands = {}
    for name, (fmin, fmax) in SUB_BANDS.items():
        energy = stft_band_energy_db(freqs_hz, bin_power, norm_factor, fmin, fmax)
        parent = SUB_BAND_PARENT[name]
        sub_bands[name] = {
            "energy_db":  round(energy, 1),
            "fmin":       fmin,
            "fmax":       fmax,
            "center_hz":  round((fmin * fmax) ** 0.5, 0),   # geometric mean
            "parent":     parent,
        }

    # Narrow-resonance detection: scan sub-bands, flag any sub-band that is
    # >=5 dB above the *median* of its siblings in the same parent band.
    # Median is more robust than mean when one sub-band is a true outlier.
    resonances = []
    for parent_name in BAND_RANGES.keys():
        siblings = [sub_bands[f"{parent_name}_{i}"]["energy_db"] for i in range(4)]
        median = float(np.median(siblings))
        for i in range(4):
            key = f"{parent_name}_{i}"
            e = sub_bands[key]["energy_db"]
            lift = round(e - median, 1)
            if lift >= 5.0 and e > -50:    # ignore resonances in nearly-silent parents
                resonances.append({
                    "sub_band":    key,
                    "parent":      parent_name,
                    "center_hz":   sub_bands[key]["center_hz"],
                    "fmin":        sub_bands[key]["fmin"],
                    "fmax":        sub_bands[key]["fmax"],
                    "energy_db":   e,
                    "above_median_db": lift,
                })
    # Sort most prominent first
    resonances.sort(key=lambda r: r["above_median_db"], reverse=True)

    # Tilt: linear regression of parent band energies vs log-frequency
    freqs_centers = [np.sqrt(BAND_RANGES[n][0] * BAND_RANGES[n][1]) for n in BAND_RANGES]
    energies      = [bands[n]["energy_db"] for n in BAND_RANGES]
    log_f = np.log10(freqs_centers)
    slope = float(np.polyfit(log_f, energies, 1)[0])

    return {
        "bands":      bands,
        "sub_bands":  sub_bands,
        "resonances": resonances,
        "spectral_tilt_db_per_decade": round(slope, 1),
        "warnings":   _spectrum_warnings(bands, slope, resonances),
    }


def _spectrum_warnings(bands, slope, resonances=None):
    w = []
    if bands["sub"]["status"] == "high":
        w.append("Sub-bass is heavy — may sound muddy on speakers without a subwoofer.")
    if bands["bass"]["status"] == "high" and bands["sub"]["status"] == "high":
        w.append("Both sub and bass are elevated — check for low-end buildup.")
    if bands["low_mid"]["status"] == "high":
        w.append("Low-mids are prominent — mix may sound boxy or honky.")
    if bands["mid"]["status"] == "low":
        w.append("Mids are scooped — mix may lack presence on small speakers.")
    if bands["presence"]["status"] == "low":
        w.append("Presence range is low — vocals/guitars may lack definition.")
    if bands["air"]["status"] == "high":
        w.append("High-frequency air is boosted — check for harshness on digital playback.")
    if slope > -2:
        w.append("Spectral tilt is bright (slope flatter than -2 dB/decade).")
    if slope < -6:
        w.append("Spectral tilt is dark (slope steeper than -6 dB/decade).")
    # Resonance warnings — top 3 only, to avoid flooding the list
    if resonances:
        for r in resonances[:3]:
            c = int(r["center_hz"])
            w.append(f"Narrow resonance around {c} Hz ({r['above_median_db']:.1f} dB above siblings in {r['parent']} band) — check for boxy or ringing tone.")
    return w


def analyze_stereo(y_stereo, sr):
    """Stereo width, mid/side balance, correlation."""
    L, R = y_stereo[0], y_stereo[1]
    M = (L + R) / 2
    S = (L - R) / 2

    mid_energy  = rms_db(M)
    side_energy = rms_db(S)
    width_ratio = round(side_energy - mid_energy, 1)   # negative = narrow, 0 = balanced, positive = wide

    # Detect mono: side channel essentially silent relative to mid
    # A true-mono file (L == R) has side_energy ≈ -96 dB. Real stereo mixes
    # typically have side_energy within ~20 dB of mid_energy. If side is
    # >40 dB below mid, treat as mono (stereo analysis is not meaningful).
    is_mono = (mid_energy - side_energy) > 40 if mid_energy > -60 else True

    # Pearson correlation between L and R
    if np.std(L) < 1e-10 or np.std(R) < 1e-10:
        correlation = 1.0
    else:
        correlation = float(np.corrcoef(L, R)[0, 1])

    # Mono compatibility: drop in RMS when summed to mono
    stereo_rms = rms_db((L + R) / 2)
    mono_rms   = rms_db(M)
    mono_compatibility_db = round(stereo_rms - mono_rms, 1)

    # Width over time (variance of per-frame width)
    frame = int(sr * 0.1)
    widths = []
    for i in range(0, len(L) - frame, frame):
        ml = rms_db(L[i:i+frame] + R[i:i+frame])
        sl = rms_db(L[i:i+frame] - R[i:i+frame])
        widths.append(sl - ml)
    width_variance = float(np.std(widths)) if widths else 0.0

    return {
        "lr_correlation":         round(correlation, 3),
        "mid_side_ratio_db":      width_ratio,
        "mono_compatibility_db":  mono_compatibility_db,
        "width_variance":         round(width_variance, 2),
        "is_mono":                is_mono,
        "warnings":               _stereo_warnings(correlation, width_ratio, mono_compatibility_db, is_mono),
    }


def _stereo_warnings(corr, width, mono_db, is_mono=False):
    w = []
    # If the source is mono, skip all stereo warnings — they aren't meaningful
    if is_mono:
        w.append("Source file is mono — stereo analysis not applicable.")
        return w
    if corr < 0.3:
        w.append("Low L/R correlation — phase issues likely. Check mono playback immediately.")
    if corr < 0:
        w.append("Negative correlation detected — severe phase cancellation in mono.")
    if width > 6:
        w.append("Stereo field is very wide — may collapse badly in mono.")
    if width < -6:
        w.append("Mix is very narrow — consider widening the stereo image.")
    if mono_db < -3:
        w.append("Significant level drop in mono — stereo widening may be too aggressive.")
    return w


def apply_k_weighting(y, sr):
    """Apply ITU-R BS.1770 K-weighting filter.

    This is the same weighting used by LUFS measurement. It's a cascade of:
      1. A high-shelf filter around 1.5 kHz (+4 dB above) — "pre-filter"
      2. A high-pass at 38 Hz — removes rumble

    Returns the filtered signal. Useful for computing perceptually-weighted
    band energies, so that "the bass is 3 dB hot" becomes a perceptual claim
    not just an energy claim.

    Coefficients from BS.1770-4, normalized for 48 kHz; we adjust for other
    sample rates via bilinear transform approximation.
    """
    from scipy.signal import butter, sosfilt, bilinear
    # BS.1770 analog prototype — implemented in digital via bilinear transform
    # Using librosa's built-in approximation or a manual filter:
    # Here we implement it as documented in the standard.

    # Pre-filter (high-shelf): fc=1681.97 Hz, gain=3.99954 dB, Q=0.7071
    # High-pass: fc=38.13547, Q=0.5003
    # These values from BS.1770-4 Annex 1 (48 kHz reference).

    # For robustness across sample rates we use scipy's digital IIR equivalents.
    # Pre-filter: biquad high-shelf. We compute analog coefficients then bilinear transform.
    import numpy as np

    def _biquad_highshelf(fc, gain_db, Q, fs):
        # Standard Robert Bristow-Johnson audio-EQ cookbook formulas
        A  = 10 ** (gain_db / 40)
        w0 = 2 * np.pi * fc / fs
        cosw = np.cos(w0)
        sinw = np.sin(w0)
        alpha = sinw / (2 * Q)
        b0 =    A * ((A + 1) + (A - 1) * cosw + 2 * np.sqrt(A) * alpha)
        b1 = -2*A * ((A - 1) + (A + 1) * cosw)
        b2 =    A * ((A + 1) + (A - 1) * cosw - 2 * np.sqrt(A) * alpha)
        a0 =       (A + 1) - (A - 1) * cosw + 2 * np.sqrt(A) * alpha
        a1 =   2 * ((A - 1) - (A + 1) * cosw)
        a2 =       (A + 1) - (A - 1) * cosw - 2 * np.sqrt(A) * alpha
        return np.array([[b0/a0, b1/a0, b2/a0, 1.0, a1/a0, a2/a0]])

    def _biquad_highpass(fc, Q, fs):
        w0 = 2 * np.pi * fc / fs
        cosw = np.cos(w0)
        sinw = np.sin(w0)
        alpha = sinw / (2 * Q)
        b0 =  (1 + cosw) / 2
        b1 = -(1 + cosw)
        b2 =  (1 + cosw) / 2
        a0 =   1 + alpha
        a1 =  -2 * cosw
        a2 =   1 - alpha
        return np.array([[b0/a0, b1/a0, b2/a0, 1.0, a1/a0, a2/a0]])

    sos_pre = _biquad_highshelf(1681.97, 3.99954, 0.7071, sr)
    sos_hp  = _biquad_highpass(38.13547, 0.5003, sr)
    sos = np.vstack([sos_pre, sos_hp])
    return sosfilt(sos, y)


def analyze_dynamics(y_mono, sr):
    """Transient density, compression estimate, headroom, per-band crest factors."""
    # Onset detection as proxy for transient density
    onset_frames = librosa.onset.onset_detect(y=y_mono, sr=sr, units="time")
    transients_per_sec = len(onset_frames) / (len(y_mono) / sr) if len(y_mono) > 0 else 0

    # Dynamic range: P95-P10 range of short-term RMS (dB)
    # Clamp frames to -60 dBFS floor to avoid silence exploding variance
    frame_size = int(sr * 0.05)
    rms_frames = [max(rms_db(y_mono[i:i+frame_size]), -60.0)
                  for i in range(0, len(y_mono) - frame_size, frame_size)]
    p10 = float(np.percentile(rms_frames, 10))
    p95 = float(np.percentile(rms_frames, 95))
    rms_dynamic_range = round(p95 - p10, 1)

    headroom = round(-true_peak_db(y_mono), 1)

    # Per-band crest factor (peak-to-RMS ratio per frequency band)
    # Tells you which bands are transient-heavy vs compressed.
    # Large crest = undamped transients (hats, snares, vocal consonants).
    # Small crest = compressed/smoothed (sustained bass, pads, limited master).
    from scipy.signal import butter, sosfilt
    band_crests = {}
    nyq = sr / 2
    for name, (fmin, fmax) in BAND_RANGES.items():
        lo = max(fmin / nyq, 1e-4)
        hi = min(fmax / nyq, 0.9999)
        sos = butter(4, [lo, hi], btype="band", output="sos")
        filtered = sosfilt(sos, y_mono)
        band_rms = rms_db(filtered)
        band_peak = true_peak_db(filtered)
        if band_rms > -60 and band_peak > -60:
            band_crests[name] = {
                "rms_db":   round(band_rms, 1),
                "peak_db":  round(band_peak, 1),
                "crest_db": round(band_peak - band_rms, 1),
            }
        else:
            band_crests[name] = {"rms_db": None, "peak_db": None, "crest_db": None}

    return {
        "transients_per_second":  round(transients_per_sec, 1),
        "rms_variance":           rms_dynamic_range,
        "headroom_db":            headroom,
        "band_crests":            band_crests,
        "warnings":               _dynamics_warnings(transients_per_sec, rms_dynamic_range, headroom, band_crests),
    }


def _dynamics_warnings(tps, var, headroom, band_crests=None):
    w = []
    # Thresholds match the frontend color thresholds in app.js so the
    # warning list and the card color agree on when something's actually
    # out of range. See app.js dynCardHeadroom for documented sources.
    if tps > 20:
        w.append("Very high transient density — mix may feel genuinely cluttered.")
    if var < 3:
        w.append("Low dynamic range (P95-P10 < 3 dB) — mix is crushed.")
    if var > 30:
        w.append("Very high dynamic range — check for silence or very quiet sections pulling the average down.")
    if headroom < 1:
        w.append("Less than 1 dB headroom — inter-sample peaks may clip on lossy encoders.")
    if headroom > 12:
        w.append("Generous headroom — mix has not been limited; may need mastering.")
    # Per-band crest hints — flag extremes in either direction.
    # Large crest (>22 dB) in lows = untamed kick/bass transients.
    # Large crest (>18 dB) in mid/presence = un-glued leads, no bus compression.
    # Very small crest (<5 dB) in mid/presence = over-compressed lead (squashed).
    if band_crests:
        for band_name, c in band_crests.items():
            if c.get("crest_db") is None:
                continue
            cr = c["crest_db"]
            rms = c.get("rms_db", -100)
            if band_name in ("sub", "bass") and cr > 22:
                w.append(f"{band_name.capitalize()} band has very high crest factor ({cr} dB) — transients (likely kick) may need taming.")
            if band_name in ("mid", "presence") and cr > 18 and rms > -35:
                w.append(f"{band_name.capitalize()} band crest factor is high ({cr} dB) — this range lacks glue. Consider gentle bus compression on vocals/leads.")
            if band_name in ("mid", "presence") and cr < 5 and rms > -30:
                w.append(f"{band_name.capitalize()} band has very low crest factor ({cr} dB) — this range is over-compressed.")
    return w



def _smooth_lufs(values, window=5):
    out, half = [], window // 2
    for i in range(len(values)):
        lo, hi = max(0, i - half), min(len(values), i + half + 1)
        win = [v for v in values[lo:hi] if v > -70]
        out.append(float(np.median(win)) if win else -70.0)
    return out


def _label_section(lufs_avg, gmin, gmax):
    if gmax - gmin < 2:
        return "steady"
    pos = (lufs_avg - gmin) / max(gmax - gmin, 0.1)
    if pos < 0.25: return "quiet"
    if pos < 0.55: return "medium"
    if pos < 0.85: return "loud"
    return "peak"


def analyze_sections(lufs_timeline, time_points, peak_events, duration):
    """Break the song into sections using smart change-point detection, falling back
    to fixed 30s windows when the track doesn't have clear structure."""
    if not lufs_timeline or len(lufs_timeline) < 10:
        return {"sections": [], "method": "none", "callouts": []}

    smoothed = _smooth_lufs(lufs_timeline, window=5)

    # Smart change-point detection: find points where LUFS shifts ≥3 dB and sustains
    change_points = [0]
    sustain = 5
    i = sustain
    while i < len(smoothed) - sustain:
        before = np.mean(smoothed[max(0, i - sustain):i])
        after  = np.mean(smoothed[i:i + sustain])
        if abs(after - before) >= 3.0:
            if (i - change_points[-1]) >= sustain * 2:
                change_points.append(i)
                i += sustain
                continue
        i += 1
    change_points.append(len(smoothed))

    num = len(change_points) - 1
    method = "smart" if 3 <= num <= 8 else "window"

    if method == "window":
        change_points = list(range(0, len(smoothed), 30))
        if change_points[-1] < len(smoothed):
            change_points.append(len(smoothed))

    valid = [v for v in lufs_timeline if v > -70]
    if not valid:
        return {"sections": [], "method": method, "callouts": []}
    gmin = float(np.percentile(valid, 5))
    gmax = float(np.percentile(valid, 95))

    sections = []
    for idx in range(len(change_points) - 1):
        s_i, e_i = change_points[idx], change_points[idx + 1]
        if e_i - s_i < 3:
            continue
        seg = [v for v in lufs_timeline[s_i:e_i] if v > -70]
        if not seg:
            continue
        st = time_points[s_i] if s_i < len(time_points) else 0.0
        et = time_points[e_i - 1] if e_i - 1 < len(time_points) else duration
        avg, lo, hi = float(np.mean(seg)), float(np.min(seg)), float(np.max(seg))
        pk_count = sum(1 for p in peak_events if st <= p["time"] < et)
        sections.append({
            "index": idx, "label": _label_section(avg, gmin, gmax),
            "start_time": round(st, 1), "end_time": round(et, 1),
            "duration": round(et - st, 1),
            "lufs_avg": round(avg, 1), "lufs_min": round(lo, 1), "lufs_max": round(hi, 1),
            "dynamic_range": round(hi - lo, 1), "peak_events": pk_count,
        })
    for idx, s in enumerate(sections):
        s["index"] = idx

    callouts = []
    if len(sections) >= 2:
        q = min(sections, key=lambda s: s["lufs_avg"])
        l = max(sections, key=lambda s: s["lufs_avg"])
        jump = l["lufs_avg"] - q["lufs_avg"]
        if jump >= 8:
            callouts.append({"kind": "dynamic_range", "severity": "info",
                "message": f"Wide dynamic range: {round(jump,1)} dB between quietest and loudest sections.",
                "detail": f"Quietest at {int(q['start_time'])}s ({q['lufs_avg']} LUFS), loudest at {int(l['start_time'])}s ({l['lufs_avg']} LUFS)."})
        elif jump < 3 and len(sections) >= 3:
            callouts.append({"kind": "dynamic_range", "severity": "warn",
                "message": f"Very compressed arrangement: only {round(jump,1)} dB between quietest and loudest sections.",
                "detail": "Consider automation for more contrast between parts."})
        hot = max(sections, key=lambda s: s["peak_events"])
        if hot["peak_events"] >= 5:
            callouts.append({"kind": "peak_hotspot", "severity": "warn",
                "message": f"Peak clipping concentrated at {int(hot['start_time'])}s–{int(hot['end_time'])}s ({hot['peak_events']} peak events).",
                "detail": "Check this section's master bus — might need a limiter or level ride."})

    return {"sections": sections, "method": method, "callouts": callouts}


def analyze_timeline(y_mono, y_stereo, sr):
    """Short-term LUFS timeline and waveform envelope for visualization."""
    import pyloudnorm as pyln

    # Waveform envelope — peak amplitude per chunk, ~300 points
    target_points = 300
    chunk = max(1, len(y_mono) // target_points)
    waveform = []
    for i in range(0, len(y_mono) - chunk, chunk):
        waveform.append(round(float(np.max(np.abs(y_mono[i:i+chunk]))), 4))

    # Short-term LUFS — 3s window, 1s hop (EBU R128 short-term)
    meter  = pyln.Meter(sr)
    window = int(sr * 3.0)
    hop    = int(sr * 1.0)
    lufs_timeline = []
    time_points   = []
    for i in range(0, len(y_mono) - window, hop):
        t = round(i / sr, 1)
        block = y_mono[i:i+window].reshape(-1, 1)
        try:
            l = float(meter.integrated_loudness(block))
            lufs_timeline.append(round(max(l, -70.0), 1))
        except Exception:
            lufs_timeline.append(-70.0)
        time_points.append(t)

    # Peak events — moments where true peak exceeds -1 dBFS
    peak_events = []
    chunk_peak = int(sr * 0.1)  # 100ms chunks
    for i in range(0, len(y_mono) - chunk_peak, chunk_peak):
        chunk_data = y_mono[i:i+chunk_peak]
        peak = float(np.max(np.abs(chunk_data)))
        if peak > 0.891:  # -1 dBFS threshold
            t = round(i / sr, 1)
            peak_db = round(20 * np.log10(peak), 1) if peak > 0 else -96.0
            peak_events.append({"time": t, "peak_db": peak_db})

    # Merge nearby peak events (within 0.5s)
    merged = []
    for ev in peak_events:
        if merged and ev["time"] - merged[-1]["time"] < 0.5:
            if ev["peak_db"] > merged[-1]["peak_db"]:
                merged[-1] = ev
        else:
            merged.append(ev)

    return {
        "waveform":      waveform,
        "lufs_timeline": lufs_timeline,
        "time_points":   time_points,
        "peak_events":   merged[:20],  # cap at 20 worst peaks
    }


def compare_reference(y_mono, y_ref_mono, sr, y_stereo=None, y_ref_stereo=None):
    """Delta comparison: LUFS, per-band energies (parent + sub-band), stereo width/correlation."""
    ref_m, mix_m = pyln.Meter(sr), pyln.Meter(sr)
    try:
        mix_lufs = float(mix_m.integrated_loudness(y_mono.reshape(-1, 1)))
        ref_lufs = float(ref_m.integrated_loudness(y_ref_mono.reshape(-1, 1)))
        lufs_delta = round(mix_lufs - ref_lufs, 1)
    except Exception:
        mix_lufs = ref_lufs = lufs_delta = None

    # Single STFT per signal, reused for both parent-band and sub-band comparisons
    mix_freqs, mix_bp, mix_nf = compute_stft_spectrum(y_mono, sr)
    ref_freqs, ref_bp, ref_nf = compute_stft_spectrum(y_ref_mono, sr)

    # Parent bands (unchanged shape for backward compat)
    deltas, mix_bands, ref_bands = {}, {}, {}
    for name, (fmin, fmax) in BAND_RANGES.items():
        me = stft_band_energy_db(mix_freqs, mix_bp, mix_nf, fmin, fmax)
        re = stft_band_energy_db(ref_freqs, ref_bp, ref_nf, fmin, fmax)
        mix_bands[name], ref_bands[name] = round(me, 1), round(re, 1)
        deltas[name] = round(me - re, 1)

    # Sub-bands — new: finer-resolution comparison surfaces where exactly the mix deviates
    sub_deltas, mix_subs, ref_subs = {}, {}, {}
    for name, (fmin, fmax) in SUB_BANDS.items():
        me = stft_band_energy_db(mix_freqs, mix_bp, mix_nf, fmin, fmax)
        re = stft_band_energy_db(ref_freqs, ref_bp, ref_nf, fmin, fmax)
        mix_subs[name], ref_subs[name] = round(me, 1), round(re, 1)
        sub_deltas[name] = round(me - re, 1)

    # Top divergences: pick the 3 sub-bands with the largest |delta|
    top_div = sorted(
        [(k, v) for k, v in sub_deltas.items()],
        key=lambda kv: abs(kv[1]),
        reverse=True
    )[:3]
    top_divergences = [
        {
            "sub_band":  k,
            "parent":    SUB_BAND_PARENT[k],
            "center_hz": round((SUB_BANDS[k][0] * SUB_BANDS[k][1]) ** 0.5, 0),
            "fmin":      SUB_BANDS[k][0],
            "fmax":      SUB_BANDS[k][1],
            "delta_db":  v,
        }
        for k, v in top_div
    ]

    stereo = None
    if y_stereo is not None and y_ref_stereo is not None:
        try:
            ms, rs = analyze_stereo(y_stereo, sr), analyze_stereo(y_ref_stereo, sr)
            mw, rw = ms.get("stereo_width_db"), rs.get("stereo_width_db")
            mc, rc = ms.get("correlation"), rs.get("correlation")
            stereo = {
                "width_db": mw, "width_db_ref": rw,
                "width_delta_db": round((mw or 0) - (rw or 0), 1),
                "correlation": mc, "correlation_ref": rc,
                "correlation_delta": round((mc or 0) - (rc or 0), 2),
            }
        except Exception:
            stereo = None

    # Overall RMS of both signals — needed by UI to place bars on vs-pink scale
    mix_rms_db = rms_db(y_mono)
    ref_rms_db = rms_db(y_ref_mono)

    return {
        "loudness_delta_lufs": lufs_delta,
        "mix_lufs": round(mix_lufs, 1) if mix_lufs is not None else None,
        "ref_lufs": round(ref_lufs, 1) if ref_lufs is not None else None,
        "spectral_deltas_db": deltas,
        "mix_band_energy_db": mix_bands,
        "ref_band_energy_db": ref_bands,
        "mix_overall_rms_db": round(mix_rms_db, 2),
        "ref_overall_rms_db": round(ref_rms_db, 2),
        "pink_offsets": _ensure_pink_offsets(),
        "sub_band_deltas_db": sub_deltas,
        "mix_sub_band_energy_db": mix_subs,
        "ref_sub_band_energy_db": ref_subs,
        "top_divergences": top_divergences,
        "stereo": stereo,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def build_action_summary(report):
    """Produce a tiered action plan from a completed analysis report.

    Returns a dict with three tiers: fix_before_bounce, worth_fixing, polish.
    Each item has: tier, category, issue (short), location (optional),
    fix (specific, actionable), priority_score (for stable sort).

    Ranking philosophy:
      - Tier 1 (fix_before_bounce): things that will actively break the
        delivered audio — clipping, mono collapse, severe phase cancellation,
        LUFS way off target.
      - Tier 2 (worth_fixing): clear tonal or level problems that will be
        noticed by most listeners on most playback systems.
      - Tier 3 (polish): refinements that make the mix better but aren't
        mix-breakers.
    """
    items = []

    loud = report.get("loudness", {}) or {}
    spec = report.get("spectrum", {}) or {}
    stereo = report.get("stereo", {}) or {}
    dyn = report.get("dynamics", {}) or {}

    # Mono source files: skip all stereo-related checks. The numbers are
    # mathematically valid but perceptually meaningless (side channel is
    # empty by construction, so width/correlation/mono-delta are artifacts).
    is_mono = bool(stereo.get("is_mono"))

    # --- TIER 1: fix_before_bounce ---

    peak = loud.get("true_peak_dbfs")
    if peak is not None and peak > -0.5:
        items.append({
            "tier": "fix_before_bounce",
            "category": "loudness",
            "issue": "True peak clipping risk",
            "location": f"{peak:+.1f} dBFS (threshold −0.5)",
            "fix": "Insert a true-peak limiter (Cubase Limiter or Brickwall Limiter) on the master bus with ceiling at −1 dBFS. Or reduce master gain by 1–2 dB.",
            "priority_score": 95,
        })

    corr = stereo.get("lr_correlation")
    if not is_mono and corr is not None and corr < 0:
        items.append({
            "tier": "fix_before_bounce",
            "category": "stereo",
            "issue": "Negative L/R correlation — severe phase cancellation",
            "location": f"correlation {corr:.2f}",
            "fix": "Identify the channel causing it (mute-check one at a time). Usually a polarity-flipped sample, stereo widener set too wide, or out-of-phase mic pair. Flip polarity or remove widening.",
            "priority_score": 90,
        })
    elif not is_mono and corr is not None and corr < 0.3:
        items.append({
            "tier": "fix_before_bounce",
            "category": "stereo",
            "issue": "Low L/R correlation — phase issues likely",
            "location": f"correlation {corr:.2f}",
            "fix": "Check mono playback immediately. Look for channels with aggressive stereo widening or unpaired mic techniques. Reduce widening on suspicious channels.",
            "priority_score": 85,
        })

    mono_db = stereo.get("mono_compatibility_db")
    if not is_mono and mono_db is not None and mono_db < -3:
        items.append({
            "tier": "fix_before_bounce",
            "category": "stereo",
            "issue": "Significant level drop in mono",
            "location": f"{mono_db:+.1f} dB",
            "fix": "Your stereo widening is too aggressive. Remove or narrow stereo widening plugins. Target mono-delta under 3 dB. Mix should remain recognizable in mono.",
            "priority_score": 80,
        })

    lufs = loud.get("integrated_lufs")
    if lufs is not None:
        # Way-off-target: >3 LUFS from streaming target signals a real level problem
        if lufs > -8:
            items.append({
                "tier": "fix_before_bounce",
                "category": "loudness",
                "issue": "Mix severely over-compressed",
                "location": f"{lufs:.1f} LUFS (target −14)",
                "fix": "Streaming platforms will turn this down significantly, losing dynamics. Ease the master limiter — raise threshold by 3–5 dB.",
                "priority_score": 75,
            })

    # --- TIER 2: worth_fixing ---

    # Severe spectral imbalances (|delta| >= 6 dB)
    for name, b in spec.get("bands", {}).items():
        delta = b.get("delta_db")
        if delta is None:
            continue
        if abs(delta) >= 6:
            direction = "too hot" if delta > 0 else "too quiet"
            fmin, fmax = BAND_RANGES.get(name, (0, 0))
            items.append({
                "tier": "worth_fixing",
                "category": "spectral",
                "issue": f"{name.replace('_',' ').capitalize()} band {direction} vs genre",
                "location": f"{fmin:.0f}–{fmax:.0f} Hz ({delta:+.1f} dB vs target)",
                "fix": (f"Cut {abs(int(delta))} dB in this range on the dominant element"
                        if delta > 0 else
                        f"Boost {abs(int(delta))} dB in this range on the main element, or check if a filter is rolling it off"),
                "priority_score": 60 + min(20, int(abs(delta))),
            })

    # Significant resonances (>= 10 dB lift) — most actionable
    for r in spec.get("resonances", []):
        if r.get("above_median_db", 0) >= 10:
            items.append({
                "tier": "worth_fixing",
                "category": "resonance",
                "issue": "Strong narrow resonance",
                "location": f"{int(r['center_hz'])} Hz (+{r['above_median_db']:.1f} dB above siblings)",
                "fix": f"Open Frequency EQ on the offending channel, apply a narrow-Q bell cut (Q ≈ 1.6–2.0) at {int(r['center_hz'])} Hz. Start with 3–4 dB of cut, A/B to verify.",
                "priority_score": 55 + min(15, int(r.get('above_median_db', 0))),
            })

    # Over-loud/over-quiet but not extreme
    if lufs is not None and -8 >= lufs > -11 and not any(i["category"] == "loudness" for i in items):
        items.append({
            "tier": "worth_fixing",
            "category": "loudness",
            "issue": "Mix is on the loud side",
            "location": f"{lufs:.1f} LUFS (target −14)",
            "fix": "Streaming will normalize this down. Lightly ease the master limiter — raise threshold 1–2 dB to preserve dynamics.",
            "priority_score": 50,
        })

    # Under-compressed mid/presence (new feature)
    for band_name, c in (dyn.get("band_crests") or {}).items():
        if c.get("crest_db") is None:
            continue
        cr = c["crest_db"]
        rms = c.get("rms_db", -100)
        if band_name in ("mid", "presence") and cr > 18 and rms > -35:
            items.append({
                "tier": "worth_fixing",
                "category": "dynamics",
                "issue": f"{band_name.capitalize()} band lacks glue",
                "location": f"crest factor {cr:.1f} dB",
                "fix": "Add a bus compressor on vocals/lead group. Slow attack (~30 ms), medium release, 2:1 ratio, 2–3 dB gain reduction on peaks.",
                "priority_score": 45,
            })

    # Width vs target stereo issues (non-ship-blocking)
    width = stereo.get("mid_side_ratio_db")
    if not is_mono and width is not None:
        if width > 6:
            items.append({
                "tier": "worth_fixing",
                "category": "stereo",
                "issue": "Mix is unusually wide",
                "location": f"M/S ratio {width:+.1f} dB",
                "fix": "Check stereo widening plugins and M/S processing. Widening above 100% often causes mono collapse. Narrow the widest elements.",
                "priority_score": 40,
            })
        elif width < -6:
            items.append({
                "tier": "worth_fixing",
                "category": "stereo",
                "issue": "Mix is narrow",
                "location": f"M/S ratio {width:+.1f} dB",
                "fix": "Pan instruments more aggressively (hi-hat 30% right, rhythm guitars hard-panned L/R, pads wider). Avoid unnecessary mono-ing.",
                "priority_score": 35,
            })

    # --- TIER 3: polish ---

    # Mild spectral imbalances (3 <= |delta| < 6)
    for name, b in spec.get("bands", {}).items():
        delta = b.get("delta_db")
        if delta is None:
            continue
        if 3 <= abs(delta) < 6:
            direction = "slightly hot" if delta > 0 else "slightly quiet"
            fmin, fmax = BAND_RANGES.get(name, (0, 0))
            items.append({
                "tier": "polish",
                "category": "spectral",
                "issue": f"{name.replace('_',' ').capitalize()} band {direction}",
                "location": f"{fmin:.0f}–{fmax:.0f} Hz ({delta:+.1f} dB vs target)",
                "fix": (f"Gentle {abs(int(delta))} dB cut on the loudest element in this range"
                        if delta > 0 else
                        f"Gentle {abs(int(delta))} dB boost on the main element in this range"),
                "priority_score": 25 + int(abs(delta)),
            })

    # Minor resonances (5-10 dB lift)
    for r in spec.get("resonances", []):
        lift = r.get("above_median_db", 0)
        if 5 <= lift < 10:
            items.append({
                "tier": "polish",
                "category": "resonance",
                "issue": "Minor resonance",
                "location": f"{int(r['center_hz'])} Hz (+{lift:.1f} dB above siblings)",
                "fix": f"Optional narrow-Q cut at {int(r['center_hz'])} Hz (1–2 dB, Q ≈ 1.5) if you notice ringing.",
                "priority_score": 20 + int(lift),
            })

    # Spectral tilt polish
    slope = spec.get("spectral_tilt_db_per_decade")
    if slope is not None:
        if slope > -2:
            items.append({
                "tier": "polish",
                "category": "spectral",
                "issue": "Spectral tilt is bright",
                "location": f"slope {slope:+.1f} dB/decade",
                "fix": "High-shelf cut above 8 kHz (1–2 dB) on master bus, or reduce cymbal/hi-hat levels 1–2 dB.",
                "priority_score": 15,
            })
        elif slope < -6:
            items.append({
                "tier": "polish",
                "category": "spectral",
                "issue": "Spectral tilt is dark",
                "location": f"slope {slope:+.1f} dB/decade",
                "fix": "High-shelf boost above 8 kHz (1–2 dB) on master bus. Check no low-pass is engaged on key elements.",
                "priority_score": 14,
            })

    # Headroom for mastering
    hr = dyn.get("headroom_db")
    if hr is not None and hr > 12 and not any(i["category"] == "loudness" and "over-compressed" in i["issue"].lower() for i in items):
        items.append({
            "tier": "polish",
            "category": "dynamics",
            "issue": "Lots of unused headroom",
            "location": f"{hr:.1f} dB free",
            "fix": "If sending to a mastering engineer, this is fine. If this is your final master, add a limiter — ceiling −1 dBFS, threshold set for −14 LUFS.",
            "priority_score": 10,
        })

    # Transient density extremes
    tps = dyn.get("transients_per_second")
    if tps is not None and tps > 12:
        items.append({
            "tier": "polish",
            "category": "dynamics",
            "issue": "Very high transient density",
            "location": f"{tps:.1f} hits/sec",
            "fix": "Thin out busy sections. Sidechain non-essential percussion to the main hits, or reduce hi-hat/shaker counts.",
            "priority_score": 8,
        })

    # Sort each tier by priority_score descending
    buckets = {"fix_before_bounce": [], "worth_fixing": [], "polish": []}
    for it in items:
        buckets[it["tier"]].append(it)
    for key in buckets:
        buckets[key].sort(key=lambda x: -x["priority_score"])

    return {
        "fix_before_bounce": buckets["fix_before_bounce"],
        "worth_fixing":      buckets["worth_fixing"],
        "polish":            buckets["polish"],
        "total_actions":     len(items),
    }


def analyze(audio_path, genre="pop", ref_path=None):
    print(f"  Loading {audio_path}...", file=sys.stderr)
    y_stereo, y_mono, sr = load_audio(audio_path)
    duration = len(y_mono) / sr

    print("  Analyzing loudness...", file=sys.stderr)
    loudness = analyze_loudness(y_mono, y_stereo, sr, genre, filepath=audio_path)

    print("  Analyzing spectrum...", file=sys.stderr)
    spectrum = analyze_spectrum(y_mono, sr, genre)

    print("  Analyzing stereo image...", file=sys.stderr)
    stereo = analyze_stereo(y_stereo, sr)

    print("  Analyzing dynamics...", file=sys.stderr)
    dynamics = analyze_dynamics(y_mono, sr)

    print('  Analyzing frequency cutoff...', file=sys.stderr)
    try:
        from master_engine import analyze_frequency_cutoff
        frequency_cutoff = analyze_frequency_cutoff(y_mono, sr)
    except Exception as e:
        print(f'    cutoff analysis failed: {e}', file=sys.stderr)
        frequency_cutoff = None

    print('  Detecting genre...', file=sys.stderr)
    genre_detection = detect_genre(y_mono, sr, spectrum, dynamics, loudness)
    detected_genre  = genre_detection["detected"]

    # If user passed "auto" or detection is more confident, use detected genre
    if genre == "auto":
        genre = detected_genre
        # Re-run spectrum with correct genre targets
        spectrum = analyze_spectrum(y_mono, sr, genre)

    print('  Building timeline...', file=sys.stderr)
    timeline = analyze_timeline(y_mono, y_stereo, sr)

    print('  Building sections...', file=sys.stderr)
    sections = analyze_sections(
        timeline["lufs_timeline"], timeline["time_points"],
        timeline["peak_events"], duration,
    )

    reference = None
    if ref_path:
        print(f"  Comparing to reference: {ref_path}...", file=sys.stderr)
        y_ref_stereo, y_ref_mono, ref_sr = load_audio(ref_path)
        if ref_sr != sr:
            y_ref_mono = librosa.resample(y_ref_mono, orig_sr=ref_sr, target_sr=sr)
            y_ref_stereo = np.stack([
                librosa.resample(y_ref_stereo[0], orig_sr=ref_sr, target_sr=sr),
                librosa.resample(y_ref_stereo[1], orig_sr=ref_sr, target_sr=sr),
            ])
        reference = compare_reference(y_mono, y_ref_mono, sr,
                                      y_stereo=y_stereo, y_ref_stereo=y_ref_stereo)

    # Collect all warnings for a top-level summary
    all_warnings = (
        loudness["warnings"] +
        spectrum["warnings"] +
        stereo["warnings"] +
        dynamics["warnings"]
    )

    report = {
        "file":     audio_path,
        "genre":    genre,
        "duration_seconds": round(duration, 1),
        "sample_rate": sr,
        "summary": {
            "total_issues":  len(all_warnings),
            "warnings":      all_warnings,
        },
        "loudness":  loudness,
        "spectrum":  spectrum,
        "stereo":    stereo,
        "dynamics":  dynamics,
        "timeline":  timeline,
        "sections":  sections,
        "genre_detection": genre_detection,
    }
    if reference:
        report["reference_comparison"] = reference
    if frequency_cutoff is not None:
        report["frequency_cutoff"] = frequency_cutoff

    # Build the tiered action summary — runs last so it can see everything
    report["action_summary"] = build_action_summary(report)

    return report


def main():
    parser = argparse.ArgumentParser(description="Analyze an audio mix and output a JSON report.")
    parser.add_argument("file",           help="Path to WAV or AIFF file")
    parser.add_argument("--genre", "-g",  default="pop",
                        choices=list(GENRE_TARGETS.keys()),
                        help="Genre for spectral targets (default: pop)")
    parser.add_argument("--ref", "-r",    default=None,
                        help="Optional reference track for comparison")
    parser.add_argument("--pretty", "-p", action="store_true",
                        help="Pretty-print JSON output")
    args = parser.parse_args()

    print("Anvil Audio Lab — running...", file=sys.stderr)
    report = analyze(args.file, genre=args.genre, ref_path=args.ref)

    indent = 2 if args.pretty else None
    print(json.dumps(report, indent=indent))
    print("\nDone.", file=sys.stderr)


if __name__ == "__main__":
    main()
