import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import { nominal } from "#compiler/core/brand.ts"
import type { NodeId, ParamId } from "#compiler/core/ids.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type { CoercionIdentity, ElisionReason } from "#compiler/ir/certificate.ts"
import type { EvidenceContext, Grounds, Premise } from "#compiler/ir/evidence.ts"
import { evidenceContexts, lessDemanding, premiseText, strongest } from "#compiler/ir/evidence.ts"
import { type OpId, sortedOps, sortedUnique } from "#compiler/ir/expr.ts"
import type { KeySet } from "#compiler/ir/rel.ts"
import { inHeadingOrder } from "#compiler/logical/closure.ts"

/** What a physical claim rests on, as a join reads it (`Justification`), in any order and with repeats. */
interface Grounding extends Grounds {
	readonly reasons: ReadonlyArray<ElisionReason>
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

declare const normalBrand: unique symbol

/**
 * What a physical claim rests on: its grounds, and what only a claim about a lowered SQL fragment depends on beyond
 * them (the elision reasons, operators, coercions and outer columns), in its normal form, which only this module mints
 * (`normalized`): its premises ordered by their text (ir/evidence.ts premiseText), its operators by their order
 * (ir/expr.ts sortedOps), its coercions and outer columns by their text, each once, and its reasons each once in the
 * order they were first given. The join of one normal justification with any that rest on nothing (`restsOnNothing`)
 * is that justification itself, so a join that meets only one justification resting on anything builds nothing.
 */
export interface Justification extends Grounding {
	readonly [normalBrand]: true
}

const mintJustification = nominal<Grounding, Justification>()

/** A column of a node outside the fragment, read per evaluation. */
export interface OuterColumn {
	readonly node: NodeId
	readonly column: string
}

export const structural: Justification = mintJustification(
	Object.freeze({
		premises: [],
		context: "queryLocal",
		reasons: [],
		equality: [],
		coercions: [],
		outer: []
	})
)

/** An outer column's key: its node and its column, which no column name holds the separator of. */
export const outerKey = (o: OuterColumn): string => `${o.node}\u0000${o.column}`

/**
 * The normal form of the union of several groundings: every premise, reason, operator and coercion, under the most
 * demanding context (logical/props.ts strongest).
 */
const normalized = (groundings: Iterable<Grounding>): Justification => {
	const premises = new Map<string, Premise>()
	const contexts: Array<EvidenceContext> = []
	const reasons: Array<ElisionReason> = []
	const equality: Array<OpId> = []
	const coercions: Array<CoercionIdentity> = []
	const outer = new Map<string, OuterColumn>()
	for (const j of groundings) {
		for (const p of j.premises) {
			premises.set(premiseText(p), p)
		}
		contexts.push(j.context)
		appendAll(reasons, j.reasons)
		appendAll(equality, j.equality)
		appendAll(coercions, j.coercions)
		for (const o of j.outer) {
			outer.set(outerKey(o), o)
		}
	}
	return mintJustification({
		premises: [...premises.entries()]
			.toSorted(([a], [b]) => compareStrings(a, b))
			.map(([, p]) => p),
		context: strongest(contexts),
		reasons: [...new Set(reasons)],
		equality: sortedOps(equality),
		coercions: sortedUnique(coercions),
		outer: [...outer.entries()].toSorted(([a], [b]) => compareStrings(a, b)).map(([, o]) => o)
	})
}

/**
 * Whether a justification rests on nothing: no premise, reason, operator, coercion or outer column, in the least
 * demanding context, which every other context is at least as demanding as (ir/evidence.ts strongest), so a join
 * reads nothing of it.
 */
const restsOnNothing = (j: Justification): boolean =>
	j.context === "queryLocal" &&
	j.premises.length === 0 &&
	j.reasons.length === 0 &&
	j.equality.length === 0 &&
	j.coercions.length === 0 &&
	j.outer.length === 0

/**
 * The union of several justifications: every premise, reason, operator and coercion, under the most demanding
 * context (logical/props.ts strongest). Those resting on nothing add nothing; one alone is its own union, being normal,
 * and none is `structural`, so only a union of two or more that rest on something is built.
 */
export const joinJustifications = (justs: Iterable<Justification>): Justification => {
	const held: Array<Justification> = []
	for (const j of justs) {
		if (!restsOnNothing(j)) {
			held.push(j)
		}
	}
	const [first] = held
	if (first === undefined) {
		return structural
	}
	return held.length === 1 ? first : normalized(held)
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
		: { bound, just: normalized([{ ...just, outer: just.outer.filter((o) => !local(o.node)) }]) }
}

/** The justification of what `input` names, in its normal form. */
export const justify = (input: Partial<Grounding>): Justification =>
	normalized([{ ...structural, ...input }])

export const withReason = (
	j: Justification,
	reasons: ReadonlyArray<ElisionReason>
): Justification => joinJustifications([j, justify({ reasons })])

export const nodePremise = (node: NodeId): Premise => ({ kind: "node", node })
export const paramPremise = (param: ParamId): Premise => ({ kind: "param", param })

/**
 * The attribute a dependency table derives when its start identifies at most one row of its fragment: a superkey is a
 * start whose closure holds it. Every table names its own row this one way; an embedding renames an embedded table's.
 */
export const rowAttribute = "\u0000"

/**
 * An attribute a table carries beyond its fragment's heading, under the namespace of the embedding that brought it:
 * an embedded table's row, a column of the embedded fragment the embedding gives no column of its own, or a hidden
 * attribute of the embedded table, numbered anew among the draft's (DependencyDraft embed), so a hidden attribute's name
 * is as long at every depth, where each embedding wrote the embedded one's whole name into its own (the ledger's judge
 * at hub f4f1f78de: 150 characters on average, 2,368 at most, each hashed again as the name of a fact). Every hidden
 * attribute begins with the character `row` is, which no column name holds (a declared name is ASCII letters, digits
 * and underscores, and so is every name grizzle mints), so a table's columns and its hidden attributes never meet, and
 * two namespaces of one table never do either.
 */
export const hiddenIn = (namespace: string, attribute: string): string =>
	`${rowAttribute}${namespace}${rowAttribute}${attribute}`

const isHidden = (attribute: string): boolean => attribute.startsWith(rowAttribute)

/**
 * The embeddings an implication passed through, outermost first: the namespace of the outermost and the embeddings
 * within it, or a table's own. An embedding adds its namespace before an origin and shares the rest, so carrying an
 * implication up a chain of embeddings costs one cell at each, however deep it came from, where each embedding copied
 * the whole path (the ledger's judge at hub f4f1f78de: 44 namespaces on average, 277 at most).
 */
type Origin =
	| { readonly kind: "own" }
	| { readonly kind: "embedded"; readonly namespace: string; readonly within: Origin }

/** The origin of a table's own implications and point rules. */
export const ownOrigin: Origin = Object.freeze({ kind: "own" })

/** The origin of what the embedding `namespace` brought from `inner`. */
export const embeddedIn = (namespace: string, inner: Origin): Origin => ({
	kind: "embedded",
	namespace,
	within: inner
})

/** Whether `origin` lies within the embedding `prefix` names: every namespace of `prefix` its own, outermost first. */
const within = (origin: Origin, prefix: Origin): boolean => {
	let o = origin
	for (let p = prefix; p.kind === "embedded"; p = p.within) {
		if (o.kind !== "embedded" || o.namespace !== p.namespace) {
			return false
		}
		o = o.within
	}
	return true
}

/** One occurrence a rule region's identification joins: its row attribute, and the origin of what its embedding added. */
export interface JoinedOccurrence {
	readonly row: string
	readonly origin: Origin
}

/** The one empty list every dependency's empty attributes and joins share: a table holds millions of dependencies, most
 * with no span `at` and no region `join`, where each held an empty list of its own (qti's write compile at hub
 * a8dbf06b8: 2.85M dependencies, about 91 MB of empty lists over its two placement analyses). */
const nothing: ReadonlyArray<never> = Object.freeze([])

/** `xs`, or the one empty list where it holds nothing. */
const shared = <A>(xs: ReadonlyArray<A>): ReadonlyArray<A> => (xs.length === 0 ? nothing : xs)

export interface Implication {
	readonly from: ReadonlyArray<string>
	/**
	 * The span columns of which one known point serves in place of the value (a nonoverlap key's spans); none for an
	 * ordinary dependency.
	 */
	readonly at: ReadonlyArray<string>
	readonly to: ReadonlyArray<string>
	readonly just: Justification
	readonly origin: Origin
	/**
	 * The occurrences a rule region's identification of its row joins, whose proof says whether each was identified
	 * by the candidate's own columns (annotateJoin); none for every other implication.
	 */
	readonly join: ReadonlyArray<JoinedOccurrence>
}

/** A span column one of whose points `from` determines. */
export interface PointRule {
	readonly from: ReadonlyArray<string>
	readonly span: string
	readonly just: Justification
	readonly origin: Origin
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
 * What a start determines: each attribute whose value is known, and each span with a point known only by a point
 * rule, with the step that reached it.
 */
export interface FactClosure {
	readonly columns: ReadonlyMap<string, Step>
	readonly points: ReadonlyMap<string, Step>
}

/**
 * A start's strongest proof before it is explained: the index, among a table's stages, of the least demanding one whose
 * closure of the start holds the row, and that closure (Dependencies proof).
 */
interface Staged {
	readonly stage: number
	readonly closure: FactClosure
}

/** A fact a derivation reads: an attribute's value, or a point of a span. */
type Fact =
	| { readonly kind: "column"; readonly column: string }
	| { readonly kind: "point"; readonly span: string }

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
 * A start proved a superkey: the justification of its strongest proof, and the canonical minimal key among its own
 * columns (Dependencies keyAmong).
 */
export interface Identification {
	readonly just: Justification
	readonly key: KeySet
}

/** A column of a draft standing for a column of an embedded fragment, and what representing it rests on. */
export interface Rep {
	readonly column: string
	readonly just: Justification
}

/** What an embedded implication's justification becomes, and the attributes it reads besides its own. */
interface Localized {
	readonly from: ReadonlyArray<string>
	readonly just: Justification
}

/**
 * How a fragment's table is embedded in a draft: under `namespace`, each column of its heading as the draft columns
 * `column` gives (none hides it under the namespace), its row as `row`, and each implication's justification as
 * `localize` turns it, undefined dropping the implication.
 */
export interface Embedding {
	readonly namespace: string
	readonly column: (column: string) => ReadonlyArray<Rep>
	readonly row: string
	readonly localize: (just: Justification) => Localized | undefined
}

/** The localization of an embedding whose implications hold as they are. */
export const asTheyAre = (just: Justification): Localized => ({ from: [], just })

/**
 * The reasons a region identification's proof gives: an occurrence identified only through a dependency of the
 * region, not by the start's own columns through its source's keys, is matched at most once (oneToOneJoin); otherwise
 * every occurrence's key lies in the start (combinedJoinKeys), which takes more than one.
 */
const annotateJoin = (
	closure: FactClosure,
	joined: ReadonlyArray<JoinedOccurrence>
): ReadonlyArray<ElisionReason> => {
	if (joined.some((o) => !directly(closure, o))) {
		return ["oneToOneJoin"]
	}
	return joined.length > 1 ? ["combinedJoinKeys"] : []
}

/**
 * Whether the start identified an occurrence itself: its row's derivation, followed back through what the
 * occurrence's own embedding added, reaches only the start, never a dependency of the region around it.
 */
const directly = (closure: FactClosure, occurrence: JoinedOccurrence): boolean => {
	const seen = new Set<string>()
	const stack: Array<Fact> = [{ kind: "column", column: occurrence.row }]
	for (let fact = stack.pop(); fact !== undefined; fact = stack.pop()) {
		const column = fact.kind === "column" || closure.columns.has(fact.span)
		const key = fact.kind === "column" ? fact.column : fact.span
		const name = `${column ? "c" : "p"}${rowAttribute}${key}`
		if (seen.has(name)) {
			continue
		}
		seen.add(name)
		const how = column ? closure.columns.get(key) : closure.points.get(key)
		if (how === undefined) {
			return false
		}
		switch (how.kind) {
			case "start":
				continue
			case "implication":
				if (!within(how.implication.origin, occurrence.origin)) {
					return false
				}
				appendAll(stack, [
					...how.implication.from.map((c): Fact => ({ kind: "column", column: c })),
					...how.implication.at.map((s): Fact => ({ kind: "point", span: s }))
				])
				continue
			case "point":
				if (!within(how.rule.origin, occurrence.origin)) {
					return false
				}
				appendAll(
					stack,
					how.rule.from.map((c): Fact => ({ kind: "column", column: c }))
				)
				continue
		}
	}
	return true
}

/** Which implications and point rules a closure fires: those whose justification `admit` holds of. */
type Admit = (just: Justification) => boolean

const everything: Admit = () => true

/** What a closure through a stage of `context` admits: the dependencies whose contexts are no more demanding. */
const admittedThrough = (context: EvidenceContext): Admit => {
	const admitted: Admit = (just) => !lessDemanding(context, just.context)
	return admitted
}

/**
 * What a closure admits: every implication and point rule (`every`), or those of a table's stage, by its index, whose
 * contexts are no more demanding than the stage's.
 */
type Admission = "every" | number

/**
 * A key reduction's key and its proof: the closure that proved the narrowest key the reduction closed for, where no
 * column was dropped after it without one (`closed`), or none yet where a column was dropped by a dependency the
 * rest of the key starts (`narrowed`), whose closure the key's caller runs once if it explains the proof.
 */
interface Minimized {
	readonly key: KeySet
	readonly proof:
		| { readonly kind: "closed"; readonly staged: Staged }
		| { readonly kind: "narrowed" }
}

/** How many facts each implication and each point rule of a table waits on as a closure starts, -1 for one it admits not. */
interface Counts {
	readonly implications: Int32Array
	readonly points: Int32Array
}

/** The implications and point rules waiting on a fact, by index. */
interface Waiting {
	readonly fromColumn: ReadonlyMap<string, ReadonlyArray<number>>
	readonly atSpan: ReadonlyMap<string, ReadonlyArray<number>>
	readonly pointFrom: ReadonlyMap<string, ReadonlyArray<number>>
}

/** The invariant of an index the Waiting holds: it names an implication of the table it was built from. */
const indexedImplication = "the waiting index names an implication of its table"

/** The invariant of an index the Waiting holds: it names a point rule of the table it was built from. */
const indexedPoint = "the waiting index names a point rule of its table"

const indexed = (imps: ReadonlyArray<Implication>, points: ReadonlyArray<PointRule>): Waiting => {
	const fromColumn = new Map<string, Array<number>>()
	const atSpan = new Map<string, Array<number>>()
	const pointFrom = new Map<string, Array<number>>()
	const enter = (map: Map<string, Array<number>>, key: string, i: number): void => {
		const list = map.get(key)
		if (list === undefined) {
			map.set(key, [i])
		} else {
			list.push(i)
		}
	}
	for (const [i, imp] of imps.entries()) {
		for (const c of imp.from) {
			enter(fromColumn, c, i)
		}
		for (const s of imp.at) {
			enter(atSpan, s, i)
		}
	}
	for (const [i, rule] of points.entries()) {
		for (const c of rule.from) {
			enter(pointFrom, c, i)
		}
	}
	return { fromColumn, atSpan, pointFrom }
}

/**
 * One closure of a table (Dependencies closure): the facts it has learned, each with the step that reached it, in the
 * order learned, and each implication's and point rule's facts still awaited. Each implication that fires reaches all
 * its targets by one step, the same data for each of them.
 */
class FactClosing {
	readonly #imps: ReadonlyArray<Implication>
	readonly #rules: ReadonlyArray<PointRule>
	readonly #waitingOn: Waiting
	readonly #columns = new Map<string, Step>()
	readonly #points = new Map<string, Step>()
	readonly #waiting: Int32Array
	readonly #pointWaiting: Int32Array
	/** The spans of `at` each implication has already counted as pointed, once one has been. */
	#pointedAt: Map<number, Set<string>> | undefined
	/** The facts learned, in the order learned: each one's name, a column or a span, and whether it is a point. */
	readonly #queue: Array<string> = []
	readonly #queuedPoints: Array<boolean> = []

	constructor(table: Dependencies, waitingOn: Waiting, counts: Counts) {
		this.#imps = table.implications
		this.#rules = table.points
		this.#waitingOn = waitingOn
		this.#waiting = counts.implications.slice()
		this.#pointWaiting = counts.points.slice()
	}

	/** What `start`, among `heading`, determines: every fact learned, the queue read in order until it ends. */
	closed(start: Iterable<string>, heading: ReadonlySet<string>): FactClosure {
		for (const c of start) {
			if (heading.has(c)) {
				this.#learn(c, fromStart)
			}
		}
		for (let i = 0; i < this.#waiting.length; i++) {
			if (this.#waiting[i] === 0) {
				this.#fire(i)
			}
		}
		for (let i = 0; i < this.#pointWaiting.length; i++) {
			if (this.#pointWaiting[i] === 0) {
				this.#firePoint(i)
			}
		}
		const queue = this.#queue
		for (let q = 0; q < queue.length; q++) {
			const name = defined(queue[q], "a learned fact is queued")
			if (this.#queuedPoints[q] !== true) {
				for (const i of this.#waitingOn.fromColumn.get(name) ?? []) {
					if (this.#waitingFor(i) > 0) {
						this.#count(i)
					}
				}
				for (const i of this.#waitingOn.pointFrom.get(name) ?? []) {
					const pending = defined(this.#pointWaiting[i], indexedPoint)
					if (pending <= 0) {
						continue
					}
					this.#pointWaiting[i] = pending - 1
					if (pending === 1) {
						this.#firePoint(i)
					}
				}
			}
			for (const i of this.#waitingOn.atSpan.get(name) ?? []) {
				this.#countAt(i, name)
			}
		}
		return { columns: this.#columns, points: this.#points }
	}

	#learn(column: string, step: Step): void {
		if (this.#columns.has(column)) {
			return
		}
		this.#columns.set(column, step)
		this.#queue.push(column)
		this.#queuedPoints.push(false)
	}

	#learnPoint(span: string, step: Step): void {
		if (this.#columns.has(span) || this.#points.has(span)) {
			return
		}
		this.#points.set(span, step)
		this.#queue.push(span)
		this.#queuedPoints.push(true)
	}

	#fire(i: number): void {
		const implication = defined(this.#imps[i], indexedImplication)
		const step: Step = { kind: "implication", index: i, implication }
		for (const t of implication.to) {
			this.#learn(t, step)
		}
	}

	#firePoint(i: number): void {
		const rule = defined(this.#rules[i], indexedPoint)
		this.#learnPoint(rule.span, { kind: "point", index: i, rule })
	}

	#waitingFor(i: number): number {
		return defined(this.#waiting[i], indexedImplication)
	}

	#count(i: number): void {
		const left = this.#waitingFor(i) - 1
		this.#waiting[i] = left
		if (left === 0) {
			this.#fire(i)
		}
	}

	#countAt(i: number, span: string): void {
		if (this.#waitingFor(i) < 0) {
			return
		}
		this.#pointedAt ??= new Map()
		const seen = this.#pointedAt.get(i) ?? new Set<string>()
		if (seen.has(span)) {
			return
		}
		seen.add(span)
		this.#pointedAt.set(i, seen)
		this.#count(i)
	}
}

/**
 * A fragment's dependency table: its heading's columns, the implications and point rules over them and the attributes
 * it carries beyond them (the hidden attributes of what it embeds, and a rule region's variables it does not deliver,
 * which an embedding of the table hides in turn), and the index a closure reads them through. Built once by a draft's
 * freeze, it never changes but for the counts of its work (closures, explanations).
 *
 * A closure is linear in the table (Beeri and Bernstein): each implication counts the facts it still waits on, and a
 * fact, once learned, decrements the count of every implication and point rule waiting on it, which fires at zero.
 */
export class Dependencies {
	readonly columns: ReadonlyArray<string>
	readonly implications: ReadonlyArray<Implication>
	readonly points: ReadonlyArray<PointRule>
	/** The heading's columns, which a closure's start is read among. */
	readonly heading: ReadonlySet<string>
	/** The evidence contexts the table's justifications hold in, least demanding first, one of each demand. */
	readonly stages: ReadonlyArray<EvidenceContext>
	/** How many closures the table has run. */
	#closures = 0
	/** How many derivations the table has explained. */
	#explanations = 0

	private constructor(
		columns: ReadonlyArray<string>,
		implications: ReadonlyArray<Implication>,
		points: ReadonlyArray<PointRule>
	) {
		this.columns = columns
		this.implications = implications
		this.points = points
		this.heading = new Set(columns)
		const used = new Set<EvidenceContext>([
			...implications.map((i) => i.just.context),
			...points.map((p) => p.just.context)
		])
		this.stages = evidenceContexts
			.filter((c) => used.has(c))
			.toSorted((a, b) => (lessDemanding(a, b) ? -1 : lessDemanding(b, a) ? 1 : 0))
			.filter((c, i, all) => {
				const prior = all[i - 1]
				return prior === undefined || lessDemanding(prior, c)
			})
	}

	/**
	 * The table of a fragment of heading `columns`, holding exactly what of `implications` and `points` can matter to a
	 * start among its columns. An implication or point rule that reads an attribute the closure of the whole heading
	 * does not reach never fires, and an attribute from which no derivation leads to a column, to the row or to a point
	 * a kept implication reads changes no answer, so both are dropped. The closure of any start among the columns then
	 * holds the columns, the row and those points the whole table's holds, each by the same derivation.
	 */
	static reduce(
		columns: ReadonlyArray<string>,
		implications: ReadonlyArray<Implication>,
		points: ReadonlyArray<PointRule>
	): Dependencies {
		const whole = new Dependencies(columns, implications, points)
		const reached = whole.closure(columns)
		const knows = (a: string): boolean => reached.columns.has(a)
		const pointed = (s: string): boolean => knows(s) || reached.points.has(s)
		const firing = implications.filter((imp) => imp.from.every(knows) && imp.at.every(pointed))
		const pinning = points.filter((rule) => rule.from.every(knows))
		const deriving = new Map<string, Array<Implication>>()
		for (const imp of firing) {
			for (const t of imp.to) {
				const list = deriving.get(t)
				if (list === undefined) {
					deriving.set(t, [imp])
				} else {
					list.push(imp)
				}
			}
		}
		const pinningSpan = new Map<string, Array<PointRule>>()
		for (const rule of pinning) {
			const list = pinningSpan.get(rule.span)
			if (list === undefined) {
				pinningSpan.set(rule.span, [rule])
			} else {
				list.push(rule)
			}
		}
		const useful = new Set<string>()
		const usefulSpans = new Set<string>()
		const keptImps = new Set<Implication>()
		const keptPoints = new Set<PointRule>()
		const queue: Array<string> = []
		const need = (a: string): void => {
			if (!useful.has(a)) {
				useful.add(a)
				queue.push(a)
			}
		}
		const needPoint = (span: string): void => {
			if (usefulSpans.has(span)) {
				return
			}
			usefulSpans.add(span)
			for (const rule of pinningSpan.get(span) ?? []) {
				if (!keptPoints.has(rule)) {
					keptPoints.add(rule)
					for (const c of rule.from) {
						need(c)
					}
				}
			}
		}
		for (const c of [...columns, rowAttribute]) {
			need(c)
		}
		for (const a of queue) {
			for (const imp of deriving.get(a) ?? []) {
				if (keptImps.has(imp)) {
					continue
				}
				keptImps.add(imp)
				for (const c of [...imp.from, ...imp.at]) {
					need(c)
				}
				for (const span of imp.at) {
					needPoint(span)
				}
			}
		}
		const kept = firing.flatMap((imp): ReadonlyArray<Implication> => {
			if (!keptImps.has(imp)) {
				return []
			}
			const to = imp.to.filter((t) => useful.has(t))
			return [to.length === imp.to.length ? imp : { ...imp, to }]
		})
		return new Dependencies(
			columns,
			kept,
			pinning.filter((rule) => keptPoints.has(rule))
		)
	}

	/**
	 * Every fact the start determines, each with the dependency that derived it. A start is among the heading's columns:
	 * the row and the attributes beyond the heading are what a closure derives, never what it starts from.
	 */
	closure(start: Iterable<string>): FactClosure {
		return new Questioning(this).closure(start, "every")
	}

	/** How many closures the table has run: the work of its questions, which a property bounds. */
	get closures(): number {
		return this.#closures
	}

	/** How many derivations the table has explained (explain): the work of its proofs, which a property bounds. */
	get explanations(): number {
		return this.#explanations
	}

	/** Counts a closure of the table (Questioning closure). */
	countClosure(): void {
		this.#closures += 1
	}

	/**
	 * The justification of the targets' derivation: the dependencies and point rules that reached them, transitively,
	 * and, for each region identification on it, which of its occurrences the start identified itself (annotateJoin).
	 */
	explain(closure: FactClosure, targets: Iterable<string>): Justification {
		this.#explanations += 1
		const usedImplications = new Map<number, Implication>()
		const usedPoints = new Map<number, PointRule>()
		const seen = new Set<string>()
		const stack: Array<Fact> = [...targets].map((column) => ({ kind: "column", column }))
		for (let fact = stack.pop(); fact !== undefined; fact = stack.pop()) {
			/**
			 * A pinned point is explained by the rule that pinned it, which the closure learned before anything derived from
			 * the point, its span's column among them. A span known by its value before any rule pinned it has every point
			 * known, and its point is explained as the column is.
			 */
			const column = fact.kind === "column" || !closure.points.has(fact.span)
			const key = fact.kind === "column" ? fact.column : fact.span
			const name = `${column ? "c" : "p"}${rowAttribute}${key}`
			if (seen.has(name)) {
				continue
			}
			seen.add(name)
			const how = defined(
				column ? closure.columns.get(key) : closure.points.get(key),
				"an explained fact is one its closure learned"
			)
			switch (how.kind) {
				case "start":
					continue
				case "implication": {
					usedImplications.set(how.index, how.implication)
					appendAll(stack, [
						...how.implication.from.map((c): Fact => ({ kind: "column", column: c })),
						...how.implication.at.map((s): Fact => ({ kind: "point", span: s }))
					])
					continue
				}
				case "point":
					usedPoints.set(how.index, how.rule)
					appendAll(
						stack,
						how.rule.from.map((c): Fact => ({ kind: "column", column: c }))
					)
					continue
			}
		}
		return joinJustifications([
			...[...usedImplications]
				.toSorted(([a], [b]) => a - b)
				.map(([, imp]) =>
					imp.join.length === 0 ? imp.just : withReason(imp.just, annotateJoin(closure, imp.join))
				),
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
	 * Whether the start identifies at most one row, and on its strongest proof: the one that holds in the least
	 * demanding evidence context, found by closing under the dependencies of each context in turn, least demanding
	 * first, the last stage admitting every dependency. So a scan that reads an immediate key is proved unique by that
	 * key alone, never through a deferrable one it also determines.
	 */
	proof(start: ReadonlyArray<string>): Justification | undefined {
		const found = new Questioning(this).staged(start, this.stages.length - 1)
		return found === undefined ? undefined : this.#explained(found)
	}

	/** The justification of a staged proof: the derivation of the row in its closure (explain). */
	#explained(found: Staged): Justification {
		return this.explain(found.closure, [rowAttribute])
	}

	/**
	 * Whether the start, read among the heading's columns, identifies at most one row: its strongest proof and the
	 * canonical minimal key among its columns (keyAmong).
	 */
	identification(start: Iterable<string>): Identification | undefined {
		const asking = new Questioning(this)
		const candidate = inHeadingOrder(this.columns, start)
		const found = asking.staged(candidate, this.stages.length - 1)
		if (found === undefined) {
			return undefined
		}
		return { just: this.#explained(found), key: asking.minimized(candidate, found).key }
	}

	/**
	 * The canonical minimal key among `columns`, read in heading order, when they identify a row: each column dropped,
	 * from the end of the heading, while the rest still identifies a row on a proof no more demanding. The greedy
	 * reduction asks one closure per column, so it is polynomial where the minimal keys a search would enumerate are
	 * not; no column of the key it keeps can be dropped on a proof as strong, since a subset of a start reaches less,
	 * and its proof holds wherever the whole candidate's does.
	 */
	keyAmong(columns: Iterable<string>): JustifiedKey | undefined {
		const asking = new Questioning(this)
		const candidate = inHeadingOrder(this.columns, columns)
		const found = asking.staged(candidate, this.stages.length - 1)
		if (found === undefined) {
			return undefined
		}
		const minimal = asking.minimized(candidate, found)
		const proof =
			minimal.proof.kind === "closed"
				? minimal.proof.staged
				: defined(
						asking.staged(minimal.key, found.stage),
						"a key the reduction narrowed identifies a row at its candidate's stage"
					)
		return { columns: minimal.key, just: this.#explained(proof) }
	}
}

/**
 * One question asked of a dependency table (Dependencies closure, proof, identification, keyAmong): the index its
 * closures read the table through, each admission's counts a closure starts from, and each attribute's deriving
 * implications, each built at the question's first need of it and shared by every closure the question runs, so a key
 * reduction's closures read the table once for each stage (`#counts`). None outlives the question: a table keeps its
 * columns, dependencies and stages alone, where each kept its index and counts as long as it lived, as every node's
 * properties do (qti's write compile at hub a8dbf06b8: 309 MB of its two placement analyses' 1,064 MB of tables).
 */
class Questioning {
	readonly #table: Dependencies
	#waiting: Waiting | undefined = undefined
	/** Each admission's counts a closure starts from (`#counts`), by the stage it closes through, built at its first. */
	readonly #starts = new Map<Admission, Counts>()
	/** Each attribute's deriving implications (`#derivers`), built at the question's first key reduction. */
	#deriving: ReadonlyMap<string, ReadonlyArray<number>> | undefined = undefined

	constructor(table: Dependencies) {
		this.#table = table
	}

	/** The index the question's closures read the table through, built at its first closure. */
	#index(): Waiting {
		this.#waiting ??= indexed(this.#table.implications, this.#table.points)
		return this.#waiting
	}

	/**
	 * What a closure through `admission` starts from: how many facts each implication and point rule waits on, -1 for one
	 * it does not admit. Read off the table once for each admission the question's closures close through, every closure
	 * after the first copying it, where each closure asked every dependency's justification again.
	 */
	#counts(admission: Admission): Counts {
		return this.#starts.getOrInsertComputed(admission, () => {
			const table = this.#table
			const admit =
				admission === "every"
					? everything
					: admittedThrough(defined(table.stages[admission], "a stage the table holds"))
			const implications = new Int32Array(table.implications.length)
			for (const [i, imp] of table.implications.entries()) {
				implications[i] = admit(imp.just) ? imp.from.length + imp.at.length : -1
			}
			const points = new Int32Array(table.points.length)
			for (const [i, rule] of table.points.entries()) {
				points[i] = admit(rule.just) ? rule.from.length : -1
			}
			return { implications, points }
		})
	}

	/** Whether a dependency of the table reads `column`: an implication from it or at it, or a point rule from it. */
	#reads(column: string): boolean {
		const waiting = this.#index()
		return (
			waiting.fromColumn.has(column) || waiting.atSpan.has(column) || waiting.pointFrom.has(column)
		)
	}

	/** Every fact `start` determines through `admission` (Dependencies closure). */
	closure(start: Iterable<string>, admission: Admission): FactClosure {
		const table = this.#table
		table.countClosure()
		return new FactClosing(table, this.#index(), this.#counts(admission)).closed(
			start,
			table.heading
		)
	}

	/**
	 * The least demanding stage, among the first `last + 1`, whose closure of the start holds the row, with that closure:
	 * the start's strongest proof among those stages, not yet explained.
	 */
	staged(start: ReadonlyArray<string>, last: number): Staged | undefined {
		for (let stage = 0; stage <= last; stage++) {
			const closure = this.closure(start, stage)
			if (closure.columns.has(rowAttribute)) {
				return { stage, closure }
			}
		}
		return undefined
	}

	/**
	 * The greedy reduction of keyAmong, from a candidate proved at `found`. A proof's stage orders proofs as their
	 * contexts do: the proof a stage's closure explains rests on that stage's context exactly, since a derivation by only
	 * less demanding dependencies is one an earlier stage's closure would have found. So a narrower proof no more
	 * demanding is one found at a stage no later than the key's, and a column's removal closes only through the key's
	 * stage, never at a later one whose proof the reduction would refuse. The key's proof is explained once, by its
	 * caller, where each narrower key was explained as it was taken. A column no dependency reads (`#reads`) is dropped
	 * with no closure: a fact no dependency waits on fires nothing, so the rest of the key reaches what the key reached,
	 * at every stage and by the same derivations, and the key's proof stands for the narrower key's.
	 */
	minimized(candidate: KeySet, found: Staged): Minimized {
		let key = candidate
		let proof: Minimized["proof"] = { kind: "closed", staged: found }
		const held = new Set(key)
		const counts = this.#counts(found.stage)
		for (let i = key.length - 1; i >= 0; i--) {
			const column = defined(key[i], "a column of the key")
			const without = key.toSpliced(i, 1)
			if (!this.#reads(column)) {
				key = without
				held.delete(column)
				continue
			}
			held.delete(column)
			if (this.#derivedFrom(column, held, counts)) {
				key = without
				proof = { kind: "narrowed" }
				continue
			}
			const narrower = this.staged(without, found.stage)
			if (narrower !== undefined) {
				key = without
				proof = { kind: "closed", staged: narrower }
			} else {
				held.add(column)
			}
		}
		return { key, proof }
	}

	/**
	 * Whether a dependency the stage of `counts` admits derives `column` from columns all `held`: one whose start is the
	 * rest of a key derives the column, so the rest reaches all the key did.
	 */
	#derivedFrom(column: string, held: ReadonlySet<string>, counts: Counts): boolean {
		for (const i of this.#derivers().get(column) ?? []) {
			const imp = defined(this.#table.implications[i], indexedImplication)
			if (
				defined(counts.implications[i], indexedImplication) >= 0 &&
				imp.from.every((c) => held.has(c)) &&
				imp.at.every((c) => held.has(c))
			) {
				return true
			}
		}
		return false
	}

	/** Each attribute's deriving implications, by index, in the table's order: built at the question's first key
	 * reduction. */
	#derivers(): ReadonlyMap<string, ReadonlyArray<number>> {
		if (this.#deriving === undefined) {
			const deriving = new Map<string, Array<number>>()
			for (const [i, imp] of this.#table.implications.entries()) {
				for (const t of imp.to) {
					deriving.getOrInsertComputed(t, () => []).push(i)
				}
			}
			this.#deriving = deriving
		}
		return this.#deriving
	}
}

/**
 * Functional dependencies with proofs, over one physical fragment's columns and the attributes it carries beyond them.
 *
 * The physical analysis must say not only that a heading is unique but what the claim rests on: the installed
 * constraints, the parameters a fixed component assumes, the equality operators and the coercions. Every dependency
 * therefore carries a Justification, and a closure remembers which dependency derived each attribute, so the
 * justification of a derived fact is exactly the union of the dependencies on its derivation, never the whole table.
 *
 * Uniqueness is a dependency like any other, into the table's row attribute (`row`): a start identifies at most one
 * row exactly when its closure holds the row, so a superkey question is one closure and no key is ever enumerated,
 * whose minimal keys can be exponentially many (Lucchesi and Osborn). A general functional dependency is not a key: a
 * dependency says which columns a row's other columns follow from, never that two rows differ, so a start identifies a
 * row only when its closure reaches `row`, which only the query structure, an exact duplicate elimination and the
 * installed keys put there. A rule
 * region identifies its row by every occurrence's (an occurrence's own row, hidden, reached by its source's keys), a
 * union by every arm's and a literal telling each two apart, a placed DISTINCT by its whole heading, and a fragment of
 * at most one row by nothing.
 *
 * A fragment's table holds its heading's columns, a rule region's other variables, and the hidden attributes
 * (`hiddenIn`) its embedded inputs carry: an input's table is embedded whole, renamed, never projected onto the
 * heading, since the projection of a dependency set can need exponentially many dependencies. The dependencies are only
 * those the declared keys and the query structure imply: a column fixed per evaluation (from nothing), two equal
 * columns (each from the other), a key of a scan determining the variables the scan binds, and a computed output
 * determined by the columns it reads.
 *
 * A fact is an attribute's value known, or, for a span, one point inside its value known (a span known has every point
 * known). A nonoverlap key, a stored relation's key with span fields (theory/laws.ts), holds at most one fact whose
 * spans hold given points for each value of its scalar fields, so its dependency reads its spans `at` a point. A point
 * rule derives a span's point from columns: a predicate holding the span to contain a value, or a nonempty span, those
 * columns compute.
 *
 * A draft is built by a node's rule and frozen once (freeze) into the table every question reads.
 */
export class DependencyDraft {
	readonly #members: ReadonlySet<string>
	readonly #imps: Array<Implication> = []
	readonly #points: Array<PointRule> = []
	/** The namespaces of the draft's embeddings, each its own (embed). */
	readonly #namespaces = new Set<string>()
	/** Whether the draft extends a table (extend), which makes it a draft of no other table. */
	#extended = false
	/** How many hidden attributes of embedded tables the draft has named (embed). */
	#hidden = 0

	/** A draft over `universe`, the attributes a rule names: a node's heading, or a region's variables. */
	constructor(universe: ReadonlyArray<string>) {
		this.#members = new Set(universe)
	}

	/** Whether the draft holds an attribute: one of its universe, or a hidden one. */
	has(attribute: string): boolean {
		return this.#members.has(attribute) || isHidden(attribute)
	}

	imply(from: ReadonlyArray<string>, to: ReadonlyArray<string>, just: Justification): void {
		this.#add(from, [], to, just, ownOrigin, [])
	}

	/** `from` with one known point of each span of `at` determines `to`. */
	implyAt(
		from: ReadonlyArray<string>,
		at: ReadonlyArray<string>,
		to: ReadonlyArray<string>,
		just: Justification
	): void {
		this.#add(from, at, to, just, ownOrigin, [])
	}

	/** `from` determines `to`, as part of the embedding `namespace` names (an occurrence's known columns). */
	implyWithin(
		namespace: string,
		from: ReadonlyArray<string>,
		to: ReadonlyArray<string>,
		just: Justification
	): void {
		this.#add(from, [], to, just, embeddedIn(namespace, ownOrigin), [])
	}

	/** `from` identifies at most one row. */
	identify(from: ReadonlyArray<string>, just: Justification): void {
		this.#add(from, [], [rowAttribute], just, ownOrigin, [])
	}

	/** A rule region's row is identified by every one of its occurrences' rows, `joined`. */
	identifyByJoin(joined: ReadonlyArray<JoinedOccurrence>, just: Justification): void {
		this.#add(
			joined.map((o) => o.row),
			[],
			[rowAttribute],
			just,
			ownOrigin,
			joined
		)
	}

	/** `from` determines a point of the span `span`. */
	pin(from: ReadonlyArray<string>, span: string, just: Justification): void {
		this.#pin(from, span, just, ownOrigin)
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
	 * Every implication and point rule of `table`, renamed by `embedding`: a heading column read as its first
	 * representative, with what representing it rests on, and determined as every representative; a column with none as
	 * the hidden attribute of the namespace (hiddenIn), which the draft's rules may name; every hidden attribute as one
	 * numbered anew under the namespace, which no rule names; the row as the embedding's row. Each embedding of a draft
	 * has a namespace of its own, so the draft names no two embedded attributes alike.
	 */
	embed(table: Dependencies, embedding: Embedding): void {
		const heading = new Set(table.columns)
		const ns = embedding.namespace
		if (this.#namespaces.has(ns)) {
			defect(`physical: two embeddings of one dependency draft under the namespace ${ns}`)
		}
		if (this.#extended) {
			defect(`physical: an embedding under ${ns} into a dependency draft that extends a table`)
		}
		this.#namespaces.add(ns)
		/** Each attribute's name in the embedding, made once for every implication and point rule that reads it. */
		const renamed = new Map<string, string>()
		const rename = (a: string): string =>
			a === rowAttribute
				? embedding.row
				: renamed.getOrInsertComputed(a, () => (isHidden(a) ? this.#hiddenIn(ns) : hiddenIn(ns, a)))
		/** Each origin of the embedded table's, within the embedding: one cell for every implication that shares it. */
		const origins = new Map<Origin, Origin>()
		const originOf = (o: Origin): Origin => origins.getOrInsertComputed(o, () => embeddedIn(ns, o))
		const read = (a: string): Rep => {
			const first = heading.has(a) ? embedding.column(a)[0] : undefined
			return first ?? { column: rename(a), just: structural }
		}
		/** The names `to` is written under in the embedding, each target's in turn. */
		const written = (to: ReadonlyArray<string>): ReadonlyArray<string> => {
			const out: Array<string> = []
			for (const a of to) {
				const reps = heading.has(a) ? embedding.column(a) : []
				if (reps.length === 0) {
					out.push(rename(a))
				} else {
					for (const r of reps) {
						out.push(r.column)
					}
				}
			}
			return out
		}
		for (const imp of table.implications) {
			const local = embedding.localize(imp.just)
			if (local === undefined) {
				continue
			}
			const from = imp.from.map(read)
			const at = imp.at.map(read)
			this.#add(
				[...from.map((r) => r.column), ...local.from],
				at.map((r) => r.column),
				written(imp.to),
				joinJustifications([local.just, ...from.map((r) => r.just), ...at.map((r) => r.just)]),
				originOf(imp.origin),
				imp.join.map((o) => ({ row: rename(o.row), origin: originOf(o.origin) }))
			)
		}
		for (const rule of table.points) {
			const local = embedding.localize(rule.just)
			if (local === undefined) {
				continue
			}
			const from = rule.from.map(read)
			this.#pin(
				[...from.map((r) => r.column), ...local.from],
				read(rule.span).column,
				joinJustifications([local.just, ...from.map((r) => r.just)]),
				originOf(rule.origin)
			)
		}
	}

	/**
	 * Every implication and point rule of `table`, the very ones, where the draft is the table's own extended: a draft of
	 * no table before it and of no other after it (embed refuses one), whose universe holds every column of the table's
	 * heading under its own name, and whose rows are the table's rows, its justifications holding as they are
	 * (analysis/physical/rules.ts extendSame: a filter, a semi-join's left, a step, a take, a window). That is the identity
	 * embedding, which embed copied each dependency through under the namespace `input`, and the copies are the same
	 * dependencies but for two things no answer reads:
	 *
	 * - a hidden attribute's name: embed numbered each anew so that two embeddings of one draft never meet, and with no
	 *   other embedding the table's own names meet none either, the draft's own rules naming its heading's columns and
	 *   its row alone, which are the table's;
	 * - an origin: embed added the namespace before every origin it carried, an implication's and each of its joined
	 *   occurrences' alike, and adding one namespace before every origin, or none, keeps which of them lies within which
	 *   (`within`, a prefix): the joined occurrences a closure's `directly` compares an implication's origin with are
	 *   carried with it, and the draft's own dependencies, whose origin is its own, lie within no occurrence's, which
	 *   holds at least the region's namespace for it.
	 *
	 * So every closure, proof, key and explanation of the draft is the copying draft's, and a chain of nodes that keep
	 * their input's rows shares one set of dependencies, where each node held a copy of its input's (edullm's qti and
	 * pantry drafts: 31% of the dependencies the analysis embedded).
	 */
	extend(table: Dependencies): void {
		if (
			this.#extended ||
			this.#namespaces.size > 0 ||
			this.#imps.length > 0 ||
			this.#points.length > 0
		) {
			defect("physical: a dependency draft extends a table only as the first table it holds")
		}
		for (const c of table.columns) {
			if (!this.#members.has(c)) {
				defect(`physical: an extended table's column ${c} is no column of its draft`)
			}
		}
		this.#extended = true
		appendAll(this.#imps, table.implications)
		appendAll(this.#points, table.points)
	}

	/** A hidden attribute of a table the embedding `namespace` brings, named anew: numbered among the draft's. */
	#hiddenIn(namespace: string): string {
		const n = this.#hidden
		this.#hidden = n + 1
		return hiddenIn(namespace, `${rowAttribute}${n}`)
	}

	/** The table of this draft for a fragment of heading `columns`, reduced (Dependencies reduce). */
	freeze(columns: ReadonlyArray<string>): Dependencies {
		return Dependencies.reduce(columns, this.#imps, this.#points)
	}

	#add(
		from: ReadonlyArray<string>,
		at: ReadonlyArray<string>,
		to: ReadonlyArray<string>,
		just: Justification,
		origin: Origin,
		join: ReadonlyArray<JoinedOccurrence>
	): void {
		const f = shared([...new Set(from)])
		const a = shared([...new Set(at)].filter((c) => !f.includes(c)))
		const t = [...new Set(to)].filter((c) => this.has(c) && !f.includes(c))
		if (t.length === 0 || !f.every((c) => this.has(c)) || !a.every((c) => this.has(c))) {
			return
		}
		this.#imps.push({ from: f, at: a, to: t, just, origin, join: shared(join) })
	}

	#pin(from: ReadonlyArray<string>, span: string, just: Justification, origin: Origin): void {
		const f = shared([...new Set(from)])
		if (!this.has(span) || f.includes(span) || !f.every((c) => this.has(c))) {
			return
		}
		this.#points.push({ from: f, span, just, origin })
	}
}
