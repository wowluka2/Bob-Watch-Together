# Bob Watch Together 3.0

A self-hosted platform for watching your personal movie and TV library, alone or
in synchronized watch parties with friends.

## Features

- Automatically scanned movie and TV library.
- MKV/MP4 playback, audio and subtitle selection, seeking, and FFmpeg transcoding.
- Synchronized watch parties with chat and invite links.
- User accounts, roles, profiles, watch history, favorites, and a watch-later list.
- Admin dashboard, account management, backups, and diagnostics.
- Optional metadata and artwork from TMDb and OMDb.
- Polish and English UI, light and dark themes, and an installable PWA.
- Docker Compose deployment with Caddy as a reverse proxy.

## Requirements

**Recommended:** Docker Engine and the Docker Compose plugin.

**Without Docker:** Node.js 18+, SQLite 3 (`sqlite3`), FFmpeg, and FFprobe.

## Quick start with Docker

1. Clone the existing GitHub repository:

   ```bash
   git clone https://github.com/wowluka2/Bob-Watch-Together.git
   cd Bob-Watch-Together
   ```

2. Create your local configuration:

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and set a unique, strong `ADMIN_PASSWORD`. API keys are optional.
   Never commit or share your `.env` file.

3. Put your media files in `videos/`, then start the application:

   ```bash
   docker compose up -d --build
   ```

4. Open <http://localhost:3000>. Caddy also exposes ports 80 and 443. For public
   HTTPS, configure `DOMAIN` with a domain name pointing to your server.

View application logs:

```bash
docker compose logs -f bob-watch-together
```

Stop the application without deleting its data:

```bash
docker compose down
```

Avoid `docker compose down -v` if you want to keep Caddy's Docker volumes.
Application state is stored in `data/`; media stays in `videos/`.

## Run without Docker

Install Node.js, SQLite 3, and FFmpeg. Copy `.env.example` to `.env`, configure
the variables, and add media to `videos/`. Then run:

```bash
npm start
```

The application is available at <http://localhost:3000> by default.

## Configuration

| Variable | Description |
| --- | --- |
| `PORT` | HTTP port (default: `3000`). |
| `ADMIN_USERNAME` | Administrator username (default: `admin`). |
| `ADMIN_PASSWORD` | Administrator password. Set a unique password before deployment. |
| `SESSION_TTL_HOURS` | Regular session lifetime (default: 24 hours). |
| `TMDB_API_KEY` | Optional TMDb v3 key for artwork and metadata. |
| `OMDB_API_KEY` | Optional OMDb key for additional metadata. |
| `DOMAIN` | Caddy domain (default: `localhost`). |
| `MAX_CACHE_MB` | Application cache limit (default: 500 MB). |
| `MAX_BODY_MB` | Maximum request size (default: 20 MB). |

Data paths can also be configured with `VIDEO_DIR`, `CACHE_DIR`, `DATABASE_FILE`,
`BACKUP_DIR`, `PROFILES_FILE`, `METADATA_FILE`, `ADMIN_FILE`, and `PARTY_FILE`.
Docker Compose mounts `videos/` and `data/` into the container.

After changing API keys or other environment variables, recreate the application
container so it loads the new configuration:

```bash
docker compose up -d --build --force-recreate bob-watch-together
```

The `/admin` page provides administrator settings and diagnostics. If
`ADMIN_PASSWORD` is not set, the server generates an initial password and prints
it in the logs. Sign in with it and immediately set your own password.

## Data and backups

- `data/` — SQLite database, accounts, profiles, administrator settings, and watch-party state.
- `videos/` — your private media library.
- `.cache/` — generated application files.
- `backups/` — database backups.

These directories and local configuration files are excluded from Git and Docker
build contexts. Back up `data/` separately; pushing the source code to GitHub does
not back up application data.

## Security

- `.env` contains your administrator password and API keys. Never publish or share it.
- Rotate passwords and revoke/replace any API keys that may have been exposed.
- Do not commit databases, backups, profiles, logs, TLS keys, or private media.
- `.env.example` is a safe template: keep real secrets out of it.
- TMDb attribution is displayed when TMDb artwork is used. This project is not
  endorsed or certified by TMDb.
