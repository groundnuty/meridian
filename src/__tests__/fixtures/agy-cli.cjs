#!/usr/bin/env node
// Deterministic official-CLI protocol fixture. Never contacts a model service.
const { readFileSync } = require('node:fs')
const args = process.argv.slice(2)
const emit = value => process.stdout.write(JSON.stringify(value) + '\n')
async function main() {
  if (args[0] === 'models') return console.log('fixture-model\tFixture Model')
  let prompt = args[args.indexOf('-p') + 1]
  if (args.includes('--input-format')) {
    let input = ''; for await (const chunk of process.stdin) input += chunk
    prompt = JSON.parse(input).message.content
  }
  if (prompt === '/config') return emit({ command: { data: { config: { modelProvider: process.env.AGY_FIXTURE_API ? 'gemini' : '', useG1Credits: false } } } })
  emit({ event: 'init' })
  if (prompt.includes('HANG')) { setInterval(() => {}, 1000); return }
  if (prompt.includes('MALFORMED')) { console.log('not JSON'); return }
  if (prompt.includes('DENIED')) return emit({ event: 'result', result: { status: 'SUCCESS', denied_actions: [{ action: 'mcp' }] } })
  const config = JSON.parse(readFileSync('.agents/mcp_config.json', 'utf8'))
  const url = config.mcpServers.meridian_client.serverUrl
  const rpc = async (method, params) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    const value = await response.json()
    if (value.error) throw new Error(value.error.message)
    return value.result
  }
  const { tools } = await rpc('tools/list')
  let answer = 'READY'
  if (tools.length) {
    emit({ event: 'step_update', step_update: { state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 100, output_tokens: 5 } } })
    const calls = Array.from({ length: prompt.includes('PARALLEL2') ? 2 : 1 }, (_, n) => rpc('tools/call', { name: tools[0].name, arguments: { key: `probe${n}` } }))
    const results = await Promise.all(calls)
    answer = results.map(result => (result.isError ? 'FAILED:' : '') + result.content.map(b => b.text).join('')).join('|')
  }
  emit({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: answer } })
  emit({ event: 'step_update', step_update: { state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 120, output_tokens: 10, cache_read_tokens: 20 } } })
  emit({ event: 'result', result: { status: 'SUCCESS' } })
}
main().catch(error => { console.error(error); process.exitCode = 1 })
