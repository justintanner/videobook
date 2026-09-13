import type { Engine } from "videobook-engine";

const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAIAAAC0SDtlAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFUlEQVQYlWMomiNNEmIY1TBnMIQSACBhpxH2SYbTAAAAAElFTkSuQmCC",
  "base64",
);

type MixedStatusCatalog = {
  ready: string[];
  error: string[];
  processing: string[];
};

export async function seedMixedStatusCatalog(
  engine: Engine,
  counts: {
    ready: number;
    error: number;
    processing: number;
  },
): Promise<MixedStatusCatalog> {
  const ready: string[] = [];
  const error: string[] = [];
  const processing: string[] = [];

  for (let index = 0; index < counts.ready; index += 1) {
    const created = await engine.artifacts.create({
      kind: "image",
      label: `ready still ${index + 1}`,
    });
    if (!created.ok) throw new Error(created.error.message);
    const written = await engine.files.write(
      created.value.artifactId,
      "original.png",
      MINIMAL_PNG,
    );
    if (!written.ok) throw new Error(written.error.message);
    ready.push(created.value.artifactId);
  }

  for (let index = 0; index < counts.error; index += 1) {
    const created = await engine.artifacts.create({
      kind: "image",
      label: `failed still ${index + 1}`,
    });
    if (!created.ok) throw new Error(created.error.message);
    const lease = engine.jobs.artifactWork.begin(created.value.artifactId, {
      kind: "upload",
      ownerKind: "job",
      durationMs: 60_000,
    });
    if (!lease) throw new Error("Could not claim failed artifact");
    const failed = await engine.jobs.artifactWork.fail(
      created.value.artifactId,
      lease.ownerId,
      { message: "ingest failed" },
    );
    if (!failed) throw new Error("Could not fail artifact");
    error.push(created.value.artifactId);
  }

  for (let index = 0; index < counts.processing; index += 1) {
    const created = await engine.artifacts.create({
      kind: "image",
      label: `processing still ${index + 1}`,
    });
    if (!created.ok) throw new Error(created.error.message);
    const lease = engine.jobs.artifactWork.begin(created.value.artifactId, {
      kind: "upload",
      ownerKind: "job",
      durationMs: 60 * 60_000,
    });
    if (!lease) throw new Error("Could not claim processing artifact");
    processing.push(created.value.artifactId);
  }

  return { ready, error, processing };
}

export async function seedRetryableFailedImage(
  engine: Engine,
  label: string,
): Promise<string> {
  const created = await engine.artifacts.create({
    kind: "image",
    label,
  });
  if (!created.ok) throw new Error(created.error.message);
  const written = await engine.files.write(
    created.value.artifactId,
    "original.png",
    MINIMAL_PNG,
  );
  if (!written.ok) throw new Error(written.error.message);
  const lease = engine.jobs.artifactWork.begin(created.value.artifactId, {
    kind: "upload",
    ownerKind: "job",
    durationMs: 60_000,
  });
  if (!lease) throw new Error("Could not claim retryable artifact");
  const failed = await engine.jobs.artifactWork.fail(
    created.value.artifactId,
    lease.ownerId,
    { message: "ingest failed" },
  );
  if (!failed) throw new Error("Could not fail retryable artifact");
  return created.value.artifactId;
}
