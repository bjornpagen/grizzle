import { appendAll } from "#compiler/core/array.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { NodeId, OccurrenceId, ParamId } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
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
	type EqualWitness,
	type FixedWitness,
	distinctColumn,
	equalColumns,
	fixedColumn,
	groupKeeps,
	groupKey,
	type Implication,
	implication,
	type KeyMember,
	type KeyProof,
	keyClasses,
	keyIn,
	keyMember,
	keyWithin,
	matchBinds,
	producedFact,
	projectionCloses,
	rowsKeep,
	rowsKey,
	type Separation,
	unionKey,
	unionKeyDetermines,
	type ViewKey,
	windowValue
} from "#compiler/ir/keys.ts"

import {
	type Card,
	closedColumn,
	edgesOf,
	type Heading,
	type KeySet,
	type KindOver,
	type NodeOf,
	type NodeOver,
	type RelNode,
	unionArms,
	type ValueRefs
} from "#compiler/ir/rel.ts"

import {
	type Closure,
	closure,
	covers,
	derivation,
	inHeadingOrder,
	minimalKeys
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
 *   its environment names them. Closed: each column whose values are distinct, a column of one value fixed, at most
 *   one fact; descriptor facts. Context: at most one fact. A membership's row: exactly one fact, a descriptor fact.
 *   Delta: its relation's keys, which hold in both of the states it compares. Any other InputSet, Recursive and
 *   SelfRef: none beyond the whole heading, a set.
 * - MatchRegion: a scan determines what it binds from its source's dependencies, its source columns bound to variables,
 *   fixed by a constant, or fixed in the source; shared variables join, a column bound to two variables equates them,
 *   equalities equate, a correlated variable follows from what it reads.
 * - Filter: an equality with a value fixed per evaluation fixes its column; one between two columns equates them; a
 *   false conjunct leaves at most one row, none.
 * - ProjectSet: closes over its input, its computed outputs following from the columns they read.
 * - Group: the group key determines the group, and the input's dependencies among it hold.
 * - Union: a column every arm fixes alike is fixed; two columns every arm makes equal are equal, by each arm's
 *   equalities; a key of every arm is a key when every two arms are told apart by a literal both fix on it, their
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
	readonly columns: ReadonlyArray<string>
	/** The dependencies the node states over its heading, its own and those it carries from its inputs. */
	readonly dependencies: ReadonlyArray<Dependency>
	/**
	 * Its minimal keys over its classes of equal columns, each a proof over the classes' representatives, in key order:
	 * another column of a key column's class stands for it (KeyProof members).
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
 * The value an expression has when it reads no column of `locals`: a literal, a parameter, an outer column, or a
 * computation over those.
 */
const fixedOf = (e: ScalarExpr, locals: ReadonlySet<NodeId>): Fixed | undefined => {
	if (e.deps.nodes.some((n) => locals.has(n))) {
		return undefined
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
			return { kind: "expr" }
	}
}

const localColumn = (e: ScalarExpr, node: NodeId): string | undefined => {
	const u = comparedValue(e)
	return u.kind === "column" && u.column.node === node ? u.column.name : undefined
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

/** A node's columns and the dependencies it states, which its closures read, with its reading and attachment, which say
 * what value each step fixes a column to. */
interface Table {
	readonly node: { readonly id: NodeId }
	readonly reading: PropsReading
	readonly attachment: NodeOf<"Attach"> | undefined
	readonly columns: ReadonlyArray<string>
	readonly dependencies: ReadonlyArray<Dependency>
}

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

const namedOf = (f: Fixed): Named | undefined => (f.kind === "expr" ? undefined : f)

/**
 * What `start` determines at a node, under its dependencies, each column reached by a step naming its value where one
 * does: the derivation a rule stores, and a fixed column's value, are read off it, so they name the value wherever a
 * step names it.
 */
const closureOf = (props: Table, start: Iterable<string>): Closure<Named> => {
	const columns = new Set(props.columns)
	const given = [...start].filter((c) => columns.has(c))
	return closure(
		props.node.id,
		columns,
		props.dependencies,
		inHeadingOrder(props.columns, given),
		(d, column, named) => namedOf(stepValue(props, d, column, (c) => named.get(c)))
	)
}

/**
 * What `start` determines at a node, each column reached by the first step to fire: what a key determines, whose
 * derivation holds only the steps the key needs to determine the heading, whatever values they name.
 */
const coverOf = (props: Table, start: Iterable<string>): Closure<never> => {
	const columns = new Set(props.columns)
	const given = [...start].filter((c) => columns.has(c))
	return closure<never>(
		props.node.id,
		columns,
		props.dependencies,
		inHeadingOrder(props.columns, given),
		() => undefined
	)
}

/** The columns of a node fixed per evaluation: what nothing determines. */
export const fixedColumns = (props: Props): ReadonlyArray<string> => [...props.fixed.keys()]

/** Every name of the value a fixed column holds per evaluation, undefined when the column is not fixed (Props.fixed). */
export const fixedNames = (props: Props, column: string): ReadonlyArray<NamedValue> | undefined =>
	props.fixed.get(column)

/**
 * The value the closure of nothing names a fixed column by, the first of its names, which the derivations a parent
 * carries from that closure read; a computation where it has none.
 */
const firstName = (props: Props, column: string): Fixed =>
	props.fixed.get(column)?.[0]?.name ?? { kind: "expr" }

/**
 * Each column the closure of nothing reaches, with every name a step fixes it to: first the one the closure reached it
 * by, then each further one a step gives it, until none adds a name. A step that carries an input's column carries each
 * name the input fixes it to, by a step like it over the input's derivation of that name; an equality carries each name
 * of its other column. So the names are every value the node's steps fix the column to, in any order of its steps.
 */
const fixedOver = (props: Table): ReadonlyMap<string, ReadonlyArray<NamedValue>> => {
	const reached = closureOf(props, [])
	const names = new Map<string, Array<NamedValue>>()
	for (const c of reached.columns.keys()) {
		const first = reached.named.get(c)
		names.set(c, first === undefined ? [] : [{ name: first, derivation: derivation(reached, [c]) }])
	}
	const namesOf = (c: string): ReadonlyArray<NamedValue> => names.get(c) ?? []
	for (let changed = true; changed;) {
		changed = false
		for (const d of props.dependencies) {
			if (!d.from.every((c) => reached.columns.has(c))) {
				continue
			}
			for (const c of d.to) {
				const held = names.get(c)
				if (held === undefined) {
					continue
				}
				for (const v of stepNames(props, reached, d, c, namesOf, held)) {
					held.push(v)
					changed = true
				}
			}
		}
	}
	return names
}

/**
 * What a step reads the value it fixes `column` to from: its own value (a literal, a parameter, an outer column, a
 * computation); another column of the node, an equality's; an input's column, whose value it carries, with the step
 * like it that carries the column alone over another derivation of the input; or a union's arms, which agree on it.
 */
type StepSource =
	| { readonly kind: "own"; readonly value: Fixed }
	| { readonly kind: "column"; readonly column: string }
	| {
			readonly kind: "input"
			readonly input: Props
			readonly column: string
			readonly over: (derivation: Implication) => Dependency
	  }
	| { readonly kind: "arms"; readonly arms: NonEmptyReadonlyArray<Props> }

const own = (value: Fixed): StepSource => ({ kind: "own", value })
const opaque: StepSource = own({ kind: "expr" })

/** The input of a reading whose label is `input`, by which a rule carries its columns. */
const inputOf = (reading: PropsReading, input: NodeId): Props | undefined =>
	edgesOf<Props>(reading).find((p) => p.node.id === input)

/** Where step `d` reads the value it fixes `column` to at a node. */
const stepSource = (props: Table, d: Dependency, column: string): StepSource => {
	const node = props.reading
	const rule = d.rule
	switch (rule.rule) {
		case "fixed": {
			const witness = rule.witness
			if (witness.kind !== "semiJoinPair") {
				return own(fixedWitnessValue(props, witness, column))
			}
			const pair = node.kind === "SemiJoin" ? node.on[witness.index] : undefined
			return pair === undefined || node.kind !== "SemiJoin"
				? opaque
				: {
						kind: "input",
						input: node.right,
						column: pair.right,
						over: (right) =>
							fixedColumn(column, { kind: "semiJoinPair", index: witness.index, right })
					}
		}
		case "correlated": {
			const corr = node.kind === "MatchRegion" ? node.correlated[rule.index] : undefined
			if (corr === undefined || node.kind !== "MatchRegion") {
				return opaque
			}
			return own(fixedOf(corr.expr, regionLocals(props.node.id, node)) ?? { kind: "expr" })
		}
		case "equal": {
			const [from] = d.from
			return from === undefined ? opaque : { kind: "column", column: from }
		}
		case "match": {
			if (node.kind !== "MatchRegion") {
				return opaque
			}
			const occurrence = node.occurrences.find((o) => o.id === rule.occurrence)
			const binding = occurrence?.bindings.find((b) => b.var.name === column)
			if (occurrence === undefined || binding === undefined) {
				return opaque
			}
			const constant = occurrence.constants.find((k) => k.column === binding.column)
			if (constant !== undefined) {
				return own(fixedOf(constant.expr, regionLocals(props.node.id, node)) ?? { kind: "expr" })
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
				return opaque
			}
			const out = node.out.find((o) => o.name === column)
			if (out === undefined) {
				return opaque
			}
			const input = node.input.node.id
			const copied = localColumn(out.expr, input)
			return copied === undefined
				? own(fixedOf(out.expr, new Set([input])) ?? { kind: "expr" })
				: {
						kind: "input",
						input: node.input,
						column: copied,
						over: (derived) => projectionCloses(d.from, [column], derived)
					}
		}
		case "kept":
		case "grouped": {
			const input = inputOf(node, rule.input.node)
			const carry = rule.rule === "kept" ? rowsKeep : groupKeeps
			return input === undefined
				? opaque
				: { kind: "input", input, column, over: (derived) => carry(d.from, [column], derived) }
		}
		case "agreed":
			return node.kind === "Union" ? { kind: "arms", arms: unionArms(node.groups) } : opaque
		case "declared":
		case "group":
		case "atMostOne":
		case "distinct":
		case "produced":
		case "ranked":
		case "unionKey":
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
 * The names beside `held` that step `d` gives `column` of a node whose closure of nothing is `reached`, given the names
 * `namesOf` holds of its columns so far, each with its derivation: the closure's derivation of the step's determinants,
 * then the step, or the step like it over the input's derivation of each name it carries. A derivation that reaches the
 * column before its last step names it by that earlier step, and gives no name here.
 */
const stepNames = (
	props: Table,
	reached: Closure<Named>,
	d: Dependency,
	column: string,
	namesOf: (column: string) => ReadonlyArray<NamedValue>,
	held: ReadonlyArray<NamedValue>
): ReadonlyArray<NamedValue> => {
	const named = (
		name: Named,
		before: () => ReadonlyArray<Dependency>,
		step: () => Dependency
	): ReadonlyArray<NamedValue> => {
		if (held.some((h) => fixedEqual(h.name, name))) {
			return []
		}
		const steps = before()
		return steps.some((s) => s.to.includes(column))
			? []
			: [{ name, derivation: implication(props.node.id, [], [...steps, step()]) }]
	}
	const determinants = () => derivation(reached, d.from).steps
	const source = stepSource(props, d, column)
	switch (source.kind) {
		case "own": {
			const name = namedOf(source.value)
			return name === undefined ? [] : named(name, determinants, () => d)
		}
		case "column":
			return namesOf(source.column).flatMap((v) =>
				named(
					v.name,
					() => v.derivation.steps,
					() => d
				)
			)
		case "input":
			return (fixedNames(source.input, source.column) ?? []).flatMap((v) =>
				named(v.name, determinants, () => source.over(v.derivation))
			)
		case "arms":
			return commonNames(source.arms, column).flatMap((v) =>
				named(v.name, determinants, () => armsAgree(column, v.arms))
			)
	}
}

/**
 * The value a step fixes `column` to at a node: a literal, a parameter, an outer column, or a computation. A rule that
 * carries the column from an input reads the name its input's closure of nothing gives it (firstName), as the
 * derivation the rule carries does; a union's agreement reads the first name its arms share, as its derivations do; an
 * equality reads the value its other column holds, `named`, where the closure named one.
 */
const stepValue = (
	props: Table,
	d: Dependency,
	column: string,
	named: (column: string) => Fixed | undefined
): Fixed => {
	const source = stepSource(props, d, column)
	switch (source.kind) {
		case "own":
			return source.value
		case "column":
			return named(source.column) ?? { kind: "expr" }
		case "input":
			return firstName(source.input, source.column)
		case "arms":
			return commonNames(source.arms, column)[0]?.name ?? { kind: "expr" }
	}
}

/**
 * The value a fixed column holds by the witness that fixed it at the node `props` are of, a witness of the node's own: a
 * semi-join's pair carries the right side's (stepSource).
 */
const fixedWitnessValue = (
	props: Table,
	witness: Exclude<FixedWitness, { readonly kind: "semiJoinPair" }>,
	column: string
): Fixed => {
	const node = props.reading
	switch (witness.kind) {
		case "conjunct": {
			if (node.kind !== "Filter") {
				return { kind: "expr" }
			}
			const input = node.input.node.id
			const conjunct = conjuncts(node.pred).find((e) => e.id === witness.expr)
			const operands = conjunct === undefined ? undefined : equalityOperands(conjunct)
			const other = operands?.find((o) => localColumn(o, input) !== column)
			return other === undefined
				? { kind: "expr" }
				: (fixedOf(other, new Set([input])) ?? { kind: "expr" })
		}
		case "closedValue": {
			if (node.kind !== "Closed") {
				return { kind: "expr" }
			}
			const i = node.heading.findIndex((h) => h.name === column)
			const literal = node.rows[0]?.[i]
			return literal === undefined
				? { kind: "expr" }
				: { kind: "literal", literal, key: nativeEqualityKey(literal) }
		}
		case "takeCorrelation": {
			const corr = node.kind === "Take" ? node.correlation[witness.index] : undefined
			return corr === undefined || node.kind !== "Take"
				? { kind: "expr" }
				: (fixedOf(corr.expr, new Set([node.input.node.id])) ?? { kind: "expr" })
		}
		case "attachCorrelation": {
			const attach = props.attachment
			const pair = attach?.id === witness.attach ? attach.correlation[witness.index] : undefined
			return pair === undefined || attach === undefined
				? { kind: "expr" }
				: { kind: "outer", node: attach.parent.id, column: pair.parent }
		}
	}
}

/** The nodes a region's own expressions read: its heading and its occurrences' sources. */
const regionLocals = (region: NodeId, reading: ReadingOf<"MatchRegion">): ReadonlySet<NodeId> =>
	new Set<NodeId>([region, ...reading.occurrences.map((o) => o.source.node.id)])

/** The determinants a parent may carry from a node: nothing (its fixed columns), each dependency's, and each key. */
const determinantsOf = (props: Props): ReadonlyArray<KeySet> => {
	const seen = new Set<string>()
	const out: Array<KeySet> = []
	for (const d of [[], ...props.dependencies.map((x) => x.from), ...props.keys.map((k) => k.key)]) {
		const text = inHeadingOrder(props.columns, d).join("\u0000")
		if (!seen.has(text)) {
			seen.add(text)
			out.push(d)
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
 * projection's copies of input columns equal so, or a kept input's columns equal so, which a union reads in every arm
 * (ir/keys.ts); or by determination, a group's keys of one input class, a match's variables bound to one source class,
 * a correlated variable copying another.
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
const pathOf = (
	props: Pick<Props, "node" | "forest">,
	a: string,
	b: string
): EqualPath | undefined => {
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
			props.node.id,
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
const sameColumn = (node: NodeId, column: string): EqualPath => ({
	by: "equalities",
	derivation: implication(node, [column], [])
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
 * The dependencies a node keeps from an input whose rows it keeps, over the input columns it carries under the same
 * names (`carried`): each input determinant whose columns are carried, fixed, or of a class a carried column stands
 * for, determining the carried columns of the closure in the input of the carried columns standing for it, by `rule`.
 */
const carried = (
	input: Props,
	carriedColumn: (column: string) => boolean,
	rule: (from: KeySet, to: KeySet, input: Implication) => Dependency
): ReadonlyArray<Dependency> => {
	const fixed = new Set(fixedColumns(input))
	return determinantsOf(input).flatMap((d) => {
		const from: Array<string> = []
		for (const c of d) {
			const stand = carriedColumn(c)
				? c
				: fixed.has(c)
					? undefined
					: classOf(input, c).find(carriedColumn)
			if (stand === undefined && !fixed.has(c)) {
				return []
			}
			if (stand !== undefined && !from.includes(stand)) {
				from.push(stand)
			}
		}
		const reached = closureOf(input, from)
		const to = [...reached.columns.keys()].filter((c) => carriedColumn(c) && !from.includes(c))
		return to.length === 0 ? [] : [rule(from, to, derivation(reached, to))]
	})
}

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
type Subject = Pick<Props, "node" | "reading" | "attachment">

/**
 * The props of `node` stating `dependencies`, its keys derived from them.
 *
 * The keys are searched over the classes' representatives (classesIn): a minimal key holds at most one column of a
 * class, and another column of the class in its place gives another, so the representatives' minimal keys under the
 * dependencies, each read through the classes, are every minimal key, one per class key. k pairs of equal columns
 * over a key of their first columns give one key, where every choice of a column per pair would give 2^k.
 */
const finish = (subject: Subject, dependencies: ReadonlyArray<Dependency>, rest: Rest): Props => {
	const { node } = subject
	const columns = node.heading.map((c) => c.name)
	const heading = new Set(columns)
	const table: Table = {
		node,
		reading: subject.reading,
		attachment: subject.attachment,
		columns,
		dependencies: dependencies.filter((d) => d.from.every((c) => heading.has(c)))
	}
	const forest = forestOf(columns, rest.equal)
	const classes = classesIn(columns, forest)
	/** Each other column of a key column's class, in heading order, with its path to the key column. */
	const membersOf = (key: KeySet): ReadonlyArray<KeyMember> =>
		key.flatMap((k) =>
			columns.flatMap((m) => {
				const path = m === k || key.includes(m) ? undefined : pathOf({ node, forest }, m, k)
				return path === undefined ? [] : [keyMember(k, m, path.derivation)]
			})
		)
	/**
	 * The closure of `key` and the key it reaches: the whole heading, or the first kept input's key it covers for rows
	 * of several heading groups; undefined where it reaches none.
	 */
	const reachOf = (key: KeySet): Reach | undefined => {
		const reached = coverOf(table, key)
		if (rest.discriminant.length === 0) {
			return covers(reached, columns) ? { kind: "rows", reached } : undefined
		}
		const inner = rest.inner.find((k) => covers(reached, k.key))
		return inner === undefined ? undefined : { kind: "within", reached, inner }
	}
	/** The proof of `key` from the key its closure reaches. */
	const proofOf = (key: KeySet, reach: Reach): KeyProof =>
		reach.kind === "rows"
			? rowsKey(node.id, key, derivation(reach.reached, columns), membersOf(key))
			: keyWithin(
					node.id,
					key,
					derivation(reach.reached, reach.inner.key),
					reach.inner,
					membersOf(key)
				)
	const prove = (cs: ReadonlyArray<string>): KeyProof | undefined => {
		const key = inHeadingOrder(columns, cs)
		const reach = reachOf(key)
		return reach === undefined ? undefined : proofOf(key, reach)
	}
	/** The closure of the whole heading reaches every column of it. */
	const whole = (): WholeKey =>
		rest.discriminant.length === 0
			? { kind: "set", key: proofOf(columns, { kind: "rows", reached: coverOf(table, columns) }) }
			: { kind: "groups" }
	const representatives = columns.filter((c) => classes.get(c)?.[0] === c)
	/** The representatives of the classes of the heading's columns among `cs`. */
	const represented = (cs: Iterable<string>): KeySet =>
		inHeadingOrder(
			representatives,
			[...cs].flatMap((c) => {
				const members = classes.get(c)
				return members === undefined ? [] : [members[0]]
			})
		)
	const seeds =
		rest.discriminant.length === 0 ? [representatives] : rest.inner.map((k) => represented(k.key))
	const exchange = table.dependencies.map((d) => ({
		from: represented(d.from),
		to: new Set(represented(d.to))
	}))
	const keys = minimalKeys(
		representatives,
		seeds,
		(cs) => reachOf(inHeadingOrder(columns, cs)),
		exchange
	).map(({ key, witness }) => proofOf(key, witness))
	const atMostOne = keys.some((k) => k.key.length === 0)
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
		fixed: fixedOver(table)
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
	equal: keptEqualities(input, (c) => node.heading.some((h) => h.name === c))
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
		const cx = localColumn(x, input)
		const cy = localColumn(y, input)
		if (cx !== undefined && cy !== undefined) {
			if (cx !== cy) {
				const stated = statedEquality(cx, cy, { kind: "conjunct", expr: c })
				out.push(stated.there, stated.back)
				equal.push(stated)
			}
			continue
		}
		if (cx !== undefined && fixedOf(y, locals) !== undefined) {
			out.push(fixedColumn(cx, { kind: "conjunct", expr: c }))
		}
		if (cy !== undefined && fixedOf(x, locals) !== undefined) {
			out.push(fixedColumn(cy, { kind: "conjunct", expr: c }))
		}
	}
	return { dependencies: out, equal }
}

/**
 * A view's dependencies: each of its keys determines the row, and each member of a key's class and the key column it
 * stands for determine each other, both columns of the view's heading.
 */
const viewDependencies = (keys: ReadonlyArray<ViewKey>, all: KeySet): Stated => {
	const out: Array<Dependency> = keys.map((k) => declaredKey(k.fields, all, k.premises, k.context))
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
 * The logical properties of a node from its inputs': `reading` is the node with each input replaced by that input's
 * properties (ir/dag.ts edgeValues). A world relation's facts are a view's, read under the view's name, which may be a
 * base relation's: no containment between stored facts speaks of them.
 */
export const logicalPropsOf = (node: RelNode, reading: PropsReading, env: PropsEnv): Props => {
	const subject: Subject = { node, reading, attachment: undefined }
	const all = node.heading.map((c) => c.name)
	/** The rest of a node's props that delivers its rows as one group, with no discriminant and no inner group. */
	const oneGroup = (rest: Omit<Rest, "discriminant" | "inner">): Rest => ({
		...rest,
		discriminant: [],
		inner: []
	})
	switch (reading.kind) {
		case "Base": {
			const relation = reading.relation
			const stated: Stated =
				reading.relationKind === "relation"
					? {
							dependencies: [reading.primaryKey, ...reading.keys].map((k, i) =>
								declaredKey(k, all, [storedKeyPremise(relation, k, i === 0)], "immediate")
							),
							equal: []
						}
					: viewDependencies(env.keyedViews ? reading.view : [], all)
			const occurrence = reading.occurrence
			return finish(
				subject,
				stated.dependencies,
				oneGroup({
					exactlyOne: false,
					provenance:
						reading.relationKind === "world"
							? noProvenance
							: (c) => [{ scan: occurrence, relation, field: c }],
					context: "immediate",
					equal: stated.equal
				})
			)
		}
		case "Context":
			return finish(
				subject,
				[atMostOneRow(all, { kind: "context" })],
				oneGroup({ exactlyOne: false, provenance: noProvenance, context: "descriptor", equal: [] })
			)
		case "Closed": {
			const rows = reading.rows
			const deps: Array<Dependency> =
				rows.length <= 1 ? [atMostOneRow(all, { kind: "singleFact" })] : []
			for (const [i, c] of all.entries()) {
				const values = closedColumn(reading, i).map((v) => nativeEqualityKey(v))
				if (new Set(values).size === values.length) {
					deps.push(distinctColumn(c, all))
				}
				if (values.length > 0 && new Set(values).size === 1) {
					deps.push(fixedColumn(c, { kind: "closedValue" }))
				}
			}
			return finish(
				subject,
				deps,
				oneGroup({
					exactlyOne: rows.length === 1,
					provenance: noProvenance,
					context: "descriptor",
					equal: []
				})
			)
		}
		case "InputSet":
			return reading.input.kind === "row"
				? finish(
						subject,
						[atMostOneRow(all, { kind: "row" })],
						oneGroup({
							exactlyOne: true,
							provenance: noProvenance,
							context: "descriptor",
							equal: []
						})
					)
				: finish(
						subject,
						[],
						oneGroup({
							exactlyOne: false,
							provenance: noProvenance,
							context: "queryLocal",
							equal: []
						})
					)
		case "Recursive":
		case "SelfRef": {
			const inputs: ReadonlyArray<Props> =
				reading.kind === "Recursive" ? [reading.base, reading.step] : []
			return finish(
				subject,
				[],
				oneGroup({
					exactlyOne: false,
					provenance: noProvenance,
					context: strongest(inputs.map((p) => p.context)),
					equal: []
				})
			)
		}
		case "Delta": {
			const relation = reading.relation
			const deps = reading.keys.map((k, i) =>
				declaredKey(k, all, [storedKeyPremise(relation, k, i === 0)], "immediate")
			)
			return finish(
				subject,
				deps,
				oneGroup({
					exactlyOne: false,
					provenance: noProvenance,
					context: deps.length > 0 ? "immediate" : "queryLocal",
					equal: []
				})
			)
		}
		case "MatchRegion":
			return regionProps(subject, reading, env)
		case "Filter": {
			const input = reading.input
			const filtered = filterDependencies(reading)
			const rest = keptRest(reading, input, input.context)
			return finish(subject, [...carried(input, () => true, rowsKeep), ...filtered.dependencies], {
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
			const deps: Array<Dependency> = [...carried(left, () => true, rowsKeep)]
			if (reading.kind === "SemiJoin") {
				/** A left column paired with a right column the right side fixes is fixed too, by the pair. */
				const rightFixed = closureOf(right, [])
				appendAll(
					deps,
					reading.on.flatMap((pair, index) =>
						rightFixed.columns.has(pair.right)
							? [
									fixedColumn(pair.left, {
										kind: "semiJoinPair",
										index,
										right: derivation(rightFixed, [pair.right])
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
			const deps = [...carried(left, () => true, rowsKeep), ...carried(right, () => true, rowsKeep)]
			const rest = keptRest(reading, left, strongest([left.context, right.context]))
			return finish(subject, deps, {
				...rest,
				equal: [...rest.equal, ...keptEqualities(right, (c) => all.includes(c))]
			})
		}
		case "Union":
			return unionProps(subject, reading)
		case "Take": {
			/** The take ranks the rows its correlation restricts its input to, so its card is theirs, bounded. */
			const input = reading.input
			const locals = new Set([input.node.id])
			const deps: Array<Dependency> = [
				...carried(input, () => true, rowsKeep),
				...reading.correlation.flatMap((c, index) =>
					fixedOf(c.expr, locals) !== undefined
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
			const deps = [
				...carried(input, (c) => groupKeys.includes(c), groupKeeps),
				groupKey(groupKeys, all)
			]
			return finish(
				subject,
				deps,
				oneGroup({
					exactlyOne: input.card === "one",
					/** An aggregate output carries none of the facts of an input column it may share a name with. */
					provenance: (c) => (groupKeys.includes(c) ? provenanceOf(input, c) : []),
					context: input.context,
					equal: inputEqualities(
						input,
						(c) => groupKeys.includes(c),
						(from, to, path) => groupKeeps([from], [to], path),
						() => "determination"
					)
				})
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
			const deps: Array<Dependency> = [...carried(input, inCarried, rowsKeep), ...produced]
			return finish(
				subject,
				deps,
				oneGroup({
					exactlyOne: false,
					provenance: (c) => (inCarried(c) ? provenanceOf(input, c) : []),
					context: input.context,
					equal: keptEqualities(input, inCarried)
				})
			)
		}
		case "ApproximateNearest":
		case "OrderedResult":
		case "Window": {
			const input = reading.kind === "ApproximateNearest" ? reading.source : reading.input
			const deps: Array<Dependency> = [
				...carried(input, (c) => input.columns.includes(c), rowsKeep)
			]
			if (reading.kind === "ApproximateNearest" && reading.take === 1n) {
				deps.push(atMostOneRow(all, { kind: "nearestOne" }))
			}
			const windowOut = reading.kind === "Window" ? reading.out : undefined
			if (windowOut !== undefined) {
				deps.push(windowValue(input.columns, windowOut))
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
			return finish(
				subject,
				carried(input, () => true, rowsKeep),
				{
					...keptRest(reading, input, strongest([input.context, ...others.map((o) => o.context)])),
					exactlyOne: input.card === "one"
				}
			)
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
	const bound: Array<{ readonly v: string; readonly provenance: ReadonlyArray<Provenance> }> = []
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
		const varsAt = new Map<string, Array<string>>()
		for (const b of o.bindings) {
			const v = b.var.name
			bound.push({
				v,
				provenance:
					sourceNode.kind === "Base"
						? [{ scan: o.id, relation: sourceNode.relation, field: b.column }]
						: provenanceOf(src, b.column)
			})
			if (!heading.has(v)) {
				continue
			}
			const at = varsAt.get(b.column) ?? []
			const [first] = at
			if (first !== undefined && first !== v) {
				const e = statedEquality(first, v, {
					kind: "sharedColumn",
					occurrence: o.id,
					column: b.column
				})
				deps.push(e.there, e.back)
				equal.push(e)
			}
			at.push(v)
			varsAt.set(b.column, at)
		}
		const lateral = refsTo(env.scope(sourceNode).outer, locals)
		if (lateral.length === 0) {
			appendAll(equal, sourceEqualities(src, o.id, varsAt))
		}
		const reads = lateral.length === 0 ? [] : varsOf(lateral)
		if (reads === undefined) {
			continue
		}
		/** What a constant's source column follows from: nothing when it reads no region column, else those variables. */
		const constant = new Map<string, ReadonlyArray<string> | undefined>(
			o.constants.map((k) => [
				k.column,
				fixedOf(k.expr, locals) !== undefined ? [] : varsOf(localRefs(k.expr, locals))
			])
		)
		const srcFixed = new Set(fixedColumns(src))
		/**
		 * What a determinant's source column is given by in the region: the variable bound to it, the variables its
		 * constant follows from, nothing for a column fixed in the source, or a column of its class the scan binds,
		 * which stands for it; undefined when none of these holds.
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
				? undefined
				: { given: [member], from: [memberVar] }
		}
		for (const d of determinantsOf(src)) {
			const givens = d.map(givenBy)
			if (!givens.every((g) => g !== undefined)) {
				continue
			}
			const given = givens.flatMap((g) => g.given)
			const from = new Set<string>([...reads, ...givens.flatMap((g) => g.from)])
			const reached = closureOf(src, given)
			const targets = [...reached.columns.keys()].filter((c) => varsAt.has(c))
			const to = targets.flatMap((c) => varsAt.get(c) ?? []).filter((v) => !from.has(v))
			if (to.length > 0) {
				deps.push(matchBinds([...from], [...new Set(to)], o.id, derivation(reached, targets)))
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
		const reads = fixedOf(e, locals) !== undefined ? [] : varsOf(localRefs(e, locals))
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
		provenance: (c) => bound.flatMap((b) => (b.v === c ? b.provenance : [])),
		context: strongest(contexts),
		discriminant: [],
		inner: [],
		equal
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
 * A projection closes over its input: each input determinant whose columns the output keeps (copied, determined by a
 * copied column, or fixed), and each copying output alone, determines the outputs whose values its closure in the input
 * reaches, a copy of a reached column, or a computed or constant output reading only reached columns. So two copies of
 * one column, or of equal columns, determine each other.
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
		const col = localColumn(o.expr, inputId)
		if (col !== undefined) {
			copyOf.set(o.name, col)
			if (!copies.has(col)) {
				copies.set(col, o.name)
			}
			continue
		}
		reads.set(o.name, readColumns(o.expr, inputId))
	}
	const inputFixed = new Set(fixedColumns(input))
	/**
	 * The output standing for an input column: its copy, a copy of the first column of its class copied, or a copy of a
	 * column that determines it.
	 */
	const standFor = (c: string): string | undefined => {
		const copy = copies.get(c)
		if (copy !== undefined) {
			return copy
		}
		for (const m of classOf(input, c)) {
			const out = copies.get(m)
			if (out !== undefined) {
				return out
			}
		}
		for (const [col, out] of copies) {
			if (coverOf(input, [col]).columns.has(c)) {
				return out
			}
		}
		return undefined
	}
	/** The images of the input's determinants that the output keeps, then each copying output alone. */
	const images = determinantsOf(input).flatMap((d): ReadonlyArray<ReadonlyArray<string>> => {
		const from: Array<string> = []
		for (const c of d) {
			if (inputFixed.has(c)) {
				continue
			}
			const out = standFor(c)
			if (out === undefined) {
				return []
			}
			from.push(out)
		}
		return [from]
	})
	const deps: Array<Dependency> = []
	const seen = new Set<string>()
	for (const from of [...images, ...[...copyOf.keys()].map((o) => [o])]) {
		const ordered = inHeadingOrder(all, from)
		const text = ordered.join("\u0000")
		if (seen.has(text)) {
			continue
		}
		seen.add(text)
		const given = ordered.flatMap((o) => {
			const col = copyOf.get(o)
			return col === undefined ? [] : [col]
		})
		const reached = closureOf(input, given)
		const to = all.filter((o) => {
			if (ordered.includes(o)) {
				return false
			}
			const col = copyOf.get(o)
			return col !== undefined
				? reached.columns.has(col)
				: (reads.get(o) ?? []).every((c) => reached.columns.has(c))
		})
		if (to.length === 0) {
			continue
		}
		const needed = to.flatMap((o) => {
			const col = copyOf.get(o)
			return col !== undefined ? [col] : (reads.get(o) ?? [])
		})
		deps.push(projectionCloses(ordered, to, derivation(reached, needed)))
	}
	/**
	 * Copies of columns of one input class are equal, each two by the input's path between the columns they copy, none for
	 * copies of one column.
	 */
	const copying = [...copyOf]
	const equal: Array<Equality> = []
	for (const [i, [x, cx]] of copying.entries()) {
		for (const [y, cy] of copying.slice(i + 1)) {
			const there = cx === cy ? sameColumn(inputId, cx) : pathOf(input, cx, cy)
			const back = cx === cy ? sameColumn(inputId, cx) : pathOf(input, cy, cx)
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
		equal
	})
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
	/** The union proof of `cs`: every arm proves it, and every two arms are told apart on it. */
	const unionProof = (given: ReadonlyArray<string>): KeyProof | undefined => {
		const cs = inHeadingOrder(all, given)
		const proofs = everyArm(arms, (a) => a.prove(cs))
		if (proofs === undefined) {
			return undefined
		}
		const separations: Array<Separation> = []
		for (const [i, j, a, b] of pairs) {
			const s = separation(cs, i, j, a, b)
			if (s === undefined) {
				return undefined
			}
			separations.push(s)
		}
		return unionKey(subject.node.id, cs, proofs, separations)
	}
	const separators = all.filter((c) => arms.every((a) => literalAt(a, c) !== undefined))
	/**
	 * Each arm key within the heading, by any columns of its classes, with the separators: the minimization keeps the
	 * columns of its classes every arm proves.
	 */
	const candidates: Array<ReadonlyArray<string>> = arms.flatMap((a) =>
		a.keys.flatMap((k) =>
			keyIn(k, (c) => all.includes(c)) === undefined
				? []
				: [
						[
							...keyClasses(k)
								.flat()
								.filter((c) => all.includes(c)),
							...separators
						]
					]
		)
	)
	/** A union's keys rest on its arms' keys and its separators, not on a dependency table of its own. */
	const unionKeys = minimalKeys(all, candidates, unionProof, []).map((k) => k.witness)
	const [firstArm, ...laterArms] = arms
	const onlyArm = laterArms.length === 0 ? firstArm : undefined
	const rest: Rest = {
		exactlyOne: onlyArm?.card === "one",
		provenance: (c) => (onlyArm !== undefined ? provenanceOf(onlyArm, c) : []),
		context: strongest(arms.map((a) => a.context)),
		discriminant,
		inner: single ? [] : unionKeys,
		equal
	}
	return finish(
		subject,
		single ? [...deps, ...unionKeys.map((k) => unionKeyDetermines(k, all))] : deps,
		rest
	)
}

/**
 * An attachment's child relative to its parent: the child's dependencies with each correlated child column fixed per
 * parent row, so its keys are reduced by them.
 */
export const relativeProps = (child: Props, attach: NodeOf<"Attach">): Props =>
	finish(
		{ node: child.node, reading: child.reading, attachment: attach },
		[
			...child.dependencies,
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
			}))
		}
	)
