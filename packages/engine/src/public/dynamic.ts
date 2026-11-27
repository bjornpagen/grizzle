import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import {
	declaredNaming,
	derivedRosterNaming,
	type RelationNaming,
	type RosterNaming
} from "#compiler/ir/desc.ts"
import { recordsBuilder } from "#compiler/program/records.ts"
import type { GenerationRow } from "#compiler/schema/api.ts"
import {
	admitDerivedNaming,
	closedBuilder,
	closedRelation as closedRelationBuilder,
	type DerivedNamingInput,
	namedClosedBuilder,
	namedGeneratedRelation,
	namedRelationBuilder
} from "#compiler/schema/relation.ts"
import type { FieldBase, GeneratedField } from "#compiler/types/fields/field.ts"
import type {
	GeneratedRecords,
	NoRecordNames,
	RecordedQuery,
	RecordOwner
} from "#compiler/types/schema/records.ts"
import type {
	AnyClosedRelation,
	AnyRelation,
	AnyRoster,
	Relation
} from "#compiler/types/schema/relation.ts"

/**
 * @bjornpagen/grizzle/dynamic: the relation constructors of a schema whose relations' names are known only at run
 * time, a schema a program generates from data. The package root's constructors take a relation's name as one string
 * literal (types/schema/relation.ts RelationName), the key a schema's types hold the relation under; these take any
 * string, and their values' types say what that loses: each is AnyRelation, AnyRoster or AnyClosedRelation, whose name
 * is `string` and whose fields, key and rows are no type, so a schema that lists one holds its relations under any name
 * (types/schema/schema.ts Declared) and no typed statement, query or role reads its fields. What the types do not
 * state the run time checks, as it checks every JavaScript caller's: the one builder of each value (schema/relation.ts)
 * admits its arguments, its name a declared name, its fields descriptors, its key its own fields each once and its
 * rows facts of its fields, one per key. The root never re-exports this barrel, so the checked API stays the only one
 * an import of the package reaches.
 *
 * - `relation(name, fields, primaryKey)`, `relation.generated(name, written, primaryKey, generate)`: an ordinary
 *   relation, as the root's.
 * - `closed.ordered(name, handles)`, `closed.unordered(name, handles)`, `closed.zones(name, zones)`: a roster, as the
 *   root's.
 * - `closed.relation(name, fields, key, rows)`: a closed relation, as the root's; its value holds its facts, one per
 *   distinct row written, in `rows`.
 * - `records(stem, query, owner, ownerKey, { names })`: a query's records, as the root's (program/records.ts, its one
 *   builder), their stem any string and the names they state a run-time record of attachment paths to relation names,
 *   typed GeneratedRecords: every relation one of any name and every law a statement.
 * - `derivedName({ stem, path })`: relation, relation.generated and closed.unordered under a derived naming, as the
 *   root's derivedName, each typed as the door's own.
 *
 * Each of relation, relation.generated and closed.unordered is one view of its builder under a naming (ir/desc.ts
 * RelationNaming, RosterNaming), the door's declared and derivedName's derived.
 */

/** relation(name, fields, primaryKey) under `naming`: an ordinary relation of a name known only at run time. */
const ordinaryRelationNamed =
	(naming: RelationNaming) =>
	(
		name: string,
		fields: Readonly<Record<string, FieldBase>>,
		primaryKey: NonEmptyReadonlyArray<string>,
		...extra: ReadonlyArray<never>
	): AnyRelation =>
		namedRelationBuilder(name, naming, fields, primaryKey, extra)

const ordinaryRelation = ordinaryRelationNamed(declaredNaming)

/**
 * relation.generated(name, written, primaryKey, generate) under `naming`: a relation of a name known only at run time
 * whose fields `generate` returns PostgreSQL writes. Its row is the root's (schema/api.ts GenerationRow), typed by the
 * written fields' own types, the one thing the value's type does not keep that a term the callback builds reads.
 */
const generatedNamed =
	(naming: RelationNaming) =>
	<const Written extends Readonly<Record<string, FieldBase>>>(
		name: string,
		written: Written,
		primaryKey: NonEmptyReadonlyArray<string>,
		generate: (
			row: GenerationRow<Relation<string, Written, NonEmptyReadonlyArray<keyof Written & string>>>
		) => Readonly<Record<string, GeneratedField<FieldBase>>>,
		...extra: ReadonlyArray<never>
	): AnyRelation =>
		namedGeneratedRelation(name, naming, written, primaryKey, generate, extra)

const generated = generatedNamed(declaredNaming)

export const relation: typeof ordinaryRelation & { readonly generated: typeof generated } =
	Object.freeze(Object.assign(ordinaryRelation, { generated }))

/** closed.ordered(name, handles): a roster of a name known only at run time, its handles in declared order. */
const orderedRoster = (
	name: string,
	handles: ReadonlyArray<string>,
	...extra: ReadonlyArray<never>
): AnyRoster => closedBuilder(name, handles, "ordered", extra)

/** closed.unordered(name, handles) under `naming`: a roster of a name known only at run time whose order means
 * nothing. */
const unorderedRosterNamed =
	(naming: RosterNaming) =>
	(name: string, handles: ReadonlyArray<string>, ...extra: ReadonlyArray<never>): AnyRoster =>
		namedClosedBuilder(name, naming, handles, "unordered", extra)

const unorderedRoster = unorderedRosterNamed(declaredNaming)

/** closed.zones(name, zones): a roster of time zones of a name known only at run time. */
const zoneRoster = (
	name: string,
	zones: ReadonlyArray<string>,
	...extra: ReadonlyArray<never>
): AnyRoster => closedBuilder(name, zones, "zones", extra)

/**
 * closed.relation(name, fields, key, rows): a closed relation of a name known only at run time, its value's `rows` the
 * facts it keeps, a row written twice one fact.
 */
const closedRelation = (
	name: string,
	fields: Readonly<Record<string, FieldBase>>,
	key: NonEmptyReadonlyArray<string>,
	rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
	...extra: ReadonlyArray<never>
): AnyClosedRelation => closedRelationBuilder(name, fields, key, rows, extra)

export const closed: {
	readonly ordered: typeof orderedRoster
	readonly unordered: typeof unorderedRoster
	readonly zones: typeof zoneRoster
	readonly relation: typeof closedRelation
} = Object.freeze({
	ordered: orderedRoster,
	unordered: unorderedRoster,
	zones: zoneRoster,
	relation: closedRelation
})

/**
 * records(stem, query, owner, ownerKey, { names }): the records of `query` (program/records.ts) for a generated schema,
 * their stem known only at run time and `names` a record, read at run time, of relation names by attachment path
 * (recordPaths lists them), an empty one stating none. Built by records' one builder as the root's records are, which
 * admits every argument at run time: the stem, each stated path one of the query's attachments and each stated name a
 * declared name.
 */
export const records = (
	stem: string,
	query: RecordedQuery,
	owner: RecordOwner,
	ownerKey: NonEmptyReadonlyArray<string>,
	options: { readonly names: Readonly<Record<string, string>> },
	...extra: ReadonlyArray<never>
): GeneratedRecords =>
	recordsBuilder<string, RecordedQuery, RecordOwner, NonEmptyReadonlyArray<string>, NoRecordNames>(
		stem,
		query,
		owner,
		ownerKey,
		[options, ...extra]
	)

/**
 * derivedName({ stem, path }): the root's derivedName at the door, for a library that derives its relations' and
 * rosters' names from data known only at run time: relation, relation.generated and closed.unordered, each typed as the
 * door's own, each name readable at any length and refused for nothing but its characters and a collision, what it
 * installs hashed over it (schema/api.ts derivedName).
 */
export const derivedName = (
	naming: DerivedNamingInput,
	...extra: ReadonlyArray<never>
): {
	readonly relation: typeof ordinaryRelation
	readonly generated: typeof generated
	readonly unordered: typeof unorderedRoster
} => {
	const admitted = admitDerivedNaming(naming, extra)
	return Object.freeze({
		relation: ordinaryRelationNamed(admitted),
		generated: generatedNamed(admitted),
		unordered: unorderedRosterNamed(derivedRosterNaming)
	})
}
