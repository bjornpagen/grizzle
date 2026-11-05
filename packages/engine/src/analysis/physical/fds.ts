import type { MultiplicityReason } from "#compiler/analysis/certificates/reasons.ts"
import { appendAll } from "#compiler/core/array.ts"
import { compareText } from "#compiler/core/canonical.ts"
import type { NodeId, ParamId } from "#compiler/core/ids.ts"
import type { CoercionIdentity } from "#compiler/ir/certificate.ts"
import type { EvidenceContext, Grounds, Premise } from "#compiler/ir/evidence.ts"
import { evidenceContexts, lessDemanding, premiseText, strongest } from "#compiler/ir/evidence.ts"
import { type OpId, sortedOps } from "#compiler/ir/expr.ts"
import type { KeySet } from "#compiler/ir/rel.ts"
import { inHeadingOrder } from "#compiler/logical/closure.ts"

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
		appendAll(reasons, j.reasons)
		appendAll(equality, j.equality)
		appendAll(coercions, j.coercions)
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
	reasons: ReadonlyArray<MultiplicityReason>
): Justification => joinJustifications([j, { ...structural, reasons }])

export const nodePremise = (node: NodeId): Premise => ({ kind: "node", node })
export const paramPremise = (param: ParamId): Premise => ({ kind: "param", param })

/**
 * The attribute a dependency table derives when its start identifies at most one row of its fragment: a superkey is a
 * start whose closure holds it. Every table names its own row this one way; an embedding renames an embedded table's.
 */
export const row = "\u0000"

/**
 * An attribute a table carries beyond its fragment's heading, under the namespace of the embedding that brought it:
 * an embedded table's row, a column of the embedded fragment the embedding gives no column of its own, or a hidden
 * attribute of the embedded table, renamed again. Every hidden attribute begins with the character `row` is, which no
 * column name holds (a declared name is ASCII letters, digits and underscores, and so is every name grizzle mints), so
 * a table's columns and its hidden attributes never meet, and two namespaces of one table never do either.
 */
export const hiddenIn = (namespace: string, attribute: string): string =>
	`${row}${namespace}${row}${attribute}`

const isHidden = (attribute: string): boolean => attribute.startsWith(row)

/** The namespaces of the embeddings an implication passed through, outermost first; none for a table's own. */
type Origin = ReadonlyArray<string>

/** Whether `origin` lies within the embedding `prefix` names. */
const within = (origin: Origin, prefix: Origin): boolean =>
	prefix.length <= origin.length && prefix.every((n, i) => origin[i] === n)

/** One occurrence a rule region's identification joins: its row attribute, and the origin of what its embedding added. */
export interface JoinedOccurrence {
	readonly row: string
	readonly origin: Origin
}

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
): ReadonlyArray<MultiplicityReason> => {
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
		const name = `${column ? "c" : "p"}${row}${key}`
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

/** The implications and point rules waiting on a fact, by index. */
interface Waiting {
	readonly fromColumn: ReadonlyMap<string, ReadonlyArray<number>>
	readonly atSpan: ReadonlyMap<string, ReadonlyArray<number>>
	readonly pointFrom: ReadonlyMap<string, ReadonlyArray<number>>
}

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
 * A fragment's dependency table: its heading's columns, the implications and point rules over them and the attributes
 * it carries beyond them (the hidden attributes of what it embeds, and a rule region's variables it does not deliver,
 * which an embedding of the table hides in turn), and the index a closure reads them through. Built once by a draft's
 * freeze, it never changes.
 *
 * A closure is linear in the table (Beeri and Bernstein): each implication counts the facts it still waits on, and a
 * fact, once learned, decrements the count of every implication and point rule waiting on it, which fires at zero.
 */
export class Dependencies {
	readonly columns: ReadonlyArray<string>
	readonly implications: ReadonlyArray<Implication>
	readonly points: ReadonlyArray<PointRule>
	readonly #waiting: Waiting
	/** The evidence contexts the table's justifications hold in, least demanding first, one of each demand. */
	readonly #stages: ReadonlyArray<EvidenceContext>

	private constructor(
		columns: ReadonlyArray<string>,
		implications: ReadonlyArray<Implication>,
		points: ReadonlyArray<PointRule>
	) {
		this.columns = columns
		this.implications = implications
		this.points = points
		this.#waiting = indexed(implications, points)
		const used = new Set<EvidenceContext>([
			...implications.map((i) => i.just.context),
			...points.map((p) => p.just.context)
		])
		this.#stages = evidenceContexts
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
		for (const c of [...columns, row]) {
			need(c)
		}
		for (let at = 0; at < queue.length; at++) {
			const a = queue[at]
			for (const imp of a === undefined ? [] : (deriving.get(a) ?? [])) {
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
		return this.#closure(start, everything)
	}

	#closure(start: Iterable<string>, admit: Admit): FactClosure {
		const imps = this.implications
		const rules = this.points
		const columns = new Map<string, Step>()
		const points = new Map<string, Step>()
		const waiting = imps.map((imp) => (admit(imp.just) ? imp.from.length + imp.at.length : -1))
		const pointWaiting = rules.map((rule) => (admit(rule.just) ? rule.from.length : -1))
		/** The spans of `at` each implication has already counted as pointed. */
		const pointedAt = new Map<number, Set<string>>()
		const queue: Array<Fact> = []
		const learn = (column: string, step: Step): void => {
			if (!columns.has(column)) {
				columns.set(column, step)
				queue.push({ kind: "column", column })
			}
		}
		const learnPoint = (span: string, step: Step): void => {
			if (!columns.has(span) && !points.has(span)) {
				points.set(span, step)
				queue.push({ kind: "point", span })
			}
		}
		const fire = (i: number): void => {
			const imp = imps[i]
			if (imp === undefined) {
				return
			}
			for (const t of imp.to) {
				learn(t, { kind: "implication", index: i, implication: imp })
			}
		}
		const firePoint = (i: number): void => {
			const rule = rules[i]
			if (rule !== undefined) {
				learnPoint(rule.span, { kind: "point", index: i, rule })
			}
		}
		const count = (i: number): void => {
			const left = (waiting[i] ?? 0) - 1
			waiting[i] = left
			if (left === 0) {
				fire(i)
			}
		}
		const countAt = (i: number, span: string): void => {
			if ((waiting[i] ?? -1) < 0) {
				return
			}
			const seen = pointedAt.get(i) ?? new Set<string>()
			if (seen.has(span)) {
				return
			}
			seen.add(span)
			pointedAt.set(i, seen)
			count(i)
		}
		for (const c of start) {
			if (this.columns.includes(c)) {
				learn(c, fromStart)
			}
		}
		for (const [i, n] of waiting.entries()) {
			if (n === 0) {
				fire(i)
			}
		}
		for (const [i, n] of pointWaiting.entries()) {
			if (n === 0) {
				firePoint(i)
			}
		}
		for (let at = 0; at < queue.length; at++) {
			const fact = queue[at]
			if (fact === undefined) {
				continue
			}
			if (fact.kind === "column") {
				for (const i of this.#waiting.fromColumn.get(fact.column) ?? []) {
					if ((waiting[i] ?? -1) > 0) {
						count(i)
					}
				}
				for (const i of this.#waiting.pointFrom.get(fact.column) ?? []) {
					const left = (pointWaiting[i] ?? 0) - 1
					if ((pointWaiting[i] ?? -1) > 0) {
						pointWaiting[i] = left
						if (left === 0) {
							firePoint(i)
						}
					}
				}
			}
			const span = fact.kind === "column" ? fact.column : fact.span
			for (const i of this.#waiting.atSpan.get(span) ?? []) {
				countAt(i, span)
			}
		}
		return { columns, points }
	}

	/**
	 * The justification of the targets' derivation: the dependencies and point rules that reached them, transitively,
	 * and, for each region identification on it, which of its occurrences the start identified itself (annotateJoin).
	 */
	explain(closure: FactClosure, targets: Iterable<string>): Justification {
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
			const name = `${column ? "c" : "p"}${row}${key}`
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
		for (const stage of this.#stages) {
			const staged = this.#closure(start, (j) => !lessDemanding(stage, j.context))
			if (staged.columns.has(row)) {
				return this.explain(staged, [row])
			}
		}
		return undefined
	}

	/**
	 * Whether the start, read among the heading's columns, identifies at most one row: its strongest proof and the
	 * canonical minimal key among its columns (keyAmong).
	 */
	identification(start: Iterable<string>): Identification | undefined {
		const candidate = inHeadingOrder(this.columns, start)
		const just = this.proof(candidate)
		if (just === undefined) {
			return undefined
		}
		return { just, key: this.#minimized(candidate, just).columns }
	}

	/**
	 * The canonical minimal key among `columns`, read in heading order, when they identify a row: each column dropped,
	 * from the end of the heading, while the rest still identifies a row on a proof no more demanding. The greedy
	 * reduction asks one closure per column, so it is polynomial where the minimal keys a search would enumerate are
	 * not; no column of the key it keeps can be dropped on a proof as strong, since a subset of a start reaches less,
	 * and its proof holds wherever the whole candidate's does.
	 */
	keyAmong(columns: Iterable<string>): JustifiedKey | undefined {
		const candidate = inHeadingOrder(this.columns, columns)
		const just = this.proof(candidate)
		return just === undefined ? undefined : this.#minimized(candidate, just)
	}

	#minimized(candidate: KeySet, just: Justification): JustifiedKey {
		let key = candidate
		let proof = just
		for (let i = key.length - 1; i >= 0; i--) {
			const without = key.toSpliced(i, 1)
			const narrower = this.proof(without)
			if (narrower !== undefined && !lessDemanding(proof.context, narrower.context)) {
				key = without
				proof = narrower
			}
		}
		return { columns: key, just: proof }
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

	/** A draft over `universe`, the attributes a rule names: a node's heading, or a region's variables. */
	constructor(universe: ReadonlyArray<string>) {
		this.#members = new Set(universe)
	}

	/** Whether the draft holds an attribute: one of its universe, or a hidden one. */
	has(attribute: string): boolean {
		return this.#members.has(attribute) || isHidden(attribute)
	}

	imply(from: ReadonlyArray<string>, to: ReadonlyArray<string>, just: Justification): void {
		this.#add(from, [], to, just, [], [])
	}

	/** `from` with one known point of each span of `at` determines `to`. */
	implyAt(
		from: ReadonlyArray<string>,
		at: ReadonlyArray<string>,
		to: ReadonlyArray<string>,
		just: Justification
	): void {
		this.#add(from, at, to, just, [], [])
	}

	/** `from` determines `to`, as part of the embedding `namespace` names (an occurrence's known columns). */
	implyWithin(
		namespace: string,
		from: ReadonlyArray<string>,
		to: ReadonlyArray<string>,
		just: Justification
	): void {
		this.#add(from, [], to, just, [namespace], [])
	}

	/** `from` identifies at most one row. */
	identify(from: ReadonlyArray<string>, just: Justification): void {
		this.#add(from, [], [row], just, [], [])
	}

	/** A rule region's row is identified by every one of its occurrences' rows, `joined`. */
	identifyByJoin(joined: ReadonlyArray<JoinedOccurrence>, just: Justification): void {
		this.#add(
			joined.map((o) => o.row),
			[],
			[row],
			just,
			[],
			joined
		)
	}

	/** `from` determines a point of the span `span`. */
	pin(from: ReadonlyArray<string>, span: string, just: Justification): void {
		this.#pin(from, span, just, [])
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
	 * representative, with what representing it rests on, and determined as every representative; a column with none,
	 * and every hidden attribute, as the hidden attribute of the namespace; the row as the embedding's row.
	 */
	embed(table: Dependencies, embedding: Embedding): void {
		const heading = new Set(table.columns)
		const ns = embedding.namespace
		const rename = (a: string): string => (a === row ? embedding.row : hiddenIn(ns, a))
		const read = (a: string): Rep => {
			const first = heading.has(a) ? embedding.column(a)[0] : undefined
			return first ?? { column: rename(a), just: structural }
		}
		const written = (a: string): ReadonlyArray<string> => {
			const reps = heading.has(a) ? embedding.column(a) : []
			return reps.length === 0 ? [rename(a)] : reps.map((r) => r.column)
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
				imp.to.flatMap(written),
				joinJustifications([local.just, ...from.map((r) => r.just), ...at.map((r) => r.just)]),
				[ns, ...imp.origin],
				imp.join.map((o) => ({ row: rename(o.row), origin: [ns, ...o.origin] }))
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
				[ns, ...rule.origin]
			)
		}
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
		const f = [...new Set(from)]
		const a = [...new Set(at)].filter((c) => !f.includes(c))
		const t = [...new Set(to)].filter((c) => this.has(c) && !f.includes(c))
		if (t.length === 0 || !f.every((c) => this.has(c)) || !a.every((c) => this.has(c))) {
			return
		}
		this.#imps.push({ from: f, at: a, to: t, just, origin, join })
	}

	#pin(from: ReadonlyArray<string>, span: string, just: Justification, origin: Origin): void {
		const f = [...new Set(from)]
		if (!this.has(span) || f.includes(span) || !f.every((c) => this.has(c))) {
			return
		}
		this.#points.push({ from: f, span, just, origin })
	}
}
