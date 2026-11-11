import type {
	FaultTag,
	TodoFailure,
	TodoNotFound
} from "#lint/fixtures/unchecked-vocabulary-literal/vocabulary.ts"

declare const it: Readonly<{ effect: (title: string, body: () => void) => void }>

declare const refuse: (tag: TodoFailure["_tag"]) => void

declare const fault: Readonly<{ tag: FaultTag }>

export const typed: FaultTag = "UnseenOccupant"

refuse("PostgresTransientFailure")

export const narrowed = fault.tag !== "CursorOversized"

export const inferred = "TodoNotFound"

it.effect("TodoNotFound", () => {})

export const tagOf = (error: TodoFailure | TodoNotFound): number => {
	switch (error._tag) {
		case "TodoNotFound":
			return 1
		case "PostgresTransientFailure":
			return 2
		case "PostgresStatementRejected":
			return 3
	}
}

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
