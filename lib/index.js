/**
 * dsh-session-delete — host half.
 *
 * Registers four exact routes on the profile's web server so the browser half
 * can list, delete (to trash), restore, and purge sessions:
 *
 *   GET  /api/session-delete/list            sessions on disk
 *   GET  /api/session-delete/trash           trash entries
 *   POST /api/session-delete/delete          { sessionId }            move to trash
 *   POST /api/session-delete/restore         { trashId }              put it back
 *   POST /api/session-delete/purge           { trashId }              irreversible
 *
 * Mutations require the `x-dsh-session-delete: 1` header. A cross-origin page
 * cannot set a custom header without a CORS preflight, and these routes never
 * grant CORS, so the header is a cheap CSRF fence on top of the app's own
 * session auth.
 *
 * @module dsh-session-delete
 */

import {
  listSessions,
  listTrash,
  moveToTrash,
  purgeTrash,
  restoreFromTrash,
} from './host.js'

/** Services this plugin needs before it activates. */
export const inject = ['webServer']

/** Route prefix. Exact routes under `/api` win over the RPC fallback. */
const PREFIX = '/api/session-delete'

/** Header that marks a same-page mutation request. */
const ACTION_HEADER = 'x-dsh-session-delete'

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {object} body - JSON body.
 * @returns {void}
 */
function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * Read and parse a small JSON request body.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {number} [limit] - maximum accepted bytes.
 * @returns {Promise<object>} the parsed body.
 */
function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { code: 'bad-request' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { code: 'bad-request' }))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Map a domain error onto a response.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {unknown} error - thrown value.
 * @returns {void}
 */
function fail(res, error) {
  const err = /** @type {{code?: string, message?: string}} */ (error)
  const code = err?.code ?? 'io'
  const status = code === 'bad-request' ? 400
    : code === 'not-found' ? 404
      : code === 'in-use' || code === 'conflict' ? 409
        : 500
  send(res, status, { ok: false, code, error: err?.message ?? String(error) })
}

/**
 * Reject a request whose method or guard header does not match.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {'GET'|'POST'} method - required method.
 * @returns {boolean} true when the request may proceed.
 */
function guard(req, res, method) {
  if ((req.method ?? 'GET') !== method) {
    send(res, 405, { ok: false, code: 'method', error: '仅支持 ' + method })
    return false
  }
  if (method === 'POST' && req.headers[ACTION_HEADER] !== '1') {
    send(res, 403, { ok: false, code: 'forbidden', error: '缺少 ' + ACTION_HEADER + ' 请求头' })
    return false
  }
  return true
}

/**
 * Mount the plugin's routes.
 * @param {any} ctx - cordis context carrying `webServer`.
 * @returns {void}
 */
export function apply(ctx) {
  /** @type {string} */
  const home = process.env.DSH_HOME?.trim() || ''

  const route = (path, method, handler, label) => {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: PREFIX + path,
      handler: (req, res) => {
        if (!guard(req, res, method)) return
        Promise.resolve(handler(req, res)).catch((error) => fail(res, error))
      },
    }), label)
  }

  route('/list', 'GET', async (_req, res) => {
    const sessions = await listSessions(home || undefined)
    send(res, 200, { ok: true, home: home || undefined, sessions })
  }, 'session-delete: list')

  route('/trash', 'GET', async (_req, res) => {
    const entries = await listTrash(home || undefined)
    send(res, 200, { ok: true, entries })
  }, 'session-delete: trash')

  route('/delete', 'POST', async (req, res) => {
    const body = await readJson(req)
    const receipt = await moveToTrash(home || undefined, body.sessionId)
    if (body.mode === 'purge') {
      await purgeTrash(home || undefined, receipt.trashId)
      send(res, 200, { ok: true, purged: true, ...receipt })
      return
    }
    send(res, 200, { ok: true, ...receipt })
  }, 'session-delete: delete')

  route('/restore', 'POST', async (req, res) => {
    const body = await readJson(req)
    const receipt = await restoreFromTrash(home || undefined, body.trashId)
    send(res, 200, { ok: true, ...receipt })
  }, 'session-delete: restore')

  route('/purge', 'POST', async (req, res) => {
    const body = await readJson(req)
    const receipt = await purgeTrash(home || undefined, body.trashId)
    send(res, 200, { ok: true, ...receipt })
  }, 'session-delete: purge')
}
