/* ═══════════════════════════════════════════════════════════════════════════
   master.js — frontend for the Mastering page

   Flow:
     1. User drops a WAV/FLAC/AIFF -> POST /analyze-master
        -> receives {master_upload_id, analysis_summary, proposal}
     2. We render the proposal cards from proposal.suggestions
     3. User toggles/adjusts cards -> we rebuild chain_config on each change
     4. "Render preview" -> POST /preview-master -> receives audio URLs + stats
        -> we wire both <audio> elements for A/B and show verification
     5. "Export master" -> POST /export-master -> returns the rendered WAV 24-bit.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  // ---------- State ----------
  const state = {
    masterUploadId: null,
    sourceFilename: null,
    sourceFile: null,
    proposal: null,
    analysisSummary: null,
    chainConfig: null,
    previewSourceUrl: null,
    previewMasterUrl: null,
    isBusy: false,
    tonalMode: false,
    // Tonal correction source — mutually exclusive between the 6-band EQ
    // and Reference Match. "eq" = suggested 6-band EQ (default); "refmatch"
    // = reference-match-driven EQ. Only one feeds the chain at a time.
    tonalSource: "eq",
    // 6-band EQ (genre match)
    geqProposal: null,          // {bells, config, comparison, correction_ratio}
    geqCorrectionPct: 50,       // 0-100
    geqEnabled: false,          // "Apply in chain" checkbox
    geqUserDismissed: false,    // true if user explicitly unchecked 'Apply in chain';
                                // prevents auto-enable from re-firing on subsequent
                                // bell interactions (respect the explicit opt-out).
    geqBusy: false,
    // Mono-bass check (from server /analyze-master response)
    msBass: null,
    // Sides-air check (from server /analyze-master response)
    msAir: null,
    // Frequency cutoff check (from server /analyze-master response)
    cutoff: null,
    // Reference Match — null until user drops a reference file, then becomes:
    //   {filename, ref_lufs, proposal, correctionPct, enabled, busy}
    // Visibility is now controlled by the Tonal correction segmented toggle,
    // not an independent collapsible — the refExpanded flag is gone.
    refMatch: null,
    // Metadata tagging — collapsible. "expanded" flag persists during the
    // session but not across page loads. Field values themselves live in
    // the DOM (<input>s) and localStorage (Artist/Album only).
    metaExpanded: false,
  };

  // ---------- DOM handles ----------
  const $ = (id) => document.getElementById(id);

  const dom = {
    drop:            $("mst-drop"),
    fileInput:       $("mst-file-input"),
    uploadSection:   $("mst-upload-section"),
    analyzingSection:$("mst-analyzing-section"),
    proposalSection: $("mst-proposal-section"),
    sourceFilename:  $("mst-source-filename"),
    sourceStrip:     $("mst-source-strip"),
    verdict:         $("mst-verdict"),
    warnings:        $("mst-warnings"),
    cards:           $("mst-cards"),
    btnPreview:      $("mst-btn-preview"),
    btnReset:        $("mst-btn-reset"),
    btnNew:          $("mst-btn-new"),
    previewWrap:     $("mst-preview-wrap"),
    audioSource:     $("mst-audio-source"),
    audioMaster:     $("mst-audio-master"),
    verify:          $("mst-verify"),
    btnExport:       $("mst-btn-export"),
    historyPanel:    $("master-history-panel"),
    historyOverlay:  $("master-history-overlay"),
    historyList:     $("master-history-list"),
    modeToggle:      $("mst-mode-toggle"),
    // Tonal correction segmented toggle (switches between 6-band EQ and Ref Match)
    tonalModeGroup:  $("mst-tonal-mode"),
    // 6-band EQ
    geqPanel:        $("mst-geq-panel"),
    geqDesc:         $("mst-geq-desc"),
    geqEnabled:      $("mst-geq-enabled"),
    geqCorrWrap:     $("mst-geq-corr-wrap"),
    geqCorrSlider:   $("mst-geq-corr-slider"),
    geqCorrVal:      $("mst-geq-corr-val"),
    geqCompare:      $("mst-geq-compare"),
    geqCurveSvg:     $("mst-geq-curve-svg"),
    geqBells:        $("mst-geq-bells"),
    // Mono-bass check
    msBassCard:      $("mst-msbass"),
    msBassBody:      $("mst-msbass-body"),
    // Sides-air check
    msAirCard:       $("mst-msair"),
    msAirBody:       $("mst-msair-body"),
    // Frequency cutoff check
    cutoffCard:      $("mst-cutoff"),
    cutoffBody:      $("mst-cutoff-body"),
    // Reference Match panel (now toggle-controlled, not collapsible)
    refPanel:        $("mst-refmatch-panel"),
    refDrop:         $("mst-ref-drop"),
    refFileInput:    $("mst-ref-file-input"),
    refLoaded:       $("mst-ref-loaded"),
    refAnalyzing:    $("mst-ref-analyzing"),
    refFilename:     $("mst-ref-filename"),
    refLufs:         $("mst-ref-lufs"),
    refRemove:       $("mst-ref-remove"),
    refCorrSlider:   $("mst-ref-corr-slider"),
    refCorrVal:      $("mst-ref-corr-val"),
    refEnabled:      $("mst-ref-enabled"),
    refCurveSvg:     $("mst-ref-curve-svg"),
    refCompare:      $("mst-ref-compare"),
    refBells:        $("mst-ref-bells"),
    // Metadata form (collapsible)
    metaWrap:        $("mst-meta"),
    metaHeader:      $("mst-meta-header"),
    metaBody:        $("mst-meta-body"),
    metaTitle:       $("mst-meta-title"),
    metaArtist:      $("mst-meta-artist"),
    metaAlbum:       $("mst-meta-album"),
    metaTrack:       $("mst-meta-track"),
    metaYear:        $("mst-meta-year"),
    metaGenre:       $("mst-meta-genre"),
    metaClear:       $("mst-meta-clear"),
  };

  // ---------- Helpers ----------
  function fmtDb(v, digits=1) {
    if (v === null || v === undefined || Number.isNaN(v)) return "—";
    const s = v >= 0 ? "+" : "";
    return s + Number(v).toFixed(digits);
  }
  function fmtNum(v, digits=1) {
    if (v === null || v === undefined || Number.isNaN(v)) return "—";
    return Number(v).toFixed(digits);
  }

  // Rationale text formatters — mirror the server-side ones in master_engine.py
  // (_format_genre_bell_rationale, _format_bell_rationale). Keep in sync manually.
  //
  // Using these client-side means the rationale text updates instantly when
  // the user moves the correction-strength slider, without a server round-trip.
  function formatGenreBellRationale(band, mixVp, target, delta, gain) {
    const pretty = band.replace("_", " ");
    const Cap = pretty.charAt(0).toUpperCase() + pretty.slice(1);
    if (Math.abs(gain) < 0.3) {
      return `${Cap}: mix is ${fmtNum(mixVp,1)} dB vs neutral, genre target is `
           + `${fmtNum(target,1)} dB. Delta is small (${fmtDb(delta,1)} dB) — no EQ needed.`;
    }
    const direction = delta > 0 ? "brighter" : "darker";
    const action = gain < 0 ? "cut" : "boost";
    return `${Cap}: mix is ${fmtNum(mixVp,1)} dB vs neutral, genre target is `
         + `${fmtNum(target,1)} dB — mix is ${direction} than typical by `
         + `${Math.abs(delta).toFixed(1)} dB. Suggested ${fmtDb(gain,1)} dB ${action} `
         + `nudges toward genre norm.`;
  }

  function show(el) { el.classList.remove("mst-hidden"); }
  function hide(el) { el.classList.add("mst-hidden"); }

  function setBusy(busy) {
    state.isBusy = busy;
    [dom.btnPreview, dom.btnExport, dom.btnReset, dom.btnNew].forEach(b => {
      if (b) b.disabled = busy;
    });
  }

  /**
   * Attach wheel-to-change behavior to a number input.
   *
   * Without this, Chrome lets the wheel event bubble so scrolling the wheel
   * over a focused number input also scrolls the page — annoying when
   * you're trying to nudge a value. With this: wheel over the input changes
   * the value by the step and prevents the page scroll.
   *
   * Respects shift-wheel for fine adjustment (step / 10).
   *
   *   el    — the <input type="number"> element
   *   step  — the normal step per wheel tick (e.g. 0.1 for dB, 0.5 for LUFS)
   *   min   — inclusive lower bound (optional)
   *   max   — inclusive upper bound (optional)
   *   onChange(newValue) — called with the new number after each tick
   *
   * The helper dispatches a "change" event on the input after updating, so
   * existing change listeners fire normally.
   */
  function attachWheelNudge(el, step, min, max, onChange) {
    el.addEventListener("wheel", (e) => {
      // Only react when the input is the target. We rely on hover, since
      // that's the natural expectation (wheel over the knob = adjust it).
      e.preventDefault();
      const current = parseFloat(el.value);
      if (Number.isNaN(current)) return;
      const direction = e.deltaY < 0 ? 1 : -1;  // wheel up → increase
      const scale = e.shiftKey ? 0.1 : 1.0;
      let next = current + direction * step * scale;
      if (typeof min === "number") next = Math.max(min, next);
      if (typeof max === "number") next = Math.min(max, next);
      // Round to the step's precision to avoid 0.30000000000000004
      const decimals = step < 1 ? (step.toString().split(".")[1] || "").length : 0;
      next = parseFloat(next.toFixed(decimals));
      el.value = next.toFixed(Math.min(decimals, 2));
      if (onChange) onChange(next);
      // Fire a real change event so existing handlers pick it up
      el.dispatchEvent(new Event("change", {bubbles: true}));
    }, {passive: false});
  }

  // ---------- Upload + analyze ----------
  // Click-to-pick via AnvilPicker anchors the dialog to the user's last-used
  // master source folder (Chrome/Edge). "master-source" scope is distinct
  // from the mix analysis page's "mix-source" scope because the two workflows
  // typically target different folders (pre-master vs mastered source).
  dom.drop.addEventListener("click", async () => {
    const file = await window.AnvilPicker.pick({
      scope:           "master-source",
      accept:          { "audio/*": [".wav", ".flac", ".aiff", ".aif"] },
      fallbackStartIn: "music",
      inputElement:    dom.fileInput,
    });
    if (file) handleFile(file);
  });
  dom.drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    dom.drop.classList.add("drag-over");
  });
  dom.drop.addEventListener("dragleave", () => dom.drop.classList.remove("drag-over"));
  dom.drop.addEventListener("drop", (e) => {
    e.preventDefault();
    dom.drop.classList.remove("drag-over");
    const files = e.dataTransfer.files;
    if (files && files.length > 0) handleFile(files[0]);
  });
  // The hidden <input type="file"> is kept as a fallback for non-Chrome
  // browsers. When AnvilPicker falls back to it, the picker's change event
  // fires normally and propagates to this listener.
  dom.fileInput.addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f) handleFile(f);
  });

  // ---------- Tonal Mode toggle ----------
  // Clicking the visual switch or pressing Space/Enter while focused flips mode.
  // If an analysis is already loaded we re-fetch the proposal so defaults update.
  function setModeAndRefresh(newMode) {
    if (state.isBusy) return;
    if (state.tonalMode === newMode) return;
    state.tonalMode = !!newMode;
    // Visual state
    if (dom.modeToggle) {
      dom.modeToggle.classList.toggle("on", state.tonalMode);
      dom.modeToggle.setAttribute("aria-checked", state.tonalMode ? "true" : "false");
    }
    // If we already have an analysis, re-propose; otherwise just remember.
    if (state.sourceFile && state.proposal) {
      reproposeForModeChange();
    }
  }

  if (dom.modeToggle) {
    dom.modeToggle.addEventListener("click", () => setModeAndRefresh(!state.tonalMode));
    dom.modeToggle.addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        setModeAndRefresh(!state.tonalMode);
      }
    });
  }

  function handleFile(file) {
    const name = (file.name || "").toLowerCase();
    if (!/\.(wav|wave|aiff|aif|flac)$/.test(name)) {
      alert("Unsupported file type. Use WAV, AIFF, or FLAC.");
      return;
    }

    state.sourceFile = file;          // cache for potential re-analysis
    state.sourceFilename = file.name;
    // New source = old genre-eq proposal + mono-bass check + sides-air check are stale
    resetGeq();
    state.msBass = null;
    state.msAir = null;
    if (dom.msBassCard) dom.msBassCard.style.display = "none";
    if (dom.msAirCard) dom.msAirCard.style.display = "none";
    // Reference Match stays across new-source in the sense that the section
    // remains in the DOM, but any previously-loaded reference file is tied
    // to the old master_upload_id, so it's no longer valid. Clear it.
    resetRefMatch();
    // New source = new track. Wipe per-track metadata fields (Title/Track/
    // Year/Genre). Artist + Album persist because they typically apply to
    // a whole album.
    if (typeof window.__anvilResetMetaPerTrack === "function") {
      window.__anvilResetMetaPerTrack();
    }
    hide(dom.uploadSection);
    show(dom.analyzingSection);
    runAnalyzeUpload(file);
  }

  function runAnalyzeUpload(file) {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("tonal_mode", state.tonalMode ? "true" : "false");

    fetch("/analyze-master", { method: "POST", body: fd })
      .then(r => r.json().then(j => ({ok: r.ok, body: j})))
      .then(({ok, body}) => {
        hide(dom.analyzingSection);
        if (!ok) {
          alert("Analysis failed: " + (body.error || "unknown"));
          show(dom.uploadSection);
          return;
        }
        state.masterUploadId = body.master_upload_id;
        state.analysisSummary = body.analysis_summary;
        state.proposal = body.proposal;
        state.chainConfig = JSON.parse(JSON.stringify(body.proposal.config));
        state.msBass = body.ms_bass_check || null;
        state.msAir  = body.ms_air_check  || null;
        state.cutoff = body.cutoff_check  || null;
        renderProposal();
        renderMsBassCheck();
        renderMsAirCheck();
        renderCutoffCheck();
        // Auto-fill Genre in the metadata form (only if empty)
        if (typeof window.__anvilAutofillGenre === "function") window.__anvilAutofillGenre();
        show(dom.proposalSection);
        // Populate 6-band EQ card with fresh suggestions from the mix
        fetchGeqProposal();
      })
      .catch(err => {
        hide(dom.analyzingSection);
        show(dom.uploadSection);
        alert("Upload failed: " + err.message);
      });
  }

  /**
   * Re-request the proposal with the current tonal_mode. Called when the
   * user toggles mode *after* an analysis has already loaded. We re-use
   * the cached File so the user doesn't need to re-upload.
   */
  function reproposeForModeChange() {
    if (!state.sourceFile || state.isBusy) return;
    setBusy(true);
    // Mark the verdict/cards as being rebuilt so the UI isn't confusing
    if (dom.cards) dom.cards.style.opacity = "0.4";
    if (dom.verdict) dom.verdict.style.opacity = "0.4";

    // Re-use the /analyze-master path for simplicity. We already have the
    // file in-memory from the previous drop, so this is cheap.
    const fd = new FormData();
    fd.append("file", state.sourceFile);
    fd.append("tonal_mode", state.tonalMode ? "true" : "false");

    fetch("/analyze-master", { method: "POST", body: fd })
      .then(r => r.json().then(j => ({ok: r.ok, body: j})))
      .then(({ok, body}) => {
        setBusy(false);
        if (dom.cards) dom.cards.style.opacity = "";
        if (dom.verdict) dom.verdict.style.opacity = "";
        if (!ok) {
          alert("Mode switch failed: " + (body.error || "unknown"));
          return;
        }
        state.masterUploadId = body.master_upload_id;
        state.analysisSummary = body.analysis_summary;
        state.proposal = body.proposal;
        state.chainConfig = JSON.parse(JSON.stringify(body.proposal.config));
        state.msBass = body.ms_bass_check || null;
        state.msAir  = body.ms_air_check  || null;
        state.cutoff = body.cutoff_check  || null;
        // Reset 6-band EQ — new upload id requires fresh proposal
        resetGeq();
        // Reset loaded reference — old master_upload_id is gone
        resetRefMatch();
        renderProposal();
        renderMsBassCheck();
        renderMsAirCheck();
        renderCutoffCheck();
        // Auto-fill Genre (no-op if user already typed one)
        if (typeof window.__anvilAutofillGenre === "function") window.__anvilAutofillGenre();
        hide(dom.previewWrap);
        fetchGeqProposal();
      })
      .catch(err => {
        setBusy(false);
        if (dom.cards) dom.cards.style.opacity = "";
        if (dom.verdict) dom.verdict.style.opacity = "";
        alert("Mode switch failed: " + err.message);
      });
  }

  // ---------- Render: source summary + verdict + warnings ----------
  function renderProposal() {
    dom.sourceFilename.textContent = state.sourceFilename || "";

    const s = state.analysisSummary || {};
    const m = state.proposal.source_metrics || {};

    const chips = [
      { label: "Integrated LUFS", value: fmtNum(s.integrated_lufs, 1), unit: "LUFS" },
      { label: "True peak",       value: fmtNum(s.true_peak_dbfs, 1), unit: "dBFS" },
      { label: "Crest factor",    value: fmtNum(s.crest_factor_db, 1), unit: "dB" },
      { label: "LRA",             value: fmtNum(s.loudness_range_lra, 1), unit: "LU" },
    ];
    dom.sourceStrip.innerHTML = chips.map(c => `
      <div class="mst-chip">
        <div class="mst-chip-label">${c.label}</div>
        <div class="mst-chip-value">${c.value}<span class="mst-chip-unit">${c.unit}</span></div>
      </div>
    `).join("");

    // Source verdict card
    renderVerdict(state.proposal.source_verdict);

    // Urgent warnings (clipping, etc.) — separate from the verdict card
    const warnings = state.proposal.warnings || [];
    // Filter out the verdict message so we don't show it twice
    const verdictMsg = (state.proposal.source_verdict && state.proposal.source_verdict.message) || "";
    const urgent = warnings.filter(w => w !== verdictMsg);
    if (urgent.length === 0) {
      dom.warnings.innerHTML = "";
    } else {
      dom.warnings.innerHTML = urgent.map(w => `
        <div class="mst-warning">
          <span class="mst-warning-icon">!</span>${escapeHtml(w)}
        </div>
      `).join("");
    }

    // Cards
    renderCards();

    // Hide any previous preview
    hide(dom.previewWrap);
  }

  /**
   * Render the mono-bass check card. Uses state.msBass (populated from the
   * server's /analyze-master response) to show a severity badge + message
   * and an "Apply fix" button that enables the ms_hp_sides chain stage.
   *
   * Severity tiers (decided server-side in analyze_ms_bass):
   *   clean        — <10% side bass, healthy, fix disabled
   *   mild         — 10-20%, available but optional
   *   worth_fixing — 20-35%, recommended
   *   severe       — >35%, likely a mix-side problem; fix still available
   *
   * The card also detects if the user has already opted in (chainConfig has
   * ms_hp_sides.enabled === true) and flips the button to an "Applied /
   * remove" state so the action is reversible.
   */
  function renderMsBassCheck() {
    if (!dom.msBassCard || !dom.msBassBody) return;
    const m = state.msBass;

    // No data yet, or analysis didn't run — hide the card entirely so we
    // don't show a confusing empty shell.
    if (!m) {
      dom.msBassCard.style.display = "none";
      return;
    }
    dom.msBassCard.style.display = "";

    // Mono sources: the concept of "stereo bass" doesn't apply; show a
    // short note and no action button.
    if (m.is_mono) {
      dom.msBassCard.className = "mst-msbass clean";
      dom.msBassBody.innerHTML = `
        <div class="mst-msbass-row">
          <div class="mst-msbass-stats">
            <span class="hdr clean">Source is mono</span>
            <span class="sub">Mono-bass check doesn't apply to mono material.</span>
          </div>
        </div>`;
      return;
    }

    const sev = m.severity || "clean";
    const pct = (typeof m.side_bass_pct === "number") ? m.side_bass_pct : 0;
    const applied = !!(state.chainConfig &&
                       state.chainConfig.ms_hp_sides &&
                       state.chainConfig.ms_hp_sides.enabled);

    // Class mapping: 4 severity classes on the card → border color
    const cardClass =
      sev === "clean"        ? "clean"  :
      sev === "mild"         ? "mild"   :
      sev === "worth_fixing" ? "worth"  :
      sev === "severe"       ? "severe" : "clean";
    dom.msBassCard.className = "mst-msbass " + cardClass;

    // Header text per severity
    const hdrText = {
      clean:        `Low end is ${pct.toFixed(0)}% in the sides — already tight`,
      mild:         `Low end is ${pct.toFixed(0)}% in the sides`,
      worth_fixing: `Low end is ${pct.toFixed(0)}% in the sides`,
      severe:       `Low end is ${pct.toFixed(0)}% in the sides — that's a lot`,
    }[sev] || `Low end is ${pct.toFixed(0)}% in the sides`;

    const subText = {
      clean:        `No action needed. Your rhythm section sits mostly in the center, as it should.`,
      mild:         `A bit of stereo content below ~150 Hz. Optional cleanup: mono-ify the low end so it stays tight on small speakers and vinyl.`,
      worth_fixing: `Meaningful stereo energy below ~150 Hz. Mono-ing the low end wastes less headroom and tightens the rhythm section on mono playback.`,
      severe:       `That's unusually high. This often points to a mix-side issue — check for stereo-widened bass, stereo reverb on kick, or a stereo bus compressor. Applying the fix helps but the real solve is upstream.`,
    }[sev] || "";

    // Action button state:
    //   clean       — disabled
    //   otherwise   — enabled; label depends on whether already applied
    let btnHtml;
    if (sev === "clean") {
      btnHtml = `<button class="mst-msbass-btn" id="mst-msbass-apply" disabled>No fix needed</button>`;
    } else if (applied) {
      btnHtml = `<button class="mst-msbass-btn applied" id="mst-msbass-apply">✓ Applied — click to remove</button>`;
    } else {
      btnHtml = `<button class="mst-msbass-btn" id="mst-msbass-apply">Apply fix: HP sides at 120 Hz</button>`;
    }

    dom.msBassBody.innerHTML = `
      <div class="mst-msbass-row">
        <div class="mst-msbass-stats">
          <span class="hdr ${cardClass}">${hdrText}</span>
          <span class="sub">${subText}</span>
        </div>
        <div class="mst-msbass-action">${btnHtml}</div>
      </div>`;

    // Wire the button
    const btn = $("mst-msbass-apply");
    if (btn && sev !== "clean") {
      btn.addEventListener("click", () => toggleMsBassFix());
    }
  }

  /**
   * Toggle the ms_hp_sides chain stage on/off and re-render the card so the
   * button reflects the new state. Invalidates the current preview because
   * the chain has changed.
   */
  function toggleMsBassFix() {
    if (!state.chainConfig) return;
    const current = state.chainConfig.ms_hp_sides;
    if (current && current.enabled) {
      // Remove
      delete state.chainConfig.ms_hp_sides;
    } else {
      // Apply — 120 Hz is the hardcoded default; exposing a slider is a
      // future nicety but not needed for the common case.
      state.chainConfig.ms_hp_sides = {enabled: true, cutoff_hz: 120};
    }
    hide(dom.previewWrap);
    renderMsBassCheck();
  }

  /**
   * Render the sides-air check card. Sibling to renderMsBassCheck — same
   * pattern (severity → border color + header + sub + action button), but
   * measures the air-band gap between Mid and Side and suggests a high-shelf
   * only on the Side channel to open up the stereo image without affecting
   * center-panned elements.
   *
   * Severity tiers (from analyze_ms_air):
   *   clean        — <2 dB gap, no headroom to boost
   *   mild         — 2-4 dB gap, small shelf (+1.5 dB)
   *   worth_fixing — 4-7 dB gap, classic case (+2.5 dB)
   *   big_room     — >7 dB gap, still conservative (+3 dB)
   *
   * The button label embeds the specific suggested shelf gain so the user
   * knows exactly what will be applied.
   */
  function renderMsAirCheck() {
    if (!dom.msAirCard || !dom.msAirBody) return;
    const m = state.msAir;
    if (!m) {
      dom.msAirCard.style.display = "none";
      return;
    }
    dom.msAirCard.style.display = "";

    if (m.is_mono) {
      dom.msAirCard.className = "mst-msair clean";
      dom.msAirBody.innerHTML = `
        <div class="mst-msbass-row">
          <div class="mst-msbass-stats">
            <span class="hdr clean">Source is mono</span>
            <span class="sub">Sides-air check doesn't apply to mono material.</span>
          </div>
        </div>`;
      return;
    }

    const sev = m.severity || "clean";
    const gap = (typeof m.gap_db === "number") ? m.gap_db : 0;
    const shelf = (typeof m.suggested_shelf_db === "number") ? m.suggested_shelf_db : 0;
    const applied = !!(state.chainConfig &&
                       state.chainConfig.ms_air_shelf &&
                       state.chainConfig.ms_air_shelf.enabled);

    // Reuse the mono-bass CSS severity classes (clean/mild/worth/severe).
    // For sides-air we don't have a "severe" tier — "big_room" maps to the
    // "worth" border color since it's still an acceptable, not alarming,
    // condition.
    const cardClass =
      sev === "clean"        ? "clean" :
      sev === "mild"         ? "mild"  :
      sev === "worth_fixing" ? "worth" :
      sev === "big_room"     ? "worth" : "clean";
    dom.msAirCard.className = "mst-msair " + cardClass;

    const hdrText = {
      clean:        `Sides are ${gap.toFixed(1)} dB darker than mid in air — balanced`,
      mild:         `Sides are ${gap.toFixed(1)} dB darker than mid in the air band`,
      worth_fixing: `Sides are ${gap.toFixed(1)} dB darker than mid in the air band`,
      big_room:     `Sides are ${gap.toFixed(1)} dB darker than mid — lots of room`,
    }[sev] || `Sides vs mid air gap: ${gap.toFixed(1)} dB`;

    const subText = {
      clean:        `No room to add air only on the sides. Mid and Side air are already balanced.`,
      mild:         `A gentle Side-only shelf would widen the mix without adding sibilance on vocals.`,
      worth_fixing: `Classic case: boost air only on the Side channel to open the mix without affecting center-panned vocals/drums.`,
      big_room:     `Big gap, but stay conservative — adding too much can make reverb tails feel detached from the dry signal.`,
    }[sev] || "";

    let btnHtml;
    if (sev === "clean") {
      btnHtml = `<button class="mst-msbass-btn" id="mst-msair-apply" disabled>No fix needed</button>`;
    } else if (applied) {
      btnHtml = `<button class="mst-msbass-btn applied" id="mst-msair-apply">✓ Applied — click to remove</button>`;
    } else {
      btnHtml = `<button class="mst-msbass-btn" id="mst-msair-apply">Apply fix: +${shelf.toFixed(1)} dB shelf on sides at 10 kHz</button>`;
    }

    dom.msAirBody.innerHTML = `
      <div class="mst-msbass-row">
        <div class="mst-msbass-stats">
          <span class="hdr ${cardClass}">${hdrText}</span>
          <span class="sub">${subText}</span>
        </div>
        <div class="mst-msbass-action">${btnHtml}</div>
      </div>`;

    const btn = $("mst-msair-apply");
    if (btn && sev !== "clean") {
      btn.addEventListener("click", () => toggleMsAirFix());
    }
  }

  /**
   * Toggle the ms_air_shelf chain stage on/off. Uses the server-suggested
   * shelf gain (scales with the measured Mid/Side air gap) when applying.
   */
  function toggleMsAirFix() {
    if (!state.chainConfig || !state.msAir) return;
    const current = state.chainConfig.ms_air_shelf;
    if (current && current.enabled) {
      delete state.chainConfig.ms_air_shelf;
    } else {
      state.chainConfig.ms_air_shelf = {
        enabled: true,
        gain_db: state.msAir.suggested_shelf_db || 2.5,
        freq_hz: 10000,
      };
    }
    hide(dom.previewWrap);
    renderMsAirCheck();
  }

  /**
   * Render the frequency-cutoff check card. Informational-only — no fix
   * button, since this is a property of the source material (the user's mix)
   * and mastering can't undo bandwidth loss. The point is to alert the user
   * when they're mastering what looks like an upsampled 44.1/48 kHz source,
   * which makes delivering at a higher sample rate cosmetic.
   */
  function renderCutoffCheck() {
    if (!dom.cutoffCard || !dom.cutoffBody) return;
    const c = state.cutoff;

    if (!c || c.cutoff_hz == null) {
      dom.cutoffCard.style.display = "none";
      return;
    }
    dom.cutoffCard.style.display = "";

    const verdict = c.verdict || "unknown";
    // Map verdict → severity class (reuses .mst-msbass severity borders)
    const cardClass =
      verdict === "full_band"    ? "clean"  :
      verdict === "normal"       ? "clean"  :
      verdict === "band_limited" ? "worth"  : "clean";
    dom.cutoffCard.className = "mst-cutoff " + cardClass;

    const hdrClass =
      verdict === "full_band"    ? "clean"  :
      verdict === "normal"       ? "clean"  :
      verdict === "band_limited" ? "worth"  : "clean";

    const cfKhz = (c.cutoff_hz / 1000).toFixed(1);
    const nyqKhz = (c.nyquist_hz / 1000).toFixed(1);
    const pct = (c.pct_nyquist != null) ? c.pct_nyquist.toFixed(0) : "—";

    const hdrText = {
      full_band:    `Full-bandwidth content — ${cfKhz} kHz (${pct}% of Nyquist)`,
      normal:       `Native high-rate content — ${cfKhz} kHz (${pct}% of Nyquist)`,
      band_limited: `Cuts off at ${cfKhz} kHz (${pct}% of ${nyqKhz} kHz Nyquist)`,
      unknown:      `Cutoff not detected`,
    }[verdict] || `Cutoff at ${cfKhz} kHz`;

    const subText = c.detail || "";

    dom.cutoffBody.innerHTML = `
      <div class="mst-msbass-row">
        <div class="mst-msbass-stats">
          <span class="hdr ${hdrClass}">${escapeHtml(hdrText)}</span>
          <span class="sub">${escapeHtml(subText)}</span>
        </div>
      </div>`;
  }

  /**
   * Render the source-verdict card. Severity drives the border/bg color.
   * When verdict recommends Tonal Mode but it's off, show a one-click CTA.
   */
  function renderVerdict(verdict) {
    if (!verdict) {
      dom.verdict.innerHTML = "";
      return;
    }
    const sev = verdict.severity || "note";
    const iconMap = { warn: "!", info: "i", ok: "✓", note: "•" };
    const icon = iconMap[sev] || "•";

    // CTA to enable Tonal Mode if recommended and not already on
    let ctaHtml = "";
    if (verdict.tonal_mode_recommended && !state.tonalMode) {
      ctaHtml = `
        <div class="mst-verdict-cta" id="mst-verdict-cta">
          → Switch to Tonal Mode
        </div>`;
    }

    const heuristicHtml = verdict.heuristic
      ? `<div class="mst-verdict-heuristic">${escapeHtml(verdict.heuristic)}</div>`
      : "";

    dom.verdict.innerHTML = `
      <div class="mst-verdict sev-${sev}">
        <div class="mst-verdict-title">
          <span class="mst-verdict-icon">[${icon}]</span>
          <span>${escapeHtml(verdict.title || "Source")}</span>
        </div>
        <div class="mst-verdict-body">${escapeHtml(verdict.message || "")}</div>
        ${heuristicHtml}
        ${ctaHtml}
      </div>
    `;

    // Wire CTA
    const cta = $("mst-verdict-cta");
    if (cta) {
      cta.addEventListener("click", () => setModeAndRefresh(true));
    }
  }

  function escapeHtml(s) {
    if (s === null || s === undefined) return "";
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ---------- Render: suggestion cards ----------
  function renderCards() {
    const cards = state.proposal.suggestions || [];
    dom.cards.innerHTML = cards.map((card, idx) => cardHtml(card, idx)).join("");

    // Wire toggles + sliders
    cards.forEach((card, idx) => {
      const toggle = $(`mst-toggle-${card.step}`);
      if (toggle) {
        toggle.addEventListener("change", () => {
          state.chainConfig[card.step].enabled = toggle.checked;
          updateCardAcceptedClass(card.step);
          // Preview invalidated on any change
          hide(dom.previewWrap);
        });
      }
      // Slider for adjustable gain on each card
      const slider = $(`mst-slider-${card.step}`);
      const numInput = $(`mst-num-${card.step}`);
      if (slider && numInput) {
        if (card.step === "gain") {
          // Loudness card: slider adjusts target LUFS (not gain directly).
          // Gain is computed as target - current whenever the slider moves.
          const sync = (v) => {
            const n = parseFloat(v);
            if (Number.isNaN(n)) return;
            slider.value = n;
            numInput.value = n.toFixed(1);
            const currentLufs = state.proposal?.source_metrics?.integrated_lufs ?? 0;
            const gain = n - currentLufs;
            state.chainConfig.target_lufs = n;
            state.chainConfig.gain.gain_db = gain;
            // Update the numeric summary chips in the card so gain_db
            // and target_lufs reflect the new slider position immediately.
            refreshGainCardNumbers(n, gain);
            hide(dom.previewWrap);
          };
          slider.addEventListener("input", (e) => sync(e.target.value));
          numInput.addEventListener("change", (e) => sync(e.target.value));
          // Wheel over the number input nudges target LUFS by 0.5 dB per
          // tick (shift+wheel = 0.05 dB). Prevents the page from scrolling.
          attachWheelNudge(numInput, 0.5, -20, -6);
        } else {
          // Tilt / limiter sliders: direct parameter control.
          const key = (card.step === "limiter") ? "ceiling_dbfs" : "gain_db";
          const sync = (v) => {
            const n = parseFloat(v);
            if (Number.isNaN(n)) return;
            slider.value = n;
            numInput.value = n.toFixed(1);
            state.chainConfig[card.step][key] = n;
            // Refresh the in-card display so the chips and header reflect
            // the actual active value, not the initial proposal. Without
            // this the user can't tell whether their slider move took
            // effect — one of the worst possible UX failures on a DSP tool.
            refreshCardDisplay(card.step, n);
            hide(dom.previewWrap);
          };
          slider.addEventListener("input", (e) => sync(e.target.value));
          numInput.addEventListener("change", (e) => sync(e.target.value));
          // Wheel range per card step.
          if (card.step === "limiter") {
            attachWheelNudge(numInput, 0.1, -3, -0.5);
          } else if (card.step === "tilt") {
            attachWheelNudge(numInput, 0.1, -3, 3);
          }
        }
      }
    });
  }

  /**
   * Refresh the display of tilt or limiter cards when their slider moves.
   * Updates:
   *   - the numeric summary chip that matches this slider's parameter
   *   - the header delta chip (top-right)
   *   - the rationale text (if it contains stale numbers the user can see)
   *
   * For Loudness, use refreshGainCardNumbers() instead — it has card-specific
   * logic because the slider is target-LUFS not a direct parameter.
   */
  function refreshCardDisplay(step, value) {
    const card = $(`mst-card-${step}`);
    if (!card) return;
    // The summary chip whose label matches the slider's parameter
    card.querySelectorAll(".mst-num-box").forEach(box => {
      const label = box.querySelector(".mst-num-label");
      const val = box.querySelector(".mst-num-value");
      if (!label || !val) return;
      const key = label.textContent.trim().toLowerCase();
      if (step === "limiter" && key.includes("ceiling")) {
        val.textContent = fmtNum(value, 1) + " dBFS";
      } else if (step === "tilt" && key.includes("gain")) {
        val.textContent = fmtDb(value, 1) + " dB";
      }
    });
    // Header delta chip
    const delta = card.querySelector(".mst-card-delta");
    if (delta) {
      if (step === "limiter") {
        delta.textContent = fmtNum(value, 1) + " dBFS";
      } else if (step === "tilt") {
        delta.textContent = `${fmtDb(value, 1)} dB @ 8 kHz`;
      }
    }
    // Rationale text: regenerate to replace stale numbers.
    // These templates mirror the ones in master_engine.py — keep in sync.
    const rationale = card.querySelector(".mst-card-rationale");
    if (rationale) {
      if (step === "limiter") {
        // The limiter rationale mentions the ceiling value twice: "Ceiling
        // at X dBFS ..." and "pushing peaks above X dBFS". Use a global
        // match to update both at once.
        const txt = rationale.textContent;
        const updated = txt
          .replace(/Ceiling at [+\-]?\d+(\.\d+)? dBFS/g,
                   `Ceiling at ${fmtNum(value, 1)} dBFS`)
          .replace(/above [+\-]?\d+(\.\d+)? dBFS/g,
                   `above ${fmtNum(value, 1)} dBFS`);
        if (updated !== txt) rationale.textContent = updated;
      } else if (step === "tilt") {
        // Same strategy: replace the gain value in the proposed shelf phrase.
        const txt = rationale.textContent;
        const updated = txt.replace(
          /[+\-]\d+(\.\d+)? dB shelf/,
          `${fmtDb(value, 1)} dB shelf`
        );
        if (updated !== txt) rationale.textContent = updated;
      }
    }
  }

  /**
   * Refresh the gain card's numeric summary chips without re-rendering the
   * whole card (which would reset the slider focus/drag state).
   */
  function refreshGainCardNumbers(targetLufs, gainDb) {
    const card = $("mst-card-gain");
    if (!card) return;
    card.querySelectorAll(".mst-num-box").forEach(box => {
      const label = box.querySelector(".mst-num-label");
      const val = box.querySelector(".mst-num-value");
      if (!label || !val) return;
      const key = label.textContent.trim().toLowerCase();
      if (key.includes("target")) {
        val.textContent = fmtNum(targetLufs, 1) + " LUFS";
      } else if (key.includes("gain")) {
        val.textContent = fmtDb(gainDb, 1) + " dB";
      }
    });
    // Also update the header delta chip
    const delta = card.querySelector(".mst-card-delta");
    if (delta) delta.textContent = `${fmtDb(gainDb)} dB`;
  }

  function updateCardAcceptedClass(step) {
    const el = $(`mst-card-${step}`);
    if (!el) return;
    if (state.chainConfig[step] && state.chainConfig[step].enabled) {
      el.classList.add("accepted");
    } else {
      el.classList.remove("accepted");
    }
  }

  function cardHtml(card, idx) {
    const step = card.step;
    const acceptedClass = card.accept ? "accepted" : "";
    const checkedAttr = card.accept ? "checked" : "";

    // Numeric summary chips inside the card
    const nums = card.numbers || {};
    const numBoxes = Object.entries(nums).map(([k, v]) => `
      <div class="mst-num-box">
        <div class="mst-num-label">${prettyNumLabel(k)}</div>
        <div class="mst-num-value">${prettyNumValue(k, v)}</div>
      </div>
    `).join("");

    // Slider row — different target per card
    let sliderHtml = "";
    if (step === "gain") {
      // Slider controls target LUFS (not gain). Range covers quiet master
      // through loudness-war territory.
      const val = nums.target_lufs ?? -14;
      sliderHtml = sliderRowHtml(step, "Target LUFS", val, -20, -6, 0.5);
    } else if (step === "tilt") {
      const val = nums.gain_db ?? 0;
      sliderHtml = sliderRowHtml(step, "Gain (dB)", val, -3, 3, 0.1);
    } else if (step === "limiter") {
      const val = nums.ceiling_dbfs ?? -1;
      sliderHtml = sliderRowHtml(step, "Ceiling (dBFS)", val, -3, -0.5, 0.1);
    }

    // Delta hint in header
    let headerDelta = "";
    if (step === "gain" && nums.gain_db !== undefined) {
      headerDelta = `${fmtDb(nums.gain_db)} dB`;
    } else if (step === "limiter" && nums.expected_reduction_db !== undefined && nums.expected_reduction_db > 0.1) {
      headerDelta = `~${fmtNum(nums.expected_reduction_db)} dB GR`;
    } else if (step === "tilt" && nums.gain_db !== undefined && Math.abs(nums.gain_db) >= 0.1) {
      headerDelta = `${fmtDb(nums.gain_db)} dB @ 8 kHz`;
    }

    return `
      <div class="mst-card ${acceptedClass}" id="mst-card-${step}">
        <div class="mst-card-header">
          <input type="checkbox" class="mst-card-toggle" id="mst-toggle-${step}" ${checkedAttr}>
          <span class="mst-card-num">${idx + 1}</span>
          <span class="mst-card-title">${card.title}</span>
          <span class="mst-card-delta">${headerDelta}</span>
        </div>
        <div class="mst-card-body">
          <div class="mst-card-rationale">${card.rationale}</div>
          <div class="mst-card-numbers">${numBoxes}</div>
          ${sliderHtml}
        </div>
      </div>
    `;
  }

  function sliderRowHtml(step, label, value, min, max, step_) {
    return `
      <div class="mst-slider-row">
        <label for="mst-slider-${step}">${label}</label>
        <input type="range" id="mst-slider-${step}"
               min="${min}" max="${max}" step="${step_}" value="${value}">
        <input type="number" id="mst-num-${step}"
               min="${min}" max="${max}" step="${step_}" value="${Number(value).toFixed(1)}">
      </div>
    `;
  }

  function prettyNumLabel(k) {
    const map = {
      current_lufs: "Current LUFS",
      target_lufs: "Target LUFS",
      gain_db: "Gain (dB)",
      ceiling_dbfs: "Ceiling (dBFS)",
      expected_reduction_db: "Expected GR (dB)",
      oversample: "Oversample",
      shelf_freq_hz: "Shelf freq",
      presence_delta_db: "Presence Δ",
      air_delta_db: "Air Δ",
    };
    return map[k] || k;
  }

  function prettyNumValue(k, v) {
    if (k === "shelf_freq_hz") return (v / 1000).toFixed(0) + " kHz";
    if (k === "oversample") return v + "×";
    if (k === "target_lufs" || k === "current_lufs") return fmtNum(v, 1) + " LUFS";
    if (k === "ceiling_dbfs") return fmtNum(v, 1) + " dBFS";
    if (k === "gain_db") return fmtDb(v, 1) + " dB";
    if (k.endsWith("_delta_db")) return fmtDb(v, 1) + " dB";
    if (k === "expected_reduction_db") return fmtNum(v, 1) + " dB";
    return String(v);
  }

  // ---------- Reset / new ----------
  dom.btnReset.addEventListener("click", () => {
    if (!state.proposal) return;
    state.chainConfig = JSON.parse(JSON.stringify(state.proposal.config));
    renderCards();
    hide(dom.previewWrap);
  });

  dom.btnNew.addEventListener("click", () => {
    if (state.isBusy) return;
    state.masterUploadId = null;
    state.sourceFilename = null;
    state.sourceFile = null;
    state.proposal = null;
    state.chainConfig = null;
    state.previewSourceUrl = null;
    state.previewMasterUrl = null;
    // Reset 6-band EQ state + mono-bass check + sides-air check
    resetGeq();
    state.msBass = null;
    state.msAir = null;
    if (dom.msBassCard) dom.msBassCard.style.display = "none";
    if (dom.msAirCard) dom.msAirCard.style.display = "none";
    // Any loaded reference is bound to the old source
    resetRefMatch();
    // New session = clear per-track metadata (Artist/Album keep via localStorage)
    if (typeof window.__anvilResetMetaPerTrack === "function") {
      window.__anvilResetMetaPerTrack();
    }
    hide(dom.proposalSection);
    show(dom.uploadSection);
    dom.fileInput.value = "";
  });

  // ---------- 6-band EQ (Suggested / Manual) ----------
  //
  // This card parallels Reference Match but deltas come from the mix's
  // comparison to genre targets (Suggested mode) or from nothing at all
  // (Manual mode — user dials in their own moves).
  //
  // Shared with ref-match: bell DOM structure, EQ curve SVG, ±4 dB clamps,
  // min 0.3 dB engage threshold. Different: chain-config key ("genre_match"),
  // suggestion scaling (uses mix-vs-target delta not mix-vs-reference), and
  // an "Apply in chain" toggle (ref-match auto-applies on upload; genre-eq
  // is explicit opt-in so users don't accidentally layer 6 bells on top of
  // whatever else they've enabled).

  /**
   * Set which tonal correction source is active. Mutually exclusive between
   * the suggested 6-band EQ and Reference Match — only one feeds the chain
   * at any time to avoid double tonal correction.
   *
   * Switching sources preserves both panels' state (loaded reference file,
   * configured bells) — the inactive one is just hidden, not reset. This
   * matches the UX pattern of the old Suggest/Manual toggle.
   *
   * Chain-config wiring: we flip the underlying `state.geqEnabled` /
   * `state.refMatch.enabled` flags and call the sync functions. That way
   * the chain config stays consistent regardless of which path the user
   * takes to get there — toggling the tonal source, toggling the
   * Apply-in-chain checkboxes, or both.
   *
   * We do NOT auto-enable the newly-active source. The user still has to
   * tick "Apply in chain" on the side they want to actually use. This
   * prevents the toggle from silently changing what the preview will sound
   * like — switching tabs just reveals the panel, not activates it.
   */
  function setTonalSource(source) {
    if (source !== "eq" && source !== "refmatch") return;
    if (source === state.tonalSource) return;
    state.tonalSource = source;

    // Segmented control visual state
    if (dom.tonalModeGroup) {
      dom.tonalModeGroup.querySelectorAll(".mst-eq-mode-btn").forEach(b => {
        const active = b.dataset.tonal === source;
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", active ? "true" : "false");
      });
    }

    // Panel visibility
    if (source === "eq") {
      if (dom.geqPanel) dom.geqPanel.classList.remove("mst-hidden");
      if (dom.refPanel) dom.refPanel.classList.add("mst-hidden");
    } else {
      if (dom.geqPanel) dom.geqPanel.classList.add("mst-hidden");
      if (dom.refPanel) dom.refPanel.classList.remove("mst-hidden");
    }

    // Chain wiring: forcibly disable the inactive source so the chain never
    // runs both tonal stages at once. We flip the underlying enabled flag
    // (not just the chain-config entry) and re-sync so the checkbox UI stays
    // visually accurate too — a user switching back to a previously-enabled
    // panel will see the checkbox unticked, matching the actual chain state.
    if (source === "eq") {
      if (state.refMatch) state.refMatch.enabled = false;
      if (dom.refEnabled) dom.refEnabled.checked = false;
      syncRefMatchIntoChain();
    } else {
      state.geqEnabled = false;
      if (dom.geqEnabled) dom.geqEnabled.checked = false;
      syncGeqIntoChain();
    }
    // Preview is now stale since the chain has effectively changed
    if (dom.previewWrap) hide(dom.previewWrap);
  }

  if (dom.tonalModeGroup) {
    dom.tonalModeGroup.querySelectorAll(".mst-eq-mode-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        setTonalSource(btn.dataset.tonal);
      });
      btn.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setTonalSource(btn.dataset.tonal);
        }
      });
    });
  }

  if (dom.geqCorrSlider) {
    // Force the slider to its canonical initial value on load. Don't trust
    // the HTML `value="50"` attribute — browser form-autofill can restore
    // a cached value from a previous session which would desync the visual
    // slider from state.geqCorrectionPct.
    dom.geqCorrSlider.value = state.geqCorrectionPct;
    dom.geqCorrVal.textContent = state.geqCorrectionPct + "%";

    dom.geqCorrSlider.addEventListener("input", (e) => {
      state.geqCorrectionPct = parseInt(e.target.value, 10);
      dom.geqCorrVal.textContent = state.geqCorrectionPct + "%";
    });
    // On release: rescale bells AND their rationale text client-side.
    // This is instant — no server round-trip, no re-analysis of the mix.
    // The original bug was that rescale didn't touch rationale text so it
    // showed stale gain values; now we regenerate the text to match.
    dom.geqCorrSlider.addEventListener("change", () => rescaleGeqBells());
  }

  if (dom.geqEnabled) {
    dom.geqEnabled.addEventListener("change", () => {
      state.geqEnabled = dom.geqEnabled.checked;
      // Track explicit opt-out so auto-enable doesn't silently re-check
      // the box after the user disabled it.
      state.geqUserDismissed = !dom.geqEnabled.checked;
      syncGeqIntoChain();
      hide(dom.previewWrap);
    });
  }

  /**
   * Auto-enable 'Apply in chain' in response to a bell interaction.
   * Fires when the user toggles a bell on, sets a non-trivial gain, or
   * moves the correction slider — meaning they're clearly engaging with
   * the EQ and would probably expect it to take effect.
   *
   * Respects explicit user opt-out: if the user unchecked 'Apply in chain'
   * by hand, we don't re-check it automatically on subsequent interactions.
   */
  function maybeAutoEnableGeq() {
    if (state.geqEnabled) return;          // already on, nothing to do
    if (state.geqUserDismissed) return;    // user explicitly opted out
    if (!state.geqProposal) return;
    // Only auto-enable if at least one bell is active at >= 0.3 dB —
    // otherwise enabling would produce a no-op chain stage.
    const anyActive = state.geqProposal.bells.some(b => b.accept);
    if (!anyActive) return;
    state.geqEnabled = true;
    if (dom.geqEnabled) dom.geqEnabled.checked = true;
  }

  /**
   * Called when the mix has been analyzed (masterUploadId is set) and we need
   * to populate the 6-band EQ card. Also called on mode toggle.
   */
  function fetchGeqProposal() {
    if (!state.masterUploadId) return;
    state.geqBusy = true;

    const corr = state.geqCorrectionPct / 100;
    fetch("/genre-eq-proposal", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        master_upload_id: state.masterUploadId,
        correction_ratio: corr,
      }),
    })
      .then(r => r.json().then(j => ({ok: r.ok, body: j})))
      .then(({ok, body}) => {
        state.geqBusy = false;
        if (!ok) {
          console.warn("Genre EQ proposal failed:", body.error);
          return;
        }
        state.geqProposal = body.proposal;
        renderGeqProposal();
      })
      .catch(err => {
        state.geqBusy = false;
        console.warn("Genre EQ fetch failed:", err);
      });
  }

  function renderGeqProposal() {
    if (!state.geqProposal) return;
    const p = state.geqProposal;

    // Single-mode description — Suggest/Manual toggle was removed, bells
    // are always suggested and editable.
    dom.geqDesc.textContent =
      "Half-correction toward genre norms. Adjust each bell or disable bells you disagree with.";

    // Comparison strip
    renderGeqCompare(p.comparison);
    // Bell list
    renderGeqBells(p.bells);
    // EQ curve
    refreshGeqEqCurve();
    // Sync the enabled toggle visual (doesn't reflect chain enabled state —
    // reflects the user's "Apply in chain" preference only)
    dom.geqEnabled.checked = state.geqEnabled;
    syncGeqIntoChain();
  }

  function renderGeqCompare(comparison) {
    const html = (comparison || []).map(c => {
      const delta = c.delta_db;
      const cls = Math.abs(delta) < 1.0 ? "small"
                : delta > 0 ? "bright" : "dark";
      const tgt = c.target_vs_pink_db;
      const tgtStr = (tgt === null || tgt === undefined) ? "—" : fmtDb(tgt, 1);
      const deltaTxt = `${delta > 0 ? "+" : ""}${fmtNum(delta, 1)} dB`;
      return `
        <div class="mst-cmp-cell">
          <div class="mst-cmp-band">${c.band.replace("_"," ")}</div>
          <div class="mst-cmp-row"><span class="lbl">mix</span><span class="val">${fmtDb(c.mix_vs_pink_db, 1)}</span></div>
          <div class="mst-cmp-row"><span class="lbl">target</span><span class="val">${tgtStr}</span></div>
          <div class="mst-cmp-delta ${cls}">${deltaTxt}</div>
        </div>`;
    }).join("");
    dom.geqCompare.innerHTML = html;
  }

  function renderGeqBells(bells) {
    const BAND_LABELS = {
      sub: "Sub", bass: "Bass", low_mid: "Low-mid",
      mid: "Mid", presence: "Presence", air: "Air"
    };
    const fmtFreq = (hz) => hz < 1000 ? `${hz.toFixed(0)} Hz` : `${(hz/1000).toFixed(1)} kHz`;

    dom.geqBells.innerHTML = bells.map(b => {
      const acceptedCls = b.accept ? "accepted" : "";
      const checkedAttr = b.accept ? "checked" : "";
      const gainCls = Math.abs(b.gain_db) < 0.3 ? "zero"
                    : b.gain_db > 0 ? "pos" : "neg";
      return `
        <div class="mst-bell ${acceptedCls}" data-band="${b.band}">
          <input type="checkbox" class="mst-bell-toggle" id="mst-geq-tog-${b.band}" ${checkedAttr}>
          <div class="mst-bell-label">
            ${BAND_LABELS[b.band] || b.band}
            <br><small>${fmtFreq(b.freq_hz)} · Q ${b.q.toFixed(1)}</small>
          </div>
          <div class="mst-bell-rationale">${escapeHtml(b.rationale)}</div>
          <input type="number" class="mst-bell-num" id="mst-geq-num-${b.band}"
                 min="-4" max="4" step="0.1" value="${b.gain_db.toFixed(1)}">
          <div class="mst-bell-gain ${gainCls}">${fmtDb(b.gain_db, 1)} dB</div>
        </div>`;
    }).join("");

    // Wire per-bell toggle + number input
    bells.forEach(b => {
      const tog = $(`mst-geq-tog-${b.band}`);
      const num = $(`mst-geq-num-${b.band}`);
      if (tog) {
        tog.addEventListener("change", () => {
          b.accept = tog.checked;
          const cb = state.geqProposal.config.bells.find(cc => cc.band === b.band);
          if (cb) cb.enabled = tog.checked;
          state.geqProposal.config.enabled = state.geqProposal.bells.some(x => x.accept);
          const row = tog.closest(".mst-bell");
          if (row) row.classList.toggle("accepted", tog.checked);
          // Auto-enable 'Apply in chain' if the user is turning a bell ON.
          // Don't auto-enable on bell-off (that would be wrong direction).
          if (tog.checked) maybeAutoEnableGeq();
          syncGeqIntoChain();
          refreshGeqEqCurve();
          hide(dom.previewWrap);
        });
      }
      if (num) {
        num.addEventListener("change", () => {
          let v = parseFloat(num.value);
          if (isNaN(v)) return;
          v = Math.max(-4, Math.min(4, v));
          v = Math.round(v * 10) / 10;
          num.value = v.toFixed(1);
          b.gain_db = v;
          b.numbers.suggested_gain_db = v;
          b.accept = Math.abs(v) >= 0.3;
          const tog = $(`mst-geq-tog-${b.band}`);
          if (tog) tog.checked = b.accept;
          const cb = state.geqProposal.config.bells.find(cc => cc.band === b.band);
          if (cb) {
            cb.gain_db = v;
            cb.enabled = b.accept;
          }
          state.geqProposal.config.enabled = state.geqProposal.bells.some(x => x.accept);
          const row = num.closest(".mst-bell");
          if (row) row.classList.toggle("accepted", b.accept);
          const gainEl = row && row.querySelector(".mst-bell-gain");
          if (gainEl) {
            gainEl.textContent = fmtDb(v, 1) + " dB";
            gainEl.className = "mst-bell-gain " + (Math.abs(v) < 0.3 ? "zero" : v > 0 ? "pos" : "neg");
          }
          // Auto-enable only if the user dialed in a meaningful gain (not
          // if they zeroed out a previously-active bell).
          if (b.accept) maybeAutoEnableGeq();
          syncGeqIntoChain();
          refreshGeqEqCurve();
          hide(dom.previewWrap);
        });
        // Wheel over the bell number nudges gain by 0.1 dB per tick
        // (shift+wheel = 0.01 dB). Prevents page scroll.
        attachWheelNudge(num, 0.1, -4, 4);
      }
    });
  }

  /**
   * Only makes sense in Suggested mode. Rescales all bell gains against the
   * raw delta with the new correction ratio. Also regenerates the rationale
   * text so the user sees consistent numbers in both the gain field and the
   * sentence next to it. Instant — no server hop.
   */
  function rescaleGeqBells() {
    if (!state.geqProposal) return;
    const newRatio = state.geqCorrectionPct / 100;
    const oldRatio = state.geqProposal.correction_ratio || 0.5;
    if (Math.abs(newRatio - oldRatio) < 0.005) return;

    state.geqProposal.bells.forEach(b => {
      const delta = b.numbers.delta_db;
      let g = -delta * newRatio;
      g = Math.max(-4, Math.min(4, g));
      g = Math.round(g * 100) / 100;
      b.gain_db = g;
      b.numbers.suggested_gain_db = g;
      b.accept = Math.abs(g) >= 0.3;
      // Regenerate rationale with the new gain so text and field agree
      b.rationale = formatGenreBellRationale(
        b.band, b.numbers.mix_vs_pink_db, b.numbers.target_vs_pink_db, delta, g
      );
    });
    state.geqProposal.correction_ratio = newRatio;
    state.geqProposal.config.bells.forEach(cb => {
      const bell = state.geqProposal.bells.find(b => b.band === cb.band);
      if (bell) { cb.gain_db = bell.gain_db; cb.enabled = bell.accept; }
    });
    state.geqProposal.config.enabled = state.geqProposal.bells.some(b => b.accept);

    renderGeqBells(state.geqProposal.bells);
    // Moving the correction slider counts as engagement → auto-enable.
    // (Respects explicit opt-out via state.geqUserDismissed.)
    maybeAutoEnableGeq();
    syncGeqIntoChain();
    refreshGeqEqCurve();
    hide(dom.previewWrap);
  }

  /**
   * Mirrors the genre-eq state into chainConfig.genre_match. Respects the
   * "Apply in chain" toggle — even if individual bells are accepted, the
   * whole stage is disabled unless the user explicitly opts in.
   */
  function syncGeqIntoChain() {
    if (!state.chainConfig) return;
    if (!state.geqProposal || !state.geqEnabled) {
      delete state.chainConfig.genre_match;
      return;
    }
    state.chainConfig.genre_match = {
      enabled: state.geqEnabled,
      bells: JSON.parse(JSON.stringify(state.geqProposal.config.bells)),
      correction_ratio: state.geqProposal.correction_ratio,
    };
  }

  function refreshGeqEqCurve() {
    if (!state.geqProposal) { drawGeqEqCurve({freqs_hz: [], magnitude_db: []}); return; }
    const bells = state.geqProposal.config.bells
      .filter(cb => cb.enabled && Math.abs(cb.gain_db) >= 0.3)
      .map(cb => ({freq: cb.freq, gain_db: cb.gain_db, q: cb.q}));
    if (!bells.length) { drawGeqEqCurve({freqs_hz: [], magnitude_db: []}); return; }
    fetch("/eq-curve", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({bells, sample_rate: 48000, n_points: 160}),
    })
      .then(r => r.json())
      .then(data => drawGeqEqCurve(data))
      .catch(() => {});
  }

  function drawGeqEqCurve(data) {
    // Same as drawEqCurve but targets the genre-eq SVG container.
    const W = 600, H = 120;
    const freqs = data.freqs_hz || [];
    const mags = data.magnitude_db || [];

    if (!freqs.length) {
      dom.geqCurveSvg.innerHTML = `
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
          <line x1="0" y1="${H/2}" x2="${W}" y2="${H/2}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3,3" opacity="0.4"/>
          <text x="10" y="${H/2 + 4}" fill="var(--muted)" font-family="monospace" font-size="10">No EQ active</text>
        </svg>`;
      return;
    }
    const logFmin = Math.log10(20), logFmax = Math.log10(20000);
    const xFor = (f) => ((Math.log10(f) - logFmin) / (logFmax - logFmin)) * W;
    const dbMin = -6, dbMax = +6;
    const yFor = (db) => H - ((db - dbMin) / (dbMax - dbMin)) * H;
    const pts = freqs.map((f, i) => `${xFor(f).toFixed(1)},${yFor(mags[i]).toFixed(1)}`).join(" ");
    const zeroY = yFor(0);
    const fillPts = `${xFor(freqs[0]).toFixed(1)},${zeroY} ` + pts +
                    ` ${xFor(freqs[freqs.length-1]).toFixed(1)},${zeroY}`;
    dom.geqCurveSvg.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <line x1="0" y1="${yFor(3)}" x2="${W}" y2="${yFor(3)}" stroke="var(--border)" stroke-width="0.5" opacity="0.4"/>
        <line x1="0" y1="${yFor(-3)}" x2="${W}" y2="${yFor(-3)}" stroke="var(--border)" stroke-width="0.5" opacity="0.4"/>
        <line x1="0" y1="${zeroY}" x2="${W}" y2="${zeroY}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="4,3" opacity="0.5"/>
        <text x="${xFor(100)}" y="${H - 3}" fill="var(--muted)" font-family="monospace" font-size="9" text-anchor="middle">100</text>
        <text x="${xFor(1000)}" y="${H - 3}" fill="var(--muted)" font-family="monospace" font-size="9" text-anchor="middle">1k</text>
        <text x="${xFor(10000)}" y="${H - 3}" fill="var(--muted)" font-family="monospace" font-size="9" text-anchor="middle">10k</text>
        <polygon points="${fillPts}" fill="var(--accent)" opacity="0.12"/>
        <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>`;
  }

  function resetGeq() {
    state.geqProposal = null;
    state.geqEnabled = false;
    state.geqCorrectionPct = 50;
    state.geqUserDismissed = false;    // new source = clean slate
    if (dom.geqEnabled) dom.geqEnabled.checked = false;
    if (dom.geqCorrSlider) dom.geqCorrSlider.value = 50;
    if (dom.geqCorrVal) dom.geqCorrVal.textContent = "50%";
    if (dom.geqCorrWrap) dom.geqCorrWrap.style.display = "";
    if (dom.geqBells) dom.geqBells.innerHTML = "";
    if (dom.geqCompare) dom.geqCompare.innerHTML = "";
    if (dom.geqCurveSvg) dom.geqCurveSvg.innerHTML = "";
    // Reset tonal source back to default ("eq"). Done here rather than in
    // a dedicated resetTonalSource() because this is the only path that
    // needs it — New Source triggers a full re-analysis anyway.
    state.tonalSource = "eq";
    if (dom.tonalModeGroup) {
      dom.tonalModeGroup.querySelectorAll(".mst-eq-mode-btn").forEach(b => {
        const active = b.dataset.tonal === "eq";
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", active ? "true" : "false");
      });
    }
    if (dom.geqPanel) dom.geqPanel.classList.remove("mst-hidden");
    if (dom.refPanel) dom.refPanel.classList.add("mst-hidden");
  }

  // ---------- Preview render ----------
  dom.btnPreview.addEventListener("click", () => {
    if (!state.masterUploadId || !state.chainConfig) return;
    setBusy(true);
    dom.btnPreview.innerHTML = '<span class="mst-loading"></span> Rendering...';

    fetch("/preview-master", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        master_upload_id: state.masterUploadId,
        chain_config: state.chainConfig,
      }),
    })
      .then(r => r.json().then(j => ({ok: r.ok, body: j})))
      .then(({ok, body}) => {
        setBusy(false);
        dom.btnPreview.innerHTML = "Render preview";
        if (!ok) {
          alert("Preview failed: " + (body.error || "unknown"));
          return;
        }
        state.previewSourceUrl = body.source_url;
        state.previewMasterUrl = body.preview_url;
        dom.audioSource.src = body.source_url;
        dom.audioMaster.src = body.preview_url;
        renderVerification(body.measurement, body.stats);
        show(dom.previewWrap);
        dom.previewWrap.scrollIntoView({ behavior: "smooth", block: "start" });
      })
      .catch(err => {
        setBusy(false);
        dom.btnPreview.innerHTML = "Render preview";
        alert("Preview failed: " + err.message);
      });
  });

  // Make the A/B player mutually exclusive for quick toggling
  dom.audioSource.addEventListener("play",  () => {
    dom.audioMaster.pause();
    dom.audioSource.closest(".mst-ab-row").classList.add("active");
    dom.audioMaster.closest(".mst-ab-row").classList.remove("active");
  });
  dom.audioMaster.addEventListener("play",  () => {
    dom.audioSource.pause();
    dom.audioMaster.closest(".mst-ab-row").classList.add("active");
    dom.audioSource.closest(".mst-ab-row").classList.remove("active");
  });

  function renderVerification(meas, stats) {
    const checks = meas.checks || {};
    const lufsOk = checks.lufs_in_range;
    const peakOk = checks.true_peak_safe;

    // Detect intentional trim-skip (Loudness card off = upstream loudness preserved)
    const trimStage = (stats.stages || []).find(s => s.name === "trim");
    const trimSkipped = trimStage && trimStage.skipped;
    const loudnessPreserved = trimSkipped &&
      /upstream loudness preserved/i.test(trimStage.reason || "");

    // Peak-safety warning when limiter off and post-tilt peaks exceed ceiling
    const peakWarning = stats.peak_safety_warning || null;

    // LUFS box — treat loudness-preserved as informational, not a failure
    const lufsBox = loudnessPreserved
      ? {
          label: "Integrated LUFS",
          value: fmtNum(meas.integrated_lufs, 2) + " LUFS",
          target: "source loudness preserved (loudness card off)",
          cls: "note",
        }
      : {
          label: "Integrated LUFS",
          value: fmtNum(meas.integrated_lufs, 2) + " LUFS",
          target: "target " + fmtNum(meas.target_lufs, 1) + " · " + (lufsOk ? "pass" : "outside target"),
          cls: lufsOk ? "pass" : "fail",
        };

    // True peak box — if the peak_safety_warning fired, show it with that context
    const peakBox = peakWarning
      ? {
          label: "True peak",
          value: fmtNum(meas.true_peak_dbfs, 2) + " dBFS",
          target: `ceiling ${fmtNum(meas.ceiling_dbfs, 1)} · overshoot ${fmtNum(peakWarning.overshoot_db, 2)} dB`,
          cls: "fail",
        }
      : {
          label: "True peak",
          value: fmtNum(meas.true_peak_dbfs, 2) + " dBFS",
          target: "ceiling " + fmtNum(meas.ceiling_dbfs, 1) + " · " + (peakOk ? "pass" : "outside target"),
          cls: peakOk ? "pass" : "fail",
        };

    const boxes = [lufsBox, peakBox];

    dom.verify.innerHTML = boxes.map(b => `
      <div class="mst-verify-box ${b.cls}">
        <div class="mst-verify-label">${b.label}</div>
        <div class="mst-verify-value">${b.value}</div>
        <div class="mst-verify-target">${b.target}</div>
      </div>
    `).join("");

    // Peak-safety warning + one-click fix CTA
    if (peakWarning) {
      const warnBox = document.createElement("div");
      warnBox.className = "mst-warning";
      warnBox.style.cssText = "margin-top:12px";
      warnBox.innerHTML = `
        <span class="mst-warning-icon">!</span>${escapeHtml(peakWarning.message)}
        <div style="margin-top:10px">
          <button class="mst-btn mst-btn-secondary" id="mst-enable-limiter-btn"
                  style="padding:8px 14px;font-size:11px">
            Enable limiter &amp; re-render
          </button>
        </div>
      `;
      dom.verify.appendChild(warnBox);
      const btn = $("mst-enable-limiter-btn");
      if (btn) {
        btn.addEventListener("click", () => {
          // Flip limiter on in chainConfig, reflect in UI, re-render preview
          if (state.chainConfig && state.chainConfig.limiter) {
            state.chainConfig.limiter.enabled = true;
            // Sync the card toggle
            const tog = $("mst-toggle-limiter");
            if (tog) tog.checked = true;
            updateCardAcceptedClass("limiter");
            // Trigger a fresh preview
            dom.btnPreview.click();
          }
        });
      }
    }

    // Limiter stats note (unchanged)
    const lim = (stats.stages || []).find(s => s.name === "limiter");
    if (lim && lim.max_gain_reduction_db > 0.1) {
      const note = document.createElement("div");
      note.className = "mst-muted";
      note.style.cssText = "margin-top:10px;font-family:var(--font-mono);font-size:11px";
      note.textContent =
        `Limiter engaged ${lim.pct_limited.toFixed(1)}% of audio, ` +
        `max reduction ${fmtNum(lim.max_gain_reduction_db, 1)} dB, ` +
        `average ${fmtNum(lim.avg_gain_reduction_db, 1)} dB.`;
      dom.verify.appendChild(note);
    }
  }

  // ---------- Export ----------
  //
  // One POST per checked format. Each returns the raw audio file directly
  // (no zip, no JSON sidecar).
  //
  // Saving to disk uses window.showSaveFilePicker() on Chromium-based
  // browsers so the user sees a native Save-As dialog and can pick a
  // location + filename. On Firefox/Safari (no picker API) we fall back
  // to the classic <a download> approach, which respects the browser's
  // own "ask where to save" setting.
  //
  // CRITICAL: showSaveFilePicker needs a "transient activation" (a recent
  // user gesture). Chrome gives us ~5 seconds from the button click before
  // that activation expires. A server render on a 3-min mix takes longer
  // than that, so we CANNOT do fetch-then-picker — the picker would refuse.
  // Instead we show ALL pickers first (while the gesture is fresh), collect
  // file handles, THEN start rendering. User picks locations up front, then
  // walks away while the renders run.
  dom.btnExport.addEventListener("click", () => {
    if (!state.masterUploadId || !state.chainConfig) return;

    // Only one format is supported. Kept as an array for historical reasons —
    // the phase-1/phase-2 picker loop below was built to support multi-format
    // export, and a single-element array makes it a no-op loop rather than
    // requiring a structural rewrite. If we ever add another format, the
    // loop already handles it.
    const formats = ["wav24"];

    const hasPicker = typeof window.showSaveFilePicker === "function";

    // Same filename rule the server uses (so pre-picker suggestions match
    // what would come back in Content-Disposition).
    const base = (state.sourceFilename || "mix")
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]/g, "_");
    const defaultNameByFmt = {
      wav24:   `${base}_mastered_24bit.wav`,
    };
    const pickerTypesByFmt = {
      wav24:   [{description: "WAV audio", accept: {"audio/wav":  [".wav"]}}],
    };

    // ---- PHASE 1: collect file handles (all in the user-gesture window) ----
    //
    // For each format, show a save picker. Result is:
    //   {fmt, handle, filename}  — user picked, we have a writable handle
    //   {fmt, skip: true}        — user cancelled this specific picker
    //   null                     — picker unavailable entirely → full fallback
    //
    // We collect these synchronously-as-possible, awaiting only the picker
    // itself. No fetches, no setTimeouts, nothing that would break the
    // gesture chain.
    (async () => {
      let targets = [];           // {fmt, handle, filename} entries
      let pickerFailed = false;   // true if any picker threw SecurityError

      if (hasPicker) {
        for (const fmt of formats) {
          const filename = defaultNameByFmt[fmt] || `${base}_mastered`;
          try {
            const handle = await window.showSaveFilePicker({
              suggestedName: filename,
              types: pickerTypesByFmt[fmt] || [],
            });
            targets.push({fmt, handle, filename});
          } catch (err) {
            if (err && err.name === "AbortError") {
              // User cancelled THIS picker — skip just this format
              targets.push({fmt, skip: true, filename});
              continue;
            }
            if (err && err.name === "SecurityError") {
              // Gesture expired somehow (shouldn't happen pre-fetch, but
              // be defensive). Fall back to anchor path for everything
              // we haven't committed to yet.
              pickerFailed = true;
              break;
            }
            // Something else unexpected — abort the whole export.
            alert("Save dialog failed: " + err.message);
            return;
          }
        }
      }

      // If the user cancelled ALL pickers, nothing to do.
      if (hasPicker && !pickerFailed &&
          targets.every(t => t.skip)) {
        return;
      }

      // ---- PHASE 2: render + write ----
      //
      // Show busy state, then for each target (or for each format in the
      // full-fallback path) render and save.

      setBusy(true);
      dom.btnExport.innerHTML = '<span class="mst-loading"></span> Exporting...';

      async function fetchOne(fmt, persistReport) {
        const resp = await fetch("/export-master", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            master_upload_id: state.masterUploadId,
            chain_config: state.chainConfig,
            source_filename: state.sourceFilename || "mix.wav",
            format: fmt,
            persist_report: persistReport,
            metadata: collectMetadata(),
          }),
        });
        if (!resp.ok) {
          const j = await resp.json().catch(() => ({error: "unknown"}));
          throw new Error(j.error || "export failed");
        }
        const cd = resp.headers.get("content-disposition") || "";
        const match = cd.match(/filename="?([^";]+)"?/);
        const serverName = match ? match[1] : null;
        return {blob: await resp.blob(), serverName};
      }

      function saveViaAnchor(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
      }

      try {
        if (!hasPicker || pickerFailed) {
          // Full fallback path — no pickers used, anchor downloads only.
          for (let i = 0; i < formats.length; i++) {
            const fmt = formats[i];
            const {blob, serverName} = await fetchOne(fmt, i === 0);
            saveViaAnchor(blob, serverName || defaultNameByFmt[fmt]);
            if (i < formats.length - 1) {
              await new Promise(r => setTimeout(r, 400));
            }
          }
        } else {
          // Picker path — we have handles collected up front.
          // persistReport on first non-skipped render only.
          let persistUsed = false;
          for (const t of targets) {
            if (t.skip) continue;
            const persistReport = !persistUsed;
            persistUsed = true;
            const {blob} = await fetchOne(t.fmt, persistReport);
            // Write bytes to the pre-collected handle.
            const writable = await t.handle.createWritable();
            await writable.write(blob);
            await writable.close();
          }
        }
        setBusy(false);
        dom.btnExport.innerHTML = "Export master ↓";
        if (dom.historyPanel.style.display !== "none") loadMasterHistory();
      } catch (err) {
        setBusy(false);
        dom.btnExport.innerHTML = "Export master ↓";
        alert("Export failed: " + err.message);
      }
    })();
  });

  // ---------- History panel ----------
  window.toggleMasterHistory = function () {
    const open = dom.historyPanel.style.display !== "none";
    if (open) {
      dom.historyPanel.style.display = "none";
      dom.historyOverlay.style.display = "none";
    } else {
      dom.historyPanel.style.display = "block";
      dom.historyOverlay.style.display = "block";
      loadMasterHistory();
    }
  };

  function loadMasterHistory() {
    dom.historyList.innerHTML = '<div style="font-size:13px;color:var(--muted);text-align:center;padding:40px 0">Loading...</div>';
    fetch("/master-history")
      .then(r => r.json())
      .then(items => {
        if (!items.length) {
          dom.historyList.innerHTML = '<div style="font-size:13px;color:var(--muted);text-align:center;padding:40px 0">No masters yet.</div>';
          return;
        }
        dom.historyList.innerHTML = items.map(it => {
          const when = new Date((it.mtime || 0) * 1000).toLocaleString();
          return `
            <div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-bottom:10px">
              <div style="font-family:var(--font-mono);font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${it.source_filename || "(untitled)"}</div>
              <div style="font-family:var(--font-mono);font-size:11px;color:var(--muted);margin-top:4px">
                ${fmtNum(it.integrated_lufs, 1)} LUFS · ${fmtNum(it.true_peak_dbfs, 1)} dBFS
              </div>
              <div style="font-size:10px;color:var(--muted);margin-top:6px">
                ${when} · ${(it.formats || []).length} format(s)
              </div>
            </div>
          `;
        }).join("");
      })
      .catch(() => {
        dom.historyList.innerHTML = '<div style="font-size:13px;color:var(--danger);text-align:center;padding:40px 0">Failed to load history.</div>';
      });
  }

  // ---------- "from=<report_id>" — deep-link path (future hook) ----------
  // If we arrive with ?from=<id> we could auto-prompt to upload and call
  // /master-from-report/<id>. For now we just note the ID for the UI to use.
  (function parseDeepLink() {
    const params = new URLSearchParams(window.location.search);
    const from = params.get("from");
    if (from) {
      // Add a small hint on the upload card
      const hint = document.createElement("div");
      hint.className = "mst-muted";
      hint.style.cssText = "margin-top:10px;text-align:center;font-family:var(--font-mono);font-size:11px";
      hint.innerHTML = `Continuing from report <span style="color:var(--accent)">${from}</span> — re-upload the same source file.`;
      dom.drop.parentNode.insertBefore(hint, dom.drop.nextSibling);
      state.sourceReportId = from;
    }
  })();

  // ---------- Floating nav show/hide on scroll ----------
  (function () {
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

  // ========================================================================
  // Reference Match (optional, collapsible block at the bottom of the page)
  // ========================================================================
  //
  // Flow:
  //   1. User clicks the "Reference Match" header → body expands (empty drop zone)
  //   2. User drops or selects a WAV/AIFF/FLAC reference file
  //   3. Server measures ref spectrum + computes 6 bell suggestions
  //   4. UI shows filename/LUFS + correction-strength slider + bells + EQ curve + vs-ref
  //   5. User toggles "Apply in chain" — writes to chainConfig.ref_match
  //   6. Correction slider rescales bell gains live (reuses /eq-curve for the SVG)
  //
  // State shape once a ref is loaded:
  //   state.refMatch = {
  //     filename, ref_lufs,
  //     proposal: {bells, config, comparison, correction_ratio, mode},
  //     correctionPct: 0-100,
  //     enabled: bool,
  //     busy: bool,
  //   }
  //
  // Reuses the .mst-bell* / .mst-eq-curve* / .mst-cmp-* CSS classes that were
  // kept from the previous Ref Match removal for the 6-band EQ — the styling
  // matches 6-band EQ exactly, which is the right aesthetic for Ref Match.

  // --- Drop zone + file picker ---
  // (The old collapsible toggle was removed — Ref Match visibility is now
  // driven by setTonalSource() above, not an independent chevron.)

  if (dom.refDrop) {
    // Ref Match uses its own "master-reference" scope because a reference
    // track (a commercial mastered release you're matching toward) is
    // typically pulled from a different folder than your own source mixes.
    dom.refDrop.addEventListener("click", async () => {
      const file = await window.AnvilPicker.pick({
        scope:           "master-reference",
        accept:          { "audio/*": [".wav", ".flac", ".aiff", ".aif"] },
        fallbackStartIn: "music",
        inputElement:    dom.refFileInput,
      });
      if (file) handleRefFile(file);
    });
    dom.refDrop.addEventListener("dragover", (e) => {
      e.preventDefault();
      dom.refDrop.classList.add("drag-over");
    });
    dom.refDrop.addEventListener("dragleave", () => {
      dom.refDrop.classList.remove("drag-over");
    });
    dom.refDrop.addEventListener("drop", (e) => {
      e.preventDefault();
      dom.refDrop.classList.remove("drag-over");
      const files = e.dataTransfer.files;
      if (files && files.length > 0) handleRefFile(files[0]);
    });
  }
  if (dom.refFileInput) {
    dom.refFileInput.addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (f) handleRefFile(f);
    });
  }

  /**
   * Validate and upload a reference file. Auto-expands the Ref Match
   * section (the user has clearly committed to using it) and swaps the
   * drop zone for an analyzing spinner until the server returns.
   */
  function handleRefFile(file) {
    if (!file) return;
    if (!state.masterUploadId) {
      alert("Load a source mix before adding a reference.");
      return;
    }
    const ok = /\.(wav|aiff?|flac)$/i.test(file.name);
    if (!ok) {
      alert("Reference must be WAV, AIFF, or FLAC.");
      return;
    }
    // User dropped a ref file — switch the tonal source to Reference Match
    // so the analysis they're about to see is actually visible. This also
    // ensures the chain will wire ref_match (not genre_match) as the active
    // tonal stage once analysis completes.
    setTonalSource("refmatch");

    // Swap UI to the analyzing state
    hide(dom.refDrop);
    hide(dom.refLoaded);
    show(dom.refAnalyzing);

    const fd = new FormData();
    fd.append("file", file);
    fd.append("master_upload_id", state.masterUploadId);

    fetch("/upload-reference", { method: "POST", body: fd })
      .then(r => r.json().then(j => ({ok: r.ok, body: j})))
      .then(({ok, body}) => {
        hide(dom.refAnalyzing);
        if (!ok) {
          alert("Reference analysis failed: " + (body.error || "unknown"));
          show(dom.refDrop);
          return;
        }
        // Stash the proposal and render the loaded state
        const rm = body.reference_measurement || {};
        state.refMatch = {
          filename: body.reference_filename || file.name,
          ref_lufs: (typeof rm.integrated_lufs === "number") ? rm.integrated_lufs : null,
          proposal: body.proposal,
          correctionPct: 50,
          enabled: false,
          busy: false,
        };
        renderRefMatchLoaded();
      })
      .catch(err => {
        hide(dom.refAnalyzing);
        alert("Network error uploading reference: " + err.message);
        show(dom.refDrop);
      });
  }

  /**
   * Clear the reference, return the section to the empty drop-zone state,
   * and remove the ref_match stage from the chain. Section stays expanded
   * (the user is interacting with it; collapsing would be surprising).
   */
  function clearRefMatch() {
    state.refMatch = null;
    if (state.chainConfig && state.chainConfig.ref_match) {
      delete state.chainConfig.ref_match;
    }
    if (dom.refFileInput) dom.refFileInput.value = "";
    hide(dom.refLoaded);
    hide(dom.refAnalyzing);
    show(dom.refDrop);
    hide(dom.previewWrap);
    // If the user was on the Reference Match tab, switch back to the 6-band
    // EQ tab — otherwise they'd be staring at an empty drop zone with no
    // way to use the tonal section until they re-upload. The EQ tab is
    // always a valid fallback (it's proposed from the mix itself).
    if (state.tonalSource === "refmatch") {
      setTonalSource("eq");
    }
  }
  if (dom.refRemove) {
    dom.refRemove.addEventListener("click", clearRefMatch);
  }

  /**
   * Render the "loaded" state after a successful /upload-reference.
   * Sets filename + LUFS, configures slider + apply-in-chain checkbox,
   * then delegates to sub-renderers for bells, comparison strip, and EQ
   * curve. Idempotent — safe to call again after slider or toggle changes.
   */
  function renderRefMatchLoaded() {
    if (!state.refMatch) return;
    const r = state.refMatch;
    if (dom.refFilename) dom.refFilename.textContent = r.filename || "";
    if (dom.refLufs) {
      const lufsStr = (typeof r.ref_lufs === "number")
        ? `${r.ref_lufs.toFixed(1)} LUFS integrated`
        : "LUFS not measured";
      dom.refLufs.textContent = lufsStr;
    }
    if (dom.refCorrSlider) dom.refCorrSlider.value = String(r.correctionPct);
    if (dom.refCorrVal) dom.refCorrVal.textContent = r.correctionPct + "%";
    if (dom.refEnabled) dom.refEnabled.checked = !!r.enabled;
    show(dom.refLoaded);

    // Payload rendering
    renderRefBells(r.proposal.bells || []);
    renderRefCompare(r.proposal.comparison || []);
    refreshRefEqCurve();
  }

  /**
   * Render the 6 bell rows inside #mst-ref-bells. Each row shows the band
   * name, center frequency, rationale, an editable number input for the
   * gain, and a checkbox to include/exclude the bell from the chain.
   *
   * Mirrors the 6-band EQ bell renderer so the user gets a familiar UI
   * for both EQ tools.
   */
  function renderRefBells(bells) {
    if (!dom.refBells) return;
    const BAND_LABELS = {
      sub: "Sub", bass: "Bass", low_mid: "Low-mid",
      mid: "Mid", presence: "Presence", air: "Air",
    };
    const fmtFreq = (hz) => hz < 1000 ? `${hz.toFixed(0)} Hz` : `${(hz/1000).toFixed(1)} kHz`;

    dom.refBells.innerHTML = bells.map((b) => {
      const accepted = !!b.accept;
      const gainCls = Math.abs(b.gain_db) < 0.3 ? "zero"
                    : b.gain_db > 0 ? "pos" : "neg";
      return `
        <div class="mst-bell ${accepted ? "accepted" : ""}" data-band="${b.band}">
          <input type="checkbox" class="mst-bell-toggle" id="mst-ref-tog-${b.band}" ${accepted ? "checked" : ""}>
          <div class="mst-bell-label">
            ${BAND_LABELS[b.band] || b.band}
            <br><small>${fmtFreq(b.freq_hz)} · Q ${(b.q || 1.0).toFixed(1)}</small>
          </div>
          <div class="mst-bell-rationale">${escapeHtml(b.rationale || "")}</div>
          <input type="number" class="mst-bell-num" id="mst-ref-num-${b.band}"
                 min="-4" max="4" step="0.1" value="${b.gain_db.toFixed(1)}">
          <div class="mst-bell-gain ${gainCls}">${fmtDb(b.gain_db, 1)} dB</div>
        </div>`;
    }).join("");

    // Wire toggle + number input for each bell.
    // Both paths end in syncRefMatchIntoChain() which writes the current
    // state of the bell set into state.chainConfig.ref_match (if enabled)
    // and invalidates the preview.
    bells.forEach(b => {
      const tog = $(`mst-ref-tog-${b.band}`);
      const num = $(`mst-ref-num-${b.band}`);
      if (tog) {
        tog.addEventListener("change", () => {
          b.accept = tog.checked;
          const cb = state.refMatch.proposal.config.bells.find(cc => cc.band === b.band);
          if (cb) cb.enabled = tog.checked;
          state.refMatch.proposal.config.enabled =
            state.refMatch.proposal.bells.some(x => x.accept);
          const row = tog.closest(".mst-bell");
          if (row) row.classList.toggle("accepted", tog.checked);
          // Auto-enable "Apply in chain" if the user turns a bell ON.
          // Matches the UX pattern of the 6-band EQ card.
          if (tog.checked && !state.refMatch.enabled) {
            state.refMatch.enabled = true;
            if (dom.refEnabled) dom.refEnabled.checked = true;
          }
          syncRefMatchIntoChain();
          refreshRefEqCurve();
          hide(dom.previewWrap);
        });
      }
      if (num) {
        num.addEventListener("change", () => {
          let v = parseFloat(num.value);
          if (isNaN(v)) return;
          v = Math.max(-4, Math.min(4, v));
          v = Math.round(v * 10) / 10;
          num.value = v.toFixed(1);
          b.gain_db = v;
          if (b.numbers) b.numbers.suggested_gain_db = v;
          b.accept = Math.abs(v) >= 0.3;
          const togEl = $(`mst-ref-tog-${b.band}`);
          if (togEl) togEl.checked = b.accept;
          const cb = state.refMatch.proposal.config.bells.find(cc => cc.band === b.band);
          if (cb) {
            cb.gain_db = v;
            cb.enabled = b.accept;
          }
          state.refMatch.proposal.config.enabled =
            state.refMatch.proposal.bells.some(x => x.accept);
          const row = num.closest(".mst-bell");
          if (row) row.classList.toggle("accepted", b.accept);
          const gainEl = row && row.querySelector(".mst-bell-gain");
          if (gainEl) {
            gainEl.textContent = fmtDb(v, 1) + " dB";
            gainEl.className = "mst-bell-gain " + (Math.abs(v) < 0.3 ? "zero" : v > 0 ? "pos" : "neg");
          }
          if (b.accept && !state.refMatch.enabled) {
            state.refMatch.enabled = true;
            if (dom.refEnabled) dom.refEnabled.checked = true;
          }
          syncRefMatchIntoChain();
          refreshRefEqCurve();
          hide(dom.previewWrap);
        });
        // Mouse wheel over the number nudges by 0.1 dB per tick.
        if (typeof attachWheelNudge === "function") {
          attachWheelNudge(num, 0.1, -4, 4);
        }
      }
    });
  }

  /**
   * Render the 6-cell vs-ref comparison strip. Each cell shows mix vs pink
   * and ref vs pink in dB, plus a delta badge colored by direction:
   *   |delta| < 1.0 — muted (essentially matched)
   *   delta > 0     — red-ish (mix is brighter than ref in this band)
   *   delta < 0     — purple-ish (mix is darker than ref)
   */
  function renderRefCompare(comparison) {
    if (!dom.refCompare) return;
    const html = (comparison || []).map(c => {
      const delta = c.delta_db;
      const cls = Math.abs(delta) < 1.0 ? "small"
                : delta > 0 ? "bright" : "dark";
      const deltaTxt = `${delta > 0 ? "+" : ""}${fmtNum(delta, 1)} dB`;
      const bandLabel = (c.band || "").replace("_", " ");
      return `
        <div class="mst-cmp-cell">
          <div class="mst-cmp-band">${bandLabel}</div>
          <div class="mst-cmp-row"><span class="lbl">mix</span><span class="val">${fmtDb(c.mix_vs_pink_db,1)}</span></div>
          <div class="mst-cmp-row"><span class="lbl">ref</span><span class="val">${fmtDb(c.ref_vs_pink_db,1)}</span></div>
          <div class="mst-cmp-delta ${cls}">${deltaTxt}</div>
        </div>`;
    }).join("");
    dom.refCompare.innerHTML = html;
  }

  /**
   * Fetch the total EQ response from /eq-curve and draw an SVG polyline.
   * Only considers bells currently marked enabled with |gain| >= 0.3 dB.
   * If no bells are active, draws a flat "No EQ active" marker.
   */
  function refreshRefEqCurve() {
    if (!state.refMatch || !dom.refCurveSvg) return;
    const bells = (state.refMatch.proposal.config.bells || [])
      .filter(cb => cb.enabled && Math.abs(cb.gain_db) >= 0.3)
      .map(cb => ({freq: cb.freq, gain_db: cb.gain_db, q: cb.q}));

    if (!bells.length) {
      drawRefEqCurve({freqs_hz: [], magnitude_db: []});
      return;
    }
    fetch("/eq-curve", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({bells, sample_rate: 48000, n_points: 160}),
    })
      .then(r => r.json())
      .then(data => drawRefEqCurve(data))
      .catch(() => {
        // Non-critical; skip the curve if it fails.
      });
  }

  function drawRefEqCurve(data) {
    if (!dom.refCurveSvg) return;
    const W = 600, H = 140;
    const freqs = data.freqs_hz || [];
    const mags = data.magnitude_db || [];

    if (!freqs.length) {
      dom.refCurveSvg.innerHTML = `
        <line x1="0" y1="${H/2}" x2="${W}" y2="${H/2}"
              stroke="var(--muted)" stroke-width="1" stroke-dasharray="3,3" opacity="0.4"/>
        <text x="10" y="${H/2 + 4}" fill="var(--muted)"
              font-family="monospace" font-size="10">No EQ active</text>`;
      return;
    }

    // Log-frequency X, ±6 dB Y (matches the gain range the bells allow)
    const logFmin = Math.log10(20);
    const logFmax = Math.log10(20000);
    const xFor = (f) => ((Math.log10(f) - logFmin) / (logFmax - logFmin)) * W;
    const dbMin = -6, dbMax = +6;
    const yFor = (db) => H - ((db - dbMin) / (dbMax - dbMin)) * H;

    const pts = freqs.map((f, i) => `${xFor(f).toFixed(1)},${yFor(mags[i]).toFixed(1)}`).join(" ");
    const zeroY = yFor(0);
    const fillPts = `${xFor(freqs[0]).toFixed(1)},${zeroY} ${pts} ${xFor(freqs[freqs.length-1]).toFixed(1)},${zeroY}`;

    dom.refCurveSvg.innerHTML = `
      <line x1="0" y1="${yFor(3)}" x2="${W}" y2="${yFor(3)}" stroke="var(--border)" stroke-width="0.5" opacity="0.4"/>
      <line x1="0" y1="${yFor(-3)}" x2="${W}" y2="${yFor(-3)}" stroke="var(--border)" stroke-width="0.5" opacity="0.4"/>
      <line x1="0" y1="${zeroY}" x2="${W}" y2="${zeroY}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="4,3" opacity="0.5"/>
      <text x="${xFor(100)}" y="${H - 3}" fill="var(--muted)" font-family="monospace" font-size="9" text-anchor="middle">100</text>
      <text x="${xFor(1000)}" y="${H - 3}" fill="var(--muted)" font-family="monospace" font-size="9" text-anchor="middle">1k</text>
      <text x="${xFor(10000)}" y="${H - 3}" fill="var(--muted)" font-family="monospace" font-size="9" text-anchor="middle">10k</text>
      <polygon points="${fillPts}" fill="var(--accent)" opacity="0.12"/>
      <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round"/>`;
  }

  /**
   * Rebuild all bell gains when the correction strength slider moves.
   * Uses the ORIGINAL delta_db from each bell's numbers field (never the
   * current gain_db) so repeated slider moves don't compound rounding.
   *
   *   new_gain = -delta_db * (newRatio)
   *
   * The sign flip is because delta is (mix - ref); if mix is +3 dB vs ref,
   * we need a -3 dB * ratio cut to nudge toward the ref.
   */
  function rescaleRefBellsFromSlider() {
    if (!state.refMatch || !state.refMatch.proposal) return;
    const ratio = state.refMatch.correctionPct / 100.0;
    const bells = state.refMatch.proposal.bells || [];

    bells.forEach(b => {
      const orig = (b.numbers && typeof b.numbers.delta_db === "number") ? b.numbers.delta_db : 0;
      let g = -orig * ratio;
      g = Math.max(-4, Math.min(4, g));
      g = Math.round(g * 10) / 10;
      b.gain_db = g;
      if (b.numbers) b.numbers.suggested_gain_db = g;
      b.accept = Math.abs(g) >= 0.3;
    });
    // Sync into config
    const cfgBells = state.refMatch.proposal.config.bells || [];
    cfgBells.forEach(cb => {
      const bell = bells.find(b => b.band === cb.band);
      if (bell) {
        cb.gain_db = bell.gain_db;
        cb.enabled = bell.accept;
      }
    });
    state.refMatch.proposal.config.enabled = bells.some(b => b.accept);
    state.refMatch.proposal.correction_ratio = ratio;

    // Re-render bells + curve; leave comparison strip alone (it's ratio-independent)
    renderRefBells(bells);
    refreshRefEqCurve();
    syncRefMatchIntoChain();
    hide(dom.previewWrap);
  }

  /**
   * Copy the current proposal.config into chainConfig.ref_match IF the
   * "Apply in chain" checkbox is on. Otherwise delete it so the chain
   * runs without ref_match. Deep copy to keep chainConfig independent.
   */
  function syncRefMatchIntoChain() {
    if (!state.chainConfig) return;
    if (state.refMatch && state.refMatch.enabled && state.refMatch.proposal) {
      state.chainConfig.ref_match = JSON.parse(JSON.stringify(state.refMatch.proposal.config));
    } else {
      delete state.chainConfig.ref_match;
    }
  }

  // --- Correction slider wiring ---
  if (dom.refCorrSlider) {
    dom.refCorrSlider.addEventListener("input", (e) => {
      const v = parseInt(e.target.value, 10);
      if (Number.isNaN(v)) return;
      if (state.refMatch) state.refMatch.correctionPct = v;
      if (dom.refCorrVal) dom.refCorrVal.textContent = v + "%";
    });
    // Recompute bells on release (cheap — no server roundtrip)
    dom.refCorrSlider.addEventListener("change", () => {
      if (!state.refMatch) return;
      rescaleRefBellsFromSlider();
    });
  }

  // --- Apply in chain checkbox ---
  if (dom.refEnabled) {
    dom.refEnabled.addEventListener("change", (e) => {
      if (!state.refMatch) return;
      state.refMatch.enabled = !!e.target.checked;
      syncRefMatchIntoChain();
      hide(dom.previewWrap);
    });
  }

  // --- Reset hooks ---
  // When the user drops a new source, switches modes, or clicks New source,
  // any previously-loaded reference is no longer valid (the master_upload_id
  // changed on the backend). Wipe state and UI.
  //
  // We DON'T collapse the section in those cases — if the user had it open,
  // keep it open so they see the reset happened. They can collapse it
  // themselves if they want.
  function resetRefMatch() {
    clearRefMatch();
  }

  // ---------- Metadata tagging ----------
  //
  // Collapsible form between Post-master verification and Export. Six fields
  // (Title, Artist, Album, Track#, Year, Genre) written into the exported
  // file via the /export-master route.
  //
  // Persistence strategy:
  //   - Artist and Album save to localStorage on every change — typing them
  //     once per album should be enough, not once per song.
  //   - Title / Track# / Year / Genre do NOT persist (they change per track;
  //     stale values would be worse than blanks).
  //   - Genre auto-fills from state.analysisSummary.genre when analysis
  //     completes, unless the user has manually entered something.
  //
  // The "expanded" state does not persist across reloads — keep initial
  // visual quiet by default.

  const META_STORAGE_KEY = "anvil_meta_persist";

  /**
   * Collapsible toggle — mirrors the Reference Match pattern. Updates
   * aria-expanded and rotates the chevron via the .expanded class.
   */
  function setMetaExpanded(expanded) {
    state.metaExpanded = !!expanded;
    if (!dom.metaWrap || !dom.metaBody || !dom.metaHeader) return;
    dom.metaWrap.classList.toggle("expanded", state.metaExpanded);
    if (state.metaExpanded) show(dom.metaBody);
    else                     hide(dom.metaBody);
    dom.metaHeader.setAttribute("aria-expanded",
                                state.metaExpanded ? "true" : "false");
  }
  function toggleMetaExpanded() { setMetaExpanded(!state.metaExpanded); }

  if (dom.metaHeader) {
    dom.metaHeader.addEventListener("click", toggleMetaExpanded);
    dom.metaHeader.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleMetaExpanded();
      }
    });
  }

  /**
   * Read current form values into a plain object. Empty strings are kept
   * as-is here; the server's embed_metadata helper filters them out.
   * Trimming happens at collect time so whitespace-only values become "".
   */
  function collectMetadata() {
    const val = (el) => (el && typeof el.value === "string") ? el.value.trim() : "";
    return {
      title:  val(dom.metaTitle),
      artist: val(dom.metaArtist),
      album:  val(dom.metaAlbum),
      track:  val(dom.metaTrack),
      year:   val(dom.metaYear),
      genre:  val(dom.metaGenre),
    };
  }

  /**
   * Persist Artist and Album to localStorage. Called on every change of
   * those inputs. Wrapped in try/catch because localStorage can throw in
   * private-browsing modes or when quota is exceeded.
   */
  function saveMetaPersistence() {
    try {
      const payload = {
        artist: dom.metaArtist ? dom.metaArtist.value.trim() : "",
        album:  dom.metaAlbum  ? dom.metaAlbum.value.trim()  : "",
      };
      localStorage.setItem(META_STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
      // Ignore — persistence is best-effort
    }
  }

  /**
   * Restore Artist and Album from localStorage on initial page load.
   * Only restores if the field is currently empty (don't overwrite
   * whatever the user has already typed if that somehow happens).
   */
  function loadMetaPersistence() {
    try {
      const raw = localStorage.getItem(META_STORAGE_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p && typeof p === "object") {
        if (p.artist && dom.metaArtist && !dom.metaArtist.value) {
          dom.metaArtist.value = p.artist;
        }
        if (p.album && dom.metaAlbum && !dom.metaAlbum.value) {
          dom.metaAlbum.value = p.album;
        }
      }
    } catch (e) {
      // Ignore — corrupt localStorage shouldn't break the page
    }
  }

  /**
   * Map Anvil's internal genre labels (postrock, progrock, etc.) to
   * user-friendly display strings suitable for ID3 free-text tagging.
   * Unknown labels pass through capitalized. Returns "" for null/undefined.
   */
  function formatGenreForTag(internalLabel) {
    if (!internalLabel) return "";
    const MAP = {
      postrock:     "Post-Rock",
      progrock:     "Progressive Rock",
      metal:        "Metal",
      instrumental: "Instrumental",
      rock:         "Rock",
      pop:          "Pop",
      electronic:   "Electronic",
      hiphop:       "Hip Hop",
      jazz:         "Jazz",
      classical:    "Classical",
    };
    const key = String(internalLabel).toLowerCase().replace(/[^a-z]/g, "");
    if (MAP[key]) return MAP[key];
    // Fallback: capitalize first letter
    const s = String(internalLabel);
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /**
   * Auto-fill the Genre field from the analyzer's detected genre, but only
   * if the user hasn't already typed something there. Called after each
   * successful /analyze-master. Safe to call repeatedly.
   */
  function autofillGenreFromAnalysis() {
    if (!dom.metaGenre) return;
    if (dom.metaGenre.value && dom.metaGenre.value.trim().length > 0) return;
    const detected = state.analysisSummary && state.analysisSummary.genre;
    const formatted = formatGenreForTag(detected);
    if (formatted) dom.metaGenre.value = formatted;
  }

  /**
   * Clear per-track fields (Title, Track#, Year, Genre) on new source.
   * Keeps Artist and Album intact — those typically apply to a whole album
   * and get reused across sibling tracks.
   */
  function resetMetaPerTrackFields() {
    if (dom.metaTitle) dom.metaTitle.value = "";
    if (dom.metaTrack) dom.metaTrack.value = "";
    if (dom.metaYear)  dom.metaYear.value  = "";
    if (dom.metaGenre) dom.metaGenre.value = "";
  }

  // Wire the field change handlers for the persisted pair.
  if (dom.metaArtist) {
    dom.metaArtist.addEventListener("input", saveMetaPersistence);
  }
  if (dom.metaAlbum) {
    dom.metaAlbum.addEventListener("input", saveMetaPersistence);
  }

  // Wheel-scroll nudge for Track # and Year (prevents page scroll).
  if (typeof attachWheelNudge === "function") {
    if (dom.metaTrack) attachWheelNudge(dom.metaTrack, 1, 1, 999);
    if (dom.metaYear)  attachWheelNudge(dom.metaYear,  1, 1900, 2100);
  }

  // Clear button — wipes all 6 fields AND clears the persisted Artist/Album
  // from localStorage. Confirm-free because it's a trivial undo (just retype).
  if (dom.metaClear) {
    dom.metaClear.addEventListener("click", () => {
      if (dom.metaTitle)  dom.metaTitle.value  = "";
      if (dom.metaArtist) dom.metaArtist.value = "";
      if (dom.metaAlbum)  dom.metaAlbum.value  = "";
      if (dom.metaTrack)  dom.metaTrack.value  = "";
      if (dom.metaYear)   dom.metaYear.value   = "";
      if (dom.metaGenre)  dom.metaGenre.value  = "";
      try { localStorage.removeItem(META_STORAGE_KEY); } catch (e) {}
    });
  }

  // Initial load: restore persisted Artist + Album from localStorage.
  loadMetaPersistence();

  // Expose reset hooks for existing reset paths to call.
  window.__anvilResetMetaPerTrack = resetMetaPerTrackFields;
  window.__anvilAutofillGenre = autofillGenreFromAnalysis;

})();
