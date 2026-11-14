import { refuse } from "#compiler/analysis/theory/build.ts"
import { mapBindings, mapLeaves, varsOf } from "#compiler/analysis/theory/leaves.ts"
import { leavesOf, ruleLeaves } from "#compiler/check/scan.ts"
import { appendAll } from "#compiler/core/array.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import type {
	Channel,
	InferredBindings,
	InferredExpr,
	InferredMatch,
	InferredQuery,
	InferredRule,
	InferredSource,
	VarDesc
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
 * rule holds, its parameters and literals, each next match the one with the most columns bound so far, by the steps
 * placed or by an equality with them, the earliest declared among equals. That is how a member walks a qti package:
 * from the package's documents by its own key, down to a node's children by (package, path, parent), and up to a
 * node's parent by its primary key, never by (package, path) alone while a narrower lookup is left.
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

/** `e` with each parameter `bound` names replaced by the term it binds, every other leaf as it is. */
const boundIn = (e: InferredExpr, bound: ReadonlyMap<string, InferredExpr>): InferredExpr => {
	const m = (x: InferredExpr): InferredExpr => boundIn(x, bound)
	switch (e.kind) {
		case "param":
			return bound.get(e.name) ?? e
		case "var":
		case "field":
		case "value":
		case "parent":
		case "literal":
			return e
		case "compute":
			return { ...e, args: e.args.map(m) }
		case "cast":
		case "base":
		case "not":
		case "in":
			return { ...e, arg: m(e.arg) }
		case "cond":
			return { ...e, pred: m(e.pred), onTrue: m(e.onTrue), onFalse: m(e.onFalse) }
		case "when":
			return { ...e, subject: m(e.subject), proved: m(e.proved), otherwise: m(e.otherwise) }
		case "compare":
		case "allen":
			return { ...e, left: m(e.left), right: m(e.right) }
		case "between":
			return { ...e, arg: m(e.arg), low: m(e.low), high: m(e.high) }
		case "and":
		case "or":
			return { ...e, args: mapNonEmpty(e.args, m) }
		case "pointIn":
			return { ...e, point: m(e.point), span: m(e.span) }
		case "absent":
			return {
				...e,
				bindings: Object.fromEntries(
					Object.entries(e.bindings).map(([k, b]) => [k, m(b)] as const)
				),
				source:
					e.source.kind === "query" || e.source.kind === "step"
						? {
								...e.source,
								bind: Object.fromEntries(
									Object.entries(e.source.bind).map(([k, b]) => [
										k,
										b.kind === "relationParam" ? b : m(b)
									])
								)
							}
						: e.source
			}
		case "closedAt":
		case "closedHas":
			return { ...e, args: mapNonEmpty(e.args, m) }
		case "closedRow":
			return { ...e, args: e.args.map(m) }
	}
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

/** One match of a stored or closed relation, its bindings over the rule's variables. */
interface Read {
	readonly relation: string
	readonly bindings: InferredBindings
	readonly loc: SourceLoc
}

/** A conjunctive rule over stored and closed relations, as navigation reads it. */
interface Flat {
	readonly vars: ReadonlyArray<VarDesc>
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
	 */
	rule(rule: InferredRule, depth: number): InferredRule {
		const chain = this.#chain(this.#defined(this.#inline(rule)), depth)
		const kept = Object.fromEntries(chain.vars.map((v, i) => [`k${i}`, varRef(v.id)] as const))
		let current: InferredRule = {
			vars: chain.vars,
			matches: chain.matches,
			where: chain.where,
			head: kept,
			interiors: [],
			attach: [],
			loc: rule.loc
		}
		for (const a of chain.absents) {
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
		const reads: Array<Read> = []
		const where: Array<InferredExpr> = [...rule.where]
		for (const m of rule.matches) {
			const source = m.source
			if (source.kind === "relation") {
				reads.push({ relation: source.name, bindings: m.bindings, loc: m.loc })
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
			appendAll(
				reads,
				inner.reads.map((r) => ({
					...r,
					bindings: Object.fromEntries(
						Object.entries(r.bindings).map(([column, e]) => [column, lift(e)] as const)
					)
				}))
			)
			appendAll(where, inner.where.map(lift))
			for (const [field, outer] of Object.entries(m.bindings)) {
				const head = inner.head[field]
				if (head === undefined || head.kind === "aggregate" || head.kind === "producer") {
					return this.#refuse(`an imported query whose head derives ${field}`)
				}
				where.push(equal(lift(head), outer))
			}
		}
		return { vars, reads, where, head: rule.head }
	}

	/**
	 * `flat` with every variable no read binds replaced by the term an equality equates it with, and that equality
	 * dropped: what an inlined import's head equated with a term only the import's match bound. A variable a read binds
	 * stays the read's own, so every negation and the head still read the row the chain delivers. Every variable left is
	 * one a read binds.
	 */
	#defined(flat: Flat): Flat {
		const bound = new Set(
			flat.reads.flatMap((r) => Object.values(r.bindings).flatMap((e) => [...readsOf(e)]))
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
	 * The reads of `flat` as one chain of steps, at nesting `depth`, in their order (module doc). Each condition is
	 * placed inside the first step after which every variable it reads is bound; a condition no variable of which a step
	 * binds stays the rule's own; the negations are left to `rule`.
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
		/** The variables an equality still pending fixes to values the steps placed so far hold. */
		const fixed = (): ReadonlySet<string> => {
			const out = new Set<string>()
			for (const c of pending) {
				if (c.kind === "compare" && c.op === "eq") {
					for (const [v, term] of [
						[c.left, c.right],
						[c.right, c.left]
					] as const) {
						if (v.kind === "var" && isKnown(term)) {
							out.add(v.var)
						}
					}
				}
			}
			return out
		}
		const boundColumns = (r: Read, values: ReadonlySet<string>): number =>
			Object.values(r.bindings).filter((e) =>
				[...readsOf(e)].every((id) => known.has(id) || values.has(id))
			).length
		const vars: Array<VarDesc> = []
		const matches: Array<InferredMatch> = []
		while (reads.length > 0) {
			const values = fixed()
			let best = 0
			for (const [i, r] of reads.entries()) {
				const current = reads[best]
				if (current !== undefined && boundColumns(r, values) > boundColumns(current, values)) {
					best = i
				}
			}
			const read = reads[best]
			if (read === undefined) {
				return this.#refuse("a read to place")
			}
			reads = reads.filter((_, i) => i !== best)
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
						origin: { relation: read.relation, field: column },
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
								matches: [
									{ source: { kind: "relation", name: read.relation }, bindings, loc: read.loc }
								],
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
const negatesBelow = (e: InferredExpr): boolean => {
	switch (e.kind) {
		case "absent":
			return true
		case "var":
		case "field":
		case "value":
		case "parent":
		case "param":
		case "literal":
			return false
		case "compute":
		case "closedRow":
			return e.args.some(negatesBelow)
		case "and":
		case "or":
		case "closedAt":
		case "closedHas":
			return e.args.some(negatesBelow)
		case "cast":
		case "base":
		case "not":
		case "in":
			return negatesBelow(e.arg)
		case "cond":
			return negatesBelow(e.pred) || negatesBelow(e.onTrue) || negatesBelow(e.onFalse)
		case "when":
			return negatesBelow(e.subject) || negatesBelow(e.proved) || negatesBelow(e.otherwise)
		case "compare":
		case "allen":
			return negatesBelow(e.left) || negatesBelow(e.right)
		case "between":
			return negatesBelow(e.arg) || negatesBelow(e.low) || negatesBelow(e.high)
		case "pointIn":
			return negatesBelow(e.point) || negatesBelow(e.span)
	}
}

/**
 * The stored and closed relations `rule` reads once its imports are inlined (`Navigator.#inline`), or undefined where
 * navigation reads no such rule: one with interiors, attachments or a folded or produced head, a match of anything but a
 * stored or closed relation or an imported query of one such rule binding no parameter, a negation below a scalar
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
		if (source.kind === "relation") {
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
