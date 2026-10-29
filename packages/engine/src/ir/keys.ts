import { compareText } from "#compiler/core/canonical.ts"
import { ExprId, NodeId, OccurrenceId } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import {
	type EvidenceContext,
	evidenceContextShape,
	type Grounds,
	type Premise,
	premiseShape,
	premiseText,
	strongest
} from "#compiler/ir/evidence.ts"
import type { DeclaredKey, HeadingColumn, KeySet } from "#compiler/ir/rel.ts"
import * as S from "#compiler/ir/shape.ts"

/**
 * Keys as proofs.
 *
 * A key is a proof kept as a runtime value: the columns it is, the premises it rests on, the validity context those hold
 * in, and its derivation, built only by the constructors below, one per inference rule. The logical analysis
 * (logical/props.ts) is the search that finds them; a small kernel independent of it (test/support/keys/kernel.ts)
 * re-checks every derivation the compiler emits, in tests, by reading each rule's side condition off the DAG alone.
 *
 * A node states dependencies over its own heading: `from` determines `to`, by one rule. A derivation that some columns
 * determine others at a node (an Implication) is the dependencies applied in order, each one's determinants known by
 * then. A key is a set of columns that determines the whole heading of a node whose rows are distinct tuples of it (one
 * heading group), or a proved key of a node of several heading groups.
 *
 * A key is over classes of equal columns. Columns equal in every row of a node, each determining the other, are one
 * class, and its first column in heading order is the class's representative. A minimal key holds at most one column of
 * a class, and putting another column of that class in its place gives another minimal key; so a proof states its key
 * by the representatives and lists, as its members, every other column of their classes with the derivation that it
 * determines the key column it stands for. k pairs of equal columns are one key, not 2^k.
 *
 * The rules:
 * - a declared key determines the row (a stored relation's primary key or key(), a Delta's, a view's inherited key);
 * - a fixed column is determined by nothing (a filter's equality with a value fixed per evaluation, a closed column of
 *   one value, a take's correlation, a semi-join's pair whose right column is fixed, an attachment's correlation);
 * - equal columns determine each other (a filter's equality, a region's equality or shared column, a correlated copy,
 *   a view's key column and a column its definition makes equal to it, two union columns every arm makes equal);
 * - a correlated variable follows from the variables its expression reads;
 * - a match determines what it binds from its source's dependency;
 * - a projection closes over its input, its computed and constant outputs included;
 * - a group key determines the group, and a group keeps its input's dependencies among its key;
 * - a node keeping its input's rows keeps its input's dependencies;
 * - at most one row: nothing determines the row (a context, a closed relation of at most one fact, a take(1), a nearest
 *   one, a false conjunct);
 * - a closed column distinct across its facts determines the fact;
 * - a produced fact is determined by its input's carried key, and the produced span when there may be several;
 * - a window's input row determines its value;
 * - a union column every arm fixes alike is fixed, two union columns equal in every arm are equal, and a union keeps
 *   what every arm proves where a discriminant tells any two arms apart.
 *
 * Two union columns are equal in every row only when they are equal in every row of every arm: that one determines
 * the other in every arm is not enough, since the arms may map one column's value to different values of the other. So
 * each arm's derivation that they are equal steps by equalities alone, from one column to the other: an equal
 * dependency of the arm, two outputs of a projection copying one input column or columns its input derives equal so,
 * or a kept input's columns its input derives equal so.
 */

/** What fixes a column per evaluation. */
export type FixedWitness =
	| { readonly kind: "conjunct"; readonly expr: ExprId }
	| { readonly kind: "closedValue" }
	| { readonly kind: "takeCorrelation"; readonly index: number }
	| { readonly kind: "semiJoinPair"; readonly index: number; readonly right: Implication }
	| { readonly kind: "attachCorrelation"; readonly attach: NodeId; readonly index: number }

/**
 * What makes two columns equal. Two columns of a union are equal by `arms`: each arm's derivation, by equalities
 * alone, from the first to the second.
 */
export type EqualWitness =
	| { readonly kind: "conjunct"; readonly expr: ExprId }
	| { readonly kind: "regionEquality"; readonly index: number }
	| { readonly kind: "sharedColumn"; readonly occurrence: OccurrenceId; readonly column: string }
	| { readonly kind: "correlatedCopy"; readonly index: number }
	| { readonly kind: "viewMember" }
	| { readonly kind: "arms"; readonly arms: NonEmptyReadonlyArray<Implication> }

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
	| { readonly rule: "agreed"; readonly arms: NonEmptyReadonlyArray<Implication> }
	| { readonly rule: "unionKey"; readonly proof: KeyProof }

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
 * proofs), and the test kernel re-checks its derivation.
 *
 * Two other key values exist, each for an exact reason. A lowering rewrite's KeyGrounds (lower/shapes/catalog) has no
 * derivation because two of its three sources have none: a stored relation's declared key rests on its installed
 * constraint, and a key a rewrite claims of a node it built rests on that rewrite's certificate. A JustifiedKey
 * (analysis/physical/fds.ts) is a key of a lowered SQL fragment, proved over the fragment's physical dependencies,
 * whose Justification adds what only that claim depends on: multiplicity reasons, native equality operators,
 * coercions and outer columns.
 */
export interface KeyProof extends Grounds {
	readonly node: NodeId
	readonly key: KeySet
	readonly basis: KeyBasis
	/**
	 * The other columns of the key columns' classes, by key column and then in heading order: each one, put in place of
	 * the key column it stands for, gives a key of the same class. Its derivation is its grounds' too.
	 */
	readonly members: ReadonlyArray<KeyMember>
}

/** A column equal to a key column of a proof's node: it determines that key column, so it can stand for it. */
export interface KeyMember {
	/** The key column it stands for. */
	readonly of: string
	readonly column: string
	/** The derivation, at the proof's node, that `column` determines `of`. */
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
}

/**
 * A view as a Base over it reads it: its heading, its definition's, and its keys narrowest first, which the checker
 * stamps on the Base (rel.ts ViewBase).
 */
export interface ViewRead {
	readonly heading: NonEmptyReadonlyArray<HeadingColumn>
	readonly keys: ReadonlyArray<ViewKey>
}

/**
 * The columns of the class of keys of `key` and `members` that `holds` holds, the key's own column or else its first
 * member, for every key column; undefined when some key column has neither. The key's own columns, the same list, when
 * it holds them all.
 */
const classKeyIn = (
	key: KeySet,
	members: ReadonlyArray<ClassMember>,
	holds: (column: string) => boolean
): KeySet | undefined => {
	if (key.every(holds)) {
		return key
	}
	const out: Array<string> = []
	for (const k of key) {
		const stand = holds(k) ? k : members.find((m) => m.of === k && holds(m.column))?.column
		if (stand === undefined) {
			return undefined
		}
		out.push(stand)
	}
	return out
}

/** The key of a proof's class whose columns `holds` holds: each key column, or else its first member it holds. */
export const keyIn = (proof: KeyProof, holds: (column: string) => boolean): KeySet | undefined =>
	classKeyIn(proof.key, proof.members, holds)

/** The key of a claimed key's class whose columns `holds` holds (keyIn). */
export const claimedKeyIn = (
	k: ClaimedKey,
	holds: (column: string) => boolean
): KeySet | undefined =>
	k.kind === "proved" ? keyIn(k.proof, holds) : classKeyIn(k.key, k.members, holds)

/** A key over classes of equal columns: each class's columns, its key column first. */
export type KeyClasses = ReadonlyArray<NonEmptyReadonlyArray<string>>

/**
 * A proof's key over its classes: each key column with its members, the key column first. One column of each class,
 * together, are a key.
 */
export const keyClasses = (proof: KeyProof): KeyClasses => classesOfKey(proof.key, proof.members)

/** A claimed key over its classes (keyClasses). */
export const claimedClasses = (k: ClaimedKey): KeyClasses =>
	k.kind === "proved" ? keyClasses(k.proof) : classesOfKey(k.key, k.members)

const classesOfKey = (key: KeySet, members: ReadonlyArray<ClassMember>): KeyClasses =>
	key.map((k): NonEmptyReadonlyArray<string> => [
		k,
		...members.flatMap((m) => (m.of === k ? [m.column] : []))
	])

/** A proof's members without their derivations, as a view's or a rewrite's key states them. */
export const classMembers = (proof: KeyProof): ReadonlyArray<ClassMember> =>
	proof.members.map((m) => Object.freeze({ of: m.of, column: m.column }))

/** The members a claimed key states. */
export const claimedMembers = (k: ClaimedKey): ReadonlyArray<ClassMember> =>
	k.kind === "proved" ? classMembers(k.proof) : k.members

/**
 * A key a node's metadata claims: one the logical analysis proved, with its proof; or one a lowering rewrite states of a
 * node it builds by construction (a row number within its partition, a group it forms, the rows it keeps), which the
 * rewrite's certificate justifies, over the classes of equal columns of the rows it keeps (its members).
 */
export type ClaimedKey =
	| { readonly kind: "proved"; readonly proof: KeyProof }
	| { readonly kind: "rewrite"; readonly key: KeySet; readonly members: ReadonlyArray<ClassMember> }

/** The columns a claimed key is: a proof's, its classes' representatives. */
export const claimedColumns = (k: ClaimedKey): KeySet => (k.kind === "proved" ? k.proof.key : k.key)

/** A proved key as a node's metadata claims it. */
export const provedClaim = (proof: KeyProof): ClaimedKey => Object.freeze({ kind: "proved", proof })

/** A key a lowering rewrite states of a node it builds, with the members of its classes among `members`. */
export const rewriteClaim = (key: KeySet, members: ReadonlyArray<ClassMember>): ClaimedKey =>
	Object.freeze({ kind: "rewrite", key, members: members.filter((m) => key.includes(m.of)) })

const dependency = (from: KeySet, to: KeySet, rule: Rule): Dependency =>
	Object.freeze({ from, to, rule })

/** A declared key determines the row. */
export const declaredKey = (
	key: KeySet,
	heading: KeySet,
	premises: ReadonlyArray<Premise>,
	context: EvidenceContext
): Dependency => dependency(key, heading, { rule: "declared", premises, context })

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
 * relation of one fact are descriptor facts; a take or a search of one, and a false conjunct, hold by the query alone.
 */
const atMostOneContext = (witness: AtMostOneWitness): EvidenceContext | undefined => {
	switch (witness.kind) {
		case "context":
		case "row":
		case "singleFact":
			return "descriptor"
		case "takeOne":
		case "nearestOne":
		case "falseConjunct":
			return undefined
	}
}

/**
 * The context a rule holds in by itself: a closed relation's facts, a session's one fact and a membership's one row are
 * descriptor facts.
 */
const ruleContext = (rule: Rule): EvidenceContext | undefined => {
	switch (rule.rule) {
		case "declared":
			return rule.context
		case "distinct":
			return "descriptor"
		case "atMostOne":
			return atMostOneContext(rule.witness)
		case "fixed":
			return rule.witness.kind === "closedValue" ? "descriptor" : undefined
		case "equal":
		case "correlated":
		case "match":
		case "projection":
		case "group":
		case "grouped":
		case "kept":
		case "produced":
		case "ranked":
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
			return
	}
}

/** A proof of `key` at `node` on `basis`, with its members, its premises and context those of their derivations. */
const proved = (
	node: NodeId,
	key: KeySet,
	basis: KeyBasis,
	members: ReadonlyArray<KeyMember>
): KeyProof => {
	const g: Collected = { premises: new Map(), contexts: [], seen: new Set() }
	for (const m of members) {
		groundImplication(g, m.determines)
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
		members: Object.freeze([...members])
	})
}

/** A column that stands for key column `of`: `determines` derives `of` from it. */
export const keyMember = (of: string, column: string, determines: Implication): KeyMember =>
	Object.freeze({ of, column, determines })

/** A key of a node of one heading group: `key` determines its heading. */
export const rowsKey = (
	node: NodeId,
	key: KeySet,
	determines: Implication,
	members: ReadonlyArray<KeyMember>
): KeyProof => proved(node, key, { kind: "rows", implication: determines }, members)

/**
 * A key of a union: every arm proves it, and every two arms are told apart on it. It lists no members: the union's keys
 * over its classes, the columns every arm makes equal, are proved from it at the union.
 */
export const unionKey = (
	node: NodeId,
	key: KeySet,
	arms: NonEmptyReadonlyArray<KeyProof>,
	separations: ReadonlyArray<Separation>
): KeyProof => proved(node, key, { kind: "union", arms, separations }, [])

/** A key of a node of several heading groups: `key` determines `inner`, a key of it or of the input it keeps. */
export const keyWithin = (
	node: NodeId,
	key: KeySet,
	determines: Implication,
	inner: KeyProof,
	members: ReadonlyArray<KeyMember>
): KeyProof => proved(node, key, { kind: "within", implication: determines, inner }, members)

const nodeIdShape = S.branded(NodeId, S.nonEmptyString)
const exprIdShape = S.branded(ExprId, S.nonEmptyString)
const occurrenceIdShape = S.branded(OccurrenceId, S.nonEmptyString)
const columnsShape: S.Shape<KeySet> = S.uniqueStrings("key columns", S.nonEmptyString)

const implicationShape: S.Shape<Implication> = S.lazy("an implication", () =>
	S.struct({ node: nodeIdShape, from: columnsShape, steps: S.array(dependencyShape) })
)

/** The shape of a key proof, as a node's metadata records it (rel.ts NodeMeta). */
const keyProofShape: S.Shape<KeyProof> = S.lazy("a key proof", () =>
	S.struct({
		node: nodeIdShape,
		key: columnsShape,
		premises: S.array(premiseShape),
		context: evidenceContextShape,
		members: S.array(
			S.struct({ of: S.nonEmptyString, column: S.nonEmptyString, determines: implicationShape })
		),
		basis: S.tagged("kind", {
			rows: S.struct({ implication: implicationShape }),
			union: S.struct({
				arms: S.nonEmptyArray(keyProofShape),
				separations: S.array(
					S.struct({
						arms: S.pairShape(S.nonNegativeInteger),
						column: S.nonEmptyString,
						fixed: S.pairShape(implicationShape)
					})
				)
			}),
			within: S.struct({ implication: implicationShape, inner: keyProofShape })
		})
	})
)

/** The shape of a view's key, as the checker stamps it on a Base over the view (rel.ts ViewBase). */
export const viewKeyShape: S.Shape<ViewKey> = S.struct({
	fields: S.nonEmptyUniqueStrings("view key columns"),
	premises: S.array(premiseShape),
	context: evidenceContextShape,
	members: S.array(S.struct({ of: S.nonEmptyString, column: S.nonEmptyString }))
})

/** The shape of a claimed key, as a node's metadata records it (rel.ts NodeMeta). */
export const claimedKeyShape: S.Shape<ClaimedKey> = S.tagged("kind", {
	proved: S.struct({ proof: keyProofShape }),
	rewrite: S.struct({
		key: columnsShape,
		members: S.array(S.struct({ of: S.nonEmptyString, column: S.nonEmptyString }))
	})
})

const fixedWitnessShape: S.Shape<FixedWitness> = S.tagged("kind", {
	conjunct: S.struct({ expr: exprIdShape }),
	closedValue: S.struct({}),
	takeCorrelation: S.struct({ index: S.nonNegativeInteger }),
	semiJoinPair: S.struct({ index: S.nonNegativeInteger, right: implicationShape }),
	attachCorrelation: S.struct({ attach: nodeIdShape, index: S.nonNegativeInteger })
})

const equalWitnessShape: S.Shape<EqualWitness> = S.tagged("kind", {
	conjunct: S.struct({ expr: exprIdShape }),
	regionEquality: S.struct({ index: S.nonNegativeInteger }),
	sharedColumn: S.struct({ occurrence: occurrenceIdShape, column: S.nonEmptyString }),
	correlatedCopy: S.struct({ index: S.nonNegativeInteger }),
	viewMember: S.struct({}),
	arms: S.struct({ arms: S.nonEmptyArray(implicationShape) })
})

const atMostOneWitnessShape: S.Shape<AtMostOneWitness> = S.tagged("kind", {
	context: S.struct({}),
	row: S.struct({}),
	singleFact: S.struct({}),
	takeOne: S.struct({}),
	nearestOne: S.struct({}),
	falseConjunct: S.struct({ expr: exprIdShape })
})

const ruleShape: S.Shape<Rule> = S.tagged("rule", {
	declared: S.struct({ premises: S.array(premiseShape), context: evidenceContextShape }),
	fixed: S.struct({ witness: fixedWitnessShape }),
	equal: S.struct({ witness: equalWitnessShape }),
	correlated: S.struct({ index: S.nonNegativeInteger }),
	match: S.struct({ occurrence: occurrenceIdShape, source: implicationShape }),
	projection: S.struct({ input: implicationShape }),
	group: S.struct({}),
	grouped: S.struct({ input: implicationShape }),
	kept: S.struct({ input: implicationShape }),
	atMostOne: S.struct({ witness: atMostOneWitnessShape }),
	distinct: S.struct({}),
	produced: S.struct({ input: keyProofShape }),
	ranked: S.struct({}),
	agreed: S.struct({ arms: S.nonEmptyArray(implicationShape) }),
	unionKey: S.struct({ proof: keyProofShape })
})

const dependencyShape: S.Shape<Dependency> = S.struct({
	from: columnsShape,
	to: columnsShape,
	rule: ruleShape
})
