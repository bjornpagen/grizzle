import { appendAll } from "#compiler/core/array.ts"
import { compareText } from "#compiler/core/canonical.ts"
import type { ExprId, NodeId, OccurrenceId } from "#compiler/core/ids.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import {
	type EvidenceContext,
	type Grounds,
	type Premise,
	premiseText,
	strongest
} from "#compiler/ir/evidence.ts"
import type { DeclaredKey, HeadingColumn, KeySet } from "#compiler/ir/rel.ts"

/**
 * Keys as proofs.
 *
 * A key is a proof kept as a runtime value: the columns it is, the premises it rests on, the validity context those hold
 * in, and its derivation, built only by the constructors below, one per inference rule. The logical analysis
 * (logical/props.ts) is the search that finds them; a small kernel independent of it (test/support/keys/kernel.ts)
 * re-checks every derivation the compiler emits, in tests, by reading each rule's side condition off the DAG alone.
 *
 * A node states dependencies over its attributes: its heading, and the hidden attributes of its rows it does not
 * deliver, each an attribute of an input it reads, named by where it comes from (hiddenAttribute): `from` determines
 * `to`, by one rule. So a node embeds its inputs' dependencies whole, renamed, never a projection of them onto its
 * heading, which can need exponentially many dependencies: whether some columns determine others at a node is one
 * closure. A derivation that some attributes determine others at a node (an Implication) is the dependencies applied
 * in order, each one's determinants known by then. A key is a set of heading columns that determines the whole heading
 * of a node whose rows are distinct tuples of it (one heading group), or a proved key of a node of several heading
 * groups; a hidden attribute is never in a key.
 *
 * A key is over classes of equal columns. Columns equal in every row of a node, each determining the other, are one
 * class, and its first column in heading order is the class's representative. A minimal key holds at most one column of
 * a class, and putting another column of that class in its place gives another minimal key; so a proof states its key
 * by the representatives and lists, as its members, every other column of their classes with the derivation that it
 * determines the key column it stands for. k pairs of equal columns are one key, not 2^k.
 *
 * The rules:
 * - a declared key determines the row (a stored relation's primary key or key(), a Delta's, a view's inherited key),
 *   and a view's alternative columns and the key fields they stand for determine each other, beside the fields of
 *   the factors before theirs they need;
 * - a fixed column is determined by nothing (a filter's equality with a value fixed per evaluation, a closed column of
 *   one value, a take's correlation, a semi-join's pair whose right column is fixed, an attachment's correlation);
 * - equal columns determine each other (a filter's equality, a region's equality or shared column, a correlated copy,
 *   a view's key column and a column its definition makes equal to it, two union columns every arm makes equal, two
 *   closed columns holding one value in every fact, a region's variable bound to a column its lateral source fixes to
 *   a region column's value, and that column's variable);
 * - a correlated variable follows from the variables its expression reads;
 * - a match determines what it binds from its source's dependency;
 * - a projection closes over its input, its computed and constant outputs included;
 * - a group key determines the group, and a group keeps its input's dependencies among its key;
 * - a node keeping its input's rows keeps its input's dependencies;
 * - at most one row: nothing determines the row (a context, a closed relation of at most one fact, a take(1), a nearest
 *   one, a false conjunct);
 * - a closed column distinct across its facts determines the fact;
 * - a produced fact is determined by its input's carried key, and the produced span when there may be several;
 * - a window's input row determines its value, and a row number within its partition, with the partition, the row;
 * - a union column every arm fixes alike is fixed, two union columns equal in every arm are equal, and a union keeps
 *   what every arm proves where a discriminant tells any two arms apart.
 *
 * Two union columns are equal in every row only when they are equal in every row of every arm: that one determines
 * the other in every arm is not enough, since the arms may map one column's value to different values of the other. So
 * each arm's derivation that they are equal steps by equalities alone, from one column to the other: an equal
 * dependency of the arm, two outputs of a projection copying one input column or columns its input derives equal so,
 * a kept input's columns its input derives equal so, or a group's key columns its input derives equal so, every
 * group's key values being one input row's.
 */

/**
 * The name a node gives an attribute of its input it does not deliver under a name of its own: `scope` (the input's
 * label, or a region's occurrence) and the attribute. A projection, a group and a produce keep their input's hidden
 * attributes under their names, rows being their input's; a region names every source attribute it does not bind by its
 * occurrence, since two occurrences of one source are two rows. No declared name holds the separator.
 */
export const hiddenAttribute = (scope: string, attribute: string): string =>
	`${scope}\u0000${attribute}`

/** Whether an attribute is hidden: no column of a heading, an input's attribute a node holds without delivering it. */
export const isHidden = (attribute: string): boolean => attribute.includes("\u0000")

/** What fixes a column per evaluation. */
export type FixedWitness =
	| { readonly kind: "conjunct"; readonly expr: ExprId }
	| { readonly kind: "closedValue" }
	| { readonly kind: "takeCorrelation"; readonly index: number }
	| { readonly kind: "semiJoinPair"; readonly index: number; readonly right: Implication }
	| { readonly kind: "attachCorrelation"; readonly attach: NodeId; readonly index: number }

/**
 * What makes two columns equal. Two columns of a union are equal by `arms`: each arm's derivation, by equalities
 * alone, from the first to the second. Two columns of a closed relation are equal by `closedColumns` when every fact
 * holds one value in both. A region's variable bound to a column its lateral source fixes to a region column's value
 * equals that column's variable by `lateralFixed`: the occurrence, the source column, and the source's derivation from
 * nothing that fixes it, whose first step naming its value names the region column.
 */
export type EqualWitness =
	| { readonly kind: "conjunct"; readonly expr: ExprId }
	| { readonly kind: "regionEquality"; readonly index: number }
	| { readonly kind: "sharedColumn"; readonly occurrence: OccurrenceId; readonly column: string }
	| { readonly kind: "correlatedCopy"; readonly index: number }
	| { readonly kind: "viewMember" }
	| { readonly kind: "arms"; readonly arms: NonEmptyReadonlyArray<Implication> }
	| { readonly kind: "closedColumns" }
	| {
			readonly kind: "lateralFixed"
			readonly occurrence: OccurrenceId
			readonly column: string
			readonly fixed: Implication
	  }

/** Why a node has at most one row. */
export type AtMostOneWitness =
	| { readonly kind: "context" }
	| { readonly kind: "row" }
	| { readonly kind: "singleFact" }
	| { readonly kind: "takeOne" }
	| { readonly kind: "nearestOne" }
	| { readonly kind: "falseConjunct"; readonly expr: ExprId }

/** The inference rule a dependency is an instance of, with what its side condition reads. */
export type Rule =
	| {
			readonly rule: "declared"
			readonly premises: ReadonlyArray<Premise>
			readonly context: EvidenceContext
	  }
	| { readonly rule: "fixed"; readonly witness: FixedWitness }
	| { readonly rule: "equal"; readonly witness: EqualWitness }
	| { readonly rule: "correlated"; readonly index: number }
	| { readonly rule: "match"; readonly occurrence: OccurrenceId; readonly source: Implication }
	| { readonly rule: "projection"; readonly input: Implication }
	| { readonly rule: "group" }
	| { readonly rule: "grouped"; readonly input: Implication }
	| { readonly rule: "kept"; readonly input: Implication }
	| { readonly rule: "atMostOne"; readonly witness: AtMostOneWitness }
	| { readonly rule: "distinct" }
	| { readonly rule: "produced"; readonly input: KeyProof }
	| { readonly rule: "ranked" }
	| { readonly rule: "numbered" }
	| { readonly rule: "agreed"; readonly arms: NonEmptyReadonlyArray<Implication> }
	| { readonly rule: "unionKey"; readonly proof: KeyProof }
	| {
			readonly rule: "viewAlternative"
			readonly premises: ReadonlyArray<Premise>
			readonly context: EvidenceContext
	  }

/** A dependency a node states over its heading: `from` determines `to`, by `rule`. */
export interface Dependency {
	readonly from: KeySet
	readonly to: KeySet
	readonly rule: Rule
}

/**
 * That `from` determines more of node `node`'s columns: the dependencies applied in order, each one's determinants
 * among `from` and the columns the earlier ones determined. What it determines is `from` with every step's `to`.
 */
export interface Implication {
	readonly node: NodeId
	readonly from: KeySet
	readonly steps: ReadonlyArray<Dependency>
}

/** Two union arms told apart on a column: each fixes it, to literals that differ. */
export interface Separation {
	/** The arms' indexes in the union's arm order, the first the lower. */
	readonly arms: readonly [number, number]
	readonly column: string
	/** Each arm's derivation that the column is fixed, whose last step fixes it to a literal. */
	readonly fixed: readonly [Implication, Implication]
}

/** Why the key's columns are a key of the node. */
export type KeyBasis =
	| { readonly kind: "rows"; readonly implication: Implication }
	| {
			readonly kind: "union"
			readonly arms: NonEmptyReadonlyArray<KeyProof>
			readonly separations: ReadonlyArray<Separation>
	  }
	| { readonly kind: "within"; readonly implication: Implication; readonly inner: KeyProof }

/**
 * A proved key of node `node` of the checked DAG, in heading order: its derivation (`basis`, built rule by rule by the
 * constructors below) and the grounds the derivation rests on, collected from it once. The logical analysis builds it
 * (logical/props.ts), the consumers of a key take it (unique-index emission, db.get, db.page, attach deliveries, put
 * proofs, the lowering's rewrites), and the test kernel re-checks its derivation.
 *
 * A proof states every key of a product of factors at once (logical/closure.ts independentFactors): its factors
 * partition `key`, each factor's key one minimal key of it, and each factor lists its other minimal keys, the columns
 * that stand in place of its key, given the key columns of the factors before it. One minimal key of each factor, each
 * column then any column of its class (members), is a key, so k factors of two minimal keys each are one proof of k
 * alternatives, never 2^k proofs.
 *
 * Another key value exists, for an exact reason: a JustifiedKey (analysis/physical/fds.ts) is a key of a lowered SQL
 * fragment, proved over the fragment's physical dependencies, whose Justification adds what only that claim depends
 * on: multiplicity reasons, native equality operators, coercions and outer columns.
 */
export interface KeyProof extends Grounds {
	readonly node: NodeId
	readonly key: KeySet
	readonly basis: KeyBasis
	/**
	 * The other columns of the classes of the key's columns and of its alternatives' columns, by the column they stand
	 * for and then in heading order: each one, put in place of the column it stands for, gives a key of the same class.
	 * Its derivation is its grounds' too.
	 */
	readonly members: ReadonlyArray<KeyMember>
	/**
	 * The key's factors: their keys disjoint, together the key, each factor after the ones whose key columns its
	 * alternatives' derivations read. Their alternatives' derivations are the grounds' too.
	 */
	readonly factors: ReadonlyArray<KeyFactor>
}

/** A column equal to a column of a proof's keys: it determines that column, so it can stand for it. */
export interface KeyMember {
	/** The column it stands for: a key column or an alternative's. */
	readonly of: string
	readonly column: string
	/** The derivation, at the proof's node, that `column` determines `of`. */
	readonly determines: Implication
}

/**
 * One factor of a proof's key: its columns of the key, one minimal key of the factor given the key columns of the factors
 * before it, and its other minimal keys, each a key of the factor's own columns.
 */
export interface KeyFactor {
	readonly key: NonEmptyReadonlyArray<string>
	readonly alternatives: ReadonlyArray<KeyAlternative>
}

/**
 * Another minimal key of one factor of a proof's key: columns of the node that determine the factor, its key among it,
 * beside the key columns of the factors before it that their derivation reads, so the proof's key with them in place of
 * the factor's is a key.
 */
export interface KeyAlternative {
	readonly columns: KeySet
	/**
	 * The derivation, at the proof's node, that `columns`, with key columns of earlier factors, determine the factor and
	 * its key: from them, those columns first, what a parent closes over as one of the proof's determinants.
	 */
	readonly determines: Implication
}

/**
 * A column equal to a key column in every row, so it stands for that column in the key, as a key a view or a lowering
 * rewrite states lists it, without its derivation.
 */
export interface ClassMember {
	readonly of: string
	readonly column: string
}

/**
 * A key of a relation read as a view, with what it rests on: a derived relation's inherited key, whose premise is its
 * view's unique index, or a world relation's, whose premises are its definition's proof's. Its fields are its class
 * representatives, and its members the view's other columns of their classes, which its definition makes equal to them:
 * a column equal in every row of the definition is equal in every fact of the view.
 */
export interface ViewKey extends Grounds {
	readonly fields: DeclaredKey
	readonly members: ReadonlyArray<ClassMember>
	/**
	 * The other minimal keys of the key's factors, each with the fields it stands for, as its definition's proof lists them
	 * (KeyProof factors): what the definition derives of every row holds of every fact, on the derivation's grounds.
	 */
	readonly alternatives: ReadonlyArray<ViewAlternative>
}

/**
 * Columns of a view that, with the fields `of` they stand for, are two minimal keys of one factor of a key, so each,
 * beside the key's fields `given` of the factors before it, determines the other, on the grounds of the definition's
 * derivation.
 */
export interface ViewAlternative extends Grounds {
	readonly of: KeySet
	readonly columns: KeySet
	readonly given: KeySet
}

/**
 * A view as a Base over it reads it: its heading, its definition's, and its keys narrowest first, which the checker
 * stamps on the Base (rel.ts ViewBase).
 */
export interface ViewRead {
	readonly heading: NonEmptyReadonlyArray<HeadingColumn>
	readonly keys: ReadonlyArray<ViewKey>
}

/** Each column a member stands for, with the members standing for it, in their order. */
const standIns = (
	members: ReadonlyArray<ClassMember>
): ReadonlyMap<string, ReadonlyArray<string>> => {
	const out = new Map<string, Array<string>>()
	for (const m of members) {
		const held = out.get(m.of)
		if (held === undefined) {
			out.set(m.of, [m.column])
		} else {
			held.push(m.column)
		}
	}
	return out
}

/**
 * The columns of `key` that `holds` holds, each the key's own column or else its first member it holds; undefined when
 * some column has neither.
 */
const classKeyIn = (
	key: KeySet,
	members: ReadonlyMap<string, ReadonlyArray<string>>,
	holds: (column: string) => boolean
): KeySet | undefined => {
	const out: Array<string> = []
	for (const k of key) {
		const stand = holds(k) ? k : members.get(k)?.find(holds)
		if (stand === undefined) {
			return undefined
		}
		out.push(stand)
	}
	return out
}

/**
 * A proof's key as independent choices in key order, each its minimal keys: a factor of several minimal keys at its
 * first key column, its key's own first; and each column of a factor of one minimal key alone, chosen apart from the
 * others since one minimal key is the product of its columns.
 */
const choicesOf = (
	proof: Pick<KeyProof, "key" | "factors">
): ReadonlyArray<NonEmptyReadonlyArray<KeySet>> =>
	proof.factors
		.flatMap(
			(f): ReadonlyArray<{ readonly at: string; readonly keys: NonEmptyReadonlyArray<KeySet> }> =>
				f.alternatives.length === 0
					? f.key.map((c) => ({ at: c, keys: [[c]] }))
					: [{ at: f.key[0], keys: [f.key, ...f.alternatives.map((a) => a.columns)] }]
		)
		.toSorted((a, b) => proof.key.indexOf(a.at) - proof.key.indexOf(b.at))
		.map((choice) => choice.keys)

/**
 * A key of a proof whose columns `holds` holds: of each choice, its first minimal key whose columns, each itself or a
 * column of its class, `holds` holds; undefined when some choice has none.
 */
export const keyIn = (proof: KeyProof, holds: (column: string) => boolean): KeySet | undefined => {
	const members = standIns(proof.members)
	const out: Array<string> = []
	for (const choice of choicesOf(proof)) {
		const found = choice.map((k) => classKeyIn(k, members, holds)).find((k) => k !== undefined)
		if (found === undefined) {
			return undefined
		}
		appendAll(out, found)
	}
	return out
}

/** A key over classes of equal columns: each class's columns, its key column first. */
export type KeyClasses = ReadonlyArray<NonEmptyReadonlyArray<string>>

/**
 * A proof's keys over its choices and classes: each choice's minimal keys, its key's own first, each over its classes.
 * One minimal key of each choice, one column of each of its classes, together, are a key.
 */
export type KeyFactors = ReadonlyArray<NonEmptyReadonlyArray<KeyClasses>>

const classesOf = (key: KeySet, members: ReadonlyMap<string, ReadonlyArray<string>>): KeyClasses =>
	key.map((k): NonEmptyReadonlyArray<string> => [k, ...(members.get(k) ?? [])])

/** A proof's keys over its choices and classes (KeyFactors). */
export const keyFactors = (proof: KeyProof): KeyFactors => {
	const members = standIns(proof.members)
	return choicesOf(proof).map((choice) => mapNonEmpty(choice, (k) => classesOf(k, members)))
}

/**
 * The key with an alternative of one of its factors in place of that factor's key columns, in key order then its own:
 * a key one alternative away from the proof's.
 */
export const keyWith = (
	proof: Pick<KeyProof, "key">,
	factor: KeyFactor,
	alternative: KeyAlternative
): KeySet => [...proof.key.filter((c) => !factor.key.includes(c)), ...alternative.columns]

/** A proof's members without their derivations, as a view's key states them. */
export const classMembers = (proof: KeyProof): ReadonlyArray<ClassMember> =>
	proof.members.map((m) => Object.freeze({ of: m.of, column: m.column }))

/**
 * A proof's factors' alternatives as a view's key states them, each with the factor's key it stands for: on the proof's
 * grounds, which hold their derivations.
 */
export const viewAlternatives = (proof: KeyProof): ReadonlyArray<ViewAlternative> =>
	proof.factors.flatMap((f) =>
		f.alternatives.map((a) =>
			Object.freeze({
				of: f.key,
				columns: a.columns,
				given: a.determines.from.filter((c) => !a.columns.includes(c)),
				premises: proof.premises,
				context: proof.context
			})
		)
	)

const dependency = (from: KeySet, to: KeySet, rule: Rule): Dependency =>
	Object.freeze({ from, to, rule })

/** A declared key determines the row. */
export const declaredKey = (
	key: KeySet,
	heading: KeySet,
	premises: ReadonlyArray<Premise>,
	context: EvidenceContext
): Dependency => dependency(key, heading, { rule: "declared", premises, context })

/**
 * A view's alternative columns and the key fields they stand for, two minimal keys of one factor, determine each other
 * beside the fields of the factors before it they need, on its definition's grounds: each way, so a Base over the view
 * holds each factor's keys apart from the others'.
 */
export const viewAlternative = (
	alternative: ViewAlternative
): readonly [Dependency, Dependency] => {
	const rule: Rule = {
		rule: "viewAlternative",
		premises: alternative.premises,
		context: alternative.context
	}
	return [
		dependency([...alternative.columns, ...alternative.given], alternative.of, rule),
		dependency([...alternative.of, ...alternative.given], alternative.columns, rule)
	]
}

/** A fixed column is determined by nothing. */
export const fixedColumn = (column: string, witness: FixedWitness): Dependency =>
	dependency([], [column], { rule: "fixed", witness })

/** Equal columns determine each other: `a` determines `b`. */
export const equalColumns = (a: string, b: string, witness: EqualWitness): Dependency =>
	dependency([a], [b], { rule: "equal", witness })

/** A correlated variable follows from the region variables its expression reads. */
export const correlatedVariable = (reads: KeySet, variable: string, index: number): Dependency =>
	dependency(reads, [variable], { rule: "correlated", index })

/** A match determines what it binds from its source's dependency. */
export const matchBinds = (
	from: KeySet,
	to: KeySet,
	occurrence: OccurrenceId,
	source: Implication
): Dependency => dependency(from, to, { rule: "match", occurrence, source })

export const projectionCloses = (from: KeySet, to: KeySet, input: Implication): Dependency =>
	dependency(from, to, { rule: "projection", input })

/** A group key determines the group. */
export const groupKey = (keys: KeySet, heading: KeySet): Dependency =>
	dependency(keys, heading, { rule: "group" })

/** A group keeps its input's dependencies among its key. */
export const groupKeeps = (from: KeySet, to: KeySet, input: Implication): Dependency =>
	dependency(from, to, { rule: "grouped", input })

/** A node keeping its input's rows keeps its input's dependencies. */
export const rowsKeep = (from: KeySet, to: KeySet, input: Implication): Dependency =>
	dependency(from, to, { rule: "kept", input })

/** At most one row: nothing determines the row. */
export const atMostOneRow = (heading: KeySet, witness: AtMostOneWitness): Dependency =>
	dependency([], heading, { rule: "atMostOne", witness })

/** A closed column distinct across its facts determines the fact. */
export const distinctColumn = (column: string, heading: KeySet): Dependency =>
	dependency([column], heading, { rule: "distinct" })

/** A produced fact is determined by its input's carried key, and its produced span when there may be several. */
export const producedFact = (from: KeySet, heading: KeySet, input: KeyProof): Dependency =>
	dependency(from, heading, { rule: "produced", input })

/** A window's input row determines its value. */
export const windowValue = (inputHeading: KeySet, out: string): Dependency =>
	dependency(inputHeading, [out], { rule: "ranked" })

/** A row number within its partition, with the partition, determines the row it numbers. */
export const numberedRow = (partition: KeySet, out: string, heading: KeySet): Dependency =>
	dependency([...partition, out], heading, { rule: "numbered" })

/** A union column every arm fixes alike is fixed. */
export const armsAgree = (column: string, arms: NonEmptyReadonlyArray<Implication>): Dependency =>
	dependency([], [column], { rule: "agreed", arms })

/** A union's key determines its row. */
export const unionKeyDetermines = (proof: KeyProof, heading: KeySet): Dependency =>
	dependency(proof.key, heading, { rule: "unionKey", proof })

/** The derivation that `from` determines more columns of `node` by `steps`. */
export const implication = (
	node: NodeId,
	from: KeySet,
	steps: ReadonlyArray<Dependency>
): Implication => Object.freeze({ node, from, steps: Object.freeze([...steps]) })

/**
 * The context an at-most-one witness holds in by itself: a session's one fact, a membership's one row and a closed
 * relation of one fact are the query's own facts, which hold wherever it runs; a take or a search of one, and a false
 * conjunct, hold by the query alone as well, which the rule's premises state.
 */
const atMostOneContext = (witness: AtMostOneWitness): EvidenceContext | undefined => {
	switch (witness.kind) {
		case "context":
		case "row":
		case "singleFact":
			return "queryLocal"
		case "takeOne":
		case "nearestOne":
		case "falseConjunct":
			return undefined
	}
}

/**
 * The context a rule holds in by itself: a closed relation's facts (its distinct, fixed and equal columns), a session's
 * one fact and a membership's one row are the query's own facts, which hold wherever it runs.
 */
const ruleContext = (rule: Rule): EvidenceContext | undefined => {
	switch (rule.rule) {
		case "declared":
		case "viewAlternative":
			return rule.context
		case "distinct":
			return "queryLocal"
		case "atMostOne":
			return atMostOneContext(rule.witness)
		case "fixed":
			return rule.witness.kind === "closedValue" ? "queryLocal" : undefined
		case "equal":
			return rule.witness.kind === "closedColumns" ? "queryLocal" : undefined
		case "correlated":
		case "match":
		case "projection":
		case "group":
		case "grouped":
		case "kept":
		case "produced":
		case "ranked":
		case "numbered":
		case "agreed":
		case "unionKey":
			return undefined
	}
}

/** What a proof object rests on, collected once per object. */
interface Collected {
	readonly premises: Map<string, Premise>
	readonly contexts: Array<EvidenceContext>
	readonly seen: Set<object>
}

const groundImplication = (g: Collected, at: Implication): void => {
	if (g.seen.has(at)) {
		return
	}
	g.seen.add(at)
	for (const step of at.steps) {
		groundRule(g, step.rule)
	}
}

const groundProof = (g: Collected, proof: KeyProof): void => {
	if (g.seen.has(proof)) {
		return
	}
	g.seen.add(proof)
	for (const p of proof.premises) {
		g.premises.set(premiseText(p), p)
	}
	g.contexts.push(proof.context)
}

const groundRule = (g: Collected, rule: Rule): void => {
	const context = ruleContext(rule)
	if (context !== undefined) {
		g.contexts.push(context)
	}
	switch (rule.rule) {
		case "declared":
		case "viewAlternative":
			for (const p of rule.premises) {
				g.premises.set(premiseText(p), p)
			}
			return
		case "fixed":
			if (rule.witness.kind === "semiJoinPair") {
				groundImplication(g, rule.witness.right)
			}
			return
		case "equal":
			if (rule.witness.kind === "arms") {
				for (const arm of rule.witness.arms) {
					groundImplication(g, arm)
				}
			}
			if (rule.witness.kind === "lateralFixed") {
				groundImplication(g, rule.witness.fixed)
			}
			return
		case "match":
			groundImplication(g, rule.source)
			return
		case "projection":
		case "grouped":
		case "kept":
			groundImplication(g, rule.input)
			return
		case "produced":
			groundProof(g, rule.input)
			return
		case "agreed":
			for (const arm of rule.arms) {
				groundImplication(g, arm)
			}
			return
		case "unionKey":
			groundProof(g, rule.proof)
			return
		case "correlated":
		case "group":
		case "atMostOne":
		case "distinct":
		case "ranked":
		case "numbered":
			return
	}
}

/** A proof of `key` at `node` on `basis`, with its members, its premises and context those of their derivations. */
const proved = (
	node: NodeId,
	key: KeySet,
	basis: KeyBasis,
	members: ReadonlyArray<KeyMember>,
	factors: ReadonlyArray<KeyFactor>
): KeyProof => {
	const g: Collected = { premises: new Map(), contexts: [], seen: new Set() }
	for (const m of members) {
		groundImplication(g, m.determines)
	}
	for (const f of factors) {
		for (const a of f.alternatives) {
			groundImplication(g, a.determines)
		}
	}
	switch (basis.kind) {
		case "rows":
			groundImplication(g, basis.implication)
			break
		case "union":
			for (const arm of basis.arms) {
				groundProof(g, arm)
			}
			for (const s of basis.separations) {
				groundImplication(g, s.fixed[0])
				groundImplication(g, s.fixed[1])
			}
			break
		case "within":
			groundImplication(g, basis.implication)
			groundProof(g, basis.inner)
			break
	}
	const premises = [...g.premises].toSorted(([a], [b]) => compareText(a, b)).map(([, p]) => p)
	return Object.freeze({
		node,
		key: Object.freeze([...key]),
		premises: Object.freeze(premises),
		context: strongest(g.contexts),
		basis,
		members: Object.freeze([...members]),
		factors: Object.freeze([...factors])
	})
}

/** A column that stands for key column `of`: `determines` derives `of` from it. */
export const keyMember = (of: string, column: string, determines: Implication): KeyMember =>
	Object.freeze({ of, column, determines })

/** Another minimal key of a factor: `columns`, which `determines` derives the factor from, beside earlier key columns. */
export const keyAlternative = (columns: KeySet, determines: Implication): KeyAlternative =>
	Object.freeze({ columns, determines })

/** A factor of a proof's key: its key columns and its other minimal keys. */
export const keyFactor = (
	key: NonEmptyReadonlyArray<string>,
	alternatives: ReadonlyArray<KeyAlternative>
): KeyFactor => Object.freeze({ key, alternatives: Object.freeze([...alternatives]) })

/** A key no factor search split: one factor of one minimal key, the key itself, and none for the empty key. */
export const soleFactor = (key: KeySet): ReadonlyArray<KeyFactor> =>
	isNonEmpty(key) ? [keyFactor(key, [])] : []

/** A key of a node of one heading group: `key`, its factors' keys together, determines its heading. */
export const rowsKey = (
	node: NodeId,
	key: KeySet,
	determines: Implication,
	members: ReadonlyArray<KeyMember>,
	factors: ReadonlyArray<KeyFactor>
): KeyProof => proved(node, key, { kind: "rows", implication: determines }, members, factors)

/**
 * A key of a union: every arm proves it, and every two arms are told apart on it. It lists no members: the union's keys
 * over its classes, the columns every arm makes equal, are proved from it at the union.
 */
export const unionKey = (
	node: NodeId,
	key: KeySet,
	arms: NonEmptyReadonlyArray<KeyProof>,
	separations: ReadonlyArray<Separation>
): KeyProof => proved(node, key, { kind: "union", arms, separations }, [], soleFactor(key))

/** A key of a node of several heading groups: `key` determines `inner`, a key of it or of the input it keeps. */
export const keyWithin = (
	node: NodeId,
	key: KeySet,
	determines: Implication,
	inner: KeyProof,
	members: ReadonlyArray<KeyMember>
): KeyProof =>
	proved(node, key, { kind: "within", implication: determines, inner }, members, soleFactor(key))
