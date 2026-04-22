"""
master_engine.py — Offline mastering DSP chain for Anvil Audio Lab

Chain order (fixed — do not reorder):
  1. Tonal tilt (optional high-shelf)
  1b. Reference-match EQ (6 bells, optional)
  1c. Genre-match EQ (6 bells, optional)
  2. Gain stage (LUFS-normalized, computed as target - current on frontend)
  3. True-peak limiter (lookahead, 4x oversampling)
  4. Dither (TPDF, only when reducing bit depth to 16 on export)

Note: an earlier version had a "Final LUFS trim" stage after the limiter
that measured post-chain loudness and adjusted gain to hit target_lufs
exactly. It was removed because it competed with the user's gain slider —
the slider would move but the trim would cancel it out. The gain stage now
directly applies `target - current` (computed on the frontend), the limiter
catches peaks, and whatever loudness comes out is what the user sees. This
is honest and predictable.

Design philosophy:
  - Every step is numeric and inspectable. No hidden decisions.
  - Each processor is pure: audio in, audio out, no hidden state.
  - Chain is assembled from a config dict so UI can toggle steps on/off
    and preview == export (same code path).
  - Measurement uses the same pipeline as mix_analyzer.py (ffmpeg ebur128)
    so numbers shown on the mastering page match the analyzer page exactly.

Audio shape convention (matches mix_analyzer.load_audio):
    y_stereo: (2, N) — channel first
    y_mono:   (N,)
"""

import os
import tempfile
import numpy as np
from scipy import signal as sp_signal

# Reuse the project's existing DSP + measurement pipeline so values on the
# mastering page match the analyzer page to the decimal.
from mix_analyzer import (
    load_audio,
    measure_ffmpeg,
    true_peak_db,
    LUFS_TARGETS,
)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Spotify / YouTube / Bandcamp effectively share one loudness target — we
# render a single master and export it in multiple formats.
DEFAULT_TARGET_LUFS = LUFS_TARGETS["streaming"]   # -14.0
DEFAULT_CEILING_DBFS = -1.0                       # true-peak ceiling

# Limiter tuned for musical (non-aggressive) mastering — for post-rock/prog
# /metal we want gentle catches, not loudness-war crushing.
LIMITER_LOOKAHEAD_MS = 5.0
LIMITER_RELEASE_MS = 50.0
LIMITER_OVERSAMPLE = 4
LIMITER_KNEE_DB = 1.0

# Tilt EQ — single high-shelf at 8 kHz, Q ~ 0.707 (gentle, musical)
TILT_SHELF_FREQ = 8000.0
TILT_SHELF_Q = 0.707

# Safety bounds — refuse extreme moves that indicate a setup problem
MAX_PREGAIN_DB = 18.0
MAX_TILT_DB = 3.0        # above this, fix in the mix, not mastering
MAX_TRIM_DB = 6.0

# Mono-bass check — measures how much low-frequency energy sits in the Side
# channel (i.e., stereo bass). Stereo bass wastes headroom and smears the
# low end on mono playback / small speakers.
#
# Threshold rationale:
#   <10%  ("clean")     — typical of tight, professionally-mastered material
#   10-20% ("mild")     — acceptable but can be tightened
#   20-35% ("worth it") — noticeable gain from mono-ing the low end
#   >35%  ("bad")       — mix-side problem, needs fixing upstream
#
# The default HP cutoff on the Side channel — 120 Hz is the sweet spot:
# low enough to preserve stereo bass guitar/sub pulses if the user wanted
# them, high enough to catch the mud zone (80-150 Hz).
MS_BASS_ANALYZE_HZ = 150.0     # LP cutoff for the analysis measurement
MS_BASS_MILD_PCT = 10.0        # threshold for "worth flagging"
MS_BASS_WORTH_PCT = 20.0       # threshold for "worth fixing"
MS_BASS_SEVERE_PCT = 35.0      # threshold for "probably a mix-side issue"
MS_HP_DEFAULT_HZ = 120.0       # default cutoff when user clicks Apply fix

# Sides-air check — measures whether there's room to add air (8-16 kHz) to
# the Side channel without affecting center-panned elements (vocals, kick,
# snare). The move lifts reverb tails, stereo guitars, cymbal shimmer —
# classic "modern master" openness — without causing vocal sibilance.
#
# The measurement is the gap between Mid's air energy and Side's air energy
# in the 8-16 kHz band. If Side is substantially darker than Mid, there's
# headroom to boost it. Recommended shelf gain scales with the gap:
#   0-2 dB darker  ("clean")     — no room, skip the move
#   2-4 dB darker  ("mild")      — small shelf, +1.5 dB
#   4-7 dB darker  ("worth_it")  — classic case, +2.5 dB
#   >7 dB darker   ("big_room")  — lots of headroom, but still conservative +3 dB
#
# Additional guard: if the overall mix is already air-rich (mix air band at
# or above the genre target), we don't recommend more, regardless of the M/S
# gap. That prevents stacking brightness on an already-bright master.
MS_AIR_ANALYZE_LO_HZ = 8000.0  # lower bound of the air band analysis
MS_AIR_ANALYZE_HI_HZ = 16000.0 # upper bound of the air band analysis
MS_AIR_MILD_DB = 2.0           # threshold for "worth flagging"
MS_AIR_WORTH_DB = 4.0          # threshold for "worth fixing"
MS_AIR_BIG_DB = 7.0            # threshold for "big room, but be conservative"
MS_AIR_SHELF_FREQ = 10000.0    # high-shelf center frequency for the apply-fix
MS_AIR_SHELF_Q = 0.707         # same Q as Quick tilt — gentle, musical

# Frequency-cutoff detection — finds the highest audible frequency in a file
# and expresses it as a percentage of Nyquist. Useful as an upsample sanity
# check: a 44.1 kHz source upsampled to 48 kHz still cuts off at ~20 kHz,
# which is ~83% of the 48 kHz Nyquist (24 kHz). A native 48 kHz source should
# reach ~22 kHz, or ~92% of Nyquist.
#
# Method: average STFT magnitude → smooth in log-frequency → walk down from
# the top bin to find the highest frequency where smoothed power is within
# THRESHOLD_DB of the in-band peak. -40 dB is the standard "effective
# bandwidth" threshold (matches spectrum-analyzer conventions).
CUTOFF_THRESHOLD_DB = -40.0    # below in-band peak → audible content boundary
CUTOFF_PCT_NYQUIST_WARN = 90.0 # <90% of Nyquist = flag as band-limited source
CUTOFF_PCT_NYQUIST_FULL = 97.0 # >=97% = full-bandwidth / no meaningful cutoff
CUTOFF_SMOOTH_OCT = 1.0 / 12.0 # 1/12 octave smoothing window (fine resolution)


# ---------------------------------------------------------------------------
# Shape helpers — mix_analyzer uses (2, N) stereo convention
# ---------------------------------------------------------------------------

def _ensure_stereo_2n(audio):
    """Normalize input to (2, N) stereo float64. Accepts (N,), (2, N), (N, 2)."""
    audio = np.asarray(audio, dtype=np.float64)
    if audio.ndim == 1:
        return np.stack([audio, audio], axis=0)
    if audio.shape[0] == 2:
        return audio
    if audio.shape[1] == 2:
        return audio.T
    return np.stack([audio[0], audio[0]], axis=0)


def _to_mono(y_stereo):
    return np.mean(y_stereo, axis=0)


# ---------------------------------------------------------------------------
# 1. Tonal tilt — RBJ high-shelf biquad
# ---------------------------------------------------------------------------

def apply_tilt_shelf(y_stereo, sr, gain_db):
    """High-shelf at 8 kHz. +dB brighter, -dB darker. Operates on (2, N)."""
    if abs(gain_db) < 0.1:
        return y_stereo

    A = 10 ** (gain_db / 40.0)
    w0 = 2 * np.pi * TILT_SHELF_FREQ / sr
    cos_w0 = np.cos(w0)
    sin_w0 = np.sin(w0)
    alpha = sin_w0 / (2 * TILT_SHELF_Q)
    sqrtA = np.sqrt(A)

    b0 = A * ((A + 1) + (A - 1) * cos_w0 + 2 * sqrtA * alpha)
    b1 = -2 * A * ((A - 1) + (A + 1) * cos_w0)
    b2 = A * ((A + 1) + (A - 1) * cos_w0 - 2 * sqrtA * alpha)
    a0 = (A + 1) - (A - 1) * cos_w0 + 2 * sqrtA * alpha
    a1 = 2 * ((A - 1) - (A + 1) * cos_w0)
    a2 = (A + 1) - (A - 1) * cos_w0 - 2 * sqrtA * alpha

    b = np.array([b0, b1, b2]) / a0
    a = np.array([1.0, a1 / a0, a2 / a0])

    out = np.empty_like(y_stereo)
    out[0] = sp_signal.lfilter(b, a, y_stereo[0])
    out[1] = sp_signal.lfilter(b, a, y_stereo[1])
    return out


# ---------------------------------------------------------------------------
# 1b. Reference-match EQ — six parametric bell filters
# ---------------------------------------------------------------------------

# Bell EQ frequencies: geometric mean of each parent band range.
# These match BAND_RANGES in mix_analyzer.py so EQ bell centers align with
# the band analysis. Q = 1.0 gives a gentle musical bell ~1 octave wide.
REF_MATCH_BANDS = [
    {"name": "sub",      "freq":   40.0, "q": 1.0},  # sqrt(20*80)
    {"name": "bass",     "freq":  141.4, "q": 1.0},  # sqrt(80*250)
    {"name": "low_mid",  "freq":  447.2, "q": 1.0},  # sqrt(250*800)
    {"name": "mid",      "freq": 1414.2, "q": 1.0},  # sqrt(800*2500)
    {"name": "presence", "freq": 3872.9, "q": 1.0},  # sqrt(2500*6000)
    {"name": "air",      "freq":10954.5, "q": 1.0},  # sqrt(6000*20000)
]

# Reference matching limits: how much EQ is too much to apply
REF_MATCH_MAX_BELL_DB = 4.0    # any single bell capped at ±4 dB
REF_MATCH_MIN_BELL_DB = 0.3    # don't bother rendering bells smaller than this


def _rbj_peaking_biquad(sr, freq, gain_db, q):
    """RBJ audio-EQ cookbook peaking-bell biquad. Returns (b, a) arrays."""
    A = 10 ** (gain_db / 40.0)
    w0 = 2 * np.pi * freq / sr
    cos_w0 = np.cos(w0)
    sin_w0 = np.sin(w0)
    alpha = sin_w0 / (2 * q)

    b0 = 1 + alpha * A
    b1 = -2 * cos_w0
    b2 = 1 - alpha * A
    a0 = 1 + alpha / A
    a1 = -2 * cos_w0
    a2 = 1 - alpha / A

    b = np.array([b0, b1, b2]) / a0
    a = np.array([1.0, a1 / a0, a2 / a0])
    return b, a


def apply_ref_match_eq(y_stereo, sr, bells):
    """Apply a cascade of bell filters to stereo audio.

    bells: list of {"freq": Hz, "gain_db": dB, "q": float}
    Skips bells whose |gain_db| is below REF_MATCH_MIN_BELL_DB.
    Operates on (2, N). Returns processed (2, N).
    """
    if not bells:
        return y_stereo

    out = y_stereo
    # Sum up SOS (cascade of biquads) then single filter pass per channel
    sos_list = []
    for bell in bells:
        g = float(bell.get("gain_db", 0.0))
        if abs(g) < REF_MATCH_MIN_BELL_DB:
            continue
        # Safety clamp — never apply more than the max per-bell gain
        g = float(np.clip(g, -REF_MATCH_MAX_BELL_DB, REF_MATCH_MAX_BELL_DB))
        f = float(bell.get("freq", 1000.0))
        q = float(bell.get("q", 1.0))
        b, a = _rbj_peaking_biquad(sr, f, g, q)
        # sp_signal.sosfilt expects [b0 b1 b2 a0 a1 a2]; since our a[0]=1
        # we can pack directly
        sos_list.append([b[0], b[1], b[2], 1.0, a[1], a[2]])

    if not sos_list:
        return y_stereo

    sos = np.array(sos_list)
    # Apply to each channel
    out = np.empty_like(y_stereo)
    out[0] = sp_signal.sosfilt(sos, y_stereo[0])
    out[1] = sp_signal.sosfilt(sos, y_stereo[1])
    return out


def compute_eq_response(bells, sr, n_points=256, fmin=20.0, fmax=20000.0):
    """Compute the combined magnitude response of a bell chain.

    Returns (freqs_hz, magnitude_db) — useful for UI visualization of the
    total EQ curve that will be applied.
    """
    freqs = np.logspace(np.log10(fmin), np.log10(fmax), n_points)
    # Start with 0 dB (linear 1.0)
    mag_total = np.ones_like(freqs)
    for bell in bells:
        g = float(bell.get("gain_db", 0.0))
        if abs(g) < REF_MATCH_MIN_BELL_DB:
            continue
        g = float(np.clip(g, -REF_MATCH_MAX_BELL_DB, REF_MATCH_MAX_BELL_DB))
        f = float(bell.get("freq", 1000.0))
        q = float(bell.get("q", 1.0))
        b, a = _rbj_peaking_biquad(sr, f, g, q)
        w, h = sp_signal.freqz(b, a, worN=freqs, fs=sr)
        mag_total *= np.abs(h)
    mag_db = 20 * np.log10(np.clip(mag_total, 1e-10, 1e10))
    return freqs, mag_db


# ---------------------------------------------------------------------------
# 2. Gain
# ---------------------------------------------------------------------------

def apply_gain(y_stereo, gain_db):
    if abs(gain_db) < 0.01:
        return y_stereo
    return y_stereo * (10 ** (gain_db / 20.0))


# ---------------------------------------------------------------------------
# 2b. Mid/Side utilities — mono-bass check + Side-channel high-pass
# ---------------------------------------------------------------------------
#
# M/S encoding rotates (L, R) into (Mid, Side) where:
#   M = (L + R) / 2   — content panned to center
#   S = (L - R) / 2   — content that differs between channels (stereo content)
#
# And the inverse:
#   L = M + S,  R = M - S
#
# This lets us process center and stereo content independently. For v1
# we use it for a single purpose: detecting and fixing stereo bass.

def _ms_encode(y_stereo):
    """(2,N) L/R -> (2,N) where row 0 is Mid, row 1 is Side."""
    mid  = 0.5 * (y_stereo[0] + y_stereo[1])
    side = 0.5 * (y_stereo[0] - y_stereo[1])
    return np.stack([mid, side], axis=0)


def _ms_decode(y_ms):
    """(2,N) M/S -> (2,N) L/R."""
    L = y_ms[0] + y_ms[1]
    R = y_ms[0] - y_ms[1]
    return np.stack([L, R], axis=0)


def analyze_ms_bass(y_stereo, sr, cutoff_hz=MS_BASS_ANALYZE_HZ):
    """Measure how much low-frequency energy sits in the Side channel.

    Returns a dict:
      {
        "side_bass_pct": float,      # 0..100, energy share of Side in low band
        "mid_bass_rms": float,       # raw RMS for debug
        "side_bass_rms": float,
        "cutoff_hz": float,
        "severity": "clean"|"mild"|"worth_fixing"|"severe",
        "is_mono": bool,             # if source is effectively mono, check is N/A
      }

    Method:
      1. M/S encode the source
      2. Low-pass both Mid and Side at `cutoff_hz` (4th-order Butterworth
         provides steep enough rolloff to isolate true low-frequency content
         without too much ringing on transients)
      3. Compute RMS of each low-passed signal
      4. side_bass_pct = S_rms / (M_rms + S_rms) * 100

    Why RMS not peak: we care about sustained energy distribution, not
    momentary transients. A single hi-hat hit doesn't skew the measurement.
    """
    # Mono-source guard — on a truly mono input the Side channel is silent
    # and the percentage is meaningless.
    ch_diff_rms = float(np.sqrt(np.mean((y_stereo[0] - y_stereo[1]) ** 2)))
    ch_total_rms = float(np.sqrt(np.mean((y_stereo[0] ** 2 + y_stereo[1] ** 2) / 2)))
    if ch_total_rms < 1e-6 or ch_diff_rms / (ch_total_rms + 1e-12) < 0.001:
        return {
            "side_bass_pct": 0.0,
            "mid_bass_rms": 0.0,
            "side_bass_rms": 0.0,
            "cutoff_hz": float(cutoff_hz),
            "severity": "clean",
            "is_mono": True,
        }

    ms = _ms_encode(y_stereo)
    # 4th-order Butterworth LP — roll off everything above cutoff.
    # sos form is numerically stabler than b/a at low frequencies.
    sos = sp_signal.butter(4, cutoff_hz / (sr / 2), btype="low", output="sos")
    mid_low  = sp_signal.sosfilt(sos, ms[0])
    side_low = sp_signal.sosfilt(sos, ms[1])

    mid_rms  = float(np.sqrt(np.mean(mid_low  ** 2)))
    side_rms = float(np.sqrt(np.mean(side_low ** 2)))
    total = mid_rms + side_rms
    if total < 1e-9:
        pct = 0.0
    else:
        pct = 100.0 * side_rms / total

    if   pct < MS_BASS_MILD_PCT:    severity = "clean"
    elif pct < MS_BASS_WORTH_PCT:   severity = "mild"
    elif pct < MS_BASS_SEVERE_PCT:  severity = "worth_fixing"
    else:                            severity = "severe"

    return {
        "side_bass_pct": round(pct, 1),
        "mid_bass_rms": mid_rms,
        "side_bass_rms": side_rms,
        "cutoff_hz": float(cutoff_hz),
        "severity": severity,
        "is_mono": False,
    }


def apply_side_highpass(y_stereo, sr, cutoff_hz=MS_HP_DEFAULT_HZ, order=2):
    """High-pass only the Side channel; Mid passes through unchanged.

    Effect: low frequencies become mono, mid/high frequencies keep their
    stereo image. Classic mastering move to tighten low end without
    narrowing the mix.

    order=2 is a 12 dB/oct slope — gentle enough not to audibly alter
    the material just above the cutoff, steep enough to remove the
    targeted mud zone.
    """
    if cutoff_hz <= 0:
        return y_stereo
    sos = sp_signal.butter(order, cutoff_hz / (sr / 2), btype="high", output="sos")
    ms = _ms_encode(y_stereo)
    # Filter Side only
    ms[1] = sp_signal.sosfilt(sos, ms[1])
    return _ms_decode(ms)


def analyze_ms_air(y_stereo, sr):
    """Measure air-band (8-16 kHz) energy gap between Mid and Side.

    Returns a dict:
      {
        "mid_air_db": float,        # RMS of Mid in air band, in dBFS
        "side_air_db": float,       # RMS of Side in air band
        "gap_db": float,            # mid_air_db - side_air_db (positive = Side darker)
        "severity": "clean"|"mild"|"worth_fixing"|"big_room",
        "suggested_shelf_db": float, # recommended shelf gain for Side
        "is_mono": bool,
      }

    Method:
      1. M/S encode the source
      2. Band-pass both channels between MS_AIR_ANALYZE_LO_HZ and MS_AIR_ANALYZE_HI_HZ
      3. Compute RMS of each, convert to dB
      4. gap = mid_db - side_db. Positive means Side is darker than Mid
         (the case where we can add air without affecting center elements).
    """
    # Mono guard — same as mono-bass check
    ch_diff_rms = float(np.sqrt(np.mean((y_stereo[0] - y_stereo[1]) ** 2)))
    ch_total_rms = float(np.sqrt(np.mean((y_stereo[0] ** 2 + y_stereo[1] ** 2) / 2)))
    if ch_total_rms < 1e-6 or ch_diff_rms / (ch_total_rms + 1e-12) < 0.001:
        return {
            "mid_air_db": -96.0,
            "side_air_db": -96.0,
            "gap_db": 0.0,
            "severity": "clean",
            "suggested_shelf_db": 0.0,
            "is_mono": True,
        }

    ms = _ms_encode(y_stereo)

    # Band-pass isolating the air region. 4th-order Butterworth in both
    # directions gives a clean 8-16 kHz window.
    nyq = sr / 2
    lo = MS_AIR_ANALYZE_LO_HZ / nyq
    # Clamp hi to well below Nyquist — e.g., at 44.1 kHz SR, nyq = 22050,
    # and 16000/22050 = 0.726, safe. But at unusual sample rates guard anyway.
    hi = min(MS_AIR_ANALYZE_HI_HZ / nyq, 0.95)
    if lo >= hi:
        # Sample rate too low to measure this band meaningfully — bail.
        return {
            "mid_air_db": -96.0,
            "side_air_db": -96.0,
            "gap_db": 0.0,
            "severity": "clean",
            "suggested_shelf_db": 0.0,
            "is_mono": False,
        }
    sos = sp_signal.butter(4, [lo, hi], btype="band", output="sos")
    mid_bp  = sp_signal.sosfilt(sos, ms[0])
    side_bp = sp_signal.sosfilt(sos, ms[1])

    def rms_db(x):
        r = float(np.sqrt(np.mean(x * x)))
        if r < 1e-9:
            return -96.0
        return 20.0 * np.log10(r)

    mid_db  = rms_db(mid_bp)
    side_db = rms_db(side_bp)
    gap = mid_db - side_db

    # Severity + suggested shelf gain. These scale together: bigger gap =
    # more headroom to boost, but we cap at +3 dB to stay musical.
    if gap < MS_AIR_MILD_DB:
        severity = "clean"
        shelf = 0.0
    elif gap < MS_AIR_WORTH_DB:
        severity = "mild"
        shelf = 1.5
    elif gap < MS_AIR_BIG_DB:
        severity = "worth_fixing"
        shelf = 2.5
    else:
        severity = "big_room"
        shelf = 3.0

    return {
        "mid_air_db": round(mid_db, 1),
        "side_air_db": round(side_db, 1),
        "gap_db": round(gap, 1),
        "severity": severity,
        "suggested_shelf_db": shelf,
        "is_mono": False,
    }


def apply_side_air_shelf(y_stereo, sr, gain_db, freq_hz=MS_AIR_SHELF_FREQ):
    """Apply a high-shelf boost only to the Side channel.

    Classic M/S mastering move — lifts air in stereo content (reverb tails,
    wide guitars, cymbal decays) while leaving center-panned elements
    (vocals, kick, snare) untouched. Results in a wider, airier mix without
    adding harshness to lead elements.

    Uses the same RBJ high-shelf math as apply_tilt_shelf, applied only to
    the Side channel of the M/S representation.
    """
    if abs(gain_db) < 0.1:
        return y_stereo

    A = 10 ** (gain_db / 40.0)
    w0 = 2 * np.pi * freq_hz / sr
    cos_w0 = np.cos(w0)
    sin_w0 = np.sin(w0)
    alpha = sin_w0 / (2 * MS_AIR_SHELF_Q)
    sqrtA = np.sqrt(A)

    b0 = A * ((A + 1) + (A - 1) * cos_w0 + 2 * sqrtA * alpha)
    b1 = -2 * A * ((A - 1) + (A + 1) * cos_w0)
    b2 = A * ((A + 1) + (A - 1) * cos_w0 - 2 * sqrtA * alpha)
    a0 = (A + 1) - (A - 1) * cos_w0 + 2 * sqrtA * alpha
    a1 = 2 * ((A - 1) - (A + 1) * cos_w0)
    a2 = (A + 1) - (A - 1) * cos_w0 - 2 * sqrtA * alpha

    b = np.array([b0, b1, b2]) / a0
    a = np.array([1.0, a1 / a0, a2 / a0])

    ms = _ms_encode(y_stereo)
    # Filter Side only; Mid passes through unchanged
    ms[1] = sp_signal.lfilter(b, a, ms[1])
    return _ms_decode(ms)


# ---------------------------------------------------------------------------
# Frequency-cutoff detection — upsample / band-limit sanity check
# ---------------------------------------------------------------------------

def analyze_frequency_cutoff(y_mono, sr,
                             threshold_db=CUTOFF_THRESHOLD_DB,
                             smooth_octaves=CUTOFF_SMOOTH_OCT):
    """Detect the effective audio bandwidth of a signal.

    Finds the highest frequency where the smoothed spectrum is still within
    `threshold_db` of the in-band peak. Expresses the result as Hz and as a
    percentage of Nyquist. Low % Nyquist on a high-SR file indicates the
    source was upsampled from a lower rate or was aggressively low-passed.

    Method:
      1. Reuse mix_analyzer.compute_stft_spectrum for the time-averaged
         magnitude spectrum (one STFT pass).
      2. Convert bin power to dB.
      3. Log-frequency smooth (moving window of +/- `smooth_octaves`) so one
         hot bin doesn't drag the result up. Median is more outlier-robust
         than mean here.
      4. Find the in-band peak (20 Hz to Nyquist * 0.99).
      5. Walk DOWN from the top bin, return the first freq at or above
         peak + threshold_db.

    Returns dict:
      cutoff_hz         — estimated audible cutoff (float, Hz)
      nyquist_hz        — sr / 2
      pct_nyquist       — cutoff_hz / nyquist_hz * 100
      threshold_db      — the relative level used (negative, e.g. -40)
      peak_db           — the in-band peak level (for reference)
      verdict           — "full_band" | "normal" | "band_limited"
      sample_rate       — sr (echoed for convenience)
      detail            — short human-readable explanation
    """
    from mix_analyzer import compute_stft_spectrum

    y = np.asarray(y_mono, dtype=np.float64).ravel()
    nyq = sr / 2.0

    # Guard against pathologically short signals
    if y.size < 4096:
        return {
            "cutoff_hz":    None,
            "nyquist_hz":   round(nyq, 1),
            "pct_nyquist":  None,
            "threshold_db": threshold_db,
            "peak_db":      None,
            "verdict":      "unknown",
            "sample_rate":  int(sr),
            "detail":       "Signal too short to analyze cutoff",
        }

    freqs, bin_power, _ = compute_stft_spectrum(y, sr)

    # Convert to dB. Guard against log(0) on silent bins.
    with np.errstate(divide="ignore"):
        bin_db = 10.0 * np.log10(np.maximum(bin_power, 1e-30))

    # Log-frequency smoothing: for each bin, take the median dB of all bins
    # within +/- smooth_octaves. Skip DC (freqs[0] == 0).
    if freqs[0] <= 0:
        start_idx = 1
    else:
        start_idx = 0
    smoothed = np.full_like(bin_db, -200.0)
    log_window = smooth_octaves   # already in octaves
    for i in range(start_idx, len(freqs)):
        f = freqs[i]
        f_lo = f * (2.0 ** (-log_window))
        f_hi = f * (2.0 ** ( log_window))
        mask = (freqs >= f_lo) & (freqs <= f_hi)
        if np.any(mask):
            smoothed[i] = float(np.median(bin_db[mask]))

    # Find in-band peak (ignore DC and the very top 1% of Nyquist which can
    # carry anti-alias artifacts).
    in_band = (freqs >= 20.0) & (freqs <= nyq * 0.99)
    if not np.any(in_band):
        return {
            "cutoff_hz":    None,
            "nyquist_hz":   round(nyq, 1),
            "pct_nyquist":  None,
            "threshold_db": threshold_db,
            "peak_db":      None,
            "verdict":      "unknown",
            "sample_rate":  int(sr),
            "detail":       "No in-band content",
        }

    peak_db = float(np.max(smoothed[in_band]))

    # Silence / near-silence check — if the in-band peak is below a floor, we
    # can't meaningfully detect a cutoff (everything is noise or zeros).
    if peak_db < -80.0:
        return {
            "cutoff_hz":    None,
            "nyquist_hz":   round(nyq, 1),
            "pct_nyquist":  None,
            "threshold_db": threshold_db,
            "peak_db":      round(peak_db, 1),
            "verdict":      "unknown",
            "sample_rate":  int(sr),
            "detail":       "Signal too quiet to detect a cutoff",
        }

    target_db = peak_db + threshold_db   # threshold_db is negative

    # Walk DOWN from the highest in-band bin. The first bin at or above
    # target_db is the cutoff.
    in_band_idx = np.where(in_band)[0]
    cutoff_hz = None
    for idx in reversed(in_band_idx):
        if smoothed[idx] >= target_db:
            cutoff_hz = float(freqs[idx])
            break

    if cutoff_hz is None:
        # Nothing above target anywhere — signal is essentially silent.
        return {
            "cutoff_hz":    None,
            "nyquist_hz":   round(nyq, 1),
            "pct_nyquist":  None,
            "threshold_db": threshold_db,
            "peak_db":      round(peak_db, 1),
            "verdict":      "unknown",
            "sample_rate":  int(sr),
            "detail":       "Signal too quiet to detect a cutoff",
        }

    pct = (cutoff_hz / nyq) * 100.0 if nyq > 0 else 0.0

    if pct >= CUTOFF_PCT_NYQUIST_FULL:
        verdict = "full_band"
        detail = (f"Full-bandwidth source — content extends to {cutoff_hz/1000:.1f} kHz "
                  f"({pct:.0f}% of the {nyq/1000:.1f} kHz Nyquist).")
    elif pct >= CUTOFF_PCT_NYQUIST_WARN:
        verdict = "normal"
        detail = (f"Native high-rate content — reaches {cutoff_hz/1000:.1f} kHz "
                  f"({pct:.0f}% of Nyquist).")
    else:
        verdict = "band_limited"
        # Try to identify a common upstream sample rate
        hint = ""
        # 20-21 kHz with Nyquist much higher → likely 44.1 kHz source upsampled
        if cutoff_hz < 22000 and nyq > 23000:
            hint = " Likely a 44.1/48 kHz source upsampled, or a low-pass filter is active."
        elif cutoff_hz < 16000:
            hint = " A low-pass filter is removing audible content — verify this is intentional."
        detail = (f"Content cuts off at {cutoff_hz/1000:.1f} kHz "
                  f"({pct:.0f}% of the {nyq/1000:.1f} kHz Nyquist).{hint}")

    return {
        "cutoff_hz":    round(cutoff_hz, 1),
        "nyquist_hz":   round(nyq, 1),
        "pct_nyquist":  round(pct, 1),
        "threshold_db": threshold_db,
        "peak_db":      round(peak_db, 1),
        "verdict":      verdict,
        "sample_rate":  int(sr),
        "detail":       detail,
    }


# ---------------------------------------------------------------------------
# 3. True-peak limiter — lookahead + soft knee + oversampled peak detection
# ---------------------------------------------------------------------------

def apply_limiter(
    y_stereo, sr,
    ceiling_dbfs=DEFAULT_CEILING_DBFS,
    lookahead_ms=LIMITER_LOOKAHEAD_MS,
    release_ms=LIMITER_RELEASE_MS,
    oversample=LIMITER_OVERSAMPLE,
):
    """Musical lookahead limiter with oversampled true-peak detection.
    Input: (2, N) stereo. Returns (limited, stats_dict)."""
    ceiling_linear = 10 ** (ceiling_dbfs / 20.0)
    lookahead_samples = int(sr * lookahead_ms / 1000.0)
    release_samples = max(1, int(sr * release_ms / 1000.0))
    n = y_stereo.shape[1]

    # Detect peaks on oversampled audio to catch inter-sample peaks
    if oversample > 1:
        up = sp_signal.resample_poly(y_stereo, oversample, 1, axis=1)
        peak_up = np.max(np.abs(up), axis=0)
        trimmed = peak_up[: n * oversample]
        peak_env = trimmed.reshape(n, oversample).max(axis=1)
    else:
        peak_env = np.max(np.abs(y_stereo), axis=0)

    # Required instantaneous gain reduction
    knee_linear = 10 ** ((ceiling_dbfs - LIMITER_KNEE_DB) / 20.0)
    required_gain = np.ones_like(peak_env)

    over_knee = peak_env > knee_linear
    if np.any(over_knee):
        full_limit = peak_env > ceiling_linear
        knee_region = over_knee & ~full_limit

        if np.any(full_limit):
            required_gain[full_limit] = ceiling_linear / peak_env[full_limit]

        if np.any(knee_region):
            knee_pos = (peak_env[knee_region] - knee_linear) / (ceiling_linear - knee_linear)
            target_gain = ceiling_linear / peak_env[knee_region]
            required_gain[knee_region] = 1.0 - (1.0 - target_gain) * (knee_pos ** 2)

    # Lookahead: start reducing before the peak
    if lookahead_samples > 0:
        shifted = np.concatenate([required_gain[lookahead_samples:], np.ones(lookahead_samples)])
        required_gain = np.minimum(required_gain, shifted)

    # Release smoother — attack instant, release one-pole
    release_coeff = np.exp(-1.0 / release_samples)
    gain_env = np.empty_like(required_gain)
    gain_env[0] = required_gain[0]
    for i in range(1, len(required_gain)):
        if required_gain[i] < gain_env[i - 1]:
            gain_env[i] = required_gain[i]
        else:
            gain_env[i] = required_gain[i] + (gain_env[i - 1] - required_gain[i]) * release_coeff

    limited = y_stereo * gain_env[np.newaxis, :]

    reduction_db = -20 * np.log10(np.clip(gain_env, 1e-10, 1.0))
    active = reduction_db > 0.01
    stats = {
        "max_gain_reduction_db": float(np.max(reduction_db)) if len(reduction_db) else 0.0,
        "avg_gain_reduction_db": float(np.mean(reduction_db[active])) if np.any(active) else 0.0,
        "samples_limited": int(np.sum(active)),
        "pct_limited": float(100.0 * np.sum(active) / len(reduction_db)),
    }
    return limited, stats


# ---------------------------------------------------------------------------
# 4. Dither (TPDF) — only for 16-bit reduction
# ---------------------------------------------------------------------------

def apply_dither_tpdf(y_stereo, target_bits=16):
    if target_bits >= 24:
        return y_stereo
    lsb = 2.0 / (2 ** target_bits)
    rng = np.random.default_rng()
    noise = (rng.random(y_stereo.shape) - rng.random(y_stereo.shape)) * lsb
    return y_stereo + noise


# ---------------------------------------------------------------------------
# Measurement — reuse the analyzer's ffmpeg path for parity
# ---------------------------------------------------------------------------

def measure_from_array(y_stereo, sr):
    """Write a temp WAV and run the project's measure_ffmpeg() so that
    numbers match the main analyzer bit-for-bit. Falls back to pyloudnorm
    + scipy if ffmpeg fails."""
    y_stereo = _ensure_stereo_2n(y_stereo)

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        tmp_path = tf.name
    try:
        import soundfile as sf
        sf.write(tmp_path, y_stereo.T.astype(np.float32), sr, subtype="FLOAT")
        meas = measure_ffmpeg(tmp_path)

        if meas.get("peak") is None:
            meas["peak"] = true_peak_db(_to_mono(y_stereo))
        if meas.get("lufs") is None:
            try:
                import pyloudnorm as pyln
                meter = pyln.Meter(sr)
                meas["lufs"] = float(meter.integrated_loudness(y_stereo.T))
            except Exception:
                meas["lufs"] = None
        return meas
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


# ---------------------------------------------------------------------------
# The full chain
# ---------------------------------------------------------------------------

def run_chain(y_stereo, sr, config):
    """Execute the mastering chain per config.

    Config schema:
      {
        "tilt":    {"enabled": bool, "gain_db": float},
        "gain":    {"enabled": bool, "gain_db": float},
        "limiter": {"enabled": bool, "ceiling_dbfs": float},
        "target_lufs": float | None,
      }
    Returns (processed_2N, stats_dict).
    """
    stats = {"stages": []}
    y = _ensure_stereo_2n(y_stereo).copy()

    # Stage 1: Tilt
    tilt_cfg = config.get("tilt", {})
    if tilt_cfg.get("enabled") and abs(tilt_cfg.get("gain_db", 0.0)) >= 0.1:
        g = float(np.clip(tilt_cfg["gain_db"], -MAX_TILT_DB, MAX_TILT_DB))
        y = apply_tilt_shelf(y, sr, g)
        stats["stages"].append({"name": "tilt", "gain_db": g, "freq_hz": TILT_SHELF_FREQ})

    # Stage 1b: Reference-match EQ (between tilt and gain)
    ref_cfg = config.get("ref_match", {})
    if ref_cfg.get("enabled"):
        bells = ref_cfg.get("bells", [])
        # Only apply bells marked as enabled
        active_bells = [b for b in bells if b.get("enabled")]
        if active_bells:
            y = apply_ref_match_eq(y, sr, active_bells)
            stats["stages"].append({
                "name": "ref_match",
                "bells": [
                    {"band": b.get("band"),
                     "freq": b.get("freq"),
                     "gain_db": float(np.clip(b.get("gain_db", 0.0),
                                              -REF_MATCH_MAX_BELL_DB,
                                              REF_MATCH_MAX_BELL_DB)),
                     "q": b.get("q", 1.0)}
                    for b in active_bells
                    if abs(b.get("gain_db", 0.0)) >= REF_MATCH_MIN_BELL_DB
                ],
            })

    # Stage 1c: Genre-match EQ (between ref_match and gain)
    # Same DSP as ref_match, different source of bell values. Chain order
    # places genre after ref so a loaded reference track takes precedence
    # in practice (user sees its effect first), and genre acts as a final
    # tonal nudge on top.
    genre_cfg = config.get("genre_match", {})
    if genre_cfg.get("enabled"):
        bells = genre_cfg.get("bells", [])
        active_bells = [b for b in bells if b.get("enabled")]
        if active_bells:
            y = apply_ref_match_eq(y, sr, active_bells)
            stats["stages"].append({
                "name": "genre_match",
                "mode": genre_cfg.get("mode", "suggested"),
                "bells": [
                    {"band": b.get("band"),
                     "freq": b.get("freq"),
                     "gain_db": float(np.clip(b.get("gain_db", 0.0),
                                              -REF_MATCH_MAX_BELL_DB,
                                              REF_MATCH_MAX_BELL_DB)),
                     "q": b.get("q", 1.0)}
                    for b in active_bells
                    if abs(b.get("gain_db", 0.0)) >= REF_MATCH_MIN_BELL_DB
                ],
            })

    # Stage 1c: Mono-bass cleanup (Side-channel high-pass)
    ms_cfg = config.get("ms_hp_sides", {})
    if ms_cfg.get("enabled"):
        ms_cutoff = float(ms_cfg.get("cutoff_hz", MS_HP_DEFAULT_HZ))
        # Safety clamp — don't allow cutoff so high it would hollow out the mix
        ms_cutoff = float(np.clip(ms_cutoff, 40.0, 250.0))
        y = apply_side_highpass(y, sr, cutoff_hz=ms_cutoff)
        stats["stages"].append({
            "name": "ms_hp_sides",
            "cutoff_hz": round(ms_cutoff, 1),
        })

    # Stage 1d: Sides-air boost (Side-channel high-shelf)
    air_cfg = config.get("ms_air_shelf", {})
    if air_cfg.get("enabled"):
        air_gain = float(air_cfg.get("gain_db", 0.0))
        # Safety clamp — same +-4 dB ceiling as the 6-band bells, applied
        # one-sided here (negative gain is technically valid but not the
        # intended use case for this card)
        air_gain = float(np.clip(air_gain, -4.0, 4.0))
        if abs(air_gain) >= 0.1:
            air_freq = float(air_cfg.get("freq_hz", MS_AIR_SHELF_FREQ))
            y = apply_side_air_shelf(y, sr, gain_db=air_gain, freq_hz=air_freq)
            stats["stages"].append({
                "name": "ms_air_shelf",
                "gain_db": round(air_gain, 2),
                "freq_hz": round(air_freq, 0),
            })

    # Stage 2: Pre-gain
    #
    # Auto-correction: if target_lufs is set AND gain is enabled, re-compute
    # gain_db from the actual LUFS at this point in the chain (after tilt /
    # ref_match / genre_match / ms_hp_sides / ms_air_shelf), not from the
    # frontend's source_lufs minus target_lufs. This matters because LUFS is
    # K-weighted — tonal EQ stages can shift integrated loudness by ±0.5 dB
    # without changing any gain, so the frontend's gain calculation is
    # systematically off by whatever the EQ stages did.
    #
    # The override only fires when BOTH conditions are met:
    #   - config["target_lufs"] is not None (the user has set a loudness target)
    #   - gain_cfg["enabled"] is True (loudness stage is active)
    #
    # In Tonal Mode (loudness off) or when no target is set, we honor the
    # config's gain_db exactly so behavior is predictable.
    gain_cfg = config.get("gain", {})
    if gain_cfg.get("enabled"):
        target_lufs = config.get("target_lufs")
        original_gain_db = float(np.clip(gain_cfg.get("gain_db", 0.0),
                                          -MAX_PREGAIN_DB, MAX_PREGAIN_DB))
        g = original_gain_db
        correction_info = None

        if target_lufs is not None:
            # Measure integrated LUFS at this point in the chain.
            # Using pyloudnorm directly (BS.1770-4, same algorithm ffmpeg uses)
            # avoids writing a temp file — cheap enough to run on every preview.
            try:
                import pyloudnorm as pyln
                meter = pyln.Meter(sr)
                pre_gain_lufs = float(meter.integrated_loudness(y.T))
                # Gain = target - current. Clip to sane range so bad measurements
                # (e.g., -inf LUFS on silent audio) can't request absurd gains.
                corrected = float(np.clip(target_lufs - pre_gain_lufs,
                                           -MAX_PREGAIN_DB, MAX_PREGAIN_DB))
                correction_info = {
                    "pre_gain_lufs": round(pre_gain_lufs, 2),
                    "target_lufs":   round(float(target_lufs), 2),
                    "frontend_gain_db":  round(original_gain_db, 2),
                    "corrected_gain_db": round(corrected, 2),
                    "delta_db":          round(corrected - original_gain_db, 2),
                }
                g = corrected
            except Exception as e:
                # Measurement failure: fall back to the frontend's gain_db.
                # No worse than the pre-fix behavior — the chain still runs.
                correction_info = {"error": str(e)}

        y = apply_gain(y, g)
        stage_stats = {"name": "gain", "gain_db": round(g, 2)}
        if correction_info is not None:
            stage_stats["auto_correction"] = correction_info
        stats["stages"].append(stage_stats)

    # Stage 3: Limiter
    lim_cfg = config.get("limiter", {})
    if lim_cfg.get("enabled"):
        ceiling = float(lim_cfg.get("ceiling_dbfs", DEFAULT_CEILING_DBFS))
        y, lim_stats = apply_limiter(y, sr, ceiling_dbfs=ceiling)
        stats["stages"].append({"name": "limiter", "ceiling_dbfs": ceiling, **lim_stats})

        # Stage 3b: Post-limiter safety trim.
        #
        # The limiter's soft-knee and lookahead-release interactions can let
        # a small fraction of true peaks (typically inter-sample) slip 0.05 –
        # 0.3 dB above the requested ceiling. Most commercial limiters handle
        # this with a two-pass approach: detect overshoot, apply a tiny
        # broadband gain reduction to guarantee the ceiling is honored.
        #
        # We do the same, but with an extra twist: we aim slightly below the
        # ceiling (by SAFETY_MARGIN_DB) because our in-chain peak detector
        # (scipy 4x resample_poly) and the post-master verification peak
        # detector (ffmpeg ebur128) can disagree by up to ~0.15 dB on the
        # same audio. Trimming to `ceiling - margin` guarantees the ffmpeg
        # reading will be at or below ceiling, so the UI's "pass / outside
        # target" status is honest.
        #
        # Tradeoff: masters end up 0.15 dB quieter than the slider says.
        # That's below audibility and a fair price for a truthful display.
        # Cap total trim at -0.5 dB so a badly misconfigured chain can't
        # silently quieten the output by a lot.
        SAFETY_MARGIN_DB = 0.15
        target_peak = ceiling - SAFETY_MARGIN_DB
        try:
            # True peak is measured per-channel, not on the mono mixdown —
            # out-of-phase content can partially cancel in the mono sum and
            # hide the actual channel peak. This matches what BS.1770-4
            # true-peak does (max across channels).
            tp_left = true_peak_db(y[0])
            tp_right = true_peak_db(y[1])
            post_peak = max(tp_left, tp_right)
            if post_peak is not None and post_peak > target_peak:
                trim_db = target_peak - post_peak  # small negative
                trim_db = max(trim_db, -0.5)       # don't over-correct
                y = apply_gain(y, trim_db)
                stats["stages"].append({
                    "name": "peak_safety_trim",
                    "trim_db": round(float(trim_db), 2),
                    "pre_trim_peak_dbfs": round(float(post_peak), 2),
                    "ceiling_dbfs": round(float(ceiling), 2),
                    "safety_margin_db": SAFETY_MARGIN_DB,
                })
        except Exception:
            # Peak measurement is best-effort; never fail the chain on it.
            pass

    # NOTE: previously this function ran a final LUFS trim stage that
    # measured the post-chain audio and adjusted gain to land exactly on
    # target_lufs. That was removed because it competed with the user's
    # gain slider — the slider would move, but the trim would cancel it out,
    # making the slider feel inert. The Loudness card now follows a simpler
    # model: the user picks a target LUFS, the gain stage computes
    # gain_db = target - current on the frontend, and whatever comes out
    # comes out. Limiter reduction may pull the final LUFS slightly under
    # the target; that's honest and visible in post-master verification.
    #
    # The config key `target_lufs` is still carried through for display
    # purposes (so post-master verification can show "target X · pass/fail")
    # but it no longer drives an extra DSP stage.

    # Post-chain peak-safety check.
    # When the limiter is disabled, tonal processing (tilt, future Tier 2
    # moves like saturation or M/S EQ) can push true peaks above the intended
    # ceiling. We don't silently fix it — we measure and surface a warning so
    # the user can decide whether to enable the limiter as a safety net.
    intended_ceiling = float((lim_cfg or {}).get("ceiling_dbfs", DEFAULT_CEILING_DBFS))
    if not lim_cfg.get("enabled"):
        try:
            post_peak = true_peak_db(_to_mono(y))
            if post_peak > intended_ceiling + 0.05:
                stats["peak_safety_warning"] = {
                    "measured_peak_dbfs": round(float(post_peak), 2),
                    "intended_ceiling_dbfs": round(intended_ceiling, 2),
                    "overshoot_db": round(float(post_peak - intended_ceiling), 2),
                    "message": (
                        f"True peak after processing is {post_peak:+.2f} dBFS, "
                        f"above the intended ceiling of {intended_ceiling:+.1f} dBFS. "
                        f"Enable the True-peak limiter card as a safety net, or "
                        f"reduce tonal moves that lift high frequencies."
                    ),
                }
        except Exception:
            # Peak measurement is best-effort; never fail the chain on it
            pass

    return y, stats


def classify_source(loudness):
    """Classify a source file by what mastering mode makes sense for it.

    Returns a dict:
      {
        "level":      "heavy" | "at_loudness" | "ready" | "quiet" | "unknown",
        "lufs":       float,
        "peak_dbfs":  float,
        "crest_db":   float,
        "lra_lu":     float,
        "title":      short label for the UI banner,
        "message":    human-readable explanation,
        "severity":   "warn" | "info" | "ok" | "note",
        "heuristic":  extra note about inferred processing (pre-limiter, etc.)
        "tonal_mode_recommended": bool,  # whether we'd suggest Tonal Mode
      }
    """
    lufs  = loudness.get("integrated_lufs")
    peak  = loudness.get("true_peak_dbfs")
    crest = loudness.get("crest_factor_db")
    lra   = loudness.get("loudness_range_lra")

    if lufs is None:
        return {
            "level": "unknown",
            "lufs": None, "peak_dbfs": peak, "crest_db": crest, "lra_lu": lra,
            "title": "Source unanalyzed",
            "message": "Could not measure integrated loudness. Mastering can still run but preflight checks are unavailable.",
            "severity": "note",
            "heuristic": None,
            "tonal_mode_recommended": False,
        }

    # Limiter-activity heuristic — combines LUFS + crest + LRA.
    # Cubase Maximizer / gentle bus limiting: high LUFS BUT high crest (>13 dB)
    #   and moderate LRA (>5 LU) means transients survived → gentle limiting.
    # Aggressive pre-mastering: high LUFS + low crest (<10 dB) + low LRA (<4 LU)
    #   means the mix has been squashed.
    if crest is not None and crest < 10 and lufs > -13:
        heuristic = ("Low crest factor (<10 dB) combined with high loudness "
                     "suggests aggressive pre-mastering. Tonal moves still work, "
                     "but dynamics cannot be restored.")
    elif crest is not None and crest >= 13 and lufs > -14 and lufs <= -10:
        heuristic = ("Healthy crest factor with high loudness suggests gentle "
                     "bus limiting (like Cubase Maximizer) — not aggressive "
                     "pre-mastering. Tonal moves will work well.")
    elif crest is not None and crest >= 15:
        heuristic = "Strong dynamics preserved — good headroom for any mastering move."
    else:
        heuristic = None

    # Level classification
    # Boundaries chosen so "ready to master" means Classic mastering will do
    # meaningful work (at least ~2 dB of gain + possibly some limiting).
    if lufs > -10.0:
        level = "heavy"
        title = "Heavily pre-limited source"
        severity = "warn"
        message = (
            f"Integrated loudness is {lufs:.1f} LUFS — well above streaming "
            f"targets. A loudness-targeted master cannot add to this without "
            f"distortion. Tonal work is still possible, but for best results, "
            f"re-bounce the mix with at least 6 dB more headroom."
        )
        tonal_mode_recommended = True

    elif lufs > -14.0:
        # Already at or above streaming target — Classic mastering will apply
        # less than ~1.5 dB of gain, which is effectively a no-op.
        level = "at_loudness"
        title = "Source at streaming loudness"
        severity = "info"
        delta_needed = -14.0 - lufs
        message = (
            f"Integrated loudness is {lufs:.1f} LUFS — already at or above "
            f"the streaming target (-14 LUFS). Classic mastering would apply "
            f"only {delta_needed:+.1f} dB of gain, which is effectively a no-op. "
            f"Consider Tonal Mode to focus on EQ and dynamic shaping instead."
        )
        tonal_mode_recommended = True

    elif lufs >= -20.0:
        level = "ready"
        title = "Source ready to master"
        severity = "ok"
        message = (
            f"Integrated loudness is {lufs:.1f} LUFS — good headroom for "
            f"mastering. Classic mastering will bring this to streaming "
            f"targets with gentle limiting."
        )
        tonal_mode_recommended = False

    else:
        level = "quiet"
        title = "Quiet source — extra gain needed"
        severity = "note"
        message = (
            f"Integrated loudness is {lufs:.1f} LUFS — a fair amount of gain "
            f"will be applied ({-14.0 - lufs:+.1f} dB). Verify the mix isn't "
            f"unintentionally quiet before mastering."
        )
        tonal_mode_recommended = False

    return {
        "level": level,
        "lufs": round(lufs, 1),
        "peak_dbfs": round(peak, 1) if peak is not None else None,
        "crest_db": round(crest, 1) if crest is not None else None,
        "lra_lu": round(lra, 1) if lra is not None else None,
        "title": title,
        "message": message,
        "severity": severity,
        "heuristic": heuristic,
        "tonal_mode_recommended": tonal_mode_recommended,
    }


# ---------------------------------------------------------------------------
# Suggestion builder — reads analyzer report, proposes chain + UI cards
# ---------------------------------------------------------------------------

def propose_chain(analysis, target_lufs=DEFAULT_TARGET_LUFS,
                  ceiling_dbfs=DEFAULT_CEILING_DBFS,
                  tonal_mode=False):
    """Turn an analyzer report into a proposed chain + suggestion cards.

    Understands the real report shape:
      report["loudness"]["integrated_lufs"]  (float or None)
      report["loudness"]["true_peak_dbfs"]   (float or None)
      report["spectrum"]["bands"][<band>]["delta_db"]  (float)

    tonal_mode (bool): when True, the proposed chain defaults loudness/limiter
      OFF and focuses cards on tonal work. When False (classic), loudness +
      limiter default ON as before.
    """
    loudness = analysis.get("loudness", {}) or {}
    spectrum = analysis.get("spectrum", {}) or {}
    bands = spectrum.get("bands", {}) or {}

    current_lufs = loudness.get("integrated_lufs")
    current_peak = loudness.get("true_peak_dbfs")
    if current_lufs is None:
        current_lufs = -20.0
    if current_peak is None:
        current_peak = -6.0

    # Classify the source for the UI
    source_verdict = classify_source(loudness)

    # Pre-flight warnings — keep the legacy flat list for backward-compat UI,
    # but populate it from the verdict now.
    warnings = []
    if source_verdict["severity"] == "warn":
        warnings.append(source_verdict["message"])
    if current_peak is not None and current_peak > 0.0:
        warnings.append(
            f"Source is clipping at {current_peak:+.1f} dBFS. Lower your mix "
            "bus output before bouncing."
        )

    # Decide default acceptance based on mode.
    # Classic mode: gain + limiter ON (drive to streaming target).
    # Tonal mode:   gain + limiter OFF by default — preserve upstream loudness,
    #               focus the chain on tonal/dynamic shaping instead.
    gain_accept_default    = not tonal_mode
    limiter_accept_default = not tonal_mode

    # Suggestion 1: gain
    # Simple: gain_db = target - current. No headroom reservation; limiter
    # handles peaks. The user-facing slider adjusts `target_lufs`, and the
    # frontend recomputes gain_db on every slider change.
    gain_needed = target_lufs - current_lufs
    pre_gain = gain_needed

    gain_rationale_classic = (
        f"Current integrated loudness is {current_lufs:.1f} LUFS. "
        f"To reach {target_lufs:.0f} LUFS (Spotify/YouTube/Bandcamp target), "
        f"apply {pre_gain:+.1f} dB of gain. Drag the target slider to aim higher or lower."
    )
    gain_rationale_tonal = (
        f"Tonal Mode preserves upstream loudness ({current_lufs:.1f} LUFS). "
        f"Gain is off by default. Enable only if you want the master to aim "
        f"at a specific LUFS target — otherwise the export keeps your "
        f"bounce loudness intact."
    )

    gain_suggestion = {
        "step": "gain",
        "accept": gain_accept_default,
        "title": "Loudness",
        "numbers": {
            "current_lufs": round(current_lufs, 1),
            "target_lufs": float(target_lufs),
            "gain_db": round(pre_gain, 1),
        },
        "rationale": gain_rationale_tonal if tonal_mode else gain_rationale_classic,
    }

    # Suggestion 2: limiter
    post_gain_peak = current_peak + pre_gain
    expected_reduction = max(0.0, post_gain_peak - ceiling_dbfs)

    limiter_rationale_classic = (
        f"Ceiling at {ceiling_dbfs:.1f} dBFS with {LIMITER_OVERSAMPLE}× "
        f"oversampled peak detection — protects against inter-sample "
        f"clipping when encoded to MP3/AAC. "
        + (f"Expecting ~{expected_reduction:.1f} dB peak reduction."
           if expected_reduction > 0.2
           else "Current peaks leave enough headroom — minimal limiting expected.")
    )
    limiter_rationale_tonal = (
        f"Off by default in Tonal Mode. Your upstream bus limiter is already "
        f"handling peaks. Re-enable only as a safety net if tonal moves risk "
        f"pushing peaks above {ceiling_dbfs:.1f} dBFS."
    )

    limiter_suggestion = {
        "step": "limiter",
        "accept": limiter_accept_default,
        "title": "True-peak limiter",
        "numbers": {
            "ceiling_dbfs": float(ceiling_dbfs),
            "expected_reduction_db": round(expected_reduction, 1),
            "oversample": LIMITER_OVERSAMPLE,
        },
        "rationale": limiter_rationale_tonal if tonal_mode else limiter_rationale_classic,
    }

    # Suggestion 3: tilt — in Classic mode, off by default (opt-in). In Tonal
    # mode, ON by default when a useful move was detected, since the point of
    # Tonal Mode is tonal/dynamic work.
    presence_delta = (bands.get("presence", {}) or {}).get("delta_db", 0.0)
    air_delta = (bands.get("air", {}) or {}).get("delta_db", 0.0)
    high_tilt = (presence_delta + air_delta) / 2.0

    tilt_gain = 0.0
    needs_tilt = abs(high_tilt) > 2.0
    if needs_tilt:
        tilt_gain = float(np.clip(-high_tilt * 0.5, -MAX_TILT_DB, MAX_TILT_DB))

    tilt_accept_default = bool(tonal_mode and needs_tilt)

    tilt_suggestion = {
        "step": "tilt",
        "accept": tilt_accept_default,
        "title": "Quick tilt" + ("" if tonal_mode else " (optional)"),
        "numbers": {
            "shelf_freq_hz": TILT_SHELF_FREQ,
            "gain_db": round(tilt_gain, 1),
            "presence_delta_db": round(presence_delta, 1),
            "air_delta_db": round(air_delta, 1),
        },
        "rationale": (
            f"High-frequency content is {high_tilt:+.1f} dB vs genre average "
            f"(presence {presence_delta:+.1f}, air {air_delta:+.1f}). "
            + (f"A gentle {tilt_gain:+.1f} dB shelf at 8 kHz would half-correct this. "
               + ("On by default in Tonal Mode." if tonal_mode
                  else "Off by default — prefer to fix in the mix if possible.")
               if needs_tilt else "Within normal range — no tilt needed.")
        ),
    }

    config = {
        "tilt":    {"enabled": tilt_suggestion["accept"], "gain_db": tilt_gain},
        "gain":    {"enabled": gain_suggestion["accept"],   "gain_db": pre_gain},
        "limiter": {"enabled": limiter_suggestion["accept"], "ceiling_dbfs": ceiling_dbfs},
        "target_lufs": float(target_lufs),
    }

    return {
        "config": config,
        "suggestions": [gain_suggestion, limiter_suggestion, tilt_suggestion],
        "targets": {"lufs": float(target_lufs), "true_peak_dbfs": float(ceiling_dbfs)},
        "warnings": warnings,
        "source_metrics": {
            "integrated_lufs": round(current_lufs, 1),
            "true_peak_dbfs": round(current_peak, 1),
            "crest_db": round(loudness.get("crest_factor_db"), 1) if loudness.get("crest_factor_db") is not None else None,
            "lra_lu": round(loudness.get("loudness_range_lra"), 1) if loudness.get("loudness_range_lra") is not None else None,
        },
        "source_verdict": source_verdict,
        "mode": "tonal" if tonal_mode else "classic",
    }


# ---------------------------------------------------------------------------
# Reference matching
# ---------------------------------------------------------------------------
# The flow:
#   1. User uploads reference track (WAV/FLAC/AIFF only — purist mode)
#   2. We measure reference spectrum with the same pipeline as the source
#   3. Express both mix and reference on the vs-pink scale so loudness is
#      normalized out of the comparison
#   4. Compute per-band deltas (mix vs reference, on vs-pink scale)
#   5. Propose half-correction bell EQs at each parent band center
#   6. User accepts / adjusts / rejects each bell
#   7. DSP chain applies the approved bells as a cascade of RBJ biquads

def measure_reference_spectrum(ref_path):
    """Analyze a reference track for spectrum matching.
    Returns vs-pink band values + overall metrics, no tonal recommendations.

    This is a lightweight pass — doesn't run the full analyze() pipeline,
    just what's needed for band-level comparison.
    """
    from mix_analyzer import (
        load_audio, compute_stft_spectrum, stft_band_energy_db,
        BAND_RANGES, rms_db, _ensure_pink_offsets,
    )
    # Also import pyloudnorm for integrated LUFS
    import pyloudnorm as pyln

    y_stereo, y_mono, sr = load_audio(ref_path)
    duration = len(y_mono) / sr

    # Overall RMS
    overall_rms = rms_db(y_mono)

    # LUFS — pyloudnorm so we don't need to spawn ffmpeg for reference
    try:
        meter = pyln.Meter(sr)
        ref_lufs = float(meter.integrated_loudness(y_mono.reshape(-1, 1)))
    except Exception:
        ref_lufs = None

    # Per-band vs-pink
    pink_offsets = _ensure_pink_offsets()
    freqs, bin_power, norm = compute_stft_spectrum(y_mono, sr)
    bands = {}
    for name, (fmin, fmax) in BAND_RANGES.items():
        e = stft_band_energy_db(freqs, bin_power, norm, fmin, fmax)
        vs_pink = round(e - overall_rms - pink_offsets[name], 2)
        bands[name] = {
            "energy_db":  round(e, 2),
            "vs_pink_db": vs_pink,
        }

    return {
        "sample_rate":    sr,
        "duration_sec":   round(duration, 1),
        "integrated_lufs": round(ref_lufs, 1) if ref_lufs is not None else None,
        "overall_rms_db": round(overall_rms, 2),
        "bands":          bands,
    }


def propose_reference_match(analysis, ref_measurement, correction_ratio=0.5):
    """Given a mix analysis report + a reference measurement, propose bell
    EQs that move the mix toward the reference's tonal character.

    Semantics:
      delta_vs_pink = mix_vs_pink - ref_vs_pink    (per band)
      - positive = mix brighter than ref in this band (suggest a CUT)
      - negative = mix darker than ref in this band  (suggest a BOOST)
      - suggested gain = -delta * correction_ratio  (half-correct by default)

    Bells whose suggested gain is below REF_MATCH_MIN_BELL_DB are accepted=false
    (shown but disabled — no point applying an inaudible EQ move).

    Returns:
      {
        "bells":      [<bell card>, ...],
        "config":     {"enabled": bool, "bells": [{freq, gain_db, q}, ...]},
        "comparison": [{band, mix_vs_pink, ref_vs_pink, delta_db}, ...],
        "correction_ratio": float,
      }
    """
    mix_bands = (analysis.get("spectrum", {}) or {}).get("bands", {}) or {}
    ref_bands = ref_measurement.get("bands", {}) or {}

    bells = []
    comparison = []
    config_bells = []

    for meta in REF_MATCH_BANDS:
        name = meta["name"]
        mix_vp = (mix_bands.get(name) or {}).get("vs_pink_db")
        ref_vp = (ref_bands.get(name) or {}).get("vs_pink_db")
        if mix_vp is None or ref_vp is None:
            continue

        delta = round(mix_vp - ref_vp, 2)
        suggested_gain = round(-delta * correction_ratio, 2)
        # Clamp per-bell safety
        suggested_gain = float(np.clip(suggested_gain,
                                        -REF_MATCH_MAX_BELL_DB,
                                         REF_MATCH_MAX_BELL_DB))
        # Small deltas: skip (flag as inactive)
        accept = abs(suggested_gain) >= REF_MATCH_MIN_BELL_DB

        direction = "cut" if suggested_gain < 0 else ("boost" if suggested_gain > 0 else "none")

        bells.append({
            "band":      name,
            "freq_hz":   meta["freq"],
            "q":         meta["q"],
            "gain_db":   suggested_gain,
            "accept":    accept,
            "direction": direction,
            "numbers": {
                "mix_vs_pink_db": round(mix_vp, 1),
                "ref_vs_pink_db": round(ref_vp, 1),
                "delta_db":       round(delta, 1),
                "suggested_gain_db": suggested_gain,
            },
            "rationale": _format_bell_rationale(name, mix_vp, ref_vp, delta, suggested_gain),
        })

        comparison.append({
            "band": name,
            "mix_vs_pink_db": round(mix_vp, 1),
            "ref_vs_pink_db": round(ref_vp, 1),
            "delta_db": round(delta, 1),
        })

        config_bells.append({
            "band":    name,
            "freq":    meta["freq"],
            "q":       meta["q"],
            "gain_db": suggested_gain,
            "enabled": accept,
        })

    return {
        "bells":       bells,
        "config":      {"enabled": any(b["enabled"] for b in config_bells),
                        "bells": config_bells,
                        "correction_ratio": float(correction_ratio)},
        "comparison":  comparison,
        "correction_ratio": float(correction_ratio),
    }


def _format_bell_rationale(band_name, mix_vp, ref_vp, delta, gain):
    pretty = band_name.replace("_", " ")
    if abs(gain) < REF_MATCH_MIN_BELL_DB:
        return (f"{pretty.capitalize()}: mix is {mix_vp:+.1f} dB vs neutral, "
                f"reference is {ref_vp:+.1f} dB. Delta is small ({delta:+.1f} dB) "
                f"— no EQ needed.")
    direction = "brighter" if delta > 0 else "darker"
    action = "cut" if gain < 0 else "boost"
    return (f"{pretty.capitalize()}: mix is {mix_vp:+.1f} dB vs neutral, "
            f"reference is {ref_vp:+.1f} dB — mix is {direction} by "
            f"{abs(delta):.1f} dB. Suggest a {gain:+.1f} dB {action} "
            f"(half-correction).")


# ---------------------------------------------------------------------------
# Genre-match EQ — same DSP as reference-match, but deltas come from the
# GENRE_TARGETS table instead of a loaded reference track.
# ---------------------------------------------------------------------------
# Honest caveat: suggestions here are against a statistical genre average,
# not a specific track the user has chosen. Over-application can homogenize
# a mix toward genre norms at the expense of artistic intent. The UI
# emphasizes this by framing suggestions as "nudges", not corrections.


def propose_genre_match(analysis, correction_ratio=0.5):
    """Like propose_reference_match, but deltas come from the mix's own
    genre-target comparison. Reuses the same bell + config shape so the
    frontend can render identically.

    mix_vs_pink - target_vs_pink  is already the `delta_db` we store in
    analysis["spectrum"]["bands"][band]["delta_db"] — so all we do is read
    that, apply correction ratio, and package into bells.

    Returns the same shape as propose_reference_match:
      {
        "bells":      [<bell card>, ...],
        "config":     {"enabled": bool, "bells": [...], "correction_ratio": f},
        "comparison": [{band, mix_vs_pink_db, target_vs_pink_db, delta_db}],
        "correction_ratio": f,
        "mode": "suggested"
      }
    """
    mix_bands = (analysis.get("spectrum", {}) or {}).get("bands", {}) or {}
    bells = []
    comparison = []
    config_bells = []

    for meta in REF_MATCH_BANDS:
        name = meta["name"]
        b = mix_bands.get(name) or {}
        mix_vp = b.get("vs_pink_db")
        target = b.get("target_db")
        delta = b.get("delta_db")
        if mix_vp is None or target is None or delta is None:
            continue

        # Half-correct toward the genre target. Same sign convention as
        # ref-match: positive delta (mix brighter than target) -> cut.
        suggested_gain = round(-float(delta) * float(correction_ratio), 2)
        suggested_gain = float(np.clip(suggested_gain,
                                        -REF_MATCH_MAX_BELL_DB,
                                         REF_MATCH_MAX_BELL_DB))
        accept = abs(suggested_gain) >= REF_MATCH_MIN_BELL_DB
        direction = "cut" if suggested_gain < 0 else ("boost" if suggested_gain > 0 else "none")

        bells.append({
            "band":      name,
            "freq_hz":   meta["freq"],
            "q":         meta["q"],
            "gain_db":   suggested_gain,
            "accept":    accept,
            "direction": direction,
            "numbers": {
                "mix_vs_pink_db":    round(float(mix_vp), 1),
                "target_vs_pink_db": round(float(target), 1),
                "delta_db":          round(float(delta), 1),
                "suggested_gain_db": suggested_gain,
            },
            "rationale": _format_genre_bell_rationale(name, mix_vp, target, delta, suggested_gain),
        })

        comparison.append({
            "band":              name,
            "mix_vs_pink_db":    round(float(mix_vp), 1),
            "target_vs_pink_db": round(float(target), 1),
            "delta_db":          round(float(delta), 1),
        })

        config_bells.append({
            "band":    name,
            "freq":    meta["freq"],
            "q":       meta["q"],
            "gain_db": suggested_gain,
            "enabled": accept,
        })

    return {
        "bells":            bells,
        "config":           {"enabled": any(b["enabled"] for b in config_bells),
                             "bells": config_bells,
                             "correction_ratio": float(correction_ratio)},
        "comparison":       comparison,
        "correction_ratio": float(correction_ratio),
        "mode":             "suggested",
    }


def _format_genre_bell_rationale(band_name, mix_vp, target, delta, gain):
    pretty = band_name.replace("_", " ")
    if abs(gain) < REF_MATCH_MIN_BELL_DB:
        return (f"{pretty.capitalize()}: mix is {mix_vp:+.1f} dB vs neutral, "
                f"genre target is {target:+.1f} dB. Delta is small ({delta:+.1f} dB) "
                f"— no EQ needed.")
    direction = "brighter" if delta > 0 else "darker"
    action = "cut" if gain < 0 else "boost"
    return (f"{pretty.capitalize()}: mix is {mix_vp:+.1f} dB vs neutral, "
            f"genre target is {target:+.1f} dB — mix is {direction} than "
            f"typical by {abs(delta):.1f} dB. Suggested {gain:+.1f} dB "
            f"{action} nudges toward genre norm.")


# ---------------------------------------------------------------------------
# File I/O
# ---------------------------------------------------------------------------

def render_to_wav(y_stereo, sr, out_path, bit_depth=24):
    """Write (2, N) stereo to WAV. Dithers if reducing to 16-bit."""
    import soundfile as sf
    y = _ensure_stereo_2n(y_stereo)

    if bit_depth == 16:
        y = apply_dither_tpdf(y, target_bits=16)
        subtype = "PCM_16"
    elif bit_depth == 24:
        subtype = "PCM_24"
    elif bit_depth == 32:
        subtype = "FLOAT"
    else:
        raise ValueError(f"Unsupported bit depth: {bit_depth}")

    y = np.clip(y, -1.0, 1.0)
    sf.write(out_path, y.T.astype(np.float32 if bit_depth == 32 else np.float64),
             sr, subtype=subtype)
    return out_path


# ---------------------------------------------------------------------------
# Metadata tagging — embed Title / Artist / Album / Track / Year / Genre
# ---------------------------------------------------------------------------
#
# Writes ID3v2 tags on MP3 and WAV files, Vorbis comments on FLAC (future-
# proofed, not currently used). For WAV, we write ID3v2 which modern players
# (Foobar2000, MusicBee, VLC, iTunes) read correctly. The older WAV LIST/INFO
# chunks are a Windows-era standard with a very limited field set; skipping
# them in favor of the richer ID3v2 embedded approach.
#
# Design: the function is tolerant of missing fields — any field set to
# None, empty string, or absent from the dict is simply not written. This
# means the caller can pass whatever the user filled in without pre-
# validating each field.

def embed_metadata(file_path, metadata):
    """Embed metadata tags into an audio file on disk (in place).

    metadata dict keys (all optional, all strings or ints):
      title       — song title
      artist      — main artist
      album       — album / release name
      track       — track number (int or str)
      year        — release year (int or str)
      genre       — genre name (free text)

    Raises no exceptions on failure — returns True/False. Tagging failure
    should never break an export; the file is still a valid master.
    """
    if not metadata:
        return False

    # Filter empty / None values so we don't write blank tags
    def _nz(v):
        if v is None:
            return None
        s = str(v).strip()
        return s if s else None

    title  = _nz(metadata.get("title"))
    artist = _nz(metadata.get("artist"))
    album  = _nz(metadata.get("album"))
    track  = _nz(metadata.get("track"))
    year   = _nz(metadata.get("year"))
    genre  = _nz(metadata.get("genre"))

    # Nothing to write
    if not any([title, artist, album, track, year, genre]):
        return False

    ext = os.path.splitext(file_path)[1].lower()
    try:
        if ext == ".mp3":
            from mutagen.id3 import ID3, ID3NoHeaderError, TIT2, TPE1, TALB, TRCK, TDRC, TCON
            try:
                tags = ID3(file_path)
            except ID3NoHeaderError:
                tags = ID3()
            if title:  tags.add(TIT2(encoding=3, text=title))
            if artist: tags.add(TPE1(encoding=3, text=artist))
            if album:  tags.add(TALB(encoding=3, text=album))
            if track:  tags.add(TRCK(encoding=3, text=str(track)))
            if year:   tags.add(TDRC(encoding=3, text=str(year)))
            if genre:  tags.add(TCON(encoding=3, text=genre))
            tags.save(file_path, v2_version=3)  # ID3v2.3 = max compatibility
            return True

        elif ext in (".wav", ".wave"):
            # Mutagen's WAVE module supports ID3v2 embedded in a WAV RIFF
            # chunk. Modern players read this; older Windows-only tools
            # may not. Belt-and-suspenders LIST/INFO writing would add
            # complexity for diminishing returns — ID3v2 is the modern
            # standard and well-supported.
            from mutagen.wave import WAVE
            from mutagen.id3 import TIT2, TPE1, TALB, TRCK, TDRC, TCON
            audio = WAVE(file_path)
            if audio.tags is None:
                audio.add_tags()
            tags = audio.tags
            if title:  tags.add(TIT2(encoding=3, text=title))
            if artist: tags.add(TPE1(encoding=3, text=artist))
            if album:  tags.add(TALB(encoding=3, text=album))
            if track:  tags.add(TRCK(encoding=3, text=str(track)))
            if year:   tags.add(TDRC(encoding=3, text=str(year)))
            if genre:  tags.add(TCON(encoding=3, text=genre))
            audio.save()
            return True

        elif ext == ".flac":
            # Future-proofing — not currently an export format, but cheap
            # to include so this function is format-complete.
            from mutagen.flac import FLAC
            audio = FLAC(file_path)
            if title:  audio["title"]  = title
            if artist: audio["artist"] = artist
            if album:  audio["album"]  = album
            if track:  audio["tracknumber"] = str(track)
            if year:   audio["date"]  = str(year)
            if genre:  audio["genre"] = genre
            audio.save()
            return True

        else:
            # Unknown container — skip silently. The file is still valid.
            return False

    except Exception as e:
        # Tagging is best-effort. If it fails (permissions, corrupt file,
        # missing codec support, whatever), log and move on — the audio
        # file itself is fine.
        import sys
        print(f"[embed_metadata] Warning: tagging failed for {file_path}: {e}",
              file=sys.stderr)
        return False


# ---------------------------------------------------------------------------
# Post-master verification
# ---------------------------------------------------------------------------

def measure_master(y_stereo, sr, target_lufs=DEFAULT_TARGET_LUFS,
                   ceiling_dbfs=DEFAULT_CEILING_DBFS):
    """Measure a mastered buffer. Returns metrics + pass/fail checks."""
    meas = measure_from_array(y_stereo, sr)
    lufs = meas.get("lufs")
    peak = meas.get("peak")

    checks = {
        "lufs_in_range": (lufs is not None and abs(lufs - target_lufs) < 0.5),
        "true_peak_safe": (peak is not None and peak <= ceiling_dbfs + 0.05),
    }
    return {
        "integrated_lufs": round(lufs, 2) if lufs is not None else None,
        "true_peak_dbfs": round(peak, 2) if peak is not None else None,
        "loudness_range_lra": meas.get("lra"),
        "checks": checks,
        "target_lufs": float(target_lufs),
        "ceiling_dbfs": float(ceiling_dbfs),
    }


# ---------------------------------------------------------------------------
# Release check — platform-specific pass/warn/fail verification for a finished
# master. Unlike measure_master (which checks against the user's chosen target),
# this compares against published platform specs for Spotify, YouTube, Bandcamp.
#
# Design: each platform defines hard pass/warn/fail thresholds for loudness
# and true-peak. Shared checks (dynamics, stereo, mono-bass, peak events)
# use the same thresholds across platforms since they're about the master
# quality itself, not platform compliance.
#
# Source: platform docs verified April 2026.
#   - Spotify:  -14 LUFS, -1 dBTP (official support page)
#   - YouTube:  -14 LUFS, -1 dBTP (only normalizes DOWN, never UP)
#   - Bandcamp: no LUFS target (official help article states "no recommended
#              LUFS level... loudness level is up to your discretion"),
#              -2 dBTP recommended because of 128 kbps MP3 streaming codec
#
# Status codes per check:
#   "pass" — meets spec
#   "warn" — close to limit or slightly out of range; safe but suboptimal
#   "fail" — clearly outside spec; would cause issues on the platform
#   "info" — not a pass/fail check, just reports the value (Bandcamp LUFS)
# ---------------------------------------------------------------------------

PLATFORM_TARGETS = {
    "spotify": {
        "display":         "Spotify",
        "target_lufs":     -14.0,
        "lufs_tolerance":  1.5,      # ±1.5 LU from target = pass
        "lufs_warn_band":  2.5,      # within 2.5 LU = warn, beyond = fail
        "peak_ceiling":    -1.0,
        "peak_warn_margin": 0.1,     # >=0.1 dB under ceiling = pass, otherwise warn/fail
        "normalizes_up":   True,     # quieter content gets boosted
        "codec_note":      "Ogg Vorbis encoding can lift true peak by ~1 dB — keep master below -1 dBTP.",
    },
    "youtube": {
        "display":         "YouTube",
        "target_lufs":     -14.0,
        "lufs_tolerance":  1.5,
        "lufs_warn_band":  2.5,
        "peak_ceiling":    -1.0,
        "peak_warn_margin": 0.1,
        "normalizes_up":   False,    # quieter stays quieter on YouTube
        "codec_note":      "YouTube only attenuates masters LOUDER than -14 LUFS. Quieter tracks stay quiet.",
    },
    "bandcamp": {
        "display":         "Bandcamp",
        "target_lufs":     None,     # No official target — info-only report
        "lufs_tolerance":  None,
        "lufs_warn_band":  None,
        "peak_ceiling":    -2.0,
        "peak_warn_margin": 0.1,
        "normalizes_up":   False,
        "codec_note":      "Bandcamp doesn't normalize. Streaming uses 128 kbps MP3 — leave at least 2 dB of peak headroom for codec safety.",
    },
}

# Shared thresholds (independent of platform)
LRA_WARN_LU    = 4.0     # below this = crushed
LRA_FAIL_LU    = 2.5     # below this = severely over-compressed
CREST_WARN_DB  = 9.0     # crest below this = getting tight
CREST_FAIL_DB  = 7.0     # crest below this = over-limited
CORR_WARN      = 0.3     # correlation below this = phase issues likely
CORR_FAIL      = 0.0     # negative correlation = mono cancellation


def _status_for_lufs(lufs, platform_cfg):
    """Return ('pass'/'warn'/'fail'/'info', detail_string) for the LUFS check."""
    target = platform_cfg.get("target_lufs")
    tol    = platform_cfg.get("lufs_tolerance")
    warn   = platform_cfg.get("lufs_warn_band")
    if lufs is None:
        return "fail", "Could not measure loudness"
    if target is None:
        # Bandcamp case — no target, just report
        return "info", f"No target on {platform_cfg['display']} — played as mastered"
    delta = lufs - target
    abs_d = abs(delta)
    if abs_d <= tol:
        return "pass", f"Within {tol:.1f} LU of {target:+.0f} LUFS target"
    if abs_d <= warn:
        direction = "louder" if delta > 0 else "quieter"
        return "warn", f"{abs_d:.1f} LU {direction} than target — will be normalized"
    direction = "louder" if delta > 0 else "quieter"
    return "fail", f"{abs_d:.1f} LU {direction} than target — significant mismatch"


def _status_for_peak(peak_dbfs, platform_cfg):
    """Return status for true-peak vs ceiling."""
    ceiling = platform_cfg["peak_ceiling"]
    margin  = platform_cfg["peak_warn_margin"]
    if peak_dbfs is None:
        return "fail", "Could not measure true peak"
    if peak_dbfs <= ceiling - margin:
        return "pass", f"{abs(ceiling - peak_dbfs):.1f} dB under the {ceiling:.1f} dBTP ceiling"
    if peak_dbfs <= ceiling:
        return "warn", f"Right at the ceiling ({ceiling:.1f} dBTP) — codec transcoding may cause clipping"
    return "fail", f"Over the {ceiling:.1f} dBTP ceiling — will clip after codec encoding"


def analyze_release_file(y_stereo, sr, platform="spotify"):
    """Run all release-check measurements on a finished master.

    Returns a dict:
      {
        "platform":         "spotify" | "youtube" | "bandcamp",
        "platform_display": "Spotify",
        "codec_note":       str,
        "checks":           [ {id, label, value, unit, status, detail} ... ],
        "summary":          {"pass": int, "warn": int, "fail": int},
      }

    `y_stereo` must be (2, N). If mono source (same L and R), stereo checks
    return "info" status since they're not meaningful on mono.
    """
    platform = platform.lower()
    if platform not in PLATFORM_TARGETS:
        platform = "spotify"
    cfg = PLATFORM_TARGETS[platform]

    # Core loudness/peak measurement — reuses the main analyzer's ffmpeg path
    meas = measure_from_array(y_stereo, sr)
    lufs = meas.get("lufs")
    peak = meas.get("peak")
    lra  = meas.get("lra")

    # Crest factor: peak_dbfs - rms_db(mono sum). We compute locally rather
    # than depending on mix_analyzer's analyze_loudness (which does more work).
    y_mono = 0.5 * (y_stereo[0] + y_stereo[1])
    rms_lin = float(np.sqrt(np.mean(y_mono * y_mono)))
    rms_db_v = 20.0 * np.log10(rms_lin) if rms_lin > 1e-9 else -96.0
    crest = None
    if peak is not None:
        crest = round(peak - rms_db_v, 1)

    # Stereo measurements (correlation, mid/side, mono detection)
    L, R = y_stereo[0], y_stereo[1]
    M = 0.5 * (L + R)
    S = 0.5 * (L - R)
    mid_rms  = float(np.sqrt(np.mean(M * M))) + 1e-12
    side_rms = float(np.sqrt(np.mean(S * S))) + 1e-12
    mid_db   = 20.0 * np.log10(mid_rms)
    side_db  = 20.0 * np.log10(side_rms)
    ms_gap   = round(side_db - mid_db, 1)   # negative = narrow, 0 = balanced, positive = wide
    is_mono  = (mid_db - side_db) > 40 if mid_db > -60 else True

    if np.std(L) < 1e-10 or np.std(R) < 1e-10:
        correlation = 1.0
    else:
        correlation = float(np.corrcoef(L, R)[0, 1])
    correlation = round(correlation, 2)

    # Peak events: count samples where |L| or |R| >= -0.1 dBFS (near clip)
    # We count above the platform ceiling for relevance.
    ceiling_lin = 10 ** (cfg["peak_ceiling"] / 20.0)
    peak_events = int(np.sum(
        (np.abs(L) >= ceiling_lin) | (np.abs(R) >= ceiling_lin)
    ))

    # Mono-bass share (reuse existing analyzer)
    msb = analyze_ms_bass(y_stereo, sr)

    checks = []

    # 1. Integrated LUFS
    lufs_status, lufs_detail = _status_for_lufs(lufs, cfg)
    checks.append({
        "id": "lufs",
        "label": "Integrated LUFS",
        "value": round(lufs, 1) if lufs is not None else None,
        "unit":  "LUFS",
        "status": lufs_status,
        "detail": lufs_detail,
    })

    # 2. True peak
    peak_status, peak_detail = _status_for_peak(peak, cfg)
    checks.append({
        "id": "true_peak",
        "label": "True peak",
        "value": round(peak, 1) if peak is not None else None,
        "unit":  "dBTP",
        "status": peak_status,
        "detail": peak_detail,
    })

    # 3. LRA (loudness range / dynamic spread)
    if lra is None:
        lra_status, lra_detail = "warn", "Could not measure"
    elif lra >= LRA_WARN_LU:
        lra_status, lra_detail = "pass", "Healthy dynamic range"
    elif lra >= LRA_FAIL_LU:
        lra_status, lra_detail = "warn", "Low range — mix may feel flat"
    else:
        lra_status, lra_detail = "fail", "Very low range — likely over-compressed"
    checks.append({
        "id":    "lra",
        "label": "Loudness range (LRA)",
        "value": round(lra, 1) if lra is not None else None,
        "unit":  "LU",
        "status": lra_status,
        "detail": lra_detail,
    })

    # 4. Crest factor
    if crest is None:
        crest_status, crest_detail = "warn", "Could not measure"
    elif crest >= CREST_WARN_DB:
        crest_status, crest_detail = "pass", "Good peak-to-average ratio"
    elif crest >= CREST_FAIL_DB:
        crest_status, crest_detail = "warn", "Getting tight — some dynamic impact lost"
    else:
        crest_status, crest_detail = "fail", "Over-limited — transients crushed"
    checks.append({
        "id":    "crest",
        "label": "Crest factor",
        "value": crest,
        "unit":  "dB",
        "status": crest_status,
        "detail": crest_detail,
    })

    # 5. Peak events (samples at/above ceiling)
    pe_status = "pass" if peak_events == 0 else ("warn" if peak_events < 50 else "fail")
    pe_detail = (
        f"No samples at or above {cfg['peak_ceiling']:.1f} dBFS ceiling" if peak_events == 0
        else f"{peak_events} samples at or above the ceiling"
    )
    checks.append({
        "id":    "peak_events",
        "label": "Samples at ceiling",
        "value": peak_events,
        "unit":  "",
        "status": pe_status,
        "detail": pe_detail,
    })

    # 6. L/R correlation (skip if mono source)
    if is_mono:
        checks.append({
            "id":    "correlation",
            "label": "L/R correlation",
            "value": None,
            "unit":  "",
            "status": "info",
            "detail": "Source is mono — not applicable",
        })
    else:
        if correlation >= CORR_WARN:
            corr_status, corr_detail = "pass", "Mono-safe"
        elif correlation >= CORR_FAIL:
            corr_status, corr_detail = "warn", "Low correlation — check mono sum"
        else:
            corr_status, corr_detail = "fail", "Negative correlation — severe cancellation in mono"
        checks.append({
            "id":    "correlation",
            "label": "L/R correlation",
            "value": correlation,
            "unit":  "",
            "status": corr_status,
            "detail": corr_detail,
        })

    # 7. Stereo width (mid/side ratio)
    if is_mono:
        checks.append({
            "id":    "width",
            "label": "Stereo width",
            "value": None,
            "unit":  "",
            "status": "info",
            "detail": "Source is mono — not applicable",
        })
    else:
        if abs(ms_gap) <= 6:
            w_status, w_detail = "pass", "Balanced mid/side ratio"
        elif abs(ms_gap) <= 10:
            w_status, w_detail = "warn", ("Sides dominate" if ms_gap > 0 else "Very narrow mix")
        else:
            w_status, w_detail = "fail", ("Extremely wide — mono collapse risk" if ms_gap > 0 else "Nearly mono")
        checks.append({
            "id":    "width",
            "label": "Stereo width",
            "value": ms_gap,
            "unit":  "dB M-S",
            "status": w_status,
            "detail": w_detail,
        })

    # 8. Mono-bass share
    if msb.get("is_mono"):
        checks.append({
            "id":    "mono_bass",
            "label": "Mono-bass check",
            "value": None,
            "unit":  "",
            "status": "info",
            "detail": "Source is mono — not applicable",
        })
    else:
        sev = msb.get("severity", "clean")
        pct = msb.get("side_bass_pct", 0.0)
        if sev == "clean":
            mb_status, mb_detail = "pass", "Tight low end"
        elif sev == "mild":
            mb_status, mb_detail = "warn", "Some stereo bass — minor"
        elif sev == "worth_fixing":
            mb_status, mb_detail = "warn", "Stereo bass wastes headroom"
        else:
            mb_status, mb_detail = "fail", "Large stereo bass — mix-side issue likely"
        checks.append({
            "id":    "mono_bass",
            "label": "Mono-bass share",
            "value": round(pct, 0) if pct is not None else None,
            "unit":  "%",
            "status": mb_status,
            "detail": mb_detail,
        })

    # 9. Frequency cutoff — upsample / band-limit sanity check.
    # Operates on the mono sum (we computed y_mono earlier for crest).
    try:
        cutoff = analyze_frequency_cutoff(y_mono, sr)
        v = cutoff.get("verdict")
        pct_n = cutoff.get("pct_nyquist")
        cf_hz = cutoff.get("cutoff_hz")
        if v == "full_band":
            cf_status = "pass"
        elif v == "normal":
            cf_status = "pass"
        elif v == "band_limited":
            cf_status = "warn"
        else:
            cf_status = "info"
        # Display: show the frequency in kHz; pct in the detail
        val_display = round(cf_hz / 1000.0, 1) if cf_hz is not None else None
        checks.append({
            "id":    "frequency_cutoff",
            "label": "Frequency cutoff",
            "value": val_display,
            "unit":  "kHz",
            "status": cf_status,
            "detail": cutoff.get("detail", ""),
            "extra":  {"pct_nyquist": pct_n, "nyquist_hz": cutoff.get("nyquist_hz")},
        })
    except Exception:
        # Non-critical — don't fail the whole release check if cutoff fails
        pass

    # Summary counts
    summary = {"pass": 0, "warn": 0, "fail": 0, "info": 0}
    for c in checks:
        summary[c["status"]] = summary.get(c["status"], 0) + 1

    return {
        "platform":         platform,
        "platform_display": cfg["display"],
        "codec_note":       cfg["codec_note"],
        "checks":           checks,
        "summary":          summary,
    }


# ---------------------------------------------------------------------------
# Top-level convenience
# ---------------------------------------------------------------------------

def master_file(
    input_path, output_path,
    analysis=None,
    target_lufs=DEFAULT_TARGET_LUFS,
    ceiling_dbfs=DEFAULT_CEILING_DBFS,
    bit_depth=24,
    chain_config=None,
):
    """Load -> run chain -> write WAV -> measure. Returns result dict."""
    y_stereo, y_mono, sr = load_audio(input_path)

    if chain_config is None:
        if analysis is None:
            raise ValueError("Provide either chain_config or analysis.")
        proposal = propose_chain(analysis, target_lufs=target_lufs,
                                 ceiling_dbfs=ceiling_dbfs)
        chain_config = proposal["config"]

    mastered, stats = run_chain(y_stereo, sr, chain_config)
    render_to_wav(mastered, sr, output_path, bit_depth=bit_depth)
    post = measure_master(mastered, sr, target_lufs, ceiling_dbfs)

    return {
        "output_path": output_path,
        "sample_rate": sr,
        "bit_depth": bit_depth,
        "config": chain_config,
        "stats": stats,
        "measurement": post,
    }


# ---------------------------------------------------------------------------
# Release check — independent tool for verifying a finished master against
# platform delivery specs. Unlike measure_master (which is tied to a
# render job's targets), release_check takes any arbitrary WAV/FLAC and
# asks "is this ready to ship for <platform>?"
#
# Each check returns one of three states: pass / warn / fail.
#   pass — value is comfortably inside the acceptable range
#   warn — value is close to a boundary; ship if you want but flag it
#   fail — value is outside the acceptable range
#
# Design notes:
# - Pure data in/out. All measurements are passed in; this function doesn't
#   do any DSP itself. Keeps it testable and fast.
# - Per-platform specs live in PLATFORM_TARGETS and can be tuned without
#   touching the check-generation code.
# - Bandcamp is a special case: no loudness normalization, so LUFS isn't
#   a pass/fail but an informational note. See BANDCAMP_LUFS_MODE.
# ---------------------------------------------------------------------------

PLATFORM_TARGETS = {
    # Spotify: per their artist support docs. −14 LUFS integrated target;
    # −1 dBTP ceiling; if master is louder than −14 LUFS, ceiling drops to
    # −2 dBTP because louder tracks are more susceptible to transcoding
    # distortion into OGG Vorbis.
    "spotify": {
        "label":              "Spotify",
        "lufs_target":        -14.0,
        "lufs_tolerance":     1.5,     # pass zone: target ±tolerance
        "lufs_warn_zone":     3.0,     # warn zone: target ±warn (outside pass)
        "peak_ceiling":       -1.0,
        "peak_ceiling_loud":  -2.0,    # if lufs > target, use this ceiling
        "lra_min_warn":       3.0,     # < this LRA = warn (over-compressed)
        "lra_min_fail":       2.0,     # < this LRA = fail (crushed)
    },
    # YouTube: same effective target as Spotify per public consensus
    # (YouTube doesn't publish official numbers but every mastering guide
    # in 2025-2026 confirms −14 LUFS / −1 dBTP).
    "youtube": {
        "label":              "YouTube",
        "lufs_target":        -14.0,
        "lufs_tolerance":     1.5,
        "lufs_warn_zone":     3.0,
        "peak_ceiling":       -1.0,
        "peak_ceiling_loud":  -1.0,    # YouTube doesn't differentiate
        "lra_min_warn":       3.0,
        "lra_min_fail":       2.0,
    },
    # Bandcamp: per their help docs, no LUFS normalization and no recommended
    # target level. We still check peak headroom (so downloads don't clip on
    # playback systems) but report LUFS as info rather than pass/fail.
    "bandcamp": {
        "label":              "Bandcamp",
        "lufs_target":        None,     # no target: LUFS check reports info only
        "lufs_tolerance":     None,
        "lufs_warn_zone":     None,
        "peak_ceiling":       -1.0,     # conservative: streamed MP3 128k is lossy
        "peak_ceiling_loud":  -1.0,
        "lra_min_warn":       3.0,
        "lra_min_fail":       2.0,
    },
}


def _check_status(name, label, value, ok_fn, warn_fn, fail_fn, hint, unit=""):
    """Helper that picks a status from pass/warn/fail predicates.

    Evaluation order: fail > pass > warn. ok_fn wins over warn_fn when both
    match, because warn_fn is typically defined as "inside a warn zone"
    which is a superset of the pass zone. Returns a UI-friendly dict.
    """
    if value is None:
        return {
            "name": name, "label": label, "value": None, "unit": unit,
            "status": "unknown", "hint": "Measurement unavailable.",
        }
    if fail_fn and fail_fn(value):
        status = "fail"
    elif ok_fn(value):
        status = "pass"
    elif warn_fn and warn_fn(value):
        status = "warn"
    else:
        status = "warn"
    return {
        "name": name, "label": label,
        "value": round(value, 2), "unit": unit,
        "status": status, "hint": hint,
    }


def build_release_check(measurements, platform="spotify"):
    """Compare a set of measurements against a platform's delivery specs.

    measurements (dict): expected keys:
        integrated_lufs  — float, LUFS
        true_peak_dbfs   — float, dBTP
        lra              — float, LU (loudness range)
        crest_factor_db  — float, dB
        lr_correlation   — float, -1 to +1 (Pearson or phase)
        stereo_width_db  — float, dB
        side_bass_pct    — float, 0-100 (optional, from mono-bass analyzer)
        frequency_cutoff — dict, optional (from analyze_frequency_cutoff)

    platform (str): key into PLATFORM_TARGETS.

    Returns:
      {
        "platform":      str,
        "platform_label": str,
        "overall_status": "pass" | "warn" | "fail",
        "checks": [ {name, label, value, unit, status, hint}, ... ],
      }
    """
    spec = PLATFORM_TARGETS.get(platform, PLATFORM_TARGETS["spotify"])
    checks = []

    m = measurements or {}
    lufs = m.get("integrated_lufs")
    peak = m.get("true_peak_dbfs")
    lra  = m.get("lra")
    crest = m.get("crest_factor_db")
    corr = m.get("lr_correlation")
    width = m.get("stereo_width_db")
    side_bass = m.get("side_bass_pct")

    # ---- LUFS ----
    lufs_target = spec.get("lufs_target")
    if lufs_target is None:
        # Bandcamp: informational only
        if lufs is not None:
            checks.append({
                "name": "integrated_lufs",
                "label": "Integrated LUFS",
                "value": round(lufs, 1),
                "unit": "LUFS",
                "status": "info",
                "hint": "Bandcamp doesn't normalize loudness — any level is "
                        "accepted. Louder masters stream at full loudness.",
            })
        else:
            checks.append({
                "name": "integrated_lufs", "label": "Integrated LUFS",
                "value": None, "unit": "LUFS",
                "status": "unknown", "hint": "Measurement unavailable.",
            })
    else:
        # Pass/warn/fail against target
        tol = spec["lufs_tolerance"]
        warn = spec["lufs_warn_zone"]
        ok_fn   = lambda v: abs(v - lufs_target) <= tol
        warn_fn = lambda v: abs(v - lufs_target) <= warn
        hint_txt = f"Target {lufs_target:+g} LUFS ±{tol} for pass zone."
        checks.append(_check_status(
            "integrated_lufs", "Integrated LUFS", lufs,
            ok_fn, warn_fn, None, hint_txt, "LUFS"
        ))

    # ---- True peak ----
    # Spotify: if master is louder than target, tighter ceiling applies
    # (prevents distortion on OGG Vorbis transcoding).
    ceiling = spec["peak_ceiling"]
    if lufs is not None and lufs_target is not None and lufs > lufs_target:
        ceiling = spec["peak_ceiling_loud"]
    peak_hint = (f"Ceiling {ceiling} dBTP. "
                 + ("Tighter ceiling active because master is louder than "
                    f"{lufs_target} LUFS." if ceiling != spec["peak_ceiling"]
                    else "Standard streaming ceiling."))
    checks.append(_check_status(
        "true_peak", "True peak", peak,
        ok_fn   = lambda v: v <= ceiling,
        warn_fn = lambda v: v <= ceiling + 0.5,
        fail_fn = lambda v: v > ceiling + 0.5,
        hint    = peak_hint, unit="dBTP",
    ))

    # ---- LRA (loudness range) ----
    checks.append(_check_status(
        "lra", "Loudness range (LRA)", lra,
        ok_fn   = lambda v: v >= spec["lra_min_warn"],
        warn_fn = lambda v: v >= spec["lra_min_fail"],
        fail_fn = lambda v: v < spec["lra_min_fail"],
        hint    = (f"≥{spec['lra_min_warn']} LU = healthy dynamics. "
                   f"<{spec['lra_min_fail']} LU = likely over-compressed."),
        unit    = "LU",
    ))

    # ---- Crest factor ----
    # Universal across platforms: <8 dB = crushed, 10-14 = typical,
    # >14 = very dynamic (acoustic/classical territory).
    checks.append(_check_status(
        "crest", "Crest factor", crest,
        ok_fn   = lambda v: v >= 10.0,
        warn_fn = lambda v: v >= 8.0,
        fail_fn = lambda v: v < 8.0,
        hint    = "≥10 dB = healthy peak-to-RMS ratio. <8 dB = over-limited.",
        unit    = "dB",
    ))

    # ---- L/R correlation (mono safety) ----
    # +1 = identical channels; 0 = uncorrelated; negative = partial phase
    # inversion (mono collapse risk).
    checks.append(_check_status(
        "correlation", "L/R correlation", corr,
        ok_fn   = lambda v: v >= 0.3,
        warn_fn = lambda v: v >= 0.0,
        fail_fn = lambda v: v < 0.0,
        hint    = "≥0.3 = mono-safe. <0 = phase issues on mono playback.",
        unit    = "",
    ))

    # ---- Stereo width (dB mid/side balance) ----
    # Internal units: ~0 dB means balanced, 5-10 = wider than typical,
    # >15 dB = unusually wide (potential phase/mono issues).
    if width is not None:
        checks.append(_check_status(
            "width", "Stereo width", width,
            ok_fn   = lambda v: v <= 12.0,
            warn_fn = lambda v: v <= 18.0,
            fail_fn = lambda v: v > 18.0,
            hint    = "≤12 dB = well-balanced. >18 dB = unusually wide.",
            unit    = "dB",
        ))

    # ---- Side bass (optional, included if analyzer was run) ----
    if side_bass is not None:
        checks.append(_check_status(
            "side_bass", "Mono-bass tightness", side_bass,
            ok_fn   = lambda v: v <= 20.0,
            warn_fn = lambda v: v <= 35.0,
            fail_fn = lambda v: v > 35.0,
            hint    = "≤20% = tight low end. >35% suggests stereo-widened bass.",
            unit    = "%",
        ))

    # ---- Frequency cutoff (optional, upsample sanity check) ----
    cutoff = m.get("frequency_cutoff")
    if cutoff and cutoff.get("cutoff_hz") is not None:
        v       = cutoff.get("verdict")
        cf_hz   = cutoff.get("cutoff_hz")
        pct_n   = cutoff.get("pct_nyquist")
        nyq     = cutoff.get("nyquist_hz")
        # Display as kHz in the value slot, pct/detail in the hint
        val_khz = round(cf_hz / 1000.0, 1)
        if v == "full_band":
            status = "pass"
            hint   = (f"Full-bandwidth source — {val_khz} kHz "
                      f"({pct_n:.0f}% of {nyq/1000:.1f} kHz Nyquist).")
        elif v == "normal":
            status = "pass"
            hint   = (f"Native high-rate content — {val_khz} kHz "
                      f"({pct_n:.0f}% of Nyquist).")
        elif v == "band_limited":
            status = "warn"
            if cf_hz < 22000 and nyq and nyq > 23000:
                extra = " Likely a 44.1/48 kHz source upsampled, or a low-pass is active."
            elif cf_hz < 16000:
                extra = " A low-pass is removing audible content — verify this is intentional."
            else:
                extra = ""
            hint = (f"Content cuts off at {val_khz} kHz "
                    f"({pct_n:.0f}% of {nyq/1000:.1f} kHz Nyquist).{extra}")
        else:
            status = "unknown"
            hint   = cutoff.get("detail", "Could not determine cutoff.")
        checks.append({
            "name":   "frequency_cutoff",
            "label":  "Frequency cutoff",
            "value":  val_khz,
            "unit":   "kHz",
            "status": status,
            "hint":   hint,
            "extra":  {"pct_nyquist": pct_n, "nyquist_hz": nyq},
        })

    # ---- Overall status ----
    statuses = [c["status"] for c in checks]
    if "fail" in statuses:
        overall = "fail"
    elif "warn" in statuses:
        overall = "warn"
    elif all(s in ("pass", "info") for s in statuses):
        overall = "pass"
    else:
        overall = "unknown"

    return {
        "platform":       platform,
        "platform_label": spec["label"],
        "overall_status": overall,
        "checks":         checks,
    }
