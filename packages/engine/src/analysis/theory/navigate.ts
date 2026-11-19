import { refuse } from "#compiler/analysis/theory/build.ts"
import { boundIn, mapBindings, mapLeaves, varsOf } from "#compiler/analysis/theory/leaves.ts"
import { leavesOf, ruleLeaves } from "#compiler/check/scan.ts"
import { appendAll } from "#compiler/core/array.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import {
	type Channel,
	exprChildren,
	type InferredBindings,
	type InferredExpr,
	type InferredMatch,
	type InferredQuery,
	type InferredRule,
	type InferredSource,
	type VarDesc
} from "#compiler/ir/desc.ts"

/**
 * Navigation: a conjunctive rule over stored relations as one chain of steps (ir/desc.ts SourceDesc `step`, ir/rel.ts
 * Step), each a read of one stored or closed relation alone, by the columns the steps before it bound. A write
 * member's query and every query the judge reads (`navigateQuery`) are such rules: a join of the live definitions its
 * matches import, each a join of a few stored relations, or a read of one relation that negates such a join.
 *
 * Navigation re-associates the rule's conjunction; it changes no fact the rule derives. Each imported query the rule
 * matches is inlined, its variables renamed apart, its parameters replaced by what its bind map binds them to, and its
 * head equated with the terms the match binds it at (`#inline`); a variable then bound by no match is the term an
 * equality defines (`#defined`). The matches are then read in an order of their own (`#chain`): from the values the
 * rule holds, its parameters and literals, each next match the one with the most columns keyed so far, bound to a
 * parameter or to a variable the steps placed bound, directly or by an equality with them, then the one with the most
 * columns bound at all, literals among them, the earliest declared among equals: a literal alone is no key, a constant
 * every key's rows may share, so a read a literal alone binds never goes before one a key binds. That is how a rule's
 * probe starts from the row its write touched, and how a member walks a qti package: from the package's documents by
 * its own key, down to a node's children by (package, path, parent), and up to a node's parent by its primary key,
 * never by (package, path) alone while a narrower lookup is left.
 *
 * Each match is its own step: an import of one rule over its relation, every column a variable the steps before it bound
 * read through a channel (ir/desc.ts Channel) its bind map binds to that variable, every parameter of the rule passed in
 * as itself, its other columns delivered under head names of its own. A condition is placed inside the first step after
 * which every variable it reads is bound. A relational filter, a negation or an existence, is a chain of its own,
 * correlated through its channels: a filtered relation one step, a filtered query each rule of it navigated with its
 * head equated with the terms it is filtered at.
 *
 * Each step is a Step node, which every lowering prints as a subquery PostgreSQL never pulls up (lower/conservative/step),
 * read LATERAL after the steps it reads: PostgreSQL plans each step alone, a lookup of one relation by the values the
 * row before it holds, and cannot reorder two steps or join them at once, so no estimate it makes, with statistics or
 * none, can turn the walk into a join of every relation the rule reads.
 */

const channel: Channel = { kind: "channel" }

const varRef = (id: string): InferredExpr => ({ kind: "var", var: id })

const eq = (left: InferredExpr, right: InferredExpr): InferredExpr => ({
	kind: "compare",
	op: "eq",
	left,
	right
})

/** Whether `e` is a bare literal, which takes the type of the term it meets and so never stands first. */
const isBare = (e: InferredExpr): boolean => e.kind === "literal" && e.type === undefined

/** `left` = `right`, a bare literal second, as the checker reads an equality. */
const equal = (left: InferredExpr, right: InferredExpr): InferredExpr =>
	isBare(left) ? eq(right, left) : eq(left, right)

/** The variables `e` reads. */
const readsOf = (e: InferredExpr): ReadonlySet<string> => varsOf(e, new Set())

/**
 * Whether a term a read is bound by is keyed: it reads a variable a step bound or a parameter, a value of the row or
 * the call at hand. A literal alone is no key: it is a constant every key's rows may share (a kind, a flag), so a read
 * bound by literals alone reads every key's rows.
 */
const keyedTerm = (e: InferredExpr): boolean => readsOf(e).size > 0 || leavesOf(e).params.length > 0

/** How a read is looked up from the values known so far: its columns bound by a keyed term, and all its columns bound. */
interface Lookup {
	readonly keyed: number
	readonly bound: number
}

/** Whether lookup `a` is narrower than `b`: more columns keyed, then more columns bound. */
const narrower = (a: Lookup, b: Lookup): boolean =>
	a.keyed > b.keyed || (a.keyed === b.keyed && a.bound > b.bound)

/** Whether a relational filter reads no variable of its rule, by its bindings or by the bind map of the query it reads. */
const readsNoVariable = (a: Filtered): boolean => {
	const leaves = leavesOf(a)
	return leaves.vars.size === 0 && leaves.parents.size === 0
}

/** The scalar terms an import's bind map binds its parameters to, or undefined where one binds a relation parameter. */
const scalarBinds = (
	bind: Extract<InferredSource, { readonly kind: "query" }>["bind"]
): ReadonlyMap<string, InferredExpr> | undefined => {
	const out = new Map<string, InferredExpr>()
	for (const [name, b] of Object.entries(bind)) {
		if (b.kind === "relationParam") {
			return undefined
		}
		out.set(name, b)
	}
	return out
}

/**
 * What a read reads: a stored or closed relation, or the delta of one, the rows a transaction wrote of it, which a rule
 * probe over its region matches (analysis/theory/query.ts probes).
 */
type ReadSource = Extract<InferredSource, { readonly kind: "relation" | "delta" }>

/** One match of a stored or closed relation or of a delta, its bindings over the rule's variables. */
interface Read {
	readonly source: ReadSource
	readonly bindings: InferredBindings
	readonly loc: SourceLoc
}

/** The relation a read's rows are rows of: the relation itself, or the relation a delta's rows were written to. */
const relationOf = (source: ReadSource): string =>
	source.kind === "relation" ? source.name : source.relation

/**
 * A conjunctive rule over stored and closed relations, as navigation reads it: its region, the deltas it matches, which
 * the chain reads before any relation, and its reads of relations.
 */
interface Flat {
	readonly vars: ReadonlyArray<VarDesc>
	readonly region: ReadonlyArray<Read>
	readonly reads: ReadonlyArray<Read>
	readonly where: ReadonlyArray<InferredExpr>
	readonly head: InferredRule["head"]
}

/** A relational filter of a rule, a negation or an existence, navigated apart (`Navigator.#filtered`). */
type Filtered = Extract<InferredExpr, { readonly kind: "absent" | "exists" }>

/** Whether `e` is a relational filter (`Filtered`). */
const isFiltered = (e: InferredExpr): e is Filtered => e.kind === "absent" || e.kind === "exists"

/** A rule's reads as one chain of steps (`Navigator.#chain`): the rule's parts, its relational filters still to navigate. */
interface Chain {
	readonly vars: ReadonlyArray<VarDesc>
	readonly matches: ReadonlyArray<InferredMatch>
	readonly where: ReadonlyArray<InferredExpr>
	readonly filters: ReadonlyArray<Filtered>
	readonly head: InferredRule["head"]
}

/**
 * What a step passes in, at nesting `depth`: each variable of its reader a channel bound to it, each parameter of the
 * reader a parameter of the same name, bound to itself.
 */
class Passing {
	readonly bind = new Map<string, InferredExpr>()
	readonly #depth: number

	constructor(depth: number) {
		this.#depth = depth
	}

	/** The channel the reader's variable `id` is passed in under. */
	channel(id: string): InferredExpr {
		const name = `via${this.#depth}.${id}`
		this.bind.set(name, varRef(id))
		return { kind: "param", name, type: channel }
	}

	/** `e` passed in whole: every variable a channel, every parameter itself. */
	expr(e: InferredExpr): InferredExpr {
		return this.within(e, () => false)
	}

	/** `e` passed in but for the variables `own` holds, the step's own. */
	within(e: InferredExpr, own: (id: string) => boolean): InferredExpr {
		for (const p of leavesOf(e).params) {
			if (p.kind === "param") {
				this.bind.set(p.name, p)
			}
		}
		return mapLeaves(e, {
			var: (id) => (own(id) ? undefined : this.channel(id)),
			field: () => undefined
		})
	}
}

/** Navigates rules, `loc` locating a refusal. */
class Navigator {
	readonly #loc: SourceLoc
	#next = 0

	constructor(loc: SourceLoc) {
		this.#loc = loc
	}

	#refuse(what: string): never {
		return refuse("MalformedDescription", this.#loc, `a navigation: ${what}`)
	}

	/**
	 * `rule` navigated at nesting `depth`: a chain of steps, then each of its relational filters, negations and
	 * existences, in declared order, over the rows the chain and the filters before it leave, each a chain of its own.
	 * Every rule but the last is a step the next reads whole, so PostgreSQL judges a filter only of a row every read and
	 * every earlier filter kept, and never reads a filtered relation for a row a read would have dropped.
	 *
	 * A filter that reads no variable, only the rule's parameters and literals, is a condition of the chain's own
	 * rule, as every condition that reads no variable is (`#chain`), all of them in declared order. PostgreSQL judges such
	 * a filter once, as a gating qual of a Result over the plan of the rule that holds it, before that plan reads a row
	 * (createplan.c:804-809, nodeResult.c:81-85), and the gating quals of one rule in declared order where their costs
	 * are equal (get_gating_quals, createplan.c:1007, through order_qual_clauses, a stable sort). Nested as a correlated
	 * negation is, the last would gate the outermost Result and be judged first, reading a later arm's relations for a
	 * row an earlier arm already refutes.
	 */
	rule(rule: InferredRule, depth: number): InferredRule {
		const chain = this.#chain(this.#defined(this.#inline(rule)), depth)
		const kept = Object.fromEntries(chain.vars.map((v, i) => [`k${i}`, varRef(v.id)] as const))
		const gates = chain.filters.filter(readsNoVariable)
		let current: InferredRule = {
			vars: chain.vars,
			matches: chain.matches,
			where: [...chain.where, ...gates.map((a) => this.#filtered(a, depth))],
			head: kept,
			interiors: [],
			attach: [],
			loc: rule.loc
		}
		for (const a of chain.filters.filter((x) => !readsNoVariable(x))) {
			const passed = new Map(
				ruleLeaves(current, true).params.flatMap((p) =>
					p.kind === "param" ? [[p.name, p] as const] : []
				)
			)
			current = {
				vars: chain.vars,
				matches: [
					{
						source: {
							kind: "step",
							query: { stage: { kind: "rules", arms: [current], loc: rule.loc } },
							bind: Object.fromEntries(passed)
						},
						bindings: kept,
						loc: rule.loc
					}
				],
				where: [this.#filtered(a, depth)],
				head: kept,
				interiors: [],
				attach: [],
				loc: rule.loc
			}
		}
		return { ...current, head: chain.head }
	}

	/**
	 * `rule` with every imported query it matches inlined: its one rule's variables under a fresh prefix, its matches and
	 * conditions beside the rule's, and each term the match binds equated with the head field it binds.
	 */
	#inline(rule: InferredRule): Flat {
		if (rule.interiors.length > 0 || rule.attach.length > 0) {
			return this.#refuse("a rule with interiors or attachments")
		}
		const vars: Array<VarDesc> = [...rule.vars]
		const region: Array<Read> = []
		const reads: Array<Read> = []
		const where: Array<InferredExpr> = [...rule.where]
		for (const m of rule.matches) {
			const source = m.source
			if (source.kind === "relation") {
				reads.push({ source, bindings: m.bindings, loc: m.loc })
				continue
			}
			if (source.kind === "delta") {
				region.push({ source, bindings: m.bindings, loc: m.loc })
				continue
			}
			const binds = source.kind === "query" ? scalarBinds(source.bind) : undefined
			if (source.kind !== "query" || binds === undefined) {
				return this.#refuse(`a match of a ${source.kind} source`)
			}
			const stage = source.query.stage
			if (stage.kind !== "rules" || stage.arms.length !== 1) {
				return this.#refuse("an imported query of one rule")
			}
			const prefix = `n${this.#next++}.`
			const leaves = { var: (id: string) => varRef(`${prefix}${id}`), field: () => undefined }
			/** An inner expression in the rule's scope: its variables renamed apart, its parameters what the import binds. */
			const lift = (e: InferredExpr): InferredExpr => boundIn(mapLeaves(e, leaves), binds)
			const inner = this.#inline(stage.arms[0])
			appendAll(
				vars,
				inner.vars.map((v) => ({ ...v, id: `${prefix}${v.id}` }))
			)
			const lifted = (r: Read): Read => ({
				...r,
				bindings: Object.fromEntries(
					Object.entries(r.bindings).map(([column, e]) => [column, lift(e)] as const)
				)
			})
			appendAll(region, inner.region.map(lifted))
			appendAll(reads, inner.reads.map(lifted))
			appendAll(where, inner.where.map(lift))
			for (const [field, outer] of Object.entries(m.bindings)) {
				const head = inner.head[field]
				if (head === undefined || head.kind === "aggregate" || head.kind === "producer") {
					return this.#refuse(`an imported query whose head derives ${field}`)
				}
				where.push(equal(lift(head), outer))
			}
		}
		return { vars, region, reads, where, head: rule.head }
	}

	/**
	 * `flat` with every variable no read binds replaced by the term an equality equates it with, and that equality
	 * dropped: what an inlined import's head equated with a term only the import's match bound. A variable a read binds
	 * stays the read's own, so every relational filter and the head still read the row the chain delivers. Every variable left is
	 * one a read binds.
	 */
	#defined(flat: Flat): Flat {
		const bound = new Set(
			[...flat.region, ...flat.reads].flatMap((r) =>
				Object.values(r.bindings).flatMap((e) => [...readsOf(e)])
			)
		)
		const defines = (v: InferredExpr, term: InferredExpr): string | undefined => {
			if (v.kind !== "var" || readsOf(term).has(v.var)) {
				return undefined
			}
			return bound.has(v.var) ? undefined : v.var
		}
		for (const [at, w] of flat.where.entries()) {
			if (w.kind !== "compare" || w.op !== "eq") {
				continue
			}
			const left = defines(w.left, w.right)
			const right = left === undefined ? defines(w.right, w.left) : undefined
			const name = left ?? right
			if (name === undefined) {
				continue
			}
			const term = left === undefined ? w.left : w.right
			const leaves = {
				var: (id: string) => (id === name ? term : undefined),
				field: () => undefined
			}
			return this.#defined({
				vars: flat.vars.filter((v) => v.id !== name),
				region: flat.region.map((r) => ({ ...r, bindings: mapBindings(r.bindings, leaves) })),
				reads: flat.reads.map((r) => ({ ...r, bindings: mapBindings(r.bindings, leaves) })),
				where: flat.where.flatMap((x, i) => (i === at ? [] : [mapLeaves(x, leaves)])),
				head: Object.fromEntries(
					Object.entries(flat.head).map(([k, h]) => [
						k,
						h.kind === "aggregate" || h.kind === "producer" ? h : mapLeaves(h, leaves)
					])
				)
			})
		}
		const unbound = flat.vars.find((v) => !bound.has(v.id))
		return unbound === undefined ? flat : this.#refuse(`variable ${unbound.id} bound by no match`)
	}

	/**
	 * The reads of `flat` as one chain of steps, at nesting `depth`: its region first, the rows a transaction wrote that a
	 * rule probe over its region starts from (analysis/theory/query.ts probes), then its reads of relations in their
	 * order (module doc). Each condition is placed inside the first step after which every variable it reads is bound; a
	 * condition no variable of which a step binds stays the rule's own; the relational filters are left to `rule`.
	 */
	#chain(flat: Flat, depth: number): Chain {
		const declared = new Map(flat.vars.map((v) => [v.id, v] as const))
		const known = new Set<string>()
		let reads = [...flat.reads]
		let pending: Array<InferredExpr> = []
		const filters: Array<Filtered> = []
		const head = flat.head
		const where: Array<InferredExpr> = []
		for (const c of flat.where) {
			if (isFiltered(c)) {
				filters.push(c)
			} else if (readsOf(c).size === 0) {
				where.push(c)
			} else {
				pending.push(c)
			}
		}
		const isKnown = (e: InferredExpr): boolean => [...readsOf(e)].every((id) => known.has(id))
		/**
		 * The variables an equality still pending fixes to values the steps placed so far hold, each with whether one
		 * such value is keyed (`keyedTerm`).
		 */
		const fixed = (): ReadonlyMap<string, boolean> => {
			const out = new Map<string, boolean>()
			for (const c of pending) {
				if (c.kind === "compare" && c.op === "eq") {
					for (const [v, term] of [
						[c.left, c.right],
						[c.right, c.left]
					] as const) {
						if (v.kind === "var" && isKnown(term)) {
							out.set(v.var, out.get(v.var) === true || keyedTerm(term))
						}
					}
				}
			}
			return out
		}
		/** How a read is looked up from the values known so far (`Lookup`). */
		const lookupOf = (r: Read, values: ReadonlyMap<string, boolean>): Lookup => {
			let keyed = 0
			let bound = 0
			for (const e of Object.values(r.bindings)) {
				const ids = [...readsOf(e)]
				if (ids.every((id) => known.has(id) || values.has(id))) {
					bound++
					if (
						leavesOf(e).params.length > 0 ||
						ids.some((id) => known.has(id) || values.get(id) === true)
					) {
						keyed++
					}
				}
			}
			return { keyed, bound }
		}
		const vars: Array<VarDesc> = []
		const matches: Array<InferredMatch> = []
		/** `read` placed as the next step, its variables bound from then on. */
		const place = (read: Read): void => {
			const passing = new Passing(depth)
			const own = new Set<string>()
			const bindings: Record<string, InferredExpr> = {}
			for (const [column, e] of Object.entries(read.bindings)) {
				if (isKnown(e)) {
					bindings[column] = passing.expr(e)
				} else if (e.kind === "var") {
					own.add(e.var)
					bindings[column] = e
				} else {
					const hidden = `h${this.#next++}.${column}`
					own.add(hidden)
					declared.set(hidden, {
						id: hidden,
						origin: { relation: relationOf(read.source), field: column },
						loc: read.loc
					})
					bindings[column] = varRef(hidden)
					pending.push(equal(varRef(hidden), e))
				}
			}
			const inner: Array<InferredExpr> = []
			pending = pending.filter((c) => {
				if ([...readsOf(c)].every((id) => known.has(id) || own.has(id))) {
					inner.push(passing.within(c, (id) => own.has(id)))
					return false
				}
				return true
			})
			const outputs = [...own]
			const stepVars = outputs.map(
				(id) => declared.get(id) ?? this.#refuse(`a declaration of variable ${id}`)
			)
			const delivered = Object.fromEntries(outputs.map((id, i) => [`o${i}`, varRef(id)] as const))
			const step: InferredSource = {
				kind: "step",
				query: {
					stage: {
						kind: "rules",
						arms: [
							{
								vars: stepVars,
								matches: [{ source: read.source, bindings, loc: read.loc }],
								where: inner,
								head: delivered,
								interiors: [],
								attach: [],
								loc: read.loc
							}
						],
						loc: read.loc
					}
				},
				bind: Object.fromEntries(passing.bind)
			}
			matches.push({ source: step, bindings: delivered, loc: read.loc })
			appendAll(vars, stepVars)
			for (const id of outputs) {
				known.add(id)
			}
		}
		for (const read of flat.region) {
			place(read)
		}
		while (reads.length > 0) {
			const values = fixed()
			let best = 0
			for (const [i, r] of reads.entries()) {
				const current = reads[best]
				if (current !== undefined && narrower(lookupOf(r, values), lookupOf(current, values))) {
					best = i
				}
			}
			const read = reads[best]
			if (read === undefined) {
				return this.#refuse("a read to place")
			}
			reads = reads.filter((_, i) => i !== best)
			place(read)
		}
		const left = pending.filter((c) => !isKnown(c))
		if (left.length > 0) {
			return this.#refuse("a condition over variables no read binds")
		}
		return { vars, matches, where: [...where, ...pending], filters, head }
	}

	/**
	 * A relational filter as a chain of its own, of its own kind, at nesting `depth` of the rule that filters: a filtered
	 * relation one step reading it by the terms it is filtered at, a filtered arm its rule navigated with its head
	 * equated with those terms, each passed in through the filter's channels.
	 */
	#filtered(a: Filtered, depth: number): InferredExpr {
		const passing = new Passing(depth)
		const source = a.source
		switch (source.kind) {
			case "relation": {
				const bindings = Object.fromEntries(
					Object.entries(a.bindings).map(([column, e]) => [column, passing.expr(e)] as const)
				)
				const step: InferredSource = {
					kind: "step",
					query: {
						stage: {
							kind: "rules",
							arms: [
								{
									vars: [],
									matches: [{ source, bindings, loc: this.#loc }],
									where: [],
									head: {},
									interiors: [],
									attach: [],
									loc: this.#loc
								}
							],
							loc: this.#loc
						}
					},
					bind: Object.fromEntries(passing.bind)
				}
				return { kind: a.kind, source: step, bindings: {} }
			}
			case "query": {
				const stage = source.query.stage
				if (Object.keys(source.bind).length > 0 || stage.kind !== "rules") {
					return this.#refuse("a filter of an imported query of rules binding no parameter")
				}
				const navigated = mapNonEmpty(stage.arms, (arm) => {
					const at: Array<InferredExpr> = []
					for (const [field, outer] of Object.entries(a.bindings)) {
						const head = arm.head[field]
						if (head === undefined || head.kind === "aggregate" || head.kind === "producer") {
							return this.#refuse(`a filtered query whose head derives ${field}`)
						}
						at.push(equal(head, passing.expr(outer)))
					}
					return this.rule({ ...arm, where: [...arm.where, ...at] }, depth + 1)
				})
				return {
					kind: a.kind,
					source: {
						kind: "query",
						query: { stage: { kind: "rules", arms: navigated, loc: stage.loc } },
						bind: Object.fromEntries(passing.bind)
					},
					bindings: {}
				}
			}
			case "step":
			case "param":
			case "paramOf":
			case "interior":
			case "self":
			case "delta":
			case "context":
			case "row":
				return this.#refuse(`a filter of a ${source.kind} source`)
		}
	}
}

/**
 * The rule `rule` navigated (module doc): the same facts, read as one chain of steps from the values it holds, its
 * negations chains of their own. `loc` locates a refusal, which only a rule `navigateQuery` does not hand it meets.
 */
const navigate = (rule: InferredRule, loc: SourceLoc): InferredRule =>
	new Navigator(loc).rule(rule, 0)

/** Whether a scalar condition holds a relational filter anywhere below its top, where navigation reads none (`navigable`). */
const filtersBelow = (e: InferredExpr): boolean =>
	isFiltered(e) || exprChildren(e).some((c) => filtersBelow(c.term))

/**
 * Whether a rule of an imported query, matched or negated at `bindings`, delivers a field of its head as a bare literal
 * that a bare literal binds: the equality navigation states of the two (`Navigator.#inline`, `#filtered`) types neither
 * side, which the checker refuses, and whether the two are equal is the field's type's to say, a numeric's scale or a
 * domain's, which navigation does not read.
 */
const literalAtLiteral = (
	rule: InferredRule,
	bindings: Readonly<Record<string, InferredExpr>>
): boolean =>
	Object.entries(bindings).some(([field, term]) => {
		const head = rule.head[field]
		return head?.kind === "literal" && isBare(head) && isBare(term)
	})

/**
 * The stored and closed relations and the deltas `rule` reads once its imports are inlined (`Navigator.#inline`), or
 * undefined where navigation reads no such rule: one with interiors, attachments or a folded or produced head, a match of
 * anything but a stored or closed relation, a delta or an imported query of one such rule binding no parameter, a
 * relational filter below a scalar expression, a filter of anything but a stored or closed relation or an imported
 * query of such rules, or a match or a filter of an imported query that binds a literal of its head at a literal
 * (`literalAtLiteral`). A filter, a negation or an existence, is no read the count holds: it keeps or drops a row the
 * reads deliver, so a rule that reads one relation beside a filter is one lookup, and a filter of a delta, which no step
 * reads by an index, leaves the rule as written, where PostgreSQL hashes the delta once per statement.
 */
const readsOfRule = (rule: InferredRule): number | undefined => {
	if (rule.interiors.length > 0 || rule.attach.length > 0) {
		return undefined
	}
	if (Object.values(rule.head).some((h) => h.kind === "aggregate" || h.kind === "producer")) {
		return undefined
	}
	let reads = 0
	for (const m of rule.matches) {
		const source = m.source
		if (source.kind === "relation" || source.kind === "delta") {
			reads += 1
			continue
		}
		if (source.kind !== "query" || scalarBinds(source.bind) === undefined) {
			return undefined
		}
		const stage = source.query.stage
		const inner =
			stage.kind === "rules" &&
			stage.arms.length === 1 &&
			!literalAtLiteral(stage.arms[0], m.bindings)
				? readsOfRule(stage.arms[0])
				: undefined
		if (inner === undefined) {
			return undefined
		}
		reads += inner
	}
	for (const w of rule.where) {
		if (!isFiltered(w)) {
			if (filtersBelow(w)) {
				return undefined
			}
			continue
		}
		const source = w.source
		if (source.kind === "relation") {
			continue
		}
		if (
			source.kind !== "query" ||
			Object.keys(source.bind).length > 0 ||
			source.query.stage.kind !== "rules" ||
			source.query.stage.arms.some(
				(arm) => readsOfRule(arm) === undefined || literalAtLiteral(arm, w.bindings)
			)
		) {
			return undefined
		}
	}
	return reads
}

/**
 * Whether navigation reads `rule` and it joins: it reads two stored or closed relations or more once its imports are
 * inlined (`readsOfRule`), or it filters by a query a rule of which joins (`filtersJoin`). A rule that reads one
 * relation and filters by no join is one lookup already; one navigation reads no part of is no join it reads.
 */
const joins = (rule: InferredRule): boolean => {
	const reads = readsOfRule(rule)
	return reads !== undefined && (reads > 1 || rule.where.some(filtersJoin))
}

/**
 * Whether a condition filters by a query, negated or existing, a rule of which joins (`joins`). Read as written, such
 * a filter is the query's join under the terms it is filtered at, which bind only the relations whose columns the
 * query's head delivers: qti's
 * "Dependency target" negates DependencyResolved at a dependency's (package, path, start), a join of Node and
 * ResourceId at (package, path) under it, ResourceId bound by the dependency's ref alone, which only the dependency's
 * row holds. Navigated, each relation the query reads is a step bound by the terms and the steps before it.
 */
const filtersJoin = (w: InferredExpr): boolean =>
	isFiltered(w) &&
	w.source.kind === "query" &&
	w.source.query.stage.kind === "rules" &&
	w.source.query.stage.arms.some(joins)

/**
 * `rule` navigated where it joins (`joins`); one that does not, with the query each of its steps reads navigated where it
 * joins (`navigateQuery`); itself where nothing in it joins.
 */
const navigatedRule = (rule: InferredRule, loc: SourceLoc): InferredRule => {
	if (joins(rule)) {
		return navigate(rule, loc)
	}
	const matches = rule.matches.map((m): InferredMatch => {
		const source = m.source
		if (source.kind !== "step") {
			return m
		}
		const query = navigateQuery(source.query, loc)
		return query === source.query ? m : { ...m, source: { ...source, query } }
	})
	return matches.every((m, i) => m === rule.matches[i]) ? rule : { ...rule, matches }
}

/**
 * A query navigated wherever it joins: each rule of its one rules stage that joins (`joins`) as a chain of steps
 * (`navigate`), and in each that does not, every step's query so, at any depth; the query itself where nothing in it
 * joins. A write member's query (write/frontend/compile.ts) is a rule over the live definitions its matches import, each
 * a join of a few stored relations, the whole a join of every relation they read. Every query the judge reads
 * (physical/ddl/rules.ts judgedStatement) is navigated so too: a rule probe's, over its region, and a whole rule's
 * violation over its units, whose rule read per unit is a step (analysis/theory/unit.ts perUnit), navigated where it
 * joins within the unit or negates a join, as qti's "Dependency target" does, so no estimate PostgreSQL makes, with
 * statistics or none, reads a join the judge reads as a product it filters afterwards.
 */
export const navigateQuery = (query: InferredQuery, loc: SourceLoc): InferredQuery => {
	const stage = query.stage
	if (stage.kind !== "rules") {
		return query
	}
	const arms = mapNonEmpty(stage.arms, (rule) => navigatedRule(rule, loc))
	return arms.every((rule, i) => rule === stage.arms[i])
		? query
		: { ...query, stage: { ...stage, arms } }
}
