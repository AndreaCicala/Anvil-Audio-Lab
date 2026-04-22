"""
version.py — Single source of truth for the application version.

This file is deliberately trivial so it's safe to import from anywhere
without pulling in Flask, numpy, scipy, etc. Anything that just needs the
version string (PyInstaller spec, test runners, update check) imports from
here without side effects.

The constants:
  __version__        — human-readable version, matches the GitHub release tag
                       (without the "v" prefix). Used in the UI footer and
                       the "Check for updates" comparison.
  GITHUB_OWNER       — GitHub username that owns the release repo.
  GITHUB_REPO        — Repository name on GitHub.
                       Together with __version__ these form the URLs used
                       by the update checker.

When releasing:
  1. Bump __version__ here
  2. Commit + push
  3. Create a GitHub release with tag "v{__version__}"
     (so v0.2.0 corresponds to __version__ = "0.2.0")
"""

__version__ = "0.2.0"

# Used to query the latest release via the GitHub API:
#   https://api.github.com/repos/{OWNER}/{REPO}/releases/latest
GITHUB_OWNER = "AndreaCicala"
GITHUB_REPO  = "Anvil-Audio-Lab"


def parse_version(v):
    """Parse a "0.2.0" or "v0.2.0" string into a tuple of ints for comparison.

    Returns None if the string doesn't match the expected pattern — callers
    should treat "None vs known" as "don't know, assume current is fine".
    """
    if not v:
        return None
    v = v.strip().lstrip("v").lstrip("V")
    parts = v.split(".")
    try:
        return tuple(int(p) for p in parts)
    except (ValueError, TypeError):
        return None


def is_newer(candidate, current=__version__):
    """Return True if `candidate` represents a newer release than `current`.

    Both arguments may include a "v" prefix ("v0.2.0") or not. If either is
    unparseable, returns False (no update) — we'd rather miss an update
    notification than show a wrong one.
    """
    c = parse_version(candidate)
    k = parse_version(current)
    if c is None or k is None:
        return False
    return c > k
