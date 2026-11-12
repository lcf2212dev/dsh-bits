/**
 * Harness packs: transpile a repository agent harness (GitHub Copilot / Claude
 * Code style: AGENTS.md, `.github/agents`, `.github/skills`,
 * `.github/instructions`, `.github/hooks`, `.github/scripts`, `.mcp.json`) into
 * a self-contained directory owned by the Bits plugin, so teams of bits can
 * carry the harness into sessions of a repository that no longer contains it.
 *
 * A pack keeps the original `.github/` layout (relative links inside skills
 * keep working and scripts find their siblings) under
 * `<botsRoot>/harness/<packId>/`, plus `manifest.json` describing what was
 * found. Markdown is rewritten so commands point at the pack
 * (`node .github/x` → `node <pack>/.github/x`). A few script patches make the
 * harness work from outside the repository; each one is anchored on an exact
 * source string and reported in `manifest.patches` (applied or skipped).
 *
 * Runtime environment shared with the scripts: `DSH_HARNESS_PACK_ROOT=<packDir>`.
 *
 * Node built-ins only, no side effects at import time.
 *
 * @module host/harness
 */

import { execFileSync } from 'node:child_process'
import { existsSync, promises as fs, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/** Pack id syntax (also the directory name). */
export const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Environment variable the patched scripts read to locate the pack. */
export const PACK_ENV = 'DSH_HARNESS_PACK_ROOT'

/** Harness entries copied from the source repository (relative paths). */
const HARNESS_ROOTS = [
  'AGENTS.md',
  'CLAUDE.md',
  '.mcp.json',
  '.github/copilot-instructions.md',
  '.github/harness.json',
  '.github/copilot',
  '.github/agents',
  '.github/skills',
  '.github/instructions',
  '.github/hooks',
  '.github/scripts',
]

/** Never copied even when tracked under a harness root. */
const EXCLUDED = [/(^|\/)node_modules\//, /(^|\/)\.env($|\.)(?!example)/]

const MAX_FILE_BYTES = 2 * 1024 * 1024
const TEXT_EXTENSIONS = new Set(['.md', '.mdx'])

function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/* ------------------------------------------------------------------ */
/* Frontmatter                                                         */
/* ------------------------------------------------------------------ */

const RE_FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/**
 * Minimal YAML-ish frontmatter reader: top-level `key: value` scalars plus the
 * raw block (nested keys such as `hooks:` stay in `raw`).
 *
 * @param {string} text
 * @returns {{ fields: Record<string, string>, raw: string, body: string }}
 */
export function parseFrontmatter(text) {
  const match = RE_FRONTMATTER.exec(text)
  if (!match) return { fields: {}, raw: '', body: text }
  const fields = {}
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([A-Za-z][\w-]*):[ \t]*(.*?)[ \t]*$/.exec(line)
    if (!m || m[2] === '') continue
    fields[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2')
  }
  return { fields, raw: match[1], body: text.slice(match[0].length) }
}

/** `--launches a,b` / `--launches -` from a hook command line; null when absent. */
function launchesOf(raw) {
  const m = /--launches(?:[ \t=]+([^\s'"]*))?/.exec(raw)
  if (!m) return null
  const value = (m[1] || '').trim()
  if (value === '' || value === '-') return []
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

/**
 * Model tier from a qualified model name (`Claude Opus 5.5 (copilot)`,
 * `fable`, `opus`, `sonnet`…). The runtime maps tiers to the profile's models.
 *
 * @param {string} model
 * @returns {{ tier: 'strong' | 'balanced' | 'fast' | null, label: string }}
 */
export function modelTier(model) {
  const text = String(model || '').trim()
  const label = text.replace(/\s*\((copilot|github)\)\s*$/i, '')
  if (/fable|opus|\bstrong\b|\bpro\b/i.test(text)) return { tier: 'strong', label }
  if (/sonnet|balanced|\bmedium\b/i.test(text)) return { tier: 'balanced', label }
  if (/haiku|\bfast\b|\bflash\b|\bmini\b/i.test(text)) return { tier: 'fast', label }
  return { tier: null, label }
}

/* ------------------------------------------------------------------ */
/* Source discovery                                                    */
/* ------------------------------------------------------------------ */

function isExcluded(rel) {
  return EXCLUDED.some((pattern) => pattern.test(rel))
}

/**
 * Harness files of the source repository: tracked files (git) when it is a git
 * checkout, otherwise a directory walk of the harness roots.
 *
 * @param {string} sourceDir absolute
 * @returns {Promise<string[]>} relative POSIX paths
 */
async function harnessFiles(sourceDir) {
  let tracked = null
  try {
    const out = execFileSync('git', ['-C', sourceDir, 'ls-files', '-z', '--', ...HARNESS_ROOTS], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20000,
    })
    tracked = out.split('\0').filter(Boolean)
  } catch {
    tracked = null
  }
  const files = []
  if (tracked !== null) {
    for (const rel of tracked) {
      if (isExcluded(rel)) continue
      // Tracked but deleted in the working tree: skip (nothing to copy).
      if (existsSync(path.join(sourceDir, rel))) files.push(rel)
    }
    return files.sort()
  }
  async function walk(rel) {
    const abs = path.join(sourceDir, rel)
    let info
    try {
      info = await fs.stat(abs)
    } catch {
      return
    }
    if (info.isFile()) {
      if (!isExcluded(rel)) files.push(rel.split(path.sep).join('/'))
      return
    }
    if (!info.isDirectory()) return
    for (const entry of await fs.readdir(abs)) {
      if (entry === 'node_modules') continue
      await walk(path.join(rel, entry))
    }
  }
  for (const root of HARNESS_ROOTS) await walk(root)
  return files.sort()
}

function gitHead(sourceDir) {
  try {
    return execFileSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
    }).trim()
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* Rewrites                                                            */
/* ------------------------------------------------------------------ */

/**
 * Point harness commands and harness file references in Markdown at the pack.
 * Repository paths (packages/, apps/, `.github/workflows`…) stay untouched.
 *
 * @param {string} text
 * @param {string} packDir absolute pack directory
 * @returns {string}
 */
export function rewriteMarkdown(text, packDir) {
  const pack = packDir.split(path.sep).join('/')
  const harnessDirs = '(?:agents|skills|instructions|hooks|scripts|copilot-instructions\\.md|harness\\.json|copilot)'
  return text
    // `node .github/...` (any harness script) → absolute pack path.
    .replace(new RegExp(`(\\bnode\\s+)\\.github/(${harnessDirs})`, 'g'), `$1${pack}/.github/$2`)
    // Backticked or bare references to harness files: `.github/skills/x/SKILL.md`.
    .replace(new RegExp(`(^|[\\s\`(\\["'])\\.github/(${harnessDirs})`, 'gm'), `$1${pack}/.github/$2`)
}

/**
 * One anchored script patch. `from` must occur exactly once in the file.
 *
 * @typedef {{ id: string, file: string, from: string, to: string, why: string }} ScriptPatch
 */

/** Patches that make the DSC-style harness work from outside the repository. */
export const SCRIPT_PATCHES = [
  {
    id: 'guard.packInsideRepo',
    file: '.github/hooks/scripts/guard/paths.cjs',
    from: 'const insideRepo = (abs, repo) =>\n  !!repo && (isInside(repo.top, abs) || isInside(repo.principal, abs));',
    to: 'const insideRepo = (abs, repo) =>\n  (!!process.env.DSH_HARNESS_PACK_ROOT && isInside(process.env.DSH_HARNESS_PACK_ROOT, abs)) ||\n  (!!repo && (isInside(repo.top, abs) || isInside(repo.principal, abs)));',
    why: 'Harness scripts live in the package (outside the repository): running them is not an "outside-the-repository script".',
  },
  {
    id: 'where.packVersion',
    file: '.github/scripts/where.mjs',
    from: "readFileSync(path.join(dir, '.github', 'harness.json'), 'utf8')",
    to: "readFileSync(path.join(process.env.DSH_HARNESS_PACK_ROOT || dir, '.github', 'harness.json'), 'utf8')",
    why: 'The harness version comes from the team pack (the same for the Root and the WTs), not from the tree.',
  },
]

async function applyPatches(packDir, patches) {
  const results = []
  for (const patch of patches) {
    const file = path.join(packDir, patch.file)
    let text
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      results.push({ id: patch.id, file: patch.file, applied: false, reason: 'file missing', why: patch.why })
      continue
    }
    const count = text.split(patch.from).length - 1
    if (count !== 1) {
      results.push({ id: patch.id, file: patch.file, applied: false, reason: `anchor found ${count} time(s)`, why: patch.why })
      continue
    }
    await fs.writeFile(file, text.replace(patch.from, patch.to))
    results.push({ id: patch.id, file: patch.file, applied: true, reason: null, why: patch.why })
  }
  return results
}

/* ------------------------------------------------------------------ */
/* Manifest                                                            */
/* ------------------------------------------------------------------ */

async function readText(file) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

async function collectAgents(packDir, files) {
  const agents = []
  for (const rel of files) {
    const m = /^\.github\/agents\/([^/]+)\.agent\.md$/.exec(rel)
    if (!m) continue
    const text = await readText(path.join(packDir, rel))
    if (text === null) continue
    const { fields, raw, body } = parseFrontmatter(text)
    const tier = modelTier(fields.model)
    agents.push({
      name: fields.name || m[1],
      description: fields.description || '',
      model: tier.label,
      tier: tier.tier,
      effort: fields['reasoning-effort'] || fields.effort || '',
      readOnly: /--read-only\b/.test(raw),
      launches: launchesOf(raw),
      userInvocable: fields['user-invocable'] !== 'false',
      skills: skillsLine(body),
      path: rel,
      instructions: body.trim(),
    })
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name))
}

/** Skill names from a `**Skills:** read [`x`](../skills/x/SKILL.md) first` line. */
function skillsLine(body) {
  const line = body.split(/\r?\n/).find((item) => /^\*\*Skills:\*\*/.test(item.trim()))
  if (!line) return []
  const names = []
  const re = /skills\/([a-z0-9-]+)\/SKILL\.md/g
  let m
  while ((m = re.exec(line)) !== null) if (!names.includes(m[1])) names.push(m[1])
  return names
}

async function collectSkills(packDir, files) {
  const skills = []
  for (const rel of files) {
    const m = /^\.github\/skills\/([^/]+)\/SKILL\.md$/.exec(rel)
    if (!m) continue
    const text = await readText(path.join(packDir, rel))
    if (text === null) continue
    const { fields, body } = parseFrontmatter(text)
    const dir = path.posix.dirname(rel)
    skills.push({
      name: fields.name || m[1],
      description: fields.description || '',
      argumentHint: fields['argument-hint'] || '',
      path: rel,
      dir,
      readsFirst: skillsLine(body),
      resources: files.filter((item) => item.startsWith(dir + '/') && item !== rel),
    })
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

async function collectInstructions(packDir, files) {
  const instructions = []
  for (const rel of files) {
    const m = /^\.github\/instructions\/([^/]+)\.instructions\.md$/.exec(rel)
    if (!m) continue
    const text = await readText(path.join(packDir, rel))
    if (text === null) continue
    const { fields } = parseFrontmatter(text)
    instructions.push({
      name: fields.name || m[1],
      description: fields.description || '',
      applyTo: String(fields.applyTo || '').split(',').map((item) => item.trim()).filter(Boolean),
      path: rel,
    })
  }
  return instructions.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * MCP servers of `.mcp.json` with harness script paths pointed at the pack.
 *
 * @param {string} packDir
 * @returns {Promise<Record<string, any>>}
 */
async function collectMcp(packDir) {
  const text = await readText(path.join(packDir, '.mcp.json'))
  if (text === null) return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  const servers = parsed && typeof parsed.mcpServers === 'object' && parsed.mcpServers !== null ? parsed.mcpServers : {}
  const out = {}
  for (const [name, server] of Object.entries(servers)) {
    if (!server || typeof server !== 'object') continue
    const copy = JSON.parse(JSON.stringify(server))
    if (Array.isArray(copy.args)) {
      copy.args = copy.args.map((arg) => (typeof arg === 'string' && arg.startsWith('.github/') ? path.join(packDir, arg) : arg))
    }
    out[name] = copy
  }
  return out
}

function harnessVersion(packDir) {
  try {
    const value = JSON.parse(readFileSync(path.join(packDir, '.github', 'harness.json'), 'utf8')).versao
    return Number.isSafeInteger(value) ? value : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* Transpile                                                           */
/* ------------------------------------------------------------------ */

/**
 * Copy and transpile the harness of `sourceDir` into `<packsRoot>/<packId>/`.
 * Replaces an existing pack atomically (staging directory + rename).
 *
 * @param {{ sourceDir: string, packsRoot: string, packId: string, name?: string, patches?: ScriptPatch[], now?: () => Date }} options
 * @returns {Promise<Record<string, any>>} the manifest
 */
export async function transpileHarness({ sourceDir, packsRoot, packId, name, patches = SCRIPT_PATCHES, now = () => new Date() }) {
  if (typeof sourceDir !== 'string' || !path.isAbsolute(sourceDir)) {
    throw codedError('HARNESS_INVALID_SOURCE', 'sourceDir must be an absolute path')
  }
  if (!PACK_ID_PATTERN.test(String(packId))) throw codedError('HARNESS_INVALID_ID', `invalid pack id "${packId}"`)
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    throw codedError('HARNESS_INVALID_SOURCE', `source directory not found: ${sourceDir}`)
  }
  const files = await harnessFiles(sourceDir)
  if (!files.some((rel) => rel === 'AGENTS.md' || rel.startsWith('.github/agents/') || rel.startsWith('.github/skills/'))) {
    throw codedError('HARNESS_NOT_FOUND', `no harness (AGENTS.md, .github/agents or .github/skills) in ${sourceDir}`)
  }

  await fs.mkdir(packsRoot, { recursive: true, mode: 0o700 })
  const packDir = path.join(packsRoot, packId)
  const staging = path.join(packsRoot, `.${packId}.staging-${process.pid}-${Date.now()}`)
  await fs.rm(staging, { recursive: true, force: true })
  await fs.mkdir(staging, { recursive: true, mode: 0o700 })

  let bytes = 0
  const skipped = []
  for (const rel of files) {
    const from = path.join(sourceDir, rel)
    const to = path.join(staging, rel)
    let info
    try {
      info = await fs.stat(from)
    } catch {
      continue
    }
    if (!info.isFile() || info.size > MAX_FILE_BYTES) {
      skipped.push(rel)
      continue
    }
    await fs.mkdir(path.dirname(to), { recursive: true })
    if (TEXT_EXTENSIONS.has(path.extname(rel))) {
      const text = await fs.readFile(from, 'utf8')
      await fs.writeFile(to, rewriteMarkdown(text, packDir))
    } else {
      await fs.copyFile(from, to)
      // Keep the executable bit of shims and scripts.
      if (info.mode & 0o111) await fs.chmod(to, info.mode & 0o777)
    }
    bytes += info.size
  }

  const patchResults = await applyPatches(staging, patches)
  // Manifest paths/contents are read from staging but describe the final location.
  const manifest = {
    format: 'dsh-bits-harness',
    formatVersion: 1,
    id: packId,
    name: name || path.basename(sourceDir),
    source: { dir: sourceDir, commit: gitHead(sourceDir) },
    packDir,
    env: { [PACK_ENV]: packDir },
    harnessVersion: harnessVersion(staging),
    createdAt: now().toISOString(),
    files: files.length - skipped.length,
    bytes,
    skipped,
    rules: existsSync(path.join(staging, 'AGENTS.md')) ? 'AGENTS.md' : null,
    conduct: existsSync(path.join(staging, '.github/copilot-instructions.md')) ? '.github/copilot-instructions.md' : null,
    agents: await collectAgents(staging, files),
    skills: await collectSkills(staging, files),
    instructions: await collectInstructions(staging, files),
    mcp: await collectMcp(staging),
    hooks: {
      guard: existsSync(path.join(staging, '.github/hooks/scripts/git-guard.cjs')) ? '.github/hooks/scripts/git-guard.cjs' : null,
      gitInstaller: existsSync(path.join(staging, '.github/hooks/git/install.mjs')) ? '.github/hooks/git/install.mjs' : null,
    },
    patches: patchResults,
  }
  // MCP args were resolved against staging; point them at the final directory.
  manifest.mcp = JSON.parse(JSON.stringify(manifest.mcp).split(staging).join(packDir))
  await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })

  const previous = path.join(packsRoot, `.${packId}.previous-${process.pid}-${Date.now()}`)
  const hadPrevious = existsSync(packDir)
  if (hadPrevious) await fs.rename(packDir, previous)
  try {
    await fs.rename(staging, packDir)
  } catch (error) {
    if (hadPrevious) await fs.rename(previous, packDir).catch(() => {})
    throw error
  }
  if (hadPrevious) await fs.rm(previous, { recursive: true, force: true })
  return manifest
}

/**
 * Read a pack manifest; null when missing or invalid.
 *
 * @param {string} packsRoot
 * @param {string} packId
 * @returns {Promise<Record<string, any> | null>}
 */
export async function readPack(packsRoot, packId) {
  if (!PACK_ID_PATTERN.test(String(packId))) return null
  const text = await readText(path.join(packsRoot, packId, 'manifest.json'))
  if (text === null) return null
  try {
    const manifest = JSON.parse(text)
    return manifest && manifest.format === 'dsh-bits-harness' ? manifest : null
  } catch {
    return null
  }
}

/**
 * List pack manifests under `packsRoot` (ignores staging leftovers).
 *
 * @param {string} packsRoot
 * @returns {Promise<Record<string, any>[]>}
 */
export async function listPacks(packsRoot) {
  let entries = []
  try {
    entries = await fs.readdir(packsRoot)
  } catch {
    return []
  }
  const packs = []
  for (const entry of entries.sort()) {
    if (entry.startsWith('.')) continue
    const manifest = await readPack(packsRoot, entry)
    if (manifest) packs.push(manifest)
  }
  return packs
}
