'use client';

import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  CircleHelp,
  Crosshair,
  FileCheck2,
  FileSpreadsheet,
  FileText,
  Gauge,
  Info,
  LockKeyhole,
  Map,
  Pause,
  Play,
  RotateCcw,
  Save,
  Satellite,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Upload,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  buildTrack,
  formatDegrees,
  formatNumber,
  formatUtc,
  renderPdfPage,
  type DecodedSample,
  type PreparedSession,
  type TrackData,
  type ValidationOutcome,
  validateFileSet,
} from '@/lib/tacan';

type FileKey = 'primary' | 'excel' | 'raw' | 'note' | 'pdf';
type FileSet = Record<FileKey, File | null>;
type ViewMode = '2d' | '3d';
type CalibrationStep = 'station' | 'ring' | null;
type ReportHighlightRange = { start: number; end: number } | null;

type ChartPoint = { x: number; y: number };
type Calibration = {
  station: ChartPoint;
  pxPerNm: number;
  reference?: ChartPoint;
  referenceDistanceNm?: number;
  rotationDeg?: number;
};
type PdfPreview = {
  canvas: HTMLCanvasElement;
  groundCanvas: HTMLCanvasElement;
  fileName: string;
  fingerprint: string;
  width: number;
  height: number;
};

const EMPTY_FILES: FileSet = {
  primary: null,
  excel: null,
  raw: null,
  note: null,
  pdf: null,
};

const CALIBRATION_STORAGE_PREFIX = 'tacan-local-calibration.v1:';
const FT_PER_NM = 6076.12;
const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2, 4, 8] as const;

const FILE_SLOTS: Array<{
  key: FileKey;
  label: string;
  description: string;
  icon: typeof Satellite;
  accept?: string;
  required: boolean;
}> = [
  {
    key: 'primary',
    label: 'Primary track recording',
    description:
      'One TORB or TRAD file. The prefix and binary structure are checked.',
    icon: Satellite,
    required: true,
  },
  {
    key: 'excel',
    label: 'WinFIS Excel export',
    description: 'Matching .xlsx export. Report-style fields are read locally.',
    icon: FileSpreadsheet,
    accept: '.xlsx',
    required: true,
  },
  {
    key: 'raw',
    label: 'RAW companion',
    description: 'Optional fixed-length per-sample binary companion.',
    icon: FileCheck2,
    required: false,
  },
  {
    key: 'note',
    label: 'NOTE file',
    description: 'Optional text metadata and pilot-event detail.',
    icon: FileText,
    required: false,
  },
  {
    key: 'pdf',
    label: 'TACAN chart PDF',
    description: 'Optional local chart overlay. Exactly one page is required.',
    icon: Map,
    accept: '.pdf,application/pdf',
    required: false,
  },
];

function fileSize(file: File | null): string {
  if (!file) return 'Not selected';
  if (file.size < 1024 * 1024)
    return `${Math.max(1, Math.round(file.size / 1024))} KB`;
  return `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
}

function initialSampleIndex(session: TrackData): number {
  const firstEventSample = session.note.pilotEvents[0]?.sample ?? 1;
  return clamp(firstEventSample - 1, 0, session.samples.length - 1);
}

function stationReference(session: TrackData): string {
  const sourceValue = [
    session.note.sensor,
    session.note.recordId,
    session.embeddedText,
  ].find((value) => value?.trim());
  return sourceValue?.trim() ?? 'Not stated in source metadata';
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatDateTime(): string {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date());
}

function readStoredCalibration(fingerprint: string): Calibration | null {
  try {
    const raw = window.localStorage.getItem(
      `${CALIBRATION_STORAGE_PREFIX}${fingerprint}`,
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Calibration>;
    if (
      !parsed.station ||
      !Number.isFinite(parsed.station.x) ||
      !Number.isFinite(parsed.station.y) ||
      !Number.isFinite(parsed.pxPerNm) ||
      Number(parsed.pxPerNm) <= 0
    )
      return null;
    return {
      station: { x: Number(parsed.station.x), y: Number(parsed.station.y) },
      pxPerNm: Number(parsed.pxPerNm),
      reference:
        parsed.reference &&
        Number.isFinite(parsed.reference.x) &&
        Number.isFinite(parsed.reference.y)
          ? { x: Number(parsed.reference.x), y: Number(parsed.reference.y) }
          : undefined,
      referenceDistanceNm:
        Number.isFinite(parsed.referenceDistanceNm) &&
        Number(parsed.referenceDistanceNm) > 0
          ? Number(parsed.referenceDistanceNm)
          : undefined,
      rotationDeg: Number.isFinite(parsed.rotationDeg)
        ? Number(parsed.rotationDeg)
        : 0,
    };
  } catch {
    return null;
  }
}

function saveStoredCalibration(
  fingerprint: string,
  calibration: Calibration,
): boolean {
  try {
    window.localStorage.setItem(
      `${CALIBRATION_STORAGE_PREFIX}${fingerprint}`,
      JSON.stringify(calibration),
    );
    return true;
  } catch {
    return false;
  }
}

function chartTransform(
  width: number,
  height: number,
  image: PdfPreview | null,
) {
  if (!image) return null;
  const scale = Math.min(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  return {
    scale,
    offsetX: (width - drawWidth) / 2,
    offsetY: (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  };
}

function trackBounds(samples: DecodedSample[]) {
  let maxRadius = 3;
  let minAltitude = 0;
  let maxAltitude = 0;
  samples.forEach((sample) => {
    maxRadius = Math.max(maxRadius, Math.hypot(sample.eastNm, sample.northNm));
    minAltitude = Math.min(minAltitude, sample.altitudeFt);
    maxAltitude = Math.max(maxAltitude, sample.altitudeFt);
  });
  return { maxRadius, minAltitude, maxAltitude };
}

type SceneBounds = ReturnType<typeof trackBounds>;
type ScenePoint = { eastNm: number; northNm: number; altitudeFt: number };
type ProjectedPoint = { x: number; y: number; depth?: number };
type Camera = { yaw: number; pitch: number; altScale: number; zoom: number };
type ProjectPoint = (point: ScenePoint, ground?: boolean) => ProjectedPoint;
type TrackPresentationScale = { horizontal: number; vertical: number };

// Presentation-only scaling for the calibrated chart view.  The decoder,
// calibration values, and displayed measurements remain unchanged; this
// simply gives the track more visual room inside the same responsive canvas.
const CHART_TRACK_PRESENTATION_SCALE: TrackPresentationScale = {
  horizontal: 1.1,
  vertical: 1.2,
};

function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color = '#1f2933',
  align: CanvasTextAlign = 'left',
) {
  ctx.save();
  ctx.font = '700 11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = align;
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawGrid2d(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  ctx.save();
  ctx.strokeStyle = 'rgba(188, 198, 207, 0.58)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= width; x += 52) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y <= height; y += 52) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.restore();
}

function rotateVector(eastNm: number, northNm: number, degrees: number) {
  const radians = (degrees * Math.PI) / 180;
  return {
    eastNm: eastNm * Math.cos(radians) - northNm * Math.sin(radians),
    northNm: eastNm * Math.sin(radians) + northNm * Math.cos(radians),
  };
}

function sceneScale(
  bounds: SceneBounds,
  width: number,
  height: number,
  camera: Camera,
) {
  const horizontalSpan = Math.max(bounds.maxRadius * 2 + 12, 12);
  const verticalSpan = Math.max(
    1,
    ((bounds.maxAltitude - bounds.minAltitude) / FT_PER_NM) *
      camera.altScale *
      1.9,
  );
  return (
    (Math.min(width, height) /
      (Math.max(horizontalSpan, verticalSpan) * 1.18)) *
    camera.zoom
  );
}

function createProject2d(
  bounds: SceneBounds,
  width: number,
  height: number,
  camera: Camera,
  presentationScale: TrackPresentationScale = { horizontal: 1, vertical: 1 },
): ProjectPoint {
  const horizontalSpan = Math.max(bounds.maxRadius * 2 + 12, 12);
  const scale =
    (Math.min(width, height) / (horizontalSpan * 1.18)) *
    camera.zoom *
    presentationScale.horizontal;
  return (point) => ({
    x: width / 2 + point.eastNm * scale,
    y: height / 2 - point.northNm * scale,
  });
}

function createProject3d(
  bounds: SceneBounds,
  width: number,
  height: number,
  camera: Camera,
  presentationScale: TrackPresentationScale = { horizontal: 1, vertical: 1 },
): ProjectPoint {
  const yaw = (camera.yaw * Math.PI) / 180;
  const pitch = (camera.pitch * Math.PI) / 180;
  const scale = sceneScale(bounds, width, height, camera);
  // Keep the additional altitude presentation scale inside the canvas.  The
  // ground plane and route receive the same offset, so calibration geometry
  // stays aligned while the taller profile remains readable near the top edge.
  const altitudeSpanNm =
    ((bounds.maxAltitude - bounds.minAltitude) / FT_PER_NM) * camera.altScale;
  const altitudePresentationOffset =
    Math.max(0, altitudeSpanNm * Math.sin(pitch)) *
    (presentationScale.vertical - 1) *
    scale;
  return (point, ground = false) => {
    const rx = point.eastNm * Math.cos(yaw) - point.northNm * Math.sin(yaw);
    const rz = point.eastNm * Math.sin(yaw) + point.northNm * Math.cos(yaw);
    const altitudeNm = ground
      ? 0
      : (point.altitudeFt - bounds.minAltitude) / FT_PER_NM;
    const ry = altitudeNm * camera.altScale;
    return {
      x: width / 2 + rx * scale * presentationScale.horizontal,
      y:
        height / 2 +
        altitudePresentationOffset +
        (-rz * Math.cos(pitch) * presentationScale.horizontal -
          ry * Math.sin(pitch) * presentationScale.vertical) *
          scale,
      depth:
        rz * Math.sin(pitch) * presentationScale.horizontal +
        ry * Math.cos(pitch) * presentationScale.vertical,
    };
  };
}

function chartPixelToGround(
  calibration: Calibration,
  x: number,
  y: number,
  rotation: number,
): ScenePoint {
  const chartVector = {
    eastNm: (x - calibration.station.x) / calibration.pxPerNm,
    northNm: (calibration.station.y - y) / calibration.pxPerNm,
  };
  const ground = rotateVector(
    chartVector.eastNm,
    chartVector.northNm,
    -rotation,
  );
  return { ...ground, altitudeFt: 0 };
}

function createChartGroundCanvas(source: HTMLCanvasElement) {
  const groundCanvas = window.document.createElement('canvas');
  groundCanvas.width = source.width;
  groundCanvas.height = source.height;
  const context = groundCanvas.getContext('2d', { willReadFrequently: true });
  if (!context) return source;
  context.drawImage(source, 0, 0);
  try {
    const imageData = context.getImageData(
      0,
      0,
      groundCanvas.width,
      groundCanvas.height,
    );
    const pixels = imageData.data;
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      const lightness = (red + green + blue) / 3;
      const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
      if (lightness > 248 && chroma < 10) {
        pixels[index + 3] = 0;
      } else if (lightness > 232 && chroma < 18) {
        pixels[index + 3] = Math.round(
          pixels[index + 3] * ((248 - lightness) / 16),
        );
        pixels[index] = 0;
        pixels[index + 1] = 0;
        pixels[index + 2] = 0;
      } else {
        pixels[index] = 0;
    oor(width * dpr);
  const pixelHeight = Math.floor(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const current = samples[currentIndex] ?? samples[0];
  const chartFit = chartTransform(width, height, chart.preview);
  const presentationScale = chart.active
    ? CHART_TRACK_PRESENTATION_SCALE
    : undefined;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  if (chart.editing && chart.preview && chartFit) {
    ctx.save();
    ctx.globalAlpha = chart.opacity;
    ctx.drawImage(
      chart.preview.canvas,
      chartFit.offsetX,
      chartFit.offsetY,
      chartFit.drawWidth,
      chartFit.drawHeight,
    );
    ctx.restore();
    drawCalibrationMarkers(
      ctx,
      chart.preview,
      chart.pendingStation,
      chart.pendingRing,
      chart.activeHandle,
      chartFit,
    );
    return;
  }

  if (viewMode === '2d') {
    const project = createProject2d(
      bounds,
      width,
      height,
      camera,
      presentationScale,
    );
    if (chart.visible && chart.preview && chart.active) {
      drawChartPlane(
        ctx,
        chart.preview,
        chart.active,
        chart.rotation,
        chart.opacity,
        project,
      );
    } else if (chart.visible && chart.preview && chartFit) {
      ctx.save();
      ctx.globalAlpha = chart.opacity;
      ctx.drawImage(
        chart.preview.canvas,
        chartFit.offsetX,
        chartFit.offsetY,
        chartFit.drawWidth,
        chartFit.drawHeight,
      );
      ctx.restore();
    }
    drawGrid2d(ctx, width, height);
    drawMapDirections(ctx, bounds, project);
    drawRadialCue(ctx, current, project);
    drawPath(ctx, samples, currentIndex, highlightRange, project);
    const currentPoint = project(current);
    drawStation(ctx, project({ eastNm: 0, northNm: 0, altitudeFt: 0 }, true));
    drawAircraftProjected(ctx, samples, currentIndex, project, '#16ddec');
    drawLabel(
      ctx,
      `${formatDegrees(current.gpsBearingDeg)}° / ${formatNumber(current.gpsRangeNm, 1)} NM`,
      currentPoint.x + 13,
      currentPoint.y - 13,
      '#334155',
    );
  } else {
    const project = createProject3d(
      bounds,
      width,
      height,
      camera,
      presentationScale,
    );
    if (chart.visible && chart.preview) {
      drawChartPlane(
        ctx,
        chart.preview,
        chart.active ?? provisionalChartCalibration(chart.preview, bounds),
        chart.rotation,
        chart.opacity,
        project,
        true,
      );
    }
    drawGrid3d(ctx, bounds, project);
    drawMapDirections(ctx, bounds, project);
    drawRadialCue(ctx, current, project);
    drawPath(ctx, samples, currentIndex, highlightRange, project);
    drawAltitudeCue(ctx, current, project);
    drawStation(ctx, project({ eastNm: 0, northNm: 0, altitudeFt: 0 }, true));
    drawAircraftProjected(ctx, samples, currentIndex, project, '#16ddec');
    drawLabel(ctx, '3D ALTITUDE VIEW', 24, 28, '#1f2933');
    drawLabel(
      ctx,
      `${formatNumber(current.altitudeFt, 0)} FT MSL`,
      width - 24,
      28,
      '#9a4d19',
      'right',
    );
    if (chart.visible && chart.preview && !chart.active)
      drawLabel(
        ctx,
        'UNCALIBRATED PDF GROUND PREVIEW · ALIGN IN 2D',
        24,
        50,
        '#9a4d19',
      );
  }
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.fillRect(16, height - 52, Math.min(390, width - 32), 32);
  drawLabel(
    ctx,
    `SAMPLE ${String(current.sample).padStart(5, '0')} / ${samples.length.toLocaleString()}`,
    28,
    height - 31,
    '#1f2933',
  );
  drawLabel(
    ctx,
    `${formatDegrees(current.gpsBearingDeg)}°  ${formatNumber(current.gpsRangeNm, 1)} NM`,
    width - 24,
    height - 31,
    '#9a4d19',
    'right',
  );
  ctx.restore();
}

function drawPath(
  ctx: CanvasRenderingContext2D,
  samples: DecodedSample[],
  currentIndex: number,
  highlightRange: ReportHighlightRange,
  project: (sample: DecodedSample) => { x: number; y: number; depth?: number },
) {
  if (!samples.length) return;
  const stride = Math.max(1, Math.floor(samples.length / 12000));
  const strokeRange = (
    firstIndex: number,
    lastIndex: number,
    color: string,
    width: number,
  ) => {
    if (lastIndex < firstIndex) return;
    ctx.beginPath();
    let lastDrawn = -1;
    for (let index = firstIndex; index <= lastIndex; index += stride) {
      const point = project(samples[index]);
      if (lastDrawn < 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
      lastDrawn = index;
    }
    if (lastDrawn !== lastIndex) {
      const point = project(samples[lastIndex]);
      ctx.lineTo(point.x, point.y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  strokeRange(0, samples.length - 1, 'rgba(63, 125, 181, 0.78)', 2.5);
  if (highlightRange) {
    strokeRange(
      clamp(highlightRange.start - 1, 0, samples.length - 1),
      clamp(highlightRange.end - 1, 0, samples.length - 1),
      'rgba(242, 184, 64, 0.96)',
      7,
    );
  }
  if (currentIndex > 0)
    strokeRange(0, currentIndex, 'rgba(17, 213, 232, 0.98)', 4.5);
  ctx.restore();
}

function drawStation(ctx: CanvasRenderingContext2D, point: ProjectedPoint) {
  ctx.save();
  ctx.strokeStyle = '#9a4d19';
  ctx.fillStyle = '#d0831f';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(point.x, point.y, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  drawLabel(ctx, 'TACAN', point.x + 12, point.y - 10, '#9a4d19');
  ctx.restore();
}

function drawAircraft(
  ctx: CanvasRenderingContext2D,
  point: ProjectedPoint,
  angle: number,
  color: string,
) {
  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.rotate(angle);
  ctx.shadowColor = 'rgba(8, 48, 61, 0.36)';
  ctx.shadowBlur = 8;
  ctx.fillStyle = color;
  ctx.strokeStyle = '#073b4c';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, -14);
  ctx.lineTo(8, 10);
  ctx.lineTo(0, 6);
  ctx.lineTo(-8, 10);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawAircraftProjected(
  ctx: CanvasRenderingContext2D,
  samples: DecodedSample[],
  currentIndex: number,
  project: ProjectPoint,
  color: string,
) {
  const current = project(samples[currentIndex]);
  let dx = 0;
  let dy = - return {
    min: Math.min(...values),
    max: Math.max(...values),
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

function reportRangeText(
  session: TrackData,
  selection: string,
  ranges: Array<{ label: string; start: number; end: number }>,
) {
  if (selection === 'exclude')
    return {
      label: 'Exclude all signal statistics',
      samples: [] as DecodedSample[],
    };
  if (selection.startsWith('range:')) {
    const range = ranges[Number(selection.slice(6))];
    if (range)
      return {
        label: range.label,
        samples: session.samples.slice(range.start - 1, range.end),
      };
  }
  return { label: 'All file', samples: session.samples };
}

function buildReport(
  session: TrackData,
  selection: string,
  ranges: Array<{ label: string; start: number; end: number }>,
) {
  const target = reportRangeText(session, selection, ranges);
  const samples = target.samples;
  const range = (
    stats: ReturnType<typeof reportStats>,
    unit: string,
    digits = 1,
  ) =>
    stats
      ? `${formatNumber(stats.min, digits)} to ${formatNumber(stats.max, digits)} ${unit} (avg ${formatNumber(stats.avg, digits)} ${unit})`
      : 'N/A';
  return [
    `${session.title}    Samples: ${samples.length.toLocaleString()} of ${session.sampleCount.toLocaleString()}    Rate: ${formatNumber(session.sampleRateHz, 1)} Hz`,
    `Report range: ${target.label}`,
    `Generated: ${formatDateTime()}`,
    '',
    `Bearing error: ${range(reportStats(samples, 'diffDeg'), 'Deg', 2)}`,
    `15 Hz modulation: ${range(reportStats(samples, 'mod15'), '%', 1)}`,
    `135 Hz modulation: ${range(reportStats(samples, 'mod135'), '%', 1)}`,
    `DME range: ${range(reportStats(samples, 'dmeRangeNm'), 'NM', 2)}`,
    `DME error (Excel): ${range(reportStats(samples, 'dmeErrM'), 'm', 0)}`,
    `DME efficiency: ${range(reportStats(samples, 'dmeEffPct'), '%', 1)}`,
    `DME PRF: ${range(reportStats(samples, 'dmePrfPps'), 'pps', 0)}`,
    `TACAN level: ${range(reportStats(samples, 'tacanDbm'), 'dBm', 1)}`,
    `GPS range: ${range(reportStats(samples, 'gpsRangeNm'), 'NM', 2)}`,
    `Altitude MSL (Excel preferred): ${range(reportStats(samples, 'altitudeFt'), 'ft', 0)}`,
    `Altitude AGL (Excel): ${range(reportStats(samples, 'altAglFt'), 'ft', 0)}`,
    '',
    `Excel: ${session.excelInfo.fileName}`,
    `Primary: ${session.fileName}`,
    `RAW: ${session.rawInfo ? `${session.rawInfo.fileName} (${session.rawInfo.recordLength} B/sample)` : 'Unavailable'}`,
    `NOTE events: ${session.note.pilotEvents.length} (${session.note.source})`,
    `Raw DME error mapping: ${session.rawDmeErrorMapping}`,
    'Analysis/review only. Not FMS, navigation, flight-check, or operational acceptance.',
  ].join('\n');
}

function formatDifference(value: number): string {
  return value >= 10 ? value.toFixed(1) : value.toFixed(2);
}

function SafetyNotice() {
  return (
    <div className="safety-notice" role="note">
      <ShieldCheck size={16} aria-hidden="true" />
      <span>
        Analysis and review tool only. This is not an FMS, navigation,
        flight-check acceptance, or operational tool.
      </span>
    </div>
  );
}

function LocalStatus() {
  return (
    <div className="local-status" data-testid="local-status">
      <span className="status-dot" aria-hidden="true" />
      <span>Local processing only</span>
    </div>
  );
}

function FileSlot({
  slot,
  file,
  onChange,
}: {
  slot: (typeof FILE_SLOTS)[number];
  file: File | null;
  onChange: (file: File | null) => void;
}) {
  const Icon = slot.icon;
  return (
    <div className={`file-slot ${slot.required ? 'required' : ''}`}>
      <div className="file-slot-head">
        <div className="file-slot-icon">
          <Icon size={16} aria-hidden="true" />
        </div>
        <div>
          <Label htmlFor={`file-${slot.key}`}>
            {slot.label}{' '}
            {slot.required ? (
              <span className="required-mark">Required</span>
            ) : (
              <span className="optional-mark">Optional</span>
            )}
          </Label>
          <p>{slot.description}</p>
        </div>
      </div>
      <div className="file-input-row">
        <Input
          id={`file-${slot.key}`}
          type="file"
          accept={slot.accept}
          onChange={(event) => onChange(event.target.files?.[0] ?? null)}
        />
      </div>
      <div className={`file-selected ${file ? 'has-file' : ''}`}>
        {file ? (
          <Check size={14} aria-hidden="true" />
        ) : (
          <CircleHelp size={14} aria-hidden="true" />
        )}
        <span title={file?.name}>{file?.name ?? 'No file selected'}</span>
        <small>{fileSize(file)}</small>
      </div>
    </div>
  );
}

function ValidationPanel({
  outcome,
  onOpenWithWarnings,
  canOpenWithWarnings,
}: {
  outcome: ValidationOutcome;
  onOpenWithWarnings: () => void;
  canOpenWithWarnings: boolean;
}) {
  const isError = outcome.status === 'error';
  const isWarning = outcome.status === 'warning';
  return (
    <Card
      className={`validation-panel ${isError ? 'error' : isWarning ? 'warning' : 'success'}`}
    >
      <CardHeader className="validation-head">
        <div className="validation-title">
          {isError ? (
            <XCircle size={19} />
          ) : isWarning ? (
            <AlertTriangle size={19} />
          ) : (
            <Check size={19} />
          )}
          <CardTitle>
            {isError
              ? 'Validation stopped'
              : isWarning
                ? 'Decoder fidelity notice'
                : 'Validation passed'}
          </CardTitle>
        </div>
        <Badge
          variant={
            isError ? 'destructive' : isWarning ? 'outline' : 'secondary'
          }
        >
          {isError ? 'Hard error' : isWarning ? 'Informational' : 'Ready'}
        </Badge>
      </CardHeader>
      <CardContent>
        {outcome.errors.length > 0 && (
          <div className="message-list" role="alert">
            {outcome.errors.map((error) => (
              <p key={error}>
                <XCircle size={14} />
                {error}
              </p>
            ))}
          </div>
        )}
        {outcome.warnings.length > 0 && (
          <div className="message-list warning-list">
            {outcome.warnings.map((warning) => (
              <p key={warning}>
                <AlertTriangle size={14} />
                {warning}
              </p>
            ))}
          </div>
        )}
        {outcome.status !== 'error' && (
          <>
            <div className="validation-meta">
              <span>
                <strong>{outcome.checkedSamples.toLocaleString()}</strong>{' '}
                samples checked
              </span>
              <span>
                <strong>{outcome.differences.length}</strong> field differences
              </span>
              <span>{outcome.toleranceVersion}</span>
            </div>
            {outcome.differences.length > 0 && (
              <div className="difference-table-wrap">
                <table className="difference-table">
                  <thead>
                    <tr>
                      <th>Field</th>
                      <th>Largest difference</th>
                      <th>Fixed tolerance</th>
                      <th>Sample</th>
                    </tr>
                  </thead>
                  <tbody>
                    {outcome.differences.map((difference) => (
                      <tr key={difference.field}>
                        <td>{difference.label}</td>
                        <td>{formatDifference(difference.maxDifference)}</td>
                        <td>{formatDifference(difference.tolerance)}</td>
                        <td>{difference.sample.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="validation-disclaimer">
              Checked fields: {outcome.checkedFields.join(', ')}. This is a
              lightweight TORB-versus-Excel comparison, not an all-sample
              equality claim. The chart PDF is not part of this comparison.
            </p>
            {canOpenWithWarnings && (
              <div className="validation-actions">
                <Button
                  onClick={onOpenWithWarnings}
                  data-testid="open-with-warnings"
                >
                  Open with notice
                </Button>
                <span>Open the viewer with these differences noted.</span>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function UploadSurface({
  files,
  onFileChange,
  onValidate,
  validation,
  busy,
  onOpenWithWarnings,
  canOpenWithWarnings,
}: {
  files: FileSet;
  onFileChange: (key: FileKey, file: File | null) => void;
  onValidate: () => void;
  validation: ValidationOutcome | null;
  busy: boolean;
  onOpenWithWarnings: () => void;
  canOpenWithWarnings: boolean;
}) {
  return (
    <main className="upload-surface">
      <section className="intro-grid">
        <div className="intro-copy">
          <div className="eyebrow">
            <Sparkles size={13} />
            Private local-file workspace
          </div>
          <h2>Inspect a TACAN track without moving the data.</h2>
          <p>
            Select the recording and its WinFIS export, then open a validated
            in-memory review session. Optional RAW, NOTE, and chart files stay
            on this device too.
          </p>
          <div className="intro-points">
            <span>
              <ShieldCheck size={15} />
              No upload or retention path
            </span>
            <span>
              <Gauge size={15} />
              Modern desktop Chromium
            </span>
            <span>
              <SlidersHorizontal size={15} />
              Fixed, visible tolerances
            </span>
          </div>
        </div>
        <div className="intro-art" aria-hidden="true">
          <div className="radar-ring ring-one" />
          <div className="radar-ring ring-two" />
          <div className="radar-ring ring-three" />
          <div className="radar-cross" />
          <div className="radar-sweep" />
          <span className="radar-label label-n">N</span>
          <span className="radar-label label-e">E</span>
          <span className="radar-label label-s">S</span>
          <span className="radar-label label-w">W</span>
          <span className="radar-center">
            <Crosshair size={21} />
          </span>
        </div>
      </section>
      <section className="upload-card" aria-labelledby="file-selection-title">
        <div className="section-heading">
          <div>
            <div className="eyebrow">
              <Upload size={13} />
              Manual file selection
            </div>
            <h3 id="file-selection-title">
              Choose the evidence for this session
            </h3>
          </div>
          <LocalStatus />
        </div>
        <div className="file-grid">
          {FILE_SLOTS.map((slot) => (
            <FileSlot
              key={slot.key}
              slot={slot}
              file={files[slot.key]}
              onChange={(file) => onFileChange(slot.key, file)}
            />
          ))}
        </div>
        <div className="upload-actions">
          <Button
            onClick={onValidate}
            disabled={busy}
            size="lg"
            data-testid="validate-open"
          >
            {busy ? 'Validating locally…' : 'Validate & Open'}
          </Button>
          <div className="upload-helper">
            <Info size={15} />
            Parsing begins only after this button is pressed. Refreshing the tab
            clears the in-memory session.
          </div>
        </div>
      </section>
      {validation && (
        <ValidationPanel
          outcome={validation}
          onOpenWithWarnings={onOpenWithWarnings}
          canOpenWithWarnings={canOpenWithWarnings}
        />
      )}
      <SafetyNotice />
    </main>
  );
}

function ControlCard({
  title,
  icon,
  children,
  className = '',
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={`control-card ${className}`}>
      <CardHeader className="control-card-head">
        <CardTitle>
          <span className="control-icon">{icon}</span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function ValueRow({
  label,
  value,
  source,
}: {
  label: string;
  value: string;
  source?: string;
}) {
  return (
    <div className="value-row">
      <dt>{label}</dt>
      <dd>
        <span>{value}</span>
        {source && <small>{source}</small>}
      </dd>
    </div>
  );
}

function ViewerSurface({
  session,
  selectedPdf,
  onBack,
}: {
  session: TrackData;
  selectedPdf: File | null;
  onBack: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<
    | {
        mode: 'camera';
        pointerId: number;
        x: number;
        y: number;
        yaw: number;
        pitch: number;
      }
    | { mode: 'station' | 'ring'; pointerId: number }
    | null
  >(null);
  const interactionFrameRef = useRef<number | null>(null);
  const queuedInteractionRef = useRef<(() => void) | null>(null);
  const [currentIndex, setCurrentIndex] = useState(() =>
    initialSampleIndex(session),
  );
  const [playing, setPlaying] = useState(false);
  const [speedIndex, setSpeedIndex] = useState(2);
  const [viewMode, setViewMode] = useState<ViewMode>('3d');
  const [camera, setCamera] = useState<Camera>({
    yaw: -32,
    pitch: 58,
    altScale: 10,
    zoom: 1,
  });
  const [reportSelection, setReportSelection] = useState('all');
  const [chartPreview, setChartPreview] = useState<PdfPreview | null>(null);
  const [chartStatus, setChartStatus] = useState(
    selectedPdf ? 'Rendering locally…' : 'No chart selected',
  );
  const [chartVisible, setChartVisible] = useState(true);
  const [chartOpacity, setChartOpacity] = useState(0.72);
  const [chartRotation, setChartRotation] = useState(0);
  const [activeCalibration, setActiveCalibration] =
    useState<Calibration | null>(null);
  const [calibrationEditing, setCalibrationEditing] = useState(false);
  const [pendingStation, setPendingStation] = useState<ChartPoint | null>(null);
  const [pendingRing, setPendingRing] = useState<ChartPoint | null>(null);
  const [ringDistanceDraft, setRingDistanceDraft] = useState('');
  const [calibrationStep, setCalibrationStep] = useState<CalibrationStep>(null);
  const [calibrationMessage, setCalibrationMessage] = useState(
    'Calibration is inactive.',
  );
  const [rawErrorOpen, setRawErrorOpen] = useState(false);

  const current = session.samples[currentIndex] ?? session.samples[0];
  const events = session.note.pilotEvents;
  const bounds = useMemo(() => trackBounds(session.samples), [session.samples]);
  const ranges = useMemo(
    () =>
      events.slice(0, -1).map((event, index) => ({
        label: `Pilot ${event.event} → ${events[index + 1].event}  (samples ${event.sample.toLocaleString()}–${events[index + 1].sample.toLocaleString()})`,
        start: event.sample,
        end: events[index + 1].sample,
      })),
    [events],
  );
  const report = useMemo(
    () => buildReport(session, reportSelection, ranges),
    [session, reportSelection, ranges],
  );
  const activeReportRange = useMemo<ReportHighlightRange>(() => {
    if (!reportSelection.startsWith('range:')) return null;
    return ranges[Number(reportSelection.slice(6))] ?? null;
  }, [ranges, reportSelection]);
  const ringDistanceNm = Number(ringDistanceDraft);
  const previewCalibration = useMemo<Calibration | null>(() => {
    if (
      !pendingStation ||
      !pendingRing ||
      !ringDistanceDraft.trim() ||
      !Number.isFinite(ringDistanceNm) ||
      ringDistanceNm <= 0
    )
      return null;
    const distancePx = Math.hypot(
      pendingRing.x - pendingStation.x,
      pendingRing.y - pendingStation.y,
    );
    if (distancePx < 3) return null;
    return {
      station: pendingStation,
      pxPerNm: distancePx / ringDistanceNm,
      reference: pendingRing,
      referenceDistanceNm: ringDistanceNm,
      rotationDeg: chartRotation,
    };
  }, [
    chartRotation,
    pendingRing,
    pendingStation,
    ringDistanceDraft,
    ringDistanceNm,
  ]);

  const scheduleInteraction = useCallback((update: () => void) => {
    queuedInteractionRef.current = update;
    if (interactionFrameRef.current !== null) return;
    interactionFrameRef.current = window.requestAnimationFrame(() => {
      interactionFrameRef.current = null;
      const queued = queuedInteractionRef.current;
      queuedInteractionRef.current = null;
      queued?.();
    });
  }, []);

  useEffect(
    () => () => {
      if (interactionFrameRef.current !== null)
        window.cancelAnimationFrame(interactionFrameRef.current);
    },
    [],
  );

  useEffect(() => {
    document.body.classList.add('viewer-mode');
    window.scrollTo(0, 0);
    return () => document.body.classList.remove('viewer-mode');
  }, []);

  useEffect(() => {
    if (!selectedPdf) return;
    let cancelled = false;
    void renderPdfPage(selectedPdf)
      .then(({ canvas, inspection }) => {
        if (cancelled) return;
        setChartPreview({
          canvas,
          groundCanvas: createChartGroundCanvas(canvas),
          fileName: inspection.fileName,
          fingerprint: inspection.fingerprint,
          width: inspection.width ?? canvas.width,
          height: inspection.height ?? canvas.height,
        });
        const saved = readStoredCalibration(inspection.fingerprint);
        setActiveCalibration(saved);
        setChartRotation(saved?.rotationDeg ?? 0);
        setCalibrationMessage(
          saved
            ? 'Loaded saved calibration for this PDF fingerprint.'
            : 'Calibration is inactive.',
        );
        setChartStatus(
          `Local PDF • 1 page • SHA-256 ${inspection.fingerprint.slice(0, 12)}…`,
        );
      })
      .catch((error) => {
        if (cancelled) return;
        setChartStatus(
          error instanceof Error
            ? error.message
            : 'Could not render this PDF locally.',
        );
        setChartPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPdf]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let frame = 0;
    const redraw = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() =>
        drawScene(
          canvas,
          session.samples,
          bounds,
          currentIndex,
          viewMode,
          camera,
          activeReportRange,
          {
            preview: chartPreview,
            active: activeCalibration,
            editing: calibrationEditing,
            pendingStation,
            pendingRing,
            activeHandle: calibrationStep,
            visible: chartVisible,
            opacity: chartOpacity,
            rotation: chartRotation,
          },
        ),
      );
    };
    redraw();
    const observer = new ResizeObserver(redraw);
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [
    activeCalibration,
    activeReportRange,
    bounds,
    calibrationEditing,
    calibrationStep,
    camera,
    chartOpacity,
    chartPreview,
    chartRotation,
    chartVisible,
    currentIndex,
    pendingRing,
    pendingStation,
    session.samples,
    viewMode,
  ]);

  useEffect(() => {
    if (!playing) return;
    const delay = Math.max(
      16,
      1000 / (session.sampleRateHz * PLAYBACK_SPEEDS[speedIndex]),
    );
    const timer = window.setInterval(
      () =>
        setCurrentIndex((index) => {
          if (index >= session.samples.length - 1) {
            setPlaying(false);
            return index;
          }
          return index + 1;
        }),
      delay,
    );
    return () => window.clearInterval(timer);
  }, [playing, session.sampleRateHz, session.samples.length, speedIndex]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleWheel = (event: WheelEvent) => {
      if (calibrationEditing) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.12 : 0.89;
      setCamera((value) => ({
        ...value,
        zoom: clamp(value.zoom * factor, 0.45, 5),
      }));
    };
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [calibrationEditing]);

  const chartPointFromPointer = useCallback(
    (
      canvas: HTMLCanvasElement,
      clientX: number,
      clientY: number,
    ): ChartPoint | null => {
      if (!chartPreview) return null;
      const rect = canvas.getBoundingClientRect();
      const fit = chartTransform(rect.width, rect.height, chartPreview);
      if (!fit) return null;
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      if (
        x < fit.offsetX ||
        x > fit.offsetX + fit.drawWidth ||
        y < fit.offsetY ||
        y > fit.offsetY + fit.drawHeight
      )
        return null;
      return {
        x: (x - fit.offsetX) / fit.scale,
        y: (y - fit.offsetY) / fit.scale,
      };
    },
    [chartPreview],
  );

  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (calibrationEditing && chartPreview && viewMode === '2d') {
      const point = chartPointFromPointer(
        event.currentTarget,
        event.clientX,
        event.clientY,
      );
      if (!point) {
        setCalibrationMessage(
          'Drag the markers inside the rendered chart page.',
        );
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      const fit = chartTransform(rect.width, rect.height, chartPreview);
      const stationDistance =
        pendingStation && fit
          ? Math.hypot(point.x - pendingStation.x, point.y - pendingStation.y) *
            fit.scale
          : Number.POSITIVE_INFINITY;
      const ringDistance =
        pendingRing && fit
          ? Math.hypot(point.x - pendingRing.x, point.y - pendingRing.y) *
            fit.scale
          : Number.POSITIVE_INFINITY;
      let mode: 'station' | 'ring' =
        stationDistance <= 24 || stationDistance <= ringDistance
          ? 'station'
          : 'ring';
      if (Math.min(stationDistance, ringDistance) > 24 && calibrationStep)
        mode = calibrationStep;
      if (mode === 'station') setPendingStation(point);
      else setPendingRing(point);
      setCalibrationStep(mode);
      dragRef.current = { mode, pointerId: event.pointerId };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (viewMode === '3d') {
      dragRef.current = {
        mode: 'camera',
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        yaw: camera.yaw,
        pitch: camera.pitch,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.mode === 'camera') {
      const yaw = clamp(drag.yaw + (event.clientX - drag.x) * 0.25, -180, 180);
      const pitch = clamp(drag.pitch - (event.clientY - drag.y) * 0.18, 15, 78);
      scheduleInteraction(() =>
        setCamera((value) => ({
          ...value,
          yaw: Math.round(yaw),
          pitch: Math.round(pitch),
        })),
      );
      return;
    }
    const point = chartPointFromPointer(
      event.currentTarget,
      event.clientX,
      event.clientY,
    );
    if (!point) return;
    scheduleInteraction(() => {
      if (drag.mode === 'station') setPendingStation(point);
      else setPendingRing(point);
    });
  };

  const finishCanvasDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.mode === 'station') setCalibrationStep('ring');
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const startCalibration = () => {
    if (!chartPreview) return;
    const station = activeCalibration?.station ?? {
      x: chartPreview.width / 2,
      y: chartPreview.height / 2,
    };
    const referenceDistance = activeCalibration?.referenceDistanceNm;
    const reference = activeCalibration?.reference ?? {
      x: clamp(
        station.x + Math.min(chartPreview.width, chartPreview.height) * 0.18,
        0,
        chartPreview.width,
      ),
      y: station.y,
    };
    setPlaying(false);
    setViewMode('2d');
    setPendingStation(station);
    setPendingRing(reference);
    setRingDistanceDraft(referenceDistance ? String(referenceDistance) : '');
    setCalibrationStep('station');
    setCalibrationEditing(true);
    setCalibrationMessage(
      'Drag the station and DME reference markers, then enter the exact known DME distance.',
    );
  };

  const cancelCalibration = () => {
    setCalibrationEditing(false);
    setPendingStation(null);
    setPendingRing(null);
    setCalibrationStep(null);
    setCalibrationMessage(
      activeCalibration
        ? 'Calibration edit cancelled; the confirmed calibration remains active.'
        : 'Calibration is inactive.',
    );
  };

  const resetCalibration = () => {
    setCalibrationEditing(false);
    setPendingStation(null);
    setPendingRing(null);
    setRingDistanceDraft('');
    setActiveCalibration(null);
    setCalibrationStep(null);
    setCalibrationMessage('Calibration reset for this session.');
  };

  const confirmCalibration = () => {
    if (!previewCalibration) return;
    setActiveCalibration(previewCalibration);
    setCalibrationEditing(false);
    setPendingStation(null);
    setPendingRing(null);
    setCalibrationStep(null);
    setCalibrationMessage(
      `Calibration confirmed at ${formatNumber(previewCalibration.pxPerNm, 2)} px/NM.`,
    );
  };

  const saveCalibration = () => {
    if (!chartPreview || !activeCalibration) return;
    const saved = saveStoredCalibration(chartPreview.fingerprint, {
      ...activeCalibration,
      rotationDeg: chartRotation,
    });
    setCalibrationMessage(
      saved
        ? 'Calibration saved locally to this PDF SHA-256 fingerprint.'
        : 'Browser storage is unavailable; calibration was not saved.',
    );
  };

  const nudgeCamera = (key: keyof Camera, amount: number) =>
    setCamera((value) => ({
      ...value,
      [key]: clamp(
        value[key] + amount,
        key === 'pitch'
          ? 15
          : key === 'altScale'
            ? 1
            : key === 'zoom'
              ? 0.45
              : -180,
        key === 'pitch'
          ? 78
          : key === 'altScale'
            ? 25
            : key === 'zoom'
              ? 5
              : 180,
      ),
    }));

  const setThreeDimensional = () => {
    setCalibrationEditing(false);
    setViewMode('3d');
    setCamera((value) => ({
      ...value,
      pitch: value.pitch < 20 ? 58 : value.pitch,
    }));
  };

  const selectReportRange = (selection: string) => {
    setReportSelection(selection);
    if (!selection.startsWith('range:')) return;
    const range = ranges[Number(selection.slice(6))];
    if (!range) return;
    setPlaying(false);
    setCurrentIndex(clamp(range.start - 1, 0, session.samples.length - 1));
  };

  return (
    <main className="viewer-surface">
      <section className="viewer-grid">
        <div className="map-column">
          <header className="viewer-header">
            <div className="viewer-title">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onBack}
                aria-label="Return to file selection"
                title="Return to file selection"
              >
                <ArrowLeft size={17} />
              </Button>
              <div>
                <div className="eyebrow">
                  <Satellite size={13} />
                  Validated local session
                </div>
                <h2>{session.title}</h2>
              </div>
              <Badge variant="secondary">{session.fileKind}</Badge>
            </div>
            <div className="viewer-statuses">
              <LocalStatus />
              <span className="desktop-hint">
                Drag 3D • Wheel zoom • Local files only
              </span>
            </div>
          </header>
          <section className="context-strip" aria-label="Track context">
            <div className="context-item active-file-context">
              <span className="eyebrow">Active file</span>
              <strong title={session.fileName}>{session.title}</strong>
              <small>{session.fileKind} • validated in memory</small>
            </div>
            <div className="context-item station-context">
              <span className="eyebrow">Station reference</span>
              <strong title={stationReference(session)}>
                {stationReference(session)}
              </strong>
              <small>Source metadata only • north-up 360°</small>
            </div>
            <div className="context-item radial-context">
              <span className="eyebrow">Live radial</span>
              <strong>{formatDegrees(current.gpsBearingDeg)}°</strong>
              <small>{formatNumber(current.gpsRangeNm, 1)} NM from origin</small>
            </div>
            <div className="context-item profile-context">
              <span className="eyebrow">Altitude profile</span>
              <strong>{viewMode.toUpperCase()}</strong>
              <small>{formatNumber(current.altitudeFt, 0)} ft MSL</small>
            </div>
          </section>
          <Card
            className={`map-card ${activeCalibration ? 'chart-calibrated-map-card' : ''}`}
          >
            <CardHeader className="map-card-head">
              <div>
                <div className="eyebrow">
                  <Crosshair size={13} />
                  Track surface
                </div>
                <CardTitle>
                  {calibrationEditing
                    ? 'Drag calibration markers'
                    : activeCalibration
                      ? 'Chart-calibrated track'
                      : 'TACAN-relative track'}
                </CardTitle>
              </div>
              <div className="map-head-metrics">
                <span>
                  <strong>{session.sampleCount.toLocaleString()}</strong>{' '}
                  samples
                </span>
                <span>
                  <strong>{formatNumber(session.sampleRateHz, 1)}</strong> Hz
                </span>
              </div>
            </CardHeader>
            <CardContent className="map-card-content">
              <div className="canvas-wrap">
                <canvas
                  ref={canvasRef}
                  className={`track-canvas ${calibrationEditing ? 'calibration-active' : ''}`}
                  aria-label="Aircraft track relative to TACAN station"
                  onPointerDown={onCanvasPointerDown}
                  onPointerMove={onCanvasPointerMove}
                  onPointerUp={finishCanvasDrag}
                  onPointerCancel={finishCanvasDrag}
                  data-testid="track-canvas"
                />
                {!chartPreview && selectedPdf && (
                  <div className="canvas-overlay-message">{chartStatus}</div>
                )}
              </div>
              <div className="map-legend">
                <span>
                  <i className="legend-line full-route" />
                  Full route
                </span>
                <span>
                  <i className="legend-line played-route" />
                  Played route
                </span>
                <span>
                  <i className="legend-dot current" />
                  Current sample
                </span>
                {activeReportRange && (
                  <span>
                    <i className="legend-line report-range" />
                    Selected report interval
                  </span>
                )}
                <span>
                  <i className="legend-station" />
                  TACAN origin
                </span>
                {chartVisible && chartPreview && (
                  <span>
                    <i className="legend-chart" />
                    {viewMode === '3d' && !activeCalibration
                      ? 'PDF ground preview · uncalibrated'
                      : viewMode === '3d'
                        ? 'PDF chart ground'
                        : 'PDF chart overlay'}
                  </span>
                )}
                <span className="map-legend-note">North-up reference: 0°</span>
              </div>
            </CardContent>
          </Card>
          <SafetyNotice />
        </div>
        <aside className="control-rail" aria-label="Viewer controls">
          <div className="rail-heading">
            <div>
              <span className="eyebrow">Mission control</span>
              <strong>TACAN check</strong>
            </div>
            <Badge variant="secondary">
              Sample {current.sample.toLocaleString()}
            </Badge>
          </div>
          <ControlCard
            title="Playback"
            icon={<Play size={15} />}
            className="playback-card"
          >
            <div className="sample-readout">
              <div>
                <span className="eyebrow">Current sample</span>
                <strong>{current.sample.toLocaleString()}</strong>
              </div>
              <Badge variant="outline">
                {formatDegrees(current.gpsBearingDeg)}° /{' '}"
                size="sm"
                onClick={() => setSpeedIndex((index) => Math.max(0, index - 1))}
              >
                Slower
              </Button>
              <strong>{PLAYBACK_SPEEDS[speedIndex]}×</strong>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setSpeedIndex((index) =>
                    Math.min(PLAYBACK_SPEEDS.length - 1, index + 1),
                  )
                }
              >
                Faster
              </Button>
            </div>
            <div className="event-status">
              Pilot events: {events.length} • Source: {session.note.source}
            </div>
          </ControlCard>
          <ControlCard
            title="View and camera"
            icon={<SlidersHorizontal size={15} />}
          >
            <fieldset className="segmented-control" aria-label="View mode">
              <Button
                variant={viewMode === '3d' ? 'default' : 'outline'}
                onClick={setThreeDimensional}
              >
                3D
              </Button>
              <Button
                variant={viewMode === '2d' ? 'default' : 'outline'}
                onClick={() => {
                  setCalibrationEditing(false);
                  setViewMode('2d');
                }}
              >
                2D
              </Button>
            </fieldset>
            <div className="camera-presets">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setCalibrationEditing(false);
                  setViewMode('2d');
                  setCamera((value) => ({ ...value, yaw: 0 }));
                }}
              >
                Top
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setCalibrationEditing(false);
                  setViewMode('3d');
                  setCamera((value) => ({ ...value, yaw: 0, pitch: 15 }));
                }}
              >
                Side
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCamera((value) => ({ ...value, yaw: 0 }))}
              >
                North up
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setViewMode('3d');
                  setCamera({ yaw: -32, pitch: 58, altScale: 10, zoom: 1 });
                }}
              >
                Reset
              </Button>
            </div>
            <label className="control-label">
              <span>
                View angle <strong>{camera.yaw}°</strong>
              </span>
              <input
                className="range-input"
                type="range"
                min={-180}
                max={180}
                value={camera.yaw}
                onChange={(event) =>
                  setCamera((value) => ({
                    ...value,
                    yaw: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label className="control-label">
              <span>
                Tilt <strong>{camera.pitch}°</strong>
              </span>
              <input
                className="range-input"
                type="range"
                min={15}
                max={78}
                value={camera.pitch}
                onChange={(event) =>
                  setCamera((value) => ({
                    ...value,
                    pitch: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label className="control-label">
              <span>
                Altitude scale <strong>{camera.altScale}×</strong>
              </span>
              <input
                className="range-input"
                type="range"
                min={1}
                max={25}
                value={camera.altScale}
                onChange={(event) =>
                  setCamera((value) => ({
                    ...value,
                    altScale: Number(event.target.value),
                  }))
                }
              />
            </label>
            <div className="zoom-buttons">
              <Button
                variant="outline"
                size="sm"
                onClick={() => nudgeCamera('zoom', -0.15)}
              >
                Zoom −
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => nudgeCamera('zoom', 0.15)}
              >
                Zoom +
              </Button>
            </div>
          </ControlCard>
          <ControlCard
            title="Chart overlay and calibration"
            icon={<Map size={15} />}
            className="chart-control-card"
          >
            <div className="chart-status-line">
              <span className="eyebrow">Chart status</span>
              <span className={chartPreview ? 'status-good' : 'status-muted'}>
                {chartStatus}
              </span>
            </div>
            {chartPreview ? (
              <>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={chartVisible}
                    onChange={(event) => setChartVisible(event.target.checked)}
                  />{' '}
                  <span>Show chart page</span>
                </label>
                <label className="control-label">
                  <span>
                    Chart opacity{' '}
                    <strong>{Math.round(chartOpacity * 100)}%</strong>
                  </span>
                  <input
                    className="range-input"
                    type="range"
                    min={0}
                    max={100}
                    value={chartOpacity * 100}
                    onChange={(event) =>
                      setChartOpacity(Number(event.target.value) / 100)
                    }
                    data-testid="chart-opacity"
                  />
                </label>
                <label className="control-label">
                  <span>
                    Rotation correction <strong>{chartRotation}°</strong>
                  </span>
                  <input
                    className="range-input"
                    type="range"
                    min={-180}
                    max={180}
                    value={chartRotation}
                    onChange={(event) =>
                      setChartRotation(Number(event.target.value))
                    }
                  />
                </label>
                <div className="calibration-guide">
                  <div className="guide-step">
                    <span>01</span>
                    <div>
                      <strong>Drag station marker</strong>
                      <small>
                        Place it at the exact centre of the TACAN symbol.
                      </small>
                    </div>
                  </div>
                  <div className="guide-step">
                    <span>02</span>
                    <div>
                      <strong>Drag DME reference</strong>
                      <small>
                        Place it on any point with a known DME distance.
                      </small>
                    </div>
                  </div>
                </div>
                <div className="button-row">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={startCalibration}
                    data-testid="start-calibration"
                  >
                    <Crosshair size={14} />
                    {activeCalibration
                      ? 'Edit calibration'
                      : 'Start calibration'}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={resetCalibration}>
                    <RotateCcw size={14} />
                    Reset
                  </Button>
                </div>
                <p className="calibration-message">{calibrationMessage}</p>
                {calibrationEditing && (
                  <div className="calibration-preview-box">
                    <div className="preview-line">
                      <span>Station point</span>
                      <strong>
                        {pendingStation
                          ? `${Math.round(pendingStation.x)}, ${Math.round(pendingStation.y)}`
                          : 'Drag marker'}
                      </strong>
                    </div>
                    <div className="preview-line">
                      <label htmlFor="known-dme">Known DME (NM)</label>
                      <Input
                        id="known-dme"
                        type="number"
                        min="0.01"
                        step="any"
                        inputMode="decimal"
                        value={ringDistanceDraft}
                        onChange={(event) =>
                          setRingDistanceDraft(event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') confirmCalibration();
                        }}
                        placeholder="Enter exact distance"
                        data-testid="known-dme"
                      />
                    </div>
                    <div className="preview-line">
                      <span>Scale preview</span>
                      <strong>
                        {previewCalibration
                          ? `${formatNumber(previewCalibration.pxPerNm, 3)} px/NM`
                          : 'Enter exact distance'}
                      </strong>
                    </div>
                    <div className="button-row">
                      <Button
                        size="sm"
                        onClick={confirmCalibration}
                        disabled={!previewCalibration}
                        data-testid="confirm-calibration"
                      >
                        <Check size={14} />
                        Confirm calibration
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={cancelCalibration}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
                {activeCalibration && (
                  <div className="saved-calibration-row">
                    <span>
                      <Check size={14} />
                      Active calibration
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={saveCalibration}
                      data-testid="save-calibration"
                    >
                      <Save size={14} />
                      Save locally
                    </Button>
                  </div>
                )}
                <p className="fingerprint-note">
                  Calibration storage key: PDF SHA-256{' '}
                  {chartPreview.fingerprint.slice(0, 16)}…
                </p>
              </>
            ) : (
              <p className="empty-control">
                <Info size={15} />
                No chart overlay is active. The TACAN-relative track remains
                available.
              </p>
            )}
          </ControlCard>
          <ControlCard title="Report" icon={<FileText size={15} />}>
            <label className="control-label">
              <span>Report range</span>
              <span className="select-wrap">
                <select
                  value={reportSelection}
                  onChange={(event) => selectReportRange(event.target.value)}
                  data-testid="report-range"
                >
                  <option value="all">All file</option>
                  <option value="exclude">Exclude signal stats</option>
                  {ranges.map((range, index) => (
                    <option key={range.label} value={`range:${index}`}>
                      {range.label}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} />
              </span>
            </label>
            <pre className="report-box">{report}</pre>
          </ControlCard>
          <ControlCard title="Live sample readout" icon={<Gauge size={15} />}>
            <dl className="readout-list">
              <ValueRow
                label="Radial"
                value={`${formatDegrees(current.gpsBearingDeg)}°`}
                source="Decoded / Excel GPS"
              />
              <ValueRow
                label="Bearing"
                value={`${formatNumber(current.brgDeg, 1)}°`}
                source="Excel preferred"
              />
              <ValueRow
                label="Position ref"
                value={`${formatNumber(current.refDeg, 2)}°`}
                source="Excel preferred"
              />
              <ValueRow
                label="Bearing error"
                value={`${formatNumber(current.diffDeg, 2)}°`}
                source="Excel preferred"
              />
              <ValueRow
                label="15 / 135 Hz"
                value={`${formatNumber(current.mod15, 1)}% / ${formatNumber(current.mod135, 1)}%`}
                source="Excel preferred"
              />
              <ValueRow
                label="DME range"
                value={`${formatNumber(current.dmeRangeNm, 2)} NM`}
                source="Excel preferred"
              />
              <ValueRow
                label="DME error"
                value={
                  current.dmeErrM === null
                    ? 'N/A'
                    : `${formatNumber(current.dmeErrM, 0)} m`
                }
                source="Excel"
              />
              <ValueRow
                label="Altitude"
                value={`${formatNumber(current.altitudeFt, 0)} ft MSL`}
                source="Excel preferred"
              />
              <ValueRow
                label="AGL"
                value={
                  current.altAglFt === null
                    ? 'Unavailable'
                    : `${formatNumber(current.altAglFt, 0)} ft`
                }
                source="Excel"
              />
              <ValueRow
                label="DME efficiency"
                value={`${formatNumber(current.dmeEffPct, 0)}%`}
                source="Excel preferred"
              />
              <ValueRow
                label="DME PRF"
                value={`${formatNumber(current.dmePrfPps, 0)} pps`}
                source="Excel preferred"
              />
              <ValueRow
                label="TACAN level"
                value={`${formatNumber(current.tacanDbm, 1)} dBm`}
                source="Excel preferred"
              />
              <ValueRow
                label="UTC"
                value={formatUtc(current.utc)}
                source="Excel"
              />
              <ValueRow
                label="Data valid"
                value={
                  current.dataValid === null
                    ? 'Unavailable'
                    : current.dataValid
                      ? 'Valid'
                      : 'Invalid'
                }
                source="Excel"
              />
            </dl>
            <button
              className="raw-detail-toggle"
              type="button"
              onClick={() => setRawErrorOpen((value) => !value)}
              aria-expanded={rawErrorOpen}
            >
              <span>
                <LockKeyhole size={14} />
                RAW diagnostic mapping
              </span>
              <ChevronDown
                size={14}
                className={rawErrorOpen ? 'rotate-180' : ''}
              />
            </button>
            {rawErrorOpen && (
              <div className="raw-detail">
                <strong>
                  {session.rawInfo
                    ? current.rawDmeErrM === null
                      ? 'Unavailable at this sample'
                      : `${current.rawDmeErrM} m`
                    : 'Unavailable without RAW companion'}
                </strong>
                <small>
                  DME error from RAW offset 170 is retained as an unvalidated
                  diagnostic mapping and is not used for acceptance.
                </small>
              </div>
            )}
          </ControlCard>
        </aside>
      </section>
    </main>
  );
}

export default function Home() {
  const [files, setFiles] = useState<FileSet>(EMPTY_FILES);
  const [validation, setValidation] = useState<ValidationOutcome | null>(null);
  const [prepared, setPrepared] = useState<PreparedSession | null>(null);
  const [session, setSession] = useState<TrackData | null>(null);
  const [busy, setBusy] = useState(false);
  const openPrepared = useCallback(
    (preparedSession: PreparedSession) =>
      setSession(
        buildTrack(
          preparedSession.primary,
          preparedSession.excel,
          preparedSession.note,
          preparedSession.raw,
        ),
      ),
    [],
  );
  const runValidation = useCallback(async () => {
    setBusy(true);
    setValidation(null);
    setPrepared(null);
    const result = await validateFileSet(files);
    setBusy(false);
    setValidation(result.outcome);
    setPrepared(result.prepared);
    if (result.outcome.status === 'ok' && result.prepared)
      openPrepared(result.prepared);
  }, [files, openPrepared]);
  const onFileChange = (key: FileKey, file: File | null) => {
    setFiles((current) => ({ ...current, [key]: file }));
    setValidation(null);
    setPrepared(null);
    setSession(null);
  };
  const backToSelection = () => {
    setSession(null);
    setValidation(null);
    setPrepared(null);
  };
  return (
    <div className={`app-shell ${session ? 'viewer-active' : ''}`}>
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark">
            <Satellite size={19} />
          </div>
          <div>
            <div className="brand-kicker">702 SQUADRON / PRIVATE SITE</div>
            <h1>TACAN Track Viewer</h1>
          </div>
        </div>
        <div className="header-right">
          <LocalStatus />
          <Badge variant="outline">Review build 1.0</Badge>
        </div>
      </header>
      {session ? (
        <ViewerSurface
          session={session}
          selectedPdf={files.pdf}
          onBack={backToSelection}
        />
      ) : (
        <UploadSurface
          files={files}
          onFileChange={onFileChange}
          onValidate={runValidation}
          validation={validation}
          busy={busy}
          onOpenWithWarnings={() => {
            if (prepared) openPrepared(prepared);
          }}
          canOpenWithWarnings={
            validation?.status === 'warning' && Boolean(prepared)
          }
        />
      )}
      <footer className="app-footer">
        <span>
          Local-file processing • No selected data is sent to a server
        </span>
        <span>WinFIS-derived review surface • Test and analysis use only</span>
      </footer>
    </div>
  );
}
