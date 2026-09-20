// OpenCode V1 plugin: use a provider named meridian-agy.
import { createHash } from 'node:crypto'
export default async function ({ client }) {
  return {
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
