import type { Built, Phantom, phantom } from "#compiler/core/phantom.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import type { Identical } from "#compiler/types/core/identical.ts"
import type {
	Invariant,
	IsOneLiteral,
	MembersTyped,
	PhantomOf,
	Refusal
} from "#compiler/types/core/phantom.ts"
import type { AnyDerived } from "#compiler/types/derived/derived.ts"
import type {
	AnyClosed,
	AnyClosedRelation,
	AnyRelation,
	AnyRoster,
	NameOf
} from "#compiler/types/schema/relation.ts"
import type {
	Alternatives,
	AlternativesBase,
	AnyFin,
	AnyTerm,
	CandidateKey,
	Check,
	Containment,
	Counted,
	ExpansionOf,
	Fin,
	Fold,
	Key,
	Mirrors,
	MirrorsBase,
	Mutable,
	OrderedFamily,
	Race,
	Series,
	RelationOfKey,
	Selection,
	Side,
	Statement,
	Tree,
	Unit
} from "#compiler/types/schema/statements.ts"

/**
 * Schemas, schema extension, and the projections that read a schema's captured statements. The builders schema and
 * schema.extend are the typed schema facade's (schema/api.ts), written under these types over the admission cores of
 * packages/engine/src/schema.
 *
 * A schema's type holds its statements by name (StatementsByName): each relation a statement names, which the record
 * holds under its name, is spelled as that name. A type argument holds no relation then, and so no relation's field
 * record, an object-literal type the checker takes for one that may hold a type variable: every generic call whose type
 * mentions the schema instantiates its type arguments again, and would walk every statement's relations each time.
 * `statements` reads each statement back whole (StatementsFromNames), the very type the call wrote.
 *
 * The schema this one extends (never for a root schema) is a phantom, so the levels below a schema are part of its
 * type. It is the type-level image of SchemaDesc.bases; an extension's runtime value also holds its base, `bases:
 * [base]`, and a root schema's holds none, `bases: []`. The fragments its list holds (Fragments, never for none) are a
 * phantom too, each a level of the schema (LevelsOf). An extension's statements are its base's, then its own, exactly
 * the tuple its calls wrote; the statements of the fragments its levels list, its base's then its own, each fragment's
 * held by name as the fragment holds them, are apart from them (`listed`), and StatementsOf reads both.
 *
 * `Below` is the statements of the levels below it, its base's as the base holds them (StatementsBelow), and
 * `SpelledOver` the record its own statements are spelled over and read back by: its own record, but for a level
 * schema.extend built over a base parameter (Extended), whose statements are spelled over its record over the base's
 * bound, the one record its call knows, and read back as the very statements the call wrote.
 */
export interface Schema<
	Name extends string,
	Relations,
	Named extends ReadonlyArray<Statement>,
	Base extends AnySchema = never,
	Fragments extends AnyFragment = never,
	Below extends ReadonlyArray<Statement> = StatementsBelow<Base>,
	SpelledOver = Relations
> extends Phantom<{ readonly extends: Base; readonly fragments: Fragments }> {
	readonly kind: "schema"
	readonly name: Name
	readonly relations: Relations
	readonly statements: readonly [...Below, ...StatementsFromNames<Named, SpelledOver>]
	readonly listed: ReadonlyArray<Base["listed"][number] | Fragments["statements"][number]>
}

/**
 * A fragment: relations and the statements over them, declared by no schema of their own, which an application's
 * schema lists among its relations (schema/schema.ts fragment), each schema that lists it holding its relations and
 * statements as its own. It has no name and no installation: its identity is its content. A query or a ChangeSet over a
 * fragment reads and writes its relations alone, and is a program of every schema that lists it (LevelsOf). Its
 * relations are held by name and its statements by name read back whole, as a schema holds its own (Schema).
 */
export interface Fragment<Relations, Named extends ReadonlyArray<Statement>> extends Built {
	readonly kind: "fragment"
	readonly relations: Relations
	readonly statements: readonly [...StatementsFromNames<Named, Relations>]
}

/** Any fragment: the members every one has. */
export interface AnyFragment extends Built {
	readonly kind: "fragment"
	readonly relations: Readonly<Record<string, AnyRelation | AnyClosed>>
	readonly statements: ReadonlyArray<Statement>
}

/**
 * What X states under the key K, read by key: X[K] where K is a key of X, none otherwise (an array or a record indexed
 * by a key it lacks is its element, so the key is asked first). A union states what each of its members states there,
 * where every member has the key. It is how a level's lists and statements are read, never by a conditional test of
 * the item: a derived relation holds its definition, a query over the level below, and a conditional the checker
 * resolves instantiates its operands whole, every relation of that level with them, once for each item it tests.
 */
type Stated<X, K extends string> = K extends keyof X ? X[K] : never

/**
 * The kind X states, read by key: its `kind`, and `unknown`, which is no kind, where it states none, so a test of the
 * kind of an item with none is false.
 */
type KindStated<X> = "kind" extends keyof X ? Stated<X, "kind"> : unknown

/** The name X states, by key: its `name` where that is a string, none otherwise; each member of a union its own. */
type NameStated<X> = X extends unknown ? StringStated<Stated<X, "name">> : never

/** N where it is a string, never otherwise; N whole, so a union of a string and another type is none. */
type StringStated<N> = [N] extends [string] ? N : never

/**
 * The fragments a level's list holds, each item told by its kind (a fragment's is "fragment"); a fragment is then
 * matched as one, which reads only the fragment, never another item.
 */
export type FragmentsIn<Relations extends ReadonlyArray<unknown>> = FragmentsAmong<
	Relations[number]
>
type FragmentsAmong<X> = X extends unknown
	? KindStated<X> extends "fragment"
		? Extract<X, AnyFragment>
		: never
	: never

/**
 * What one item of a level's list declares among its relations: a fragment, each of its relations; a declared
 * function, none, since a function is no relation and its name lies in no relation's namespace; any other item,
 * itself. It distributes over a union of items, as a list's element type is, each told by its kind.
 */
type Listed<X> = X extends unknown
	? KindStated<X> extends "fragment"
		? Stated<X, "relations">[keyof Stated<X, "relations">]
		: KindStated<X> extends "function"
			? never
			: X
	: never

/** The statements of the levels below a schema: its base's, none below a root schema. */
export type StatementsBelow<Base extends AnySchema> = [Base] extends [never]
	? readonly []
	: Base["statements"]

/**
 * How a statement spells each relation it names: by name, the literal key of the schema's record that holds that
 * relation (SameRelation), or by the relation itself. A relation the record does not hold under its name, and one whose
 * name is no literal, is spelled as itself either way, so reading a statement back by relation gives the statement it
 * was.
 */
type Spelling = "name" | "relation"

/** R by name: its literal name, where the record holds R under it (SameRelation), and R otherwise. */
export type NameIn<R, Rs> = R extends { readonly name: infer N extends string }
	? string extends N
		? R
		: SameRelation<R, UnderName<Rs, N>> extends true
			? N
			: R
	: R

/** N by relation: the record's relation under the name N, and N where N is no name of the record. */
export type RelationIn<N, Rs> = N extends keyof Rs ? Rs[N] : N

/**
 * R spelled: by name, R's literal name read by key (NameStated) where the record holds R itself under it, and R
 * otherwise; by relation, the record's relation under the name R, and R where R is no name of the record.
 */
type Spelled<R, Rs, To extends Spelling> = To extends "name"
	? R extends unknown
		? NamedAs<R, NameStated<R>, Rs>
		: never
	: RelationIn<R, Rs>

/**
 * R by its name N, a parameter of its own so that no test of it reads R: N where it is a literal name the record holds
 * R under (SameRelation), and R otherwise, as NameIn spells it.
 */
type NamedAs<R, N, Rs> = [N] extends [never]
	? R
	: string extends N
		? R
		: SameRelation<R, UnderName<Rs, N>> extends true
			? N
			: R

/**
 * A law side's source spelled: a selection, told by its `relation`, the one member a selection has and no relation
 * has, over its relation spelled; any other source spelled itself. A source typed `any`, whose keys are every key, is
 * spelled as itself.
 */
type SourceSpelled<Src, Rs, To extends Spelling> = Src extends unknown
	? "relation" extends keyof Src
		? symbol extends keyof Src
			? Spelled<Src, Rs, To>
			: SelectionBuilt<Spelled<Stated<Src, "relation">, Rs, To>>
		: Spelled<Src, Rs, To>
	: never

/**
 * A law side spelled, read by key: its source spelled, its terms as they are; anything that is no side, itself. A side
 * typed `any`, whose keys are every key, is itself.
 */
type SideSpelled<S, Rs, To extends Spelling> = S extends unknown
	? symbol extends keyof S
		? S
		: "source" extends keyof S
			? Stated<S, "terms"> extends infer T extends ReadonlyArray<AnyTerm>
				? SideBuilt<SourceSpelled<Stated<S, "source">, Rs, To>, T>
				: S
			: S
	: never

/** A relation or a candidate key in key position, spelled: a key, told by its kind, its side spelled. */
type KeyRefSpelled<K, Rs, To extends Spelling> = K extends unknown
	? KindStated<K> extends "key"
		? KeyBuilt<SideSpelled<Stated<K, "side">, Rs, To>>
		: Spelled<K, Rs, To>
	: never

/** A family's slots spelled, told by their kind: fin(O, n) over its owner spelled; anything else, itself. */
type FinSpelled<Fi, Rs, To extends Spelling> = Fi extends unknown
	? KindStated<Fi> extends "fin"
		? Stated<Fi, "count"> extends infer N extends string
			? FinBuilt<Spelled<Stated<Fi, "owner">, Rs, To>, N>
			: Fi
		: Fi
	: never

/** A family spelled, told by its kind (FamilySpelledAs); anything that is no family, itself. */
type FamilySpelled<Fa, Rs, To extends Spelling> = Fa extends unknown
	? FamilySpelledAs<Fa, KindStated<Fa>, Rs, To>
	: never

/**
 * A family Fa of the kind Kind spelled, read by key: its member side and its slots spelled, a tree's roots as they are;
 * anything of another kind, itself. The kind is a parameter of its own, read once, and each test of it a test of a
 * literal.
 */
type FamilySpelledAs<Fa, Kind, Rs, To extends Spelling> = Kind extends "ordered"
	? OrderedFamilyBuilt<
			SideSpelled<Stated<Fa, "family">, Rs, To>,
			FinSpelled<Stated<Fa, "slots">, Rs, To>
		>
	: Kind extends "counted"
		? CountedBuilt<
				SideSpelled<Stated<Fa, "family">, Rs, To>,
				FinSpelled<Stated<Fa, "slots">, Rs, To>
			>
		: Kind extends "tree"
			? Stated<Fa, "root"> extends infer Root extends ReadonlyArray<string>
				? TreeBuilt<
						SideSpelled<Stated<Fa, "family">, Rs, To>,
						FinSpelled<Stated<Fa, "slots">, Rs, To>,
						Root
					>
				: Fa
			: Fa

/**
 * One statement spelled, each relation it names in place, the statement told by its kind and read by key
 * (StatementSpelledAs), never tested whole: a statement over a derived relation holds its definition, a query over the
 * level below, and a conditional the checker resolves instantiates its operands whole. A statement of no kind spelled
 * here, a unit, is itself. An alternatives law keeps its arm map as written, the caller's own object-literal
 * type, which the checker instantiates as one type without walking its arms.
 */
type StatementSpelled<St, Rs, To extends Spelling> = St extends unknown
	? StatementSpelledAs<St, KindStated<St>, Rs, To>
	: never

/**
 * A statement St of the kind Kind spelled, read by key, each part spelled alone and passed to the statement's
 * constructor (Constructed); a family's kinds as FamilySpelledAs spells them. The kind is a parameter of its own, read once,
 * and each test of it a test of a literal. A part that holds no relation, a name, a side's terms, is bound by `infer`
 * where its constructor constrains it.
 */
type StatementSpelledAs<St, Kind, Rs, To extends Spelling> = Kind extends "key"
	? KeyBuilt<SideSpelled<Stated<St, "side">, Rs, To>>
	: Kind extends "mutable"
		? MutableBuilt<Spelled<Stated<St, "relation">, Rs, To>>
		: Kind extends "race"
			? RaceBuilt<Spelled<Stated<St, "relation">, Rs, To>>
			: Kind extends "series"
				? SeriesBuilt<Spelled<Stated<St, "relation">, Rs, To>>
				: Kind extends "check"
					? Stated<St, "name"> extends infer N extends string
						? CheckBuilt<N, Spelled<Stated<St, "relation">, Rs, To>>
						: St
					: Kind extends "contained"
						? ContainmentBuilt<
								SideSpelled<Stated<St, "left">, Rs, To>,
								SideSpelled<Stated<St, "right">, Rs, To>
							>
						: Kind extends "mirrors"
							? MirrorsBuilt<
									SideSpelled<Stated<St, "left">, Rs, To>,
									SideSpelled<Stated<St, "right">, Rs, To>
								>
							: Kind extends "alternatives"
								? Stated<St, "discriminator"> extends infer D extends string
									? AlternativesBuilt<
											KeyRefSpelled<Stated<St, "parent">, Rs, To>,
											D,
											Spelled<Stated<St, "roster">, Rs, To>,
											Stated<St, "arms">
										>
									: St
								: Kind extends "fold"
									? FoldBuilt<
											FamilySpelled<Stated<St, "family">, Rs, To>,
											Stated<St, "monoid">,
											SideSpelled<Stated<St, "step">, Rs, To>,
											SideSpelled<Stated<St, "end">, Rs, To>
										>
									: FamilySpelledAs<St, Kind, Rs, To>

/**
 * T as it is, read as a record's member. The spelled statements' constructors name their interface through it: inside
 * a type alias the checker defers an interface's reference that is the alias's whole body, to keep the alias's name,
 * and one whose argument is an alias, `Key<SideSpelled<…>>`, and instantiates either again, whole, for each check of
 * the conditional it stands in, walking every relation of the record it names. A part passed to its constructor as an
 * argument is resolved once, as the constructor is instantiated, where one bound by `infer` and read again in the
 * branch is instantiated again whole.
 */
type Constructed<T> = { readonly built: T }["built"]

/** The constructors of a spelled statement and its parts, each its interface over its parameters (Constructed). */
type SideBuilt<Src, T extends ReadonlyArray<AnyTerm>> = Constructed<Side<Src, T>>
type SelectionBuilt<R> = Constructed<Selection<R>>
type FinBuilt<O, N extends string> = Constructed<Fin<O, N>>
type KeyBuilt<S> = Constructed<Key<S>>
type MutableBuilt<R> = Constructed<Mutable<R>>
type RaceBuilt<R> = Constructed<Race<R>>
type SeriesBuilt<R> = Constructed<Series<R>>
type CheckBuilt<N extends string, R> = Constructed<Check<N, R>>
type ContainmentBuilt<L, R> = Constructed<Containment<L, R>>
type MirrorsBuilt<L, R> = Constructed<Mirrors<L, R>>
type AlternativesBuilt<P, D extends string, C, Arms> = Constructed<Alternatives<P, D, C, Arms>>
type FoldBuilt<Fa, M, S, E> = Constructed<Fold<Fa, M, S, E>>
type OrderedFamilyBuilt<F, Fi> = Constructed<OrderedFamily<F, Fi>>
type CountedBuilt<F, Fi> = Constructed<Counted<F, Fi>>
type TreeBuilt<F, Fi, Root extends ReadonlyArray<string>> = Constructed<Tree<F, Fi, Root>>

/** Statements by name: each relation of the record a statement names spelled as its name. */
export type StatementsByName<Statements, Relations> = {
	readonly [I in keyof Statements]: StatementSpelled<Statements[I], Relations, "name">
}

/** Statements by name read back whole: each name spelled as the record's relation under it. */
type StatementsFromNames<Named, Relations> = {
	readonly [I in keyof Named]: StatementSpelled<Named[I], Relations, "relation">
}

/**
 * The statements schema(…) and schema.extend(…) admit: those that read back from their names as themselves, which
 * every tuple of statements does, so a builder holds its statements at the type the schema reads them back at.
 */
export type StatementsReadBack<Statements, Relations> = StatementsFromNames<
	StatementsByName<Statements, Relations>,
	Relations
>

/**
 * Any schema: the members every one has. Every Schema whose relations are a record of relations is one. A role is no
 * schema (world.ts AnyRole): it is defined over one, so what takes a schema (role, login, schema.extend, lawsOf) never
 * takes a role, and what reads a schema or a role (query, ChangeSet.empty, workload) names both.
 */
export interface AnySchema extends Built {
	readonly kind: "schema"
	readonly name: string
	readonly relations: Readonly<Record<string, AnyRelation | AnyClosed | AnyDerived>>
	readonly statements: ReadonlyArray<Statement>
	readonly listed: ReadonlyArray<Statement>
	/**
	 * The least level of a base parameter bounded by AnySchema, the weakest bound (SchemaOver): AnySchema, none of whose
	 * relations' names a call knows.
	 */
	readonly [least]?: AnySchema | undefined
	/** No schema is refused: a level its instantiation refuses states its refusal here (Extended), which no schema admits. */
	readonly [refused]?: undefined
}

/**
 * The keys a schema type's bound and its refusal ride under, phantoms no runtime value holds (core/phantom.ts): the least
 * level a base parameter's or a role parameter's bound states (SchemaOver, world.ts RoleOver), and the refusal of a level
 * its instantiation refuses (Extended). `least` is read type-only (`import type { least }`).
 */
export declare const least: unique symbol
declare const refused: unique symbol

/**
 * A schema of which L is a level: the bound of a base parameter, for a level built over whatever schema of L it is
 * given, `<Base extends SchemaOver<typeof Policy>>(base: Base) => schema.extend([base], "Analysis", relations,
 * statements)`. It holds L's relations under their names, and states L as its least level, the level a call of
 * schema.extend over the parameter reads its checks over (Extended). AnySchema is the weakest bound, whose relations'
 * names no call knows.
 */
export interface SchemaOver<L extends AnySchema> extends AnySchema {
	readonly relations: L["relations"]
	readonly [least]?: L | undefined
}

/**
 * What schema.extend infers a base's least level Least from: the `least` member a bound states (SchemaOver, AnySchema),
 * which a base parameter's type reads from its constraint. A built schema states none, so Least is inferred from none
 * and stays never. `kind`, a member every schema has, keeps it no weak type.
 */
export interface LeastStated<Least> {
	readonly kind: "schema"
	readonly [least]?: Least | undefined
}

/** A base's least level: the base itself where it states none, a built schema; its bound's level where it is a parameter. */
export type LeastOf<Base extends AnySchema, Least extends AnySchema> = [Least] extends [never]
	? Base
	: Least

/**
 * The record a level's statements are spelled over: its record over its base's least level (LeastOf), which is its record
 * over the base where the base is a built schema.
 */
export type LeastRecord<
	Base extends AnySchema,
	Least extends AnySchema,
	Relations extends ReadonlyArray<unknown>
> = DeclaredOver<LeastOf<Base, Least>["relations"], Relations>

/**
 * The level schema.extend builds over Base, named Name, of its list Relations and its statements Statements spelled over
 * the record SpelledOver: its record over the base's (DeclaredOver), and its statements below its own its base's.
 */
export type Extension<
	Base extends AnySchema,
	Name extends string,
	Relations extends ReadonlyArray<unknown>,
	Statements extends ReadonlyArray<Statement>,
	SpelledOver
> = Schema<
	Name,
	DeclaredOver<Base["relations"], Relations>,
	StatementsByName<Statements, SpelledOver>,
	Base,
	FragmentsIn<Relations>,
	Base["statements"],
	SpelledOver
>

/**
 * What schema.extend([base], name, relations, statements) builds: the level over Base (Extension). Its call checks its
 * list and its statements over the base's least level (LeastOf): the base itself where it is a built schema, so every
 * check is the base's at the call; where it is a base parameter, its bound's level, the one level the call knows, and
 * the same checks over the base itself wait for the parameter's instantiation, where the base is known
 * (InstantiationRefusal). A level its instantiation refuses states the refusal under `refused`, which no schema admits
 * (AnySchema), so it is refused wherever it is taken as a schema: a base of another level, a role's, a login's.
 */
export type Extended<
	Base extends AnySchema,
	Least extends AnySchema,
	Name extends string,
	Relations extends ReadonlyArray<unknown>,
	Statements extends ReadonlyArray<Statement>
> = RefusedAt<
	Extension<Base, Name, Relations, Statements, LeastRecord<Base, Least, Relations>>,
	InstantiationRefusal<Base, Least, Relations, Statements>
>

/**
 * A level refused by Why, none where Why is never: the level, with the refusal under `refused`. The level is the
 * value either way, which states no refusal, so the builder's value is the level whatever its instantiation decides.
 */
type RefusedAt<Level, Why> = [Why] extends [never]
	? Level
	: Level & { readonly [refused]?: Refusal<Why & Refused> }

/**
 * The rule a level over a base parameter breaks at its instantiation, never where its base is a built schema (Least is
 * never), whose call checked each rule over the base itself: each check its call read over the base's least level, read
 * again over the base, in the order the call checks them.
 */
type InstantiationRefusal<
	Base extends AnySchema,
	Least extends AnySchema,
	Relations extends ReadonlyArray<unknown>,
	Statements extends ReadonlyArray<Statement>
> = [Least] extends [never] ? never : RefusalOver<Base, Relations, Statements>

/**
 * The first rule a level of the list Relations and the statements Statements over the base Base breaks, its call's
 * checks over the base itself: a relation of a name the base holds another relation of (DeclaredOnce), a statement
 * naming a relation no level declares (StatementsWithin), and a derived relation whose definition is a query over no
 * level of the base (extend's DerivedAt).
 */
type RefusalOver<
	Base extends AnySchema,
	Relations extends ReadonlyArray<unknown>,
	Statements extends ReadonlyArray<Statement>
> = [Clashing<Relations, Base["relations"]>] extends [never]
	? [Undeclared<DeclaredOver<Base["relations"], Relations>, NamedBy<Statements[number]>>] extends [
			never
		]
		? [Exclude<Extract<Relations[number], AnyDerived>, DerivedAt<LevelsOf<Base>>>] extends [never]
			? never
			: "a derived definition is a query over a level of the schema it extends"
		: "a statement names a relation no level of the schema declares"
	: "two relations of one name across a schema's levels"

/**
 * A derived relation whose definition is a query over one of the levels L: its view's level is the key of one of them
 * (LevelKeyOf), read off the relation's phantom by key, never off its definition, which its type does not hold
 * (types/derived/derived.ts Derived).
 */
export type DerivedAt<L> = AnyDerived & Phantom<{ readonly level: LevelKeyOf<L> }>

/**
 * A level as a derived relation's view names it (types/derived/derived.ts DefinitionView), each of a union its own: a
 * schema or a role by its kind and its name, read by key, one string, which no two levels of an installation share (the
 * run time refuses a derived relation over a schema no level of its base is, whatever its name); a fragment, which has
 * no name, by itself.
 */
export type LevelKeyOf<L> = L extends unknown
	? KindStated<L> extends "fragment"
		? L
		: `${KindStated<L> & string}:${NameStated<L>}`
	: never

/**
 * The relations a statement names: the relation of a mutable, a race or a check; the source of each law side (a selection's
 * relation), a key's, a family's, a tree's and a fold's included; a family's and a tree's owner; and an alternatives
 * law's parent, roster and arms. A unit names none, and a statement typed `any`, whose keys are
 * every key, names `unknown`, as a side typed `any` does (SideNames). Each statement is read by its kind
 * (NamedByAs), each part by key.
 */
export type NamedBy<St> = St extends unknown
	? symbol extends keyof St
		? unknown
		: NamedByAs<St, KindStated<St>>
	: never

/**
 * What a statement St of the kind Kind names, read by key, each part read alone; none for a kind that names none here.
 * The kind is a parameter of its own, read once, and each test of it a test of a literal.
 */
type NamedByAs<St, Kind> = Kind extends "key"
	? SideNames<Stated<St, "side">>
	: Kind extends "mutable" | "race" | "series" | "check"
		? Stated<St, "relation">
		: Kind extends "contained" | "mirrors"
			? SideNames<Stated<St, "left">> | SideNames<Stated<St, "right">>
			: Kind extends "alternatives"
				? | RelationOfKey<Stated<St, "parent">>
					| Stated<St, "roster">
					| RelationOfKey<Exclude<Stated<St, "arms">[keyof Stated<St, "arms">], undefined>>
				: Kind extends "ordered" | "counted" | "tree"
					? SideNames<Stated<St, "family">> | OwnerOf<Stated<St, "slots">>
					: Kind extends "fold"
						? SideNames<Stated<St, "step">> | SideNames<Stated<St, "end">>
						: never

/**
 * The relation each law side of X reads, by key: its source's, a selection's relation (SourceRelation). A side typed
 * `any`, whose keys are every key, names no relation it tells: `unknown`, which no record holds and Undeclared admits.
 */
type SideNames<X> = X extends unknown
	? symbol extends keyof X
		? unknown
		: SourceRelation<Stated<X, "source">>
	: never

/**
 * The relation a law side's source reads, by key: a selection's relation, the one member a selection has and no
 * relation has; any other source, itself.
 */
type SourceRelation<Src> = Src extends unknown
	? "relation" extends keyof Src
		? Src["relation"]
		: Src
	: never

/** The owner a family's slots count over. */
type OwnerOf<Fi> = Fi extends Fin<infer O, string> ? O : never

/**
 * Whether every relation of the union U is one of R's (SameRelation): false where some is another relation, true where
 * U is R, where U is copies of R the checker keeps apart, as one name's relations in Declared are, and where R is
 * relations of one name a list's element chooses among at run time, each of U being one of them. U and R are compared
 * member by member.
 */
type SameAs<U, R> = U extends unknown
	? true extends (R extends unknown ? SameRelation<U, R> : never)
		? true
		: false
	: never

/**
 * Whether A and B are one relation as a type tells relations apart: of one name and one kind, their headings of one
 * set of field names, and of one declared key, a relation's primary key, a closed relation's key, a roster's handles and
 * their order, each read by key and compared as the literals it is. Two relations alike in all of these and differing
 * in a field's type, or a derived relation's definition, are refused where the schema is built (schema/schema.ts
 * statementsDeclared, declaresFirst: DuplicateIdentity), as the run time holds every name to one meaning.
 */
type SameRelation<A, B> =
	Identical<NameStated<A>, NameStated<B>> extends true
		? Identical<KindStated<A>, KindStated<B>> extends true
			? Identical<keyof Stated<A, "heading">, keyof Stated<B, "heading">> extends true
				? Identical<DeclaredKeyOf<A>, DeclaredKeyOf<B>>
				: false
			: false
		: false

/** The key R declares, read by key: a relation's primary key, a closed relation's key, a roster's handles and order. */
type DeclaredKeyOf<R> = Stated<R, "primaryKey" | "key" | "handles" | "order">

/**
 * Whether a record's keys are names the type knows: false for a record with an index signature, which a list holding
 * a relation of a name the type does not know as one literal makes (Declared), as a record typed
 * `Record<string, R>` is.
 */
type KnownNames<Relations> = string extends keyof Relations ? false : true

/**
 * The relations a statement names that are not the record's relation of their name: one the record holds under no
 * key, and one whose name the record holds only other relations under, which a statement would name by that name
 * alone (ir/desc.ts SideDesc). A relation is the record's where it is one of the relations under its name: the list
 * refuses two of one name differing (DeclaredOnce), so several there are copies, or the relations one element chosen
 * at run time may be. Over a record whose names the type does not know, a relation is the record's where it is one of
 * its relations. A relation whose name the type does not know (a widened arm of alternatives, a side over AnySide, a
 * statement list typed ReadonlyArray<Statement>) is not refused here; the run time checks it.
 */
type Undeclared<Relations, R> = R extends unknown
	? IsOneLiteral<NameStated<R>> extends false
		? never
		: KnownNames<Relations> extends false
			? [R] extends [Relations[keyof Relations]]
				? never
				: R
			: true extends SameAs<UnderName<Relations, NameStated<R>>, R>
				? never
				: R
	: never

/**
 * Every statement is typed (MembersTyped), and every relation it names is the schema's relation of its name, at some
 * level (the run time's refusals at the schema's build: "a statement names a relation no level of the schema
 * declares", and DuplicateIdentity for another relation of a declared name, as one type error). A statement typed
 * `any` names whatever its reader asks, so it is refused before the relations it names are read. Whether one is is
 * asked of the statements' keys first, as MembersTyped asks it: `any`'s keys are every symbol, and a statement's are
 * not, so no statement is an operand of the test, which would instantiate it whole, the derived relations it names
 * with it.
 */
export type StatementsWithin<
	Statements extends ReadonlyArray<Statement>,
	Relations
> = symbol extends keyof Statements[number]
	? 0 extends 1 & Statements[number]
		? Refusal<"a member typed any, which every check admits: type each member of the list or record">
		: UndeclaredRefused<Undeclared<Relations, NamedBy<Statements[number]>>>
	: UndeclaredRefused<Undeclared<Relations, NamedBy<Statements[number]>>>

/**
 * The refusal of a mutable statement of Statements over a relation whose primary key leads with no unit's heading of
 * Units, the unit statements of its level and every level below (the run time's refusal at the schema's build,
 * schema/own.ts ownUnits): an open relation is mutable inside a unit, whose borrow holds its every change alone, and
 * any other is closed. None where every mutable relation sits in a unit, where the statements are generic, holding
 * every Mutable, or where Prior, the statements' check of the relations they name (StatementsWithin), refuses them
 * already: two refusals of one list would intersect to never, which names neither.
 */
export type MutablesUnder<
	Statements extends ReadonlyArray<Statement>,
	Units,
	Prior
> = unknown extends Prior ? MutablesOutside<Statements, Units> : unknown

/** MutablesUnder's refusal itself, over statements no other check refuses. */
type MutablesOutside<Statements extends ReadonlyArray<Statement>, Units> =
	Mutable<unknown> extends Statements[number]
		? unknown
		: true extends OutsideUnits<
					Statements[number],
					HeadingsOf<Extract<Units, Unit<string, unknown>>>
			  >
			? Refusal<"mutable over a relation under a unit, whose every change is a write its unit's borrow holds alone: declare the unit its primary key leads with, unit(name, { …its leading key fields }), or keep it closed and record each change as an inserted fact">
			: unknown

/**
 * true for each mutable statement among the statements S whose relation's primary key leads with none of Hs; none for a
 * relation whose key the types do not know, a list of no fixed length, which the run time judges alone.
 */
type OutsideUnits<S, Hs> =
	S extends Mutable<infer R>
		? KeyKnown<R> extends true
			? InSomeUnit<R, Hs> extends true
				? never
				: true
			: never
		: never

/** Whether R's primary key is a tuple the types know, of a fixed length. */
type KeyKnown<R> = R extends { readonly primaryKey: infer K extends ReadonlyArray<string> }
	? number extends K["length"]
		? false
		: true
	: false

/** The headings of the unit statements U, one union member a unit. */
type HeadingsOf<U> = U extends Unit<string, infer H> ? H : never

/** Whether R's primary key leads with one of the headings Hs. */
type InSomeUnit<R, Hs> = true extends (Hs extends unknown ? LeadsWith<R, Hs> : never) ? true : false

/**
 * Whether R's primary key leads with heading H: its first fields, as many as H holds, are H's fields, each of the type
 * H gives it, as ir/desc.ts leadsWithHeading reads a unit's members. A heading is a record, so its fields are compared as
 * a set of the key's leading fields.
 */
type LeadsWith<R, H> = R extends {
	readonly primaryKey: infer K extends ReadonlyArray<string>
	readonly fields: infer F
}
	? LeadingFields<K, keyof H & string, H, F, never>
	: false

/** Whether K's leading fields, past Seen, are exactly Need, each of H's type in F. */
type LeadingFields<
	K extends ReadonlyArray<string>,
	Need extends string,
	H,
	F,
	Seen extends string
> = [Need] extends [Seen]
	? true
	: K extends readonly [infer First extends string, ...infer Rest extends ReadonlyArray<string>]
		? First extends Need
			? SameFieldType<H[First & keyof H], F[First & keyof F]> extends true
				? LeadingFields<Rest, Need, H, F, Seen | First>
				: false
			: false
		: false

/** Whether two field descriptors are of one type. */
type SameFieldType<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/**
 * The refusal of the undeclared relations U: none where there are none. U is a parameter of its own: a tuple of
 * Undeclared in StatementsWithin's body would be a reference the checker defers, holding the statements and the record
 * in its mapper, so deciding it would instantiate every statement whole, the derived relations it names with it.
 */
type UndeclaredRefused<U> = [U] extends [never]
	? unknown
	: Refusal<"a statement names a relation no level of the schema declares">

/**
 * A level's relations by name, from the list its call writes: each relation under its own name, and the relations
 * of one name in one union there, which DeclaredOnce refuses unless they are one relation. Its keys are the level's
 * names, so a lookup by name is one property read.
 */
export type Declared<Relations extends ReadonlyArray<unknown>> = DeclaredIn<
	Listed<Relations[number]>
>

/**
 * The relations of the union R by name; where some relation's name is no one literal the type knows, every relation
 * of R under any name, as a record typed `Record<string, R>` holds them.
 */
type DeclaredIn<R> = true extends (
	R extends unknown ? (IsOneLiteral<NameStated<R>> extends true ? false : true) : never
)
	? { readonly [name: string]: R }
	: DeclaredByName<R>

/**
 * The relations of R under their names, keyed by R's names read once, so keyof the record is its key set and a lookup
 * by name is one property read. A record whose keys an `as` clause names is read again whole at every lookup and every
 * keyof: the checker instantiates the clause over every relation of R to ask whether the record is generic, which made
 * each statement's, role's and ChangeSet's lookup of a relation cost the level's every relation. Each name's relations
 * are those of R (Extract), so every reader of the record reads R's relations, generic ones included. The names are
 * read by key (NameStated), never by a test of a relation: a derived relation holds its definition, a query over the
 * level below, and a conditional the checker resolves instantiates it whole. DeclaredIn reaches the record only where
 * every relation states one literal name.
 */
type DeclaredByName<R> = {
	readonly [N in NameStated<R>]: Extract<NamedIn<R>[N], R>
}

/**
 * Each relation of R under its name, the relations of one name in one union: read once per name, as DeclaredByName
 * resolves its properties, its clause a read by key, one instantiation over all of R.
 */
type NamedIn<R> = { readonly [X in R as Stated<X, "name"> & string]: X }

/**
 * Each element of an array, boxed: an array's possible elements, each relation of its element type, any two of which it
 * may hold. A fragment's relations are each an element of their own (Listed).
 */
type Elements<Relations extends ReadonlyArray<unknown>> =
	Listed<Relations[number]> extends infer R ? (R extends unknown ? readonly [R] : never) : never

/** A tuple's element boxed: a fragment, each of its relations boxed apart; any other element, itself whole. */
type Boxed<X> = [X] extends [AnyFragment]
	? Listed<X> extends infer R
		? R extends unknown
			? readonly [R]
			: never
		: never
	: readonly [X]

/**
 * The name of R where `Named`, the relations of a list or a level below under R's name, holds another relation
 * (SameAs): R's name where they are not R, or copies of R, or the one element R itself is.
 */
type ClashOf<R, Named> = [Named] extends [never]
	? never
	: false extends SameAs<Named, R>
		? NameOf<R>
		: never

/**
 * The names element R declares with another relation of its name in the list or among the relations below it, R one
 * boxed element of the list (Boxed, Elements), compared whole with the relations under its name (ClashOf).
 */
type ClashesOf<B, Relations extends ReadonlyArray<unknown>, Below> = B extends readonly [infer R]
	? IsOneLiteral<NameOf<R>> extends false
		? never
		: | (KnownNames<Declared<Relations>> extends true
					? ClashOf<R, UnderName<Declared<Relations>, NameOf<R>>>
					: never)
			| (KnownNames<Below> extends true ? ClashOf<R, UnderName<Below, NameOf<R>>> : never)
	: never

/**
 * The names the list's relations declare, each with another relation of its name in the list or among the relations
 * below it: two declarations of one name differing. Each element of a tuple, as its call wrote it (a relation chosen
 * at run time among several of one name is one element), and each possible element of an array, is compared with the
 * relations under its name (ClashesOf), the one declaration of its name among them. A relation whose name the type does
 * not know as one literal, and a list or base whose record holds such a name, pass here; the run time checks them.
 */
type Clashing<Relations extends ReadonlyArray<unknown>, Below> = number extends Relations["length"]
	? ClashesOf<Elements<Relations>, Relations, Below>
	: { readonly [I in keyof Relations]: ClashesOf<Boxed<Relations[I]>, Relations, Below> }[number]

/**
 * A level's list of relations, each name declared once (the run time's DuplicateIdentity, as a type error): a
 * relation is refused where another relation of its name is in the list or, for an extension, at a level below
 * (`Below`, the base's relations). One relation listed twice, or copies of one relation, declare it once. Every
 * relation of a clashing name carries the refusal, so each side of the clash is named; a list with no clash is checked
 * as itself, so a list spreading an array of relations keeps its inferred tuple. A relation typed `any` states no name
 * and passes every reader of the list, so it is refused (MembersTyped).
 */
export type DeclaredOnce<
	Relations extends ReadonlyArray<unknown>,
	Below = never
> = MembersTyped<Relations> & ClashRefused<Relations, Clashing<Relations, Below>>

/**
 * The list's refusal of its clashing names C: none where no name clashes, and otherwise each element declaring one
 * marked. C is a parameter of its own: a tuple of Clashing in DeclaredOnce's body would be a reference the checker
 * defers, holding the list in its mapper, so deciding it would instantiate every element of the list whole.
 */
type ClashRefused<Relations extends ReadonlyArray<unknown>, C> = [C] extends [never]
	? unknown
	: {
			readonly [I in keyof Relations]: [NameStated<Listed<Relations[I]>> & C] extends [never]
				? unknown
				: Refusal<"two relations of one name across a schema's levels">
		}

/**
 * An extension's record: the base's relations, then each relation of the level's list under a name the base does not
 * hold, so a name the level declares again, as the base declares it, is the base's relation alone (RecordOver).
 */
export type DeclaredOver<BaseRelations, Relations extends ReadonlyArray<unknown>> = RecordOver<
	BaseRelations,
	Declared<Relations>
>

/**
 * The base's record B over the level's record L: one mapped type over both key sets, each name the base holds read from
 * the base and every other from the level, so a lookup by name is one property read at each level. It is no
 * intersection of the two: a lookup by name in a type, `Rs[N]`, on an intersection asks whether the intersection
 * reduces, which instantiates it whole, every relation of every level below with it, a derived relation's definition and
 * its schema among them, once for each extension's record. A record whose keys the type does not know, one with an
 * index signature, is the intersection, since a mapped type over its keys would be one index signature, the base's names
 * lost under it: a level makes one by listing a relation whose name is no one literal (DeclaredIn), as a schema built
 * from data does, `relation(name, …)` with `name: string`, and an extension of a base typed AnySchema has one, as a chain
 * of levels built in a loop does. Each record is tested apart: a tuple of both tests would be a reference the checker
 * defers, holding both records in its mapper, and deciding it would instantiate them whole.
 */
type RecordOver<B, L> =
	KnownNames<B> extends false
		? B & L
		: KnownNames<L> extends false
			? B & L
			: { readonly [N in keyof B | keyof L]: N extends keyof B ? B[N] : L[N & keyof L] }

/**
 * S, every schema below it, and every fragment one of them lists (FragmentsOf). A query over any of them is a query
 * over S. The recursion is as deep as the extension chain, never over relations or statements.
 */
export type LevelsOf<S> = S | FragmentsOf<S> | LevelsBelow<BelowOf<S>>

/** LevelsOf the level below, none below a root schema. */
type LevelsBelow<B> = [B] extends [never] ? never : LevelsOf<B>

/**
 * What a level's phantom states under K, the level it extends or the fragments it lists, read by key (PhantomOf), each
 * member of a union its own: never a match of `Phantom<{ readonly [K]: infer X }>`, which binds the level below, a
 * schema, and instantiates it again, whole, every relation and statement of it, in the branch that reads it, so a walk
 * of the chain read every level below each level once more. A value with no phantom, a Built such as AnySchema, states
 * `unknown`, as that match reads it, and a value that is no Built states nothing.
 */
type LevelStated<S, K extends string> = S extends unknown
	? typeof phantom extends keyof S
		? Stated<PhantomOf<S>, K>
		: S extends Built
			? unknown
			: never
	: never

/** The level S extends, read off its phantom by key (LevelStated): never below a root schema. */
export type BelowOf<S> = LevelStated<S, "extends">

/**
 * The fragments that are levels of S itself: a schema's, those its list holds; a role's, those of its base's levels it
 * holds whole (types/schema/world.ts Role); none for anything else.
 */
export type FragmentsOf<S> = LevelStated<S, "fragments">

/** The fragments every level of a schema lists, the levels below it included. */
export type AllFragmentsOf<S> = FragmentsOf<S> | AllFragmentsBelow<BelowOf<S>>

/** AllFragmentsOf the level below, none below a root schema. */
type AllFragmentsBelow<B> = [B] extends [never] ? never : AllFragmentsOf<B>

/**
 * Whether X is one of the levels of S. Each level is compared invariantly, as Query compares its schema, so a schema
 * that is structurally wider or narrower than every level (an extension of S, or another schema of the same name
 * with more relations) is not a level even where plain assignability would admit it.
 */
export type IsLevelOf<S, X> = IsLevelOfInvariant<S, Invariant<X>>
/** Whether Invariant<X>, a source's phantom schema as it carries it, is Invariant<L> of a level L of S (IsLevelOf). */
export type IsLevelOfInvariant<S, IX> = 0 extends 1 & S
	? true
	: true extends LevelMatch<LevelsOf<S>, IX>
		? true
		: false

/**
 * The highest of the levels L, of which every level in L is one, or never where none is: levels form one chain, so of
 * any levels either one is the highest or two of them are not levels of one another and do not combine. Every
 * combination of values over levels is over the highest of its arguments' (schema/level.ts higherLevel), by this one
 * rule: ChangeSet.union and sequence (HigherLevel), and a query whose relation parameters are bound to the rows of
 * queries over other levels (Query.bind).
 */
export type HighestLevel<L> = HighestIn<L, L>
/** The members X of L of which every member of All is a level (HighestLevel). */
type HighestIn<L, All> = L extends unknown
	? [All extends unknown ? (IsLevelOf<L, All> extends true ? never : All) : never] extends [never]
		? L
		: never
	: never
/** The higher of two levels (HighestLevel), or never where neither is a level of the other. */
export type HigherLevel<A, B> = HighestLevel<A | B>

/**
 * Whether X is each level of L, each its own. The invariant phantoms are parameters of their own (InvariantlyAt): a
 * tuple of Invariant here would be a reference the checker defers, holding X and the level in its mapper, and deciding
 * it would instantiate both whole, every relation of each with them, for each level of each test.
 */
type LevelMatch<L, IX> = L extends unknown ? InvariantlyAt<IX, Invariant<L>> : never
type InvariantlyAt<A, B> = [A] extends [B] ? true : false

/**
 * Schema projections. Each is a property read or a single Extract over the statement tuple's element union; none
 * recurses over the schema graph. A projection tests that S has the member and reads it by key, never binding it with
 * `infer`: a member bound by `infer` and read in the branch is instantiated again, whole, through the branch's mapper,
 * the relations of the schema, their definitions and the levels below with it. A value typed `any`, the one value
 * with the member to which unknown is assignable, is matched instead (RelationsBound, StatementsBound): a read by key
 * would read `any`, and a match binds what the member's constraint admits, unknown relations and a list of statements.
 */
export type RelationsOf<S> = S extends { readonly relations: unknown }
	? unknown extends S
		? RelationsBound<S>
		: S["relations"]
	: never

/** The relations a match of S binds, for S typed `any`: unknown. */
type RelationsBound<S> = S extends { readonly relations: infer Rs } ? Rs : never
export type RelationOf<S> = RelationsOf<S>[keyof RelationsOf<S>]

/**
 * What a record of relations holds under the name N, none where it holds nothing of that name. A schema's record and
 * a role's hold each relation under its own name (Declared, EntriesCheck), so a relation is found by its name in
 * one property read, never in a pass over the record's values.
 */
export type UnderName<Rs, N> = N extends keyof Rs ? Rs[N] : never

/**
 * Whether R is a relation, closed relation or derived relation of S; any schema admits every relation. S's record
 * holds each relation under its own name (Declared), so R is S's relation of its name exactly when it is one of
 * RelationOf<S>, the union the checker builds once per schema.
 */
export type IsRelationOf<S, R> = 0 extends 1 & S ? true : [R] extends [RelationOf<S>] ? true : false

/**
 * The statements of S: a level's own and its base's, then those of the fragments its levels list where it lists one,
 * so a level that lists none has exactly the tuple its calls wrote; a role's or a fragment's, its own. Each list is
 * read by key, as RelationsOf reads the relations.
 */
export type StatementsOf<S> = S extends { readonly statements: ReadonlyArray<Statement> }
	? unknown extends S
		? StatementsBound<S>
		: S extends { readonly listed: ReadonlyArray<Statement> }
			? StatementsBeside<S["statements"], S["listed"][number]>
			: S["statements"]
	: never

/** The statements a match of S binds, for S typed `any`: a list of statements. */
type StatementsBound<S> = S extends {
	readonly statements: infer St extends ReadonlyArray<Statement>
}
	? St
	: never

/** A level's statements St, then the listed statements L of its fragments where it lists any. */
type StatementsBeside<St extends ReadonlyArray<Statement>, L> = [L] extends [never]
	? St
	: readonly [...St, ...ReadonlyArray<L>]
type StatementOf<S> = StatementsOf<S>[number]

/**
 * The keys of R in S: its own (OwnKeysOf), and every candidate key declared for R with key(), for each relation its name
 * may be where it is a generic relation's union of names (DeclaredKeysOfAll). Each key is a list of field names. A
 * context holds at most one fact, so its key is the empty one.
 */
export type KeysOf<S, R> = R extends { readonly kind: "context" }
	? readonly []
	: OwnKeysOf<R> | DeclaredKeysOfAll<S, NameOf<R>>

/**
 * The keys R states of itself, whatever schema holds it: its primary key, a roster's handle, a closed relation's
 * declared key, and the keys a derived or world relation's definition proves.
 */
export type OwnKeysOf<R> = R extends { readonly primaryKey: infer P }
	? P
	: R extends AnyRoster
		? readonly ["id"]
		: R extends AnyClosedRelation
			? R["key"]
			: R extends { readonly kind: "derived" }
				? DefinitionKeysOf<R>
				: R extends { readonly kind: "world" }
					? DefinitionKeysOf<R["definition" & keyof R]>
					: never

/**
 * The candidate keys of every relation of S, each relation's under its name and none under any other name. Relation
 * names are unique within a schema, so the name identifies the relation. The index is built once per schema, in one
 * pass over its key sides, each placed under its relation's name, so reading one relation's keys is a property read: no
 * read passes over the statement tuple, and no read takes the index's keys (`keyof`), which a remapped index computes
 * again at every read.
 */
type KeyIndexOf<S> = {
	readonly [K in KeySideOf<StatementOf<S>> as NameOf<SourceOf<K>>]: TermsOf<K>
} & { readonly [name: string]: never }

/**
 * The candidate keys declared for every relation of S named in N: a generic relation's, whose name is the union of its
 * relations' names, are the keys each of them holds; a relation's, its own. Each name's keys are one property read of
 * the index, which holds a value under every name (ByName), so no read asks whether a name is among its keys.
 */
export type DeclaredKeysOfAll<S, N extends string> = HeldByAll<N, KeyIndexOf<S>[N], KeyIndexOf<S>>
type HeldByAll<N extends string, T, I extends ByName> = T extends unknown
	? HeldWhere<N, T, HoldersOf<N, T, I>>
	: never

/**
 * T where every name of N is among its holders H, never otherwise. The holders are a parameter of their own: a tuple of
 * HoldersOf in HeldByAll's body would be a reference the checker defers, holding the key index in its mapper, so
 * deciding it would instantiate the whole index again.
 */
type HeldWhere<N extends string, T, H> = [N] extends [H] ? T : never
type HoldersOf<N extends string, T, I extends ByName> = N extends unknown
	? [T] extends [I[N]]
		? N
		: never
	: never

/** An index by name that holds a value under every name, as KeyIndexOf holds none, `never`, under a name it keys none of. */
interface ByName {
	readonly [name: string]: unknown
}

type SourceOf<X> = X extends Side<infer R> ? R : never
type TermsOf<X> = X extends Side<unknown, infer T> ? T : never

/**
 * The side of every candidate key a statement declares: a key statement's, and an ordered family's (its group and
 * index). A counted family's index is in no heading; a tree's (root…, start) is its relation's primary key, and its
 * (root…, parent, at) a key of its members alone, so neither adds a key of the relation.
 */
type KeySideOf<St> =
	St extends CandidateKey<AnyRelation>
		? St["side"]
		: St extends OrderedFamily<infer F, AnyFin>
			? F
			: never

/** The proved keys a query's evidence carries. */
type DefinitionKeysOf<Q> =
	Q extends Phantom<{ readonly evidence: { readonly keys: infer Ks } }>
		? Ks extends ReadonlyArray<infer K extends ReadonlyArray<string>>
			? MinimalKeys<K>
			: never
		: never

/**
 * The minimal keys among a union of keys K, as a derived relation's analysis lists them: each key no other key's
 * fields lie strictly within. The whole heading a definition's evidence states, a set's own key, is one only where no
 * fewer fields are. Quadratic in the keys, which a definition states a few of.
 */
type MinimalKeys<K> = MinimalAmong<K, K>

/** Each key of Each that no key of All lies strictly within. */
type MinimalAmong<Each, All> =
	Each extends ReadonlyArray<infer F> ? (true extends StrictlyWithin<All, F> ? never : Each) : never

/** Whether some key of Ks has fields strictly within F: all of its fields among F's, and not all of F's among its. */
type StrictlyWithin<Ks, F> =
	Ks extends ReadonlyArray<infer G>
		? [G] extends [F]
			? [F] extends [G]
				? false
				: true
			: false
		: never

/** A law read without its sugar: a mirrors as the two containments it is, any other law as itself. */
type Desugared<L> = L extends MirrorsBase
	? L extends Mirrors<infer A, infer B>
		? Containment<A, B> | Containment<B, A>
		: never
	: L

/**
 * The laws of S: its statements, each alternatives law read as the statements it expands to, and each mirrors, its
 * own or an alternatives arm's, as its two containments.
 */
export type LawsOf<S> =
	StatementOf<S> extends infer St
		? Desugared<St extends AlternativesBase ? ExpansionOf<St> : St>
		: never
export type ContainmentsOf<S> = Extract<LawsOf<S>, Containment<unknown, unknown>>
