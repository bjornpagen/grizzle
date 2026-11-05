import type { Built } from "#compiler/core/phantom.ts"
import type { SchemaInfo } from "#compiler/query/build/scope.ts"
import { relationHeading, sourceInfo, sourceValue } from "#compiler/query/build/state.ts"
import { malformed } from "#compiler/schema/protocol.ts"
import { namedRelation } from "#compiler/schema/relation.ts"
import { worldDraftOf } from "#compiler/schema/world.ts"
import type { Delta } from "#compiler/types/changeset/changeset.ts"
import type { Carriers, Headed } from "#compiler/types/core/phantom.ts"
import type { BuiltOver } from "#compiler/write/changeset/levels.ts"

/** The Delta as a JavaScript caller's read-back callback sees it: each side a source of any relation it names. */
export interface DeltaValue {
	readonly added: (relation: unknown) => Built
	readonly removed: (relation: unknown) => Built
}

/** The relation a member names, by its name: an ordinary relation of the schema, or of a ChangeSet over a role a whole
 * ordinary entry or a query entry, whose writability the role's write list decides. */
export const memberRelation = (relation: unknown, over: BuiltOver, label: string): string => {
	if (over.kind === "schema") {
		return writableRelation(relation, over, label)
	}
	const world = worldDraftOf(relation)
	if (world === undefined) {
		return writableRelation(relation, over, label)
	}
	const entry = over.entries.get(world.name)
	if (entry?.kind !== "world") {
		throw malformed(
			label,
			`a relation of the ChangeSet's role ${over.desc.name}; ${world.name} is not one of its relations`
		)
	}
	return world.name
}

/** What a relation no ChangeSet writes is, by its kind: a roster or a closed relation, whose rows the schema fixes, or a
 * derived relation, a stored query. */
const unwritable = (kind: "closed" | "closedRelation" | "derived"): string =>
	kind === "derived" ? "a derived relation" : "a closed relation"

/** The ordinary relation a delta, a member or a ChangeSet method names, by declared name, refused when it is not one of
 * the schema's ordinary relations (WritableCheck), or of a role's whole ordinary entries. */
const writableRelation = (relation: unknown, over: BuiltOver, label: string): string => {
	const schema = over.kind === "schema" ? over.desc : over.desc.base
	const named = namedRelation(relation, label)
	const name = named.name
	if (named.kind !== "relation") {
		throw malformed(
			label,
			`an ordinary relation; ${name} is ${unwritable(named.kind)}, which no ChangeSet writes`
		)
	}
	const declared = over.relations.get(name)
	if (declared === undefined) {
		throw malformed(
			label,
			`a relation of the ChangeSet's schema ${schema.name}; ${name} is not one of its relations`
		)
	}
	if (declared.kind !== "relation") {
		throw malformed(
			label,
			`an ordinary relation; ${name} is ${unwritable(declared.kind)}, which no ChangeSet writes`
		)
	}
	if (over.kind === "role" && over.entries.get(name)?.kind !== "whole") {
		throw malformed(
			label,
			`a relation of the ChangeSet's role ${over.desc.name}; ${name} is not one of its entries`
		)
	}
	return name
}

/** One side of the delta of `relation`, a source whose variables are minted over `carriers`, the relation's heading. */
const deltaSource = <C extends Carriers>(
	over: BuiltOver,
	info: SchemaInfo,
	side: "added" | "removed",
	relation: unknown,
	carriers: C
): Built & Headed<C> => {
	const label = `delta.${side}`
	const name = memberRelation(relation, over, label)
	const heading =
		worldDraftOf(relation) === undefined
			? relationHeading(relation, info.env, label)
			: sourceInfo(relation, label, info.env).heading
	return sourceValue(
		{ kind: "delta", side, relation: name },
		heading,
		carriers,
		`delta.${side}(${name})`
	)
}

/** The Delta of a ChangeSet over `over`, at its public type Delta<S>: each source's carriers are its relation's own
 * heading, which the relation's type names. A JavaScript caller's callback receives the same value (`DeltaValue`).
 * `read(name, (delta) => query)` calls its callback once, with a Delta over the ChangeSet's schema. delta.added(R) and
 * delta.removed(R) are sources of R's heading, recorded in the read-back's Description as a delta source
 * ({ kind: "delta", side, relation }): the facts of R this application made present, R in the final state minus R in
 * the initial state, and the facts it made absent, the reverse. Both are netted across strata. R is an ordinary
 * relation of some level of the schema (`WritableOf`), or of a ChangeSet over a role a whole ordinary entry or a query
 * entry, a source of the entry's heading (`deltaEntries` says which entries' deltas a write can deliver): a closed or
 * derived relation changes only through its declaration or db.refresh, never through a ChangeSet, so it has no delta.
 * A read-back may name the delta of an ordinary relation the ChangeSet does not write, which is empty; the checker
 * admits it and the write program supplies the empty relation. A delta source is local to the read-back: it carries no
 * schema and no origin, so it is matched only through `v` and `match` inside the callback's rules, like a relation
 * parameter. */
export const delta = <S>(over: BuiltOver, info: SchemaInfo): Delta<S> => {
	const value: Delta<S> = {
		added: (relation) => deltaSource(over, info, "added", relation, relation.heading),
		removed: (relation) => deltaSource(over, info, "removed", relation, relation.heading)
	}
	return Object.freeze(value)
}
