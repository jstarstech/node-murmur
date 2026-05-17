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

## Installation & Quick Start

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

## Usage

### Connecting to the Server

Once the server is running, you can connect using any Mumble-compatible client (like the official [Mumble client](https://www.mumble.info/)).

- **Address:** Your server's IP or hostname
- **Port:** `64738` (default)
- **Username:** Any username you choose

### Administrative Access (SuperUser)

On the first startup, `node-murmur` generates a unique password for the `SuperUser` account and logs it to the console. You can use this account to:

- Create and manage channels
- Manage ACLs and groups
- Kick or ban users

To log in as `SuperUser`, use the username `SuperUser` and the generated password when connecting.

### Configuration

By default, the server keeps runtime state in the `data/` directory:

- `data/mumble-server.ini`: Optional server configuration
- `data/mumble-server.sqlite`: SQLite database for persistent storage
- `data/mumble-server.log`: Server log file
- `data/server.cert` & `data/server.key`: Automatically generated TLS certificate and key

If `data/mumble-server.ini` is missing, the server starts with built-in defaults.

#### Common Settings

You can customize the server by adding these keys to your `mumble-server.ini`:

- `port`: Port to listen on (default: `64738`)
- `welcometext`: Message displayed to users upon connection
- `users`: Maximum number of concurrent users
- `serverpassword`: Password required to connect to the server

#### Example Configuration (`mumble-server.ini`)

```ini
# Port to listen on (default: 64738)
port=64738

# Message displayed to users upon connection
welcometext="Welcome to the server!"

# Maximum number of concurrent users
users=100

# Password required to connect to the server (uncomment to enable)
# serverpassword=mypassword

# Allow HTML in welcome text and channel descriptions
allowhtml=true

# Bandwidth limit in bits per second
bandwidth=558000
```

#### Rich HTML Example

You can use HTML and inline CSS to create a more styled welcome message. Here is an example:

```ini
welcometext="<br />Welcome!<p style=\"margin-bottom:12px; margin-top:12px\">Website: <a href=\"https://github.com/jstarstech/node-murmur\"><span style=\"color:#39a5dd\">node-murmur</span></a></p><p style=\"margin-bottom:12px; margin-top:12px\"><a href=\"https://github.com/jstarstech/node-murmur/issues\"><span style=\"color:#39a5dd\">Report Issues</span></a></p>"
```

> **Note:** When using quotes or complex HTML in the `.ini` file, ensure you escape inner quotes or use the appropriate format for your environment.

#### Environment Variables

You can override default paths using environment variables:

- `CONFIG_FILE`: Path to the `.ini` config file
- `DB_STORAGE`: Path to the SQLite database
- `LOG_FILE`: Path to the log file

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
