import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

try {
  process.stdin.setEncoding('utf8')
  let payload = ''
  for await (const chunk of process.stdin) payload += chunk
  const input = JSON.parse(payload)
  const file = input?.tool_input?.file_path
  if (['Edit', 'Write'].includes(input?.tool_name) && typeof file === 'string' && isAbsolute(file)) {
    const root = await realpath(fileURLToPath(new URL('../', import.meta.url)))
    const inside = (path) => {
      const local = relative(root, path)
      return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)
    }
    const path = await realpath(file)
    if (inside(resolve(file)) && inside(path) && /\.(ts|tsx)$/.test(path) && (await stat(path)).isFile()) {
      const { ESLint } = await import(pathToFileURL(resolve(root, 'node_modules/eslint/lib/api.js')).href)
      const eslint = new ESLint({ cwd: root, fix: true, globInputPaths: false })
      if (!(await eslint.isPathIgnored(path))) {
        await ESLint.outputFixes(await eslint.lintFiles([path]))
      }
    }
  }
} catch {}
