import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'

describe('cell context menu layout in Chromium', () => {
  it.each([{ width: 1440, height: 1000 }, { width: 390, height: 844 }])('keeps growing menus visible without stealing keyboard focus at $width px', async (viewport) => {
    const client = `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { NotebookCellContextMenu } from './src/components/videobook/NotebookCellContextMenu.tsx';
      const initial = [
        { id: 'inspect', label: 'Edit cell', icon: 'inspect' },
        { id: 'source', label: 'View source', icon: 'source' },
      ];
      function Harness() {
        const [open, setOpen] = useState(false);
        const [actions, setActions] = useState(initial);
        window.showMediaActions = () => setActions([...initial,
          { id: 'media', label: 'Open media', icon: 'media' },
          { id: 'extract_frame', label: 'Extract frame', icon: 'extract-frame' },
          { id: 'generate_video', label: 'Generate video', icon: 'generate-video' },
          { id: 'duplicate', label: 'Duplicate', icon: 'duplicate' },
          { id: 'arrange_videos_column', label: 'Arrange videos in column', icon: 'arrange-column' },
          { id: 'arrange_videos_row', label: 'Arrange videos in row', icon: 'arrange-row' },
          { id: 'split', label: 'Split video', icon: 'split' },
          { id: 'more', label: 'More actions', icon: 'more' },
        ]);
        return React.createElement(React.Fragment, null,
          React.createElement('button', { id: 'trigger', onClick: () => setOpen(true) }, 'Open cell menu'),
          open && React.createElement(NotebookCellContextMenu, {
            actions, address: '@a1', cellType: 'video', menuId: 'cell-menu',
            position: { x: innerWidth - 24, y: innerHeight - 24 },
            returnFocus: document.getElementById('trigger'),
            onAction: () => {}, onClose: () => setOpen(false), onDelete: () => {},
          }),
        );
      }
      createRoot(document.getElementById('root')).render(React.createElement(Harness));
    `
    const [bundle, preflight, stylesheet] = await Promise.all([
      build({
        stdin: { contents: client, resolveDir: process.cwd(), sourcefile: 'cell-menu-harness.js', loader: 'js' },
        bundle: true, write: false, platform: 'browser', format: 'iife', tsconfig: 'tsconfig.app.json',
        define: { 'process.env.NODE_ENV': JSON.stringify('development') },
      }),
      readFile('node_modules/tailwindcss/preflight.css', 'utf8'),
      readFile('src/index.css', 'utf8'),
    ])
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage({ viewport })
      await page.setContent('<!doctype html><div id="root"></div>')
      await page.addStyleTag({ content: preflight + stylesheet })
      await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
      const trigger = page.getByRole('button', { name: 'Open cell menu', exact: true })
      await trigger.click()
      const menu = page.getByRole('menu', { name: 'Cell actions for @a1', exact: true })
      await menu.waitFor()
      await menu.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)) })
      await page.keyboard.press('ArrowDown')
      const source = menu.getByRole('menuitem', { name: 'View source', exact: true })
      expect(await source.evaluate(element => document.activeElement === element)).toBe(true)
      const initial = await menu.boundingBox()
      expect(initial).not.toBeNull()
      await page.evaluate(() => (window as unknown as { showMediaActions: () => void }).showMediaActions())
      await menu.getByRole('menuitem', { name: 'Split video', exact: true }).waitFor()
      await expect.poll(async () => {
        const bounds = await menu.boundingBox()
        return bounds ? { left: bounds.x, top: bounds.y, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height } : null
      }).toEqual({
        left: expect.closeTo(initial!.x, 0),
        top: expect.any(Number),
        right: expect.closeTo(initial!.x + initial!.width, 0),
        bottom: expect.closeTo(initial!.y + initial!.height, 0),
      })
      const grown = await menu.boundingBox()
      expect(grown!.y).toBeGreaterThanOrEqual(8)
      expect(grown!.height).toBeGreaterThan(initial!.height)
      expect(grown!.y + grown!.height).toBeLessThanOrEqual(viewport.height - 8)
      expect(await source.evaluate(element => document.activeElement === element)).toBe(true)
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'hidden' })
      expect(await trigger.evaluate(element => document.activeElement === element)).toBe(true)
    } finally { await browser.close() }
  })
})
