# TACAN Track Viewer

> A browser-first workspace for reviewing WinFIS-derived TACAN tracks with a calibrated 2D/3D track view.

[![Live Site](https://img.shields.io/badge/live%20site-owner--only-2563eb?style=flat-square)](https://tacan-track-viewer.kenzaz2014.chatgpt.site)
[![Built with React](https://img.shields.io/badge/built%20with-React%2019-149eca?style=flat-square&logo=react&logoColor=white)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

## Overview

TACAN Track Viewer is a local-file analysis surface for WinFIS-derived flight-track data. It lets an analyst load a recording and its matching export, validate the relationship between the two, and inspect the result spatially without uploading source files to a server.

The production Site is owner-only. This repository contains only the application source and public-safe documentation; operational recordings, raw samples, chart packages, screenshots, and internal validation material are intentionally excluded.

## What it does

- Parses supported `TORB` and `TRAD` recordings in the browser.
- Compares recording-derived values with a matching Excel export.
- Supports optional `RAW`, `NOTE`, and chart-PDF inputs for local review.
- Renders the route in 2D and 3D with playback, pilot-event navigation, and view presets.
- Calibrates a chart against a reference station and DME distance.
- Keeps calibration state in the browser, keyed to the selected chart fingerprint.
- Applies file-size, parser, rendering, and browser-security limits before analysis.

## Privacy and safety boundaries

This project is designed for test and analysis workflows:

- Source files are read in memory in the browser and are not embedded in the application.
- No operational track data or real validation evidence is part of the public repository.
- Offline-generated views are not UFP-UI, FMS, operational, or flight-check acceptance.
- Never commit recordings, spreadsheets, raw WinFIS exports, chart PDFs, screenshots containing real values, credentials, or local environment files.

## Technology

- React 19 + TypeScript
- Vinext / Vite
- PDF.js for local chart rendering
- ExcelJS for local workbook parsing
- Cloudflare-compatible build output for the Sites runtime

## Run locally

Requirements: Node.js `22.13.0` or newer.

```bash
npm ci
npm run dev
```

The development server will print the local URL. To create a production build:

```bash
npm run build
```

Useful quality checks:

```bash
npm run lint
npm run format
```

## Repository layout

```text
app/                 Application routes and shared styles
components/ui/       Reusable interface primitives
hooks/               Small React hooks
lib/                 Decoder, validation, security, and utility modules
public/              Browser assets, including the PDF.js worker
.openai/hosting.json Local Sites project metadata; credentials are never stored
```

## Deployment

The validated application is published as a private Sites deployment:

<https://tacan-track-viewer.kenzaz2014.chatgpt.site>

The public GitHub repository is the source-facing home for the project. The checked-in Sites metadata contains no credentials; deployment tokens and private runtime state are never stored in Git history.

## Status

Active development. The interface and decoder are intentionally scoped to local review and evidence-backed test workflows.
