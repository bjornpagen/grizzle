/** The one member of a list of exactly one, or undefined for any other length. */
export const only = <T>(list: ReadonlyArray<T>): T | undefined =>
	list.length === 1 ? list[0] : undefined
