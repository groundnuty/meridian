import { createHash } from "node:crypto"
import { writeFile, rename } from "node:fs/promises"
import { join } from "node:path"
import { AntigravityError, blocks, type AgBlock, type AgMessage, type AgResult } from "./antigravityProtocol"

/** Materialize only request-owned bytes, never URLs or arbitrary filesystem paths. */
export class AgAttachments {
  private readonly paths = new Set<string>()
  constructor(private readonly workspace: string) {}
  get present(): boolean { return this.paths.size > 0 }
  async content(content: AgBlock[]): Promise<AgBlock[]> {
    const result: AgBlock[] = []
    for (const block of content) {
      if (block.type === "image") {
        const { data, media_type: mime } = block.source
        const bytes = Buffer.from(data, "base64")
        const valid = mime === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : mime === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : mime === "image/gif" ? /GIF8[79]a/.test(bytes.subarray(0, 6).toString("ascii"))
          : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP"
        if (!valid || bytes.toString("base64") !== data) throw new AntigravityError("Image data does not match its declared media_type or canonical base64 encoding")
        const name = createHash("sha256").update(bytes).digest("hex")
        const path = join(this.workspace, `attachment-${name}.${mime.split("/")[1]}`)
        if (!this.paths.has(path)) {
          await writeFile(path, bytes, { flag: "wx", mode: 0o600 })
          this.paths.add(path)
        }
        result.push({ type: "text", text: `Meridian image attachment (${mime}): use view_file to inspect exactly ${path}` })
      } else if (block.type === "tool_result") result.push(await this.toolResult(block))
      else result.push(block)
    }
    // Hooks may run while an HTTP continuation adds images. Atomic replacement
    // prevents an in-flight hook from observing a partially written allowlist.
    const list = join(this.workspace, "attachment-paths.json")
    await writeFile(list + ".tmp", JSON.stringify([...this.paths]), { mode: 0o600 })
    await rename(list + ".tmp", list)
    return result
  }
  async toolResult(result: AgResult): Promise<AgResult> {
    if (!Array.isArray(result.content)) return result
    const content = await this.content(result.content)
    return { ...result, content: content.filter(b => b.type === "text" || b.type === "image") }
  }
  async messages(messages: AgMessage[]): Promise<AgMessage[]> {
    const result: AgMessage[] = []
    for (const message of messages) result.push({ ...message, content: await this.content(blocks(message)) })
    return result
  }
}
