import { certify, type RoleIsolation } from "#compiler/analysis/isolation/certify.ts"
import type { MemberFacts } from "#compiler/analysis/isolation/facts.ts"
import type { CheckedSchema, RoleWorld } from "#compiler/analysis/schema.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { isNonEmpty } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { TupleMap, TupleSet } from "#compiler/core/tuple-map.ts"
import { triggerLawsOver } from "#compiler/laws/model/model.ts"
import { checkedRole, grantedPrivileges } from "#compiler/physical/ddl/roles.ts"
import { type ExtractNames, memberFacts } from "#compiler/program/isolation/extract.ts"
import { isolationInput, type RoleSource } from "#compiler/program/isolation/input.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import type { CompiledVariants, RoleChanges } from "#compiler/program/workload/change.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import type { ArtifactStatement } from "#compiler/write/program/artifact.ts"
import type { CompiledWrite } from "#compiler/write/program/compile.ts"
import { refusalFunction } from "#compiler/write/refusal.ts"

/** The forms one statement may be sent in: its own, and its whole-relation form where an execution may choose it. */
const sentForms = (statement: ArtifactStatement): ReadonlyArray<SqlStatement> =>
	statement.forms.kind === "chosen" ? [statement.ast, statement.forms.large.ast] : [statement.ast]

/**
 * Every statement a compiled write's flight may send, in the order it sends them (adapter/apply/run.ts): its write
 * statements, each in every form an execution may send (write/program/served.ts projectWrite), then its read-backs',
 * which run in the change's own transaction at its level. A staged statement reads its nested rows from carriers in
 * place of its arrays and reads the stored relations its inline form reads (write/program/staged.ts), so its inline
 * form stands for it.
 */
const flightStatements = (compiled: CompiledWrite): ReadonlyArray<SqlStatement> => [
	...compiled.artifact.statements.filter((s) => s.step.kind !== "readBack").flatMap(sentForms),
	...compiled.artifact.readBacks.flatMap((r) => r.statements.flatMap(sentForms))
]

/** Every compiled write of a ChangeSet's variants, holding before lacking. */
const variantWrites = (variants: CompiledVariants): ReadonlyArray<CompiledWrite> =>
	variants.kind === "form"
		? [variants.entry.compiled]
		: [...variantWrites(variants.holding), ...variantWrites(variants.lacking)]

/**
 * How the extractor reads a role's statements back (program/isolation/extract.ts ExtractNames), from the names its
 * artifacts give the installation's objects:
 *
 * - a stored relation's table and a materialized derived relation's view are that relation, but a table the role writes
 *   under a row policy that reads another relation's table (a write entry whose filter reads others), whose reads no
 *   statement shows, is none;
 * - the role's view of a whole entry is its relation; a view of a query entry is none, its definition's reads being
 *   the view's own;
 * - a column of a stored relation's table is its field, and none of a law column;
 * - the refusal function, each closed relation's constant functions and each serial field's advance function read no
 *   table; any other function may.
 *
 * Every name the extractor meets that these do not name is a reason the certifier refuses, never a pass.
 */
const extractNames = (role: RoleChanges): ExtractNames => {
	const { artifacts, owned } = role
	const names = artifacts.names
	const stored = Object.entries(artifacts.owned.relations)
	const policed = new Set(
		[...owned.writes.values()].flatMap((w) =>
			w.kind === "rows" && w.writable.filter.kind === "query" && w.writable.filter.readsOther
				? [w.writable.target]
				: []
		)
	)
	const tabled = new Set(
		stored.flatMap(([name, r]) =>
			(r.kind === "relation" && !policed.has(name)) ||
			(r.kind === "derived" && r.view.kind !== "live")
				? [name]
				: []
		)
	)
	const relations = new TupleMap<readonly [string, string], string>()
	for (const name of tabled) {
		const table = names.relation(name)
		relations.set([table.schema, table.name], name)
	}
	const world = artifacts.world
	if (world.kind === "role") {
		for (const entry of Object.values(owned.relations)) {
			if (entry.kind === "whole" && tabled.has(entry.relation.name)) {
				const view = world.names.view(entry.name)
				relations.set([view.schema, view.name], entry.relation.name)
			}
		}
	}
	const columns = new TupleMap<readonly [string, string], string>()
	const refuse = refusalFunction(names.schema)
	const noTable = new TupleSet<readonly [string, string]>().add([refuse.schema, refuse.name])
	for (const [name, r] of stored) {
		if (r.kind === "relation") {
			for (const field of Object.values(r.fields)) {
				columns.set([name, names.column(name, field.name)], field.name)
				if (field.sequence !== undefined) {
					const advance = names.advance(name, field.name)
					noTable.add([advance.schema, advance.name])
				}
			}
		} else if (r.kind === "closedRelation") {
			for (const fn of names.closed(name).functions) {
				noTable.add([fn.schema, fn.name])
			}
		}
	}
	return {
		relationOf: (table) => relations.get([table.schema, table.name]),
		fieldOf: (relation, column) => columns.get([relation, column]),
		readsNoTable: (fn) => noTable.has([fn.schema, fn.name])
	}
}

/**
 * One role of a login as certification reads it (program/isolation/input.ts RoleSource): its login's and its own
 * declared name, its checked schema over the installation's, as the installation reads it to grant it
 * (physical/install/plan.ts planInstallation), the names its statements are read back by, and its change members.
 */
const roleSource = (
	artifacts: SchemaArtifacts,
	login: string,
	role: RoleChanges
): Result.Result<
	RoleSource<CheckedSchema<RoleWorld>, ExtractNames, CompiledVariants>,
	CompileError
> =>
	Result.map(
		checkedRole(artifacts.derived.schema, artifacts.names.levels, role.owned),
		(checked) => ({
			login,
			role: role.owned.name,
			checked: checked.checked,
			names: extractNames(role),
			members: [...role.members].map(([name, compiled]) => ({ name, compiled }))
		})
	)

/**
 * The certificate of every role of every login (analysis/isolation/certify.ts certify), from the installation's facts
 * over its artifacts `artifacts`, the configured schema's over every relation, and each login's roles with their change
 * members compiled once (program/workload/change.ts loginChanges), by the login's name: each relation's facts from the
 * law model, each role's privileges as its grants hold them (physical/ddl/roles.ts grantedPrivileges), and each change
 * member's facts read from every statement each of its variants' flights may send (extract.ts memberFacts). A role
 * certifies READ COMMITTED only when the certifier proves it from these; a variant that sends no statement has no facts.
 */
export const certification = (
	artifacts: SchemaArtifacts,
	changes: ReadonlyMap<string, ReadonlyMap<string, RoleChanges>>
): Result.Result<ReadonlyArray<RoleIsolation>, CompileError> => {
	const roles: Array<RoleSource<CheckedSchema<RoleWorld>, ExtractNames, CompiledVariants>> = []
	for (const [login, logged] of changes) {
		for (const role of logged.values()) {
			const source = roleSource(artifacts, login, role)
			if (!source.ok) {
				return source
			}
			roles.push(source.value)
		}
	}
	return Result.ok(
		certify(
			isolationInput({
				model: artifacts.laws,
				roles,
				triggerLawsOver,
				grantedPrivileges,
				memberFacts: (name, variants, names) =>
					variantWrites(variants).flatMap((write): ReadonlyArray<MemberFacts> => {
						const statements = flightStatements(write)
						return isNonEmpty(statements) ? [memberFacts(name, statements, names)] : []
					})
			})
		)
	)
}
