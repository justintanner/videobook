import type { GenerationIdentity } from '@/videobook/output-generation'

export function CellGeneratorIdentity({
  identity,
  className,
}: {
  identity: GenerationIdentity
  className: string
}) {
  return (
    <span className={className} title={identity.label}>
      {identity.provider && <span className="cell-generator-provider">{identity.provider}</span>}
      {identity.model && <span className="cell-generator-model">{identity.model}</span>}
    </span>
  )
}
