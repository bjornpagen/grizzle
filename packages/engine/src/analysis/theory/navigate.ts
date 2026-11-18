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
 * member's query (`navigateMember`) is such a rule: a join of the live definitions its matches import, each a join of a
 * few stored relations.
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
 * which every variable it reads is bound. A negation is a chain of its own, correlated through its channels: a negated
 * relation one step, a negated query each rule of it navigated with its head equated with the terms it is negated at.
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

/** Whether a negation reads no variable of its rule, by its bindings or by the bind map of the query it negates. */
const readsNoVariable = (a: Absent): boolean => {
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
 * probe over its region matches (analysis/theory/query.ts regionQuery).
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

/** A negation of a rule, navigated apart (`Navigator.#absent`). */
type Absent = Extract<InferredExpr, { readonly kind: "absent" }>

/** A rule's reads as one chain of steps (`Navigator.#chain`): the rule's parts, its negations still to navigate. */
interface Chain {
	readonly vars: ReadonlyArray<VarDesc>
	readonly matches: ReadonlyArray<InferredMatch>
	readonly where: ReadonlyArray<InferredExpr>
	readonly absents: ReadonlyArray<Absent>
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
	 * `rule` navigated at nesting `depth`: a chain of steps, then each of its negations, in declared order, over the rows
	 * the chain and the negations before it leave, each a chain of its own. Every rule but the last is a step the next
	 * reads whole, so PostgreSQL judges a negation only of a row every read and every earlier negation kept, and never
	 * reads a negated relation for a row a read would have dropped.
	 *
	 * A negation that reads no variable, only the rule's parameters and literals, is a condition of the chain's own
	 * rule, as every condition that reads no variable is (`#chain`), all of them in declared order. PostgreSQL judges such
	 * a negation once, as a gating qual of a Result over the plan of the rule that holds it, before that plan reads a row
	 * (createplan.c:804-809, nodeResult.c:81-85), and the gating quals of one rule in declared order where their costs
	 * are equal (get_gating_quals, createplan.c:1007, through order_qual_clauses, a stable sort). Nested as a correlated
	 * negation is, the last would gate the outermost Result and be judged first, reading a later arm's relations for a
	 * row an earlier arm already refutes.
	 */
	rule(rule: InferredRule, depth: number): InferredRule {
		const chain = this.#chain(this.#defined(this.#inline(rule)), depth)
		const kept = Object.fromEntries(chain.vars.map((v, i) => [`k${i}`, varRef(v.id)] as const))
		const gates = chain.absents.filter(readsNoVariable)
		let current: InferredRule = {
			vars: chain.vars,
			matches: chain.matches,
			where: [...chain.where, ...gates.map((a) => this.#absent(a, depth))],
			head: kept,
			interiors: [],
			attach: [],
			loc: rule.loc
		}
		for (const a of chain.absents.filter((x) => !readsNoVariable(x))) {
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
				where: [this.#absent(a, depth)],
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
	 * stays the read's own, so every negation and the head still read the row the chain delivers. Every variable left is
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
	 * rule probe over its region starts from (analysis/theory/query.ts regionQuery), then its reads of relations in their
	 * order (module doc). Each condition is placed inside the first step after which every variable it reads is bound; a
	 * condition no variable of which a step binds stays the rule's own; the negations are left to `rule`.
	 */
	#chain(flat: Flat, depth: number): Chain {
		const declared = new Map(flat.vars.map((v) => [v.id, v] as const))
		const known = new Set<string>()
		let reads = [...flat.reads]
		let pending: Array<InferredExpr> = []
		const absents: Array<Absent> = []
		const head = flat.head
		const where: Array<InferredExpr> = []
		for (const c of flat.where) {
			if (c.kind === "absent") {
				absents.push(c)
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
		return { vars, matches, where: [...where, ...pending], absents, head }
	}

	/**
	 * A negation as a chain of its own, at nesting `depth` of the rule that negates: a negated relation one step reading
	 * it by the terms it is negated at, a negated arm its rule navigated with its head equated with those terms, each
	 * passed in through the negation's channels.
	 */
	#absent(a: Absent, depth: number): InferredExpr {
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
				return { kind: "absent", source: step, bindings: {} }
			}
			case "query": {
				const stage = source.query.stage
				if (Object.keys(source.bind).length > 0 || stage.kind !== "rules") {
					return this.#refuse("a negation of an imported query of rules binding no parameter")
				}
				const navigated = mapNonEmpty(stage.arms, (arm) => {
					const at: Array<InferredExpr> = []
					for (const [field, outer] of Object.entries(a.bindings)) {
						const head = arm.head[field]
						if (head === undefined || head.kind === "aggregate" || head.kind === "producer") {
							return this.#refuse(`a negated query whose head derives ${field}`)
						}
						at.push(equal(head, passing.expr(outer)))
					}
					return this.rule({ ...arm, where: [...arm.where, ...at] }, depth + 1)
				})
				return {
					kind: "absent",
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
				return this.#refuse(`a negation of a ${source.kind} source`)
		}
	}
}

/**
 * The rule `rule` navigated (module doc): the same facts, read as one chain of steps from the values it holds, its
 * negations chains of their own. `loc` locates a refusal, which only a rule `navigateMember` does not hand it meets.
 */
const navigate = (rule: InferredRule, loc: SourceLoc): InferredRule =>
	new Navigator(loc).rule(rule, 0)

/** Whether a scalar condition holds a negation anywhere below its top, where navigation reads none (`navigable`). */
const negatesBelow = (e: InferredExpr): boolean =>
	e.kind === "absent" || exprChildren(e).some((c) => negatesBelow(c.term))

/**
 * The stored and closed relations and the deltas `rule` reads once its imports are inlined (`Navigator.#inline`), or
 * undefined where navigation reads no such rule: one with interiors, attachments or a folded or produced head, a match of
 * anything but a stored or closed relation, a delta or an imported query of one such rule binding no parameter, a negation below a scalar
 * expression, or a negation of anything but a stored or closed relation or an imported query of such rules.
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
			stage.kind === "rules" && stage.arms.length === 1 ? readsOfRule(stage.arms[0]) : undefined
		if (inner === undefined) {
			return undefined
		}
		reads += inner
	}
	for (const w of rule.where) {
		if (w.kind !== "absent") {
			if (negatesBelow(w)) {
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
			source.query.stage.arms.some((arm) => readsOfRule(arm) === undefined)
		) {
			return undefined
		}
	}
	return reads
}

/**
 * A write member's query navigated where navigation reads it and it joins: each rule of its one rules stage that reads
 * two stored or closed relations or more once its imports are inlined (`readsOfRule`), as a chain of steps
 * (`navigate`), every rule otherwise as it is. A member query is a rule over the live definitions its matches import,
 * each a join of a few stored relations, the whole a join of every relation they read; a member that reads one relation
 * is one lookup already, and one of another shape is no join navigation reads.
 */
export const navigateMember = (query: InferredQuery, loc: SourceLoc): InferredQuery => {
	const stage = query.stage
	if (stage.kind !== "rules" || !stage.arms.some((rule) => (readsOfRule(rule) ?? 0) > 1)) {
		return query
	}
	return {
		...query,
		stage: {
			...stage,
			arms: mapNonEmpty(stage.arms, (rule) =>
				(readsOfRule(rule) ?? 0) > 1 ? navigate(rule, loc) : rule
			)
		}
	}
}
