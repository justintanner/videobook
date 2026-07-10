import {
  ComponentDom,
  Dom,
  InputView,
  LineGridDesignerExtension,
  OutputView,
  RectPlaceholderDesignerExtension,
  StartStopRootComponentDesignerExtension,
  getAbsolutePosition,
} from 'sequential-workflow-designer'
import type {
  ClickDetails,
  DesignerExtension,
  StepComponentView,
  StepComponentViewContext,
  StepContext,
  TextWidthMeasurer,
} from 'sequential-workflow-designer'
import type { NotebookPlanStep } from './types'

// Card geometry. Cells render as fixed-width "asset cards" that echo the left
// sidebar's 16:9 thumbnail cards, so the canvas reads like a game inventory.
export const CARD_WIDTH = 200
const HERO_HEIGHT = 112 // ~16:9 of the card width
const NAME_BAR_HEIGHT = 28
const GEN_CARD_HEIGHT = HERO_HEIGHT + NAME_BAR_HEIGHT // 140
const PROMPT_CARD_HEIGHT = 76
const RADIUS = 10
const HERO_ICON_SIZE = 40
const PROMPT_ICON_SIZE = 18
const INPUT_SIZE = 14
const OUTPUT_SIZE = 10

/**
 * Set `full` on `text`, then binary-search a truncation with a trailing
 * ellipsis until it fits `maxWidth`. Measurement uses the live element's
 * `getBBox()`, so the element must already be attached to the rendered SVG.
 */
function fitText(
  text: SVGTextElement,
  full: string,
  maxWidth: number,
  measure: TextWidthMeasurer,
): void {
  text.textContent = full
  if (!full || measure(text) <= maxWidth) return
  let lo = 0
  let hi = full.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    text.textContent = `${full.slice(0, mid)}…`
    if (measure(text) <= maxWidth) lo = mid
    else hi = mid - 1
  }
  text.textContent = lo > 0 ? `${full.slice(0, lo)}…` : '…'
}

/** Word-wrap `full` into at most `maxLines` <text> lines, ellipsizing overflow. */
function fillLines(
  g: SVGGElement,
  full: string,
  maxLines: number,
  maxWidth: number,
  firstLineY: number,
  lineHeight: number,
  measure: TextWidthMeasurer,
): void {
  const words = full.split(' ')
  let cursor = 0
  for (let lineIndex = 0; lineIndex < maxLines && cursor < words.length; lineIndex += 1) {
    const line = Dom.svg('text', {
      class: 'vc-card-excerpt',
      x: 12,
      y: firstLineY + lineIndex * lineHeight,
      'text-anchor': 'start',
    })
    g.appendChild(line)
    let count = 0
    while (cursor + count < words.length) {
      line.textContent = words.slice(cursor, cursor + count + 1).join(' ')
      if (measure(line) > maxWidth) break
      count += 1
    }
    if (count === 0) {
      // A single word is wider than the line — hard-truncate it.
      fitText(line, words[cursor], maxWidth, measure)
      count = 1
    } else {
      line.textContent = words.slice(cursor, cursor + count).join(' ')
    }
    cursor += count
    if (lineIndex === maxLines - 1 && cursor < words.length) {
      fitText(line, `${line.textContent ?? ''} …`, maxWidth, measure)
    }
  }
}

function createNotebookCardView(
  parentElement: SVGElement,
  stepContext: StepContext,
  viewContext: StepComponentViewContext,
): StepComponentView {
  const step = stepContext.step as NotebookPlanStep
  const isPrompt = step.type === 'prompt'
  const height = isPrompt ? PROMPT_CARD_HEIGHT : GEN_CARD_HEIGHT

  // `stepG` stamps `sqd-step-task sqd-type-{type}` + data-step-id, keeping the
  // selection walker, keyboard/context-menu delete, and the decorations hook
  // working against a stock-shaped node.
  const g = ComponentDom.stepG('task', step.type, step.id)
  parentElement.appendChild(g)

  const rect = Dom.svg('rect', {
    class: 'sqd-step-task-rect vc-card-rect',
    x: 0.5,
    y: 0.5,
    width: CARD_WIDTH,
    height,
    rx: RADIUS,
    ry: RADIUS,
  })
  g.appendChild(rect)

  const iconUrl = viewContext.getStepIconUrl()

  if (!isPrompt) {
    // The ghost (isPreview) renders the same step id concurrently on <body>, so
    // clip-path ids must not collide with the on-canvas card.
    const clipId = `vc-hero-${step.id}${stepContext.isPreview ? '-preview' : ''}`
    const defs = Dom.svg('defs')
    const clip = Dom.svg('clipPath', { id: clipId })
    // Full-height rounded clip: the hero gets the card's rounded top corners and
    // a straight bottom edge where the name bar begins.
    clip.appendChild(Dom.svg('rect', {
      x: 1,
      y: 1,
      width: CARD_WIDTH - 1,
      height,
      rx: RADIUS,
      ry: RADIUS,
    }))
    defs.appendChild(clip)
    g.appendChild(defs)

    g.appendChild(Dom.svg('rect', {
      class: 'vc-card-hero-bg',
      x: 1,
      y: 1,
      width: CARD_WIDTH - 1,
      height: HERO_HEIGHT - 1,
      'clip-path': `url(#${clipId})`,
    }))

    // Empty-state layer: the type icon, hidden by CSS once a thumbnail arrives.
    if (iconUrl) {
      g.appendChild(Dom.svg('image', {
        class: 'vc-card-icon',
        href: iconUrl,
        x: (CARD_WIDTH - HERO_ICON_SIZE) / 2,
        y: (HERO_HEIGHT - HERO_ICON_SIZE) / 2,
        width: HERO_ICON_SIZE,
        height: HERO_ICON_SIZE,
      }))
    }

    // Thumbnail layer: href + `.vc-has-thumb` are set by useCanvasStepDecorations.
    g.appendChild(Dom.svg('image', {
      class: 'vc-node-thumb',
      x: 1,
      y: 1,
      width: CARD_WIDTH - 1,
      height: HERO_HEIGHT - 1,
      preserveAspectRatio: 'xMidYMid slice',
      'clip-path': `url(#${clipId})`,
    }))

    g.appendChild(Dom.svg('line', {
      class: 'vc-card-divider',
      x1: 1,
      y1: HERO_HEIGHT + 0.5,
      x2: CARD_WIDTH,
      y2: HERO_HEIGHT + 0.5,
    }))

    const name = Dom.svg('text', {
      class: 'sqd-step-task-text vc-card-name',
      x: CARD_WIDTH / 2,
      y: HERO_HEIGHT + NAME_BAR_HEIGHT / 2,
      'text-anchor': 'middle',
    })
    g.appendChild(name)
    fitText(name, viewContext.getStepName(), CARD_WIDTH - 24, viewContext.textWidthMeasurer)
  } else {
    if (iconUrl) {
      g.appendChild(Dom.svg('image', {
        class: 'vc-card-icon-sm',
        href: iconUrl,
        x: 12,
        y: 12,
        width: PROMPT_ICON_SIZE,
        height: PROMPT_ICON_SIZE,
      }))
    }
    const name = Dom.svg('text', {
      class: 'sqd-step-task-text vc-card-name',
      x: 38,
      y: 21,
      'text-anchor': 'start',
    })
    g.appendChild(name)
    fitText(name, viewContext.getStepName(), CARD_WIDTH - 38 - 12, viewContext.textWidthMeasurer)

    const raw = typeof step.properties.text === 'string'
      ? step.properties.text.replace(/\s+/g, ' ').trim()
      : ''
    if (raw) {
      fillLines(g, raw, 2, CARD_WIDTH - 24, 44, 15, viewContext.textWidthMeasurer)
    }
  }

  const inputView = stepContext.isInputConnected
    ? InputView.createRoundInput(g, CARD_WIDTH / 2, 0, INPUT_SIZE)
    : null
  const outputView = OutputView.create(g, CARD_WIDTH / 2, height, OUTPUT_SIZE)

  return {
    g,
    width: CARD_WIDTH,
    height,
    joinX: CARD_WIDTH / 2,
    components: null,
    placeholders: null,
    hasOutput: true,
    getClientPosition: () => getAbsolutePosition(rect),
    resolveClick: (click: ClickDetails) => (g.contains(click.element) ? true : null),
    setIsDragging: (isDragging: boolean) => {
      inputView?.setIsHidden(isDragging)
      outputView.setIsHidden(isDragging)
    },
    setIsDisabled: (isDisabled: boolean) => Dom.toggleClass(g, isDisabled, 'sqd-disabled'),
    // Toggle on the group (stock toggles on the rect) so one class drives the
    // rect stroke, the drop-shadow glow, and the name-bar accent.
    setIsSelected: (isSelected: boolean) => Dom.toggleClass(g, isSelected, 'sqd-selected'),
  }
}

// Module-level constant: the React wrapper applies `extensions` only when the
// designer is (re)built, so a stable identity keeps behavior deterministic.
export const notebookDesignerExtensions: DesignerExtension[] = [
  { steps: [{ componentType: 'task', createComponentView: createNotebookCardView }] },
  LineGridDesignerExtension.create({ gridSizeX: 40, gridSizeY: 40 }),
  RectPlaceholderDesignerExtension.create({ gapWidth: 200, gapHeight: 32, radius: 8, iconSize: 16 }),
  StartStopRootComponentDesignerExtension.create({ view: { size: 36, defaultIconSize: 24 } }),
]
