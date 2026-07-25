export type MvpGate = 'G0' | 'G1' | 'G2' | 'G3' | 'G4' | 'G5'

const PREFIX_GATES: Record<string, MvpGate> = {
  SRC: 'G1',
  ING: 'G1',
  NBK: 'G2',
  CMD: 'G3',
  EDT: 'G4',
  AI: 'G4',
  EXP: 'G4',
  NFR: 'G5',
}

export function gateForRequirement(requirementId: string): MvpGate {
  const match = requirementId.match(/^VB-([A-Z]+)-\d+$/)
  const gate = match ? PREFIX_GATES[match[1]!] : undefined
  if (!gate) throw new Error(`Unmapped MVP requirement: ${requirementId}`)
  return gate
}
