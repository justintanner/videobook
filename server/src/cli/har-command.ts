import { dirname, resolve } from "node:path";
import { exportHarCaptures, selectHarRows, type HarExportManifest, type HarSelection } from "../har-export.js";
import { readHarIndex } from "../har-index.js";
import { harDirectory } from "../har-settings.js";
import type { HarAction, HarFlags } from "./args.js";

interface HarCommand {
  action: HarAction;
  flags: HarFlags;
}

const LISTED_SKIPS = 10;

function selection(flags: HarFlags): HarSelection {
  return {
    since: flags.since === undefined ? null : Date.parse(flags.since),
    failures: flags.failures,
    providers: flags.providers,
  };
}

async function listCaptures(flags: HarFlags): Promise<number> {
  const dir = harDirectory();
  const rows = selectHarRows(await readHarIndex(dir), selection(flags)).sort((a, b) => b.ts.localeCompare(a.ts));
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ dir, captures: rows }, null, 2)}\n`);
    return 0;
  }
  const lines = rows.map((row) => [row.ts, row.provider, row.endpoint, row.outcome, row.status ?? "-", row.file].join("\t"));
  process.stdout.write(`${["ts\tprovider\tendpoint\toutcome\tstatus\tfile", ...lines].join("\n")}\n`);
  if (rows.length === 0) process.stderr.write(`No matching captures in ${dir}\n`);
  return 0;
}

function outcomeSummary(outcomes: HarExportManifest["outcomes"]): string {
  return Object.entries(outcomes).filter(([, count]) => count > 0).map(([outcome, count]) => `${outcome} ${count}`).join(", ");
}

function shellPath(path: string): string {
  return /^[\w./:@%+=,-]+$/u.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
}

function handoff(out: string, archive: boolean, manifest: HarExportManifest): string {
  const target = shellPath(archive ? out.replace(/\.(?:tar\.gz|tgz)$/iu, "") : out);
  return [
    `Exported ${manifest.files} capture${manifest.files === 1 ? "" : "s"} (${manifest.dateRange.first} to ${manifest.dateRange.last}) to ${out}`,
    ...manifest.providers.map((provider) => `  ${provider.provider}: ${provider.calls} (${outcomeSummary(provider.outcomes)})`),
    `Every file passed the @apicity/har ${manifest.apicity.har} scrub check. The captures still contain prompts and media URLs; review them before sharing.`,
    "",
    "Hand-off to an apicity maintainer:",
    ...(archive ? [`  tar -xzf ${shellPath(out)} -C ${shellPath(dirname(out))}`] : []),
    `  apicity har report ${target} > report.md`,
    "  apicity har scrub --check <capture.har>",
    "  pnpm run har:promote -- <capture.har> --name <provider>/<test-name> --dry-run   (in the apicity repository, for a successful call)",
    "",
  ].join("\n");
}

function skippedWarning(skipped: readonly string[]): string {
  if (skipped.length === 0) return "";
  const listed = skipped.slice(0, LISTED_SKIPS).map((file) => `  ${file}\n`).join("");
  const more = skipped.length > LISTED_SKIPS ? `  and ${skipped.length - LISTED_SKIPS} more\n` : "";
  return `Skipped ${skipped.length} indexed capture${skipped.length === 1 ? "" : "s"} that are missing or unreadable:\n${listed}${more}`;
}

async function exportCaptures(flags: HarFlags): Promise<number> {
  const dir = harDirectory();
  const out = resolve(process.cwd(), flags.out ?? "");
  const result = await exportHarCaptures({ dir, out, ...selection(flags) });
  switch (result.status) {
    case "out-inside-captures":
      process.stderr.write(`--out must be outside the capture directory ${dir}\n`);
      return 2;
    case "out-exists":
      process.stderr.write(`${out} already exists; choose a new file or an empty directory\n`);
      return 1;
    case "needs-scrub":
      process.stderr.write([
        "Refusing to export: @apicity/har scrubHar would change these captures:",
        ...result.files.map((file) => `  ${file}`),
        "A scrub rule is missing upstream. Report it to apicity instead of editing the captures. Nothing was written.",
        "",
      ].join("\n"));
      return 1;
    case "empty":
      process.stderr.write(`${skippedWarning(result.skipped)}No captures in ${dir} match the filters. Nothing was written.\n`);
      return 1;
    case "exported":
      process.stderr.write(skippedWarning(result.skipped));
      process.stdout.write(flags.json
        ? `${JSON.stringify({ out: result.out, archive: result.archive, manifest: result.manifest, skipped: result.skipped }, null, 2)}\n`
        : handoff(result.out, result.archive, result.manifest));
      return 0;
  }
}

export async function runHarCommand(command: HarCommand): Promise<number> {
  return command.action === "export" ? exportCaptures(command.flags) : listCaptures(command.flags);
}
