import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadModules } from './load-app.mjs'

const { App, GlassesDisplay, sdk } = await loadModules()
const settle = () => new Promise((resolve) => setImmediate(resolve))
const list = { kind: 'list', header: 'Sessions', items: ['Example'] }
const strip = { kind: 'stripList', status: ['Sessions', '1 active'], settings: ['tap open', 'dbl back'], items: list.items }

test('an invalid startup recovers over an existing page, and probes a missing host once', async () => {
  for (const pageExists of [false, true]) {
    let rebuilds = 0
    const screen = new GlassesDisplay({
      createStartUpPageContainer: async () => sdk.StartUpPageCreateResult.invalid,
      rebuildPageContainer: async () => { rebuilds++; return pageExists },
    })
    screen.render(list)
    assert.equal(await screen.init('Starting'), pageExists)
    screen.render(list)
    await settle()
    assert.equal(screen.showsList(list), pageExists)
    assert.equal(rebuilds, pageExists ? 2 : 1)
  }
})

test('fallback handles a rejected image layout and a repeatedly failing second half', async () => {
  // Supply only the canvas operations used to produce the strip; the device
  // independently accepts/rejects the pixel transfers.
  const previous = globalThis.OffscreenCanvas
  const ctx = new Proxy({
    getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    measureText: (s) => ({ width: s.length * 8 }),
  }, { get: (obj, key) => obj[key] ?? (() => {}) })
  globalThis.OffscreenCanvas = class { getContext() { return ctx } }
  try {
    for (const rejectLayout of [false, true]) {
      let imageBuilds = 0
      const images = []
      const screen = new GlassesDisplay({
        createStartUpPageContainer: async () => sdk.StartUpPageCreateResult.success,
        rebuildPageContainer: async (layout) => {
          if (layout.imageObject?.length) { imageBuilds++; return !rejectLayout }
          return true
        },
        updateImageRawData: async ({ containerName }) => {
          images.push(containerName)
          return containerName === 'imgl' ? sdk.ImageRawDataUpdateResult.success : sdk.ImageRawDataUpdateResult.sendFailed
        },
      })
      screen.onImageFallback = () => screen.render(list)
      await screen.init()
      screen.render(strip)
      await settle()
      screen.render(strip)
      await settle()
      assert.deepEqual(images, rejectLayout ? [] : ['imgl', 'imgr', 'imgl', 'imgr'])
      assert.equal(imageBuilds, 2)
      assert.equal(screen.imageStrips, false)
      assert.equal(screen.showsList(list), true)
    }
  } finally { globalThis.OffscreenCanvas = previous }
})

test('all sessions and settings remain reachable within the firmware row cap', async () => {
  const app = new App()
  app.state = 'list'
  app.sessions = Array.from({ length: 48 }, (_, i) => ({ id: String(i), title: 'Example', workerStatus: 'idle' }))
  const screen = new GlassesDisplay({
    createStartUpPageContainer: async () => sdk.StartUpPageCreateResult.success,
    rebuildPageContainer: async () => true,
  })
  await screen.init()
  app.glasses = screen
  app.render = () => screen.render(app.layout())
  const seen = []
  app.openSession = (sid) => seen.push(sid)
  app.render()
  for (let page = 0; page < 3; page++) {
    await settle()
    const rows = app.sessionRows()
    assert.ok(rows.length <= 20)
    assert.match(screen.listItems.at(-1), /Settings/)
    assert.equal(new Set(screen.listItems).size, rows.length)
    if (page === 2) {
      const before = seen.slice()
      // A tap on the preceding page arrives after this page has landed.
      app.onHubEvent({ listEvent: { currentSelectItemName: 'Next page ▶' } })
      app.onHubEvent({ listEvent: { currentSelectItemIndex: 0, currentSelectItemName: '☉ Settings' } })
      assert.deepEqual(seen, before)
    }
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i].sid) continue
      app.listSelectIndex = i
      app.onTap()
    }
    const next = rows.findIndex((r) => r.page === page + 1)
    if (next >= 0) {
      app.listSelectIndex = next
      app.onTap()
      app.listSelectIndex = 0
      app.onTap() // new page hasn't landed; ignore even if all labels match
    }
  }
  assert.deepEqual(seen, app.sessions.map((s) => s.id))
  app.listSelectIndex = screen.listItems.length - 1
  app.onTap()
  assert.equal(app.state, 'settings')
})

test('a wake waits for the visible transcript before consuming taps or clearing unread', async () => {
  const app = new App()
  const reads = []
  const screen = new GlassesDisplay({
    createStartUpPageContainer: async () => sdk.StartUpPageCreateResult.success,
    rebuildPageContainer: async () => true,
    textContainerUpgrade: async () => true,
  })
  await screen.init()
  app.glasses = screen
  app.sid = 'example'
  app.state = 'session'
  app.blanked = true
  app.rc = { markRead: async (sid) => reads.push(sid) }
  app.render = () => screen.render({ kind: 'text', content: app.blanked ? '' : app.state })
  screen.onPainted = () => app.onDisplayPainted()
  app.markRead()
  app.onHubEvent({ sysEvent: { eventType: sdk.OsEventTypeList.CLICK_EVENT } })
  app.onHubEvent({ sysEvent: { eventType: sdk.OsEventTypeList.CLICK_EVENT } })
  assert.equal(app.state, 'session')
  assert.deepEqual(reads, [])
  await settle()
  assert.deepEqual(reads, ['example'])
})

test('a refused sensor enable retries and a background transition closes a late enable', async () => {
  const app = new App()
  app.state = 'calibrate'
  app.render = () => {}
  const calls = []
  let ack
  app.bridge = { imuControl: async (enable) => {
    calls.push(enable)
    if (calls.length === 1) return false
    if (enable) return new Promise((resolve) => { ack = resolve })
    return true
  } }
  await app.syncImu()
  assert.equal(app.imuOn, false)
  await app.syncImu()
  assert.deepEqual(calls, [true])
  app.imuRetryAt = 0
  const retry = app.syncImu()
  app.foreground = false
  ack(true)
  await retry
  await settle()
  assert.deepEqual(calls, [true, true, false])
  assert.equal(app.imuOn, false)
})
