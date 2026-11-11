declare const pair: readonly [string, string]
declare const either: readonly [number] | readonly [number, number]
declare const optional: readonly [string, number?]
declare const lines: ReadonlyArray<string>
declare const join: (this: unknown, ...parts: Array<string>) => string
declare const area: (width: number, height?: number) => number
declare const label: (name: string, count?: number) => string

const out: Array<string> = []

out.push(...pair)

export const sized = area(...either)

export const labeled = label(...optional)

export const shaped = area(...[optional[1] ?? 0])

export const forward = (...args: Parameters<typeof area>): number => area(...args)

export const copied: ReadonlyArray<string> = [...lines, ...pair]

export const applied = join.apply(undefined, ["a", "b"])

export const reflected = Reflect.apply(join, undefined, ["a", "b"])

out.push(...["a", "b"])

for (const line of lines) {
	out.push(line)
}

export const superstarter = { apply: (...parts: ReadonlyArray<string>) => parts.length }

export const own = superstarter.apply(...pair)
