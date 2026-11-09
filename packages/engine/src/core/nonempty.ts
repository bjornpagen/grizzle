/** A list with at least one element, its first element typed present. */
export type NonEmptyReadonlyArray<A> = readonly [A, ...Array<A>]

export const isNonEmpty = <A>(xs: ReadonlyArray<A>): xs is NonEmptyReadonlyArray<A> => xs.length > 0

export const headNonEmpty = <A>(xs: NonEmptyReadonlyArray<A>): A => xs[0]

export const lastNonEmpty = <A>(xs: NonEmptyReadonlyArray<A>): A => xs.reduceRight((last) => last)

/** `f` applied to each element in order, keeping the list nonempty. */
export const mapNonEmpty = <A, B>(
	xs: NonEmptyReadonlyArray<A>,
	f: (a: A, i: number) => B
): NonEmptyReadonlyArray<B> => {
	const [head, ...tail] = xs
	return [f(head, 0), ...tail.map((a, i) => f(a, i + 1))]
}

/** `f`'s nonempty lists for each element in order, concatenated: nonempty. */
export const flatMapNonEmpty = <A, B>(
	xs: NonEmptyReadonlyArray<A>,
	f: (a: A, i: number) => NonEmptyReadonlyArray<B>
): NonEmptyReadonlyArray<B> => {
	const [first, ...rest] = mapNonEmpty(xs, f)
	return [...first, ...rest.flat()]
}

/** `xs` followed by `last`: nonempty whatever `xs` is. */
export const appendNonEmpty = <A>(xs: ReadonlyArray<A>, last: A): NonEmptyReadonlyArray<A> =>
	isNonEmpty(xs) ? [xs[0], ...xs.slice(1), last] : [last]

/** `xs` followed by every element of `ys`: nonempty whatever `xs` is. */
export const concatNonEmpty = <A>(
	xs: ReadonlyArray<A>,
	ys: NonEmptyReadonlyArray<A>
): NonEmptyReadonlyArray<A> => (isNonEmpty(xs) ? [xs[0], ...xs.slice(1), ...ys] : ys)

/** Every element of `xs`, then every element of `ys`: nonempty whatever `ys` is. */
export const extendNonEmpty = <A>(
	xs: NonEmptyReadonlyArray<A>,
	ys: ReadonlyArray<A>
): NonEmptyReadonlyArray<A> => (isNonEmpty(ys) ? [xs[0], ...xs.slice(1), ...ys] : xs)

/** `xs` in `compare`'s order, stable: as `toSorted`, still nonempty. */
export const sortNonEmpty = <A>(
	xs: NonEmptyReadonlyArray<A>,
	compare: (a: A, b: A) => number
): NonEmptyReadonlyArray<A> => {
	const [head] = xs
	const rest = xs.slice(1).toSorted(compare)
	const at = rest.findIndex((r) => compare(head, r) <= 0)
	const cut = at === -1 ? rest.length : at
	return [...appendNonEmpty(rest.slice(0, cut), head), ...rest.slice(cut)]
}

/** Each element of `xs` once, at its first position: still nonempty. */
export const dedupeNonEmpty = <A>(xs: NonEmptyReadonlyArray<A>): NonEmptyReadonlyArray<A> => {
	const [head] = xs
	return [head, ...xs.filter((x, i) => i > 0 && x !== head && xs.indexOf(x) === i)]
}
