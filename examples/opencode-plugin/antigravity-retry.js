// OpenCode V1 plugin: use a provider named meridian-agy.
import { createHash } from 'node:crypto'
export default async function ({ client }) {
  return {
    config: async config => {
      const provider = config.provider?.['meridian-agy']
      if (!provider) return
      const options = provider.options ??= {}
      const upstream = options.fetch ?? globalThis.fetch
      options.fetch = async (input, init) => {
        const originalSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
        const deadline = AbortSignal.timeout(300000)
        const signal = originalSignal ? AbortSignal.any([originalSignal, deadline]) : deadline
        const response = await upstream(input, { ...init, signal })
        if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response
        // OpenCode executes complete tool blocks before message_stop. Keep the
        // response inside its provider transport until delivery is complete,
        // so a broken network stream cannot expose an executable tool prefix.
        const reader = response.body.getReader()
        const cancel = () => { void reader.cancel(signal.reason).catch(() => undefined) }
        signal.addEventListener('abort', cancel, { once: true })
        if (signal.aborted) cancel()
        const chunks = []
        let bytes = 0
        try {
          while (true) {
            const next = await reader.read()
            if (next.done) break
            bytes += next.value.byteLength
            if (bytes > 4 * 1024 * 1024) throw new Error('Meridian response exceeds the 4 MiB client buffer')
            chunks.push(next.value)
          }
          signal.throwIfAborted()
          const body = new Uint8Array(bytes)
          let offset = 0
          for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
          const frames = new TextDecoder().decode(body).replace(/\r\n/g, '\n').split('\n\n')
          const complete = frames.some(frame => frame.split('\n').some(line => {
            if (!line.startsWith('data:')) return false
            try { return JSON.parse(line.slice(5)).type === 'message_stop' }
            catch { return false }
          }))
          if (!complete) throw new TypeError('fetch failed: Meridian stream ended before message_stop')
          const headers = new Headers(response.headers)
          headers.delete('content-encoding')
          headers.delete('content-length')
          return new Response(body, { status: response.status, statusText: response.statusText, headers })
        } finally {
          signal.removeEventListener('abort', cancel)
          // A broken network reader may already be errored; preserve the original failure.
          await reader.cancel().catch(() => undefined)
          reader.releaseLock()
        }
      }
    },
    'chat.headers': async (input, output) => {
      if (input.model.providerID !== 'meridian-agy') return
      for (const key of Object.keys(output.headers)) if (key.toLowerCase() === 'idempotency-key') delete output.headers[key]
      // The header hook runs again on a processor retry. A random ID here
      // would regenerate the response. Use the public client's active message,
      // created before generation and retained across retries of that step.
      const result = await client.session.messages({ path: { id: input.sessionID } })
      if (result.error || !Array.isArray(result.data)) throw new Error('Cannot read OpenCode request identity')
      const active = result.data.filter(({ info }) => info.role === 'assistant' && info.parentID === input.message.id && info.agent === input.agent && info.modelID === input.model.id && info.providerID === input.model.providerID && !info.time?.completed)
      // Hidden one-shots and ambiguous concurrent steps must not share an ID.
      if (active.length !== 1) return
      output.headers['idempotency-key'] = createHash('sha256').update(JSON.stringify([input.sessionID, active[0].info.id])).digest('hex')
    },
  }
}
