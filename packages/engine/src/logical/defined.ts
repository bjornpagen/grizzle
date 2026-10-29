/** Every pair of a nonempty list's first member with each later member, the chain an equivalence class is equated by. */
export const chain = <T>(members: ReadonlyArray<T>, f: (first: T, other: T) => void): void => {
	const [first, ...rest] = members
	if (first === undefined) {
		return
	}
	for (const other of rest) {
		f(first, other)
	}
}
