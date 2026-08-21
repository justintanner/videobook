import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  GenerationControlField,
  type GenerationControlFieldProps,
} from '../../src/components/videobook/GenerationControlField'
import type { GenerationControl } from '../../src/videobook/notebook-generation-actions'

const booleanControl: GenerationControl = {
  name: 'fast_mode',
  label: 'Fast mode',
  kind: 'boolean',
  valueType: 'boolean',
  required: false,
  defaultValue: true,
  options: [],
  description: 'Toggle fast mode',
}

const selectControl: GenerationControl = {
  name: 'size',
  label: 'Size',
  kind: 'select',
  valueType: 'string',
  required: false,
  options: ['720p', '1080p'],
  description: 'Output size',
}

const requiredNumberSelect: GenerationControl = {
  name: 'count',
  label: 'Count',
  kind: 'select',
  valueType: 'number',
  required: true,
  options: [1, 2],
  description: 'Variant count',
}

const defaultedSelect: GenerationControl = {
  name: 'aspect',
  label: 'Aspect',
  kind: 'select',
  valueType: 'string',
  required: false,
  defaultValue: '16:9',
  options: ['16:9', '9:16'],
  description: 'Aspect ratio',
}

const numberControl: GenerationControl = {
  name: 'duration',
  label: 'Duration',
  kind: 'number',
  valueType: 'number',
  required: false,
  defaultValue: 5,
  minimum: 1,
  maximum: 10,
  options: [],
  description: 'Clip seconds',
}

const textControl: GenerationControl = {
  name: 'asset_name',
  label: 'Asset name',
  kind: 'text',
  valueType: 'string',
  required: false,
  options: [],
  description: 'Output asset name',
}

function renderField(
  control: GenerationControl,
  settings: GenerationControlFieldProps['settings'] = {},
  overrides: Partial<GenerationControlFieldProps> = {},
): string {
  return renderToStaticMarkup(createElement(GenerationControlField, {
    control,
    settings,
    busy: false,
    onChange: () => undefined,
    ...overrides,
  }))
}

describe('GenerationControlField boolean controls', () => {
  it('checks the toggle from the effective default value', () => {
    const html = renderField(booleanControl)

    expect(html).toContain('type="checkbox"')
    expect(html).toContain('checked=""')
    expect(html).toContain('title="Toggle fast mode"')
  })

  it('reflects an explicit setting over the default', () => {
    const html = renderField(booleanControl, { fast_mode: false })

    expect(html).not.toContain('checked=""')
  })

  it('renders the label before the input by default', () => {
    const html = renderField(booleanControl, {}, {
      toggleClassName: 'generation-review-toggle',
    })

    expect(html).toContain('class="generation-review-toggle"')
    expect(html.indexOf('<span>Fast mode</span>')).toBeLessThan(html.indexOf('<input'))
  })

  it('supports the inspector label-after-input ordering', () => {
    const html = renderField(booleanControl, {}, {
      toggleClassName: 'inspector-generation-toggle',
      booleanLabelFirst: false,
    })

    expect(html).toContain('class="inspector-generation-toggle"')
    expect(html.indexOf('<input')).toBeLessThan(html.indexOf('<span>Fast mode</span>'))
  })

  it('disables the toggle while busy', () => {
    const html = renderField(booleanControl, {}, { busy: true })

    expect(html).toContain('disabled=""')
  })
})

describe('GenerationControlField select controls', () => {
  it('offers an Auto placeholder when nothing is required or defaulted', () => {
    const html = renderField(selectControl)

    expect(html).toContain('<option value="" selected="">Auto</option>')
    expect(html).toContain('<option value="string:720p">720p</option>')
    expect(html).toContain('<option value="string:1080p">1080p</option>')
    expect(html).toContain('aria-label="Size"')
  })

  it('offers a Select placeholder for required controls without a default', () => {
    const html = renderField(requiredNumberSelect)

    expect(html).toContain('<option value="" selected="">Select…</option>')
    expect(html).toContain('<option value="number:1">1</option>')
  })

  it('names the placeholder after the default value when one exists', () => {
    const html = renderField(defaultedSelect)

    expect(html).toContain('<option value="" selected="">Default · 16:9</option>')
  })

  it('selects the persisted value', () => {
    const html = renderField(selectControl, { size: '1080p' })

    expect(html).toContain('<option value="string:1080p" selected="">1080p</option>')
  })

  it('keeps a persisted value missing from current options visible as incompatible', () => {
    const html = renderField(selectControl, { size: 'legacy-4k' })

    expect(html).toContain(
      '<option value="string:legacy-4k" selected="">legacy-4k · incompatible</option>',
    )
    expect(html).toContain('<option value="string:720p">720p</option>')
  })

  it('wraps the label in a span by default and bare text for the inspector', () => {
    const review = renderField(selectControl)
    const inspector = renderField(selectControl, {}, { labelAsSpan: false })

    expect(review).toContain('<span>Size</span>')
    expect(inspector).not.toContain('<span>Size</span>')
    expect(inspector).toContain('>Size<select')
  })
})

describe('GenerationControlField number and text controls', () => {
  it('renders number bounds, step, and the effective default', () => {
    const html = renderField(numberControl)

    expect(html).toContain('type="number"')
    expect(html).toContain('min="1"')
    expect(html).toContain('max="10"')
    expect(html).toContain('step="any"')
    expect(html).toContain('value="5"')
    expect(html).toContain('aria-label="Duration"')
  })

  it('renders an explicit number setting over the default', () => {
    const html = renderField(numberControl, { duration: 8 })

    expect(html).toContain('value="8"')
  })

  it('renders a text control with its persisted value', () => {
    const html = renderField(textControl, { asset_name: 'intro clip' })

    expect(html).toContain('type="text"')
    expect(html).toContain('value="intro clip"')
    expect(html).not.toContain('step=')
    expect(html).not.toContain('min=')
  })

  it('renders an empty text value when nothing is set or defaulted', () => {
    const html = renderField(textControl)

    expect(html).toContain('value=""')
  })
})
