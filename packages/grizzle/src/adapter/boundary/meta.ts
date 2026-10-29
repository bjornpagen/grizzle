import { Result, Schema } from "effect"
import { exact } from "#adapter/boundary/exact.ts"
import { fingerprintSchemas } from "#adapter/boundary/names.ts"
import { toResult } from "#adapter/engine.ts"
import { decode, noRevivers } from "#compiler/core/canonical.ts"
import { type CompileError, malformedArtifact } from "#compiler/core/errors.ts"
import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import {
	type MigrationMeta,
	type ReadMeta,
	readDecodedMeta
} from "#compiler/deploy/render/folder.ts"

const NonEmptyText = Schema.String.check(Schema.isMinLength(1))
const Fingerprint: Schema.Codec<SchemaFingerprint, string> = NonEmptyText.pipe(
	Schema.decodeTo(fingerprintSchemas.schema)
)

const CandidateIndex = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))

const Within = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("top") }),
	Schema.Struct({ kind: Schema.Literal("within"), candidate: CandidateIndex })
])

const MetaDecisionsSchema = Schema.Struct({
	candidates: Schema.Array(
		Schema.Struct({
			label: NonEmptyText,
			renames: Schema.Struct({
				kind: Schema.Literals(["relation", "field", "type", "login"]),
				removed: NonEmptyText,
				added: NonEmptyText
			}),
			requires: Schema.Array(CandidateIndex),
			witness: Schema.Struct({ choice: CandidateIndex, statement: CandidateIndex })
		})
	),
	choices: Schema.Array(
		Schema.Struct({
			file: NonEmptyText,
			within: Within,
			keep: NonEmptyText,
			offers: Schema.Array(
				Schema.Struct({
					candidate: CandidateIndex,
					statements: Schema.Array(NonEmptyText)
				})
			)
		})
	),
	confirms: Schema.Array(
		Schema.Struct({ file: NonEmptyText, statements: Schema.NonEmptyArray(NonEmptyText) })
	),
	losses: Schema.Array(
		Schema.Struct({
			file: NonEmptyText,
			within: Within,
			loses: Schema.Union([
				Schema.Struct({ kind: Schema.Literal("relation"), relation: NonEmptyText }),
				Schema.Struct({
					kind: Schema.Literal("field"),
					relation: NonEmptyText,
					field: NonEmptyText
				}),
				Schema.Struct({
					kind: Schema.Literal("schema"),
					schema: NonEmptyText,
					abandoned: Schema.NonEmptyArray(
						Schema.Struct({ schema: NonEmptyText, directory: NonEmptyText })
					)
				})
			]),
			statement: NonEmptyText,
			carriers: Schema.Array(CandidateIndex)
		})
	)
})

/** meta.json as the generator writes it. */
const metaFields = {
	schemaName: NonEmptyText,
	schema: NonEmptyText,
	source: Fingerprint,
	target: Fingerprint
} as const

/** Typed exactly against the engine's MigrationMeta, so the two cannot drift apart. */
const MigrationMetaSchema = exact<MigrationMeta>()(
	Schema.Union([
		Schema.Struct({
			kind: Schema.Literal("drafted"),
			...metaFields,
			decisions: MetaDecisionsSchema
		}),
		Schema.Struct({ kind: Schema.Literal("custom"), ...metaFields })
	])
)
const decodeMetaForm = Schema.decodeUnknownResult(MigrationMetaSchema)

/** The form of a folder's meta.json, as writeMeta writes it. */
export const decodeMeta = (text: string): Result.Result<MigrationMeta, CompileError> => {
	const value = decode(text, noRevivers)
	if (!value.ok) {
		return Result.fail(value.error)
	}
	return Result.mapError(decodeMetaForm(value.value, { onExcessProperty: "error" }), (issue) =>
		malformedArtifact("meta", [], `a migration's meta.json: ${issue.message}`)
	)
}

/** Reads a folder's meta.json: its form decoded once (decodeMeta), then what the form alone does not say (the engine's
 * readDecodedMeta). */
export const readMeta = (text: string): Result.Result<ReadMeta, CompileError> =>
	Result.flatMap(decodeMeta(text), (meta) => toResult(readDecodedMeta(meta)))
