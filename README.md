# I²CDriver – Web Serial Control Panel

A browser-based control panel for the [I²C-Driver](https://i2cdriver.com/) USB-to-I²C adapter (and visualizer with a small display). The app is
built with [Vite](https://vite.dev/) and the [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API).
No installation required – open the app in Chrome or Edge and connect your device.

[![Latest Release](https://img.shields.io/github/v/release/the78mole/i2c-driver-webapp)](https://github.com/the78mole/i2c-driver-webapp/releases/latest)
[![Deploy Status](https://github.com/the78mole/i2c-driver-webapp/actions/workflows/release-and-deploy.yml/badge.svg)](https://github.com/the78mole/i2c-driver-webapp/actions/workflows/release-and-deploy.yml)

---

[![App Screenshot](https://github.com/the78mole/i2c-driver-webapp/releases/latest/download/app-screenshot.png)](https://the78mole.github.io/i2c-driver-webapp/)

---

## Features

| Section | What it does |
|---|---|
| **Device Status** | Live readout of firmware version, serial number, uptime, USB voltage & current, temperature, I²C speed and pullup configuration |
| **Bus Scan** | Scans all 112 valid I²C addresses and highlights detected devices with known-device labels |
| **Write / Read / WriteRead** | Raw I²C operations with hex input and annotated byte output |
| **Register Read / Write** | Single-byte register access with address + value |
| **Script Runner** | Execute multi-line I²C command scripts from a text editor |
| **Device Explorer** | Register-level explorer for known devices (ADXL345, BME280, DS3231, MCP9808) with per-register polling and a live chart |
| **Terminal Log** | Color-coded xterm.js log with timestamps for every TX/RX operation |

## Requirements

- **Browser:** Google Chrome ≥ 89 or Microsoft Edge ≥ 89 (Web Serial API required)
- **Connection:** `localhost` or HTTPS (Web Serial is restricted to secure contexts)
- **Hardware:** [I²C-Driver](https://i2cdriver.com/) connected via USB

## Live App

The latest build is deployed automatically to GitHub Pages:

**→ https://the78mole.github.io/i2c-driver-webapp/**

## Local Development

```bash
# Install dependencies
npm install

# Start dev server with hot reload
npm run dev

# Production build
npm run build

# Preview the production build locally
npm run preview
```

## How It Works

The app communicates with the I²CDriver over the Web Serial API using the device's
[binary protocol](https://i2cdriver.com/i2cdriver.pdf). All serial operations are
serialized via an async mutex to prevent byte interleaving from concurrent calls.

## CI / CD

Every push to `main`:

1. Computes a **semantic version** from commit history (`paulhatch/semantic-version`)
2. Builds the app with the correct GitHub Pages `base` path
3. Takes a **Playwright screenshot** (with `networkidle` wait) of the running build
4. Creates a **GitHub Release** with auto-generated notes and the screenshot attached
5. Deploys to **GitHub Pages**

Use `(MINOR)` or `(MAJOR)` in a commit message to bump the respective version component;
all other commits bump the patch version.

## License

[LICENSE](LICENSE)
