/**
 * A value its owner holds, computed where it is first read and held after: the engine's one lazy value. A reader gives
 * the computation (Lazy `read`), or `once` closes over it, so an owner that cannot name the computation where it is made
 * (program/schema.ts CompiledSchema, whose family inserts and laws program/preview.ts and program/laws.ts compute)
 * holds the value all the same.
 */
export class Lazy<A> {
	#held: { readonly value: A } | undefined

	/** The value: `compute`'s, where it is first read, then the one held. */
	read(compute: () => A): A {
		this.#held ??= { value: compute() }
		return this.#held.value
	}
}

/** A value computed where it is first read, then read from its holder (Lazy). */
export const once = <A>(compute: () => A): (() => A) => {
	const held = new Lazy<A>()
	return () => held.read(compute)
}
