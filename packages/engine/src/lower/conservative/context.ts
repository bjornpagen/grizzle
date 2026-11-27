import { postorder } from "@bjornpagen/grizzle-text/base/graph"
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	extendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { clockInstant } from "#compiler/check/clock.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import type { ClockUnit } from "#compiler/core/clock.ts"
import { CompileError, type ProseTag, prose } from "#compiler/core/errors.ts"
import type { ParamPlace } from "#compiler/core/identity.ts"
import type { NodeId, ParamId, StoredRelationName } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { TextsMap } from "#compiler/core/text.ts"
import { factSet, typedEq } from "#compiler/ir/compare.ts"
import { DagTemplates } from "#compiler/ir/dag-digest.ts"
import { type NodeScope, nodeScopes, type OuterRefs } from "#compiler/ir/dag.ts"
import { exprClosure } from "#compiler/ir/expr.ts"
import type { Fold } from "#compiler/ir/fold.ts"
import {
	baseTypeRef as physicalBaseType,
	type PhysicalNames,
	qualifiedType
} from "#compiler/ir/physical.ts"
import { type FilledRows, filledRowsKey } from "#compiler/ir/products.ts"
import {
	exprsOf,
	type Heading,
	type HeadingColumn,
	inputsOf,
	type NodeOf,
	type RelKind,
	type RelNode,
	type TakeBound,
	unionArms,
	type ValidDag
} from "#compiler/ir/rel.ts"
import { regexOf, type RegexRef, type ScalarType } from "#compiler/ir/scalar.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"
import { EvaluationKeys } from "#compiler/lower/conservative/call/keys.ts"
import { DagIndex } from "#compiler/lower/conservative/dag-index.ts"
import { FieldTexts } from "#compiler/lower/conservative/expr/share.ts"
import type {
	ArrayPart,
	ArraySlot,
	BoundCarrier,
	ConservativeOptions,
	ConservativeParamSlot,
	DeclaredParamSlot,
	MemberParamSlot,
	NestedRowsParamSlot,
	OwnParamSlot,
	RelationColumn,
	RelationParamSlot,
	ScalarParamSlot
} from "#compiler/lower/conservative/types.ts"
import { columnType, namedColumn } from "#compiler/runtime/lower/columns.ts"
import { namesOrUnit } from "#compiler/runtime/lower/tree.ts"
import {
	type ArrayCheck,
	type ArraysSource,
	type ClockInstant,
	type ClockOf,
	type Cte,
	type Expr,
	type FromItem,
	type FromSource,
	isSetQuery,
	type OperandSelect,
	type Select,
	type SelectCore,
	type SetCore,
	type Target,
	transactionInstant,
	type TypeRef
} from "#compiler/sql/ast.ts"
import {
	baseCheck,
	col,
	columnDefinition,
	core,
	conjunction,
	cteRead,
	type DefinedCte,
	derived,
	distinctCore,
	keyedRead,
	lit,
	operandSelect,
	operandUnionAll,
	positionalValue,
	provedSelect,
	sameTypeRef,
	select,
	setBodyOf,
	setOp,
	slotParam,
	target,
	types,
	unitTargets
} from "#compiler/sql/build.ts"
import {
	freshNames,
	namedQuery,
	type NameOrigin,
	NameSupply,
	type NameSupplyStart
} from "#compiler/sql/naming.ts"
import { inertVisitor, visitSelect } from "#compiler/sql/transform.ts"

/** The SQL expressions of one node's columns, by heading name. */
export type ColumnMap = ReadonlyMap<string, Expr>

/**
 * What a query is lowered in scope of: the nodes in scope and their columns, and the nodes it reads at some of their
 * columns' values alone (`restrictedEnv`), each with its equalities, every value an expression over what is in scope.
 * A restriction is scoped as a column is: it holds wherever this scope is extended (`extendEnv`), a LATERAL source's
 * or an existence test's, and nowhere a query is lowered in a scope of its own, a CTE's body at the WITH it stands in
 * (lowered in its definition's scope: the statement's, `emptyEnv`, or its holder's), a root's or an attachment's child
 * (`envOf`), so no value is read where its row is not in scope.
 */
export interface Env {
	readonly columns: ReadonlyMap<NodeId, ColumnMap>
	readonly restricted: ReadonlyMap<RelNode, ColumnEqualities>
	/**
	 * The restricted nodes a row site's root reads at several reads, each held once (`heldEnv`): a CTE of the table the
	 * root's query leads its WITH with, defined at its first read, which every read of it reads (`restrictedRead`).
	 */
	readonly held: ReadonlyMap<RelNode, Held>
}

/**
 * A node a row site's root holds once (Env `held`): the table its CTE stands in, and the relations in scope where the
 * root's WITH stands (`inScope`), the only ones a restriction its body takes may read (`restrictedEnv`).
 */
interface Held {
	readonly table: CteTable<RelNode>
	readonly inScope: ReadonlySet<string>
}

/** The relations an expression reads through its column references, at any depth. */
const relationsRead = (e: Expr): ReadonlySet<string> => {
	const out = new Set<string>()
	visitSelect(operandSelect(core([target(e)], [], undefined)), {
		...inertVisitor,
		expr: (x) => {
			if (x.kind === "column" && x.table !== undefined) {
				out.add(x.table)
			}
		}
	})
	return out
}

/** The relations a scope's columns are read from: those in scope where it stands. */
const relationsInScope = (env: Env): ReadonlySet<string> =>
	new Set(
		[...env.columns.values()].flatMap((columns) =>
			[...columns.values()].flatMap((e) => [...relationsRead(e)])
		)
	)

export const emptyEnv: Env = { columns: new Map(), restricted: new Map(), held: new Map() }

/**
 * Whether a node restricted in a scope (`restrictedEnv`) restricts its own rows inside: a union, each arm at the values
 * (lower/shapes/union keyedUnion), a fold, its keys below its aggregate (lower/shapes/aggregate keyedGroup), where a
 * restriction over either reaches no arm and no group, and a region, at the occurrence its chain leads with
 * (lower/shapes/region keyedChain), whose order a restriction over it would leave to PostgreSQL's estimates.
 */
export const restrictsInside = (node: RelNode): boolean =>
	node.kind === "Union" || node.kind === "Group" || node.kind === "MatchRegion"

/**
 * Whether `node`'s rows reach a reader in `env` already at the values its scope restricts them to: the node holds a
 * restriction of its own (`restrictedEnv`), which its lowering places inside it (`restrictsInside`), so a fold over it
 * or a union of it restricts nothing again.
 */
/**
 * Whether a root holds a restriction of its rows at `equalities` itself (`restrictsInside`): a union and a region at
 * any, a fold only where each is one of its grouping keys, a value of an aggregate no restriction below its grouping
 * reaches (lower/shapes/aggregate keyedGroup), which a fold's reader then keeps where the fold delivers it.
 */
export const holdsInside = (node: RelNode, equalities: ColumnEqualities): boolean =>
	restrictsInside(node) &&
	(node.kind !== "Group" || equalities.every((e) => node.keys.includes(e.column)))

/**
 * Whether `node`'s rows reach a reader in `env` already at every value of `restriction`, the reader's: the node holds
 * a restriction of its own (`restrictedEnv`) at each of those columns, which its lowering places inside it
 * (`restrictsInside`), so a fold over it or a union of it restricts nothing again. A fold holds its grouping keys alone
 * (share/keys.ts restrictionWalk), so a reader restricted at a value of its aggregate keeps that value itself.
 */
export const heldIn = (env: Env, node: RelNode, restriction: ColumnEqualities): boolean => {
	const held = env.restricted.get(node) ?? []
	return (
		restrictsInside(node) &&
		held.length > 0 &&
		restriction.every((e) => held.some((h) => h.column === e.column))
	)
}

/** A scope of `entries` alone, no node restricted in it. */
export const envOf = (entries: Iterable<readonly [NodeId, ColumnMap]>): Env => ({
	columns: new Map(entries),
	restricted: new Map(),
	held: new Map()
})

/** `env` with `entries` in scope too, each node it restricts restricted still. */
export const extendEnv = (env: Env, entries: Iterable<readonly [NodeId, ColumnMap]>): Env => {
	const columns = new Map(env.columns)
	for (const [id, map] of entries) {
		columns.set(id, map)
	}
	return { columns, restricted: env.restricted, held: env.held }
}

/**
 * `env` with each node of `restricted` read at its equalities' values alone, beside those it restricts: wherever the
 * node is lowered in the scope, it is lowered where it is read (lower/shapes dispatchIn), never as a CTE or a carrier,
 * its rows those at the values (LowerContext `lower`), so a restriction a fence would stop at its edge stands inside it
 * (lower/shapes/share/keyed.ts restrictionWalk); a node of no equalities only passes the values on to nodes under it. A
 * node an enclosing row site held once (`heldEnv`) is held no longer where this scope restricts it again, at values
 * the enclosing root's query, where its CTE stands, does not see, and so is one a node under it is restricted at
 * values that read a relation not in scope where the root's WITH stands (Held `inScope`), its CTE's body, defined at its
 * first read, lowered under that restriction otherwise (a chain step's row site restricting the nodes under a held source
 * at the values of the steps before it, rows of the root's own FROM: qti-pie's ItemRefSection, its structure nodes held
 * at the test and read by two fenced steps at each item ref's values, 42P01); a node under it restricted at values of
 * what is in scope there, the unit's channels a judge's row carries, leaves it held. No scope restricts a held node
 * again at the values it is held at: the restriction walk gives each node under a row site the one restriction it is
 * derived at, the site's own walk (share/keys.ts rowReading), so a chain of unions' lowest level is held once by the
 * row site that reads it, never restricted again by the rules above it.
 */
/** The ids of a node's subtree through data inputs, itself included, once a node (its subtree is immutable). */
const subtrees = new WeakMap<RelNode, ReadonlySet<NodeId>>()
const subtreeOf = (node: RelNode): ReadonlySet<NodeId> => {
	const known = subtrees.get(node)
	if (known !== undefined) {
		return known
	}
	const ids = new Set(postorder<RelNode>([node], inputsOf).map((n) => n.id))
	subtrees.set(node, ids)
	return ids
}

export const restrictedEnv = (env: Env, restricted: ReadonlyMap<RelNode, ColumnEqualities>): Env =>
	restricted.size === 0
		? env
		: {
				columns: env.columns,
				restricted: new Map([...env.restricted, ...restricted]),
				held: new Map(
					[...env.held].filter(([node, held]) =>
						[...restricted].every(
							([under, now]) =>
								under !== node &&
								(!subtreeOf(node).has(under.id) ||
									now.every((e) => [...relationsRead(e.value)].every((r) => held.inScope.has(r))))
						)
					)
				)
			}

/**
 * `env` with each node of `held`, a restricted node a row site's root reads at several reads (share/keys.ts
 * restrictionWalk), held once in the table it maps to, the root's query's WITH (`restrictedRead`); a node an enclosing
 * root holds already, at the same values (`restrictedEnv`), keeps that one CTE.
 */
export const heldEnv = (env: Env, held: ReadonlyMap<RelNode, CteTable<RelNode>>): Env => {
	if (held.size === 0) {
		return env
	}
	const inScope = relationsInScope(env)
	return {
		columns: env.columns,
		restricted: env.restricted,
		held: new Map([
			...[...held].map(([node, table]) => [node, { table, inScope }] as const),
			...env.held
		])
	}
}

/**
 * A read of a node a restriction reaches in `env`, lowered by `lower`: where a row site's root holds it (`heldEnv`), a
 * read of its one MATERIALIZED CTE in the root's query, defined at its first read, its rows kept at the restriction
 * inside it (LowerContext keptAt), so the root derives it once for each of its evaluations, never once for each read;
 * where none does, lowered where it is read.
 */
export const restrictedRead = (
	cx: LowerContext,
	node: RelNode,
	env: Env,
	lower: (cx: LowerContext, env: Env) => OperandSelect
): OperandSelect => {
	const held = env.held.get(node)
	return held === undefined
		? lower(cx, env)
		: cteAtFirstUse(cx, node, held.table, node, "MATERIALIZED", () =>
				cx.keptAt(node, lower(cx, env), env)
			)
}

/**
 * One output column of a derived table or a CTE: the heading name it carries, paired at allocation with the fresh SQL
 * column it is read under.
 */
export interface NamedColumn {
	readonly name: string
	readonly column: string
}

/** The columns of a relation read under `alias` whose columns are `named`, by heading name. */
export const namedMap = (alias: string, named: ReadonlyArray<NamedColumn>): ColumnMap =>
	new Map(named.map(({ name, column }) => [name, col(alias, column)]))

/** One input read as a derived table: its FROM item, its alias and its columns. */
export interface InputSource {
	readonly item: FromSource
	readonly alias: string
	readonly columns: ReadonlyArray<string>
	readonly map: ColumnMap
}

/** Where a lowering step refuses: the step's label under conservative lowering. */
export const loweringAt = (at: string): SourceLoc => SourceLoc("conservative lowering", [at])

/** A refusal at `loc`, for a lowering a persistent expression shares (span and vector operators). */
export const refuseAt = (tag: ProseTag, loc: SourceLoc, capability: string): never => {
	throw new Refusal(CompileError.make(prose(tag, loc, capability)))
}

/** A refusal at the lowering step labelled `at`. */
export const refuse = (tag: ProseTag, at: string, capability: string): never =>
	refuseAt(tag, loweringAt(at), capability)

export const nodeLabel = (node: RelNode): string => `node ${node.id} (${node.kind})`

/** The column `name` of a column map the lowering built over a heading that holds it (namedColumn). */
export const columnIn = <V>(map: ReadonlyMap<string, V>, name: string): V =>
	namedColumn(map.get(name), name)

/** The inputs a node's query reads: an attachment is read as its parent, whose statement delivers the child (attach/). */
export const queryInputs = (node: RelNode): ReadonlyArray<RelNode> =>
	node.kind === "Attach" ? [node.parent] : inputsOf(node)

/**
 * The columns of a relation input of `heading`, each traveling as the array column `key` allocates (a membership's row
 * as a VALUES column of that name), of its base type `base` gives, its array checked as `check` gives (sql/ast.ts
 * ArrayCheck): a declared relation parameter's refined column through its domain, every other by its base type alone.
 */
export const relationColumns = (
	heading: Heading,
	key: () => string,
	base: (type: ScalarType) => TypeRef,
	check: (column: HeadingColumn) => ArrayCheck
): ReadonlyArray<RelationColumn> =>
	heading.map((c) => ({
		name: c.name,
		type: c.type,
		definition: columnDefinition(key(), base(c.type)),
		check: check(c)
	}))

/** No array a member slot, a carrier or a membership row travels as is checked beyond its base type. */
export const unchecked = (): ArrayCheck => baseCheck

/**
 * The arrays one relation input over `columns` travels as, in placeholder order: one per column, or, for an input of no
 * column, its count of facts.
 */
const arrayParts = (columns: ReadonlyArray<RelationColumn>): NonEmptyReadonlyArray<ArrayPart> =>
	isNonEmpty(columns)
		? mapNonEmpty(columns, (_, index): ArrayPart => ({ kind: "column", index }))
		: [{ kind: "count" }]

/**
 * The arrays of a relation input as a FROM item reads them (sql/ast.ts ArraysSource), from its placeholders in part
 * order (`arrayParts`): each column's definition with its array's placeholder, or the count's.
 */
export const arraysSource = (slots: NonEmptyReadonlyArray<ArraySlot>): ArraysSource => {
	const columns = slots[0].columns
	if (!isNonEmpty(columns)) {
		return { kind: "count", count: positionalValue(slots[0].number) }
	}
	return {
		kind: "columns",
		ordinal: undefined,
		columns: mapNonEmpty(columns, (column, index) => ({
			definition: column.definition,
			check: column.check,
			array: positionalValue(
				defined(slots[index], `the placeholder of column ${index} of a relation input`).number
			)
		}))
	}
}

/**
 * The placeholders of one statement, numbered from $1 in first-use order: its declared parameters', which every lowering
 * allocates, and those of `Own` only its own lowering allocates (a write's member slots, a page's fills). Each slot
 * carries its number, its position in `slots`, so a placeholder holding it prints it. Whoever begins a statement makes
 * its placeholders and hands the lowering their Placeholders view, so the statement it drains holds placeholders of
 * exactly the kinds its lowering can allocate.
 */
export class StatementParams<in out Own extends OwnParamSlot> {
	readonly #slots: Array<DeclaredParamSlot | Own> = []
	/** Each parameter's placeholders, one per cast type, found by the type's structure (sql/build.ts sameTypeRef). */
	readonly #scalars = new Map<
		ParamId,
		Array<{ readonly type: TypeRef; readonly slot: ScalarParamSlot }>
	>()
	readonly #relations = new Map<ParamId, NonEmptyReadonlyArray<RelationParamSlot>>()

	get slots(): ReadonlyArray<DeclaredParamSlot | Own> {
		return this.#slots
	}

	/** The slot `make` makes of the next number, appended. */
	#allocate<S extends DeclaredParamSlot | Own>(make: (number: number) => S): S {
		const slot = make(this.#slots.length + 1)
		this.#slots.push(slot)
		return slot
	}

	/** The slots of one relation input over `columns`, one per array (arrayParts), each `make` makes of its number and part. */
	protected allocateArrays<S extends DeclaredParamSlot | Own>(
		columns: ReadonlyArray<RelationColumn>,
		make: (number: number, part: ArrayPart) => S
	): NonEmptyReadonlyArray<S> {
		return mapNonEmpty(arrayParts(columns), (part) =>
			this.#allocate((number) => make(number, part))
		)
	}

	/**
	 * One placeholder per parameter and cast type: a parameter compared as its base and written as its domain is two
	 * placeholders, each always cast the same way (the kernel audit's param rule, test/support/oracle/verify/sql.ts).
	 */
	scalar(param: ParamId, type: ScalarType, sqlType: TypeRef): Expr {
		const casts = this.#scalars.getOrInsertComputed(param, () => [])
		const found = casts.find((c) => sameTypeRef(c.type, sqlType))
		if (found !== undefined) {
			return slotParam(found.slot, sqlType)
		}
		const slot = this.#allocate((number): ScalarParamSlot => ({
			kind: "scalar",
			placeholder: "value",
			number,
			param,
			type,
			sqlType
		}))
		casts.push({ type: sqlType, slot })
		return slotParam(slot, sqlType)
	}

	/**
	 * The array placeholders of a relation parameter, one per column or its count, its columns those `allocate` gives at
	 * the first use: every read of it in the statement reads the same arrays.
	 */
	relation(
		param: ParamId,
		allocate: () => ReadonlyArray<RelationColumn>
	): NonEmptyReadonlyArray<RelationParamSlot> {
		const known = this.#relations.get(param)
		if (known !== undefined) {
			return known
		}
		const columns = allocate()
		const slots = this.allocateArrays(columns, (number, part): RelationParamSlot => ({
			kind: "relation",
			placeholder: "value",
			number,
			param,
			columns,
			part
		}))
		this.#relations.set(param, slots)
		return slots
	}

	/** A new placeholder of the lowering's own slot, which `make` makes of its number. */
	own<S extends Own>(make: (number: number) => S): S {
		return this.#allocate(make)
	}
}

/** The placeholders of one write statement: its declared parameters', its member slots' and its nested rows' arrays. */
export class WriteParams extends StatementParams<MemberParamSlot | NestedRowsParamSlot> {
	readonly #members = new Map<ParamId, NonEmptyReadonlyArray<MemberParamSlot>>()
	readonly #nested = new TextsMap<NonEmptyReadonlyArray<NestedRowsParamSlot>>()

	/**
	 * The array placeholders of a stratum's nested rows of `relation`, one per column, its columns those `allocate` gives
	 * at the first use.
	 */
	nestedRows(
		stratum: StratumAt,
		relation: StoredRelationName,
		rows: FilledRows,
		allocate: () => ReadonlyArray<RelationColumn>
	): NonEmptyReadonlyArray<NestedRowsParamSlot> {
		const key = filledRowsKey(stratum, relation, rows)
		const known = this.#nested.get(key)
		if (known !== undefined) {
			return known
		}
		const columns = allocate()
		const slots = this.allocateArrays(columns, (number, part): NestedRowsParamSlot => ({
			kind: "nestedRows",
			placeholder: "value",
			number,
			stratum,
			relation,
			rows,
			columns,
			part
		}))
		this.#nested.set(key, slots)
		return slots
	}

	/**
	 * The array placeholders of an enumerated member slot of a write, one per column or its count, its columns those
	 * `allocate` gives at the first use.
	 */
	member(
		slot: ParamId,
		relation: string,
		allocate: () => ReadonlyArray<RelationColumn>
	): NonEmptyReadonlyArray<MemberParamSlot> {
		const known = this.#members.get(slot)
		if (known !== undefined) {
			return known
		}
		const columns = allocate()
		const slots = this.allocateArrays(columns, (number, part): MemberParamSlot => ({
			kind: "member",
			placeholder: "value",
			number,
			slot,
			relation,
			columns,
			part
		}))
		this.#members.set(slot, slots)
		return slots
	}
}

/**
 * What a lowering reads and allocates of the statement being lowered, whoever began it: its placeholders so far, as
 * any kind, and a declared parameter's placeholder.
 */
export interface Placeholders {
	readonly slots: ReadonlyArray<ConservativeParamSlot>
	readonly scalar: (param: ParamId, type: ScalarType, sqlType: TypeRef) => Expr
	readonly relation: (
		param: ParamId,
		allocate: () => ReadonlyArray<RelationColumn>
	) => NonEmptyReadonlyArray<RelationParamSlot>
}

/**
 * The placeholders of the statement being lowered: a query's or a page's, whose own placeholders its caller allocates,
 * or a write's, whose member slots its InputSets read.
 */
type StatementPlaceholders =
	| { readonly kind: "query"; readonly params: Placeholders }
	| { readonly kind: "write"; readonly params: WriteParams }

/**
 * The feedback relation of a Recursive node being lowered: the recursive CTE its SelfRef reads, the subquery depth
 * its WITH RECURSIVE is lowered at, and how many scans of it the step has lowered so far. PostgreSQL admits one
 * self-reference in the recursive term, outside any subquery expression of it, so the SelfRef
 * plug-in refuses a second scan, or a scan deeper than its CTE, rather than emit SQL that fails with 42P19.
 */
interface Feedback {
	readonly cte: string
	readonly columns: ReadonlyArray<NamedColumn>
	readonly sublinkDepth: number
	reads: number
}

export type NodeDispatch = (node: RelNode, cx: LowerContext, env: Env) => OperandSelect

/**
 * A node's rows with columns carried beside its heading (lower/shapes/share/keyed.ts KeyedLowering carried): its query,
 * delivering its heading's columns and then the carried ones, and the name each carried one is read by in the node's
 * column map, none a heading's name (`carriedName`).
 */
export interface CarriedRead {
	readonly query: OperandSelect
	readonly carried: NonEmptyReadonlyArray<string>
}

/**
 * How a lowering reads a node whose rows carry columns beside its heading where a reader places it as a source
 * (LowerContext sourceAs), the one place a node's rows enter a scope through a column map, so every reader that scopes
 * a node's columns scopes its carried ones too; none (`carriesNothing`) in a lowering whose nodes carry none.
 */
export type Carrying = (node: RelNode, cx: LowerContext, env: Env) => CarriedRead | undefined

/** The carrying of a lowering whose nodes carry no column beside their headings. */
export const carriesNothing: Carrying = () => undefined

/**
 * The name a column carried beside a node's heading is read by in its column map (CarriedRead): `column` of the carried
 * set `set`, under a NUL no heading's name holds, so it never reads a heading column, nor a heading column it.
 */
export const carriedName = (set: number, column: number): string =>
	`\u0000${String(set)}.${String(column)}`

/**
 * How a lowering builds a call's evaluation's query (call/index.ts evaluationQuery, or the query of the read that
 * evaluates the call itself) in the scope `env` it is built in: with the CTEs its arguments' shared nodes stand in
 * leading its WITH, each body lowered in that scope (cte-policy holderOf, lower/shapes ShapeState withHeldCtes), or as
 * it is (`evaluatedAsItStands`) in a lowering whose plan holds none there.
 */
export type EvaluationHolding = <Q extends OperandSelect>(
	call: NodeOf<"Call">,
	env: Env,
	build: () => Q
) => Q

/** The holding of a lowering that holds no CTE in an evaluation's query: each query as it is built. */
export const evaluatedAsItStands: EvaluationHolding = (_call, _env, build) => build()

/**
 * One kind's plug-in: its node to the query of its heading, a set (Select) or, realized plain where its consumer makes
 * its rows a set, an operand (OperandSelect).
 */
export type NodeLowerer<K extends RelKind> = (
	node: NodeOf<K>,
	cx: LowerContext,
	env: Env
) => OperandSelect

/**
 * The plug-ins of the kinds `K`, one per kind. Over every kind it is a kind table, so a kind the IR adds is a type
 * error until the table has its plug-in; a plug-in module exports its one-entry table, its lowerer staying private.
 */
export type Lowerers<K extends RelKind> = { readonly [P in K]: NodeLowerer<P> }

/**
 * What one lowering shares across every scope of it: the statement being lowered, whose names and placeholders a
 * statement accumulates and never crosses, and each node's outer references and scope as this lowering computed them,
 * the traversal's state for the life of the lowering. The scopes are a fold over the DAG, made at their first read.
 */
interface Shared {
	supply: NameSupply
	statement: StatementPlaceholders
	/**
	 * The host of the evaluations the statement holds once each in its own WITH (call/index.ts statementEvaluations),
	 * which the statement's builder states after it begins it, undefined where it states none.
	 */
	evaluations: EvaluationLookup | undefined
	readonly free: Map<RelNode, OuterRefs>
	scopes: Fold<RelNode, NodeScope> | undefined
	/** The templates its keys read (`templatesOf`). */
	readonly templates: DagTemplates
	/** The texts its expressions' interning reads (expr/share.ts FieldTexts). */
	readonly fieldTexts: FieldTexts
	/** The evaluation keys of the DAG's reads of fields of calls (call/keys.ts), made at the first key read. */
	evaluationKeys: EvaluationKeys | undefined
	/** What the lowering asks of the DAG about a node beside the node (dag-index.ts DagIndex), made at the first question. */
	index: DagIndex | undefined
	/** How many nodes the builds of `index` visited, summed over every build. */
	indexVisits: number
}

/**
 * A query of the conservative lowering whose WITH holds one MATERIALIZED CTE for each node in `shared`: the nodes its
 * lowering would otherwise lower more than once (dispatch.ts). Every use of such a node in the query reads its CTE, so
 * the node is lowered once, in the CTE's body, and a query's text grows with its DAG, not with the DAG's paths.
 *
 * A frame encloses the queries lowered inside its root's, and its CTEs are read from all of them. A CTE's body is
 * lowered where the frame's root was, in `cx` and `env`: the outer values it reads are bound outside the root, so they
 * are in scope at the root's WITH, and nothing lowered inside the root binds them anew.
 */
export interface ShareFrame {
	/** The frame the root was lowered in, whose CTEs the queries of this one read too. */
	readonly outer: ShareFrame | undefined
	readonly shared: ReadonlySet<RelNode>
	readonly cx: LowerContext
	readonly env: Env
	/** Each shared node's CTE, defined at its first use, and the WITH entries in definition order (CteTable). */
	readonly table: CteTable<RelNode>
}

/**
 * The CTEs a lowering defines, each at its first use (cteAtFirstUse): each by its key, and the WITH entries in
 * definition order, each after every entry its body reads.
 */
export interface CteTable<K> {
	readonly defined: Map<K, DefinedCte>
	readonly ctes: Set<Cte>
}

/** A CTE table that holds none yet. */
export const freshCtes = <K>(): CteTable<K> => ({ defined: new Map(), ctes: new Set() })

/**
 * A read of the CTE `table` holds for `node` at `key`, defined at its first use: `body()`, its query, lowered once, its
 * name and columns `cx`'s, `materialized` as given, entered last among `table`'s WITH entries.
 */
export const cteAtFirstUse = <K>(
	cx: LowerContext,
	node: RelNode,
	table: CteTable<K>,
	key: K,
	materialized: NonNullable<Cte["materialized"]>,
	body: () => OperandSelect
): OperandSelect => {
	const origin = { kind: "node", node: node.id } as const
	let cte = table.defined.get(key)
	if (cte === undefined) {
		const query = body()
		const name = cx.relationAlias(origin)
		const columns = cx.supply.columns(outputNames(node.heading).map(() => origin))
		table.ctes.add({ name, materialized, query: namedQuery(query, columns) })
		cte = { name, columns, set: isSetQuery(query) }
		table.defined.set(key, cte)
	}
	return cteRead(cx.relationAlias(origin), cte)
}

/** `query` with `ctes` leading its WITH, before the entries it already holds. */
export const withLeading = <Q extends OperandSelect>(query: Q, ctes: Iterable<Cte>): Q => {
	const leading = [...ctes]
	return isNonEmpty(leading)
		? {
				...query,
				with:
					query.with === undefined
						? { ctes: leading, recursive: false }
						: { ...query.with, ctes: extendNonEmpty(leading, query.with.ctes) }
			}
		: query
}

/**
 * A call's evaluation as a read of a field of its row finds it where a query around the read hosts it
 * (lower/conservative/call): the items the read's own FROM places before the field's rows, none where an item in scope
 * evaluates the call, and the row's attributes in their order, each a column of one of those items or of the one in
 * scope.
 */
export interface HostedEvaluation {
	readonly from: ReadonlyArray<FromSource>
	readonly attributes: NonEmptyReadonlyArray<Expr>
}

/**
 * What hosts the evaluations of the calls whose fields a scope's queries read: a host's evaluation of the call of the
 * read `read`, of evaluation key `key` (call/index.ts evaluationKey), undefined where it holds none, and the host
 * around it, which a read asks next.
 */
interface EvaluationHost {
	readonly outer: EvaluationHost | undefined
	readonly evaluation: EvaluationLookup
}

/**
 * A host's evaluation of the call a field read `read` reads, of evaluation key `key`, undefined where it holds none
 * (EvaluationHost), the read standing in `cx` and `env`, which binds the outer values its call reads.
 */
export type EvaluationLookup = (
	read: NodeOf<"Call">,
	key: string,
	cx: LowerContext,
	env: Env
) => HostedEvaluation | undefined

/**
 * What the query being lowered is nested in: how many subquery expressions (EXISTS) enclose it, the feedback relations
 * of the recursions being lowered around it, the dispatch its nodes lower through, and the hosts of the evaluations its
 * field reads read. A scope is extended for a subtree, never changed and restored: PostgreSQL refuses a recursive
 * reference inside a subquery expression of its own recursive term (42P19), so a feedback scan lowered deeper than its
 * recursive CTE is refused; a whole WITH RECURSIVE inside EXISTS is fine.
 */
interface Scope {
	readonly sublinkDepth: number
	/** The feedback relation of each Recursive being lowered, by its label, the name its SelfRef holds. */
	readonly feedback: ReadonlyMap<NodeId, Feedback>
	readonly dispatch: NodeDispatch
	/** The innermost share frame the query is lowered in, if its dispatch shares (dispatch.ts). */
	readonly sharing: ShareFrame | undefined
	/** The innermost host of the evaluations its field reads read, undefined where none hosts one. */
	readonly evaluations: EvaluationHost | undefined
	/** How a call's evaluation's query is built (EvaluationHolding). */
	readonly holding: EvaluationHolding
	/** How a node placed as a source carries columns beside its heading (Carrying). */
	readonly carrying: Carrying
	/**
	 * Where the statement computes a node once and reads it there (`computedAt`): the columns of its key analysis's key set
	 * (a share it holds at keys, a carrier's or a CTE's, or a union or a fold it lowers in place at its key set), none for
	 * a share it holds of every row, undefined for a node it computes nowhere once (share/statements.ts, keyed.ts,
	 * lower/optimize/pipeline.ts).
	 */
	readonly once: (node: RelNode) => ComputedAt
}

/**
 * Where a statement computes a node once (Scope `once`): the columns of its key set, none where it computes it whole,
 * undefined where it computes it nowhere once.
 */
export type ComputedAt = ReadonlyArray<string> | undefined

/** No node computed once: a lowering whose statement shares nothing. */
const noneOnce = (_node: RelNode): ComputedAt => undefined

/** Each write DAG's fact spine (factSpine), made once: a DAG is immutable. */
const factSpines = new WeakMap<ValidDag, ReadonlySet<RelNode>>()

/**
 * A write program's fact spine: the nodes whose rows are the facts its members state, as they reach the member's
 * statement (check/checker.ts RowsOf): each root, a union's arms, a projection's input, a filter's, the left side of a
 * semi-join or an anti-join, down to the region its rules match, whose sources are relations of their own. A merge on
 * it takes no canonical zero, so every boundary on it forms its rows by their identity (LowerContext.setOf); a node off
 * it, a region's source, a group's input, a take's, is a query's, whose merges the checker gave the canonical zero.
 */
const factSpine = (dag: ValidDag): ReadonlySet<RelNode> => {
	const made = factSpines.get(dag)
	if (made !== undefined) {
		return made
	}
	const spine = new Set<RelNode>()
	const reach = (node: RelNode): void => {
		if (spine.has(node)) {
			return
		}
		spine.add(node)
		for (const below of spineBelow(node)) {
			reach(below)
		}
	}
	for (const root of dag.roots) {
		reach(root)
	}
	factSpines.set(dag, spine)
	return spine
}

/** The nodes a fact spine continues through below `node` on it (factSpine): those whose rows are its own. */
const spineBelow = (node: RelNode): ReadonlyArray<RelNode> => {
	switch (node.kind) {
		case "Union":
			return unionArms(node.groups)
		case "ProjectSet":
		case "Filter":
			return [node.input]
		case "SemiJoin":
		case "AntiJoin":
			return [node.left]
		case "MatchRegion":
		case "Base":
		case "Closed":
		case "Context":
		case "InputSet":
		case "Delta":
		case "Intersect":
		case "Difference":
		case "Take":
		case "Group":
		case "Produce":
		case "Recursive":
		case "SelfRef":
		case "ApproximateNearest":
		case "OrderedResult":
		case "Attach":
		case "Forbid":
		case "Window":
		case "OrderedSetAggregate":
		case "Step":
		case "Call":
			return []
	}
}

/**
 * The store of the templates a lowering's keys and digests read (ir/dag-digest.ts DagTemplates): a write's and a
 * read-back's, their compile's, which its share planning reads too (write/program/compile.ts compileAt); any other
 * lowering's, its own.
 */
const templatesOf = (subject: ConservativeOptions["subject"]): DagTemplates => {
	switch (subject.kind) {
		case "write":
		case "readBack":
			return subject.templates
		case "query":
		case "ruleRegion":
		case "violationProbe":
		case "membership":
			return new DagTemplates("derivation")
	}
}

/** Where a lowering's first statement starts naming: a read-back's start, every other statement's r1 and c1. */
const firstStart = (options: ConservativeOptions): NameSupplyStart =>
	options.subject.kind === "readBack" ? options.subject.start : freshNames

/**
 * The state one conservative lowering threads through its per-kind plug-ins.
 *
 * Every node lowers to a query whose output columns are the node's heading, position by position (a zero-column
 * heading carries one private boolean `true`, so the unit tuple is a row). A consumer reads an input as a
 * derived table with a fresh r<n> alias and a fresh c<n> column list, so no generated name is ever
 * defined twice in a statement and every reference is qualified.
 *
 * A node holds its inputs and expressions themselves (ir/rel.ts), so a plug-in reads them as fields. Column references
 * in the IR name the node whose heading supplies the column by its label (ir/expr.ts). An environment maps the label
 * of each node in scope to the SQL expressions of its columns: a node's own expressions see its inputs, and a
 * correlated source also sees the outer nodes it names, which is what makes it LATERAL. A reference to a node outside
 * the environment is MalformedDescription: the IR promised a scope it does not have.
 *
 * Plug-ins report a refusal by throwing a Refusal (core/canonical.ts), which the entry point turns into a Result, so
 * the pass itself never throws.
 *
 * Set by the constructor, and by #within for an extended scope, which shares its lowering's state.
 */
export class LowerContext {
	readonly dag: ValidDag
	readonly options: ConservativeOptions
	readonly names: PhysicalNames
	#shared: Shared
	#scope: Scope

	constructor(
		dag: ValidDag,
		options: ConservativeOptions,
		dispatch: NodeDispatch,
		holding: EvaluationHolding,
		carrying: Carrying
	) {
		this.dag = dag
		this.options = options
		this.names = options.names
		this.#shared = {
			supply: new NameSupply(firstStart(options)),
			statement: { kind: "query", params: new StatementParams<never>() },
			evaluations: undefined,
			free: new Map(),
			scopes: undefined,
			templates: templatesOf(options.subject),
			fieldTexts: new FieldTexts(),
			evaluationKeys: undefined,
			index: undefined,
			indexVisits: 0
		}
		this.#scope = {
			sublinkDepth: 0,
			feedback: new Map(),
			dispatch,
			sharing: undefined,
			evaluations: undefined,
			holding,
			carrying,
			once: noneOnce
		}
	}

	/**
	 * This lowering in `scope`: the same statement and memo, so a subtree lowered in it allocates the statement's
	 * names and placeholders.
	 */
	#within(scope: Scope): LowerContext {
		const cx = new LowerContext(
			this.dag,
			this.options,
			scope.dispatch,
			scope.holding,
			scope.carrying
		)
		cx.#shared = this.#shared
		cx.#scope = scope
		return cx
	}

	get supply(): NameSupply {
		return this.#shared.supply
	}

	get params(): Placeholders {
		return this.#shared.statement.params
	}

	/** The recursions being lowered around the query, by the Recursive's label. */
	get feedback(): ReadonlyMap<NodeId, Feedback> {
		return this.#scope.feedback
	}

	get sublinkDepth(): number {
		return this.#scope.sublinkDepth
	}

	/** The scope of a subquery expression (EXISTS) of the query being lowered. */
	inSublink(): LowerContext {
		return this.#within({ ...this.#scope, sublinkDepth: this.#scope.sublinkDepth + 1 })
	}

	/** The scope of a recursion's term, whose SelfRef scans `cte`, its columns paired with the state columns. */
	withFeedback(
		recursive: NodeOf<"Recursive">,
		cte: string,
		columns: ReadonlyArray<NamedColumn>
	): LowerContext {
		const feedback = new Map(this.#scope.feedback)
		feedback.set(recursive.id, { cte, columns, sublinkDepth: this.#scope.sublinkDepth, reads: 0 })
		return this.#within({ ...this.#scope, feedback })
	}

	/** The scope whose nodes lower through `dispatch`. */
	withDispatch(dispatch: NodeDispatch): LowerContext {
		return this.#within({ ...this.#scope, dispatch })
	}

	/**
	 * This lowering at the root of its statement, its nodes lowered through `dispatch`: inside no sublink, recursion,
	 * share frame or evaluation host, the statement's own evaluations alone found (hostStatementEvaluations), and no node
	 * lowered as a scope it is read in lowers it (withLowering). A WITH entry of the statement stands outside every
	 * scope of the query that first reads it, and is lowered here.
	 */
	atStatementRoot(dispatch: NodeDispatch): LowerContext {
		return this.#within({
			sublinkDepth: 0,
			feedback: new Map(),
			dispatch,
			sharing: undefined,
			evaluations: undefined,
			holding: this.#scope.holding,
			carrying: this.#scope.carrying,
			once: this.#scope.once
		})
	}

	/** The scope whose node `node` lowers through `lower`, and every other node as this scope's dispatch lowers it. */
	withLowering<K extends RelKind>(node: NodeOf<K>, lower: NodeLowerer<K>): LowerContext {
		const dispatch = this.#scope.dispatch
		return this.withDispatch((n, cx, env) =>
			n === node ? lower(node, cx, env) : dispatch(n, cx, env)
		)
	}

	/**
	 * Where the statement computes `node` once and reads it there (Scope `once`): the columns of its key set (a share it
	 * holds at keys, or a union or a fold in place at its key set), read there wherever the statement reads it, never
	 * derived again at a reader's values; none, whole (a share of every row), which a reader binding it at values derives
	 * again there unless it is computed apart (lower/shapes/region heldChain); or undefined, nowhere once.
	 */
	computedAt(node: RelNode): ComputedAt {
		return this.#scope.once(node)
	}

	/** The scope whose statement computes the nodes `once` names once, at the key sets it gives (computedAt). */
	withComputedAt(once: (node: RelNode) => ComputedAt): LowerContext {
		return this.#within({ ...this.#scope, once })
	}

	/** The innermost share frame the query being lowered is inside, undefined outside every frame. */
	get sharing(): ShareFrame | undefined {
		return this.#scope.sharing
	}

	/** The scope whose queries are lowered inside `frame`. */
	withSharing(frame: ShareFrame): LowerContext {
		return this.#within({ ...this.#scope, sharing: frame })
	}

	/**
	 * The scope whose field reads find their calls' evaluations in `lookup` first, then in the hosts around it and the
	 * statement's.
	 */
	withEvaluations(lookup: EvaluationLookup): LowerContext {
		return this.#within({
			...this.#scope,
			evaluations: { outer: this.#scope.evaluations, evaluation: lookup }
		})
	}

	/**
	 * `build`'s query of `call`'s evaluation in the scope `env`, holding what the lowering's plan holds there
	 * (EvaluationHolding).
	 */
	evaluationOf<Q extends OperandSelect>(call: NodeOf<"Call">, env: Env, build: () => Q): Q {
		return this.#scope.holding(call, env, build)
	}

	/** The templates the lowering's keys and digests read (`templatesOf`). */
	get templates(): DagTemplates {
		return this.#shared.templates
	}

	/** The texts every expression of the statement is interned by (expr/share.ts FieldTexts). */
	get fieldTexts(): FieldTexts {
		return this.#shared.fieldTexts
	}

	/** The evaluation key of `read`, a read of a field of a call (call/keys.ts EvaluationKeys). */
	evaluationKey(read: NodeOf<"Call">): string {
		const keys = this.#shared.evaluationKeys ?? new EvaluationKeys(this.dag, this.#shared.templates)
		this.#shared.evaluationKeys = keys
		return keys.of(read)
	}

	/**
	 * What the lowering asks of its DAG about a node beside the node itself (dag-index.ts DagIndex): built at its first
	 * question, and every later question of every scope and statement of the lowering read off it.
	 */
	get index(): DagIndex {
		const made = this.#shared.index
		if (made !== undefined) {
			return made
		}
		const index = new DagIndex(this.dag)
		this.#shared.index = index
		this.#shared.indexVisits += index.visited
		return index
	}

	/** How many nodes the lowering's builds of its index (`index`) visited: the DAG's nodes once, whatever it asks. */
	get indexVisits(): number {
		return this.#shared.indexVisits
	}

	/**
	 * The evaluation of the call of evaluation key `key` a query around the scope hosts: the innermost host's that holds
	 * it, undefined where none does, so the read evaluates the call itself.
	 */
	hostedEvaluation(read: NodeOf<"Call">, key: string, env: Env): HostedEvaluation | undefined {
		for (let host = this.#scope.evaluations; host !== undefined; host = host.outer) {
			const hosted = host.evaluation(read, key, this, env)
			if (hosted !== undefined) {
				return hosted
			}
		}
		return this.#shared.evaluations?.(read, key, this, env)
	}

	/**
	 * The statement being lowered hosts the evaluations `lookup` holds, after every host of the scopes inside it: its
	 * builder states them once it begins it, and emits the WITH entries they define.
	 */
	hostStatementEvaluations(lookup: EvaluationLookup): void {
		this.#shared.evaluations = lookup
	}

	/**
	 * The next statement of a query or a page, its placeholders `params`, naming past the last one's names: no two
	 * statements of one lowering define one generated name, so any of them can be parts of one statement (a riding
	 * read-back's of the write statement it rides, ReadBackLowering start; a conservative program's of its one statement,
	 * shapes/index.ts partedConservative). Placeholders never cross statements.
	 */
	beginStatement(params: Placeholders): void {
		this.beginStatementWith(new NameSupply(this.#shared.supply.past()), params)
	}

	/** The next statement of a query or a page, naming from `supply`, its placeholders `params`. */
	beginStatementWith(supply: NameSupply, params: Placeholders): void {
		this.#shared.supply = supply
		this.#shared.statement = { kind: "query", params }
		this.#shared.evaluations = undefined
	}

	/** The next statement of a write, naming from `supply`, its placeholders `params`, which its member slots read. */
	beginWriteStatement(supply: NameSupply, params: WriteParams): void {
		this.#shared.supply = supply
		this.#shared.statement = { kind: "write", params }
		this.#shared.evaluations = undefined
	}

	/**
	 * The array placeholders of the enumerated member slot `slot` of `relation`, its columns those `allocate` gives at
	 * the first use. A member slot is a write's: outside a write statement, which fills it, it is UnsupportedOperation,
	 * as a Delta outside a write program is.
	 */
	member(
		slot: ParamId,
		relation: string,
		allocate: () => ReadonlyArray<RelationColumn>,
		at: string
	): NonEmptyReadonlyArray<MemberParamSlot> {
		const statement = this.#shared.statement
		switch (statement.kind) {
			case "write":
				return statement.params.member(slot, relation, allocate)
			case "query":
				return refuse(
					"UnsupportedOperation",
					at,
					`the member slot ${slot} of ${relation} outside a write statement that fills it`
				)
		}
	}

	/**
	 * The array placeholders of a stratum's nested rows of `relation`, its columns those `allocate` gives at the first use.
	 * Nested rows are a write's: outside a write statement, which fills them, they are UnsupportedOperation.
	 */
	nestedRows(
		stratum: StratumAt,
		relation: StoredRelationName,
		rows: FilledRows,
		allocate: () => ReadonlyArray<RelationColumn>,
		at: string
	): NonEmptyReadonlyArray<NestedRowsParamSlot> {
		const statement = this.#shared.statement
		switch (statement.kind) {
			case "write":
				return statement.params.nestedRows(stratum, relation, rows, allocate)
			case "query":
				return refuse(
					"UnsupportedOperation",
					at,
					`the nested rows of ${relation} in stratum ${stratum} outside a write statement that fills them`
				)
		}
	}

	/**
	 * The carrier of the relation parameter `param` its ChangeSet binds to a query (InputSet `bound`), which its write
	 * program fills once before the first stratum of the part that bound it: a write statement's or a read-back's, whose
	 * subject names it. Outside
	 * a write program, or for a parameter its program holds in no carrier, it is UnsupportedOperation, as a Delta outside
	 * a write program is.
	 */
	boundRows(param: ParamId, at: string): BoundCarrier {
		const subject = this.options.subject
		switch (subject.kind) {
			case "write":
			case "readBack":
				return (
					subject.bound(param) ??
					refuse(
						"UnsupportedOperation",
						at,
						`relation parameter ${param} bound to a query outside a write program that holds its rows`
					)
				)
			case "query":
			case "membership":
			case "ruleRegion":
			case "violationProbe":
				return refuse(
					"UnsupportedOperation",
					at,
					`relation parameter ${param} bound to a query outside a write program that holds its rows`
				)
		}
	}

	/**
	 * The value of each field of a write filter's membership row, by the field's name, as the membership's caller names
	 * it. A row is a membership's: outside the membership that names it, it is UnsupportedOperation, as a Delta outside
	 * a write program is.
	 */
	membershipRow(at: string): (field: string) => Expr {
		const subject = this.options.subject
		switch (subject.kind) {
			case "membership":
				return subject.row
			case "query":
			case "write":
			case "ruleRegion":
			case "violationProbe":
			case "readBack":
				return refuse(
					"UnsupportedOperation",
					at,
					"a write filter's row outside the membership that names its values"
				)
		}
	}

	/**
	 * The set of `node`'s rows `targets` deliver, in its heading's order, over `from` where `where` holds: the one
	 * boundary every lowerer puts on a node's own rows. On a write's fact spine (factSpine), where the rows are facts a
	 * member states and no merge took the canonical zero, a set of facts by their identity (ir/compare.ts factSet), -0
	 * and +0 two of them, as the write's statement forms them (write/insert/input.ts inputSet); elsewhere SELECT
	 * DISTINCT, under PostgreSQL's equality, where the checker gave every float a merge may take its canonical zero
	 * (check/merge.ts), so no plan picks one.
	 */
	setOf(
		node: RelNode,
		targets: NonEmptyReadonlyArray<Target>,
		from: ReadonlyArray<FromItem>,
		where: Expr | undefined
	): SetCore {
		if (!this.#onFactSpine(node)) {
			return distinctCore(targets, from, where)
		}
		const columns = node.heading.flatMap((c, at) => {
			const read = targets[at]
			return read === undefined ? [] : [{ target: read, type: c.type }]
		})
		return isNonEmpty(columns) ? factSet(columns, from, where) : distinctCore(targets, from, where)
	}

	/**
	 * The set union of a union node's arms, each projected onto its heading (union/arms.ts armCore): UNION, under
	 * PostgreSQL's equality, off a write's fact spine; on it, the arms' UNION ALL formed into one set of facts by their
	 * identity (setOf), so a member's -0 and +0 at otherwise equal fields stay two facts.
	 */
	unionOf(node: NodeOf<"Union">, arms: NonEmptyReadonlyArray<SelectCore>): Select {
		if (!this.#onFactSpine(node)) {
			return select(
				setBodyOf(setOp("UNION", arms), "a set union over at least two arms, or one set arm")
			)
		}
		const all = this.wrap(operandSelect(operandUnionAll(arms)), node.heading, {
			kind: "node",
			node: node.id
		})
		return select(this.setOf(node, headingTargets(node.heading, all.map), [all.item], undefined))
	}

	/** Whether `node` is on the fact spine of the write this lowers (factSpine): none is, off a write's members. */
	#onFactSpine(node: RelNode): boolean {
		switch (this.options.subject.kind) {
			case "write":
				return factSpine(this.dag).has(node)
			case "query":
			case "ruleRegion":
			case "violationProbe":
			case "readBack":
			case "membership":
				return false
		}
	}

	/**
	 * The query of a node, output columns in heading order, as the scope's dispatch lowers it; at the values `env`
	 * restricts it to where it does (`restrictedEnv`), its rows read apart and kept at them.
	 */
	lower(node: RelNode, env: Env): OperandSelect {
		return this.keptAt(node, this.#scope.dispatch(node, this, env), env)
	}

	/**
	 * `query`, `node`'s rows, kept at the values `env` restricts it to where its lowering holds none of them itself
	 * (`restrictsInside`): read apart and filtered; as it is where `env` restricts it to none. A node held once
	 * (`restrictedRead`) is kept so inside its CTE too, which its every read reads, whatever dispatch reads it.
	 */
	keptAt(node: RelNode, query: OperandSelect, env: Env): OperandSelect {
		const restriction = env.restricted.get(node)
		if (restriction === undefined || restriction.length === 0 || restrictsInside(node)) {
			return query
		}
		const rows = this.wrap(query, node.heading, { kind: "node", node: node.id })
		return operandSelect(
			keyedRead(
				headingTargets(node.heading, rows.map),
				[rows.item],
				conjunction(equalitiesOver(this, node.heading, rows.map, restriction))
			)
		)
	}

	/**
	 * Whether lowering `node` would scan the working table of a Recursive being lowered: whether its inputs reach a
	 * SelfRef with an active feedback relation.
	 *
	 * The array iterator reads the length at every step, so the inputs pushed below are visited too.
	 */
	readsFeedback(node: RelNode): boolean {
		if (this.feedback.size === 0) {
			return false
		}
		const seen = new Set<RelNode>([node])
		const queue = [node]
		for (const queued of queue) {
			if (queued.kind === "SelfRef" && this.feedback.has(queued.recursive)) {
				return true
			}
			for (const input of inputsOf(queued)) {
				if (!seen.has(input)) {
					seen.add(input)
					queue.push(input)
				}
			}
		}
		return false
	}

	/**
	 * `left = right` for two values of `type`, at the operator its type resolves (ir/compare.ts operatorSchemaOf). Every
	 * binding, constant, equality, correlation, stitch and delivery check a lowering emits compares through it.
	 */
	equal(type: ScalarType, left: Expr, right: Expr): Expr {
		return typedEq(type, left, right, this.names)
	}

	relationAlias(origin: NameOrigin): string {
		return this.supply.relation(origin)
	}

	/** One fresh column per name, paired with it. */
	freshColumns(names: ReadonlyArray<string>, origin: NameOrigin): ReadonlyArray<NamedColumn> {
		return names.map((name) => ({ name, column: this.supply.column(origin) }))
	}

	/** A lowered query read as a derived table with a fresh alias and column list. `heading` names its outputs. */
	wrap(query: OperandSelect, heading: Heading, origin: NameOrigin): InputSource {
		return this.wrapAs(query, heading, origin, false)
	}

	/** wrap, a LATERAL derived table when `lateral`. */
	wrapAs(
		query: OperandSelect,
		heading: Heading,
		origin: NameOrigin,
		lateral: boolean
	): InputSource {
		return this.#wrapNamed(query, outputNames(heading), origin, lateral)
	}

	/** A query read as a derived table whose columns are `names`, each under a fresh column, LATERAL when `lateral`. */
	#wrapNamed(
		query: OperandSelect,
		names: ReadonlyArray<string>,
		origin: NameOrigin,
		lateral: boolean
	): InputSource {
		const named = this.freshColumns(names, origin)
		const columns = named.map((n) => n.column)
		const alias = this.supply.relation(origin)
		return {
			item: derived(namedQuery(query, columns), alias, lateral),
			alias,
			columns,
			map: namedMap(alias, named)
		}
	}

	/** A node lowered and read as a derived table. */
	source(node: RelNode, env: Env): InputSource {
		return this.sourceAs(node, env, false)
	}

	/**
	 * source, a LATERAL derived table when `lateral`; a node whose rows carry columns beside its heading (Carrying) read
	 * with them, each in its map under its carried name, where the scope reads the node whole: a restriction stands on
	 * the node as it is lowered (`lower`), which its carried rows would not keep.
	 */
	sourceAs(node: RelNode, env: Env, lateral: boolean): InputSource {
		const origin = { kind: "node", node: node.id } as const
		const carried = env.restricted.has(node) ? undefined : this.#scope.carrying(node, this, env)
		return carried === undefined
			? this.wrapAs(this.lower(node, env), node.heading, origin, lateral)
			: this.#wrapNamed(
					carried.query,
					[...outputNames(node.heading), ...carried.carried],
					origin,
					lateral
				)
	}

	/**
	 * The stored columns a scalar expression subtree of `node` reads from nodes outside its own subtree, by the label
	 * of the node: the outer references that make a source correlated. Feedback edges are names and are not followed.
	 */
	freeRefs(node: RelNode): OuterRefs {
		const known = this.#shared.free.get(node)
		if (known !== undefined) {
			return known
		}
		const reach = new Set<RelNode>([node])
		const labels = new Set<NodeId>([node.id])
		const queue = [node]
		for (const queued of queue) {
			for (const input of inputsOf(queued).filter((i) => !reach.has(i))) {
				reach.add(input)
				labels.add(input.id)
				queue.push(input)
			}
		}
		const free = new Map<NodeId, Set<string>>()
		for (const e of exprClosure(queue.flatMap((n) => exprsOf(n)))) {
			if (e.kind !== "column" || labels.has(e.column.node)) {
				continue
			}
			const set = free.getOrInsertComputed(e.column.node, () => new Set<string>())
			set.add(e.column.name)
		}
		this.#shared.free.set(node, free)
		return free
	}

	/**
	 * The scope of `node` (ir/dag.ts nodeScopes): the columns of nodes outside it that its evaluation reads, which an
	 * environment must bind wherever it is lowered.
	 */
	scopeOf(node: RelNode): NodeScope {
		this.#shared.scopes ??= nodeScopes()
		return this.#shared.scopes.of(node)
	}

	/** The PostgreSQL type of a value of `t` (physicalTypeRef). */
	typeRef(t: ScalarType): TypeRef {
		return physicalTypeRef(this.names, t)
	}

	/**
	 * The type a declared parameter's value of `t` at `place` is cast to as its placeholder is bound: a contract's domain,
	 * a pattern's the parameter's own pattern domain (ir/physical.ts paramDomain), and otherwise its base. PostgreSQL
	 * checks the value against the refinement as it binds it, before any row is read, and nothing on the host does, so
	 * its refinement travels with it and a refusal names its law or its parameter.
	 */
	paramTypeRef(t: ScalarType, place: ParamPlace): TypeRef {
		const regex = paramPattern(t)
		if (regex === undefined) {
			return this.typeRef(t)
		}
		const domain = this.names.paramDomain(place, regex)
		return { kind: "named", schema: domain.schema, name: domain.name, typmod: [], array: false }
	}

	/**
	 * The placeholder of the declared scalar parameter `param`, read as a value of `type`: cast to the type its declared
	 * type's values are checked against as they are bound (paramTypeRef), whatever type the expression reading it has,
	 * so every placeholder of a refined parameter is checked by PostgreSQL; an undeclared one is a malformed description.
	 * A parameter its served member binds to the database's clock is no slot but the reading itself (sql/ast.ts Expr
	 * clock), cast as its placeholder would be, so its contract judges the reading as it judges a caller's value.
	 */
	scalarParam(param: ParamId, type: ScalarType, at: string): Expr {
		const p = this.options.params.find((d) => d.id === param)
		if (p === undefined || p.kind === "relation") {
			return refuse("MalformedDescription", at, `a declared scalar parameter ${param}`)
		}
		const checked = this.paramTypeRef(p.type, { kind: "scalar", name: param })
		return p.kind === "clock"
			? this.clockReading({ kind: "param", param: p.name }, p.unit, checked)
			: this.params.scalar(param, type, checked)
	}

	/**
	 * A reading of the database's clock for `of` in `unit`, cast to `type` (sql/ast.ts Expr clock), at the instant the
	 * program's declared parameters say: the call's transaction's, or, in a program that declares the clock's stated
	 * instant (a moved clock's compile, check/clock.ts sourcedParams), the instant's placeholder, one per statement however
	 * many readings it holds, so every reading of a call counts the one instant the call states.
	 */
	clockReading(of: ClockOf, unit: ClockUnit, type: TypeRef): Expr {
		const stated = this.options.params.find((d) => d.id === clockInstant.id)
		const instant: ClockInstant =
			stated === undefined
				? transactionInstant
				: { kind: "moved", at: this.params.scalar(stated.id, clockInstant.type, types.bigint) }
		return { kind: "clock", of, instant, unit, type }
	}

	/**
	 * What checks a declared relation parameter's array of `t` at `field` as it is bound (sql/ast.ts ArrayCheck): its
	 * refinement's domain, the one `paramTypeRef` casts a scalar parameter to, through which the array is cast before its
	 * base type, so PostgreSQL checks every element; nothing beyond its base type for an unrefined one.
	 */
	arrayCheck(t: ScalarType, param: string, field: string): ArrayCheck {
		const domain = this.paramTypeRef(t, { kind: "field", name: param, field })
		return sameTypeRef(domain, this.baseTypeRef(t)) ? baseCheck : { kind: "domain", domain }
	}

	/**
	 * The type with every refinement dropped: a contract's base, unrefined text. Input arrays, VALUES lists, literals
	 * and recursive state are cast to it; a value checked at compile time or already stored
	 * needs no domain check again.
	 */
	baseTypeRef(t: ScalarType): TypeRef {
		return physicalBaseType(this.names, t)
	}

	/**
	 * The type of a take or page bound parameter: its declaration's, which the checker states for every bound parameter
	 * (integer, or the wider type another use of the parameter fixes). It is the type its values are checked against as
	 * they are bound (paramTypeRef): a bound is never refined, since the checker refuses a contract's or a pattern's use
	 * of a parameter beside its integer use as a bound (check/params.ts ParamCell.use). An undeclared one is a malformed
	 * description, and so is one its member binds to the database's clock: a bound is a count of rows the call states,
	 * never an instant.
	 */
	boundParam(bound: TakeBound & { readonly kind: "param" }): Expr {
		const p = this.options.params.find((d) => d.id === bound.param)
		switch (p?.kind) {
			case "scalar":
				return this.params.scalar(bound.param, p.type, this.baseTypeRef(p.type))
			case "clock":
				return refuse(
					"MalformedDescription",
					"take bound",
					`a take bound the call states; ${bound.param} is bound to the database's clock`
				)
			case "relation":
			case undefined:
				return refuse(
					"MalformedDescription",
					"take bound",
					`a declared scalar parameter ${bound.param}`
				)
		}
	}

	boundExpr(bound: TakeBound): Expr {
		return bound.kind === "literal" ? lit.int(bound.k, types.bigint) : this.boundParam(bound)
	}
}

/** The pattern a declared parameter's own pattern domain checks of a value of `t`: refined text outside any contract. */
const paramPattern = (t: ScalarType): RegexRef | undefined =>
	t.contract === undefined && t.carrier === "text" ? regexOf(t.text) : undefined

/**
 * The PostgreSQL type of a value of `t`: a contract's domain, a regex refinement's structural text domain, which the
 * installation holds for every refinement any artifact over it types a value by (ir/physical.ts PhysicalNames
 * textDomain), an extension's vector, or the builtin with its typmod, a closed id's smallint code and a set's bit(n)
 * among them. A closed id's value is no domain's: its column is its roster's domain, which checks a code where it is
 * stored, and a code computed or compared in a query is the smallint it is.
 */
export const physicalTypeRef = (names: PhysicalNames, t: ScalarType): TypeRef => {
	const { contract } = t
	if (contract !== undefined) {
		return qualifiedType(names.contractDomain(contract.name))
	}
	const regex = t.carrier === "text" ? regexOf(t.text) : undefined
	return regex === undefined ? physicalBaseType(names, t) : qualifiedType(names.textDomain(regex))
}

/** The output names of a heading: its columns, or the unit marker (runtime/lower/tree.ts namesOrUnit). */
export const outputNames = (heading: Heading): NonEmptyReadonlyArray<string> =>
	namesOrUnit(heading.map((c) => c.name))

/**
 * The targets that read `heading` from a column map over a heading with its columns, in heading order; the unit marker
 * for a zero-column heading.
 */
export const headingTargets = (heading: Heading, map: ColumnMap): NonEmptyReadonlyArray<Target> =>
	isNonEmpty(heading) ? mapNonEmpty(heading, (c) => target(columnIn(map, c.name))) : unitTargets

/**
 * Columns each equal to a value, one equality per entry. It is a list, never a map from column to value, as an
 * attachment's correlation is a list of pairs (ir/rel.ts Attach): a child column the correlation pairs with two parent
 * columns is equal to both, which holds only for a parent whose two columns agree.
 */
export type ColumnEqualities = ReadonlyArray<{ readonly column: string; readonly value: Expr }>

/** No equality: a node read with every row (a fold's every group, a union's every row). */
export const noRestriction: ColumnEqualities = []

/** An attachment's correlation over its parent's columns read through `parent`: each pair one equality. */
const correlatedColumns = (attach: NodeOf<"Attach">, parent: ColumnMap): ColumnEqualities =>
	attach.correlation.map((c) => ({ column: c.child, value: columnIn(parent, c.parent) }))

/** The equalities over columns of `heading`, each column read through `source`. */
export const equalitiesOver = (
	cx: LowerContext,
	heading: Heading,
	source: ColumnMap,
	equalities: ColumnEqualities
): ReadonlyArray<Expr> =>
	equalities.map((e) =>
		cx.equal(columnType(heading, e.column), columnIn(source, e.column), e.value)
	)

/**
 * The equalities of an attachment's correlation: each child column of heading `child`, read through `source`, equal to
 * the parent column it is correlated with, read through `parent`.
 */
export const correlationEqualities = (
	cx: LowerContext,
	attach: NodeOf<"Attach">,
	child: Heading,
	source: ColumnMap,
	parent: ColumnMap
): ReadonlyArray<Expr> => equalitiesOver(cx, child, source, correlatedColumns(attach, parent))

/**
 * SELECT DISTINCT over one or more FROM items: the conservative set boundary, restricted by the conjunction of
 * `where`, which has no WHERE when it is empty.
 */
export const distinctSelect = (
	targets: NonEmptyReadonlyArray<Target>,
	from: ReadonlyArray<FromItem>,
	where: ReadonlyArray<Expr>
): Select => select(distinctCore(targets, from, conjunction(where)))

/**
 * A heading's columns read through `map` over `from` as a set of facts (ir/compare.ts factSet): an InputSet's, whose
 * rows are a parameter relation's facts, a set by their identity, so -0 and +0 are two of them as the host codec holds
 * them (codec/recordset.ts); a heading of no column is the unit relation's.
 */
export const factSetSelect = (
	heading: Heading,
	map: ColumnMap,
	from: ReadonlyArray<FromItem>
): Select =>
	isNonEmpty(heading)
		? select(
				factSet(
					mapNonEmpty(heading, (c) => ({ target: target(columnIn(map, c.name)), type: c.type })),
					from,
					undefined
				)
			)
		: distinctSelect(unitTargets, from, [])

/**
 * Whether a source's rows are a set: a derived table whose query is one (sql/ast.ts isSetQuery), deduplicated or a
 * core under its proof, as every node a lowering deduplicates or proves is, or any other source.
 */
export const readsSet = (source: FromSource): boolean =>
	source.kind !== "derived" || isSetQuery(source.query)

/**
 * The rows of `node` over the sources `from` where `where` holds, delivered by `targets`, which hold every column of
 * each source, each as it is, through the binary coercion, which keeps every value, or fixed by `where`: a filter's
 * heading, a renaming's, a region's every column bound. Two distinct rows of the sources then deliver two distinct
 * rows, so over sets no row repeats and the core stands under the proof `keyed`, the sets' whole headings (sql/ast.ts
 * RowsProof), with no deduplication; over rows that may repeat, it is the node's set boundary (LowerContext.setOf).
 */
export const wholeSelect = (
	cx: LowerContext,
	node: RelNode,
	from: ReadonlyArray<FromSource>,
	targets: NonEmptyReadonlyArray<Target>,
	where: ReadonlyArray<Expr>
): Select =>
	from.every(readsSet)
		? provedSelect("keyed", targets, from, conjunction(where))
		: select(cx.setOf(node, targets, from, conjunction(where)))
