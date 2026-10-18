/**
 * dsh-session-delete — host-side session file operations.
 *
 * DSH's session storage seam has no delete interface by design ("the log
 * accumulates under `root` until removed externally"), and the agent
 * protocol's `session/delete` method only exists for external ACP agents.
 * So a session is deleted the only way it can be: by moving its on-disk
 * directory out of `$DSH_HOME/sessions`.
 *
 * Design rules that keep this safe:
 *  - **Move, never unlink.** Deleting renames the session directory into
 *    `$DSH_HOME/session-trash/`, so every delete is reversible until an
 *    explicit purge. A moved directory also keeps the original workspace
 *    name in a `meta.json`, which is what `restore` reads.
 *  - **Windows is the guard.** A session directory holding the log file of a
 *    session that is still loaded cannot be renamed (sharing violation), so
 *    an in-use session fails instead of being half-removed. That failure is
 *    reported as `in-use`, not as a generic error.
 *  - **Every path stays under `$DSH_HOME`.** Session and trash ids are
 *    validated against a strict pattern and the resolved path is re-checked
 *    before any filesystem call.
 *
 * The module is plain ESM with no cordis dependency, so the same code can be
 * exercised directly by a Node test (see `tests/` in the repository) and by
 * the plugin body in `index.js`.
 *
 * @module dsh-session-delete/host
 */

import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/** Session directory names created by the DSH kernel. */
const SESSION_DIR_RE = /^session-[A-Za-z0-9][A-Za-z0-9._-]*$/
/** A trash entry id: sortable timestamp + random suffix. */
const TRASH_ID_RE = /^\d{8}T\d{6}-\d{3}Z-[A-Za-z0-9]{6}$/
/** Files a session directory may hold. Listed only for diagnostics/bytes. */
export const ARTIFACT_NAMES = [
  'session.v4.jsonl.zstd',
  'session.v3.jsonl.zstd',
  'session.v2.jsonl.zstd',
  'session.jsonl.zstd',
  'session.jsonl',
]

/**
 * The DSH home this process uses.
 * @param {NodeJS.ProcessEnv} [env] - environment to read.
 * @returns {string} absolute DSH home.
 */
export function resolveHome(env = process.env) {
  const fromEnv = env.DSH_HOME?.trim()
  if (fromEnv) return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

/**
 * Root directory holding one subdirectory per workspace.
 * @param {string} home - DSH home.
 * @returns {string} absolute sessions root.
 */
export function sessionsRoot(home) {
  return join(home, 'sessions')
}

/**
 * Root directory holding deleted-but-restorable sessions.
 * @param {string} home - DSH home.
 * @returns {string} absolute trash root.
 */
export function trashRoot(home) {
  return join(home, 'session-trash')
}

/**
 * Assert a path stays inside a root, and return it.
 * @param {string} root - permitted root.
 * @param {string} candidate - path to check.
 * @returns {string} the resolved candidate.
 */
function inside(root, candidate) {
  const r = resolve(root)
  const c = resolve(candidate)
  if (c !== r && !c.startsWith(r + sep)) {
    throw Object.assign(new Error('path escapes its root'), { code: 'bad-request' })
  }
  return c
}

/**
 * Validate a session id as it arrives from the browser and normalise it to the
 * on-disk directory name.
 * @param {string} raw - `session-<uuid>` or a bare id.
 * @returns {string} the directory name.
 */
export function normalizeSessionId(raw) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === '' || /[\\/\x00-\x1f<>"|?*]/.test(value) || /[. ]$/.test(value)) {
    throw Object.assign(new Error('会话标识不合法'), { code: 'bad-request' })
  }
  const dirName = value.startsWith('session-') ? value : `session-${value}`
  if (!SESSION_DIR_RE.test(dirName)) {
    throw Object.assign(new Error('会话标识不合法'), { code: 'bad-request' })
  }
  return dirName
}

/**
 * Validate a trash entry id.
 * @param {string} raw - candidate id.
 * @returns {string} the id.
 */
export function normalizeTrashId(raw) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!TRASH_ID_RE.test(value)) {
    throw Object.assign(new Error('回收站条目标识不合法'), { code: 'bad-request' })
  }
  return value
}

/**
 * Sum the bytes of a directory tree, tolerating races with a live writer.
 * @param {string} dir - directory.
 * @returns {Promise<number>} byte count.
 */
async function directoryBytes(dir) {
  let total = 0
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const child = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await directoryBytes(child)
    } else if (entry.isFile()) {
      try {
        total += (await fs.stat(child)).size
      } catch { /* a live writer may have replaced it */ }
    }
  }
  return total
}

/**
 * Map a filesystem error from a rename/remove call to a stable code the UI can
 * explain.
 * @param {unknown} error - thrown value.
 * @returns {string} `in-use`, `not-found`, or `io`.
 */
function classify(error) {
  const code = /** @type {NodeJS.ErrnoException} */ (error)?.code
  if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'ENOTEMPTY') return 'in-use'
  if (code === 'ENOENT') return 'not-found'
  return 'io'
}

/**
 * List every session directory under the sessions root.
 * @param {string} home - DSH home.
 * @returns {Promise<Array<{workspace: string, dirName: string, sessionId: string, path: string, mtime: number, bytes: number}>>} rows, newest first.
 */
export async function listSessions(home) {
  const root = sessionsRoot(home)
  const rows = []
  let workspaces = []
  try {
    workspaces = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return rows
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const workspacePath = join(root, workspace.name)
    let entries = []
    try {
      entries = await fs.readdir(workspacePath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SESSION_DIR_RE.test(entry.name)) continue
      const dir = join(workspacePath, entry.name)
      let stat
      try {
        stat = await fs.stat(dir)
      } catch {
        continue
      }
      rows.push({
        workspace: workspace.name,
        dirName: entry.name,
        sessionId: entry.name.slice('session-'.length),
        path: dir,
        mtime: stat.mtimeMs,
        bytes: await directoryBytes(dir),
      })
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime)
  return rows
}

/**
 * Locate one session by id.
 * @param {string} home - DSH home.
 * @param {string} rawId - session id from the browser.
 * @returns {Promise<{workspace: string, dirName: string, path: string} | null>} the location, or null.
 */
export async function findSession(home, rawId) {
  const dirName = normalizeSessionId(rawId)
  const root = sessionsRoot(home)
  let workspaces = []
  try {
    workspaces = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const candidate = inside(root, join(root, workspace.name, dirName))
    if (existsSync(candidate)) {
      return { workspace: workspace.name, dirName, path: candidate }
    }
  }
  return null
}

/**
 * Build a fresh, non-colliding trash id.
 *
 * Shape: `<YYYYMMDD>T<HHMMSS>-<mmm>Z-<6 hex>`, which matches `TRASH_ID_RE` and
 * sorts lexicographically by deletion time.
 * @returns {string} the id.
 */
function newTrashId() {
  const now = new Date()
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  const stamp = [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    'T',
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
    '-',
    pad(now.getUTCMilliseconds(), 3),
    'Z',
  ].join('')
  return `${stamp}-${randomBytes(3).toString('hex')}`
}

/**
 * Move a session's directory into the trash. Reversible until purged.
 * @param {string} home - DSH home.
 * @param {string} rawId - session id from the browser.
 * @returns {Promise<{trashId: string, workspace: string, sessionId: string, bytes: number}>} the receipt.
 */
export async function moveToTrash(home, rawId) {
  const found = await findSession(home, rawId)
  if (!found) throw Object.assign(new Error('找不到该会话，可能已被删除'), { code: 'not-found' })

  const trashId = newTrashId()
  const target = inside(trashRoot(home), join(trashRoot(home), trashId))
  const bytes = await directoryBytes(found.path)

  try {
    await fs.mkdir(trashRoot(home), { recursive: true })
    // rename() across the same volume is atomic; on Windows a session that is
    // still open cannot be renamed, which is exactly the guard we want.
    await fs.rename(found.path, target)
  } catch (error) {
    const code = classify(error)
    if (code === 'in-use') {
      throw Object.assign(new Error('该会话正在被使用，先切到别的会话再删除'), { code })
    }
    throw Object.assign(new Error('移动失败：' + /** @type {Error} */ (error).message), { code })
  }

  const meta = {
    workspace: found.workspace,
    dirName: found.dirName,
    sessionId: found.dirName.slice('session-'.length),
    deletedAt: new Date().toISOString(),
    bytes,
  }
  await fs.writeFile(join(target, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8')
  return { trashId, workspace: meta.workspace, sessionId: meta.sessionId, bytes }
}

/**
 * List trash entries, newest first.
 * @param {string} home - DSH home.
 * @returns {Promise<Array<{trashId: string, sessionId: string, workspace: string, deletedAt: string, bytes: number}>>} entries.
 */
export async function listTrash(home) {
  const root = trashRoot(home)
  let entries = []
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const rows = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !TRASH_ID_RE.test(entry.name)) continue
    const dir = join(root, entry.name)
    let meta = {}
    try {
      meta = JSON.parse(await fs.readFile(join(dir, 'meta.json'), 'utf8'))
    } catch { /* a half-written entry still lists, with unknown provenance */ }
    let stat
    try {
      stat = await fs.stat(dir)
    } catch {
      continue
    }
    rows.push({
      trashId: entry.name,
      sessionId: typeof meta.sessionId === 'string' ? meta.sessionId : '(unknown)',
      workspace: typeof meta.workspace === 'string' ? meta.workspace : '(unknown)',
      deletedAt: typeof meta.deletedAt === 'string' ? meta.deletedAt : new Date(stat.mtimeMs).toISOString(),
      bytes: typeof meta.bytes === 'number' ? meta.bytes : 0,
    })
  }
  rows.sort((a, b) => (a.trashId < b.trashId ? 1 : -1))
  return rows
}

/**
 * Put a trashed session back where it came from.
 * @param {string} home - DSH home.
 * @param {string} rawTrashId - trash entry id.
 * @returns {Promise<{workspace: string, sessionId: string}>} the restored location.
 */
export async function restoreFromTrash(home, rawTrashId) {
  const trashId = normalizeTrashId(rawTrashId)
  const source = inside(trashRoot(home), join(trashRoot(home), trashId))
  let meta
  try {
    meta = JSON.parse(await fs.readFile(join(source, 'meta.json'), 'utf8'))
  } catch {
    throw Object.assign(new Error('回收站条目缺少 meta.json，无法确定原位置'), { code: 'bad-request' })
  }
  const workspace = typeof meta.workspace === 'string' ? meta.workspace : ''
  const dirName = typeof meta.dirName === 'string' ? meta.dirName : ''
  if (workspace === '' || !SESSION_DIR_RE.test(dirName)) {
    throw Object.assign(new Error('回收站条目的原位置记录不完整'), { code: 'bad-request' })
  }
  const workspacePath = inside(sessionsRoot(home), join(sessionsRoot(home), workspace, dirName))
  if (existsSync(workspacePath)) {
    throw Object.assign(new Error('原位置已存在同名会话，未覆盖'), { code: 'conflict' })
  }
  try {
    await fs.mkdir(join(sessionsRoot(home), workspace), { recursive: true })
    await fs.rename(source, workspacePath)
  } catch (error) {
    throw Object.assign(new Error('恢复失败：' + /** @type {Error} */ (error).message), { code: classify(error) })
  }
  return { workspace, sessionId: dirName.slice('session-'.length) }
}

/**
 * Permanently remove one trash entry. Irreversible.
 * @param {string} home - DSH home.
 * @param {string} rawTrashId - trash entry id.
 * @returns {Promise<{trashId: string}>} the receipt.
 */
export async function purgeTrash(home, rawTrashId) {
  const trashId = normalizeTrashId(rawTrashId)
  const target = inside(trashRoot(home), join(trashRoot(home), trashId))
  try {
    await fs.rm(target, { recursive: true, force: false })
  } catch (error) {
    throw Object.assign(new Error('彻底删除失败：' + /** @type {Error} */ (error).message), { code: classify(error) })
  }
  return { trashId }
}
