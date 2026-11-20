import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import {
	flatMapNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { refuse } from "#compiler/analysis/theory/build.ts"
import type { QueryColumns } from "#compiler/analysis/theory/columns.ts"
import {
	atColumn,
	boundIn,
	type ColumnTypes,
	equal,
	isBare,
	mapBindings,
	mapLeaves,
	varRef,
	varsOf
} from "#compiler/analysis/theory/leaves.ts"
import { leavesOf, ruleLeaves } from "#compiler/check/scan.ts"
import { canonicalEquals, ownedText, withoutSourceLocs } from "#compiler/core/canonical.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import {
	type Channel,
	descIdentity,
	exprChildren,
	type InferredBindings,
	type InferredExpr,
	type InferredMatch,
	type InferredQuery,
	type InferredRule,
	type InferredSource,
	queryParamNames,
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
 * head equated with the terms the match binds it at (`#inline`), a bare literal of either, which stands for the
 * import's column, typed at that column's descriptor (analysis/theory/columns.ts, leaves.ts atColumn); a variable then
 * bound by no match is the term an equality defines (`#defined`), so a literal it replaces a variable by is a term of
 * the variable's column, which stands wherever the variable stood, first among them. The matches are then read in an order of their own (`#chain`): from the values the
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
 * probe over its region matches (analysis/theory/query.ts probes); or an import the rule's unfolding reads more than
 * once that joins (`sharedImports`), which the step that reads it reads whole, as the checker builds it once for every
 * read and the lowering computes it once per unit (lower/optimize/cte-policy).
 */
type ReadSource = Extract<InferredSource, { readonly kind: "relation" | "delta" | "query" }>

/** One match of a stored or closed relation or of a delta, its bindings over the rule's variables. */
interface Read {
	readonly source: ReadSource
	readonly bindings: InferredBindings
	readonly loc: SourceLoc
}

/**
 * The field a read's column is a field of, which names a variable navigation mints for it: the relation's own, or the
 * relation a delta's rows were written to; none for an import's head field.
 */
const originOf = (
	source: ReadSource,
	field: string
): { readonly relation: string; readonly field: string } | undefined => {
	switch (source.kind) {
		case "relation":
			return { relation: source.name, field }
		case "delta":
			return { relation: source.relation, field }
		case "query":
			return undefined
	}
}

/**
 * How navigation reads an import a rule's unfolding reads more than once that joins: `perUnit`, whole, once, each read
 * a join of its rows (`sharedImports`), as a rule statement reads it, whose checker builds one node for every read of
 * one import (check/checker.ts #imported) and whose lowering computes it once per unit (lower/optimize/cte-policy);
 * `perRead`, inlined at each read, as a write member's query reads it, whose checker builds an import at every read.
 */
export type ImportSharing = "perUnit" | "perRead"

/** An import's bind map, its terms in the scope of the rule the unfolding reads it in. */
type Binds = ReadonlyMap<string, InferredExpr>

/**
 * The key two reads of an import in one rule's unfolding share exactly when they read the same rows: the semantic
 * identity of its query and of the terms its bind map binds its parameters to, as the outermost rule reads them, so two
 * matches of one query at one parameter's values, a whole rule's unit channels among them, share it, and one bound to a
 * variable of an inlined rule, renamed apart at each inlining, shares it with none.
 */
const importKey = (query: InferredQuery, bind: Binds): string =>
	ownedText([query, [...bind].toSorted(([a], [b]) => compareStrings(a, b))], withoutSourceLocs)

/**
 * The imports one statement's navigation reads whole, each by its identity (ir/desc.ts descIdentity): every read of one
 * import at one set of values is one object, so the checker, which keys an import by its query's identity (check/
 * session.ts CheckSession place), builds one node for all of them, where each read navigated apart was an object of
 * its own, a node of its own. One per call of `navigateQuery`, never shared between statements.
 */
class Interned {
	readonly #by = new Map<string, Imported>()

	/** The one import of `source`'s identity this navigation read first, `source` itself where none was. */
	of(source: Imported): Imported {
		const identity = descIdentity(source)
		if (!identity.ok) {
			throw defect(`a navigated import encodes: ${identity.error.message}`)
		}
		const known = this.#by.get(identity.value)
		if (known !== undefined) {
			return known
		}
		this.#by.set(identity.value, source)
		return source
	}
}

/**
 * `flat` with each import it reads whole (`sharedImports`) restricted inside to the parameters its bindings are fixed
 * to (`fixedTerms`), a whole rule's unit channels among them, and navigated as a query of its own from them
 * (`boundInside`, `navigateQuery`): every read of it at those values reads one import, which the checker builds once
 * (check/checker.ts #imported) and the lowering computes once at the scope its channels come from, the unit's rows
 * alone (lower/optimize/cte-policy), its other bindings each read's own, a join of its rows. The keys of the imports
 * no parameter restricts (`unrestricted`), which read whole would read every unit's rows, a probe's import bound to the
 * rows of its delta by variables alone among them: `Navigator.rule` inlines those at each read again, read by the keys
 * the steps before them bound.
 */
const sharedWithin = (
	flat: Flat,
	loc: SourceLoc,
	columns: QueryColumns,
	interned: Interned
): { readonly flat: Flat; readonly unrestricted: ReadonlySet<string> } => {
	const fixed = fixedTerms({
		vars: flat.vars,
		matches: [],
		where: flat.where,
		head: flat.head,
		interiors: [],
		attach: [],
		loc
	})
	/** A fixed term an import is restricted inside to: one that reads a parameter, a channel among them. */
	const byParameter = (term: InferredExpr): InferredExpr | undefined => {
		const held = fixed(term)
		return held !== undefined && leavesOf(held).params.length > 0 ? held : undefined
	}
	const unrestricted = new Set<string>()
	const reads = flat.reads.map((r): Read => {
		if (r.source.kind !== "query") {
			return r
		}
		const inside = boundInside(r.source, r.bindings, byParameter, columns)
		if (inside === r.source) {
			const binds = scalarBinds(r.source.bind)
			unrestricted.add(importKey(r.source.query, binds ?? new Map()))
			return r
		}
		return {
			...r,
			source: interned.of({
				...inside,
				query: navigatedQuery(inside.query, loc, columns, "perUnit", interned)
			})
		}
	})
	return { flat: { ...flat, reads }, unrestricted }
}

/**
 * The imports a rule's navigation reads whole, each one read of one node per unit, by key (`importKey`): every one
 * `kept`, and of those the `unions`, its imports of several rules.
 */
interface KeptImports {
	readonly kept: ReadonlySet<string>
	readonly unions: ReadonlySet<string>
}

/**
 * The imports `rule`'s unfolding reads whole (`KeptImports`), by key (`importKey`). An import of one rule that the
 * unfolding reads more than once and that joins is one, each the outermost of its kind first: navigation reads it
 * whole, the same rows at every read, where inlining it at every read multiplies the rule's reads by its own, and by
 * its reads' at every level below it, so a chain of definitions each reading the one below it twice reads its leaf two
 * to the chain's depth times. An import of several rules is one wherever it is read, its rules navigated inside it
 * (`navigateQuery`): distributed, the rule is the union of its conjunctions (`conjunctions`), one for each choice of a
 * rule of every union it reads, each reading every other import again, the product of the unions' widths, so a rule
 * over two reads of a union of three rules is nine conjunctions, each reading the union's relations twice
 * (test/unit/physical/judge-size). Each rule of a union is navigated as a query of its own, so an import its rules
 * each read is read once in each of them. An import of one rule read once, or one that reads one relation alone, is
 * inlined, its reads keyed by the values the steps before them bound. The imports are counted in the unfolding as
 * inlining leaves it: a read inside an import navigation keeps whole is that import's own, so the shallowest imports
 * read more than once are kept first, and the rest counted again without the rows they hold.
 */
const sharedImports = (rule: InferredRule, columns: QueryColumns): KeptImports => {
	const shared = new Set<string>()
	const unions = new Set<string>()
	for (;;) {
		const counts = new Map<
			string,
			{ readonly n: number; readonly depth: number; readonly rule: InferredRule }
		>()
		let next = 0
		const visit = (
			r: InferredRule,
			toTop: (e: InferredExpr) => InferredExpr,
			depth: number
		): void => {
			for (const m of r.matches) {
				const source = m.source
				const binds = source.kind === "query" ? scalarBinds(source.bind) : undefined
				const stage = source.kind === "query" ? source.query.stage : undefined
				if (source.kind !== "query" || binds === undefined || stage?.kind !== "rules") {
					continue
				}
				const top = new Map([...binds].map(([name, e]) => [name, toTop(e)] as const))
				const key = importKey(source.query, top)
				if (stage.arms.length > 1) {
					unions.add(key)
					continue
				}
				const seen = counts.get(key)
				counts.set(key, {
					n: (seen?.n ?? 0) + 1,
					depth: Math.min(seen?.depth ?? depth, depth),
					rule: stage.arms[0]
				})
				if (shared.has(key)) {
					continue
				}
				const prefix = `c${next++}.`
				const leaves = { var: (id: string) => varRef(`${prefix}${id}`), field: () => undefined }
				visit(stage.arms[0], (e) => toTop(boundIn(mapLeaves(e, leaves), binds)), depth + 1)
			}
		}
		visit(rule, (e) => e, 0)
		const joined = [...counts].flatMap(([key, c]) => {
			const reads = c.n > 1 && !shared.has(key) ? readsOfRule(c.rule, columns) : undefined
			return reads !== undefined && reads > 1 ? [{ key, depth: c.depth }] : []
		})
		if (!isNonEmpty(joined)) {
			return { kept: new Set([...shared, ...unions]), unions }
		}
		const shallowest = joined.reduce((least, c) => Math.min(least, c.depth), joined[0].depth)
		for (const c of joined) {
			if (c.depth === shallowest) {
				shared.add(c.key)
			}
		}
	}
}

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

/**
 * `arms`, a union of rules, as a union of conjunctions: each arm that matches an imported query of several rules, or of
 * one rule that matches such a query in turn, at any depth, in place of one arm for each conjunction of that query,
 * matching it alone. A rule over a union is the
 * union of the rule over each of its rules, so a filter of `arms`, a negation of each conjunction or an existence of
 * any, keeps the rows it kept: qti's "Expression node in unknown operand base" negates UnknownOperandBase, a selection
 * of a derived relation of two rules over the operands' join, each then a chain of lookups by the operator it is
 * filtered at (`Navigator.#filtered`), where, read as written, PostgreSQL derived the union whole, every unit's
 * operands joined by its estimates, and anti-joined each node to it.
 *
 * A conjunction matches one rule of the union alone, so each bare head literal of that rule is typed at the union's
 * column (`headAtUnion`), the type the union's checked heading states (`columns`), never the literal's own default: a
 * union's heading has one type per column, `scope` natural where some rules fix it at 0n and others read Node.start,
 * and the rule matched alone delivers the column at that type, as the union did. The heading is the union's
 * definition's (`columns` reads a whole rule's walked copy at the definition it was walked from, analysis/theory/query.ts
 * WholeRule `definitionOf`), never a copy's, which reads channels only its import types. A query of one rule is that
 * rule: matched alone, its head is the heading it delivered, as it was typed.
 */
const conjunctions = (
	arms: NonEmptyReadonlyArray<InferredRule>,
	columns: QueryColumns
): NonEmptyReadonlyArray<InferredRule> =>
	flatMapNonEmpty(arms, (arm): NonEmptyReadonlyArray<InferredRule> => {
		for (const [at, m] of arm.matches.entries()) {
			const source = m.source
			if (source.kind !== "query") {
				continue
			}
			const stage = source.query.stage
			if (stage.kind !== "rules") {
				continue
			}
			const inner = conjunctions(stage.arms, columns)
			if (inner.length === 1 && inner[0] === stage.arms[0]) {
				continue
			}
			const alone =
				stage.arms.length > 1
					? (rule: InferredRule): InferredRule => headAtUnion(rule, columns(source.query))
					: (rule: InferredRule): InferredRule => rule
			return conjunctions(
				mapNonEmpty(inner, (rule) => ({
					...arm,
					matches: arm.matches.map((x, i) =>
						i === at
							? {
									...m,
									source: {
										...source,
										query: {
											...source.query,
											stage: { ...stage, arms: [alone(rule)] }
										}
									}
								}
							: x
					)
				})),
				columns
			)
		}
		return [arm]
	})

/** `rule` with each bare literal of its head typed at the column of the union it is a rule of (`union`): itself where none is. */
const headAtUnion = (rule: InferredRule, union: ColumnTypes): InferredRule => {
	const head = Object.fromEntries(
		Object.entries(rule.head).map(([field, h]) => [
			field,
			h.kind === "aggregate" || h.kind === "producer" ? h : atColumn(h, field, union)
		])
	)
	return Object.entries(head).every(([field, h]) => h === rule.head[field])
		? rule
		: { ...rule, head }
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
	readonly #columns: QueryColumns
	#next = 0

	readonly #sharing: ImportSharing

	readonly #interned: Interned

	constructor(loc: SourceLoc, columns: QueryColumns, sharing: ImportSharing, interned: Interned) {
		this.#interned = interned
		this.#sharing = sharing
		this.#loc = loc
		this.#columns = columns
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
	rule(rule: InferredRule, depth: number): NonEmptyReadonlyArray<InferredRule> {
		const imports: KeptImports =
			this.#sharing === "perUnit"
				? sharedImports(rule, this.#columns)
				: { kept: new Set(), unions: new Set() }
		const shared = new Set(imports.kept)
		let within = sharedWithin(
			this.#defined(this.#inline(rule, shared, (e) => e)),
			this.#loc,
			this.#columns,
			this.#interned
		)
		while (within.unrestricted.size > 0) {
			if ([...within.unrestricted].some((key) => imports.unions.has(key))) {
				return flatMapNonEmpty(conjunctions([rule], this.#columns), (conjunction) =>
					this.rule(conjunction, depth)
				)
			}
			for (const key of within.unrestricted) {
				shared.delete(key)
			}
			within = sharedWithin(
				this.#defined(this.#inline(rule, shared, (e) => e)),
				this.#loc,
				this.#columns,
				this.#interned
			)
		}
		const chain = this.#chain(within.flat, depth)
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
		return [{ ...current, head: chain.head }]
	}

	/**
	 * `rule` with every imported query it matches inlined: its one rule's variables under a fresh prefix, its matches and
	 * conditions beside the rule's, and each term the match binds equated with the head field it binds; but an import of
	 * `shared` (`sharedImports`), by its key under `toTop`, which lifts a term of `rule` into the outermost rule's
	 * scope: that import is one read, of its query navigated as a query of its own, which every read of it shares.
	 */
	#inline(
		rule: InferredRule,
		shared: ReadonlySet<string>,
		toTop: (e: InferredExpr) => InferredExpr
	): Flat {
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
			const top = new Map([...binds].map(([name, e]) => [name, toTop(e)] as const))
			if (shared.has(importKey(source.query, top))) {
				reads.push({ source, bindings: m.bindings, loc: m.loc })
				continue
			}
			const stage = source.query.stage
			if (stage.kind !== "rules" || stage.arms.length !== 1) {
				return this.#refuse("an imported query of one rule")
			}
			const prefix = `n${this.#next++}.`
			const leaves = { var: (id: string) => varRef(`${prefix}${id}`), field: () => undefined }
			/** An inner expression in the rule's scope: its variables renamed apart, its parameters what the import binds. */
			const lift = (e: InferredExpr): InferredExpr => boundIn(mapLeaves(e, leaves), binds)
			const inner = this.#inline(stage.arms[0], shared, (e) => toTop(lift(e)))
			appendAll(
				vars,
				inner.vars.map((v) => ({ ...v, id: `${prefix}${v.id}` }))
			)
			const lifted = (r: Read): Read => ({
				...r,
				source:
					r.source.kind === "query"
						? {
								...r.source,
								bind: Object.fromEntries(
									Object.entries(r.source.bind).map(
										([name, b]) => [name, b.kind === "relationParam" ? b : lift(b)] as const
									)
								)
							}
						: r.source,
				bindings: Object.fromEntries(
					Object.entries(r.bindings).map(([column, e]) => [column, lift(e)] as const)
				)
			})
			appendAll(region, inner.region.map(lifted))
			appendAll(reads, inner.reads.map(lifted))
			appendAll(where, inner.where.map(lift))
			const columns = this.#columns(source.query)
			for (const [field, outer] of Object.entries(m.bindings)) {
				const head = inner.head[field]
				if (head === undefined || head.kind === "aggregate" || head.kind === "producer") {
					return this.#refuse(`an imported query whose head derives ${field}`)
				}
				where.push(equal(lift(atColumn(head, field, columns)), atColumn(outer, field, columns)))
			}
		}
		return { vars, region, reads, where, head: rule.head }
	}

	/**
	 * `flat` with every variable no read binds replaced by the term an equality equates it with, and that equality
	 * dropped: what an inlined import's head equated with a term only the import's match bound. A bare literal, which has
	 * no type of its own and takes the type of the term it meets, defines no variable, so a condition the rule states of
	 * a variable at a literal, `kind = 1`, stays a condition of the term that defines it; the equations `#inline` states
	 * hold no bare literal (leaves.ts atColumn), so every such variable has a term to be defined by. A variable a read binds
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
			if (v.kind !== "var" || isBare(term) || readsOf(term).has(v.var)) {
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
	 *
	 * Each import the rule reads whole (`sharedWithin`) is a match of the rule itself, before the steps: every read of it
	 * is an occurrence of one region, so the checker builds it once for all of them (check/checker.ts #imported) and the
	 * lowering computes it once per row of what binds its parameters, the unit's channels, a join of its rows at each
	 * read (lower/optimize/cte-policy), where a step of its own at each read would be a node of its own, correlated to
	 * that step's region. Its variables are bound from then on, so the chain's steps read by them.
	 */
	#chain(flat: Flat, depth: number): Chain {
		const declared = new Map(flat.vars.map((v) => [v.id, v] as const))
		const known = new Set<string>()
		let reads = flat.reads.filter((r) => r.source.kind !== "query")
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
		for (const read of flat.reads) {
			if (read.source.kind !== "query") {
				continue
			}
			matches.push({ source: read.source, bindings: read.bindings, loc: read.loc })
			for (const e of Object.values(read.bindings)) {
				for (const id of readsOf(e)) {
					if (!known.has(id)) {
						known.add(id)
						vars.push(declared.get(id) ?? this.#refuse(`a declaration of variable ${id}`))
					}
				}
			}
		}
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
						origin: originOf(read.source, column),
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
			const source: ReadSource =
				read.source.kind === "query"
					? {
							...read.source,
							bind: Object.fromEntries(
								Object.entries(read.source.bind).map(
									([name, b]) => [name, b.kind === "relationParam" ? b : passing.expr(b)] as const
								)
							)
						}
					: read.source
			const step: InferredSource = {
				kind: "step",
				query: {
					stage: {
						kind: "rules",
						arms: [
							{
								vars: stepVars,
								matches: [{ source, bindings, loc: read.loc }],
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
				const columns = this.#columns(source.query)
				const arms =
					this.#sharing === "perUnit" ? stage.arms : conjunctions(stage.arms, this.#columns)
				const navigated = flatMapNonEmpty(arms, (arm) => {
					const at: Array<InferredExpr> = []
					for (const [field, outer] of Object.entries(a.bindings)) {
						const head = arm.head[field]
						if (head === undefined || head.kind === "aggregate" || head.kind === "producer") {
							return this.#refuse(`a filtered query whose head derives ${field}`)
						}
						at.push(
							equal(atColumn(head, field, columns), passing.expr(atColumn(outer, field, columns)))
						)
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
			case "call":
			case "callField":
			case "split":
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
const navigate = (
	rule: InferredRule,
	loc: SourceLoc,
	columns: QueryColumns,
	sharing: ImportSharing,
	interned: Interned
): NonEmptyReadonlyArray<InferredRule> =>
	new Navigator(loc, columns, sharing, interned).rule(rule, 0)

/** Whether a scalar condition holds a relational filter anywhere below its top, where navigation reads none (`navigable`). */
const filtersBelow = (e: InferredExpr): boolean =>
	isFiltered(e) || exprChildren(e).some((c) => filtersBelow(c.term))

/**
 * The stored and closed relations and the deltas `rule` reads once its imports are inlined (`Navigator.#inline`), or
 * undefined where navigation reads no such rule: one with interiors, attachments or a folded or produced head, a match of
 * anything but a stored or closed relation, a delta or an imported query of one such rule binding no parameter, a
 * relational filter below a scalar expression, a filter of anything but a stored or closed relation or an imported
 * query whose conjunctions (`conjunctions`) are such rules. A filter, a negation or an existence, is no read the count holds: it keeps or drops a row the
 * reads deliver, so a rule that reads one relation beside a filter is one lookup, and a filter of a delta, which no step
 * reads by an index, leaves the rule as written, where PostgreSQL hashes the delta once per statement.
 */
const readsOfRule = (rule: InferredRule, columns: QueryColumns): number | undefined => {
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
			stage.kind === "rules" && stage.arms.length === 1
				? readsOfRule(stage.arms[0], columns)
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
			conjunctions(source.query.stage.arms, columns).some(
				(arm) => readsOfRule(arm, columns) === undefined
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
const joins = (rule: InferredRule, columns: QueryColumns): boolean => {
	const reads = readsOfRule(rule, columns)
	return reads !== undefined && (reads > 1 || rule.where.some((w) => filtersJoin(w, columns)))
}

/**
 * Whether a condition filters by a query, negated or existing, a rule of which joins (`joins`). Read as written, such
 * a filter is the query's join under the terms it is filtered at, which bind only the relations whose columns the
 * query's head delivers: qti's
 * "Dependency target" negates DependencyResolved at a dependency's (package, path, start), a join of Node and
 * ResourceId at (package, path) under it, ResourceId bound by the dependency's ref alone, which only the dependency's
 * row holds. Navigated, each relation the query reads is a step bound by the terms and the steps before it.
 */
const filtersJoin = (w: InferredExpr, columns: QueryColumns): boolean =>
	isFiltered(w) &&
	w.source.kind === "query" &&
	w.source.query.stage.kind === "rules" &&
	conjunctions(w.source.query.stage.arms, columns).some((arm) => joins(arm, columns))

/**
 * `rule` navigated where it joins (`joins`); one that does not, with the query each of its steps and imports reads
 * navigated where it joins (`navigateQuery`); itself where nothing in it joins. An aggregate's rule, which navigation
 * reads no part of (`readsOfRule`), counts or folds the facts of the query it imports, read per unit inside a whole
 * rule's step: navigated, each relation that query joins is a lookup by every key column the steps before it bound,
 * where read as written PostgreSQL plans the join by its estimates of one unit's rows, a nested loop over a range of
 * the unit for each row of another, the unit's rows squared.
 */
const navigatedRule = (
	rule: InferredRule,
	loc: SourceLoc,
	columns: QueryColumns,
	sharing: ImportSharing,
	interned: Interned
): NonEmptyReadonlyArray<InferredRule> => {
	if (joins(rule, columns)) {
		return navigate(rule, loc, columns, sharing, interned)
	}
	const fixed = fixedTerms(rule)
	const matches = rule.matches.map((m): InferredMatch => {
		const source = m.source
		if (source.kind === "step") {
			const query = navigatedQuery(source.query, loc, columns, sharing, interned)
			return query === source.query ? m : { ...m, source: { ...source, query } }
		}
		if (source.kind !== "query") {
			return m
		}
		const inside = boundInside(source, m.bindings, fixed, columns)
		const query = navigatedQuery(inside.query, loc, columns, sharing, interned)
		return query === source.query ? m : { ...m, source: interned.of({ ...inside, query }) }
	})
	return [matches.every((m, i) => m === rule.matches[i]) ? rule : { ...rule, matches }]
}

/** An import a rule matches (ir/desc.ts SourceDesc `query`). */
type Imported = Extract<InferredSource, { readonly kind: "query" }>

/**
 * An import a rule matches at `bindings`, which navigation reads apart from the rule (`navigatedRule`), with each
 * binding the rule fixes (`fixedTerms`), to a parameter, a channel or a literal, equated inside each rule of the import
 * with the head term it binds, every parameter it reads passed in under its own name, at every depth navigation reads
 * apart in turn: navigated apart, the
 * import's chain starts from those values. Outside it, beside steps PostgreSQL never pulls a condition into, the
 * equality left the chain's first step a read of every row: a whole rule's aggregate over the operands' join, its
 * groups bound to the unit's channels at its match, read every expression of every unit once per unit
 * (known_operand_base_key). A binding stays the match's alone where the import cannot hold it: at a field a rule's head
 * aggregates or produces, or reading a parameter the import already reads as another term. A bare literal, the head's
 * or the binding's, is typed at the import's column it stands for (leaves.ts atColumn).
 */
/** Whether `e` reads no variable of its rule: a parameter, a channel, a literal or a term of them alone. */
const isFixed = (e: InferredExpr): boolean => {
	const leaves = leavesOf(e)
	return leaves.vars.size === 0 && leaves.parents.size === 0
}

/**
 * The term each binding of a rule's matches fixes, where it reads no variable of the rule (`isFixed`) or is a variable
 * the rule's conditions equate with such a term: an aggregate's rule its import's group fields at the unit's channels a
 * whole rule's step equates them with (`boundInside`).
 */
const fixedTerms = (rule: InferredRule): ((term: InferredExpr) => InferredExpr | undefined) => {
	const vars = new Map<string, InferredExpr>()
	for (const w of rule.where) {
		if (w.kind !== "compare" || w.op !== "eq") {
			continue
		}
		if (w.left.kind === "var" && isFixed(w.right)) {
			vars.set(w.left.var, w.right)
		} else if (w.right.kind === "var" && isFixed(w.left)) {
			vars.set(w.right.var, w.left)
		}
	}
	return (term) => (term.kind === "var" ? vars.get(term.var) : isFixed(term) ? term : undefined)
}

const boundInside = (
	source: Imported,
	bindings: InferredBindings,
	fixed: (term: InferredExpr) => InferredExpr | undefined,
	columnsOf: QueryColumns
): Imported => {
	const stage = source.query.stage
	if (stage.kind !== "rules") {
		return source
	}
	const columns = columnsOf(source.query)
	const own = queryParamNames(source.query)
	const bind: Record<string, Imported["bind"][string]> = { ...source.bind }
	/** Each binding held inside: its term, and the term each rule's head binds it at, rule by rule. */
	const held: Array<{ readonly term: InferredExpr; readonly heads: ReadonlyArray<InferredExpr> }> =
		[]
	for (const [field, bound] of Object.entries(bindings)) {
		const found = fixed(bound)
		if (found === undefined) {
			continue
		}
		const term = atColumn(found, field, columns)
		const leaves = leavesOf(term)
		const passed = leaves.params.flatMap((p) =>
			p.kind === "param" ? [{ kind: "param", name: p.name, type: p.type } as const] : []
		)
		const heads = stage.arms.flatMap((arm) => {
			const head = arm.head[field]
			return head === undefined || head.kind === "aggregate" || head.kind === "producer"
				? []
				: [atColumn(head, field, columns)]
		})
		if (
			passed.length < leaves.params.length ||
			heads.length < stage.arms.length ||
			passed.some((p) => own.has(p.name) && !(p.name in bind && canonicalEquals(bind[p.name], p)))
		) {
			continue
		}
		for (const p of passed) {
			bind[p.name] = p
		}
		held.push({ term, heads })
	}
	if (!isNonEmpty(held)) {
		return source
	}
	const arms = mapNonEmpty(stage.arms, (arm, i) => ({
		...arm,
		where: [
			...arm.where,
			...held.flatMap(({ term, heads }) => {
				const head = heads[i]
				return head === undefined ? [] : [equal(head, term)]
			})
		]
	}))
	return { ...source, bind, query: { ...source.query, stage: { ...stage, arms } } }
}

/**
 * A query navigated wherever it joins: each rule of its one rules stage that joins (`joins`) as a chain of steps
 * (`navigate`), and in each that does not, every step's query so, at any depth; the query itself where nothing in it
 * joins. A write member's query (write/frontend/compile.ts) is a rule over the live definitions its matches import, each
 * a join of a few stored relations, the whole a join of every relation they read. Every query the judge reads
 * (physical/ddl/rules.ts judgedStatement) is navigated so too: a rule probe's, over its region, and a whole rule's
 * violation over its units, whose rule read per unit is a step (analysis/theory/unit.ts perUnit), navigated where it
 * joins within the unit or negates a join, as qti's "Dependency target" does, so no estimate PostgreSQL makes, with
 * statistics or none, reads a join the judge reads as a product it filters afterwards. A rule over an imported query of
 * several rules, where one of its conjunctions (`conjunctions`) joins, is navigated with each such import read whole
 * under `perUnit`, the judge's, one node per unit, each of its rules navigated inside it (`sharedImports`), and as the
 * union of its conjunctions, each navigated, under `perRead`, or where no parameter restricts such an import: qti's
 * "Choice not variable" reads ChoiceOrHottext, a union of choices and hottexts, beside a negation of UnclaimedName, which
 * then is a chain of lookups from each choice or hottext, where read beside the union as written it was derived whole
 * for every unit and anti-joined to it by PostgreSQL's estimates of one unit.
 */
export const navigateQuery = (
	query: InferredQuery,
	loc: SourceLoc,
	columns: QueryColumns,
	sharing: ImportSharing
): InferredQuery => navigatedQuery(query, loc, columns, sharing, new Interned())

/** `navigateQuery` within one statement's navigation, its imports read whole interned in `interned`. */
const navigatedQuery = (
	query: InferredQuery,
	loc: SourceLoc,
	columns: QueryColumns,
	sharing: ImportSharing,
	interned: Interned
): InferredQuery => {
	const stage = query.stage
	if (stage.kind !== "rules") {
		return query
	}
	const arms = flatMapNonEmpty(stage.arms, (rule): NonEmptyReadonlyArray<InferredRule> => {
		const split = conjunctions([rule], columns)
		if (split.length === 1 || !split.some((conjunction) => joins(conjunction, columns))) {
			return navigatedRule(rule, loc, columns, sharing, interned)
		}
		switch (sharing) {
			case "perUnit":
				return navigate(rule, loc, columns, sharing, interned)
			case "perRead":
				return flatMapNonEmpty(split, (conjunction) =>
					navigatedRule(conjunction, loc, columns, sharing, interned)
				)
		}
	})
	return arms.length === stage.arms.length && arms.every((rule, i) => rule === stage.arms[i])
		? query
		: { ...query, stage: { ...stage, arms } }
}
