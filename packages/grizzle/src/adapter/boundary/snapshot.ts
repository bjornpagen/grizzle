import { Effect, Result, Schema } from "effect"
import { exact } from "#adapter/boundary/exact.ts"
import { fingerprintSchemas, nameSchemas } from "#adapter/boundary/names.ts"
import { SqlStatementSchema } from "#adapter/boundary/sql.ts"
import { fromJson, noRevivers } from "#compiler/core/canonical.ts"
import { type CompileError, malformedArtifact } from "#compiler/core/errors.ts"
import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import { fingerprintHolds } from "#compiler/deploy/snapshot/build.ts"
import type {
	DeploySnapshot,
	SnapshotField,
	SnapshotLaw,
	SnapshotRelation,
	SnapshotResidual,
	SnapshotTheory
} from "#compiler/deploy/snapshot/types.ts"

import {
	accessUses,
	type InstallationManifest,
	type PhysicalObject,
	type PhysicalReason,
	physicalKinds,
	type ProgramAccess,
	type StoredIndexRequest
} from "#compiler/ir/products.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"

const Strings = Schema.Array(Schema.String)

const SchemaFingerprintSchema: Schema.Codec<SchemaFingerprint, string> = fingerprintSchemas.schema

const Statements = Schema.Array(SqlStatementSchema)

const SnapshotFieldSchema = exact<SnapshotField>()(
	Schema.Struct({
		name: Schema.String,
		column: nameSchemas.column,
		type: Schema.String,
		serial: Schema.Boolean
	})
)

const relationFields = {
	ident: nameSchemas.relation,
	mutable: Schema.Boolean,
	level: Schema.Finite
} as const
const headingFields = { fields: Schema.Array(SnapshotFieldSchema), primaryKey: Strings } as const

const SnapshotRelationSchema = exact<SnapshotRelation>()(
	Schema.Union([
		Schema.Struct({ kind: Schema.Literal("relation"), ...relationFields, ...headingFields }),
		Schema.Struct({
			kind: Schema.Literal("closed"),
			...relationFields,
			...headingFields,
			template: Schema.String
		}),
		Schema.Struct({ kind: Schema.Literal("derived"), ...relationFields })
	])
)

const SnapshotResidualSchema = exact<SnapshotResidual>()(
	Schema.Struct({
		family: Schema.String,
		digest: Schema.String,
		withoutUpdates: Schema.String,
		participants: Strings
	})
)

const SnapshotLawSchema = exact<SnapshotLaw>()(
	Schema.Union([
		Schema.Struct({ kind: Schema.Literal("native"), shape: Schema.String }),
		Schema.Struct({
			kind: Schema.Literal("residual"),
			shape: Schema.String,
			residual: SnapshotResidualSchema
		})
	])
)

const SnapshotTheorySchema = exact<SnapshotTheory>()(
	Schema.Struct({
		schema: SchemaFingerprintSchema,
		relations: Schema.Record(Schema.String, SnapshotRelationSchema),
		laws: Schema.Record(Schema.String, SnapshotLawSchema)
	})
)

const PhysicalReasonSchema = exact<PhysicalReason>()(
	Schema.Union([
		Schema.Struct({ kind: Schema.Literal("law"), law: nameSchemas.lawId }),
		Schema.Struct({ kind: Schema.Literal("access") }),
		Schema.Struct({ kind: Schema.Literal("enforcement"), of: Schema.String }),
		Schema.Struct({ kind: Schema.Literal("proof"), premises: Schema.Array(nameSchemas.lawId) })
	])
)

const PhysicalObjectSchema = exact<PhysicalObject<SqlStatement>>()(
	Schema.Struct({
		kind: Schema.Literals(physicalKinds),
		ident: Schema.String,
		ddl: Statements,
		reasons: Schema.Array(PhysicalReasonSchema),
		state: Schema.Literals(["needed", "created", "building", "validated", "trusted"]),
		phase: Schema.Literals(["setup", "structure", "indexes", "validate", "publish"])
	})
)

const InstallationManifestSchema = exact<InstallationManifest<SqlStatement>>()(
	Schema.Struct({
		objects: Schema.Array(PhysicalObjectSchema),
		edges: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })),
		roleDefaults: Statements,
		publicRevokes: Statements,
		comments: Statements
	})
)

/** The operator class of a key that names none: the type's default. */
const defaultOpclass: string | undefined = undefined

const requestFields = {
	relation: Schema.String,
	keys: Schema.Array(
		Schema.Struct({
			expr: Schema.String,
			dir: Schema.Literals(["asc", "desc"]),
			/** Absent in the snapshot JSON for the type's default operator class. */
			opclass: Schema.UndefinedOr(Schema.String).pipe(
				Schema.withDecodingDefaultKey(Effect.succeed(defaultOpclass))
			)
		})
	),
	method: Schema.Literals(["btree", "gist", "hnsw"])
} as const

/** A workload access request: the snapshot's accessPaths hold only the workload's. */
const IndexRequestSchema = exact<StoredIndexRequest>()(
	Schema.Struct({
		...requestFields,
		role: Schema.Literal("access"),
		use: Schema.Literals(accessUses)
	})
)

/** A workload program's access: the paths it reads through and the statistics it asks for (ir/products.ts). */
const ProgramAccessSchema = exact<ProgramAccess>()(
	Schema.Struct({
		paths: Schema.Array(
			Schema.Struct({
				relation: Schema.String,
				derived: Schema.Boolean,
				method: Schema.Literals(["btree", "gist", "hnsw"]),
				keys: Schema.Array(
					Schema.Struct({ field: Schema.String, dir: Schema.Literals(["asc", "desc"]) })
				),
				use: Schema.Literals(accessUses)
			})
		),
		statistics: Schema.Array(
			Schema.Struct({
				relation: Schema.String,
				columns: Strings,
				use: Schema.Literals(["correlated selection", "grouping"])
			})
		)
	})
)

/** Each table's or domain's constraint names to the law a violation reports (ir/products.ts ConstraintLaws). */
const ConstraintLawsSchema = Schema.Struct({
	tables: Schema.Record(
		nameSchemas.relation,
		Schema.Record(nameSchemas.constraint, nameSchemas.lawId)
	),
	domains: Schema.Record(
		nameSchemas.domain,
		Schema.Record(nameSchemas.constraint, nameSchemas.lawId)
	)
})

const contentFields = {
	schemaName: Schema.String,
	schema: Schema.String,
	theory: SnapshotTheorySchema,
	manifest: InstallationManifestSchema,
	constraintToLaw: ConstraintLawsSchema,
	workload: Schema.Record(Schema.String, Schema.Record(Schema.String, ProgramAccessSchema)),
	accessPaths: Schema.Array(IndexRequestSchema)
} as const

const DeploySnapshotSchema = exact<DeploySnapshot>()(
	Schema.Struct({
		fingerprint: SchemaFingerprintSchema,
		...contentFields
	})
)

const decodeForm = Schema.decodeUnknownResult(DeploySnapshotSchema)
const decodeJsonText = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))

/** Parses a snapshot from its JSON form, the value JSON.parse or a JSON import of snapshot.json yields: its canonical
 * tags revived once (`fromJson`), then its form decoded once as a snapshot of the documented form, its recorded
 * fingerprint checked against its content (build.ts fingerprintHolds): a hand-edited file is never trusted. The file is
 * the application's, edited and
 * merged outside the process, so its form is parsed before it is used, and nothing downstream checks it again. The
 * schema is annotated with `DeploySnapshot`, so the two cannot drift apart. A key the form does not have is refused,
 * and a revived DeploySnapshot is not the JSON form and is refused (a bigint is no JSON value). Writing and
 * fingerprinting spell each clause that is none by leaving it out (build.ts snapshotForm), so the file has one
 * spelling. */
export const parseSnapshot = (json: unknown): Result.Result<DeploySnapshot, CompileError> => {
	const revived = fromJson(json, noRevivers)
	if (!revived.ok) {
		return Result.fail(revived.error)
	}
	const decoded = Result.mapError(
		decodeForm(revived.value, { onExcessProperty: "error" }),
		(issue) =>
			malformedArtifact("snapshot", [], `a snapshot of the documented form: ${issue.message}`)
	)
	if (Result.isFailure(decoded)) {
		return decoded
	}
	const holds = fingerprintHolds(decoded.success)
	if (!holds.ok) {
		return Result.fail(holds.error)
	}
	return holds.value
		? decoded
		: Result.fail(
				malformedArtifact(
					"snapshot",
					[],
					"a snapshot whose recorded fingerprint is its content's: this one was edited by hand"
				)
			)
}

/** Reads snapshot.json's text: its JSON parsed, then parseSnapshot. The empty snapshot is never a file: a schema without
 * snapshot.json starts from emptySnapshot. */
export const readSnapshot = (text: string): Result.Result<DeploySnapshot, CompileError> => {
	const json = decodeJsonText(text)
	return Result.isFailure(json)
		? Result.fail(malformedArtifact("snapshot", [], "JSON text"))
		: parseSnapshot(json.success)
}
