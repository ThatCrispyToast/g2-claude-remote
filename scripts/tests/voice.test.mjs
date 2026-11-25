import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as tick } from 'node:timers/promises'
import { loadModules } from './load-app.mjs'

const { App, VoiceDictation, config } = await loadModules()
const reply = (seq, final = [], interim = '', model = 'ready') => Response.json({ seq, final, interim, model })

function fixture(t, post, initialModel = 'ready') {
  let flush
  let nextId = 0
  const saved = new Map()
  globalThis.window = {
    localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    setInterval(callback, ms) { if (ms === 1000) flush = callback },
  }
  config.saveRuntimeSettings({ sttSource: 'bridge', bridgeUrl: 'http://localhost:8791' })
  config.setBridgeDictation(true)
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    const url = new URL(path)
    assert.equal(url.origin, 'http://localhost:8791')
    if (url.pathname.endsWith('/start')) {
      return Response.json({ id: (++nextId).toString(16).padStart(16, '0'), protocol: 1, model: initialModel })
    }
    if (url.pathname.endsWith('/cancel')) return Response.json({ ok: true })
    return post(url.pathname.split('/').pop(), Number(url.searchParams.get('seq')), init.body)
  })
  const sent = [], draft = [], errors = []
  const app = new App()
  app.state = 'session'
  app.sid = 'fiction'
  app.panel = new Proxy({
    setInterim() {}, setGlassesDraft() {}, setConnection() {}, setDictating() {},
    setToast: message => errors.push(message), appendDraft: text => draft.push(text),
  }, { get: (target, name) => target[name] ?? (() => {}) })
  app.voice = new VoiceDictation({ audioControl: async () => true })
  app.rc = { send: async (_, text) => sent.push(text) }
  return {
    app, sent, draft, errors,
    start: async (from = 'panel') => { await app.startVoice('send', from); await tick() },
    feed: (...bytes) => app.voice.pushPcm(Uint8Array.from(bytes)),
    flush: async () => { flush(); await tick() },
  }
}

test('Stop preserves the displayed draft after a failed final request on either surface', async t => {
  const f = fixture(t, (action, seq) => action === 'audio'
    ? reply(seq, ['Wait'], 'for approval')
    : Response.json({ error: 'Dictation expired.' }, { status: 404 }))
  for (const from of ['panel', 'glasses']) {
    await f.start(from)
    f.feed(1, 0)
    await f.flush()
    assert.equal(f.app.interim, 'Wait for approval')
    if (from === 'panel') {
      await f.app.commitVoice()
      assert.deepEqual(f.draft, ['Wait for approval'])
    } else {
      await f.app.reviewDictation()
      assert.equal(f.app.state, 'voice')
      assert.equal(f.app.voiceStop.text, 'Wait for approval')
    }
    assert.deepEqual(f.sent, [])
    assert.match(f.errors.at(-1), /expired/)
  }
})

test('a late response after cancellation cannot enter a later dictation', async t => {
  const late = Promise.withResolvers()
  const f = fixture(t, (action, seq) => action === 'audio' ? late.promise : reply(seq, ['new message']))
  await f.start()
  f.feed(1, 0)
  await f.flush()
  await f.app.cancelVoice()
  await f.start()
  late.resolve(reply(0, ['cancelled words']))
  await tick()
  assert.equal(f.app.interim, '')
  await f.app.commitVoice()
  assert.deepEqual(f.sent, ['new message'])
})

test('Stop replays the exact lost chunk before sending the final microphone bytes', async t => {
  const requests = []
  const f = fixture(t, (action, seq, body) => {
    requests.push([action, seq, [...body]])
    if (requests.length === 1) throw new Error('Acknowledgement was lost')
    return reply(seq, [action === 'audio' ? 'first' : 'last'])
  })
  await f.start()
  f.feed(1, 0)
  await f.flush()
  f.feed(2, 0)
  await f.app.commitVoice()
  assert.deepEqual(requests, [['audio', 0, [1, 0]], ['audio', 0, [1, 0]], ['finish', 1, [2, 0]]])
  assert.deepEqual(f.sent, ['first last'])
})

test('audio during the first download is discarded until the bridge is ready', async t => {
  const requests = []
  const f = fixture(t, (action, seq, body) => {
    requests.push([action, [...body]])
    return reply(seq, action === 'finish' ? ['heard'] : [])
  }, 'downloading')
  await f.start('glasses')
  f.feed(1, 0)
  await f.flush()
  f.feed(2, 0)
  await f.app.reviewDictation()
  assert.deepEqual(requests, [['audio', []], ['finish', [2, 0]]])
  assert.equal(f.app.pendingSend.text, 'heard')
  assert.deepEqual(f.sent, [])
})

test('stopped speech and append prefixes retire before a different session opens', async t => {
  const f = fixture(t, (action, seq) => action === 'audio'
    ? reply(seq, [], 'previous draft') : Response.json({}, {status: 409}))
  await f.app.startVoice('send', 'glasses', 'original')
  await tick()
  f.feed(1, 0)
  await f.flush()
  await f.app.reviewDictation()
  assert.equal(f.app.voiceStop.text, 'original previous draft')

  const details = Promise.withResolvers()
  f.app.rc.getSession = () => details.promise
  f.app.rc.getHistoryPage = async () => ({ events: [] })
  f.app.rc.streamEvents = () => () => {}
  f.app.rc.markRead = async () => {}
  const opened = f.app.openSession('next')
  assert.equal(f.app.sid, null)
  await f.app.commitVoice()
  details.resolve({ id: 'next', title: 'Next', workerStatus: 'idle' })
  await opened
  await f.start()
  assert.equal(f.app.sid, 'next')
  assert.deepEqual(f.sent, [])
  assert.deepEqual(f.draft, [])
  await f.app.cancelVoice()
})

test('a panel Stop consumes appended speech before its message delivery finishes', async t => {
  const send = Promise.withResolvers()
  const f = fixture(t, (_, seq) => reply(seq, ['last words']))
  f.app.rc.send = (_, text) => { f.sent.push(text); return send.promise }
  await f.app.startVoice('send', 'glasses', 'first words')
  const stopping = f.app.commitVoice()
  await tick()
  await f.app.reviewDictation()
  assert.deepEqual(f.sent, ['first words last words'])
  assert.equal(f.app.state, 'session')
  assert.equal(f.app.pendingSend, null)
  send.resolve()
  await stopping
})

test('a native open which lands after cancellation is followed by a close', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(t, () => assert.fail('cancelled microphone started transcription'))
  const delayedOpen = Promise.withResolvers()
  const applied = []
  f.app.voice = new VoiceDictation({ async audioControl(open) {
    if (open) await delayedOpen.promise
    applied.push(open)
    return true
  } })
  const opening = f.start()
  await tick()
  f.app.cancelVoice()
  t.mock.timers.tick(4001)
  await opening
  await tick()
  assert.deepEqual(applied, [false])
  delayedOpen.resolve()
  await tick()
  assert.deepEqual(applied, [false, true, false])
})

test('a panel-only browser cannot start the bridge model through the dictation button', async t => {
  const f = fixture(t, () => assert.fail('Unexpected speech request'))
  f.app.glasses = { unavailable: true }
  const start = t.mock.method(f.app.voice, 'start')
  await f.start()
  assert.equal(start.mock.callCount(), 0)
  assert.match(f.errors.at(-1), /Even app/)
})
