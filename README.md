# Bob Watch Together

A lightweight, self-hosted Node.js local streaming server designed for synchronized watch parties over virtual local networks (VPN). It features an Amazon Prime Video-inspired interface, dynamic IMDb ratings and release dates via the OMDb API, split audio/video streaming, and smooth local playback.

---

## Features

- **Synced Watch Parties:** Real-time synchronization of play, pause, seek, and room state via Server-Sent Events (SSE).
- **Split Audio/Video Architecture:** Streams high-performance native video directly using HTTP Range requests while transcoding audio on the fly (`/audio`) to prevent codec compatibility issues.
- **IMDb Metadata Integration:** Automatically retrieves ratings, release dates, and episode information using the OMDb API.
- **Responsive Interface:** Clean, ultrawide-friendly dark theme (`style.css`) with title posters and persistent local storage state.
- **Subtitles Support:** Automatic detection and rendering of external `.srt` or `.vtt` subtitle files.
- **Minimal Dependencies:** Built entirely with Node.js standard modules without requiring external package installations.

---

## Getting Started

### Prerequisites
1. **Node.js** (version 16 or newer) - [Download](https://nodejs.org)
2. **FFmpeg & FFprobe** (Required for audio transcoding, poster generation, and library scanning).

### Installation and Setup

1. Clone or download the repository into a local directory.
2. Place video files inside the `videos` directory.
   - For series, organize files into subfolders.
   - For subtitles, place a `.srt` or `.vtt` file with the exact matching filename next to the video file (e.g., `movie.mp4` and `movie.srt`).
3. Start the server:
   ```bash
   node server.js
