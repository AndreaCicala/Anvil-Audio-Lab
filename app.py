"""
app.py — Flask backend for Anvil Audio Lab
Run with: python app.py
Then open http://localhost:5000
"""

import os
import re
import json
import time
import uuid
from flask import Flask, request, jsonify, render_template, send_from_directory
from werkzeug.utils import secure_filename
from mix_analyzer import analyze
# ai_advisor is optional — it depends on the `anthropic` package which may
# not be installed (e.g. in a packaged .exe build without the SDK). Import
# lazily so the app still boots. The /advice route checks ADVISOR_AVAILABLE
# and returns a helpful error if the dependency is missing or unconfigured.
try:
    from ai_advisor import get_advice
    ADVISOR_AVAILABLE = True
    ADVISOR_IMPORT_ERROR = None
except ImportError as _e:
    get_advice = None
    ADVISOR_AVAILABLE = False
    ADVISOR_IMPORT_ERROR = str(_e)
from stem_analyzer import analyze_stems

app = Flask(__name__)
app.config["UPLOAD_FOLDER"] = "uploads"
app.config["REPORTS_FOLDER"] = "reports"
app.config["MAX_CONTENT_LENGTH"] = 500 * 1024 * 1024

ALLOWED_EXTENSIONS = {"wav", "wave", "aiff", "aif", "flac"}

def allowed_file(filename):
    if "." not in filename:
        return False
    return filename.rsplit(".", 1)[1].lower().strip() in ALLOWED_EXTENSIONS


def _json_default(o):
    """Handle numpy scalars/arrays when dumping stem reports."""
    try:
        import numpy as np
        if isinstance(o, np.ndarray):
            return o.tolist()
        if isinstance(o, (np.integer, np.floating)):
            return o.item()
        if isinstance(o, np.bool_):
            return bool(o)
    except ImportError:
        pass
    raise TypeError(f"Object of type {type(o).__name__} is not JSON serializable")


def _normalize_stem_name(name):
    """Normalize a stem name for project matching.
    Strips common version suffixes, numbers, spaces, punctuation."""
    s = (name or "").lower()
    s = re.sub(r"\.(wav|aiff?|flac)$", "", s)          # extension
    s = re.sub(r"[\s_\-]*v\d+$", "", s)                 # v1, v2
    s = re.sub(r"[\s_\-]*\d{3,4}$", "", s)              # 0001, 001
    s = re.sub(r"[\s_\-]*(final|master|bounce|export)$", "", s)
    s = re.sub(r"[^a-z0-9]", "", s)                     # strip all punct/space
    return s


def _fingerprint_stems(names):
    """Produce a stable fingerprint for a set of stem names."""
    normed = sorted({_normalize_stem_name(n) for n in names if n})
    return "|".join(normed)


def _find_stem_project_history(fingerprint, exclude_id=None):
    """Return list of existing stem reports matching this fingerprint, newest first."""
    import glob
    report_dir = app.config["REPORTS_FOLDER"]
    files = glob.glob(os.path.join(report_dir, "*_stem_report.json"))
    matches = []
    for f in files:
        try:
            with open(f) as fh:
                r = json.load(fh)
            if r.get("fingerprint") == fingerprint and r.get("stem_report_id") != exclude_id:
                matches.append(r)
        except Exception:
            pass
    matches.sort(key=lambda r: r.get("created_at", 0), reverse=True)
    return matches


def _normalize_mix_filename(filename):
    """Normalize a mix filename for project matching. Strips UID prefixes,
    version suffixes, extensions, punctuation."""
    s = (filename or "").lower()
    # Strip leading UID (8 hex chars + underscore) added by /analyze
    s = re.sub(r"^[a-f0-9]{8}_", "", s)
    s = re.sub(r"\.(wav|aiff?|flac)$", "", s)
    s = re.sub(r"[\s_\-]*v\d+$", "", s)
    s = re.sub(r"[\s_\-]*\d{3,4}$", "", s)
    s = re.sub(r"[\s_\-]*(final|master|bounce|export|mix|mixdown)$", "", s)
    s = re.sub(r"[^a-z0-9]", "", s)
    return s


def _find_mix_project_history(fingerprint, exclude_id=None):
    """Return list of existing mix reports with matching fingerprint, newest first."""
    import glob
    report_dir = app.config["REPORTS_FOLDER"]
    all_files = glob.glob(os.path.join(report_dir, "*_report.json"))
    files = [f for f in all_files if not f.endswith("_stem_report.json")]
    matches = []
    for f in files:
        try:
            with open(f) as fh:
                r = json.load(fh)
            if r.get("mix_fingerprint") == fingerprint and r.get("report_id") != exclude_id:
                matches.append(r)
        except Exception:
            pass
    matches.sort(key=lambda r: r.get("created_at", 0), reverse=True)
    return matches


@app.route("/config")
def config():
    """Expose runtime capability flags to the frontend.

    advisor_available: can the server reach the ai_advisor module? False in
        builds without the `anthropic` SDK installed (e.g. packaged .exe).
    has_api_key: is ANTHROPIC_API_KEY set? Without it, advice calls will
        fail even if the module itself is importable.
    """
    has_key = bool(os.environ.get("ANTHROPIC_API_KEY"))
    return jsonify({
        "has_api_key": has_key,
        "advisor_available": ADVISOR_AVAILABLE,
    })


@app.route("/favicon.ico")
def favicon():
    return send_from_directory("static", "favicon.ico", mimetype="image/x-icon")


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/history")
def get_history():
    """Return list of recent mix reports (excludes stem reports)."""
    import glob
    report_dir = app.config["REPORTS_FOLDER"]
    files = glob.glob(os.path.join(report_dir, "*_report.json"))
    files = [f for f in files if not f.endswith("_stem_report.json")]
    files.sort(key=os.path.getmtime, reverse=True)
    history = []
    for f in files[:20]:
        try:
            with open(f) as fh:
                r = json.load(fh)
            fname = (r.get("file","") or "").replace("\\","/").split("/")[-1]
            fname = __import__("re").sub(r"^[a-f0-9_-]+_","",fname)
            history.append({
                "report_id": r.get("report_id",""),
                "file":      fname,
                "genre":     r.get("genre",""),
                "duration":  r.get("duration_seconds",0),
                "issues":    r.get("summary",{}).get("total_issues",0),
                "mtime":     os.path.getmtime(f),
            })
        except Exception:
            pass
    return jsonify(history)


@app.route("/stems")
def stems_page():
    return render_template("stems.html")


@app.route("/analyze-stems", methods=["POST"])
def run_stem_analysis():
    if "stems" not in request.files:
        return jsonify({"error": "No stem files uploaded"}), 400

    files   = request.files.getlist("stems")
    names   = request.form.getlist("names")
    genre   = request.form.get("genre", "auto")

    if not files or len(files) < 2:
        return jsonify({"error": "Please upload at least 2 stem files"}), 400

    saved = {}
    uid   = str(uuid.uuid4())[:8]

    try:
        for i, file in enumerate(files):
            if not file.filename or not allowed_file(file.filename):
                continue
            stem_name = names[i] if i < len(names) and names[i] else                         file.filename.rsplit(".", 1)[0]
            fname = uid + "_stem_" + secure_filename(file.filename)
            fpath = os.path.join(app.config["UPLOAD_FOLDER"], fname)
            file.save(fpath)
            saved[stem_name] = fpath

        if len(saved) < 2:
            return jsonify({"error": "Need at least 2 valid audio files"}), 400

        print(f"  >> Stem analysis: {list(saved.keys())}", flush=True)
        print(f"  >> Stem count: {len(saved)}", flush=True)
        result = analyze_stems(saved)
        print(f"  >> Analysis complete: {result['summary']}", flush=True)

        # Attach metadata + version info
        stem_names = list(saved.keys())
        fingerprint = _fingerprint_stems(stem_names)
        prior = _find_stem_project_history(fingerprint)

        if prior:
            project_id = prior[0].get("project_id") or prior[0].get("stem_report_id", uid)
            version = max((p.get("version", 1) for p in prior), default=0) + 1
            previous_version = {
                "stem_report_id": prior[0].get("stem_report_id"),
                "version": prior[0].get("version", 1),
                "created_at": prior[0].get("created_at"),
            }
            siblings = len(prior) + 1
        else:
            project_id = uid
            version = 1
            previous_version = None
            siblings = 1

        result["stem_report_id"]  = uid
        result["created_at"]      = time.time()
        result["stem_names"]      = stem_names
        result["genre"]           = genre
        result["fingerprint"]     = fingerprint
        result["project_id"]      = project_id
        result["version"]         = version
        result["previous_version"] = previous_version
        result["project_versions_total"] = siblings

        path = os.path.join(app.config["REPORTS_FOLDER"], uid + "_stem_report.json")
        try:
            with open(path, "w") as f:
                json.dump(result, f, indent=2, default=_json_default)
            print(f"  >> Stem report saved: {path} | v{version} of project {project_id}", flush=True)
        except Exception as e:
            print(f"  !! Could not save stem report: {e}", flush=True)

        return jsonify(result)

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

    finally:
        for path in saved.values():
            if os.path.exists(path):
                os.remove(path)


@app.route("/analyze", methods=["POST"])
def run_analysis():
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    file  = request.files["file"]
    genre = request.form.get("genre", "auto")
    print(f"  >> Received: '{file.filename}' | genre={genre}", flush=True)

    ref_file = request.files.get("reference")

    if not file.filename:
        return jsonify({"error": "No filename received."}), 400
    if not allowed_file(file.filename):
        ext = file.filename.rsplit(".", 1)[-1] if "." in file.filename else "none"
        return jsonify({"error": f"Unsupported file type '.{ext}'. Use WAV, AIFF, or FLAC."}), 400

    uid      = str(uuid.uuid4())[:8]
    filename = uid + "_" + secure_filename(file.filename)
    filepath = os.path.join(app.config["UPLOAD_FOLDER"], filename)
    file.save(filepath)

    ref_path = None
    if ref_file and ref_file.filename and allowed_file(ref_file.filename):
        ref_name = uid + "_ref_" + secure_filename(ref_file.filename)
        ref_path = os.path.join(app.config["UPLOAD_FOLDER"], ref_name)
        ref_file.save(ref_path)

    try:
        report = analyze(filepath, genre=genre, ref_path=ref_path)
        report["report_id"] = uid  # add BEFORE saving

        # Versioning: match by normalized filename
        mix_fingerprint = _normalize_mix_filename(file.filename)
        prior = _find_mix_project_history(mix_fingerprint) if mix_fingerprint else []
        if prior:
            project_id = prior[0].get("mix_project_id") or prior[0].get("report_id", uid)
            version = max((p.get("version", 1) for p in prior), default=0) + 1
            previous_version = {
                "report_id":  prior[0].get("report_id"),
                "version":    prior[0].get("version", 1),
                "created_at": prior[0].get("created_at"),
            }
            siblings = len(prior) + 1
        else:
            project_id = uid
            version = 1
            previous_version = None
            siblings = 1

        report["created_at"]       = time.time()
        report["mix_fingerprint"]  = mix_fingerprint
        report["mix_project_id"]   = project_id
        report["version"]          = version
        report["previous_version"] = previous_version
        report["project_versions_total"] = siblings

        report_path = os.path.join(app.config["REPORTS_FOLDER"], uid + "_report.json")
        with open(report_path, "w") as f:
            json.dump(report, f, indent=2)

        print(f"  >> Report saved: {report_path} | genre={report.get('genre')} | v{version}", flush=True)
        return jsonify(report)

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

    finally:
        if os.path.exists(filepath):
            os.remove(filepath)
        if ref_path and os.path.exists(ref_path):
            os.remove(ref_path)


@app.route("/advice", methods=["POST"])
def run_advice():
    # The advisor is optional. In builds without the `anthropic` SDK
    # installed (see the import-block at the top of this file), the route
    # returns a clear explanation rather than crashing — some deployments
    # (like the packaged .exe) intentionally omit the SDK to keep the
    # binary small and avoid requiring an API key to run.
    if not ADVISOR_AVAILABLE:
        return jsonify({
            "error": "AI advisor is not available in this build. "
                     "The `anthropic` Python package must be installed "
                     "for /advice to work.",
            "reason": "module_not_installed",
        }), 503

    data = request.get_json()
    if not data:
        return jsonify({"error": "No data received"}), 400

    api_key = data.get("api_key") or os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return jsonify({
            "error": "No API key. Set ANTHROPIC_API_KEY or enter it in the UI.",
            "reason": "no_api_key",
        }), 400

    # Always use inline report from browser (freshest data, avoids disk/cache issues)
    report = data.get("report")
    if not report:
        return jsonify({"error": "No report data received. Please re-run the analysis."}), 400

    print(f"  >> Getting advice for genre={report.get('genre')}", flush=True)

    try:
        advice = get_advice(report, api_key=api_key)
        return jsonify(advice)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/report/<report_id>")
def get_report(report_id):
    safe_id = secure_filename(report_id)
    path = os.path.join(app.config["REPORTS_FOLDER"], safe_id + "_report.json")
    if not os.path.exists(path):
        return jsonify({"error": "Report not found"}), 404
    with open(path) as f:
        return jsonify(json.load(f))


@app.route("/report/<report_id>", methods=["DELETE"])
def delete_report(report_id):
    safe_id = secure_filename(report_id)
    if not safe_id:
        return jsonify({"error": "Invalid report id"}), 400
    path = os.path.join(app.config["REPORTS_FOLDER"], safe_id + "_report.json")
    if not os.path.exists(path):
        return jsonify({"error": "Report not found"}), 404
    try:
        os.remove(path)
        print(f"  >> Deleted mix report: {safe_id}", flush=True)
        return jsonify({"report_id": safe_id, "deleted": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/stem-history")
def get_stem_history():
    """Return recent stem analyses, grouped-aware (project_id + version)."""
    import glob
    report_dir = app.config["REPORTS_FOLDER"]
    files = glob.glob(os.path.join(report_dir, "*_stem_report.json"))
    files.sort(key=os.path.getmtime, reverse=True)
    history = []
    for f in files[:30]:
        try:
            with open(f) as fh:
                r = json.load(fh)
            summary = r.get("summary", {}) or {}
            history.append({
                "report_id":   r.get("stem_report_id", ""),
                "project_id":  r.get("project_id"),
                "version":     r.get("version", 1),
                "stem_names":  r.get("stem_names", []),
                "genre":       r.get("genre", "auto"),
                "stem_count":  summary.get("stem_count", 0),
                "pair_count":  summary.get("pair_count", 0),
                "severe":      summary.get("severe_conflicts", 0),
                "moderate":    summary.get("moderate_conflicts", 0),
                "total_recs":  summary.get("total_recs", 0),
                "mtime":       os.path.getmtime(f),
            })
        except Exception:
            pass
    return jsonify(history)


@app.route("/stem-report/<report_id>")
def get_stem_report(report_id):
    safe_id = secure_filename(report_id)
    path = os.path.join(app.config["REPORTS_FOLDER"], safe_id + "_stem_report.json")
    if not os.path.exists(path):
        return jsonify({"error": "Stem report not found"}), 404
    with open(path) as f:
        return jsonify(json.load(f))


@app.route("/stem-report/<report_id>", methods=["DELETE"])
def delete_stem_report(report_id):
    safe_id = secure_filename(report_id)
    if not safe_id:
        return jsonify({"error": "Invalid report id"}), 400
    path = os.path.join(app.config["REPORTS_FOLDER"], safe_id + "_stem_report.json")
    if not os.path.exists(path):
        return jsonify({"error": "Stem report not found"}), 404
    try:
        os.remove(path)
        print(f"  >> Deleted stem report: {safe_id}", flush=True)
        return jsonify({"report_id": safe_id, "deleted": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def _severity_rank(sev):
    return {"no_conflict": 0, "mild": 1, "moderate": 2, "severe": 3}.get(sev, 0)


@app.route("/stem-diff/<old_id>/<new_id>")
def stem_diff(old_id, new_id):
    """Compute diff between two stem reports — at band granularity within each pair.

    For each (pair, band) combination we classify as:
      fix        — severity dropped a tier, OR same tier but dB delta improved by ≥1 dB
      regression — severity rose a tier, OR same tier but dB delta worsened by ≥1 dB
      new        — band conflict present in new but not in old
      resolved   — band conflict present in old but not in new
      unchanged  — same tier, dB delta within ±1 dB
    """
    def load(rid):
        p = os.path.join(app.config["REPORTS_FOLDER"], secure_filename(rid) + "_stem_report.json")
        if not os.path.exists(p):
            return None
        with open(p) as fh:
            return json.load(fh)
    old_r = load(old_id)
    new_r = load(new_id)
    if not old_r or not new_r:
        return jsonify({"error": "One or both reports not found"}), 404

    old_matrix = old_r.get("matrix", {}) or {}
    new_matrix = new_r.get("matrix", {}) or {}

    def norm_pair(key):
        parts = [_normalize_stem_name(p) for p in key.split("|")]
        return "|".join(sorted(parts))

    old_by_norm = {norm_pair(k): (k, v) for k, v in old_matrix.items()}
    new_by_norm = {norm_pair(k): (k, v) for k, v in new_matrix.items()}

    def extract_bands(entry):
        """Return the bands dict, falling back to legacy worst-band data for old reports."""
        b = entry.get("bands") or {}
        if b:
            return b
        # Legacy fallback: reconstruct from worst_band / severity / delta_db
        wb = entry.get("worst_band")
        if wb:
            return {wb: {"severity": entry.get("severity", "no_conflict"),
                         "delta_db": entry.get("delta_db")}}
        return {}

    IMPROVEMENT_THRESHOLD_DB = 2.0  # empirically: Cubase exports drift by up to ~1.8 dB
                                     # between identical re-renders, so 2 dB filters noise

    fixes, regressions, new_issues, resolved, unchanged = [], [], [], [], []

    def all_pair_keys():
        return set(old_by_norm.keys()) | set(new_by_norm.keys())

    for np_key in all_pair_keys():
        old_tuple = old_by_norm.get(np_key)
        new_tuple = new_by_norm.get(np_key)

        if old_tuple and new_tuple:
            # Pair present in both versions — do band-level diff
            orig_key = new_tuple[0]  # prefer new's naming
            old_entry = old_tuple[1]
            new_entry = new_tuple[1]
            old_bands = extract_bands(old_entry)
            new_bands = extract_bands(new_entry)

            all_bands = set(old_bands.keys()) | set(new_bands.keys())
            for band in all_bands:
                ob = old_bands.get(band)
                nb = new_bands.get(band)

                if ob and nb:
                    # Conflict exists in both — compare severity and delta
                    old_sev = ob.get("severity", "no_conflict")
                    new_sev = nb.get("severity", "no_conflict")
                    old_d = ob.get("delta_db")
                    new_d = nb.get("delta_db")
                    old_rank = _severity_rank(old_sev)
                    new_rank = _severity_rank(new_sev)

                    entry = {
                        "pair": orig_key, "band": band,
                        "old_severity": old_sev, "new_severity": new_sev,
                        "old_delta_db": old_d, "new_delta_db": new_d,
                    }

                    # Severity tier is the authority. It encodes the masking physics:
                    # lower dB delta = stems competing more = WORSE masking, so tier drop
                    # (severe→moderate→mild→clean) = improvement.
                    # Numeric delta is only used within a single tier to detect small
                    # improvements/regressions below the noise-floor threshold.
                    if new_rank < old_rank:
                        # Tier dropped → fix. Suppress if numeric change is below noise floor.
                        if old_d is not None and new_d is not None and abs(old_d - new_d) < IMPROVEMENT_THRESHOLD_DB:
                            unchanged.append(entry)
                        else:
                            fixes.append(entry)
                    elif new_rank > old_rank:
                        # Tier rose → regression. Same noise-floor check.
                        if old_d is not None and new_d is not None and abs(old_d - new_d) < IMPROVEMENT_THRESHOLD_DB:
                            unchanged.append(entry)
                        else:
                            regressions.append(entry)
                    else:
                        # Same tier — use numeric delta to detect within-tier movement.
                        # Remember: LOWER dB delta = WORSE (more equal energies = more masking).
                        # So a decrease in delta_db = regression, increase = improvement.
                        if old_d is not None and new_d is not None:
                            diff = new_d - old_d  # positive = more separation = improvement
                            if abs(diff) < IMPROVEMENT_THRESHOLD_DB:
                                unchanged.append(entry)
                            elif diff > 0:
                                fixes.append(entry)
                            else:
                                regressions.append(entry)
                        else:
                            unchanged.append(entry)

                elif nb and not ob:
                    # New band conflict
                    if _severity_rank(nb.get("severity", "no_conflict")) > 0:
                        new_issues.append({
                            "pair": orig_key, "band": band,
                            "new_severity": nb.get("severity"),
                            "new_delta_db": nb.get("delta_db"),
                        })

                elif ob and not nb:
                    # Band conflict no longer present — counts as a fix (resolved within pair)
                    if _severity_rank(ob.get("severity", "no_conflict")) > 0:
                        fixes.append({
                            "pair": orig_key, "band": band,
                            "old_severity": ob.get("severity"),
                            "new_severity": "no_conflict",
                            "old_delta_db": ob.get("delta_db"),
                            "new_delta_db": None,
                        })

        elif new_tuple and not old_tuple:
            # Whole new pair — list each band conflict as new
            orig_key = new_tuple[0]
            for band, b in extract_bands(new_tuple[1]).items():
                if _severity_rank(b.get("severity", "no_conflict")) > 0:
                    new_issues.append({
                        "pair": orig_key, "band": band,
                        "new_severity": b.get("severity"),
                        "new_delta_db": b.get("delta_db"),
                    })

        elif old_tuple and not new_tuple:
            # Whole pair no longer present — list each band conflict as resolved
            orig_key = old_tuple[0]
            for band, b in extract_bands(old_tuple[1]).items():
                if _severity_rank(b.get("severity", "no_conflict")) > 0:
                    resolved.append({
                        "pair": orig_key, "band": band,
                        "old_severity": b.get("severity"),
                        "old_delta_db": b.get("delta_db"),
                    })

    def by_old(x): return -_severity_rank(x.get("old_severity", "no_conflict"))
    def by_new(x): return -_severity_rank(x.get("new_severity", "no_conflict"))
    fixes.sort(key=by_old)
    regressions.sort(key=by_new)
    new_issues.sort(key=by_new)
    resolved.sort(key=by_old)

    return jsonify({
        "old_report_id":  old_r.get("stem_report_id"),
        "new_report_id":  new_r.get("stem_report_id"),
        "old_version":    old_r.get("version"),
        "new_version":    new_r.get("version"),
        "old_summary":    old_r.get("summary"),
        "new_summary":    new_r.get("summary"),
        "fixes":          fixes,
        "regressions":    regressions,
        "new_issues":     new_issues,
        "resolved":       resolved,
        "unchanged_count": len(unchanged),
        "granularity":    "band",
    })


@app.route("/stem-project/<project_id>")
def stem_project(project_id):
    """Return all versions of a stem project (for timeline view)."""
    import glob
    pid = secure_filename(project_id)
    files = glob.glob(os.path.join(app.config["REPORTS_FOLDER"], "*_stem_report.json"))
    versions = []
    for f in files:
        try:
            with open(f) as fh:
                r = json.load(fh)
            if r.get("project_id") == pid:
                summary = r.get("summary", {}) or {}
                versions.append({
                    "report_id":  r.get("stem_report_id"),
                    "version":    r.get("version", 1),
                    "created_at": r.get("created_at"),
                    "stem_count": summary.get("stem_count", 0),
                    "severe":     summary.get("severe_conflicts", 0),
                    "moderate":   summary.get("moderate_conflicts", 0),
                    "total_recs": summary.get("total_recs", 0),
                })
        except Exception:
            pass
    versions.sort(key=lambda v: v.get("version", 0))
    return jsonify({"project_id": pid, "versions": versions})


@app.route("/stem-project/<project_id>", methods=["DELETE"])
def delete_stem_project(project_id):
    """Delete all stem report files belonging to a project."""
    import glob
    pid = secure_filename(project_id)
    if not pid:
        return jsonify({"error": "Invalid project id"}), 400

    files = glob.glob(os.path.join(app.config["REPORTS_FOLDER"], "*_stem_report.json"))
    deleted = []
    for f in files:
        try:
            with open(f) as fh:
                r = json.load(fh)
            if r.get("project_id") == pid:
                os.remove(f)
                deleted.append(os.path.basename(f))
        except Exception as e:
            print(f"  !! Could not remove {f}: {e}", flush=True)

    print(f"  >> Deleted {len(deleted)} stem reports for project {pid}", flush=True)
    return jsonify({"project_id": pid, "deleted_count": len(deleted), "deleted": deleted})


@app.route("/mix-project/<project_id>")
def mix_project(project_id):
    """Return all versions of a mix project."""
    import glob
    pid = secure_filename(project_id)
    all_files = glob.glob(os.path.join(app.config["REPORTS_FOLDER"], "*_report.json"))
    files = [f for f in all_files if not f.endswith("_stem_report.json")]
    versions = []
    for f in files:
        try:
            with open(f) as fh:
                r = json.load(fh)
            if r.get("mix_project_id") == pid:
                loud = r.get("loudness", {}) or {}
                versions.append({
                    "report_id":  r.get("report_id"),
                    "version":    r.get("version", 1),
                    "created_at": r.get("created_at"),
                    "lufs":       loud.get("integrated_lufs"),
                    "true_peak":  loud.get("true_peak_dbfs"),
                    "issues":     (r.get("summary") or {}).get("total_issues", 0),
                })
        except Exception:
            pass
    versions.sort(key=lambda v: v.get("version", 0))
    return jsonify({"project_id": pid, "versions": versions})


@app.route("/mix-project/<project_id>", methods=["DELETE"])
def delete_mix_project(project_id):
    """Delete all versions of a mix project."""
    import glob
    pid = secure_filename(project_id)
    if not pid:
        return jsonify({"error": "Invalid project id"}), 400
    all_files = glob.glob(os.path.join(app.config["REPORTS_FOLDER"], "*_report.json"))
    files = [f for f in all_files if not f.endswith("_stem_report.json")]
    deleted = []
    for f in files:
        try:
            with open(f) as fh:
                r = json.load(fh)
            if r.get("mix_project_id") == pid:
                os.remove(f)
                deleted.append(os.path.basename(f))
        except Exception as e:
            print(f"  !! Could not remove {f}: {e}", flush=True)
    print(f"  >> Deleted {len(deleted)} mix reports for project {pid}", flush=True)
    return jsonify({"project_id": pid, "deleted_count": len(deleted), "deleted": deleted})


@app.route("/mix-diff/<old_id>/<new_id>")
def mix_diff(old_id, new_id):
    """Compute diff between two mix reports.
    Returns per-metric changes (LUFS, true peak, crest, stereo, band energies)
    above noise-floor thresholds.
    """
    def load(rid):
        p = os.path.join(app.config["REPORTS_FOLDER"], secure_filename(rid) + "_report.json")
        if not os.path.exists(p):
            return None
        with open(p) as fh:
            return json.load(fh)
    old_r = load(old_id)
    new_r = load(new_id)
    if not old_r or not new_r:
        return jsonify({"error": "One or both reports not found"}), 404

    # Per-metric noise-floor thresholds (below = "unchanged")
    #   LUFS: 0.5 dB is meaningful to the ear; re-renders drift ~0.1
    #   True peak: 0.3 dB is audible
    #   Crest factor: 1.0 dB
    #   Stereo correlation: 0.05
    #   Stereo width: 1.0 dB
    #   Spectral band energy: 1.0 dB
    changes = []

    def add(name, category, old_v, new_v, thresh, unit="", lower_is_better=False, higher_is_better=False):
        if old_v is None or new_v is None:
            return
        diff = new_v - old_v
        if abs(diff) < thresh:
            return
        # Direction: was the change an improvement?
        if lower_is_better:
            direction = "fix" if diff < 0 else "regression"
        elif higher_is_better:
            direction = "fix" if diff > 0 else "regression"
        else:
            direction = "change"
        changes.append({
            "name": name, "category": category,
            "old": round(old_v, 2), "new": round(new_v, 2),
            "delta": round(diff, 2), "unit": unit,
            "direction": direction,
        })

    # Loudness family
    ol = old_r.get("loudness") or {}
    nl = new_r.get("loudness") or {}
    add("Integrated LUFS", "loudness", ol.get("integrated_lufs"), nl.get("integrated_lufs"), 0.5, "LUFS")
    add("True peak",       "loudness", ol.get("true_peak_dbfs"),  nl.get("true_peak_dbfs"),  0.3, "dBFS", lower_is_better=True)
    add("Crest factor",    "loudness", ol.get("crest_factor_db"), nl.get("crest_factor_db"), 1.0, "dB")

    # Stereo
    os_ = old_r.get("stereo") or {}
    ns_ = new_r.get("stereo") or {}
    add("L/R correlation", "stereo", os_.get("lr_correlation"),    ns_.get("lr_correlation"),    0.05, "",   higher_is_better=True)
    add("Stereo width",    "stereo", os_.get("mid_side_ratio_db"), ns_.get("mid_side_ratio_db"), 1.0,  "dB")

    # Spectral — compare each band's energy_db
    BAND_PRETTY = {"sub":"Sub","bass":"Bass","low_mid":"Low mid","mid":"Mid","presence":"Presence","air":"Air"}
    obands = (old_r.get("spectrum") or {}).get("bands") or {}
    nbands = (new_r.get("spectrum") or {}).get("bands") or {}
    for band_key, pretty in BAND_PRETTY.items():
        o = obands.get(band_key) or {}
        n = nbands.get(band_key) or {}
        add(f"{pretty}", "spectrum", o.get("energy_db"), n.get("energy_db"), 1.0, "dB")

    # Issue count summary (not grouped into changes — it's a top-level number)
    old_issues = (old_r.get("summary") or {}).get("total_issues", 0)
    new_issues = (new_r.get("summary") or {}).get("total_issues", 0)

    fixes       = [c for c in changes if c["direction"] == "fix"]
    regressions = [c for c in changes if c["direction"] == "regression"]
    neutral     = [c for c in changes if c["direction"] == "change"]

    return jsonify({
        "old_report_id": old_r.get("report_id"),
        "new_report_id": new_r.get("report_id"),
        "old_version":   old_r.get("version"),
        "new_version":   new_r.get("version"),
        "old_issues":    old_issues,
        "new_issues":    new_issues,
        "old_filename":  (old_r.get("file","") or "").replace("\\","/").split("/")[-1],
        "new_filename":  (new_r.get("file","") or "").replace("\\","/").split("/")[-1],
        "fixes":         fixes,
        "regressions":   regressions,
        "neutral":       neutral,
        "unchanged_count": 0,  # we don't enumerate unchanged metrics
    })


# =============================================================================
# MASTERING — routes for offline mastering page
# =============================================================================
# Mastering uses a persistent upload folder (MASTER_UPLOADS) because we need
# the source file around across separate requests (analyze -> preview -> export).
# A background TTL cleanup is handled on each new upload: anything older than
# MASTER_UPLOAD_TTL_SECONDS gets purged.

from master_engine import (
    propose_chain,
    run_chain,
    render_to_wav,
    measure_master,
    measure_reference_spectrum,
    propose_reference_match,
    propose_genre_match,
    compute_eq_response,
    analyze_ms_bass,
    analyze_ms_air,
    embed_metadata,
    DEFAULT_TARGET_LUFS,
    DEFAULT_CEILING_DBFS,
)
from mix_analyzer import load_audio as _ma_load_audio

app.config["MASTER_UPLOADS"] = "master_uploads"
app.config["MASTER_REPORTS"] = "master_reports"
os.makedirs(app.config["MASTER_UPLOADS"], exist_ok=True)
os.makedirs(app.config["MASTER_REPORTS"], exist_ok=True)

MASTER_UPLOAD_TTL_SECONDS = 24 * 60 * 60   # 24 h; cleaned opportunistically


def _cleanup_master_uploads():
    """Purge master-upload files older than TTL. Called on new uploads."""
    now = time.time()
    folder = app.config["MASTER_UPLOADS"]
    try:
        for name in os.listdir(folder):
            p = os.path.join(folder, name)
            if os.path.isfile(p) and (now - os.path.getmtime(p)) > MASTER_UPLOAD_TTL_SECONDS:
                try:
                    os.remove(p)
                except OSError:
                    pass
    except FileNotFoundError:
        pass


def _save_master_upload(file_obj, original_name):
    """Save an uploaded file under a UID and return (uid, filepath)."""
    _cleanup_master_uploads()
    uid = str(uuid.uuid4())[:8]
    safe = secure_filename(original_name or "upload.wav")
    fname = f"{uid}_{safe}"
    fpath = os.path.join(app.config["MASTER_UPLOADS"], fname)
    file_obj.save(fpath)
    return uid, fpath


def _lookup_master_upload(uid):
    """Return filepath for a given master-upload uid, or None."""
    folder = app.config["MASTER_UPLOADS"]
    try:
        for name in os.listdir(folder):
            if name.startswith(f"{uid}_"):
                return os.path.join(folder, name)
    except FileNotFoundError:
        pass
    return None


# ----- Page render ---------------------------------------------------------

@app.route("/master")
def master_page():
    return render_template("master.html")


# ---------------------------------------------------------------------------
# Release check — separate verification tool (own page + API route).
# ---------------------------------------------------------------------------

@app.route("/release")
def release_page():
    return render_template("release.html")


@app.route("/release-check", methods=["POST"])
def release_check():
    """Upload a finished master and verify it against a platform's delivery
    specs. Returns pass/warn/fail status per check.

    Request: multipart/form-data with:
      file     — WAV or FLAC
      platform — "spotify" | "youtube" | "bandcamp" (default spotify)

    Response JSON:
      {
        filename: str,
        duration_seconds: float,
        sample_rate: int,
        measurements: {integrated_lufs, true_peak_dbfs, lra, ...},
        report: { platform, platform_label, overall_status, checks: [...] },
      }
    """
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400
    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Invalid file"}), 400
    # Whitelist accepted extensions — release-check rejects lossy inputs on
    # principle (can't verify a master's true peak from an MP3 accurately).
    name = file.filename.lower()
    if not re.search(r"\.(wav|wave|flac)$", name):
        return jsonify({
            "error": "Release check accepts WAV or FLAC only. "
                     "Lossy formats (MP3/AAC/OGG) can't be accurately verified."
        }), 400

    platform = (request.form.get("platform") or "spotify").lower()
    if platform not in ("spotify", "youtube", "bandcamp"):
        return jsonify({"error": f"Unknown platform: {platform}"}), 400

    # Save upload into the existing master_uploads dir (reusing infra).
    # The file is treated as read-only input; no DSP chain is run.
    uid, fpath = _save_master_upload(file, file.filename)

    try:
        # Load audio and run the same measurements that Post-master
        # verification uses, plus stereo correlation/width.
        y_stereo, _, sr = _ma_load_audio(fpath)
        from master_engine import (
            measure_from_array, build_release_check, analyze_ms_bass,
            analyze_frequency_cutoff,
        )

        meas = measure_from_array(y_stereo, sr)
        lufs = meas.get("lufs")
        peak = meas.get("peak")
        lra = meas.get("lra")

        # Crest factor: peak minus RMS. Compute from mono sum.
        import numpy as np
        y_mono = 0.5 * (y_stereo[0] + y_stereo[1]) if y_stereo.shape[0] == 2 else y_stereo[0]
        rms = 20.0 * np.log10(max(np.sqrt(np.mean(y_mono ** 2)), 1e-9))
        crest = round(float(peak - rms), 1) if peak is not None else None

        # L/R correlation + stereo width (same method as mix_analyzer)
        from mix_analyzer import analyze_stereo
        stereo = analyze_stereo(y_stereo, sr)
        corr = stereo.get("lr_correlation")
        width = stereo.get("stereo_width_db")

        # Mono-bass side percentage (reuse the mastering-page analyzer)
        try:
            mb = analyze_ms_bass(y_stereo, sr)
            side_bass = mb.get("side_bass_pct")
        except Exception:
            side_bass = None

        # Frequency cutoff — upsample sanity check. Operates on mono sum.
        try:
            cutoff = analyze_frequency_cutoff(y_mono, sr)
        except Exception:
            cutoff = None

        # Coerce everything to native Python float/int before building the
        # response — numpy scalars (float32 in particular) are not JSON
        # serializable and round() preserves the numpy type. The _nf() helper
        # takes "None or numeric-ish" and produces None or native float.
        def _nf(v, ndigits=1):
            if v is None: return None
            try:
                return round(float(v), ndigits)
            except (TypeError, ValueError):
                return None

        measurements = {
            "integrated_lufs":  _nf(lufs, 1),
            "true_peak_dbfs":   _nf(peak, 1),
            "lra":              _nf(lra, 1),
            "crest_factor_db":  _nf(crest, 1),
            "lr_correlation":   _nf(corr, 2),
            "stereo_width_db":  _nf(width, 1),
            "side_bass_pct":    _nf(side_bass, 1),
            "frequency_cutoff": cutoff,
        }
        report = build_release_check(measurements, platform)

        return jsonify({
            "filename":         file.filename,
            "duration_seconds": float(y_stereo.shape[1]) / float(sr),
            "sample_rate":      int(sr),
            "measurements":     measurements,
            "report":           report,
        })
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": f"Release check failed: {e}"}), 500
    finally:
        # Clean up — release check is stateless, no need to keep the upload
        try:
            os.remove(fpath)
        except OSError:
            pass


# ----- Upload + analyze (for direct-to-mastering workflow) -----------------

@app.route("/analyze-master", methods=["POST"])
def analyze_for_master():
    """Upload a file, run mix analysis on it, and return the mastering
    proposal + a master_upload_id we use for subsequent preview/export calls."""
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400
    file = request.files["file"]
    if not file.filename or not allowed_file(file.filename):
        return jsonify({"error": "Invalid file type. Use WAV, AIFF, or FLAC."}), 400

    uid, fpath = _save_master_upload(file, file.filename)

    # Tonal mode flag — comes from the form as "true"/"false" or 1/0.
    tonal_mode = str(request.form.get("tonal_mode", "")).lower() in ("true", "1", "yes", "on")

    try:
        report = analyze(fpath, genre="auto")
        proposal = propose_chain(
            report,
            target_lufs=DEFAULT_TARGET_LUFS,
            ceiling_dbfs=DEFAULT_CEILING_DBFS,
            tonal_mode=tonal_mode,
        )
        # Separate M/S bass analysis — needs raw audio, not just the report.
        # Loading the file twice is not ideal but at ~1s it's acceptable;
        # alternative would be to restructure analyze() to return audio.
        ms_bass = None
        ms_air = None
        cutoff_check = None
        try:
            y_stereo, y_mono_tmp, sr = _ma_load_audio(fpath)
            ms_bass = analyze_ms_bass(y_stereo, sr)
            ms_air = analyze_ms_air(y_stereo, sr)
            from master_engine import analyze_frequency_cutoff
            cutoff_check = analyze_frequency_cutoff(y_mono_tmp, sr)
        except Exception:
            # M/S analysis is a nice-to-have; don't fail the whole route if it throws
            ms_bass = None
            ms_air = None
        return jsonify({
            "master_upload_id": uid,
            "filename": file.filename,
            "analysis_summary": {
                "integrated_lufs": report.get("loudness", {}).get("integrated_lufs"),
                "true_peak_dbfs":  report.get("loudness", {}).get("true_peak_dbfs"),
                "crest_factor_db": report.get("loudness", {}).get("crest_factor_db"),
                "loudness_range_lra": report.get("loudness", {}).get("loudness_range_lra"),
                "genre": report.get("genre"),
                "duration_seconds": report.get("duration_seconds"),
                "sample_rate": report.get("sample_rate"),
            },
            "proposal": proposal,
            "ms_bass_check": ms_bass,
            "ms_air_check": ms_air,
            "cutoff_check": cutoff_check,
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        # clean upload on failure
        if os.path.exists(fpath):
            try:
                os.remove(fpath)
            except OSError:
                pass
        return jsonify({"error": str(e)}), 500


# ----- Shortcut: master an already-analyzed report -------------------------

@app.route("/master-from-report/<report_id>", methods=["POST"])
def master_from_report(report_id):
    """Use an existing analyzer report as the starting point for mastering.
    Requires the user to re-upload the source file since /analyze deletes
    uploads — we only kept the report. The file is matched by filename."""
    report_path = os.path.join(app.config["REPORTS_FOLDER"], f"{report_id}_report.json")
    if not os.path.exists(report_path):
        return jsonify({"error": "Report not found"}), 404

    if "file" not in request.files:
        return jsonify({"error": "Re-upload the source audio file"}), 400
    file = request.files["file"]
    if not file.filename or not allowed_file(file.filename):
        return jsonify({"error": "Invalid file type"}), 400

    with open(report_path) as fh:
        report = json.load(fh)

    # Sanity check: filename should roughly match what was analyzed
    orig = (report.get("file", "") or "").replace("\\", "/").split("/")[-1]
    orig_clean = re.sub(r"^[a-f0-9_-]+_", "", orig)
    if file.filename and orig_clean and os.path.splitext(file.filename)[0] not in orig_clean:
        # Not a hard fail — just a warning in the response
        mismatch = True
    else:
        mismatch = False

    uid, fpath = _save_master_upload(file, file.filename)
    tonal_mode = str(request.form.get("tonal_mode", "")).lower() in ("true", "1", "yes", "on")
    try:
        proposal = propose_chain(
            report,
            target_lufs=DEFAULT_TARGET_LUFS,
            ceiling_dbfs=DEFAULT_CEILING_DBFS,
            tonal_mode=tonal_mode,
        )
        return jsonify({
            "master_upload_id": uid,
            "filename": file.filename,
            "source_report_id": report_id,
            "filename_mismatch_warning": mismatch,
            "analysis_summary": {
                "integrated_lufs": report.get("loudness", {}).get("integrated_lufs"),
                "true_peak_dbfs":  report.get("loudness", {}).get("true_peak_dbfs"),
                "crest_factor_db": report.get("loudness", {}).get("crest_factor_db"),
                "loudness_range_lra": report.get("loudness", {}).get("loudness_range_lra"),
                "genre": report.get("genre"),
                "duration_seconds": report.get("duration_seconds"),
                "sample_rate": report.get("sample_rate"),
            },
            "proposal": proposal,
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        if os.path.exists(fpath):
            try:
                os.remove(fpath)
            except OSError:
                pass
        return jsonify({"error": str(e)}), 500


# ----- Preview render ------------------------------------------------------

@app.route("/preview-master", methods=["POST"])
def preview_master():
    """Render the chain against a master-upload file and return a WAV blob.
    Request body: JSON with keys: master_upload_id, chain_config."""
    data = request.get_json(silent=True) or {}
    uid = data.get("master_upload_id")
    chain_config = data.get("chain_config")
    if not uid or not chain_config:
        return jsonify({"error": "master_upload_id and chain_config required"}), 400

    src_path = _lookup_master_upload(uid)
    if not src_path:
        return jsonify({"error": "Upload not found — try re-uploading"}), 404

    try:
        y_stereo, _, sr = _ma_load_audio(src_path)
        mastered, stats = run_chain(y_stereo, sr, chain_config)
        meas = measure_master(
            mastered, sr,
            target_lufs=chain_config.get("target_lufs", DEFAULT_TARGET_LUFS),
            ceiling_dbfs=(chain_config.get("limiter") or {}).get("ceiling_dbfs", DEFAULT_CEILING_DBFS),
        )

        # Write preview to temp file (16-bit PCM for fastest browser load)
        preview_name = f"preview_{uid}_{uuid.uuid4().hex[:6]}.wav"
        preview_path = os.path.join(app.config["MASTER_UPLOADS"], preview_name)
        render_to_wav(mastered, sr, preview_path, bit_depth=16)

        # Return URL + stats as JSON; client will fetch the audio URL separately.
        # We keep the preview file around briefly — TTL cleanup removes it.
        return jsonify({
            "preview_url": f"/master-audio/{preview_name}",
            "source_url":  f"/master-audio/{os.path.basename(src_path)}",
            "stats": stats,
            "measurement": meas,
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ----- Serve audio files (source + previews) -------------------------------

@app.route("/master-audio/<path:fname>")
def master_audio(fname):
    """Stream audio files from the master uploads dir (source + previews)."""
    # Prevent path traversal
    safe = secure_filename(fname)
    if safe != fname:
        return "forbidden", 403
    path = os.path.join(app.config["MASTER_UPLOADS"], safe)
    if not os.path.exists(path):
        return "not found", 404
    return send_from_directory(app.config["MASTER_UPLOADS"], safe,
                               conditional=True, mimetype="audio/wav")


# ----- Final export: WAV 24-bit + MP3 320, zipped -------------------------

@app.route("/export-master", methods=["POST"])
def export_master():
    """Render and return ONE mastered audio file directly (raw WAV or MP3).

    The client is expected to make one POST per format it wants — this keeps
    downloads as raw audio files rather than forcing a zip container around
    a single file. The master report JSON is persisted server-side for the
    history panel, but not included in the download response.

    Request body:
      {
        "master_upload_id": str,
        "chain_config": {...},
        "source_filename": str,
        "format": "wav24",   # only format supported (WAV 16 + MP3 removed)
        "persist_report": bool (optional, default true)
      }
    """
    data = request.get_json(silent=True) or {}
    uid = data.get("master_upload_id")
    chain_config = data.get("chain_config")
    source_filename = data.get("source_filename", "mix.wav")
    fmt = data.get("format", "wav24")
    persist_report = data.get("persist_report", True)
    # Optional user metadata (Title/Artist/Album/Track/Year/Genre).
    # All fields optional; anything missing or empty is simply not written.
    metadata = data.get("metadata") or {}
    if not uid or not chain_config:
        return jsonify({"error": "master_upload_id and chain_config required"}), 400
    # Only WAV 24-bit export is supported. WAV 16 and MP3 were removed since
    # the user only ships lossless. Accept legacy "wav16"/"mp3_320" values by
    # falling through to wav24 rather than erroring — keeps any cached
    # frontend state from breaking.
    if fmt not in ("wav24", "wav16", "mp3_320"):
        return jsonify({"error": f"Unknown format: {fmt}"}), 400
    fmt = "wav24"

    src_path = _lookup_master_upload(uid)
    if not src_path:
        return jsonify({"error": "Upload not found — try re-uploading"}), 404

    try:
        y_stereo, _, sr = _ma_load_audio(src_path)
        mastered, stats = run_chain(y_stereo, sr, chain_config)
        meas = measure_master(
            mastered, sr,
            target_lufs=chain_config.get("target_lufs", DEFAULT_TARGET_LUFS),
            ceiling_dbfs=(chain_config.get("limiter") or {}).get("ceiling_dbfs", DEFAULT_CEILING_DBFS),
        )

        base = os.path.splitext(os.path.basename(source_filename))[0]
        base = re.sub(r"[^a-zA-Z0-9_-]", "_", base)[:60] or "master"

        # Render WAV 24-bit (the only supported output)
        tmp_dir = os.path.join(app.config["MASTER_UPLOADS"], f"export_{uid}_{uuid.uuid4().hex[:6]}")
        os.makedirs(tmp_dir, exist_ok=True)
        out_path = os.path.join(tmp_dir, f"{base}_mastered_24bit.wav")
        render_to_wav(mastered, sr, out_path, bit_depth=24)
        mimetype = "audio/wav"

        # Apply user metadata tags to the rendered file. This is best-effort:
        # if tagging fails (permissions, malformed input, etc.) the export
        # continues with an untagged file. embed_metadata returns False and
        # logs to stderr in that case — no exception propagates.
        if metadata:
            embed_metadata(out_path, metadata)

        # Persist master report (only for the first format of a multi-format
        # export — client passes persist_report=false on subsequent ones)
        if persist_report:
            master_uid = str(uuid.uuid4())[:8]
            master_report = {
                "master_report_id": master_uid,
                "source_filename":  source_filename,
                "sample_rate":      sr,
                "created_at":       time.time(),
                "chain_config":     chain_config,
                "stats":            stats,
                "measurement":      meas,
                "formats_exported": [os.path.basename(out_path)],
                "metadata":         metadata or {},
            }
            mr_path = os.path.join(app.config["MASTER_REPORTS"], f"{master_uid}_master_report.json")
            with open(mr_path, "w") as fh:
                json.dump(master_report, fh, indent=2, default=_json_default)

        # Read the file into memory so we can clean up the temp dir, then
        # stream the bytes back as a download.
        with open(out_path, "rb") as fh:
            payload = fh.read()
        try:
            os.remove(out_path)
            os.rmdir(tmp_dir)
        except OSError:
            pass

        from flask import send_file
        import io
        return send_file(
            io.BytesIO(payload),
            mimetype=mimetype,
            as_attachment=True,
            download_name=os.path.basename(out_path),
        )

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ----- Master history ------------------------------------------------------

@app.route("/master-history")
def get_master_history():
    """Return list of recent master reports."""
    import glob
    folder = app.config["MASTER_REPORTS"]
    files = glob.glob(os.path.join(folder, "*_master_report.json"))
    files.sort(key=os.path.getmtime, reverse=True)
    out = []
    for f in files[:20]:
        try:
            with open(f) as fh:
                r = json.load(fh)
            fname = (r.get("source_filename", "") or "").replace("\\", "/").split("/")[-1]
            m = r.get("measurement", {}) or {}
            out.append({
                "master_report_id": r.get("master_report_id", ""),
                "source_filename":  fname,
                "integrated_lufs":  m.get("integrated_lufs"),
                "true_peak_dbfs":   m.get("true_peak_dbfs"),
                "mtime":            os.path.getmtime(f),
                "formats":          r.get("formats_exported", []),
            })
        except Exception:
            pass
    return jsonify(out)


@app.route("/master-report/<report_id>")
def get_master_report(report_id):
    path = os.path.join(app.config["MASTER_REPORTS"], f"{report_id}_master_report.json")
    if not os.path.exists(path):
        return jsonify({"error": "Report not found"}), 404
    with open(path) as fh:
        return jsonify(json.load(fh))


@app.route("/master-report/<report_id>", methods=["DELETE"])
def delete_master_report(report_id):
    path = os.path.join(app.config["MASTER_REPORTS"], f"{report_id}_master_report.json")
    if os.path.exists(path):
        try:
            os.remove(path)
            return jsonify({"ok": True})
        except OSError as e:
            return jsonify({"error": str(e)}), 500
    return jsonify({"error": "Report not found"}), 404


# ---------------------------------------------------------------------------
# Reference-match routes
# ---------------------------------------------------------------------------
# Flow:
#   POST /upload-reference        (multipart: file + master_upload_id)
#       -> saves ref file, measures its spectrum, returns proposal bells
#           that would move the mix toward the reference
#   DELETE /reference/<master_upload_id>
#       -> forgets the reference association for a master upload
#   GET /eq-curve?bells=...        (query JSON of bells)
#       -> returns the total EQ response for UI visualization
#
# The reference file lives in master_uploads under a distinct prefix so
# TTL cleanup handles it the same way as other uploads.

# Purist mode: only lossless containers for the reference
REF_ALLOWED_EXTENSIONS = {"wav", "wave", "aiff", "aif", "flac"}

def _ref_allowed(filename):
    if "." not in filename:
        return False
    return filename.rsplit(".", 1)[1].lower() in REF_ALLOWED_EXTENSIONS


@app.route("/upload-reference", methods=["POST"])
def upload_reference():
    """Upload a reference track for matching against a previously-uploaded mix.
    Returns the proposed bell EQ moves."""
    master_upload_id = request.form.get("master_upload_id")
    if not master_upload_id:
        return jsonify({"error": "master_upload_id required"}), 400

    if "file" not in request.files:
        return jsonify({"error": "No reference file uploaded"}), 400
    ref = request.files["file"]
    if not ref.filename:
        return jsonify({"error": "No filename"}), 400
    if not _ref_allowed(ref.filename):
        ext = ref.filename.rsplit(".", 1)[-1] if "." in ref.filename else "?"
        return jsonify({
            "error": f"Unsupported reference file type (.{ext}). "
                     f"Use WAV, AIFF, or FLAC only — lossy formats (MP3) are "
                     f"rejected for spectrum-matching accuracy."
        }), 400

    # Verify master upload exists
    mix_path = _lookup_master_upload(master_upload_id)
    if not mix_path:
        return jsonify({
            "error": "Source mix upload not found or expired — re-upload the mix first"
        }), 404

    # Save reference under a prefix tied to the mix's upload id
    _cleanup_master_uploads()
    safe = secure_filename(ref.filename)
    ref_fname = f"ref_{master_upload_id}_{safe}"
    ref_path = os.path.join(app.config["MASTER_UPLOADS"], ref_fname)
    ref.save(ref_path)

    try:
        # Measure reference spectrum
        ref_meas = measure_reference_spectrum(ref_path)

        # Load the mix analysis report from disk (cached by the analyze step)
        # ... or recompute if not cached. Simplest: recompute (fast for stereo).
        mix_report = analyze(mix_path, genre="auto")

        # Correction ratio can be overridden via form field (default 0.5 = half)
        try:
            corr_ratio = float(request.form.get("correction_ratio", 0.5))
            corr_ratio = max(0.0, min(1.0, corr_ratio))
        except (TypeError, ValueError):
            corr_ratio = 0.5

        proposal = propose_reference_match(mix_report, ref_meas,
                                           correction_ratio=corr_ratio)
        return jsonify({
            "master_upload_id": master_upload_id,
            "reference_filename": ref.filename,
            "reference_measurement": ref_meas,
            "proposal": proposal,
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        # Don't keep the reference file if analysis failed
        try:
            os.remove(ref_path)
        except OSError:
            pass
        return jsonify({"error": str(e)}), 500


@app.route("/eq-curve", methods=["POST"])
def eq_curve():
    """Compute total EQ curve for a set of bells. Used by UI visualization."""
    data = request.get_json(silent=True) or {}
    bells = data.get("bells", [])
    sr = int(data.get("sample_rate", 48000))
    n_points = int(data.get("n_points", 200))
    try:
        freqs, mag = compute_eq_response(bells, sr, n_points=n_points)
        return jsonify({
            "freqs_hz":       [round(float(f), 2) for f in freqs.tolist()],
            "magnitude_db":   [round(float(m), 3) for m in mag.tolist()],
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/genre-eq-proposal", methods=["POST"])
def genre_eq_proposal():
    """Return a 6-bell EQ proposal for the 6-band EQ card.

    Request body:
      {
        "master_upload_id": str,
        "correction_ratio": float (default 0.5, clamped 0-1)
      }
    The analysis is recomputed from the source mix — same cheap analyze() call
    the ref-match route uses — so the bells reflect current mix deltas.

    Returns a bell/config/comparison shape identical to /upload-reference's
    proposal so the frontend can render with shared code.

    Note: the legacy 'mode' field is silently ignored for backward compatibility
    with any stored payload. The Suggested / Manual toggle was removed — the
    single-mode proposal (suggested, with editable correction ratio) replaces it.
    """
    data = request.get_json(silent=True) or {}
    uid = data.get("master_upload_id")
    try:
        corr_ratio = float(data.get("correction_ratio", 0.5))
        corr_ratio = max(0.0, min(1.0, corr_ratio))
    except (TypeError, ValueError):
        corr_ratio = 0.5

    if not uid:
        return jsonify({"error": "master_upload_id required"}), 400

    mix_path = _lookup_master_upload(uid)
    if not mix_path:
        return jsonify({
            "error": "Source mix upload not found or expired — re-upload the mix first"
        }), 404

    try:
        mix_report = analyze(mix_path, genre="auto")
        proposal = propose_genre_match(mix_report, correction_ratio=corr_ratio)
        return jsonify({
            "master_upload_id": uid,
            "genre":            mix_report.get("genre_detection", {}).get("detected"),
            "proposal":         proposal,
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# =============================================================================
# END MASTERING
# =============================================================================


if __name__ == "__main__":
    os.makedirs("uploads", exist_ok=True)
    os.makedirs("reports", exist_ok=True)
    os.makedirs("master_uploads", exist_ok=True)
    os.makedirs("master_reports", exist_ok=True)
    key_status = "found in environment" if os.environ.get("ANTHROPIC_API_KEY") else "not set"
    print(f"\n  Anvil Audio Lab running at http://localhost:5000")
    print(f"  ANTHROPIC_API_KEY: {key_status}\n")
    app.run(debug=True, port=5000)
