// Exercise the actual gesture dispatcher and serialized display pump.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as tick } from 'node:timers/promises'
import { loadModules } from './load-app.mjs'

const { App, GlassesDisplay, sdk } = await loadModules()
const gestures = sdk.OsEventTypeList

test('a review must reach the HUD before a tap sends or a long press appends', async t => {
  let now = 3000
  t.mock.method(performance, 'now', () => now)
  const building = Promise.withResolvers()
  const app = new App()
  const sent = [], appended = []
  app.sid = 'fiction'
  app.panel = new Proxy({}, { get: () => () => {} })
  app.voice = { available: true }
  app.rc = { send: async (_, text) => sent.push(text) }
  t.mock.method(app, 'startVoice', (...args) => appended.push(args))
  app.glasses = new GlassesDisplay({
    createStartUpPageContainer: async () => 0,
    rebuildPageContainer: () => building.promise,
    textContainerUpgrade: async () => true,
  })
  await app.glasses.init()
  app.glasses.noImages = true
  const gesture = (eventType) => app.onHubEvent({ sysEvent: { eventType } })
  app.confirmSend('Please review', 'session')
  now += 2000
  gesture(gestures.CLICK_EVENT)
  gesture(gestures.LONG_PRESS_EVENT)
  assert.deepEqual([sent, appended], [[], []])

  building.resolve(true)
  await tick()
  gesture(gestures.CLICK_EVENT)
  assert.deepEqual(sent, []) // a tap already on the way
  now += 1000
  gesture(gestures.LONG_PRESS_EVENT)
  assert.deepEqual(appended, [['send', 'glasses', 'Please review']])

  // The new draft needs its own review even if all its pixels match.
  app.confirmSend('Please review', 'session')
  gesture(gestures.CLICK_EVENT)
  assert.deepEqual(sent, [])
  await tick()
  now += 1000
  gesture(gestures.CLICK_EVENT)
  await tick()
  assert.deepEqual(sent, ['Please review'])
})
