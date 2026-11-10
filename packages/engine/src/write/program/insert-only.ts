import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import { CompileError, type RoleAccess } from "#compiler/core/errors.ts"
import { defined } from "#compiler/core/invariant.ts"
import * as Result from "#compiler/core/result.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import type { CteBody, MergeWhen, SqlStatement, TableName } from "#compiler/sql/ast.ts"
import type { ArtifactStatement } from "#compiler/write/program/artifact.ts"

/** An UPDATE or a DELETE of a stored relation, which a role that writes by its insert list holds no privilege for. */
type BeyondInsert = Extract<RoleAccess, { readonly kind: "insert" }>

/** A table one data-modifying statement updates or deletes from, and which. */
interface Modified {
	readonly table: TableName
	readonly operation: BeyondInsert["operation"]
}

/** The data-modifying statements of a statement: itself and its WITH's CTEs, the only place PostgreSQL admits one. */
const bodiesOf = (statement: SqlStatement): ReadonlyArray<CteBody> =>
	statement.kind === "select" ||
	statement.kind === "insert" ||
	statement.kind === "update" ||
	statement.kind === "delete" ||
	statement.kind === "merge"
		? [statement, ...(statement.with?.ctes.map((c) => c.query) ?? [])]
		: []

/** What one WHEN of a MERGE does to its target beyond an insert: an update or a deletion, or nothing. */
const mergeModifies = (action: MergeWhen["action"]): ReadonlyArray<BeyondInsert["operation"]> => {
	switch (action.kind) {
		case "update":
			return ["UPDATE"]
		case "delete":
			return ["DELETE"]
		case "insert":
		case "insertDefault":
		case "doNothing":
			return []
	}
}

/** What one data-modifying statement updates or deletes: an UPDATE's and a DELETE's target, an INSERT's under ON
 * CONFLICT DO UPDATE, and a MERGE's target by each WHEN that updates or deletes. */
const modifiedBy = (body: CteBody): ReadonlyArray<Modified> => {
	switch (body.kind) {
		case "select":
			return []
		case "insert":
			return body.onConflict?.action.kind === "doUpdate"
				? [{ table: body.table, operation: "UPDATE" }]
				: []
		case "update":
			return [{ table: body.table, operation: "UPDATE" }]
		case "delete":
			return [{ table: body.table, operation: "DELETE" }]
		case "merge":
			return body.whens.flatMap((w) =>
				mergeModifies(w.action).map((operation) => ({ table: body.table, operation }))
			)
	}
}

/**
 * A write program of a role that writes by its insert list, refused where a statement of its artifact updates or
 * deletes: the role holds INSERT and SELECT alone on what it writes (physical/ddl/roles.ts grantedPrivileges), so
 * PostgreSQL would refuse that statement with 42501 when it runs. Compilation refuses it first, an OutsideRole at the
 * role naming the relation and the operation. Every statement counts, a member's and grizzle's own alike: the artifact
 * places a family's edits, recounts and refills among them (compile.ts familyProgram). Its first UPDATE, DELETE, INSERT
 * ON CONFLICT DO UPDATE or MERGE WHEN that updates or deletes, of a stored table, is refused, named by the relation of
 * `laws` the table is; a carrier is the program's own temporary table, no relation's. A program of reality or of a role that writes by its
 * write list passes.
 */
export const insertOnly = (
	schema: CheckedSchema,
	statements: ReadonlyArray<ArtifactStatement>,
	names: PhysicalNames,
	laws: LawModel
): Result.Result<undefined, CompileError> => {
	const world = schema.world
	if (world.kind !== "role" || world.role.writing === "write") {
		return Result.ok(undefined)
	}
	const tables = new Map<string, Map<string, string>>()
	for (const relation of laws.relations.keys()) {
		const table = names.relation(relation)
		const inSchema = tables.get(table.schema) ?? new Map<string, string>()
		inSchema.set(table.name, relation)
		tables.set(table.schema, inSchema)
	}
	for (const statement of statements) {
		for (const modified of bodiesOf(statement.ast).flatMap(modifiedBy)) {
			const table = modified.table
			if (typeof table !== "string") {
				const relation = defined(
					tables.get(table.schema)?.get(table.name),
					`the relation of ${table.schema}.${table.name}, a stored table a write program modifies`
				)
				return Result.err(
					CompileError.make({
						_tag: "OutsideRole",
						at: world.role.loc,
						role: world.role.name,
						access: { kind: "insert", relation, operation: modified.operation }
					})
				)
			}
		}
	}
	return Result.ok(undefined)
}
