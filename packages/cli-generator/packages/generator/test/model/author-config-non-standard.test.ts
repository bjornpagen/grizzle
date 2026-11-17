import { Effect, Exit, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { AuthorConfig, decodeAuthorConfig } from "#model/author-config.ts"
import type { AuthorConfigContext } from "#model/author-config.ts"
import { DocumentUri } from "#model/brands.ts"

const document = Schema.decodeUnknownSync(DocumentUri)("file:///work/author.json")

const context: AuthorConfigContext = { document }

const base = { binName: "example", package: { name: "example-cli", version: "1.0.0" } } as const

const decode = (input: Schema.Json) => Effect.runSync(decodeAuthorConfig(input, context))

const refusals = (input: Schema.Json) => {
	const exit = Effect.runSyncExit(decodeAuthorConfig(input, context))
	if (Exit.isSuccess(exit)) {
		throw new Error("expected a refusal")
	}

	const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
	if (failure === undefined) {
		throw new Error("expected a typed failure")
	}

	return failure.error.diagnostics.map((d) => `${d.pointer}|${d.code}`)
}

describe("author config nonStandard.deepObjectBrackets", () => {
	test("a string is refused as an invalid value", () => {
		expect(refusals({ ...base, nonStandard: { deepObjectBrackets: "true" } })).toEqual([
			"/nonStandard/deepObjectBrackets|CFG-1/invalid-value"
		])
	})

	test("a number is refused as an invalid value", () => {
		expect(refusals({ ...base, nonStandard: { deepObjectBrackets: 1 } })).toEqual([
			"/nonStandard/deepObjectBrackets|CFG-1/invalid-value"
		])
	})

	test("an unknown key under nonStandard is refused", () => {
		expect(refusals({ ...base, nonStandard: { deepObjectBrackets: true, x: 1 } })).toEqual([
			"/nonStandard/x|CFG-1/unknown-key"
		])
	})
})

describe("author config nonStandard.deepObjectScalars", () => {
	test("a non-boolean is refused as an invalid value", () => {
		expect(refusals({ ...base, nonStandard: { deepObjectScalars: "true" } })).toEqual([
			"/nonStandard/deepObjectScalars|CFG-1/invalid-value"
		])
		expect(refusals({ ...base, nonStandard: { deepObjectScalars: 1 } })).toEqual([
			"/nonStandard/deepObjectScalars|CFG-1/invalid-value"
		])
	})

	test("an unknown key beside it is refused", () => {
		expect(refusals({ ...base, nonStandard: { deepObjectScalars: true, scalars: true } })).toEqual([
			"/nonStandard/scalars|CFG-1/unknown-key"
		])
	})
})
