/**
 * What each statement creates of the catalog the drift check describes, by the manifest identity the obligation graph
 * spells it with (graph.ts identText): a schema; a table, view, domain, type, index or function of a schema; a column, constraint, trigger or policy of a relation. The drift check owns every fact PostgreSQL describes by
 * an object of the manifest, the object the fact describes or the relation it lies in (the shell's
 * adapter/admission/drift.ts factOwner), so a catalog object a manifest object's DDL creates under any other identity
 * is owned by none: a fresh installation of it drifts at once, and its next migrate refuses. Two rules make that no
 * installation, both internal compiler errors:
 *
 * - every object a manifest object's DDL creates is the object itself or lies within it, a column, a constraint, a
 *   trigger or a policy of the relation it is (`assertCreatesOwned`), so one manifest object is one catalog object, as
 *   a head's table and its stamp function are two (physical/ddl/stamps.ts);
 * - every schema object a drafted folder creates that stands once it applied is one the target's manifest holds
 *   (`assertFolderCreatesHeld`): a temporary the folder renames into place stands under the name it takes, one it
 *   attaches as a key's index stands as the key, within its table, and one it drops stands not at all. An object within
 *   a relation is its relation's, which the drift check owns it by.
 *
 * A role, a membership, a publication, an extension and a grant are no description's, judged beside the descriptions,
 * so no rule here reads them.
 */
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import {
	innerIdent,
	namedIdent,
	parseIdent,
	qualifiedIdent
} from "#compiler/physical/obligations/graph.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"

/** A trigger's identity: its name within its table. */
const trigger = (s: {
	readonly name: string
	readonly table: { readonly schema: string; readonly name: string }
}): ReadonlyArray<string> => [innerIdent("trigger", s.table.schema, s.table.name, s.name)]

/** What an ALTER TABLE's action creates within its table `table`: a column it adds, or a constraint. */
const alteredIn = (
	table: { readonly schema: string; readonly name: string },
	a: Extract<SqlStatement, { readonly kind: "alterTable" }>["actions"][number]
): ReadonlyArray<string> => {
	switch (a.kind) {
		case "addColumn":
			return [innerIdent("column", table.schema, table.name, a.column.name)]
		case "addConstraint":
			return [innerIdent("constraint", table.schema, table.name, a.constraint.name)]
		case "addColumnDefault":
		case "addColumnPlaceholder":
		case "addColumnUnchecked":
		case "addConstraintUsingIndex":
		case "alterColumnType":
		case "alterConstraintDeferral":
		case "disableRowSecurity":
		case "dropColumn":
		case "dropConstraint":
		case "dropDefault":
		case "enableRowSecurity":
		case "replicaIdentity":
		case "setExpression":
		case "setNotNull":
		case "validateConstraint":
			return []
	}
}

/**
 * Every catalog object `s` creates that the drift check describes, by its manifest identity, every statement kind
 * decided here, so a new kind is a type error until it is.
 */
const createdIdents = (s: SqlStatement): ReadonlyArray<string> => {
	switch (s.kind) {
		case "createSchema":
			return [namedIdent("schema", s.name)]
		case "createTable":
		case "createLiveSecret":
			return [qualifiedIdent("table", s.table.schema, s.table.name)]
		case "createStoredTable":
			return [qualifiedIdent("table", s.name.schema, s.name.name)]
		case "alterTable":
			return s.actions.flatMap((a) => alteredIn(s.table, a))
		case "createDomain":
			return [qualifiedIdent("domain", s.name.schema, s.name.name)]
		case "createIndex":
			return [qualifiedIdent("index", s.table.schema, s.name)]
		case "createView":
			return [qualifiedIdent("view", s.name.schema, s.name.name)]
		case "createPolicy":
			return [innerIdent("policy", s.table.schema, s.table.name, s.name)]
		case "createFunction":
		case "createDeclaredFunction":
		case "createConstant":
		case "stubConstant":
			return [qualifiedIdent("function", s.name.schema, s.name.name)]
		case "packConstant":
			return [qualifiedIdent("function", s.function.schema, s.function.name)]
		case "createRowType":
			return [qualifiedIdent("type", s.name.schema, s.name.name)]
		case "alterRowType":
			return []
		case "createGuardTrigger":
		case "createImmutableGuardTrigger":
		case "createConstraintTrigger":
		case "createTransitionTrigger":
			return trigger(s)
		case "select":
		case "insert":
		case "update":
		case "delete":
		case "merge":
		case "rename":
		case "replaceConstant":
		case "renameColumn":
		case "renameConstraint":
		case "alterDomain":
		case "dropIndex":
		case "dropPolicy":
		case "drop":
		case "dropFunction":
		case "dropTrigger":
		case "handOverFunction":
		case "adoptRole":
		case "endHolders":
		case "createPublication":
		case "dropPublication":
		case "guardBracket":
		case "createRole":
		case "alterRole":
		case "grantRole":
		case "revokeRole":
		case "grant":
		case "revoke":
		case "grantColumns":
		case "alterDefaultPrivileges":
		case "createExtension":
		case "lockTable":
		case "comment":
		case "beginRead":
		case "beginWrite":
		case "commit":
		case "rollback":
		case "fillStored":
		case "setConstraintsImmediate":
			return []
	}
}

/** The identity of the relation an object within one lies in: a column's, constraint's, trigger's or policy's table or
 * view, under either kind; none for an object within none. */
const relationsOf = (ident: string): ReadonlyArray<string> => {
	const parsed = parseIdent(ident)
	switch (parsed.kind) {
		case "column":
		case "constraint":
		case "trigger":
		case "policy":
			return [
				qualifiedIdent("table", parsed.schema, parsed.relation),
				qualifiedIdent("view", parsed.schema, parsed.relation)
			]
		case "schema":
		case "extension":
		case "role":
		case "membership":
		case "privileges":
		case "publication":
		case "domain":
		case "type":
		case "table":
		case "view":
		case "index":
		case "statistics":
		case "function":
		case "rowSecurity":
		case "replicaIdentity":
		case "other":
			return []
	}
}

/**
 * The internal compiler error of a manifest object whose DDL creates a catalog object that is neither the object nor
 * within it (the module's header): every object of `objects` creates its own identity, and each object within a
 * relation only where the object is that relation or that object itself.
 */
export const assertCreatesOwned = (
	objects: ReadonlyArray<{ readonly ident: string; readonly ddl: ReadonlyArray<SqlStatement> }>
): void => {
	for (const o of objects) {
		for (const s of o.ddl) {
			for (const created of createdIdents(s)) {
				if (created !== o.ident && !relationsOf(created).includes(o.ident)) {
					defect(
						`the manifest object ${o.ident} creates ${created}, which is neither it nor within it: one manifest object is one catalog object, so the drift check owns every fact it describes`
					)
				}
			}
		}
	}
}

/** The identity a rename gives the schema object it renames, by the identity it had; none for a rename of an object
 * no schema holds. */
const renamed = (
	s: Extract<SqlStatement, { readonly kind: "rename" }>
): readonly [string, string] | undefined => {
	switch (s.object) {
		case "TABLE":
			return [
				qualifiedIdent("table", s.name.schema, s.name.name),
				qualifiedIdent("table", s.name.schema, s.to)
			]
		case "INDEX":
			return [
				qualifiedIdent("index", s.name.schema, s.name.name),
				qualifiedIdent("index", s.name.schema, s.to)
			]
		case "DOMAIN":
			return [
				qualifiedIdent("domain", s.name.schema, s.name.name),
				qualifiedIdent("domain", s.name.schema, s.to)
			]
		case "FUNCTION":
			return [
				qualifiedIdent("function", s.name.schema, s.name.name),
				qualifiedIdent("function", s.name.schema, s.to)
			]
		case "ROLE":
		case "SCHEMA":
			return undefined
	}
}

/**
 * The indexes an ALTER TABLE attaches as a key's (ADD CONSTRAINT ... USING INDEX), by identity: PostgreSQL renames each
 * to its constraint's name, so it stands as the key, within its table, and no longer as an index of its own name.
 */
const attachedIndexes = (s: SqlStatement): ReadonlyArray<string> =>
	s.kind === "alterTable"
		? s.actions.flatMap((a) =>
				a.kind === "addConstraintUsingIndex"
					? [qualifiedIdent("index", s.table.schema, a.index)]
					: []
			)
		: []

/** The schema objects a statement drops, by identity: a DROP's, a function's by its signature, an index's. */
const droppedBy = (s: SqlStatement): ReadonlyArray<string> =>
	s.kind === "drop"
		? droppedObject(s)
		: s.kind === "dropFunction"
			? [qualifiedIdent("function", s.name.schema, s.name.name)]
			: s.kind === "dropIndex"
				? [qualifiedIdent("index", s.name.schema, s.name.name)]
				: []

/** The schema object a DROP drops, by identity: none for a role's or a schema's. */
const droppedObject = (
	s: Extract<SqlStatement, { readonly kind: "drop" }>
): ReadonlyArray<string> => {
	switch (s.object) {
		case "TABLE":
			return [qualifiedIdent("table", s.name.schema, s.name.name)]
		case "VIEW":
			return [qualifiedIdent("view", s.name.schema, s.name.name)]
		case "DOMAIN":
			return [qualifiedIdent("domain", s.name.schema, s.name.name)]
		case "TYPE":
			return [qualifiedIdent("type", s.name.schema, s.name.name)]
		case "ROLE":
		case "SCHEMA":
			return []
	}
}

/**
 * The internal compiler error of a drafted folder, its statements `statements` in the order it runs them, that leaves
 * standing a schema object no object of the target's manifest is, its identities `held` (the module's header): each
 * object it creates stands from its statement on, under the name a later rename gives it, until a later statement drops
 * it or attaches it as a key's index, and every one standing at its end is held. An object within a relation is its
 * relation's, and stands as it does.
 */
export const assertFolderCreatesHeld = (
	statements: ReadonlyArray<SqlStatement>,
	held: ReadonlySet<string>
): void => {
	const standing = new Set<string>()
	for (const s of statements) {
		for (const gone of [...droppedBy(s), ...attachedIndexes(s)]) {
			standing.delete(gone)
		}
		if (s.kind === "rename") {
			const pair = renamed(s)
			if (pair !== undefined && standing.delete(pair[0])) {
				standing.add(pair[1])
			}
		}
		for (const created of createdIdents(s)) {
			if (relationsOf(created).length === 0) {
				standing.add(created)
			}
		}
	}
	for (const created of standing) {
		if (!held.has(created)) {
			defect(
				`the drafted folder leaves standing ${created}, which no object of the target's manifest is: every object a folder leaves standing is one the snapshot records, so the drift check owns it`
			)
		}
	}
}
