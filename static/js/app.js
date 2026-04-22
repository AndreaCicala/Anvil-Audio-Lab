/* app.js — Anvil Audio Lab frontend (mix analysis page) */

const BAND_LABELS = { sub: "Sub", bass: "Bass", low_mid: "Low mid", mid: "Mid", presence: "Presence", air: "Air" };


const GENRE_NAMES = {
  postrock:     "Post-Rock",
  progrock:     "Prog Rock",
  metal:        "Metal",
  instrumental: "Instrumental",
  rock:         "Rock",
  pop:          "Pop",
  electronic:   "Electronic",
  hiphop:       "Hip-Hop",
  jazz:         "Jazz",
  classical:    "Classical",
  unknown:      "Unknown",
  auto:         "Auto-detect",
};

function genreLabel(key) {
  return GENRE_NAMES[key] || key.toUpperCase();
}

/* Warning → fix-suggestion map. Matched by substring (case-insensitive) for
   robustness against small wording changes. First match wins. */
const WARNING_FIXES = [
  // Loudness
  { match: "true peak exceeds",
    fix: "Reduce the master bus gain by 1–2 dB, or insert a true-peak limiter (e.g. Cubase Limiter, ceiling −1 dBFS) before the bounce." },
  { match: "very loud (over-compressed)",
    fix: "Ease the output limiter / master compressor. Aim for −14 LUFS integrated for streaming. Current master will be loudness-normalized down anyway, losing dynamics with no volume benefit." },
  { match: "quiet — but wide dynamic range is normal",
    fix: "This is genre-appropriate. No action needed unless you want a club-ready version — in which case parallel compression on the master bus or a secondary loud master is the usual approach." },
  { match: "quiet for modern releases",
    fix: "Add a master-bus limiter (Cubase Limiter or Brickwall Limiter) with ceiling −1 dBFS. Pull threshold down in 0.5 dB steps until integrated LUFS reads −14." },
  { match: "low crest factor",
    fix: "Compression is too aggressive on the master bus or individual tracks. Reduce ratio or raise threshold on the heaviest compressors. Transients should survive to the master." },
  { match: "very high crest factor",
    fix: "Mix is peak-heavy and dynamically wide. Use gentle bus compression (2:1 ratio, slow attack ~30 ms, release ~100 ms) on the drum bus or master to tame transients." },

  // Spectrum
  { match: "sub-bass is heavy",
    fix: "High-pass filter at 25–30 Hz on the master bus. If bass guitar or kick are the culprit, notch 2–3 dB at 40–60 Hz on those channels with Frequency EQ." },
  { match: "both sub and bass are elevated",
    fix: "Low-end pileup. Decide which element owns sub (usually kick) and which owns bass (usually bass guitar). High-pass the other element's low extension to clear the conflict." },
  { match: "low-mids are prominent",
    fix: "Cut 2–4 dB around 300–500 Hz on the dominant element (usually rhythm guitars or keys). Use a wide bell Q (~0.8–1.2) in Frequency EQ." },
  { match: "mids are scooped",
    fix: "Gentle 1–2 dB shelf boost between 800 Hz–1.5 kHz on the master bus, or boost the same range on vocals/lead instrument. Avoid narrow-Q boosts here." },
  { match: "presence range is low",
    fix: "Boost 3–5 kHz by 1–3 dB on the main lead element (vocals, lead guitar) or on the master bus with a wide bell. Check for harshness before committing." },
  { match: "high-frequency air is boosted",
    fix: "High-shelf cut above 10 kHz on the master bus (−1 to −2 dB). If cymbals are the source, de-esser or dynamic EQ on the drum bus works better than static cut." },
  { match: "spectral tilt is bright",
    fix: "The mix leans high-frequency. High-shelf cut above 8 kHz (1–2 dB) on the master bus, or reduce cymbal/hi-hat levels 1–2 dB. Compare against a reference track." },
  { match: "spectral tilt is dark",
    fix: "The mix is low-end heavy. High-shelf boost above 8 kHz (1–2 dB) on the master bus, or check that no low-pass filter is engaged on key elements." },

  // Stereo
  { match: "low l/r correlation",
    fix: "Phase issues likely. Check for wide stereo widening plugins, out-of-phase mic pairs, or mono elements panned too wide. Narrow the stereo image on problem channels." },
  { match: "negative correlation",
    fix: "Severe phase cancellation — mix will partially disappear in mono. Identify the channel causing it (mute and check): often reverse-polarity samples or widened mono sources. Flip polarity or remove widening." },
  { match: "stereo field is very wide",
    fix: "Check your stereo wideners and M/S processing. Widening above 100% often causes mono collapse. Narrow the widest elements or add a mono-below-120Hz plugin on the master." },
  { match: "mix is very narrow",
    fix: "Pan instruments more aggressively. Common moves: hi-hat 30% right, rhythm guitars hard-panned L/R, synth pads 70% spread. Avoid mono-ing elements unnecessarily." },
  { match: "significant level drop in mono",
    fix: "Your stereo widening is too aggressive. Remove or narrow widening plugins. Aim for a mono-delta under 3 dB — the mix should remain recognizable in mono." },

  // Dynamics
  { match: "very high transient density",
    fix: "Too many hits per second — feels cluttered. Thin out busy sections (fewer hats, sparser percussion), or sidechain non-essential elements to main hits." },
  { match: "low dynamic range",
    fix: "Over-compressed. Pull back bus/master compression. For prog/rock, aim for 6–10 dB of RMS dynamic range. Automation-riding quiet parts up is better than compression." },
  { match: "mix is crushed",
    fix: "Pull back master-bus limiting heavily. Remove the limiter entirely and use automation or lighter compression instead. A crushed mix can't be unsquashed at mastering." },
  { match: "very high dynamic range",
    fix: "Likely silence or fade-outs pulling the average down. If intentional (ambient intro / outro), ignore. Otherwise, check for very quiet sections that need volume automation." },
  { match: "less than 1 db headroom",
    fix: "Peaks are at the ceiling — lossy encoders (Spotify OGG, YouTube AAC) will likely generate inter-sample clipping. Raise the master limiter threshold by 1–2 dB to get back into the 3–6 dB sweet spot." },
  { match: "very little headroom",
    fix: "Peak limiting is aggressive. Raise the master limiter threshold by 1–2 dB. 3–6 dB is the documented ideal for a pre-master; anything below 1 dB risks inter-sample clipping." },
  { match: "generous headroom",
    fix: "Unmastered state. Fine if you're sending to a mastering engineer. If this is your final master, add a limiter — ceiling −1 dBFS, threshold set for −14 LUFS." },
  { match: "genuinely cluttered",
    fix: "Very dense rhythmic content — double-check the arrangement. Consider pulling a layer back (sidechain ducking on secondary elements, or mute A/B to see which parts survive a subtractive mix)." },

  // Per-band crest
  { match: "transients (likely kick) may need taming",
    fix: "Add a transient shaper or gentle compressor on the kick/bass bus. Fast attack (~10 ms), 3:1 ratio, 2–3 dB of gain reduction on hits. Or use Cubase's Envelope Shaper to pull down attack phase." },
  { match: "lacks glue. consider gentle bus compression",
    fix: "Add a bus compressor on vocals/lead group. Slow attack (~30 ms), medium release, 2:1 ratio, threshold set for 2–3 dB gain reduction on loudest moments. Cubase Stock Compressor or Tube Compressor both work." },
  { match: "over-compressed",
    fix: "Reduce compression on the main lead element. Raise threshold or lower ratio on the channel compressor. A good target is 4–6 dB of gain reduction on peaks, not 10+." },

  // Narrow resonances
  { match: "narrow resonance around",
    fix: "Open Frequency EQ on the offending channel, add a narrow-Q bell cut (Q ≈ 1.5–2.0) at the specific frequency mentioned. Start with 3–4 dB of cut; A/B against solo to verify the ringing/boxy character is reduced." },
];

function findWarningFix(warningText) {
  if (!warningText) return null;
  const lower = warningText.toLowerCase();
  for (const { match, fix } of WARNING_FIXES) {
    if (lower.includes(match.toLowerCase())) return fix;
  }
  return null;
}


/* ── State ── */
let selectedGenre = "auto";
let selectedFile  = null;
let refFile       = null;

/* ── DOM refs ── */
const dropZone      = document.getElementById("drop-zone");
const fileInput     = document.getElementById("file-input");
const refInput      = document.getElementById("ref-input");
const refLabel      = document.getElementById("ref-label");
const fileInfo      = document.getElementById("file-info");
const fileNameDisp  = document.getElementById("file-name-display");
const btnAnalyze    = document.getElementById("btn-analyze");
const btnReset      = document.getElementById("btn-reset");
const uploadPanel   = document.getElementById("upload-panel");
const progressPanel = document.getElementById("progress-panel");
const progressFill  = document.getElementById("progress-fill");
const progressLabel = document.getElementById("progress-label");
const resultsPanel  = document.getElementById("results-panel");

/* ── Genre pills ── */
document.getElementById("genre-pills").addEventListener("click", e => {
  const pill = e.target.closest(".pill");
  if (!pill) return;
  document.querySelectorAll(".pill").forEach(p => p.classList.remove("active"));
  pill.classList.add("active");
  selectedGenre = pill.dataset.genre;
});

/* ── File selection ── */
fileInput.addEventListener("change", () => setFile(fileInput.files[0]));
refInput.addEventListener("change", () => setRef(refInput.files[0]));

function setFile(file) {
  if (!file) return;
  selectedFile = file;
  fileNameDisp.textContent = file.name;
  fileInfo.classList.remove("hidden");
}

function setRef(file) {
  if (!file) return;
  refFile = file;
  refLabel.textContent = "✓ " + file.name;
  refLabel.classList.add("has-file");
}

/* ── Drag & drop ── */
dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", e => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const f = e.dataTransfer.files[0];
  if (f) setFile(f);
});
// Click-to-pick via AnvilPicker for sticky-folder anchoring on Chrome/Edge.
// Firefox and other browsers fall back to the hidden <input type="file">.
// We don't fire the picker when the click originated on a <label> child
// because labels have their own native file-input triggering behavior
// (e.g. the "+ Add reference" label uses for=ref-input).
dropZone.addEventListener("click", async e => {
  if (e.target.tagName === "LABEL") return;
  const file = await window.AnvilPicker.pick({
    scope:           "mix-source",
    accept:          { "audio/*": [".wav", ".flac", ".aiff", ".aif", ".mp3"] },
    fallbackStartIn: "music",
    inputElement:    fileInput,
  });
  if (file) setFile(file);
});

/* ── Analyze ── */
btnAnalyze.addEventListener("click", runAnalysis);

async function runAnalysis() {
  if (!selectedFile) return;

  uploadPanel.classList.add("hidden");
  resultsPanel.classList.add("hidden");
  progressPanel.classList.remove("hidden");

  const steps = [
    [15, "Loading audio file…"],
    [35, "Measuring loudness & dynamics…"],
    [55, "Analyzing spectral balance…"],
    [72, "Checking stereo image…"],
    [88, "Computing phase correlation…"],
    [96, "Building report…"],
  ];

  let stepIdx = 0;
  const progressTimer = setInterval(() => {
    if (stepIdx < steps.length) {
      const [pct, label] = steps[stepIdx++];
      progressFill.style.width = pct + "%";
      progressLabel.textContent = label;
    }
  }, 600);

  const form = new FormData();
  form.append("file", selectedFile);
  form.append("genre", selectedGenre);
  if (refFile) form.append("reference", refFile);

  try {
    const res  = await fetch("/analyze", { method: "POST", body: form });
    const data = await res.json();

    clearInterval(progressTimer);

    if (!res.ok || data.error) {
      progressFill.style.width = "100%";
      progressFill.style.background = "var(--danger)";
      progressLabel.textContent = "Error: " + (data.error || "Analysis failed. Check the server console.");
      setTimeout(() => {
        progressPanel.classList.add("hidden");
        progressFill.style.background = "";
        uploadPanel.classList.remove("hidden");
      }, 3000);
      return;
    }

    progressFill.style.width = "100%";
    progressLabel.textContent = "Done!";

    setTimeout(() => {
      progressPanel.classList.add("hidden");
      renderResults(data);
      resultsPanel.classList.remove("hidden");
    }, 400);

  } catch (err) {
    clearInterval(progressTimer);
    progressLabel.textContent = "Error: " + err.message;
    setTimeout(() => {
      progressPanel.classList.add("hidden");
      uploadPanel.classList.remove("hidden");
    }, 3000);
  }
}

/* ── Reset ── */
btnReset.addEventListener("click", () => {
  selectedFile = null; refFile = null;
  fileInput.value = ""; refInput.value = "";
  refLabel.textContent = "+ Add reference";
  refLabel.classList.remove("has-file");
  fileInfo.classList.add("hidden");
  resultsPanel.classList.add("hidden");
  uploadPanel.classList.remove("hidden");
  currentReportId = null;
  window._currentReport = null;
  try { sessionStorage.removeItem("mix_analyzer_report"); } catch(e) {}
  document.getElementById("ai-results").classList.add("hidden");
  document.getElementById("ai-loading").classList.add("hidden");
  document.getElementById("ai-key-row").style.display = "";
  document.getElementById("ai-key-row").style.opacity = "1";
  document.getElementById("ai-badge").style.display = "none";
  document.getElementById("btn-get-advice").disabled = false;
  progressFill.style.width = "0%";
});

/* ── Render results ── */
function renderResults(r) {
  /* Sync genre pill to detected/used genre */
  const displayGenre = r.genre || (r.genre_detection && r.genre_detection.detected) || "auto";
  document.querySelectorAll(".pill").forEach(p => p.classList.remove("active"));
  const match = document.querySelector(`.pill[data-genre="${displayGenre}"]`);
  if (match) { match.classList.add("active"); selectedGenre = displayGenre; }
  else {
    // Fallback to auto pill
    const autoPill = document.querySelector('.pill[data-genre="auto"]');
    if (autoPill) autoPill.classList.add("active");
  }

  /* Store report for AI advice + session persistence */
  currentReportId = r.report_id || null;
  window._currentReport = r;
  try { sessionStorage.setItem("mix_analyzer_report", JSON.stringify(r)); } catch(e) {}

  /* Header */
  const fname = (r.file || "").replace(/\\/g, "/").split("/").pop().replace(/^[a-f0-9_-]+_/, "");
  document.getElementById("results-filename").textContent = fname;
  document.getElementById("results-meta").innerHTML =
    (() => {
    let genreStr = genreLabel(r.genre);
    if (r.genre_detection && r.genre_detection.detected) {
      const det = r.genre_detection;
      const top3 = det.top3.map(([g, s]) => `${genreLabel(g)} ${s.toFixed(1)}`).join(" · ");
      if (r.genre === det.detected) {
        genreStr += ` <span style="font-size:10px;color:var(--accent2);opacity:0.8">(auto)</span>`;
      }
      window._genreScores = det.top3;
    }
    return `${genreStr} · ${formatDuration(r.duration_seconds)} · ${(r.sample_rate / 1000).toFixed(1)} kHz`;
  })();

  /* Timeline — defer to next frame so canvas has correct layout dimensions */
  _resetTimelineZoom();
  requestAnimationFrame(() => renderTimeline(r));

  /* Bind tooltips to meter cards */
  bindTooltip("meter-lufs",  "meter-lufs");
  bindTooltip("meter-peak",  "meter-peak");
  bindTooltip("meter-crest", "meter-crest");
  bindTooltip("meter-corr",  "meter-corr");
  bindTooltip("meter-width", "meter-width");

  /* Issue banner */
  const n = r.summary.total_issues;
  const banner = document.getElementById("issue-banner");
  if (n === 0) {
    banner.className = "issue-banner none";
    banner.textContent = "✓ No issues detected — mix looks clean.";
  } else if (n <= 4) {
    banner.className = "issue-banner few";
    banner.textContent = `⚠ ${n} issue${n > 1 ? "s" : ""} detected — see details below.`;
  } else {
    banner.className = "issue-banner many";
    banner.textContent = `✕ ${n} issues detected — this mix needs attention.`;
  }

  /* Mix version banner (auto-match previous version by filename) */
  renderMixVersionBanner(r);

  /* Meter strip */
  const L = r.loudness;
  setMeter("meter-lufs",  L.integrated_lufs,
    v => v >= -16 && v <= -9 ? "ok" : v > -9 ? "danger" : "warn",
    v => v + " LUFS");
  setMeter("meter-peak",  L.true_peak_dbfs,
    v => v <= -0.5 ? "ok" : "danger",
    v => v + " dB");
  setMeter("meter-crest", L.crest_factor_db,
    v => v >= 8 && v <= 18 ? "ok" : v < 6 ? "danger" : "warn",
    v => v + " dB");
  setMeter("meter-corr",  r.stereo.lr_correlation,
    v => v >= 0.6 ? "ok" : v >= 0.3 ? "warn" : "danger",
    v => v.toFixed(2));
  setMeter("meter-width", r.stereo.mid_side_ratio_db,
    v => Math.abs(v) < 8 ? "ok" : v > 8 ? "warn" : "warn",
    v => v + " dB");

  /* Spectrum chart */
  renderSpectrum(r.spectrum);

  /* Dynamics */
  renderDynamics(r.loudness, r.dynamics);

  /* Stereo */
  renderStereo(r.stereo);

  /* Frequency cutoff — may be null if analysis couldn't run */
  renderCutoffCheck(r.frequency_cutoff);

  /* Warnings */
  const list = document.getElementById("warnings-list");
  list.innerHTML = "";
  const allW = r.summary.warnings;
  if (allW.length === 0) {
    list.innerHTML = '<li class="warning-item"><span style="color:var(--ok)">No issues detected.</span></li>';
  } else {
    allW.forEach((w, i) => {
      const severity = i < 2 ? "w-danger" : i < 5 ? "w-warn" : "w-info";
      const fix = findWarningFix(w);
      const hasFix = !!fix;
      list.innerHTML += `
        <li class="warning-item ${severity}" ${hasFix ? `data-fix="${fix.replace(/"/g, "&quot;")}" data-severity="${severity}" style="cursor:help"` : ""}>
          <span class="warning-dot"></span>
          <span>${w}</span>
          ${hasFix ? `<span style="margin-left:6px;font-size:10px;color:var(--muted);opacity:0.6">ⓘ</span>` : ""}
        </li>`;
    });
    // Attach tooltip handlers
    list.querySelectorAll(".warning-item[data-fix]").forEach(li => {
      const fix = li.getAttribute("data-fix");
      const sev = li.getAttribute("data-severity");
      const sevColor = sev === "w-danger" ? "var(--danger)" : sev === "w-warn" ? "var(--warn)" : "var(--accent2)";
      const sevBg    = sev === "w-danger" ? "rgba(255,95,87,0.08)" : sev === "w-warn" ? "rgba(245,166,35,0.08)" : "rgba(123,97,255,0.08)";
      li.addEventListener("mouseenter", e => {
        tooltipEl.innerHTML = `
          <div style="font-family:var(--font-head);font-size:12px;font-weight:600;color:var(--color-text-primary);margin-bottom:6px;letter-spacing:0.04em">HOW TO FIX</div>
          <div style="font-size:11px;padding:8px 10px;background:${sevBg};border-radius:6px;color:${sevColor};line-height:1.6;border-left:2px solid ${sevColor}">${fix}</div>`;
        tooltipEl.style.opacity = "1";
        positionTooltip(e);
      });
      li.addEventListener("mousemove", e => positionTooltip(e));
      li.addEventListener("mouseleave", () => { tooltipEl.style.opacity = "0"; });
    });
  }

  /* Sections */
  renderSections(r.sections);

  /* Reference */
  if (r.reference_comparison) {
    renderReference(r.reference_comparison);
  } else {
    const card = document.getElementById("ref-card");
    if (card) card.classList.add("hidden");
    document.querySelectorAll(".meter-ref-badge").forEach(el => el.remove());
    document.querySelectorAll(".bar-ref").forEach(el => el.remove());
    const ld = document.getElementById("spectrum-legend-ref");
    const ll = document.getElementById("spectrum-legend-ref-label");
    if (ld) ld.style.display = "none";
    if (ll) ll.style.display = "none";
  }

  /* Action summary — prioritized fix list at the bottom */
  renderActionSummary(r.action_summary);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Action summary renderer — shared between main analyzer and stems page
   Three tiers: fix_before_bounce / worth_fixing / polish
   ═══════════════════════════════════════════════════════════════════════════ */
function renderActionSummary(summary) {
  const card = document.getElementById("action-summary-card");
  if (!card) return;
  if (!summary || summary.total_actions === 0) {
    card.style.display = "none";
    return;
  }
  card.style.display = "";

  const tierMeta = {
    fix_before_bounce: {
      label:     "Fix before bounce",
      desc:      "Ship-blockers — issues that will affect playback quality or streaming delivery.",
      color:     "var(--danger)",
      bg:        "rgba(255,95,87,0.05)",
      border:    "rgba(255,95,87,0.25)",
      dotBg:     "rgba(255,95,87,0.18)",
    },
    worth_fixing: {
      label:     "Worth fixing",
      desc:      "Clear tonal or level problems most listeners will notice.",
      color:     "var(--warn)",
      bg:        "rgba(245,166,35,0.04)",
      border:    "rgba(245,166,35,0.22)",
      dotBg:     "rgba(245,166,35,0.18)",
    },
    polish: {
      label:     "Polish",
      desc:      "Refinements that make the mix better but aren't mix-breakers.",
      color:     "var(--accent2)",
      bg:        "rgba(123,97,255,0.04)",
      border:    "rgba(123,97,255,0.2)",
      dotBg:     "rgba(123,97,255,0.15)",
    },
  };

  const tiers = ["fix_before_bounce", "worth_fixing", "polish"];
  const counts = tiers.map(t => (summary[t] || []).length);
  const totalHeader = counts.map((c, i) => c > 0 ? `${c} ${tierMeta[tiers[i]].label.toLowerCase()}` : null)
                            .filter(Boolean).join(" · ");

  let html = `
    <div class="section-head">
      <span class="section-title">Action summary</span>
      <span style="font-size:11px;color:var(--muted)">${summary.total_actions} action${summary.total_actions === 1 ? "" : "s"}</span>
    </div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:14px;line-height:1.5">
      ${totalHeader}
    </div>
  `;

  for (const tierKey of tiers) {
    const items = summary[tierKey] || [];
    if (!items.length) continue;
    const meta = tierMeta[tierKey];
    html += `
      <div style="margin-bottom:20px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <span style="width:8px;height:8px;border-radius:50%;background:${meta.color}"></span>
          <span style="font-family:var(--font-head);font-size:12px;font-weight:700;color:${meta.color};letter-spacing:0.06em;text-transform:uppercase">${meta.label}</span>
          <span style="font-size:11px;color:var(--muted)">(${items.length})</span>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:10px;line-height:1.5">${meta.desc}</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${items.map((it, idx) => {
            const itemId = `action-${tierKey}-${idx}`;
            const loc = it.location ? `<span style="font-size:10px;color:var(--muted);font-family:var(--font-mono);background:${meta.dotBg};padding:2px 7px;border-radius:3px;margin-left:8px">${it.location}</span>` : "";
            return `
              <div style="padding:12px 14px;background:${meta.bg};border:1px solid ${meta.border};border-radius:6px">
                <div onclick="toggleActionItem('${itemId}')" style="display:flex;align-items:center;gap:10px;cursor:pointer">
                  <span style="color:${meta.color};font-family:var(--font-mono);font-size:11px;width:14px;flex-shrink:0" id="${itemId}-chevron">▸</span>
                  <div style="flex:1;font-family:var(--font-mono);font-size:12px;color:var(--text);line-height:1.4">
                    ${it.issue}${loc}
                  </div>
                </div>
                <div id="${itemId}" style="display:none;margin-top:10px;padding:10px 12px;background:rgba(0,0,0,0.2);border-radius:4px;font-size:11px;color:var(--muted);line-height:1.6;border-left:2px solid ${meta.color}">
                  ${it.fix}
                </div>
              </div>`;
          }).join("")}
        </div>
      </div>
    `;
  }

  card.innerHTML = html;
}

function toggleActionItem(id) {
  const body    = document.getElementById(id);
  const chevron = document.getElementById(id + "-chevron");
  if (!body) return;
  const open = body.style.display === "";
  if (open) {
    body.style.display = "none";
    if (chevron) chevron.textContent = "▸";
  } else {
    body.style.display = "";
    if (chevron) chevron.textContent = "▾";
  }
}

function setMeter(id, val, colorFn, labelFn) {
  const card = document.getElementById(id);
  const el   = card.querySelector(".meter-value");
  if (val === null || val === undefined) { el.textContent = "—"; return; }
  el.textContent = labelFn(val);
  el.className   = "meter-value " + colorFn(val);
}

/* ── Sections renderer ── */
function renderSections(s) {
  const card = document.getElementById("sections-card");
  if (!card) return;
  if (!s || !s.sections || !s.sections.length) {
    card.style.display = "none"; return;
  }
  card.style.display = "";

  const badge = document.getElementById("sections-badge");
  if (badge) {
    const method = s.method === "smart" ? "auto-detected" : "30s windows";
    badge.textContent = `${s.sections.length} sections · ${method}`;
    badge.className = "section-badge badge-ok";
  }

  const fmtT = t => `${Math.floor(t/60)}:${Math.floor(t%60).toString().padStart(2,"0")}`;

  const strip = document.getElementById("sections-strip");
  const totalDur = s.sections.reduce((a, x) => a + x.duration, 0) || 1;
  strip.innerHTML = s.sections.map(sec => {
    const pct = (sec.duration / totalDur) * 100;
    // Tag narrow blocks so CSS can hide text that would overflow
    const narrowCls = pct < 10 ? " sec-block-narrow" : "";
    return `<div class="sec-block sec-${sec.label}${narrowCls}" style="flex:${pct}" title="${fmtT(sec.start_time)} · ${sec.lufs_avg} LUFS · ${sec.peak_events} peaks">
      <div class="sec-block-label">${sec.label}</div>
      <div class="sec-block-time">${fmtT(sec.start_time)}</div>
      <div class="sec-block-lufs">${sec.lufs_avg}</div>
    </div>`;
  }).join("");

  const q = s.sections.reduce((a, x) => x.lufs_avg < a.lufs_avg ? x : a, s.sections[0]);
  const l = s.sections.reduce((a, x) => x.lufs_avg > a.lufs_avg ? x : a, s.sections[0]);
  const w = s.sections.reduce((a, x) => x.dynamic_range > a.dynamic_range ? x : a, s.sections[0]);

  document.getElementById("sections-summary").innerHTML = `
    <div class="sec-stat"><span class="sec-stat-label">Quietest</span><span class="sec-stat-value">${q.lufs_avg} LUFS <span class="sec-stat-meta">at ${fmtT(q.start_time)}</span></span></div>
    <div class="sec-stat"><span class="sec-stat-label">Loudest</span><span class="sec-stat-value">${l.lufs_avg} LUFS <span class="sec-stat-meta">at ${fmtT(l.start_time)}</span></span></div>
    <div class="sec-stat"><span class="sec-stat-label">Widest DR</span><span class="sec-stat-value">${w.dynamic_range} dB <span class="sec-stat-meta">at ${fmtT(w.start_time)}</span></span></div>
  `;

  const callouts = document.getElementById("sections-callouts");
  callouts.innerHTML = (s.callouts || []).map(c => {
    const cls = c.severity === "warn" ? "callout-warn" : "callout-info";
    return `<div class="sec-callout ${cls}">
      <div class="sec-callout-msg">${c.message}</div>
      <div class="sec-callout-detail">${c.detail || ""}</div>
    </div>`;
  }).join("");
}

/* ── Reference renderer (spectral + loudness + stereo) ── */
function renderReference(ref) {
  const card = document.getElementById("ref-card");
  if (!card) return;
  card.classList.remove("hidden");

  let html = `<div class="ref-deltas">`;
  if (ref.loudness_delta_lufs !== null && ref.loudness_delta_lufs !== undefined) {
    const d = ref.loudness_delta_lufs;
    const cls = Math.abs(d) < 2 ? "ok" : d > 0 ? "pos" : "neg";
    html += chip("LUFS vs ref", (d > 0 ? "+" : "") + d + " LUFS", cls);
  }
  Object.entries(ref.spectral_deltas_db || {}).forEach(([band, d]) => {
    const cls = Math.abs(d) < 2 ? "ok" : d > 0 ? "pos" : "neg";
    const label = (typeof BAND_LABELS !== "undefined" && BAND_LABELS[band]) || band;
    html += chip(label, (d > 0 ? "+" : "") + d + " dB", cls);
  });
  if (ref.stereo) {
    if (ref.stereo.width_delta_db !== null && ref.stereo.width_delta_db !== undefined) {
      const wd = ref.stereo.width_delta_db;
      const cls = Math.abs(wd) < 2 ? "ok" : "pos";
      html += chip("Width vs ref", (wd > 0 ? "+" : "") + wd + " dB", cls);
    }
    if (ref.stereo.correlation_delta !== null && ref.stereo.correlation_delta !== undefined) {
      const cd = ref.stereo.correlation_delta;
      const cls = Math.abs(cd) < 0.1 ? "ok" : cd < 0 ? "neg" : "pos";
      html += chip("Correlation vs ref", (cd > 0 ? "+" : "") + cd.toFixed(2), cls);
    }
  }
  html += `</div>`;

  // Top divergences block — specific frequencies where the mix deviates most from reference
  if (ref.top_divergences && ref.top_divergences.length) {
    const meaningful = ref.top_divergences.filter(d => Math.abs(d.delta_db) >= 0.5);
    if (meaningful.length === 0) {
      html += `
        <div style="margin-top:16px;padding:10px 14px;background:rgba(48,209,88,0.04);border:1px solid rgba(48,209,88,0.15);border-radius:8px;font-size:11px;color:var(--ok);font-family:var(--font-mono)">
          ✓ Mix spectrum matches reference within 0.5 dB across all sub-bands.
        </div>`;
    } else {
      html += `
        <div style="margin-top:16px;padding:12px 14px;background:rgba(123,97,255,0.04);border:1px solid rgba(123,97,255,0.15);border-radius:8px">
          <div style="font-family:var(--font-head);font-size:10px;font-weight:600;color:var(--muted);letter-spacing:0.06em;margin-bottom:8px">SHARPEST FREQUENCY DIFFERENCES</div>
          <div style="display:flex;flex-direction:column;gap:5px">
            ${meaningful.map(d => {
              const sign = d.delta_db > 0 ? "+" : "";
              const clr = Math.abs(d.delta_db) < 2 ? "var(--muted)" : d.delta_db > 0 ? "var(--danger)" : "var(--accent2)";
              const desc = d.delta_db > 0 ? "louder than ref" : "quieter than ref";
              return `<div style="display:flex;justify-content:space-between;font-family:var(--font-mono);font-size:11px">
                <span style="color:var(--text)">${Math.round(d.center_hz)} Hz <span style="color:var(--muted);font-size:10px">(${Math.round(d.fmin)}–${Math.round(d.fmax)} Hz)</span></span>
                <span style="color:${clr};font-weight:600">${sign}${d.delta_db.toFixed(1)} dB <span style="font-weight:400;font-size:10px;color:var(--muted);margin-left:4px">${desc}</span></span>
              </div>`;
            }).join("")}
          </div>
        </div>`;
    }
  }

  document.getElementById("ref-content").innerHTML = html;

  renderReferenceOverlayOnSpectrum(ref);
  renderReferenceOnMeters(ref);

  const ld = document.getElementById("spectrum-legend-ref");
  const ll = document.getElementById("spectrum-legend-ref-label");
  if (ld) ld.style.display = "";
  if (ll) ll.style.display = "";
}

function renderReferenceOnMeters(ref) {
  document.querySelectorAll(".meter-ref-badge").forEach(el => el.remove());
  const addBadge = (cardId, text, cls) => {
    const card = document.getElementById(cardId);
    if (!card) return;
    const b = document.createElement("div");
    b.className = "meter-ref-badge " + cls;
    b.textContent = text;
    card.appendChild(b);
  };
  if (ref.loudness_delta_lufs !== null && ref.loudness_delta_lufs !== undefined) {
    const d = ref.loudness_delta_lufs;
    addBadge("meter-lufs", `vs ref: ${d > 0 ? "+" : ""}${d} LUFS`, Math.abs(d) < 2 ? "ok" : d > 0 ? "pos" : "neg");
  }
  if (ref.stereo && ref.stereo.width_delta_db !== null && ref.stereo.width_delta_db !== undefined) {
    const wd = ref.stereo.width_delta_db;
    addBadge("meter-width", `vs ref: ${wd > 0 ? "+" : ""}${wd} dB`, Math.abs(wd) < 2 ? "ok" : "pos");
  }
  if (ref.stereo && ref.stereo.correlation_delta !== null && ref.stereo.correlation_delta !== undefined) {
    const cd = ref.stereo.correlation_delta;
    addBadge("meter-corr", `vs ref: ${cd > 0 ? "+" : ""}${cd.toFixed(2)}`, Math.abs(cd) < 0.1 ? "ok" : cd < 0 ? "neg" : "pos");
  }
}

function renderReferenceOverlayOnSpectrum(ref) {
  if (!ref || !ref.ref_band_energy_db) return;
  const chart = document.getElementById("spectrum-chart");
  if (!chart) return;

  // Match the scale used in renderSpectrum (vs-pink, ±10 dB window).
  // We need to convert reference absolute dBFS into vs-pink. To do that we
  // need the reference overall RMS and pink offsets. Server returns both
  // keys when available: ref.ref_overall_rms_db and ref.pink_offsets.
  // If either is missing (older report), fall back to drawing nothing —
  // better than drawing an inconsistent overlay.
  const refOverallRms = (ref.ref_overall_rms_db !== undefined) ? ref.ref_overall_rms_db : null;
  const pinkOffsets   = ref.pink_offsets || null;
  if (refOverallRms === null || !pinkOffsets) return;

  const minDb  = -10, maxDb = +10;
  const range  = maxDb - minDb;
  const dBtoPx = 130 / range;
  const zeroPx = -minDb * dBtoPx;  // = 65

  const order = ["sub","bass","low_mid","mid","presence","air"];
  chart.querySelectorAll(".band-col").forEach((col, idx) => {
    const band = order[idx];
    if (!band) return;
    const refAbsDb = ref.ref_band_energy_db[band];
    if (refAbsDb === null || refAbsDb === undefined) return;
    const pinkOff = pinkOffsets[band];
    if (pinkOff === null || pinkOff === undefined) return;

    // Reference's tonal position on the same vs-pink scale
    const refVsPink = refAbsDb - refOverallRms - pinkOff;
    const clamped   = Math.max(minDb, Math.min(maxDb, refVsPink));
    const refPxFromBottom = zeroPx + clamped * dBtoPx;  // + because +dB goes up

    const bars = col.querySelector(".band-bars");
    if (!bars) return;
    bars.querySelectorAll(".bar-ref").forEach(el => el.remove());
    const m = document.createElement("div");
    m.className = "bar-ref";
    m.style.bottom = (refPxFromBottom - 1) + "px";
    m.title = `Reference: ${refVsPink.toFixed(1)} dB vs neutral`;
    bars.appendChild(m);
  });
}

function renderSpectrum(spectrum) {
  const chart = document.getElementById("spectrum-chart");
  chart.innerHTML = "";

  const bands  = spectrum.bands;
  // New scale: bars represent "dB vs pink noise at same overall loudness".
  // 0 = neutral (pink), positive = brighter than neutral, negative = darker.
  // We show a symmetric window ±10 dB so both directions are visible.
  const minDb  = -10, maxDb = +10;
  const range  = maxDb - minDb;
  // In bar-height terms (out of 130), zero sits at 65. Every dB is 6.5 px.
  const dBtoPx = 130 / range;
  const zeroPx = -minDb * dBtoPx;   // = 65

  // badge
  const issues = Object.values(bands).filter(b => b.status !== "ok").length;
  const badge  = document.getElementById("spectrum-badge");
  badge.textContent = issues === 0 ? "Balanced" : issues <= 2 ? `${issues} imbalance${issues>1?"s":""}` : `${issues} imbalances`;
  badge.className   = "section-badge " + (issues === 0 ? "badge-ok" : issues <= 2 ? "badge-warn" : "badge-danger");

  const BAND_FIX = {
    sub:      { high: "Sub-bass is heavy. Apply a high-pass filter at 25–30 Hz on the master bus (Frequency EQ). Check for resonances in the 40–60 Hz range.",
                low:  "Sub is low — may be intentional for this genre. If unwanted, check if a high-pass is cutting too high on the bass channel." },
    bass:     { high: "Bass band elevated. Notch 2–4 dB around 100–200 Hz on the dominant bass element (kick or bass guitar) using Frequency EQ, medium Q.",
                low:  "Bass is thin. Lower the high-pass filter cutoff on the bass channel, or add a low shelf boost around 100 Hz." },
    low_mid:  { high: "Low-mids heavy — causes boxiness. Cut 2–4 dB around 300–500 Hz on rhythm guitars or keys using Frequency EQ, medium Q.",
                low:  "Low-mids scooped — mix sounds thin on small speakers. Gentle bell boost around 400 Hz on the main instrument bus." },
    mid:      { high: "Mids elevated — can sound honky. Cut around 1–2 kHz on the loudest mid-range element. Check synths and distorted guitars.",
                low:  "Mids scooped — mix lacks presence on earbuds. Boost 800 Hz–1.5 kHz gently on master bus or main lead element." },
    presence: { high: "Presence range bright or harsh. Cut 3–6 kHz with a gentle bell on master bus (Frequency EQ). Check for sibilance.",
                low:  "Presence low — mix lacks definition. Boost 3–5 kHz on master EQ or on the main lead element (vocals, lead guitar)." },
    air:      { high: "Air frequencies excessive — listener fatigue risk. High-shelf cut above 10 kHz on master bus, 1–2 dB.",
                low:  "Air frequencies low — mix sounds dull. High-shelf boost above 10 kHz on master bus, 1–2 dB. Check no LPF is cutting too early." },
  };

  // Iterate in low-to-high frequency order, not dict order
  const BAND_ORDER = ["sub", "bass", "low_mid", "mid", "presence", "air"];
  BAND_ORDER.filter(name => bands[name]).forEach(name => {
    const data = bands[name];
    // Clamp for drawing, keep real values for labels
    const vsPink = data.vs_pink_db !== undefined ? data.vs_pink_db : 0;
    const target = data.target_db;
    const clampedPink = Math.max(minDb, Math.min(maxDb, vsPink));
    const clampedTarg = Math.max(minDb, Math.min(maxDb, target));
    // Bars grow from the zero line up (bright) or down (dark)
    const mixH    = Math.abs(clampedPink) * dBtoPx;
    const mixDir  = clampedPink >= 0 ? "up" : "down";
    const targetH = Math.abs(clampedTarg) * dBtoPx;
    const targetDir = clampedTarg >= 0 ? "up" : "down";

    const delta    = data.delta_db;
    const dClass   = Math.abs(delta) < 3 ? "delta-ok" : delta > 0 ? "delta-high" : "delta-low";
    const fixHint  = BAND_FIX[name];
    const fix      = fixHint && Math.abs(delta) >= 3 ? (delta > 0 ? fixHint.high : fixHint.low) : null;

    // Sub-band breakdown — 4 sub-bands per parent, with frequency ranges
    let subBandHtml = "";
    if (spectrum.sub_bands) {
      const subs = [0, 1, 2, 3].map(i => spectrum.sub_bands[`${name}_${i}`]).filter(Boolean);
      if (subs.length) {
        const median = (() => {
          const sorted = subs.map(s => s.energy_db).slice().sort((a, b) => a - b);
          return (sorted[1] + sorted[2]) / 2;
        })();
        subBandHtml = `
          <div style="font-family:var(--font-head);font-size:10px;font-weight:600;color:var(--muted);margin-top:10px;margin-bottom:4px;letter-spacing:0.06em">SUB-BAND BREAKDOWN</div>
          <div style="display:flex;flex-direction:column;gap:3px">
            ${subs.map(s => {
              const lift = s.energy_db - median;
              const hot = lift >= 5;
              const color = hot ? "var(--danger)" : "var(--muted)";
              const bg    = hot ? "rgba(255,95,87,0.08)" : "transparent";
              const label = `${Math.round(s.fmin)}–${Math.round(s.fmax)} Hz`;
              return `<div style="display:flex;justify-content:space-between;font-family:var(--font-mono);font-size:10px;padding:2px 6px;background:${bg};border-radius:3px;color:${color}">
                <span>${label}</span>
                <span>${s.energy_db.toFixed(1)} dB${hot ? ` &nbsp;· <strong>+${lift.toFixed(1)} lift</strong>` : ""}</span>
              </div>`;
            }).join("")}
          </div>`;
      }
    }

    const col = document.createElement("div");
    col.className = "band-col";
    // Always hover — even without a fix, show sub-band data
    const hasContent = fix || subBandHtml;
    if (hasContent) {
      col.style.cursor = "help";
      col.addEventListener("mouseenter", e => {
        const dir = delta > 0 ? "brighter than genre" : "darker than genre";
        const fixBlock = fix
          ? `<div style="font-size:11px;padding:8px 10px;background:rgba(255,95,87,0.08);border-radius:6px;color:var(--danger);line-height:1.6;border-left:2px solid var(--danger)"><strong style="display:block;margin-bottom:3px">How to fix</strong>${fix}</div>`
          : "";
        const headerLabel = fix ? `${BAND_LABELS[name]} — ${dir}` : `${BAND_LABELS[name]} — in range`;
        tooltipEl.innerHTML = `
          <div style="font-family:var(--font-head);font-size:13px;font-weight:600;color:var(--color-text-primary);margin-bottom:6px">${headerLabel}</div>
          <div style="font-family:var(--font-mono);font-size:11px;color:var(--muted);margin-bottom:8px;line-height:1.5">
            ${vsPink >= 0 ? "+" : ""}${vsPink.toFixed(1)} dB vs neutral &nbsp;·&nbsp;
            target ${target >= 0 ? "+" : ""}${target.toFixed(1)} dB &nbsp;·&nbsp;
            ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} dB vs genre
          </div>
          ${fixBlock}
          ${subBandHtml}
        `;
        tooltipEl.style.opacity = "1";
        positionTooltip(e);
      });
      col.addEventListener("mousemove",  e => positionTooltip(e));
      col.addEventListener("mouseleave", () => { tooltipEl.style.opacity = "0"; });
    }
    // Diverging bars: two vertical bars per band, side by side.
    // - Target bar (faint, outline) on the left half
    // - Mix bar (accent colored) on the right half
    // Both grow up from the zero line (if brighter than neutral) or down (if darker).
    // The zero line is drawn as a dashed horizontal across the column.
    const barMixTop   = mixDir === "up"    ? (zeroPx - mixH)  : zeroPx;
    const barTargTop  = targetDir === "up" ? (zeroPx - targetH) : zeroPx;
    // Minimum visible height so zero-delta bands are still discoverable
    const visMixH    = Math.max(2, mixH);
    const visTargH   = Math.max(2, targetH);
    col.innerHTML = `
        <div class="band-bars" style="position:relative;height:130px;display:block">
          <div class="band-bar bar-target" style="position:absolute;left:8%;width:38%;top:${barTargTop}px;height:${visTargH}px;min-height:2px;z-index:1"></div>
          <div class="band-bar bar-mix"    style="position:absolute;left:54%;width:38%;top:${barMixTop}px;height:${visMixH}px;min-height:2px;z-index:1"></div>
          <div style="position:absolute;left:0;right:0;top:${zeroPx}px;height:0;border-top:1px dashed rgba(255,255,255,0.28);z-index:3;pointer-events:none"></div>
        </div>
        <div class="band-name">${BAND_LABELS[name]}</div>
        <div class="band-delta ${dClass}">${delta > 0 ? "+" : ""}${delta} dB</div>`;
    chart.appendChild(col);
  });

  // Resonance card — renders independently of this function
  renderResonances(spectrum.resonances);
}

/* ── Render narrow-resonance callouts ── */
function renderResonances(resonances) {
  const el = document.getElementById("resonances-card");
  if (!el) return;
  if (!resonances || !resonances.length) {
    el.style.display = "none";
    return;
  }
  el.style.display = "";
  // Show top 5 resonances with specific frequency + fix tip
  const top = resonances.slice(0, 5);
  const parentLabel = { sub: "Sub", bass: "Bass", low_mid: "Low mid", mid: "Mid", presence: "Presence", air: "Air" };
  el.innerHTML = `
    <div class="section-head">
      <span class="section-title">Narrow resonances</span>
      <span class="section-badge badge-warn">${top.length} detected</span>
    </div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:12px;line-height:1.5">
      Sub-bands standing out ≥5 dB above their siblings. Often caused by room modes, instrument resonances, or un-tamed sample transients. Apply a narrow-Q (1.4–2.0) cut at the center frequency on the offending channel.
    </div>
    <div style="display:flex;flex-direction:column;gap:6px">
      ${top.map(r => `
        <div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:rgba(245,166,35,0.06);border-left:2px solid var(--warn);border-radius:4px">
          <div style="flex:1">
            <div style="font-family:var(--font-mono);font-size:13px;color:var(--text)">
              <strong>${Math.round(r.center_hz)} Hz</strong>
              <span style="color:var(--muted);margin-left:10px;font-size:11px">${Math.round(r.fmin)}–${Math.round(r.fmax)} Hz · ${parentLabel[r.parent] || r.parent} band</span>
            </div>
          </div>
          <div style="font-family:var(--font-mono);font-size:11px;color:var(--warn);font-weight:600">
            +${r.above_median_db.toFixed(1)} dB lift
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function renderDynamics(loudness, dynamics) {
  const row = document.getElementById("dynamics-row");
  const headroom = dynamics.headroom_db;
  const variance = dynamics.rms_variance;
  const tps      = dynamics.transients_per_second;

  // Color thresholds — aligned with industry documentation. Each range mirrors
  // the tooltip text rather than being stricter than it.
  //
  // Headroom: 3-6 dB is the documented ideal range for a pre-master (Sage
  //   Audio, Lagerfeldt mastering guide, Production III textbook). The
  //   "6 dB rule" is explicitly called a myth by working MEs. 1-3 dB is
  //   workable but tight; <1 dB is where inter-sample peaks become risky.
  // Dynamic range (P95-P10 RMS dB): 8-20 is healthy for most genres but
  //   metal/EDM normally sits at 4-10 (Yamaha audio guide). We use 6 as the
  //   green floor so a metal mix at 6 dB doesn't get flagged — that's its
  //   genre, not a compression problem. <3 dB indicates genuinely crushed.
  // Transients/sec: descriptive, not diagnostic. A 180 BPM metal track with
  //   double kicks hits 14/sec naturally — no literature supports marking
  //   that as problematic. Only flag when density is genuinely cluttered
  //   (20+ onsets/sec = ~1200/min = beyond any normal musical density).
  const hrColor  = headroom > 3 ? "var(--ok)" : headroom > 1 ? "var(--warn)" : "var(--danger)";
  const varColor = variance  > 6 ? "var(--ok)" : variance > 3 ? "var(--warn)" : "var(--danger)";
  const tpsColor = tps < 14 ? "var(--ok)" : tps < 20 ? "var(--warn)" : "var(--danger)";

  dynCardIdx = 0;
  row.innerHTML = `
    ${dynCard("Headroom", headroom + " dB", Math.min(100, (headroom / 20) * 100), hrColor)}
    ${dynCard("Dynamic range", variance.toFixed(1) + " dB", Math.min(100, (variance / 30) * 100), varColor)}
    ${dynCard("Transients / sec", tps.toFixed(1), Math.min(100, (tps / 20) * 100), tpsColor)}
  `;
  bindTooltip("dyn-headroom", "dyn-headroom");
  bindTooltip("dyn-rms",      "dyn-rms");
  bindTooltip("dyn-tps",      "dyn-tps");
}

const DYN_TOOLTIP_IDS = ["dyn-headroom", "dyn-rms", "dyn-tps"];
let dynCardIdx = 0;
function dynCard(label, value, pct, color) {
  const tid = DYN_TOOLTIP_IDS[dynCardIdx++ % DYN_TOOLTIP_IDS.length];
  return `<div class="dyn-card" id="${tid}" style="cursor:help">
    <div class="dyn-label">${label}</div>
    <div class="dyn-bar-track"><div class="dyn-bar-fill" style="width:${pct}%;background:${color}"></div></div>
    <div class="dyn-value" style="color:${color}">${value}</div>
  </div>`;
}

function renderStereo(stereo) {
  const row = document.getElementById("stereo-row");

  const corr = stereo.lr_correlation;
  const corrColor = corr >= 0.6 ? "var(--ok)" : corr >= 0.3 ? "var(--warn)" : "var(--danger)";
  const corrPct   = Math.max(0, (corr + 1) / 2 * 100);

  const width = stereo.mid_side_ratio_db;   // negative = narrow, positive = wide
  const widthPct = Math.min(100, Math.max(0, ((width + 20) / 40) * 100));
  const widthColor = Math.abs(width) < 8 ? "var(--ok)" : "var(--warn)";

  const mono = stereo.mono_compatibility_db;
  const monoColor = Math.abs(mono) < 1 ? "var(--ok)" : Math.abs(mono) < 3 ? "var(--warn)" : "var(--danger)";

  stereoCardIdx = 0;
  row.innerHTML = `
    ${stereoCard("L/R correlation", corr.toFixed(3), corrPct, corrColor, "from centre")}
    ${stereoCard("Stereo width (M/S)", width + " dB", widthPct, widthColor, "narrow ← → wide")}
    ${stereoCard("Mono delta", mono + " dB", Math.min(100, (Math.abs(mono) / 6) * 100), monoColor, "level loss in mono")}
  `;
  bindTooltip("stereo-corr",  "stereo-corr");
  bindTooltip("stereo-width", "stereo-width");
  bindTooltip("stereo-mono",  "stereo-mono");
}

/**
 * Render the frequency-cutoff card on the mix analysis page.
 *
 * Shows the effective audible bandwidth of the mix as kHz + % of Nyquist.
 * Informational for mix QA: flags cases where the source is band-limited
 * (e.g. a 44.1 kHz master upsampled to 48 or 96 kHz — still cuts at ~20 kHz
 * so the higher rate is cosmetic).
 *
 * Card stays hidden if the backend didn't include frequency_cutoff (e.g.
 * the signal was too short or too quiet to measure).
 */
function renderCutoffCheck(cutoff) {
  const card = document.getElementById("cutoff-card");
  const body = document.getElementById("cutoff-body");
  if (!card || !body) return;

  if (!cutoff || cutoff.cutoff_hz == null) {
    card.style.display = "none";
    return;
  }
  card.style.display = "";

  const verdict = cutoff.verdict || "unknown";
  const cfKhz   = (cutoff.cutoff_hz / 1000).toFixed(1);
  const nyqKhz  = (cutoff.nyquist_hz / 1000).toFixed(1);
  const pct     = (cutoff.pct_nyquist != null) ? cutoff.pct_nyquist.toFixed(0) : "—";

  // Escape detail text — it's server-generated but we still treat strings
  // in HTML context conservatively.
  const detail = String(cutoff.detail || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const sub = {
    full_band:    `Full bandwidth · vs ${nyqKhz} kHz Nyquist`,
    normal:       `Native high-rate · vs ${nyqKhz} kHz Nyquist`,
    band_limited: `Band-limited · vs ${nyqKhz} kHz Nyquist`,
    unknown:      `vs ${nyqKhz} kHz Nyquist`,
  }[verdict] || `vs ${nyqKhz} kHz Nyquist`;

  body.className = "cutoff-body";
  body.innerHTML = `
    <div class="cutoff-main">
      <div>
        <span class="cutoff-khz">${cfKhz}</span><span class="cutoff-khz-unit">kHz</span>
      </div>
      <div class="cutoff-pct">
        <span class="cutoff-pct-val verdict-${verdict}">${pct}%</span> of Nyquist
      </div>
    </div>
    <div class="cutoff-detail">
      <strong>${sub}</strong><br>${detail}
    </div>`;
}

const STEREO_TOOLTIP_IDS = ["stereo-corr", "stereo-width", "stereo-mono"];
let stereoCardIdx = 0;
function stereoCard(label, value, pct, color, hint) {
  const stid = STEREO_TOOLTIP_IDS[stereoCardIdx++ % STEREO_TOOLTIP_IDS.length];
  return `<div class="stereo-card" id="${stid}" style="cursor:help">
    <div class="stereo-label">${label}</div>
    <div class="stereo-gauge"><div class="stereo-fill" style="left:0;width:${pct}%;background:${color}"></div></div>
    <div class="stereo-value" style="color:${color}">${value}</div>
    <div style="font-size:10px;color:var(--muted);margin-top:4px">${hint}</div>
  </div>`;
}

function chip(label, value, cls) {
  return `<div class="ref-chip">
    <div class="ref-chip-label">${label}</div>
    <div class="ref-chip-val ${cls}">${value}</div>
  </div>`;
}

function formatDuration(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}



/* ── Tooltip definitions ── */
const TOOLTIPS = {
  "meter-lufs": {
    name: "Integrated LUFS",
    desc: "The average perceived loudness of the entire track, measured in Loudness Units relative to Full Scale. This is what streaming platforms use to normalize your music.",
    range: "Streaming target: −14 LUFS. Typical masters: −14 to −8 LUFS. Below −20 is too quiet, above −8 is over-limited.",
    fix: {
      high: "Too loud: reduce the gain on your master bus limiter (Cubase Brickwall Limiter) — raise the threshold or lower the input gain. Target −14 LUFS for streaming.",
      low:  "Too quiet: increase the input gain on your master bus limiter, or add a gentle makeup gain stage before it."
    },
    threshold: { high: -8, low: -20, value: "integrated_lufs" }
  },
  "meter-peak": {
    name: "True Peak",
    desc: "The highest inter-sample peak in the audio. Codec encoding (MP3, AAC) can cause peaks to clip even if the sample peak looks fine — true peak catches these.",
    range: "Should stay below −1 dBFS for streaming. −0.5 dBFS is the safe ceiling. Anything at or above 0 dBFS will clip.",
    fix: {
      high: "Clipping risk: lower the ceiling on your Brickwall Limiter to −1.0 dBTP. In Cubase: Limiter insert → set Output Ceiling to −1.0. Re-export and re-check."
    },
    threshold: { high: -0.5, value: "true_peak_dbfs" }
  },
  "meter-crest": {
    name: "Crest Factor",
    desc: "The difference between the peak level and the RMS (average) level. A higher crest factor means more dynamic range and punchier transients. Low values indicate heavy compression.",
    range: "8–18 dB is healthy for most genres. Below 6 dB = over-compressed. Metal/EDM can go as low as 5 dB intentionally. Classical can exceed 20 dB.",
    fix: {
      low: "Over-compressed: reduce the ratio or raise the threshold on your master bus compressor. Try bypassing it entirely and see if the mix breathes more naturally."
    },
    threshold: { low: 6, value: "crest_factor_db" }
  },
  "meter-corr": {
    name: "L/R Correlation",
    desc: "How similar the left and right channels are. 1.0 = perfect mono, 0.0 = completely different signals, negative = phase cancellation (bad). Low values cause the mix to collapse or lose bass in mono.",
    range: "0.5–1.0 is healthy. Below 0.3 suggests phase issues. Negative values are a serious problem — the mix will cancel in mono.",
    fix: {
      low: "Phase issues: check any stereo widening plugins on the master bus — reduce their width. Solo each track and flip phase (the ⌀ button in Cubase channel settings) to find the culprit. Check mono in Control Room."
    },
    threshold: { low: 0.3, value: "lr_correlation" }
  },
  "meter-width": {
    name: "Stereo Width (M/S ratio)",
    desc: "The balance between the Mid channel (mono content) and the Side channel (stereo information), measured in dB. Negative values mean the mix is narrower (more mono-like), positive means wider.",
    range: "−10 to −4 dB is a typical healthy range. Below −12 dB is very narrow. Above 0 dB is extremely wide and may cause mono issues.",
    fix: {
      low:  "Too narrow: add a Stereo Enhancer on the master bus, or use Mid/Side EQ to boost the Side channel slightly above 2 kHz.",
      high: "Too wide: reduce the width on any stereo widener, or use M/S EQ to cut the Side channel — especially in the low end below 200 Hz."
    },
    threshold: { low: -12, high: 0, value: "mid_side_ratio_db" }
  },
  "dyn-headroom": {
    name: "Headroom",
    desc: "How much space remains between the true peak and 0 dBFS. Negative headroom means the audio is already clipping. More headroom gives the mastering engineer room to work.",
    range: "3–6 dB is the documented ideal for a pre-master. 1–3 dB is tight but usable. Below 1 dB risks inter-sample clipping on lossy encoders. Negative = already clipping."
  },
  "dyn-rms": {
    name: "Dynamic Range (P95–P10)",
    desc: "The spread between the loud and quiet moments in the track, measured as the difference between the 95th and 10th percentile short-term RMS levels. A higher value means more dynamic variation — the mix breathes. A low value means the loudness is consistently compressed flat.",
    range: "Above 6 dB is healthy for most genres. 3–6 dB is typical for heavily compressed pop/metal/EDM. Below 3 dB indicates the mix is genuinely crushed. Post-Rock and classical naturally reach 15–30 dB."
  },
  "dyn-tps": {
    name: "Transients per Second",
    desc: "How many distinct transient events (attacks) occur each second — drum hits, pick attacks, note starts. This is a descriptive measure of rhythmic density, not a quality judgment.",
    range: "Under 14 per second covers most music including fast metal with double-kick drumming. 14–20 is dense (djent, drum-and-bass, busy electronic). Above 20 can feel genuinely cluttered."
  },
  "stereo-corr": {
    name: "L/R Correlation",
    desc: "Measures phase coherence between left and right channels. Critical for mono compatibility — if a listener plays your track in mono (phone speaker, club PA), low correlation causes bass and other content to cancel out.",
    range: "0.5–1.0 is safe. Below 0.3 is risky. Negative values mean destructive phase cancellation in mono."
  },
  "stereo-width": {
    name: "Stereo Width (M/S ratio)",
    desc: "Derived from the Mid/Side encoding of your stereo signal. The Mid is the mono-compatible center content; the Side is the difference between L and R. A very wide side channel can make the mix feel thin in mono.",
    range: "−10 to −4 dB is typical. Post-Rock and cinematic music often sits around −8 to −5 dB. Below −14 dB is very narrow; closer to 0 dB is very wide."
  },
  "stereo-mono": {
    name: "Mono Compatibility",
    desc: "How much level is lost when the stereo mix is summed to mono. A 0 dB drop means the mix is perfectly mono compatible. Larger drops indicate stereo widening that causes cancellation when collapsed to mono.",
    range: "0 to −1 dB is excellent. −1 to −3 dB is acceptable. Below −3 dB means significant content will disappear on mono systems (phone speakers, some club PAs)."
  },
};

function createTooltip() {
  const el = document.createElement("div");
  el.id = "mix-tooltip";
  el.style.cssText = [
    "position:fixed", "z-index:9999", "max-width:320px",
    "background:var(--bg2)", "border:1px solid var(--border2)",
    "border-radius:var(--border-radius-lg,12px)", "padding:14px 16px",
    "pointer-events:none", "opacity:0", "transition:opacity 0.15s",
    "box-shadow:0 4px 24px rgba(0,0,0,0.4)"
  ].join(";");
  document.body.appendChild(el);
  return el;
}

const tooltipEl = createTooltip();

function showTooltip(e, key) {
  const data = TOOLTIPS[key];
  if (!data) return;

  // Check if value is out of range and determine fix hint
  let fixHtml = "";
  if (data.fix && data.threshold && window._currentReport) {
    const report = window._currentReport;
    let val = null;
    const tv  = data.threshold.value;
    if (tv === "integrated_lufs")   val = report.loudness?.integrated_lufs;
    if (tv === "true_peak_dbfs")    val = report.loudness?.true_peak_dbfs;
    if (tv === "crest_factor_db")   val = report.loudness?.crest_factor_db;
    if (tv === "lr_correlation")    val = report.stereo?.lr_correlation;
    if (tv === "mid_side_ratio_db") val = report.stereo?.mid_side_ratio_db;

    if (val !== null && val !== undefined) {
      let fixMsg = null;
      if (data.threshold.high !== undefined && val > data.threshold.high && data.fix.high) fixMsg = data.fix.high;
      if (data.threshold.low  !== undefined && val < data.threshold.low  && data.fix.low)  fixMsg = data.fix.low;
      if (fixMsg) {
        fixHtml = `<div style="font-size:11px;padding:8px 10px;background:rgba(255,95,87,0.08);border-radius:6px;color:var(--danger,#ff5f57);line-height:1.5;margin-top:6px;border-left:2px solid var(--danger,#ff5f57)"><strong style="display:block;margin-bottom:3px">How to fix</strong>${fixMsg}</div>`;
      }
    }
  }

  tooltipEl.innerHTML = `
    <div style="font-family:var(--font-head);font-size:13px;font-weight:600;color:var(--color-text-primary,#e8e6e0);margin-bottom:6px">${data.name}</div>
    <div style="font-size:12px;color:var(--muted,#6b6a72);line-height:1.6;margin-bottom:8px">${data.desc}</div>
    <div style="font-size:11px;padding:8px 10px;background:var(--bg3,#1c1c22);border-radius:6px;color:var(--accent,#c8f050);line-height:1.5">${data.range}</div>
    ${fixHtml}
  `;
  tooltipEl.style.opacity = "1";
  positionTooltip(e);
}

function positionTooltip(e) {
  const tw = 320, th = tooltipEl.offsetHeight || 140;
  let x = e.clientX + 14;
  let y = e.clientY + 14;
  if (x + tw > window.innerWidth - 16)  x = e.clientX - tw - 14;
  if (y + th > window.innerHeight - 16) y = e.clientY - th - 14;
  tooltipEl.style.left = x + "px";
  tooltipEl.style.top  = y + "px";
}

function hideTooltip() {
  tooltipEl.style.opacity = "0";
}

function bindTooltip(id, key) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.cursor = "help";
  el.addEventListener("mouseenter", e => showTooltip(e, key));
  el.addEventListener("mousemove",  e => positionTooltip(e));
  el.addEventListener("mouseleave", hideTooltip);
}

/* ── Session persistence — restore last report on page load ── */
(function restoreSession() {
  try {
    const saved = sessionStorage.getItem("mix_analyzer_report");
    if (!saved) return;
    const report = JSON.parse(saved);
    if (!report.loudness || !report.spectrum) return;
    window._currentReport = report;
    currentReportId = report.report_id || null;
    uploadPanel.classList.add("hidden");
    renderResults(report);
    resultsPanel.classList.remove("hidden");
    _resetTimelineZoom();
    requestAnimationFrame(() => renderTimeline(report));
    // Re-check API key display
    fetch("/config").then(r => r.json()).then(data => {
      if (data.has_api_key) {
        const input = document.getElementById("api-key-input");
        if (input) input.replaceWith(Object.assign(document.createElement("span"), {
          style: "font-size:13px;color:var(--ok);align-self:center",
          textContent: "✓ API key loaded from environment"
        }));
      }
    });
  } catch(e) {}
})();

/* ── Check runtime capabilities on load ──
 * /config reports:
 *   has_api_key       — ANTHROPIC_API_KEY present in environment?
 *   advisor_available — ai_advisor module (anthropic SDK) importable?
 *
 * Behavior:
 *   advisor_available=false → hide the whole AI card entirely (the feature
 *     is not available in this build, e.g. packaged .exe without the SDK)
 *   advisor_available=true, has_api_key=true → show "API key loaded" pill
 *   advisor_available=true, has_api_key=false → show the API key input,
 *     user can paste a key per-request
 */
(async function checkAdvisorConfig() {
  try {
    const res  = await fetch("/config");
    const data = await res.json();
    const card = document.getElementById("ai-card");

    if (!data.advisor_available) {
      if (card) card.style.display = "none";
      return;
    }
    if (data.has_api_key) {
      const input = document.getElementById("api-key-input");
      const hint  = document.querySelector(".ai-key-hint");
      if (input) input.replaceWith(Object.assign(document.createElement("span"), {
        style: "font-size:13px;color:var(--ok);align-self:center",
        textContent: "✓ API key loaded from environment"
      }));
      if (hint) hint.style.display = "none";
    }
  } catch (e) { /* silently ignore — leave the default visible state */ }
})();

/* ── AI Advice ── */
let currentReportId = null;

document.getElementById("btn-get-advice").addEventListener("click", fetchAdvice);

async function fetchAdvice() {
  const keyInput = document.getElementById("api-key-input");
  const key = keyInput ? keyInput.value.trim() : "";
  const btn = document.getElementById("btn-get-advice");

  if (!currentReportId) {
    alert("Run an analysis first.");
    return;
  }

  btn.disabled = true;
  document.getElementById("ai-loading").classList.remove("hidden");
  document.getElementById("ai-results").classList.add("hidden");
  document.getElementById("ai-key-row").style.opacity = "0.4";

  try {
    const res = await fetch("/advice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ report_id: currentReportId, report: window._currentReport, api_key: key || undefined }),
    });
    const data = await res.json();

    if (data.error) {
      document.getElementById("ai-loading").classList.add("hidden");
      document.getElementById("ai-key-row").style.opacity = "1";
      btn.disabled = false;
      alert("Error: " + data.error);
      return;
    }

    console.log('AI advice response:', JSON.stringify(data, null, 2));
    renderAdvice(data);

  } catch (err) {
    document.getElementById("ai-loading").classList.add("hidden");
    document.getElementById("ai-key-row").style.opacity = "1";
    btn.disabled = false;
    alert("Error: " + err.message);
  }
}

function renderAdvice(a) {
  document.getElementById("ai-loading").classList.add("hidden");
  document.getElementById("ai-results").classList.remove("hidden");
  document.getElementById("ai-key-row").style.display = "none";
  document.getElementById("ai-badge").style.display = "";

  /* Overall */
  document.getElementById("ai-overall").textContent = a.overall;

  /* Issues */
  const issuesEl = document.getElementById("ai-issues");
  issuesEl.innerHTML = "";
  (a.issues || []).forEach(issue => {
    const p = Math.min(issue.priority, 5);
    issuesEl.innerHTML += `
      <div class="ai-issue p${p}">
        <div class="ai-issue-header">
          <div class="ai-issue-num">${p}</div>
          <div class="ai-issue-title">${issue.title}</div>
          <span class="ai-issue-stage stage-${issue.stage}">${issue.stage}</span>
        </div>
        <p class="ai-issue-problem">${issue.problem}</p>
        <div class="ai-issue-fix">${issue.fix}</div>
      </div>`;
  });

  /* Positives */
  const posEl = document.getElementById("ai-positives");
  posEl.innerHTML = (a.positives || []).map(p => `<li>${p}</li>`).join("");

  /* Mastering note */
  document.getElementById("ai-mastering").textContent = a.mastering_note;
}

/* ── Resize handler for timeline canvas ── */
window.addEventListener("resize", () => {
  if (window._currentReport && window._currentReport.timeline) {
    renderTimeline(window._currentReport);
  }
});

/* ── Timeline renderer ── */
// Timeline zoom state — persists across re-renders of the same report
let _tlViewStart = null;
let _tlViewEnd   = null;

// Drag state (module-level so it persists across renders if one happens mid-drag)
let _tlDragStartX = null;
let _tlDragCurX   = null;

function _resetTimelineZoom() {
  _tlViewStart = null;
  _tlViewEnd   = null;
}

function renderTimeline(report) {
  const tl       = report.timeline;
  const duration = report.duration_seconds;
  if (!tl || !tl.waveform) return;

  // Initialise zoom window if unset or outside duration (e.g. loading new report)
  if (_tlViewStart === null || _tlViewEnd === null ||
      _tlViewStart < 0 || _tlViewEnd > duration + 0.1 || _tlViewStart >= _tlViewEnd) {
    _tlViewStart = 0;
    _tlViewEnd   = duration;
  }
  const viewStart = _tlViewStart;
  const viewEnd   = _tlViewEnd;
  const viewSpan  = viewEnd - viewStart;
  const isZoomed  = viewStart > 0.01 || viewEnd < duration - 0.01;

  const canvas  = document.getElementById("timeline-canvas");
  const ctx     = canvas.getContext("2d");
  const dpr     = window.devicePixelRatio || 1;
  const W       = canvas.parentElement.clientWidth || canvas.parentElement.offsetWidth || 800;
  const H       = 140;

  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + "px";
  canvas.style.height = H + "px";
  ctx.scale(dpr, dpr);

  const PAD_L = 42, PAD_R = 12, PAD_T = 10, PAD_B = 24;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  // Background
  ctx.fillStyle = getComputedStyle(document.documentElement)
    .getPropertyValue("--bg3").trim() || "#1c1c22";
  ctx.fillRect(0, 0, W, H);

  // LUFS range for scaling — clamp between -40 and 0
  const lufsVals   = tl.lufs_timeline.filter(v => v > -70);
  const lufsMin    = Math.min(-40, ...(lufsVals.length ? lufsVals : [-40]));
  const lufsMax    = Math.max(0,   ...(lufsVals.length ? lufsVals : [0]));
  const lufsRange  = lufsMax - lufsMin || 1;

  function lufsY(v) {
    const clamped = Math.max(lufsMin, Math.min(lufsMax, v));
    return PAD_T + plotH - ((clamped - lufsMin) / lufsRange) * plotH;
  }

  function timeX(t) {
    return PAD_L + ((t - viewStart) / viewSpan) * plotW;
  }

  // Grid lines — every 6 dB LUFS
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth   = 0.5;
  for (let v = Math.ceil(lufsMin / 6) * 6; v <= lufsMax; v += 6) {
    const y = lufsY(v);
    ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + plotW, y); ctx.stroke();
    ctx.fillStyle   = "rgba(255,255,255,0.25)";
    ctx.font        = "10px monospace";
    ctx.textAlign   = "right";
    ctx.fillText(v + " dB", PAD_L - 4, y + 3);
  }

  // Streaming target line at −14 LUFS
  if (lufsMin <= -14 && lufsMax >= -14) {
    const ty = lufsY(-14);
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.2)";
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD_L, ty); ctx.lineTo(PAD_L + plotW, ty); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.font      = "9px monospace";
    ctx.textAlign = "left";
    ctx.fillText("−14", PAD_L + 2, ty - 3);
  }

  // Waveform — filled area centered vertically
  const wfMid = PAD_T + plotH * 0.35;  // draw waveform in upper 35% of plot
  const wfH   = plotH * 0.32;
  const wf    = tl.waveform;

  // Map waveform sample index → time; only draw samples inside view window
  const wfSecondsPerSample = duration / wf.length;
  const wfStartIdx = Math.max(0, Math.floor(viewStart / wfSecondsPerSample));
  const wfEndIdx   = Math.min(wf.length, Math.ceil(viewEnd / wfSecondsPerSample));

  if (wfEndIdx > wfStartIdx) {
    ctx.beginPath();
    for (let i = wfStartIdx; i < wfEndIdx; i++) {
      const t = i * wfSecondsPerSample;
      const x = timeX(t);
      const h = wf[i] * wfH;
      if (i === wfStartIdx) ctx.moveTo(x, wfMid - h);
      else ctx.lineTo(x, wfMid - h);
    }
    for (let i = wfEndIdx - 1; i >= wfStartIdx; i--) {
      const t = i * wfSecondsPerSample;
      const x = timeX(t);
      const h = wf[i] * wfH;
      ctx.lineTo(x, wfMid + h);
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(200,240,80,0.15)";
    ctx.fill();
    ctx.strokeStyle = "rgba(200,240,80,0.45)";
    ctx.lineWidth   = 0.5;
    ctx.stroke();
  }

  // LUFS timeline line
  const lufs = tl.lufs_timeline;
  const times = tl.time_points;
  if (lufs.length > 1) {
    // Include one point on each side of the view for smooth edges
    let firstDrawnIdx = -1;
    let lastDrawnIdx  = -1;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < lufs.length; i++) {
      const t = times[i] + 1.5;  // short-term window offset
      // Keep points inside the view, plus one on each side
      const prevT = i > 0 ? times[i-1] + 1.5 : -Infinity;
      const nextT = i < lufs.length - 1 ? times[i+1] + 1.5 : Infinity;
      const inView      = t >= viewStart && t <= viewEnd;
      const prevInView  = prevT >= viewStart && prevT <= viewEnd;
      const nextInView  = nextT >= viewStart && nextT <= viewEnd;
      if (!inView && !prevInView && !nextInView) continue;

      const x = timeX(t);
      const y = lufsY(lufs[i]);
      if (!started) { ctx.moveTo(x, y); started = true; firstDrawnIdx = i; }
      else ctx.lineTo(x, y);
      lastDrawnIdx = i;
    }
    if (started) {
      ctx.strokeStyle = "#7b61ff";
      ctx.lineWidth   = 1.5;
      ctx.lineJoin    = "round";
      ctx.stroke();

      // Fill under LUFS line
      if (lastDrawnIdx >= 0 && firstDrawnIdx >= 0) {
        ctx.lineTo(timeX(times[lastDrawnIdx] + 1.5), H);
        ctx.lineTo(timeX(times[firstDrawnIdx] + 1.5), H);
        ctx.closePath();
        ctx.fillStyle = "rgba(123,97,255,0.08)";
        ctx.fill();
      }
    }
  }

  // Peak event markers (only draw those in view)
  (tl.peak_events || []).forEach(ev => {
    if (ev.time < viewStart || ev.time > viewEnd) return;
    const x = timeX(ev.time);
    ctx.beginPath();
    ctx.moveTo(x, PAD_T);
    ctx.lineTo(x, PAD_T + plotH);
    ctx.strokeStyle = "rgba(255,95,87,0.6)";
    ctx.lineWidth   = 1;
    ctx.setLineDash([2, 2]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Triangle marker at top
    ctx.beginPath();
    ctx.moveTo(x, PAD_T + 2);
    ctx.lineTo(x - 4, PAD_T + 10);
    ctx.lineTo(x + 4, PAD_T + 10);
    ctx.closePath();
    ctx.fillStyle = "#ff5f57";
    ctx.fill();
  });

  // Time axis labels (reflect current view window)
  const labelEl = document.getElementById("timeline-labels");
  const nLabels = 6;
  labelEl.innerHTML = "";
  for (let i = 0; i <= nLabels; i++) {
    const t   = viewStart + (i / nLabels) * viewSpan;
    const min = Math.floor(t / 60);
    const sec = Math.floor(t % 60).toString().padStart(2, "0");
    const span = document.createElement("span");
    span.textContent = `${min}:${sec}`;
    labelEl.appendChild(span);
  }

  // Badge: peak event count
  const badge = document.getElementById("timeline-badge");
  const peakCount = (tl.peak_events || []).length;
  if (peakCount > 0) {
    badge.textContent = `${peakCount} peak event${peakCount > 1 ? "s" : ""}`;
    badge.className   = "section-badge badge-danger";
  } else {
    badge.textContent = "No clipping";
    badge.className   = "section-badge badge-ok";
  }

  // Peak timestamp list — group nearby events, show worst peak per cluster
  const peakListEl = document.getElementById("peak-timestamps");
  const peakList   = document.getElementById("peak-list");
  if (tl.peak_events && tl.peak_events.length > 0) {
    peakListEl.style.display = "block";

    // Cluster peaks within 3 seconds of each other, keep worst
    const clusters = [];
    tl.peak_events.forEach(ev => {
      const last = clusters[clusters.length - 1];
      if (last && ev.time - last.time < 3) {
        if (ev.peak_db > last.peak_db) clusters[clusters.length - 1] = ev;
      } else {
        clusters.push({...ev});
      }
    });

    // Format each cluster
    const items = clusters.map(ev => {
      const m = Math.floor(ev.time / 60);
      const s = Math.floor(ev.time % 60).toString().padStart(2, "0");
      const db = (ev.peak_db > 0 ? "+" : "") + ev.peak_db + " dBFS";
      return `<span style="white-space:nowrap;margin-right:4px">${m}:${s} <span style="opacity:0.6">(${db})</span></span>`;
    }).join('<span style="color:rgba(255,95,87,0.3);margin:0 4px">·</span>');

    // Add summary
    const spanSec = tl.peak_events[tl.peak_events.length-1].time - tl.peak_events[0].time;
    const summary = tl.peak_events.length > clusters.length
      ? ` <span style="opacity:0.5;font-size:10px">(${tl.peak_events.length} total, clustered into ${clusters.length} zones)</span>`
      : "";

    peakList.innerHTML = items + summary;
  } else {
    peakListEl.style.display = "none";
  }

  // Hover + drag-to-zoom interaction
  // Using onX assignment (not addEventListener) so handlers replace cleanly on re-render
  const hoverEl   = document.getElementById("timeline-hover");
  const hoverTime = document.getElementById("hover-time");
  const hoverLufs = document.getElementById("hover-lufs");
  const hoverPeak = document.getElementById("hover-peak");

  // Convert screen X (relative to canvas) to time within current view window
  function xRelToTime(xRel, rectW) {
    const plotLeftRel = PAD_L;
    const plotRightRel = rectW - PAD_R;
    const plotWRel = plotRightRel - plotLeftRel;
    const fracInPlot = Math.max(0, Math.min(1, (xRel - plotLeftRel) / plotWRel));
    return viewStart + fracInPlot * viewSpan;
  }

  // Get or create the drag overlay div (positioned absolutely over the canvas)
  const wrap = canvas.parentElement;
  let dragOverlay = document.getElementById("timeline-drag-overlay");
  if (!dragOverlay) {
    dragOverlay = document.createElement("div");
    dragOverlay.id = "timeline-drag-overlay";
    dragOverlay.style.cssText = "position:absolute;display:none;top:0;background:rgba(200,240,80,0.15);border-left:1px solid rgba(200,240,80,0.7);border-right:1px solid rgba(200,240,80,0.7);pointer-events:none;z-index:5";
    if (getComputedStyle(wrap).position === "static") wrap.style.position = "relative";
    wrap.appendChild(dragOverlay);
  }

  function updateDragOverlay() {
    if (_tlDragStartX === null || _tlDragCurX === null) {
      dragOverlay.style.display = "none";
      return;
    }
    const x0 = Math.min(_tlDragStartX, _tlDragCurX);
    const x1 = Math.max(_tlDragStartX, _tlDragCurX);
    dragOverlay.style.display = "block";
    dragOverlay.style.left = x0 + "px";
    dragOverlay.style.width = (x1 - x0) + "px";
    // Height = plot area on canvas
    dragOverlay.style.top = PAD_T + "px";
    dragOverlay.style.height = plotH + "px";
  }

  // If a drag is already in progress when we re-render (rare but possible), restore overlay
  if (_tlDragStartX !== null) updateDragOverlay();

  canvas.onmousedown = e => {
    const rect = canvas.getBoundingClientRect();
    const xRel = e.clientX - rect.left;
    // Only start drag if inside plot area
    if (xRel < PAD_L || xRel > rect.width - PAD_R) return;
    _tlDragStartX = xRel;
    _tlDragCurX   = xRel;
    hoverEl.style.display = "none";
    updateDragOverlay();
    e.preventDefault();
  };

  canvas.onmousemove = e => {
    const rect = canvas.getBoundingClientRect();
    const xRel = e.clientX - rect.left;

    if (_tlDragStartX !== null) {
      // Dragging — just update the overlay div; DO NOT re-render canvas
      _tlDragCurX = xRel;
      updateDragOverlay();
      return;  // skip hover tooltip during drag
    }

    // Normal hover — time based on current view window
    const timeSec = xRelToTime(xRel, rect.width);

    const m  = Math.floor(Math.max(0, timeSec) / 60);
    const s  = Math.floor(Math.max(0, timeSec) % 60).toString().padStart(2, "0");
    hoverTime.textContent = `${m}:${s}`;

    if (tl.time_points && tl.lufs_timeline && tl.time_points.length > 0) {
      let nearestIdx = 0;
      let nearestDist = Infinity;
      tl.time_points.forEach((t, i) => {
        const dist = Math.abs(t - timeSec);
        if (dist < nearestDist) { nearestDist = dist; nearestIdx = i; }
      });
      const lufsVal = tl.lufs_timeline[nearestIdx];
      hoverLufs.textContent = lufsVal > -70 ? `${lufsVal} LUFS` : "";
    }

    const nearPeak = (tl.peak_events || []).find(ev => Math.abs(ev.time - timeSec) < Math.max(0.5, viewSpan * 0.01));
    hoverPeak.textContent = nearPeak ? `⚠ peak ${nearPeak.peak_db > 0 ? "+" : ""}${nearPeak.peak_db} dBFS` : "";

    hoverEl.style.display = "block";
    const tipW = hoverEl.offsetWidth;
    let tipX   = xRel + 12;
    if (tipX + tipW > rect.width) tipX = xRel - tipW - 8;
    hoverEl.style.left = tipX + "px";
  };

  canvas.onmouseup = e => {
    if (_tlDragStartX === null) return;
    const rect = canvas.getBoundingClientRect();
    const xRel = e.clientX - rect.left;
    const x0 = Math.min(_tlDragStartX, xRel);
    const x1 = Math.max(_tlDragStartX, xRel);
    _tlDragStartX = null;
    _tlDragCurX = null;
    dragOverlay.style.display = "none";

    // Ignore tiny drags (treat as a click — do nothing)
    if (x1 - x0 < 5) return;

    const t0 = xRelToTime(x0, rect.width);
    const t1 = xRelToTime(x1, rect.width);
    // Require at least 0.5s of zoom to avoid useless micro-zooms
    if (t1 - t0 < 0.5) return;

    _tlViewStart = t0;
    _tlViewEnd   = t1;
    renderTimeline(report);
  };

  canvas.onmouseleave = () => {
    hoverEl.style.display = "none";
    // Note: we DON'T cancel the drag here — user might be dragging beyond canvas edge.
    // The drag is only canceled on mouseup (or if mouseup happens outside, we catch it on window)
  };

  // Also catch mouseup on the window, in case user releases outside the canvas
  if (!window._tlMouseUpBound) {
    window._tlMouseUpBound = true;
    window.addEventListener("mouseup", () => {
      if (_tlDragStartX !== null) {
        _tlDragStartX = null;
        _tlDragCurX = null;
        const el = document.getElementById("timeline-drag-overlay");
        if (el) el.style.display = "none";
      }
    });
  }

  // Double-click to reset zoom
  canvas.ondblclick = () => {
    if (!isZoomed) return;
    _resetTimelineZoom();
    renderTimeline(report);
  };

  canvas.style.cursor = isZoomed ? "zoom-out" : "crosshair";

  // Zoom indicator badge — small "zoomed" chip when active
  const zoomIndicator = document.getElementById("timeline-zoom-indicator");
  if (zoomIndicator) {
    if (isZoomed) {
      const fmt = t => `${Math.floor(t/60)}:${Math.floor(t%60).toString().padStart(2,"0")}`;
      zoomIndicator.innerHTML = `<span style="color:var(--accent2);font-family:var(--font-mono);font-size:11px;padding:3px 8px;background:rgba(123,97,255,0.1);border-radius:4px;cursor:pointer" onclick="_resetTimelineZoom(); renderTimeline(window._currentReport);" title="Click to reset zoom">Zoomed: ${fmt(viewStart)}–${fmt(viewEnd)} ✕</span>`;
    } else {
      zoomIndicator.innerHTML = `<span style="color:var(--muted);font-size:10px">Drag to zoom · double-click to reset</span>`;
    }
  }
}

/* ── History panel ── */
const GENRE_NAMES_H = {
  postrock:"Post-Rock", progrock:"Prog Rock", metal:"Metal",
  instrumental:"Instrumental", rock:"Rock", pop:"Pop",
  electronic:"Electronic", hiphop:"Hip-Hop", jazz:"Jazz", classical:"Classical",
};

function toggleHistory() {
  const panel   = document.getElementById("history-panel");
  const overlay = document.getElementById("history-overlay");
  const open    = panel.style.display === "block";
  panel.style.display   = open ? "none" : "block";
  overlay.style.display = open ? "none" : "block";
  if (!open) loadHistory();
}

async function loadHistory() {
  const list = document.getElementById("history-list");
  try {
    const res  = await fetch("/history");
    const data = await res.json();
    if (!data.length) {
      list.innerHTML = '<div style="font-size:13px;color:var(--muted);text-align:center;padding:40px 0">No previous analyses found.</div>';
      return;
    }
    list.innerHTML = data.map(r => {
      const genre = GENRE_NAMES_H[r.genre] || r.genre || "—";
      const dur   = r.duration ? `${Math.floor(r.duration/60)}:${Math.floor(r.duration%60).toString().padStart(2,"0")}` : "—";
      const date  = new Date(r.mtime * 1000).toLocaleString([], {month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
      const issues = r.issues > 0
        ? `<span style="color:var(--danger);font-size:10px">${r.issues} issues</span>`
        : `<span style="color:var(--ok);font-size:10px">Clean</span>`;
      return `<div style="position:relative;padding:12px;background:var(--bg3);border-radius:8px;margin-bottom:8px;border:1px solid transparent;transition:border-color 0.15s" onmouseenter="this.style.borderColor='var(--border2)'" onmouseleave="this.style.borderColor='transparent'">
        <div onclick="loadHistoryReport('${r.report_id}')" style="cursor:pointer;padding-right:28px">
          <div style="font-family:var(--font-head);font-size:13px;font-weight:600;color:var(--text);margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.file || "Unknown"}</div>
          <div style="display:flex;align-items:center;gap:8px;font-size:11px;color:var(--muted)">
            <span>${genre}</span><span>·</span><span>${dur}</span><span>·</span>${issues}
          </div>
          <div style="font-size:10px;color:var(--muted);opacity:0.5;margin-top:3px">${date}</div>
        </div>
        <button onclick="event.stopPropagation();deleteHistoryEntry('${r.report_id}', this.closest('div[style*=\\'position:relative\\']'))" title="Delete this analysis" style="position:absolute;top:10px;right:10px;background:transparent;border:none;color:var(--muted);font-size:14px;cursor:pointer;padding:4px 8px;border-radius:4px;opacity:0.5;transition:all 0.15s" onmouseover="this.style.opacity='1';this.style.color='var(--danger)';this.style.background='rgba(255,95,87,0.08)'" onmouseout="this.style.opacity='0.5';this.style.color='var(--muted)';this.style.background='transparent'">🗑</button>
      </div>`;
    }).join("");
  } catch(e) {
    list.innerHTML = '<div style="font-size:13px;color:var(--danger);text-align:center;padding:20px">Could not load history.</div>';
  }
}

async function deleteHistoryEntry(reportId, rowEl) {
  if (!confirm("Delete this analysis? This cannot be undone.")) return;
  try {
    const res = await fetch(`/report/${reportId}`, { method: "DELETE" });
    const data = await res.json();
    if (data.error) { alert("Could not delete: " + data.error); return; }

    // If the currently-open report was just deleted, clear the view
    if (typeof currentReportId !== "undefined" && currentReportId === reportId) {
      try { sessionStorage.removeItem("mix_analyzer_report"); } catch(e) {}
      if (typeof resultsPanel !== "undefined" && resultsPanel) resultsPanel.classList.add("hidden");
      if (typeof uploadPanel !== "undefined" && uploadPanel) uploadPanel.classList.remove("hidden");
      const vb = document.getElementById("mix-version-banner");
      if (vb) vb.style.display = "none";
      if (typeof closeMixDiffCard === "function") closeMixDiffCard();
      if (typeof closeMixTimelineCard === "function") closeMixTimelineCard();
    }

    // Remove just this row from the history panel (no need to reload full list)
    if (rowEl && rowEl.parentNode) rowEl.parentNode.removeChild(rowEl);

    // If list is now empty, show the "no analyses" state
    const list = document.getElementById("history-list");
    if (list && !list.querySelector("div[style*='position:relative']")) {
      list.innerHTML = '<div style="font-size:13px;color:var(--muted);text-align:center;padding:40px 0">No previous analyses found.</div>';
    }
  } catch(e) {
    alert("Error deleting: " + e.message);
  }
}

async function loadHistoryReport(reportId) {
  toggleHistory();
  try {
    const res  = await fetch("/report/" + reportId);
    const data = await res.json();
    if (data.error) { alert("Could not load report: " + data.error); return; }
    window._currentReport = data;
    currentReportId = data.report_id || reportId;
    try { sessionStorage.setItem("mix_analyzer_report", JSON.stringify(data)); } catch(e) {}
    uploadPanel.classList.add("hidden");
    renderResults(data);
    resultsPanel.classList.remove("hidden");
    requestAnimationFrame(() => renderTimeline(data));
    // Reset AI panel
    document.getElementById("ai-results").classList.add("hidden");
    document.getElementById("ai-loading").classList.add("hidden");
    document.getElementById("ai-key-row").style.display = "";
    document.getElementById("ai-key-row").style.opacity = "1";
    document.getElementById("ai-badge").style.display = "none";
    document.getElementById("btn-get-advice").disabled = false;
    fetch("/config").then(r => r.json()).then(cfg => {
      if (cfg.has_api_key) {
        const input = document.getElementById("api-key-input");
        if (input) input.replaceWith(Object.assign(document.createElement("span"), {
          style: "font-size:13px;color:var(--ok);align-self:center",
          textContent: "✓ API key loaded from environment"
        }));
      }
    });
  } catch(e) {
    alert("Error loading report: " + e.message);
  }
}


/* ═══════════════════════════════════════════════════════════════════════════
   Mix versioning — banner, diff, timeline, delete
   Mirrors the stems versioning pattern. Project linkage is by normalized filename.
   ═══════════════════════════════════════════════════════════════════════════ */

async function renderMixVersionBanner(r) {
  const banner = document.getElementById("mix-version-banner");
  if (!banner) return;
  if (!r.previous_version || !r.version || r.version < 2) {
    banner.style.display = "none";
    return;
  }
  const prev = r.previous_version;
  const ts = prev.created_at
    ? new Date(prev.created_at * 1000).toLocaleString([], {month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})
    : "earlier";

  // Fetch full list of prior versions of this project for the picker
  let priorVersions = [];
  try {
    if (r.mix_project_id) {
      const res = await fetch(`/mix-project/${r.mix_project_id}`);
      const j = await res.json();
      if (j.versions && j.versions.length) {
        priorVersions = j.versions
          .filter(v => v.report_id !== r.report_id)
          .sort((a, b) => (b.version || 0) - (a.version || 0));
      }
    }
  } catch(e) { /* fall back to single-version button */ }

  const currentId = r.report_id;
  let compareControl;
  if (priorVersions.length > 1) {
    const opts = priorVersions.map(v => {
      const vts = v.created_at
        ? new Date(v.created_at * 1000).toLocaleString([], {month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})
        : "";
      return `<option value="${v.report_id}">v${v.version} — ${vts}</option>`;
    }).join("");
    compareControl = `
      <select id="mix-compare-picker" style="padding:6px 10px;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-family:var(--font-mono);font-size:12px;cursor:pointer">${opts}</select>
      <button onclick="loadMixDiffFromPicker('${currentId}')" style="padding:6px 14px;background:var(--accent);color:#0d0d0f;border:none;border-radius:6px;font-family:var(--font-mono);font-size:12px;font-weight:600;cursor:pointer">Compare</button>`;
  } else {
    compareControl = `<button onclick="loadMixDiff('${prev.report_id}','${currentId}')" style="padding:6px 14px;background:var(--accent);color:#0d0d0f;border:none;border-radius:6px;font-family:var(--font-mono);font-size:12px;font-weight:600;cursor:pointer">Compare with v${prev.version}</button>`;
  }

  const timelineBtn = (r.project_versions_total && r.project_versions_total >= 3)
    ? `<button onclick="loadMixTimeline('${r.mix_project_id}')" style="padding:6px 14px;background:transparent;border:1px solid var(--border2);border-radius:6px;font-family:var(--font-mono);font-size:12px;color:var(--muted);cursor:pointer">Timeline (${r.project_versions_total} versions)</button>`
    : "";

  const deleteBtn = r.mix_project_id
    ? `<button onclick="deleteMixProject('${r.mix_project_id}', ${r.project_versions_total || 1})" title="Delete all versions of this project" style="padding:6px 10px;background:transparent;border:1px solid rgba(255,95,87,0.3);border-radius:6px;font-family:var(--font-mono);font-size:12px;color:var(--danger);cursor:pointer;transition:background 0.15s" onmouseover="this.style.background='rgba(255,95,87,0.08)'" onmouseout="this.style.background='transparent'">🗑</button>`
    : "";

  banner.style.display = "block";
  banner.innerHTML = `
    <div style="background:rgba(123,97,255,0.06);border:1px solid rgba(123,97,255,0.25);border-radius:10px;padding:14px 18px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:24px">
      <div style="font-size:13px;color:var(--text);line-height:1.5;flex:1;min-width:200px">
        <span style="color:var(--accent2);font-weight:600">v${r.version} of this mix detected.</span>
        <span style="color:var(--muted);margin-left:8px">Previous analysis (v${prev.version}) was ${ts}.</span>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        ${compareControl}
        ${timelineBtn}
        ${deleteBtn}
        <button onclick="dismissMixVersionBanner()" title="Dismiss" style="padding:6px 10px;background:transparent;border:1px solid rgba(255,255,255,0.1);border-radius:6px;font-family:var(--font-mono);font-size:14px;color:var(--muted);cursor:pointer;line-height:1;transition:all 0.15s" onmouseover="this.style.background='rgba(255,255,255,0.05)';this.style.color='var(--text)'" onmouseout="this.style.background='transparent';this.style.color='var(--muted)'">×</button>
      </div>
    </div>`;
}

function dismissMixVersionBanner() {
  const banner = document.getElementById("mix-version-banner");
  if (banner) banner.style.display = "none";
}

function loadMixDiffFromPicker(currentId) {
  const picker = document.getElementById("mix-compare-picker");
  if (!picker) return;
  const pickedId = picker.value;
  if (!pickedId) return;
  loadMixDiff(pickedId, currentId);
}

async function loadMixDiff(oldId, newId) {
  try {
    const res  = await fetch(`/mix-diff/${oldId}/${newId}`);
    const data = await res.json();
    if (data.error) { alert("Could not load diff: " + data.error); return; }
    renderMixDiffCard(data);
  } catch(e) {
    alert("Error loading diff: " + e.message);
  }
}

function renderMixDiffCard(d) {
  const card = document.getElementById("mix-diff-card");
  if (!card) return;
  card.style.display = "";

  document.getElementById("mix-diff-title").textContent =
    `Diff: v${d.old_version || "?"} → v${d.new_version || "?"}`;

  const fixCount = d.fixes.length;
  const regCount = d.regressions.length;
  const neuCount = d.neutral.length;
  document.getElementById("mix-diff-summary").innerHTML =
    `Issues: <strong>${d.old_issues} → ${d.new_issues}</strong> &nbsp;·&nbsp; ${fixCount} improved &nbsp;·&nbsp; ${regCount} regressed &nbsp;·&nbsp; ${neuCount} changed (neutral)`;

  const categoryLabel = c => ({loudness:"Loudness", stereo:"Stereo", spectrum:"Spectral"})[c] || c;

  // Key-metrics chip row at the top — gives an at-a-glance summary of the
  // same 5 numbers shown in the meter strip.
  // Look for each metric by name across all diff items (fix/regression/neutral).
  const allItems = [...d.fixes, ...d.regressions, ...d.neutral];
  const findItem = (metricName) => allItems.find(i =>
    i.name.toLowerCase() === metricName.toLowerCase()
  );
  const keyMetrics = [
    { label: "LUFS",       name: "Integrated LUFS", unit: " LUFS", lowerBetter: false },
    { label: "True peak",  name: "True peak",       unit: " dBFS", lowerBetter: true },
    { label: "Crest",      name: "Crest factor",    unit: " dB",   lowerBetter: false },
    { label: "L/R corr",   name: "L/R correlation", unit: "",      lowerBetter: false },
    { label: "Width",      name: "Stereo width",    unit: " dB",   lowerBetter: false },
  ];

  const keyChipHtml = keyMetrics.map(m => {
    const item = findItem(m.name);
    if (!item) {
      return `<div style="flex:1;min-width:110px;padding:10px 12px;background:var(--bg3);border-radius:6px;border:1px solid var(--border)">
        <div style="font-size:9px;color:var(--muted);letter-spacing:0.08em;text-transform:uppercase;font-family:var(--font-head);font-weight:600;margin-bottom:4px">${m.label}</div>
        <div style="font-family:var(--font-mono);font-size:12px;color:var(--muted)">— unchanged</div>
      </div>`;
    }
    const sign  = item.delta > 0 ? "+" : "";
    const color = item.direction === "fix" ? "var(--ok)"
                : item.direction === "regression" ? "var(--danger)"
                : "var(--muted)";
    return `<div style="flex:1;min-width:110px;padding:10px 12px;background:var(--bg3);border-radius:6px;border:1px solid var(--border)">
      <div style="font-size:9px;color:var(--muted);letter-spacing:0.08em;text-transform:uppercase;font-family:var(--font-head);font-weight:600;margin-bottom:4px">${m.label}</div>
      <div style="font-family:var(--font-mono);font-size:11px;color:var(--muted);line-height:1.4">
        ${item.old}${m.unit} <span style="color:var(--muted);opacity:0.6">→</span> <span style="color:var(--text)">${item.new}${m.unit}</span>
      </div>
      <div style="font-family:var(--font-mono);font-size:12px;color:${color};font-weight:600;margin-top:3px">${sign}${item.delta}${m.unit}</div>
    </div>`;
  }).join("");

  const keyChipsBlock = `<div style="display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap">${keyChipHtml}</div>`;

  const row = (item, cls) => {
    const deltaColor = item.direction === "fix" ? "var(--ok)" :
                       item.direction === "regression" ? "var(--danger)" :
                       "var(--muted)";
    const sign = item.delta > 0 ? "+" : "";
    const catBadge = `<span style="font-size:10px;color:var(--accent2);background:rgba(123,97,255,0.1);padding:1px 6px;border-radius:3px;margin-left:8px;font-family:var(--font-mono)">${categoryLabel(item.category)}</span>`;
    return `<div class="diff-row ${cls}" style="display:flex;align-items:center;gap:12px;padding:10px 14px;border-left:2px solid;border-radius:4px;margin-bottom:6px">
      <div style="flex:1;font-family:var(--font-mono);font-size:13px;color:var(--text)">${item.name}${catBadge}</div>
      <div style="display:flex;align-items:center;gap:8px;font-size:11px;font-family:var(--font-mono)">
        <span style="color:var(--muted)">${item.old}${item.unit ? " " + item.unit : ""}</span>
        <span style="color:var(--muted)">→</span>
        <span style="color:var(--text)">${item.new}${item.unit ? " " + item.unit : ""}</span>
        <span style="color:${deltaColor};font-weight:600;margin-left:4px">${sign}${item.delta}${item.unit ? " " + item.unit : ""}</span>
      </div>
    </div>`;
  };

  let html = keyChipsBlock;  // prepend the key-metrics chips
  if (fixCount) {
    html += `<div class="diff-section"><div class="diff-section-head" style="font-family:var(--font-head);font-size:12px;font-weight:600;color:var(--ok);letter-spacing:0.08em;text-transform:uppercase;margin:14px 0 8px">✓ Improved (${fixCount})</div>`;
    html += d.fixes.map(f => row(f, "diff-fix")).join("");
    html += `</div>`;
  }
  if (regCount) {
    html += `<div class="diff-section"><div class="diff-section-head" style="font-family:var(--font-head);font-size:12px;font-weight:600;color:var(--danger);letter-spacing:0.08em;text-transform:uppercase;margin:14px 0 8px">✕ Regressed (${regCount})</div>`;
    html += d.regressions.map(f => row(f, "diff-regress")).join("");
    html += `</div>`;
  }
  if (neuCount) {
    html += `<div class="diff-section"><div class="diff-section-head" style="font-family:var(--font-head);font-size:12px;font-weight:600;color:var(--muted);letter-spacing:0.08em;text-transform:uppercase;margin:14px 0 8px">Changed (${neuCount})</div>`;
    html += d.neutral.map(f => row(f, "diff-resolved")).join("");
    html += `</div>`;
  }
  if (!fixCount && !regCount && !neuCount) {
    html += `<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px">No meaningful changes in any metric.</div>`;
  }

  document.getElementById("mix-diff-content").innerHTML = html;
  card.scrollIntoView({behavior: "smooth", block: "start"});
}

function closeMixDiffCard() {
  const card = document.getElementById("mix-diff-card");
  if (card) card.style.display = "none";
}

async function loadMixTimeline(projectId) {
  try {
    const res  = await fetch(`/mix-project/${projectId}`);
    const data = await res.json();
    if (data.error) { alert("Could not load timeline: " + data.error); return; }
    renderMixTimelineCard(data);
  } catch(e) {
    alert("Error loading timeline: " + e.message);
  }
}

function renderMixTimelineCard(proj) {
  const card = document.getElementById("mix-timeline-card");
  if (!card) return;
  card.style.display = "";
  const v = proj.versions || [];
  if (!v.length) {
    document.getElementById("mix-timeline-content").innerHTML =
      `<div style="color:var(--muted);font-size:13px;padding:12px">No versions found.</div>`;
    return;
  }

  // Bar per version, height proportional to issue count
  const maxIssues = Math.max(1, ...v.map(x => x.issues || 0));
  const bars = v.map(x => {
    const issues = x.issues || 0;
    const h = Math.max(4, (issues / maxIssues) * 80);
    const ts = x.created_at ? new Date(x.created_at * 1000).toLocaleDateString([], {month:"short",day:"numeric"}) : "";
    const color = issues === 0 ? "var(--ok)" : issues <= 4 ? "var(--warn)" : "var(--danger)";
    return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer" onclick="loadMixReportIntoView('${x.report_id}')" title="v${x.version}: ${issues} issues">
      <div style="font-size:11px;color:var(--muted);font-family:var(--font-mono)">${issues}</div>
      <div style="width:100%;max-width:60px;height:${h}px;background:${color};border-radius:4px 4px 0 0;opacity:0.85;transition:opacity 0.2s" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.85'"></div>
      <div style="font-family:var(--font-head);font-size:12px;font-weight:700;color:var(--text)">v${x.version}</div>
      <div style="font-size:10px;color:var(--muted);font-family:var(--font-mono)">${ts}</div>
    </div>`;
  }).join("");

  let trend = "";
  if (v.length >= 2) {
    const first = v[0].issues || 0;
    const last  = v[v.length-1].issues || 0;
    const delta = last - first;
    if (delta < 0) trend = `<span style="color:var(--ok)">↓ ${-delta} fewer issues since v1</span>`;
    else if (delta > 0) trend = `<span style="color:var(--danger)">↑ ${delta} more issues since v1</span>`;
    else trend = `<span style="color:var(--muted)">Issue count unchanged since v1</span>`;
  }

  document.getElementById("mix-timeline-content").innerHTML = `
    <div style="font-size:12px;color:var(--muted);margin-bottom:14px">${trend} &nbsp;·&nbsp; <span style="color:var(--muted)">Click a bar to open that version</span></div>
    <div style="display:flex;gap:8px;align-items:flex-end;padding:12px 4px;background:var(--bg3);border-radius:8px;min-height:130px">${bars}</div>
  `;
  card.scrollIntoView({behavior: "smooth", block: "start"});
}

function closeMixTimelineCard() {
  const card = document.getElementById("mix-timeline-card");
  if (card) card.style.display = "none";
}

async function loadMixReportIntoView(reportId) {
  // Re-use the existing loadHistoryReport logic — it already handles loading a saved mix report
  if (typeof loadHistoryReport === "function") {
    await loadHistoryReport(reportId);
    closeMixTimelineCard();
    closeMixDiffCard();
  }
}

async function deleteMixProject(projectId, versionCount) {
  const n = versionCount || 1;
  const msg = `Delete all ${n} version${n === 1 ? "" : "s"} of this mix project?\n\nThis will permanently remove every mix analysis tied to this project from your local reports folder. This cannot be undone.`;
  if (!confirm(msg)) return;
  try {
    const res = await fetch(`/mix-project/${projectId}`, { method: "DELETE" });
    const data = await res.json();
    if (data.error) { alert("Could not delete project: " + data.error); return; }

    // Clear view and return to upload state
    try { sessionStorage.removeItem("mix_analyzer_report"); } catch(e) {}
    if (typeof resultsPanel !== "undefined" && resultsPanel) resultsPanel.classList.add("hidden");
    if (typeof uploadPanel !== "undefined" && uploadPanel) uploadPanel.classList.remove("hidden");
    closeMixDiffCard();
    closeMixTimelineCard();
    const vb = document.getElementById("mix-version-banner");
    if (vb) vb.style.display = "none";

    alert(`Deleted ${data.deleted_count} report${data.deleted_count === 1 ? "" : "s"}. Starting fresh.`);
  } catch(e) {
    alert("Error deleting project: " + e.message);
  }
}


/* ═══════════════════════════════════════════════════════════════════════════
   Floating nav — show/hide on scroll
   Appears when scrolled past the main header (~80 px), hides at the top.
   ═══════════════════════════════════════════════════════════════════════════ */
(function() {
  const nav = document.querySelector(".floating-nav");
  if (!nav) return;
  const THRESHOLD = 80;  // px scrolled before showing
  let ticking = false;

  function update() {
    if (window.scrollY > THRESHOLD) nav.classList.add("visible");
    else                            nav.classList.remove("visible");
    ticking = false;
  }

  window.addEventListener("scroll", () => {
    if (!ticking) {
      window.requestAnimationFrame(update);
      ticking = true;
    }
  }, { passive: true });

  // Initial check (in case page is loaded scrolled, e.g. via hash)
  update();
})();
