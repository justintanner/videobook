import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const [version, file] = process.argv.slice(2)
if (!version) {
  process.stderr.write('Usage: changelog-section.mjs <version> [changelog]\n')
  process.exit(2)
}
const path = file ?? fileURLToPath(new URL('../server/CHANGELOG.md', import.meta.url))
const changelog = await readFile(path, 'utf8')
const heading = new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\][^\\n]*$`, 'mu').exec(changelog)
if (!heading) {
  process.stderr.write(`${path} has no "## [${version}]" section\n`)
  process.exit(1)
}
const rest = changelog.slice(heading.index + heading[0].length)
const next = rest.search(/^## \[/mu)
const section = (next === -1 ? rest : rest.slice(0, next)).trim()
if (!section) {
  process.stderr.write(`The "## [${version}]" section in ${path} is empty\n`)
  process.exit(1)
}
process.stdout.write(`${section}\n`)
