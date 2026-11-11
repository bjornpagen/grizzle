type Kind = "a" | "b"
export const nothing = (kind: Kind): string | null => {
	switch (kind) {
		case "a":
			return null
		default:
			return null // violation
	}
}
export const missing = (kind: Kind): string | undefined => {
	switch (kind) {
		default:
			return undefined // violation
	}
}
export const empty = (kind: Kind): string => {
	switch (kind) {
		default:
			return "" // violation
	}
}
export const none = (kind: Kind): ReadonlyArray<string> => {
	switch (kind) {
		default:
			return [] // violation
	}
}
export const bare = (kind: Kind): object => {
	switch (kind) {
		default:
			return {} // violation
	}
}
export const named = (kind: Kind): string => {
	switch (kind) {
		case "a":
			return "A"
		default:
			return "B"
	}
}
