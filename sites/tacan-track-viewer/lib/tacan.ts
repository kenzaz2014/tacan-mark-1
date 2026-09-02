const PDF_WORKER_SRC = '/pdf.worker.min.mjs';
const MIB = 1024 * 1024;
const FILE_SIZE_LIMITS = {
  primary: 64 * MIB,
  excel: 32 * MIB,
  raw: 256 * MIB,
  note: 2 * MIB,
  pdf: 32 * MIB,
} as const;

export type TrackKind = 'TORB' | 'TRAD';

export type PilotEvent = {
  event: number;
  sample: number;
  dme: number | null;
  gps: number | null;
  sourceLine: string;
  source: 'NOTE' | 'recording header';
};

export type NoteMetadata = {
  fileName: string | null;
  recordId: string | null;
  description: string;
  trackingType: string | null;
  sensor: string | null;
  inspection: string | null;
  taskId: string | null;
  orbitStartedDegrees: number | null;
  pilotEvents: PilotEvent[];
  source: 'NOTE' | 'recording header' | 'none';
};

export type ExcelRow = {
  dataValid: boolean | null;
  bearingDeg: number | null;
  positionRefDeg: number | null;
  bearingErrorDeg: number | null;
  mod15Pct: number | null;
  mod135Pct: number | null;
  dmeRangeNm: number | null;
  dmeErrorM: number | null;
  dmeEffPct: number | null;
  dmePrfPps: number | null;
  tacanDbm: number | null;
  gpsBearingDeg: number | null;
  gpsRangeNm: number | null;
  altMslFt: number | null;
  altAglFt: number | null;
  utc: string | null;
};

export type ParsedPrimary = {
  fileName: string;
  fileKind: TrackKind;
  bytes: number;
  headerLen: number;
  arrayCount: number;
  sampleCount: number;
  sampleRateHz: number;
  headerWords: number[];
  headerPilotEvents: number[];
  embeddedText: string | null;
  arrays: number[][];
};

export type ParsedRaw = {
  fileName: string;
  bytes: number;
  recordLength: number;
  bytesData: ArrayBuffer;
};

export type ParsedExcel = {
  fileName: string;
  sheetName: string;
  rows: ExcelRow[];
  headers: string[];
};

export type DecodedSample = {
  sample: number;
  eastNm: number;
  northNm: number;
  gpsBearingDeg: number;
  gpsRangeNm: number;
  altitudeFt: number;
  rawAltitudeFt: number | null;
  brgDeg: number;
  refDeg: number;
  diffDeg: number;
  mod15: number;
  mod135: number;
  dmeRangeNm: number;
  dmeErrM: number | null;
  rawDmeErrM: number | null;
  dmeRslDbm: number;
  dmeEffPct: number;
  dmePrfPps: number;
  tacanDbm: number;
  altAglFt: number | null;
  utc: string | null;
  dataValid: boolean | null;
  gpsErrHM: number | null;
  gpsErrVM: number | null;
  gpsUncertaintyHPct: number | null;
  gpsUncertaintyVPct: number | null;
  source: {
    excel: boolean;
    raw: boolean;
  };
};

export type TrackData = {
  title: string;
  fileName: string;
  fileKind: TrackKind;
  sampleRateHz: number;
  sampleCount: number;
  embeddedText: string | null;
  samples: DecodedSample[];
  note: NoteMetadata;
  rawInfo: { fileName: string; bytes: number; recordLength: number } | null;
  excelInfo: { fileName: string; sheetName: string; headers: string[] };
  rawDmeErrorMapping: 'present but unvalidated' | 'unavailable';
};

export type ValidationDifference = {
  field: string;
  label: string;
  tolerance: number;
  maxDifference: number;
  count: number;
  sample: number;
  actual: number;
  expected: number;
};

export type ValidationOutcome = {
  status: 'ok' | 'warning' | 'error';
  errors: string[];
  warnings: string[];
  differences: ValidationDifference[];
  checkedSamples: number;
  checkedFields: string[];
  toleranceVersion: string;
};

export type PdfInspection = {
  fileName: string;
  pageCount: number;
  fingerprint: string;
  width: number | null;
  height: number | null;
};

export type PreparedSession = {
  primary: ParsedPrimary;
  raw: ParsedRaw | null;
  note: NoteMetadata;
  excel: ParsedExcel;
  pdf: PdfInspection | null;
  outcome: ValidationOutcome;
};

export const VALIDATION_TOLERANCE_VERSION = 'TACAN local validation 1.0';

export const VALIDATION_TOLERANCES = {
  bearingDeg: 0.6,
  positionRefDeg: 0.25,
  bearingErrorDeg: 0.6,
  modulationPct: 1.6,
  dmeRangeNm: 0.15,
  dmePrfPps: 12,
  dmeEfficiencyPct: 2,
  tacanDbm: 2,
  gpsBearingDeg: 0.25,
  gpsRangeNm: 0.15,
} as const;

type FileIdentity = {
  kind: 'TORB' | 'TRAD' | 'RAW' | 'NOTE' | 'UNKNOWN';
  number: string | null;
};

const TRACK_ARRAY_COUNTS: Record<TrackKind, number> = {
  TORB: 26,
  TRAD: 27,
};

const MOD_SCALE = 40.96;
const FT_PER_NM = 6076.12;

function normalizeText(value: unknown): string {
  return (textFrom(value) ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function numberFrom(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null || value === undefined) return null;
  const parsed = Number((textFrom(value) ?? '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function textFrom(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const candidate = value as { text?: unknown; result?: unknown; richText?: unknown };
    if (candidate.text !== undefined) return textFrom(candidate.text);
    if (candidate.result !== undefined) return textFrom(candidate.result);
    if (Array.isArray(candidate.richText)) {
      return candidate.richText.map((part) => textFrom((part as { text?: unknown }).text)).join('');
    }
  }
  return null;
}

function boolFrom(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const text = textFrom(value)?.toLowerCase();
  if (!text) return null;
  if (['1', 'true', 'yes', 'valid', 'ok'].includes(text)) return true;
  if (['0', 'false', 'no', 'invalid'].includes(text)) return false;
  return null;
}

function fileIdentity(fileName: string): FileIdentity {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? fileName;
  const match = base.toUpperCase().match(/\b(TORB|TRAD|RAW|NOTE)(\d{4})\b/);
  if (!match) return { kind: 'UNKNOWN', number: null };
  return { kind: match[1] as FileIdentity['kind'], number: match[2] };
}

export function identifyFile(file: File): FileIdentity {
  return fileIdentity(file.name);
}

function ensureMatchingIdentity(
  file: File | null,
  expectedKind: FileIdentity['kind'],
  expectedNumber: string,
  label: string,
  errors: string[],
) {
  if (!file) return;
  const identity = fileIdentity(file.name);
  if (identity.kind !== expectedKind || identity.number !== expectedNumber) {
    errors.push(
      `${label} must identify ${expectedKind}${expectedNumber}; selected ${file.name}.`,
    );
  }
}

function isPrintable(text: string): boolean {
  return Array.from(text).every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code === 9 || code === 10 || code === 13 || code >= 32;
  });
}

function findUtf16Tail(blob: ArrayBuffer, description: string): { offset: number; text: string | null } {
  const bytes = new Uint8Array(blob);
  const decoder = new TextDecoder('utf-16le');
  if (description) {
    const exact = new Uint8Array(description.length * 2);
    const exactView = new DataView(exact.buffer);
    Array.from(description).forEach((char, index) => exactView.setUint16(index * 2, char.charCodeAt(0), true));
    outer: for (let offset = 0; offset + exact.length <= bytes.length; offset += 1) {
      for (let index = 0; index < exact.length; index += 1) {
        if (bytes[offset + index] !== exact[index]) continue outer;
      }
      return { offset: Math.max(0, offset - 2), text: description };
    }
  }
  const start = Math.max(0, bytes.length - 512);
  for (let lengthOffset = bytes.length - 2; lengthOffset >= start; lengthOffset -= 2) {
    if (lengthOffset + 2 > bytes.length) continue;
    const length = new DataView(blob).getUint16(lengthOffset, true);
    const end = lengthOffset + 2 + length * 2;
    if (length < 1 || length > 120 || end > bytes.length) continue;
    const text = decoder.decode(bytes.slice(lengthOffset + 2, end));
    if (isPrintable(text)) return { offset: lengthOffset, text };
  }
  return { offset: bytes.length, text: null };
}

function parseNoteText(text: string, fileName: string | null): NoteMetadata {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((line) => line.trimEnd());
  const pilotEvents: PilotEvent[] = [];
  for (const line of lines) {
    const match = line.match(/^Pilot Event (\d+) at Sample (\d+) DME: ([^ ]+) GPS: ([0-9.]+)/);
    if (match) {
      pilotEvents.push({
        event: Number(match[1]),
        sample: Number(match[2]),
        dme: match[3] === '----' ? null : numberFrom(match[3]),
        gps: numberFrom(match[4]),
        sourceLine: line,
        source: 'NOTE',
      });
    }
  }
  const lineValue = (prefix: string) => lines.find((line) => line.startsWith(prefix))?.slice(prefix.length).trim() || null;
  const orbit = lineValue('Orbit started at')?.match(/([0-9.]+) Degrees/);
  return {
    fileName,
    recordId: lines[0] || null,
    description: lines[1]?.trim() || '',
    trackingType: lines[2]?.trim() || null,
    sensor: lineValue('TACAN sensor is '),
    inspection: lineValue('Inspection of '),
    taskId: lineValue('Task ID:'),
    orbitStartedDegrees: orbit ? numberFrom(orbit[1]) : null,
    pilotEvents,
    source: fileName ? 'NOTE' : 'none',
  };
}

function headerPilotEvents(header: number[], sampleCount: number): PilotEvent[] {
  const eventCount = Math.max(0, Math.min(header[17] ?? 0, 12));
  return Array.from({ length: eventCount }, (_, index) => header[18 + index] ?? 0)
    .filter((sample) => sample >= 1 && sample <= sampleCount)
    .map((sample, index) => ({
      event: index + 1,
      sample,
      dme: null,
      gps: null,
      sourceLine: 'TORB/TRAD binary recording header',
      source: 'recording header' as const,
    }));
}

export async function parseNote(file: File | null): Promise<NoteMetadata> {
  if (!file) return parseNoteText('', null);
  return parseNoteText(await file.text(), file.name);
}

export async function parsePrimary(file: File, note: NoteMetadata): Promise<ParsedPrimary> {
  const identity = fileIdentity(file.name);
  if (identity.kind !== 'TORB' && identity.kind !== 'TRAD') {
    throw new Error(`Primary recording ${file.name} must identify TORB or TRAD in its file name.`);
  }
  const blob = await file.arrayBuffer();
  if (blob.byteLength < 38) throw new Error(`${file.name} is too small to contain a WinFIS recording header.`);
  const view = new DataView(blob);
  const baseHeaderWords = Array.from({ length: 19 }, (_, index) =>
    view.getUint16(index * 2, true),
  );
  const sampleCount = baseHeaderWords[12];
  const sampleRateHz = 10;
  const expectedArrayCount = TRACK_ARRAY_COUNTS[identity.kind];
  if (!sampleCount || sampleCount > 500_000) {
    throw new Error(`${file.name} has an invalid sample count in its header: ${sampleCount || 'zero'}.`);
  }
  const tail = findUtf16Tail(blob, note.description);
  const headerLen = tail.offset - sampleCount * expectedArrayCount * 2;
  if (headerLen < 0 || headerLen > 256 || tail.offset > blob.byteLength) {
    throw new Error(`Could not validate the ${identity.kind} structure of ${file.name}.`);
  }
  const availableBytes = tail.offset - headerLen;
  if (availableBytes !== sampleCount * expectedArrayCount * 2) {
    throw new Error(`${file.name} does not contain the expected ${expectedArrayCount} channel arrays.`);
  }
  const headerWords = Array.from(
    { length: Math.max(19, Math.floor(headerLen / 2)) },
    (_, index) => view.getUint16(index * 2, true),
  );
  const arrays = Array.from({ length: expectedArrayCount }, (_, channel) =>
    Array.from({ length: sampleCount }, (_, index) =>
      view.getInt16(headerLen + (channel * sampleCount + index) * 2, true),
    ),
  );
  return {
    fileName: file.name,
    fileKind: identity.kind,
    bytes: blob.byteLength,
    headerLen,
    arrayCount: expectedArrayCount,
    sampleCount,
    sampleRateHz,
    headerWords,
    headerPilotEvents: headerPilotEvents(headerWords, sampleCount).map((event) => event.sample),
    embeddedText: tail.text,
    arrays,
  };
}

export async function parseRaw(file: File | null, sampleCount: number): Promise<ParsedRaw | null> {
  if (!file) return null;
  const bytesData = await file.arrayBuffer();
  if (!bytesData.byteLength || bytesData.byteLength % sampleCount !== 0) {
    throw new Error(`RAW file ${file.name} is not divisible into ${sampleCount} per-sample records.`);
  }
  const recordLength = bytesData.byteLength / sampleCount;
  if (recordLength < 172) {
    throw new Error(`RAW file ${file.name} has an unsupported record length of ${recordLength} bytes.`);
  }
  return { fileName: file.name, bytes: bytesData.byteLength, recordLength, bytesData };
}

function cellValue(value: unknown): unknown {
  if (value && typeof value === 'object') {
    const candidate = value as { result?: unknown; text?: unknown; richText?: unknown };
    if (candidate.result !== undefined) return cellValue(candidate.result);
    if (candidate.text !== undefined) return candidate.text;
    if (Array.isArray(candidate.richText)) return textFrom(candidate);
  }
  return value;
}

function headerField(header: string): keyof ExcelRow | null {
  const key = normalizeText(header);
  const aliases: Record<string, keyof ExcelRow> = {
    datavalid: 'dataValid',
    bearingdeg: 'bearingDeg',
    positionrefdeg: 'positionRefDeg',
    bearingerrordeg: 'bearingErrorDeg',
    '15hzmod': 'mod15Pct',
    '15hzmod%': 'mod15Pct',
    '135hzmod': 'mod135Pct',
    '135hzmod%': 'mod135Pct',
    dmenm: 'dmeRangeNm',
    dmeerrorm: 'dmeErrorM',
    dmeeff: 'dmeEffPct',
    dmeeffpercent: 'dmeEffPct',
    dmeprfpps: 'dmePrfPps',
    tacandbm: 'tacanDbm',
    gpsbearingdeg: 'gpsBearingDeg',
    gpsrangenm: 'gpsRangeNm',
    altmsl: 'altMslFt',
    altagl: 'altAglFt',
    utc: 'utc',
  };
  return aliases[key] ?? null;
}

export async function parseExcel(file: File): Promise<ParsedExcel> {
  const excelModule = await import('exceljs');
  const ExcelJS = excelModule.default ?? excelModule;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await file.arrayBuffer()) as never);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error(`${file.name} does not contain a readable worksheet.`);
  const headers = Array.from({ length: worksheet.columnCount }, (_, index) =>
    textFrom(worksheet.getRow(1).getCell(index + 1).value) ?? '',
  );
  const mapped = headers.map(headerField);
  const requiredFields: Array<keyof ExcelRow> = ['bearingDeg', 'positionRefDeg', 'gpsBearingDeg', 'gpsRangeNm'];
  if (requiredFields.some((field) => !mapped.includes(field))) {
    throw new Error(`${file.name} is missing the expected WinFIS export columns.`);
  }
  const rows: ExcelRow[] = [];
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const values = mapped.map((field, index) => (field ? cellValue(row.getCell(index + 1).value) : null));
    if (values.every((value) => value === null || value === undefined || value === '')) continue;
    const valueFor = (field: keyof ExcelRow) => {
      const index = mapped.indexOf(field);
      return index >= 0 ? values[index] : null;
    };
    rows.push({
      dataValid: boolFrom(valueFor('dataValid')),
      bearingDeg: numberFrom(valueFor('bearingDeg')),
      positionRefDeg: numberFrom(valueFor('positionRefDeg')),
      bearingErrorDeg: numberFrom(valueFor('bearingErrorDeg')),
      mod15Pct: numberFrom(valueFor('mod15Pct')),
      mod135Pct: numberFrom(valueFor('mod135Pct')),
      dmeRangeNm: numberFrom(valueFor('dmeRangeNm')),
      dmeErrorM: numberFrom(valueFor('dmeErrorM')),
      dmeEffPct: numberFrom(valueFor('dmeEffPct')),
      dmePrfPps: numberFrom(valueFor('dmePrfPps')),
      tacanDbm: numberFrom(valueFor('tacanDbm')),
      gpsBearingDeg: numberFrom(valueFor('gpsBearingDeg')),
      gpsRangeNm: numberFrom(valueFor('gpsRangeNm')),
      altMslFt: numberFrom(valueFor('altMslFt')),
      altAglFt: numberFrom(valueFor('altAglFt')),
      utc: textFrom(valueFor('utc')),
    });
  }
  if (!rows.length) throw new Error(`${file.name} does not contain data rows after its header.`);
  return { fileName: file.name, sheetName: worksheet.name, rows, headers };
}

function unsignedAngle(rawValue: number, scale: number): number {
  return (((rawValue & 0xffff) / scale) % 360 + 360) % 360;
}

function normalizeDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

function angleDifference(a: number, b: number): number {
  return ((a - b + 180) % 360 + 360) % 360 - 180;
}

function delayedAngle(values: number[], index: number, delaySamples: number, scale: number): number {
  const position = index - delaySamples;
  if (position < 0 || position >= values.length - 1) return unsignedAngle(values[index], scale);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerAngle = unsignedAngle(values[lower], scale);
  if (lower === upper) return lowerAngle;
  const upperAngle = unsignedAngle(values[upper], scale);
  return normalizeDegrees(lowerAngle + angleDifference(upperAngle, lowerAngle) * (position - lower));
}

function rawInt16(raw: ParsedRaw | null, sample: number, offset: number): number | null {
  if (!raw || raw.recordLength < offset + 2) return null;
  const view = new DataView(raw.bytesData);
  return view.getInt16((sample - 1) * raw.recordLength + offset, true);
}

function rawSample(primary: ParsedPrimary, sample: number, raw: ParsedRaw | null) {
  const index = sample - 1;
  const a = primary.arrays;
  const isTrad = primary.fileKind === 'TRAD';
  const brgDeg = delayedAngle(a[0], index, 1.5 * primary.sampleRateHz, 10);
  const refDeg = delayedAngle(a[3], index, 1.25 * primary.sampleRateHz, 100);
  const dmeRangeNm = isTrad ? a[12][index] / 100 : a[13][index] / 100;
  const dmePrfPps = isTrad ? a[13][index] : a[14][index];
  const dmeRslDbm = isTrad ? -a[14][index] / 10 : -a[15][index] / 10;
  const dmeEffPct = isTrad ? a[15][index] : a[16][index];
  const gpsBearingDeg = unsignedAngle(isTrad ? a[16][index] : a[18][index], 100);
  const gpsRangeNm = (isTrad ? a[17][index] : a[19][index]) / 10;
  const gpsRadians = (gpsBearingDeg * Math.PI) / 180;
  const rawAltitudeFt = isTrad ? a[22][index] : a[23][index];
  const elAngle = (isTrad ? a[26][index] : a[24][index]) / 10;
  const rawDmeErrorQ64 = rawInt16(raw, sample, 170);
  return {
    brgDeg,
    refDeg,
    diffDeg: angleDifference(brgDeg, refDeg),
    mod15: a[1][index] / MOD_SCALE,
    mod135: a[2][index] / MOD_SCALE,
    dmeRangeNm,
    dmePrfPps,
    dmeRslDbm,
    dmeEffPct,
    gpsBearingDeg,
    gpsRangeNm,
    eastNm: gpsRangeNm * Math.sin(gpsRadians),
    northNm: gpsRangeNm * Math.cos(gpsRadians),
    rawAltitudeFt,
    gpsErrHM: (isTrad ? a[18][index] : a[20][index]) / 100,
    gpsErrVM: (isTrad ? a[19][index] : a[21][index]) / 100,
    gpsUncertaintyHPct: elAngle,
    gpsUncertaintyVPct: a[25]?.[index] === undefined ? null : a[25][index] / 10,
    rawDmeErrM: rawDmeErrorQ64 === null ? null : Math.round(rawDmeErrorQ64 / 64),
  };
}

export function buildTrack(
  primary: ParsedPrimary,
  excel: ParsedExcel,
  note: NoteMetadata,
  raw: ParsedRaw | null,
): TrackData {
  const events = note.pilotEvents.length
    ? note.pilotEvents
    : headerPilotEvents(primary.headerWords, primary.sampleCount);
  const resolvedNote: NoteMetadata = {
    ...note,
    pilotEvents: events,
    source: note.pilotEvents.length ? note.source : 'recording header',
  };
  const samples = Array.from({ length: primary.sampleCount }, (_, index) => {
    const sampleNumber = index + 1;
    const decoded = rawSample(primary, sampleNumber, raw);
    const row = excel.rows[index];
    const pick = (excelValue: number | null | undefined, decodedValue: number) =>
      excelValue === null || excelValue === undefined || Number.isNaN(excelValue) ? decodedValue : excelValue;
    const gpsBearingDeg = pick(row.gpsBearingDeg, decoded.gpsBearingDeg);
    const gpsRangeNm = pick(row.gpsRangeNm, decoded.gpsRangeNm);
    const gpsRadians = (gpsBearingDeg * Math.PI) / 180;
    return {
      sample: sampleNumber,
      eastNm: gpsRangeNm * Math.sin(gpsRadians),
      northNm: gpsRangeNm * Math.cos(gpsRadians),
      gpsBearingDeg,
      gpsRangeNm,
      altitudeFt: pick(row?.altMslFt, decoded.rawAltitudeFt),
      rawAltitudeFt: decoded.rawAltitudeFt,
      brgDeg: pick(row?.bearingDeg, decoded.brgDeg),
      refDeg: pick(row?.positionRefDeg, decoded.refDeg),
      diffDeg: pick(row?.bearingErrorDeg, decoded.diffDeg),
      mod15: pick(row?.mod15Pct, decoded.mod15),
      mod135: pick(row?.mod135Pct, decoded.mod135),
      dmeRangeNm: pick(row?.dmeRangeNm, decoded.dmeRangeNm),
      dmeErrM: row?.dmeErrorM ?? null,
      rawDmeErrM: decoded.rawDmeErrM,
      dmeRslDbm: pick(row?.tacanDbm, decoded.dmeRslDbm),
      dmeEffPct: pick(row?.dmeEffPct, decoded.dmeEffPct),
      dmePrfPps: pick(row?.dmePrfPps, decoded.dmePrfPps),
      tacanDbm: pick(row?.tacanDbm, decoded.dmeRslDbm),
      altAglFt: row?.altAglFt ?? null,
      utc: row?.utc ?? null,
      dataValid: row?.dataValid ?? null,
      gpsErrHM: decoded.gpsErrHM,
      gpsErrVM: decoded.gpsErrVM,
      gpsUncertaintyHPct: decoded.gpsUncertaintyHPct,
      gpsUncertaintyVPct: decoded.gpsUncertaintyVPct,
      source: { excel: Boolean(row), raw: true },
    } satisfies DecodedSample;
  });
  return {
    title: primary.fileName.replace(/\.[^.]+$/, ''),
    fileName: primary.fileName,
    fileKind: primary.fileKind,
    sampleRateHz: primary.sampleRateHz,
    sampleCount: primary.sampleCount,
    embeddedText: primary.embeddedText,
    samples,
    note: resolvedNote,
    rawInfo: raw ? { fileName: raw.fileName, bytes: raw.bytes, recordLength: raw.recordLength } : null,
    excelInfo: { fileName: excel.fileName, sheetName: excel.sheetName, headers: excel.headers },
    rawDmeErrorMapping: raw ? 'present but unvalidated' : 'unavailable',
  };
}

function compareValue(
  actual: number | null | undefined,
  expected: number | null | undefined,
  tolerance: number,
  angular = false,
): number | null {
  if (actual === null || actual === undefined || expected === null || expected === undefined) return null;
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return null;
  const difference = angular ? Math.abs(angleDifference(actual, expected)) : Math.abs(actual - expected);
  return difference > tolerance ? difference : null;
}

export function comparePrimaryWithExcel(primary: ParsedPrimary, excel: ParsedExcel, note: NoteMetadata): ValidationOutcome {
  const errors: string[] = [];
  if (primary.sampleCount !== excel.rows.length) {
    errors.push(`Sample count mismatch: ${primary.fileName} has ${primary.sampleCount.toLocaleString()} samples, while ${excel.fileName} has ${excel.rows.length.toLocaleString()} data rows.`);
  }
  const maxRows = Math.min(primary.sampleCount, excel.rows.length);
  const sampleTarget = Math.max(10, Math.ceil(maxRows * 0.1));
  const sampleIndexes = new Set<number>();
  for (let index = 0; index < sampleTarget; index += 1) {
    sampleIndexes.add(Math.floor((index * Math.max(0, maxRows - 1)) / Math.max(1, sampleTarget - 1)));
  }
  sampleIndexes.add(0);
  sampleIndexes.add(Math.max(0, maxRows - 1));
  const events = note.pilotEvents.length ? note.pilotEvents : headerPilotEvents(primary.headerWords, primary.sampleCount);
  for (const event of events) {
    if (event.sample <= maxRows) sampleIndexes.add(event.sample - 1);
  }
  const differenceMap = new Map<string, ValidationDifference>();
  const fields = [
    { key: 'bearingDeg', label: 'Bearing', tolerance: VALIDATION_TOLERANCES.bearingDeg, raw: (decoded: ReturnType<typeof rawSample>) => decoded.brgDeg, excel: (row: ExcelRow) => row.bearingDeg, angular: true },
    { key: 'positionRefDeg', label: 'Position reference', tolerance: VALIDATION_TOLERANCES.positionRefDeg, raw: (decoded: ReturnType<typeof rawSample>) => decoded.refDeg, excel: (row: ExcelRow) => row.positionRefDeg, angular: true },
    { key: 'bearingErrorDeg', label: 'Bearing error', tolerance: VALIDATION_TOLERANCES.bearingErrorDeg, raw: (decoded: ReturnType<typeof rawSample>) => decoded.diffDeg, excel: (row: ExcelRow) => row.bearingErrorDeg, angular: false },
    { key: 'modulationPct', label: '15 Hz modulation', tolerance: VALIDATION_TOLERANCES.modulationPct, raw: (decoded: ReturnType<typeof rawSample>) => decoded.mod15, excel: (row: ExcelRow) => row.mod15Pct, angular: false },
    { key: 'dmeRangeNm', label: 'DME range', tolerance: VALIDATION_TOLERANCES.dmeRangeNm, raw: (decoded: ReturnType<typeof rawSample>) => decoded.dmeRangeNm, excel: (row: ExcelRow) => row.dmeRangeNm, angular: false },
    { key: 'dmePrfPps', label: 'DME PRF', tolerance: VALIDATION_TOLERANCES.dmePrfPps, raw: (decoded: ReturnType<typeof rawSample>) => decoded.dmePrfPps, excel: (row: ExcelRow) => row.dmePrfPps, angular: false },
    { key: 'dmeEfficiencyPct', label: 'DME efficiency', tolerance: VALIDATION_TOLERANCES.dmeEfficiencyPct, raw: (decoded: ReturnType<typeof rawSample>) => decoded.dmeEffPct, excel: (row: ExcelRow) => row.dmeEffPct, angular: false },
    { key: 'tacanDbm', label: 'TACAN dBm', tolerance: VALIDATION_TOLERANCES.tacanDbm, raw: (decoded: ReturnType<typeof rawSample>) => decoded.dmeRslDbm, excel: (row: ExcelRow) => row.tacanDbm, angular: false },
    { key: 'gpsBearingDeg', label: 'GPS bearing', tolerance: VALIDATION_TOLERANCES.gpsBearingDeg, raw: (decoded: ReturnType<typeof rawSample>) => decoded.gpsBearingDeg, excel: (row: ExcelRow) => row.gpsBearingDeg, angular: true },
    { key: 'gpsRangeNm', label: 'GPS range', tolerance: VALIDATION_TOLERANCES.gpsRangeNm, raw: (decoded: ReturnType<typeof rawSample>) => decoded.gpsRangeNm, excel: (row: ExcelRow) => row.gpsRangeNm, angular: false },
  ];
  sampleIndexes.forEach((index) => {
    if (index < 0 || index >= maxRows) return;
    const raw = rawSample(primary, index + 1, null);
    const row = excel.rows[index];
    fields.forEach((field) => {
      const actual = field.raw(raw);
      const expected = field.excel(row);
      const difference = compareValue(actual, expected, field.tolerance, field.angular);
      if (difference === null || expected === null || expected === undefined || actual === null || actual === undefined) return;
      const existing = differenceMap.get(field.key);
      if (!existing || difference > existing.maxDifference) {
        differenceMap.set(field.key, {
          field: field.key,
          label: field.label,
          tolerance: field.tolerance,
          maxDifference: difference,
          count: (existing?.count ?? 0) + 1,
          sample: index + 1,
          actual,
          expected,
        });
      } else if (existing) {
        existing.count += 1;
      }
    });
  });
  const differences = [...differenceMap.values()].sort((a, b) => b.maxDifference - a.maxDifference);
  const warnings = differences.length
    ? [`${differences.length} sampled TORB field${differences.length === 1 ? '' : 's'} differ from the WinFIS Excel export.`]
    : [];
  return {
    status: errors.length ? 'error' : differences.length ? 'warning' : 'ok',
    errors,
    warnings,
    differences,
    checkedSamples: sampleIndexes.size,
    checkedFields: fields.map((field) => field.label),
    toleranceVersion: VALIDATION_TOLERANCE_VERSION,
  };
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

async function inspectPdf(file: File): Promise<PdfInspection> {
  const buffer = await file.arrayBuffer();
  const fingerprint = await sha256Hex(buffer);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    verbosity: 0,
    stopAtErrors: true,
    useWorkerFetch: false,
    useSystemFonts: false,
    maxImageSize: 20_000_000,
    enableXfa: false,
  });
  const document = await loadingTask.promise;
  const pageCount = document.numPages;
  let width: number | null = null;
  let height: number | null = null;
  if (document.numPages === 1) {
    const page = await document.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    width = viewport.width;
    height = viewport.height;
  }
  await loadingTask.destroy();
  return { fileName: file.name, pageCount, fingerprint, width, height };
}

export async function validateFileSet(files: {
  primary: File | null;
  excel: File | null;
  raw: File | null;
  note: File | null;
  pdf: File | null;
}): Promise<{ outcome: ValidationOutcome; prepared: PreparedSession | null }> {
  const errors: string[] = [];
  const limitedFiles = [
    ['primary recording', files.primary, FILE_SIZE_LIMITS.primary],
    ['Excel export', files.excel, FILE_SIZE_LIMITS.excel],
    ['RAW companion', files.raw, FILE_SIZE_LIMITS.raw],
    ['NOTE file', files.note, FILE_SIZE_LIMITS.note],
    ['chart PDF', files.pdf, FILE_SIZE_LIMITS.pdf],
  ] as const;
  limitedFiles.forEach(([label, file, limit]) => {
    if (file && file.size > limit) {
      errors.push(
        `${label} ${file.name} exceeds the ${(limit / MIB).toFixed(0)} MB local safety limit.`,
      );
    }
  });
  if (!files.primary) errors.push('Select exactly one TORB or TRAD primary recording.');
  if (!files.excel) errors.push('Select the matching WinFIS Excel export.');
  if (files.primary && files.excel) {
    const primaryIdentity = fileIdentity(files.primary.name);
    const excelIdentity = fileIdentity(files.excel.name);
    if (primaryIdentity.kind !== 'TORB' && primaryIdentity.kind !== 'TRAD') {
      errors.push(`Primary recording ${files.primary.name} must identify TORB or TRAD in its file name.`);
    }
    if (primaryIdentity.number && excelIdentity.number && primaryIdentity.number !== excelIdentity.number) {
      errors.push(`Primary recording ${files.primary.name} and Excel export ${files.excel.name} have different recording numbers.`);
    }
    if (excelIdentity.kind !== 'UNKNOWN' && excelIdentity.kind !== primaryIdentity.kind) {
      errors.push(`Excel export ${files.excel.name} does not match the primary ${primaryIdentity.kind} recording.`);
    }
    if (!excelIdentity.number) {
      errors.push(`Excel export ${files.excel.name} must retain a TORB/TRAD recording number for matching.`);
    }
    if (files.raw) ensureMatchingIdentity(files.raw, 'RAW', primaryIdentity.number ?? '', 'RAW companion', errors);
    if (files.note) ensureMatchingIdentity(files.note, 'NOTE', primaryIdentity.number ?? '', 'NOTE file', errors);
  }
  if (errors.length) {
    const outcome: ValidationOutcome = {
      status: 'error',
      errors,
      warnings: [],
      differences: [],
      checkedSamples: 0,
      checkedFields: [],
      toleranceVersion: VALIDATION_TOLERANCE_VERSION,
    };
    return { outcome, prepared: null };
  }
  try {
    const note = await parseNote(files.note);
    const primary = await parsePrimary(files.primary as File, note);
    const raw = await parseRaw(files.raw, primary.sampleCount);
    const excel = await parseExcel(files.excel as File);
    const outcome = comparePrimaryWithExcel(primary, excel, note);
    const pdf = files.pdf ? await inspectPdf(files.pdf) : null;
    if (pdf && pdf.pageCount !== 1) {
      outcome.status = 'error';
      outcome.errors.push(`Chart PDF ${pdf.fileName} has ${pdf.pageCount} pages; exactly one page is required.`);
    }
    return {
      outcome,
      prepared: { primary, raw, note, excel, pdf, outcome },
    };
  } catch (error) {
    const outcome: ValidationOutcome = {
      status: 'error',
      errors: [error instanceof Error ? error.message : 'Could not validate the selected files.'],
      warnings: [],
      differences: [],
      checkedSamples: 0,
      checkedFields: [],
      toleranceVersion: VALIDATION_TOLERANCE_VERSION,
    };
    return { outcome, prepared: null };
  }
}

export async function renderPdfPage(file: File): Promise<{ canvas: HTMLCanvasElement; inspection: PdfInspection }> {
  const buffer = await file.arrayBuffer();
  const fingerprint = await sha256Hex(buffer);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    verbosity: 0,
    stopAtErrors: true,
    useWorkerFetch: false,
    useSystemFonts: false,
    maxImageSize: 20_000_000,
    enableXfa: false,
  });
  const document = await loadingTask.promise;
  if (document.numPages !== 1) {
    await loadingTask.destroy();
    throw new Error(`Chart PDF ${file.name} has ${document.numPages} pages; exactly one page is required.`);
  }
  const page = await document.getPage(1);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(2.2, 1800 / Math.max(baseViewport.width, baseViewport.height));
  const viewport = page.getViewport({ scale });
  const canvas = window.document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The browser could not create a chart canvas.');
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  await loadingTask.destroy();
  return {
    canvas,
    inspection: {
      fileName: file.name,
      pageCount: 1,
      fingerprint,
      width: canvas.width,
      height: canvas.height,
    },
  };
}

export function formatDegrees(degrees: number | null | undefined): string {
  if (degrees === null || degrees === undefined || !Number.isFinite(degrees)) return 'N/A';
  const rounded = Math.round(normalizeDegrees(degrees));
  return String(rounded === 0 ? 360 : rounded).padStart(3, '0');
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
  const fixed = Number(value).toFixed(digits);
  if (digits === 0) return fixed;
  return fixed.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
}

export function formatUtc(value: string | null | undefined): string {
  return value?.trim() || 'N/A';
}

export function ftToNm(value: number): number {
  return value / FT_PER_NM;
}
