/**
 * Route-level test for the host half: give `apply()` a fake cordis context,
 * capture the registered routes, then drive them with stub HTTP objects.
 *
 *   node tests/routes.test.mjs
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { apply } from '../lib/index.js'

const home = join(tmpdir(), 'dsh-session-delete-routes-' + process.pid)
process.env.DSH_HOME = home

const workspace = '--E-route-test--'
const sessionId = '99999999-8888-7777-6666-555555555555'
const dirName = 'session-' + sessionId
const sessionDir = join(home, 'sessions', workspace, dirName)

/**
 * Build a request stub carrying an optional JSON body.
 * @param {'GET'|'POST'} method - HTTP method.
 * @param {object} [body] - JSON body.
 * @param {object} [headers] - extra headers.
 * @param {string} [remoteAddress] - peer address, loopback by default.
 * @returns {any} request-ish emitter.
 */
function request(method, body, headers = {}, remoteAddress = '127.0.0.1') {
  const req = new EventEmitter()
  req.method = method
  req.headers = { ...headers }
  req.socket = { remoteAddress }
  const payload = body === undefined ? '' : JSON.stringify(body)
  process.nextTick(() => {
    if (payload) req.emit('data', Buffer.from(payload, 'utf8'))
    req.emit('end')
  })
  req.destroy = () => {}
  return req
}

/**
 * Build a response stub capturing status and JSON body.
 * @returns {any} response-ish object.
 */
function response() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      res.status = status
      res.headers = headers ?? {}
      return res
    },
    end(chunk) {
      if (chunk) res.body += chunk
      res.json = (() => { try { return JSON.parse(res.body) } catch { return null } })()
    },
  }
  return res
}

/**
 * Call one captured route and wait for the response to settle.
 * @param {any} spec - registered route spec.
 * @param {any} req - request stub.
 * @param {any} res - response stub.
 * @returns {Promise<void>} resolves when the handler completed.
 */
async function call(spec, req, res) {
  spec.handler(req, res)
  await new Promise((resolve) => setTimeout(resolve, 30))
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
await fs.mkdir(sessionDir, { recursive: true })
await fs.writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'payload', 'utf8')

/** @type {Array<{kind: string, path: string, handler: Function}>} */
const registered = []
const ctx = {
  webServer: {
    register(spec) {
      registered.push(spec)
      return () => {}
    },
  },
  effect(fn) {
    return fn()
  },
}

apply(ctx)

/**
 * Find a registered route by suffix.
 * @param {string} suffix - path tail.
 * @returns {any} the route spec.
 */
const route = (suffix) => registered.find((entry) => entry.path === '/api/session-delete' + suffix)

await test('apply registers five exact routes under /api/session-delete', () => {
  assert.equal(registered.length, 5)
  for (const spec of registered) {
    assert.equal(spec.kind, 'exact')
    assert.ok(spec.path.startsWith('/api/session-delete/'))
  }
  for (const suffix of ['/list', '/trash', '/delete', '/restore', '/purge']) {
    assert.ok(route(suffix), 'missing route ' + suffix)
  }
})

const HEADER = { 'x-dsh-session-delete': '1' }

await test('GET /list returns the seeded session', async () => {
  const res = response()
  await call(route('/list'), request('GET', undefined, HEADER), res)
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.sessions.length, 1)
  assert.equal(res.json.sessions[0].sessionId, sessionId)
})

await test('GET without the action header is refused', async () => {
  // Regression: exact routes sit ahead of the host's auth fence, so a plain
  // GET used to answer 200 to any local process.
  const res = response()
  await call(route('/list'), request('GET'), res)
  assert.equal(res.status, 403)
  assert.equal(res.json.code, 'forbidden')
})

await test('a non-loopback peer is refused', async () => {
  const res = response()
  await call(route('/list'), request('GET', undefined, HEADER, '10.1.2.3'), res)
  assert.equal(res.status, 403)
  assert.equal(res.json.error, '仅允许本机访问')
})

await test('an IPv4-mapped loopback peer is accepted', async () => {
  const res = response()
  await call(route('/list'), request('GET', undefined, HEADER, '::ffff:127.0.0.1'), res)
  assert.equal(res.status, 200)
})

await test('POST /delete without the guard header is refused', async () => {
  const res = response()
  await call(route('/delete'), request('POST', { sessionId }), res)
  assert.equal(res.status, 403)
  assert.equal(res.json.ok, false)
  assert.equal(existsSync(sessionDir), true)
})

await test('GET on a POST route is refused with 405', async () => {
  const res = response()
  await call(route('/delete'), request('GET'), res)
  assert.equal(res.status, 405)
})

await test('POST /delete moves the session to the trash', async () => {
  const res = response()
  await call(route('/delete'), request('POST', { sessionId }, HEADER), res)
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.ok(res.json.trashId)
  assert.equal(existsSync(sessionDir), false)
})

await test('GET /trash lists the entry, POST /restore puts it back', async () => {
  const trashRes = response()
  await call(route('/trash'), request('GET', undefined, HEADER), trashRes)
  assert.equal(trashRes.json.entries.length, 1)
  const restoreRes = response()
  await call(route('/restore'), request('POST', { trashId: trashRes.json.entries[0].trashId }, HEADER), restoreRes)
  assert.equal(restoreRes.status, 200)
  assert.equal(restoreRes.json.workspace, workspace)
  assert.equal(existsSync(join(sessionDir, 'session.v4.jsonl.zstd')), true)
})

await test('POST /delete with mode purge leaves nothing behind', async () => {
  const res = response()
  await call(route('/delete'), request('POST', { sessionId, mode: 'purge' }, HEADER), res)
  assert.equal(res.status, 200)
  assert.equal(res.json.purged, true)
  const trashRes = response()
  await call(route('/trash'), request('GET', undefined, HEADER), trashRes)
  assert.equal(trashRes.json.entries.length, 0)
})

await test('deleting an unknown session is a 404', async () => {
  const res = response()
  await call(route('/delete'), request('POST', { sessionId }, HEADER), res)
  assert.equal(res.status, 404)
  assert.equal(res.json.code, 'not-found')
})

await test('a malformed body is a 400, not a crash', async () => {
  const req = new EventEmitter()
  req.method = 'POST'
  req.headers = HEADER
  req.socket = { remoteAddress: '127.0.0.1' }
  req.destroy = () => {}
  const res = response()
  route('/delete').handler(req, res)
  process.nextTick(() => {
    req.emit('data', Buffer.from('{not json', 'utf8'))
    req.emit('end')
  })
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(res.status, 400)
})

await test('without DSH_HOME the routes fall back to ~/.dsh instead of throwing', async () => {
  // Regression: the desktop main process does not export DSH_HOME. Reading it
  // eagerly produced `home = undefined`, and path.join(undefined, 'sessions')
  // answered every request with ERR_INVALID_ARG_TYPE.
  const saved = process.env.DSH_HOME
  delete process.env.DSH_HOME
  try {
    const res = response()
    await call(route('/list'), request('GET', undefined, HEADER), res)
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
    assert.equal(typeof res.json.home, 'string')
    assert.ok(res.json.home.toLowerCase().endsWith('.dsh'), 'fallback home was ' + res.json.home)
  } finally {
    process.env.DSH_HOME = saved
  }
})

await fs.rm(home, { recursive: true, force: true })
delete process.env.DSH_HOME

if (failures > 0) {
  console.log('\n' + failures + ' test(s) failed')
  process.exitCode = 1
} else {
  console.log('\nall tests passed')
}
