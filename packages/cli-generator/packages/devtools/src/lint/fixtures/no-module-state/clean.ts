import { Effect, Layer, Schema } from "effect"

const LIMITS: ReadonlyMap<string, number> = new Map([["max", 10]])

const NAMES: ReadonlyArray<string> = ["a", "b"]

const PAIR = [0, 0] as const

const TOTALS: Readonly<Record<string, number>> = {}

const BOX = { value: 0 } as const

const SHAPE: Readonly<{ value: number }> = { value: 0 }

const PATTERN = /^x+$/i

const Name = Schema.String.pipe(Schema.brand("Name"))

const program = Effect.succeed(1)

const live = Layer.empty

const double = (value: number): number => value * 2

declare global {
	var fixtureAnchor: number | undefined
}

export const anchor = (): number => {
	globalThis.fixtureAnchor = 1
	return (LIMITS.get("max") === undefined ? 0 : 1) + NAMES.length + PAIR[0] + BOX.value + SHAPE.value
}

export const local = (): number => {
	const scratch = new Map<string, number>()
	scratch.set("a", 1)
	return scratch.size
}

export const exposed = [TOTALS, PATTERN, Name, program, live, double] as const

export const registry = new WeakMap<object, string>()
export const seen = new WeakSet<object>()
export const encoder = new TextEncoder()
export const decoder = new TextDecoder("utf-8")
