/**
 * What a notebook cell's preview frame says about its media.
 *
 * Every media cell — image, video, audio — draws the same surface: a badge
 * rail along the top right naming what the media is, and a corner meter along
 * the bottom right timing it. Only the contents of those two lists vary by
 * kind, and they are derived here so the frame itself stays presentational.
 */

import { abbreviateGenerationPhrases } from './notebook-generation-actions'
import {
  formatMediaAspectRatio,
  formatMediaTime,
  notebookAudioPresentation,
} from './notebook-cell-presentation'
import type { NotebookAudioInfo } from './notebook-cell-presentation'

/** A pill in the rail. `generator` badges clamp their width and read brighter. */
export type CellPreviewBadgeEmphasis = 'plain' | 'generator'

export type CellPreviewBadge = {
  key: string
  label: string
  /** Tooltip on the pill. */
  title: string
  /** How the pill reads aloud, where the label alone would not say enough. */
  announce: string
  emphasis: CellPreviewBadgeEmphasis
}

export type CellPreviewMeter = {
  label: string
  seconds: number
}

export type ImagePreviewBadgeInput = {
  width: number | null
  height: number | null
  tool: string | null
  model: string | null
  provenance: string | null
}

export type VideoPreviewBadgeInput = {
  aspectRatio: string | null
  width: number | null
  height: number | null
  tool: string | null
  model: string | null
  provenance: string | null
}

export type AudioPreviewBadgeInput = {
  audioInfo: NotebookAudioInfo | null
  durationSeconds: number | null
  hasOutput: boolean
  inputs: Record<string, unknown> | undefined
}

function positiveFinite(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0
}

function dimensionsLabel(width: number | null, height: number | null): string | null {
  return positiveFinite(width) && positiveFinite(height)
    ? `${width}×${height}`
    : null
}

function generatorBadge(
  tool: string | null,
  model: string | null,
): CellPreviewBadge | null {
  const generator = tool ?? model
  if (!generator) return null
  const label = abbreviateGenerationPhrases(generator)
  return {
    key: 'generator',
    label,
    title: label,
    announce: `Generator ${label}`,
    emphasis: 'generator',
  }
}

function provenanceBadge(provenance: string | null): CellPreviewBadge | null {
  if (!provenance) return null
  return {
    key: 'provenance',
    label: provenance,
    title: `Extracted from ${provenance}`,
    announce: `Extracted from ${provenance}`,
    emphasis: 'generator',
  }
}

/** Size, shape, generator, provenance — the image cell's rail, unchanged. */
export function imagePreviewBadges(
  input: ImagePreviewBadgeInput,
): CellPreviewBadge[] {
  const dimensions = dimensionsLabel(input.width, input.height)
  const aspectRatio = formatMediaAspectRatio(input.width, input.height)
  return [
    dimensions
      ? {
        key: 'dimensions',
        label: dimensions,
        title: 'Dimensions',
        announce: `Dimensions ${dimensions}`,
        emphasis: 'plain' as const,
      }
      : null,
    aspectRatio
      ? {
        key: 'aspect',
        label: aspectRatio,
        title: 'Aspect ratio',
        announce: `Aspect ratio ${aspectRatio}`,
        emphasis: 'plain' as const,
      }
      : null,
    generatorBadge(input.tool, input.model),
    provenanceBadge(input.provenance),
  ].filter((badge): badge is CellPreviewBadge => badge !== null)
}

/**
 * Shape and generator. Duration is the meter's job, so it never doubles up
 * here, and the cell header no longer carries either one.
 */
export function videoPreviewBadges(
  input: VideoPreviewBadgeInput,
): CellPreviewBadge[] {
  const aspectRatio = input.aspectRatio
    ?? formatMediaAspectRatio(input.width, input.height)
  return [
    aspectRatio
      ? {
        key: 'aspect',
        label: aspectRatio,
        title: 'Aspect ratio',
        announce: `Aspect ratio ${aspectRatio}`,
        emphasis: 'plain' as const,
      }
      : null,
    generatorBadge(input.tool, input.model),
    provenanceBadge(input.provenance),
  ].filter((badge): badge is CellPreviewBadge => badge !== null)
}

/** Role first, then codec, rate and layout — everything the teal panel said. */
export function audioPreviewBadges(
  input: AudioPreviewBadgeInput,
): CellPreviewBadge[] {
  const presentation = notebookAudioPresentation(input)
  const role: CellPreviewBadge = {
    key: 'role',
    label: presentation.role,
    title: 'Audio role',
    announce: `Audio role ${presentation.role}`,
    emphasis: 'generator',
  }
  return [
    role,
    ...presentation.details.map((detail, index) => ({
      key: `detail-${index}`,
      label: detail,
      title: detail,
      announce: detail,
      emphasis: 'plain' as const,
    })),
  ]
}

/** The bottom-right readout: a duration for time-based media, nothing else. */
export function previewMeter(durationSeconds: number | null): CellPreviewMeter | null {
  if (!positiveFinite(durationSeconds)) return null
  // Whole seconds at a glance: hundredths are noise at this size, and they
  // flicker once the readout starts counting through playback.
  return { label: formatMediaTime(Math.floor(durationSeconds)), seconds: durationSeconds }
}

/** The audio meter reads the same duration the badges were built from. */
export function audioPreviewMeter(
  input: AudioPreviewBadgeInput,
): CellPreviewMeter | null {
  return previewMeter(notebookAudioPresentation(input).durationSeconds)
}

/** Screen-reader sentence for the rail and meter taken together. */
export function previewMetadataLabel(
  kindLabel: string,
  badges: CellPreviewBadge[],
  meter: CellPreviewMeter | null,
  prompt: string | null,
): string {
  return [
    `${kindLabel} metadata`,
    ...badges.map((badge) => badge.announce),
    meter ? `Duration ${meter.label}` : null,
    prompt ? `Prompt: ${prompt}` : null,
  ].filter((part): part is string => Boolean(part)).join('. ')
}
