import { type EmittedText, emit } from "#lint/fixtures/sql-text-assertion/emitted.ts"

declare const assert: Readonly<{
	match: (actual: string, expected: string) => void
	equal: (actual: unknown, expected: unknown) => void
}>

declare const containsText: (haystack: string, needle: string) => void

const migration: EmittedText = emit("create table accounts ()")

assert.match(migration, "create table")

assert.equal(migration, "create table accounts ()")

containsText(migration, "accounts")
