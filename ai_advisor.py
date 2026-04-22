"""
ai_advisor.py — Mix analysis AI advisor using Claude API
Uses a two-turn conversation to guarantee all fields are populated.
"""

import os
import anthropic

GENRE_CONTEXT = {
    "postrock":     "Post-Rock - wide dynamics, textured guitars, cinematic builds",
    "progrock":     "Progressive Rock - complex arrangements, prominent mids, technical clarity",
    "metal":        "Metal - heavy distorted guitars, tight bass, aggressive presence",
    "instrumental": "Instrumental - lead melodic instruments, natural dynamics, wide stereo",
    "rock":         "Rock - punchy drums, balanced guitars, vocal clarity",
    "pop":          "Pop - polished, loud, spectrally balanced for streaming",
    "electronic":   "Electronic - sub-heavy, wide stereo, compressed dynamics",
    "hiphop":       "Hip-Hop - deep sub, punchy bass, bright hi-hats",
    "jazz":         "Jazz - natural dynamics, warm mids, minimal compression",
    "classical":    "Classical - very wide dynamics, transparent, full-range",
}

MIX_ADVICE_TOOL = {
    "name": "submit_mix_advice",
    "description": "Submit the complete mixing and mastering advice report.",
    "input_schema": {
        "type": "object",
        "properties": {
            "overall": {
                "type": "string",
                "description": "2-3 sentence overall assessment."
            },
            "issues": {
                "type": "array",
                "minItems": 3,
                "description": "Exactly 3-5 prioritized issues.",
                "items": {
                    "type": "object",
                    "properties": {
                        "priority": {"type": "integer", "minimum": 1, "maximum": 5},
                        "title":    {"type": "string"},
                        "problem":  {"type": "string"},
                        "fix":      {"type": "string"},
                        "stage":    {"type": "string", "enum": ["mix", "master"]}
                    },
                    "required": ["priority", "title", "problem", "fix", "stage"]
                }
            },
            "positives": {
                "type": "array",
                "minItems": 1,
                "items": {"type": "string"},
                "description": "1-2 things working well."
            },
            "mastering_note": {
                "type": "string",
                "description": "One specific mastering-stage recommendation."
            }
        },
        "required": ["overall", "issues", "positives", "mastering_note"]
    }
}


def build_prompt(report):
    genre_key  = report.get("genre", "unknown")
    genre_desc = GENRE_CONTEXT.get(genre_key, genre_key)
    L  = report["loudness"]
    S  = report["spectrum"]
    St = report["stereo"]
    D  = report["dynamics"]

    band_lines = ", ".join(
        "{} {}dB (delta {}{})".format(
            name, b["energy_db"],
            "+" if b["delta_db"] > 0 else "", b["delta_db"]
        )
        for name, b in S["bands"].items()
    )
    warnings = "; ".join(report["summary"]["warnings"]) or "None"

    return (
        "Genre: {genre}\n"
        "Loudness: {lufs} LUFS, {peak} dBFS peak, {crest} dB crest, {delta} LUFS above streaming target\n"
        "Spectrum: {bands}\n"
        "Spectral tilt: {tilt} dB/decade\n"
        "Stereo: correlation={corr}, width={width} dB, mono delta={mono} dB\n"
        "Dynamics: RMS variance={rms}, transients/sec={tps}, headroom={hr} dB\n"
        "Issues detected: {warnings}\n\n"
        "You are a Cubase mixing engineer. Call submit_mix_advice with:\n"
        "- overall: 2-3 sentence assessment for a {genre} track\n"
        "- issues: at least 3 specific problems with Cubase tool names and exact parameter values\n"
        "- positives: 1-2 things working well\n"
        "- mastering_note: one mastering recommendation"
    ).format(
        genre=genre_desc,
        lufs=L["integrated_lufs"], peak=L["true_peak_dbfs"],
        crest=L["crest_factor_db"], delta=L.get("streaming_delta_lufs", "N/A"),
        bands=band_lines, tilt=S["spectral_tilt_db_per_decade"],
        corr=St["lr_correlation"], width=St["mid_side_ratio_db"],
        mono=St["mono_compatibility_db"],
        rms=D["rms_variance"], tps=D["transients_per_second"], hr=D["headroom_db"],
        warnings=warnings,
    )


def get_advice(report, api_key=None):
    key = api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise ValueError("No ANTHROPIC_API_KEY found.")

    genre = report.get("genre", "unknown")
    print(f"  [AI] Analyzing genre={genre}", flush=True)

    client = anthropic.Anthropic(api_key=key)
    prompt = build_prompt(report)

    # Turn 1: get Claude to call the tool
    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2000,
        tools=[MIX_ADVICE_TOOL],
        tool_choice={"type": "tool", "name": "submit_mix_advice"},
        messages=[{"role": "user", "content": prompt}],
    )

    print(f"  [AI] Stop reason: {response.stop_reason}", flush=True)

    for block in response.content:
        if block.type == "tool_use" and block.name == "submit_mix_advice":
            result = dict(block.input)
            print(f"  [AI] Keys returned: {list(result.keys())}", flush=True)
            print(f"  [AI] Issues count: {len(result.get('issues', []))}", flush=True)
            return result

    raise ValueError(f"Tool was not called. Stop reason: {response.stop_reason}")
