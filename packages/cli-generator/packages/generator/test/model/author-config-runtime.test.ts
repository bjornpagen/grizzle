import { Effect, Exit, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { AuthorConfig, decodeAuthorConfig, runtimeSettings } from "#model/author-config.ts"
import type { AuthorConfigContext } from "#model/author-config.ts"
import { DocumentUri } from "#model/brands.ts"

const document = Schema.decodeUnknownSync(DocumentUri)("file:///work/author.json")

const context: AuthorConfigContext = { document }

const base = { binName: "example", package: { name: "example-cli", version: "1.0.0" } }

const decode = (input: Schema.Json) => Effect.runSync(decodeAuthorConfig(input, context))

const encode = (input: Schema.Json) => Schema.encodeSync(AuthorConfig)(decode(input))

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

describe("author config runtime settings", () => {
	test("a valid runtime object decodes to its values", () => {
		const config = decode({
			...base,
			runtime: { timeoutSeconds: 0 }
		})

		expect(runtimeSettings(config)).toEqual({
			timeoutSeconds: 0
		})
	})

	test("the lower bounds decode", () => {
		const config = decode({
			...base,
			runtime: { timeoutSeconds: 3600 }
		})

		expect(runtimeSettings(config)).toEqual({
			timeoutSeconds: 3600
		})
	})

	test("an absent runtime object gives the defaults", () => {
		expect(runtimeSettings(decode(base))).toEqual({
			timeoutSeconds: 30
		})
	})

	test("an empty runtime object gives the defaults", () => {
		expect(runtimeSettings(decode({ ...base, runtime: {} }))).toEqual({
			timeoutSeconds: 30
		})
	})

	test("an absent field gives its default", () => {
		expect(runtimeSettings(decode({ ...base, runtime: { timeoutSeconds: 5 } }))).toEqual({
			timeoutSeconds: 5
		})
	})

	test.each([
		[
			"a retry count, which only the caller gives",
			{ retries: 2 },
			"/runtime/retries|CFG-1/unknown-key"
		],
		["negative timeout", { timeoutSeconds: -1 }, "/runtime/timeoutSeconds|CFG-1/invalid-value"],
		["timeout above 3600", { timeoutSeconds: 3601 }, "/runtime/timeoutSeconds|CFG-1/invalid-value"],
		["fractional timeout", { timeoutSeconds: 2.5 }, "/runtime/timeoutSeconds|CFG-1/invalid-value"],
		[
			"an idle timeout, which only the operator gives",
			{ idleTimeoutSeconds: 300 },
			"/runtime/idleTimeoutSeconds|CFG-1/unknown-key"
		],
		["an unknown key", { foo: 1 }, "/runtime/foo|CFG-1/unknown-key"]
	])("%s is refused", (_name, runtime, expected) => {
		expect(refusals({ ...base, runtime })).toEqual([expected])
	})

	test("a config without runtime keeps no runtime and round-trips", () => {
		expect(decode(base).runtime).toBeUndefined()
		expect(encode(base)).toEqual(base)
	})

	test("a config with a partial runtime round-trips unchanged", () => {
		const input = { ...base, runtime: { timeoutSeconds: 5 } }

		expect(encode(input)).toEqual(input)
	})

	test("a config with a full runtime round-trips unchanged", () => {
		const input = { ...base, runtime: { timeoutSeconds: 30 } }

		expect(encode(input)).toEqual(input)
	})
})
