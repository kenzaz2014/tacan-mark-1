# TACAN Mark 1 Public Viewer

This repository contains a public-safe TACAN track viewer UI.

Official TACAN station signal data has been removed from this GitHub version. The website still works with synthetic demo points so the layout, controls, 2D/3D map, playback, pilot-event navigation, zoom, and North Up behavior can be reviewed without exposing operational data.

Removed from the public repo:

- Real WinFIS track data
- Raw per-sample JSON files
- Embedded full `data.js` values
- Verification screenshots containing real values
- Internal project memory and decoder notes

## Run Locally

```bash
cd track-viewer
python3 -m http.server 8765
```

Then open:

```text
http://127.0.0.1:8765/index.html
```
