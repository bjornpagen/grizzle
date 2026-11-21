import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	lastNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { TupleSet } from "@bjornpagen/grizzle-text/base/tuple-map"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { NodeId, OccurrenceId, ParamId } from "#compiler/core/ids.ts"
import type { NodeScope, OuterRefs } from "#compiler/ir/dag.ts"
import { type EvidenceContext, type Premise, strongest } from "#compiler/ir/evidence.ts"
import {
	type EqualityKey,
	exprClosure,
	nativeEqualityKey,
	type ScalarExpr,
	type TypedLiteral
} from "#compiler/ir/expr.ts"
import { comparedValue } from "#compiler/ir/injective.ts"

import {
	armsAgree,
	atMostOneRow,
	correlatedVariable,
	type Dependency,
	declaredKey,
	generationDetermines,
	type EqualWitness,
	type FixedWitness,
	distinctColumns,
	equalColumns,
	fixedColumn,
	groupKeeps,
	groupKey,
	hiddenAttribute,
	type Implication,
	implication,
	isHidden,
	type KeyAlternative,
	type KeyFactor,
	type KeyMember,
	type KeyProof,
	keyAlternative,
	keyFactor,
	keyIn,
	keyMember,
	keyWithin,
	listedKeys,
	matchBinds,
	producedFact,
	projectionCloses,
	rightKeeps,
	rowsKeep,
	rowsKey,
	type Separation,
	separated,
	soleFactor,
	unionKey,
	unionKeyDetermines,
	type ViewKey,
	numberedRow,
	viewAlternative,
	windowValue
} from "#compiler/ir/keys.ts"

import {
	type Card,
	closedColumn,
	type Heading,
	type KeySet,
	type KindOver,
	type NodeOf,
	type NodeOver,
	type RelNode,
	unionArms,
	type ValueRefs
} from "#compiler/ir/rel.ts"

import { type ScalarType, sameScalarType } from "#compiler/ir/scalar.ts"
import {
	type Attributes,
	attributesOver,
	type Bits,
	bitsAt,
	addTo,
	bitsOf,
	copyBits,
	dropFrom,
	holdsAt,
	isEmpty,
	intersect,
	nameAt as attributeAt,
	namesOf as attributeNames,
	noBits,
	orInto,
	positions,
	sameBits,
	union,
	subsetOf
} from "#compiler/logical/attributes.ts"
import {
	type Closure,
	closure,
	covers,
	derivation,
	derivationRows,
	independentFactors,
	minimalKeys,
	type NameSource,
	type Naming,
	namesNone,
	namesNothing,
	namingOver,
	reaches,
	type Row,
	type Rows,
	rowsAmong,
	rowsOf,
	stepsOf
} from "#compiler/logical/closure.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"

/** What a column is fixed to per evaluation. */
export type Fixed =
	| { readonly kind: "literal"; readonly literal: TypedLiteral; readonly key: EqualityKey }
	| { readonly kind: "param"; readonly param: ParamId }
	| { readonly kind: "outer"; readonly node: NodeId; readonly column: string }
	| { readonly kind: "expr" }

/**
 * A stored fact a column's value was read from: the scan (a region occurrence over a Base, or the Base's own
 * occurrence), the relation and the field.
 */
export interface Provenance {
	readonly scan: OccurrenceId
	readonly relation: string
	readonly field: string
}

/**
 * The logical properties of one node: the dependencies it states over its heading and the keys they prove, relative to
 * its parameters and outer variables, its cardinality, the stored facts each column was read from, and the evidence
 * context its claims need.
 *
 * Every node states the dependencies it adds (ir/keys.ts names the rules), and a node's keys are derived from them: a
 * set of columns is a key when it determines the whole heading of a node whose rows are distinct tuples of it. A node
 * carries an input's dependency whose determinants it keeps, closed over the input, and each input key it keeps, a
 * dropped determinant column replaced by a kept column of its class, so a projection proves a key whenever the key
 * determines its output heading under its input's dependencies:
 *
 * - Base: its primary key and each declared key, immediate storage facts; a derived or world relation's view keys, as
 *   its environment names them. Closed: each column whose values are distinct, a column of one value fixed, two
 *   columns of one type holding one value in every fact equal, at most one fact; descriptor facts. Context: at most one fact. A membership's row: exactly one fact, a descriptor fact.
 *   Delta: its relation's keys, which hold in both of the states it compares. Any other InputSet, Recursive and
 *   SelfRef: none beyond the whole heading, a set.
 * - MatchRegion: a scan determines what it binds from its source's dependencies, its source columns bound to variables,
 *   fixed by a constant, or fixed in the source; shared variables join, a column bound to two variables equates them,
 *   equalities equate, a correlated variable follows from what it reads, and a variable bound to a column its lateral
 *   source fixes to a region column's value equals that column's variable.
 * - Filter: an equality with a value fixed per evaluation fixes its column; one between two columns equates them; a
 *   false conjunct leaves at most one row, none.
 * - ProjectSet: closes over its input, its computed outputs following from the columns they read.
 * - Group: the group key determines the group, and the input's dependencies among it hold.
 * - Union: a column every arm fixes alike is fixed; two columns every arm makes equal are equal, by each arm's
 *   equalities; what every arm derives from an arm's determinant, beside the literals telling every two arms apart, is
 *   derived from them; a key of every arm is a key when every two arms are told apart by a literal both fix on it, their
 *   discriminant; one heading group is a set of its whole heading.
 * - Every node that keeps its input's rows keeps its input's dependencies: Filter, Take, SemiJoin, AntiJoin,
 *   Difference and Intersect (either side), OrderedResult, ApproximateNearest, Window, Attach, Forbid; a SemiJoin also
 *   fixes a left column paired with a fixed right column, a Take its correlated columns, and take(1) has at most one
 *   row. A Window's input row determines its value.
 * - Produce: the input's dependencies among the carried columns; one intersection per input fact is keyed by the
 *   input's carried key, differences and packs by the carried key and the produced span.
 *
 * Every node also states which of its columns are equal in every row, by its rule or carried from an input, each pair
 * with its witness, the step by which each determines the other: they join its classes, a labelled forest whose paths
 * are the derivations that two columns are equal. The keys are searched over the classes' representatives, each found
 * key's proof listing the other columns of its classes as its members, each by its path to the key column (ir/keys.ts).
 * So a node's minimal keys are its classes' keys, as many as the representatives have, never the product of every
 * choice of a column per class.
 */
export interface Props {
	/** The node the properties are of. */
	readonly node: RelNode
	/**
	 * The node as the analysis read it: each input replaced by that input's properties, so a walk down a dependency's
	 * rule (fixedNames) reads the input's properties themselves.
	 */
	readonly reading: PropsReading
	/**
	 * The attachment these are the properties relative to (relativeProps): its correlation fixes the node's correlated
	 * columns per parent row. Undefined for a node's own properties.
	 */
	readonly attachment: NodeOf<"Attach"> | undefined
	/**
	 * The columns of other nodes the node reads from outside it (ir/dag.ts nodeScopes), each one value per evaluation of
	 * the node: what a name an input gives one of its columns must name to name one of the node's values (nameAt).
	 */
	readonly outer: OuterRefs
	readonly columns: ReadonlyArray<string>
	/**
	 * The dependencies the node states over its attributes, its own and those it carries from its inputs, interned
	 * (logical/closure.ts Rows): its attributes are its heading's columns, then the attributes of its rows it does not
	 * deliver, its inputs' columns and hidden attributes it reads and does not name in its heading (ir/keys.ts
	 * hiddenAttribute). Its dependencies range over them beside its heading, so its inputs' dependencies are embedded
	 * whole, and whether some columns determine others is one closure.
	 */
	readonly stated: Rows
	/**
	 * Where each of its steps reads the value it fixes each of its targets to, by row and target (logical/closure.ts
	 * Naming): the data every named closure of the node reads, its closure of nothing and each parent's closure of a
	 * determinant of it, built once with its dependencies.
	 */
	readonly naming: Naming<Named>
	/**
	 * Its minimal keys over its classes of equal columns and its independent factors: for rows of one heading group one
	 * proof, whose key holds one minimal key of each factor over the classes' representatives and whose alternatives are
	 * each factor's other minimal keys (KeyProof alternatives), another column of a class standing for its
	 * representative (members); for rows of several, each key a proof of its own.
	 */
	readonly keys: ReadonlyArray<KeyProof>
	/**
	 * Each column's class of the columns equal to it in every row, each determining the others: in heading order, its
	 * first the class's representative, which a key states. The partition of `forest`.
	 */
	readonly classes: ReadonlyMap<string, NonEmptyReadonlyArray<string>>
	/**
	 * The classes as a labelled forest, each class a tree: every column but a root with the edge to its parent, the
	 * witness that each determines the other (Edge). Two columns are equal by the path between them (pathOf).
	 */
	readonly forest: ReadonlyMap<string, Edge>
	/** The proof that `columns` is a key, when the node's dependencies prove one. */
	readonly prove: (columns: ReadonlyArray<string>) => KeyProof | undefined
	/**
	 * The proof that the whole heading is a key of a node whose rows are of one heading group, a set of them; a node of
	 * several heading groups (`discriminant`) has none.
	 */
	readonly whole: () => WholeKey
	readonly card: Card
	/**
	 * The stored facts a column was read from: none for a column computed, aggregated, constant, ranked or bound by no
	 * scan, and none for a name outside the heading, which no stored fact of the node gives.
	 */
	readonly provenance: (column: string) => ReadonlyArray<Provenance>
	readonly context: EvidenceContext
	/**
	 * The discriminant of the heading groups this node's rows are of, when they are of several: a heterogeneous union,
	 * and every node that keeps a subset of its rows. Its heading is then only the columns common to every group, so two
	 * rows of one group may agree on all of them: the heading is no key, and a set of columns is one only when it
	 * determines a proved key. Empty for one heading group.
	 */
	readonly discriminant: ReadonlyArray<string>
	/**
	 * The columns fixed per evaluation, what nothing determines, in the order their closure reached them, each with every
	 * value a step fixes it to (fixedNames): one value wherever the node has a row, so each names it, whatever order the
	 * steps are stated in; none for a column only a computation fixes.
	 */
	readonly fixed: ReadonlyMap<string, ReadonlyArray<NamedValue>>
	/**
	 * What nothing determines at the node: the closure of the empty start, each column with the step that reached it and
	 * the value it was named by (closureOf). `fixed` is read off it, and a parent that closes the node's determinants
	 * reads the empty one's here rather than closing it again (reachedFrom).
	 */
	readonly nothing: Closure<Named>
}

/** A node as the logical analysis reads it: each input replaced by that input's properties. */
export type PropsReading = NodeOver<ValueRefs<Props>>

/** One kind of node as the logical analysis reads it. */
type ReadingOf<K extends RelNode["kind"]> = KindOver<K, ValueRefs<Props>>

/** The stored facts a column of the node was read from (Props.provenance). */
export const provenanceOf = (props: Props, column: string): ReadonlyArray<Provenance> =>
	props.provenance(column)

/** The provenance of a node: its rule read once for each column of its heading, none for any other name. */
const provenanceOver = (
	columns: ReadonlyArray<string>,
	of: (column: string) => ReadonlyArray<Provenance>
): ((column: string) => ReadonlyArray<Provenance>) => {
	const read = new Map(columns.map((c) => [c, of(c)]))
	return (column) => read.get(column) ?? []
}

/** The rule of a column read from no stored fact. */
const noProvenance = (): ReadonlyArray<Provenance> => []

export interface PropsEnv {
	/** The scope of a node (ir/dag.ts nodeScopes): the columns of other nodes a lateral source reads. */
	readonly scope: (node: RelNode) => NodeScope
	/** Whether a Base over a view is keyed by the keys stamped on it (ir/rel.ts ViewBase view); without them it states
	 * no key, and is keyed by its whole heading, as any set is. */
	readonly keyedViews: boolean
}

/**
 * The premise of a stored relation's declared key: the installed constraint the naming door names for it, its primary
 * key or a candidate key.
 */
export const storedKeyPremise = (relation: string, fields: KeySet, primary: boolean): Premise =>
	primary
		? {
				kind: "constraint",
				constraint: identifierOf(identity.primaryKey(relation)),
				constraintKind: "primaryKey"
			}
		: {
				kind: "constraint",
				constraint: identifierOf(identity.key(relation, fields)),
				constraintKind: "unique"
			}

/** The premise of a derived relation's inherited key: its view's unique index, which the naming door names. */
export const derivedKeyPremise = (relation: string, fields: KeySet): Premise => ({
	kind: "constraint",
	constraint: identifierOf(identity.derivedKey(relation, fields)),
	constraintKind: "uniqueIndex"
})

export const fixedEqual = (a: Fixed, b: Fixed): boolean => {
	switch (a.kind) {
		case "literal":
			return b.kind === "literal" && a.key === b.key
		case "param":
			return b.kind === "param" && a.param === b.param
		case "outer":
			return b.kind === "outer" && a.node === b.node && a.column === b.column
		case "expr":
			return false
	}
}

/**
 * What an expression is per evaluation of a node whose own rows' columns are those of `locals` (valueAt): fixed (a
 * literal, a parameter, an outer column, or a computation over those), or `local`, a function of the node's own rows,
 * which no evaluation fixes. Fixed itself is also what a fixed column holds (physical/props.ts FixedFact), where no
 * value is local, so the local arm is this union's alone.
 */
type ValueAt = Fixed | { readonly kind: "local" }

const local: ValueAt = Object.freeze({ kind: "local" })

/** What an expression is per evaluation of a node whose own rows' columns are those of `locals` (ValueAt). */
const valueAt = (e: ScalarExpr, locals: ReadonlySet<NodeId>): ValueAt => {
	if (e.deps.nodes.some((n) => locals.has(n))) {
		return local
	}
	switch (e.kind) {
		case "literal":
			return { kind: "literal", literal: e.value, key: nativeEqualityKey(e.value) }
		case "param":
			return { kind: "param", param: e.param }
		case "column":
			return { kind: "outer", node: e.column.node, column: e.column.name }
		case "value":
		case "op":
		case "cast":
		case "domainCast":
		case "cond":
		case "closedAt":
		case "closedRow":
		case "closedHas":
		case "call":
			return { kind: "expr" }
	}
}

/**
 * The input column an expression a Filter or a ProjectSet evaluates over its input copies: its compared value's column.
 * Such an expression reads its input alone, since outer values enter a node only through the scope expressions of a
 * region or a take (ir/dag.ts nodeScopes), so every column it names is one of its input's.
 */
const copiedColumn = (e: ScalarExpr): string | undefined => {
	const u = comparedValue(e)
	return u.kind === "column" ? u.column.name : undefined
}

/** The columns of `node` an expression reads, in first-visit order of its closure (expr.ts exprClosure). */
export const readColumns = (e: ScalarExpr, node: NodeId): ReadonlyArray<string> => {
	const out = new Set<string>()
	for (const at of exprClosure([e])) {
		if (at.kind === "column" && at.column.node === node) {
			out.add(at.column.name)
		}
	}
	return [...out]
}

interface NodeColumn {
	readonly node: NodeId
	readonly column: string
}

/** The column references an expression's closure makes to `locals`, in first-visit order (expr.ts exprClosure). */
const localRefs = (e: ScalarExpr, locals: ReadonlySet<NodeId>): ReadonlyArray<NodeColumn> => {
	const out: Array<NodeColumn> = []
	for (const at of exprClosure([e])) {
		if (at.kind === "column" && locals.has(at.column.node)) {
			out.push({ node: at.column.node, column: at.column.name })
		}
	}
	return out
}

/** The outer references among `refs` to `locals`. */
const refsTo = (refs: OuterRefs, locals: ReadonlySet<NodeId>): ReadonlyArray<NodeColumn> => {
	const out: Array<NodeColumn> = []
	for (const [node, columns] of refs) {
		appendAll(out, locals.has(node) ? [...columns].map((column) => ({ node, column })) : [])
	}
	return out
}

/**
 * The conjuncts of a predicate: the operands of its top-level `and`s, each distinct one once in the order it first
 * appears, or the predicate itself. A conjunction is the set of its conjuncts, so one an expression shares in several
 * places is one conjunct, and a predicate has no more conjuncts than distinct expressions. The operands wait on a heap
 * stack, pushed last to first so the first is popped first, so a conjunction nests to any depth.
 */
export const conjuncts = (e: ScalarExpr): ReadonlyArray<ScalarExpr> => {
	const out: Array<ScalarExpr> = []
	const seen = new Set<ScalarExpr>()
	const stack = [e]
	for (let x = stack.pop(); x !== undefined; x = stack.pop()) {
		if (seen.has(x)) {
			continue
		}
		seen.add(x)
		if (x.kind === "op" && nativeOp(x.op)?.fn === "and") {
			appendAll(stack, x.args.toReversed())
		} else {
			out.push(x)
		}
	}
	return out
}

/** The two operands of a binary native equality, or undefined when the expression is not one. */
const equalityOperands = (e: ScalarExpr): readonly [ScalarExpr, ScalarExpr] | undefined => {
	if (e.kind !== "op") {
		return undefined
	}
	const [x, y, ...more] = e.args
	return x !== undefined && y !== undefined && more.length === 0 && nativeOp(e.op)?.fn === "eq"
		? [x, y]
		: undefined
}

/** A node's columns and the dependencies it states over its attributes, which its closures read, with its reading
 * and attachment, which say what value each step fixes a column to. */
interface Table {
	readonly node: { readonly id: NodeId }
	readonly reading: PropsReading
	readonly attachment: NodeOf<"Attach"> | undefined
	readonly outer: OuterRefs
	readonly columns: ReadonlyArray<string>
	readonly stated: Rows
	/** Where each row's step reads the value it fixes each of its targets to, in the row's target order (sourcesOf). */
	readonly sources: StepSources
	readonly naming: Naming<Named>
}

/** What a node's steps are read against: its table but what they are read into (sourcesOf, namingOf). */
type Steps = Omit<Table, "naming" | "sources">

/** A node's attributes: its heading, then its hidden attributes. */
const attributesOf = (props: Pick<Table, "stated">): Attributes => props.stated.attributes

/** A value a fixed column holds that names it: a literal, a parameter or an outer column. */
type Named = Exclude<Fixed, { readonly kind: "expr" }>

/**
 * A name of the value a fixed column holds, with its derivation from nothing, whose first step to reach the column
 * names it, as the test kernel reads a derivation's value (test/support/keys/kernel.ts).
 */
export interface NamedValue {
	readonly name: Named
	readonly derivation: Implication
}

/** The name a value gives what it is: a literal, a parameter, an outer column; none for a computation, which names no
 * value, nor for a value of the node's own rows, which varies with them. */
const namedOf = (v: ValueAt): Named | undefined => {
	switch (v.kind) {
		case "literal":
		case "param":
		case "outer":
			return v
		case "expr":
		case "local":
			return undefined
	}
}

/**
 * What `start` determines at a node, under its dependencies, each column reached by a step naming its value where one
 * does: the derivation a rule stores, and a fixed column's value, are read off it, so they name the value wherever a
 * step names it.
 */
const closureOf = (props: Pick<Table, "stated" | "naming">, start: Bits): Closure<Named> =>
	closure(props.stated, start, props.naming)

/**
 * What `start` determines at a node, each column reached by the first step to fire: what a key determines, whose
 * derivation holds only the steps the key needs to determine the heading, whatever values they name.
 */
const coverOf = (props: Pick<Table, "stated">, start: Bits): Closure<never> =>
	closure<never>(props.stated, start, namesNothing)

/**
 * What `start` determines at a node a parent reads: for the empty start, the closure of nothing the node carries
 * (Props.nothing); for any other, its closure there (closureOf).
 */
const reachedFrom = (input: Props, start: Bits): Closure<Named> =>
	isEmpty(start) ? input.nothing : closureOf(input, start)

/** The positions of the attributes `names` names at a node, in their order: none for a name the node lacks. */
const positionsOf = (attributes: Attributes, names: Iterable<string>): ReadonlyArray<number> => {
	const out: Array<number> = []
	for (const n of names) {
		const p = attributes.at.get(n)
		if (p !== undefined) {
			out.push(p)
		}
	}
	return out
}

/** The columns of a node fixed per evaluation: what nothing determines. */
export const fixedColumns = (props: Props): ReadonlyArray<string> => [...props.fixed.keys()]

/** Every name of the value a fixed column holds per evaluation, undefined when the column is not fixed (Props.fixed). */
export const fixedNames = (props: Props, column: string): ReadonlyArray<NamedValue> | undefined =>
	props.fixed.get(column)

/**
 * A name an input gives one of its columns, read at the node `props` are of: a literal and a parameter name one value
 * wherever they are read, and an outer column names one per evaluation of the node only where the node reads it from
 * outside (Props.outer). A column the node binds, a region's occurrence source's or a semi-join's left input's, holds
 * one value per row of the node, so it names none of the node's values, as an expression reading it names none
 * (valueAt).
 */
const nameAt = (props: Pick<Table, "outer">, name: Named): Named | undefined =>
	name.kind !== "outer" || props.outer.get(name.node)?.has(name.column) === true ? name : undefined

/**
 * The value the closure of nothing of `input` names its fixed column by, the first of its names, which the derivations
 * a parent carries from that closure read, read at the parent `props` are of (nameAt); a computation where it has none
 * or where the parent binds what it names.
 */
const firstNameAt = (
	props: Pick<Table, "outer">,
	input: Props,
	column: string
): Named | undefined => {
	const first = input.fixed.get(column)?.[0]?.name
	return first === undefined ? undefined : nameAt(props, first)
}

/** The names `input` fixes its column to that name values of the node `props` are of (nameAt), in the input's order. */
const namesAt = (
	props: Pick<Table, "outer">,
	input: Props,
	column: string
): ReadonlyArray<NamedValue> =>
	(fixedNames(input, column) ?? []).filter((v) => nameAt(props, v.name) !== undefined)

/**
 * Each column the closure of nothing reaches, with every name a step fixes it to: first the one the closure reached it
 * by, then each further one a step gives it, until none adds a name. A step that carries an input's column carries each
 * name the input fixes it to, by a step like it over the input's derivation of that name; an equality carries each name
 * of its other column. So the names are every value the node's steps fix the column to, in any order of its steps.
 */
const fixedOver = (
	props: Table,
	reached: Closure<Named>
): ReadonlyMap<string, ReadonlyArray<NamedValue>> => new FixedNames(props, reached).names

/**
 * A name a step offers the column it fixes (`Fixing`): with the derivation steps before the step, those that reach its
 * determinants or, for a name an equality reads, the name's own, and the step that gives it.
 */
interface Offer {
	readonly name: Named
	readonly before: () => ReadonlyArray<Dependency>
	readonly step: () => Dependency
}

/**
 * A step of a node that fixes `column`, a column its closure of nothing reaches, as the names it offers the column
 * (`FixedNames`): its own value's, or each name of the column an equality reads, of the input column a rule carries, or
 * that a union's arms agree on, where it reads them worked out once (stepSource). An equality offers its column's
 * names as FixedNames gives them, a list that only grows; every other step's offers are fixed when it is made. Each
 * offer is made once (`fresh`): one made adds nothing when made again, its name held from then on or its derivation
 * reaching the column before its last step for good.
 */
class Fixing {
	readonly column: string
	/** The names `column` holds so far, which the step's offers are added to. */
	readonly held: Array<NamedValue>
	readonly #count: () => number
	readonly #at: (i: number) => Offer
	#made = 0

	constructor(
		column: string,
		held: Array<NamedValue>,
		count: () => number,
		at: (i: number) => Offer
	) {
		this.column = column
		this.held = held
		this.#count = count
		this.#at = at
	}

	/** The offers the step makes now, those it has not made, each made once from now on. */
	fresh(): ReadonlyArray<Offer> {
		const made = this.#made
		const count = this.#count()
		this.#made = count
		return Array.from({ length: count - made }, (_, k) => this.#at(made + k))
	}

	/** How many offers the step offers now. */
	get offered(): number {
		return this.#count()
	}
}

/** The step `row` of a node whose closure of nothing is `reached`, fixing `column`, as a Fixing. */
const fixingOf = (
	props: Table,
	reached: Closure<Named>,
	row: Row,
	column: string,
	held: Array<NamedValue>,
	namesOf: (column: string) => ReadonlyArray<NamedValue>,
	source: StepSource
): Fixing => {
	const d = row.dependency
	const determinants = () => derivation(reached, positions(row.from)).steps
	const listed = (offers: ReadonlyArray<Offer>): Fixing =>
		new Fixing(
			column,
			held,
			() => offers.length,
			(i) => defined(offers[i], "an offer the step counts")
		)
	switch (source.kind) {
		case "own":
			return listed(
				source.name === undefined
					? []
					: [{ name: source.name, before: determinants, step: () => d }]
			)
		case "column": {
			const names = namesOf(source.column)
			return new Fixing(
				column,
				held,
				() => names.length,
				(i) => {
					const v = defined(names[i], "a name the equality's column holds")
					return { name: v.name, before: () => v.derivation.steps, step: () => d }
				}
			)
		}
		case "input":
			return listed(
				namesAt(props, source.input, source.column).map((v) => ({
					name: v.name,
					before: determinants,
					step: () => source.over(v.derivation)
				}))
			)
		case "arms":
			return listed(
				commonNames(source.arms, column).map((v) => ({
					name: v.name,
					before: determinants,
					step: () => armsAgree(column, v.arms)
				}))
			)
	}
}

/**
 * The name `offer` gives the column `fixing` fixes beside the names it holds, with its derivation: the steps before the
 * step, then the step. None for a name the column holds, or whose derivation reaches the column before its last step,
 * which names it by that earlier step.
 */
const offeredName = (fixing: Fixing, offer: Offer): ReadonlyArray<NamedValue> => {
	if (fixing.held.some((h) => fixedEqual(h.name, offer.name))) {
		return []
	}
	const steps = offer.before()
	return steps.some((s) => s.to.includes(fixing.column))
		? []
		: [{ name: offer.name, derivation: implication([], [...steps, offer.step()]) }]
}

/**
 * The names of the fixed columns of the node `props` are of, worked out again from its properties (FixedNames), its steps'
 * sources with them: what a reader that holds the node's properties, not its table, reads the work of.
 */
export const fixedNamesOf = (props: Props): FixedNames =>
	new FixedNames({ ...props, sources: sourcesOf(props) }, props.nothing)

/**
 * The names of each column a node's closure of nothing `reached` reaches (fixedOver), worked out semi-naively: each
 * step that fixes a reached column from reached determinants is a Fixing, made once, its source worked out once; each
 * round makes every step's fresh offers, in the node's step order, its names added after the step's offers are read,
 * until a round adds none. A step's offers once made add nothing again, so the names are those every round re-reading
 * every step's every offer gave, in the same order, where each round worked out every step's source and made every
 * offer again.
 */
export class FixedNames {
	readonly names: ReadonlyMap<string, ReadonlyArray<NamedValue>>
	/** The rounds it ran, the last adding no name. */
	readonly rounds: number
	/** The offers it made, each once. */
	readonly made: number
	/** The offers its steps offer when it is done: as many as it made. */
	readonly offered: number

	constructor(props: Table, reached: Closure<Named>) {
		const names = new Map<string, Array<NamedValue>>()
		for (const p of reached.sequence) {
			const first = reached.named.get(p)
			names.set(
				attributeAt(props.stated.attributes, p),
				first === undefined ? [] : [{ name: first, derivation: derivation(reached, [p]) }]
			)
		}
		const namesOf = (c: string): ReadonlyArray<NamedValue> => names.get(c) ?? []
		const fixings = props.sources.flatMap(({ row, targets }) =>
			subsetOf(row.from, reached.reached)
				? targets.flatMap(({ column, source }) => {
						const held = names.get(column)
						return held === undefined
							? []
							: [fixingOf(props, reached, row, column, held, namesOf, source)]
					})
				: []
		)
		let made = 0
		let rounds = 0
		for (let changed = true; changed;) {
			changed = false
			rounds += 1
			for (const fixing of fixings) {
				const offers = fixing.fresh()
				made += offers.length
				const added = offers.flatMap((offer) => offeredName(fixing, offer))
				appendAll(fixing.held, added)
				changed = changed || added.length > 0
			}
		}
		this.names = names
		this.rounds = rounds
		this.made = made
		this.offered = fixings.reduce((n, fixing) => n + fixing.offered, 0)
	}
}

/**
 * What a step reads the value it fixes `column` to from: its own value, by the name it gives it (a literal, a
 * parameter, an outer column; none for a computation or a hidden attribute); another column of the node, an equality's; an input's column, whose value it carries, with the step
 * like it that carries the column alone over another derivation of the input; or a union's arms, which agree on it.
 */
type StepSource =
	| { readonly kind: "own"; readonly name: Named | undefined }
	| { readonly kind: "column"; readonly column: string }
	| {
			readonly kind: "input"
			readonly input: Props
			readonly column: string
			readonly over: (derivation: Implication) => Dependency
	  }
	| { readonly kind: "arms"; readonly arms: NonEmptyReadonlyArray<Props> }

/**
 * Each row of a node's table with where its step reads the value it fixes each of its targets to (sourcesOf): the
 * target's position and column, in the row's target order, rows in table order.
 */
type StepSources = ReadonlyArray<{
	readonly row: Row
	readonly targets: ReadonlyArray<{
		readonly at: number
		readonly column: string
		readonly source: StepSource
	}>
}>

/** A step's own value, by the name it gives it (namedOf). */
const own = (value: ValueAt): StepSource => ({ kind: "own", name: namedOf(value) })
/** A step's own value that names nothing: what a hidden attribute holds. */
const opaque: StepSource = { kind: "own", name: undefined }

/**
 * The input whose rows a node keeps, whose dependencies its `kept` rule carries (an intersection's right side's are its
 * `intersected` rule's); none for a node that keeps no input's rows.
 */
const keptInputOf = (reading: PropsReading): Props | undefined => {
	switch (reading.kind) {
		case "Filter":
		case "Take":
		case "Produce":
		case "OrderedResult":
		case "Window":
		case "Step":
			return reading.input
		case "SemiJoin":
		case "AntiJoin":
		case "Difference":
		case "Intersect":
			return reading.left
		case "ApproximateNearest":
			return reading.source
		case "Attach":
			return reading.parent
		case "Forbid":
			return reading.violation
		case "Base":
		case "Closed":
		case "Context":
		case "InputSet":
		case "Delta":
		case "MatchRegion":
		case "ProjectSet":
		case "Union":
		case "Group":
		case "Recursive":
		case "SelfRef":
		case "OrderedSetAggregate":
		case "Call":
			return undefined
	}
}

/** The input a carried rule's derivation is held at: the kept input's, an intersection's right side's, a group's input's. */
const carriedInputOf = (reading: PropsReading, rule: "kept" | "intersected" | "grouped"): Props => {
	switch (rule) {
		case "kept":
			return defined(keptInputOf(reading), "a kept rule's node keeps an input's rows")
		case "intersected":
			if (reading.kind !== "Intersect") {
				throw defect("an intersected rule is an intersection's")
			}
			return reading.right
		case "grouped":
			if (reading.kind !== "Group" && reading.kind !== "OrderedSetAggregate") {
				throw defect("a grouped rule is a group's")
			}
			return reading.input
	}
}

/** The constructor of each carried rule, which carries an input's derivation of one column again. */
const carriers = {
	kept: rowsKeep,
	intersected: rightKeeps,
	grouped: groupKeeps
} as const

/** Where step `d` reads the value it fixes `column` to at a node. */
const stepSource = (props: Steps, d: Dependency, column: string): StepSource => {
	const node = props.reading
	const rule = d.rule
	switch (rule.rule) {
		case "fixed": {
			const witness = rule.witness
			if (witness.kind !== "semiJoinPair") {
				return own(fixedWitnessValue(props, witness, column))
			}
			if (node.kind !== "SemiJoin") {
				throw defect("a semi-join pair fixes a column of its semi-join")
			}
			const pair = defined(
				node.on[witness.index],
				"a semi-join pair's index names one of its pairs"
			)
			return {
				kind: "input",
				input: node.right,
				column: pair.right,
				over: (right) => fixedColumn(column, { kind: "semiJoinPair", index: witness.index, right })
			}
		}
		case "correlated": {
			if (node.kind !== "MatchRegion") {
				throw defect("a correlated variable is a region's")
			}
			const corr = defined(
				node.correlated[rule.index],
				"a correlated rule's index names a correlated variable of its region"
			)
			return own(valueAt(corr.expr, regionLocals(props.node.id, node)))
		}
		case "equal":
			return {
				kind: "column",
				column: defined(d.from[0], "an equality's step is determined by its one column")
			}
		case "match": {
			if (node.kind !== "MatchRegion") {
				throw defect("a match binds a variable of its region")
			}
			const occurrence = defined(
				node.occurrences.find((o) => o.id === rule.occurrence),
				"a match rule's occurrence is one of its region's"
			)
			/** A hidden attribute of the occurrence is bound to no variable: what it holds is opaque. */
			const binding = occurrence.bindings.find((b) => b.var.name === column)
			if (binding === undefined) {
				return opaque
			}
			const constant = occurrence.constants.find((k) => k.column === binding.column)
			if (constant !== undefined) {
				return own(valueAt(constant.expr, regionLocals(props.node.id, node)))
			}
			return {
				kind: "input",
				input: occurrence.source,
				column: binding.column,
				over: (source) => matchBinds(d.from, [column], rule.occurrence, source)
			}
		}
		case "projection": {
			if (node.kind !== "ProjectSet") {
				throw defect("a projection's rule is a projection's")
			}
			/** A hidden attribute of the input is no output: what it holds is opaque. */
			const out = node.out.find((o) => o.name === column)
			if (out === undefined) {
				return opaque
			}
			const input = node.input.node.id
			const copied = copiedColumn(out.expr)
			return copied === undefined
				? own(valueAt(out.expr, new Set([input])))
				: {
						kind: "input",
						input: node.input,
						column: copied,
						over: (derived) => projectionCloses(d.from, [column], derived)
					}
		}
		case "kept":
		case "intersected":
		case "grouped": {
			const input = carriedInputOf(node, rule.rule)
			const carry = carriers[rule.rule]
			return { kind: "input", input, column, over: (derived) => carry(d.from, [column], derived) }
		}
		case "agreed":
			if (node.kind !== "Union") {
				throw defect("the arms that agree on a column are a union's")
			}
			return { kind: "arms", arms: unionArms(node.groups) }
		case "declared":
		case "viewAlternative":
		case "generated":
		case "group":
		case "atMostOne":
		case "distinct":
		case "produced":
		case "ranked":
		case "numbered":
		case "unionKey":
		case "separated":
			return opaque
	}
}

/**
 * The names every arm of a union fixes `column` to, in the first arm's order, each with every arm's derivation of it:
 * a shared name is one value in every arm, so the union's column holds it in every row.
 */
const commonNames = (
	arms: NonEmptyReadonlyArray<Props>,
	column: string
): ReadonlyArray<{ readonly name: Named; readonly arms: NonEmptyReadonlyArray<Implication> }> =>
	(fixedNames(arms[0], column) ?? []).flatMap((v) => {
		const derivations = everyArm(
			arms,
			(a) => fixedNames(a, column)?.find((x) => fixedEqual(x.name, v.name))?.derivation
		)
		return derivations === undefined ? [] : [{ name: v.name, arms: derivations }]
	})

/**
 * Where a step reads the name of the value it fixes `column` to at a node: a literal, a parameter or an outer column of
 * its own, or none for a computation. A rule that carries the column from an input reads the name its input's closure of
 * nothing gives it, read at the node (firstNameAt), as the derivation the rule carries does; a union's agreement reads
 * the first name its arms share, as its derivations do; an equality reads the name its other column holds when the
 * closure names one (a copy), none for a column the node lacks.
 */
const nameSourceOf = (props: Steps, source: StepSource, column: string): NameSource<Named> => {
	const value = (name: Named | undefined): NameSource<Named> =>
		name === undefined ? namesNone : { kind: "value", value: name }
	switch (source.kind) {
		case "own":
			return value(source.name)
		case "column": {
			const at = props.stated.attributes.at.get(source.column)
			return at === undefined ? namesNone : { kind: "copy", at }
		}
		case "input":
			return value(firstNameAt(props, source.input, source.column))
		case "arms":
			return value(commonNames(source.arms, column)[0]?.name)
	}
}

/** The naming of a node's steps (Props.naming): each row's source of the name it gives each target, in its order. */
const namingOf = (props: Steps, sources: StepSources): Naming<Named> =>
	namingOver(
		props.stated,
		sources.map(({ targets }) => targets.map((t) => nameSourceOf(props, t.source, t.column)))
	)

/**
 * Where each row of a node reads the value its step fixes each target to (stepSource), in the row's target order: worked
 * out once per node, here alone, and read by its naming (namingOf) and by the names of its fixed columns (FixedNames).
 */
const sourcesOf = (props: Steps): StepSources =>
	props.stated.rows.map((row) => ({
		row,
		targets: row.to.map((at) => {
			const column = attributeAt(props.stated.attributes, at)
			return { at, column, source: stepSource(props, row.dependency, column) }
		})
	}))

/**
 * The value a fixed column holds by the witness that fixed it at the node `props` are of, a witness of the node's own: a
 * semi-join's pair carries the right side's (stepSource).
 */
const fixedWitnessValue = (
	props: Steps,
	witness: Exclude<FixedWitness, { readonly kind: "semiJoinPair" }>,
	column: string
): ValueAt => {
	const node = props.reading
	switch (witness.kind) {
		case "conjunct": {
			if (node.kind !== "Filter") {
				throw defect("a conjunct fixes a column of its filter")
			}
			const input = node.input.node.id
			const conjunct = defined(
				conjuncts(node.pred).find((e) => e.id === witness.expr),
				"a conjunct witness names a conjunct of its filter"
			)
			const operands = defined(
				equalityOperands(conjunct),
				"a conjunct that fixes a column is an equality"
			)
			const other = defined(
				operands.find((o) => copiedColumn(o) !== column),
				"an equality that fixes a column has an operand other than the column"
			)
			return valueAt(other, new Set([input]))
		}
		case "closedValue": {
			if (node.kind !== "Closed") {
				throw defect("a closed value fixes a column of its closed relation")
			}
			const row = defined(node.rows[0], "a column every fact agrees on has a fact")
			const literal = defined(
				row[node.heading.findIndex((h) => h.name === column)],
				"a closed value's column is a column of its relation"
			)
			return { kind: "literal", literal, key: nativeEqualityKey(literal) }
		}
		case "takeCorrelation": {
			if (node.kind !== "Take") {
				throw defect("a take's correlation fixes a column of its take")
			}
			const corr = defined(
				node.correlation[witness.index],
				"a take correlation's index names one of its take's"
			)
			return valueAt(corr.expr, new Set([node.input.node.id]))
		}
		case "attachCorrelation": {
			const attach = props.attachment
			if (attach?.id !== witness.attach) {
				throw defect("an attachment's correlation fixes a column of the child it relates")
			}
			const pair = defined(
				attach.correlation[witness.index],
				"an attachment correlation's index names one of its pairs"
			)
			return { kind: "outer", node: attach.parent.id, column: pair.parent }
		}
	}
}

/** The nodes a region's own expressions read: its heading and its occurrences' sources. */
const regionLocals = (region: NodeId, reading: ReadingOf<"MatchRegion">): ReadonlySet<NodeId> =>
	new Set<NodeId>([region, ...reading.occurrences.map((o) => o.source.node.id)])

/** A determinant a parent may carry from a node: its columns as the node states them, and as a set of its attributes. */
interface Determinant {
	readonly columns: KeySet
	readonly at: Bits
}

/**
 * The determinants a parent may carry from a node: nothing (its fixed columns), each dependency's, and each key, each set
 * of attributes once.
 */
const determinantsOf = (props: Props): ReadonlyArray<Determinant> => {
	const attributes = attributesOf(props)
	const out: Array<Determinant> = []
	const add = (columns: KeySet, at: Bits): void => {
		if (!out.some((d) => sameBits(d.at, at))) {
			out.push({ columns, at })
		}
	}
	add([], noBits(attributes))
	for (const row of props.stated.rows) {
		add(row.dependency.from, row.from)
	}
	for (const k of props.keys) {
		add(k.key, bitsOf(attributes, k.key))
		for (const f of k.factors) {
			for (const a of f.alternatives) {
				add(a.determines.from, bitsOf(attributes, a.determines.from))
			}
		}
	}
	return out
}

/**
 * The columns of a node's heading equal to `column` in every row, in heading order: those whose tree of the labelled
 * forest has its root (Props.forest). A column of the heading is one of them; a name outside it is equal to none.
 */
const classOf = (
	props: Pick<Props, "columns" | "forest">,
	column: string
): ReadonlyArray<string> => {
	const root = rootIn(props.forest, column)
	return props.columns.filter((m) => rootIn(props.forest, m) === root)
}

/**
 * How two columns of a node are known equal in every row: by equalities alone, each step an equal dependency, a
 * projection's copies of input columns equal so, a kept input's columns equal so, or a group's keys of input columns
 * equal so, every group's key values being one input row's, which a union reads in every arm (ir/keys.ts); or by
 * determination, a match's variables bound to one source class, a correlated variable copying another.
 */
type EqualBy = "equalities" | "determination"

/**
 * That two columns of a node are equal in every row, by one step each way at the node: `there` derives `b` from `a`, and
 * `back` `a` from `b`.
 */
interface Equality {
	readonly a: string
	readonly b: string
	readonly by: EqualBy
	readonly there: Dependency
	readonly back: Dependency
}

/** Two columns equal by an equal dependency each way, which the node states. */
const statedEquality = (a: string, b: string, witness: EqualWitness): Equality => ({
	a,
	b,
	by: "equalities",
	there: equalColumns(a, b, witness),
	back: equalColumns(b, a, witness)
})

/** A column's edge to its parent in its class's tree: the column determines its parent by `up`, the parent it by `down`. */
export interface Edge {
	readonly parent: string
	readonly by: EqualBy
	readonly up: Dependency
	readonly down: Dependency
}

/**
 * The derivation at a node that one column equals another in every row, along the path between them in their class's
 * tree: by equalities alone when every edge on it is, by determination otherwise.
 */
interface EqualPath {
	readonly by: EqualBy
	readonly derivation: Implication
}

/** A column's edges up to its class's root, each with the column below it. */
const climb = (
	forest: ReadonlyMap<string, Edge>,
	column: string
): ReadonlyArray<readonly [string, Edge]> => {
	const out: Array<readonly [string, Edge]> = []
	let at = column
	let edge = forest.get(at)
	while (edge !== undefined) {
		out.push([at, edge])
		at = edge.parent
		edge = forest.get(at)
	}
	return out
}

/** The root of a column's class's tree. */
const rootIn = (forest: ReadonlyMap<string, Edge>, column: string): string => {
	let at = column
	for (let edge = forest.get(at); edge !== undefined; edge = forest.get(at)) {
		at = edge.parent
	}
	return at
}

/**
 * The path from `a` to `b` at a node (Props.forest): up from `a` to the lowest column it shares with `b`'s way up, then
 * down to `b`. Undefined when they are of different classes.
 */
const pathOf = (props: Pick<Props, "forest">, a: string, b: string): EqualPath | undefined => {
	const upA = climb(props.forest, a)
	const upB = climb(props.forest, b)
	const above = (start: string, edges: ReadonlyArray<readonly [string, Edge]>) => [
		start,
		...edges.map(([, e]) => e.parent)
	]
	const fromA = above(a, upA)
	const fromB = above(b, upB)
	const meet = fromA.find((c) => fromB.includes(c))
	if (meet === undefined) {
		return undefined
	}
	const edges = [
		...upA.slice(0, fromA.indexOf(meet)).map(([, e]) => ({ by: e.by, step: e.up })),
		...upB
			.slice(0, fromB.indexOf(meet))
			.toReversed()
			.map(([, e]) => ({ by: e.by, step: e.down }))
	]
	return {
		by: edges.every((e) => e.by === "equalities") ? "equalities" : "determination",
		derivation: implication(
			[a],
			edges.map((e) => e.step)
		)
	}
}

/** The derivation that `b` equals `a` in every row of a node by equalities alone, when its forest joins them so. */
const equalPath = (props: Props, a: string, b: string): Implication | undefined => {
	const path = pathOf(props, a, b)
	return path?.by === "equalities" ? path.derivation : undefined
}

/** A column equal to itself, by no step. */
const sameColumn = (column: string): EqualPath => ({
	by: "equalities",
	derivation: implication([column], [])
})

/**
 * The equalities a node carries from an input's classes among the input columns `kept` keeps under their own names:
 * every two kept columns of one input class, by the input's path between them, which `step` carries to the node, by
 * equalities when the path is and `carriedBy` keeps that.
 */
const inputEqualities = (
	input: Props,
	kept: (column: string) => boolean,
	step: (from: string, to: string, path: Implication) => Dependency,
	carriedBy: (path: EqualBy) => EqualBy
): ReadonlyArray<Equality> => {
	const out: Array<Equality> = []
	for (const [column, members] of input.classes) {
		const held = members[0] === column ? members.filter(kept) : []
		for (const [i, a] of held.entries()) {
			for (const b of held.slice(i + 1)) {
				const there = pathOf(input, a, b)
				const back = pathOf(input, b, a)
				if (there !== undefined && back !== undefined) {
					out.push({
						a,
						b,
						by: carriedBy(there.by),
						there: step(a, b, there.derivation),
						back: step(b, a, back.derivation)
					})
				}
			}
		}
	}
	return out
}

/** The equalities of an input whose rows a node keeps, among the columns it keeps under their own names. */
const keptEqualities = (input: Props, kept: (column: string) => boolean): ReadonlyArray<Equality> =>
	inputEqualities(
		input,
		kept,
		(from, to, path) => rowsKeep([from], [to], path),
		(by) => by
	)

/**
 * The dependencies a node keeps from an input whose rows it keeps, or whose rows determine its own: each input
 * determinant, over the input's attributes, determining the rest of its closure in the input, every attribute under
 * the name `nameOf` gives it at the node (its own, a column the node delivers it as, or a hidden attribute's), by
 * `rule`. No input attribute is dropped, so the node's closure of any of them is the input's.
 */
const carried = (
	input: Props,
	nameOf: (attribute: string) => string,
	rule: (from: KeySet, to: KeySet, input: Implication) => Dependency
): ReadonlyArray<Dependency> =>
	determinantsOf(input).flatMap((d) => {
		const reached = reachedFrom(input, d.at)
		const to = stepsOf(reached)
		return to.length === 0
			? []
			: [
					rule(
						d.columns.map(nameOf),
						to.map((p) => nameOf(attributeAt(input.stated.attributes, p))),
						derivation(reached, to)
					)
				]
	})

/** The name every attribute of an input keeps at a node keeping its rows under the input's own names. */
const sameName = (attribute: string): string => attribute

/**
 * The name a node that delivers some of its input's columns under their names gives each input attribute: a delivered
 * column its own, any other column a hidden attribute of the input's label, a hidden attribute its own.
 */
const hiddenUnless =
	(input: Props, delivered: (column: string) => boolean) =>
	(attribute: string): string =>
		delivered(attribute) || isHidden(attribute)
			? attribute
			: hiddenAttribute(input.node.id, attribute)

/** The hidden attributes of a node naming its input's attributes by `nameOf`: those it does not deliver. */
const hiddenOf = (input: Props, nameOf: (attribute: string) => string): ReadonlyArray<string> =>
	attributesOf(input)
		.names.map(nameOf)
		.filter((a) => isHidden(a))

/** What a node's own rule says beyond its dependencies. */
interface Rest {
	/** Exactly one row, when the node's input is one and its rule keeps it: a closed fact, a group over one row. */
	readonly exactlyOne: boolean
	readonly provenance: (column: string) => ReadonlyArray<Provenance>
	readonly context: EvidenceContext
	readonly discriminant: ReadonlyArray<string>
	/**
	 * The keys the node's rows of several heading groups are told apart by (a kept input's): none for one heading group,
	 * whose rows are distinct tuples of its heading.
	 */
	readonly inner: ReadonlyArray<KeyProof>
	/**
	 * The node's columns equal in every row, each pair with its witness: those its own equal dependencies state, and those
	 * equal by an input's classes or by copying columns of one.
	 */
	readonly equal: ReadonlyArray<Equality>
	/**
	 * Its attributes interned (logical/attributes.ts): its heading's columns, then the attributes of its rows it does not
	 * deliver (Props.stated).
	 */
	readonly attributes: Attributes
}

/**
 * The labelled forest of a node's classes: each equality of two of its columns joins their trees, the column `b` re-rooted
 * below `a` by the equality's steps. The equalities by equalities alone join first, so two columns they join are joined by
 * a path of them (pathOf), as a union's equal columns read in every arm.
 */
const forestOf = (
	columns: ReadonlyArray<string>,
	equal: ReadonlyArray<Equality>
): ReadonlyMap<string, Edge> => {
	const heading = new Set(columns)
	const forest = new Map<string, Edge>()
	/** Re-roots a column's tree at it: each edge on its way up reversed. */
	const evert = (column: string): void => {
		let below = column
		let edge = forest.get(column)
		forest.delete(column)
		while (edge !== undefined) {
			const next = forest.get(edge.parent)
			forest.set(edge.parent, { parent: below, by: edge.by, up: edge.down, down: edge.up })
			below = edge.parent
			edge = next
		}
	}
	for (const e of [
		...equal.filter((x) => x.by === "equalities"),
		...equal.filter((x) => x.by === "determination")
	]) {
		if (heading.has(e.a) && heading.has(e.b) && rootIn(forest, e.a) !== rootIn(forest, e.b)) {
			evert(e.b)
			forest.set(e.b, { parent: e.a, by: e.by, up: e.back, down: e.there })
		}
	}
	return forest
}

/** A forest's classes: each in heading order, its first column its representative, every column of the heading in one. */
const classesIn = (
	columns: ReadonlyArray<string>,
	forest: ReadonlyMap<string, Edge>
): ReadonlyMap<string, NonEmptyReadonlyArray<string>> => {
	const byRoot = new Map<string, [string, ...Array<string>]>()
	const out = new Map<string, NonEmptyReadonlyArray<string>>()
	for (const c of columns) {
		const root = rootIn(forest, c)
		const members = byRoot.get(root)
		if (members === undefined) {
			const started: [string, ...Array<string>] = [c]
			byRoot.set(root, started)
			out.set(c, started)
		} else {
			members.push(c)
			out.set(c, members)
		}
	}
	return out
}

/** Whether the whole heading is a key: proved for rows of one heading group, never for rows of several. */
export type WholeKey =
	| { readonly kind: "set"; readonly key: KeyProof }
	| { readonly kind: "groups" }

/** What the closure of a key reaches: the whole heading, or a kept input's key for rows of several heading groups. */
type Reach =
	| { readonly kind: "rows"; readonly reached: Closure<never> }
	| { readonly kind: "within"; readonly reached: Closure<never>; readonly inner: KeyProof }

/** What a node's properties are of: the node, its reading, and the attachment they are relative to, if any. */
type Subject = Pick<Props, "node" | "reading" | "attachment" | "outer">

/**
 * The props of `node` stating `dependencies`, its keys derived from them.
 *
 * The keys are searched over the classes' representatives (classesIn): a minimal key holds at most one column of a
 * class, and another column of the class in its place gives another, so the representatives' minimal keys under the
 * dependencies, each read through the classes, are every minimal key, one per class key. k pairs of equal columns
 * over a key of their first columns give one key, where every choice of a column per pair would give 2^k.
 *
 * Rows of one heading group have one proof over the factors of their dependencies (closure.ts independentFactors),
 * read over the attributes the whole heading determines, hidden ones included, since an attribute no key reaches
 * determines nothing a key needs: each factor's minimal keys over its representatives, given the key columns of the
 * factors before it, a set of them a key of the factor when its closure with those holds every attribute of the factor.
 * The first of each is the factor's key in the proof's key and the others are its alternatives, each derived with the
 * earlier factors' key columns its derivation reads, so k independent relations of two keys each are one proof of k
 * factors of one alternative each, never 2^k proofs, however many projections, joins and views a parent closes their
 * key over: a dependency a parent closes over the product of the factors' keys determines what each factor's own
 * dependencies reach, and joins no two of them.
 *
 * A factor's columns that determine one another, given the key columns of the factors before it, are a class of its
 * own (determinationClasses): each in the other's closure, as a reference's key, path and document copied at each place
 * it is typed are, never equal but each the others' image. A minimal key holds at most one column of a class, and
 * another of it in its place gives another. A class no other columns of the factor determine is in every key of it, so
 * it is a factor of its own, given the factors before: its first column its key and each other column alone an
 * alternative, and the rest of the factor is searched given that column as well. k such classes of s columns each over
 * a key of their first columns are k factors of s - 1 alternatives each, found with k·s closures, where the factor
 * searched whole had s^k minimal keys and found each one. The keys stated are the same: each class's choices times the
 * rest's keys, the first of them each class's first column with the rest's first key, the whole search's first key.
 */
/**
 * The keys of a constant relation's rows: every minimal set of its columns, by index in ascending order, whose value
 * tuples no two of its `rows` rows share, each value read by equality. A closed relation is keyed by every set its rows
 * key, its declared key among them (no two of its facts share it), and by no other. The sets are searched smaller
 * first, each a set no key found holds extended by a column after its last, so every set is read once and none that
 * holds a key; a set is a key when the tuples of its columns' codes, each value numbered within its column, are
 * distinct, read row by row until one repeats.
 */
const rowKeys = (
	columns: ReadonlyArray<ReadonlyArray<EqualityKey>>,
	rows: number
): ReadonlyArray<NonEmptyReadonlyArray<number>> => {
	const codes = columns.map((values) => {
		const numbered = new Map<EqualityKey, number>()
		return values.map((value) => {
			const known = numbered.get(value)
			if (known !== undefined) {
				return known
			}
			numbered.set(value, numbered.size)
			return numbered.size - 1
		})
	})
	const keys: Array<NonEmptyReadonlyArray<number>> = []
	const holdsKey = (set: ReadonlyArray<number>): boolean =>
		keys.some((key) => key.every((i) => set.includes(i)))
	const keyed = (set: ReadonlyArray<number>): boolean => {
		const seen = new Set<string>()
		for (let row = 0; row < rows; row++) {
			const tuple = set.map((i) => defined(codes[i]?.[row], "a row's code")).join(",")
			if (seen.has(tuple)) {
				return false
			}
			seen.add(tuple)
		}
		return true
	}
	let level: ReadonlyArray<NonEmptyReadonlyArray<number>> = columns.map((_, i) => [i] as const)
	while (level.length > 0) {
		const open: Array<NonEmptyReadonlyArray<number>> = []
		for (const set of level) {
			if (holdsKey(set)) {
				continue
			}
			if (keyed(set)) {
				keys.push(set)
			} else {
				open.push(set)
			}
		}
		level = open.flatMap((set) =>
			columns.flatMap((_, j): ReadonlyArray<NonEmptyReadonlyArray<number>> =>
				j > lastNonEmpty(set) ? [[...set, j]] : []
			)
		)
	}
	return keys
}

const finish = (subject: Subject, dependencies: ReadonlyArray<Dependency>, rest: Rest): Props => {
	const { node } = subject
	const columns = node.heading.map((c) => c.name)
	const { attributes } = rest
	const heading = attributes.heading
	const steps: Steps = {
		node,
		reading: subject.reading,
		attachment: subject.attachment,
		outer: subject.outer,
		columns,
		stated: rowsOf(attributes, dependencies)
	}
	const sources = sourcesOf(steps)
	const table: Table = { ...steps, sources, naming: namingOf(steps, sources) }
	const forest = forestOf(columns, rest.equal)
	const classes = classesIn(columns, forest)
	/**
	 * Each other column of the classes of `cs`, in heading order, with its path to the column it stands for. A hidden
	 * attribute is of no class.
	 */
	const membersOf = (cs: ReadonlyArray<string>): ReadonlyArray<KeyMember> => {
		const held = new Set(cs)
		return cs.flatMap((k) =>
			(classes.get(k) ?? []).flatMap((m) => {
				const path = held.has(m) ? undefined : pathOf({ forest }, m, k)
				return path === undefined ? [] : [keyMember(k, m, path.derivation)]
			})
		)
	}
	/**
	 * The closure of `key` and the key it reaches: the whole heading, or the first kept input's key it covers for rows
	 * of several heading groups; undefined where it reaches none.
	 */
	const reachOf = (key: Bits): Reach | undefined => {
		const reached = coverOf(table, key)
		if (rest.discriminant.length === 0) {
			return covers(reached, heading) ? { kind: "rows", reached } : undefined
		}
		const inner = rest.inner.find((k) => k.key.every((c) => reaches(reached, c)))
		return inner === undefined ? undefined : { kind: "within", reached, inner }
	}
	/** The proof of `key` from the key its closure reaches. */
	const proofOf = (key: KeySet, reach: Reach): KeyProof =>
		reach.kind === "rows"
			? rowsKey(
					key,
					derivation(reach.reached, attributes.headingAt),
					membersOf(key),
					soleFactor(key)
				)
			: keyWithin(
					key,
					derivation(reach.reached, positionsOf(attributes, reach.inner.key)),
					reach.inner,
					membersOf(key)
				)
	const prove = (cs: ReadonlyArray<string>): KeyProof | undefined => {
		const key = intersect(bitsOf(attributes, cs), heading)
		const reach = reachOf(key)
		return reach === undefined ? undefined : proofOf(attributeNames(attributes, key), reach)
	}
	/** The closure of the whole heading reaches every column of it. */
	const whole = (): WholeKey =>
		rest.discriminant.length === 0
			? { kind: "set", key: proofOf(columns, { kind: "rows", reached: coverOf(table, heading) }) }
			: { kind: "groups" }
	/** Each attribute's class's representative, its first column, by position; a hidden attribute stands for itself. */
	const representativeAt = attributes.names.map((c, p) => {
		const members = classes.get(c)
		return members === undefined
			? p
			: defined(attributes.at.get(members[0]), "a class's first column is a column")
	})
	const representatives = bitsAt(
		attributes,
		representativeAt.filter((r, p) => r === p && holdsAt(heading, p))
	)
	/** The representatives of the classes of the attributes at `ps`, each once, in the order first met. */
	const represented = (ps: Iterable<number>): Array<number> => {
		const out: Array<number> = []
		for (const p of ps) {
			const r = defined(representativeAt[p], "a position is one of the node's attributes")
			if (!out.includes(r)) {
				out.push(r)
			}
		}
		return out
	}
	/** Each dependency's determinants and targets by their classes' representatives, its targets in its order. */
	const exchange = table.stated.rows.map((row) => {
		const to = represented(row.to)
		return {
			row,
			from: bitsAt(attributes, represented(positions(row.from))),
			to,
			toBits: bitsAt(attributes, to)
		}
	})
	/** The keys of rows of several heading groups: each kept input's key minimized and exchanged, one proof each. */
	const withinKeys = (): ReadonlyArray<KeyProof> =>
		minimalKeys(
			representatives,
			rest.inner.map((k) => bitsAt(attributes, represented(positionsOf(attributes, k.key)))),
			(cs) => reachOf(intersect(cs, heading)),
			exchange.map((e) => ({ from: e.from, to: e.toBits }))
		).map(({ key, witness }) => proofOf(attributeNames(attributes, key), witness))
	/** The one proof of the minimal keys of rows of one heading group, over its independent factors. */
	const productKey = (): KeyProof => {
		const reachable = coverOf(table, heading).reached
		const stated = exchange.flatMap((e) =>
			subsetOf(e.row.from, reachable)
				? [
						{
							row: e.row,
							from: e.from,
							to: e.to.filter((c) => holdsAt(reachable, c) && !holdsAt(e.from, c))
						}
					]
				: []
		)
		const factors = independentFactors(
			union(representatives, intersect(reachable, bitsOf(attributes, attributes.hidden))),
			stated
		)
		const deps = rowsAmong(
			table.stated,
			stated.map((x) => x.row)
		)
		/** What `cs` determine with the key columns `given` of the factors before theirs. */
		const closes = (cs: Bits, given: Bits): Closure<never> =>
			closure(deps, union(cs, given), namesNothing)
		/**
		 * The classes of a factor's delivered columns `delivered` that determine one another given the key columns
		 * `before` of the factors before it, each in heading order, of two columns or more: p and q are one class when
		 * each is in the other's closure with those. One closure per column, none for a factor of one column.
		 */
		const determinationClasses = (
			delivered: Bits,
			before: Bits
		): ReadonlyArray<NonEmptyReadonlyArray<number>> => {
			const at = positions(delivered)
			if (at.length < 2) {
				return []
			}
			const reached = at.map((p) => ({
				p,
				reached: closes(bitsAt(attributes, [p]), before).reached
			}))
			const grouped: Array<[(typeof reached)[number], ...Array<(typeof reached)[number]>]> = []
			for (const column of reached) {
				const into = grouped.find(
					([first]) => holdsAt(column.reached, first.p) && holdsAt(first.reached, column.p)
				)
				if (into === undefined) {
					grouped.push([column])
				} else {
					into.push(column)
				}
			}
			return grouped.flatMap((members) =>
				members.length > 1 ? [mapNonEmpty(members, (m) => m.p)] : []
			)
		}
		/**
		 * Another minimal key of a factor, with its derivation of every attribute of the factor from it and the key columns
		 * `before` of the factors before it that the derivation reads: none for a factor no dependency of an earlier one
		 * reaches. So a parent closing over it reaches what the factor's key does.
		 */
		const alternativeOf = (other: Bits, factor: Bits, before: Bits): KeyAlternative => {
			const read = noBits(attributes)
			for (const row of derivationRows(closes(other, before), positions(factor))) {
				orInto(read, row.from)
			}
			return keyAlternative(
				attributeNames(attributes, other),
				derivation(closes(other, intersect(before, read)), positions(factor))
			)
		}
		/**
		 * The minimal keys among `among`, columns of a factor, given `before`: its keys over those columns, the first its key in
		 * the proof's key.
		 */
		const keysAmong = (among: Bits, factor: Bits, before: Bits): ReadonlyArray<Bits> =>
			minimalKeys(
				among,
				[among],
				(cs) => (covers(closes(cs, before), factor) ? true : undefined),
				stated.flatMap((x) => {
					const to = x.to.filter((c) => holdsAt(factor, c))
					return to.length === 0 ? [] : [{ from: x.from, to: bitsAt(attributes, to) }]
				})
			).map((k) => k.key)
		const chosen = noBits(attributes)
		const found: Array<KeyFactor> = []
		/** A factor's keys `keys` among its columns, given `before`: the first chosen, the others its alternatives. */
		const choose = (
			keys: ReadonlyArray<Bits>,
			fallback: Bits,
			factor: Bits,
			before: Bits
		): void => {
			const [first, ...others] = keys
			/** Every factor's delivered columns determine it, so its search finds a key: the first, or those columns. */
			const key = first ?? fallback
			orInto(chosen, key)
			const named = attributeNames(attributes, key)
			if (isNonEmpty(named)) {
				found.push(
					keyFactor(
						named,
						others.map((other) => alternativeOf(other, factor, before))
					)
				)
			}
		}
		for (const factor of factors) {
			const before = copyBits(chosen)
			const delivered = intersect(factor, heading)
			const remaining = copyBits(delivered)
			const given = copyBits(before)
			for (const members of determinationClasses(delivered, before)) {
				const others = copyBits(delivered)
				for (const m of members) {
					dropFrom(others, m)
				}
				if (!holdsAt(closes(others, before).reached, members[0])) {
					const ofClass = bitsAt(attributes, members)
					choose(
						members.map((m) => bitsAt(attributes, [m])),
						ofClass,
						ofClass,
						before
					)
					for (const m of members) {
						dropFrom(remaining, m)
					}
					addTo(given, members[0])
				}
			}
			choose(keysAmong(remaining, factor, given), remaining, factor, given)
		}
		const key = attributeNames(attributes, intersect(chosen, heading))
		return rowsKey(
			key,
			derivation(coverOf(table, intersect(chosen, heading)), attributes.headingAt),
			membersOf([...key, ...found.flatMap((f) => f.alternatives.flatMap((a) => a.columns))]),
			found
		)
	}
	const keys = rest.discriminant.length === 0 ? [productKey()] : withinKeys()
	const atMostOne = keys.some((k) => k.key.length === 0)
	const nothing = closureOf(table, noBits(attributes))
	return {
		...table,
		node,
		reading: subject.reading,
		attachment: subject.attachment,
		keys,
		classes,
		forest,
		prove,
		whole,
		card: atMostOne ? (rest.exactlyOne ? "one" : "atMostOne") : "many",
		provenance: provenanceOver(columns, rest.provenance),
		context: rest.context,
		discriminant: rest.discriminant,
		fixed: fixedOver(table, nothing),
		nothing
	}
}

/** The kept input's keys a node of several heading groups is told apart by, as its own rows are a subset of them. */
const innerOf = (input: Props): ReadonlyArray<KeyProof> =>
	input.discriminant.length === 0 ? [] : input.keys

const keptRest = (
	node: { readonly heading: Heading },
	input: Props,
	context: EvidenceContext
): Rest => ({
	exactlyOne: false,
	provenance: (c) =>
		node.heading.some((h) => h.name === c) && input.columns.includes(c)
			? provenanceOf(input, c)
			: [],
	context,
	discriminant: input.discriminant,
	inner: innerOf(input),
	equal: keptEqualities(input, (c) => node.heading.some((h) => h.name === c)),
	attributes: attributesOver(
		node.heading.map((h) => h.name),
		input.stated.attributes.hidden
	)
})

/** Dependencies a node states, and the equalities among them. */
interface Stated {
	readonly dependencies: ReadonlyArray<Dependency>
	readonly equal: ReadonlyArray<Equality>
}

/** A Filter's own dependencies: its predicate's equalities and false conjuncts. */
const filterDependencies = (node: ReadingOf<"Filter">): Stated => {
	const out: Array<Dependency> = []
	const equal: Array<Equality> = []
	const input = node.input.node.id
	const locals = new Set([input])
	const heading = node.heading.map((c) => c.name)
	for (const e of conjuncts(node.pred)) {
		const c = e.id
		if (e.kind === "literal" && e.value.kind === "bool" && !e.value.value) {
			out.push(atMostOneRow(heading, { kind: "falseConjunct", expr: c }))
		}
		const operands = equalityOperands(e)
		if (operands === undefined) {
			continue
		}
		const [x, y] = operands
		const cx = copiedColumn(x)
		const cy = copiedColumn(y)
		if (cx !== undefined && cy !== undefined) {
			if (cx !== cy) {
				const stated = statedEquality(cx, cy, { kind: "conjunct", expr: c })
				out.push(stated.there, stated.back)
				equal.push(stated)
			}
			continue
		}
		if (cx !== undefined && valueAt(y, locals).kind !== "local") {
			out.push(fixedColumn(cx, { kind: "conjunct", expr: c }))
		}
		if (cy !== undefined && valueAt(x, locals).kind !== "local") {
			out.push(fixedColumn(cy, { kind: "conjunct", expr: c }))
		}
	}
	return { dependencies: out, equal }
}

/**
 * A view's dependencies: each of its keys determines the row, each alternative of a key's factor determines the fields
 * it stands for, and each member of a key's class and the key column it stands for determine each other, both columns
 * of the view's heading.
 */
const viewDependencies = (keys: ReadonlyArray<ViewKey>, all: KeySet): Stated => {
	const out: Array<Dependency> = [
		...keys.map((k) => declaredKey(k.fields, all, k.premises, k.context)),
		...keys.flatMap((k) =>
			k.alternatives.flatMap((a) =>
				[...a.of, ...a.columns, ...a.given].every((c) => all.includes(c)) ? viewAlternative(a) : []
			)
		)
	]
	const equal: Array<Equality> = []
	for (const m of keys.flatMap((k) => k.members)) {
		if (
			!all.includes(m.of) ||
			!all.includes(m.column) ||
			equal.some((e) => e.a === m.column && e.b === m.of)
		) {
			continue
		}
		const stated = statedEquality(m.column, m.of, { kind: "viewMember" })
		out.push(stated.there, stated.back)
		equal.push(stated)
	}
	return { dependencies: out, equal }
}

/**
 * The properties of every leaf of one reading of a relation, a Base's or a Delta's, by the schema's own object its
 * reading is anchored at and its text (leafProps): computed once, where the first node of the reading is analyzed, and
 * read by every other, of any query, the schema's lifetime long.
 */
const leaves = new WeakMap<object, Map<string, Props>>()

/** The text of a key list, each key's columns in its order. */
const keysText = (keys: ReadonlyArray<KeySet>): string =>
	keys.map((k) => k.join("\u0001")).join("\u0002")

/**
 * What a Base's properties are a function of, beside its anchor (its relation's declared key, or its view's keys): its
 * relation, the kind of it, its heading's columns, the keys it is read by, a stored relation's generated fields with
 * what each reads, and whether the view's own keys are admitted.
 */
const baseText = (reading: ReadingOf<"Base">, env: PropsEnv): string =>
	[
		reading.relation,
		reading.relationKind,
		reading.heading.map((c) => c.name).join("\u0001"),
		keysText([reading.primaryKey, ...reading.keys]),
		reading.relationKind === "relation"
			? keysText(reading.generated.map((g) => [g.field, ...g.reads]))
			: env.keyedViews
				? "viewed"
				: "unviewed"
	].join("\u0000")

/** What a Delta's properties are a function of, beside its anchor (its keys): its relation, heading and keys. */
const deltaText = (reading: ReadingOf<"Delta">): string =>
	[
		reading.relation,
		reading.heading.map((c) => c.name).join("\u0001"),
		keysText(reading.keys)
	].join("\u0000")

/**
 * A leaf's properties (a Base's or a Delta's), relative to its relation's reading: every rule a leaf states (a declared
 * key, a view's alternative or member) reads nothing of the node, and its derivations name none (ir/keys.ts
 * Implication), so the reading's keys, classes, closures and fixed columns are every such node's. The first node of a
 * reading computes them (`compute`), keyed by `anchor`, an object of the schema's own every leaf of the reading holds
 * (its relation's declared key, its view's keys, a Delta's keys), and `text`, the rest of what they are a function of;
 * every other node of it reads them and adds its own: itself, its reading, its outer columns and `provenance`, the
 * stored facts its columns are read from by its own scan.
 */
const leafProps = (
	subject: Subject,
	anchor: object,
	text: string,
	provenance: (column: string) => ReadonlyArray<Provenance>,
	compute: () => Props
): Props => {
	const byText = leaves.get(anchor) ?? new Map<string, Props>()
	if (byText.size === 0) {
		leaves.set(anchor, byText)
	}
	const known = byText.get(text)
	const read = known ?? compute()
	if (known === undefined) {
		byText.set(text, read)
	}
	return {
		...read,
		node: subject.node,
		reading: subject.reading,
		attachment: undefined,
		outer: subject.outer,
		provenance
	}
}

/**
 * The logical properties of a node from its inputs': `reading` is the node with each input replaced by that input's
 * properties (ir/dag.ts edgeValues). A world relation's facts are a view's, read under the view's name, which may be a
 * base relation's: no containment between stored facts speaks of them.
 */
export const logicalPropsOf = (node: RelNode, reading: PropsReading, env: PropsEnv): Props => {
	const subject: Subject = { node, reading, attachment: undefined, outer: env.scope(node).outer }
	const all = node.heading.map((c) => c.name)
	/**
	 * The rest of a node's props that delivers its rows as one group, with no discriminant and no inner group, and the
	 * attributes of its rows it does not deliver `hidden`: none, unless it states them.
	 */
	const oneGroup = (
		rest: Omit<Rest, "discriminant" | "inner" | "attributes">,
		hidden: ReadonlyArray<string>
	): Rest => ({
		...rest,
		discriminant: [],
		inner: [],
		attributes: attributesOver(all, hidden)
	})
	switch (reading.kind) {
		case "Base": {
			const relation = reading.relation
			const occurrence = reading.occurrence
			return leafProps(
				subject,
				reading.relationKind === "relation" ? reading.primaryKey : reading.view,
				baseText(reading, env),
				reading.relationKind === "world"
					? noProvenance
					: provenanceOver(all, (c) => [{ scan: occurrence, relation, field: c }]),
				() => {
					const stated: Stated =
						reading.relationKind === "relation"
							? {
									dependencies: [
										...[reading.primaryKey, ...reading.keys].map((k, i) =>
											declaredKey(k, all, [storedKeyPremise(relation, k, i === 0)], "immediate")
										),
										...reading.generated.map(generationDetermines)
									],
									equal: []
								}
							: viewDependencies(env.keyedViews ? reading.view : [], all)
					return finish(
						subject,
						stated.dependencies,
						oneGroup(
							{
								exactlyOne: false,
								provenance: noProvenance,
								context: "immediate",
								equal: stated.equal
							},
							[]
						)
					)
				}
			)
		}
		case "Context":
			return finish(
				subject,
				[atMostOneRow(all, { kind: "context" })],
				oneGroup(
					{ exactlyOne: false, provenance: noProvenance, context: "queryLocal", equal: [] },
					[]
				)
			)
		case "Closed": {
			const rows = reading.rows
			const deps: Array<Dependency> =
				rows.length <= 1 ? [atMostOneRow(all, { kind: "singleFact" })] : []
			const equal: Array<Equality> = []
			/** Each class's first column so far, with its type and its values' identities fact by fact. */
			const firsts: Array<{
				readonly column: string
				readonly type: ScalarType
				readonly values: ReadonlyArray<string>
			}> = []
			/**
			 * Each column's values fact by fact: their keys under PostgreSQL's equality, which a key is distinct by, and their
			 * identities, which a fixed column and two equal ones are one by, so a literal read for a column is its own.
			 */
			const columns = reading.heading.map((_, i) =>
				closedColumn(reading, i).map((v) => nativeEqualityKey(v))
			)
			const identities = reading.heading.map((_, i) =>
				closedColumn(reading, i).map((v) => canonicalTextOf(v))
			)
			if (rows.length > 1) {
				for (const key of rowKeys(columns, rows.length)) {
					deps.push(
						distinctColumns(
							key.map((i) => defined(reading.heading[i], "a key column").name),
							all
						)
					)
				}
			}
			for (const [i, h] of reading.heading.entries()) {
				const c = h.name
				const values = defined(identities[i], "a column's values")
				if (values.length > 0 && new Set(values).size === 1) {
					deps.push(fixedColumn(c, { kind: "closedValue" }))
				}
				const first = firsts.find(
					(f) => sameScalarType(f.type, h.type) && f.values.every((v, j) => v === values[j])
				)
				if (first === undefined) {
					firsts.push({ column: c, type: h.type, values })
					continue
				}
				const stated = statedEquality(first.column, c, { kind: "closedColumns" })
				deps.push(stated.there, stated.back)
				equal.push(stated)
			}
			return finish(
				subject,
				deps,
				oneGroup(
					{
						exactlyOne: rows.length === 1,
						provenance: noProvenance,
						context: "queryLocal",
						equal
					},
					[]
				)
			)
		}
		case "Call":
			return finish(
				subject,
				[],
				oneGroup(
					{ exactlyOne: false, provenance: noProvenance, context: "queryLocal", equal: [] },
					[]
				)
			)
		case "InputSet":
			return reading.input.kind === "row"
				? finish(
						subject,
						[atMostOneRow(all, { kind: "row" })],
						oneGroup(
							{
								exactlyOne: true,
								provenance: noProvenance,
								context: "queryLocal",
								equal: []
							},
							[]
						)
					)
				: finish(
						subject,
						[],
						oneGroup(
							{
								exactlyOne: false,
								provenance: noProvenance,
								context: "queryLocal",
								equal: []
							},
							[]
						)
					)
		case "Recursive":
		case "SelfRef": {
			const inputs: ReadonlyArray<Props> =
				reading.kind === "Recursive" ? [reading.base, reading.step] : []
			return finish(
				subject,
				[],
				oneGroup(
					{
						exactlyOne: false,
						provenance: noProvenance,
						context: strongest(inputs.map((p) => p.context)),
						equal: []
					},
					[]
				)
			)
		}
		case "Delta": {
			const relation = reading.relation
			return leafProps(subject, reading.keys, deltaText(reading), noProvenance, () => {
				const deps = reading.keys.map((k, i) =>
					declaredKey(k, all, [storedKeyPremise(relation, k, i === 0)], "immediate")
				)
				return finish(
					subject,
					deps,
					oneGroup(
						{
							exactlyOne: false,
							provenance: noProvenance,
							context: deps.length > 0 ? "immediate" : "queryLocal",
							equal: []
						},
						[]
					)
				)
			})
		}
		case "MatchRegion":
			return regionProps(subject, reading, env)
		case "Filter": {
			const input = reading.input
			const filtered = filterDependencies(reading)
			const rest = keptRest(reading, input, input.context)
			return finish(subject, [...carried(input, sameName, rowsKeep), ...filtered.dependencies], {
				...rest,
				exactlyOne: false,
				equal: [...rest.equal, ...filtered.equal]
			})
		}
		case "ProjectSet":
			return projectProps(subject, reading)
		case "SemiJoin":
		case "AntiJoin":
		case "Difference": {
			const left = reading.left
			const right = reading.right
			const deps: Array<Dependency> = [...carried(left, sameName, rowsKeep)]
			if (reading.kind === "SemiJoin") {
				/**
				 * A left column paired with a right column the right side fixes is fixed too, by the pair: the right side
				 * reads nothing of the left (ir/rel.ts SemiJoinRight, which only semiJoinRight mints, reading its subtree), so
				 * it is one relation per evaluation of the semi-join.
				 */
				const rightFixed = right.nothing
				appendAll(
					deps,
					reading.on.flatMap((pair, index) =>
						reaches(rightFixed, pair.right)
							? [
									fixedColumn(pair.left, {
										kind: "semiJoinPair",
										index,
										right: derivation(
											rightFixed,
											positionsOf(right.stated.attributes, [pair.right])
										)
									})
								]
							: []
					)
				)
			}
			return finish(
				subject,
				deps,
				keptRest(reading, left, strongest([left.context, right.context]))
			)
		}
		case "Intersect": {
			const left = reading.left
			const right = reading.right
			/** The right's rows are the left's, column for column; its hidden attributes are its own rows' others. */
			const rightName = (a: string) => (isHidden(a) ? hiddenAttribute(right.node.id, a) : a)
			const deps = [...carried(left, sameName, rowsKeep), ...carried(right, rightName, rightKeeps)]
			const rest = keptRest(reading, left, strongest([left.context, right.context]))
			return finish(subject, deps, {
				...rest,
				equal: [
					...rest.equal,
					...inputEqualities(
						right,
						(c) => all.includes(c),
						(from, to, path) => rightKeeps([from], [to], path),
						(by) => by
					)
				],
				attributes: attributesOver(all, [
					...rest.attributes.hidden,
					...right.stated.attributes.hidden.map(rightName)
				])
			})
		}
		case "Union":
			return unionProps(subject, reading)
		case "Take": {
			/** The take ranks the rows its correlation restricts its input to, so its card is theirs, bounded. */
			const input = reading.input
			const locals = new Set([input.node.id])
			const deps: Array<Dependency> = [
				...carried(input, sameName, rowsKeep),
				...reading.correlation.flatMap((c, index) =>
					valueAt(c.expr, locals).kind !== "local"
						? [fixedColumn(c.column, { kind: "takeCorrelation", index })]
						: []
				)
			]
			if (reading.bound.kind === "literal" && reading.bound.k === 1n) {
				deps.push(atMostOneRow(all, { kind: "takeOne" }))
			}
			return finish(subject, deps, {
				...keptRest(reading, input, input.context),
				exactlyOne: input.card === "one" && reading.correlation.length === 0
			})
		}
		case "Group":
		case "OrderedSetAggregate": {
			const input = reading.input
			const groupKeys = reading.keys
			/**
			 * Only the group key is carried from the input; an aggregate output may reuse the name of an input column
			 * that is not a key, and carries none of its facts.
			 */
			const nameOf = hiddenUnless(input, (c) => groupKeys.includes(c))
			const deps = [...carried(input, nameOf, groupKeeps), groupKey(groupKeys, all)]
			return finish(
				subject,
				deps,
				oneGroup(
					{
						exactlyOne: input.card === "one",
						/** An aggregate output carries none of the facts of an input column it may share a name with. */
						provenance: (c) => (groupKeys.includes(c) ? provenanceOf(input, c) : []),
						context: input.context,
						equal: inputEqualities(
							input,
							(c) => groupKeys.includes(c),
							(from, to, path) => groupKeeps([from], [to], path),
							(by) => by
						)
					},
					hiddenOf(input, nameOf)
				)
			)
		}
		case "Produce": {
			const input = reading.input
			const out = reading.out
			const intersection = reading.producer === "spanIntersection"
			const inCarried = (c: string) => reading.carried.includes(c)
			/** Each input key, by the carried columns of its class when its own are not all carried. */
			const produced = input.keys.flatMap((k) => {
				const within = keyIn(k, inCarried)
				const p = k.key.every(inCarried)
					? k
					: within === undefined
						? undefined
						: input.prove(within)
				return p === undefined ? [] : [producedFact(intersection ? p.key : [...p.key, out], all, p)]
			})
			const nameOf = hiddenUnless(input, inCarried)
			const deps: Array<Dependency> = [...carried(input, nameOf, rowsKeep), ...produced]
			return finish(
				subject,
				deps,
				oneGroup(
					{
						exactlyOne: false,
						provenance: (c) => (inCarried(c) ? provenanceOf(input, c) : []),
						context: input.context,
						equal: keptEqualities(input, inCarried)
					},
					hiddenOf(input, nameOf)
				)
			)
		}
		case "ApproximateNearest":
		case "OrderedResult":
		case "Window":
		case "Step": {
			const input = reading.kind === "ApproximateNearest" ? reading.source : reading.input
			const deps: Array<Dependency> = [...carried(input, sameName, rowsKeep)]
			if (reading.kind === "ApproximateNearest" && reading.take === 1n) {
				deps.push(atMostOneRow(all, { kind: "nearestOne" }))
			}
			const windowOut = reading.kind === "Window" ? reading.out : undefined
			if (windowOut !== undefined) {
				deps.push(windowValue(input.columns, windowOut))
			}
			if (reading.kind === "Window" && reading.fn === "rowNumber") {
				deps.push(numberedRow(reading.partition, reading.out, all))
			}
			return finish(subject, deps, {
				...keptRest(reading, input, input.context),
				exactlyOne: reading.kind !== "ApproximateNearest" && input.card === "one",
				/** A window's output is ranked or aggregated over its partition: it carries no input fact. */
				provenance: (c) => (c === windowOut ? [] : provenanceOf(input, c))
			})
		}
		case "Attach":
		case "Forbid": {
			const input = reading.kind === "Attach" ? reading.parent : reading.violation
			const others = reading.kind === "Attach" ? [reading.child] : []
			return finish(subject, carried(input, sameName, rowsKeep), {
				...keptRest(reading, input, strongest([input.context, ...others.map((o) => o.context)])),
				exactlyOne: input.card === "one"
			})
		}
	}
}

/**
 * A rule region.
 *
 * The region's own nodes are its heading and its occurrences' sources: a constant is evaluated with the whole region
 * in scope, a correlated variable's expression may read it, and a lateral source reads the region's heading or an
 * earlier occurrence's source. Only a value that reads none of them is fixed per evaluation; one that does is a
 * function of the variables equal to what it reads, when each has one.
 *
 * A scan determines what it binds from its source's dependencies: each source determinant whose columns are bound to
 * variables, fixed by a constant or fixed in the source determines the variables bound to the columns its closure in
 * the source reaches. A lateral source's dependencies hold per evaluation of it, so in each row of the region they hold
 * given the variables equal to the region's columns it reads, or not at all when one of those has none.
 */
const regionProps = (subject: Subject, node: ReadingOf<"MatchRegion">, env: PropsEnv): Props => {
	const region = subject.node.id
	const deps: Array<Dependency> = []
	/** Each binding's variable with the facts its column was read from, in occurrence and binding order. */
	const bound = new Map<string, Array<Provenance>>()
	/** The source attributes the region binds to no variable of its heading, each under its occurrence. */
	const hidden: Array<string> = []
	const locals = regionLocals(region, node)
	const bySource = Map.groupBy(node.occurrences, (o) => o.source.node.id)
	/**
	 * The variable equal to a column of one of the region's own nodes: the variable itself for the region's heading,
	 * the variable the one occurrence over that source binds the column to otherwise.
	 */
	const heading = new Set(node.heading.map((c) => c.name))
	const varOf = (ref: NodeColumn): string | undefined => {
		if (ref.node === region) {
			return heading.has(ref.column) ? ref.column : undefined
		}
		const [only, ...others] = bySource.get(ref.node) ?? []
		if (only === undefined || others.length > 0) {
			return undefined
		}
		const b = only.bindings.find((x) => x.column === ref.column)
		const v = b?.var.name
		return v !== undefined && heading.has(v) ? v : undefined
	}
	/** The variables equal to the region's own columns a value reads, or undefined when one of them has none. */
	const varsOf = (refs: ReadonlyArray<NodeColumn>): ReadonlyArray<string> | undefined => {
		const vars = refs.map(varOf)
		return vars.every((v) => v !== undefined) ? [...new Set(vars)] : undefined
	}
	const contexts: Array<EvidenceContext> = []
	const equal: Array<Equality> = []
	for (const o of node.occurrences) {
		const src = o.source
		contexts.push(src.context)
		const sourceNode = src.node
		/** Each source column's variables, in binding order; a column bound to several equates them. */
		const varsAt = new Map<string, [string, ...Array<string>]>()
		for (const b of o.bindings) {
			const v = b.var.name
			const facts = bound.get(v) ?? []
			appendAll(
				facts,
				sourceNode.kind === "Base"
					? [{ scan: o.id, relation: sourceNode.relation, field: b.column }]
					: provenanceOf(src, b.column)
			)
			bound.set(v, facts)
			if (!heading.has(v)) {
				continue
			}
			const at = varsAt.get(b.column)
			if (at === undefined) {
				varsAt.set(b.column, [v])
				continue
			}
			const [first] = at
			if (first !== v) {
				const e = statedEquality(first, v, {
					kind: "sharedColumn",
					occurrence: o.id,
					column: b.column
				})
				deps.push(e.there, e.back)
				equal.push(e)
			}
			at.push(v)
		}
		const lateral = refsTo(env.scope(sourceNode).outer, locals)
		if (lateral.length === 0) {
			appendAll(equal, sourceEqualities(src, o.id, varsAt))
		}
		for (const [column, [w]] of lateral.length === 0 ? [] : varsAt) {
			for (const v of fixedNames(src, column) ?? []) {
				const other =
					v.name.kind === "outer" ? varOf({ node: v.name.node, column: v.name.column }) : undefined
				if (other === undefined || other === w) {
					continue
				}
				const stated = statedEquality(other, w, {
					kind: "lateralFixed",
					occurrence: o.id,
					column,
					fixed: v.derivation
				})
				deps.push(stated.there, stated.back)
				equal.push(stated)
			}
		}
		/** A source attribute bound to no variable of the heading: a hidden attribute of the region, by its occurrence. */
		const hide = (c: string) => hiddenAttribute(o.id, c)
		/** Each source attribute's hidden attribute of the region, by its position. */
		const hiddenNames = attributesOf(src).names.map(hide)
		const hiddenAt = (p: number): string =>
			defined(hiddenNames[p], "a position of the source's attributes")
		appendAll(
			hidden,
			attributesOf(src).names.flatMap((c, p) => (varsAt.has(c) ? [] : [hiddenAt(p)]))
		)
		const reads = lateral.length === 0 ? [] : varsOf(lateral)
		if (reads === undefined) {
			continue
		}
		/** What a constant's source column follows from: nothing when it reads no region column, else those variables. */
		const constant = new Map<string, ReadonlyArray<string> | undefined>(
			o.constants.map((k) => [
				k.column,
				valueAt(k.expr, locals).kind !== "local" ? [] : varsOf(localRefs(k.expr, locals))
			])
		)
		const srcFixed = new Set(fixedColumns(src))
		/**
		 * What a determinant's source attribute is given by in the region: the variable bound to it, the variables its
		 * constant follows from, nothing for an attribute fixed in the source, a column of its class the scan binds, which
		 * stands for it, or else its own hidden attribute; undefined only for a constant reading a region column no
		 * variable is equal to.
		 */
		const givenBy = (
			c: string
		):
			| { readonly given: ReadonlyArray<string>; readonly from: ReadonlyArray<string> }
			| undefined => {
			const first = varsAt.get(c)?.[0]
			if (first !== undefined) {
				return { given: [c], from: [first] }
			}
			if (constant.has(c)) {
				const needs = constant.get(c)
				return needs === undefined ? undefined : { given: [c], from: needs }
			}
			if (srcFixed.has(c)) {
				return { given: [], from: [] }
			}
			const member = classOf(src, c).find((m) => varsAt.has(m))
			const memberVar = member === undefined ? undefined : varsAt.get(member)?.[0]
			return member === undefined || memberVar === undefined
				? { given: [c], from: [hide(c)] }
				: { given: [member], from: [memberVar] }
		}
		for (const d of determinantsOf(src)) {
			const givens = d.columns.map(givenBy)
			if (!givens.every((g) => g !== undefined)) {
				continue
			}
			const given = givens.flatMap((g) => g.given)
			const from = new Set<string>([...reads, ...givens.flatMap((g) => g.from)])
			const reached = reachedFrom(src, bitsOf(attributesOf(src), given))
			const to = reached.sequence
				.flatMap((p) => varsAt.get(attributeAt(attributesOf(src), p)) ?? [hiddenAt(p)])
				.filter((v) => !from.has(v))
			if (to.length > 0) {
				deps.push(
					matchBinds([...from], [...new Set(to)], o.id, derivation(reached, reached.sequence))
				)
			}
		}
	}
	for (const [index, c] of node.correlated.entries()) {
		const v = c.var.name
		if (!heading.has(v)) {
			continue
		}
		const e = c.expr
		const copied =
			e.kind === "column" && locals.has(e.column.node)
				? varOf({ node: e.column.node, column: e.column.name })
				: undefined
		const reads = valueAt(e, locals).kind !== "local" ? [] : varsOf(localRefs(e, locals))
		const follows = reads === undefined ? undefined : correlatedVariable(reads, v, index)
		if (follows !== undefined) {
			deps.push(follows)
		}
		if (copied !== undefined && copied !== v) {
			const copy = equalColumns(v, copied, { kind: "correlatedCopy", index })
			deps.push(copy)
			if (follows !== undefined) {
				equal.push({ a: v, b: copied, by: "determination", there: copy, back: follows })
			}
		}
	}
	for (const [index, e] of node.equalities.entries()) {
		const a = e.a.name
		const b = e.b.name
		if (a === b || !heading.has(a) || !heading.has(b)) {
			continue
		}
		const stated = statedEquality(a, b, { kind: "regionEquality", index })
		deps.push(stated.there, stated.back)
		equal.push(stated)
	}
	return finish(subject, deps, {
		exactlyOne: false,
		/** A variable no occurrence binds, a correlated one, is read from no fact of the region. */
		provenance: (c) => bound.get(c) ?? [],
		context: strongest(contexts),
		discriminant: [],
		inner: [],
		equal,
		attributes: attributesOver(
			node.heading.map((c) => c.name),
			hidden
		)
	})
}

/**
 * The variables an occurrence binds to columns of one class of its source, a source that reads no region column, are
 * equal: the match binds each from the other by the source's path between their columns. `varsAt` holds each source
 * column's variables, in binding order.
 */
const sourceEqualities = (
	src: Props,
	occurrence: OccurrenceId,
	varsAt: ReadonlyMap<string, ReadonlyArray<string>>
): ReadonlyArray<Equality> => {
	const out: Array<Equality> = []
	for (const [column, members] of src.classes) {
		const [first, ...others] =
			members[0] === column
				? members.flatMap((c) => {
						const v = varsAt.get(c)?.[0]
						return v === undefined ? [] : [{ column: c, v }]
					})
				: []
		if (first === undefined) {
			continue
		}
		for (const other of others) {
			const there = pathOf(src, first.column, other.column)
			const back = pathOf(src, other.column, first.column)
			if (there !== undefined && back !== undefined) {
				out.push({
					a: first.v,
					b: other.v,
					by: "determination",
					there: matchBinds([first.v], [other.v], occurrence, there.derivation),
					back: matchBinds([other.v], [first.v], occurrence, back.derivation)
				})
			}
		}
	}
	return out
}

/**
 * A projection closes over its input: every input attribute is an attribute here, a copied column under its first
 * copy's name and every other one hidden (ir/keys.ts hiddenAttribute), so each input determinant, every attribute named
 * here, and each copying output alone, determines the attributes whose values its closure in the input reaches: a copy
 * of a reached column, a hidden attribute reached, or a computed or constant output reading only reached columns. No
 * dependency is dropped with a column the projection drops, and two copies of one column, or of equal columns,
 * determine each other.
 */
const projectProps = (subject: Subject, node: ReadingOf<"ProjectSet">): Props => {
	const input = node.input
	const inputId = input.node.id
	const all = node.heading.map((c) => c.name)
	/** The input column each copying output copies, and each input column's first copy. */
	const copyOf = new Map<string, string>()
	const copies = new Map<string, string>()
	/** The input columns each computed or constant output reads. */
	const reads = new Map<string, ReadonlyArray<string>>()
	for (const o of node.out) {
		const col = copiedColumn(o.expr)
		if (col !== undefined) {
			copyOf.set(o.name, col)
			if (!copies.has(col)) {
				copies.set(col, o.name)
			}
			continue
		}
		reads.set(o.name, readColumns(o.expr, inputId))
	}
	/** Each input attribute's name here: the output copying it first, or a hidden attribute. */
	const nameOf = (a: string): string =>
		copies.get(a) ?? (isHidden(a) ? a : hiddenAttribute(inputId, a))
	/** Each name here of an input attribute, but a copy's: the attribute it names. */
	const hiddenFrom = new Map(
		attributesOf(input).names.flatMap((a) => (copies.has(a) ? [] : [[nameOf(a), a] as const]))
	)
	/** The input attributes an attribute here reads: a copy's column, a computed output's, a hidden one's own. */
	const readsOf = (o: string): ReadonlyArray<string> => {
		const col = copyOf.get(o) ?? hiddenFrom.get(o)
		return col !== undefined ? [col] : (reads.get(o) ?? [])
	}
	const attributes = attributesOver(all, [...hiddenFrom.keys()])
	const inputAttributes = attributesOf(input)
	/** The input attributes each attribute here reads, by position. */
	const readsAt = attributes.names.map((o) => bitsOf(inputAttributes, readsOf(o)))
	/** The input attributes the attributes here of `at` read. */
	const readBy = (at: Bits): Bits => {
		const read = noBits(inputAttributes)
		readsAt.forEach((columns, p) => {
			if (holdsAt(at, p)) {
				orInto(read, columns)
			}
		})
		return read
	}
	/** The images of the input's determinants, every attribute named here, then each copying output alone. */
	const deps: Array<Dependency> = []
	const seen: Array<Bits> = []
	for (const from of [
		...determinantsOf(input).map((d) => d.columns.map(nameOf)),
		...[...copyOf.keys()].map((o) => [o])
	]) {
		const at = bitsOf(attributes, from)
		if (seen.some((s) => sameBits(s, at))) {
			continue
		}
		seen.push(at)
		const reached = reachedFrom(input, readBy(at))
		const to = bitsAt(
			attributes,
			readsAt.flatMap((columns, p) =>
				!holdsAt(at, p) && subsetOf(columns, reached.reached) ? [p] : []
			)
		)
		if (!isEmpty(to)) {
			deps.push(
				projectionCloses(
					attributeNames(attributes, at),
					attributeNames(attributes, to),
					derivation(reached, positions(readBy(to)))
				)
			)
		}
	}
	/**
	 * Copies of columns of one input class are equal, each two by the input's path between the columns they copy, none for
	 * copies of one column; copies of columns of two classes are never equal, so only the copies of one class are paired.
	 */
	const equal: Array<Equality> = []
	const byClass = Map.groupBy(copyOf, ([, c]) => input.classes.get(c)?.[0] ?? c)
	for (const copying of byClass.values()) {
		for (const [i, [x, cx]] of copying.entries()) {
			for (const [y, cy] of copying.slice(i + 1)) {
				const there = cx === cy ? sameColumn(cx) : pathOf(input, cx, cy)
				const back = cx === cy ? sameColumn(cx) : pathOf(input, cy, cx)
				if (there !== undefined && back !== undefined) {
					equal.push({
						a: x,
						b: y,
						by: there.by,
						there: projectionCloses([x], [y], there.derivation),
						back: projectionCloses([y], [x], back.derivation)
					})
				}
			}
		}
	}
	return finish(subject, deps, {
		exactlyOne: input.card === "one",
		/** A computed output is read from no fact. */
		provenance: (c) => {
			const col = copyOf.get(c)
			return col === undefined ? [] : provenanceOf(input, col)
		},
		context: input.context,
		discriminant: [],
		inner: [],
		equal,
		attributes
	})
}

/** Each of `sets` once, by its columns in their order, in the order of their first. */
const distinctSets = (
	sets: ReadonlyArray<ReadonlyArray<string>>
): ReadonlyArray<ReadonlyArray<string>> => {
	const distinct = new TupleSet<ReadonlyArray<string>>()
	for (const cs of sets) {
		distinct.add(cs)
	}
	return [...distinct]
}

/** The sets of `sets` no other of them is within, each once, in their order. */
const leastSets = (
	sets: ReadonlyArray<ReadonlyArray<string>>
): ReadonlyArray<ReadonlyArray<string>> => {
	const unique = distinctSets(sets)
	return unique.filter(
		(cs) => !unique.some((other) => other.length < cs.length && other.every((c) => cs.includes(c)))
	)
}

/** Each arm's `f`, or undefined when some arm has none. */
const everyArm = <B>(
	arms: NonEmptyReadonlyArray<Props>,
	f: (arm: Props) => B | undefined
): NonEmptyReadonlyArray<B> | undefined => {
	const [first, ...rest] = arms
	const head = f(first)
	if (head === undefined) {
		return undefined
	}
	const tail: Array<B> = []
	for (const arm of rest) {
		const x = f(arm)
		if (x === undefined) {
			return undefined
		}
		tail.push(x)
	}
	return [head, ...tail]
}

/**
 * A union's properties. Columns equal in every row of every arm are equal in every row of the union: its classes are the
 * meet of its arms' classes by equalities alone, each column of one with the class's first column in heading order, both
 * ways, by every arm's path between them.
 */
const unionProps = (subject: Subject, node: ReadingOf<"Union">): Props => {
	const all = node.heading.map((c) => c.name)
	const attributes = attributesOver(all, [])
	/** The columns of the heading among `cs`, each once, in heading order. */
	const inHeading = (cs: Iterable<string>): KeySet =>
		attributeNames(attributes, bitsOf(attributes, cs))
	const arms = unionArms(node.groups)
	/** Rows of several heading groups: the union's own groups, or one group whose arms are of several themselves. */
	const discriminant =
		node.groups.length > 1 ? node.discriminant : [...new Set(arms.flatMap((a) => a.discriminant))]
	const single = node.groups.length === 1 && discriminant.length === 0
	/**
	 * The literal an arm fixes a column to, with its derivation: the one literal among the column's names; none where they
	 * hold no literal, or two, which no row of the arm holds at once.
	 */
	const literalAt = (
		a: Props,
		c: string
	): { readonly key: EqualityKey; readonly derivation: Implication } | undefined => {
		const [only, ...more] = (fixedNames(a, c) ?? []).flatMap((v) =>
			v.name.kind === "literal" ? [{ key: v.name.key, derivation: v.derivation }] : []
		)
		return more.length === 0 ? only : undefined
	}
	/** Columns every arm fixes to one value, a name they share, and columns every arm makes equal. */
	const deps: Array<Dependency> = []
	const equal: Array<Equality> = []
	for (const c of all) {
		const [shared] = commonNames(arms, c)
		if (shared !== undefined) {
			deps.push(armsAgree(c, shared.arms))
		}
	}
	for (const c of all) {
		const [first, ...others] = all.flatMap((o) => {
			const there = everyArm(arms, (a) => equalPath(a, c, o))
			const back = everyArm(arms, (a) => equalPath(a, o, c))
			return there === undefined || back === undefined ? [] : [{ o, there, back }]
		})
		if (first?.o !== c) {
			continue
		}
		for (const { o, there, back } of others) {
			const e: Equality = {
				a: c,
				b: o,
				by: "equalities",
				there: equalColumns(c, o, { kind: "arms", arms: there }),
				back: equalColumns(o, c, { kind: "arms", arms: back })
			}
			deps.push(e.there, e.back)
			equal.push(e)
		}
	}
	const pairs = arms.flatMap((a, i) =>
		arms.slice(i + 1).map((b, j) => [i, i + 1 + j, a, b] as const)
	)
	/** The separation of two arms on `cs`: a column each fixes to one literal, the two different. */
	const separation = (
		cs: ReadonlyArray<string>,
		i: number,
		j: number,
		a: Props,
		b: Props
	): Separation | undefined => {
		for (const c of cs) {
			const x = literalAt(a, c)
			const y = literalAt(b, c)
			if (x !== undefined && y !== undefined && x.key !== y.key) {
				return { arms: [i, j], column: c, fixed: [x.derivation, y.derivation] }
			}
		}
		return undefined
	}
	const separators = all.filter((c) => arms.every((a) => literalAt(a, c) !== undefined))
	/** The separations of every two arms on `cs`, undefined when some two are not told apart on them. */
	const separationsOn = (cs: ReadonlyArray<string>): ReadonlyArray<Separation> | undefined => {
		const out: Array<Separation> = []
		for (const [i, j, a, b] of pairs) {
			const s = separation(cs, i, j, a, b)
			if (s === undefined) {
				return undefined
			}
			out.push(s)
		}
		return out
	}
	/** Columns that tell every two arms apart, with the separations on them; undefined when they do not. */
	const toldApartBy = (
		cs: ReadonlyArray<string>
	):
		| { readonly columns: ReadonlyArray<string>; readonly separations: ReadonlyArray<Separation> }
		| undefined => {
		const separations = separationsOn(cs)
		return separations === undefined ? undefined : { columns: cs, separations }
	}
	/**
	 * The fewest separators, the first in heading order, that tell every two arms apart: the separators, each dropped
	 * from the end while the rest still do; undefined when the separators do not.
	 */
	const telling = separators.reduceRight(
		(kept, c) =>
			kept === undefined ? undefined : (toldApartBy(kept.columns.filter((k) => k !== c)) ?? kept),
		toldApartBy(separators)
	)
	/**
	 * What every arm derives from each determinant of an arm within the heading, with the separators that tell every two
	 * arms apart: two rows of one arm agree on it as the arm's rows do, and rows of two arms never agree on it. So the
	 * union keeps its arms' factors, each separator a factor of its own before them.
	 */
	const everyArmDerives: ReadonlyArray<Dependency> =
		telling === undefined
			? []
			: distinctSets(
					arms
						.flatMap(determinantsOf)
						.filter((d) => d.columns.every((c) => all.includes(c)))
						.map((d) => inHeading([...d.columns, ...telling.columns]))
				).flatMap((from) => {
					const reached = mapNonEmpty(arms, (a) => coverOf(a, bitsOf(attributesOf(a), from)))
					const to = all.filter((c) => !from.includes(c) && reached.every((r) => reaches(r, c)))
					return to.length === 0
						? []
						: [
								separated(
									from,
									to,
									mapNonEmpty(reached, (r) => derivation(r, positionsOf(r.rows.attributes, to))),
									telling.separations
								)
							]
				})
	/**
	 * The least unions of one key each arm lists (listedKeys) within the heading, each key by any columns of its classes,
	 * with the separators: a union key holds a key of every arm, and the least sets holding one listed key of each are
	 * where the minimization starts, keeping the columns of its classes every arm proves; the dependencies every arm
	 * derives (above) give the rest of the keys their factors choose among. Arms keyed alike give each listed key once.
	 * Then the whole heading: minimizing it from the end finds a key holding a key of each arm beside the separators.
	 */
	const candidates: ReadonlyArray<ReadonlyArray<string>> = [
		...arms
			.map((a) =>
				a.keys.flatMap((k) =>
					listedKeys(k).flatMap((classes) =>
						classes.every((members) => members.some((c) => all.includes(c)))
							? [inHeading(classes.flat())]
							: []
					)
				)
			)
			.reduce<ReadonlyArray<ReadonlyArray<string>>>(
				(sofar, listed) =>
					leastSets(sofar.flatMap((s) => listed.map((l) => inHeading([...s, ...l])))),
				[[]]
			)
			.map((cs) => [...cs, ...separators]),
		all
	]
	/** The union proof of `cs`: every arm proves it, and every two arms are told apart on it. */
	const unionProof = (given: ReadonlyArray<string>): KeyProof | undefined => {
		const cs = inHeading(given)
		const proofs = everyArm(arms, (a) => a.prove(cs))
		const separations = separationsOn(cs)
		return proofs === undefined || separations === undefined
			? undefined
			: unionKey(cs, proofs, separations)
	}
	/** A union's keys rest on its arms' keys and its separators. */
	const unionKeys = minimalKeys(
		attributes.heading,
		candidates.map((cs) => bitsOf(attributes, cs)),
		(key) => unionProof(attributeNames(attributes, key)),
		[]
	).map((k) => k.witness)
	const [firstArm, ...laterArms] = arms
	const onlyArm = laterArms.length === 0 ? firstArm : undefined
	const rest: Rest = {
		exactlyOne: onlyArm?.card === "one",
		provenance: (c) => (onlyArm !== undefined ? provenanceOf(onlyArm, c) : []),
		context: strongest(arms.map((a) => a.context)),
		discriminant,
		inner: single ? [] : unionKeys,
		equal,
		attributes
	}
	return finish(
		subject,
		[
			...deps,
			...everyArmDerives,
			...(single ? unionKeys.map((k) => unionKeyDetermines(k, all)) : [])
		],
		rest
	)
}

/**
 * An attachment's child relative to its parent: the child's dependencies with each correlated child column fixed per
 * parent row, so its keys are reduced by them.
 */
export const relativeProps = (child: Props, attach: NodeOf<"Attach">): Props =>
	finish(
		{ node: child.node, reading: child.reading, attachment: attach, outer: child.outer },
		[
			...child.stated.rows.map((row) => row.dependency),
			...attach.correlation.map((pair, index) =>
				fixedColumn(pair.child, { kind: "attachCorrelation", attach: attach.id, index })
			)
		],
		{
			exactlyOne: child.card === "one",
			provenance: (c) => provenanceOf(child, c),
			context: child.context,
			discriminant: child.discriminant,
			inner: innerOf(child),
			equal: [...child.forest].map(([column, edge]): Equality => ({
				a: edge.parent,
				b: column,
				by: edge.by,
				there: edge.down,
				back: edge.up
			})),
			attributes: attributesOf(child)
		}
	)
