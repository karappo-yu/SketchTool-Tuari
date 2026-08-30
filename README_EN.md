# SketchTool-Tuari

[中文](./README.md) / [日本語](./README_JA.md)

A desktop sketch practice tool rebuilt with Tauri + Rust.  
This version keeps the core workflow of the original app while adapting the window behavior, image playback, average-color background, grid overlay, and library experience for the current desktop implementation.

## Screenshots

### Main Screen

![Main Screen](./screenshot/index.png)

### Library

![Library](./screenshot/library.png)

### Slideshow Countdown

![Slideshow Countdown](./screenshot/show.png)

## Features

- Select a local image folder for sketch practice
- Random / sequential playback
- Filter already marked images
- Browse image library, open images externally, remove marks
- Mirror, grayscale, and grid overlay tools
- Solid color, average color, and static image backgrounds
- Countdown display and time format switching
- Default folder, startup folder, and always-on-top support
- macOS-style window dragging and traffic light visibility handling
- Doodle mode: dims the reference image and enables the drawing board
- Master Copy mode: same-size white canvas beside the reference, with synced grid and layer panel
- Pen pressure (tablet), multiple layers, HSL color picker, and paint-bucket fill

## Keyboard Shortcuts

Slideshow:

| Shortcut | Action |
| --- | --- |
| Space | Pause / resume |
| ← / → | Previous / next image (hold to repeat) |
| M | Toggle mirror |
| G | Toggle grid |

Drawing mode (Doodle / Master Copy):

| Shortcut | Action |
| --- | --- |
| B | Pen tool |
| E | Eraser tool |
| H | Mirror |
| [ / ] | Decrease / increase brush size (hold to keep adjusting) |
| ⌘Z / Ctrl+Z | Undo |
| ⌘⇧Z / Ctrl+Y | Redo |
| Esc | Exit drawing mode |

Extras:

- Hold the stylus side button (mapped to "Erase" in the tablet driver) to erase temporarily; release to restore the previous tool. Right / middle-button drag works the same way.
- Shortcuts are matched by physical key, so they keep working while a Chinese or any other IME is active — no need to switch to English input.

## Tech Stack

- Frontend: Vanilla JavaScript + Vite
- Desktop: Tauri 2
- Backend: Rust

## Development

Install dependencies:

```bash
npm install
```

Run in development mode:

```bash
npm run tauri dev
```

## Build

Build a debug app:

```bash
npm run tauri build -- --debug --bundles app
```

Build a release app:

```bash
npm run tauri build -- --bundles app
```

## Project Structure

```text
src/              frontend logic
src-tauri/        Tauri and Rust backend
screenshot/       screenshots used in README files
index.html        entry page
style.css         styles
```

## Notes

- This repository no longer uses the old Electron structure.
- The current priority is preserving the original usage flow and interaction feel, not doing high-risk large-scale refactors.
