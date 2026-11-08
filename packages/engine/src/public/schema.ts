import {
	derived as derivedBuilder,
	materializedDerived as materializedBuilder
} from "#compiler/schema/relation.ts"
import type {
	DefinitionCheck,
	DefinitionQuery,
	Derived,
	DerivedConstructor
} from "#compiler/types/derived/derived.ts"

export {
	alternatives,
	check,
	closed,
	constant,
	contained,
	context,
	counted,
	fin,
	fold,
	key,
	Monoid,
	mirrors,
	mutable,
	on,
	ordered,
	pred,
	relation,
	role,
	schema,
	select,
	tree
} from "#compiler/schema/api.ts"
export { lawsOf } from "#compiler/program/laws.ts"
export { roleNameOf, schemaNameOf } from "#compiler/program/names.ts"
export { login } from "#compiler/program/workload/login.ts"
export { insertableNamesOf, wholeEntriesOf, writableNamesOf } from "#compiler/schema/world.ts"
export type { AnyDerived, Derived, NoParams } from "#compiler/types/derived/derived.ts"
export type {
	Alternatives,
	AnyFamily,
	AnyFin,
	AnyMonoid,
	Check,
	Constant,
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
	RelationOfKey,
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
	Roster,
	SerialFieldsOf
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
	Login,
	LoginReadsContext,
	LoginRole,
	ReadsContext,
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
	AnySchema,
	ContainmentsOf,
	KeysOf,
	LawsOf,
	LevelsOf,
	RelationOf,
	RelationsOf,
	Schema,
	StatementsBelow,
	StatementsByName,
	StatementsOf,
	StatementsReadBack,
	StatementsWithin,
	UnderOwnNames
} from "#compiler/types/schema/schema.ts"

/**
 * Public barrel: relation (and relation.generated), closed (and closed.relation), derived, schema, the statement
 * constructors, the worlds: context, role (with wholeEntriesOf and writableNamesOf, a full role's entries and write
 * list) and login, insertableNamesOf, the relations a ChangeSet over a schema inserts at its top level, and roleNameOf
 * and schemaNameOf, the installed names of a login's, a role's and a schema's PostgreSQL role and schema.
 *
 * relation, closed, schema and the statement constructors are the typed schema facade's (schema/api.ts), and login,
 * which admits the workloads it owns, the workload program's (program/workload/login.ts). derived's
 * precise signature is declared with the derived relation types (types/derived); the view here gives it to the one
 * builder of a derived relation's value (schema/relation.ts).
 *
 * derived(name, definition) and derived.materialized(name, definition): views over the builders of a derived
 * relation's value (schema/relation.ts derived and materializedDerived), which narrow its definition to one
 * DefinitionCheck admits.
 */
export const derived: DerivedConstructor = Object.freeze(
	Object.assign(
		<const Name extends string, Q extends DefinitionQuery>(
			name: Name,
			definition: Q & DefinitionCheck<Q>,
			...extra: ReadonlyArray<unknown>
		): Derived<Name, Q, "live"> => derivedBuilder<Name, Q>(name, definition, extra),
		{
			materialized: <const Name extends string, Q extends DefinitionQuery>(
				name: Name,
				definition: Q & DefinitionCheck<Q>,
				...extra: ReadonlyArray<unknown>
			): Derived<Name, Q, "materialized"> => materializedBuilder<Name, Q>(name, definition, extra)
		}
	)
)
