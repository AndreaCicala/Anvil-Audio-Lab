/**
 * Release check page — upload finished master, get pass/warn/fail report.
 *
 * Flow:
 *   1. User picks a platform (Spotify / YouTube / Bandcamp)
 *   2. User drops or selects a WAV/FLAC file
 *   3. JS POSTs to /release-check with the file + selected platform
 *   4. Server measures + compares against platform specs
 *   5. JS renders overall verdict + per-check rows
 *
 * No history, no persistence — the tool is stateless. Drop a file, get an
 * answer, optionally drop another. Reset is just a single "Check another
 * file" button that returns to the drop zone.
 */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const state = {
    platform: "spotify",       // matches PLATFORM_TARGETS keys on backend
    isBusy: false,
  };

  const dom = {
    platformPills:  document.querySelectorAll(".rel-platform-pill"),
    uploadSection:  $("rel-upload-section"),
    drop:           $("rel-drop"),
    fileInput:      $("rel-file-input"),
    analyzingSection: $("rel-analyzing-section"),
    resultsSection: $("rel-results-section"),
    verdict:        $("rel-verdict"),
    verdictIcon:    $("rel-verdict-icon"),
    verdictTitle:   $("rel-verdict-title"),
    verdictSub:     $("rel-verdict-sub"),
    verdictFile:    $("rel-verdict-file"),
    checks:         $("rel-checks"),
    btnNew:         $("rel-btn-new"),
  };

  // ---------- Helpers ----------

  function show(el) { if (el) el.classList.remove("rel-hidden"); }
  function hide(el) { if (el) el.classList.add("rel-hidden"); }

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function fmtValue(v, unit) {
    if (v === null || v === undefined) return "—";
    // Number formatting: integers as-is, floats trimmed to 1-2 decimals based
    // on magnitude. Small percentage/dB values want 1 decimal.
    const num = Number(v);
    if (Number.isNaN(num)) return String(v);
    const abs = Math.abs(num);
    let txt;
    if (abs >= 100) txt = num.toFixed(0);
    else if (abs >= 10) txt = num.toFixed(1);
    else txt = num.toFixed(1);
    // Positive sign prefix for LUFS / dB values (negative already has −)
    return txt;
  }

  // ---------- Platform selector ----------

  function setPlatform(p) {
    state.platform = p;
    dom.platformPills.forEach(pill => {
      const active = pill.getAttribute("data-platform") === p;
      pill.classList.toggle("active", active);
      pill.setAttribute("aria-checked", active ? "true" : "false");
    });
  }

  dom.platformPills.forEach(pill => {
    pill.addEventListener("click", () => {
      setPlatform(pill.getAttribute("data-platform"));
    });
    pill.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setPlatform(pill.getAttribute("data-platform"));
      }
    });
  });

  // ---------- Upload: drop + click ----------

  if (dom.drop) {
    // "release-check" scope anchors to wherever the user's finished masters
    // live (typically different folder than pre-master sources). Accepts
    // only WAV/FLAC per the backend's lossy-formats-rejected rule.
    dom.drop.addEventListener("click", async () => {
      const file = await window.AnvilPicker.pick({
        scope:           "release-check",
        accept:          { "audio/*": [".wav", ".wave", ".flac"] },
        fallbackStartIn: "music",
        inputElement:    dom.fileInput,
      });
      if (file) handleFile(file);
    });
    dom.drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      dom.drop.classList.add("drag-over");
    });
    dom.drop.addEventListener("dragleave", () =>
      dom.drop.classList.remove("drag-over"));
    dom.drop.addEventListener("drop", (e) => {
      e.preventDefault();
      dom.drop.classList.remove("drag-over");
      const files = e.dataTransfer.files;
      if (files && files.length > 0) handleFile(files[0]);
    });
  }
  if (dom.fileInput) {
    dom.fileInput.addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (f) handleFile(f);
    });
  }

  /**
   * Validate file extension, then POST to /release-check.
   * Server does its own validation too but rejecting here avoids a round
   * trip for obviously-wrong inputs (mp3, m4a, ogg).
   */
  function handleFile(file) {
    if (state.isBusy) return;
    if (!file) return;
    const ok = /\.(wav|wave|flac)$/i.test(file.name);
    if (!ok) {
      alert("Release check accepts WAV or FLAC only. " +
            "Lossy formats (MP3/AAC/OGG) can't be verified accurately.");
      return;
    }
    state.isBusy = true;
    hide(dom.uploadSection);
    hide(dom.resultsSection);
    show(dom.analyzingSection);

    const fd = new FormData();
    fd.append("file", file);
    fd.append("platform", state.platform);

    fetch("/release-check", { method: "POST", body: fd })
      .then(r => r.json().then(j => ({ok: r.ok, body: j})))
      .then(({ok, body}) => {
        state.isBusy = false;
        hide(dom.analyzingSection);
        // Reset the file input so the same file can be re-selected after a
        // failed attempt. Without this, the <input type="file"> retains its
        // .value and the `change` event doesn't refire when the user picks
        // the same file again — the file picker opens, closes, and nothing
        // happens. Most likely what the user saw as "it doesn't even open"
        // when they switched platform tabs and re-tried after a server error.
        if (dom.fileInput) dom.fileInput.value = "";
        if (!ok) {
          alert("Release check failed: " + (body.error || "unknown"));
          show(dom.uploadSection);
          return;
        }
        renderResults(body);
        show(dom.resultsSection);
      })
      .catch(err => {
        state.isBusy = false;
        hide(dom.analyzingSection);
        show(dom.uploadSection);
        if (dom.fileInput) dom.fileInput.value = "";
        alert("Network error: " + err.message);
      });
  }

  // ---------- Render results ----------

  /**
   * Render the verdict card + check list from a /release-check response.
   * Response shape:
   *   { filename, duration_seconds, sample_rate,
   *     measurements: {...},
   *     report: { platform, platform_label, overall_status, checks: [...] } }
   */
  function renderResults(body) {
    const report = body.report || {};
    const checks = report.checks || [];

    // Verdict
    const overall = report.overall_status || "unknown";
    dom.verdict.classList.remove("pass", "warn", "fail", "unknown");
    dom.verdict.classList.add(overall);

    const iconMap = { pass: "✓", warn: "!", fail: "✗", unknown: "?" };
    dom.verdictIcon.textContent = iconMap[overall] || "?";

    const titleMap = {
      pass: "Ready for delivery",
      warn: "Ship with caveats",
      fail: "Not ready — fix before release",
      unknown: "Check incomplete",
    };
    dom.verdictTitle.textContent =
      `${titleMap[overall] || "Check result"} — ${report.platform_label || ""}`;

    const counts = {pass: 0, warn: 0, fail: 0, info: 0};
    checks.forEach(c => { counts[c.status] = (counts[c.status] || 0) + 1; });
    const sumParts = [];
    if (counts.pass) sumParts.push(`${counts.pass} pass`);
    if (counts.warn) sumParts.push(`${counts.warn} warn`);
    if (counts.fail) sumParts.push(`${counts.fail} fail`);
    if (counts.info) sumParts.push(`${counts.info} info`);
    dom.verdictSub.textContent = sumParts.join(" · ") || "No checks returned.";

    dom.verdictFile.textContent = body.filename || "";

    // Checks
    dom.checks.innerHTML = checks.map(c => {
      const iconMap2 = { pass: "✓", warn: "!", fail: "✗", info: "i", unknown: "?" };
      const icon = iconMap2[c.status] || "?";
      const val = (c.value === null || c.value === undefined) ? "—" : fmtValue(c.value, c.unit);
      const unit = c.unit ? `<span class="rel-check-value-unit">${escapeHtml(c.unit)}</span>` : "";
      return `
        <div class="rel-check ${c.status}">
          <div class="rel-check-icon">${icon}</div>
          <div class="rel-check-body">
            <div class="rel-check-label">${escapeHtml(c.label)}</div>
            <div class="rel-check-hint">${escapeHtml(c.hint)}</div>
          </div>
          <div class="rel-check-value">${escapeHtml(val)}${unit}</div>
        </div>`;
    }).join("");
  }

  // ---------- "Check another file" reset ----------

  if (dom.btnNew) {
    dom.btnNew.addEventListener("click", () => {
      hide(dom.resultsSection);
      show(dom.uploadSection);
      dom.fileInput.value = "";
    });
  }

})();
