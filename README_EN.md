# SketchTool-Tuari

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
