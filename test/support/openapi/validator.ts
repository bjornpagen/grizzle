import {
	hasSchema,
	registerSchema,
	type SchemaObject,
	unregisterSchema,
	validate,
	type Validator
} from "@hyperjump/json-schema/draft-2020-12"
import { validate as validateOas } from "@hyperjump/json-schema/openapi-3-2"
import { Array as Arr, Effect } from "effect"
import { sha256Hex } from "#compiler/core/sha256.ts"
import { trusted, trustedJson } from "#compiler/core/trusted.ts"
import { fileText, repoRoot } from "#test/support/files.ts"

/**
 * The one door the OpenAPI documents' tests validate through: JSON Schema 2020-12 by @hyperjump/json-schema 1.18.0, the
 * validator the fork of the CLI generator pins, offline. The official OpenAPI 3.2 schema is vendored beside this file,
 * its bytes pinned by their SHA-256, and registered under its own `$id` before any document is judged, so no network is
 * reached at test time; the OAS dialect and its base schema are the validator's own, bundled with it.
 */

/** A JSON value as the validator takes one. */
type Json = Parameters<Validator>[0]

/** The vendored official schema of OpenAPI 3.2 documents (https://spec.openapis.org/oas/3.2/schema/2025-09-17). */
const officialPath = `${repoRoot}test/support/openapi/oas-3.2-schema-2025-09-17.json`

/** The SHA-256 of the vendored schema's bytes, lowercase hex, as fetched from spec.openapis.org on 2026-11-11. */
export const officialSha256 = "0c9d74bf25f9b9388b2d81e421ef60fdefa9feffa94898dadfc501b342b3bfcc"

/** The official schema's `$id`, under which it is registered. */
const officialId = "https://spec.openapis.org/oas/3.2/schema/2025-09-17"

/** The OAS 3.2 base schema, which also validates every Schema Object under the OAS dialect (bundled by the validator). */
const baseId = "https://spec.openapis.org/oas/3.2/schema-base"

/**
 * The vendored schema, its bytes held to their pinned SHA-256 and registered once: a schema whose bytes differ is a
 * defect of the checkout, never a schema the documents are judged by.
 */
const official: Effect.Effect<void> = Effect.gen(function* () {
	const text = yield* fileText(officialPath)
	const digest = sha256Hex(text)
	if (digest !== officialSha256) {
		return yield* Effect.die(
			new Error(`the vendored OAS 3.2 schema's SHA-256 is ${digest}, not ${officialSha256}`)
		)
	}
	if (!hasSchema(officialId)) {
		yield* Effect.sync(() => registerSchema(trustedJson<SchemaObject>(text), officialId))
	}
})

/** The instance locations of every failing leaf of an output, in order. */
const failures = (unit: {
	readonly instanceLocation: string
	readonly keyword: string
	readonly errors?: ReadonlyArray<unknown>
}): ReadonlyArray<string> => [`${unit.instanceLocation} ${unit.keyword}`]

/**
 * Where a document breaks the official OpenAPI 3.2 schema and the OAS base schema (every Schema Object under the OAS
 * dialect): each failing keyword's instance location, none for a valid document.
 */
export const documentErrors = (document: unknown): Effect.Effect<ReadonlyArray<string>> =>
	Effect.gen(function* () {
		yield* official
		const value = trusted<Json>(document)
		const byOfficial = yield* Effect.promise(() => validate(officialId, value, "BASIC"))
		const byBase = yield* Effect.promise(() => validateOas(baseId, value, "BASIC"))
		return [
			...(byOfficial.valid ? [] : Arr.flatMap(byOfficial.errors ?? [], failures)),
			...(byBase.valid ? [] : Arr.flatMap(byBase.errors ?? [], failures))
		]
	}).pipe(Effect.orDie)

/** A fresh retrieval URI for one schema judged on its own. */
const scratchId = (n: number): string => `urn:grizzle:test:schema:${n}`

/**
 * Whether `schema`, a JSON Schema 2020-12 object a document holds, admits `value`: registered under a fresh URI for the
 * one judgement and unregistered after it, so no schema outlives its case. `n` names the URI, unique among the
 * judgements running at once.
 */
export const schemaAdmits = (schema: unknown, value: unknown, n: number): Effect.Effect<boolean> =>
	Effect.acquireUseRelease(
		Effect.sync(() => {
			const id = scratchId(n)
			registerSchema(
				trusted<SchemaObject>({
					$schema: "https://json-schema.org/draft/2020-12/schema",
					...trusted<object>(schema)
				}),
				id
			)
			return id
		}),
		(id) =>
			Effect.promise(() => validate(id, trusted<Json>(value), "FLAG")).pipe(
				Effect.map((out) => out.valid)
			),
		(id) => Effect.sync(() => unregisterSchema(id))
	).pipe(Effect.orDie)
