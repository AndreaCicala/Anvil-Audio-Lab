# -*- mode: python ; coding: utf-8 -*-
"""
anvil_audio_lab.spec — PyInstaller build configuration for Anvil Audio Lab.

Build mode: onedir (a folder the user unzips, faster startup than onefile)
Entry point: app.py
Output:      dist/AnvilAudioLab/ (folder containing AnvilAudioLab.exe + data)

To build (run from the project root):
    pyinstaller anvil_audio_lab.spec --clean --noconfirm

The .spec file is committed to git. The build output (dist/, build/) is in
.gitignore so we don't bloat the repo with platform-specific binaries.

Before building:
  1. pip install pyinstaller
  2. Place ffmpeg.exe in ./ffmpeg/ffmpeg.exe next to this spec file.
     (On Windows: download from gyan.dev or similar, extract ffmpeg.exe.)
     The build copies this into dist/AnvilAudioLab/ffmpeg/ so the packaged
     app has a self-contained ffmpeg and doesn't depend on PATH.
  3. Run the command above.

Common issues:
  - "Missing module X"     — add X to hiddenimports below
  - "Could not find Y.dll" — add the DLL path to binaries
  - librosa/numba issues   — already handled via hiddenimports
  - Slow startup           — expected on first launch (Windows Defender scans
                             the 300+ MB dist folder); subsequent launches
                             are fast
"""

import os

block_cipher = None

# ---------------------------------------------------------------------------
# Paths and data files we need to bundle
# ---------------------------------------------------------------------------

# Flask needs templates and static/ at runtime. We bundle them next to the
# exe so paths resolve the same way as in development.
datas = [
    ('templates', 'templates'),
    ('static', 'static'),
]

# ffmpeg binary — bundled so the exe is self-contained.
# The user places ./ffmpeg/ffmpeg.exe before building. At runtime,
# mix_analyzer._resolve_ffmpeg_binary() looks for it at
# <dist_folder>/ffmpeg/ffmpeg.exe.
if os.path.exists(os.path.join('ffmpeg', 'ffmpeg.exe')):
    datas.append(('ffmpeg/ffmpeg.exe', 'ffmpeg'))
elif os.path.exists(os.path.join('ffmpeg', 'ffmpeg')):
    datas.append(('ffmpeg/ffmpeg', 'ffmpeg'))
# If neither exists, the build still succeeds; the app will fall back to
# using ffmpeg from PATH (if any). This matches dev-mode behavior.

# Librosa ships resource files (example audio, filter impulse responses)
# that it loads lazily. PyInstaller can't discover them without help.
try:
    from PyInstaller.utils.hooks import collect_data_files
    datas += collect_data_files('librosa')
    datas += collect_data_files('soundfile')
except ImportError:
    # Running without PyInstaller installed — spec file being imported for
    # inspection. Skip the helper.
    pass

# ---------------------------------------------------------------------------
# Hidden imports — modules PyInstaller doesn't discover via static analysis
# ---------------------------------------------------------------------------

hiddenimports = [
    # sklearn is pulled in transitively by librosa for some operations.
    # PyInstaller often misses its submodules.
    'sklearn.utils._typedefs',
    'sklearn.utils._heap',
    'sklearn.utils._sorting',
    'sklearn.utils._vector_sentinel',
    'sklearn.neighbors._partition_nodes',
    # librosa lazy imports
    'librosa.util.exceptions',
    'librosa.util.decorators',
    # numba & llvmlite — librosa dependency that's often PyInstaller-hostile
    'numba',
    'numba.core.typing.cffi_utils',
    # scipy — a few submodules that PyInstaller's static analysis misses
    'scipy.special.cython_special',
    'scipy.io._fortran',
    'scipy._lib.messagestream',
    # Flask / Werkzeug internals
    'werkzeug.middleware.dispatcher',
    # Our own modules — belt-and-braces; PyInstaller should find these but
    # listing them explicitly helps if the spec is moved around.
    'version',
    'mix_analyzer',
    'master_engine',
    'stem_analyzer',
    'ai_advisor',
]

# Modules we *never* want bundled (pulled in transitively but huge & unused).
# Excluding these trims ~50-100 MB off the final size.
excludes = [
    'tkinter',
    'matplotlib',
    'pandas',
    'IPython',
    'jupyter',
    'notebook',
    'pytest',
]


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='AnvilAudioLab',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,           # UPX breaks some scientific-stack DLLs; leave off
    console=True,        # Keep the console window so users see errors if
                         # the server fails to start. Change to False once
                         # the build is stable and we want a cleaner UX.
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,           # TODO: add an .ico file and reference it here
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='AnvilAudioLab',
)
