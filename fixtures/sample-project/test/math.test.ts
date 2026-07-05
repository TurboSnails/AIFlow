import { describe, it, expect } from "vitest";
import { clamp } from "../src/math";

describe("clamp", () => {
  it("returns the value unchanged when it is within range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
  it("clamps to min when the value is below range", () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });
  it("clamps to max when the value is above range", () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });
});
