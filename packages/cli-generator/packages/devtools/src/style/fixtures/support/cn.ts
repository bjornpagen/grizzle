type ClassValue =
	| string
	| false
	| null
	| undefined
	| Readonly<Record<string, boolean>>
	| ReadonlyArray<ClassValue>

const valuesOf = (input: ClassValue): ReadonlyArray<string> => {
	if (typeof input === "string") {
		return [input]
	}
	if (input === false || input === null || input === undefined) {
		return []
	}
	if (Array.isArray(input)) {
		return input.flatMap(valuesOf)
	}
	return Object.keys(input)
}

/** The fixtures' class helper: joins class values the way clsx does. */
export const cn = (...inputs: ReadonlyArray<ClassValue>): string => inputs.flatMap(valuesOf).join(" ")
