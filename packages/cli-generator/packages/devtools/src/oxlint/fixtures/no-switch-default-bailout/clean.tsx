type Kind = "a" | "b"
export const label = (kind: Kind): string => {
	switch (kind) {
		case "a":
			return "A"
		case "b":
			return "B"
	}
}
