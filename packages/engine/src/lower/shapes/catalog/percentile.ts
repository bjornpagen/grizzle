import { firstIndex } from "#compiler/core/array.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import {
	derived,
	itemIdBytes,
	pageHeaderBytes,
	postgresSource,
	published
} from "#compiler/core/limits.ts"
import { binary64DecimalDigits, binary64Precision, canonicalZero } from "#compiler/ir/carriers.ts"
import type { ColumnRef, ScalarExpr } from "#compiler/ir/expr.ts"
import { OpId } from "#compiler/ir/expr.ts"
import type { Cell, EditRefs, KindOver, OccurrenceOver, VarDecl } from "#compiler/ir/rel.ts"
import { baseOf } from "#compiler/ir/scalar.ts"
import { conjuncts } from "#compiler/logical/props.ts"
import {
	bindingsByVar,
	type CatalogContext,
	freshColumn,
	type KeyGrounds,
	sameSource
} from "#compiler/lower/shapes/catalog/context.ts"

import {
	attempt,
	binaryOperands,
	colExpr,
	columnRef,
	demand,
	eitherOrder,
	litExpr,
	literalOf,
	noMatch,
	plain,
	required,
	sameExpr
} from "#compiler/lower/shapes/catalog/exprs.ts"

import {
	metaWithKeys,
	plainKeys,
	type SelfMatch,
	selfMatch
} from "#compiler/lower/shapes/catalog/ordinal.ts"

const pageLayout = "https://www.postgresql.org/docs/19/storage-page-layout.html"

/** The largest block number of a relation: its pages are numbered from 0 to it. */
const maxBlockNumber = published({
	value: 0xffff_fffe,
	owner: "PostgreSQL 19rc1's storage manager",
	unit: "pages, as their block numbers count them from 0",
	scope: "one relation's main fork",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/storage/block.h#L35`,
	quote: "#define MaxBlockNumber\t\t\t((BlockNumber) 0xFFFFFFFE)",
	verified: "2026-11-05"
})

/** The largest page PostgreSQL can be built with, so a bound on rows per page at it bounds every build's. */
const largestBlockSize = published({
	value: 32_768,
	owner: "PostgreSQL 19rc1's build",
	unit: "bytes",
	scope: "one heap page, under the largest block size configure admits",
	constraint: "compile-time constant",
	source: `${postgresSource}/configure.ac#L257`,
	quote: " 32) BLCKSZ=32768;;",
	verified: "2026-11-05"
})

/**
 * The fixed header of every heap tuple, before its alignment: a lower bound on the space a tuple takes beside its line
 * pointer.
 */
const tupleHeaderBytes = published({
	value: 23,
	owner: "PostgreSQL 19rc1's page layout",
	unit: "bytes",
	scope: "one heap tuple",
	constraint: "compile-time constant",
	source: pageLayout,
	quote: "There is a fixed-size header (occupying 23 bytes on most machines)",
	verified: "2026-11-05"
})

/**
 * More rows than one stored relation can hold under any build: every page of a relation, each holding fewer tuples
 * than its space after the header over the least a tuple takes, its fixed header and its line pointer (the bound
 * MaxHeapTuplesPerPage computes with the header aligned, src/include/access/htup_details.h).
 */
const storedMaxRows = derived({
	owner: "PostgreSQL 19rc1's heap storage",
	unit: "rows",
	scope: "one stored relation, at any block size",
	from: [maxBlockNumber, largestBlockSize, pageHeaderBytes, tupleHeaderBytes, itemIdBytes],
	derivation:
		"(maxBlockNumber + 1) pages times floor((largestBlockSize - pageHeaderBytes) / (tupleHeaderBytes + itemIdBytes)) tuples a page: 4,294,967,295 × 1,212 = 5,205,500,361,540, thirteen digits",
	compute: ([blocks, page, header, tuple, pointer]) =>
		BigInt(blocks.value + 1) *
		BigInt(Math.floor((page.value - header.value) / (tuple.value + pointer.value)))
})

/**
 * The largest j of a dyadic fraction m / 2^j the discrete rewrite admits (see tryPercentile), the least of the two
 * exponents its proof needs: the product x = p · n of such a fraction and a row count n of a stored relation is exact
 * in double precision while m · n stays within its significand, every integer up to 2^binary64Precision (ECMAScript's
 * double precision is the IEEE 754 binary64 PostgreSQL's is); and numeric's cast keeps x's fractional part of at least
 * 2^-j from rounding to zero while 2^-j is more than half a unit in the last decimal place the cast keeps of x,
 * binary64DecimalDigits less the digits of storedMaxRows.
 */
const maxDyadicExponent = derived({
	owner: "grizzle's percentile rewrite (lower/shapes/catalog/percentile.ts)",
	unit: "binary exponent of a fraction's denominator",
	scope: "one discrete percentile's fraction",
	from: [binary64DecimalDigits, binary64Precision, storedMaxRows],
	derivation:
		"min(the largest j with 2^j × storedMaxRows ≤ 2^binary64Precision (2^53), which is 10; the largest j with 2^-j > 0.5 × 10^-(binary64DecimalDigits - 13), that is 2^j < 2 × 10^(15 - 13), which is 7) = 7",
	compute: ([digits, precision, rows]) => {
		const kept = digits.value - rows.value.toString().length
		let rounding = 0
		while (2n ** BigInt(rounding + 1) < 2n * 10n ** BigInt(kept)) {
			rounding++
		}
		let exact = 0
		while (2n ** BigInt(exact + 1) * rows.value <= 2n ** BigInt(precision.value)) {
			exact++
		}
		return Math.min(rounding, exact)
	}
})

type Selection =
	| { readonly kind: "disc"; readonly p: number }
	| { readonly kind: "floor" | "ceil"; readonly p: number }

/** The operand of the unary function `op` at `e`; none for any other expression or arity. */
const unaryOperand = (e: ScalarExpr, op: string): ScalarExpr | undefined => {
	if (e.kind !== "op" || e.op !== op) {
		return undefined
	}
	const [only, ...rest] = e.args
	return rest.length === 0 ? only : undefined
}

const castArg = (e: ScalarExpr, carrier: string): ScalarExpr | undefined =>
	e.kind === "cast" && baseOf(e.type).carrier === carrier ? e.args[0] : undefined

const isColumn = (e: ScalarExpr, ref: ColumnRef): boolean => {
	const c = columnRef(e)
	return c !== undefined && c.node === ref.node && c.name === ref.name
}

const floatLiteral = (e: ScalarExpr): number | undefined => {
	if (baseOf(e.type).carrier !== "float8") {
		return undefined
	}
	const l = literalOf(e)
	return l?.kind === "float" ? l.value : undefined
}

const intLiteral = (e: ScalarExpr): bigint | undefined => {
	const l = literalOf(e)
	return l?.kind === "int" ? l.value : undefined
}

/** n::float8 */
const isN = (e: ScalarExpr, n: ColumnRef): boolean => {
	const arg = castArg(e, "float8")
	return arg !== undefined && isColumn(arg, n)
}

/** p * n::float8: p. */
const discProduct = (e: ScalarExpr, n: ColumnRef): number | undefined =>
	eitherOrder(e, "float8mul", (p, x) => (isN(x, n) ? floatLiteral(p) : undefined))

/** n − 1, in bigint or in double precision. */
const isNMinusOne = (d: ScalarExpr, n: ColumnRef): boolean => {
	const viaBigint = castArg(d, "float8")
	const integer = viaBigint === undefined ? undefined : binaryOperands(viaBigint, "int8mi")
	if (integer !== undefined && isColumn(integer[0], n) && intLiteral(integer[1]) === 1n) {
		return true
	}
	const float = binaryOperands(d, "float8mi")
	return float !== undefined && isN(float[0], n) && floatLiteral(float[1]) === 1
}

/** (n − 1)p in double precision: p. */
const minusOneProduct = (e: ScalarExpr, n: ColumnRef): number | undefined =>
	eitherOrder(e, "float8mul", (p, d) => {
		const value = floatLiteral(p)
		return value !== undefined && isNMinusOne(d, n) ? value : undefined
	})

/** 1 + (n − 1)p: p. */
const contPosition = (e: ScalarExpr, n: ColumnRef): number | undefined =>
	eitherOrder(e, "float8pl", (one, h) =>
		floatLiteral(one) === 1 ? minusOneProduct(h, n) : undefined
	)

/** ceil(x::numeric) or floor(x::numeric) as numeric: the rounding and x. */
const rounded = (
	e: ScalarExpr
): { readonly fn: "ceil" | "floor"; readonly x: ScalarExpr } | undefined => {
	for (const fn of ["ceil", "floor"] as const) {
		const arg = unaryOperand(e, `${fn}(numeric)`)
		const x = arg === undefined ? undefined : castArg(arg, "numeric")
		if (x !== undefined) {
			return { fn, x }
		}
	}
	return undefined
}

/** The rounding a comparison of the ordinal `o` with `value` states, the ordinal as bigint or cast to numeric. */
const roundingOf = (
	ord: ScalarExpr,
	value: ScalarExpr,
	o: ColumnRef
): ReturnType<typeof rounded> => {
	if (isColumn(ord, o)) {
		const inner = castArg(value, "int8")
		return inner === undefined ? undefined : rounded(inner)
	}
	const arg = castArg(ord, "numeric")
	return arg !== undefined && isColumn(arg, o) ? rounded(value) : undefined
}

/** The selection a comparison states for the ordinal `o`, or none. */
const selection = (pred: ScalarExpr, o: ColumnRef, n: ColumnRef): Selection | undefined => {
	const parse = (ord: ScalarExpr, value: ScalarExpr): Selection | undefined => {
		const r = roundingOf(ord, value, o)
		if (r === undefined) {
			return undefined
		}
		const disc = r.fn === "ceil" ? discProduct(r.x, n) : undefined
		if (disc !== undefined) {
			return { kind: "disc", p: disc }
		}
		const p = contPosition(r.x, n)
		return p === undefined ? undefined : { kind: r.fn, p }
	}
	return eitherOrder(pred, "int8eq", parse) ?? eitherOrder(pred, "numeric_eq", parse)
}

type Occurrence = OccurrenceOver<Cell, ScalarExpr, VarDecl>

interface OrdinalUse {
	readonly occ: Occurrence
	readonly match: SelfMatch
	/** The region variables the occurrence binds: the value, the ordinal. */
	readonly value: string
	readonly ordinal: string
}

interface PercentileResult {
	readonly rule: "R29" | "R30"
	readonly inputs: ReadonlyArray<NodeId>
	readonly outputs: ReadonlyArray<NodeId>
	readonly keys: ReadonlyArray<KeyGrounds>
}

/**
 * R29 and R30: a selection by ordinal is PERCENTILE_DISC, an interpolation between two ordinals PERCENTILE_CONT
 * (R30).
 *
 * The composition: the ordinal stage of R26 (an inclusive self-match counted, ordered by the value and
 * a tiebreak to a key), the group's count, and a selection
 *
 *   ProjectSet(group, value) <- Filter(ordinal = ceil(p · n)) <- MatchRegion(ordinals, counts)
 *
 * for the discrete percentile, one ordinal occurrence per fraction; for the continuous one, two ordinal occurrences
 * selected at floor(1 + (n − 1)p) and ceil(1 + (n − 1)p) and the head a + f · (b − a), f the fractional part of
 * (n − 1)p. The language's ceil and floor are numeric, so the composition computes the product in
 * double precision and rounds it through numeric: `ceil((p * n::float8)::numeric)`. The recognized spellings are those
 * arrangements: the ordinal compared as bigint with the rounded value cast back, or cast to numeric; the product and
 * the sums in either operand order; n − 1 in bigint or in double precision.
 *
 * The preconditions: p is a double precision literal, in (0, 1] for the discrete form and [0, 1] for the continuous
 * one, so neither form meets a fraction PostgreSQL refuses and p = 0, where ceil(0) selects no ordinal while the
 * native form returns the first value, keeps the composition; the continuous value is double precision, which the
 * native aggregate would otherwise convert, and which the interpolation's float8 operators over the ordinal values
 * already require (a value of another type is interpolated by other operators or through a cast, never matched); each ordinal stage is the unfiltered count of its self-match (R26's
 * ordinal, nothing else of the same type); the ordinals and the count range over one source, and every stage is
 * joined to the count on the whole group, each binding every group column to the one group variable; the ordinal
 * order's first field is the value.
 *
 * The discrete form has one more condition. Both forms compute x = p · n by the same IEEE product (float8mul, and
 * percentile_disc's `percentile * rowcount`), but PostgreSQL then takes ceil(x) in C double precision, while the
 * composition's ceil is numeric and the cast x::numeric keeps 15 significant digits (float8_numeric), so the
 * composition selects ceil(round15(x)). The two differ exactly where x is above an integer by less than that rounding:
 * 0.07 · 100 is 7.000000000000001, the composition selects the seventh value and the native form the eighth. That is
 * a different answer, not a rounding of one, so the rewrite is admitted only where it provably cannot happen: p is a
 * dyadic fraction m / 2^j with j at most maxDyadicExponent (7), and the source is a stored relation. A stored relation
 * holds fewer than storedMaxRows < 10^13 rows, so n < 10^13: m · n < 2^53 makes x exact, an integer x has at most 13
 * digits and survives the cast, and a fractional x keeps at least two decimals, which round a fractional part to zero
 * only below 0.005, and 2^-7 is more. Any other fraction, 0.07 among them, keeps the composition; the gate records its
 * disagreement with the native form (test/pg/catalog). The continuous form's floor and ceil round the same way, but
 * there the interpolation weight moves with them, so the forms differ only by double-precision rounding of one value,
 * which the catalog admits for double precision.
 *
 * The ordinal is the unfiltered count of the inclusive self-match (R26): a running conditional count or any
 * other fold the self-match also recognizes (R41) is no position, whatever its type.
 *
 * Every stage joined to the count on the whole group: the count and each ordinal bind every group column, each to
 * the one group variable. A stage that leaves one unbound would compare its ordinals with every group's count.
 *
 * The continuous form: two ordinals at floor and ceil of one position, and the interpolation.
 */
export const tryPercentile = (cx: CatalogContext, cell: Cell): PercentileResult => {
	const head = cell.current
	if (head.kind !== "ProjectSet") {
		return noMatch("a head projection")
	}
	const filterCell = head.input
	const f = filterCell.current
	demand(f.kind === "Filter", "a selection")
	const regionCell = f.input
	const r = regionCell.current
	demand(r.kind === "MatchRegion", "a selection over one match")
	demand(r.equalities.length === 0 && r.correlated.length === 0, "an uncorrelated region")
	const byVar = bindingsByVar(r)
	const ordinals: Array<OrdinalUse> = []
	const countStages: Array<{
		readonly occ: Occurrence
		readonly group: KindOver<"Group", EditRefs>
	}> = []
	for (const occ of r.occurrences) {
		demand(occ.constants.length === 0, "unrestricted stages")
		const group = occ.source.current
		demand(group.kind === "Group", "aggregate stages")
		const found = attempt(() => selfMatch(cx, occ.source, group))
		if (found.kind === "noMatch") {
			demand(countStages.length === 0, "one count stage")
			countStages.push({ occ, group })
			continue
		}
		const match = found.value
		const [only] = group.aggs
		demand(group.aggs.length === 1 && only !== undefined, "an ordinal stage with the count alone")
		demand(
			only.fn === "count" && only.filter === undefined,
			"an ordinal stage: the unfiltered count of the self-match"
		)
		demand(
			match.shared.length === 0 &&
				match.firstConstants.length === 0 &&
				match.firstConditions.length === 0,
			"an ordinal over the whole source"
		)
		const valueColumn = required(match.order[0], "the value order key of an ordinal stage").column
		const ordinalBinding = occ.bindings.findLast((b) => b.column === only.name)
		const valueBinding = occ.bindings.findLast(
			(b) => b.column !== only.name && match.firstColumn.get(b.column) === valueColumn
		)
		const ordinal = ordinalBinding === undefined ? undefined : ordinalBinding.var.name
		const value = valueBinding === undefined ? undefined : valueBinding.var.name
		demand(ordinal !== undefined && value !== undefined, "the value and the ordinal bound")
		ordinals.push({ occ, match, value, ordinal })
	}
	const [firstUse] = ordinals
	const [counts] = countStages
	demand(
		ordinals.length > 0 && firstUse !== undefined && counts !== undefined,
		"ordinal stages and the group's count"
	)
	const c = counts
	const first = firstUse.match
	const source = first.source
	const firstOrder = required(first.order[0], "the value order key of an ordinal stage")
	const valueColumn = firstOrder.column
	const valueDir = firstOrder.dir
	for (const o of ordinals) {
		demand(sameSource(o.match.source, source), "ordinals over one source")
		demand(
			o.match.order[0]?.column === valueColumn && o.match.order[0].dir === valueDir,
			"ordinals ordered by the value first"
		)
		demand(
			o.match.partition.length === first.partition.length &&
				o.match.partition.every((p) => first.partition.includes(p)),
			"ordinals over one group"
		)
	}
	demand(c.group.aggs.length === 1, "the group's unfiltered count")
	const countName = required(
		c.group.aggs.find((a) => a.fn === "count" && a.filter === undefined),
		"the group's unfiltered count"
	).name
	const ci = c.group.input.current
	demand(ci.kind === "MatchRegion", "a count over one match")
	const [cOcc] = ci.occurrences
	demand(
		ci.occurrences.length === 1 &&
			ci.correlated.length === 0 &&
			ci.equalities.length === 0 &&
			cOcc !== undefined,
		"a count over one occurrence"
	)
	demand(
		cOcc.constants.length === 0 && sameSource(cOcc.source, source),
		"a count over the whole source"
	)
	const cColumn = (name: string): string | undefined =>
		cOcc.bindings.find((b) => b.var.name === name)?.column
	const covered = new Set(
		c.group.bound.columns.flatMap((b) => {
			const column = cColumn(b)
			return column === undefined ? [] : [column]
		})
	)
	const countKey = required(cx.keyWithin(source, covered), "a count of the source's rows")
	const keyColumns = c.group.keys.map((k) => cColumn(k))
	demand(
		keyColumns.length === first.partition.length &&
			keyColumns.every((k) => k !== undefined && first.partition.includes(k)),
		"the count keyed by the ordinals' group"
	)
	/** The group variables, by name: one per partition column, the same on every stage. */
	const groupVar = new Map<string, string>()
	const bindGroup = (column: string, v: string) => {
		const known = groupVar.get(column)
		demand(known === undefined || known === v, "one variable per group column")
		groupVar.set(column, v)
	}
	for (const b of c.occ.bindings) {
		if (b.column === countName) {
			continue
		}
		const col = required(cColumn(b.column), "the count bound by its group and count")
		demand(first.partition.includes(col), "the count bound by its group and count")
		bindGroup(col, b.var.name)
	}
	const nBinding = c.occ.bindings.findLast((b) => b.column === countName)
	const nVar = nBinding === undefined ? undefined : nBinding.var.name
	for (const o of ordinals) {
		for (const [col, v] of o.occ.bindings.flatMap((b) => {
			const column = o.match.firstColumn.get(b.column)
			return column !== undefined && first.partition.includes(column)
				? [[column, b.var] as const]
				: []
		})) {
			bindGroup(col, v.name)
		}
	}
	demand(groupVar.size === first.partition.length, "the group and the count bound")
	const countVar = required(nVar, "the group and the count bound")
	for (const col of first.partition) {
		const v = groupVar.get(col)
		const sameVar = (b: VarDecl): boolean => v !== undefined && b.name === v
		demand(
			c.occ.bindings.some((b) => cColumn(b.column) === col && sameVar(b.var)),
			"the count joined on the whole group"
		)
		for (const o of ordinals) {
			demand(
				o.occ.bindings.some((b) => o.match.firstColumn.get(b.column) === col && sameVar(b.var)),
				"stages joined on the whole group"
			)
		}
	}
	for (const [v, list] of byVar) {
		if (list.length > 1) {
			demand(
				[...groupVar.values()].some((g) => g === v.name),
				"stages joined on the group only"
			)
		}
	}
	const n: ColumnRef = { node: regionCell.id, name: countVar }
	const selected = new Map<string, Selection>()
	/** The first ordinal a condition selects, with its selection. */
	const selects = (
		cj: ScalarExpr
	): { readonly use: OrdinalUse; readonly selection: Selection } | undefined => {
		for (const o of ordinals) {
			const s = selection(cj, { node: regionCell.id, name: o.ordinal }, n)
			if (s !== undefined) {
				return { use: o, selection: s }
			}
		}
		return undefined
	}
	for (const cj of conjuncts(f.pred)) {
		const hit = required(selects(cj), "each condition a selection by ordinal")
		const h = hit.use
		demand(!selected.has(h.ordinal), "one selection per ordinal")
		selected.set(h.ordinal, hit.selection)
	}
	demand(selected.size === ordinals.length, "every ordinal selected")
	const sel = ordinals.map((o) =>
		required(selected.get(o.ordinal), `the selection of ${o.ordinal}`)
	)
	const groupOut = (name: string): string | undefined =>
		[...groupVar].find(([, v]) => v === name)?.[0]
	const sourceNode = source.current
	const valueType = required(
		sourceNode.heading.find((h) => h.name === valueColumn),
		"the value's type"
	).type
	const keys = first.partition
	const keysHeading = keys.map((k) =>
		required(
			sourceNode.heading.find((h) => h.name === k),
			`a group column ${k} of the source`
		)
	)
	const inputKeys = [first.key, countKey]
	if (sel.every((s) => s.kind === "disc")) {
		for (const s of sel) {
			demand(s.p > 0 && s.p <= 1, "a fraction in (0, 1]")
		}
		for (const s of sel) {
			demand(
				Number.isInteger(s.p * 2 ** maxDyadicExponent.value),
				"a dyadic fraction, whose product the composition's numeric ceil cannot round to an integer"
			)
		}
		demand(
			sourceNode.kind === "Base",
			"a stored source, whose row count bounds n below the numeric cast's rounding"
		)
		const outs = [...ordinals.keys()].map((i) =>
			freshColumn([...keys, `__p${i + 1}`], `__p${i + 1}`)
		)
		const osa = cx.ed.node({
			kind: "OrderedSetAggregate",
			input: source,
			keys,
			fn: "percentileDisc",
			op: OpId("percentile_disc(double precision,anyelement)"),
			order: { keys: [{ column: valueColumn, dir: valueDir }] },
			fractions: sel.map((s) =>
				litExpr(cx.ed, { kind: "float", value: canonicalZero(s.p) }, plain.float8)
			),
			outs,
			rule: "R29",
			heading: [...keysHeading, ...outs.map((o) => ({ name: o, type: valueType }))],
			meta: metaWithKeys(plainKeys([keys])),
			loc: undefined
		})
		const out = head.out.map((o) => {
			const ref = columnRef(o.expr)
			demand(
				ref !== undefined && ref.node === filterCell.id,
				`a head column ${o.name} the selection binds`
			)
			const name = ref.name
			const valueIndex = firstIndex(ordinals, (x) => x.value === name)
			const column = required(
				groupOut(name) ?? (valueIndex === undefined ? undefined : outs[valueIndex]),
				`a head column ${o.name} that is the group or a selected value`
			)
			const type = required(
				head.heading.find((h) => h.name === o.name),
				`a head column ${o.name}`
			).type
			return { name: o.name, expr: colExpr(cx.ed, osa, column, type) }
		})
		cx.ed.redefine(cell, {
			kind: "ProjectSet",
			input: osa,
			out,
			heading: head.heading,
			meta: head.meta,
			loc: undefined
		})
		return {
			rule: "R29",
			inputs: [cell.id, filterCell.id, regionCell.id, ...r.occurrences.map((o) => o.source.id)],
			outputs: [cell.id, osa.id],
			keys: inputKeys
		}
	}
	demand(ordinals.length === 2, "two ordinals for the interpolation")
	const lo = firstIndex(sel, (s) => s.kind === "floor")
	const hi = firstIndex(sel, (s) => s.kind === "ceil")
	const low = sel.find((s) => s.kind === "floor")
	const high = sel.find((s) => s.kind === "ceil")
	demand(
		lo !== undefined &&
			hi !== undefined &&
			low !== undefined &&
			high !== undefined &&
			low.p === high.p,
		"floor and ceil of one position"
	)
	const p = low.p
	demand(p >= 0 && p <= 1, "a fraction in [0, 1]")
	const a: ColumnRef = {
		node: filterCell.id,
		name: required(ordinals[lo], "the floor ordinal").value
	}
	const b: ColumnRef = {
		node: filterCell.id,
		name: required(ordinals[hi], "the ceil ordinal").value
	}
	const nf: ColumnRef = { node: filterCell.id, name: countVar }
	/** f · (b − a), f the fractional part (n − 1)p − floor((n − 1)p): the fraction's operands. */
	const weightedSpan = (
		frac: ScalarExpr,
		diff: ScalarExpr
	): readonly [ScalarExpr, ScalarExpr] | undefined => {
		const span = binaryOperands(diff, "float8mi")
		if (span === undefined || !isColumn(span[0], b) || !isColumn(span[1], a)) {
			return undefined
		}
		const fraction = binaryOperands(frac, "float8mi")
		if (fraction === undefined) {
			return undefined
		}
		const [h, fl] = fraction
		const flo = castArg(fl, "float8")
		const rnd = flo === undefined ? undefined : rounded(flo)
		return minusOneProduct(h, nf) === p && rnd?.fn === "floor" && sameExpr(rnd.x, h)
			? fraction
			: undefined
	}
	const isInterpolation = (e: ScalarExpr): boolean =>
		eitherOrder(e, "float8pl", (x, rest) =>
			isColumn(x, a) ? eitherOrder(rest, "float8mul", weightedSpan) : undefined
		) !== undefined
	const out = cx.ed.node({
		kind: "OrderedSetAggregate",
		input: source,
		keys,
		fn: "percentileCont",
		op: OpId("percentile_cont(double precision,double precision)"),
		order: { keys: [{ column: valueColumn, dir: valueDir }] },
		fractions: [litExpr(cx.ed, { kind: "float", value: canonicalZero(p) }, plain.float8)],
		outs: [freshColumn(keys, "__p")],
		rule: "R30",
		heading: [...keysHeading, { name: freshColumn(keys, "__p"), type: plain.float8 }],
		meta: metaWithKeys(plainKeys([keys])),
		loc: undefined
	})
	const outName = freshColumn(keys, "__p")
	const exprs = head.out.map((o) => {
		const type = required(
			head.heading.find((h) => h.name === o.name),
			`a head column ${o.name}`
		).type
		const ref = columnRef(o.expr)
		if (ref !== undefined && ref.node === filterCell.id) {
			const g = required(
				groupOut(ref.name),
				`a head column ${o.name} that is the group or the interpolation`
			)
			return { name: o.name, expr: colExpr(cx.ed, out, g, type) }
		}
		demand(isInterpolation(o.expr), "the interpolation a + f · (b − a)")
		return { name: o.name, expr: colExpr(cx.ed, out, outName, type) }
	})
	demand(
		head.out.filter((o) => columnRef(o.expr) === undefined).length === 1,
		"one interpolated value"
	)
	cx.ed.redefine(cell, {
		kind: "ProjectSet",
		input: out,
		out: exprs,
		heading: head.heading,
		meta: head.meta,
		loc: undefined
	})
	return {
		rule: "R30",
		inputs: [cell.id, filterCell.id, regionCell.id, ...r.occurrences.map((o) => o.source.id)],
		outputs: [cell.id, out.id],
		keys: inputKeys
	}
}
