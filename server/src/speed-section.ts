export interface SpeedSection {
  startSeconds: number;
  endSeconds: number;
}

interface SectionPart {
  start: number;
  end: number | null;
  rate: number;
}

const MIN_PART_SECONDS = 0.001;
const MIN_SECTION_SECONDS = 0.1;
const ATEMPO_MIN = 0.5;

export function resolveSpeedSection(
  startSeconds: number | undefined,
  endSeconds: number | undefined,
  durationSeconds: number,
): SpeedSection | string | null {
  if (startSeconds === undefined && endSeconds === undefined) return null;
  const start = startSeconds ?? 0;
  const end = Math.min(endSeconds ?? durationSeconds, durationSeconds);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) {
    return `Section times must be finite and non-negative, got ${start}–${end}`;
  }
  if (end - start < MIN_SECTION_SECONDS) {
    return `Section must be at least ${MIN_SECTION_SECONDS}s long inside the ${durationSeconds.toFixed(2)}s source`;
  }
  if (start <= MIN_PART_SECONDS && durationSeconds - end <= MIN_PART_SECONDS) return null;
  return { startSeconds: start, endSeconds: end };
}

export function sectionSpeedForTarget(
  section: SpeedSection,
  durationSeconds: number,
  targetSeconds: number,
): number {
  const length = section.endSeconds - section.startSeconds;
  const untouched = durationSeconds - length;
  return targetSeconds > untouched ? length / (targetSeconds - untouched) : Number.POSITIVE_INFINITY;
}

export function sectionOutputDuration(
  section: SpeedSection,
  durationSeconds: number,
  speed: number,
): number {
  const length = section.endSeconds - section.startSeconds;
  return durationSeconds - length + length / speed;
}

function sectionParts(section: SpeedSection, durationSeconds: number, speed: number): SectionPart[] {
  const parts: SectionPart[] = [
    { start: 0, end: section.startSeconds, rate: 1 },
    { start: section.startSeconds, end: section.endSeconds, rate: speed },
    { start: section.endSeconds, end: null, rate: 1 },
  ];
  return parts.filter((part) => (part.end ?? durationSeconds) - part.start > MIN_PART_SECONDS);
}

function trimRange(part: SectionPart): string {
  const start = `start=${part.start.toFixed(6)}`;
  return part.end === null ? start : `${start}:end=${part.end.toFixed(6)}`;
}

function atempoChain(rate: number): string[] {
  const filters: string[] = [];
  let remaining = rate;
  while (remaining < ATEMPO_MIN) {
    filters.push(`atempo=${ATEMPO_MIN}`);
    remaining /= ATEMPO_MIN;
  }
  filters.push(`atempo=${remaining}`);
  return filters;
}

function videoPartFilter(part: SectionPart, index: number): string {
  const retime = part.rate === 1 ? "setpts=PTS-STARTPTS" : `setpts=(PTS-STARTPTS)/${part.rate}`;
  return `[0:v]trim=${trimRange(part)},${retime}[v${index}]`;
}

function audioPartFilter(part: SectionPart, index: number): string {
  const tempo = part.rate === 1 ? [] : atempoChain(part.rate);
  return [`[0:a]atrim=${trimRange(part)}`, "asetpts=PTS-STARTPTS", ...tempo].join(",") + `[a${index}]`;
}

export function buildSectionSpeedFilter(
  section: SpeedSection,
  durationSeconds: number,
  speed: number,
  hasAudio: boolean,
): string {
  const parts = sectionParts(section, durationSeconds, speed);
  const chains = parts.flatMap((part, index) => (
    hasAudio ? [videoPartFilter(part, index), audioPartFilter(part, index)] : [videoPartFilter(part, index)]
  ));
  const inputs = parts.map((_, index) => (hasAudio ? `[v${index}][a${index}]` : `[v${index}]`)).join("");
  const outputs = hasAudio ? "[vout][aout]" : "[vout]";
  return [...chains, `${inputs}concat=n=${parts.length}:v=1:a=${hasAudio ? 1 : 0}${outputs}`].join(";");
}
