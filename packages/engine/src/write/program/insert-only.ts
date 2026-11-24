import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import { CompileError, type RoleAccess } from "#compiler/core/errors.ts"
import { headsOf } from "#compiler/ir/instant.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import type { CteBody, MergeWhen, ObjectName, SqlStatement, TableName } from "#compiler/sql/ast.ts"
import type { WriteWorld } from "#compiler/write/entry/precheck.ts"
import type { WriteNames } from "#compiler/write/insert/statement.ts"
import type { ArtifactStatement } from "#compiler/write/program/artifact.ts"

/** An UPDATE or a DELETE of a stored relation its role holds no privilege for, where it only inserts. */
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
 * A write program of a role, refused where a statement of its artifact updates or deletes from a table its role holds
 * no UPDATE or DELETE on (write/entry/precheck.ts WriteWorld `privileges`, physical/ddl/roles.ts grantedPrivileges):
 * a relation under its insert list, or the owner of a family whose open member is, whose recount the program makes, so
 * PostgreSQL would refuse that statement with 42501 when it runs. Compilation refuses it first, an OutsideRole at the
 * role naming the relation and the operation. Every statement counts, a member's and grizzle's own alike: the artifact
 * places a family's edits, recounts and refills among them (compile.ts familyProgram). Its first UPDATE, DELETE, INSERT
 * ON CONFLICT DO UPDATE or MERGE WHEN that updates or deletes, of a stored table its role does not hold the privilege
 * on, is refused, named by the relation of `laws` the table is or whose clock's or place's head it is, judged by that
 * relation's privilege (a place's release deletes its head's rows of the groups a delete of the relation removes,
 * write/insert/stamp.ts placeReleases); a carrier is the program's own temporary table, no relation's. A program of
 * reality passes.
 */
export const insertOnly = (
	schema: CheckedSchema,
	world: WriteWorld,
	statements: ReadonlyArray<ArtifactStatement>,
	names: WriteNames,
	laws: LawModel
): Result.Result<undefined, CompileError> => {
	const checked = schema.world
	if (checked.kind === "reality" || world.kind === "reality") {
		return Result.ok(undefined)
	}
	const tables = new Map<string, Map<string, string>>()
	const owned = (table: ObjectName, relation: string): void => {
		tables
			.getOrInsertComputed(table.schema, () => new Map<string, string>())
			.set(table.name, relation)
	}
	for (const relation of laws.relations.keys()) {
		owned(names.relation(relation), relation)
	}
	for (const head of headsOf(laws.theory.instants)) {
		owned(names.head(head.relation, head.field.name), head.relation)
	}
	for (const statement of statements) {
		for (const modified of bodiesOf(statement.ast).flatMap(modifiedBy)) {
			const table = modified.table
			if (typeof table === "string") {
				continue
			}
			const relation = defined(
				tables.get(table.schema)?.get(table.name),
				`the relation of ${table.schema}.${table.name}, a stored table a write program modifies`
			)
			if (world.privileges.get(relation)?.has(modified.operation) !== true) {
				return Result.err(
					CompileError.make({
						_tag: "OutsideRole",
						at: checked.role.loc,
						role: checked.role.name,
						access: { kind: "insert", relation, operation: modified.operation }
					})
				)
			}
		}
	}
	return Result.ok(undefined)
}
