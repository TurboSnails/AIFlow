# Sample Project Spec

## US-1: Implement clamp(value, min, max)

`src/math.ts` exports a `clamp` function that currently always returns the
input value unchanged. Implement it so that:

- if `value` is less than `min`, return `min`
- if `value` is greater than `max`, return `max`
- otherwise, return `value`

Acceptance is verified by `test/math.test.ts`.
