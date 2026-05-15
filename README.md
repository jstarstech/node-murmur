# node-murmur

`node-murmur` is a Node.js implementation of a Mumble-compatible voice server.

<p align="">
  <a href="https://www.npmjs.com/package/node-murmur"><img src="https://img.shields.io/npm/v/node-murmur?style=for-the-badge" alt="NPM Version" /></a>
  <a href="https://www.npmjs.com/package/node-murmur"><img src="https://img.shields.io/npm/l/node-murmur?style=for-the-badge" alt="MIT License" /></a>
  <a href="https://github.com/jstarstech/node-murmur"><img src="https://img.shields.io/badge/github-repo-blue?logo=github&style=for-the-badge" alt="Build status" /></a>
</p>

## Requirements

- Node.js 24 or newer
- npm

## Run

Run directly from npm:

```bash
npx node-murmur
```

Or install it globally:

```bash
npm install -g node-murmur
node-murmur
```

Run with Docker from GitHub Container Registry:

```bash
docker run --rm -it \
  -p 64738:64738/tcp \
  -p 64738:64738/udp \
  -v node-murmur-data:/app/data \
  ghcr.io/jstarstech/node-murmur:latest
```

To run from source:

```bash
git clone https://github.com/jstarstech/node-murmur.git
cd node-murmur
npm install
npm start
```

By default, the server keeps runtime state in `data/`:

- `data/mumble-server.ini` for optional server config
- `data/mumble-server.sqlite` for SQLite storage
- `data/mumble-server.log` for logs
- `data/server.cert` and `data/server.key` for generated TLS

If `data/mumble-server.ini` is missing, the server starts with built-in defaults.

The config, database, and log paths can be overridden with the `CONFIG_FILE`, `DB_STORAGE`, and `LOG_FILE` environment variables.

## Development

The project uses:

- ESM modules
- SQLite for local storage
- ESLint for linting
- Node's built-in test runner for tests

For local development with automatic restarts:

```bash
npm run dev
```

Useful commands:

```bash
npm run lint
npm run lint:fix
npm test
```

## Notes

The project is still in an early stage and may contain bugs. It is expected to become more complete and ready for wider use closer to a `1.0` release.

## Credit

This project uses some ideas and code inspired by the original [Rantanen/node-mumble](https://github.com/Rantanen/node-mumble) project.
