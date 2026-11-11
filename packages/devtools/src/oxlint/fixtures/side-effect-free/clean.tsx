/* @__NO_SIDE_EFFECTS__ */
export const brand = <A, B extends A>(): ((value: A) => B) => {
	const claim: (value: A) => asserts value is B = () => undefined
	return (value) => {
		claim(value)
		return value
	}
}

/* @__NO_SIDE_EFFECTS__ */
export function twice(value: number): number {
	let total = 0
	for (let step = 0; step < 2; step++) {
		total += value
	}
	return total
}

/* @__NO_SIDE_EFFECTS__ */
export const tagged = (value: { readonly n: number }) => Object.freeze({ ...value, tag: "t" })

/* @__NO_SIDE_EFFECTS__ */
const minted = (value: number): number => brand<number, number>()(twice(value))

/* @__NO_SIDE_EFFECTS__ */
export const kept = (values: ReadonlyArray<number>): boolean =>
	Array.isArray(values) && Number.isInteger(values.length) && Object.is(values, values)

/* @__NO_SIDE_EFFECTS__ */
export const swapped = (pair: readonly [number, number]): readonly [number, number] => {
	let [first, second] = pair
	;[first, second] = [second, first]
	const local = { first }
	return [local.first, second]
}

/* @__NO_SIDE_EFFECTS__ */
export const invoked = (value: number): number => ((n: number) => n + 1)(value)

let counter = 0

export const unmarked = (): number => {
	counter += 1
	return counter
}

export const used = minted(2)

/* @__NO_SIDE_EFFECTS__ */
export const derive = (spec: {
	readonly base: number
	readonly compute: (base: number) => number
}): number => spec.compute(spec.base)

export const limit = Object.freeze({ value: 3 })

const label = `n${1}`

const step = 2

const made = twice(4)

/* @__NO_SIDE_EFFECTS__ */
export const converted = (value: number): string =>
	`${String(BigInt(Math.floor(value)))}${(1n + 2n).toString()}${(value * 2).toString(16)}${label}${step}${made}${limit.value}`

export const derivedValue = derive({ base: 2, compute: (base) => Math.max(base, step) * 2 })

export const derivedTwice = derive({ base: 2, compute: twice })
