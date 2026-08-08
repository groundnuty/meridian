/**
 * Unit tests for the profile-reordering helpers — pure functions, no mocks.
 */
import { describe, expect, it } from "bun:test"
import { moveInOrder, sortByOrder } from "../telemetry/profileOrder"

describe("moveInOrder", () => {
  const base = ["a", "b", "c", "d"]

  it("moves an item down", () => {
    expect(moveInOrder(base, 0, 2)).toEqual(["b", "c", "a", "d"])
  })

  it("moves an item up", () => {
    expect(moveInOrder(base, 3, 1)).toEqual(["a", "d", "b", "c"])
  })

  it("moves to the ends", () => {
    expect(moveInOrder(base, 2, 0)).toEqual(["c", "a", "b", "d"])
    expect(moveInOrder(base, 0, 3)).toEqual(["b", "c", "d", "a"])
  })

  it("returns an unchanged copy for a no-op move", () => {
    const out = moveInOrder(base, 1, 1)
    expect(out).toEqual(base)
    expect(out).not.toBe(base)
  })

  it("ignores out-of-range indices instead of corrupting the order", () => {
    expect(moveInOrder(base, -1, 2)).toEqual(base)
    expect(moveInOrder(base, 0, 9)).toEqual(base)
    expect(moveInOrder(base, 9, 0)).toEqual(base)
    expect(moveInOrder(base, 0, -1)).toEqual(base)
  })

  it("never mutates the input", () => {
    const input = ["a", "b", "c"]
    moveInOrder(input, 0, 2)
    expect(input).toEqual(["a", "b", "c"])
  })

  it("handles empty and single-item lists", () => {
    expect(moveInOrder([], 0, 0)).toEqual([])
    expect(moveInOrder(["only"], 0, 0)).toEqual(["only"])
  })
})

describe("sortByOrder", () => {
  const profiles = [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }]

  it("applies the saved order", () => {
    expect(sortByOrder(profiles, ["gamma", "alpha", "beta"]).map((p) => p.id))
      .toEqual(["gamma", "alpha", "beta"])
  })

  it("keeps config order when nothing is saved", () => {
    expect(sortByOrder(profiles, []).map((p) => p.id)).toEqual(["alpha", "beta", "gamma"])
  })

  it("appends profiles missing from the saved order, in their original order", () => {
    // "beta" was added after the order was last saved.
    expect(sortByOrder(profiles, ["gamma", "alpha"]).map((p) => p.id))
      .toEqual(["gamma", "alpha", "beta"])
  })

  it("ignores ids in the order that no longer exist", () => {
    expect(sortByOrder(profiles, ["deleted", "beta", "alpha", "gamma"]).map((p) => p.id))
      .toEqual(["beta", "alpha", "gamma"])
  })

  it("ignores a duplicated id rather than rendering the profile twice", () => {
    const out = sortByOrder(profiles, ["beta", "beta", "alpha"])
    expect(out.map((p) => p.id)).toEqual(["beta", "alpha", "gamma"])
    expect(out.length).toBe(3)
  })

  it("never mutates the input", () => {
    const input = [{ id: "alpha" }, { id: "beta" }]
    sortByOrder(input, ["beta", "alpha"])
    expect(input.map((p) => p.id)).toEqual(["alpha", "beta"])
  })
})
