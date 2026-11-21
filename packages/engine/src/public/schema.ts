import { recordsBuilder, recordsFactsOver, recordsQueryOver } from "#compiler/program/records.ts"
import {
	derivedBuilder,
	materializedDerived as materializedBuilder
} from "#compiler/schema/relation.ts"
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
	RecordOwner,
	Records,
	RecordsInsert,
	RecordsQuery
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
	Monoid,
	mirrors,
	mutable,
	on,
	ordered,
	pred,
	race,
	relation,
	retirable,
	role,
	row,
	rows,
	schema,
	select,
	tree
} from "#compiler/schema/api.ts"
export { constraintNamesOf, lawsByStatement, lawsOf } from "#compiler/program/laws.ts"
export type {
	AdmittedRow,
	CheckNameOf,
	CheckVerdict,
	DomainRefused,
	EvaluatedRow,
	GeneratedFieldOf,
	RowEvaluation,
	RowEvaluator,
	RowSource,
	SourceRelation,
	Unevaluated,
	ValueRefused
} from "#compiler/types/schema/evaluation.ts"
export { type NameFault, nameFaultText, parseDeclaredName } from "#compiler/core/identity.ts"
export { schemaNameOf } from "#compiler/program/names.ts"
export { login } from "#compiler/program/workload/login.ts"
export { insertableNamesOf, wholeEntriesOf, writableNamesOf } from "#compiler/schema/world.ts"
export type { AnyDerived, Derived, NoParams } from "#compiler/types/derived/derived.ts"
export type {
	AnyRecords,
	OwnerFacts,
	OwnerParams,
	RecordedQuery,
	RecordFields,
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
	Retirable,
	RowScalars,
	Selection,
	Side,
	SlotField,
	Statement,
	Tree
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
	RefreshListOf,
	Role,
	RolesOf,
	WholeEntries,
	WholeEntriesOf,
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
 * statement constructors, the worlds: context, role (with wholeEntriesOf and writableNamesOf, a full role's entries and write
 * list) and login, insertableNamesOf, the relations a ChangeSet over a schema inserts at its top level, and
 * schemaNameOf, the installed name of a schema's or a role's PostgreSQL schema, and parseDeclaredName, the declared-name
 * rule every builder and ownership judge a name by (with its fault, NameFault, and nameFaultText, the fault as the rule
 * states it), for a generator that writes declared names to judge each where it derives it. A login's and a role's
 * PostgreSQL role is roleNameOf's, the runtime's one function, which the package root re-exports.
 *
 * relation, closed, schema, fragment and the statement constructors are the typed schema facade's (schema/api.ts), and login,
 * which admits the workloads it owns, the workload program's (program/workload/login.ts). derived's
 * precise signature is declared with the derived relation types (types/derived); the view here gives it to the one
 * builder of a derived relation's value (schema/relation.ts).
 *
 * derived(name, definition) and derived.materialized(name, definition): views over the builders of a derived
 * relation's value (schema/relation.ts derivedBuilder and materializedDerived), which narrow its definition to one
 * DefinitionCheck admits.
 */
export const derived: DerivedConstructor = Object.freeze(
	Object.assign(
		<const Name extends string, Q extends DefinitionQuery>(
			name: RelationName<Name>,
			definition: CheckedDefinition<Q>,
			...extra: ReadonlyArray<unknown>
		): Derived<
			Name,
			DefinitionView<Q["heading"], DefinitionKeys<Q>, RuleReadOf<Q>, DefinitionLevel<Q>>,
			"live"
		> => derivedBuilder<Name, Q>(name, definition, extra),
		{
			materialized: <const Name extends string, Q extends DefinitionQuery>(
				name: RelationName<Name>,
				definition: CheckedDefinition<Q>,
				...extra: ReadonlyArray<unknown>
			): Derived<
				Name,
				DefinitionView<Q["heading"], DefinitionKeys<Q>, RuleReadOf<Q>, DefinitionLevel<Q>>,
				"materialized"
			> => materializedBuilder<Name, Q>(name, definition, extra)
		}
	)
)

/**
 * records(stem, query, owner, ownerKey): the relations that hold the rows `query` found, for a level over the query's to
 * list (program/records.ts): `${stem}Row`, the owner's fields then each column of the query's heading as the query's
 * own field, keyed by `ownerKey`, a nonempty list of the owner's field names, as relation's primary key; and each
 * attachment's, at any depth, keyed by its parent's key and, for an array, its place, held to its parent by the law of
 * its delivery. Its `relations` and `rules` are what the level lists; `row` is the root, `apart` the relations an insert
 * states beside it.
 */
export const records = <
	const Stem extends string,
	Q extends RecordedQuery,
	const Owner extends RecordOwner,
	const Key extends readonly [keyof Owner & string, ...Array<keyof Owner & string>]
>(
	stem: RelationName<Stem>,
	query: Q,
	owner: Owner,
	ownerKey: Key,
	...extra: ReadonlyArray<never>
): Records<
	Stem,
	HeadOf<Q>,
	ImmediateHeadOf<Q>,
	RecordFields<Owner, Q>,
	Owner,
	readonly [...Key],
	RecordChildren<Stem, Owner, readonly [...Key], Q>,
	RecordLaws<Stem, Owner, readonly [...Key], Q>,
	RecordApart<Stem, Owner, readonly [...Key], Q>
> => recordsBuilder<Stem, Q, Owner, readonly [...Key]>(stem, query, owner, ownerKey, extra)

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
