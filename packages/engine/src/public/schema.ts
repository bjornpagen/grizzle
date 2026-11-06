import { derived as derivedBuilder } from "#compiler/schema/relation.ts"
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
export { login } from "#compiler/program/workload/login.ts"
export type { AnyDerived, Derived, NoParams } from "#compiler/types/derived/derived.ts"
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
	ClosedRelationOptionRecord,
	ClosedRelationOptions,
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
	World,
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
	StatementsOf,
	StatementsWithin,
	UnderOwnNames
} from "#compiler/types/schema/schema.ts"

/**
 * Public barrel: relation (and relation.generated), closed (and closed.relation), derived, schema, the statement
 * constructors, and the worlds: context, role and login.
 *
 * relation, closed, schema and the statement constructors are the typed schema facade's (schema/api.ts), and login,
 * which admits the workloads it owns, the workload program's (program/workload/login.ts). derived's
 * precise signature is declared with the derived relation types (types/derived); the view here gives it to the one
 * builder of a derived relation's value (schema/relation.ts).
 *
 * derived(name, definition): a view over the one builder of a derived relation's value (schema/relation.ts derived),
 * which narrows its definition to one DefinitionCheck admits.
 */
export const derived: DerivedConstructor = <const Name extends string, Q extends DefinitionQuery>(
	name: Name,
	definition: Q & DefinitionCheck<Q>,
	...extra: ReadonlyArray<unknown>
): Derived<Name, Q> => derivedBuilder<Name, Q>(name, definition, extra)
