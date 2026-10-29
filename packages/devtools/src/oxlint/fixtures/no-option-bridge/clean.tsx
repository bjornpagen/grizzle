const Option = {
	getOrElse: (value: number | undefined, fallback: () => number): number => value ?? fallback()
}
export const index = Option.getOrElse(undefined, () => -1)
