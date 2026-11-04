import { Result, Schema } from "effect"
import { exact } from "#adapter/boundary/exact.ts"
import { fingerprintSchemas } from "#adapter/boundary/names.ts"
import { toResult } from "#adapter/engine.ts"
import { decode, noRevivers } from "#compiler/core/canonical.ts"
import { type CompileError, malformedArtifact } from "#compiler/core/errors.ts"
import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import type { CandidatePath } from "#compiler/deploy/diff/plan.ts"
import {
	type MetaFile,
	type MetaLosses,
	type MetaNestedRename,
	type MetaPlainOffer,
	type MetaRelationStep,
	type MetaRequires,
	type MetaRootRenames,
	type MetaSealedStep,
	type MetaTopOffer,
	type MigrationMeta,
	type ReadMeta,
	readDecodedMeta
} from "#compiler/deploy/render/folder.ts"

const NonEmptyText = Schema.String.check(Schema.isMinLength(1))
const Fingerprint: Schema.Codec<SchemaFingerprint, string> = NonEmptyText.pipe(
	Schema.decodeTo(fingerprintSchemas.schema)
)

const Ends = { removed: NonEmptyText, added: NonEmptyText } as const

const RelationPath = Schema.Struct({ kind: Schema.Literal("relation"), ...Ends })
const TypePath = Schema.Struct({ kind: Schema.Literal("type"), ...Ends })
const LoginPath = Schema.Struct({ kind: Schema.Literal("login"), ...Ends })

const CandidatePathSchema = exact<CandidatePath>()(
	Schema.Union([
		RelationPath,
		TypePath,
		LoginPath,
		Schema.Struct({ kind: Schema.Literal("field"), relation: NonEmptyText, ...Ends }),
		Schema.Struct({ kind: Schema.Literal("nested field"), parent: RelationPath, ...Ends })
	])
)

const RequiresSchema = exact<MetaRequires>()(
	Schema.Union([Schema.Struct({ kind: Schema.Literal("nothing") }), TypePath])
)

const RootRenamesSchema = exact<MetaRootRenames>()(
	Schema.Union([
		LoginPath,
		Schema.Struct({
			kind: Schema.Literal("type"),
			object: Schema.Literals(["TYPE", "DOMAIN"]),
			...Ends
		}),
		Schema.Struct({
			kind: Schema.Literal("field"),
			relation: NonEmptyText,
			...Ends,
			requires: RequiresSchema
		})
	])
)

const LossesSchema = exact<MetaLosses>()(
	Schema.Union([
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
	])
)

const PlainOfferSchema = exact<MetaPlainOffer>()(
	Schema.Union([
		Schema.Struct({
			kind: Schema.Literal("replace"),
			candidate: CandidatePathSchema,
			statements: Schema.NonEmptyArray(NonEmptyText)
		}),
		Schema.Struct({ kind: Schema.Literal("delete"), candidate: CandidatePathSchema })
	])
)

/** The steps of one place in a drafted file, a choice there offering what `offer` decodes: the depth of nesting is the
 * form's, a relation's alternative under a file's top and a sealed one under either, so no form recurses. */
const stepsOf = <O, E>(offer: Schema.Codec<O, E>) =>
	Schema.Union([
		Schema.Struct({ kind: Schema.Literal("statement"), statement: NonEmptyText }),
		Schema.Struct({
			kind: Schema.Literal("choice"),
			keep: NonEmptyText,
			offers: Schema.NonEmptyArray(offer),
			follows: Schema.Array(NonEmptyText)
		}),
		Schema.Struct({
			kind: Schema.Literal("loss"),
			loses: LossesSchema,
			statement: NonEmptyText,
			carriers: Schema.Array(CandidatePathSchema)
		}),
		Schema.Struct({
			kind: Schema.Literal("confirm"),
			statements: Schema.NonEmptyArray(NonEmptyText)
		})
	])

const SealedStepSchema = PlainOfferSchema.pipe(stepsOf, exact<MetaSealedStep>())

const NestedRenameSchema = exact<MetaNestedRename>()(
	Schema.Struct({
		kind: Schema.Literal("nested rename"),
		...Ends,
		requires: RequiresSchema,
		head: NonEmptyText,
		alternative: Schema.Array(SealedStepSchema)
	})
)

const RelationStepSchema = Schema.Union([NestedRenameSchema, PlainOfferSchema]).pipe(
	stepsOf,
	exact<MetaRelationStep>()
)

const TopOfferSchema = exact<MetaTopOffer>()(
	Schema.Union([
		Schema.Struct({
			kind: Schema.Literal("rename"),
			renames: RootRenamesSchema,
			head: NonEmptyText,
			alternative: Schema.Array(SealedStepSchema)
		}),
		Schema.Struct({
			kind: Schema.Literal("relation rename"),
			...Ends,
			head: NonEmptyText,
			alternative: Schema.Array(RelationStepSchema)
		}),
		PlainOfferSchema
	])
)

const MetaFileSchema = exact<MetaFile>()(
	Schema.Struct({ name: NonEmptyText, steps: Schema.Array(stepsOf(TopOfferSchema)) })
)

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
			files: Schema.Array(MetaFileSchema)
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
