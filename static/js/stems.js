/* stems.js — Stem analysis frontend */

const BAND_LABELS = { sub: "Sub", bass: "Bass", low_mid: "Low mid", mid: "Mid", presence: "Presence", air: "Air" };
const COLORS = ["#c8f050","#7b61ff","#ff5f57","#30d158","#f5a623","#64d2ff","#bf5af2","#ff9f0a"];

let stemFiles = [];

/* ── Restore previous stem session ── */
(function restoreStemSession() {
  try {
    const saved = sessionStorage.getItem("stem_results");
    if (!saved) return;
    const data = JSON.parse(saved);
    if (!data.stems || !data.summary) return;
    // Show restore banner
    const banner = document.createElement("div");
    banner.id = "stem-restore-banner";
    banner.style.cssText = "background:rgba(200,240,80,0.06);border:1px solid rgba(200,240,80,0.2);border-radius:8px;padding:12px 16px;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between;font-size:13px";
    banner.innerHTML = `<span style="color:var(--accent)">Previous stem analysis available (${data.summary.stem_count} stems)</span>
      <div style="display:flex;gap:8px">
        <button onclick="restoreStemData()" style="padding:6px 14px;background:var(--accent);color:#0d0d0f;border:none;border-radius:6px;font-family:var(--font-mono);font-size:12px;font-weight:500;cursor:pointer">Restore</button>
        <button onclick="document.getElementById('stem-restore-banner').remove();sessionStorage.removeItem('stem_results')" style="padding:6px 14px;background:transparent;border:1px solid var(--border2);border-radius:6px;font-family:var(--font-mono);font-size:12px;color:var(--muted);cursor:pointer">Dismiss</button>
      </div>`;
    document.querySelector("main").prepend(banner);
    window._savedStemData = data;
  } catch(e) {}
})();

function restoreStemData() {
  if (!window._savedStemData) return;
  document.getElementById("stem-restore-banner")?.remove();
  document.getElementById("btn-analyze").style.display = "none";
  document.getElementById("progress-panel").classList.add("hidden");
  renderResults(window._savedStemData);
  document.getElementById("results").classList.remove("hidden");
}

/* ── File handling ── */
function handleDrop(e) {
  e.preventDefault();
  document.getElementById("drop-zone").classList.remove("drag-over");
  handleFiles(e.dataTransfer.files);
}

function handleFiles(files) {
  const allowed = ["wav","wave","aif","aiff","flac"];
  [...files].forEach(file => {
    const ext = file.name.split(".").pop().toLowerCase();
    if (!allowed.includes(ext)) return;
    if (stemFiles.find(f => f.file.name === file.name)) return; // dedupe
    const label = (() => {
      const base  = file.name.replace(/\.[^.]+$/, "");  // remove extension
      const parts = base.split(" - ");
      if (parts.length >= 4) return parts.slice(3).join(" - ").trim();  // Cubase: skip project/number/type
      if (parts.length >= 3) return parts.slice(2).join(" - ").trim();
      return base.replace(/^[a-f0-9_-]+_?/, "").replace(/^\d+[-_\s]/, "").trim();
    })();
    stemFiles.push({ file, label });
  });
  renderStemList();
}

function renderStemList() {
  const list = document.getElementById("stem-list");
  list.innerHTML = stemFiles.map((s, i) => `
    <div class="stem-item">
      <span style="width:10px;height:10px;border-radius:50%;background:${COLORS[i % COLORS.length]};flex-shrink:0"></span>
      <span class="stem-item-name">${s.file.name}</span>
      <input class="stem-label-input" value="${s.label}" placeholder="Label" oninput="stemFiles[${i}].label=this.value" />
      <button class="stem-remove" onclick="removeStem(${i})">×</button>
    </div>`).join("");

  const count = stemFiles.length;
  const btn = document.getElementById("btn-analyze");
  btn.style.display = count >= 2 ? "block" : "none";
  btn.textContent = count > 12
    ? `Analyze ${count} stems (may take 2–5 min) →`
    : `Analyze ${count} stem${count !== 1 ? "s" : ""} →`;

  // Warning for large stem counts
  let warn = document.getElementById("stem-count-warn");
  if (!warn) {
    warn = document.createElement("div");
    warn.id = "stem-count-warn";
    warn.style.cssText = "font-size:12px;color:var(--warn);margin:-8px 0 12px;padding:10px 14px;background:rgba(245,166,35,0.06);border-radius:6px;border:1px solid rgba(245,166,35,0.2)";
    document.getElementById("btn-analyze").before(warn);
  }
  warn.style.display = count > 12 ? "block" : "none";
  warn.textContent = `⚠ ${count} stems = ${Math.floor(count*(count-1)/2)} comparisons. Consider using only your bus/group channels for a faster analysis.`;
}

function removeStem(i) {
  stemFiles.splice(i, 1);
  renderStemList();
}

/* ── Analysis ── */
async function runAnalysis() {
  const form = new FormData();
  stemFiles.forEach(s => {
    form.append("stems", s.file);
    form.append("names",  s.label);
  });

  document.getElementById("btn-analyze").style.display = "none";
  document.getElementById("results").classList.add("hidden");
  document.getElementById("progress-panel").classList.remove("hidden");

  const steps = [
    [20, "Loading stems…"],
    [40, "Measuring frequency profiles…"],
    [60, "Analysing stem pairs…"],
    [80, "Detecting masking conflicts…"],
    [95, "Building recommendations…"],
  ];
  let si = 0;
  const timer = setInterval(() => {
    if (si < steps.length) {
      document.getElementById("progress-fill").style.width = steps[si][0] + "%";
      document.getElementById("progress-label").textContent = steps[si][1];
      si++;
    }
  }, 800);

  try {
    const res  = await fetch("/analyze-stems", { method: "POST", body: form });
    const data = await res.json();
    clearInterval(timer);
    document.getElementById("progress-fill").style.width = "100%";
    document.getElementById("progress-label").textContent = "Done!";

    if (data.error) { alert("Error: " + data.error); return; }

    setTimeout(() => {
      document.getElementById("progress-panel").classList.add("hidden");
      renderResults(data);
      document.getElementById("results").classList.remove("hidden");
    }, 400);

  } catch (err) {
    clearInterval(timer);
    alert("Error: " + err.message);
  }
}


/* ── EQ curve renderer ── */
const BAND_HZ = {
  sub: 50, bass: 160, low_mid: 400, mid: 1200, presence: 4000, air: 10000
};
const BAND_Q = {
  sub: 0.7, bass: 1.0, low_mid: 1.2, mid: 1.4, presence: 1.2, air: 0.7
};
const CUT_TYPE = {
  sub: "hp", bass: "bell", low_mid: "bell", mid: "bell", presence: "bell", air: "shelf"
};

function freqToX(freq, W, minHz=20, maxHz=20000) {
  return (Math.log10(freq / minHz) / Math.log10(maxHz / minHz)) * W;
}

function bellResponse(freq, centerHz, gainDb, Q) {
  // Simplified RBJ peaking EQ transfer function magnitude
  const w  = 2 * Math.PI * freq;
  const w0 = 2 * Math.PI * centerHz;
  const A  = Math.pow(10, gainDb / 40);
  const bw = w0 / Q;
  const num = (w0*w0 - w*w) * (w0*w0 - w*w) + (w*bw*A) * (w*bw*A);
  const den = (w0*w0 - w*w) * (w0*w0 - w*w) + (w*bw/A) * (w*bw/A);
  return 10 * Math.log10(num / den) / 2;
}

function shelfResponse(freq, cornerHz, gainDb, isHigh) {
  // Simplified high/low shelf response
  const ratio = isHigh ? freq / cornerHz : cornerHz / freq;
  const t = Math.atan(Math.log10(ratio) * 3);
  return gainDb * (0.5 + t / Math.PI);
}

function hpResponse(freq, cornerHz) {
  // High-pass approximation
  if (freq < cornerHz * 0.5) return -24;
  if (freq < cornerHz) return -6 * Math.log2(cornerHz / freq);
  return 0;
}

function drawEQCurve(canvas, band, gainDb) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.offsetWidth  || 240;
  const H   = canvas.offsetHeight || 60;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);

  const centerHz  = BAND_HZ[band]  || 1000;
  const Q         = BAND_Q[band]   || 1.2;
  const cutType   = CUT_TYPE[band] || "bell";
  const midY      = H / 2;
  const dbRange   = 12; // ±12 dB display range

  // Background grid
  ctx.fillStyle = "rgba(28,28,34,0.8)";
  ctx.fillRect(0, 0, W, H);

  // Zero line
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth   = 0.5;
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(W, midY); ctx.stroke();
  ctx.setLineDash([]);

  // Frequency grid lines (octaves)
  [50,100,200,500,1000,2000,5000,10000].forEach(hz => {
    const x = freqToX(hz, W);
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth   = 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  });

  // Center frequency marker
  const cx = freqToX(centerHz, W);
  ctx.strokeStyle = "rgba(255,95,87,0.3)";
  ctx.lineWidth   = 1;
  ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
  ctx.setLineDash([]);

  // EQ curve
  ctx.beginPath();
  const freqs = [];
  for (let i = 0; i <= W; i++) {
    const logMin = Math.log10(20), logMax = Math.log10(20000);
    const hz = Math.pow(10, logMin + (i / W) * (logMax - logMin));
    freqs.push(hz);
  }

  let started = false;
  freqs.forEach((hz, i) => {
    let db = 0;
    if (cutType === "bell") {
      db = bellResponse(hz, centerHz, -gainDb, Q);
    } else if (cutType === "shelf") {
      db = shelfResponse(hz, centerHz, -gainDb, true);
    } else if (cutType === "hp") {
      db = hpResponse(hz, centerHz);
    }

    const x = i;
    const y = midY - (db / dbRange) * (H / 2 - 4);
    const yc = Math.max(4, Math.min(H - 4, y));

    if (!started) { ctx.moveTo(x, yc); started = true; }
    else ctx.lineTo(x, yc);
  });

  ctx.strokeStyle = "#ff5f57";
  ctx.lineWidth   = 1.5;
  ctx.lineJoin    = "round";
  ctx.stroke();

  // Fill under/above curve
  ctx.lineTo(W, midY); ctx.lineTo(0, midY); ctx.closePath();
  ctx.fillStyle = "rgba(255,95,87,0.08)";
  ctx.fill();

  // dB label
  ctx.fillStyle = "rgba(255,95,87,0.7)";
  ctx.font = `${10 * dpr}px monospace`;
  ctx.scale(1/dpr, 1/dpr);
  ctx.fillText("-" + gainDb.toFixed(1) + " dB", 4 * dpr, (H - 4) * dpr);
  const hzLabel = centerHz >= 1000 ? (centerHz/1000).toFixed(1) + "k" : centerHz + " Hz";
  ctx.fillText(hzLabel, (cx - 10) * dpr, 12 * dpr);
}

/* ── Render ── */
function renderResults(data) {
  const s = data.summary;

  // Banner
  const banner = document.getElementById("summary-banner");
  const total  = s.severe_conflicts + s.moderate_conflicts;
  let versionBadge = "";
  if (data.version && data.version > 1) {
    versionBadge = ` <span style="background:rgba(200,240,80,0.12);color:var(--accent);padding:2px 8px;border-radius:4px;font-size:11px;margin-left:6px">v${data.version}</span>`;
  }
  if (total === 0) {
    banner.className = "issue-banner none";
    banner.innerHTML = `✓ No significant masking detected across ${s.stem_count} stems.${versionBadge}`;
  } else if (s.severe_conflicts > 0) {
    banner.className = "issue-banner many";
    banner.innerHTML = `✕ ${s.severe_conflicts} severe + ${s.moderate_conflicts} moderate masking conflicts across ${s.stem_count} stems.${versionBadge}`;
  } else {
    banner.className = "issue-banner few";
    banner.innerHTML = `⚠ ${s.moderate_conflicts} moderate masking conflicts across ${s.stem_count} stems.${versionBadge}`;
  }

  // Version banner — only when a previous version was auto-matched
  renderVersionBanner(data);

  renderMatrix(data);
  renderFingerprints(data);
  renderEnergyShare(data);
  renderRecommendations(data);
  renderStemActionSummary(data.action_summary);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Action summary renderer for stems page
   Mirrors the main-analyzer version — same tier structure, same DOM pattern.
   ═══════════════════════════════════════════════════════════════════════════ */
function renderStemActionSummary(summary) {
  const card = document.getElementById("stem-action-summary-card");
  if (!card) return;
  if (!summary || summary.total_actions === 0) {
    card.style.display = "none";
    return;
  }
  card.style.display = "";

  const tierMeta = {
    fix_before_bounce: {
      label: "Fix before bounce",
      desc:  "Severe masking and phase issues — will audibly hurt the mix.",
      color: "var(--danger)",
      bg:    "rgba(255,95,87,0.05)",
      border:"rgba(255,95,87,0.25)",
      dotBg: "rgba(255,95,87,0.18)",
    },
    worth_fixing: {
      label: "Worth fixing",
      desc:  "Moderate masking that will clean up separation when resolved.",
      color: "var(--warn)",
      bg:    "rgba(245,166,35,0.04)",
      border:"rgba(245,166,35,0.22)",
      dotBg: "rgba(245,166,35,0.18)",
    },
    polish: {
      label: "Polish",
      desc:  "Mild masking — optional tweaks for extra clarity.",
      color: "var(--accent2)",
      bg:    "rgba(123,97,255,0.04)",
      border:"rgba(123,97,255,0.2)",
      dotBg: "rgba(123,97,255,0.15)",
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
            const itemId = `stem-action-${tierKey}-${idx}`;
            const loc = it.location ? `<span style="font-size:10px;color:var(--muted);font-family:var(--font-mono);background:${meta.dotBg};padding:2px 7px;border-radius:3px;margin-left:8px">${it.location}</span>` : "";
            return `
              <div style="padding:12px 14px;background:${meta.bg};border:1px solid ${meta.border};border-radius:6px">
                <div onclick="toggleStemActionItem('${itemId}')" style="display:flex;align-items:center;gap:10px;cursor:pointer">
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

function toggleStemActionItem(id) {
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

/* ── Version banner (auto-match previous version) ── */
async function renderVersionBanner(data) {
  const banner = document.getElementById("version-banner");
  if (!banner) return;
  if (!data.previous_version || !data.version || data.version < 2) {
    banner.style.display = "none";
    return;
  }
  const prev = data.previous_version;
  const ts = prev.created_at ? new Date(prev.created_at * 1000).toLocaleString([], {month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}) : "earlier";

  // Fetch full list of versions for this project so we can build a picker
  let priorVersions = [];
  try {
    if (data.project_id) {
      const r = await fetch(`/stem-project/${data.project_id}`);
      const j = await r.json();
      if (j.versions && j.versions.length) {
        // Exclude the current (just-analyzed) version itself; keep the rest sorted newest→oldest
        priorVersions = j.versions
          .filter(v => v.report_id !== data.stem_report_id)
          .sort((a, b) => (b.version || 0) - (a.version || 0));
      }
    }
  } catch (e) { /* graceful fallback below */ }

  // Build picker options — if multiple versions exist, offer a dropdown; otherwise single button
  const currentId = data.stem_report_id;
  let compareControl;
  if (priorVersions.length > 1) {
    const opts = priorVersions.map(v => {
      const vts = v.created_at ? new Date(v.created_at * 1000).toLocaleString([], {month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}) : "";
      return `<option value="${v.report_id}">v${v.version} — ${vts}</option>`;
    }).join("");
    compareControl = `
      <select id="compare-picker" style="padding:6px 10px;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-family:var(--font-mono);font-size:12px;cursor:pointer">${opts}</select>
      <button onclick="loadDiffFromPicker('${currentId}')" style="padding:6px 14px;background:var(--accent);color:#0d0d0f;border:none;border-radius:6px;font-family:var(--font-mono);font-size:12px;font-weight:600;cursor:pointer">Compare</button>`;
  } else {
    compareControl = `<button onclick="loadDiff('${prev.stem_report_id}','${currentId}')" style="padding:6px 14px;background:var(--accent);color:#0d0d0f;border:none;border-radius:6px;font-family:var(--font-mono);font-size:12px;font-weight:600;cursor:pointer">Compare with v${prev.version}</button>`;
  }

  const timelineBtn = (data.project_versions_total && data.project_versions_total >= 3)
    ? `<button onclick="loadTimeline('${data.project_id}')" style="padding:6px 14px;background:transparent;border:1px solid var(--border2);border-radius:6px;font-family:var(--font-mono);font-size:12px;color:var(--muted);cursor:pointer">Timeline (${data.project_versions_total} versions)</button>`
    : "";

  const deleteBtn = data.project_id
    ? `<button onclick="deleteProject('${data.project_id}', ${data.project_versions_total || 1})" title="Delete all versions of this project" style="padding:6px 10px;background:transparent;border:1px solid rgba(255,95,87,0.3);border-radius:6px;font-family:var(--font-mono);font-size:12px;color:var(--danger);cursor:pointer;transition:background 0.15s" onmouseover="this.style.background='rgba(255,95,87,0.08)'" onmouseout="this.style.background='transparent'">🗑</button>`
    : "";

  banner.style.display = "block";
  banner.innerHTML = `
    <div style="background:rgba(123,97,255,0.06);border:1px solid rgba(123,97,255,0.25);border-radius:10px;padding:14px 18px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap">
      <div style="font-size:13px;color:var(--text);line-height:1.5">
        <span style="color:var(--accent2);font-weight:600">v${data.version} of this project detected.</span>
        <span style="color:var(--muted);margin-left:8px">Previous analysis (v${prev.version}) was ${ts}.</span>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        ${compareControl}
        ${timelineBtn}
        ${deleteBtn}
      </div>
    </div>`;
}

/* ── Delete all versions of a project ── */
async function deleteProject(projectId, versionCount) {
  const n = versionCount || 1;
  const msg = `Delete all ${n} version${n === 1 ? "" : "s"} of this project?\n\nThis will permanently remove every stem analysis tied to this project from your local reports folder. This cannot be undone.`;
  if (!confirm(msg)) return;

  try {
    const res = await fetch(`/stem-project/${projectId}`, { method: "DELETE" });
    const data = await res.json();
    if (data.error) { alert("Could not delete project: " + data.error); return; }

    // Clear the view and return to upload state
    try { sessionStorage.removeItem("stem_results"); } catch (e) {}
    if (typeof resetToUpload === "function") resetToUpload();

    alert(`Deleted ${data.deleted_count} report${data.deleted_count === 1 ? "" : "s"}. Starting fresh.`);
  } catch (e) {
    alert("Error deleting project: " + e.message);
  }
}

function loadDiffFromPicker(currentId) {
  const picker = document.getElementById("compare-picker");
  if (!picker) return;
  const pickedId = picker.value;
  if (!pickedId) return;
  loadDiff(pickedId, currentId);
}

/* ── Load + render diff ── */
async function loadDiff(oldId, newId) {
  try {
    const res  = await fetch(`/stem-diff/${oldId}/${newId}`);
    const data = await res.json();
    if (data.error) { alert("Could not load diff: " + data.error); return; }
    renderDiffCard(data);
  } catch (e) {
    alert("Error loading diff: " + e.message);
  }
}

function renderDiffCard(d) {
  const card = document.getElementById("diff-card");
  if (!card) return;
  card.style.display = "";

  document.getElementById("diff-title").textContent =
    `Diff: v${d.old_version || "?"} → v${d.new_version || "?"}`;

  const oldTot = (d.old_summary && (d.old_summary.severe_conflicts + d.old_summary.moderate_conflicts)) || 0;
  const newTot = (d.new_summary && (d.new_summary.severe_conflicts + d.new_summary.moderate_conflicts)) || 0;
  document.getElementById("diff-summary").innerHTML =
    `Issues: <strong>${oldTot} → ${newTot}</strong> &nbsp;·&nbsp; ${d.fixes.length} band fixes &nbsp;·&nbsp; ${d.regressions.length} band regressions &nbsp;·&nbsp; ${d.new_issues.length} new &nbsp;·&nbsp; ${d.resolved.length} resolved &nbsp;·&nbsp; ${d.unchanged_count} band conflicts unchanged`;

  const sevColor = s => ({severe:"var(--danger)", moderate:"var(--warn)", mild:"var(--accent2)", no_conflict:"var(--ok)"})[s] || "var(--muted)";
  const sevLabel = s => ({severe:"severe", moderate:"moderate", mild:"mild", no_conflict:"clean"})[s] || s;

  const row = (pair, oldSev, newSev, oldDelta, newDelta, band, cls) => {
    const ob = oldSev ? `<span style="color:${sevColor(oldSev)};font-size:11px">${sevLabel(oldSev)}</span>` : "—";
    const nb = newSev ? `<span style="color:${sevColor(newSev)};font-size:11px">${sevLabel(newSev)}</span>` : "—";

    // Compute improvement magnitude — HIGHER dB delta = better (more energy separation between
    // stems = less masking). So an increase in delta_db is an improvement.
    let improvement = "";
    if (oldDelta !== undefined && newDelta !== undefined && oldDelta !== null && newDelta !== null) {
      const diff = newDelta - oldDelta;  // positive = improvement (more separation)
      if (Math.abs(diff) >= 0.5) {
        const sign = diff > 0 ? "+" : "−";
        const color = diff > 0 ? "var(--ok)" : "var(--danger)";
        improvement = `<span style="font-size:10px;color:${color};margin-left:6px;font-weight:600">${sign}${Math.abs(diff).toFixed(1)} dB</span>`;
      }
      const deltaShown = `<span style="font-size:10px;color:var(--muted);margin-left:6px">(${oldDelta} → ${newDelta} dB)</span>`;
      improvement = deltaShown + improvement;
    } else if (oldDelta !== undefined && oldDelta !== null) {
      improvement = `<span style="font-size:10px;color:var(--muted);margin-left:6px">(was ${oldDelta} dB)</span>`;
    } else if (newDelta !== undefined && newDelta !== null) {
      improvement = `<span style="font-size:10px;color:var(--muted);margin-left:6px">(${newDelta} dB)</span>`;
    }

    const bandLabel = band
      ? `<span style="font-size:10px;color:var(--accent2);background:rgba(123,97,255,0.1);padding:1px 6px;border-radius:3px;margin-left:8px;font-family:var(--font-mono)">${(BAND_LABELS && BAND_LABELS[band]) || band}</span>`
      : "";
    return `<div class="diff-row ${cls}" style="display:flex;align-items:center;gap:12px;padding:10px 14px;border-left:2px solid;border-radius:4px;margin-bottom:6px">
      <div style="flex:1;font-family:var(--font-mono);font-size:13px;color:var(--text)">${pair}${bandLabel}</div>
      <div style="display:flex;align-items:center;gap:8px">
        ${ob} <span style="color:var(--muted);font-size:11px">→</span> ${nb} ${improvement}
      </div>
    </div>`;
  };

  let html = "";

  if (d.fixes.length) {
    html += `<div class="diff-section"><div class="diff-section-head" style="font-family:var(--font-head);font-size:12px;font-weight:600;color:var(--ok);letter-spacing:0.08em;text-transform:uppercase;margin:14px 0 8px">✓ Fixed (${d.fixes.length})</div>`;
    html += d.fixes.map(f => row(f.pair, f.old_severity, f.new_severity, f.old_delta_db, f.new_delta_db, f.band, "diff-fix")).join("");
    html += `</div>`;
  }
  if (d.regressions.length) {
    html += `<div class="diff-section"><div class="diff-section-head" style="font-family:var(--font-head);font-size:12px;font-weight:600;color:var(--danger);letter-spacing:0.08em;text-transform:uppercase;margin:14px 0 8px">✕ Regressed (${d.regressions.length})</div>`;
    html += d.regressions.map(f => row(f.pair, f.old_severity, f.new_severity, f.old_delta_db, f.new_delta_db, f.band, "diff-regress")).join("");
    html += `</div>`;
  }
  if (d.new_issues.length) {
    html += `<div class="diff-section"><div class="diff-section-head" style="font-family:var(--font-head);font-size:12px;font-weight:600;color:var(--danger);letter-spacing:0.08em;text-transform:uppercase;margin:14px 0 8px">! New issues (${d.new_issues.length})</div>`;
    html += d.new_issues.map(f => row(f.pair, null, f.new_severity, null, f.new_delta_db, f.band, "diff-new")).join("");
    html += `</div>`;
  }
  if (d.resolved.length) {
    html += `<div class="diff-section"><div class="diff-section-head" style="font-family:var(--font-head);font-size:12px;font-weight:600;color:var(--muted);letter-spacing:0.08em;text-transform:uppercase;margin:14px 0 8px">Pair no longer present (${d.resolved.length})</div>`;
    html += d.resolved.map(f => row(f.pair, f.old_severity, null, f.old_delta_db, null, f.band, "diff-resolved")).join("");
    html += `</div>`;
  }
  if (!d.fixes.length && !d.regressions.length && !d.new_issues.length && !d.resolved.length) {
    html = `<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px">No meaningful changes between these two versions. ${d.unchanged_count} band conflicts unchanged.</div>`;
  }

  document.getElementById("diff-content").innerHTML = html;
  card.scrollIntoView({behavior: "smooth", block: "start"});
}

function closeDiffCard() {
  const card = document.getElementById("diff-card");
  if (card) card.style.display = "none";
}

/* ── Timeline view (3+ versions) ── */
async function loadTimeline(projectId) {
  try {
    const res  = await fetch(`/stem-project/${projectId}`);
    const data = await res.json();
    if (data.error) { alert("Could not load timeline: " + data.error); return; }
    renderTimelineCard(data);
  } catch (e) {
    alert("Error loading timeline: " + e.message);
  }
}

function renderTimelineCard(proj) {
  const card = document.getElementById("timeline-card");
  if (!card) return;
  card.style.display = "";
  const v = proj.versions || [];
  if (!v.length) {
    document.getElementById("timeline-content").innerHTML =
      `<div style="color:var(--muted);font-size:13px;padding:12px">No versions found.</div>`;
    return;
  }

  // Simple chart: bar per version of severe+moderate count
  const maxIssues = Math.max(1, ...v.map(x => (x.severe || 0) + (x.moderate || 0)));
  const bars = v.map(x => {
    const issues = (x.severe || 0) + (x.moderate || 0);
    const h = Math.max(4, (issues / maxIssues) * 80);
    const ts = x.created_at ? new Date(x.created_at * 1000).toLocaleDateString([], {month:"short",day:"numeric"}) : "";
    const color = x.severe > 0 ? "var(--danger)" : x.moderate > 0 ? "var(--warn)" : "var(--ok)";
    return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer" onclick="loadStemReportIntoView('${x.report_id}')" title="v${x.version}: ${issues} issues">
      <div style="font-size:11px;color:var(--muted);font-family:var(--font-mono)">${issues}</div>
      <div style="width:100%;max-width:60px;height:${h}px;background:${color};border-radius:4px 4px 0 0;opacity:0.85;transition:opacity 0.2s" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.85'"></div>
      <div style="font-family:var(--font-head);font-size:12px;font-weight:700;color:var(--text)">v${x.version}</div>
      <div style="font-size:10px;color:var(--muted);font-family:var(--font-mono)">${ts}</div>
    </div>`;
  }).join("");

  const trend = v.length >= 2
    ? (() => {
        const first = (v[0].severe || 0) + (v[0].moderate || 0);
        const last  = (v[v.length-1].severe || 0) + (v[v.length-1].moderate || 0);
        const delta = last - first;
        if (delta < 0) return `<span style="color:var(--ok)">↓ ${-delta} fewer issues since v1</span>`;
        if (delta > 0) return `<span style="color:var(--danger)">↑ ${delta} more issues since v1</span>`;
        return `<span style="color:var(--muted)">Issue count unchanged since v1</span>`;
      })()
    : "";

  document.getElementById("timeline-content").innerHTML = `
    <div style="font-size:12px;color:var(--muted);margin-bottom:14px">${trend} &nbsp;·&nbsp; <span style="color:var(--muted)">Click a bar to open that version</span></div>
    <div style="display:flex;gap:8px;align-items:flex-end;padding:12px 4px;background:var(--bg3);border-radius:8px;min-height:130px">${bars}</div>
  `;
  card.scrollIntoView({behavior: "smooth", block: "start"});
}

function closeTimelineCard() {
  const card = document.getElementById("timeline-card");
  if (card) card.style.display = "none";
}

/* ── Reset to upload state (New analysis button) ── */
function resetToUpload() {
  // Hide all result-side UI
  const results = document.getElementById("results");
  if (results) results.classList.add("hidden");
  closeDiffCard();
  closeTimelineCard();

  // Clear the file list + stem state
  stemFiles = [];
  renderStemList();

  // Show upload UI again
  const dropZone   = document.getElementById("drop-zone");
  const fileList   = document.getElementById("file-list");
  const analyzeBtn = document.getElementById("btn-analyze");
  if (dropZone)   dropZone.style.display = "";
  if (fileList)   fileList.style.display = "";
  if (analyzeBtn) analyzeBtn.style.display = "none";  // no files picked yet

  // Drop restore-banner if present (user is starting fresh)
  document.getElementById("stem-restore-banner")?.remove();

  // Clear the session-restore payload too — user is moving on
  try { sessionStorage.removeItem("stem_results"); } catch (e) {}

  // Scroll back to the top
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ── Stem history panel ── */
function toggleStemHistory() {
  const panel   = document.getElementById("stem-history-panel");
  const overlay = document.getElementById("stem-history-overlay");
  if (!panel || !overlay) return;
  const open = panel.style.display === "block";
  panel.style.display   = open ? "none" : "block";
  overlay.style.display = open ? "none" : "block";
  if (!open) loadStemHistory();
}

async function loadStemHistory() {
  const list = document.getElementById("stem-history-list");
  if (!list) return;
  try {
    const res  = await fetch("/stem-history");
    const data = await res.json();
    if (!data.length) {
      list.innerHTML = '<div style="font-size:13px;color:var(--muted);text-align:center;padding:40px 0">No previous stem analyses found.</div>';
      return;
    }
    list.innerHTML = data.map(r => {
      const names = r.stem_names || [];
      const preview = names.length <= 3
        ? names.join(" · ")
        : `${names.slice(0, 3).join(" · ")} +${names.length - 3}`;
      const title = `${r.stem_count} stem${r.stem_count === 1 ? "" : "s"}${r.version && r.version > 1 ? ` · v${r.version}` : ""}`;
      const date = new Date(r.mtime * 1000).toLocaleString([], {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
      });
      let status;
      if (r.severe > 0) {
        status = `<span style="color:var(--danger);font-size:10px">${r.severe} severe</span>`;
      } else if (r.moderate > 0) {
        status = `<span style="color:var(--warn);font-size:10px">${r.moderate} moderate</span>`;
      } else if (r.total_recs > 0) {
        status = `<span style="color:var(--muted);font-size:10px">${r.total_recs} recs</span>`;
      } else {
        status = `<span style="color:var(--ok);font-size:10px">Clean</span>`;
      }
      return `<div style="position:relative;padding:12px;background:var(--bg3);border-radius:8px;margin-bottom:8px;border:1px solid transparent;transition:border-color 0.15s" onmouseenter="this.style.borderColor='var(--border2)'" onmouseleave="this.style.borderColor='transparent'">
        <div onclick="loadStemReportIntoView('${r.report_id}');toggleStemHistory()" style="cursor:pointer;padding-right:28px">
          <div style="font-family:var(--font-head);font-size:13px;font-weight:600;color:var(--text);margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${title}</div>
          <div style="font-size:11px;color:var(--muted);margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${preview || "—"}</div>
          <div style="display:flex;align-items:center;gap:8px;font-size:11px;color:var(--muted)">${status}</div>
          <div style="font-size:10px;color:var(--muted);opacity:0.5;margin-top:3px">${date}</div>
        </div>
        <button onclick="event.stopPropagation();deleteStemHistoryEntry('${r.report_id}', this.closest('div[style*=\\'position:relative\\']'))" title="Delete this stem analysis" style="position:absolute;top:10px;right:10px;background:transparent;border:none;color:var(--muted);font-size:14px;cursor:pointer;padding:4px 8px;border-radius:4px;opacity:0.5;transition:all 0.15s" onmouseover="this.style.opacity='1';this.style.color='var(--danger)';this.style.background='rgba(255,95,87,0.08)'" onmouseout="this.style.opacity='0.5';this.style.color='var(--muted)';this.style.background='transparent'">🗑</button>
      </div>`;
    }).join("");
  } catch (e) {
    list.innerHTML = '<div style="font-size:13px;color:var(--danger);text-align:center;padding:20px">Could not load history.</div>';
  }
}

async function deleteStemHistoryEntry(reportId, rowEl) {
  if (!confirm("Delete this stem analysis? This cannot be undone.")) return;
  try {
    const res = await fetch(`/stem-report/${reportId}`, { method: "DELETE" });
    const data = await res.json();
    if (data.error) { alert("Could not delete: " + data.error); return; }

    // If the currently-viewed stem report was deleted, clear session + view
    try {
      const stored = sessionStorage.getItem("mix_analyzer_stem_report");
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && parsed.stem_report_id === reportId) {
          sessionStorage.removeItem("mix_analyzer_stem_report");
          // Best-effort: return to upload state
          const dropZone = document.getElementById("drop-zone");
          const results = document.getElementById("results");
          if (dropZone) dropZone.style.display = "";
          if (results) results.classList.add("hidden");
        }
      }
    } catch(e) {}

    // Remove just this row
    if (rowEl && rowEl.parentNode) rowEl.parentNode.removeChild(rowEl);

    // Show empty state if list is now empty
    const list = document.getElementById("stem-history-list");
    if (list && !list.querySelector("div[style*='position:relative']")) {
      list.innerHTML = '<div style="font-size:13px;color:var(--muted);text-align:center;padding:40px 0">No previous stem analyses found.</div>';
    }
  } catch(e) {
    alert("Error deleting: " + e.message);
  }
}

/* ── Load a historical stem report into the main view ── */
async function loadStemReportIntoView(reportId) {
  try {
    const res = await fetch("/stem-report/" + reportId);
    const data = await res.json();
    if (data.error) { alert("Could not load report: " + data.error); return; }

    // Close the timeline card since we're switching views
    closeTimelineCard();
    closeDiffCard();

    // Hide upload UI, show results
    const dropZone = document.getElementById("drop-zone");
    const fileList = document.getElementById("file-list");
    const analyzeBtn = document.getElementById("btn-analyze");
    const progress = document.getElementById("progress-panel");
    const results = document.getElementById("results");
    if (dropZone) dropZone.style.display = "none";
    if (fileList) fileList.style.display = "none";
    if (analyzeBtn) analyzeBtn.style.display = "none";
    if (progress) progress.classList.add("hidden");

    renderResults(data);
    if (results) results.classList.remove("hidden");

    // Update session so restore works correctly
    try { sessionStorage.setItem("stem_results", JSON.stringify(data)); } catch(e) {}

    // Scroll to top of results
    if (results) results.scrollIntoView({behavior: "smooth", block: "start"});
  } catch (e) {
    alert("Error loading report: " + e.message);
  }
}

function renderMatrix(data) {
  const stemNames = Object.keys(data.stems);
  const table     = document.getElementById("matrix-table");

  // Ensure a tooltip element exists (lazy init, reused across hovers)
  let tip = document.getElementById("stem-matrix-tooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "stem-matrix-tooltip";
    tip.style.cssText = "position:fixed;display:none;max-width:320px;padding:12px 14px;background:rgba(13,13,15,0.95);border:1px solid rgba(255,255,255,0.12);border-radius:8px;font-size:12px;font-family:var(--font-mono);color:var(--text);line-height:1.5;z-index:10000;pointer-events:none;box-shadow:0 8px 24px rgba(0,0,0,0.4)";
    document.body.appendChild(tip);
  }

  const SEV_INFO = {
    severe: {
      color: "var(--danger)",
      bg:    "rgba(255,95,87,0.08)",
      label: "Severe masking",
      desc:  "Energy gap between the two stems in this band is ≤3 dB. They're competing at nearly equal levels — both stems fight for the same sonic space.",
      fix:   "Cut 3–6 dB on the less-important stem at the conflicting band, OR duck it with sidechain compression keyed to the dominant stem. Check the Fix recommendations card below for band-specific EQ moves.",
    },
    moderate: {
      color: "var(--warn)",
      bg:    "rgba(245,166,35,0.08)",
      label: "Moderate masking",
      desc:  "Energy gap between the two stems is 3–6 dB. Some overlap, but one stem is already louder and partially wins the frequency range.",
      fix:   "Cut 1–3 dB on the quieter stem at the conflicting band to push past the 6 dB headroom target, OR accept it if the quieter element is genuinely meant to be a supporting texture.",
    },
    mild: {
      color: "var(--accent2)",
      bg:    "rgba(123,97,255,0.08)",
      label: "Mild masking",
      desc:  "Energy gap is 6–12 dB. Enough separation that both stems can coexist cleanly, but they still share frequency real estate.",
      fix:   "Usually fine to leave alone. If the mix feels cluttered, a gentle 1–2 dB cut on the quieter stem can add extra clarity. Focus on severe conflicts first.",
    },
  };

  let html = "<thead><tr><th></th>";
  stemNames.forEach(n => { html += `<th>${n}</th>`; });
  html += "</tr></thead><tbody>";

  stemNames.forEach((na, i) => {
    html += `<tr><td style="text-align:left;font-size:12px;color:var(--muted)">${na}</td>`;
    stemNames.forEach((nb, j) => {
      if (na === nb) {
        html += `<td><span class="matrix-cell matrix-self">—</span></td>`;
      } else {
        const key  = `${na}|${nb}` in data.matrix ? `${na}|${nb}` : `${nb}|${na}`;
        const info = data.matrix[key];
        if (!info || info.score === 0) {
          html += `<td><span class="matrix-cell matrix-none">OK</span></td>`;
        } else {
          const sev = info.score === 3 ? "severe" : info.score === 2 ? "moderate" : "mild";
          const worstBand = info.worst_band ? (BAND_LABELS[info.worst_band] || info.worst_band) : "";
          const deltaDb   = info.delta_db != null ? info.delta_db : "";
          html += `<td><span class="matrix-cell matrix-${sev}" data-sev="${sev}" data-pair="${na} ⇄ ${nb}" data-worst-band="${worstBand}" data-delta="${deltaDb}" style="cursor:help">${sev}</span></td>`;
        }
      }
    });
    html += "</tr>";
  });

  table.innerHTML = html + "</tbody>";

  // Wire up tooltips on severity cells
  table.querySelectorAll(".matrix-cell[data-sev]").forEach(cell => {
    const sev = cell.getAttribute("data-sev");
    const info = SEV_INFO[sev];
    if (!info) return;
    const pair = cell.getAttribute("data-pair");
    const worstBand = cell.getAttribute("data-worst-band");
    const deltaDb = cell.getAttribute("data-delta");
    const context = (worstBand || deltaDb !== "")
      ? `<div style="font-size:10px;color:var(--muted);margin-bottom:8px">${pair}${worstBand ? ` · worst at <strong style="color:var(--accent2)">${worstBand}</strong>` : ""}${deltaDb !== "" ? ` · gap <strong>${deltaDb} dB</strong>` : ""}</div>`
      : `<div style="font-size:10px;color:var(--muted);margin-bottom:8px">${pair}</div>`;

    cell.addEventListener("mouseenter", e => {
      tip.innerHTML = `
        <div style="font-family:var(--font-head);font-size:12px;font-weight:600;color:${info.color};margin-bottom:4px;letter-spacing:0.04em;text-transform:uppercase">${info.label}</div>
        ${context}
        <div style="font-size:11px;color:var(--muted);margin-bottom:8px;line-height:1.6">${info.desc}</div>
        <div style="font-family:var(--font-head);font-size:10px;font-weight:600;color:var(--text);margin-bottom:4px;letter-spacing:0.04em;text-transform:uppercase">How to fix</div>
        <div style="font-size:11px;padding:8px 10px;background:${info.bg};border-radius:6px;color:${info.color};line-height:1.6;border-left:2px solid ${info.color}">${info.fix}</div>`;
      tip.style.display = "block";
    });
    cell.addEventListener("mousemove", e => {
      const tw = 320, th = tip.offsetHeight || 180;
      let x = e.clientX + 14, y = e.clientY + 14;
      if (x + tw > window.innerWidth - 8)  x = e.clientX - tw - 14;
      if (y + th > window.innerHeight - 8) y = e.clientY - th - 14;
      tip.style.left = x + "px";
      tip.style.top  = y + "px";
    });
    cell.addEventListener("mouseleave", () => { tip.style.display = "none"; });
  });
}

function renderFingerprints(data) {
  const el = document.getElementById("fingerprints");
  const stemNames = Object.keys(data.stems);
  const minDb = -70, maxDb = 0;

  el.innerHTML = stemNames.map((name, idx) => {
    const stem = data.stems[name];
    const fp   = stem.fingerprint;
    const color = COLORS[idx % COLORS.length];

    const bars = Object.entries(fp).map(([band, db]) => {
      const pct = Math.max(0, ((db - minDb) / (maxDb - minDb)) * 100);
      return `<div class="fp-row">
        <div class="fp-label">${BAND_LABELS[band]}</div>
        <div class="fp-bar-wrap"><div class="fp-bar" style="width:${pct}%;background:${color};opacity:0.7"></div></div>
        <div class="fp-val">${db} dB</div>
      </div>`;
    }).join("");

    return `<div style="background:var(--bg3);border-radius:var(--radius);padding:14px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
        <span style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0"></span>
        <span style="font-family:var(--font-head);font-size:13px;font-weight:600;color:var(--text)">${name}</span>
        <span style="font-size:10px;color:var(--muted);margin-left:auto">${stem.rms_db} dBFS</span>
      </div>
      ${bars}
    </div>`;
  }).join("");
}

/* ── Per-band energy share: who owns each band ── */
function renderEnergyShare(data) {
  const el = document.getElementById("energy-share");
  if (!el) return;

  const stemNames = Object.keys(data.stems);
  if (!stemNames.length) { el.innerHTML = ""; return; }

  // Assumes all stems have the same band keys
  const firstFp = data.stems[stemNames[0]].fingerprint || {};
  const bandOrder = ["sub", "bass", "low_mid", "mid", "presence", "air"];
  const bands = bandOrder.filter(b => b in firstFp);

  // Compute linear energy per stem per band (10^(dB/10))
  // Sum per band, then compute % share per stem
  const colorFor = idx => COLORS[idx % COLORS.length];

  const rows = bands.map(band => {
    const linearPerStem = stemNames.map(n => {
      const db = data.stems[n].fingerprint[band];
      return (db === null || db === undefined || db <= -95) ? 0 : Math.pow(10, db / 10);
    });
    const total = linearPerStem.reduce((a, b) => a + b, 0);
    if (total <= 0) {
      return `<div class="share-row">
        <div class="share-label">${BAND_LABELS[band]}</div>
        <div class="share-bar-wrap"><div style="width:100%;height:100%;background:var(--bg3)"></div></div>
      </div>`;
    }

    const segments = stemNames.map((n, i) => {
      const pct = (linearPerStem[i] / total) * 100;
      if (pct < 0.5) return "";  // hide tiny slivers
      const color = colorFor(i);
      const labelShown = pct >= 10 ? `${n} ${pct.toFixed(0)}%` : (pct >= 5 ? `${pct.toFixed(0)}%` : "");
      return `<div class="share-seg" style="width:${pct}%;background:${color}" title="${n}: ${pct.toFixed(1)}%">
        <span class="share-seg-label">${labelShown}</span>
      </div>`;
    }).join("");

    // Dominant stem callout (if any stem exceeds 55%)
    let dominance = "";
    const domIdx = linearPerStem.findIndex(v => (v / total) > 0.55);
    if (domIdx >= 0) {
      const pct = ((linearPerStem[domIdx] / total) * 100).toFixed(0);
      dominance = `<span class="share-dom">${stemNames[domIdx]} dominates (${pct}%)</span>`;
    }

    return `<div class="share-row">
      <div class="share-label">${BAND_LABELS[band]}</div>
      <div class="share-bar-wrap">${segments}</div>
      <div class="share-meta">${dominance}</div>
    </div>`;
  }).join("");

  // Build the legend (reuse stem colors)
  const legend = stemNames.map((n, i) =>
    `<span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--muted)">
      <span style="width:8px;height:8px;border-radius:2px;background:${colorFor(i)}"></span>${n}
    </span>`
  ).join("");

  el.innerHTML = `
    <div class="share-container">${rows}</div>
    <div style="display:flex;gap:14px;margin-top:14px;flex-wrap:wrap">${legend}</div>
  `;
}

function renderRecommendations(data) {
  const el = document.getElementById("recommendations");

  if (!data.recommendations.length) {
    el.innerHTML = `<div style="font-size:13px;color:var(--ok)">✓ No significant masking to address.</div>`;
    return;
  }

  // Group recommendations by the stem that needs to be cut
  const grouped = {};
  data.recommendations.forEach(rec => {
    const match = rec.action.match(/^Cut (.+?) by/);
    const stem  = match ? match[1] : rec.stems[0];
    if (!grouped[stem]) grouped[stem] = [];
    grouped[stem].push(rec);
  });

  // Sort groups by worst severity first
  const sevOrder = { severe: 3, moderate: 2, mild: 1 };
  const sortedStems = Object.keys(grouped).sort((a, b) => {
    const maxA = Math.max(...grouped[a].map(r => sevOrder[r.severity] || 0));
    const maxB = Math.max(...grouped[b].map(r => sevOrder[r.severity] || 0));
    return maxB - maxA;
  });

  let canvasIdx = 0;
  const html = sortedStems.map(stem => {
    const recs    = grouped[stem];
    const worst   = recs.reduce((a, b) => sevOrder[a.severity] >= sevOrder[b.severity] ? a : b);
    const totalCuts = recs.length;

    const recRows = recs.map((rec, i) => {
      const idx = canvasIdx++;
      const gainMatch = rec.action.match(/by ([\d.]+) dB/);
      const gain = gainMatch ? parseFloat(gainMatch[1]) : 4;
      const phaseWarn = rec.phase_warning
        ? `<div class="rec-phase" style="margin-top:6px">⚠ ${rec.phase_warning}</div>` : "";

      return `<div style="display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-top:1px solid rgba(255,255,255,0.06)">
        <canvas id="eq-canvas-${idx}" data-band="${rec.band}" data-gain="${gain}"
          width="180" height="52"
          style="flex-shrink:0;border-radius:6px;width:180px;height:52px"></canvas>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <span class="rec-badge ${rec.severity}" style="font-size:9px;padding:2px 6px">${rec.severity}</span>
            <span style="font-size:11px;color:var(--muted)">${rec.stems.join(" ↔ ")}</span>
            <span class="rec-band">${BAND_LABELS[rec.band] || rec.band}</span>
          </div>
          <div class="rec-action" style="margin-bottom:4px">${rec.action}</div>
          <div class="rec-cubase">${rec.cubase}</div>
          ${phaseWarn}
        </div>
      </div>`;
    }).join("");

    return `<div class="rec-item ${worst.severity}" style="padding:16px 18px;margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
        <div style="font-family:var(--font-head);font-size:15px;font-weight:700;color:var(--text)">${stem}</div>
        <span style="font-size:11px;color:var(--muted)">${totalCuts} cut${totalCuts > 1 ? "s" : ""} needed</span>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:2px">Open Frequency EQ on this channel and apply the following:</div>
      ${recRows}
    </div>`;
  }).join("");

  el.innerHTML = html;

  // Persist stem results
  try { sessionStorage.setItem("stem_results", JSON.stringify(data)); } catch(e) {}

  // Draw all EQ curves
  requestAnimationFrame(() => {
    document.querySelectorAll("canvas[data-band]").forEach(canvas => {
      const band = canvas.dataset.band;
      const gain = parseFloat(canvas.dataset.gain);
      drawEQCurve(canvas, band, gain);
    });
  });
}


/* ═══════════════════════════════════════════════════════════════════════════
   Floating nav — show/hide on scroll
   ═══════════════════════════════════════════════════════════════════════════ */
(function() {
  const nav = document.querySelector(".floating-nav");
  if (!nav) return;
  const THRESHOLD = 80;
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

  update();
})();
