type NonEmptyReadonlyArray<A> = readonly [A, ...Array<A>]

declare const lines: ReadonlyArray<string>
declare const rows: Array<{ readonly width: number }>
declare const points: ReadonlyArray<number>
declare const handles: NonEmptyReadonlyArray<string>
declare const name: string
declare const seen: ReadonlySet<string>
declare const sum: (...values: ReadonlyArray<number>) => number
declare const parts: Array<string>
declare const join: (this: unknown, ...parts: Array<string>) => string

class Chunk {
	readonly parts: ReadonlyArray<string>

	constructor(...parts: ReadonlyArray<string>) {
		this.parts = parts
	}
}

const out: Array<string> = []

out.push(...lines) // violation

export const widest = Math.max(...rows.map((row) => row.width)) // violation

export const text = String.fromCodePoint(...points) // violation

out.push(...handles) // violation

export const largest = <T extends ReadonlyArray<number>>(values: T): number => sum(...values) // violation

out.push(...name) // violation

out.push(...seen) // violation

export const applied = join.apply(undefined, parts) // violation

export const reflected = Reflect.apply(join, undefined, parts) // violation

export const called = Function.prototype.call.apply(join, [undefined, ...parts]) // violation

export const built = new Chunk(...lines) // violation

export const constructed = Reflect.construct(Chunk, lines) // violation

out.push(...[...lines, "end"]) // violation
