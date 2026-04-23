# ffmpeg bundle folder

This folder exists so Anvil Audio Lab can ship with its own `ffmpeg.exe`
bundled into the Windows build, avoiding the need for users to install
ffmpeg system-wide.

## What to put here

Place `ffmpeg.exe` directly in this folder:

```
ffmpeg/
├── .gitkeep
├── README.md
└── ffmpeg.exe   ← you download and place this
```

The `ffmpeg.exe` binary is **not committed to git** because:

- It's platform-specific (Windows-only)
- It's large (~150 MB)
- It has its own versioning and license
- Different builds want different ffmpeg features

## Where to download

Recommended: **[gyan.dev ffmpeg builds](https://www.gyan.dev/ffmpeg/builds/)** — full build, well-maintained, includes the ebur128 filter that Anvil Audio Lab uses for LUFS measurement.

1. Download "ffmpeg-release-full.7z" (or similar)
2. Extract the archive
3. Navigate inside to `bin/` folder
4. Copy just `ffmpeg.exe` into this folder

Alternative sources:

- https://ffmpeg.org/download.html (official)
- https://github.com/BtbN/FFmpeg-Builds/releases

## Verifying

Before running `build.ps1`, confirm the binary works:

```powershell
./ffmpeg/ffmpeg.exe -version
```

Should print version information including `--enable-libavfilter` in the configuration line (required for ebur128).

## macOS / Linux

For non-Windows builds, place the platform's native binary as `ffmpeg/ffmpeg` (no extension) in this folder. The PyInstaller spec detects both.
