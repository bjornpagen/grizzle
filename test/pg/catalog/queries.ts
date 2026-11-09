import { Array as Arr, Record as Rec } from "effect"
import { indices } from "#compiler/core/array.ts"
import type { Direction } from "#compiler/core/order.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import type {
	AuthoredExprDesc as ExprDesc,
	HeadTermDesc,
	QueryDesc
} from "#test/support/fixtures/ir/desc.ts"
import * as D from "#test/unit/check/dsl.ts"

export const double: FieldDesc = { kind: "pg", type: "double precision" }
const bigint: FieldDesc = { kind: "pg", type: "bigint" }
const integer: FieldDesc = { kind: "pg", type: "integer" }

const v = D.varRef
const s = (field: string) => D.ref("Sitting", field)
const sVars = D.vars("Sitting", "id", "student", "day", "score")
const mean = (arg: ExprDesc): HeadTermDesc => ({ kind: "aggregate", fn: "mean", arg })
const f8 = (value: number): ExprDesc => D.typedLit(value, double)
const cond = (pred: ExprDesc, onTrue: ExprDesc, onFalse: ExprDesc): ExprDesc => ({
	kind: "cond",
	pred,
	onTrue,
	onFalse
})

/**
 * The tuple comparison "t before-or-at s" written field by field, per field direction: for an ascending field t < s,
 * for a descending one t > s, and the last field inclusive or strict.
 */
export const lexicographic = (
	fields: ReadonlyArray<{
		readonly t: ExprDesc
		readonly s: ExprDesc
		readonly dir: Direction
	}>,
	inclusive: boolean
): ExprDesc => {
	const [first, ...rest] = fields
	if (first === undefined) {
		throw new Error("an empty tuple")
	}
	const strict = first.dir === "asc" ? D.lt(first.t, first.s) : D.gt(first.t, first.s)
	if (rest.length === 0) {
		if (!inclusive) {
			return strict
		}
		return first.dir === "asc" ? D.le(first.t, first.s) : D.ge(first.t, first.s)
	}
	return D.or(strict, D.and(D.eq(first.t, first.s), lexicographic(rest, inclusive)))
}

/**
 * Ordinals and running aggregates (R26, R41): Sitting matched as s and t on the student, t restricted by (t.day, t.id)
 * <= (s.day, s.id) under `dirs`.
 */
export interface SelfMatchOptions {
	readonly dirs: readonly [Direction, Direction]
	readonly inclusive: boolean
	readonly extra: ReadonlyArray<ExprDesc>
	/**
	 * The restriction of t: the nested expansion of (t.day, t.id) against (s.day, s.id) under `dirs`, or a comparison
	 * spelled otherwise.
	 */
	readonly order:
		| { readonly kind: "expanded" }
		| { readonly kind: "spelled"; readonly where: ExprDesc }
	readonly keys: ReadonlyArray<"student" | "id">
	/** The student both occurrences share: the shared variable, or a constant both fix it to. */
	readonly student: ExprDesc
}

/** The plain self-match: ascending (day, id), inclusive, nothing extra, the student shared, keyed by student and id. */
export const plainSelfMatch: SelfMatchOptions = {
	dirs: ["asc", "asc"],
	inclusive: true,
	extra: [],
	order: { kind: "expanded" },
	keys: ["student", "id"],
	student: s("student")
}

/**
 * The window and ordering compositions over the Lab fixture, written the way an author writes them: each is an ordinary
 * query of the language, and the catalog's recognizers decide whether it has a native target.
 */
export const selfMatch = (
	head: Readonly<Record<string, HeadTermDesc>>,
	options: SelfMatchOptions
): QueryDesc => {
	const [dDay, dId] = options.dirs
	const student = options.student
	return D.queryDesc(
		D.rule({
			vars: [...sVars, D.plainVar("t.id"), D.plainVar("t.day"), D.plainVar("t.score")],
			matches: [
				D.match(D.relationSource("Sitting"), {
					student,
					id: s("id"),
					day: s("day"),
					score: s("score")
				}),
				D.match(D.relationSource("Sitting"), {
					student,
					id: v("t.id"),
					day: v("t.day"),
					score: v("t.score")
				})
			],
			where: [
				options.order.kind === "spelled"
					? options.order.where
					: lexicographic(
							[
								{ t: v("t.day"), s: s("day"), dir: dDay },
								{ t: v("t.id"), s: s("id"), dir: dId }
							],
							options.inclusive
						),
				...options.extra
			],
			head: {
				...Rec.fromEntries(Arr.map(options.keys, (k) => [k, s(k)])),
				...head
			},
			interiors: [],
			attach: []
		})
	)
}

export const ordinal = (dirs: readonly [Direction, Direction]): QueryDesc =>
	selfMatch({ ordinal: D.count() }, { ...plainSelfMatch, dirs })

export const running = (options: SelfMatchOptions): QueryDesc =>
	selfMatch(
		{
			ordinal: D.count(),
			total: D.sum(v("t.score")),
			top: D.max(v("t.score")),
			low: D.min(v("t.day")),
			meanDay: mean(v("t.day")),
			/** A conditional count where no row qualifies, and one where some do. */
			none: D.sum(cond(D.gt(v("t.score"), f8(100)), D.lit(1), D.lit(0))),
			some: D.sum(cond(D.gt(v("t.score"), f8(3)), D.lit(1), D.lit(0))),
			/** A bigint conditional count, whose sum is numeric (R24's typing). */
			wide: D.sum(cond(D.gt(v("t.score"), f8(3)), D.lit(1n), D.lit(0n))),
			/** A conditional sum. */
			partial: D.sum(cond(D.gt(v("t.score"), f8(3)), v("t.score"), f8(0)))
		},
		options
	)

/** The take(1) of Sitting after (or before) the parent's (day, id) on the parent's student. */
const neighborQuery = (
	direction: "next" | "previous",
	heading: { readonly id: string; readonly day: string },
	extra: ReadonlyArray<ExprDesc>
) =>
	D.take(
		D.orderBy(
			D.queryDesc(
				D.rule({
					vars: [D.plainVar("n.id"), D.plainVar("n.day"), D.plainVar("n.score")],
					matches: [
						D.match(D.relationSource("Sitting"), {
							student: D.param("st", integer),
							id: v("n.id"),
							day: v("n.day"),
							score: v("n.score")
						})
					],
					where: [
						direction === "next"
							? D.or(
									D.gt(v("n.day"), D.param("d", integer)),
									D.and(
										D.eq(v("n.day"), D.param("d", integer)),
										D.gt(v("n.id"), D.param("i", bigint))
									)
								)
							: D.or(
									D.lt(v("n.day"), D.param("d", integer)),
									D.and(
										D.eq(v("n.day"), D.param("d", integer)),
										D.lt(v("n.id"), D.param("i", bigint))
									)
								),
						...extra
					],
					head: { [heading.id]: v("n.id"), [heading.day]: v("n.day"), nscore: v("n.score") },
					interiors: [],
					attach: []
				})
			),
			[heading.day, direction === "next" ? "asc" : "desc"],
			[heading.id, direction === "next" ? "asc" : "desc"]
		),
		1
	)

/** R27, bound: every sitting with its next (or previous) sitting's id and score. */
export const boundNeighbor = (
	direction: "next" | "previous",
	extra: ReadonlyArray<ExprDesc>
): QueryDesc =>
	D.queryDesc(
		D.rule({
			vars: [...sVars, D.plainVar("x.nid"), D.plainVar("x.nscore")],
			matches: [
				D.match(D.relationSource("Sitting"), { student: s("student"), id: s("id"), day: s("day") }),
				D.match(
					D.imported(neighborQuery(direction, { id: "nid", day: "nday" }, extra), {
						st: s("student"),
						d: s("day"),
						i: s("id")
					}),
					{ nid: v("x.nid"), nscore: v("x.nscore") }
				)
			],
			head: { id: s("id"), nid: v("x.nid"), nscore: v("x.nscore") },
			where: [],
			interiors: [],
			attach: []
		})
	)

const parentSittings = D.queryDesc(
	D.rule({
		vars: sVars,
		matches: [
			D.match(D.relationSource("Sitting"), { student: s("student"), id: s("id"), day: s("day") })
		],
		head: { student: s("student"), id: s("id"), day: s("day") },
		where: [],
		interiors: [],
		attach: []
	})
)

/** The sittings whose score is some point's x: Sitting is the match's second occurrence, after Point. */
const pointedSittings = D.queryDesc(
	D.rule({
		vars: [...sVars, D.plainVar("pt.id")],
		matches: [
			D.match(D.relationSource("Point"), { id: v("pt.id"), x: s("score") }),
			D.match(D.relationSource("Sitting"), {
				student: s("student"),
				id: s("id"),
				day: s("day"),
				score: s("score")
			})
		],
		head: { student: s("student"), id: s("id"), day: s("day") },
		where: [],
		interiors: [],
		attach: []
	})
)

/**
 * R27, attached: each sitting with its next (or previous) sitting as an attachment; over "pointed" the parents are the
 * sittings whose score is some point's x, so each parent value is a column of the match's second occurrence.
 */
export const attachedNeighbor = (
	direction: "next" | "previous",
	parents: "sittings" | "pointed"
): QueryDesc => {
	const child = D.take(
		D.orderBy(
			D.queryDesc(
				D.rule({
					vars: [D.plainVar("n.id"), D.plainVar("n.day"), D.plainVar("n.score")],
					matches: [
						D.match(D.relationSource("Sitting"), {
							student: D.parent("student"),
							id: v("n.id"),
							day: v("n.day"),
							score: v("n.score")
						})
					],
					where: [
						direction === "next"
							? D.or(
									D.gt(v("n.day"), D.parent("day")),
									D.and(D.eq(v("n.day"), D.parent("day")), D.gt(v("n.id"), D.parent("id")))
								)
							: D.or(
									D.lt(v("n.day"), D.parent("day")),
									D.and(D.eq(v("n.day"), D.parent("day")), D.lt(v("n.id"), D.parent("id")))
								)
					],
					head: { nid: v("n.id"), nday: v("n.day"), nscore: v("n.score") },
					interiors: [],
					attach: []
				})
			),
			["nday", direction === "next" ? "asc" : "desc"],
			["nid", direction === "next" ? "asc" : "desc"]
		),
		1
	)
	return D.attach(parents === "sittings" ? parentSittings : pointedSittings, "neighbor", child)
}

/**
 * The latest price of the student at or before (<=), strictly before (<), or the earliest at or after (>=) a day. The
 * bigint amount compared with the sitting's integer day is a comparison the checker refuses (operands of one type).
 */
type Compared = "day" | "amount"
const asOfQuery = (
	mode: "le" | "lt" | "ge",
	extra: ReadonlyArray<ExprDesc>,
	compared: Compared
) => {
	const parentDay = D.param("d", integer)
	const field = v(compared === "day" ? "p.day" : "p.amount")
	return D.take(
		D.orderBy(
			D.queryDesc(
				D.rule({
					vars: [D.plainVar("p.id"), D.plainVar("p.day"), D.plainVar("p.amount")],
					matches: [
						D.match(D.relationSource("Price"), {
							student: D.param("st", integer),
							id: v("p.id"),
							day: v("p.day"),
							amount: v("p.amount")
						})
					],
					where: [
						mode === "le"
							? D.le(field, parentDay)
							: mode === "lt"
								? D.lt(field, parentDay)
								: D.ge(field, parentDay),
						...extra
					],
					head: { pid: v("p.id"), pday: v("p.day"), amount: v("p.amount") },
					interiors: [],
					attach: []
				})
			),
			[compared === "day" ? "pday" : "amount", mode === "ge" ? "asc" : "desc"],
			["pid", mode === "ge" ? "asc" : "desc"]
		),
		1
	)
}

/**
 * R42, bound: every sitting with the as-of price's id and amount; `extra` restricts the prices alone, and `compared`
 * names the price field compared with the sitting's day.
 */
export const boundAsOf = (
	mode: "le" | "lt" | "ge",
	extra: ReadonlyArray<ExprDesc>,
	compared: Compared
): QueryDesc =>
	D.queryDesc(
		D.rule({
			vars: [...sVars, D.plainVar("x.pid"), D.plainVar("x.amount")],
			matches: [
				D.match(D.relationSource("Sitting"), { student: s("student"), id: s("id"), day: s("day") }),
				D.match(D.imported(asOfQuery(mode, extra, compared), { st: s("student"), d: s("day") }), {
					pid: v("x.pid"),
					amount: v("x.amount")
				})
			],
			head: { id: s("id"), pid: v("x.pid"), amount: v("x.amount") },
			where: [],
			interiors: [],
			attach: []
		})
	)

/** R42, attached: each sitting with its as-of price as an attachment. */
export const attachedAsOf = (
	mode: "le" | "lt" | "ge",
	extra: ReadonlyArray<ExprDesc>
): QueryDesc => {
	const child = D.take(
		D.orderBy(
			D.queryDesc(
				D.rule({
					vars: [D.plainVar("p.id"), D.plainVar("p.day"), D.plainVar("p.amount")],
					matches: [
						D.match(D.relationSource("Price"), {
							student: D.parent("student"),
							id: v("p.id"),
							day: v("p.day"),
							amount: v("p.amount")
						})
					],
					where: [
						mode === "le"
							? D.le(v("p.day"), D.parent("day"))
							: mode === "lt"
								? D.lt(v("p.day"), D.parent("day"))
								: D.ge(v("p.day"), D.parent("day")),
						...extra
					],
					head: { pid: v("p.id"), pday: v("p.day"), amount: v("p.amount") },
					interiors: [],
					attach: []
				})
			),
			["pday", mode === "ge" ? "asc" : "desc"],
			["pid", mode === "ge" ? "asc" : "desc"]
		),
		1
	)
	return D.attach(parentSittings, "price", child)
}

const perStudent = D.queryDesc(
	D.rule({
		vars: sVars,
		matches: [D.match(D.relationSource("Sitting"), { student: s("student"), id: s("id") })],
		head: { student: s("student"), n: D.count() },
		where: [],
		interiors: [],
		attach: []
	})
)

const total = D.queryDesc(
	D.rule({
		vars: sVars,
		matches: [D.match(D.relationSource("Sitting"), { id: s("id") })],
		head: { n: D.count() },
		where: [],
		interiors: [],
		attach: []
	})
)

/** The total over another relation, and over a filtered input: neither ranges over the grouped count's bindings. */
const totals = {
	Sitting: total,
	Price: D.queryDesc(
		D.rule({
			vars: D.vars("Price", "id"),
			matches: [D.match(D.relationSource("Price"), { id: D.ref("Price", "id") })],
			head: { n: D.count() },
			where: [],
			interiors: [],
			attach: []
		})
	),
	filtered: D.queryDesc(
		D.rule({
			vars: sVars,
			matches: [D.match(D.relationSource("Sitting"), { id: s("id"), score: s("score") })],
			where: [D.gt(s("score"), f8(3))],
			head: { n: D.count() },
			interiors: [],
			attach: []
		})
	)
} as const

/**
 * R28: each student's count beside the total; `restricted` binds the total to the grouped count's variable, which keeps
 * only the groups whose count is the total.
 */
export const groupedShare = (over: keyof typeof totals, restricted: boolean): QueryDesc =>
	D.queryDesc(
		D.rule({
			vars: [D.plainVar("g"), D.plainVar("c"), D.plainVar("tot")],
			matches: [
				D.match(D.imported(perStudent, {}), { student: v("g"), n: v("c") }),
				D.match(D.imported(totals[over], {}), { n: v(restricted ? "c" : "tot") })
			],
			head: { student: v("g"), c: v("c"), ...(restricted ? {} : { tot: v("tot") }) },
			where: [],
			interiors: [],
			attach: []
		})
	)

/**
 * R28: each sitting with its student's count. `restricted` binds the count to the sitting's id, which keeps only the
 * sittings whose id equals their student's count.
 */
export const keyedShare = (restricted: boolean): QueryDesc =>
	D.queryDesc(
		D.rule({
			vars: [...sVars, D.plainVar("c")],
			matches: [
				D.match(D.relationSource("Sitting"), { student: s("student"), id: s("id"), day: s("day") }),
				D.match(D.imported(perStudent, {}), {
					student: s("student"),
					n: restricted ? s("id") : v("c")
				})
			],
			head: {
				id: s("id"),
				day: s("day"),
				student: s("student"),
				...(restricted ? {} : { c: v("c") })
			},
			where: [],
			interiors: [],
			attach: []
		})
	)

/** The ordinal of each sitting by score within its student, ties broken by id: the ordinal stage of a percentile. */
const scoreOrdinals = selfMatchByScore(D.count())

/**
 * The same self-match folding a running conditional count of scores above 3 in place of the ordinal: bigint like an
 * ordinal, but no position.
 */
const runningAboveThree = selfMatchByScore(
	D.sum(cond(D.gt(v("t.score"), f8(3)), D.lit(1), D.lit(0)))
)

function selfMatchByScore(ord: HeadTermDesc): QueryDesc {
	return D.queryDesc(
		D.rule({
			vars: [...sVars, D.plainVar("t.id"), D.plainVar("t.score")],
			matches: [
				D.match(D.relationSource("Sitting"), {
					student: s("student"),
					id: s("id"),
					score: s("score")
				}),
				D.match(D.relationSource("Sitting"), {
					student: s("student"),
					id: v("t.id"),
					score: v("t.score")
				})
			],
			where: [
				lexicographic(
					[
						{ t: v("t.score"), s: s("score"), dir: "asc" },
						{ t: v("t.id"), s: s("id"), dir: "asc" }
					],
					true
				)
			],
			head: { student: s("student"), id: s("id"), score: s("score"), ord },
			interiors: [],
			attach: []
		})
	)
}

/** ceil((p * n::float8)::numeric) */
const ceilPn = (p: number, n: ExprDesc): ExprDesc =>
	D.compute("ceil", D.compute("numeric", D.compute("mul", f8(p), D.cast(n, double))))

/**
 * The ordinal `o` at a rounded position: o::numeric = position. The ordinal widens into numeric, which every value
 * survives; the position cast back to bigint would narrow a value no type proves finite.
 */
const ordinalAt = (o: string, position: ExprDesc): ExprDesc =>
	D.eq(D.compute("numeric", v(o)), position)

/**
 * R29: the value at ordinal ceil(p · n) of each student's scores, one selection per fraction. `unjoined` leaves the
 * ordinal stages' student unbound, so each ordinal meets every student's count; `stage` swaps the ordinal stage for
 * another fold of the same self-match.
 */
export interface PercentileStage {
	/** Whether the ordinal stage's student is joined to the group's. */
	readonly joined: boolean
	/** The fold of the self-match the selection reads: the ordinal, or a running conditional count. */
	readonly fold: "ordinal" | "runningCount"
}

/** The selection by ordinal, joined on the group: R29's shape. */
export const ordinalStage: PercentileStage = { joined: true, fold: "ordinal" }

export const discretePercentile = (
	fractions: ReadonlyArray<number>,
	stage: PercentileStage
): QueryDesc =>
	D.queryDesc(
		D.rule({
			vars: [
				D.plainVar("g"),
				D.plainVar("n"),
				...Arr.flatMap(indices(fractions.length), (k) => [D.plainVar(`o${k}`), D.plainVar(`v${k}`)])
			],
			matches: [
				...Arr.map(indices(fractions.length), (k) =>
					D.match(
						D.imported(stage.fold === "runningCount" ? runningAboveThree : scoreOrdinals, {}),
						{
							...(stage.joined ? { student: v("g") } : {}),
							score: v(`v${k}`),
							ord: v(`o${k}`)
						}
					)
				),
				D.match(D.imported(perStudent, {}), { student: v("g"), n: v("n") })
			],
			where: Arr.map(fractions, (p, k) => ordinalAt(`o${k}`, ceilPn(p, v("n")))),
			head: {
				student: v("g"),
				...Rec.fromEntries(Arr.map(indices(fractions.length), (k) => [`p${k}`, v(`v${k}`)]))
			},
			interiors: [],
			attach: []
		})
	)

/** (n − 1)p in double precision. */
const hOf = (p: number, n: ExprDesc): ExprDesc =>
	D.compute("mul", f8(p), D.cast(D.compute("sub", n, D.lit(1n)), double))

/** The ordinal of each price by amount within its student, ties broken by id, and each student's count of prices. */
const amountOrdinals = D.queryDesc(
	D.rule({
		vars: [
			...D.vars("Price", "id", "student", "amount"),
			D.plainVar("t.id"),
			D.plainVar("t.amount")
		],
		matches: [
			D.match(D.relationSource("Price"), {
				student: D.ref("Price", "student"),
				id: D.ref("Price", "id"),
				amount: D.ref("Price", "amount")
			}),
			D.match(D.relationSource("Price"), {
				student: D.ref("Price", "student"),
				id: v("t.id"),
				amount: v("t.amount")
			})
		],
		where: [
			lexicographic(
				[
					{ t: v("t.amount"), s: D.ref("Price", "amount"), dir: "asc" },
					{ t: v("t.id"), s: D.ref("Price", "id"), dir: "asc" }
				],
				true
			)
		],
		head: {
			student: D.ref("Price", "student"),
			id: D.ref("Price", "id"),
			amount: D.ref("Price", "amount"),
			ord: D.count()
		},
		interiors: [],
		attach: []
	})
)

const pricesPerStudent = D.queryDesc(
	D.rule({
		vars: D.vars("Price", "id", "student"),
		matches: [
			D.match(D.relationSource("Price"), {
				student: D.ref("Price", "student"),
				id: D.ref("Price", "id")
			})
		],
		head: { student: D.ref("Price", "student"), n: D.count() },
		where: [],
		interiors: [],
		attach: []
	})
)

/**
 * R30: the value interpolated between the ordinals floor(1 + (n − 1)p) and ceil(1 + (n − 1)p). Over "amount" the value
 * is a bigint price, interpolated in double precision through casts.
 */
export const continuousPercentile = (p: number, over: "score" | "amount"): QueryDesc => {
	const ordinals = over === "score" ? scoreOrdinals : amountOrdinals
	const counts = over === "score" ? perStudent : pricesPerStudent
	const value = (x: string) => (over === "score" ? v(x) : D.cast(v(x), double))
	const n = v("n")
	const position = (fn: "floor" | "ceil") =>
		D.compute(fn, D.compute("numeric", D.compute("add", f8(1), hOf(p, n))))
	const frac = D.compute(
		"sub",
		hOf(p, n),
		D.cast(D.compute("floor", D.compute("numeric", hOf(p, n))), double)
	)
	return D.queryDesc(
		D.rule({
			vars: [
				D.plainVar("g"),
				D.plainVar("n"),
				D.plainVar("oa"),
				D.plainVar("a"),
				D.plainVar("ob"),
				D.plainVar("b")
			],
			matches: [
				D.match(D.imported(ordinals, {}), { student: v("g"), [over]: v("a"), ord: v("oa") }),
				D.match(D.imported(ordinals, {}), { student: v("g"), [over]: v("b"), ord: v("ob") }),
				D.match(D.imported(counts, {}), { student: v("g"), n })
			],
			where: [ordinalAt("oa", position("floor")), ordinalAt("ob", position("ceil"))],
			head: {
				student: v("g"),
				value: D.compute(
					"add",
					value("a"),
					D.compute("mul", frac, D.compute("sub", value("b"), value("a")))
				)
			},
			interiors: [],
			attach: []
		})
	)
}

/**
 * R31: the most frequent day over every sitting, ties to the earliest. `k` takes more than the first; `count` as
 * "conditional" counts only the sittings scoring above 3, sum(cond(score > 3, 1, 0)).
 */
export interface ModeOptions {
	/** How many of the most frequent days it takes. */
	readonly k: number
	/** What it counts: every sitting, or only those scoring above 3, sum(cond(score > 3, 1, 0)). */
	readonly count: "all" | "conditional"
}

/** The mode itself: the one most frequent day over every sitting. */
export const plainMode: ModeOptions = { k: 1, count: "all" }

export const modeOfDays = (tiebreak: Direction, options: ModeOptions): QueryDesc => {
	const counts = D.take(
		D.orderBy(
			D.queryDesc(
				D.rule({
					vars: sVars,
					matches: [
						D.match(D.relationSource("Sitting"), { id: s("id"), day: s("day"), score: s("score") })
					],
					head: {
						day: s("day"),
						n:
							options.count === "conditional"
								? D.sum(cond(D.gt(s("score"), f8(3)), D.lit(1), D.lit(0)))
								: D.count()
					},
					where: [],
					interiors: [],
					attach: []
				})
			),
			["n", "desc"],
			["day", tiebreak]
		),
		options.k
	)
	return D.queryDesc(
		D.rule({
			vars: [D.plainVar("m")],
			matches: [D.match(D.imported(counts, {}), { day: v("m") })],
			head: { mode: v("m") },
			where: [],
			interiors: [],
			attach: []
		})
	)
}
