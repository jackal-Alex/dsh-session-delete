/**
 * Wiring test for the browser half. It stands in for the DSH client runtime:
 * a fake `window.__ModuleLoader__` captures the bundle descriptor, a fake
 * `require` supplies React, a fake DOM captures the injected stylesheet, and a
 * fake slot registry records what `apply()` registers. This does not render
 * React; it proves the module-loader contract, the exported `inject`/`apply`,
 * both menu registrations, and the menu-cell metrics that keep the two rows
 * the same size as the shipped ones.
 *
 *   node tests/client.test.mjs
 */

import assert from 'node:assert/strict'

/** @type {any} */
let descriptor
/** @type {string} */
let injectedCss = ''
/** @type {string[]} */
const createdIds = []

globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      descriptor = value
    },
  },
}
globalThis.document = {
  getElementById(id) {
    return createdIds.includes(id) ? { id } : null
  },
  createElement() {
    const node = { id: '', textContent: '' }
    return node
  },
  head: {
    appendChild(node) {
      if (node.id) createdIds.push(node.id)
      if (node.textContent) injectedCss = node.textContent
    },
  },
  documentElement: { appendChild() {} },
}

await import('../lib/client.js')

const required = []
const requireStub = (name) => {
  required.push(name)
  if (name === 'react') {
    return { createElement: (...args) => ({ __element: true, args }) }
  }
  throw new Error('unexpected require: ' + name)
}

let failures = 0

/**
 * Run one assertion group.
 * @param {string} name - test name.
 * @param {() => void} body - test body.
 * @returns {void}
 */
function test(name, body) {
  try {
    body()
    console.log('  ok   ' + name)
  } catch (error) {
    failures++
    console.log('  FAIL ' + name)
    console.log('       ' + (error && error.stack ? error.stack : String(error)))
  }
}

test('the bundle registers itself under the package name', () => {
  assert.ok(descriptor, 'window.__ModuleLoader__.load was never called')
  assert.equal(descriptor.id, 'dsh-session-delete')
  assert.equal(typeof descriptor.factory, 'function')
})

const exportsObject = descriptor.factory(requireStub)

test('the factory exports apply and inject', () => {
  assert.equal(typeof exportsObject.apply, 'function')
  assert.deepEqual(exportsObject.inject, ['slots'])
  assert.equal(typeof exportsObject.SessionDeleteItem, 'function')
})

test('the factory only requires react', () => {
  assert.deepEqual(required, ['react'])
})

/** @type {Array<{owner: string, spec: any, component: any}>} */
const registered = []
const ctx = {
  slots: {
    inject(owner, fn) {
      fn()
      registered[registered.length - 1].owner = owner
      return () => {}
    },
    register(spec, component) {
      registered.push({ owner: '', spec, component })
      return () => {}
    },
  },
}

exportsObject.apply(ctx)

test('apply registers two entries into the Session row menu', () => {
  assert.equal(registered.length, 2)
  for (const entry of registered) {
    assert.equal(entry.owner, 'sidebar.workspaces.session.menu.item')
    assert.equal(entry.spec.name, 'sidebar.workspaces.session.menu.item')
    assert.equal(entry.component, exportsObject.SessionDeleteItem)
  }
  assert.deepEqual(registered.map((entry) => entry.spec.id), ['session-delete.trash', 'session-delete.purge'])
  assert.deepEqual(registered.map((entry) => entry.spec.order), [600, 601])
})

test('each registration injects its own mode and label', () => {
  const [trash, purge] = registered.map((entry) => entry.spec.inject())
  assert.equal(trash.mode, 'trash')
  assert.equal(trash.label, '删除会话')
  assert.equal(trash.separator, true)
  assert.equal(purge.mode, 'purge')
  assert.equal(purge.label, '彻底删除会话')
  assert.equal(purge.separator, undefined)
})

test('the injected stylesheet matches the shipped menu cell metrics', () => {
  assert.ok(injectedCss.length > 0, 'no stylesheet was injected')
  for (const rule of [
    'font-size:13px',
    'line-height:20px',
    'min-height:34px',
    'padding:6px 8px',
    'border-radius:var(--dsw-radius-md)',
    'color:var(--dsw-alias-label-primary)',
    'background:var(--dsw-alias-interactive-bg-hover)',
  ]) {
    assert.ok(injectedCss.includes(rule), 'stylesheet is missing ' + rule)
  }
})

test('the stylesheet is injected only once', () => {
  exportsObject.apply(ctx)
  assert.equal(createdIds.filter((id) => id === 'dsh-session-delete-styles').length, 1)
})

test('the trash row renders a separator and a menuitem button', () => {
  const element = exportsObject.SessionDeleteItem({
    sessionId: 'session-1',
    displayTitle: '示例会话',
    useMenuOpenState: () => [false, () => {}],
    mode: 'trash',
    label: '删除会话',
    hint: '移入回收站',
    separator: true,
  })
  assert.equal(element.args[0], 'div')
  const separator = element.args[2]
  const button = element.args[3]
  assert.equal(separator.args[1].role, 'separator')
  assert.equal(button.args[0], 'button')
  assert.equal(button.args[1].role, 'menuitem')
  assert.equal(button.args[1].className, 'dsh-session-delete-row')
  assert.equal(button.args[1]['data-dsh-session-delete'], 'trash')
  assert.equal(button.args[2], '删除会话')
})

test('the purge row is a standalone danger-coloured menuitem', () => {
  const element = exportsObject.SessionDeleteItem({
    sessionId: 'session-1',
    displayTitle: '示例会话',
    useMenuOpenState: () => [false, () => {}],
    mode: 'purge',
    label: '彻底删除会话',
    hint: '不可恢复',
  })
  assert.equal(element.args[0], 'button')
  assert.equal(element.args[1].role, 'menuitem')
  assert.ok(element.args[1].className.includes('dsh-session-delete-row--danger'))
  assert.equal(element.args[1]['data-dsh-session-delete'], 'purge')
})

if (failures > 0) {
  console.log('\n' + failures + ' test(s) failed')
  process.exitCode = 1
} else {
  console.log('\nall tests passed')
}
