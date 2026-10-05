import { ChevronDown } from 'lucide-react'
import { Fragment, useState } from 'react'
import type { NotebookCell } from 'videobook-engine'
import {
  doltCellDisplayValue,
  doltCellRows,
} from '@/videobook/dolt-cell-source'
import { ArtifactThumb } from './ArtifactThumb'
import type { NotebookCellInspectorAsset } from './NotebookCellInspector'
import { NotebookMediaMetadata } from './NotebookMediaMetadata'
import { RichJson } from './RichJson'

export type DoltArtifactAssets = ReadonlyMap<string, NotebookCellInspectorAsset>

function DoltArtifactExpansion({
  asset,
}: {
  asset: NotebookCellInspectorAsset
}) {
  return (
    <div className="inspector-dolt-artifact">
      <ArtifactThumb asset={asset} />
      <div className="inspector-dolt-artifact-facts">
        <strong>{asset.type.replaceAll('_', ' ').toUpperCase()}</strong>
        <NotebookMediaMetadata
          className="inspector-dolt-artifact-metadata"
          width={asset.width}
          height={asset.height}
          durationSeconds={asset.duration}
        />
      </div>
      {asset.mediaUrl && (
        <a href={asset.mediaUrl} target="_blank" rel="noreferrer">
          Open media
        </a>
      )}
    </div>
  )
}

function DoltCellTable({
  notebookId,
  cell,
  artifactAssets,
}: {
  notebookId: string
  cell: NotebookCell
  artifactAssets: DoltArtifactAssets
}) {
  const rows = doltCellRows(notebookId, cell)
  const [expandedColumns, setExpandedColumns] = useState<ReadonlySet<string>>(
    new Set(),
  )
  const toggleColumn = (column: string) => {
    setExpandedColumns((current) => {
      const next = new Set(current)
      if (next.has(column)) next.delete(column)
      else next.add(column)
      return next
    })
  }

  return (
    <table className="inspector-dolt-table" aria-label="Raw Dolt cells row">
      <thead>
        <tr>
          <th>Column</th>
          <th>Type</th>
          <th>Raw value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const displayValue = doltCellDisplayValue(row)

          if (displayValue.kind === 'json') {
            return (
              <Fragment key={row.column}>
                <tr className="inspector-dolt-json-meta">
                  <th scope="row">{row.column}</th>
                  <td>{row.type}</td>
                  <td><code className="dolt-json-kind">JSON</code></td>
                </tr>
                <tr className="inspector-dolt-json-value">
                  <td colSpan={3}>
                    <RichJson
                      value={displayValue.value}
                      ariaLabel={`${row.column} JSON`}
                      artifactAssets={artifactAssets}
                    />
                  </td>
                </tr>
              </Fragment>
            )
          }

          const artifactAsset = displayValue.kind === 'raw'
            && typeof displayValue.value === 'string'
            ? artifactAssets.get(displayValue.value)
            : undefined

          if (artifactAsset) {
            const expanded = expandedColumns.has(row.column)
            return (
              <Fragment key={row.column}>
                <tr
                  className={expanded
                    ? 'inspector-dolt-artifact-meta'
                    : undefined}
                >
                  <th scope="row">{row.column}</th>
                  <td>{row.type}</td>
                  <td>
                    <button
                      type="button"
                      className="inspector-dolt-artifact-toggle"
                      aria-expanded={expanded}
                      onClick={() => toggleColumn(row.column)}
                    >
                      <code>{artifactAsset.artifactId}</code>
                      <ChevronDown size={12} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
                {expanded && (
                  <tr className="inspector-dolt-artifact-value">
                    <td colSpan={3}>
                      <DoltArtifactExpansion asset={artifactAsset} />
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          }

          return (
            <tr key={row.column}>
              <th scope="row">{row.column}</th>
              <td>{row.type}</td>
              <td>
                <code className={displayValue.kind === 'null' ? 'dolt-null' : undefined}>
                  {displayValue.kind === 'null' ? 'NULL' : String(displayValue.value)}
                </code>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export function DoltCellSource({
  notebookId,
  cell,
  artifactAssets,
  heading = true,
}: {
  notebookId: string
  cell: NotebookCell
  artifactAssets: DoltArtifactAssets
  heading?: boolean
}) {
  const table = (
    <DoltCellTable
      notebookId={notebookId}
      cell={cell}
      artifactAssets={artifactAssets}
    />
  )
  if (!heading) return table

  const columnCount = doltCellRows(notebookId, cell).length
  return (
    <section className="inspector-source inspector-dolt-source">
      <header className="inspector-source-meta">
        <span>Dolt source</span>
        <code>cells · {columnCount} columns</code>
      </header>
      {table}
    </section>
  )
}
