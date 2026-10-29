import type { FaultTag } from "#lint/fixtures/unchecked-vocabulary-literal/vocabulary.ts"

declare const describe: (title: string, body: () => void) => void

declare const report: (tag: string) => void

declare const explain: (code: number, message: string) => void

declare const fault: Readonly<{ tag: FaultTag; label: string }>

export const spelled: string = "UnseenOccupant" // violation

report("MalformedDescription") // violation

export const listed: ReadonlyArray<string> = ["CursorOversized"] // violation

export const compared = fault.label === "UnseenOccupant" // violation

export const typed: FaultTag = "UnseenOccupant"

export const narrowed = fault.tag === "CursorOversized"

export const inferred = "CursorOversized"

describe("UnseenOccupant", () => {})

explain(1, "MalformedDescription")

export const word: string = "plain"

export const keyed = { MalformedDescription: 1 }

export const unknown: string = "SomethingElse"

export const picked = keyed["MalformedDescription"]
