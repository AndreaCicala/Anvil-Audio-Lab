"""
stem_analyzer.py
----------------
Analyzes multiple stems exported from Cubase and detects:
- Frequency masking between stem pairs
- Phase conflicts in shared frequency bands
- Level relationship issues
- Per-stem spectral fingerprint

Usage:
    from stem_analyzer import analyze_stems
    result = analyze_stems({"kick": "kick.wav", "bass": "bass.wav", ...})
"""

import sys
import warnings
warnings.filterwarnings("ignore")

import numpy as np
import librosa
from scipy.signal import butter, sosfilt

from mix_analyzer import (
    rms_db,
    compute_stft_spectrum, stft_band_energy_db,
    SUB_BANDS,
)


# ---------------------------------------------------------------------------
# Band definitions — more granular than the main analyzer for stem work
# ---------------------------------------------------------------------------
STEM_BANDS = {
    "sub":        (20,   80),
    "bass":       (80,   250),
    "low_mid":    (250,  800),
    "mid":        (800,  2500),
    "presence":   (2500, 6000),
    "air":        (6000, 20000),
}

# Typical stem name → category mapping
STEM_CATEGORIES = {
    "kick":      "drums",  "snare":   "drums",  "drums":   "drums",
    "drum":      "drums",  "overhead":"drums",  "room":    "drums",
    "bass":      "bass",   "bassvst": "bass",
    "guitar":    "guitar", "gtr":     "guitar", "rhythm":  "guitar", "lead":  "guitar",
    "keys":      "keys",   "piano":   "keys",   "synth":   "keys",   "pad":   "keys",
    "vox":       "vocals", "vocal":   "vocals", "vocals":  "vocals", "voice": "vocals",
    "strings":   "strings","brass":   "brass",
}

# Which band conflicts matter most per pair of categories
IMPORTANT_CONFLICTS = {
    ("drums", "bass"):   ["sub", "bass"],
    ("bass",  "guitar"): ["bass", "low_mid"],
    ("guitar","keys"):   ["low_mid", "mid"],
    ("guitar","vocals"): ["mid", "presence"],
    ("keys",  "vocals"): ["mid", "presence"],
    ("drums", "vocals"): ["presence"],
}

# Severity thresholds (dB difference — smaller = more masking)
MASKING_THRESHOLDS = {
    "severe":   3,   # stems competing equally
    "moderate": 6,   # one barely dominates
    "mild":     12,  # noticeable but manageable
}


def load_stem(path, target_sr=None):
    """Load a stem file, return (y_mono, y_stereo, sr)."""
    y, sr = librosa.load(path, sr=target_sr, mono=False)
    if y.ndim == 1:
        y = np.stack([y, y])
    y_mono = librosa.to_mono(y)
    
    # Pad very short stems to at least 1 second for analysis
    min_samples = sr
    if len(y_mono) < min_samples:
        pad = min_samples - len(y_mono)
        y_mono = np.pad(y_mono, (0, pad))
        y = np.pad(y, ((0,0),(0,pad)))
    
    return y_mono, y, sr


def stem_fingerprint(y_mono, sr):
    """Per-band energy profile for a stem. Uses STFT for both parent and sub-bands.

    Returns a flat dict with parent band keys (sub/bass/…/air) and sub-band
    keys (sub_0, sub_1, …, air_3). Old consumers read parent bands; new
    consumers can use sub-bands for precise conflict localization.
    """
    freqs, bp, nf = compute_stft_spectrum(y_mono, sr)
    out = {}
    for name, (fmin, fmax) in STEM_BANDS.items():
        out[name] = round(stft_band_energy_db(freqs, bp, nf, fmin, fmax), 1)
    # Sub-bands: 4 per parent, same names as mix_analyzer's SUB_BANDS
    for name, (fmin, fmax) in SUB_BANDS.items():
        out[name] = round(stft_band_energy_db(freqs, bp, nf, fmin, fmax), 1)
    return out


def band_correlation(y1, y2, sr, fmin, fmax):
    """Phase correlation between two stems in a frequency band."""
    try:
        nyq = sr / 2
        lo  = max(fmin / nyq, 1e-4)
        hi  = min(fmax / nyq, 0.9999)
        sos = butter(4, [lo, hi], btype="band", output="sos")
        f1  = sosfilt(sos, y1)
        f2  = sosfilt(sos, y2)
        if np.std(f1) < 1e-10 or np.std(f2) < 1e-10:
            return None  # one stem silent in this band
        return round(float(np.corrcoef(f1, f2)[0, 1]), 3)
    except Exception:
        return None


def masking_severity(delta_db):
    """Return (severity_label, score 0-3) for an energy delta."""
    if delta_db < MASKING_THRESHOLDS["severe"]:
        return "severe", 3
    if delta_db < MASKING_THRESHOLDS["moderate"]:
        return "moderate", 2
    if delta_db < MASKING_THRESHOLDS["mild"]:
        return "mild", 1
    return "none", 0


def guess_category(stem_name):
    """Guess stem category from filename."""
    name = stem_name.lower().replace("-", " ").replace("_", " ")
    for keyword, category in STEM_CATEGORIES.items():
        if keyword in name:
            return category
    return "other"


def analyze_pair(name_a, y_a, name_b, y_b, sr):
    """
    Compare two stems across all frequency bands.
    Returns masking conflicts and phase issues.

    For each parent-band conflict, also identifies the dominant conflict
    sub-band — the specific frequency range where both stems compete most.
    The "dominant conflict frequency" is the sub-band where both stems have
    high energy (min(energy_a, energy_b) is greatest) within that parent band.
    That's the point with the most masking energy, i.e. where an EQ cut will
    have the biggest impact.
    """
    fp_a = stem_fingerprint(y_a, sr)
    fp_b = stem_fingerprint(y_b, sr)

    conflicts = []
    for band_name, (fmin, fmax) in STEM_BANDS.items():
        e_a = fp_a[band_name]
        e_b = fp_b[band_name]

        # Skip bands where both stems are essentially silent
        if e_a < -60 and e_b < -60:
            continue

        delta = abs(e_a - e_b)
        sev, score = masking_severity(delta)

        if score == 0:
            continue  # no masking

        # Phase correlation in this band
        corr = band_correlation(y_a, y_b, sr, fmin, fmax)

        # Dominant stem in this band
        dominant = name_a if e_a > e_b else name_b
        masked   = name_b if e_a > e_b else name_a

        # Find the dominant-conflict sub-band: the sub-band where both stems
        # have high energy simultaneously. We use min(e_a, e_b) per sub-band
        # and pick the max — that's the sub-band where the weaker stem is
        # strongest relative to silence, indicating real competition.
        dom_sub = None
        best_min_energy = -999.0
        for i in range(4):
            sub_key = f"{band_name}_{i}"
            sa = fp_a.get(sub_key)
            sb = fp_b.get(sub_key)
            if sa is None or sb is None:
                continue
            if sa < -60 and sb < -60:
                continue
            min_e = min(sa, sb)
            if min_e > best_min_energy:
                best_min_energy = min_e
                sub_fmin, sub_fmax = SUB_BANDS[sub_key]
                dom_sub = {
                    "sub_band":    sub_key,
                    "fmin":        sub_fmin,
                    "fmax":        sub_fmax,
                    "center_hz":   round((sub_fmin * sub_fmax) ** 0.5, 0),
                    "energy_a":    sa,
                    "energy_b":    sb,
                    "delta_db":    round(abs(sa - sb), 1),
                }

        conflict = {
            "band":      band_name,
            "severity":  sev,
            "score":     score,
            "energy_a":  e_a,
            "energy_b":  e_b,
            "delta_db":  round(delta, 1),
            "dominant":  dominant,
            "masked":    masked,
            "correlation": corr,
            "phase_issue": corr is not None and corr < -0.2,
            "dominant_sub_band": dom_sub,
        }
        conflicts.append(conflict)

    # Sort by severity (worst first)
    conflicts.sort(key=lambda x: x["score"], reverse=True)

    return {
        "stems":     [name_a, name_b],
        "conflicts": conflicts,
        "max_score": max((c["score"] for c in conflicts), default=0),
    }


def generate_recommendations(pair_result, stem_fingerprints):
    """Generate actionable Cubase fix suggestions for a pair of stems."""
    recs = []
    name_a, name_b = pair_result["stems"]
    cat_a = guess_category(name_a)
    cat_b = guess_category(name_b)

    for conflict in pair_result["conflicts"]:
        if conflict["score"] == 0:
            continue

        band  = conflict["band"]
        dom   = conflict["dominant"]
        masked = conflict["masked"]
        sev   = conflict["severity"]
        delta = conflict["delta_db"]

        # Band-specific EQ recommendations
        band_recs = {
            "sub":      ("20–80 Hz",  "high-pass", "Frequency EQ — HP filter"),
            "bass":     ("80–250 Hz", "notch/cut", "Frequency EQ — narrow bell cut"),
            "low_mid":  ("250–800 Hz","notch/cut", "Frequency EQ — medium bell cut"),
            "mid":      ("800 Hz–2.5 kHz","notch/cut","Frequency EQ — bell cut"),
            "presence": ("2.5–6 kHz", "notch/cut", "Frequency EQ — bell cut"),
            "air":      ("6–20 kHz",  "shelf cut", "Frequency EQ — high shelf"),
        }

        freq_range, cut_type, tool = band_recs.get(band, ("unknown", "cut", "EQ"))
        cut_amount = 2 if sev == "mild" else 4 if sev == "moderate" else 6

        # Calculate cut amount from actual energy delta
        # Goal: give the dominant stem at least 6 dB of headroom over the masked one.
        # Cut = how much we need to pull the masked stem down to achieve that.
        # Cap at 8 dB to avoid overcorrection; minimum 1.5 dB to be audible.
        headroom_target = 6.0
        current_delta   = conflict["delta_db"]  # how much dom already leads
        cut_needed      = max(1.5, min(8.0, round(headroom_target - current_delta + 0.5)))

        # Explain the reasoning clearly
        if current_delta < 1:
            reason = f"Both stems are nearly equal in this band ({current_delta:.1f} dB apart) — they are competing directly."
        else:
            reason = f"{dom} leads by only {current_delta:.1f} dB here — needs at least 6 dB of separation to stop masking."

        # If we identified a dominant sub-band, prefer its specific frequency over the
        # generic band range. That gives a surgical-EQ recommendation instead of "the Mid band".
        dom_sub = conflict.get("dominant_sub_band")
        specific_freq = None
        if dom_sub:
            specific_freq = int(dom_sub["center_hz"])
            freq_display = f"{specific_freq} Hz (within {freq_range})"
        else:
            freq_display = freq_range

        # Identify the specific cut type advice
        if cut_type == "high-pass":
            where = f"a {cut_needed} dB high-pass around {freq_display}"
        elif cut_type == "shelf cut":
            where = f"a {cut_needed} dB high shelf cut around {freq_display}"
        else:
            # For bell cuts with a specific frequency, suggest Q too
            if specific_freq:
                where = f"a {cut_needed} dB bell cut at {specific_freq} Hz, Q ≈ 1.4"
            else:
                where = f"a {cut_needed} dB bell cut around {freq_display}"

        rec = {
            "stems":   [name_a, name_b],
            "band":    band,
            "severity": sev,
            "action":  (f"Cut {masked} by {cut_needed} dB at {specific_freq} Hz"
                        if specific_freq
                        else f"Cut {masked} by {cut_needed} dB in the {freq_range} range"),
            "cubase":  (
                f"{reason} "
                f"Find the individual track within {masked} most responsible for this band, "
                f"open its Frequency EQ and apply {where}. "
                f"Cutting on the bus is a last resort — target the source track where possible."
            ),
        }
        # Expose the specific frequency in structured form for frontend display
        if dom_sub:
            rec["dominant_freq_hz"] = specific_freq
            rec["dominant_sub_band"] = dom_sub["sub_band"]

        if conflict["phase_issue"]:
            rec["phase_warning"] = (
                f"Phase conflict detected between {name_a} and {name_b} in the {band} band "
                f"(correlation {conflict['correlation']:.2f}). Check polarity on the {masked} channel — "
                f"try flipping phase in Cubase's channel settings."
            )

        recs.append(rec)

    return recs


def _build_stem_action_summary(recommendations, matrix, stems):
    """Bucket stem recommendations into three action tiers.

    Tier 1 (fix_before_bounce): severe masking + phase issues
    Tier 2 (worth_fixing): moderate masking, clear spectral hotspots
    Tier 3 (polish): mild masking, minor adjustments

    Each item carries the specific frequency (from dominant_freq_hz when
    available), the affected stem, and the exact Cubase instruction.
    """
    items = []

    for rec in recommendations:
        sev = rec.get("severity", "mild")
        tier = "fix_before_bounce" if sev == "severe" else "worth_fixing" if sev == "moderate" else "polish"
        # Priority within tier: severe=100, moderate=70, mild=40, plus adjustments
        base_score = 100 if sev == "severe" else 70 if sev == "moderate" else 40

        stems_pair = rec.get("stems", [])
        pair_label = f"{stems_pair[0]} ⇄ {stems_pair[1]}" if len(stems_pair) == 2 else ""
        band = rec.get("band", "")
        band_label = band.replace("_", " ").capitalize()

        # Specific frequency if available
        freq_hz = rec.get("dominant_freq_hz")
        location_bits = [pair_label]
        if band_label:
            location_bits.append(f"{band_label} band")
        if freq_hz:
            location_bits.append(f"{freq_hz} Hz")
        location = " · ".join(location_bits)

        # Issue summary — short, one line
        issue = f"Masking conflict ({sev})"
        if rec.get("phase_warning"):
            # Phase issue is always top priority
            tier = "fix_before_bounce"
            issue = "Phase cancellation + masking"
            base_score += 30

        items.append({
            "tier":     tier,
            "category": "masking" if not rec.get("phase_warning") else "phase",
            "issue":    issue,
            "location": location,
            "fix":      rec.get("cubase", rec.get("action", "")),
            "priority_score": base_score,
        })

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


def analyze_stems(stem_paths: dict, sr_target: int = None):
    """
    Main entry point.

    Args:
        stem_paths: dict of {stem_name: file_path}
        sr_target:  resample all stems to this rate (None = use first stem's rate)

    Returns:
        Full stem analysis report dict
    """
    if not stem_paths:
        raise ValueError("No stems provided")

    print(f"  Loading {len(stem_paths)} stems...", file=sys.stderr)

    # Load all stems, normalise to same SR
    stems = {}
    sr = sr_target

    for name, path in stem_paths.items():
        print(f"    → {name}", file=sys.stderr)
        y_mono, y_stereo, stem_sr = load_stem(path, target_sr=sr)
        if sr is None:
            sr = stem_sr
        stems[name] = {
            "y_mono":      y_mono,
            "duration":    round(len(y_mono) / sr, 1),
            "rms_db":      round(rms_db(y_mono), 1),
            "fingerprint": stem_fingerprint(y_mono, sr),
            "category":    guess_category(name),
        }

    stem_names = list(stems.keys())

    # Pairwise analysis
    print("  Analysing stem pairs...", file=sys.stderr)
    pairs = []
    recommendations = []

    for i in range(len(stem_names)):
        for j in range(i + 1, len(stem_names)):
            na, nb = stem_names[i], stem_names[j]
            pair = analyze_pair(
                na, stems[na]["y_mono"],
                nb, stems[nb]["y_mono"],
                sr
            )
            pairs.append(pair)

            recs = generate_recommendations(
                pair,
                {n: stems[n]["fingerprint"] for n in stem_names}
            )
            recommendations.extend(recs)

    # Sort all recommendations by severity
    sev_order = {"severe": 3, "moderate": 2, "mild": 1, "none": 0}
    recommendations.sort(key=lambda r: sev_order.get(r["severity"], 0), reverse=True)

    # Build masking matrix for UI heatmap
    matrix = {}
    for pair in pairs:
        na, nb = pair["stems"]
        # Find the worst conflict (highest score) for severity/band info
        worst = None
        for c in pair["conflicts"]:
            if worst is None or c["score"] > worst["score"]:
                worst = c
        sev_label = "no_conflict"
        if worst and worst["score"] > 0:
            sev_label = worst.get("severity", "no_conflict")
        # Per-band data for version diffing: {band: {severity, delta_db}}
        bands_data = {}
        for c in pair["conflicts"]:
            b = c.get("band")
            if b:
                bands_data[b] = {
                    "severity": c.get("severity", "no_conflict"),
                    "delta_db": c.get("delta_db"),
                }
        matrix[f"{na}|{nb}"] = {
            "score":      pair["max_score"],
            "conflicts":  len(pair["conflicts"]),
            "severity":   sev_label,
            "worst_band": worst.get("band") if worst else None,
            "delta_db":   worst.get("delta_db") if worst else None,
            "bands":      bands_data,
        }

    # Summary
    severe_count   = sum(1 for r in recommendations if r["severity"] == "severe")
    moderate_count = sum(1 for r in recommendations if r["severity"] == "moderate")

    # Build tiered action summary for stems
    action_summary = _build_stem_action_summary(recommendations, matrix, stems)

    return {
        "stems":           {n: {k: v for k, v in d.items() if k != "y_mono"}
                            for n, d in stems.items()},
        "sample_rate":     sr,
        "pairs":           pairs,
        "recommendations": recommendations[:15],  # top 15 most critical
        "matrix":          matrix,
        "action_summary":  action_summary,
        "summary": {
            "stem_count":     len(stems),
            "pair_count":     len(pairs),
            "severe_conflicts":   severe_count,
            "moderate_conflicts": moderate_count,
            "total_recs":     len(recommendations),
        }
    }
