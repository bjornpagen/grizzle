import type { FaultTag, RefusalTag } from "#lint/fixtures/unchecked-vocabulary-literal/vocabulary.ts"

declare const it: (title: string, body: () => void) => void

declare const refuse: (tag: RefusalTag) => void

declare const fault: Readonly<{ tag: FaultTag }>

export const typed: FaultTag = "UnseenOccupant"

refuse("MalformedDescription")

export const narrowed = fault.tag !== "CursorOversized"

export const inferred = "CursorOversized"

it("UnseenOccupant", () => {})

export const labelOf = (tag: FaultTag): number => {
	switch (tag) {
		case "UnseenOccupant":
			return 1
		case "CursorOversized":
			return 2
		case "plain":
			return 3
	}
}
