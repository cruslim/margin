// Builds Margin and installs the unsigned app locally for the current platform.
import { execSync } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const flags = { darwin: '--mac', win32: '--win', linux: '--linux' }
const flag = flags[process.platform]
if (!flag) {
  console.error(`install-app: unsupported platform ${process.platform}`)
  process.exit(1)
}

const run = (cmd) => execSync(cmd, { stdio: 'inherit' })

run('electron-vite build')
run(`electron-builder ${flag}`)

// electron-builder's dir target names the output by platform and arch
// (mac-arm64, win-unpacked, linux-arm64-unpacked, ...), so match by pattern.
const findOutput = (pattern) => {
  const match = readdirSync('dist').find((name) => pattern.test(name))
  if (!match) throw new Error(`install-app: no ${pattern} directory under dist/`)
  return join('dist', match)
}

if (process.platform === 'darwin') {
  const dest = join(homedir(), 'Applications', 'Margin.app')
  rmSync(dest, { recursive: true, force: true })
  // ditto preserves bundle metadata that a plain copy can drop
  run(`ditto "${join(findOutput(/^mac(-|$)/), 'Margin.app')}" "${dest}"`)
  console.log(`Installed ${dest}`)
} else if (process.platform === 'win32') {
  const dest = join(
    process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
    'Programs',
    'Margin'
  )
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  cpSync(findOutput(/^win.*-unpacked$/), dest, { recursive: true })
  console.log(`Installed ${join(dest, 'Margin.exe')}`)
} else {
  const dest = join(homedir(), '.local', 'opt', 'margin')
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  cpSync(findOutput(/^linux.*-unpacked$/), dest, { recursive: true })
  const bin = join(homedir(), '.local', 'bin')
  mkdirSync(bin, { recursive: true })
  const link = join(bin, 'margin')
  rmSync(link, { force: true })
  symlinkSync(join(dest, 'margin'), link)
  console.log(`Installed ${dest} (launcher: ${link})`)
}

rmSync('dist', { recursive: true, force: true })
