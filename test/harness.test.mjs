/**
 * Tests for the harness transpiler (`host/harness.js`): a fixture repository
 * with a Copilot-style harness is transpiled into a pack; checks the manifest,
 * the Markdown rewrites, the anchored script patches and atomic replacement.
 * When the real DSC harness is available (DSC_HARNESS_SOURCE or the default
 * path), it is transpiled too and its guard is exercised from the pack.
 *
 * Plain `node test/harness.test.mjs`; Node built-ins only.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { listPacks, modelTier, parseFrontmatter, readPack, rewriteMarkdown, transpileHarness } from '../host/harness.js'

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok - ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

const temps = []
async function tempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  temps.push(dir)
  return dir
}

async function write(root, rel, text) {
  const file = path.join(root, rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}

async function fixtureRepo() {
  const repo = await tempDir('dsh-bits-harness-src-')
  await write(repo, 'AGENTS.md', '# Regras\n\nRode `node .github/scripts/where.mjs --card <n>` antes.\nVeja `.github/skills/tdd/SKILL.md` e `packages/ui/src`.\n')
  await write(repo, '.github/harness.json', '{ "versao": 7 }\n')
  await write(repo, '.github/copilot-instructions.md', '# Conduta\n')
  await write(repo, '.github/agents/scout.agent.md', [
    '---', 'name: scout', 'description: Localiza.', 'model: Claude Haiku 5.5 (copilot)', 'reasoning-effort: low', 'user-invocable: false',
    'hooks:', '  PreToolUse:', '    - type: command', '      command: node .github/hooks/scripts/git-guard.cjs --read-only --launches -', '---', '', '# Scout', '', 'Busca.', '',
  ].join('\n'))
  await write(repo, '.github/agents/builder.agent.md', [
    '---', 'name: builder', 'description: Implementa.', 'model: Claude Sonnet 5.5 (copilot)', 'reasoning-effort: medium',
    'hooks:', '  PreToolUse:', '    - type: command', '      command: node .github/hooks/scripts/git-guard.cjs --launches scout', '---', '',
    '**Skills:** leia antes a [`tdd`](../skills/tdd/SKILL.md).', '', 'Código.', '',
  ].join('\n'))
  await write(repo, '.github/skills/tdd/SKILL.md', '---\nname: tdd\ndescription: Teste antes.\n---\n\n# TDD\n\nRode `node .github/skills/tdd/scripts/run.mjs`.\n')
  await write(repo, '.github/skills/tdd/scripts/run.mjs', 'console.log("ok")\n')
  await write(repo, '.github/instructions/ui.instructions.md', "---\nname: ui\ndescription: UI.\napplyTo: '**/packages/ui/**/*.ts,**/packages/ui/**/*.tsx'\n---\n\n# UI\n")
  await write(repo, '.github/scripts/where.mjs', "const v = readFileSync(path.join(dir, '.github', 'harness.json'), 'utf8')\n")
  await write(repo, '.github/workflows/ci.yml', 'name: ci\n')
  await write(repo, '.mcp.json', JSON.stringify({ mcpServers: { files: { type: 'stdio', command: 'node', args: ['.github/scripts/mcp-files.mjs'] } } }))
  await write(repo, 'packages/ui/src/index.ts', 'export {}\n')
  await write(repo, '.env', 'SECRET=1\n')
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'add', '-A'])
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
  return repo
}

await test('parseFrontmatter and modelTier', () => {
  const parsed = parseFrontmatter('---\nname: x\nmodel: "Claude Opus 5.5 (copilot)"\nhooks:\n  a: b\n---\nbody\n')
  assert.equal(parsed.fields.name, 'x')
  assert.equal(parsed.fields.model, 'Claude Opus 5.5 (copilot)')
  assert.equal(parsed.body, 'body\n')
  assert.deepEqual(modelTier('Claude Opus 5.5 (copilot)'), { tier: 'strong', label: 'Claude Opus 5.5' })
  assert.equal(modelTier('Claude Sonnet 5.5').tier, 'balanced')
  assert.equal(modelTier('haiku').tier, 'fast')
  assert.equal(modelTier('').tier, null)
})

await test('rewriteMarkdown points harness commands and files at the pack only', () => {
  const out = rewriteMarkdown('Rode `node .github/scripts/where.mjs`. Leia `.github/skills/x/SKILL.md`. Não toque `.github/workflows/ci.yml` nem packages/.', '/p')
  assert.match(out, /`node \/p\/\.github\/scripts\/where\.mjs`/)
  assert.match(out, /`\/p\/\.github\/skills\/x\/SKILL\.md`/)
  assert.match(out, /`\.github\/workflows\/ci\.yml`/)
})

await test('transpileHarness builds the pack, manifest, rewrites and patches', async () => {
  const repo = await fixtureRepo()
  const packsRoot = await tempDir('dsh-bits-packs-')
  const patches = [
    { id: 'where', file: '.github/scripts/where.mjs', from: "path.join(dir, '.github', 'harness.json')", to: "path.join(process.env.DSH_HARNESS_PACK_ROOT || dir, '.github', 'harness.json')", why: 'x' },
    { id: 'missing', file: '.github/nope.cjs', from: 'a', to: 'b', why: 'y' },
  ]
  const manifest = await transpileHarness({ sourceDir: repo, packsRoot, packId: 'demo', name: 'Demo', patches })
  const pack = path.join(packsRoot, 'demo')
  assert.equal(manifest.packDir, pack)
  assert.equal(manifest.harnessVersion, 7)
  assert.equal(manifest.rules, 'AGENTS.md')
  assert.equal(manifest.conduct, '.github/copilot-instructions.md')
  assert.deepEqual(manifest.agents.map((agent) => [agent.name, agent.tier, agent.effort, agent.readOnly, agent.launches]), [
    ['builder', 'balanced', 'medium', false, ['scout']],
    ['scout', 'fast', 'low', true, []],
  ])
  assert.deepEqual(manifest.agents[0].skills, ['tdd'])
  assert.equal(manifest.agents[1].userInvocable, false)
  assert.deepEqual(manifest.skills.map((skill) => [skill.name, skill.resources]), [['tdd', ['.github/skills/tdd/scripts/run.mjs']]])
  assert.deepEqual(manifest.instructions[0].applyTo, ['**/packages/ui/**/*.ts', '**/packages/ui/**/*.tsx'])
  assert.deepEqual(manifest.mcp.files.args, [path.join(pack, '.github/scripts/mcp-files.mjs')])
  assert.deepEqual(manifest.patches.map((patch) => [patch.id, patch.applied]), [['where', true], ['missing', false]])
  // Copied files, exclusions and rewrites.
  assert.equal(existsSync(path.join(pack, '.github/workflows/ci.yml')), false, 'CI is not harness')
  assert.equal(existsSync(path.join(pack, 'packages')), false)
  assert.equal(existsSync(path.join(pack, '.env')), false)
  const rules = await fs.readFile(path.join(pack, 'AGENTS.md'), 'utf8')
  assert.match(rules, new RegExp(`node ${pack.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.github/scripts/where\\.mjs`))
  assert.match(rules, /`packages\/ui\/src`/)
  const where = await fs.readFile(path.join(pack, '.github/scripts/where.mjs'), 'utf8')
  assert.match(where, /DSH_HARNESS_PACK_ROOT/)
  assert.equal((await readPack(packsRoot, 'demo')).id, 'demo')
  assert.deepEqual((await listPacks(packsRoot)).map((item) => item.id), ['demo'])
})

await test('transpileHarness replaces an existing pack atomically and validates input', async () => {
  const repo = await fixtureRepo()
  const packsRoot = await tempDir('dsh-bits-packs-')
  await transpileHarness({ sourceDir: repo, packsRoot, packId: 'demo', patches: [] })
  await fs.writeFile(path.join(packsRoot, 'demo', 'stale.txt'), 'x')
  await write(repo, 'AGENTS.md', '# Regras v2\n')
  await transpileHarness({ sourceDir: repo, packsRoot, packId: 'demo', patches: [] })
  assert.equal(existsSync(path.join(packsRoot, 'demo', 'stale.txt')), false)
  assert.match(await fs.readFile(path.join(packsRoot, 'demo', 'AGENTS.md'), 'utf8'), /v2/)
  assert.deepEqual((await fs.readdir(packsRoot)).filter((entry) => entry.startsWith('.')), [])
  await assert.rejects(transpileHarness({ sourceDir: 'relative', packsRoot, packId: 'x' }), { code: 'HARNESS_INVALID_SOURCE' })
  await assert.rejects(transpileHarness({ sourceDir: repo, packsRoot, packId: 'Bad Id' }), { code: 'HARNESS_INVALID_ID' })
  const empty = await tempDir('dsh-bits-empty-')
  await assert.rejects(transpileHarness({ sourceDir: empty, packsRoot, packId: 'x' }), { code: 'HARNESS_NOT_FOUND' })
})

const DSC = process.env.DSC_HARNESS_SOURCE || path.join(os.homedir(), 'Development/work/dsc')
if (existsSync(path.join(DSC, '.github/hooks/scripts/git-guard.cjs'))) {
  await test('real DSC harness: transpiles, patches apply and the guard runs from the pack', async () => {
    const packsRoot = await tempDir('dsh-bits-packs-dsc-')
    const manifest = await transpileHarness({ sourceDir: DSC, packsRoot, packId: 'dsc', name: 'DSC' })
    assert.ok(manifest.agents.length >= 10)
    assert.ok(manifest.skills.length >= 15)
    assert.ok(manifest.patches.every((patch) => patch.applied), JSON.stringify(manifest.patches))
    const guard = path.join(manifest.packDir, manifest.hooks.guard)
    const decide = (command, flags = []) => {
      const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: DSC }
      const result = spawnSync(process.execPath, [guard, ...flags], {
        input: JSON.stringify(event), encoding: 'utf8', env: { ...process.env, DSH_HARNESS_PACK_ROOT: manifest.packDir }, timeout: 15000,
      })
      return result.status
    }
    assert.equal(decide('git stash'), 2)
    assert.equal(decide('git push --force origin x'), 2)
    assert.equal(decide('ls -la'), 0)
    assert.equal(decide(`node ${manifest.packDir}/.github/scripts/where.mjs --card 1`, ['--read-only']), 0, 'pack scripts are trusted')
    assert.equal(decide('yarn test Button', ['--read-only']), 2)
  })
}

for (const dir of temps) await fs.rm(dir, { recursive: true, force: true })
if (failures.length > 0) {
  console.error(`\nharness: ${failures.length} failed, ${passed} passed`)
  process.exitCode = 1
} else {
  console.log(`\nharness: ${passed} tests passed`)
}
