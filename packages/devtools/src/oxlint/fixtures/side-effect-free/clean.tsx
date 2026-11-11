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
