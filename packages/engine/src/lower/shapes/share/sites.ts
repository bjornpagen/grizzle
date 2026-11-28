import { isNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import { type NodeOf, type Occurrence, regionVarClasses, type VarDecl } from "#compiler/ir/rel.ts"
import {
	type ChainStep,
	type CorrelatedSite,
	chainSteps,
	evaluatedPerRow,
	fixedVariables,
	heldSet,
	holdsFixedValue,
	keyedRegionChain,
	readsStored,
	rootChain
} from "#compiler/lower/optimize/cte-policy/index.ts"

/**
 * The row sites a row site's reads hold beneath it, each read per row of what drives it at that row's values, never
 * derived whole: the decisions the lowering makes where it reads them (lower/shapes/region keyedChain) and the key
 * analysis reads (keys.ts rowReads), each made once, here.
 */

/**
 * The variables a region's chain starts bound at (cte-policy keyedRegionChain): those a restriction holds the region at
 * (`restricted`), those its correlated sites' correlation fixes, and those it holds itself at a value fixed where it is
 * evaluated (cte-policy fixedVariables), a parameter or an outer row's column, wherever it stands: a region a statement
 * reads at its parameters is chained by its declared keys as a per-key read is, never ordered by PostgreSQL's
 * estimates, which led a child's fold with every attempt of the child where its statistics stated each attempt its own.
 */
export const chainBound = (
	region: NodeOf<"MatchRegion">,
	restricted: ReadonlyArray<string>,
	sites: ReadonlyArray<CorrelatedSite>
): ReadonlyArray<string> => [
	...new Set([
		...restricted,
		...(isNonEmpty(sites)
			? region.correlated.flatMap((c) => (c.expr.deps.nodes.length > 0 ? [c.var.name] : []))
			: []),
		...fixedVariables(region)
	])
]

/**
 * The steps a region read at `restricted`, its restriction's columns, beside its correlated sites is read along, each
 * with the columns its seek binds (cte-policy ChainStep `at`): the one decision the lowering reads the region by
 * (lower/shapes/region regionSelect), the key analysis finds its row sites by (`chainSites`, share/keys.ts rowReading)
 * and its access requests the paths of (physical/access extract.ts). Where something binds the chain's start (a column
 * `chainBound` holds, a correlated site, a value fixed where the region is evaluated, or a held set it reads, cte-policy
 * heldSet: a set the statement's values restrict, a carried share's, a statement CTE's or the call's own rows, which no
 * index reads), its keyed chain (cte-policy keyedRegionChain), each stored relation such a start binds on a declared-key
 * prefix read per row of it at those values, never joined to it by PostgreSQL's estimates, which may read the relation
 * whole beside it, none where an occurrence is never bound on one; where nothing binds the region, which is read whole,
 * the chain from its root (cte-policy rootChain), every other occurrence a seek of its key at the values of the rows
 * before it, none where no root stands. A root read whole beside a restriction it does not hold would read every row
 * the restriction leaves out: a region something binds starts nowhere else.
 */
export const regionChain = (
	region: NodeOf<"MatchRegion">,
	restricted: ReadonlyArray<string>,
	sites: ReadonlyArray<CorrelatedSite>
): ReadonlyArray<ChainStep> | undefined => {
	const bound = chainBound(region, restricted, sites)
	const started =
		isNonEmpty(bound) ||
		isNonEmpty(sites) ||
		holdsFixedValue(region) ||
		region.occurrences.some((o) => o.source.kind !== "Base" && heldSet(o.source))
	return started
		? keyedRegionChain(region, region.occurrences, bound)
		: rootChain(region, region.occurrences)
}

/** One column a row site is read at: its source's column, at the column `at` of `occurrence`, a step before it. */
export interface SiteColumn {
	readonly column: string
	readonly occurrence: Occurrence
	readonly at: string
}

/**
 * An occurrence a region's chain reads per row of the steps before it: at `columns`, each a column of a step before it,
 * and at `held`, each the region's variable a restriction holds the region at.
 */
export interface ChainSite {
	readonly occurrence: Occurrence
	readonly columns: ReadonlyArray<SiteColumn>
	readonly held: ReadonlyArray<{ readonly column: string; readonly variable: string }>
}

/**
 * The row sites of a region read at `restricted`, its restriction's columns, along `steps` (`regionChain`), the one
 * decision the lowering reads them by (lower/shapes/region regionSelect, each read at its row's values, never from a set
 * the statement computes once) and the key analysis reads them by (share/keys.ts rowReading, a read no key set serves):
 * each step after the chain's first whose source is no stored relation, no held set (cte-policy heldSet, read where it
 * stands), and reads one (cte-policy readsStored), a union, a fold or a view the statement would otherwise derive once,
 * whole, as its CTE, which the chain proves read at a declared-key prefix of what binds it (ChainStep `bound`): its
 * columns the steps before it bind, each at the column of the first step before it that binds its class, and those the
 * restriction holds. So each read seeks its stored relations at a prefix of one of their keys, per row of the steps
 * before it, a number of rows of the site's own: metis's myAssignments read its assignments' status, a union of five
 * rules over their events, at each assignment's number, where it derived the union whole for every learner and read it
 * at the number, 268k pages at 41,227 sittings.
 */
export const chainSites = (
	region: NodeOf<"MatchRegion">,
	steps: ReadonlyArray<ChainStep>,
	restricted: ReadonlyArray<string>
): ReadonlyArray<ChainSite> => {
	const classOf = regionVarClasses(region)
	const heldClasses = new Map(
		restricted.flatMap((c) =>
			region.vars.filter((v) => v.name === c).map((v) => [classOf(v), c] as const)
		)
	)
	/** Each class the steps so far bind, at the first step's column that binds it. */
	const binds = new Map<VarDecl["id"], { readonly occurrence: Occurrence; readonly at: string }>()
	const out: Array<ChainSite> = []
	for (const [i, step] of steps.entries()) {
		const o = step.occurrence
		const columns = o.bindings.flatMap((b): ReadonlyArray<SiteColumn> => {
			const at = binds.get(classOf(b.var))
			return at === undefined ? [] : [{ column: b.column, ...at }]
		})
		const held = o.bindings.flatMap((b) => {
			const variable = heldClasses.get(classOf(b.var))
			return variable === undefined ? [] : [{ column: b.column, variable }]
		})
		if (
			i > 0 &&
			o.source.kind !== "Base" &&
			!heldSet(o.source) &&
			readsStored(o.source) &&
			step.bound.length >= 1 &&
			(isNonEmpty(columns) || isNonEmpty(held))
		) {
			out.push({ occurrence: o, columns, held })
		}
		for (const b of o.bindings) {
			binds.set(classOf(b.var), binds.get(classOf(b.var)) ?? { occurrence: o, at: b.column })
		}
	}
	return out
}

/**
 * Whether a region's row sites (`chainSites`) are each read at its rows' values, a read no key set serves: where a
 * restriction walked into the region (`walked`), or where the region is evaluated per outer row (cte-policy
 * evaluatedPerRow), LATERAL to it as a probe's chain is to the written row, so a set its statement computes once and
 * the site joined would be scanned whole at each evaluation, no index reading it; a region evaluated once that nothing
 * walked into reads its sites from the key set its statement computes them at, but a site of one row before it read by
 * that region alone (`oneRowBefore`, share/keys.ts rowReading). The one decision the lowering (lower/shapes/region
 * heldChain) and the key analysis (share/keys.ts rowReading) read: probe-share's population, 1,449 Budget rows written
 * at once, each of their probes joined the scopes of every document the 1,449 seats deliver, 2,099,601 index searches
 * of each of Timed and Paced.
 */
export const sitesAtRows = (region: NodeOf<"MatchRegion">, walked: boolean): boolean =>
	walked || evaluatedPerRow(region)

/**
 * Whether the region's chain `steps` (`regionChain`) reads one row before each of its row sites `sites`
 * (`chainSites`): every step before its last site is of rank `key` (cte-policy Rank), a whole declared key bound by the
 * region's values or by a step before it, so the steps before each site are at most one row and the site is read at most
 * once there. A site so read that no other reader of the statement reads is read at that row's values (share/keys.ts
 * rowReading), derived once, where a key set of it would scan that row's relations a second time to find its one key
 * (C1, test/pg/contracts/statement-size: Owner read by its id, then again for the key set of the fold its document
 * keys); one another reader reads too is read from the key set its statement computes it at for all its reads, derived
 * once for them all (test/unit/write/restricted-share: the labels two arguments of a write read by the open items, one
 * part).
 */
export const oneRowBefore = (
	steps: ReadonlyArray<ChainStep>,
	sites: ReadonlyArray<ChainSite>
): boolean => {
	const at = new Set(sites.map((site) => site.occurrence))
	const last = steps.findLastIndex((step) => at.has(step.occurrence))
	return last > 0 && steps.slice(0, last).every((step) => step.bound.rank === "key")
}

/** Whether an expression is a value of the statement's own: it reads a parameter and no relation. */
export const statementValue = (e: ScalarExpr): boolean =>
	e.deps.params.length > 0 && e.deps.nodes.length === 0

/**
 * Whether the statement's values bind occurrence `q` of `region`, a stored relation at constants of the statement's, at
 * one of its declared keys or its unit's key (cte-policy Rank `key` or `unit`: the first step of the chain over `q`
 * alone, chainSteps): its rows there one row or one unit's, however many units the store holds. A constant on a column
 * no key leads with, or on a prefix every unit's rows share, binds no unit, its rows at the value every unit's: a test's
 * assignments of every learner, where it names a test.
 */
export const unitAtValues = (region: NodeOf<"MatchRegion">, q: Occurrence): boolean => {
	const [first] = chainSteps(region, [q], [])
	return first !== undefined && (first.bound.rank === "key" || first.bound.rank === "unit")
}
