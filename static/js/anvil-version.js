/**
 * anvil-version.js — Version badge + update checker.
 *
 * Injects a version chip into the header of each page. Clicking the chip
 * calls the server's /check-updates endpoint, which hits GitHub's releases
 * API. If a newer release exists, we show a banner with release notes and
 * a download button that opens the release page in the user's browser.
 *
 * The chip lives in the `.nav-group` area so it visually belongs with
 * the navigation, not the brand/logo. Every page that loads this script
 * also gets the banner-injection logic — the banner itself is created
 * on demand if an update is found.
 *
 * Why not check for updates automatically on page load? Two reasons:
 *   1. Respect for the user — silent network calls to github.com from a
 *      local audio tool feel surprising. Make it explicit.
 *   2. GitHub API rate limits: 60 req/hour per IP. With auto-check, a
 *      user opening multiple tabs could blow through that quickly.
 *
 * The server caches the result for 15 minutes, so repeat clicks are cheap.
 */
(function () {
  "use strict";

  // ---------- Helpers ----------

  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === "onclick") el.addEventListener("click", attrs[k]);
        else if (k === "style") el.setAttribute("style", attrs[k]);
        else if (k === "className") el.className = attrs[k];
        else el.setAttribute(k, attrs[k]);
      }
    }
    if (children) {
      const items = Array.isArray(children) ? children : [children];
      for (const c of items) {
        if (c == null) continue;
        if (typeof c === "string") el.appendChild(document.createTextNode(c));
        else el.appendChild(c);
      }
    }
    return el;
  }

  function formatDate(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, {
        year: "numeric", month: "short", day: "numeric"
      });
    } catch { return ""; }
  }

  // ---------- Version chip ----------

  function injectVersionChip(version) {
    const nav = document.querySelector(".nav-group");
    if (!nav) return;

    // Avoid duplicate injection on pages that include the script twice
    if (document.getElementById("anvil-version-chip")) return;

    const chip = h("button", {
      id: "anvil-version-chip",
      className: "version-chip",
      title: "Click to check for updates",
      onclick: () => openUpdatePanel(version),
    }, `v${version}`);

    nav.appendChild(chip);
  }

  // ---------- Update panel ----------

  function openUpdatePanel(currentVersion) {
    // Re-use an existing panel if one is open
    let overlay = document.getElementById("anvil-update-overlay");
    if (overlay) return;   // already open, no-op

    overlay = h("div", { id: "anvil-update-overlay", className: "anvil-update-overlay" });
    const panel = h("div", { className: "anvil-update-panel" });

    // Close-on-backdrop-click (but not panel-click)
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closePanel();
    });

    const header = h("div", { className: "anvil-update-header" }, [
      h("span", { className: "anvil-update-title" }, "Check for updates"),
      h("button", {
        className: "anvil-update-close",
        title: "Close",
        onclick: closePanel,
      }, "×"),
    ]);
    panel.appendChild(header);

    const body = h("div", { className: "anvil-update-body", id: "anvil-update-body" });
    body.appendChild(
      h("div", { className: "anvil-update-loading" }, "Checking GitHub for the latest release...")
    );
    panel.appendChild(body);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // Fetch the result
    fetch("/check-updates")
      .then(r => r.json())
      .then(data => renderResult(body, currentVersion, data))
      .catch(err => renderError(body, err.message || String(err)));
  }

  function closePanel() {
    const overlay = document.getElementById("anvil-update-overlay");
    if (overlay) overlay.remove();
  }

  function renderResult(body, currentVersion, data) {
    body.innerHTML = "";

    if (data.error) {
      renderError(body, data.error);
      return;
    }

    const latest = data.latest_version;
    const isNewer = !!data.update_available;

    // Status badge
    const statusRow = h("div", { className: "anvil-update-row" }, [
      h("span", { className: "anvil-update-label" }, "Current version"),
      h("span", { className: "anvil-update-value" }, `v${currentVersion}`),
    ]);
    body.appendChild(statusRow);

    const latestRow = h("div", { className: "anvil-update-row" }, [
      h("span", { className: "anvil-update-label" }, "Latest release"),
      h("span", {
        className: "anvil-update-value " + (isNewer ? "available" : "uptodate"),
      }, latest ? `v${latest}` : "unknown"),
    ]);
    body.appendChild(latestRow);

    if (data.published_at) {
      body.appendChild(
        h("div", { className: "anvil-update-row" }, [
          h("span", { className: "anvil-update-label" }, "Published"),
          h("span", { className: "anvil-update-value" }, formatDate(data.published_at)),
        ])
      );
    }

    // Verdict
    if (isNewer) {
      body.appendChild(
        h("div", { className: "anvil-update-banner available" },
          `A newer version is available — ${data.release_name || "v" + latest}`)
      );
      if (data.release_notes) {
        body.appendChild(
          h("div", { className: "anvil-update-notes-label" }, "Release notes")
        );
        body.appendChild(
          h("pre", { className: "anvil-update-notes" }, data.release_notes)
        );
      }
      if (data.release_url) {
        body.appendChild(
          h("a", {
            href: data.release_url,
            target: "_blank",
            rel: "noopener",
            className: "anvil-update-btn",
          }, "Open release page on GitHub ↗")
        );
      }
    } else if (latest) {
      body.appendChild(
        h("div", { className: "anvil-update-banner uptodate" },
          "You're on the latest version.")
      );
    } else {
      body.appendChild(
        h("div", { className: "anvil-update-banner uptodate" },
          "No releases published yet.")
      );
    }
  }

  function renderError(body, msg) {
    body.innerHTML = "";
    body.appendChild(
      h("div", { className: "anvil-update-banner error" }, "Couldn't check for updates")
    );
    body.appendChild(
      h("div", { className: "anvil-update-error" }, msg)
    );
  }

  // ---------- Init ----------

  // Fetch the version from /config so we have one source of truth. If the
  // request fails (e.g. server hiccup), we silently skip — the chip just
  // doesn't render, no user-facing error.
  fetch("/config")
    .then(r => r.json())
    .then(cfg => {
      if (cfg && cfg.version) injectVersionChip(cfg.version);
    })
    .catch(() => { /* noop — version chip is nice-to-have, not critical */ });
})();
