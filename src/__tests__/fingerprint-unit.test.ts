/**
 * Unit tests for fingerprinting and CWD extraction.
 */
import { describe, it, expect } from "bun:test"
import { extractClientCwd, getConversationFingerprint } from "../proxy/session/fingerprint"

describe("extractClientCwd", () => {
  it("extracts CWD from string system prompt", () => {
    const body = {
      system: "<env>\n  Working directory: /Users/test/project\n  Platform: darwin\n</env>"
    }
    expect(extractClientCwd(body)).toBe("/Users/test/project")
  })

  it("extracts CWD from array system prompt", () => {
    const body = {
      system: [
        { type: "text", text: "<env>\n  Working directory: /home/user/app\n</env>" }
      ]
    }
    expect(extractClientCwd(body)).toBe("/home/user/app")
  })

  it("returns undefined when no system prompt", () => {
    expect(extractClientCwd({})).toBeUndefined()
    expect(extractClientCwd({ system: "" })).toBeUndefined()
  })

  it("returns undefined when no env block", () => {
    expect(extractClientCwd({ system: "You are a helpful assistant" })).toBeUndefined()
  })

  it("returns undefined when no working directory in env", () => {
    expect(extractClientCwd({ system: "<env>\n  Platform: darwin\n</env>" })).toBeUndefined()
  })

  it("handles multiline env blocks", () => {
    const body = {
      system: "Some preamble\n<env>\n  Working directory: /path/to/dir\n  Is a git repository: true\n  Platform: darwin\n</env>\nMore text"
    }
    expect(extractClientCwd(body)).toBe("/path/to/dir")
  })
})

describe("getConversationFingerprint", () => {
  it("returns a 16-char hex fingerprint", () => {
    const fp = getConversationFingerprint([{ role: "user", content: "hello" }])
    expect(fp).toHaveLength(16)
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
  })

  it("returns empty string for no user messages", () => {
    expect(getConversationFingerprint([{ role: "assistant", content: "hi" }])).toBe("")
  })

  it("returns empty string for empty messages", () => {
    expect(getConversationFingerprint([])).toBe("")
  })

  it("returns empty string for empty user content", () => {
    expect(getConversationFingerprint([{ role: "user", content: "" }])).toBe("")
  })

  it("is deterministic", () => {
    const msgs = [{ role: "user", content: "test" }]
    expect(getConversationFingerprint(msgs)).toBe(getConversationFingerprint(msgs))
  })

  it("differs by working directory", () => {
    const msgs = [{ role: "user", content: "same message" }]
    const fp1 = getConversationFingerprint(msgs, "/project/a")
    const fp2 = getConversationFingerprint(msgs, "/project/b")
    expect(fp1).not.toBe(fp2)
  })

  it("handles array content (text blocks)", () => {
    const msgs = [{ role: "user", content: [{ type: "text", text: "hello" }] }]
    const fp = getConversationFingerprint(msgs)
    expect(fp).toHaveLength(16)
  })

  it("uses only first user message", () => {
    const msgs = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ]
    const fpAll = getConversationFingerprint(msgs)
    const fpFirst = getConversationFingerprint([{ role: "user", content: "first" }])
    expect(fpAll).toBe(fpFirst)
  })
})

describe("getConversationFingerprint reminder stripping", () => {
  const bigReminder = (cwd: string) =>
    `<system-reminder>\n# Environment\n - Primary working directory: ${cwd}\n${"x".repeat(2400)}\n</system-reminder>`

  it("same reminder noise, different task text -> different fingerprints", () => {
    const fp1 = getConversationFingerprint([{
      role: "user",
      content: [{ type: "text", text: bigReminder("/repo") }, { type: "text", text: "Remember the code: AAAA" }],
    }], "/repo")
    const fp2 = getConversationFingerprint([{
      role: "user",
      content: [{ type: "text", text: bigReminder("/repo") }, { type: "text", text: "Remember the code: BBBB" }],
    }], "/repo")
    expect(fp1).not.toBe(fp2)
  })

  it("task text plus reminder noise matches bare task text", () => {
    const withReminder = [{
      role: "user",
      content: [{ type: "text", text: bigReminder("/repo") }, { type: "text", text: "fix the login bug" }],
    }]
    const bare = [{ role: "user", content: "fix the login bug" }]
    expect(getConversationFingerprint(withReminder, "/repo")).toBe(getConversationFingerprint(bare, "/repo"))
  })

  it("reminder-only text falls back to the raw text window", () => {
    const a = [{ role: "user", content: bigReminder("/repo") }]
    const b = [{ role: "user", content: bigReminder("/other-repo") }]
    expect(getConversationFingerprint(a, "/repo")).toHaveLength(16)
    expect(getConversationFingerprint(a, "/repo")).not.toBe(getConversationFingerprint(b, "/repo"))
  })

  it("strips multiple reminder blocks", () => {
    const two = "<system-reminder>\nfirst\n</system-reminder>\nmiddle\n<system-reminder>\nsecond\n</system-reminder>"
    const fpStripped = getConversationFingerprint([{ role: "user", content: two }])
    const fpBare = getConversationFingerprint([{ role: "user", content: "middle" }])
    expect(fpStripped).toBe(fpBare)
  })
})
