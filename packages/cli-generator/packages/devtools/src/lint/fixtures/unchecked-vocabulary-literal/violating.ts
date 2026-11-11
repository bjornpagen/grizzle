import type {
	FaultTag,
	TodoFailure
} from "#lint/fixtures/unchecked-vocabulary-literal/vocabulary.ts"

declare const describe: (title: string, body: () => void) => void

declare const report: (tag: string) => void

declare const explain: (code: number, message: string) => void

declare const strictEqual: <A>(actual: A, expected: A, message?: string) => void

declare const fault: Readonly<{ tag: FaultTag; label: string }>

declare const failure: TodoFailure

declare const named: Readonly<{ _tag: string }>

export const spelled: string = "UnseenOccupant" // violation

report("PostgresTransientFailure") // violation

export const listed: ReadonlyArray<string> = ["TodoNotFound"] // violation

export const compared = fault.label === "UnseenOccupant" // violation

export const untagged = named._tag === "PostgresStatementRejected" // violation

strictEqual(named._tag, "TodoNotFound", "TodoNotFound") // violation

export const typed: FaultTag = "UnseenOccupant"

export const narrowed = fault.tag === "CursorOversized"

export const tagged = failure._tag === "PostgresTransientFailure"

strictEqual(failure._tag, "PostgresStatementRejected") // violation

strictEqual<TodoFailure["_tag"]>(failure._tag, "PostgresStatementRejected")

export const inferred = "CursorOversized"

describe("TodoNotFound", () => {})

explain(1, "PostgresTransientFailure")

export const word: string = "plain"

export const keyed = { TodoNotFound: 1 }

export const unknown: string = "SomethingElse"

export const picked = keyed["TodoNotFound"]
