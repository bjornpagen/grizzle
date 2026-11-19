import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { GenerationRow } from "#compiler/schema/api.ts"
import {
	closedBuilder,
	closedRelation as closedRelationBuilder,
	generatedRelation,
	relationBuilder
} from "#compiler/schema/relation.ts"
import type { FieldBase, GeneratedField } from "#compiler/types/fields/field.ts"
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
 * - `closed.ordered(name, handles)`, `closed.unordered(name, handles)`: a roster, as the root's.
 * - `closed.relation(name, fields, key, rows)`: a closed relation, as the root's; its value holds its facts, one per
 *   distinct row written, in `rows`.
 */

/** relation(name, fields, primaryKey): an ordinary relation of a name known only at run time. */
const ordinaryRelation = (
	name: string,
	fields: Readonly<Record<string, FieldBase>>,
	primaryKey: NonEmptyReadonlyArray<string>,
	...extra: ReadonlyArray<never>
): AnyRelation => relationBuilder(name, fields, primaryKey, extra)

/**
 * relation.generated(name, written, primaryKey, generate): a relation of a name known only at run time whose fields
 * `generate` returns PostgreSQL writes. Its row is the root's (schema/api.ts GenerationRow), typed by the written
 * fields' own types, the one thing the value's type does not keep that a term the callback builds reads.
 */
const generated = <const Written extends Readonly<Record<string, FieldBase>>>(
	name: string,
	written: Written,
	primaryKey: NonEmptyReadonlyArray<keyof Written & string>,
	generate: (
		row: GenerationRow<Relation<string, Written, NonEmptyReadonlyArray<keyof Written & string>>>
	) => Readonly<Record<string, GeneratedField<FieldBase>>>,
	...extra: ReadonlyArray<never>
): AnyRelation => generatedRelation(name, written, primaryKey, generate, extra)

export const relation: typeof ordinaryRelation & { readonly generated: typeof generated } =
	Object.freeze(Object.assign(ordinaryRelation, { generated }))

/** closed.ordered(name, handles): a roster of a name known only at run time, its handles in declared order. */
const orderedRoster = (
	name: string,
	handles: NonEmptyReadonlyArray<string>,
	...extra: ReadonlyArray<never>
): AnyRoster => closedBuilder(name, handles, "ordered", extra)

/** closed.unordered(name, handles): a roster of a name known only at run time whose order means nothing. */
const unorderedRoster = (
	name: string,
	handles: NonEmptyReadonlyArray<string>,
	...extra: ReadonlyArray<never>
): AnyRoster => closedBuilder(name, handles, "unordered", extra)

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
	readonly relation: typeof closedRelation
} = Object.freeze({ ordered: orderedRoster, unordered: unorderedRoster, relation: closedRelation })
