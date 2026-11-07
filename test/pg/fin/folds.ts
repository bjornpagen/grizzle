/**
 * The folds of the fin suites as grizzle lowers them: one schema per (monoid, carrier), an owner `Owner(id, n, …ends)`
 * and its ordered family `Member(member, g, at, x, …accumulators)` folded by `fold(family, Monoid.m, step, end)`, with
 * named accumulators (fold.ts FoldRow's planes as fields), and counted families whose accumulators are hidden law
 * columns; each installed through grizzle's first migration, with the SQL a direct writer reads and writes a folded
 * family's rows by (test/support/families/fold.ts FoldStored), each value in the reference's exact encoding.
 *
 * Each installed constraint is read as a fold native by its columns' roles: the member's primary key `identity`; UNIQUE
 * (g, i) `key`, and UNIQUE (g, i, …afters) `member superkey`; CHECK (i < ‹n›) `bound`; a member CHECK reading an after
 * `combine`; a member CHECK reading the index and a before, no after, `first slot`; an owner CHECK reading the count and
 * an end `empty family`; the member-to-owner foreign key the owner axis, owner-to-member the last axis, member-to-member
 * the predecessor axis.
 */
import {
	Array as Arr,
	Data,
	Effect,
	Formatter,
	Option,
	Order,
	Result,
	type Scope,
	String as Str
} from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import type { FoldPlane } from "#compiler/ir/family.ts"
import { Compute } from "#compiler/public/compute.ts"
import {
	accumulated,
	Bits,
	bits,
	closedId,
	Decimal,
	drawn,
	natural,
	pg
} from "#compiler/public/fields.ts"
import {
	closed,
	check,
	counted,
	fin,
	fold,
	Monoid,
	on,
	ordered,
	relation,
	schema,
	select
} from "#compiler/public/schema.ts"
import {
	closedLeaf,
	type ColumnKey,
	columnKey,
	type FilledNode,
	fieldKey,
	filler,
	type HostNode,
	hostEvaluator
} from "#compiler/write/family/fold.ts"
import {
	type Catalogued,
	cleared,
	constraintText,
	type Seat,
	seatOf
} from "#test/pg/fin/installed.ts"
import { deepEquals } from "#test/support/assert.ts"
import { hexOfText, setText } from "#test/support/closed/bit-text.ts"
import {
	type FoldFamily,
	type FoldLowering,
	type FoldMonoid,
	type FoldNative,
	type FoldOwner,
	type FoldPredicted,
	type FoldRow,
	type FoldStatement,
	type FoldStored,
	type FoldViolation,
	foldApplied,
	foldPredicted,
	foldSqlstate,
	type Planes
} from "#test/support/families/fold.ts"
import type { Shape } from "#test/support/families/theorem.ts"
import type { SqlError } from "#test/support/pg.ts"
import {
	type Attempted,
	attempt,
	momentText,
	refusalText,
	sameMoment
} from "#test/support/substrate.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import type { Substrate } from "#test/support/substrate/substrate.ts"

/** The roster the set monoids fold over: five handles, codes 0 to 4. */
const Tag = closed("Tag", ["a", "b", "c", "d", "e"])

/** K, the handles at most one member may hold each of: the twos fold's check reads its plane against it. */
const K = ["a", "b"] as const

const int4Min = -2_147_483_648

const countOrdered = (() => {
	const Owner = relation(
		"Owner",
		{ id: pg.int4, n: drawn(natural), end: accumulated(natural, 0n) },
		["id"]
	)
	const Member = relation(
		"Member",
		{
			member: pg.int4,
			g: pg.int4,
			at: drawn(natural),
			on: pg.bool,
			before: accumulated(natural, 0n),
			after: accumulated(natural, 0n)
		},
		["member"]
	)
	const family = ordered(on(Member, "g", "at"), fin(Owner, "n"))
	return schema("fin_fold_count", { Owner, Member }, [
		family,
		fold(
			family,
			Monoid.count,
			on(
				select(Member, (r) => r.eq(r.on, true)),
				"g",
				"before",
				"after"
			),
			on(Owner, "id", "end")
		)
	])
})()

const sumInt4 = (() => {
	const Owner = relation(
		"Owner",
		{ id: pg.int4, n: drawn(natural), end: accumulated(pg.int4, 0) },
		["id"]
	)
	const Member = relation(
		"Member",
		{
			member: pg.int4,
			g: pg.int4,
			at: drawn(natural),
			x: pg.int4,
			before: accumulated(pg.int4, 0),
			after: accumulated(pg.int4, 0)
		},
		["member"]
	)
	const family = ordered(on(Member, "g", "at"), fin(Owner, "n"))
	return schema("fin_fold_sum_int4", { Owner, Member }, [
		family,
		fold(family, Monoid.sum, on(Member, "g", "x", "before", "after"), on(Owner, "id", "end"))
	])
})()

const sumNumeric = (() => {
	const zero = Decimal.of("0")
	const Owner = relation(
		"Owner",
		{ id: pg.int4, n: drawn(natural), end: accumulated(pg.numeric(10, 2), zero) },
		["id"]
	)
	const Member = relation(
		"Member",
		{
			member: pg.int4,
			g: pg.int4,
			at: drawn(natural),
			x: pg.numeric(10, 2),
			before: accumulated(pg.numeric(10, 2), zero),
			after: accumulated(pg.numeric(10, 2), zero)
		},
		["member"]
	)
	const family = ordered(on(Member, "g", "at"), fin(Owner, "n"))
	return schema("fin_fold_sum_numeric", { Owner, Member }, [
		family,
		fold(family, Monoid.sum, on(Member, "g", "x", "before", "after"), on(Owner, "id", "end"))
	])
})()

const orBits = (() => {
	const empty = Bits.of(Tag, [])
	const Owner = relation(
		"Owner",
		{ id: pg.int4, n: drawn(natural), end: accumulated(bits(Tag), empty) },
		["id"]
	)
	const Member = relation(
		"Member",
		{
			member: pg.int4,
			g: pg.int4,
			at: drawn(natural),
			x: bits(Tag),
			before: accumulated(bits(Tag), empty),
			after: accumulated(bits(Tag), empty)
		},
		["member"]
	)
	const family = ordered(on(Member, "g", "at"), fin(Owner, "n"))
	return schema("fin_fold_or", { Tag, Owner, Member }, [
		family,
		fold(family, Monoid.or, on(Member, "g", "x", "before", "after"), on(Owner, "id", "end"))
	])
})()

const twosBits = (() => {
	const empty = Bits.of(Tag, [])
	const Owner = relation(
		"Owner",
		{
			id: pg.int4,
			n: drawn(natural),
			k: bits(Tag),
			ones: accumulated(bits(Tag), empty),
			twos: accumulated(bits(Tag), empty)
		},
		["id"]
	)
	const Member = relation(
		"Member",
		{
			member: pg.int4,
			g: pg.int4,
			at: drawn(natural),
			x: bits(Tag),
			onesBefore: accumulated(bits(Tag), empty),
			onesAfter: accumulated(bits(Tag), empty),
			twosBefore: accumulated(bits(Tag), empty),
			twosAfter: accumulated(bits(Tag), empty)
		},
		["member"]
	)
	const family = ordered(on(Member, "g", "at"), fin(Owner, "n"))
	return schema("fin_fold_twos", { Tag, Owner, Member }, [
		family,
		fold(
			family,
			Monoid.twos,
			on(Member, "g", "x", "onesBefore", "onesAfter", "twosBefore", "twosAfter"),
			on(Owner, "id", "ones", "twos")
		),
		check("atMostOneOfK", Owner, (o) =>
			o.eq(Compute.cardinality(Compute.intersection(o.twos, o.k)), 0n)
		)
	])
})()

const maxInt4 = (() => {
	const Owner = relation(
		"Owner",
		{ id: pg.int4, n: drawn(natural), end: accumulated(pg.int4, int4Min) },
		["id"]
	)
	const Member = relation(
		"Member",
		{
			member: pg.int4,
			g: pg.int4,
			at: drawn(natural),
			x: pg.int4,
			before: accumulated(pg.int4, int4Min),
			after: accumulated(pg.int4, int4Min)
		},
		["member"]
	)
	const family = ordered(on(Member, "g", "at"), fin(Owner, "n"))
	return schema("fin_fold_max_int4", { Owner, Member }, [
		family,
		fold(family, Monoid.max, on(Member, "g", "x", "before", "after"), on(Owner, "id", "end"))
	])
})()

const maxCode = (() => {
	const Owner = relation(
		"Owner",
		{ id: pg.int4, n: drawn(natural), end: accumulated(closedId(Tag), "a") },
		["id"]
	)
	const Member = relation(
		"Member",
		{
			member: pg.int4,
			g: pg.int4,
			at: drawn(natural),
			x: closedId(Tag),
			before: accumulated(closedId(Tag), "a"),
			after: accumulated(closedId(Tag), "a")
		},
		["member"]
	)
	const family = ordered(on(Member, "g", "at"), fin(Owner, "n"))
	return schema("fin_fold_max_code", { Tag, Owner, Member }, [
		family,
		fold(family, Monoid.max, on(Member, "g", "x", "before", "after"), on(Owner, "id", "end"))
	])
})()

const sumCounted = (() => {
	const Owner = relation(
		"Owner",
		{ id: pg.int4, n: drawn(natural), end: accumulated(pg.int4, 0) },
		["id"]
	)
	const Member = relation("Member", { member: pg.int4, g: pg.int4, x: pg.int4 }, ["member"])
	const family = counted(on(Member, "g"), fin(Owner, "n"))
	return schema("fin_fold_sum_counted", { Owner, Member }, [
		family,
		fold(family, Monoid.sum, on(Member, "g", "x"), on(Owner, "id", "end"))
	])
})()

const orCounted = (() => {
	const empty = Bits.of(Tag, [])
	const Owner = relation(
		"Owner",
		{ id: pg.int4, n: drawn(natural), end: accumulated(bits(Tag), empty) },
		["id"]
	)
	const Member = relation("Member", { member: pg.int4, g: pg.int4, x: bits(Tag) }, ["member"])
	const family = counted(on(Member, "g"), fin(Owner, "n"))
	return schema("fin_fold_or_counted", { Tag, Owner, Member }, [
		family,
		fold(family, Monoid.or, on(Member, "g", "x"), on(Owner, "id", "end"))
	])
})()

/** How a carrier's values are written, read and encoded: SQL text from the reference's value, and back. */
interface Carrier {
	/** The SQL literal of a value. */
	readonly write: (v: bigint) => string
	/** The SQL expression that reads a column as text the parse reads. */
	readonly read: (column: string) => string
	readonly parse: (text: string) => bigint
	/** A value other than `v` the carrier and its domain admit: the junk a mutation writes. */
	readonly junk: (v: bigint) => bigint
	/** The host value of a value, as its carrier's codec admits it (scalar/values/identity.ts CarrierHost), and back. */
	readonly toHost: (v: bigint) => unknown
	readonly fromHost: (h: unknown) => bigint
}

/** The handles of Tag, each at its code: a fresh roster's codes are its declared order. */
const TAG_HANDLES = ["a", "b", "c", "d", "e"] as const

/** A host integer, a number or a bigint, as the reference's bigint. */
const integerOf = (h: unknown): bigint =>
	typeof h === "bigint" ? h : typeof h === "number" ? BigInt(h) : BigInt(String(h))

const integer: Omit<Carrier, "toHost"> = {
	write: (v) => `${v}`,
	read: (c) => `${c}::int8::text`,
	parse: (t) => BigInt(t),
	junk: (v) => v + 1n,
	fromHost: integerOf
}

/** int4, whose host value is a number. */
const int4: Carrier = { ...integer, toHost: (v) => Number(v) }

/** natural, whose host value is a bigint. */
const naturals: Carrier = { ...integer, toHost: (v) => v }

/** numeric(10, 2) in hundredths. */
const hundredths: Carrier = {
	write: (v) => `(${v}::numeric / 100)`,
	read: (c) => `(${c} * 100)::int8::text`,
	parse: (t) => BigInt(t),
	junk: (v) => v + 1n,
	toHost: (v) => {
		const magnitude = v < 0n ? -v : v
		return Decimal.of(
			`${v < 0n ? "-" : ""}${magnitude / 100n}.${Str.padStart(2, "0")(String(magnitude % 100n))}`
		)
	},
	fromHost: (h) => {
		const text = String(h)
		const negative = Str.startsWith("-")(text)
		const [whole, fraction = ""] = Str.split(negative ? Str.slice(1)(text) : text, ".")
		const hundredthsOf =
			BigInt(whole) * 100n + BigInt(Str.padEnd(2, "0")(Str.slice(0, 2)(fraction)))
		return negative ? -hundredthsOf : hundredthsOf
	}
}

/**
 * A set of codes 0 to 4 as its bit mask, written as the hex literal of the bit string whose position c is code c, its
 * codes rounded up to whole hex digits (test/support/closed/bit-text.ts setText).
 */
const setOf = (size: number): Carrier => ({
	write: (v) =>
		`X'${hexOfText(
			setText(
				size,
				Arr.filter(Arr.range(0, size - 1), (c) => ((v >> BigInt(c)) & 1n) === 1n)
			)
		)}'`,
	read: (c) => `${c}::text`,
	parse: (t) =>
		Arr.reduce(Str.split(t, ""), 0n, (mask, ch, c) =>
			ch === "1" ? mask | (1n << BigInt(c)) : mask
		),
	/** Code 4, `e`, toggled: no handle of K, so a junk twos plane meets the fold's natives, not K's check. */
	junk: (v) => v ^ 16n,
	toHost: (v) => new Set(Arr.filter(TAG_HANDLES, (_, c) => ((v >> BigInt(c)) & 1n) === 1n)),
	fromHost: (h) =>
		Arr.reduce(TAG_HANDLES, 0n, (mask, handle, c) =>
			h instanceof Set && h.has(handle) ? mask | (1n << BigInt(c)) : mask
		)
})

/** A closed id's code, junk the next live code down or up. */
const code: Carrier = {
	write: (v) => `${v}`,
	read: (c) => `${c}::int8::text`,
	parse: (t) => BigInt(t),
	junk: (v) => (v === 4n ? 3n : v + 1n),
	toHost: (v) => Arr.getUnsafe(TAG_HANDLES, Number(v)),
	fromHost: (h) =>
		BigInt(
			Option.getOrThrowWith(
				Arr.findFirstIndex(TAG_HANDLES, (t) => t === h),
				() => new Error(`the host value ${Formatter.format(h)} is no handle of Tag`)
			)
		)
}

/** One fold seat's specification: its schema, monoid, shape, carrier, step domain and accumulator roles. */
export interface FoldSpec {
	readonly label: string
	readonly schema: unknown
	readonly monoid: FoldMonoid
	readonly shape: Shape
	readonly carrier: Carrier
	/** The five step values, in the reference's encoding. */
	readonly domain: Arr.NonEmptyReadonlyArray<bigint>
	/** Whether the step's selection holds of a member with the value at an index of the domain; none for no selection. */
	readonly selected: Option.Option<(index: number) => boolean>
	/** The member's step column, none for count. */
	readonly x: Option.Option<string>
	/** Each plane's before and after column roles on the member, and end role on the owner. */
	readonly planes: Arr.NonEmptyReadonlyArray<{
		readonly before: string
		readonly after: string
		readonly end: string
	}>
	/** A check of the owner's ends beside the fold's own natives: the twos fold's at most one of K. */
	readonly check: Option.Option<{ readonly holds: (end: Planes, k: bigint) => boolean }>
}

const named = [{ before: "before", after: "after", end: "end" }] as const

const hidden = [{ before: "‹before 0.0›", after: "‹after 0.0›", end: "end" }] as const

const ints = [-2n, -1n, 0n, 1n, 3n] as const

/** Every fold seat of the suites. */
export const FOLD_SPECS: Arr.NonEmptyReadonlyArray<FoldSpec> = [
	{
		label: "count over a selection",
		schema: countOrdered,
		monoid: { name: "count", least: 0n },
		shape: "ordered",
		carrier: naturals,
		domain: [0n, 0n, 0n, 0n, 0n],
		selected: Option.some((i) => i % 2 === 0),
		x: Option.none(),
		planes: named,
		check: Option.none()
	},
	{
		label: "sum of int4",
		schema: sumInt4,
		monoid: { name: "sum", least: 0n },
		shape: "ordered",
		carrier: int4,
		domain: ints,
		selected: Option.none(),
		x: Option.some("x"),
		planes: named,
		check: Option.none()
	},
	{
		label: "sum of numeric(10, 2)",
		schema: sumNumeric,
		monoid: { name: "sum", least: 0n },
		shape: "ordered",
		carrier: hundredths,
		domain: [-150n, 1n, 25n, 100n, 275n],
		selected: Option.none(),
		x: Option.some("x"),
		planes: named,
		check: Option.none()
	},
	{
		label: "or of a set",
		schema: orBits,
		monoid: { name: "or", least: 0n },
		shape: "ordered",
		carrier: setOf(5),
		domain: [0b00000n, 0b00001n, 0b00010n, 0b00011n, 0b11100n],
		selected: Option.none(),
		x: Option.some("x"),
		planes: named,
		check: Option.none()
	},
	{
		label: "twos of a set",
		schema: twosBits,
		monoid: { name: "twos", least: 0n },
		shape: "ordered",
		carrier: setOf(5),
		domain: [0b00000n, 0b00001n, 0b00010n, 0b00011n, 0b11100n],
		selected: Option.none(),
		x: Option.some("x"),
		planes: [
			{ before: "onesBefore", after: "onesAfter", end: "ones" },
			{ before: "twosBefore", after: "twosAfter", end: "twos" }
		],
		check: Option.some({ holds: (end, k) => ((end[1] ?? 0n) & k) === 0n })
	},
	{
		label: "max of int4",
		schema: maxInt4,
		monoid: { name: "max", least: BigInt(int4Min) },
		shape: "ordered",
		carrier: int4,
		domain: ints,
		selected: Option.none(),
		x: Option.some("x"),
		planes: named,
		check: Option.none()
	},
	{
		label: "max of a closed id",
		schema: maxCode,
		monoid: { name: "max", least: 0n },
		shape: "ordered",
		carrier: code,
		domain: [0n, 1n, 2n, 3n, 4n],
		selected: Option.none(),
		x: Option.some("x"),
		planes: named,
		check: Option.none()
	},
	{
		label: "sum of int4 over a counted family",
		schema: sumCounted,
		monoid: { name: "sum", least: 0n },
		shape: "counted",
		carrier: int4,
		domain: ints,
		selected: Option.none(),
		x: Option.some("x"),
		planes: hidden,
		check: Option.none()
	},
	{
		label: "or of a set over a counted family",
		schema: orCounted,
		monoid: { name: "or", least: 0n },
		shape: "counted",
		carrier: setOf(5),
		domain: [0b00000n, 0b00001n, 0b00010n, 0b00011n, 0b11100n],
		selected: Option.none(),
		x: Option.some("x"),
		planes: hidden,
		check: Option.none()
	}
]

/** A fold seat: its spec, its installed seat, its index's role, its fold's and family's laws, and K's mask. */
export interface FoldSeat {
	readonly spec: FoldSpec
	readonly seat: Seat
	readonly index: string
	readonly laws: ReadonlyArray<string>
	/** K's bit mask by the installation's codes. */
	readonly k: bigint
}

export const foldSeat = (
	spec: FoldSpec,
	label: string
): Effect.Effect<
	FoldSeat,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> => Effect.map(seatOf(spec.schema, ["Owner", "Member"], label), (seat) => foldSeatOf(spec, seat))

/** A fold seat over a seat already installed for `spec`'s schema: its index's role, its laws and K's mask. */
export const foldSeatOf = (spec: FoldSpec, seat: Seat): FoldSeat => {
	const codec = Arr.findFirst(
		[...seat.installed.names.codes.rosters.values()],
		(r) => r.roster === Tag.name
	)
	const k = Arr.reduce(K, 0n, (mask, h) => {
		const c = Option.getOrUndefined(codec)?.codeOf.get(h)
		return c === undefined ? mask : mask | (1n << BigInt(c))
	})
	return {
		spec,
		seat,
		index: spec.shape === "ordered" ? "at" : "‹i›",
		laws: [...seat.lawsOf("family"), ...seat.lawsOf("fold")],
		k
	}
}

/** The fold native an installed constraint is, by its columns' roles; none for the owner's keys and the user's check. */
const foldNativeOf = (f: FoldSeat, c: Catalogued): Option.Option<FoldNative> => {
	const has = (role: string) => c.columns.includes(role)
	const afters = Arr.map(f.spec.planes, (p) => p.after)
	const befores = Arr.map(f.spec.planes, (p) => p.before)
	const ends = Arr.map(f.spec.planes, (p) => p.end)
	switch (c.kind) {
		case "primary":
			return c.relation === "Member" ? Option.some("identity") : Option.none()
		case "unique":
			if (c.relation !== "Member") {
				return Option.none()
			}
			return Arr.some(afters, has) ? Option.some("member superkey") : Option.some("key")
		case "check":
			if (c.relation === "Owner") {
				return has("n") && Arr.some(ends, has) ? Option.some("empty family") : Option.none()
			}
			if (Arr.some(afters, has)) {
				return Option.some("combine")
			}
			if (Arr.some(befores, has)) {
				return Option.some("first slot")
			}
			return has("‹n›") ? Option.some("bound") : Option.none()
		case "foreign": {
			const target = Option.getOrUndefined(c.target)
			if (target === undefined) {
				return Option.none()
			}
			if (c.relation === "Member" && target.relation === "Owner") {
				return Option.some("owner axis")
			}
			if (c.relation === "Owner" && target.relation === "Member") {
				return Option.some("last axis")
			}
			return Option.some("predecessor axis")
		}
	}
}

/** The installed constraint of a fold native, or the defect naming what the seat installed. */
export const foldInstalledOf = (f: FoldSeat, native: FoldNative): ReadonlyArray<Catalogued> =>
	Arr.filter(f.seat.constraints, (c) => Option.contains(foldNativeOf(f, c), native))

/** A fold statement's SQL on a seat. */
export const foldStatementSql = (f: FoldSeat, statement: FoldStatement): string => {
	const { seat, spec } = f
	const c = (relation: string, role: string) => seat.column(relation, role)
	const v = spec.carrier.write
	/** The owner's K, which the twos fold's check reads, written once with the owner and never updated. */
	const kColumn = Option.isSome(spec.check) ? [c("Owner", "k")] : []
	const kValue = Option.isSome(spec.check) ? [v(f.k)] : []
	const ownerColumns = [
		c("Owner", "id"),
		c("Owner", "n"),
		...Arr.map(spec.planes, (p) => c("Owner", p.end))
	]
	const ownerValues = (o: FoldOwner) => [`${o.owner}`, `${o.count}`, ...Arr.map(o.end, v)]
	const memberColumns = [
		c("Member", "member"),
		c("Member", "g"),
		c("Member", f.index),
		c("Member", "‹n›"),
		...Option.match(spec.x, { onNone: () => [], onSome: (x) => [c("Member", x)] }),
		...Option.match(spec.selected, { onNone: () => [], onSome: () => [c("Member", "on")] }),
		...Arr.flatMap(spec.planes, (p) => [c("Member", p.before), c("Member", p.after)])
	]
	const memberValues = (r: FoldRow) => [
		`${r.member}`,
		`${r.group}`,
		`${r.at}`,
		`${r.copy}`,
		...Option.match(spec.x, { onNone: () => [], onSome: () => [v(r.x)] }),
		...Option.match(spec.selected, {
			onNone: () => [],
			onSome: () => [r.selected ? "true" : "false"]
		}),
		...Arr.flatMap(spec.planes, (_, i) => [
			v(Arr.getUnsafe(r.before, i)),
			v(Arr.getUnsafe(r.after, i))
		])
	]
	const tuple = (values: ReadonlyArray<string>) => `(${Arr.join(values, ", ")})`
	switch (statement.kind) {
		case "create":
			return `INSERT INTO ${seat.table("Owner")} ${tuple([...ownerColumns, ...kColumn])} VALUES ${tuple([...ownerValues(statement.owner), ...kValue])}`
		case "drop":
			return `DELETE FROM ${seat.table("Owner")} WHERE ${c("Owner", "id")} = ${statement.owner}`
		case "count":
			return `UPDATE ${seat.table("Owner")} SET ${Arr.join(
				Arr.map(
					Arr.zip(ownerColumns, ownerValues(statement.owner)).slice(1),
					([col, val]) => `${col} = ${val}`
				),
				", "
			)} WHERE ${c("Owner", "id")} = ${statement.owner.owner}`
		case "insert":
			return `INSERT INTO ${seat.table("Member")} ${tuple(memberColumns)} VALUES ${Arr.join(
				Arr.map(statement.rows, (r) => tuple(memberValues(r))),
				", "
			)}`
		case "delete":
			return `DELETE FROM ${seat.table("Member")} WHERE ${c("Member", "member")} IN ${tuple(Arr.map(statement.members, String))}`
		case "update":
			return `UPDATE ${seat.table("Member")} SET ${Arr.join(
				[
					`${c("Member", f.index)} = ${statement.at}`,
					...Arr.flatMap(spec.planes, (p, i) => [
						`${c("Member", p.before)} = ${v(Arr.getUnsafe(statement.before, i))}`,
						`${c("Member", p.after)} = ${v(Arr.getUnsafe(statement.after, i))}`
					])
				],
				", "
			)} WHERE ${c("Member", "member")} = ${statement.member}`
	}
}

/** PostgreSQL's disagreement with the reference fold or the fold's model, spelt out. */
export class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** One transaction from no state that writes a stored state: the owners, then the rows in descending slot order. */
export const foldWriteOf = (stored: FoldStored): ReadonlyArray<FoldStatement> => {
	const rows = Arr.sort(
		stored.rows,
		Order.mapInput(Order.flip(Order.Number), (r: FoldRow) => r.at)
	)
	return [
		...Arr.map(stored.owners, (owner): FoldStatement => ({ kind: "create", owner })),
		...(Arr.isReadonlyArrayNonEmpty(rows) ? [{ kind: "insert", rows } satisfies FoldStatement] : [])
	]
}

/** A fold seat with the lowering its model judges it by: grizzle's, or a mutant of it. */
export interface Judging {
	readonly label: string
	readonly fold: FoldSeat
	readonly lowering: FoldLowering
}

/** A verdict as a feature: committed, refused naming a fold native, or refused by the twos fold's check. */
export type FoldVerdict = "committed" | `refused ${FoldNative}` | "refused at most one of K"

const predictedText = (model: FoldPredicted): string =>
	model.kind === "committed"
		? "commit"
		: `refusal ${momentText(model.moment)} by any of ${Arr.join(
				Arr.dedupe(Arr.map(model.violations, (v) => v.native)),
				", "
			)}`

export const attemptedText = (real: Attempted): string =>
	real.kind === "committed"
		? "commit"
		: `refusal ${momentText(real.moment)}: ${refusalText(real.fields)}`

/** A fold seat's stored state, read back as the reference's values, rows by member. */
export const foldRead = (f: FoldSeat): Effect.Effect<FoldStored, SqlError> =>
	Effect.gen(function* () {
		const { seat, spec, index } = f
		const c = (relation: string, role: string) => seat.column(relation, role)
		const r = spec.carrier.read
		const owners = yield* seat.session.values(
			`SELECT ${c("Owner", "id")}::int8::text, ${c("Owner", "n")}::int8::text, ${Arr.join(
				Arr.map(spec.planes, (p) => r(c("Owner", p.end))),
				", "
			)} FROM ${seat.table("Owner")}`,
			[]
		)
		const rows = yield* seat.session.values(
			`SELECT ${c("Member", "member")}::int8::text, ${c("Member", "g")}::int8::text, ${c("Member", index)}::int8::text, ${c("Member", "‹n›")}::int8::text, ${Option.match(spec.x, { onNone: () => "'0'", onSome: (x) => r(c("Member", x)) })}, ${Option.match(spec.selected, { onNone: () => "'true'", onSome: () => `${c("Member", "on")}::text` })}, ${Arr.join(
				Arr.flatMap(spec.planes, (p) => [r(c("Member", p.before)), r(c("Member", p.after))]),
				", "
			)} FROM ${seat.table("Member")}`,
			[]
		)
		const parse = (cell: unknown) => spec.carrier.parse(String(cell))
		return byMember({
			owners: Arr.sort(
				Arr.map(owners, (o) => ({
					owner: Number(o[0]),
					count: Number(o[1]),
					end: nonEmptyPlanes(Arr.map(o.slice(2), parse))
				})),
				Order.mapInput(Order.Number, (o: FoldOwner) => o.owner)
			),
			rows: Arr.map(rows, (row): FoldRow => {
				const planes = Arr.map(row.slice(6), parse)
				return {
					member: Number(row[0]),
					group: Number(row[1]),
					at: Number(row[2]),
					copy: Number(row[3]),
					x: parse(row[4]),
					selected: String(row[5]) === "true",
					before: nonEmptyPlanes(Arr.filter(planes, (_, i) => i % 2 === 0)),
					after: nonEmptyPlanes(Arr.filter(planes, (_, i) => i % 2 === 1))
				}
			})
		})
	})

const nonEmptyPlanes = (values: ReadonlyArray<bigint>): Planes => {
	if (!Arr.isReadonlyArrayNonEmpty(values)) {
		throw new Error("a fold has a plane")
	}
	return values
}

/** A stored state in one canonical order: owners by key, rows by member. */
export const byMember = (s: FoldStored): FoldStored => ({
	owners: Arr.sort(
		s.owners,
		Order.mapInput(Order.Number, (o: FoldOwner) => o.owner)
	),
	rows: Arr.sort(
		s.rows,
		Order.mapInput(Order.Number, (r: FoldRow) => r.member)
	)
})

/**
 * Writes `before` (which must commit), sends `statements` as one transaction after `prefix` (statements the model does
 * not see, such as a SET CONSTRAINTS), and judges PostgreSQL against the fold's model: the same verdict and moment; a
 * refusal by an installed constraint whose role the model allows there, with its SQLSTATE, reporting a law of the family
 * or the fold; where an owner's ends fail the twos fold's at most one of K, a refusal at that owner's statement by that
 * check with 23514; a commit that reads back exactly. Both relations are cleared after.
 */
export const judgedFold = (
	j: Judging,
	before: FoldStored,
	statements: ReadonlyArray<FoldStatement>,
	prefix: ReadonlyArray<string>
): Effect.Effect<FoldVerdict, SqlError | TransactionRolledBack | Disagreed> =>
	Effect.gen(function* () {
		const { seat, spec } = j.fold
		const sql = (s: ReadonlyArray<FoldStatement>) =>
			Arr.map(s, (st) => foldStatementSql(j.fold, st))
		const setup = yield* attempt(seat.session, sql(foldWriteOf(before)))
		const model = foldPredicted(spec.monoid, j.lowering, before, statements)
		const sent = yield* attempt(seat.session, [...prefix, ...sql(statements)])
		yield* seat.session.resetStatements
		/** The moment the model reads, the prefix's statements out. */
		const real: Attempted =
			sent.kind === "refused" && sent.moment.kind === "statement"
				? { ...sent, moment: { kind: "statement", index: sent.moment.index - prefix.length } }
				: sent
		const disagree = (why: string) =>
			new Disagreed({
				message: `${j.label}: ${why}; the model predicts ${predictedText(model)}, PostgreSQL gave ${attemptedText(real)}, over ${Formatter.format(before)}, for ${Formatter.format(statements)}`
			})
		if (setup.kind !== "committed") {
			return yield* disagree(`writing the state before was refused: ${attemptedText(setup)}`)
		}
		const after = Arr.reduce(statements, before, foldApplied)
		const checkAt = Arr.findFirstIndex(
			statements,
			(s) =>
				(s.kind === "create" || s.kind === "count") &&
				Option.exists(spec.check, (k) => !k.holds(s.owner.end, j.fold.k))
		)
		if (real.kind === "committed") {
			const read = yield* foldRead(j.fold)
			yield* cleared(seat, ["Owner", "Member"])
			if (model.kind !== "committed" || Option.isSome(checkAt)) {
				return yield* disagree("PostgreSQL committed")
			}
			if (!deepEquals(read, byMember(after))) {
				return yield* disagree(`the committed state reads back as ${Formatter.format(read)}`)
			}
			return "committed" satisfies FoldVerdict
		}
		yield* cleared(seat, ["Owner", "Member"])
		const named = seat.refusedBy(real.fields)
		const native = Option.flatMap(named, (c) => foldNativeOf(j.fold, c))
		if (
			Option.isSome(checkAt) &&
			Option.isSome(named) &&
			Option.isNone(native) &&
			named.value.relation === "Owner"
		) {
			if (
				real.fields.code !== "23514" ||
				!(real.moment.kind === "statement" && real.moment.index === checkAt.value)
			) {
				return yield* disagree(
					"at most one of K refused otherwise than at the owner's statement with 23514"
				)
			}
			return "refused at most one of K" satisfies FoldVerdict
		}
		if (model.kind === "committed") {
			return yield* disagree("PostgreSQL refused")
		}
		if (!sameMoment(model.moment, real.moment)) {
			return yield* disagree("the moments differ")
		}
		if (Option.isNone(named) || Option.isNone(native)) {
			return yield* disagree(
				`PostgreSQL names ${Option.match(named, {
					onNone: () => "no installed constraint",
					onSome: (c) => `${constraintText(c)}, no fold native`
				})}`
			)
		}
		/**
		 * The fold's member CHECK is one constraint per law: its combine and, where it reads the index, its first-slot
		 * pin, `((i > 0 OR before = ι) AND after = combine(before, x)) IS TRUE`, so its refusal stands for either.
		 */
		const pins = native.value === "combine" && named.value.columns.includes(j.fold.index)
		const violated: ReadonlyArray<FoldViolation> = model.violations
		const allowed = (n: FoldNative) =>
			Arr.some(violated, (v) => v.native === n) ||
			(pins && n === "combine" && Arr.some(violated, (v) => v.native === "first slot"))
		if (!allowed(native.value) || real.fields.code !== foldSqlstate(native.value)) {
			return yield* disagree(
				`PostgreSQL names the ${native.value}, which the model does not allow there`
			)
		}
		if (
			native.value !== "identity" &&
			!Option.exists(named.value.law, (l) => j.fold.laws.includes(l))
		) {
			return yield* disagree(
				`the ${native.value} reports ${Formatter.format(named.value.law)}, no law of the family or the fold`
			)
		}
		/** The merged CHECK's refusal is the first slot's where the model breaks only the pin there, and the combine's otherwise. */
		const pinOnly =
			pins &&
			!Arr.some(violated, (v) => v.native === "combine") &&
			Arr.some(violated, (v) => v.native === "first slot")
		const verdict: FoldVerdict = `refused ${pinOnly ? "first slot" : native.value}`
		return verdict
	})

/**
 * The host's fill of one owner's family on a fold seat (write/family/fold.ts filler over the installation's fill order
 * and codes), read back as the reference's state: the second implementation the reference fold is judged beside. A
 * family it will not fill is the disagreement it reports.
 */
export const hostFilled = (f: FoldSeat, family: FoldFamily): Result.Result<FoldStored, string> => {
	const { spec } = f
	const codes = f.seat.installed.names.codes
	const built = filler(
		f.seat.model.theory.fill,
		codes,
		hostEvaluator(codes, closedLeaf(new Map()), f.seat.model.patterns)
	)
	const node: HostNode = {
		relation: "Owner",
		values: new Map<ColumnKey, unknown>([
			[fieldKey("id"), family.owner],
			...Option.match(spec.check, {
				onNone: (): ReadonlyArray<readonly [ColumnKey, unknown]> => [],
				onSome: () => [[fieldKey("k"), spec.carrier.toHost(f.k)] as const]
			})
		]),
		families: [
			{
				family: { owner: "Owner", count: "n" },
				members: Arr.map(family.members, (m) => ({
					relation: "Member",
					values: new Map<ColumnKey, unknown>([
						[fieldKey("member"), m.member],
						...Option.match(spec.x, {
							onNone: (): ReadonlyArray<readonly [ColumnKey, unknown]> => [],
							onSome: (x) => [[fieldKey(x), spec.carrier.toHost(m.x)] as const]
						}),
						...Option.match(spec.selected, {
							onNone: (): ReadonlyArray<readonly [ColumnKey, unknown]> => [],
							onSome: () => [[fieldKey("on"), m.selected] as const]
						})
					]),
					families: []
				}))
			}
		]
	}
	const filled = built(node)
	if (!filled.ok) {
		return Result.fail(`the filler refuses the family: ${Formatter.format(filled.error)}`)
	}
	const [owned] = filled.value.families
	const fold = owned?.family.folds[0]
	if (owned === undefined || fold === undefined) {
		return Result.fail("the filled owner holds no folded family")
	}
	const host = (row: FilledNode, column: ColumnKey): bigint =>
		spec.carrier.fromHost(row.values.get(column))
	const foldPlanes: ReadonlyArray<FoldPlane> = fold.planes
	const planes = (row: FilledNode, pick: (p: FoldPlane) => ColumnKey): Planes =>
		nonEmptyPlanes(Arr.map(foldPlanes, (p) => host(row, pick(p))))
	const n = family.members.length
	return Result.succeed({
		owners: [
			{ owner: family.owner, count: n, end: planes(filled.value, (p) => fieldKey(p.end.name)) }
		],
		rows: Arr.map(owned.members, (row, at): FoldRow => {
			const m = Arr.getUnsafe(family.members, at)
			return {
				group: family.owner,
				at,
				copy: n,
				member: m.member,
				x: m.x,
				selected: m.selected,
				before: planes(row, (p) => columnKey(p.before)),
				after: planes(row, (p) => columnKey(p.after))
			}
		})
	})
}
