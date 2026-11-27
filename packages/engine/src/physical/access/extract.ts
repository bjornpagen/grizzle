import { firstIndex, appendAll } from "@bjornpagen/grizzle-text/base/array"
import { postorder } from "@bjornpagen/grizzle-text/base/graph"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { fusedAttachments } from "#compiler/check/approximate/attach.ts"
import { traceApproximate } from "#compiler/check/approximate/trace.ts"
import { searchedOccurrence } from "#compiler/check/search/fence.ts"
import {
	type Comparator,
	compareBooleans,
	compareNumbers,
	compareStrings,
	flip,
	mapInput,
	thenBy
} from "#compiler/core/order.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import type { KeyName, TheoryRelation } from "#compiler/ir/law.ts"
import type { AccessKey, AccessPath, AccessUse, ProgramAccess } from "#compiler/ir/products.ts"
import {
	type CompletedOrder,
	type Heading,
	inputsOf,
	type KeySet,
	type NodeOf,
	type OrderKey,
	type RelNode,
	regionVarClasses,
	type VarDecl,
	mergeOrder
} from "#compiler/ir/rel.ts"
import { baseOf, type Carrier, fewValued, isSpanCarrier } from "#compiler/ir/scalar.ts"
import { conjuncts } from "#compiler/logical/props.ts"
import {
	attachmentRead,
	type ChainStep,
	correlatedSites,
	restrictedByValues,
	semiJoinDriven
} from "#compiler/lower/optimize/cte-policy/index.ts"
import {
	type PageWindow,
	pagedReads,
	type WindowDriver
} from "#compiler/lower/shapes/page/driver.ts"
import { type RowReading, rowReading } from "#compiler/lower/shapes/share/keys.ts"
import { regionChain } from "#compiler/lower/shapes/share/sites.ts"
import {
	type Atom,
	atomKey,
	fixedAt,
	operandOf,
	predicateAtoms
} from "#compiler/physical/access/atoms.ts"
import { type Lookup, uniquePaths } from "#compiler/physical/access/paths.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"

interface ExtractOptions {
	/**
	 * The roots that are a paged ordered program, a workload program whose root is an ordered result, each with how its
	 * windows read its rows (lower/shapes/page/driver.ts PageWindow).
	 */
	readonly pageable: ReadonlyArray<PagedRoot>
	/** Each stored relation's keys as their unique indexes order their columns (`keyOrdersOf`). */
	readonly keyOrders: KeyOrders
	/** Each world relation the program reads, as the security barrier view it is installed as (`WorldView`). */
	readonly worlds: WorldViews
}

/**
 * A role's world relation as a reader's statement reads it: the security barrier view of its definition
 * (physical/ddl/roles.ts worldView), which PostgreSQL never flattens into its reader and passes only the reader's
 * leakproof quals (allpaths.c qual_is_pushdown_safe), so the reads beneath it are its definition's, read at those quals
 * alone: its definition's IR as its view's lowering rewrites it (`root`), and its heading's columns whose equality is
 * leaky (physical/access/catalog.ts leakyEquality), which stay above the barrier.
 */
export interface WorldView {
	readonly root: RelNode
	readonly leaky: ReadonlySet<string>
}

/** The world views of a program's role, by their relations' names; none for a program over reality. */
export type WorldViews = (relation: string) => WorldView | undefined

/** A program that reads no world relation: one over reality, a rule's judged read, a write filter's membership. */
export const noWorlds: WorldViews = () => undefined

/** What a barrier view passes of the facts `pushed` on its outputs into its definition: those of no leaky column. */
const beneath = (view: WorldView, pushed: Pushed): Pushed =>
	mapPushed(pushed, (c) => (view.leaky.has(c) ? undefined : c))

/**
 * Each key of a stored relation in the column order of the unique index the installation creates for it, which a seek
 * reads the leading run of: an ordinary relation's as its key states it, a span last (laws/model/plan.ts
 * primaryKeyPlan), and a stored derived relation's primary key led by its unit (analysis/derived/storage.ts
 * storedPrimaryKey), where a Base over it lists its proof's fields (ViewKey `fields`); none for a relation the theory
 * holds no table of.
 */
export type KeyOrders = (relation: string) => ReadonlyArray<ReadonlyArray<string>>

/** A key's columns in its index's order (KeyOrders): its fields as it states them, its span field last. */
const indexOrder = (key: KeyName<"primaryKey" | "key" | "derivedKey">): ReadonlyArray<string> => {
	const span = key.span?.name
	const names = key.fields.map((f) => f.name)
	return span === undefined ? names : [...names.filter((f) => f !== span), span]
}

/** The key orders of the theory's relations `relations` (KeyOrders). */
export const keyOrdersOf =
	(relations: Readonly<Record<string, TheoryRelation>>): KeyOrders =>
	(relation) => {
		const r = Object.hasOwn(relations, relation) ? relations[relation] : undefined
		return r === undefined ? [] : r.keyNames.map(indexOrder)
	}

/** A paged ordered program's root, and how its windows read its rows: as they stand, or driven by a window driver. */
export interface PagedRoot {
	readonly root: RelNode
	readonly window: PageWindow
}

type Bound = "lower" | "upper" | "pair"

/** What a node's consumers fix about its heading columns. */
interface Pushed {
	readonly eq: ReadonlyMap<string, "fixed" | "literal">
	readonly range: ReadonlyMap<string, ReadonlySet<Bound>>
	readonly span: ReadonlySet<string>
	/** The text columns a consumer holds to end with a fixed value (atoms.ts `suffix`). */
	readonly suffix: ReadonlySet<string>
	readonly pairs: ReadonlyArray<Atom>
}

const nothing: Pushed = {
	eq: new Map(),
	range: new Map(),
	span: new Set(),
	suffix: new Set(),
	pairs: []
}

/** The occurrences that drive through their keys around an occurrence with no region: none, it having no partner. */
const alone: ReadonlySet<number> = new Set()

const sorted = (xs: Iterable<string>): ReadonlyArray<string> =>
	[...new Set(xs)].toSorted(compareStrings)

/** Map entries by their key, by code unit. */
const byKey: Comparator<readonly [string, unknown]> = mapInput(
	compareStrings,
	([key]: readonly [string, unknown]) => key
)

/** The identity of the facts pushed on a node: its parts joined by NUL, each part's items by \u0001 and an item's own
 * parts by \u0002, none of which a column name holds; the pair atoms, whose keys hold NUL, are the last part. */
const pushedKey = (p: Pushed): string =>
	[
		[...p.eq.entries()]
			.toSorted(byKey)
			.map(([column, value]) => `${column}\u0002${value}`)
			.join("\u0001"),
		[...p.range.entries()]
			.toSorted(byKey)
			.map(([column, bounds]) => `${column}\u0002${sorted(bounds).join("\u0002")}`)
			.join("\u0001"),
		sorted(p.span).join("\u0001"),
		sorted(p.suffix).join("\u0001"),
		p.pairs
			.map((a) => atomKey(a))
			.toSorted(compareStrings)
			.join("\u0001")
	].join("\u0000")

/** Whether every member of a list is defined: the list of them. */
const everyDefined = <T>(
	xs: NonEmptyReadonlyArray<T | undefined>
): xs is NonEmptyReadonlyArray<T> => xs.every((x) => x !== undefined)

/** An equality fact on a column: a fixed one replaces a literal one, a literal one only fills an absent one. */
const noteEq = (
	eq: Map<string, "fixed" | "literal">,
	column: string,
	k: "fixed" | "literal"
): void => {
	if (k === "fixed" || !eq.has(column)) {
		eq.set(column, k)
	}
}

const withAtoms = (p: Pushed, atoms: ReadonlyArray<Atom>): Pushed => {
	const eq = new Map(p.eq)
	/** Each column a range atom bounds: its bounds in `p`, copied once, with the atoms' added. */
	const widened = new Map<string, Set<Bound>>()
	const span = new Set(p.span)
	const suffix = new Set(p.suffix)
	const pairs = [...p.pairs]
	for (const a of atoms) {
		switch (a.kind) {
			case "eq":
				noteEq(eq, a.column, a.with)
				continue
			case "range":
				widened.getOrInsertComputed(a.column, () => new Set(p.range.get(a.column))).add(a.bound)
				continue
			case "span":
				span.add(a.column)
				continue
			case "suffix":
				suffix.add(a.column)
				continue
			case "pairEq":
			case "pairRange":
			case "pairSpan":
			case "termEq":
				pairs.push(a)
				continue
		}
	}
	return { eq, range: new Map([...p.range, ...widened]), span, suffix, pairs }
}

/** The facts renamed through `rename`, which maps an output column to the input column it is; a fact on a column it
 * maps to nothing is dropped. */
const mapPushed = (p: Pushed, rename: (column: string) => string | undefined): Pushed => {
	const eq = new Map<string, "fixed" | "literal">()
	const range = new Map<string, Set<Bound>>()
	const span = new Set<string>()
	const suffix = new Set<string>()
	/** Two renamed columns of a pair atom, when both rename and stay two. */
	const both = (x: string, y: string): readonly [string, string] | undefined => {
		const a = rename(x)
		const b = rename(y)
		return a !== undefined && b !== undefined && a !== b ? [a, b] : undefined
	}
	/** Each entry of `facts` under its renamed column, an entry whose column renames to nothing dropped. */
	const renamed = <V>(facts: Iterable<readonly [string, V]>): ReadonlyArray<readonly [string, V]> =>
		[...facts].flatMap(([c, v]) => {
			const column = rename(c)
			return column === undefined ? [] : [[column, v] as const]
		})
	for (const [to, k] of renamed(p.eq)) {
		noteEq(eq, to, k)
	}
	for (const [to, b] of renamed(p.range)) {
		const into = range.getOrInsertComputed(to, () => new Set())
		for (const bound of b) {
			into.add(bound)
		}
	}
	for (const c of p.span) {
		const to = rename(c)
		if (to !== undefined) {
			span.add(to)
		}
	}
	for (const c of p.suffix) {
		const to = rename(c)
		if (to !== undefined) {
			suffix.add(to)
		}
	}
	/** A pair atom over its renamed columns, none when either renames to nothing or both to one column. */
	const renamedPair = (a: Atom): ReadonlyArray<Atom> => {
		switch (a.kind) {
			case "pairEq": {
				const pair = both(a.a, a.b)
				return pair === undefined ? [] : [{ kind: "pairEq", a: pair[0], b: pair[1] }]
			}
			case "pairRange":
			case "pairSpan": {
				const pair = both(a.column, a.other)
				return pair === undefined ? [] : [{ ...a, column: pair[0], other: pair[1] }]
			}
			case "termEq": {
				const column = rename(a.column)
				const reads = mapNonEmpty(a.reads, rename)
				return column === undefined || !everyDefined(reads) || reads.includes(column)
					? []
					: [{ kind: "termEq", column, reads }]
			}
			case "eq":
			case "range":
			case "span":
			case "suffix":
				return []
		}
	}
	return { eq, range, span, suffix, pairs: p.pairs.flatMap(renamedPair) }
}

const restrict = (p: Pushed, columns: ReadonlyArray<string>): Pushed => {
	const keep = new Set(columns)
	return mapPushed(p, (c) => (keep.has(c) ? c : undefined))
}

const fixedOn = (columns: Iterable<string>): Pushed => ({
	eq: new Map([...columns].map((c) => [c, "fixed" as const] as const)),
	range: new Map(),
	span: new Set(),
	suffix: new Set(),
	pairs: []
})

/**
 * What a join partner fixes about one occurrence's columns in a region, and whether the partner yields at most one row
 * per evaluation (its source's logical cardinality, ir/rel.ts Card): such a partner, a context, a write filter's row or
 * another source the logical analysis proves of at most one row, holds one value of each column per evaluation, as a
 * parameter does, so what it fixes binds every probe of the occurrence (`Extractor.contexts`).
 */
interface PartnerFacts {
	readonly eq: Set<string>
	readonly range: Set<string>
	readonly span: Set<string>
	readonly single: boolean
}

interface OccurrenceFacts {
	readonly source: RelNode
	readonly eq: Map<string, "fixed" | "literal">
	readonly range: Map<string, Set<Bound>>
	readonly span: Set<string>
	/** Its text columns its consumers hold to end with a fixed value (Pushed `suffix`). */
	readonly suffix: Set<string>
	/** By partner occurrence index, in occurrence order. */
	readonly partners: Map<number, PartnerFacts>
	/** Each region variable class bound here, to its first column. */
	readonly classes: Map<number, string>
}

/** A binding of a region's variable, at its occurrence's place among the region's occurrences, beside that one's facts. */
interface SiteBinding {
	readonly at: number
	readonly column: string
	readonly facts: OccurrenceFacts
}

interface RegionFacts {
	readonly occurrences: ReadonlyArray<OccurrenceFacts>
	/** A region heading column's variable class. */
	readonly classOf: (column: string) => number | undefined
}

/**
 * Each heading's columns' carriers by name (`carrierOf`), made at the first read of the heading: a node's heading is one
 * array, never changed, whose columns' carriers a region's contexts read for every column each context fixes, where
 * each read scanned the heading for the column (qti's workload at hub f1bf91a2f: 3.6 s of its app login's 482 s).
 */
const carriers = new WeakMap<Heading, ReadonlyMap<string, Carrier>>()

/** The carriers of a heading's columns' base types, by name: the first column of a name, as a scan of the heading finds
 * it. */
const carriersOf = (heading: Heading): ReadonlyMap<string, Carrier> => {
	const out = new Map<string, Carrier>()
	for (const h of heading) {
		if (!out.has(h.name)) {
			out.set(h.name, baseOf(h.type).carrier)
		}
	}
	return out
}

/** The carrier of a heading column's base type, none for a column the heading lacks. */
const carrierOf = (heading: Heading, column: string): Carrier | undefined =>
	carriers.getOrInsertComputed(heading, carriersOf).get(column)

const isSpanColumn = (heading: Heading, column: string): boolean => {
	const carrier = carrierOf(heading, column)
	return carrier !== undefined && isSpanCarrier(carrier)
}

const isVectorColumn = (heading: Heading, column: string): boolean =>
	carrierOf(heading, column) === "vector"

const isTextColumn = (heading: Heading, column: string): boolean =>
	carrierOf(heading, column) === "text"

/** An inet's or a cidr's column, whose containment a GiST index under inet_ops serves. */
const isNetColumn = (heading: Heading, column: string): boolean => {
	const carrier = carrierOf(heading, column)
	return carrier === "inet" || carrier === "cidr"
}

/** A search document's column (ir/scalar.ts SearchType), which only a GIN index serves a match of. */
const isSearchColumn = (heading: Heading, column: string): boolean =>
	carrierOf(heading, column) === "tsvector"

/** A column of few values (fewValued): fixing it bounds no scan. */
const isFewValued = (heading: Heading, column: string): boolean => {
	const carrier = carrierOf(heading, column)
	return carrier !== undefined && fewValued[carrier]
}

/**
 * Whether the region's variable `column` is correlated with a value fixed per evaluation, a fixed value or a literal:
 * a channel a navigation step passes the row before it in by (analysis/theory/navigate.ts).
 */
const correlatedFixed = (n: NodeOf<"MatchRegion">, column: string): boolean =>
	n.correlated.some((c) => {
		const operand = operandOf(n.id, c.expr)
		return c.var.name === column && (operand.kind === "fixed" || operand.kind === "literal")
	})

/** No variable of a region. */
const noVariables: ReadonlySet<string> = new Set()

/**
 * The variables of region `n` a filter over it fixes per evaluation (`pushed`): each it equates with a fixed value or a
 * literal, which the lowering prints in a chain step's read as it prints a parameter, and each it equates with a term of
 * fixed ones (atoms.ts termEq), a correlated value (`correlatedFixed`) or a variable
 * fixed so, closed under those terms: a navigation step's column bound to a term computed from the channels it passes
 * in, which a chain of the region seeks by as by the channel itself (`Extractor.chained`), as `regionFacts` fixes it.
 */
const pushedFixed = (n: NodeOf<"MatchRegion">, pushed: Pushed): ReadonlySet<string> => {
	const held = new Set(pushed.eq.keys())
	const terms = pushed.pairs.flatMap((a) => (a.kind === "termEq" ? [a] : []))
	const fixed = (column: string): boolean => held.has(column) || correlatedFixed(n, column)
	for (let grew = true; grew;) {
		grew = false
		for (const t of terms) {
			if (!held.has(t.column) && t.reads.every(fixed)) {
				held.add(t.column)
				grew = true
			}
		}
	}
	return held
}

/** The facts of every occurrence of a region under the pushed facts on its heading. */
const regionFacts = (n: NodeOf<"MatchRegion">, pushed: Pushed): RegionFacts => {
	const rootOf = regionVarClasses(n)
	const classIds = new Map<string, number>()
	const classOfVar = (v: VarDecl): number => {
		const root = rootOf(v)
		const known = classIds.get(root)
		if (known !== undefined) {
			return known
		}
		classIds.set(root, classIds.size)
		return classIds.size - 1
	}
	const varByName = new Map(n.vars.map((v) => [v.name, v] as const))
	const classOf = (column: string): number | undefined => {
		const v = varByName.get(column)
		return v === undefined ? undefined : classOfVar(v)
	}
	/** Each occurrence beside its facts, index for index. */
	const sites = n.occurrences.map((o) => {
		const classes = new Map<number, string>()
		for (const b of o.bindings) {
			const k = classOfVar(b.var)
			classes.getOrInsert(k, b.column)
		}
		const facts: OccurrenceFacts = {
			source: o.source,
			eq: new Map(),
			range: new Map(),
			span: new Set(),
			suffix: new Set(),
			partners: new Map(),
			classes
		}
		return { occurrence: o, facts }
	})
	const occurrences: Array<OccurrenceFacts> = sites.map((site) => site.facts)
	const headingOf = (o: OccurrenceFacts): Heading => o.source.heading
	/**
	 * Each variable class's bindings, by occurrence and then by binding, as the region states them: every binding's
	 * class is its variable's, which the sites fixed, so one pass indexes them all, and a class's bindings are read in
	 * the size of the class, where a scan of every binding of the region for each class read was quadratic in it.
	 */
	const byClass = new Map<number, Array<SiteBinding>>()
	for (const [at, { occurrence, facts }] of sites.entries()) {
		for (const b of occurrence.bindings) {
			byClass.getOrInsertComputed(classOfVar(b.var), () => []).push({ at, column: b.column, facts })
		}
	}
	const bindingsOf = (k: number): ReadonlyArray<SiteBinding> => byClass.get(k) ?? []
	const setEq = (o: OccurrenceFacts, column: string, kind: "fixed" | "literal"): void => {
		if (kind === "fixed" || !o.eq.has(column)) {
			o.eq.set(column, kind)
		}
		if (kind === "fixed" && isSpanColumn(headingOf(o), column)) {
			o.span.add(column)
		}
	}
	const partner = (o: OccurrenceFacts, at: number, of: OccurrenceFacts): PartnerFacts => {
		const known = o.partners.get(at)
		if (known !== undefined) {
			return known
		}
		const fresh: PartnerFacts = {
			eq: new Set(),
			range: new Set(),
			span: new Set(),
			single: of.source.meta.card !== "many"
		}
		o.partners.set(at, fresh)
		return fresh
	}
	/**
	 * A constant or correlated operand that fixes its column: a fixed value or a literal, or a term of the region's
	 * correlated variables, each fixed per evaluation (`correlatedFixed`), as a navigation step binds a column to a term
	 * computed from the channels it passes in.
	 */
	const fixing = (expr: ScalarExpr): "fixed" | "literal" | undefined => {
		const operand = fixedAt(operandOf(n.id, expr), (column) => correlatedFixed(n, column))
		return operand.kind === "fixed" || operand.kind === "literal" ? operand.kind : undefined
	}
	for (const { occurrence: o, facts } of sites) {
		for (const c of o.constants) {
			const kind = fixing(c.expr)
			if (kind !== undefined) {
				setEq(facts, c.column, kind)
			}
		}
	}
	/**
	 * The classes a correlated value fixes: each correlated variable's, and each class an equality pushed on the region's
	 * heading equates with a fixed one, as a navigation step binds a column to the value its channel passes in
	 * (analysis/theory/navigate.ts): `column = channel` over the step's region, the channel correlated with the row
	 * before it, so the column is as fixed as the channel.
	 */
	const fixedClasses = new Map<number, "fixed" | "literal">()
	const fix = (k: number, kind: "fixed" | "literal"): boolean => {
		const known = fixedClasses.get(k)
		if (known === "fixed" || known === kind) {
			return false
		}
		fixedClasses.set(k, kind)
		return true
	}
	for (const c of n.correlated) {
		const kind = fixing(c.expr)
		if (kind !== undefined) {
			fix(classOfVar(c.var), kind)
		}
	}
	const equated = pushed.pairs.flatMap((a): ReadonlyArray<readonly [number, number]> => {
		if (a.kind !== "pairEq") {
			return []
		}
		const k1 = classOf(a.a)
		const k2 = classOf(a.b)
		return k1 === undefined || k2 === undefined ? [] : [[k1, k2]]
	})
	for (let changed = fixedClasses.size > 0; changed;) {
		changed = false
		for (const [k1, k2] of equated) {
			const one = fixedClasses.get(k1)
			const two = fixedClasses.get(k2)
			changed = (one !== undefined && fix(k2, one)) || changed
			changed = (two !== undefined && fix(k1, two)) || changed
		}
	}
	for (const [k, kind] of fixedClasses) {
		for (const b of bindingsOf(k)) {
			setEq(b.facts, b.column, kind)
		}
	}
	/** The bindings of a pushed column's variable class, none for a column no variable names. */
	const bindingsAt = (column: string) => {
		const k = classOf(column)
		return k === undefined ? [] : bindingsOf(k)
	}
	for (const [column, kind] of pushed.eq) {
		for (const b of bindingsAt(column)) {
			setEq(b.facts, b.column, kind)
		}
	}
	for (const [column, bounds] of pushed.range) {
		for (const b of bindingsAt(column)) {
			const into = b.facts.range.getOrInsertComputed(b.column, () => new Set())
			for (const bound of bounds) {
				into.add(bound)
			}
		}
	}
	for (const column of pushed.span) {
		for (const b of bindingsAt(column).filter((x) => isSpanColumn(headingOf(x.facts), x.column))) {
			b.facts.span.add(b.column)
		}
	}
	for (const column of pushed.suffix) {
		for (const b of bindingsAt(column)) {
			b.facts.suffix.add(b.column)
		}
	}
	/** Join conditions: shared variable classes and pair atoms between classes. */
	const relate = (k1: number, k2: number, kind: "eq" | "range" | "span"): void => {
		const joined = bindingsOf(k1).flatMap((x) =>
			bindingsOf(k2).flatMap((y) =>
				x.at === y.at || (kind === "span" && !isSpanColumn(headingOf(x.facts), x.column))
					? []
					: [{ x, y }]
			)
		)
		for (const { x, y } of joined) {
			partner(x.facts, y.at, y.facts)[kind].add(x.column)
		}
	}
	for (const k of new Set(classIds.values())) {
		relate(k, k, "eq")
	}
	/** The classes a pair atom relates, both ways for an equality; none when a column has no class. */
	const relatedBy = (
		a: Atom
	): ReadonlyArray<readonly [number, number, "eq" | "range" | "span"]> => {
		switch (a.kind) {
			case "pairEq": {
				const k1 = classOf(a.a)
				const k2 = classOf(a.b)
				return k1 === undefined || k2 === undefined
					? []
					: [
							[k1, k2, "eq"],
							[k2, k1, "eq"]
						]
			}
			case "pairRange":
			case "pairSpan": {
				const k1 = classOf(a.column)
				const k2 = classOf(a.other)
				return k1 === undefined || k2 === undefined
					? []
					: [[k1, k2, a.kind === "pairRange" ? "range" : "span"]]
			}
			case "eq":
			case "range":
			case "span":
			case "suffix":
			case "termEq":
				return []
		}
	}
	for (const [k1, k2, kind] of pushed.pairs.flatMap(relatedBy)) {
		relate(k1, k2, kind)
	}
	/**
	 * A column equal to a term over other columns (atoms.ts termEq): fixed where every column the term reads is, a
	 * correlated value or a class equated with one, as a navigation step's channels are; else joined, at each occurrence
	 * that binds it, with each other occurrence that binds every column the term reads that is not fixed, where the
	 * partner fixes the term, so the column is a lookup's as a shared variable's is.
	 */
	const joinTerm = (a: Extract<Atom, { readonly kind: "termEq" }>): void => {
		const k = classOf(a.column)
		const reads = mapNonEmpty(a.reads, classOf)
		if (k === undefined || !everyDefined(reads)) {
			return
		}
		const open = reads.filter((r) => fixedClasses.get(r) !== "fixed")
		for (const x of bindingsOf(k)) {
			if (!isNonEmpty(open)) {
				setEq(x.facts, x.column, "fixed")
				continue
			}
			for (const [at, { facts }] of sites.entries()) {
				if (at !== x.at && open.every((r) => facts.classes.has(r))) {
					partner(x.facts, at, facts).eq.add(x.column)
				}
			}
		}
	}
	for (const a of pushed.pairs) {
		if (a.kind === "termEq") {
			joinTerm(a)
		}
	}
	return { occurrences, classOf }
}

/**
 * The facts the values a region's evaluation fixes hold of an occurrence's columns: its own facts and every partner's
 * of at most one row (PartnerFacts `single`), each partner's equality a fixed one, what a source read where it stands,
 * never probed at a partner of many rows, is read at; a join with a partner of many rows binds it at nothing.
 */
const valuesOf = (o: OccurrenceFacts): Pushed => {
	const eq = new Map(o.eq)
	for (const p of o.partners.values()) {
		if (p.single) {
			for (const c of p.eq) {
				eq.set(c, "fixed")
			}
		}
	}
	return { eq, range: o.range, span: o.span, suffix: o.suffix, pairs: [] }
}

/**
 * Whether an occurrence carries a fixed restriction: an equality with a fixed value, a range, a span predicate or a
 * suffix test.
 */
const restricted = (o: OccurrenceFacts): boolean =>
	[...o.eq.values()].some((k) => k === "fixed") ||
	o.range.size > 0 ||
	o.span.size > 0 ||
	o.suffix.size > 0

type KeysOf = (base: NodeOf<"Base">) => ReadonlyArray<KeySet>

/**
 * The declared keys of a stored relation's occurrence, or the proven keys of a derived relation's view, which its unique
 * indexes carry and the checker stamped on its Base: the keys the extraction reads, and a window driver's proof reads
 * where its access is extracted (program/workload/compile.ts).
 */
export const declaredKeys: KeysOf = (base) =>
	(base.relationKind === "derived"
		? base.view.map((k) => k.fields)
		: [base.primaryKey, ...base.keys]
	).filter((k) => k.length > 0)

/** A span key's index is GiST; every other key's is a B-tree. */
const keyMethod = (base: NodeOf<"Base">, key: ReadonlyArray<string>): "btree" | "gist" =>
	key.some((f) => isSpanColumn(base.heading, f)) ? "gist" : "btree"

/** What one probe of an occurrence binds (see `extractAccess`): its equalities and ranges, and its span columns, those under a
 * span predicate or fixed by equality, in code point order. */
interface Binding {
	readonly eq: ReadonlyMap<string, "fixed" | "literal">
	readonly range: ReadonlyMap<string, ReadonlySet<Bound>>
	readonly spans: ReadonlyArray<string>
	readonly suffix: ReadonlySet<string>
}

/** A binding classified for its probe context: a key lookup, a scalar probe fixing no key, or a span binding, which
 * only the span predicate's context requests. */
type Classified =
	| { readonly kind: "keyed"; readonly context: ProbeContext }
	| { readonly kind: "unkeyed"; readonly context: ProbeContext }
	| { readonly kind: "spanned" }

/** A ranged column of a probe, and whether it is bounded on both sides. */
interface RangeColumn {
	readonly column: string
	readonly both: boolean
}

/** The range a B-tree path leads with: one bounded on both sides first, then by column. */
const rangeOrder: Comparator<RangeColumn> = thenBy(
	mapInput(flip(compareBooleans), (r: RangeColumn) => r.both),
	mapInput(compareStrings, (r: RangeColumn) => r.column)
)

/** One probe of an occurrence (see `extractAccess`): a key lookup, when its equalities contain a declared key; an equality
 * and range probe binding no span, the occurrence's own facts and its partners' of one row alone or with one join
 * partner's; or the span predicate's probe of what its own facts and every partner fixing none of its keys bind
 * together, the only form a span is requested in. */
type ProbeContext =
	| { readonly kind: "key"; readonly key: ReadonlyArray<string>; readonly bound: Binding }
	| {
			readonly kind: "scalar"
			readonly eq: ReadonlyMap<string, "fixed" | "literal">
			readonly range: ReadonlyMap<string, ReadonlySet<Bound>>
			readonly suffix: ReadonlySet<string>
			readonly use: "equality lookup" | "join key"
	  }
	| {
			readonly kind: "span"
			readonly eq: ReadonlyMap<string, "fixed" | "literal">
			readonly range: ReadonlyMap<string, ReadonlySet<Bound>>
			readonly spans: NonEmptyReadonlyArray<string>
	  }

/** The columns a probe context fixes by equality, its own facts' and its partners'. */
const equalities = (ctx: ProbeContext): ReadonlyMap<string, "fixed" | "literal"> => {
	switch (ctx.kind) {
		case "key":
			return ctx.bound.eq
		case "scalar":
		case "span":
			return ctx.eq
	}
}

/** What a probe context pushes into a non-stored source. */
const pushedOf = (ctx: ProbeContext): Pushed => {
	switch (ctx.kind) {
		case "key":
			return {
				eq: ctx.bound.eq,
				range: ctx.bound.range,
				span: new Set(ctx.bound.spans),
				suffix: ctx.bound.suffix,
				pairs: []
			}
		case "scalar":
			return { eq: ctx.eq, range: ctx.range, span: new Set(), suffix: ctx.suffix, pairs: [] }
		case "span":
			return {
				eq: ctx.eq,
				range: ctx.range,
				span: new Set(ctx.spans),
				suffix: new Set(),
				pairs: []
			}
	}
}

const asc = (field: string): AccessKey => ({ field, dir: "asc" })

/** A requested column as one occurrence of a stored relation reads it: a column of the relation, or fixed per
 * evaluation (an equality fact pins it, or a projection computes a constant), which orders and groups nothing. */
type Resolved = { readonly kind: "stored"; readonly column: string } | { readonly kind: "fixed" }

const fixedColumn: Resolved = Object.freeze({ kind: "fixed" })

const resolvedIn = (facts: OccurrenceFacts, column: string): Resolved =>
	facts.eq.has(column) ? fixedColumn : { kind: "stored", column }

/** A resolved column's stored column, none for one fixed to a constant. */
const storedColumn = (resolved: Resolved): string | undefined =>
	resolved.kind === "stored" ? resolved.column : undefined

/** A column a node is asked to resolve, with what its asker reads back beside the answer (`A`): a heading column of
 * the node, or one a projection above it already fixed to a constant it computes. */
type Request<A> =
	| { readonly kind: "column"; readonly name: string; readonly asked: A }
	| { readonly kind: "fixed"; readonly asked: A }

/** Each heading column of `columns` as a request that reads back the column itself. */
const columnRequests = (columns: ReadonlyArray<string>): ReadonlyArray<Request<string>> =>
	columns.map((name) => ({ kind: "column", name, asked: name }))

/** A request answered: what its asker reads back, and the column of the occurrence it resolved to. */
interface Answer<A> {
	readonly asked: A
	readonly resolved: Resolved
}

/** The requested columns of a node read from one occurrence of a stored relation: the relation, the facts pushed on
 * that occurrence, whether its region's rows come in its order (`leads`), and each request's answer, in request order. */
interface Resolution<A> {
	readonly base: NodeOf<"Base">
	readonly facts: OccurrenceFacts
	/**
	 * Whether the region's rows come in this occurrence's order, what an ordered path of it serves (orderedPath): it leads
	 * the chain the lowering reads its region by where it stands (share/sites.ts regionChain), each later step read per
	 * row of it; where PostgreSQL joins the region, no other occurrence of it is restricted; a stored relation read
	 * alone, always. A take over a region its chain starts elsewhere sorts the chain's rows: metis's myOpenSittingsOf, the
	 * signed-in learner's open sittings of a test, the lowest two first, reads the claims' Clerk user, its person and the
	 * person's assignments of the test, where a take seek of every learner's assignments of the test in number order,
	 * which no plan of the chain reads, cost a B-tree insert on every assignment.
	 */
	readonly leads: boolean
	readonly columns: ReadonlyArray<Answer<A>>
}

/** A request of a region's heading column by the class of its variable, or one already fixed. */
type Classed<A> =
	| { readonly kind: "class"; readonly k: number; readonly asked: A }
	| Extract<Request<A>, { readonly kind: "fixed" }>

class Extractor {
	readonly options: ExtractOptions
	/** Every path asked for, with the columns of the lookup through it (`equalities`), none for an ordered or a vector
	 * one. */
	readonly lookups: Array<Lookup> = []
	/** The pushed facts each node was visited under, by their key: the walk's seen-set. */
	readonly #visited = new Map<RelNode, Set<string>>()
	readonly #pageable: ReadonlyMap<RelNode, PageWindow>
	/**
	 * The searched occurrences of approximate reads and of text searches, each read through its fence alone
	 * (lower/shapes/vector fenceOf, lower/shapes/search searchFenced), which no path of their region's filters, matches
	 * or negations reaches: a B-tree a filter asked of one would serve no plan of the read and would only price its
	 * search, so none is asked (`basePaths`).
	 */
	readonly #streamed = new Set<NodeOf<"Base">>()
	/**
	 * The reads the lowering makes per row of a driver and the regions they hold at a restriction (lower/shapes/share/
	 * keys.ts rowReading), the one walk the lowering reads them by, and each node's readers among the walked nodes.
	 */
	readonly #reading: RowReading
	readonly #readers = new Map<RelNode, Set<RelNode>>()
	/**
	 * The attachments whose child the lowering reads whole, once for every parent (cte-policy attachmentRead `whole`,
	 * lower/shapes/attach pipelinedAttachment), its child derived once and hashed beside the parent keys, so no statement
	 * seeks the child at a parent's values, where a statement of its own reads it;
	 * fused into a statement whose rows read a search (check/approximate/attach.ts fusedAttachments), every child is read
	 * per parent row.
	 */
	readonly #wholeChildren: ReadonlySet<NodeOf<"Attach">>

	constructor(
		options: ExtractOptions,
		roots: ReadonlyArray<RelNode>,
		nodes: ReadonlyArray<RelNode>
	) {
		this.options = options
		this.#pageable = new Map(options.pageable.map((p) => [p.root, p.window] as const))
		const fused = new Set(roots.flatMap(fusedAttachments))
		this.#wholeChildren = new Set(
			nodes.flatMap((n) =>
				n.kind === "Attach" && attachmentRead(n).kind === "whole" && !fused.has(n) ? [n] : []
			)
		)
		this.#reading = rowReading(
			nodes,
			options.pageable.flatMap((p) => pagedReads(p.window))
		)
		for (const node of nodes) {
			for (const input of inputsOf(node)) {
				this.#readers.getOrInsertComputed(input, () => new Set()).add(node)
			}
		}
	}

	/** The declared keys of a stored relation's occurrence, or the proven keys of a derived relation's view, which its
	 * unique indexes carry and the checker stamped on its Base. */
	readonly keysOf: KeysOf = (base) => declaredKeys(base)

	keyWithin(base: NodeOf<"Base">, columns: ReadonlySet<string>): ReadonlyArray<string> | undefined {
		return this.keysOf(base).find((k) => k.every((f) => columns.has(f)))
	}

	/**
	 * The paths `n`'s reads ask, each read under what `pushed` holds of its columns. An existence test's right side is
	 * probed at its pairs per left row, but a semi-join its right side drives (cte-policy semiJoinDriven) reads that side
	 * once, at what holds the semi-join's columns its pairs carry, and its left side per key: no left row probes the
	 * driver, which asks the paths its own values seek. A semi-join whose right side's rows the statement's own values
	 * restrict (cte-policy restrictedByValues), driven or not, holds its left side's pair columns at values fixed where it
	 * is evaluated, each left row's a row of those, as a join with that side in one region does: a read of T by its text
	 * where a parameter's row of S holds the text (test/unit/physical/digest-seeks `a shared variable`) seeks T at it.
	 */
	visit(n: RelNode, pushed: Pushed): void {
		const key = pushedKey(pushed)
		const seen = this.#visited.get(n)
		if (seen?.has(key) === true) {
			return
		}
		if (seen === undefined) {
			this.#visited.set(n, new Set([key]))
		} else {
			seen.add(key)
		}
		const all = (steps: ReadonlyArray<readonly [RelNode, Pushed]>): void => {
			for (const [child, p] of steps) {
				this.visit(child, p)
			}
		}
		switch (n.kind) {
			case "MatchRegion":
				return this.region(n, pushed)
			case "Base":
				if (n.relationKind === "world") {
					return this.throughBarrier(n, pushed)
				}
				this.basePaths(
					n,
					{
						source: n,
						eq: new Map(pushed.eq),
						range: new Map([...pushed.range].map(([c, b]) => [c, new Set(b)] as const)),
						span: new Set([...pushed.span].filter((c) => isSpanColumn(n.heading, c))),
						suffix: new Set(pushed.suffix),
						partners: new Map(),
						classes: new Map()
					},
					alone
				)
				return
			case "Filter": {
				const searched = searchedOccurrence(n)
				if (searched !== undefined) {
					this.#streamed.add(searched.base)
				}
				this.textSearch(n.input, n.pred)
				this.netContainment(n.input, n.pred)
				return this.visit(n.input, withAtoms(pushed, this.atomsOf(n)))
			}
			case "ProjectSet":
				return this.visit(n.input, mapPushed(pushed, this.projection(n)))
			case "Take": {
				const input = fixedOn(n.correlation.map((c) => c.column))
				this.ordered(n.input, mergeOrder(n.orders, n.input.heading), "take seek", input)
				return this.visit(n.input, input)
			}
			case "OrderedResult": {
				const window = this.#pageable.get(n)
				const order = mergeOrder(n.orders, n.input.heading)
				if (window?.kind === "driven") {
					this.drivenSeek(window.driver, order)
				} else if (window?.kind === "asItStands") {
					this.ordered(n.input, order, "page seek", pushed)
				}
				return this.visit(n.input, pushed)
			}
			case "Group":
				return this.visit(n.input, restrict(pushed, n.keys))
			case "Union":
				return all(
					n.groups.flatMap((g) =>
						g.arms.map((arm): readonly [RelNode, Pushed] => [
							arm,
							restrict(
								pushed,
								arm.heading.map((c) => c.name)
							)
						])
					)
				)
			case "Intersect":
			case "Difference":
				return all([
					[n.left, pushed],
					[n.right, fixedOn(n.right.heading.map((c) => c.name))]
				])
			case "SemiJoin":
				return all([
					[
						n.left,
						restrictedByValues(n.right)
							? withAtoms(
									pushed,
									n.on.map((p) => ({ kind: "eq", column: p.left, with: "fixed" }) as const)
								)
							: pushed
					],
					[
						n.right,
						semiJoinDriven(n) === undefined
							? fixedOn(n.on.map((p) => p.right))
							: mapPushed(pushed, (c) => n.on.find((p) => p.left === c)?.right)
					]
				])
			case "AntiJoin":
				return all([
					[n.left, pushed],
					[n.right, fixedOn(n.on.map((p) => p.right))]
				])
			case "Attach":
				return all([
					[n.parent, pushed],
					[
						n.child,
						this.#wholeChildren.has(n) ? nothing : fixedOn(n.correlation.map((c) => c.child))
					]
				])
			case "Recursive":
				return all([
					[n.base, nothing],
					[n.step, nothing]
				])
			case "ApproximateNearest": {
				this.nearest(n.source, n.score)
				const traced = traceApproximate(n.source, n.score)
				if (traced.ok) {
					this.#streamed.add(traced.value.base)
				}
				return this.visit(n.source, nothing)
			}
			case "Produce":
				return this.visit(n.input, restrict(pushed, n.carried))
			case "Window":
				return this.visit(n.input, restrict(pushed, n.partition))
			case "OrderedSetAggregate":
				return this.visit(n.input, restrict(pushed, n.keys))
			case "Forbid":
				return this.visit(n.violation, nothing)
			case "Step":
				return this.visit(n.input, pushed)
			case "Call":
				return all(
					n.args.flatMap((a): ReadonlyArray<readonly [RelNode, Pushed]> =>
						a.kind === "rows" ? [[a.rows, nothing]] : []
					)
				)
			case "Closed":
			case "Context":
			case "InputSet":
			case "Delta":
			case "SelfRef":
				return
		}
	}

	/** An output column of a projection to the input column it is, or undefined when it is computed. */
	projection(n: NodeOf<"ProjectSet">): (column: string) => string | undefined {
		return (column) => {
			const out = n.out.find((o) => o.name === column)
			if (out === undefined) {
				return undefined
			}
			const e = out.expr
			return e.kind === "column" && e.column.node === n.input.id ? e.column.name : undefined
		}
	}

	/**
	 * The atoms of a filter's predicate over its input (atoms.ts predicateAtoms), a column fixed per evaluation where its
	 * input computes it as a constant (`constantColumn`) or a region's variable is correlated with a fixed value, the
	 * channel a navigation step passes the row before it in by (analysis/theory/navigate.ts).
	 */
	atomsOf(n: NodeOf<"Filter">): ReadonlyArray<Atom> {
		const input = n.input
		const constant = (column: string): boolean => {
			if (input.kind === "ProjectSet") {
				return this.constantColumn(input, column)
			}
			return input.kind === "MatchRegion" && correlatedFixed(input, column)
		}
		return predicateAtoms(input.id, n.pred, constant)
	}

	/** Whether an output column of a projection is a constant: a literal, a parameter, or an outer value. */
	constantColumn(n: NodeOf<"ProjectSet">, column: string): boolean {
		const out = n.out.find((o) => o.name === column)
		if (out === undefined) {
			return false
		}
		const operand = operandOf(n.input.id, out.expr)
		return operand.kind === "fixed" || operand.kind === "literal"
	}

	region(n: NodeOf<"MatchRegion">, pushed: Pushed): void {
		const chains = this.chainsOf(n)
		const held = pushedFixed(n, pushed)
		for (const steps of chains.steps) {
			this.chained(steps, held)
		}
		if (chains.alone) {
			return
		}
		const facts = regionFacts(n, pushed)
		const keyDriven = new Set(
			facts.occurrences.flatMap((o, at) => {
				const source = o.source
				return source.kind === "Base" && this.drivesByKey(source, o) ? [at] : []
			})
		)
		for (const o of facts.occurrences) {
			this.occurrence(o, keyDriven)
		}
	}

	/**
	 * The chains the lowering reads a region by (lower/shapes/region regionSelect, share/sites.ts regionChain): the one its
	 * own fixed values and correlated sites start, read wherever it stands, and one for each restriction a row site's
	 * walk holds it at (share/keys.ts rowReading `restricted`); `alone` where every read of it is chained, its own chain
	 * starting, or every reader reading it per row of a driver, so no plan of it orders its occurrences by estimates and
	 * no path anticipating such an order is asked.
	 */
	chainsOf(n: NodeOf<"MatchRegion">): {
		readonly steps: ReadonlyArray<ReadonlyArray<ChainStep>>
		readonly alone: boolean
	} {
		const sites = correlatedSites(n)
		const own = regionChain(n, [], sites)
		const walked = (this.#reading.restricted.get(n) ?? []).flatMap((columns) => {
			const steps = regionChain(n, columns, sites)
			return steps === undefined ? [] : [steps]
		})
		const perRow = this.#reading.readers.get(n)
		const readers = [...(this.#readers.get(n) ?? [])]
		return {
			steps: own === undefined ? walked : [own, ...walked],
			alone:
				own !== undefined || (walked.length > 0 && readers.every((r) => perRow?.has(r) === true))
		}
	}

	/**
	 * The paths one chain's steps seek by, each step's alone (cte-policy ChainStep): a stored source's at the columns
	 * its seek binds (`stepPath`), those the steps before it bind and those `fixed` says the statement's values fix of
	 * its occurrence, a parameter's, a literal's or an outer row's, which the step's WHERE states beside them, and any
	 * other source, a row site, read at them, its own reads walked under them; or,
	 * a source a row site's root holds once (share/keys.ts rowReading `held`), derived at each restriction it is held at,
	 * its CTE, which the step reads where it stands, at its own columns: a batch's scores, a union a probe's attachment
	 * reads at its x and stage and at its y and stage, is derived once per probe at the stage alone, and its arms' paths
	 * are the stage's, where asked at each read's columns they were paths no plan reads and the stage's none. A step's
	 * seek binds beside its own columns each column of its occurrence bound to a variable `held` holds, one a filter over
	 * the region fixes (`pushedFixed`), which the lowering prints in the step's own read: a navigation step's column bound
	 * to a term of the channels it passes in, `g = CASE WHEN octet_length(x) ... END` (PUBLISH2's placed variable
	 * reference, its identifier a bounded text's guarded cast of its declaration's attribute value).
	 */
	chained(steps: ReadonlyArray<ChainStep>, held: ReadonlySet<string>): void {
		for (const step of steps) {
			const source = step.occurrence.source
			const at = [
				...step.at,
				...step.occurrence.bindings.flatMap((b) =>
					held.has(b.var.name) && !step.at.includes(b.column) ? [b.column] : []
				)
			]
			if (source.kind === "Base") {
				this.stepPath(source, at)
				continue
			}
			for (const restriction of this.#reading.held.get(source) ?? [at]) {
				this.visit(source, fixedOn(restriction))
			}
		}
	}

	/**
	 * The path a chain step seeks a stored relation by, at `at`, the columns its seek binds in the order the step leads
	 * with them: a key's own index where they hold a declared key whole or are the leading run of its index, in the order
	 * the installation creates it (ExtractOptions `keyOrders`), else an equality lookup of exactly the columns it binds,
	 * in that order, the step's bound columns before its codes (never the key prefix a dependency proves, which the seek
	 * binds no column of); a world relation's view read beneath its barrier at them (`throughBarrier`); none for a
	 * searched or streamed occurrence read through its fence, or columns of codes alone, which pick a roster's share of
	 * the rows. A key's own
	 * order is its index's, never the order a Base lists it in: a stored derived relation's key is its proof's fields,
	 * where its table's unique index leads with its unit (analysis/derived/storage.ts storedPrimaryKey), so a seek of
	 * Counted at its document, its key (doc, shelf) and its index (shelf, doc), read as a lookup of the key's index asked
	 * no index leading with the document.
	 */
	stepPath(base: NodeOf<"Base">, at: ReadonlyArray<string>): void {
		if (base.relationKind === "world") {
			this.throughBarrier(base, fixedOn(at))
			return
		}
		if (this.#streamed.has(base)) {
			return
		}
		const heading = base.heading
		const seeks = at.filter((c) => !isSpanColumn(heading, c) && !isVectorColumn(heading, c))
		if (!isNonEmpty(seeks)) {
			return
		}
		/** A declared key the seek binds whole, or whose index leads with exactly the columns it binds: its own index. */
		const bound = new Set(seeks)
		const key =
			this.keyWithin(base, bound) ??
			this.options
				.keyOrders(base.relation)
				.find((k) => k.length > bound.size && k.slice(0, bound.size).every((f) => bound.has(f)))
		const path: AccessPath | undefined =
			key !== undefined
				? {
						relation: base.relation,
						derived: base.relationKind === "derived",
						method: keyMethod(base, key),
						keys: key.map((f) => asc(f)),
						fixed: key.length,
						use: "key lookup"
					}
				: seeks.some((c) => !isFewValued(heading, c))
					? {
							relation: base.relation,
							derived: base.relationKind === "derived",
							method: "btree",
							keys: seeks.map((f) => asc(f)),
							fixed: seeks.length,
							use: "equality lookup"
						}
					: undefined
		if (path !== undefined) {
			this.lookups.push({ path, binds: [sorted(seeks)] })
		}
	}

	/**
	 * The reads beneath a world relation's barrier view read at `pushed` (WorldView): its definition at the facts the
	 * barrier passes; none for a world the program's options hold no view of.
	 */
	throughBarrier(base: NodeOf<"Base">, pushed: Pushed): void {
		const view = this.options.worlds(base.relation)
		if (view !== undefined) {
			this.visit(view.root, beneath(view, pushed))
		}
	}

	/** Whether an occurrence of a stored relation drives a plan through one of its keys' own indexes: its own fixed
	 * facts bind every column of a key, each scalar column by an equality and a span column by an equality or a span
	 * predicate, so a key lookup, or a span key's GiST index read through the span predicate, serves them. A world
	 * relation holds no index of its own. */
	drivesByKey(base: NodeOf<"Base">, o: OccurrenceFacts): boolean {
		return (
			base.relationKind !== "world" &&
			this.keysOf(base).some((key) =>
				key.every((f) => o.eq.has(f) || (isSpanColumn(base.heading, f) && o.span.has(f)))
			)
		)
	}

	/** One occurrence of a region: a stored source's access paths, or each probe context pushed into another source.
	 * `keyDriven` holds the region's occurrences that drive through their keys (drivesByKey), by index. */
	occurrence(o: OccurrenceFacts, keyDriven: ReadonlySet<number>): void {
		const source = o.source
		if (source.kind === "Base" && source.relationKind === "world") {
			this.throughBarrier(source, valuesOf(o))
			return
		}
		if (source.kind === "Base") {
			this.basePaths(source, o, keyDriven)
			return
		}
		for (const ctx of this.contexts(o, source.heading, () => undefined, keyDriven)) {
			this.visit(o.source, pushedOf(ctx))
		}
	}

	/** The probe contexts of an occurrence whose source has `heading` and whose keys `keyWithin` finds among equal
	 * columns (see `extractAccess`): the base context, unless a partner in `keyDriven` (the region's occurrences that
	 * drive through their keys) reaches the occurrence by its key, and one per join partner of many rows that fixes
	 * something, each a key lookup or binding no span; and the span predicate's context, when one of the others binds a
	 * span, of the base facts and every partner that fixes no key. What a partner of at most one row per evaluation
	 * fixes is part of every context, the base one included, as the occurrence's own fixed facts are. A source that is
	 * not stored receives each probe context pushed into it. */
	contexts(
		o: OccurrenceFacts,
		heading: Heading,
		keyWithin: (columns: ReadonlySet<string>) => ReadonlyArray<string> | undefined,
		keyDriven: ReadonlySet<number>
	): ReadonlyArray<ProbeContext> {
		const fixing = [...o.partners.entries()]
			.toSorted(mapInput(compareNumbers, ([at]: readonly [number, unknown]) => at))
			.filter(([, p]) => p.eq.size > 0 || p.range.size > 0 || p.span.size > 0)
		/** The partners of at most one row per evaluation, which bind every context. */
		const singles = fixing.flatMap(([, p]) => (p.single ? [p] : []))
		const partners = fixing.filter(([, p]) => !p.single)
		/** The base facts with those of every partner of one row and of `joined`, each partner's equalities fixed and
		 * ranges paired. */
		const bound = (joined: ReadonlyArray<PartnerFacts>): Binding => {
			const eq = new Map(o.eq)
			/** Each column a partner pairs: its bounds in `o`, copied once, with "pair" added. */
			const widened = new Map<string, Set<Bound>>()
			const span = new Set(o.span)
			for (const p of [...singles, ...joined]) {
				for (const c of p.eq) {
					eq.set(c, "fixed")
				}
				for (const c of p.range) {
					widened.getOrInsertComputed(c, () => new Set(o.range.get(c))).add("pair")
				}
				for (const c of p.span) {
					span.add(c)
				}
			}
			const spans = sorted([
				...span,
				...[...eq].filter(([c, k]) => k === "fixed" && isSpanColumn(heading, c)).map(([c]) => c)
			])
			return { eq, range: new Map([...o.range, ...widened]), spans, suffix: o.suffix }
		}
		const classify = (b: Binding, use: "equality lookup" | "join key"): Classified => {
			const key = keyWithin(new Set(b.eq.keys()))
			if (key !== undefined) {
				return { kind: "keyed", context: { kind: "key", key, bound: b } }
			}
			return b.spans.length > 0
				? { kind: "spanned" }
				: {
						kind: "unkeyed",
						context: { kind: "scalar", eq: b.eq, range: b.range, suffix: b.suffix, use }
					}
		}
		const joined = partners.map(([at, p]) => ({
			at,
			partner: p,
			classified: classify(bound([p]), "join key")
		}))
		/** A partner that drives through its own key and reaches this occurrence by this occurrence's key: the region
		 * has a plan through key indexes alone, that partner first, so an index on the occurrence's own facts would
		 * serve only the other order. */
		const reachedByKey = joined.some((j) => j.classified.kind === "keyed" && keyDriven.has(j.at))
		const base = classify(bound([]), "equality lookup")
		const classified = [
			...(reachedByKey && base.kind === "unkeyed" ? [] : [base]),
			...joined.map((j) => j.classified)
		]
		const out = classified.flatMap((c): ReadonlyArray<ProbeContext> =>
			c.kind === "spanned" ? [] : [c.context]
		)
		if (!classified.some((c) => c.kind === "spanned")) {
			return out
		}
		/** The partners the span predicate's context binds: those fixing no key. */
		const unkeyed = joined.flatMap((j) => (j.classified.kind === "keyed" ? [] : [j.partner]))
		const keyed = classified.some((c) => c.kind === "keyed")
		/**
		 * The span predicate's context of the binding `b`: its key's lookup where its equalities hold a key; beside a key
		 * lookup only with a scalar a GiST index leads, a column equal to a parameter's value or to a literal, each of
		 * which the statement's seek binds, since on the span alone it is an index no plan reads, the occurrence being
		 * reached by its key, or a span key's own index, which the key already holds and through which the occurrence
		 * drives (drivesByKey).
		 */
		const spanned = (b: Binding): ReadonlyArray<ProbeContext> => {
			const key = keyWithin(new Set(b.eq.keys()))
			if (key !== undefined) {
				return [{ kind: "key", key, bound: b }]
			}
			const scalar = [...b.eq.keys()].some(
				(c) => !isSpanColumn(heading, c) && !isVectorColumn(heading, c)
			)
			return isNonEmpty(b.spans) && (!keyed || scalar)
				? [{ kind: "span", eq: b.eq, range: b.range, spans: b.spans }]
				: []
		}
		/**
		 * The occurrence's own span binding, its facts and its partners' of one row, where partners of many rows bind it
		 * beside: the seek its statement makes wherever PostgreSQL reads those partners by a join, which binds nothing,
		 * as a statement binding a span at a literal and a scalar beside a join of a many-row relation makes it.
		 */
		const own = base.kind === "spanned" && isNonEmpty(unkeyed) ? spanned(bound([])) : []
		return [...out, ...own, ...spanned(bound(unkeyed))]
	}

	/** The access paths of an occurrence of a stored relation, one path family per
	 * probe context under the fixed form policy. Handle columns alone are no access path: equal to a parameter or a
	 * partner as to a literal, they select a roster's share of the rows at best, and a range over them is no more than
	 * an equality. A world relation is a view, read beneath its barrier (`throughBarrier`), so its own name never reaches
	 * an index. */
	basePaths(base: NodeOf<"Base">, o: OccurrenceFacts, keyDriven: ReadonlySet<number>): void {
		if (this.#streamed.has(base)) {
			return
		}
		const heading = base.heading
		const path = (
			method: AccessPath["method"],
			keys: ReadonlyArray<AccessKey>,
			fixed: number,
			use: AccessUse
		): AccessPath => ({
			relation: base.relation,
			derived: base.relationKind === "derived",
			method,
			keys,
			fixed,
			use
		})
		const contextPaths = (ctx: ProbeContext): ReadonlyArray<AccessPath> => {
			if (ctx.kind === "key") {
				return [
					path(
						keyMethod(base, ctx.key),
						ctx.key.map((f) => asc(f)),
						ctx.key.length,
						"key lookup"
					)
				]
			}
			const equal = new Set(ctx.eq.keys())
			const prefix = sorted(
				[...equal].filter((c) => !isSpanColumn(heading, c) && !isVectorColumn(heading, c))
			)
			if (ctx.kind === "span") {
				return ctx.spans.map((span) =>
					path(
						"gist",
						[...prefix, span].map((f) => asc(f)),
						prefix.length,
						"span predicate"
					)
				)
			}
			const ranges = [...ctx.range]
				.filter(([c]) => !equal.has(c) && !isSpanColumn(heading, c) && !isVectorColumn(heading, c))
				.map(([c, b]): RangeColumn => ({
					column: c,
					both: (b.has("lower") && b.has("upper")) || b.has("pair")
				}))
			const [range] = ranges.toSorted(rangeOrder)
			if (range !== undefined) {
				const { both, column } = range
				const use: AccessUse =
					both && ctx.range.get(column)?.has("pair") !== true && isTextColumn(heading, column)
						? "prefix search"
						: "range"
				return [...prefix, column].some((c) => !isFewValued(heading, c))
					? [
							path(
								"btree",
								[...prefix, column].map((f) => asc(f)),
								prefix.length,
								use
							)
						]
					: []
			}
			return prefix.some((c) => !isFewValued(heading, c))
				? [
						path(
							"btree",
							prefix.map((f) => asc(f)),
							prefix.length,
							ctx.use
						)
					]
				: []
		}
		for (const ctx of this.contexts(
			o,
			heading,
			(columns) => this.keyWithin(base, columns),
			keyDriven
		)) {
			const binds = sorted([...equalities(ctx).keys()])
			appendAll(
				this.lookups,
				contextPaths(ctx).map((p): Lookup => ({ path: p, binds: [binds] }))
			)
		}
	}

	/** Resolves requested heading columns of `n` to one stored occurrence under the facts pushed on `n`: the
	 * occurrence, each request's answer (a stored column, or fixed to a constant), and the facts of every occurrence of
	 * its region. It reaches through a filter, a projection by column reference, a union's arms, an
	 * attachment's parent and the left side of a semi-join, anti-join, intersection or difference, which keep that
	 * input's rows and heading columns and the facts pushed on it; an attached column is computed. Empty when a column
	 * is computed, the columns span several occurrences, or another node stands between: one whose columns are computed
	 * or whose rows are not one occurrence's, or a driven semi-join (cte-policy semiJoinDriven), which reads its left
	 * side per right-side key, each key's read reaching the left side's relations by its chain, which no order above it
	 * seeks. */
	resolve<A>(
		n: RelNode,
		requests: ReadonlyArray<Request<A>>,
		pushed: Pushed
	): ReadonlyArray<Resolution<A>> {
		switch (n.kind) {
			case "Filter":
				return this.resolve(n.input, requests, withAtoms(pushed, this.atomsOf(n)))
			case "ProjectSet": {
				const rename = this.projection(n)
				/** Each request as the input reads it: an input column the projection renames, or fixed to a constant the
				 * projection computes; none when a column is computed otherwise. */
				const inner: Array<Request<A>> = []
				for (const r of requests) {
					if (r.kind === "fixed") {
						inner.push(r)
						continue
					}
					const column = rename(r.name)
					if (column !== undefined) {
						inner.push({ kind: "column", name: column, asked: r.asked })
					} else if (this.constantColumn(n, r.name)) {
						inner.push({ kind: "fixed", asked: r.asked })
					} else {
						return []
					}
				}
				return this.resolve(n.input, inner, mapPushed(pushed, rename))
			}
			case "Union":
				return n.groups.flatMap((g) =>
					g.arms.flatMap((arm) => {
						const heading = arm.heading.map((c) => c.name)
						return requests.every((r) => r.kind === "fixed" || heading.includes(r.name))
							? this.resolve(arm, requests, restrict(pushed, heading))
							: []
					})
				)
			case "Base": {
				const facts: OccurrenceFacts = {
					source: n,
					eq: new Map(pushed.eq),
					range: new Map([...pushed.range].map(([c, b]) => [c, new Set(b)] as const)),
					span: new Set(pushed.span),
					suffix: new Set(pushed.suffix),
					partners: new Map(),
					classes: new Map()
				}
				const columns = requests.map((r): Answer<A> => ({
					asked: r.asked,
					resolved: r.kind === "fixed" ? fixedColumn : resolvedIn(facts, r.name)
				}))
				return [{ base: n, facts, leads: true, columns }]
			}
			case "MatchRegion": {
				const region = regionFacts(n, pushed)
				/** Each request by its column's class, a fixed one as it is; none when a column has no class. */
				const classed: Array<Classed<A>> = []
				for (const r of requests) {
					if (r.kind === "fixed") {
						classed.push(r)
						continue
					}
					const k = region.classOf(r.name)
					if (k === undefined) {
						return []
					}
					classed.push({ kind: "class", k, asked: r.asked })
				}
				/** The answers of an occurrence that binds every requested class, none when it binds not every one. */
				const answers = (facts: OccurrenceFacts): ReadonlyArray<Answer<A>> | undefined => {
					const out: Array<Answer<A>> = []
					for (const c of classed) {
						if (c.kind === "fixed") {
							out.push({ asked: c.asked, resolved: fixedColumn })
							continue
						}
						const own = facts.classes.get(c.k)
						if (own === undefined) {
							return undefined
						}
						out.push({ asked: c.asked, resolved: resolvedIn(facts, own) })
					}
					return out
				}
				const [lead] = regionChain(n, [], correlatedSites(n)) ?? []
				for (const [at, facts] of region.occurrences.entries()) {
					const source = facts.source
					if (source.kind !== "Base") {
						continue
					}
					const columns = answers(facts)
					if (columns !== undefined) {
						return [
							{
								base: source,
								facts,
								leads:
									lead === undefined
										? region.occurrences.every((o) => o === facts || !restricted(o))
										: lead.occurrence === n.occurrences[at],
								columns
							}
						]
					}
				}
				return []
			}
			case "Attach":
				return requests.some((r) => r.kind === "column" && r.name === n.name)
					? []
					: this.resolve(n.parent, requests, pushed)
			case "SemiJoin":
				return semiJoinDriven(n) === undefined ? this.resolve(n.left, requests, pushed) : []
			case "AntiJoin":
			case "Intersect":
			case "Difference":
				return this.resolve(n.left, requests, pushed)
			case "Step":
				return this.resolve(n.input, requests, pushed)
			case "Call":
			case "Closed":
			case "Context":
			case "InputSet":
			case "Delta":
			case "Take":
			case "Group":
			case "Produce":
			case "Recursive":
			case "SelfRef":
			case "ApproximateNearest":
			case "OrderedResult":
			case "Forbid":
			case "Window":
			case "OrderedSetAggregate":
				return []
		}
	}

	/** The ordered path of a take, a page or a paged ordered program (see `extractAccess`). */
	ordered(input: RelNode, order: CompletedOrder, use: AccessUse, pushed: Pushed): void {
		const requests = order.keys.map((k): Request<OrderKey> => ({
			kind: "column",
			name: k.column,
			asked: k
		}))
		for (const r of this.resolve(input, requests, pushed)) {
			const path = this.orderedPath(r, use)
			if (path !== undefined) {
				this.lookups.push({ path, binds: [] })
			}
		}
	}

	/** The ordered path of one resolution of an ordered input: none when its region's rows come in another occurrence's
	 * order (Resolution `leads`), its equalities already fix a key, the order reaches a vector column, no ordered column
	 * is stored, or the relation is a world's. */
	orderedPath(r: Resolution<OrderKey>, use: AccessUse): AccessPath | undefined {
		if (!r.leads || r.base.relationKind === "world") {
			return undefined
		}
		return this.seekPath(
			r.base,
			[...r.facts.eq].flatMap(([c, k]) => (k === "fixed" ? [c] : [])),
			new Set(r.facts.eq.keys()),
			r.columns.flatMap(({ asked: k, resolved }) => {
				const column = storedColumn(resolved)
				return column === undefined ? [] : [{ field: column, dir: k.dir }]
			}),
			use
		)
	}

	/**
	 * The page seek of a driven window (lower/shapes/page/driver.ts): the driver's own index, its prefix's columns (the
	 * call's points, then the columns its value set's chain reads) then the order's, the seek each part of the window the
	 * lowering prints reads (page/rows.ts drivenRows), the first instance of extraction asking exactly the seek a lowering
	 * prints, where it anticipates every join order elsewhere; none where the prefix's columns determine the driver's unit
	 * (WindowDriver unitBound), whose seek reads that unit's rows by its key's prefix. The value set's chain seeks each of
	 * its steps as any chain does (`chained`).
	 */
	drivenSeek(driver: WindowDriver, order: CompletedOrder): void {
		this.chained(driver.values.steps, noVariables)
		if (driver.unitBound) {
			return
		}
		const fixed = driver.prefix
		const path = this.seekPath(
			driver.base,
			fixed,
			new Set(fixed),
			order.keys.flatMap((k) => {
				const column = driver.columns.find((c) => c.heading === k.column)?.column
				return column === undefined ? [] : [{ field: column, dir: k.dir }]
			}),
			"page seek"
		)
		if (path !== undefined) {
			this.lookups.push({ path, binds: [] })
		}
	}

	/**
	 * The B-tree path of a seek of `base`: its `fixed` columns, those a value fixes and no span or vector holds, then the
	 * `ordered` columns with their directions, the fixed ones first in code point order, each taking the first ordered
	 * column's direction, so the exact reverse of an order is the exact reverse of the path, which one index serves
	 * forward and backward. Once the columns `determined` and the order so far contain a declared key the rest of the
	 * order breaks no tie, so the index stops there (`(account, priority DESC, id)`). None where the determined columns
	 * hold a key already, the order reaches a vector column, or no ordered column is stored.
	 */
	seekPath(
		base: NodeOf<"Base">,
		fixed: ReadonlyArray<string>,
		determined: ReadonlySet<string>,
		ordered: ReadonlyArray<AccessKey>,
		use: AccessUse
	): AccessPath | undefined {
		const heading = base.heading
		if (this.keyWithin(base, determined) !== undefined) {
			return undefined
		}
		const prefix = sorted(
			fixed.filter((c) => !isSpanColumn(heading, c) && !isVectorColumn(heading, c))
		)
		const seen = new Set(prefix)
		const held = new Set(determined)
		const keys: Array<AccessKey> = []
		for (const k of ordered) {
			if (seen.has(k.field)) {
				continue
			}
			if (isVectorColumn(heading, k.field)) {
				return undefined
			}
			seen.add(k.field)
			held.add(k.field)
			keys.push(k)
			if (this.keyWithin(base, held) !== undefined) {
				break
			}
		}
		if (!isNonEmpty(keys)) {
			return undefined
		}
		const [lead] = keys
		return {
			relation: base.relation,
			derived: base.relationKind === "derived",
			method: "btree",
			keys: [...prefix.map((field): AccessKey => ({ field, dir: lead.dir })), ...keys],
			fixed: prefix.length,
			use
		}
	}

	/**
	 * The GIN path of each match a filter's conjunction holds of a stored search document and a query's text the
	 * statement fixes, a parameter's or a literal's (registry.ts textSearchOf): tsvector's default GIN class finds the
	 * documents a query matches, reading those rows alone. A match under a disjunction or a negation, or of a document no
	 * stored column holds, asks nothing of an index.
	 */
	textSearch(input: RelNode, pred: ScalarExpr): void {
		for (const e of conjuncts(pred)) {
			if (e.kind !== "op") {
				continue
			}
			const fn = nativeOp(e.op)?.fn
			if (fn !== "websearchMatches" && fn !== "plainMatches") {
				continue
			}
			const [document, query] = e.args.map((a) => operandOf(input.id, a))
			if (document?.kind !== "column" || (query?.kind !== "fixed" && query?.kind !== "literal")) {
				continue
			}
			for (const r of this.resolve(input, columnRequests([document.name]), nothing)) {
				for (const { resolved } of r.columns) {
					const field = storedColumn(resolved)
					if (
						field === undefined ||
						r.base.relationKind === "world" ||
						!isSearchColumn(r.base.heading, field)
					) {
						continue
					}
					this.lookups.push({
						path: {
							relation: r.base.relation,
							derived: r.base.relationKind === "derived",
							method: "gin",
							keys: [{ field, dir: "asc" }],
							fixed: 0,
							use: "text search"
						},
						binds: []
					})
				}
			}
		}
	}

	/**
	 * The GiST path of each network containment a filter's conjunction holds (registry.ts netContainment, `<<=`, `<<`
	 * and `&&`) of a stored inet or cidr column and a value the probe knows: a parameter's, a literal's, an outer
	 * value's, or a join partner's column, a context's address among them. inet's GiST class, inet_ops, PostgreSQL 19's
	 * default for inet and cidr, serves every one of the three on either side, so the probe reads the rows whose
	 * networks contain or lie within the value and no other row. A containment under a disjunction or a negation, a side
	 * computed from the row, or a column no stored table holds asks nothing of an index.
	 */
	netContainment(input: RelNode, pred: ScalarExpr): void {
		for (const e of conjuncts(pred)) {
			if (e.kind !== "op") {
				continue
			}
			const fn = nativeOp(e.op)?.fn
			if (fn !== "netWithin" && fn !== "netStrictlyWithin" && fn !== "netOverlaps") {
				continue
			}
			const [x, y] = e.args.map((a) => operandOf(input.id, a))
			for (const [side, other] of [
				[x, y],
				[y, x]
			] as const) {
				if (side?.kind !== "column" || other === undefined || other.kind === "computed") {
					continue
				}
				for (const r of this.resolve(input, columnRequests([side.name]), nothing)) {
					for (const { resolved } of r.columns) {
						const field = storedColumn(resolved)
						if (
							field === undefined ||
							r.base.relationKind === "world" ||
							!isNetColumn(r.base.heading, field)
						) {
							continue
						}
						this.lookups.push({
							path: {
								relation: r.base.relation,
								derived: r.base.relationKind === "derived",
								method: "gist",
								keys: [{ field, dir: "asc" }],
								fixed: 0,
								use: "network containment"
							},
							binds: []
						})
					}
				}
			}
		}
	}

	/** The HNSW path of an approximate retrieval whose score is the cosine distance of a stored vector column and a
	 * fixed vector. */
	nearest(n: RelNode, score: string): void {
		if (n.kind !== "ProjectSet") {
			return
		}
		const e = n.out.find((o) => o.name === score)?.expr
		if (e?.kind !== "op" || nativeOp(e.op)?.fn !== "cosineDistance") {
			return
		}
		const operands = e.args.map((a) => operandOf(n.input.id, a))
		/** The stored column operand and the other one. */
		const at = firstIndex(operands, (o) => o.kind === "column")
		const column = at === undefined ? undefined : operands[at]
		const other = at === undefined ? undefined : operands[1 - at]
		if (column?.kind !== "column" || other?.kind !== "fixed") {
			return
		}
		for (const r of this.resolve(n.input, columnRequests([column.name]), nothing)) {
			for (const { resolved } of r.columns) {
				const field = storedColumn(resolved)
				if (
					field === undefined ||
					r.base.relationKind === "world" ||
					!isVectorColumn(r.base.heading, field)
				) {
					continue
				}
				this.lookups.push({
					path: {
						relation: r.base.relation,
						derived: r.base.relationKind === "derived",
						method: "hnsw",
						keys: [{ field, dir: "asc" }],
						fixed: 0,
						use: "approximate vector retrieval"
					},
					binds: []
				})
			}
		}
	}
}

/** The access paths a program's IR justifies, from its roots: the index requests one program's checked
 * IR justifies, a query's filters in their Allen normal form (`allenNormalDag`), under the fixed form policy below.
 *
 * The walk visits every node reachable from the program's roots once per distinct set of facts its consumers fix about
 * its heading ("pushed" facts), so the work is linear in the nodes times the probe contexts; it never enumerates column
 * subsets or permutations. Pushed facts are
 * equalities with fixed values (parameters and outer values) or literals, ranges and span predicates against fixed
 * values, and pair relations between two of the node's columns, which a match region turns into join conditions. They
 * pass through a Filter, which adds its predicate's atoms (`predicateAtoms`), and through a projection by column reference;
 * they stop at a take, an approximate retrieval and a recursion, whose inputs PostgreSQL does not filter from outside.
 * A take's correlation, an attachment's correlation, the right side of a semi-join, anti-join, intersection or
 * difference, and a group's key columns pass what PostgreSQL can apply below them; a whole-read attachment's child,
 * derived once and hashed beside its parent keys, is passed nothing.
 *
 * In a match region every occurrence of a stored relation receives probe contexts (ProbeContext), each the columns one
 * probe binds: the base context, its own fixed equalities and ranges, and one context per join partner adding the
 * columns that partner fixes, each when it binds no span; and, when its own facts or a partner bind a span (a span
 * predicate, or a span column fixed by equality), the one span context of every column its fixed values and all its
 * partners bind together. A partner of at most one row per evaluation, by its source's logical cardinality (a context,
 * a write filter's row, a closed relation of one fact, a take of one), fixes its columns as a parameter does: what it
 * fixes joins the base context and every other, and it has no context of its own, so a write filter that reads a
 * relation at its row's values and at a claim, or at its row's values and at another relation's, requests one index of
 * both. A span predicate is requested only with every scalar something
 * binds beside it: a GiST index is read through its first column (`planIndexes`), and a context per partner asked for a
 * span predicate on `during` alone where another partner binds `subscription`, an index no plan reads. An occurrence
 * has no base context when a partner reaches it by its key and that partner drives through its own key (`drivesByKey`:
 * its own facts bind a key, or a span key's scalars and span): the region then has a plan through key indexes alone,
 * that partner first, and an index on the occurrence's own facts would serve only the other order, which PostgreSQL
 * takes only where the data favors it. The platform's rollupVersusLive asked DailySpend(workspace) beside Day's window,
 * which Day's span key serves; PostgreSQL read it at 100,000 usage events and in no drawn read at a million. The fixed
 * form policy turns each context into at most one path family:
 *
 * - a context whose equalities, literal ones included, contain a declared key is a key lookup on that key, which the
 *   key's own index serves: no index is drafted for lookups the primary keys already serve;
 * - otherwise, a span context: one GiST index per span field, the scalar equality columns first through btree_gist,
 *   then the span, and the GiST index subsumes the scalar prefix, so no B-tree is added;
 * - otherwise, with a range: a B-tree on the equality columns then one range column, the one bounded on both sides
 *   first and then by code point, unless every one of them is a handle column (below); a text column bounded on both
 *   sides is a prefix search;
 * - otherwise a B-tree on the equality columns.
 *
 * Equality columns are those equal to a parameter, an outer value, a join partner's column or a literal, in code point
 * order, so an index's name never depends on declaration or predicate order. A literal equality selects its column as
 * a parameter's does: a world entry's filter that fixes a column of another relation to a literal runs at every write
 * and must read that relation by an index, which a plain B-tree on the column serves; the policy builds no partial and
 * no expression access index, because a partial index needs the compiler and the query to agree on its predicate. An
 * equality path whose columns are all handle columns is none, so a low-cardinality handle column is never indexed
 * merely because a program names a handle: a roster of a few handles splits the rows into a few large groups, which
 * PostgreSQL reads by a scan, never by such an index. A vector column is never a B-tree column; it is reached only by
 * HNSW. Ordered paths come from a take (`take seek`) and a workload program whose root is an ordered result,
 * which reader.page can page (`page seek`): the equality columns of the occurrence that holds every column of the
 * completed order, then that order with its directions, when no other occurrence carries a fixed restriction that would
 * drive the plan instead: an index of its equality-filter fields followed by its completed order. An equality column
 * is fixed within the seek, so its direction is free; it takes the order's first key's direction, so the exact reverse
 * of an order is the exact reverse of its path, which one index serves forward and backward. An attachment's delivery order and a read-back's order are no seek: without a bound
 * every child row is read anyway, so only the correlation's equality path is requested. ApproximateNearest over a
 * cosine distance of a stored vector column and a fixed vector requests HNSW with the cosine operator class. */
export const extractAccess = (
	roots: ReadonlyArray<RelNode>,
	options: ExtractOptions
): ProgramAccess => {
	const x = extracted(roots, options)
	return { paths: uniquePaths(x.lookups.map((l) => l.path)) }
}

/** The walk of `roots` (see `extractAccess`). */
const extracted = (roots: ReadonlyArray<RelNode>, options: ExtractOptions): Extractor => {
	const x = new Extractor(options, roots, postorder<RelNode>(roots, inputsOf))
	for (const root of roots) {
		x.visit(root, nothing)
	}
	return x
}
