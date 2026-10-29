import type { MultiplicityReason } from "#compiler/analysis/certificates/reasons.ts"
import { compareText } from "#compiler/core/canonical.ts"
import type { NodeId, ParamId } from "#compiler/core/ids.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { CoercionIdentity } from "#compiler/ir/certificate.ts"
import type { EvidenceContext, Grounds, Premise } from "#compiler/ir/evidence.ts"
import { lessDemanding, premiseText, strongest } from "#compiler/ir/evidence.ts"
import { type OpId, sortedOps } from "#compiler/ir/expr.ts"
import type { KeySet } from "#compiler/ir/rel.ts"
import { inHeadingOrder, keyOrder } from "#compiler/logical/closure.ts"

/**
 * At most this many physical keys per fragment ("bounded candidate antichain"): the logical analysis's
 * structural bound. Forgetting a key is always sound.
 */
export const physicalKeyBound = 8

/** At most this many dependencies are carried from a fragment to its consumers. Dropping one only weakens proofs. */
export const dependencyBound = 64

/**
 * At most this many combinations of per-occurrence keys are tried for one rule region: a structural bound of the
 * physical search, whose forgotten key keeps a DISTINCT and never changes an answer.
 */
const keyCombinationBound = 64

/**
 * The combinations of one option per scan, at most keyCombinationBound of them, each the concatenation of its chosen
 * options. They come in the order of an odometer whose first dial turns fastest, and only the first
 * keyCombinationBound of that order are kept.
 */
export const keyCombinations = (
	perScan: ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>>
): ReadonlyArray<ReadonlyArray<string>> =>
	perScan.reduceRight<ReadonlyArray<ReadonlyArray<string>>>(
		(turned, options) =>
			turned
				.flatMap((rest) => options.map((option) => [...option, ...rest]))
				.slice(0, keyCombinationBound),
		[[]]
	)

/**
 * The minimal physical keys among `candidates` under `isKey`, each minimized greedily from the end of the heading,
 * closed under the exchange over `dependencies` (Lucchesi and Osborn) up to `bound` keys, as a sorted antichain with
 * its columns in heading order. The exchange adds keys only while fewer than the bound are found: a key the candidates
 * alone prove is never cut, and a key the exchange would find beyond it only keeps a DISTINCT.
 */
const boundedMinimalKeys = (
	columns: ReadonlyArray<string>,
	candidates: Iterable<ReadonlyArray<string>>,
	prove: Prover,
	bound: number,
	dependencies: ReadonlyArray<{
		readonly from: ReadonlyArray<string>
		readonly to: ReadonlyArray<string>
	}>
): ReadonlyArray<{ readonly key: KeySet; readonly proof: Proof }> => {
	const inHeading = (cs: ReadonlyArray<string>) => inHeadingOrder(columns, cs)
	const found: Array<{ readonly key: KeySet; readonly proof: Proof }> = []
	const seen = new Set<string>()
	const add = (candidate: ReadonlyArray<string>): void => {
		let key = inHeading(candidate)
		let proof = prove(key)
		if (proof === undefined) {
			return
		}
		for (let i = key.length - 1; i >= 0; i--) {
			const without = key.toSpliced(i, 1)
			const narrower = prove(without)
			if (narrower !== undefined) {
				key = without
				proof = narrower
			}
		}
		const text = key.join("\u0000")
		if (seen.has(text)) {
			return
		}
		seen.add(text)
		found.push({ key, proof })
	}
	for (const candidate of candidates) {
		add(candidate)
	}
	for (const { key } of found) {
		for (const d of dependencies) {
			if (found.length >= bound) {
				break
			}
			const exchanged = inHeading([...d.from, ...key.filter((c) => !d.to.includes(c))])
			if (!found.some((k) => k.key.every((c) => exchanged.includes(c)))) {
				add(exchanged)
			}
		}
		if (found.length >= bound) {
			break
		}
	}
	const antichain = found.filter(
		(k) => !found.some((o) => o.key.length < k.key.length && o.key.every((c) => k.key.includes(c)))
	)
	const order = keyOrder(columns)
	return antichain.toSorted((a, b) => order(a.key, b.key))
}

/**
 * What a physical claim rests on: its grounds, and what only a claim about a lowered SQL fragment depends on beyond
 * them (the multiplicity reasons, operators, coercions and outer columns below).
 */
export interface Justification extends Grounds {
	readonly reasons: ReadonlyArray<MultiplicityReason>
	/** Native equality operators the claim compares under. */
	readonly equality: ReadonlyArray<OpId>
	/** Type, collation and cast identities the claim depends on. */
	readonly coercions: ReadonlyArray<CoercionIdentity>
	/**
	 * The columns of nodes outside the fragment the claim varies with: a fact fixed to an outer (correlated) value, or
	 * derived from one, holds only within one evaluation of the fragment for one outer row.
	 * The enclosing scope that binds those nodes turns the claim into a dependency on the variables they map to
	 * (rules.ts regionProps); until then it is never fixed outright.
	 */
	readonly outer: ReadonlyArray<OuterColumn>
}

/** A column of a node outside the fragment, read per evaluation. */
export interface OuterColumn {
	readonly node: NodeId
	readonly column: string
}

export const structural: Justification = Object.freeze({
	premises: [],
	context: "queryLocal",
	reasons: [],
	equality: [],
	coercions: [],
	outer: []
})

const outerKey = (o: OuterColumn): string => `${o.node}\u0000${o.column}`

const sortedUnique = <A extends string>(items: Iterable<A>): ReadonlyArray<A> =>
	[...new Set(items)].toSorted()

/**
 * The union of several justifications: every premise, reason, operator and coercion, under the most demanding
 * context (logical/props.ts strongest).
 */
export const joinJustifications = (justs: Iterable<Justification>): Justification => {
	const premises = new Map<string, Premise>()
	const contexts: Array<EvidenceContext> = []
	const reasons: Array<MultiplicityReason> = []
	const equality: Array<OpId> = []
	const coercions: Array<CoercionIdentity> = []
	const outer = new Map<string, OuterColumn>()
	for (const j of justs) {
		for (const p of j.premises) {
			premises.set(premiseText(p), p)
		}
		contexts.push(j.context)
		reasons.push(...j.reasons)
		equality.push(...j.equality)
		coercions.push(...j.coercions)
		for (const o of j.outer) {
			outer.set(outerKey(o), o)
		}
	}
	return {
		premises: [...premises.entries()].toSorted(([a], [b]) => compareText(a, b)).map(([, p]) => p),
		context: strongest(contexts),
		reasons: [...new Set(reasons)],
		equality: sortedOps(equality),
		coercions: sortedUnique(coercions),
		outer: [...outer.entries()].toSorted(([a], [b]) => compareText(a, b)).map(([, o]) => o)
	}
}

/**
 * Splits a justification's outer columns into those of nodes `local` to an enclosing scope, which that scope binds,
 * and the justification without them, which still varies with the rest.
 */
export const resolveOuter = (
	just: Justification,
	local: (node: NodeId) => boolean
): { readonly bound: ReadonlyArray<OuterColumn>; readonly just: Justification } => {
	const bound = just.outer.filter((o) => local(o.node))
	return bound.length === 0
		? { bound, just }
		: { bound, just: { ...just, outer: just.outer.filter((o) => !local(o.node)) } }
}

export const justify = (input: Partial<Justification>): Justification =>
	joinJustifications([{ ...structural, ...input }])

export const withReason = (
	j: Justification,
	...reasons: ReadonlyArray<MultiplicityReason>
): Justification => joinJustifications([j, { ...structural, reasons }])

export const nodePremise = (node: NodeId): Premise => ({ kind: "node", node })
export const paramPremise = (param: ParamId): Premise => ({ kind: "param", param })

export interface Implication {
	readonly from: ReadonlyArray<string>
	/**
	 * The span columns of which one known point serves in place of the value (a nonoverlap key's spans); none for an
	 * ordinary dependency.
	 */
	readonly at: ReadonlyArray<string>
	readonly to: ReadonlyArray<string>
	readonly just: Justification
}

/** A span column one of whose points `from` determines. */
interface PointRule {
	readonly from: ReadonlyArray<string>
	readonly span: string
	readonly just: Justification
}

/**
 * How a fact of a closure was reached: from the start, by the implication at that index, or, for a point, by the point
 * rule at that index.
 */
type Step =
	| { readonly kind: "start" }
	| { readonly kind: "implication"; readonly index: number; readonly implication: Implication }
	| { readonly kind: "point"; readonly index: number; readonly rule: PointRule }

const fromStart: Step = Object.freeze({ kind: "start" })

/**
 * What a start determines: each column whose value is known, and each span column with a point known only by a point
 * rule, with the step that reached it.
 */
interface Closure {
	readonly columns: ReadonlyMap<string, Step>
	readonly points: ReadonlyMap<string, Step>
}

/** A fact a derivation reads: a column's value, or a point of a span column. */
type Fact =
	| { readonly kind: "column"; readonly column: string }
	| { readonly kind: "point"; readonly span: string }

export interface KeyOption {
	readonly columns: KeySet
	readonly just: Justification
}

export type Requirement = ReadonlyArray<KeyOption>
type Alternative = ReadonlyArray<Requirement>
export type Identity = ReadonlyArray<Alternative>

export interface Identification {
	readonly just: Justification
	/**
	 * Per requirement of the satisfied alternative: whether its option lay inside the candidate itself, or was reached
	 * only through dependencies (an at-most-one match).
	 */
	readonly direct: ReadonlyArray<boolean>
	readonly alternative: number
	/** Per requirement of the satisfied alternative, its options inside the candidate's closure, in option order. */
	readonly inside: NonEmptyReadonlyArray<NonEmptyReadonlyArray<KeyOption>>
}

/**
 * Functional dependencies with proofs, over one physical fragment's columns.
 *
 * The physical analysis must say not only that a heading is unique but what the claim rests on: the installed
 * constraints, the parameters a fixed component assumes, the equality operators and the coercions. Every dependency
 * therefore carries a Justification, and a closure remembers which dependency derived each column, so the
 * justification of a derived fact is exactly the union of the dependencies on its derivation, never the whole table.
 *
 * The dependencies are only those the declared keys and the query structure imply: a column fixed per
 * evaluation (from no column), two equal columns (each from the other), a key of a scan determining the variables the
 * scan binds, and a computed output determined by the columns it reads. A general functional dependency is not a key:
 * uniqueness is a separate claim (Identity below) that a dependency can only help reach.
 *
 * A fact is a column's value known, or, for a span column, one point inside its value known (a span known has every
 * point known). A nonoverlap key, a stored relation's key with span fields (theory/laws.ts), holds at most one fact
 * whose spans hold given points for each value of its scalar fields, so its dependency reads its spans `at` a point:
 * its scalar columns and one known point of each span determine the row, as an equality key's columns do. A point
 * rule derives a span's point from columns: a predicate holding the span to contain a value, or a nonempty span,
 * those columns compute.
 *
 * Uniqueness of a candidate K is an Identity: one or more alternatives, each a conjunction of requirements, each
 * requirement a disjunction of key options. K is a physical key when, for some alternative, every requirement has an
 * option inside the closure of K. A rule region needs every occurrence identified (one requirement per occurrence:
 * a key from each input jointly identifies a pair); an explicit DISTINCT adds the alternative of the whole
 * heading. An Identity with no alternative proves nothing; an alternative never has zero requirements.
 */
export class ProofFds {
	readonly universe: ReadonlyArray<string>
	readonly #members: ReadonlySet<string>
	readonly #imps: Array<Implication> = []
	readonly #points: Array<PointRule> = []

	constructor(universe: ReadonlyArray<string>) {
		this.universe = universe
		this.#members = new Set(universe)
	}

	has(column: string): boolean {
		return this.#members.has(column)
	}

	implications(): ReadonlyArray<Implication> {
		return this.#imps
	}

	imply(from: ReadonlyArray<string>, to: ReadonlyArray<string>, just: Justification): void {
		this.implyAt(from, [], to, just)
	}

	/** `from` with one known point of each span of `at` determines `to`. */
	implyAt(
		from: ReadonlyArray<string>,
		at: ReadonlyArray<string>,
		to: ReadonlyArray<string>,
		just: Justification
	): void {
		const f = [...new Set(from)]
		const a = [...new Set(at)].filter((c) => !f.includes(c))
		const t = [...new Set(to)].filter((c) => this.has(c) && !f.includes(c))
		if (t.length === 0 || !f.every((c) => this.has(c)) || !a.every((c) => this.has(c))) {
			return
		}
		this.#imps.push({ from: f, at: a, to: t, just })
	}

	/** `from` determines a point of the span column `span`. */
	pin(from: ReadonlyArray<string>, span: string, just: Justification): void {
		const f = [...new Set(from)]
		if (!this.has(span) || f.includes(span) || !f.every((c) => this.has(c))) {
			return
		}
		this.#points.push({ from: f, span, just })
	}

	fix(column: string, just: Justification): void {
		this.imply([], [column], just)
	}

	equate(a: string, b: string, just: Justification): void {
		if (a === b) {
			return
		}
		this.imply([a], [b], just)
		this.imply([b], [a], just)
	}

	/**
	 * Every fact the start determines, each with the dependency that derived it. Implications and point rules fire in
	 * table order until none adds a fact: at most one pass per added fact.
	 */
	closure(start: Iterable<string>): Closure {
		const columns = new Map<string, Step>()
		const points = new Map<string, Step>()
		for (const c of start) {
			if (this.has(c)) {
				columns.set(c, fromStart)
			}
		}
		const fired = new Set<number>()
		const pinned = new Set<number>()
		for (let changed = true; changed;) {
			const implied = this.#fire(columns, points, fired)
			const pointedAny = this.#pin(columns, points, pinned)
			changed = implied || pointedAny
		}
		return { columns, points }
	}

	/** One pass of the implications not yet fired whose premises hold; whether it added a column. */
	#fire(
		columns: Map<string, Step>,
		points: ReadonlyMap<string, Step>,
		fired: Set<number>
	): boolean {
		const pointed = (span: string) => columns.has(span) || points.has(span)
		let changed = false
		for (const [i, imp] of this.#imps.entries()) {
			if (fired.has(i) || !imp.from.every((c) => columns.has(c)) || !imp.at.every(pointed)) {
				continue
			}
			fired.add(i)
			for (const c of imp.to.filter((t) => !columns.has(t))) {
				columns.set(c, { kind: "implication", index: i, implication: imp })
				changed = true
			}
		}
		return changed
	}

	/** One pass of the point rules not yet applied whose premises hold; whether it added a point. */
	#pin(
		columns: ReadonlyMap<string, Step>,
		points: Map<string, Step>,
		pinned: Set<number>
	): boolean {
		let changed = false
		for (const [i, rule] of this.#points.entries()) {
			if (pinned.has(i) || !rule.from.every((c) => columns.has(c))) {
				continue
			}
			pinned.add(i)
			if (columns.has(rule.span) || points.has(rule.span)) {
				continue
			}
			points.set(rule.span, { kind: "point", index: i, rule })
			changed = true
		}
		return changed
	}

	/** The justification of the targets' derivation: the dependencies and point rules that reached them, transitively. */
	explain(closure: Closure, targets: Iterable<string>): Justification {
		const usedImplications = new Map<number, Implication>()
		const usedPoints = new Map<number, PointRule>()
		const seen = new Set<string>()
		const stack: Array<Fact> = [...targets].map((column) => ({ kind: "column", column }))
		for (let fact = stack.pop(); fact !== undefined; fact = stack.pop()) {
			/** A span known by its value has every point known: its point is explained as the column is. */
			const column = fact.kind === "column" || closure.columns.has(fact.span)
			const key = fact.kind === "column" ? fact.column : fact.span
			const name = `${column ? "c" : "p"}\u0000${key}`
			if (seen.has(name)) {
				continue
			}
			seen.add(name)
			const how = column ? closure.columns.get(key) : closure.points.get(key)
			if (how === undefined) {
				continue
			}
			switch (how.kind) {
				case "start":
					continue
				case "implication": {
					usedImplications.set(how.index, how.implication)
					stack.push(
						...how.implication.from.map((c): Fact => ({ kind: "column", column: c })),
						...how.implication.at.map((s): Fact => ({ kind: "point", span: s }))
					)
					continue
				}
				case "point":
					usedPoints.set(how.index, how.rule)
					stack.push(...how.rule.from.map((c): Fact => ({ kind: "column", column: c })))
					continue
			}
		}
		return joinJustifications([
			...[...usedImplications].toSorted(([a], [b]) => a - b).map(([, imp]) => imp.just),
			...[...usedPoints].toSorted(([a], [b]) => a - b).map(([, rule]) => rule.just)
		])
	}

	determines(start: Iterable<string>, targets: Iterable<string>): boolean {
		const d = this.closure(start)
		for (const t of targets) {
			if (!d.columns.has(t)) {
				return false
			}
		}
		return true
	}

	/**
	 * Whether `candidate` satisfies the identity, and on what: the strongest proof available, the one that holds in the
	 * least demanding evidence context. Each requirement is met by its option inside the candidate's closure whose
	 * proof, the option's own and the dependencies that reach its columns, is least demanding. The alternative whose
	 * requirements so met are least demanding wins. A tie goes to the earlier option and alternative. So a scan that
	 * reads an immediate key is proved unique by that key alone, never through a deferrable one it also determines.
	 */
	identifies(identity: Identity, candidate: Iterable<string>): Identification | undefined {
		return this.identification(identity, candidate)?.()
	}

	/**
	 * identifies, deferred: whether the candidate satisfies the identity is decided from the closure alone, since an
	 * alternative is satisfied exactly when each of its requirements has an option inside the closure, whatever the
	 * options' proofs; the returned function builds the identification identifies gives, and nothing builds it for a
	 * candidate only tested.
	 */
	identification(
		identity: Identity,
		candidate: Iterable<string>
	): (() => Identification) | undefined {
		const start = [...candidate]
		const derivation = this.closure(start)
		const inside = (option: KeyOption) => option.columns.every((c) => derivation.columns.has(c))
		const satisfied = identity.flatMap((alternative, a): ReadonlyArray<Satisfied> => {
			const met = satisfiedBy(alternative, inside)
			return met === undefined ? [] : [{ alternative: a, met }]
		})
		return isNonEmpty(satisfied) ? () => this.#identify(satisfied, start, derivation) : undefined
	}

	/**
	 * The strongest identification of the candidate `start`, whose closure is `derivation`, over the alternatives it
	 * satisfies.
	 */
	#identify(
		satisfied: NonEmptyReadonlyArray<Satisfied>,
		start: ReadonlyArray<string>,
		derivation: Closure
	): Identification {
		const inStart = new Set(start)
		const [first, ...rest] = mapNonEmpty(satisfied, (s) =>
			this.#alternative(s, derivation, inStart)
		)
		return rest.reduce(
			(kept, found) => (lessDemanding(found.just.context, kept.just.context) ? found : kept),
			first
		)
	}

	/** The identification a satisfied alternative gives. */
	#alternative(
		satisfied: Satisfied,
		derivation: Closure,
		inStart: ReadonlySet<string>
	): Identification {
		const mets = mapNonEmpty(satisfied.met, (options) => this.#met(options, derivation, inStart))
		return {
			just: joinJustifications(mets.map((m) => m.just)),
			direct: mets.map((m) => m.direct),
			alternative: satisfied.alternative,
			inside: satisfied.met
		}
	}

	/**
	 * The least demanding of a requirement's derived options, and whether it lies inside the candidate itself. A tie
	 * goes to the earlier option.
	 */
	#met(
		options: NonEmptyReadonlyArray<KeyOption>,
		derivation: Closure,
		inStart: ReadonlySet<string>
	): Met {
		const metBy = (option: KeyOption): Met => ({
			just: joinJustifications([option.just, this.explain(derivation, option.columns)]),
			direct: option.columns.every((c) => inStart.has(c))
		})
		const [first, ...rest] = options
		return rest.reduce((met, option) => {
			const next = metBy(option)
			return lessDemanding(next.just.context, met.just.context) ? next : met
		}, metBy(first))
	}
}

/** A requirement met: its least demanding derived option's justification, and whether it lies inside the candidate. */
interface Met {
	readonly just: Justification
	readonly direct: boolean
}

/**
 * An alternative a candidate satisfies: its index in the identity, and per requirement the options inside the
 * candidate's closure, never none.
 */
interface Satisfied {
	readonly alternative: number
	readonly met: NonEmptyReadonlyArray<NonEmptyReadonlyArray<KeyOption>>
}

/**
 * Each requirement's options inside a closure, when the alternative is nonempty and every requirement has one;
 * undefined otherwise.
 */
const satisfiedBy = (
	alternative: Alternative,
	inside: (option: KeyOption) => boolean
): NonEmptyReadonlyArray<NonEmptyReadonlyArray<KeyOption>> | undefined => {
	const met: Array<NonEmptyReadonlyArray<KeyOption>> = []
	for (const requirement of alternative) {
		const options = requirement.filter(inside)
		if (!isNonEmpty(options)) {
			return undefined
		}
		met.push(options)
	}
	return isNonEmpty(met) ? met : undefined
}

/**
 * A physical key of a lowered fragment with the justification of its proof. It is not a KeyProof (ir/keys.ts says why
 * the two are distinct): the physical analysis proves it over the fragment's SQL-level dependencies.
 */
export interface JustifiedKey {
	/** In heading order. */
	readonly columns: KeySet
	readonly just: Justification
}

/**
 * A proof found, whose justification is built when it is read: a key search asks of most candidates only whether
 * a proof exists, so their justifications are never built.
 */
export type Proof = () => Justification

/** What proves a candidate a physical key, and on what; undefined when nothing does. */
export type Prover = (candidate: ReadonlyArray<string>) => Proof | undefined

/**
 * The prover of an identity over a dependency table, each identification annotated (a rule region adds the join
 * reasons its requirements were met by).
 */
export const annotatedProver =
	(fds: ProofFds, identity: Identity, annotate: (found: Identification) => Justification): Prover =>
	(candidate) => {
		const found = fds.identification(identity, candidate)
		return found === undefined ? undefined : () => annotate(found())
	}

/** The prover of an identity over a dependency table, each identification justified as found. */
export const identityProver = (fds: ProofFds, identity: Identity): Prover =>
	annotatedProver(fds, identity, (found) => found.just)

/**
 * The minimal physical keys among the candidates: each minimized greedily from the end of the heading while the
 * remainder is still proved a key, closed under the exchange over the fragment's dependencies (boundedMinimalKeys), as a bounded antichain, each with the justification of its proof. Only the keys kept are justified.
 */
export const physicalKeys = (
	columns: ReadonlyArray<string>,
	prove: Prover,
	candidates: Iterable<ReadonlyArray<string>>,
	dependencies: ReadonlyArray<{
		readonly from: ReadonlyArray<string>
		readonly to: ReadonlyArray<string>
	}>
): ReadonlyArray<JustifiedKey> =>
	boundedMinimalKeys(columns, candidates, prove, physicalKeyBound, dependencies).map(
		({ key, proof }) => ({ columns: key, just: proof() })
	)
