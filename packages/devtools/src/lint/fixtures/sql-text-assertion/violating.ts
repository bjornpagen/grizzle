import { type EmittedText, emit } from "#lint/fixtures/sql-text-assertion/emitted.ts"

declare const assert: Readonly<{
	match: (actual: string, expected: string) => void
	doesNotMatch: (actual: string, expected: string) => void
	equal: (actual: unknown, expected: unknown) => void
	notEqual: (actual: unknown, expected: unknown) => void
}>

declare const containsText: (haystack: string, needle: string) => void

declare const lacksText: (haystack: string, needle: string) => void

const statement: EmittedText = emit("select 1")

const prose = "select 1"

assert.match(statement, "select") // violation

assert.doesNotMatch(emit("select 1"), "delete") // violation

containsText(statement, "select") // violation

assert.equal(statement, "select 1") // violation

assert.notEqual(statement, `delete from ${prose}`) // violation

assert.match(prose, "select")

assert.equal(statement, emit("select 1"))

assert.equal(prose, "select 1")

lacksText(statement, "delete")

containsText(prose, "select")
