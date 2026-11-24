import { recordsBuilder, recordsFactsOver, recordsQueryOver } from "#compiler/program/records.ts"
import { derivedBuilder } from "#compiler/schema/relation.ts"
import type {
	CheckedDefinition,
	DefinitionQuery,
	DefinitionKeys,
	DefinitionLevel,
	DefinitionView,
	Derived,
	RuleReadOf,
	DerivedConstructor
} from "#compiler/types/derived/derived.ts"
import type { HeadOf, ImmediateHeadOf } from "#compiler/types/query/query.ts"
import type {
	AnyRecords,
	OwnerFacts,
	RecordApart,
	RecordChildren,
	RecordedQuery,
	RecordFields,
	RecordLaws,
	RecordNames,
	RecordOwner,
	Records,
	RecordsInsert,
	RecordsOptions,
	RecordsQuery,
	NoRecordNames
} from "#compiler/types/schema/records.ts"
import type { RelationName } from "#compiler/types/schema/relation.ts"

export {
	alternatives,
	check,
	attested,
	closed,
	contained,
	context,
	counted,
	fin,
	fold,
	fn,
	fragment,
	key,
	law,
	Monoid,
	mirrors,
	mutable,
	on,
	ordered,
	pred,
	race,
	relation,
	role,
	row,
	rows,
	schema,
	select,
	series,
	tree,
	unit
} from "#compiler/schema/api.ts"
export { type NameFault, nameFaultText, parseDeclaredName } from "#compiler/core/identity.ts"
export { schemaNameOf, wholeSchemaNameOf } from "#compiler/program/names.ts"
export { login } from "#compiler/program/workload/login.ts"
export {
	insertableNamesOf,
	scopedEntriesOf,
	wholeEntriesOf,
	wholeWritesOf,
	writableNamesOf
} from "#compiler/schema/world.ts"
export type { AnyDerived, Derived, NoParams } from "#compiler/types/derived/derived.ts"
export type {
	AnyRecords,
	NoRecordNames,
	OwnerFacts,
	OwnerParams,
	RecordedQuery,
	RecordFields,
	RecordNames,
	RecordOwner,
	Records,
	RecordsInsert,
	RecordsQuery,
	StoredField,
	StoredFieldsOf
} from "#compiler/types/schema/records.ts"
export type {
	AnyFunction,
	AnyRow,
	AnyRows,
	DeclaredFunction,
	FunctionBody,
	FunctionType,
	Row,
	Rows
} from "#compiler/types/schema/function.ts"
export type { DeclaredLanguage, FunctionVolatility } from "#compiler/core/function.ts"
export type {
	Alternatives,
	AnyFamily,
	AnyFin,
	AnyMonoid,
	Check,
	Containment,
	Counted,
	ExpansionOf,
	Fin,
	Fold,
	Key,
	KeyFieldsOf,
	KeyRef,
	KeyValues,
	Mirrors,
	Mutable,
	Pred,
	Race,
	RelationOfKey,
	RowScalars,
	Selection,
	Series,
	Side,
	SlotField,
	Statement,
	Tree,
	Unit
} from "#compiler/types/schema/statements.ts"

export type {
	AnyClosed,
	AnyClosedRelation,
	AnyRelation,
	AnyRoster,
	ClosedRelation,
	Fact,
	HeadingOf,
	NameOf,
	Relation,
	RelationName,
	Roster
} from "#compiler/types/schema/relation.ts"

export type {
	AnyContext,
	AnyLogin,
	AnyLoginRole,
	AnyRole,
	AnyScoped,
	AnyWorld,
	Context,
	ContextField,
	ContextsReadBy,
	AttestedFactsOf,
	Login,
	LoginReadsToken,
	LoginRole,
	ReadsAttested,
	ReadsToken,
	Role,
	RoleOver,
	RolesOf,
	ScopableNameOf,
	Scoped,
	ScopedEntriesOf,
	ScopedOrWhole,
	ScopeOptions,
	WholeEntries,
	WholeEntriesOf,
	WholeWritesOf,
	World,
	WritableNameOf,
	WriteListOf
} from "#compiler/types/schema/world.ts"

export type {
	AllFragmentsOf,
	AnyFragment,
	AnySchema,
	ContainmentsOf,
	Declared,
	DeclaredOnce,
	DeclaredOver,
	Fragment,
	FragmentsIn,
	FragmentsOf,
	KeysOf,
	LawsOf,
	LevelsOf,
	RelationOf,
	RelationsOf,
	Schema,
	SchemaOver,
	StatementsBelow,
	StatementsByName,
	StatementsOf,
	StatementsReadBack,
	StatementsWithin
} from "#compiler/types/schema/schema.ts"

/**
 * Public barrel: relation (and relation.generated), closed (and closed.relation), derived, schema, fragment, the
 * statement constructors, the worlds: context, role (with wholeEntriesOf, wholeWritesOf and writableNamesOf, a full
 * role's entries, its insert and write lists and the names they share out, and scopedEntriesOf, a role's entries holding
 * each relation of its owner scoped) and login, insertableNamesOf, the relations a ChangeSet over a schema inserts at its top level, and
 * schemaNameOf, the installed name of a schema's or a role's PostgreSQL schema, wholeSchemaNameOf, the installed name
 * of the schema of a schema's relations' whole views, and parseDeclaredName, the declared-name
 * rule every builder and ownership judge a name by (with its fault, NameFault, and nameFaultText, the fault as the rule
 * states it), for a generator that writes declared names to judge each where it derives it. A login's and a role's
 * PostgreSQL role is roleNameOf's, the runtime's one function, which the package root re-exports.
 *
 * relation, closed, schema, fragment and the statement constructors are the typed schema facade's (schema/api.ts), and login,
 * which admits the workloads it owns, the workload program's (program/workload/login.ts). derived's
 * precise signature is declared with the derived relation types (types/derived); the view here gives it to the one
 * builder of a derived relation's value (schema/relation.ts).
 *
 * derived(name, definition): a view over the builder of a derived relation's value (schema/relation.ts derivedBuilder),
 * which narrows its definition to one DefinitionCheck admits. Whether its rows are stored is the installation's
 * inference from what its definition reads, never the caller's (analysis/derived/storage.ts).
 */
export const derived: DerivedConstructor = <const Name extends string, Q extends DefinitionQuery>(
	name: RelationName<Name>,
	definition: CheckedDefinition<Q>,
	...extra: ReadonlyArray<unknown>
): Derived<
	Name,
	DefinitionView<Q["heading"], DefinitionKeys<Q>, RuleReadOf<Q>, DefinitionLevel<Q>>
> => derivedBuilder<Name, Q>(name, definition, extra)

/**
 * records(stem, query, owner, ownerKey, { names }): the relations that hold the rows `query` found, for a level over the
 * query's to list (program/records.ts): `${stem}Row`, the owner's fields then each column of the query's heading as the
 * query's own field, keyed by `ownerKey`, a nonempty list of the owner's field names, as relation's primary key; and
 * each attachment's, at any depth, keyed by its parent's key and, for an array, its place, held to its parent by the law
 * of its delivery, named as `names` states for its path (its attachment names from the root joined by `.`) or as records
 * derive it. The options are optional: left out, no name is stated. A derived name PostgreSQL would cut short is
 * refused as RecordNameTooLong, whose fix is a name stated for its path. Its `relations` and `rules` are what the level
 * lists; `row` is the root, `apart` the relations an insert states beside it.
 */
export const records = <
	const Stem extends string,
	Q extends RecordedQuery,
	const Owner extends RecordOwner,
	const Key extends readonly [keyof Owner & string, ...Array<keyof Owner & string>],
	const Names extends RecordNames<Q> = NoRecordNames
>(
	stem: RelationName<Stem>,
	query: Q,
	owner: Owner,
	ownerKey: Key,
	...options: RecordsOptions<Q, Names>
): Records<
	Stem,
	HeadOf<Q>,
	ImmediateHeadOf<Q>,
	RecordFields<Owner, Q>,
	Owner,
	readonly [...Key],
	RecordChildren<Stem, Owner, readonly [...Key], Q, Names>,
	RecordLaws<Stem, Owner, readonly [...Key], Q, Names>,
	RecordApart<Stem, Owner, readonly [...Key], Q, Names>
> => recordsBuilder<Stem, Q, Owner, readonly [...Key], Names>(stem, query, owner, ownerKey, options)

/**
 * recordsQuery(level, records): the rows the records `stored` hold at one value of their owner's key, each key field a parameter
 * of its name, as `level`, which lists the records, reads them: an ordinary query, whose rows are the records' query's
 * own, HeadOf of it, read through that query's own decoder (program/records.ts).
 */
export const recordsQuery = <L, R extends AnyRecords>(
	level: L,
	stored: R,
	...extra: ReadonlyArray<never>
): RecordsQuery<L, R> => recordsQueryOver<L, R>(level, stored, extra)

/**
 * recordsFacts(level, records)(entries): the insert of found rows into the records `stored`, which `level` lists, each
 * row beside its owner's values (`[owner, row]`; one owner's several rows share it), as `ChangeSet.insertAll` takes it:
 * under the root's name each row's fact, its owner's values then its columns, each array's members nested at its count,
 * and under each other attachment's relation its facts (program/records.ts).
 */
export const recordsFacts = <L, R extends AnyRecords>(
	level: L,
	stored: R,
	...extra: ReadonlyArray<never>
): ((entries: Iterable<readonly [OwnerFacts<R>, HeadOf<R>]>) => RecordsInsert<L, R>) =>
	recordsFactsOver<L, R>(level, stored, extra)
