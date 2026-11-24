import type {
	DeclaredLanguage,
	FunctionNullInput,
	FunctionVolatility
} from "#compiler/core/function.ts"
import { bodyBuilder, fnBuilder, rowBuilder, rowsBuilder } from "#compiler/schema/function.ts"
import { lawBuilder } from "#compiler/schema/law-entries.ts"
import {
	closedBuilder,
	closedRelation as closedRelationBuilder,
	generatedRelation,
	relationBuilder
} from "#compiler/schema/relation.ts"
import { fragmentBuilder, schemaBuilder } from "#compiler/schema/schema.ts"
import {
	alternativesBuilder,
	checkBuilder,
	containedBuilder,
	countedBuilder,
	finBuilder,
	foldBuilder,
	keyBuilder,
	mirrorsBuilder,
	monoids,
	mutableBuilder,
	onBuilder,
	orderedBuilder,
	predBuilder,
	raceBuilder,
	selectBuilder,
	seriesBuilder,
	treeBuilder,
	unitBuilder
} from "#compiler/schema/statements.ts"
import { attestedBuilder, contextBuilder, roleBuilder } from "#compiler/schema/world.ts"
import type {
	DeclaredName,
	MembersTyped,
	Hosted,
	Parameterless,
	Predicate,
	Refusal,
	Simplify
} from "#compiler/types/core/phantom.ts"
import type { AnyDerived, RuleReadDerived } from "#compiler/types/derived/derived.ts"
import type {
	FieldBase,
	GeneratedField,
	HandleOf,
	NamedIds,
	StoredOnlySql,
	WritingTag
} from "#compiler/types/fields/field.ts"
import type {
	AnyFunction,
	AnyRows,
	ArgsCheck,
	DeclaredFunction,
	FunctionBody,
	FunctionType,
	HeadingCheck,
	Row as RowOf,
	Rows as RowsOf,
	SignatureCheck
} from "#compiler/types/schema/function.ts"
import type {
	AnyClosed,
	AnyClosedRelation,
	AnyRelation,
	AnyRoster,
	ClosedIdFieldOf,
	ClosedRelation,
	DistinctFields,
	DistinctHandles,
	FactOfFields,
	KeyFieldOf,
	Relation,
	ConflictsAtKey,
	KeyLawRefusal,
	RelationName,
	Roster
} from "#compiler/types/schema/relation.ts"

import type {
	AnyFragment,
	AnySchema,
	Declared,
	DeclaredOnce,
	DerivedAt,
	Extended,
	Fragment,
	FragmentsIn,
	LeastOf,
	LeastRecord,
	LeastStated,
	LevelsOf,
	MutablesUnder,
	Schema,
	StatementsByName,
	StatementsOf,
	StatementsReadBack,
	StatementsWithin
} from "#compiler/types/schema/schema.ts"

import type { MonoidName } from "#compiler/ir/desc.ts"
import type {
	Alternatives,
	AnyFamily,
	AnyFin,
	AnyMonoid,
	AnySide,
	ArmsApartFromParent,
	ArmsCompatible,
	ArmsOfRoster,
	AtLeastOneArm,
	Check,
	Containment,
	Counted,
	CountedMember,
	CountFieldIn,
	FamilySlots,
	DiscriminatorsOf,
	DistinctTerms,
	Fin,
	FinShows,
	Fold,
	FoldEnd,
	FoldStep,
	Key,
	KeyRef,
	MemberRelationOf,
	Mirrors,
	Monoid as MonoidOf,
	Mutable,
	NoSetKey,
	OrderedFamily,
	IndexOfCount,
	CountedCount,
	OrderedMember,
	OverSlots,
	OwnerRelationOf,
	KeyShows,
	Pred,
	Race,
	RowScalars,
	Selection,
	SelfFamily,
	Series,
	Showing,
	ShowingKeyed,
	ShowingKind,
	Shows,
	Side,
	SideHosts,
	SideShows,
	SideShowsKeyed,
	SidesCompatible,
	SourceShowing,
	Statement,
	TermOf,
	Tree,
	TreeRootOf,
	Unit
} from "#compiler/types/schema/statements.ts"

import type {
	AnyContext,
	Context,
	ContextField,
	ContextOptions,
	DeclaredContexts,
	DistinctWrites,
	EntriesCheck,
	EntryValue,
	Role,
	RoleOptionRecord,
	RoleRelations,
	WritableKeys,
	WritesOpen
} from "#compiler/types/schema/world.ts"

/**
 * The typed schema facade: relation, relation.generated, closed, closed.relation, schema, schema.extend, the statement
 * constructors, context and role under their precise public signatures (types/schema; login, which admits its
 * workloads, is program/workload/login.ts), each a view over the one builder of its value in this package
 * (relation.ts, schema.ts, statements.ts, world.ts), and the one module that exports the public names. A builder checks
 * a JavaScript caller's arguments through its admission core, records the Description, and owns the literal of its
 * arguments, frozen copies (protocol.ts ownValue), so the value has its public type by construction; its type
 * parameters are as wide as that value allows, and a view here narrows them to what the public signature states and
 * calls the builder with them. A list a builder copies is typed `readonly [...T]`, which is T itself for every list a
 * call writes. A JavaScript caller's extra argument is refused; the types admit none. The public barrel
 * public/schema.ts exports these; test/unit/schema pins the runtime behavior and test/types/schema the signatures.
 *
 * The third argument is the primary key: a required, nonempty list of the relation's own field names, each once, in
 * the order written. The value holds a frozen copy of it, `readonly [...PrimaryKey]`, which is PrimaryKey itself for
 * every key a call writes.
 */
const ordinaryRelation = <
	const Name extends string,
	const Fields extends Record<string, FieldBase>,
	const PrimaryKey extends readonly [KeyFieldOf<Fields>, ...KeyFieldOf<Fields>[]]
>(
	name: RelationName<Name>,
	fields: Fields & NamedIds<Fields>,
	primaryKey: PrimaryKey & DistinctFields<PrimaryKey>,
	...extra: ReadonlyArray<never>
): Relation<Name, Fields, readonly [...PrimaryKey]> =>
	relationBuilder<Name, Fields, PrimaryKey>(name, fields, primaryKey, extra)

/** A relation's generated fields are named apart from its written ones: a field is written one way. */
type GeneratedApart<Written, G> = [keyof Written & keyof G] extends [never]
	? unknown
	: Refusal<"a generated field is named apart from the relation's written fields">

/**
 * The fields of R no generation expression reads: a generated one, as PostgreSQL's never reads another.
 */
type UnreadByGenerationOf<R> = R extends { readonly fields: infer Fields }
	? {
			[K in keyof Fields]-?: Fields[K] extends { readonly writing: "generated" } ? K : never
		}[keyof Fields]
	: never

/**
 * The row a generation expression reads: its relation's fields as a row check reads them, its caller's and the ones
 * grizzle draws or accumulates alike, whose columns hold their final values whenever PostgreSQL generates the column,
 * at the row's INSERT or at an UPDATE that writes them; less the fields no generation reads (UnreadByGenerationOf).
 */
export type GenerationRow<R extends Shows<string, unknown>> = Omit<
	RowScalars<R>,
	UnreadByGenerationOf<R>
>

/** The generated fields of G a key may hold: each whose declared type a written field of it could be a key field of. */
type GeneratedKeyFieldOf<G> = KeyFieldOf<{
	readonly [K in keyof G]: G[K] extends GeneratedField<infer F> ? F : never
}>

/**
 * relation.generated(name, written, primaryKey, (row) => ({ f: generated(type, term), ... })): a relation whose
 * written fields its caller writes and whose generated fields PostgreSQL writes, each a STORED generated column whose
 * term reads `row`, the row of its stored fields (GenerationRow): a generation expression reads no generated column,
 * and reads a drawn or an accumulated field as any other. The primary key is over written fields and generated ones,
 * a generated field in it a key generation (ir/law.ts FieldWriting keyGenerated), whose term reads caller fields alone
 * (check/generated.ts keyGeneratedRule) and which grizzle writes as its term's value, PostgreSQL proving it by a CHECK.
 * Its fields are both, and its facts hold both; its additions hold only the written.
 */
const generated = <
	const Name extends string,
	const Written extends Record<string, FieldBase>,
	const PrimaryKey extends readonly [
		KeyFieldOf<Written> | GeneratedKeyFieldOf<G>,
		...(KeyFieldOf<Written> | GeneratedKeyFieldOf<G>)[]
	],
	const G extends Record<string, GeneratedField<FieldBase>>
>(
	name: RelationName<Name>,
	written: Written & NamedIds<Written>,
	primaryKey: PrimaryKey & DistinctFields<PrimaryKey>,
	generate: (
		row: GenerationRow<Relation<Name, Written, ReadonlyArray<keyof Written & string>>>
	) => G & GeneratedApart<Written, G>,
	...extra: ReadonlyArray<never>
): Relation<Name, Simplify<Written & G>, readonly [...PrimaryKey]> =>
	generatedRelation<Name, Written, PrimaryKey, G>(name, written, primaryKey, generate, extra)

export const relation: typeof ordinaryRelation & { readonly generated: typeof generated } =
	Object.freeze(Object.assign(ordinaryRelation, { generated }))

/**
 * A closed relation's fields are closed ids, and open-typed values that are no span, set, vector, bytes or exact value,
 * and no field grizzle or PostgreSQL writes.
 */
type ClosedFieldsCheck<Fields> = [
	{
		[K in keyof Fields]-?: Fields[K] extends
			| { readonly writing: WritingTag }
			| {
					readonly sql:
						| "range"
						| "vector"
						| "bits"
						| "exact integer"
						| "exact money"
						| StoredOnlySql
			  }
			? K
			: never
	}[keyof Fields]
] extends [never]
	? unknown
	: Refusal<"a closed relation's field is a closed id, or a value of a type that is no span, set, vector, bytes or exact value, and no field grizzle or PostgreSQL writes">

/**
 * closed.ordered(name, handles): a roster whose order means something, the handles it introduces, each once, in
 * declared order, which is their codes' order and comparison order: a closed id of it compares, ranges, orders and
 * folds by it, and a declaration that puts two handles out of their codes' order is refused (RosterReordered). Its
 * `handle(member)` is the typed constant of a member. A roster of no handle is the empty domain: a closed id of it is
 * the empty type, which no value is, so a relation with a field of it holds no fact.
 */
const orderedRoster = <const Name extends string, const Handles extends ReadonlyArray<string>>(
	name: RelationName<Name>,
	handles: Handles & DistinctHandles<Handles>,
	...extra: ReadonlyArray<never>
): Roster<Name, readonly [...Handles], "ordered"> =>
	closedBuilder<Name, Handles, "ordered">(name, handles, "ordered", extra)

/**
 * closed.unordered(name, handles): a roster whose order means nothing, the handles it introduces, each once, in any
 * order: no comparison, range, orderBy, least, greatest, min, max or fold max reads a closed id of it, which its type
 * refuses (types/compute/scalar.ts OrderedOperand), and its codes are history alone, so a declaration may list its handles in
 * any order. Its `handle(member)` is the typed constant of a member.
 */
const unorderedRoster = <const Name extends string, const Handles extends ReadonlyArray<string>>(
	name: RelationName<Name>,
	handles: Handles & DistinctHandles<Handles>,
	...extra: ReadonlyArray<never>
): Roster<Name, readonly [...Handles], "unordered"> =>
	closedBuilder<Name, Handles, "unordered">(name, handles, "unordered", extra)

/**
 * closed.zones(name, zones): a roster of time zones, each handle a zone's IANA name in its Area/Location form, such as
 * "America/Chicago" or "Etc/UTC", each once, in any order, which Time.wall reads a closed id of as its zone. Its order
 * means nothing, as an unordered roster's, and the migration that installs it, or changes its handles, finds each
 * handle among the server's time zones, pg_timezone_names, or refuses before anything is changed. A name with no "/"
 * (UTC, EST, CET, GB, EST5EDT) is refused here: PostgreSQL reads such a name as a time zone abbreviation first, whose
 * meaning a session's settings choose, never the tzdata alone. Its `handle(member)` is the typed constant of a member.
 */
const zoneRoster = <const Name extends string, const Handles extends ReadonlyArray<string>>(
	name: RelationName<Name>,
	zones: Handles & DistinctHandles<Handles>,
	...extra: ReadonlyArray<never>
): Roster<Name, readonly [...Handles], "zones"> =>
	closedBuilder<Name, Handles, "zones">(name, zones, "zones", extra)

/**
 * closed.relation(name, fields, key, rows): a closed relation, its rows fixed when the schema compiles. The key is
 * required, a nonempty list of its closed-id fields, each once; a set lists every field. Its rows are facts of its
 * fields, no two of one key. `at` and `row` are its closed reads. Its migration states each of its constants as one hex
 * literal; no argument chooses another form.
 */
const closedRelation = <
	const Name extends string,
	const Fields extends Record<string, FieldBase>,
	const KeyFields extends readonly [ClosedIdFieldOf<Fields>, ...ClosedIdFieldOf<Fields>[]],
	const Rows extends ReadonlyArray<FactOfFields<Fields>>
>(
	name: RelationName<Name>,
	fields: Fields & ClosedFieldsCheck<Fields> & NamedIds<Fields>,
	key: KeyFields & DistinctFields<KeyFields>,
	rows: Rows & DistinctRows<Name, Rows, KeyFields>,
	...extra: ReadonlyArray<never>
): ClosedRelation<Name, Fields, readonly [...KeyFields]> =>
	closedRelationBuilder<Name, Fields, KeyFields>(name, fields, key, rows, extra)

/**
 * A closed relation's rows are a set by identity: a row written twice is one row, and two written out with one key and
 * different values break its key law (ConflictsAtKey).
 */
type DistinctRows<Name, Rows, KeyFields extends ReadonlyArray<string>> =
	ConflictsAtKey<Rows, KeyFields> extends true ? KeyLawRefusal<Name, KeyFields> : unknown

/**
 * The closed relations: closed.ordered and closed.unordered, a roster that states whether its order means something;
 * closed.zones, a roster of time zones; and closed.relation, a closed relation over rosters.
 */
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
 * schema(name, relations, statements). The relations are a list, each relation carrying its own name, which the value
 * holds by name (Declared), so the record is the schema's index by name. A library's relations join an application's
 * by concatenating lists, `[...own, ...library]`, which drops nothing: a name is declared once (DeclaredOnce), a
 * relation listed twice or copies of one are one declaration, and two relations of one name differing are refused,
 * each marked. The statements are a frozen copy, held by name (StatementsByName) and read back whole, so `statements`
 * is the tuple the call writes: every tuple of statements reads back as itself (StatementsReadBack). Every relation a
 * statement names is the schema's relation of its name (StatementsWithin). A relation or statement typed `any` is
 * refused (DeclaredOnce, StatementsWithin).
 */
const rootSchema = <
	const Name extends string,
	const Relations extends ReadonlyArray<AnyRelation | AnyClosed | AnyFragment | AnyFunction>,
	const Statements extends ReadonlyArray<Statement>
>(
	name: Name,
	relations: Relations & DeclaredOnce<Relations>,
	statements: Statements &
		StatementsWithin<Statements, Declared<Relations>> &
		StatementsReadBack<Statements, Declared<Relations>> &
		MutablesUnder<
			Statements,
			Statements[number],
			StatementsWithin<Statements, Declared<Relations>>
		>,
	...extra: ReadonlyArray<never>
): Schema<
	Name,
	Declared<Relations>,
	StatementsByName<Statements, Declared<Relations>>,
	never,
	FragmentsIn<Relations>
> => schemaBuilder<Name, Relations, Statements>(name, relations, statements, extra)

/**
 * schema.extend([base], name, relations, statements): a level of its own name over `base`, with relations, derived
 * relations over the base among them, a list as the root's are, and statements. A name is declared once across the
 * level and every level below it (DeclaredOnce over the base's relations): a relation the base declares, listed again
 * as the base declares it, is the base's. Its relations install in a PostgreSQL schema of its own, beside the base's,
 * in one installation with every level below it. A derived definition must be a query over the base or a lower level.
 * Query is invariant in its schema, so a query over this level, which would read its own relations, is no query over
 * any level below it. Its statements are the base's, then its own, held by name over the base's relations and its own.
 * A relation or statement typed `any` is refused (DeclaredOnce, StatementsWithin).
 *
 * Its bases are a list, of one base until a level over several is built: a second is refused (Refusal).
 *
 * The base may be a parameter, for a level built over whatever schema it is given, bounded by the least level it reads,
 * `<Base extends SchemaOver<typeof Policy>>(base: Base) => schema.extend([base], ...)`, or by AnySchema: the call
 * checks its list, its derived relations and its statements over that least level (Least, read off the bound's `least`
 * member, LeastStated), and the same checks over the base itself wait for the parameter's instantiation, which refuses
 * the level there (Extended).
 */
const extend = <
	Base extends AnySchema,
	const Name extends string,
	const Relations extends ReadonlyArray<
		AnyRelation | AnyClosed | DerivedAt<LevelsOf<LeastOf<Base, Least>>> | AnyFragment | AnyFunction
	>,
	const Statements extends ReadonlyArray<Statement>,
	Least extends AnySchema = never
>(
	bases: readonly [
		Base & LeastStated<Least>,
		...ReadonlyArray<
			Refusal<"schema.extend takes one base: a level over several bases is not built yet">
		>
	],
	name: Name,
	relations: Relations & DeclaredOnce<Relations, LeastOf<Base, Least>["relations"]>,
	statements: Statements &
		StatementsWithin<Statements, LeastRecord<Base, Least, Relations>> &
		StatementsReadBack<Statements, LeastRecord<Base, Least, Relations>> &
		MutablesUnder<
			Statements,
			Statements[number] | StatementsOf<LeastOf<Base, Least>>[number],
			StatementsWithin<Statements, LeastRecord<Base, Least, Relations>>
		>,
	...extra: ReadonlyArray<never>
): Extended<Base, Least, Name, Relations, Statements> =>
	schemaBuilder.extend<Base, Name, Relations, Statements, LeastRecord<Base, Least, Relations>>(
		bases,
		name,
		relations,
		statements,
		extra
	)

export const schema: typeof rootSchema & { readonly extend: typeof extend } = Object.freeze(
	Object.assign(rootSchema, { extend })
)

/**
 * rows(fields): the heading of the rows a declared function takes as an argument or returns: its fields, at least one,
 * in code point order of their names, whatever order the record writes them in, which is its row type's attribute
 * order, the order oxlint's sort-keys writes the record in: a body builds one of its rows, `ROW(...)::${heading}`, and
 * reads one positionally, in that order. Each is a value of a base type, a contract or a refined text over one
 * (HeadingCheck), rows of another heading, an array of its row type, or one row of one, row(heading), a value of its row
 * type.
 */
export const rows = <const Fields extends Readonly<Record<string, FunctionType>>>(
	fields: Fields & HeadingCheck<Fields> & MembersTyped<Fields>,
	...extra: ReadonlyArray<never>
): RowsOf<Fields> => rowsBuilder<Fields>(fields, extra)

/**
 * row(heading): one row of a heading, a value of its row type, a composite: as an argument, a result or a heading's
 * field, where the heading itself is rows, an array of it or a set of it.
 */
export const row = <const Heading extends AnyRows>(
	heading: Heading,
	...extra: ReadonlyArray<never>
): RowOf<Heading> => rowBuilder<Heading>(heading, extra)

/**
 * fn(name, { calls, args, returns, volatility, nullInput, language, body }): a declared function, the application's own
 * PostgreSQL function, which a level lists among its relations. `calls` lists the declared functions of its level its body calls,
 * which the installation creates first; each argument and its result are a value of a field's type or rows(heading);
 * its arguments are its parameters in code point order of their names, whatever order `args` writes them in, so a
 * body calls it positionally in that order, `$1` the first of them, or by name, `f(x => ..., y => ...)`;
 * its volatility is immutable, stable or volatile; its null input is `called`, CALLED ON NULL INPUT, whose body runs at
 * every argument, or `strict`, STRICT, whose call at any NULL argument is NULL, or no rows, without running its body,
 * stated by every declaration, neither being a default; its body is PL/pgSQL or SQL text the application owns, written
 * fn.body`...`, installed byte for byte but for each heading it names, which installs as its row type's name. It
 * installs in its level's schema as SECURITY DEFINER under the installation's function owner, a role of no privilege on
 * any table, with its search_path pinned, so its body reads no table.
 */
const declaredFunction = <
	const Name extends string,
	const Args extends Readonly<Record<string, FunctionType>>,
	const Returns extends FunctionType,
	const V extends FunctionVolatility,
	const N extends FunctionNullInput
>(
	name: Name & DeclaredName<Name>,
	definition: {
		readonly calls: ReadonlyArray<AnyFunction>
		readonly args: Args & ArgsCheck<Args> & MembersTyped<Args>
		readonly returns: Returns & SignatureCheck<Returns>
		readonly volatility: V
		readonly nullInput: N
		readonly language: DeclaredLanguage
		readonly body: FunctionBody
	},
	...extra: ReadonlyArray<never>
): DeclaredFunction<Name, Args, Returns, V, N> =>
	fnBuilder<Name, Args, Returns, V, N>(name, definition, extra)

/**
 * fn.body`...`: a declared function's body, its PL/pgSQL or SQL text, each placeholder a heading rows() built, which
 * the body names by its row type's name, `__rows_<digest>`, the one its function's search_path resolves: a heading of
 * the function's own arguments or result, or of a function it calls.
 */
const body = (strings: TemplateStringsArray, ...rowTypes: ReadonlyArray<AnyRows>): FunctionBody =>
	bodyBuilder(strings, rowTypes)

export const fn: typeof declaredFunction & { readonly body: typeof body } = Object.freeze(
	Object.assign(declaredFunction, { body })
)

/**
 * fragment(relations, statements): a library's relations and the statements over them, which an application's schema
 * lists among its relations, `schema("App", [...own, library], laws)`. The relations are a list, each name declared
 * once (DeclaredOnce), and every relation a statement names is one of them (StatementsWithin); the statements are read
 * back whole, as a schema's are. It has no name and installs nothing of its own: a schema that lists it declares its
 * relations and writes its statements at the level whose list holds it, and holds it as one of its levels (LevelsOf), so
 * a query or a ChangeSet over the fragment, `query(library)` or `ChangeSet.empty(library)`, is a program of every
 * schema that lists it and of every role holding its relations whole, which generate compiles there as it compiles any
 * program over a level. Only the fragment states how its relations are written (a key, mutable, race, a unit, a series, a
 * family, a tree or a fold over them): a schema that lists it adds over them only what refuses a write, and is refused
 * otherwise (FragmentRefused) when it is built. A relation or statement typed `any` is refused.
 */
export const fragment = <
	const Relations extends ReadonlyArray<AnyRelation | AnyClosed>,
	const Statements extends ReadonlyArray<Statement>
>(
	relations: Relations & DeclaredOnce<Relations>,
	statements: Statements &
		StatementsWithin<Statements, Declared<Relations>> &
		StatementsReadBack<Statements, Declared<Relations>> &
		MutablesUnder<
			Statements,
			Statements[number],
			StatementsWithin<Statements, Declared<Relations>>
		>,
	...extra: ReadonlyArray<never>
): Fragment<Declared<Relations>, StatementsByName<Statements, Declared<Relations>>> =>
	fragmentBuilder<Relations, Statements>(relations, statements, extra)

/**
 * key(side): no two of the side's facts share its terms, UNIQUE NULLS DISTINCT. Over a whole relation and its fields
 * it is a candidate key; over a selection or a pred term it constrains only the facts the side reads. A roster is keyed
 * by its handle and a closed relation by its declared key, so no side of either is keyed.
 */
export const key = <
	S extends Side<AnyRelation | AnyDerived | Selection<AnyRelation | AnyDerived>>,
	N extends string,
	C
>(
	side: S & SideShows<N, C> & NoSetKey<C, S["terms"]>
): Key<S> => keyBuilder<S>(side)

/**
 * Opt in to in-place change. Without it a relation is immutable: facts are added and deleted, never changed. The
 * default is pinned.
 */
export const mutable = <R extends AnyRelation>(target: R): Mutable<R> => mutableBuilder<R>(target)

/**
 * Race a relation's primary key: the first insertion at a key holds it, and every later insertion there meets the row
 * that holds it, delivered in delta.met, never refused for differing from it. Its other keys stay laws.
 */
export const race = <R extends AnyRelation>(target: R): Race<R> => raceBuilder<R>(target)

/** A unit's fields lead its members' primary keys, so each is of a type a primary key may list (KeyFieldOf). */
type UnitFields<Heading> = [Exclude<keyof Heading, KeyFieldOf<Heading>>] extends [never]
	? unknown
	: Refusal<"a unit's field is of a type a key holds, one with equality">

/**
 * unit(name, heading): a unit, the key a family of rows sits under, each value of it one lock. Every stored relation of
 * the schema whose primary key leads with the heading's fields, by name and type in order, sits under it: `unit("Learner",
 * { child: LearnerId })` holds every relation keyed (child, …), at any level at or above the unit's own, a level above
 * stating nothing. A write of a unit's rows borrows the unit at their key exclusively, and a read of a unit it does not
 * write borrows it shared, as the isolation checker derives from what each ChangeSet writes and reads: no borrow is
 * written. A unit's key is a named domain, a contract or a bounded text of its own, so no field of another meaning
 * leads a key with it.
 */
export const unit = <const Name extends string, const Heading extends Record<string, FieldBase>>(
	name: Name,
	heading: Heading & NamedIds<Heading> & UnitFields<Heading>,
	...extra: ReadonlyArray<never>
): Unit<Name, Heading> => unitBuilder<Name, Heading>(name, heading, extra)

/**
 * series(R): R's one primary key field, natural or a contract over an integer, whose own CHECK refuses a number past its
 * bound, runs 0, 1, 2, … with no gap, a law the statement states, and every write of R holds the series' one lock from
 * before its first read, so a write that appends one past the greatest number reads the greatest exactly. It is the
 * only lock no key splits: a call takes it only by writing R.
 */
export const series = <R extends AnyRelation>(target: R): Series<R> => seriesBuilder<R>(target)

export const check = <
	const Name extends string,
	R extends AnyRelation | RuleReadDerived,
	N extends string,
	C,
	Pr extends Predicate<never>
>(
	name: Name,
	target: R & Showing<N, C>,
	predicate: (
		row: RowScalars<Shows<N, C>>
	) => Pr & Parameterless<Pr> & (R extends RuleReadDerived ? unknown : Hosted<Pr>)
): Check<Name, R> => checkBuilder<Name, R>(name, target, predicate)

/**
 * A side reads at least one term of its source, each once (ir/desc.ts SideDesc): a field, or pred of a natural field,
 * whose fact has no tuple on the side where the field is zero.
 */
export const on = <
	R extends
		| AnyRelation
		| AnyClosed
		| RuleReadDerived
		| Selection<AnyRelation | AnyClosed | RuleReadDerived>,
	C,
	const T extends readonly [TermOf<C>, ...TermOf<C>[]]
>(
	source: R & SourceShowing<string, C>,
	...terms: T & DistinctTerms<T>
): Side<R, readonly [...T]> => {
	const list: T = terms
	return onBuilder<R, T>(source, list)
}

/** pred(field): a natural field's value less one, defined only above zero; on(...) takes it as a term. */
export const pred = <const F extends string>(field: F): Pred<F> => predBuilder<F>(field)

/**
 * select(R, (row) => predicate): the facts of R a row predicate over their own fields holds of, in the row-check
 * language, the one spelling of a selection.
 */
export const select = <
	R extends AnyRelation | AnyClosed | RuleReadDerived,
	N extends string,
	C,
	Pr extends Predicate<never>
>(
	target: R & Showing<N, C>,
	predicate: (row: RowScalars<Shows<N, C>>) => Pr & Parameterless<Pr>
): Selection<R> => selectBuilder<R>(target, predicate)

/**
 * contained(source, target): every tuple of the source side is one of the target side's. A target selected by
 * equalities that fix fields beyond its terms, `on(select(T, (t) => t.and(t.eq(t.kind, "x"), t.eq(t.root, t.id))),
 * "id")`, meets the source's tuples there.
 */
export const contained = <
	L extends AnySide,
	R extends AnySide,
	NL extends string,
	CL,
	NR extends string,
	CR
>(
	left: L & SideShows<NL, CL>,
	right: R &
		SideShows<NR, CR> &
		SidesCompatible<SideHosts<CL, L["terms"]>, SideHosts<CR, R["terms"]>>
): Containment<L, R> => containedBuilder<L, R>(left, right)

/** mirrors(a, b): sugar for contained(a, b) and contained(b, a), which the schema states in its place. */
export const mirrors = <
	L extends AnySide,
	R extends AnySide,
	NL extends string,
	CL,
	NR extends string,
	CR
>(
	left: L & SideShows<NL, CL>,
	right: R &
		SideShows<NR, CR> &
		SidesCompatible<SideHosts<CL, L["terms"]>, SideHosts<CR, R["terms"]>>
): Mirrors<L, R> => mirrorsBuilder<L, R>(left, right)

export const alternatives = <
	PK extends AnyRelation | Key<Side<AnyRelation, ReadonlyArray<string>>>,
	PN extends string,
	PC,
	PF,
	C extends AnyRoster,
	const D extends DiscriminatorsOf<PC, C>,
	const Arms extends Partial<{ readonly [H in HandleOf<C>]: KeyRef<AnyRelation> | AnyDerived }>
>(
	parent: PK & (ShowingKeyed<PN, PC, PF> | KeyShows<PN, PC, PF>),
	discriminator: D,
	roster: C,
	arms: Arms &
		ArmsCompatible<SideHosts<PC, PF>, Arms> &
		ArmsOfRoster<C, Arms> &
		ArmsApartFromParent<PN, Arms> &
		AtLeastOneArm<Arms>
): Alternatives<PK, D, C, Arms> =>
	alternativesBuilder<PK, D, C, Arms>(parent, discriminator, roster, arms)

/**
 * fin(O, n): the slots of O's count n: over an ordinary O, its drawn count, a family's second argument; over a closed O,
 * its natural field, which a closed relation's slot field reads (slot). Never a side, never a schema member.
 */
export const fin = <
	O extends AnyRelation | AnyClosedRelation,
	ON extends string,
	OC,
	K,
	const N extends CountFieldIn<K, OC>
>(
	owner: O & ShowingKind<ON, OC, K>,
	count: N
): Fin<O, N> => finBuilder<O, N>(owner, count)

/**
 * ordered(on(F, g…, i), fin(O, n)): each owner's members, its group g… paired with O's primary key, indexed by their
 * drawn index i exactly 0 … n − 1, in order.
 */
export const ordered = <
	F extends Side<AnyRelation | Selection<AnyRelation>>,
	Fi,
	N extends string,
	C,
	ON extends string,
	OC,
	OK extends ReadonlyArray<string>,
	Kind
>(
	family: F &
		SideShows<N, C> &
		(
			| Side<AnyRelation>
			| Refusal<"a family's member side is a relation, never a selection: its members are every fact of the relation">
		) &
		OverSlots<Kind, OrderedMember<C, F["terms"], OC, OK> & IndexOfCount<C, F["terms"], OC, Fi>>,
	slots: Fi & FinShows<ON, OC, OK, Kind> & FamilySlots<Kind>
): OrderedFamily<F, Fi> => orderedBuilder<F, Fi>(family, slots)

/** counted(on(F, g…), fin(O, n)): each owner's n members, their index hidden. */
export const counted = <
	F extends Side<AnyRelation | Selection<AnyRelation>>,
	Fi,
	N extends string,
	C,
	ON extends string,
	OC,
	OK extends ReadonlyArray<string>,
	Kind
>(
	family: F &
		SideShows<N, C> &
		(
			| Side<AnyRelation>
			| Refusal<"a family's member side is a relation, never a selection: its members are every fact of the relation">
		) &
		OverSlots<Kind, CountedMember<C, F["terms"], OC, OK> & CountedCount<OC, Fi>>,
	slots: Fi & FinShows<ON, OC, OK, Kind> & FamilySlots<Kind>
): Counted<F, Fi> => countedBuilder<F, Fi>(family, slots)

/**
 * tree(on(T, "parent", "at"), fin(T, "children"), { root: [r…] }): the ordered family of T over itself, T keyed by its
 * root fields r… then its drawn `start`, every row but each root a member, its drawn `parent` its parent's start in its
 * own tree, with T's drawn `start` and `end` its pre-order interval and r… the caller's fields each tree's rows share.
 */
export const tree = <
	F extends Side<AnyRelation | Selection<AnyRelation>>,
	Fi extends AnyFin,
	const Root extends readonly [string, ...ReadonlyArray<string>],
	N extends string,
	C,
	K
>(
	family: F &
		SideShowsKeyed<N, C, K> &
		(
			| Side<Fi["owner"]>
			| Refusal<"a tree is a family of T over itself, on(T, parent, at), keyed by its root fields then start, with drawn parent, start and end">
		) &
		SelfFamily<C, K, F["terms"], Fi["count"], Root>,
	slots: Fi,
	root: { readonly root: Root & TreeRootOf<C, Root> }
): Tree<F, Fi, Root> => treeBuilder<F, Fi, Root>(family, slots, root)

/**
 * fold(family, Monoid.m, step, end): the family's members' step values combined by the monoid in slot order, each
 * owner's result in its end fields. `step` is on(member | select(member, φ), g…, x, …accumulators): the group, the
 * value (none for count), then none or one accumulated (before, after) pair per plane; `end` is on(owner, k…, …ends),
 * one accumulated field per plane. The step is read per member row, each member once by its key in the family, never as
 * the set of its projected tuples: two members of one step value both step, so a sum counts the value twice.
 */
export const fold = <
	Fa extends AnyFamily,
	M extends AnyMonoid,
	S extends Side<AnyRelation | Selection<AnyRelation>>,
	E extends Side<AnyRelation>,
	SN extends string,
	SC,
	EN extends string,
	EC,
	EK
>(
	family: Fa,
	monoid: M,
	step: S &
		SideShows<SN, SC> &
		(
			| Side<MemberRelationOf<Fa> | Selection<MemberRelationOf<Fa>>>
			| Refusal<"a fold's step is its family's member: its group, its value, then an accumulated pair per plane">
		) &
		FoldStep<Fa, M, SC, S["terms"]>,
	end: E &
		SideShowsKeyed<EN, EC, EK> &
		(
			| Side<OwnerRelationOf<Fa>>
			| Refusal<"a fold's end names one accumulated field of the owner per plane">
		) &
		FoldEnd<Fa, M, EC, EK, E["terms"], SC, S["terms"]>
): Fold<Fa, M, S, E> => foldBuilder<Fa, M, S, E>(family, monoid, step, end)

/**
 * law({ name, source }, declaration): the declaration, with the catalog entry its author declares for the laws it
 * states, which lawsOf and every outcome that names one of those laws carry as the law's `entry` (types/changeset
 * LawEntry `declared`), where a law nothing declares one for carries the entry grizzle derives: a statement's laws; a
 * relation's primary key's law; a generated(type, term) field's law; a str.regex, str.and or str.bytes type's pattern law
 * at every stored field it types, one entry for the type; and a contract's law. `name` and `source` are any nonempty
 * texts: a catalog's name for the law, say, and the specification section it reads. The entry is no part of the law's
 * identity, so a changed entry is no migration. One law takes one entry.
 */
export const law = <
	const S extends
		| Exclude<Statement, Mutable<unknown> | Race<unknown>>
		| AnyRelation
		| GeneratedField<FieldBase>
		| FieldBase
>(
	entry: { readonly name: string; readonly source: string },
	declaration: S
): S => lawBuilder<S>(entry, declaration)

/** The closed set of monoids a fold combines by: count, sum, or, twos (two planes) and max. */
export const Monoid: { readonly [M in MonoidName]: MonoidOf<M> } = monoids

/**
 * The session's relation parameters: a source of at most one fact, matched by a rule of any query over any schema,
 * read from the claims the layer's verify returns for a Db's token. `claim` names the nested claim object the fields are
 * read from; without it they are the payload's own top-level claims.
 */
export const context = <
	const Name extends string,
	const Fields extends Readonly<Record<string, ContextField>>
>(
	name: Name,
	fields: Fields,
	...options: ContextOptions
): Context<Name, Fields> => contextBuilder<Name, Fields>(name, fields, ...options)

/**
 * A context its server attests: a source of at most one fact, matched as a context is, whose fact the server states
 * where it opens a Db (Db.open's `attested`, an HTTP handler's `attest` of its request), never a token's claim and
 * never a client's input: `attested("Origin", { address: pg.inet })` for the address a request reached the server
 * from, as the server's edge reports it.
 */
export const attested = <
	const Name extends string,
	const Fields extends Readonly<Record<string, ContextField>>
>(
	name: Name,
	fields: Fields
): Context<Name, Fields, "attested"> => attestedBuilder<Name, Fields>(name, fields)

/**
 * Relations defined over the base, a schema: whole relations of the base, each under its own name, and queries over
 * it. `insert` names the role relations it only adds to and `write` the open ones it changes, each relation once
 * between them, and `contexts` the contexts the role declares: the facts its Db's claims hold, the only contexts its
 * query entries and its programs match, a program over the base among them. A repeat across the two lists is read
 * against the options object beside them, as login reads its workloads' shared names, so the call's diagnostic names
 * the refusal. An entry, or a member of a list, typed `any` is refused (MembersTyped).
 */
export const role = <
	Base extends AnySchema,
	const Name extends string,
	const Rs extends Readonly<Record<string, EntryValue>>,
	const I extends ReadonlyArray<WritableKeys<Rs>> = readonly [],
	const W extends ReadonlyArray<WritableKeys<Rs>> = readonly [],
	const C extends ReadonlyArray<AnyContext> = readonly []
>(
	base: Base,
	name: Name,
	relations: Rs & EntriesCheck<Base, Rs, DeclaredContexts<C>> & MembersTyped<Rs>,
	...options:
		| readonly []
		| readonly [
				options: RoleOptionRecord<I, W, C> &
					DistinctWrites<I, W> &
					WritesOpen<Base, Rs, W[number]> &
					MembersTyped<I> &
					MembersTyped<W> &
					MembersTyped<C>
		  ]
): Role<Base, Name, RoleRelations<Rs>, I[number], W[number], DeclaredContexts<C>, C[number]> =>
	roleBuilder<Base, Name, Rs, I, W>(base, name, relations, ...options)
