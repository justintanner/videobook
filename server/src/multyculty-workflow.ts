import type {
  Engine,
  NotebookCell,
  NotebookDocument,
  NotebookEdge,
} from "videobook-engine";

type ArtifactRecord = {
  artifactId: string;
  slug: string;
  kind: string;
};

type SceneSpec = {
  key: string;
  label: string;
  sectionSlug: string;
  animationSlug: string;
  prompt: string;
  model: string;
};

const scenes: SceneSpec[] = [{
  key: "intro",
  label: "intro",
  sectionSlug: "vid-section-intro",
  animationSlug: "vid-animated-intro",
  prompt: "Man sits motionless as the world moves around him, subtle, ASMR.",
  model: "omni-flash",
}, {
  key: "culture",
  label: "culture beat",
  sectionSlug: "vid-section-culture",
  animationSlug: "vid-animated-culture",
  prompt: "The group looks at one another and the car, ready to collaborate.",
  model: "omni-flash",
}, {
  key: "german",
  label: "German beat",
  sectionSlug: "vid-section-german",
  animationSlug: "vid-animated-german",
  prompt: "Lock the character performance and preserve synchronized dialogue.",
  model: "videocity-render",
}, {
  key: "dialogue",
  label: "dialogue beat",
  sectionSlug: "vid-section-dunka",
  animationSlug: "vid-animated-dunka",
  prompt: "Animate the two-character scene and preserve the original dialogue beat.",
  model: "omni-flash",
}];

function workflowPosition(stage: number, column: number) {
  return {
    x: 238 + column * 348,
    y: 48 + stage * 376,
  };
}

function requiredArtifact(
  artifacts: ArtifactRecord[],
  slug: string,
): ArtifactRecord {
  const artifact = artifacts.find((candidate) => candidate.slug === slug);
  if (!artifact) throw new Error(`Multyculty fixture artifact is missing: ${slug}`);
  return artifact;
}

function roleOf(cell: NotebookCell): string | null {
  return typeof cell.inputs?.workflowRole === "string"
    ? cell.inputs.workflowRole
    : null;
}

function reusableCell(
  engine: Engine,
  notebook: NotebookDocument,
  role: string,
  input: Omit<NotebookCell, "id">,
): NotebookCell {
  const existing = notebook.cells.find((cell) => roleOf(cell) === role);
  return engine.notebooks.createCell({
    ...input,
    inputs: { ...input.inputs, workflowRole: role },
    ...(existing ? { id: existing.id } : {}),
  });
}

function reusableEdge(
  engine: Engine,
  notebook: NotebookDocument,
  source: NotebookCell,
  target: NotebookCell,
  targetInput: string,
): NotebookEdge {
  const existing = notebook.edges.find((edge) =>
    edge.source === source.id
    && edge.target === target.id
    && edge.targetInput === targetInput);
  return engine.notebooks.createEdge({
    source: source.id,
    target: target.id,
    targetInput,
    ...(existing ? { id: existing.id } : {}),
  });
}

export async function seedMultycultyWorkflow(
  engine: Engine,
): Promise<NotebookDocument> {
  if (engine.book.get().slug !== "multyculty") {
    throw new Error("The Multyculty workflow can only seed the multyculty book");
  }
  const notebook = engine.notebooks.list().find((candidate) =>
    candidate.name.toLowerCase() === "multyculty")
    ?? engine.notebooks.list()[0];
  if (!notebook) throw new Error("The Multyculty book has no notebook");

  const artifacts = engine.artifacts.list() as ArtifactRecord[];
  const sourceArtifact = requiredArtifact(artifacts, "vid-source-selection");
  const finalArtifact = requiredArtifact(artifacts, "final");
  const streams = engine.streams.list(sourceArtifact.artifactId);
  if (!streams.ok) throw new Error(streams.error.message);
  const sourceAudio = streams.value.find((stream) => stream.kind === "audio");
  if (!sourceAudio) throw new Error("The Multyculty source has no audio stream");

  const source = reusableCell(engine, notebook, "source", {
    type: "source",
    title: "@vid-source · downloaded clip",
    position: workflowPosition(0, 2),
    outputArtifactId: sourceArtifact.artifactId,
    inputs: {
      sourceProject: "multiculty",
      sourceTitle: "We Were WRONG About Rupert Lowe",
      sourceUrl: "https://www.youtube.com/watch?v=b-3853ow72Q",
      selectedRangeSeconds: [1490, 1550],
      operation: "download_video",
    },
  });

  const sceneCells = scenes.map((scene, index) => {
    const artifact = requiredArtifact(artifacts, scene.sectionSlug);
    return reusableCell(engine, notebook, `scene-${scene.key}`, {
      type: "scene",
      title: `@scene-${String(index + 1).padStart(2, "0")} · ${scene.label}`,
      position: workflowPosition(1, index),
      outputArtifactId: artifact.artifactId,
      inputs: {
        operation: "split_video",
        section: index + 1,
        sourceArtifactId: sourceArtifact.artifactId,
        state: "completed",
      },
    });
  });

  const audio = reusableCell(engine, notebook, "source-audio", {
    type: "audio",
    title: "@aud-source-audio",
    position: workflowPosition(1, 4),
    outputArtifactId: sourceArtifact.artifactId,
    inputs: {
      operation: "extract_audio",
      artifactId: sourceArtifact.artifactId,
      streamId: sourceAudio.streamId,
      objectHash: sourceAudio.objectHash,
      codec: sourceAudio.codec,
      sampleRateHz: sourceAudio.audio?.sampleRateHz,
      channelLayout: sourceAudio.audio?.channelLayout,
      state: "completed",
    },
  });

  const animationCells = scenes.map((scene, index) => {
    const artifact = requiredArtifact(artifacts, scene.animationSlug);
    return reusableCell(engine, notebook, `animate-${scene.key}`, {
      type: "video",
      title: `@scene-${String(index + 1).padStart(2, "0")} / animate`,
      position: workflowPosition(2, index),
      prompt: scene.prompt,
      model: scene.model,
      outputArtifactId: artifact.artifactId,
      inputs: {
        provider: scene.model === "videocity-render" ? "local" : "google",
        operation: "animate_scene",
        state: "completed",
      },
    });
  });

  const assembly = reusableCell(engine, notebook, "assembly", {
    type: "sequence",
    title: "@sequence · reassemble scenes",
    position: workflowPosition(3, 2),
    inputs: {
      operation: "assemble_sequence",
      render: "landscape",
      sectionArtifactIds: animationCells.map((cell) => cell.outputArtifactId),
      sourceAudioArtifactId: sourceArtifact.artifactId,
      state: "completed",
    },
  });

  const final = reusableCell(engine, notebook, "final", {
    type: "sequence",
    title: "@final · 1080p master",
    position: workflowPosition(4, 2),
    outputArtifactId: finalArtifact.artifactId,
    inputs: {
      codec: "h264",
      audioCodec: "aac",
      resolution: "1920x1080",
      durationSeconds: 72.488333,
      state: "ready",
    },
  });

  const cells = [
    source,
    ...sceneCells,
    audio,
    ...animationCells,
    assembly,
    final,
  ];
  const edges = [
    ...sceneCells.map((scene, index) =>
      reusableEdge(engine, notebook, source, scene, `section-${index + 1}`)),
    reusableEdge(engine, notebook, source, audio, "audio-stream"),
    ...sceneCells.map((scene, index) =>
      reusableEdge(engine, notebook, scene, animationCells[index]!, "reference-video")),
    ...animationCells.map((animation, index) =>
      reusableEdge(engine, notebook, animation, assembly, `slot-${index + 1}`)),
    reusableEdge(engine, notebook, audio, assembly, "source-audio"),
    reusableEdge(engine, notebook, assembly, final, "master"),
  ];
  const completedAt = new Date().toISOString();
  const execution = Object.fromEntries(cells.map((cell) => [
    cell.id,
    {
      status: "completed",
      completedAt,
      ...(cell.outputArtifactId
        ? { outputArtifactId: cell.outputArtifactId }
        : {}),
    },
  ]));
  const seeded: NotebookDocument = {
    ...notebook,
    name: "Multyculty",
    properties: {
      ...notebook.properties,
      description: "Finished green-path edit imported from Videocity multiculty.",
      sourceProject: "multiculty",
      sourceProjectPath: "~/videocity/projects/multiculty",
      state: "finished",
      stageLabels: [
        "SOURCE",
        "SCENES + AUDIO",
        "ANIMATE EACH SCENE",
        "REASSEMBLE",
        "FINAL MASTER",
        "NEXT",
      ],
      demo: {
        columns: 5,
        rows: 5,
        importedSelection: true,
        workflow: [
          "download",
          "split-scenes-and-audio",
          "animate-each-scene",
          "assemble-with-source-audio",
          "final",
        ],
      },
      audioSpine: {
        artifactId: sourceArtifact.artifactId,
        streamId: sourceAudio.streamId,
        objectHash: sourceAudio.objectHash,
        sourcePath: sourceAudio.sourcePath,
        sequenceId: engine.sequences.getPrimary().sequenceId,
        sequenceRevision: engine.head,
      },
      execution,
    },
    cells,
    edges,
  };
  const result = await engine.notebooks.write(seeded);
  if (!result.ok) throw new Error(result.error.message);
  const written = engine.notebooks.read(notebook.id);
  if (!written.ok) throw new Error(written.error.message);
  return written.value;
}
