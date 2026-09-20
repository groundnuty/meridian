// Load with Pi's -e option, using a provider named meridian-agy.
// The supported payload hook runs once before the SDK's transport retries.
import { randomUUID } from 'node:crypto'
export default function (pi) {
  pi.on('before_provider_request', (event, ctx) => {
    if (ctx.model?.provider !== 'meridian-agy') return
    return { ...event.payload, meridian_request_id: randomUUID() }
  })
}
