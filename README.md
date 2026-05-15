# node-murmur

`node-murmur` is a Node.js implementation of a Mumble-compatible voice server.

## Requirements

- Node.js 24 or newer
- npm

## Run

Install dependencies:

```bash
npm install
```

Start the server:

```bash
npm start
```

After publishing, the server can also be run with `npx`:

```bash
npx node-murmur
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
