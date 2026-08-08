/**
 * Site header + landing page layout contract.
 *
 * The shared header (profileBar.ts) is the single site chrome injected into
 * every HTML page: logo + wordmark + nav + live status pill. The landing
 * page must not duplicate it, and its profile cards are the profile
 * switcher (no dropdown).
 */

import { describe, expect, test } from "bun:test"
import { landingHtml } from "../telemetry/landing"
import { dashboardHtml } from "../telemetry/dashboard"
import { settingsPageHtml } from "../telemetry/settingsPage"
import { profilePageHtml } from "../telemetry/profilePage"
import { pluginPageHtml } from "../proxy/plugins/pluginPage"
import { profileBarCss, profileBarHtml, profileBarJs } from "../telemetry/profileBar"
import { FADE_FROM, GENERAL_WINDOW_TYPES, SPENT_AT } from "../telemetry/profileSpent"

const allPages: Array<[string, string]> = [
  ["landing", landingHtml],
  ["dashboard", dashboardHtml],
  ["settings", settingsPageHtml],
  ["profiles", profilePageHtml],
  ["plugins", pluginPageHtml],
]

describe("shared site header", () => {
  test("header markup has brand link, logo, and nav", () => {
    expect(profileBarHtml).toContain("meridian-header")
    // Brand links home and carries the logo mark + wordmark
    expect(profileBarHtml).toContain('href="/"')
    expect(profileBarHtml).toContain("<svg")
    expect(profileBarHtml).toContain("Meridian")
    // Full site nav
    for (const href of ["/telemetry", "/profiles", "/settings", "/plugins"]) {
      expect(profileBarHtml).toContain(`href="${href}"`)
    }
  })

  test("pages include the shared chrome and no duplicate body-level chrome", () => {
    for (const [name, html] of allPages) {
      // Shared header + its styles + its live poll are injected
      expect(html, `${name} missing profileBarHtml`).toContain(profileBarHtml)
      expect(html, `${name} missing profileBarCss`).toContain(profileBarCss)
      expect(html, `${name} missing profileBarJs`).toContain(profileBarJs)

      // Nav exists only in the shared header
      const navMatches = html.match(/<nav\b[^>]*>/g) ?? []
      expect(navMatches.length, `${name} has duplicate nav`).toBe(1)

      // No page carries an inline profile dropdown; profile cards / header pill do it
      expect(html, `${name} has inline profile dropdown`).not.toContain('<select id="profile-select"')
    }
  })
})

describe("landing page (at-a-glance dashboard)", () => {
  test("how-it-works intro explains the proxy port and setup docs", () => {
    expect(landingHtml).toContain("Harness Claude, your way.")
    expect(landingHtml).toContain("ANTHROPIC_BASE_URL")
    expect(landingHtml).toContain("https://github.com/rynfar/meridian/blob/main/docs/agents.md")
  })

  test("profile cards double as the switcher", () => {
    // Clickable card with affordance to activate another profile
    expect(landingHtml).toContain("data-profile=")
    expect(landingHtml).toContain("Click to activate")
    expect(landingHtml).toContain("POST")
    expect(landingHtml).toContain("/profiles/active")
    // Current profile is styled active
    expect(landingHtml).toContain("profile-card active")
  })

  test("profile card renders pace against the 7-day quota window", () => {
    // Pace row with bar, marker, percent delta, and reset countdown
    expect(landingHtml).toContain("usage-row pace-row")
    expect(landingHtml).toContain("w-label\">pace<")
    expect(landingHtml).toContain("pace-marker")
    expect(landingHtml).toContain("weeklyPace")
  })

  test("24h strip leads with operational signals, not debug metrics", () => {
    // Meaningful operational cards
    expect(landingHtml).toContain("Requests")
    expect(landingHtml).toContain("Est. API Value")
    expect(landingHtml).toContain("Failed Requests")
    // Token + cache signals are in; TTFB stays on the /telemetry page
    expect(landingHtml).toContain("tokenUsage")
    expect(landingHtml).toContain("Cache Hit")
    expect(landingHtml).not.toContain("Median TTFB")
    // Envelope violations render only when noteworthy
    expect(landingHtml).toContain("envelopeViolationCount>0")
  })

  test("spent accounts recede and unusable ones are flagged instead", () => {
    // The page carries a copy of the classifier's arithmetic, so its
    // thresholds are interpolated from the tested module rather than retyped.
    expect(landingHtml).toContain(`var FADE_FROM=${FADE_FROM}`)
    expect(landingHtml).toContain(`var SPENT_AT=${SPENT_AT}`)
    expect(landingHtml).toContain(`var GENERAL_WINDOW_TYPES=${JSON.stringify(GENERAL_WINDOW_TYPES)}`)
    expect(landingHtml).toContain("--spend-fade")
    expect(landingHtml).toContain("needs login")
  })

  test("account cards come from configured profiles, not synthetic cost buckets", () => {
    // With profiles configured, only pl.profiles render (no "default" card);
    // the single-account fallback labels the card with the login email.
    expect(landingHtml).toContain("configured.length>0")
    expect(landingHtml).toContain("k==='default'?(email||'account')")
  })
})

describe("design-system conformance (DESIGN.md)", () => {
  const pageSources = [
    "src/telemetry/landing.ts",
    "src/telemetry/dashboard.ts",
    "src/telemetry/settingsPage.ts",
    "src/telemetry/profilePage.ts",
    "src/proxy/plugins/pluginPage.ts",
  ]

  test("pages contain no hardcoded hex colors — tokens only", async () => {
    for (const path of pageSources) {
      const src = await Bun.file(path).text()
      const hexes = src.match(/#[0-9a-fA-F]{6}\b/g) ?? []
      expect(hexes, `${path} must use theme tokens, found: ${hexes.join(", ")}`).toEqual([])
    }
  })

  test("pages do not set their own body background (backsplash is shared)", async () => {
    for (const path of pageSources) {
      const src = await Bun.file(path).text()
      // Match `background:` or `background-color:` anywhere inside a `body { ... }` block
      const bodyBgMatches = src.match(/body\s*\{[^}]*\bbackground(-color)?\s*:[^}]+}/gi) ?? []
      expect(bodyBgMatches, `${path} sets body background; body bg is owned by profileBar.ts`).toEqual([])
    }
  })
})
