import { isNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { canonicalEquals } from "#compiler/core/canonical.ts"
import type { NodeId, OccurrenceId, VarId } from "#compiler/core/ids.ts"
import type { Certificate } from "#compiler/ir/certificate.ts"
import {
	type ExistenceConstraint,
	type Grounds,
	type Premise,
	strongest,
	type TemplateContext
} from "#compiler/ir/evidence.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import {
	type CompletedOrder,
	type KeySet,
	type NodeOf,
	type Occurrence,
	type RelNode,
	regionVarClasses,
	type VarDecl
} from "#compiler/ir/rel.ts"
import { conjuncts } from "#compiler/logical/props.ts"
import {
	type ChainStep,
	keyedRegionChain,
	valueFixings
} from "#compiler/lower/optimize/cte-policy/index.ts"
import { boundThrough, exactlyOne } from "#compiler/lower/optimize/eliminate/index.ts"
import { noPagedReads, type PagedRead } from "#compiler/lower/shapes/share/keys.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"

/**
 * A page's window driver: the stored relation a window is a keyset take of, the rest of its rows read per window row at
 * the driver's key.
 *
 * A window is a take: the first `size` rows of the page's rows D in the page's completed order O, strictly past an
 * anchor (a seek) or past a count of rows (an offset), W = take_k^O(σ_seek(D)). Lowered as it stands, D is a join under
 * ORDER BY O LIMIT k, and which rows PostgreSQL reads to answer it is its estimate's: a generic plan estimates LIMIT
 * $size at a tenth of D, where a hash join of every relation and a sort of every row cost less than a nested loop, so a
 * window of 50 rows read every sitting's status, assignment and test (metis's coach dashboard, 256k pages a call).
 *
 * Rule: let R be a stored occurrence of D's region (the driver), K its key, and read the region along the chain from the
 * call's values (cte-policy keyedRegionChain over P, each step bound on a declared key's prefix by the values the call fixes and
 * the steps before it): A, the occurrences exactly one per row of R; G, its guards; P, the rest, which the chain reads
 * before R, binding R's classes c̄; F_R, the call's values of R's columns (its points); and S = π_c̄(σ_F(⋈P)) × F_R, the
 * rows of the prefix (F_R's columns, then c̄) the call reads: F_R's one row where P is empty. Where
 *
 * - (i) every occurrence of A is exactly one per row of R: reached from R by a chain, each step a containment from an
 *   occurrence already reached onto the step's fields (at least one row, R03.elimination's existence) among which lies
 *   a key of the step's relation (at most one), the step binding no other variable already bound and no constant but
 *   one restating F_R (eliminate/index.ts exactlyOne, boundThrough); every occurrence of G binds no variable another
 *   occurrence binds or D's heading reads, of statement values alone, as a context or a permitted program matched at a
 *   constant (`guards`);
 * - (ii) what the driver may be filtered by: every class P binds is R's, fixed by the call, or bound by no step of A
 *   and read by no column of D's heading, and the chain from the call reads every step of P (`valueChain`); every
 *   filter of D fixes a class of R or of P to a statement value, compares the order's first column the prefix leaves
 *   free to one (at most once from below and once from above: the interval I, `intervalOf`), or reads statement values
 *   alone; every existence test D passes through tests columns only a guard binds (the signed-in operator's permission,
 *   read at the claims' key);
 * - (iii) every column of O, and so of every seek, is one of R's variables or fixed by F_R;
 * - (iv) D's heading holds R's key, each of its columns projected or fixed by F_R;
 *
 * then W = D ⋉_K merge_k^O { take_k^O(σ_{prefix = s ∧ c ∈ I ∧ seek}(R)) : s ∈ S }: each part a take of R alone at one
 * row of S, the parts' rows merged in O and cut at k, and D read at each kept row's key.
 *
 * Proof: S reads no row of R: P's chain reads the call's values and its own relations, and binds R's classes only as
 * the values it gives them. By (ii) every class P binds beside R's and the call's is one no step of A binds and D's
 * heading never reads, so a set of D's columns holds the same rows over R ⋈ P ⋈ A ⋈ G as over (R ⋉ S) ⋈ A ⋈ G: P's
 * several rows beside one row of R differ only in columns D drops, and A's match reads none of them. By (i), extending
 * each row r of σ_{c̄ ∈ S}(R) by its one match in each occurrence of A, in the chain's order, is a map e onto those rows
 * that keeps r's columns, total (each step has a match) and injective (it keeps r). The filters keep exactly e(σ_{F_R ∧
 * c ∈ I}(R ⋉ S)): a fixing or a comparison of R's column reads r's columns alone, which e keeps, and a fixing of P's
 * class is S's; an existence test whose columns only a guard binds reads no row of R: it holds for every row or for
 * none, σ_G the identity or empty, the same for every row. By (iv) D's projection keeps R's key, so it is injective on
 * e's image: h = π ∘ e is a bijection from the driver's rows σ = σ_{prefix ∈ S ∧ c ∈ I}(R) onto D (or onto nothing,
 * where a guard fails). By (iii) O and the seek read R's columns alone, so h keeps the order and the seek: O(h(r)) =
 * O(r), and O, total over D (the page's completion), is total over σ. The parts σ_s = σ_{prefix = s ∧ c ∈ I}(R), one per
 * row s of S, are disjoint, two rows of S differing in a prefix column, and their union is σ; the first k rows of a
 * disjoint union in O lie among the first k of each part, so the first k of the parts' first k rows, merged in O, are
 * σ's first k, and past a seek, which reads O's columns alone, the same holds of each part past it. Past an offset o,
 * σ's rows from o + 1 to o + k lie among each part's first o + k, so the merge's rows past o are σ's. The first k rows
 * of an order-preserving bijection's image are the image of the first k rows: take_k^O(σ_seek(D)) =
 * h(take_k^O(σ_seek(σ))), and h(T) = D ⋉_K T since h keeps K. Each condition is needed: a join of several rows per
 * driver row (no key) repeats a driver row past the limit; one of none (no containment) drops a driver row after the
 * limit, which then answers fewer rows than the window holds; a class of P that D's heading reads repeats a row once for
 * each of P's rows, and one a step of A binds makes A's match hang on P's row; a filter of A's column drops rows after
 * the limit; an order column outside R orders the take otherwise than D; a projection dropping K merges rows; a part
 * cut at k without the merge's order delivers another part's rows first.
 *
 * Where it holds the window reads each part by an index on the prefix's columns then O (physical/access/extract.ts, the
 * page seek resolved to the driver: the first instance of extracting exactly the seek the lowering prints), I bounding
 * that index's scan on O's first free column, at most k rows past the anchor in each part (o + k past an offset), and D
 * at each of the k it keeps, a few key probes a row: S's chain's rows, which its steps' ranks bound (a key's one row, a
 * unit's rows, a prefix's: the users of an email), then |S| × (a descent and k + 1 entries), then k × (the facts a row
 * reads), whatever the table holds beside them. Two costs bound which ordered index is asked for:
 *
 * - the prefix's columns determining R's unit (`unitBound`: a learner's own rows) ask none: the hot-path write of a
 *   status pays no index insertion for it. Where an index the access already builds holds the prefix's columns then the
 *   order (the unit-led primary key, or another access index), the take seeks it, at no added write cost; elsewhere it
 *   reads the unit's rows by the key's prefix and sorts them, O(unit) rows, bounded and independent of the population
 *   (metis's student search, a learner's eight sittings; main's ruling);
 * - any other prefix asks an index of its columns then O: O(k) rows read against O(N / selectivity) for a status tab
 *   whose status is rare, for one index insertion on each write of R (metis's status tabs, (status, number DESC); a
 *   student's entries by their email, (tab, user, the tab's order); den's queue, (kind, available, step), its interval
 *   available ≤ now).
 *
 * Where a condition fails, or D is no region under projections, filters, guards and attachments (a union's heading
 * groups, a fold, a take), the window stands as it is (rows.ts pagedRows over D).
 */

/** What the rule reads of the evidence: each stored relation's key among given fields, and the proved containments. */
export interface DriverFacts {
	/** The context the template is compiled for, in which a containment's evidence must hold. */
	readonly context: TemplateContext
	/** The installed containments, declared and drawn by a stored derived relation's definition (ir/evidence.ts). */
	readonly containments: ReadonlyArray<ExistenceConstraint>
	/** The fields of an ordinary relation's primary key that hold its unit's key; none for a relation of no unit. */
	readonly unitOf: (relation: string) => ReadonlyArray<string>
	/** The key of `base`'s relation among `fields`, with what it rests on; none where no key lies among them. */
	readonly keyAmong: (
		base: NodeOf<"Base">,
		fields: ReadonlyArray<string>
	) => { readonly columns: KeySet; readonly grounds: Grounds } | undefined
}

/** A column of the page's rows the window reads of its driver: its name in D's heading, and the driver's column. */
export interface DriverColumn {
	readonly heading: string
	readonly column: string
}

/**
 * S (see the header): the values of the driver's prefix columns each part of the window is read at. `points`, F_R, each
 * column a statement value fixes; `steps`, the chain from the call's values over `region`'s occurrences that reads the
 * rest (P, cte-policy ChainStep, each step keyed), none where the points fix the whole prefix, S then their one row;
 * `read`, c̄, each column the chain's rows give a value, with a variable of P binding its class, which the chain's read
 * projects: as many as P binds of the driver's classes the call leaves free, one at least where `steps` holds any;
 * `restriction`, each class of P the call fixes, by a variable of `region` binding it, at its value, where the chain
 * starts and which its read holds (a filter's value over the region: an email's users).
 */
export interface DriverValues {
	readonly region: NodeOf<"MatchRegion">
	readonly points: ReadonlyArray<{ readonly column: string; readonly value: ScalarExpr }>
	readonly steps: ReadonlyArray<ChainStep>
	readonly read: ReadonlyArray<{ readonly column: string; readonly var: VarDecl }>
	readonly restriction: ReadonlyArray<{ readonly column: string; readonly value: ScalarExpr }>
}

/**
 * An end of a window's interval: open, or the filter's `comparison` of the driver column `column`, the order's first
 * the prefix leaves free, which the take reads at the driver's column, the filter's own operator, so its rows are the
 * filter's.
 */
export type IntervalEnd =
	| { readonly kind: "open" }
	| { readonly kind: "at"; readonly column: string; readonly comparison: ColumnTest }

/** The interval a window's comparisons state of the driver's first free order column; open where none does. */
export interface DriverInterval {
	readonly lower: IntervalEnd
	readonly upper: IntervalEnd
}

/** A window's driver (see the header). */
export interface WindowDriver {
	/** D: the rows the window reads at each of its driver rows' keys, the node every attachment of the page reads. */
	readonly rows: RelNode
	/** The node over D, its lowest attachment or the ordered result, which reads D per window row (keys.ts PagedRead). */
	readonly reader: RelNode
	readonly base: NodeOf<"Base">
	readonly occurrence: OccurrenceId
	/** The driver's columns the take reads, by D's heading names: its key's that F_R leaves free, and the order's. */
	readonly columns: NonEmptyReadonlyArray<DriverColumn>
	/** D's heading columns D is read at for each window row: the driver's key's columns F_R leaves free. */
	readonly key: ReadonlyArray<string>
	/** The driver's columns each part of the window fixes, in its index's order: the points', then the value set's. */
	readonly prefix: ReadonlyArray<string>
	/** S, the rows of the prefix's columns the call reads (see the header). */
	readonly values: DriverValues
	/** The interval of the order's first column the prefix leaves free that the window's filters state. */
	readonly interval: DriverInterval
	/** Whether the prefix's columns determine the driver's unit (`unitBound`, the header), which asks no ordered index. */
	readonly unitBound: boolean
	/** The keys and containments the proof rests on, in the context they hold in. */
	readonly grounds: Grounds
}

/** A column of a node on the spine as its region reads it: one of the region's heading columns, or a statement value. */
type Column = { readonly kind: "region"; readonly name: string } | { readonly kind: "value" }

/**
 * A comparison of one column of a filter's input to a statement value (`comparison`, a conjunct of the filter
 * reading the input's column `read.column` alone), the end of an interval of it it states (`bound`), `column` the
 * region's column that input column holds.
 */
interface ColumnRange {
	readonly column: string
	readonly bound: "lower" | "upper"
	readonly comparison: ColumnTest
}

/** A conjunct of a filter that reads one column of the filter's input (`node`, `column`) and statement values alone. */
export interface ColumnTest {
	readonly expr: ScalarExpr
	readonly node: NodeId
	readonly column: string
}

/**
 * The region D reads, each column of a node on the spine as the region reads it, the filters' fixings and comparisons
 * of the region's columns to statement values, and the region's columns an existence test D passes through tests.
 */
interface Spine {
	readonly region: NodeOf<"MatchRegion">
	readonly column: (name: string) => Column | undefined
	readonly fixings: ReadonlyArray<{ readonly column: string; readonly value: ScalarExpr }>
	readonly ranges: ReadonlyArray<ColumnRange>
	readonly tested: ReadonlyArray<string>
}

/** Whether an expression is a statement value: it reads no relation. */
const statementValue = (e: ScalarExpr): boolean => e.deps.nodes.length === 0

/** The end a comparison's function states of its left operand: `<` and `<=` an upper end, `>` and `>=` a lower one. */
const comparisonEnds: ReadonlyMap<string, "lower" | "upper"> = new Map([
	["lt", "upper"],
	["le", "upper"],
	["gt", "lower"],
	["ge", "lower"]
] as const)

/** The opposite end, the comparison read with its operands swapped: `v < c` states `c > v`. */
const swapped = (bound: "lower" | "upper"): "lower" | "upper" =>
	bound === "lower" ? "upper" : "lower"

/**
 * The comparisons of `filter`'s conjuncts of one of its input's columns to a statement value, each as the end of an
 * interval of the column it states, whichever side the column stands on.
 */
const valueRanges = (filter: NodeOf<"Filter">): ReadonlyArray<ColumnRange> =>
	conjuncts(filter.pred).flatMap((e): ReadonlyArray<ColumnRange> => {
		const fn = e.kind === "op" ? nativeOp(e.op)?.fn : undefined
		const end = fn === undefined ? undefined : comparisonEnds.get(fn)
		const [x, y, ...more] = e.kind === "op" ? e.args : []
		if (end === undefined || x === undefined || y === undefined || more.length > 0) {
			return []
		}
		const columnAt = (column: ScalarExpr, value: ScalarExpr, bound: "lower" | "upper") =>
			column.kind === "column" && column.column.node === filter.input.id && statementValue(value)
				? [
						{
							column: column.column.name,
							bound,
							comparison: { expr: e, node: filter.input.id, column: column.column.name }
						}
					]
				: []
		return [...columnAt(x, y, end), ...columnAt(y, x, swapped(end))]
	})

/** The region's heading column a spine column names, none for a value or a column it does not read. */
const regionColumn = (spine: Spine, name: string): string | undefined => {
	const at = spine.column(name)
	return at?.kind === "region" ? at.name : undefined
}

/**
 * The spine from `node` down to its region (see the header): its attachments' parents, projections by column or by
 * value, filters each conjunct of which fixes a column to a statement value or reads statement values alone, and
 * existence tests, their left sides kept; none where another node stands between, a filter fixes a column the region
 * does not read, or a test tests one.
 */
const spineOf = (node: RelNode): Spine | undefined => {
	switch (node.kind) {
		case "Attach":
			return spineOf(node.parent)
		case "ProjectSet": {
			const below = spineOf(node.input)
			if (below === undefined) {
				return undefined
			}
			const out = new Map(node.out.map((o) => [o.name, o.expr] as const))
			return {
				...below,
				column: (name) => {
					const e = out.get(name)
					if (e === undefined) {
						return undefined
					}
					if (e.kind === "column" && e.column.node === node.input.id) {
						return below.column(e.column.name)
					}
					return statementValue(e) ? { kind: "value" } : undefined
				}
			}
		}
		case "Filter": {
			const below = spineOf(node.input)
			const fixings = valueFixings(node)
			const ranges = valueRanges(node)
			/**
			 * Each conjunct fixes one column, compares one to a statement value, or reads statement values alone
			 * (cte-policy valueFixings, valueRanges).
			 */
			const plain =
				conjuncts(node.pred).filter((e) => !statementValue(e)).length ===
				fixings.length + ranges.length
			if (below === undefined || !plain) {
				return undefined
			}
			const mapped = fixings.flatMap((f) => {
				const column = regionColumn(below, f.column)
				return column === undefined ? [] : [{ column, value: f.value }]
			})
			const compared = ranges.flatMap((r) => {
				const column = regionColumn(below, r.column)
				return column === undefined ? [] : [{ ...r, column }]
			})
			return mapped.length === fixings.length && compared.length === ranges.length
				? {
						...below,
						fixings: [...below.fixings, ...mapped],
						ranges: [...below.ranges, ...compared]
					}
				: undefined
		}
		case "SemiJoin":
		case "AntiJoin": {
			const below = spineOf(node.left)
			if (below === undefined) {
				return undefined
			}
			const tested = node.on.flatMap((p) => {
				const column = regionColumn(below, p.left)
				return column === undefined ? [] : [column]
			})
			return tested.length === node.on.length
				? { ...below, tested: [...below.tested, ...tested] }
				: undefined
		}
		case "MatchRegion": {
			if (node.correlated.length > 0) {
				return undefined
			}
			const heading = new Set(node.heading.map((c) => c.name))
			return {
				region: node,
				column: (name) => (heading.has(name) ? { kind: "region", name } : undefined),
				fixings: [],
				ranges: [],
				tested: []
			}
		}
		case "Base":
		case "Closed":
		case "Context":
		case "InputSet":
		case "Delta":
		case "Step":
		case "Take":
		case "Group":
		case "Union":
		case "Intersect":
		case "Difference":
		case "Produce":
		case "Recursive":
		case "SelfRef":
		case "ApproximateNearest":
		case "Call":
		case "OrderedResult":
		case "Forbid":
		case "Window":
		case "OrderedSetAggregate":
			return undefined
	}
}

/** The heading name of a region's variable class, through the variable its heading column holds. */
const classOfColumn = (
	region: NodeOf<"MatchRegion">,
	classOf: (v: VarDecl) => VarId,
	column: string
): VarId | undefined => {
	const v = region.vars.find((x) => x.name === column)
	return v === undefined ? undefined : classOf(v)
}

/** The premises and context of several grounds together. */
const joined = (grounds: ReadonlyArray<Grounds>): Grounds => ({
	premises: grounds.flatMap((g): ReadonlyArray<Premise> => g.premises),
	context: strongest(grounds.map((g) => g.context))
})

/** Whether two statement values are one: one parameter, or equal literals. */
const sameValue = (a: ScalarExpr, b: ScalarExpr): boolean =>
	a.id === b.id ||
	(a.kind === "param" && b.kind === "param" && a.param === b.param) ||
	(a.kind === "literal" && b.kind === "literal" && canonicalEquals(a.value, b.value))

/** Whether occurrence `o`'s constant restates the value its column's class is fixed to. */
const restates = (
	o: Occurrence,
	constant: Occurrence["constants"][number],
	classOf: (v: VarDecl) => VarId,
	fixedValue: ReadonlyMap<VarId, ScalarExpr>
): boolean => {
	const binding = o.bindings.find((b) => b.column === constant.column)
	const fixed = binding === undefined ? undefined : fixedValue.get(classOf(binding.var))
	return fixed !== undefined && sameValue(fixed, constant.expr)
}

/**
 * The occurrences of `region` other than `driver` and its guards that are exactly one per row of the driver (rule (i)),
 * A, each reached by a step from the driver or an occurrence reached before it, with the grounds of each step. A constant
 * of a step restates the value F_R fixes its column's class to (`restates`), as a parameter's propagation states it at
 * every occurrence of the class: it filters nothing the driver's row has not. An occurrence no step reaches is left to
 * the value set's chain (P, `valueChain`), which holds it to rule (ii).
 */
const chainFrom = (
	region: NodeOf<"MatchRegion">,
	driver: Occurrence,
	classOf: (v: VarDecl) => VarId,
	fixedValue: ReadonlyMap<VarId, ScalarExpr>,
	guard: ReadonlySet<Occurrence>,
	facts: DriverFacts
): { readonly reached: ReadonlyArray<Occurrence>; readonly steps: ReadonlyArray<Grounds> } => {
	const bound = new Set(driver.bindings.map((b) => classOf(b.var)))
	const reached: Array<Occurrence> = [driver]
	const steps: Array<Grounds> = []
	const sameClass = (a: VarDecl, b: VarDecl) => classOf(a) === classOf(b)
	const pending = new Set(
		region.occurrences.filter(
			(o) =>
				o !== driver &&
				!guard.has(o) &&
				o.source.kind === "Base" &&
				o.constants.every((c) => restates(o, c, classOf, fixedValue))
		)
	)
	for (let progressed = true; progressed && pending.size > 0;) {
		progressed = false
		for (const o of pending) {
			const source = o.source
			if (source.kind !== "Base") {
				continue
			}
			const step = reached
				.flatMap((t) => {
					const ts = t.source
					return ts.kind !== "Base"
						? []
						: facts.containments.flatMap((c) => {
								if (
									c.from.relation !== ts.relation ||
									c.to.relation !== source.relation ||
									!boundThrough(c, o, t, sameClass) ||
									o.bindings.some(
										(b) => bound.has(classOf(b.var)) && !c.to.fields.includes(b.column)
									)
								) {
									return []
								}
								const one = exactlyOne(c, facts.keyAmong(source, c.to.fields), facts.context)
								return one === undefined ? [] : [joined([one.key.grounds, one.existence])]
							})
				})
				.at(0)
			if (step === undefined) {
				continue
			}
			steps.push(step)
			reached.push(o)
			pending.delete(o)
			for (const b of o.bindings) {
				bound.add(classOf(b.var))
			}
			progressed = true
		}
	}
	return { reached: reached.slice(1), steps }
}

/**
 * Whether occurrence `o` of `region` is a guard: no variable it binds is bound by another occurrence or read by D's
 * heading (`headed`), and each of its constants is a statement value. The region's rows are then its other occurrences'
 * rows beside each of its own, and D, a set of columns it binds none of, holds every row of them or none, the same for
 * every driver row (rule (ii)): a context, the claims' Clerk user; an operator's permitted program, matched at a
 * constant.
 */
const guards = (
	region: NodeOf<"MatchRegion">,
	o: Occurrence,
	classOf: (v: VarDecl) => VarId,
	headed: ReadonlySet<VarId>
): boolean =>
	o.constants.every((c) => statementValue(c.expr)) &&
	o.bindings.every((b) => {
		const k = classOf(b.var)
		return (
			!headed.has(k) &&
			region.occurrences.every((x) => x === o || x.bindings.every((y) => classOf(y.var) !== k))
		)
	})

/**
 * The driver of a window over the ordered result `root` in `order` (see the header), the first occurrence of D's region
 * in occurrence order that meets the rule; none where no occurrence does or D is no region under its spine.
 */
export const windowDriver = (
	root: NodeOf<"OrderedResult">,
	order: CompletedOrder,
	facts: DriverFacts
): WindowDriver | undefined => {
	const { rows, reader } = rowsOf(root.input, root)
	const spine = spineOf(rows)
	if (spine === undefined) {
		return undefined
	}
	const { region } = spine
	const classOf = regionVarClasses(region)
	const classAt = (column: string) => classOfColumn(region, classOf, column)
	/** Each of D's columns as the region's class it reads, or a value. */
	const headingClass = new Map(
		rows.heading.flatMap((c): ReadonlyArray<readonly [string, VarId | "value"]> => {
			const at = spine.column(c.name)
			if (at === undefined) {
				return []
			}
			if (at.kind === "value") {
				return [[c.name, "value"] as const]
			}
			const k = classAt(at.name)
			return k === undefined ? [] : [[c.name, k] as const]
		})
	)
	/** The classes a filter fixes, with each value. */
	const filterFixed = new Map(
		spine.fixings.flatMap((f) => {
			const k = classAt(f.column)
			return k === undefined ? [] : [[k, f.value] as const]
		})
	)
	if (filterFixed.size !== spine.fixings.length) {
		return undefined
	}
	/** D's heading's classes, which no guard binds. */
	const headed = new Set([...headingClass.values()].flatMap((k) => (k === "value" ? [] : [k])))
	/** The region's guards (`guards`). */
	const guard = new Set(region.occurrences.filter((o) => guards(region, o, classOf, headed)))
	/** The classes a guard binds: statement values, which only an existence test may test (rule (ii)). */
	const guarded = new Set([...guard].flatMap((o) => o.bindings.map((b) => classOf(b.var))))
	if (
		!spine.tested.every((c) => {
			const k = classAt(c)
			return k !== undefined && guarded.has(k)
		})
	) {
		return undefined
	}
	/** The comparisons of the region's classes to statement values, each an end of an interval. */
	const ranges = spine.ranges.flatMap((r) => {
		const k = classAt(r.column)
		return k === undefined ? [] : [{ ...r, class: k }]
	})
	if (ranges.length !== spine.ranges.length) {
		return undefined
	}
	for (const o of region.occurrences) {
		const source = o.source
		if (source.kind !== "Base" || source.relationKind === "world") {
			continue
		}
		const driver = driverAt(
			region,
			o,
			source,
			classOf,
			order,
			headingClass,
			filterFixed,
			ranges,
			guard,
			facts
		)
		if (driver !== undefined) {
			return { ...driver, rows, reader }
		}
	}
	return undefined
}

/** D: the ordered result's rows under its attachments, which each attachment of the page reads, and the node over it. */
const rowsOf = (
	node: RelNode,
	over: RelNode
): { readonly rows: RelNode; readonly reader: RelNode } =>
	node.kind === "Attach" ? rowsOf(node.parent, node) : { rows: node, reader: over }

/** The window's driver at occurrence `o` of `source`, where it meets the rule (see the header). */
const driverAt = (
	region: NodeOf<"MatchRegion">,
	o: Occurrence,
	source: NodeOf<"Base">,
	classOf: (v: VarDecl) => VarId,
	order: CompletedOrder,
	headingClass: ReadonlyMap<string, VarId | "value">,
	filterFixed: ReadonlyMap<VarId, ScalarExpr>,
	ranges: ReadonlyArray<ColumnRange & { readonly class: VarId }>,
	guard: ReadonlySet<Occurrence>,
	facts: DriverFacts
): Omit<WindowDriver, "rows" | "reader"> | undefined => {
	/** The driver's column of each class it binds; a class it binds twice equates two of its columns, a filter. */
	const columnOf = new Map<VarId, string>()
	for (const b of o.bindings) {
		const k = classOf(b.var)
		if (columnOf.has(k)) {
			return undefined
		}
		columnOf.set(k, b.column)
	}
	if (!o.constants.every((c) => statementValue(c.expr))) {
		return undefined
	}
	/** Each class the call fixes, with its value: a filter's fixing, or a constant of the driver's. */
	const fixedValue = new Map(filterFixed)
	for (const c of o.constants) {
		const binding = o.bindings.find((b) => b.column === c.column)
		if (binding !== undefined && !fixedValue.has(classOf(binding.var))) {
			fixedValue.set(classOf(binding.var), c.expr)
		}
	}
	/** F_R: each of the driver's columns the call fixes, with its value. */
	const points = [
		...[...fixedValue].flatMap(([k, value]) => {
			const column = columnOf.get(k)
			return column === undefined ? [] : [{ column, value }]
		}),
		...o.constants
			.filter((c) => !o.bindings.some((b) => b.column === c.column))
			.map((c) => ({ column: c.column, value: c.expr }))
	]
	const pointColumns = new Set(points.map((f) => f.column))
	const after = chainFrom(region, o, classOf, fixedValue, guard, facts)
	const values = valueChain(region, o, after.reached, guard, classOf, columnOf, fixedValue)
	if (values === undefined) {
		return undefined
	}
	/** Rule (ii): each class a filter fixes is the driver's, or a class the value set's chain reads from the call. */
	const chained = new Set(
		values.steps.flatMap((step) => step.occurrence.bindings.map((b) => classOf(b.var)))
	)
	if (![...filterFixed.keys()].every((k) => columnOf.has(k) || chained.has(k))) {
		return undefined
	}
	const prefix = [...pointColumns, ...values.read.map((r) => r.column)]
	/** D's heading column holding each of the driver's columns, a value's none. */
	const headingOf = (column: string): string | undefined => {
		const k = o.bindings.find((b) => b.column === column)
		if (k === undefined) {
			return undefined
		}
		const at = classOf(k.var)
		return [...headingClass].find(([, c]) => c === at)?.[0]
	}
	/**
	 * Rule (iii): each order column is one of the driver's, which the take orders by: a column D's projection holds at a
	 * value orders nothing a driver row tells apart, and the take holds none, so such an order is no driver's.
	 */
	const ordered: Array<DriverColumn> = []
	for (const key of order.keys) {
		const at = headingClass.get(key.column)
		if (at === undefined || at === "value") {
			return undefined
		}
		const column = columnOf.get(at)
		if (column === undefined) {
			return undefined
		}
		ordered.push({ heading: key.column, column })
	}
	const interval = intervalOf(
		ranges,
		ordered.find((c) => !prefix.includes(c.column)),
		columnOf
	)
	if (interval === undefined) {
		return undefined
	}
	/** Rule (iv): a key of the driver among the columns D's heading holds or F_R fixes. */
	const held = source.heading.flatMap((c) =>
		pointColumns.has(c.name) || headingOf(c.name) !== undefined ? [c.name] : []
	)
	const key = facts.keyAmong(source, held)
	if (key === undefined) {
		return undefined
	}
	const free = key.columns.flatMap((c) => {
		const heading = pointColumns.has(c) ? undefined : headingOf(c)
		return heading === undefined ? [] : [{ heading, column: c }]
	})
	if (free.length + key.columns.filter((c) => pointColumns.has(c)).length !== key.columns.length) {
		return undefined
	}
	const columns = [...ordered, ...free.filter((f) => !ordered.some((x) => x.heading === f.heading))]
	if (!isNonEmpty(columns)) {
		return undefined
	}
	return {
		base: source,
		occurrence: o.id,
		columns,
		key: free.map((f) => f.heading),
		prefix,
		values: { region, points, ...values },
		interval,
		unitBound: unitDetermined(source, new Set(prefix), facts),
		grounds: joined([key.grounds, ...after.steps])
	}
}

/**
 * P, the occurrences of `region` neither `driver`, a step of A (`after`, chainFrom) nor a guard, as the chain from the
 * call's values reads them (cte-policy keyedRegionChain), each step keyed; c̄, each class P binds that the driver binds
 * and the call does not fix, the driver's column of it with a variable of P that binds it; and the call's values of P's
 * classes, where its chain starts. None where P breaks rule (ii): a class it binds is neither the driver's nor fixed by
 * the call and a step of A binds it, so A's match would hang on P's row; no chain from the call reads P, whose rows
 * would then be read whole; or P binds none of the driver's classes the call leaves free, a guard of several
 * occurrences, which no program reads (main's ruling: no consumer, so none is built). A class of P that D's heading
 * reads needs no condition here: several rows of P beside one driver row would tell D's rows apart, so D's key holds it,
 * the page's completion orders by it, and rule (iii) refuses an order column no driver's.
 */
const valueChain = (
	region: NodeOf<"MatchRegion">,
	driver: Occurrence,
	after: ReadonlyArray<Occurrence>,
	guard: ReadonlySet<Occurrence>,
	classOf: (v: VarDecl) => VarId,
	columnOf: ReadonlyMap<VarId, string>,
	fixedValue: ReadonlyMap<VarId, ScalarExpr>
): Pick<DriverValues, "steps" | "read" | "restriction"> | undefined => {
	const before = region.occurrences.filter(
		(x) => x !== driver && !guard.has(x) && !after.includes(x)
	)
	if (!isNonEmpty(before)) {
		return { steps: [], read: [], restriction: [] }
	}
	const afterClasses = new Set(after.flatMap((x) => x.bindings.map((b) => classOf(b.var))))
	const kept = before.every((x) =>
		x.bindings.every((b) => {
			const k = classOf(b.var)
			return columnOf.has(k) || fixedValue.has(k) || !afterClasses.has(k)
		})
	)
	if (!kept) {
		return undefined
	}
	/** Each class of P the call fixes, at its value, by the first variable of P binding it. */
	const restriction = new Map<VarId, { readonly column: string; readonly value: ScalarExpr }>()
	for (const x of before) {
		for (const b of x.bindings) {
			const k = classOf(b.var)
			const value = fixedValue.get(k)
			if (value !== undefined && !restriction.has(k)) {
				restriction.set(k, { column: b.var.name, value })
			}
		}
	}
	const steps = keyedRegionChain(
		region,
		before,
		[...restriction.values()].map((r) => r.column)
	)
	if (steps === undefined) {
		return undefined
	}
	const read = new Map<VarId, { readonly column: string; readonly var: VarDecl }>()
	for (const x of before) {
		for (const b of x.bindings) {
			const k = classOf(b.var)
			const column = columnOf.get(k)
			if (column !== undefined && !fixedValue.has(k) && !read.has(k)) {
				read.set(k, { column, var: b.var })
			}
		}
	}
	return read.size > 0
		? { steps, read: [...read.values()], restriction: [...restriction.values()] }
		: undefined
}

/** An end the window's interval leaves open. */
const openEnd: IntervalEnd = { kind: "open" }

/**
 * The interval `ranges` state of the driver's column `first`, the order's first the prefix leaves free; both ends open
 * where none does. None where a comparison reads another column, which no index the take reads in order bounds (a
 * later order column's, any other's: the take would read past rows it drops), or two state one end, whose values no
 * statement compares.
 */
const intervalOf = (
	ranges: ReadonlyArray<ColumnRange & { readonly class: VarId }>,
	first: DriverColumn | undefined,
	columnOf: ReadonlyMap<VarId, string>
): DriverInterval | undefined => {
	if (!isNonEmpty(ranges)) {
		return { lower: openEnd, upper: openEnd }
	}
	if (first === undefined || !ranges.every((r) => columnOf.get(r.class) === first.column)) {
		return undefined
	}
	const lower = ranges.filter((r) => r.bound === "lower")
	const upper = ranges.filter((r) => r.bound === "upper")
	if (lower.length > 1 || upper.length > 1) {
		return undefined
	}
	const end = (r: ColumnRange | undefined): IntervalEnd =>
		r === undefined ? openEnd : { kind: "at", column: first.column, comparison: r.comparison }
	return { lower: end(lower[0]), upper: end(upper[0]) }
}

/**
 * Whether fixing `fixed` of `base` holds it at one unit's rows: an ordinary relation's unit key among them, or the
 * columns a stored derived relation's definition draws, by a containment, from the fields of a relation that hold that
 * relation's unit key (a status's learner, drawn from its assignment's).
 */
const unitDetermined = (
	base: NodeOf<"Base">,
	fixed: ReadonlySet<string>,
	facts: DriverFacts
): boolean => {
	const holds = (unit: ReadonlyArray<string>, at: (field: string) => string | undefined) =>
		unit.length > 0 &&
		unit.every((f) => {
			const column = at(f)
			return column !== undefined && fixed.has(column)
		})
	return base.relationKind === "relation"
		? holds(facts.unitOf(base.relation), (f) => f)
		: facts.containments.some(
				(c) =>
					c.from.relation === base.relation &&
					holds(facts.unitOf(c.to.relation), (f) => c.from.fields[c.to.fields.indexOf(f)])
			)
}

/** How a page's windows read its rows: as they stand (rows.ts pagedRows over D), or driven by a WindowDriver. */
export type PageWindow =
	| { readonly kind: "asItStands" }
	| { readonly kind: "driven"; readonly driver: WindowDriver }

/** A window that reads D as it stands: a read that is no page's, or a page no driver drives. */
export const asItStands: PageWindow = { kind: "asItStands" }

/** The rows a page's windows read per window row, which read no key set (keys.ts PagedRead): a driven window's D. */
export const pagedReads = (window: PageWindow): ReadonlyArray<PagedRead> =>
	window.kind === "driven"
		? [{ reader: window.driver.reader, rows: window.driver.rows, key: window.driver.key }]
		: noPagedReads

/**
 * The certificate of a driven window over the ordered result `root` (see the header): it reads D and its driver, and
 * keeps D's heading, on the keys and containments its proof rests on, in their context.
 */
export const driverCertificate = (
	root: NodeOf<"OrderedResult">,
	driver: WindowDriver
): Certificate<"page.driver"> => ({
	rule: "page.driver",
	inputs: [driver.rows.id, driver.base.id],
	outputs: [root.id],
	premises: driver.grounds.premises,
	context: driver.grounds.context,
	preservedHeading: driver.rows.heading.map((c) => c.name),
	equality: [],
	coercion: [],
	params: undefined
})
