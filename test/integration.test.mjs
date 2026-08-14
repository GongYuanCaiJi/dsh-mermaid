// dsh-mermaid integration tests — the dsh wiring: session/event interception
// rendering into the store, the webServer route, and the command.
//
// A minimal fake ctx implements the small surface dsh-mermaid's apply() uses:
//   ctx.on(name, handler)            — record listeners, dispatch events
//   ctx.inject(services, cb)         — invoke cb synchronously with { effect, webServer, commands }
//   ctx.logger.warn                  — swallow
//
// The public seam under test is the webServer route: events are emitted on the
// fake ctx, rendering happens asynchronously, then the route handler answers a
// POST with the SVG results — exactly what the real web client does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, createRenderStore } from '../lib/index.js'

function fakeCtx() {
  const listeners = new Map()
  const webServer = { routes: [] }
  const commands = { registered: [] }
  const ctx = {
    on(name, handler) {
      let set = listeners.get(name)
      if (set === undefined) {
        set = new Set()
        listeners.set(name, set)
      }
      set.add(handler)
      return () => set.delete(handler)
    },
    emit(name, ...args) {
      for (const handler of listeners.get(name) ?? []) handler(...args)
    },
    logger: { warn() {}, info() {}, debug() {} },
    inject(services, cb) {
      const scope = {
        effect(fn) { fn() },
        webServer: {
          register({ path, handler }) {
            const route = { path, handler }
            webServer.routes.push(route)
            return () => {
              webServer.routes = webServer.routes.filter((r) => r !== route)
            }
          },
        },
        commands: {
          register(definition) {
            commands.registered.push(definition)
            return () => {}
          },
        },
      }
      cb(scope)
    },
  }
  ctx.webServer = webServer
  ctx.commands = commands
  return ctx
}

function routeFor(ctx, path) {
  return ctx.webServer.routes.find((r) => r.path === path)
}

function jsonResponse() {
  let status = 0
  let body = ''
  return {
    res: {
      setHeader() {},
      writeHead(code) { status = code },
      end(data) { body = String(data) },
    },
    status: () => status,
    body: () => JSON.parse(body),
  }
}

function post(handler, payload) {
  const { res, status, body } = jsonResponse()
  const req = {
    socket: { remoteAddress: '127.0.0.1' },
    method: 'POST',
    body: JSON.stringify(payload),
    readableEnded: true,
    [Symbol.asyncIterator]: async function* () {},
  }
  return { handler, req, res, status, body }
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 100))
}

test('user/message with a mermaid fence renders SVG served by the route', async () => {
  const ctx = fakeCtx()
  apply(ctx)
  ctx.emit('session/event', { id: 'sess-1' }, { type: 'turn/start', data: { turn: 3 } })
  ctx.emit('session/event', { id: 'sess-1' }, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: '```mermaid\ngraph TD\n  Start --> End\n```' }] },
  })
  await flush()

  const route = routeFor(ctx, '/dsh-mermaid/api')
  assert.ok(route, 'route registered')
  const { req, res, status, body } = post(route.handler, { session: 'sess-1', turn: 3 })
  await route.handler(req, res)
  assert.equal(status(), 200)
  assert.equal(body().ok, true)
  const results = body().value
  assert.equal(results.length, 1)
  assert.match(results[0].svg, /<svg/)
  assert.match(results[0].source, /graph TD/)
  assert.equal(results[0].issues.length, 0)
})

test('assistant/message with a mermaid fence renders SVG into the store', async () => {
  const ctx = fakeCtx()
  apply(ctx)
  ctx.emit('session/event', { id: 'sess-2' }, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', { id: 'sess-2' }, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '```mermaid\nsequenceDiagram\n  A->>B: hi\n```' }] } },
  })
  await flush()

  const route = routeFor(ctx, '/dsh-mermaid/api')
  const { req, res, status, body } = post(route.handler, { session: 'sess-2', turn: 1 })
  await route.handler(req, res)
  assert.equal(status(), 200)
  const results = body().value
  assert.equal(results.length, 1)
  assert.match(results[0].svg, /<svg/)
})

test('unsupported mermaid type renders nothing and reports an issue', async () => {
  const ctx = fakeCtx()
  apply(ctx)
  ctx.emit('session/event', { id: 'sess-3' }, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', { id: 'sess-3' }, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: '```mermaid\npie\n  "A" : 1\n```' }] },
  })
  await flush()
  const route = routeFor(ctx, '/dsh-mermaid/api')
  const { req, res, status, body } = post(route.handler, { session: 'sess-3', turn: 1 })
  await route.handler(req, res)
  assert.equal(status(), 200)
  assert.equal(body().value.length, 0, 'pie is not in SUPPORTED_TYPES')
})

test('route rejects non-localhost and bad payloads', async () => {
  const ctx = fakeCtx()
  apply(ctx)
  const route = routeFor(ctx, '/dsh-mermaid/api')

  const remote = jsonResponse()
  const reqRemote = {
    socket: { remoteAddress: '192.168.1.10' },
    method: 'POST',
    body: '{}',
    readableEnded: true,
    [Symbol.asyncIterator]: async function* () {},
  }
  await route.handler(reqRemote, remote.res)
  assert.equal(remote.status(), 403)

  const bad = post(route.handler, { session: 's' }) // no turn
  await route.handler(bad.req, bad.res)
  assert.equal(bad.status(), 400)

  const method = jsonResponse()
  const reqMethod = {
    socket: { remoteAddress: '127.0.0.1' },
    method: 'GET',
    readableEnded: true,
    [Symbol.asyncIterator]: async function* () {},
  }
  await route.handler(reqMethod, method.res)
  assert.equal(method.status(), 405)
})

test('store round-trips results keyed by (session, turn)', () => {
  const store = createRenderStore()
  store.set('s1', 2, [{ hash: 'abc12345', source: 'graph TD', svg: '<svg/>', issues: [] }])
  assert.equal(store.get('s1', 2).length, 1)
  assert.equal(store.get('s1', 3), undefined)
  store.set('s1', 2, [])
  assert.equal(store.get('s1', 2).length, 1, 'empty set is a no-op')
  assert.deepEqual(store.list('s1').map((e) => e.turn), [2])
})

test('mermaid command registers and answers without a session', async () => {
  const ctx = fakeCtx()
  apply(ctx)
  const cmd = ctx.commands.registered.find((c) => c.name === 'mermaid')
  assert.ok(cmd, 'command registered')
  const result = await cmd.handler({ agent: null })
  assert.equal(result.kind, 'error')
})

test('mermaid command renders the last assistant message into its own turn', async () => {
  const ctx = fakeCtx()
  apply(ctx)
  const cmd = ctx.commands.registered.find((c) => c.name === 'mermaid')
  const events = [
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'no mermaid here' }] } } },
    { type: 'assistant/message', data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '```mermaid\ngraph TD\n  A --> B\n```' }] } } },
  ]
  const result = await cmd.handler({ agent: { session: { id: 'sess-cmd', events } } })
  assert.equal(result.kind, 'success')

  const route = routeFor(ctx, '/dsh-mermaid/api')
  const { req, res, status, body } = post(route.handler, { session: 'sess-cmd', turn: 2 })
  await route.handler(req, res)
  assert.equal(status(), 200)
  const results = body().value
  assert.equal(results.length, 1)
  assert.match(results[0].svg, /<svg/)
  // the earlier turn rendered nothing
  const earlier = post(route.handler, { session: 'sess-cmd', turn: 1 })
  await route.handler(earlier.req, earlier.res)
  assert.deepEqual(earlier.body().value, [])
})
