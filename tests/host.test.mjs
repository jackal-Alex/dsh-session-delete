/**
 * Direct filesystem test for the host half. Runs with plain Node, no cordis,
 * no DSH app: it builds a throwaway DSH home, then exercises list → trash →
 * restore → trash → purge and the validation guards.
 *
 *   node tests/host.test.mjs
 */

import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  listSessions,
  listTrash,
  moveToTrash,
  normalizeSessionId,
  purgeTrash,
  restoreFromTrash,
  sessionsRoot,
  trashRoot,
} from '../lib/host.js'

const home = join(tmpdir(), 'dsh-session-delete-test-' + process.pid)
const workspace = '--E-test-workspace--'
const sessionId = '11111111-2222-3333-4444-555555555555'
const dirName = 'session-' + sessionId
const sessionDir = join(sessionsRoot(home), workspace, dirName)

/**
 * Build the fixture: one session directory with a log artifact.
 * @returns {Promise<void>} resolves when the fixture exists.
 */
async function seed() {
  await fs.mkdir(sessionDir, { recursive: true })
  await fs.writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'fake-zstd-payload', 'utf8')
}

let failures = 0

/**
 * Run one assertion group.
 * @param {string} name - test name.
 * @param {() => Promise<void>} body - test body.
 * @returns {Promise<void>} resolves when the test passed.
 */
async function test(name, body) {
  try {
    await body()
    console.log('  ok   ' + name)
  } catch (error) {
    failures++
    console.log('  FAIL ' + name)
    console.log('       ' + (error && error.stack ? error.stack : String(error)))
  }
}

await fs.rm(home, { recursive: true, force: true })
await seed()

await test('listSessions finds the seeded session', async () => {
  const rows = await listSessions(home)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].workspace, workspace)
  assert.equal(rows[0].sessionId, sessionId)
  assert.ok(rows[0].bytes > 0)
})

await test('normalizeSessionId accepts both spellings and rejects traversal', () => {
  assert.equal(normalizeSessionId(sessionId), dirName)
  assert.equal(normalizeSessionId(dirName), dirName)
  assert.throws(() => normalizeSessionId('../../etc/passwd'))
  assert.throws(() => normalizeSessionId('..'))
  assert.throws(() => normalizeSessionId(''))
  assert.throws(() => normalizeSessionId('has space '))
})

await test('delete moves the directory into the trash', async () => {
  const receipt = await moveToTrash(home, sessionId)
  assert.ok(receipt.trashId)
  assert.equal(receipt.workspace, workspace)
  assert.equal(existsSync(sessionDir), false)
  const trashed = join(trashRoot(home), receipt.trashId)
  assert.equal(existsSync(trashed), true)
  assert.equal(existsSync(join(trashed, 'meta.json')), true)
  assert.equal(existsSync(join(trashed, 'session.v4.jsonl.zstd')), true)
})

await test('listSessions no longer sees it, listTrash does', async () => {
  assert.equal((await listSessions(home)).length, 0)
  const entries = await listTrash(home)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].sessionId, sessionId)
  assert.equal(entries[0].workspace, workspace)
})

await test('restore puts it back in its original workspace', async () => {
  const entries = await listTrash(home)
  const receipt = await restoreFromTrash(home, entries[0].trashId)
  assert.equal(receipt.workspace, workspace)
  assert.equal(receipt.sessionId, sessionId)
  assert.equal(existsSync(join(sessionDir, 'session.v4.jsonl.zstd')), true)
  assert.equal((await listTrash(home)).length, 0)
})

await test('delete again, then purge removes it for good', async () => {
  const receipt = await moveToTrash(home, sessionId)
  await purgeTrash(home, receipt.trashId)
  assert.equal(existsSync(join(trashRoot(home), receipt.trashId)), false)
  assert.equal((await listTrash(home)).length, 0)
})

await test('deleting a missing session reports not-found', async () => {
  await assert.rejects(moveToTrash(home, sessionId), (error) => error.code === 'not-found')
})

await test('a bogus trash id cannot escape the trash root', async () => {
  await assert.rejects(restoreFromTrash(home, '../../../etc'), (error) => error.code === 'bad-request')
  await assert.rejects(purgeTrash(home, '..'), (error) => error.code === 'bad-request')
})

await fs.rm(home, { recursive: true, force: true })

if (failures > 0) {
  console.log('\n' + failures + ' test(s) failed')
  process.exitCode = 1
} else {
  console.log('\nall tests passed')
}
