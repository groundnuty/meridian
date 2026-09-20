import { createHash } from 'node:crypto'
import { AgResponseStore } from './antigravityResponses'
import { AntigravityError, blocks, contractKey, historyKey, stable, type AgRequest } from './antigravityProtocol'
import type { AgState } from './antigravityState'

export interface AgCompletedAnswer {
  id: string
  type: string
  role: string
  model: string
  content: Array<{ type: 'text'; text: string }>
  stop_reason: string
  stop_sequence: string | null
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
}

/** Separate, explicitly bounded retry snapshots; ordinary prompts are never memoized. */
export class AgCompletedAnswers {
  private readonly store: AgResponseStore
  constructor(state?: AgState) {
    this.store = new AgResponseStore({ entries: 128, bytes: 16 * 1024 * 1024, entryBytes: 1024 * 1024, ttlMs: 30 * 60_000 }, undefined, state, 'completed-answers')
  }
  private key(request: AgRequest, scope: string) {
    return createHash('sha256').update(stable([scope, contractKey(request), historyKey(request.messages), request.tool_choice])).digest('hex')
  }
  eligible(request: AgRequest) {
    return blocks(request.messages.at(-1)!).some(block => block.type === 'tool_result')
  }
  get(request: AgRequest, scope: string): AgCompletedAnswer | undefined {
    if (!this.eligible(request)) return
    try { return this.store.get(this.key(request, scope), scope).response as unknown as AgCompletedAnswer }
    catch (error) { if (!(error instanceof AntigravityError) || error.status !== 404) throw error }
  }
  put(request: AgRequest, scope: string, answer: AgCompletedAnswer) {
    if (!this.eligible(request)) return
    // Large answers remain successful but cannot acquire retry guarantees.
    // Consumed-result protection still prevents generation on an exact retry.
    if (Buffer.byteLength(JSON.stringify({ input: [], response: answer })) > 1024 * 1024) return
    this.store.put(this.key(request, scope), scope, [], { ...answer })
  }
  clear() { this.store.clear() }
}

/** Reconstruct protocol events lazily, without retaining a second response buffer. */
export function replayAgAnswer(answer: AgCompletedAnswer, stream: boolean, headers: Record<string, string>): Response {
  const replayHeaders = { ...headers, 'x-meridian-response-replayed': 'true', 'cache-control': 'no-store' }
  if (!stream) return Response.json(answer, { headers: replayHeaders })
  function* frames() {
    yield { type: 'message_start', message: { ...answer, content: [], stop_reason: null, stop_sequence: null, usage: { ...answer.usage, output_tokens: 0 } } }
    for (const [index, block] of answer.content.entries()) {
      yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }
      for (let offset = 0; offset < block.text.length; offset += 4096) yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text.slice(offset, offset + 4096) } }
      yield { type: 'content_block_stop', index }
    }
    yield { type: 'message_delta', delta: { stop_reason: answer.stop_reason, stop_sequence: answer.stop_sequence }, usage: answer.usage }
    yield { type: 'message_stop' }
  }
  const iterator = frames(), encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = iterator.next()
      if (next.done) { controller.close(); return }
      controller.enqueue(encoder.encode(`event: ${next.value.type}\ndata: ${JSON.stringify(next.value)}\n\n`))
    },
    cancel() { iterator.return() },
  }), { headers: { ...replayHeaders, 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' } })
}
