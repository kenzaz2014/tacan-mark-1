# TACAN Mark I

> Public-safe TACAN track viewers for evidence-backed review and analysis.

This repository contains the public-facing TACAN viewer workbench maintained by **kenzaz2014**. It preserves the original static viewer and adds the current React/Vinext application source in a clearly separated project path.

## Live application

The current validated application is published as a private Sites deployment:

**[Open TACAN Track Viewer](https://tacan-track-viewer.kenzaz2014.chatgpt.site)**

Access is intentionally restricted to the owner. The GitHub repository is the source-facing home for the public-safe implementation.

## Repository layout

- `sites/tacan-track-viewer/` — current React + TypeScript application source.
- `track-viewer/` — legacy static viewer retained for backwards-compatible review.
- `.github/workflows/validate.yml` — automated build and lint validation for the current source.

## Engineering principles

- **Local-first processing:** user-selected recordings and exports are handled in the browser.
- **Public-safe by default:** operational files, raw samples, chart packages, screenshots with real values, credentials, and internal notes are excluded.
- **Evidence over inference:** the viewer exposes source-derived values and validation context rather than inventing missing metadata.
- **Clear safety boundary:** offline-generated views are for test and analysis use only. They are not UFP-UI, FMS, operational, or flight-check acceptance.

## Current application capabilities

- Parse supported `TORB` and `TRAD` recordings in the browser.
- Compare recording-derived values with a matching Excel export.
- Review optional RAW, NOTE, and chart-PDF inputs locally.
- Inspect routes in 2D and 3D with playback and pilot-event navigation.
- Calibrate a chart against a reference station and DME distance.
- Keep calibration state local to the browser and bound to the selected chart fingerprint.
- Enforce file-size, parser, rendering, and browser-security limits.

## Run the current application locally

Requirements: Node.js `22.13.0` or newer.

```bash
cd sites/tacan-track-viewer
npm ci
npm run dev
```

Create a production build and run the same checks used by CI:

```bash
npm run lint
npm run build
```

## Public-data boundary

Do not commit:

- WinFIS recordings or per-sample exports
- Excel workbooks containing operational values
- RAW or NOTE files
- Chart PDFs or validation screenshots containing real data
- `.env` files, tokens, credentials, or local runtime state

If you are extending the viewer, keep new fixtures synthetic and clearly labeled.

## Status

Active development. The modern viewer is intentionally scoped to local review and evidence-backed test workflows.
