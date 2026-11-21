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
import { canonicalEquals } from "#compiler/core/canonical.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { deepFreeze } from "#compiler/core/record.ts"
import {
	type Channel,
	descIdentities,
	exprChildren,
	type InferredBindings,
	type InferredExpr,
	type InferredMatch,
	type InferredQuery,
	type InferredRule,
	type InferredSource,
	mapBindMap,
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

/**
 * The subject and suffix of a suffix test, `endsWith(x, t)` or `endsWith(x, t) = true` (Text.endsWith), whose subject
 * is a variable: what a read binding `x` is sought by once `t` is known, the B-tree on its column's suffix key serving
 * it (sql/suffix.ts), as an equality's term keys the column it binds.
 */
const suffixTestOf = (
	c: InferredExpr
): { readonly subject: string; readonly suffix: InferredExpr } | undefined => {
	const test =
		c.kind === "compare" && c.op === "eq" && c.right.kind === "literal" && c.right.value === true
			? c.left
			: c
	if (test.kind !== "compute" || test.fn !== "endsWith") {
		return undefined
	}
	const [subject, suffix] = test.args
	return subject?.kind === "var" && suffix !== undefined
		? { subject: subject.var, suffix }
		: undefined
}

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
		if (b.kind === "relationParam" || b.kind === "rows") {
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
 * How navigation reads the imports a rule's unfolding multiplies, an import of one rule read more than once that joins
 * and every import of several rules (`sharedImports`): `perStatement`, each one read, its query navigated as a query of
 * its own, restricted inside to the parameters its reads fix it at, a whole rule's unit channels among them, which the
 * checker builds as one node for every read of one import (check/checker.ts #imported) and the lowering places
 * (lower/optimize/cte-policy): restricted by the unit, inside the region it is read in, computed once per unit (rule
 * 3b), and restricted by nothing, once in the statement (rules 5 and 6); `perRead`, inlined at each read and
 * distributed into the rule's conjunctions, as a write member's query reads it, whose checker builds an import at
 * every read. Every rule statement, the judge's and a check over every row alike, reads `perStatement`, over its region
 * (`RegionExtent`): navigation never distributes a rule into the conjunctions of a union it reads, the product of the
 * unions' widths at every depth.
 */
export type ImportSharing =
	| { readonly kind: "perStatement"; readonly extent: RegionExtent }
	| { readonly kind: "perRead" }

/**
 * What a rule statement's region holds: the units a transaction wrote (`units`), a probe's or a whole rule's unit
 * statement, or every row (`every`), a rule's check over every row, which the migration that adds the rule runs. Over
 * the units, an import of one rule no parameter restricts, which read whole reads every unit's rows, is read at each
 * read instead, a step of the chain keyed by the steps before it (`Navigator.rule`): a probe of the assembled catalog
 * read qti's attribute rows of one name and kinds for every package, the import whole at the chain's head, where read
 * at each read it reads the delta's package's. Over every row, it is read whole, once: the check reads every unit
 * anyway, and at each read it was read again for every row of every read before it (test/unit/physical/judge-size).
 * An import of several rules stays whole over either.
 */
export type RegionExtent = "units" | "every"

/** An import's bind map, its terms in the scope of the rule the unfolding reads it in. */
type Binds = ReadonlyMap<string, InferredExpr>

/**
 * One statement's navigation: each query it reads navigated once for its identity (ir/desc.ts descIdentity), and what
 * it reads of each rule (`reads`), computed once for the rule. Every read of a query of one identity is the one
 * navigation of it, one object, so the checker, which keys an import by its query's place (check/session.ts
 * CheckSession), builds one node for all of them, where each read navigated apart was an object of its own, a node of
 * its own; and a chain of unions, each rule of a level reading the level below, navigates each level once for each set
 * of values its rules read it at, where navigated at each read apart, every level was navigated once for every path
 * down the chain to it, the product of the unions' widths at every depth above it. Its work is linear in the queries
 * and rules its statement reads, never in the paths through them. One per call of `navigateQuery`, never shared
 * between statements.
 */
class Interned {
	/**
	 * The identity digests of what this navigation reads (ir/desc.ts descIdentities): each query's every part digested
	 * once for every identity and import key of it, where each was digested anew for each. A query is frozen before it is
	 * digested (core/record.ts deepFreeze, which walks only what is not frozen yet), as every Description is, so the
	 * queries navigation builds, restricted inside an import and navigated, keep their tokens as the declared ones do.
	 */
	readonly #digests = descIdentities()
	/** The navigation of the first query of each identity this navigation read, by the identity. */
	readonly #navigations = new Map<string, InferredQuery>()
	/** What navigation reads of each rule this navigation asked about (`reads`), by the rule. */
	readonly #reads = new Map<InferredRule, RuleReads>()

	/**
	 * `query` navigated by `navigate`: the navigation of the first query of its identity this navigation read, that
	 * query itself where its navigation changes nothing.
	 */
	navigated(
		query: InferredQuery,
		navigate: (query: InferredQuery) => InferredQuery
	): InferredQuery {
		const identity = this.identity(query)
		const known = this.#navigations.get(identity)
		if (known !== undefined) {
			return known
		}
		const navigated = navigate(query)
		this.#navigations.set(identity, navigated)
		return navigated
	}

	/** A navigated query's identity (ir/desc.ts descIdentity), which every query a navigation reads encodes. */
	identity(query: InferredQuery): string {
		const identity = this.#digests.of(deepFreeze(query))
		if (!identity.ok) {
			throw defect(`a navigated query encodes: ${identity.error.message}`)
		}
		return identity.value
	}

	/**
	 * The key two reads of an import in one rule's unfolding share exactly when they read the same rows: the semantic
	 * identity of its query and of the terms its bind map binds its parameters to, as the outermost rule reads them, so
	 * two matches of one query at one parameter's values, a whole rule's unit channels among them, share it, and one
	 * bound to a variable of an inlined rule, renamed apart at each inlining, shares it with none. It is their identity
	 * digest (core/fingerprint.ts identityDigest), each query's frozen parts digested once for the whole navigation
	 * however many reads and identities of it are asked, where their canonical text spelled each read of a query again:
	 * a chain of unions each rule of which reads the level below spells its leaf the product of the unions' widths times.
	 */
	importKey(query: InferredQuery, bind: Binds): string {
		const key = this.#digests.of([query, [...bind].toSorted(([a], [b]) => compareStrings(a, b))])
		if (!key.ok) {
			throw defect(`an import's key encodes: ${key.error.message}`)
		}
		return key.value
	}

	/**
	 * What navigation reads of `rule` (`RuleReads`), read once for each rule however many reads of its import ask: the
	 * rules of a chain of unions, each rule of a level reading the level below, are each read once, where each read of
	 * a union read its rules again, once for every path down the chain to them.
	 */
	reads(rule: InferredRule): RuleReads {
		const known = this.#reads.get(rule)
		if (known !== undefined) {
			return known
		}
		const reads = ruleReads(rule, (r) => this.reads(r))
		this.#reads.set(rule, reads)
		return reads
	}
}

/**
 * `flat` with each import it reads whole (`sharedImports`) restricted inside to the parameters its bindings are fixed
 * to (`fixedTerms`), a whole rule's unit channels among them, and navigated as a query of its own from them
 * (`boundInside`, `navigateQuery`): every read of it at those values reads one import, which the checker builds once
 * (check/checker.ts #imported) and the lowering places by what restricts it (lower/optimize/cte-policy), its other
 * bindings each read's own, a join of its rows. Of a union, the rules whose head fixes a field the read binds to
 * another literal are dropped (`armsAt`): no row of theirs meets the read, so a selection of one rule of a union by the
 * literal its head fixes, qti's statements of one required fact (`select(PackageFact, fact = author)`), computes that
 * rule alone. The keys of the imports of one rule no parameter restricts over the units a transaction wrote
 * (`unrestricted`, RegionExtent `units`): `Navigator.rule` reads those at each read again, keyed by the steps before.
 */
/**
 * `source`, an import read at `bindings`, with each rule of its union whose head fixes a field the read binds to another
 * literal dropped (`fixed`, the rule's fixed terms): it delivers no row the read meets. Its bind map binds only the
 * parameters the rules it keeps read. Itself where no rule is dropped, or where every rule would be.
 */
const armsAt = (
	source: Imported,
	bindings: InferredBindings,
	fixed: (term: InferredExpr) => InferredExpr | undefined
): Imported => {
	const stage = source.query.stage
	if (stage.kind !== "rules" || stage.arms.length === 1) {
		return source
	}
	const literals = Object.entries(bindings).flatMap(([field, e]) => {
		const held = fixed(e) ?? e
		return held.kind === "literal" ? [[field, held] as const] : []
	})
	const meets = (arm: InferredRule): boolean =>
		literals.every(([field, literal]) => {
			const head = arm.head[field]
			return head?.kind !== "literal" || canonicalEquals(head.value, literal.value)
		})
	const [first, ...rest] = stage.arms.filter(meets)
	if (first === undefined || rest.length + 1 === stage.arms.length) {
		return source
	}
	const arms: NonEmptyReadonlyArray<InferredRule> = [first, ...rest]
	const read = new Set(
		arms.flatMap((arm) =>
			ruleLeaves(arm, true).params.flatMap((p) => (p.kind === "param" ? [p.name] : []))
		)
	)
	return {
		...source,
		bind: Object.fromEntries(Object.entries(source.bind).filter(([name]) => read.has(name))),
		query: { ...source.query, stage: { ...stage, arms } }
	}
}

const sharedWithin = (
	flat: Flat,
	loc: SourceLoc,
	columns: QueryColumns,
	sharing: ImportSharing,
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
		const read = armsAt(r.source, r.bindings, fixed)
		const inside = boundInside(read, r.bindings, byParameter, columns)
		const stage = r.source.query.stage
		if (
			inside === read &&
			sharing.kind === "perStatement" &&
			sharing.extent === "units" &&
			stage.kind === "rules" &&
			stage.arms.length === 1
		) {
			unrestricted.add(interned.importKey(r.source.query, scalarBinds(r.source.bind) ?? new Map()))
			return r
		}
		return {
			...r,
			source: { ...inside, query: navigatedQuery(inside.query, loc, columns, sharing, interned) }
		}
	})
	return { flat: { ...flat, reads }, unrestricted }
}

/** The imports a rule's navigation reads whole, each one read of one node, by key (`importKey`). */
type KeptImports = ReadonlySet<string>

/** No import kept: a write member's navigation (`perRead`), which inlines every import at every read. */
const noImports: KeptImports = new Set()

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
const sharedImports = (rules: ReadonlyArray<InferredRule>, interned: Interned): KeptImports => {
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
				const key = interned.importKey(source.query, top)
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
		for (const rule of rules) {
			visit(rule, (e) => e, 0)
		}
		const joined = [...counts].flatMap(([key, c]) => {
			const reads = c.n > 1 && !shared.has(key) ? interned.reads(c.rule).one : undefined
			return reads !== undefined && reads > 1 ? [{ key, depth: c.depth }] : []
		})
		if (!isNonEmpty(joined)) {
			return new Set([...shared, ...unions])
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
	/**
	 * Its reads of an aggregating rule's groups (`foldsIn`), never inlined: each is a step of its own, the rule restricted
	 * inside to the group fields the steps before it bound (`#chain`).
	 */
	readonly grouped: ReadonlyArray<Grouped>
	readonly where: ReadonlyArray<InferredExpr>
	readonly head: InferredRule["head"]
}

/** A read of an aggregating rule's groups (Flat `grouped`): an import of the one rule, its bindings over the rule's
 * variables. */
interface Grouped {
	readonly source: Imported
	readonly bindings: InferredBindings
	readonly loc: SourceLoc
}

/**
 * The fields at which an import of one aggregating rule holds one fact each, its group fields, the head fields no
 * aggregate derives; undefined for any other source. Its facts are its body's folded at each group, so navigation never
 * inlines it, nor distributes a union its body reads into its reader's conjunctions: a fold over a union is no union
 * of folds, two arms' facts of one group folded apart would be two facts of the group.
 */
const foldsIn = (source: InferredSource): ReadonlyArray<string> | undefined => {
	if (source.kind !== "query" || source.query.stage.kind !== "rules") {
		return undefined
	}
	const [rule, ...more] = source.query.stage.arms
	return more.length === 0 && Object.values(rule.head).some((h) => h.kind === "aggregate")
		? Object.entries(rule.head).flatMap(([field, h]) => (h.kind === "aggregate" ? [] : [field]))
		: undefined
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
): NonEmptyReadonlyArray<InferredRule> => {
	const [first, ...rest] = conjunctionsOf(arms, columns)
	if (first === undefined) {
		throw defect("a union of rules has a conjunction")
	}
	return [first, ...rest]
}

/**
 * The conjunctions of `arms` (`conjunctions`), one at a time: the product of the widths of the unions they read, at any
 * depth, which only a consumer of every conjunction builds, a write member's navigation (`perRead`) or a union read
 * whole that no parameter restricts (`Navigator.rule`). Whether one of them joins, or navigation reads every one, is read
 * off the rules of the unions they choose from, never off the conjunctions (`RuleReads`).
 */
function* conjunctionsOf(
	arms: Iterable<InferredRule>,
	columns: QueryColumns
): Generator<InferredRule, void, undefined> {
	for (const arm of arms) {
		const at = arm.matches.findIndex((m) => splitsAt(m.source))
		const m = arm.matches[at]
		const source = m?.source
		const stage = source?.kind === "query" ? source.query.stage : undefined
		if (m === undefined || source?.kind !== "query" || stage?.kind !== "rules") {
			yield arm
			continue
		}
		const alone =
			stage.arms.length > 1
				? (rule: InferredRule): InferredRule => headAtUnion(rule, columns(source.query))
				: (rule: InferredRule): InferredRule => rule
		for (const rule of conjunctionsOf(stage.arms, columns)) {
			yield* conjunctionsOf(
				[
					{
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
					}
				],
				columns
			)
		}
	}
}

/**
 * Whether `rule` is more than one conjunction (`conjunctions`): it matches an import of several rules, or of one rule
 * that is in turn, at any depth.
 */
const splits = (rule: InferredRule): boolean => rule.matches.some((m) => splitsAt(m.source))

/**
 * Whether a match of `source` makes its rule more than one conjunction (`splits`): an import of several rules, or of
 * one rule that splits in turn, but never of an aggregating rule (`foldsIn`), whose body's union its folds read whole.
 */
const splitsAt = (source: InferredSource): boolean =>
	source.kind === "query" &&
	source.query.stage.kind === "rules" &&
	foldsIn(source) === undefined &&
	(source.query.stage.arms.length > 1 || source.query.stage.arms.some(splits))

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
	rule(
		rule: InferredRule,
		depth: number,
		imports: KeptImports
	): NonEmptyReadonlyArray<InferredRule> {
		const whole = new Set(imports)
		const within = (): ReturnType<typeof sharedWithin> =>
			sharedWithin(
				this.#defined(this.#inline(rule, whole, (e) => e)),
				this.#loc,
				this.#columns,
				this.#sharing,
				this.#interned
			)
		let read = within()
		while (read.unrestricted.size > 0) {
			for (const key of read.unrestricted) {
				whole.delete(key)
			}
			read = within()
		}
		const chain = this.#chain(read.flat, depth)
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
		const grouped: Array<Grouped> = []
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
			if (foldsIn(source) !== undefined) {
				grouped.push({ source, bindings: m.bindings, loc: m.loc })
				continue
			}
			const top = new Map([...binds].map(([name, e]) => [name, toTop(e)] as const))
			if (shared.has(this.#interned.importKey(source.query, top))) {
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
								bind: mapBindMap(r.source.bind, lift)
							}
						: r.source,
				bindings: Object.fromEntries(
					Object.entries(r.bindings).map(([column, e]) => [column, lift(e)] as const)
				)
			})
			appendAll(region, inner.region.map(lifted))
			appendAll(reads, inner.reads.map(lifted))
			appendAll(
				grouped,
				inner.grouped.map((g) => ({
					...g,
					source: { ...g.source, bind: mapBindMap(g.source.bind, lift) },
					bindings: Object.fromEntries(
						Object.entries(g.bindings).map(([column, e]) => [column, lift(e)] as const)
					)
				}))
			)
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
		return { vars, region, reads, grouped, where, head: rule.head }
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
			[...flat.region, ...flat.reads, ...flat.grouped].flatMap((r) =>
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
				grouped: flat.grouped.map((g) => ({ ...g, bindings: mapBindings(g.bindings, leaves) })),
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
		let reads: ReadonlyArray<Read> = [
			...flat.reads.filter((r) => r.source.kind !== "query"),
			...flat.grouped
		]
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
		/**
		 * The variables a suffix test still pending seeks by a suffix the steps placed so far hold, keyed
		 * (`suffixTestOf`, `keyedTerm`).
		 */
		const sought = (): ReadonlySet<string> =>
			new Set(
				pending.flatMap((c) => {
					const test = suffixTestOf(c)
					return test !== undefined &&
						!known.has(test.subject) &&
						isKnown(test.suffix) &&
						keyedTerm(test.suffix)
						? [test.subject]
						: []
				})
			)
		/**
		 * How a read is looked up from the values known so far (`Lookup`): a column bound to a variable a suffix test seeks
		 * is keyed, a seek of the B-tree on its suffix key.
		 */
		const lookupOf = (
			r: Read,
			values: ReadonlyMap<string, boolean>,
			seeks: ReadonlySet<string>
		): Lookup => {
			let keyed = 0
			let bound = 0
			const keys = foldsIn(r.source)
			for (const [column, e] of Object.entries(r.bindings)) {
				if (keys !== undefined && !keys.includes(column)) {
					continue
				}
				const ids = [...readsOf(e)]
				if (ids.every((id) => known.has(id) || values.has(id))) {
					bound++
					if (
						leavesOf(e).params.length > 0 ||
						ids.some((id) => known.has(id) || values.get(id) === true)
					) {
						keyed++
					}
				} else if (e.kind === "var" && seeks.has(e.var)) {
					keyed++
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
					? { ...read.source, bind: mapBindMap(read.source.bind, (e) => passing.expr(e)) }
					: read.source
			const stepRule: InferredRule = {
				vars: stepVars,
				matches: [{ source, bindings, loc: read.loc }],
				where: inner,
				head: delivered,
				interiors: [],
				attach: [],
				loc: read.loc
			}
			const step: InferredSource = {
				kind: "step",
				query: {
					stage: {
						kind: "rules",
						arms: [source.kind === "query" ? this.#grouped(stepRule, source, bindings) : stepRule],
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
			const seeks = sought()
			let best = 0
			for (const [i, r] of reads.entries()) {
				const current = reads[best]
				if (
					current !== undefined &&
					narrower(lookupOf(r, values, seeks), lookupOf(current, values, seeks))
				) {
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
	 * The step `step` that reads an aggregating rule's groups, its one match `source` at `bindings` (Flat `grouped`): the
	 * rule restricted inside to each group field the steps before it fixed, a channel bound or a condition of the step
	 * equated with one (`fixedTerms`), its every relation then read by the group it folds (`boundInside`), and navigated
	 * as a query of its own (`navigatedQuery`), so the step folds the rows of the groups its reader reaches alone, never
	 * every group's. A folded field's binding stays the step's own, compared after the fold.
	 */
	#grouped(step: InferredRule, source: Imported, bindings: InferredBindings): InferredRule {
		const inside = boundInside(source, bindings, fixedTerms(step), this.#columns)
		const restricted: Imported = {
			...inside,
			query: navigatedQuery(inside.query, this.#loc, this.#columns, this.#sharing, this.#interned)
		}
		return { ...step, matches: [{ source: restricted, bindings, loc: step.loc }] }
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
					this.#sharing.kind === "perRead" ? conjunctions(stage.arms, this.#columns) : stage.arms
				const keptOf = (arm: InferredRule): KeptImports =>
					this.#sharing.kind === "perRead" ? noImports : sharedImports([arm], this.#interned)
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
					return this.rule({ ...arm, where: [...arm.where, ...at] }, depth + 1, keptOf(arm))
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
	imports: KeptImports,
	interned: Interned
): NonEmptyReadonlyArray<InferredRule> =>
	new Navigator(loc, columns, sharing, interned).rule(rule, 0, imports)

/** Whether a scalar condition holds a relational filter anywhere below its top, where navigation reads none (`navigable`). */
const filtersBelow = (e: InferredExpr): boolean =>
	isFiltered(e) || exprChildren(e).some((c) => filtersBelow(c.term))

/**
 * What navigation reads of a rule (`ruleReads`): `one`, the stored and closed relations and the deltas the rule reads
 * once its imports are inlined (`Navigator.#inline`), undefined where navigation reads no such rule: one with
 * interiors, attachments or a folded or produced head, a match of anything but a stored or closed relation, a delta or
 * an imported query of one such rule binding no parameter, a relational filter below a scalar expression, a filter of
 * anything but a stored or closed relation or an imported query whose conjunctions (`conjunctions`) are such rules. A
 * filter, a negation or an existence, is no read the count holds: it keeps or drops a row the reads deliver, so a rule
 * that reads one relation beside a filter is one lookup, and a filter of a delta, which no step reads by an index,
 * leaves the rule as written, where PostgreSQL hashes the delta once per statement.
 *
 * And the same over the rule's conjunctions, never built: `most`, the most relations a conjunction navigation reads
 * reads, undefined where it reads none of them, and `every`, the most where it reads every one of them, undefined where
 * it reads some one not. A conjunction is a choice of one rule at each read of an import of several rules, at any
 * depth, each read's choice its own, so the most a conjunction reads is the sum of the most each read's rules read; and
 * `filtersJoin`, whether the rule filters by a query a conjunction of which joins (`someConjunctionJoins`), as every
 * conjunction of the rule filters as it does. Each import's rules are read once (Interned `reads`), where its
 * conjunctions are the product of the unions' widths at every depth.
 */
interface RuleReads {
	readonly one: number | undefined
	readonly most: number | undefined
	readonly every: number | undefined
	readonly filtersJoin: boolean
}

/** A rule navigation reads no part of, nor any conjunction of (`RuleReads`). */
const unread: RuleReads = { one: undefined, most: undefined, every: undefined, filtersJoin: false }

/** The sum of two counts of reads, none where either is none. */
const plus = (a: number | undefined, b: number | undefined): number | undefined =>
	a === undefined || b === undefined ? undefined : a + b

/** The reads of `rule` (`RuleReads`), each rule of an import it matches or filters by read by `of`. */
const ruleReads = (rule: InferredRule, of: (rule: InferredRule) => RuleReads): RuleReads => {
	if (rule.interiors.length > 0 || rule.attach.length > 0) {
		return unread
	}
	if (Object.values(rule.head).some((h) => h.kind === "aggregate" || h.kind === "producer")) {
		return unread
	}
	let one: number | undefined = 0
	let most: number | undefined = 0
	let every: number | undefined = 0
	for (const m of rule.matches) {
		const source = m.source
		if (source.kind === "relation" || source.kind === "delta") {
			one = plus(one, 1)
			most = plus(most, 1)
			every = plus(every, 1)
			continue
		}
		if (
			source.kind !== "query" ||
			scalarBinds(source.bind) === undefined ||
			source.query.stage.kind !== "rules"
		) {
			return unread
		}
		if (foldsIn(source) !== undefined) {
			one = plus(one, 1)
			most = plus(most, 1)
			every = plus(every, 1)
			continue
		}
		const arms = mapNonEmpty(source.query.stage.arms, of)
		one = plus(one, arms.length === 1 ? arms[0].one : undefined)
		most = plus(
			most,
			arms.reduce<number | undefined>(
				(n, arm) => (arm.most === undefined ? n : Math.max(n ?? arm.most, arm.most)),
				undefined
			)
		)
		every = plus(
			every,
			arms.reduce<number | undefined>(
				(n, arm) =>
					n === undefined || arm.every === undefined ? undefined : Math.max(n, arm.every),
				0
			)
		)
	}
	let filtersJoin = false
	for (const w of rule.where) {
		if (!isFiltered(w)) {
			if (filtersBelow(w)) {
				return unread
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
			source.query.stage.kind !== "rules"
		) {
			return unread
		}
		const arms = mapNonEmpty(source.query.stage.arms, of)
		if (arms.some((arm) => arm.every === undefined)) {
			return unread
		}
		filtersJoin ||= arms.some(someConjunctionJoins)
	}
	return { one, most, every, filtersJoin }
}

/**
 * Whether navigation reads a rule and it joins (`RuleReads`): it reads two stored or closed relations or more once its
 * imports are inlined, or it filters by a query a conjunction of which joins. A rule that reads one relation and
 * filters by no join is one lookup already; one navigation reads no part of is no join it reads. A filter by a query
 * that joins, read as written, is the query's join under the terms it is filtered at, which bind only the relations
 * whose columns the query's head delivers: qti's "Dependency target" negates DependencyResolved at a dependency's
 * (package, path, start), a join of Node and ResourceId at (package, path) under it, ResourceId bound by the
 * dependency's ref alone, which only the dependency's row holds. Navigated, each relation the query reads is a step
 * bound by the terms and the steps before it.
 */
const joins = (reads: RuleReads): boolean =>
	reads.one !== undefined && (reads.one > 1 || reads.filtersJoin)

/** Whether some conjunction of a rule joins (`joins`, `conjunctions`), never built (`RuleReads` `most`). */
const someConjunctionJoins = (reads: RuleReads): boolean =>
	reads.most !== undefined && (reads.most > 1 || reads.filtersJoin)

/**
 * `rule` navigated where it joins (`joins`); one that does not, with the query each of its steps and imports reads
 * navigated where it joins (`navigateQuery`); itself where nothing in it joins. An aggregate's rule, which navigation
 * reads no part of (`RuleReads`), counts or folds the facts of the query it imports, read per unit inside a whole
 * rule's step: navigated, each relation that query joins is a lookup by every key column the steps before it bound,
 * where read as written PostgreSQL plans the join by its estimates of one unit's rows, a nested loop over a range of
 * the unit for each row of another, the unit's rows squared.
 */
const navigatedRule = (
	rule: InferredRule,
	loc: SourceLoc,
	columns: QueryColumns,
	sharing: ImportSharing,
	imports: KeptImports,
	interned: Interned
): NonEmptyReadonlyArray<InferredRule> => {
	if (joins(interned.reads(rule))) {
		return navigate(rule, loc, columns, sharing, imports, interned)
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
		return query === source.query ? m : { ...m, source: { ...inside, query } }
	})
	return [matches.every((m, i) => m === rule.matches[i]) ? rule : { ...rule, matches }]
}

/** An import a rule matches (ir/desc.ts SourceDesc `query`). */
type Imported = Extract<InferredSource, { readonly kind: "query" }>

/**
 * An import a rule matches at `bindings`, which navigation reads apart from the rule (`navigatedRule`), with each
 * binding the rule fixes (`fixedTerms`), to a parameter, a channel or a literal, equated inside each rule of the import
 * with the head term it binds, every parameter it reads passed in under a name of the import's own (`received`), at
 * every depth navigation reads
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

/**
 * The parameter an import restricted inside (`boundInside`) receives its reader's parameter `name` under, a name its
 * own navigation never mints. That navigation is a Navigator of its own, which names its channels `via<depth>.<variable>`
 * from depth 0 and its inlined variables `n<k>.` from 0, as its reader's did, so the reader's channel `via0.n0.x` is a
 * name the import's steps mint again for a variable `n0.x` of their own. A step's bind map holds one entry per name: under
 * the reader's name, the step's channel took the entry, a condition the restriction placed in that step read the step's
 * variable for the reader's value, and the import's bind map named a parameter no rule of it read, which the checker
 * refuses (check/checker.ts #importAt), as it did a containment into a union of rules each inlining one import.
 */
const received = (name: string): string => `in.${name}`

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
			passed.some((p) => own.has(received(p.name)))
		) {
			continue
		}
		for (const p of passed) {
			bind[received(p.name)] = p
		}
		held.push({
			term: boundIn(term, new Map(passed.map((p) => [p.name, { ...p, name: received(p.name) }]))),
			heads
		})
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
 * violation over its units, whose rule read per unit is a step (analysis/theory/unit.ts unitStep), navigated where it
 * joins within the unit or negates a join, as qti's "Dependency target" does, so no estimate PostgreSQL makes, with
 * statistics or none, reads a join the judge reads as a product it filters afterwards. A rule over an imported query of
 * several rules, where one of its conjunctions (`conjunctions`) joins, is navigated with each such import read whole
 * under `perStatement`, every rule statement's, one node, each of its rules navigated inside it (`sharedImports`), and
 * as the union of its conjunctions, each navigated, under `perRead`.
 */
export const navigateQuery = (
	query: InferredQuery,
	loc: SourceLoc,
	columns: QueryColumns,
	sharing: ImportSharing
): InferredQuery => navigatedQuery(query, loc, columns, sharing, new Interned())

/**
 * `navigateQuery` within one statement's navigation, its imports read whole interned in `interned`, each query of one
 * identity navigated once (Interned `navigated`).
 */
const navigatedQuery = (
	query: InferredQuery,
	loc: SourceLoc,
	columns: QueryColumns,
	sharing: ImportSharing,
	interned: Interned
): InferredQuery => {
	return interned.navigated(query, () => {
		const stage = query.stage
		if (stage.kind !== "rules") {
			return query
		}
		const keptOf = (rule: InferredRule): KeptImports =>
			sharing.kind === "perRead" ? noImports : sharedImports([rule], interned)
		const arms = flatMapNonEmpty(stage.arms, (rule): NonEmptyReadonlyArray<InferredRule> => {
			if (!splits(rule) || !someConjunctionJoins(interned.reads(rule))) {
				return navigatedRule(rule, loc, columns, sharing, keptOf(rule), interned)
			}
			switch (sharing.kind) {
				case "perStatement":
					return navigate(rule, loc, columns, sharing, keptOf(rule), interned)
				case "perRead":
					return flatMapNonEmpty(conjunctions([rule], columns), (conjunction) =>
						navigatedRule(conjunction, loc, columns, sharing, keptOf(conjunction), interned)
					)
			}
		})
		return arms.length === stage.arms.length && arms.every((rule, i) => rule === stage.arms[i])
			? query
			: { ...query, stage: { ...stage, arms } }
	})
}
