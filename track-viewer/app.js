const canvas = document.getElementById("track2d");
const ctx = canvas.getContext("2d");
const fileSelect = document.getElementById("fileSelect");
const sourceStatus = document.getElementById("sourceStatus");
const sampleSlider = document.getElementById("sampleSlider");
const sampleNumber = document.getElementById("sampleNumber");
const readout = document.getElementById("readout");
const playPause = document.getElementById("playPause");
const eventBtn = document.getElementById("eventBtn");
const eventStatus = document.getElementById("eventStatus");
const speedDown = document.getElementById("speedDown");
const speedLabel = document.getElementById("speedLabel");
const speedUp = document.getElementById("speedUp");
const trackName = document.getElementById("trackName");
const angleSlider = document.getElementById("angleSlider");
const tiltSlider = document.getElementById("tiltSlider");
const altSlider = document.getElementById("altSlider");
const altScaleLabel = document.getElementById("altScaleLabel");
const zoomOut = document.getElementById("zoomOut");
const zoomReset = document.getElementById("zoomReset");
const zoomIn = document.getElementById("zoomIn");
const northUp = document.getElementById("northUp");
const reportRange = document.getElementById("reportRange");
const reportBox = document.getElementById("reportBox");

const tracks = window.TACAN_TRACKS || [window.TACAN_TRACK_DATA];
let data = tracks[tracks.length - 1];
let points = data.points;

const FT_PER_NM = 6076.12;
const STATION_ALTITUDE_FT = 0;
const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

let currentIndex = 0;
let playing = false;
let timer = null;
let speedIndex = 2;
let viewMode = "3d";
let camera = { yaw: -32, pitch: 58, altScale: 10, zoom: 1 };
let dragStart = null;
let currentEventIndex = -1;
let reportSelection = "all";

const readoutFields = [
  ["RADIAL", "radialDeg", " Deg"],
  ["ALT", "altitudeFt", " FT"],
  ["AGL", "altAglFt", " FT"],
  ["STATUS", "publicStatus", ""],
];

function bounds() {
  let maxAbsX = 6;
  let maxAbsY = 6;
  let minAlt = Infinity;
  let maxAlt = -Infinity;
  let maxRelativeAltFt = 0;
  for (const point of points) {
    maxAbsX = Math.max(maxAbsX, Math.abs(point.eastNm));
    maxAbsY = Math.max(maxAbsY, Math.abs(point.northNm));
    minAlt = Math.min(minAlt, point.altitudeFt || 0);
    maxAlt = Math.max(maxAlt, point.altitudeFt || 0);
    maxRelativeAltFt = Math.max(maxRelativeAltFt, Math.abs((point.altitudeFt || 0) - STATION_ALTITUDE_FT));
  }
  const maxAbs = Math.max(maxAbsX, maxAbsY) + 6;
  return {
    minX: -maxAbs,
    maxX: maxAbs,
    minY: -maxAbs,
    maxY: maxAbs,
    minAlt,
    maxAlt,
    maxRelativeAltFt,
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function relativeAltitudeFt(point) {
  return (point.altitudeFt || 0) - STATION_ALTITUDE_FT;
}

function normalizeDegrees(degrees) {
  return ((degrees % 360) + 360) % 360;
}

function aircraftRadialDeg(point) {
  return normalizeDegrees((Math.atan2(point.eastNm, point.northNm) * 180) / Math.PI);
}

function formatDegrees(degrees) {
  const rounded = Math.round(normalizeDegrees(degrees));
  return String(rounded === 0 ? 360 : rounded).padStart(3, "0");
}

function compactNumber(value, digits = 2) {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return "N/A";
  return Number(value).toFixed(digits).replace(/\.?0+$/, "");
}

function currentScale(box, width, height) {
  const horizontalSpan = Math.max(box.maxX - box.minX, box.maxY - box.minY);
  const verticalSpan = (box.maxRelativeAltFt / FT_PER_NM) * camera.altScale * 1.9;
  const span = Math.max(horizontalSpan, verticalSpan, 12);
  return (Math.min(width, height) / (span * 1.18)) * camera.zoom;
}

function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(600, Math.floor(rect.width * ratio));
  canvas.height = Math.max(420, Math.floor(rect.height * ratio));
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  draw();
}

function project2d(point, box, width, height) {
  const margin = 54;
  const scaleX = (width - margin * 2) / (box.maxX - box.minX);
  const scaleY = (height - margin * 2) / (box.maxY - box.minY);
  const scale = Math.min(scaleX, scaleY) * camera.zoom;
  const usedW = (box.maxX - box.minX) * scale;
  const usedH = (box.maxY - box.minY) * scale;
  const ox = (width - usedW) / 2;
  const oy = (height - usedH) / 2;
  return {
    x: ox + (point.eastNm - box.minX) * scale,
    y: oy + (box.maxY - point.northNm) * scale,
  };
}

function project3d(point, box, width, height) {
  const yaw = (camera.yaw * Math.PI) / 180;
  const pitch = (camera.pitch * Math.PI) / 180;
  const x = point.eastNm;
  const z = point.northNm;
  const alt = relativeAltitudeFt(point) / FT_PER_NM;

  const rx = x * Math.cos(yaw) - z * Math.sin(yaw);
  const rz = x * Math.sin(yaw) + z * Math.cos(yaw);
  const ry = alt * camera.altScale;

  const sx = rx;
  const sy = -rz * Math.cos(pitch) - ry * Math.sin(pitch);
  const depth = rz * Math.sin(pitch) + ry * Math.cos(pitch);
  const scale = currentScale(box, width, height);

  return {
    x: width / 2 + sx * scale,
    y: height / 2 + sy * scale,
    depth,
  };
}

function groundPoint(point) {
  return {
    ...point,
    altitudeFt: STATION_ALTITUDE_FT,
  };
}

function clear(width, height) {
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#07121a");
  gradient.addColorStop(1, "#0d1d28");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function drawGrid2d(width, height) {
  ctx.strokeStyle = "#1f3544";
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 52) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += 52) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
}

function drawGrid3d(box, width, height) {
  const lines = 16;
  ctx.strokeStyle = "#20394a";
  ctx.lineWidth = 1;
  for (let i = 0; i <= lines; i += 1) {
    const x = box.minX + ((box.maxX - box.minX) * i) / lines;
    const a = project3d({ eastNm: x, northNm: box.minY, altitudeFt: STATION_ALTITUDE_FT }, box, width, height);
    const b = project3d({ eastNm: x, northNm: box.maxY, altitudeFt: STATION_ALTITUDE_FT }, box, width, height);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    const y = box.minY + ((box.maxY - box.minY) * i) / lines;
    const c = project3d({ eastNm: box.minX, northNm: y, altitudeFt: STATION_ALTITUDE_FT }, box, width, height);
    const d = project3d({ eastNm: box.maxX, northNm: y, altitudeFt: STATION_ALTITUDE_FT }, box, width, height);
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.stroke();
  }

  const east = project3d({ eastNm: box.maxX, northNm: 0, altitudeFt: STATION_ALTITUDE_FT }, box, width, height);
  const west = project3d({ eastNm: box.minX, northNm: 0, altitudeFt: STATION_ALTITUDE_FT }, box, width, height);
  const north = project3d({ eastNm: 0, northNm: box.maxY, altitudeFt: STATION_ALTITUDE_FT }, box, width, height);
  const south = project3d({ eastNm: 0, northNm: box.minY, altitudeFt: STATION_ALTITUDE_FT }, box, width, height);
  ctx.strokeStyle = "#31566e";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(west.x, west.y);
  ctx.lineTo(east.x, east.y);
  ctx.moveTo(south.x, south.y);
  ctx.lineTo(north.x, north.y);
  ctx.stroke();
}

function drawTextHalo(text, x, y, color = "#eaf2f7", align = "left") {
  ctx.save();
  ctx.font = "800 12px sans-serif";
  ctx.textAlign = align;
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(4, 13, 20, 0.85)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawMapDirections(project, box, width, height, is3d = false) {
  const radius = Math.min((box.maxX - box.minX) * 0.18, 16);
  const baseAlt = is3d ? STATION_ALTITUDE_FT : undefined;
  const origin = project({ eastNm: 0, northNm: 0, altitudeFt: baseAlt }, box, width, height);
  const directions = [
    { label: "N 360", eastNm: 0, northNm: radius, color: "#ffd166", width: 3 },
    { label: "090", eastNm: radius, northNm: 0, color: "#8fb4cc", width: 1.5 },
    { label: "180", eastNm: 0, northNm: -radius, color: "#8fb4cc", width: 1.5 },
    { label: "270", eastNm: -radius, northNm: 0, color: "#8fb4cc", width: 1.5 },
  ];

  for (const direction of directions) {
    const end = project(
      { eastNm: direction.eastNm, northNm: direction.northNm, altitudeFt: baseAlt },
      box,
      width,
      height,
    );
    ctx.save();
    ctx.strokeStyle = direction.color;
    ctx.lineWidth = direction.width;
    ctx.beginPath();
    ctx.moveTo(origin.x, origin.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.restore();
    drawTextHalo(direction.label, end.x + 8, end.y - 7, direction.color);
  }
}

function drawRadialCue(project, box, width, height, point, is3d = false) {
  const baseAlt = is3d ? STATION_ALTITUDE_FT : undefined;
  const station = project({ eastNm: 0, northNm: 0, altitudeFt: baseAlt }, box, width, height);
  const aircraftGround = project(
    { eastNm: point.eastNm, northNm: point.northNm, altitudeFt: baseAlt },
    box,
    width,
    height,
  );
  const radial = formatDegrees(aircraftRadialDeg(point));
  ctx.save();
  ctx.strokeStyle = "rgba(255, 209, 102, 0.88)";
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 5]);
  ctx.beginPath();
  ctx.moveTo(station.x, station.y);
  ctx.lineTo(aircraftGround.x, aircraftGround.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#ffd166";
  ctx.beginPath();
  ctx.arc(aircraftGround.x, aircraftGround.y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  drawTextHalo(`RDL ${radial} / ${formatValue(point.gpsRangeNm, " NM")}`, aircraftGround.x + 12, aircraftGround.y + 18, "#ffd166");
}

function drawAltitudeCue(point, box, width, height) {
  const ground = project3d(groundPoint(point), box, width, height);
  const aircraft = project3d(point, box, width, height);
  const heightFt = relativeAltitudeFt(point);
  ctx.save();
  ctx.strokeStyle = "rgba(255, 208, 102, 0.9)";
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(ground.x, ground.y);
  ctx.lineTo(aircraft.x, aircraft.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(255, 208, 102, 0.18)";
  ctx.beginPath();
  ctx.ellipse(ground.x, ground.y, 13, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffe39c";
  ctx.font = "700 12px sans-serif";
  ctx.fillText(`${Math.round(heightFt).toLocaleString()} FT`, aircraft.x + 12, aircraft.y - 10);
  ctx.restore();
}

function drawPath(project, box, width, height) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#7fa7ca";
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((point, index) => {
    const p = project(point, box, width, height);
    if (index === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.stroke();

  const range = selectedReportRange();
  if (range.mode === "range" && range.points.length) {
    ctx.strokeStyle = "#ffd166";
    ctx.lineWidth = 6;
    ctx.beginPath();
    range.points.forEach((point, index) => {
      const p = project(point, box, width, height);
      if (index === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
  }

  ctx.strokeStyle = "#2ee8ff";
  ctx.lineWidth = 4;
  ctx.beginPath();
  points.slice(0, currentIndex + 1).forEach((point, index) => {
    const p = project(point, box, width, height);
    if (index === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.stroke();
}

function drawAircraft(p, headingDeg) {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(((headingDeg || 0) * Math.PI) / 180);
  ctx.fillStyle = "#28e6f4";
  ctx.strokeStyle = "#c9fbff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(11, 0);
  ctx.lineTo(-8, -6);
  ctx.lineTo(-4, 0);
  ctx.lineTo(-8, 6);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function headingProbe(point) {
  const heading = (point.gpsBearingDeg * Math.PI) / 180;
  const stepNm = Math.max(0.8, (point.gpsRangeNm || 1) * 0.05);
  return {
    ...point,
    eastNm: point.eastNm + Math.sin(heading) * stepNm,
    northNm: point.northNm + Math.cos(heading) * stepNm,
  };
}

function drawAircraftProjected(project, box, width, height, point, is3d = false) {
  const aircraft = project(point, box, width, height);
  const nosePoint = is3d ? headingProbe(point) : headingProbe(point);
  const nose = project(nosePoint, box, width, height);
  const headingDeg = (Math.atan2(nose.y - aircraft.y, nose.x - aircraft.x) * 180) / Math.PI;
  drawAircraft(aircraft, headingDeg);
}

function draw() {
  const rect = canvas.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  const box = bounds();
  clear(width, height);

  if (viewMode === "2d") {
    drawGrid2d(width, height);
    drawMapDirections(project2d, box, width, height);
    drawRadialCue(project2d, box, width, height, points[currentIndex]);
    drawPath(project2d, box, width, height);
    const station = project2d({ eastNm: 0, northNm: 0 }, box, width, height);
    drawStation(station);
    drawAircraftProjected(project2d, box, width, height, points[currentIndex]);
    return;
  }

  drawGrid3d(box, width, height);
  drawMapDirections(project3d, box, width, height, true);
  drawRadialCue(project3d, box, width, height, points[currentIndex], true);
  drawPath(project3d, box, width, height);
  const station = project3d({ eastNm: 0, northNm: 0, altitudeFt: STATION_ALTITUDE_FT }, box, width, height);
  drawStation(station);
  drawAltitudeCue(points[currentIndex], box, width, height);
  drawAircraftProjected(project3d, box, width, height, points[currentIndex], true);
}

function drawStation(p) {
  ctx.fillStyle = "#d0831f";
  ctx.beginPath();
  ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#eaf2f7";
  ctx.font = "700 13px sans-serif";
  ctx.fillText("UBL", p.x + 11, p.y - 9);
}

function formatValue(value, suffix) {
  if (value === undefined || value === null || value === "") return "-";
  if (typeof value === "string") return value;
  const number = Number(value);
  const fixed = Number.isInteger(number)
    ? String(number)
    : number.toFixed(Math.abs(number) >= 100 ? 1 : 2).replace(/\.?0+$/, "");
  return `${fixed}${suffix}`;
}

function updateScaleLabel() {
  const box = bounds();
  const point = points[currentIndex];
  const spanNm = Math.round((box.maxX - box.minX) / 2);
  altScaleLabel.textContent = `Altitude x${camera.altScale} · range ${formatValue(point.gpsRangeNm, " NM")} · height ${formatValue(relativeAltitudeFt(point), " FT")} · radius ${spanNm} NM · zoom ${camera.zoom.toFixed(1)}x`;
}

function pilotEvents() {
  return data.note?.pilot_events || [];
}

function eventIndexForSample(sample) {
  return pilotEvents().findIndex((event) => event.sample === sample);
}

function updateEventStatus() {
  const events = pilotEvents();
  const matchedEventIndex = eventIndexForSample(points[currentIndex].sample);
  if (matchedEventIndex !== -1) {
    currentEventIndex = matchedEventIndex;
  }
  if (!events.length) {
    currentEventIndex = -1;
    eventBtn.disabled = true;
    eventStatus.textContent = "Pilot Event 0 / 0";
    return;
  }
  eventBtn.disabled = false;
  const displayIndex = currentEventIndex >= 0 ? currentEventIndex + 1 : "-";
  const sampleText = currentEventIndex >= 0 ? ` · sample ${events[currentEventIndex].sample}` : "";
  eventStatus.textContent = `Pilot Event ${displayIndex} / ${events.length}${sampleText}`;
}

function updateSourceStatus() {
  if (data.publicRedacted) {
    sourceStatus.textContent = "Public demo · official TACAN signal data redacted";
    return;
  }
  const source = data.excelBacked ? "Excel" : "decoded";
  const file = data.excelBacked ? data.excelSourceFile?.split("/").pop() : data.sourceFile?.split("/").pop();
  sourceStatus.textContent = `Source: ${source}${file ? ` · ${file}` : ""}`;
}

function pilotEventRanges() {
  const events = pilotEvents();
  const ranges = [];
  for (let index = 0; index < events.length - 1; index += 1) {
    const start = events[index].sample;
    const end = events[index + 1].sample;
    if (end > start) {
      ranges.push({
        value: `range:${index}`,
        label: `Pilot P${index + 1}-P${index + 2} · samples ${start}-${end}`,
        start,
        end,
      });
    }
  }
  return ranges;
}

function selectedReportRange() {
  if (reportSelection === "exclude") {
    return { mode: "exclude", label: "Exclude all", points: [], start: null, end: null };
  }
  if (reportSelection.startsWith("range:")) {
    const rangeIndex = Number(reportSelection.split(":")[1]);
    const range = pilotEventRanges()[rangeIndex];
    if (range) {
      return {
        mode: "range",
        label: range.label,
        start: range.start,
        end: range.end,
        points: points.slice(range.start - 1, range.end),
      };
    }
  }
  return { mode: "all", label: "All file", start: 1, end: points.length, points };
}

function updateReportRangeOptions() {
  const previousSelection = reportSelection;
  reportRange.replaceChildren();
  [
    ["all", "All file"],
    ["exclude", "Exclude all"],
  ].forEach(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    reportRange.append(option);
  });
  pilotEventRanges().forEach((range) => {
    const option = document.createElement("option");
    option.value = range.value;
    option.textContent = range.label;
    reportRange.append(option);
  });
  const values = [...reportRange.options].map((option) => option.value);
  reportSelection = values.includes(previousSelection) ? previousSelection : "all";
  reportRange.value = reportSelection;
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function extremeBy(pointsForStats, key, predicate, absolute = false) {
  const candidates = pointsForStats
    .map((point) => ({ point, value: Number(point[key]) }))
    .filter(({ value }) => Number.isFinite(value) && predicate(value));
  if (!candidates.length) return null;
  return candidates.reduce((best, current) => {
    const bestScore = absolute ? Math.abs(best.value) : best.value;
    const currentScore = absolute ? Math.abs(current.value) : current.value;
    return currentScore > bestScore ? current : best;
  });
}

function buildReport() {
  return [
    "PUBLIC DEMO",
    "Official station signal data has been removed from this GitHub version.",
    "The map remains available with synthetic demo points only.",
    "Source file names, official exports, raw track data, and verification screenshots are not included.",
  ].join("\n");
}

function updateReport() {
  reportBox.textContent = buildReport();
}

function updateReadout() {
  const point = points[currentIndex];
  point.radialDeg = Number(formatDegrees(aircraftRadialDeg(point)));
  point.publicStatus = data.publicRedacted ? "REDACTED" : "";
  sampleNumber.textContent = point.sample;
  sampleSlider.value = String(currentIndex);
  readout.replaceChildren();
  for (const [label, key, suffix] of readoutFields) {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = label;
    dd.textContent = formatValue(point[key], suffix);
    if (Number(point[key]) < 0) dd.classList.add("negative");
    readout.append(dt, dd);
  }
  updateScaleLabel();
  updateEventStatus();
  updateReport();
  draw();
}

function setIndex(index) {
  currentIndex = Math.max(0, Math.min(points.length - 1, index));
  updateReadout();
}

function playbackSpeed() {
  return PLAYBACK_SPEEDS[speedIndex];
}

function updateSpeedLabel() {
  speedLabel.textContent = `${playbackSpeed()}x`;
  speedDown.disabled = speedIndex === 0;
  speedUp.disabled = speedIndex === PLAYBACK_SPEEDS.length - 1;
}

function stopPlaybackTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

function playbackStep() {
  const speed = playbackSpeed();
  if (speed < 1) return 1;
  return Math.max(1, Math.round(5 * speed));
}

function playbackDelay() {
  const speed = playbackSpeed();
  return speed < 1 ? Math.round(120 / speed) : 70;
}

function startPlaybackTimer() {
  stopPlaybackTimer();
  if (playing) {
    timer = setInterval(() => {
      if (currentIndex >= points.length - 1) setIndex(0);
      else setIndex(currentIndex + playbackStep());
    }, playbackDelay());
  }
}

function togglePlay() {
  playing = !playing;
  playPause.textContent = playing ? "Pause" : "Play";
  startPlaybackTimer();
}

function setPlaybackSpeed(nextIndex) {
  speedIndex = clamp(nextIndex, 0, PLAYBACK_SPEEDS.length - 1);
  updateSpeedLabel();
  startPlaybackTimer();
}

function setZoom(nextZoom) {
  camera.zoom = clamp(nextZoom, 0.45, 5);
  updateScaleLabel();
  draw();
}

function setPitch(nextPitch) {
  camera.pitch = clamp(nextPitch, 15, 78);
  tiltSlider.value = String(Math.round(camera.pitch));
  draw();
}

function loadTrack(index) {
  data = tracks[index];
  points = data.points;
  currentIndex = 0;
  currentEventIndex = -1;
  fileSelect.value = String(index);
  trackName.textContent = data.title;
  updateSourceStatus();
  sampleSlider.min = "0";
  sampleSlider.max = String(points.length - 1);
  sampleSlider.value = "0";
  updateReportRangeOptions();
  const eventSample = data.note?.pilot_events?.[0]?.sample;
  if (eventSample) currentEventIndex = 0;
  setIndex(eventSample ? eventSample - 1 : 0);
  resizeCanvas();
}

function goToNextPilotEvent() {
  const events = pilotEvents();
  if (!events.length) return;
  const matchedEventIndex = eventIndexForSample(points[currentIndex].sample);
  const startIndex = matchedEventIndex !== -1 ? matchedEventIndex : currentEventIndex;
  currentEventIndex = (startIndex + 1 + events.length) % events.length;
  setIndex(events[currentEventIndex].sample - 1);
}

function init() {
  tracks.forEach((track, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    const description = track.note?.description ? ` · ${track.note.description.trim()}` : "";
    option.textContent = `${track.title}${description}`;
    fileSelect.append(option);
  });
  fileSelect.addEventListener("change", (event) => loadTrack(Number(event.target.value)));
  reportRange.addEventListener("change", (event) => {
    reportSelection = event.target.value;
    const range = selectedReportRange();
    if (range.mode === "range" && range.start) {
      setIndex(range.start - 1);
    } else {
      updateReport();
      draw();
    }
  });
  trackName.textContent = data.title;
  sampleSlider.min = "0";
  sampleSlider.max = String(points.length - 1);
  sampleSlider.value = "0";
  eventBtn.addEventListener("click", goToNextPilotEvent);
  playPause.addEventListener("click", togglePlay);
  speedDown.addEventListener("click", () => setPlaybackSpeed(speedIndex - 1));
  speedUp.addEventListener("click", () => setPlaybackSpeed(speedIndex + 1));
  sampleSlider.addEventListener("input", (event) => setIndex(Number(event.target.value)));
  angleSlider.addEventListener("input", (event) => {
    camera.yaw = Number(event.target.value);
    draw();
  });
  tiltSlider.addEventListener("input", (event) => {
    setPitch(Number(event.target.value));
  });
  altSlider.addEventListener("input", (event) => {
    camera.altScale = Number(event.target.value);
    updateScaleLabel();
    draw();
  });
  zoomOut.addEventListener("click", () => setZoom(camera.zoom / 1.25));
  zoomIn.addEventListener("click", () => setZoom(camera.zoom * 1.25));
  northUp.addEventListener("click", () => {
    camera.yaw = 0;
    angleSlider.value = "0";
    draw();
  });
  zoomReset.addEventListener("click", () => {
    camera.zoom = 1;
    camera.pitch = 58;
    camera.yaw = -32;
    angleSlider.value = String(camera.yaw);
    tiltSlider.value = String(camera.pitch);
    updateScaleLabel();
    draw();
  });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    setZoom(camera.zoom * (event.deltaY < 0 ? 1.12 : 0.89));
  }, { passive: false });
  canvas.addEventListener("pointerdown", (event) => {
    if (viewMode !== "3d") return;
    canvas.setPointerCapture(event.pointerId);
    dragStart = {
      x: event.clientX,
      y: event.clientY,
      yaw: camera.yaw,
      pitch: camera.pitch,
    };
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!dragStart) return;
    camera.yaw = clamp(dragStart.yaw + (event.clientX - dragStart.x) * 0.25, -180, 180);
    angleSlider.value = String(Math.round(camera.yaw));
    setPitch(dragStart.pitch - (event.clientY - dragStart.y) * 0.18);
  });
  canvas.addEventListener("pointerup", () => {
    dragStart = null;
  });
  canvas.addEventListener("pointercancel", () => {
    dragStart = null;
  });
  document.querySelectorAll(".mode").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.view) {
        viewMode = button.dataset.view;
        if (viewMode === "3d" && camera.pitch < 20) {
          camera.pitch = 58;
          tiltSlider.value = String(camera.pitch);
        }
        document
          .querySelectorAll("[data-view]")
          .forEach((b) => b.classList.toggle("active", b === button));
      }
      if (button.dataset.camera === "top") {
        viewMode = "2d";
        document
          .querySelectorAll("[data-view]")
          .forEach((b) => b.classList.toggle("active", b.dataset.view === "2d"));
      }
      if (button.dataset.camera === "side") {
        viewMode = "3d";
        camera.pitch = 15;
        camera.yaw = 0;
        angleSlider.value = "0";
        tiltSlider.value = String(camera.pitch);
        document
          .querySelectorAll("[data-view]")
          .forEach((b) => b.classList.toggle("active", b.dataset.view === "3d"));
      }
      draw();
    });
  });
  window.addEventListener("resize", resizeCanvas);
  updateSpeedLabel();
  loadTrack(tracks.length - 1);
}

init();
