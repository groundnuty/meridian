import { describe, expect, it } from 'bun:test'

type Fetch = typeof fetch
type Config = { provider?: Record<string, { options?: { fetch?: Fetch } }> }
async function wrapped(fetcher: Fetch) {
  const path = new URL('../../examples/opencode-plugin/antigravity-retry.js', import.meta.url).href
  const module: { default: (input: { client: object }) => Promise<{ config: (config: Config) => Promise<void> }> } = await import(path)
  const hooks = await module.default({ client: {} })
  const config: Config = { provider: { 'meridian-agy': { options: { fetch: fetcher } }, other: { options: { fetch: fetcher } } } }
  await hooks.config(config)
  expect(config.provider!.other!.options!.fetch).toBe(fetcher)
  return config.provider!['meridian-agy']!.options!.fetch!
}
const encode = (text: string) => new TextEncoder().encode(text)
const terminal = 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
const headers = { 'content-type': 'text/event-stream' }

describe('OpenCode Antigravity delivery buffer', () => {
  it('withholds a complete tool block until the response completes and preserves exact bytes', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
    const prefix = 'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","id":"one"}}\n\n'
    const fetcher = await wrapped(Object.assign(async () => new Response(stream, { headers }), { preconnect: fetch.preconnect }))
    let delivered = false
    const pending = fetcher('http://localhost/v1/messages').then(response => { delivered = true; return response })
    controller.enqueue(encode(prefix))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(delivered).toBe(false)
    controller.enqueue(encode(terminal)); controller.close()
    expect(await (await pending).text()).toBe(prefix + terminal)
  })
  it('rejects broken and truncated streams before exposing a response', async () => {
    for (const broken of [false, true]) {
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(encode('data: {"type":"content_block_start"}\n\n'))
        if (broken) controller.error(new TypeError('terminated'))
        else controller.close()
      } })
      const fetcher = await wrapped(Object.assign(async () => new Response(stream, { headers }), { preconnect: fetch.preconnect }))
      await expect(fetcher('http://localhost/v1/messages')).rejects.toThrow(broken ? 'terminated' : 'before message_stop')
    }
  })
  it('bounds memory and cancels an oversized response', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)) }, cancel() { cancelled = true } })
    const fetcher = await wrapped(Object.assign(async () => new Response(stream, { headers }), { preconnect: fetch.preconnect }))
    await expect(fetcher('http://localhost/v1/messages')).rejects.toThrow('4 MiB')
    expect(cancelled).toBe(true)
  })
  it('cancels buffered delivery when the caller aborts without exposing tools', async () => {
    const abort = new AbortController()
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
    const fetcher = await wrapped(Object.assign(async () => new Response(stream, { headers }), { preconnect: fetch.preconnect }))
    const pending = fetcher('http://localhost/v1/messages', { signal: abort.signal })
    abort.abort(new Error('user stopped'))
    await expect(pending).rejects.toThrow('user stopped')
    expect(cancelled).toBe(true)
  })
  it('preserves HTTP errors and nonstreaming responses without buffering', async () => {
    for (const response of [new Response('denied', { status: 403 }), new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })]) {
      const fetcher = await wrapped(Object.assign(async () => response, { preconnect: fetch.preconnect }))
      expect(await fetcher('http://localhost/v1/messages')).toBe(response)
    }
  })
})
