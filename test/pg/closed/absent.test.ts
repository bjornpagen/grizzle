import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	element,
	type Gen,
	int,
	oneOf,
	subarray,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { boundedShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { type ApplyOutcome, Db } from "#adapter/public/db.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { ChangeSet, type Law } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import { Bits, bits, closedId, contract, Decimal, generated, pg } from "#compiler/public/fields.ts"
import {
	check,
	closed,
	contained,
	key,
	on,
	relation,
	schema,
	select
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { Predicate } from "#compiler/types/core/phantom.ts"
import type { RowScalars } from "#compiler/types/schema/statements.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert } from "#test/support/assert.ts"
import { setText } from "#test/support/closed/bit-text.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * A closed read at an absent key is judged by the rule that reads it, never refused by a cast, on PostgreSQL 19rc1.
 *
 * The documented contract: `C.at` at a key its closed relation holds no row at reads NULL, `C.row` of a prefix the
 * relation completes nowhere reads the empty set and of a NULL prefix NULL, and the rule's three-valued logic decides.
 * A row check holds where its predicate is true, a selection keeps the rows it is true of, and a generated field's
 * NULL term is refused by its column's NOT NULL. Every domain admits NULL, so no cast to a roster's, a set's, a
 * contract's or a pattern's domain refuses a read first.
 *
 * Each case draws a world: rosters Kind and Flag of one to three and one to five handles, so a set over Flag is padded
 * by three bits down to none; Pick, keyed by a kind, whose payload is a flag, an integer, a numeric(3, 1), a text, a
 * contract over an integer and a refined text, holding a drawn subset of the kinds; FlagRel, a set of (from, to) flags,
 * whose row of a flag is its completions, empty for a flag it completes nowhere; FlagW, a flag's integer weight,
 * holding a drawn subset of the flags; and Allowed, a set of (kind, flag) pairs. A read is Pick.at of a payload field
 * at the row's kind, or FlagRel.row or FlagW.at at the row's own flag or, nested, at Pick.at("flag", kind). Its
 * positions:
 *
 * - two row checks, each a drawn predicate: a read equal to the row's field of its type or to a literal, the
 *   downstream `Compute.subset(FlagRel.row(…), flags)` equal to true, the kind equal or unequal to a handle, and AND,
 *   OR and NOT of them;
 * - a containment of a selection's (kind, flag) into Allowed, under a drawn predicate: a table CHECK whose guard is
 *   the selection;
 * - a key over a selection's integer, under a drawn predicate: a law column `CASE WHEN φ THEN n END`, which grizzle's
 *   writer probes by a query that lowers the selection again. Each drawn row is written at every kind, so a row the
 *   selection keeps and one it leaves unknown share their integer;
 * - a generated field of each read, each its own relation: a closed id, an integer, a numeric, a text, a contract and
 *   a refined text read by Pick.at; and a set and an integer read by FlagRel.row and FlagW.at at the own and at the
 *   picked flag.
 *
 * Each drawn row is written into each relation by grizzle's writer, one insert per ChangeSet. The oracle is the
 * documented contract restated over the world's rows: Kleene's three-valued logic over reads that are NULL exactly at
 * an absent key or a NULL argument. A lawful row is accepted; an unlawful one is `invariant-rejected` naming its
 * relation's one law; and every stored generated value is the read's, a set its exact bits. A domain's refusal of a
 * NULL is a 23514 on a roster's or a set's domain, which grizzle's writer dies with as its own defect, or names a
 * contract's or a pattern's law: neither is what the contract names.
 *
 * The planted bugs: a domain CHECK that refuses NULL refuses the downstream case and every generated closed id, set,
 * contract or pattern field at an absent key; a C.row of a prefix completed nowhere read as NULL refuses a subset
 * check and a generated set the contract stores empty.
 */

/** A Pick row's payload: a flag's code, an integer, a numeric in tenths, a text, a Units value and a Short text. */
interface Payload {
	readonly flag: number
	readonly n: number
	readonly d: number
	readonly t: string
	readonly u: number
	readonly p: string
}

/**
 * The closed relations' rows: Pick's payload at each kind, undefined where it holds none; FlagRel's completions of each
 * flag, in code order; FlagW's weight at each flag, undefined where it holds none; and Allowed's flags of each kind.
 */
interface World {
	readonly kinds: number
	readonly flags: number
	readonly pick: ReadonlyArray<Payload | undefined>
	readonly next: ReadonlyArray<ReadonlyArray<number>>
	readonly weight: ReadonlyArray<number | undefined>
	readonly allowed: ReadonlyArray<ReadonlyArray<number>>
}

/** What a read keys on: a row's kind and flag codes. */
interface Keys {
	readonly kind: number
	readonly flag: number
}

/** A row of every relation: its kind and flag codes, its set of flags, and a value of each payload type. */
interface Item extends Keys {
	readonly flags: ReadonlyArray<number>
	readonly n: number
	readonly d: number
	readonly t: string
	readonly u: number
	readonly p: string
}

const pickFields = ["flag", "n", "d", "t", "u", "p"] as const
type PickField = (typeof pickFields)[number]

/** Where a FlagRel or FlagW read takes its flag: the row's own, or Pick.at("flag", kind), NULL at an absent kind. */
const flagSources = ["own", "picked"] as const
type FlagSource = (typeof flagSources)[number]

type Read =
	| { readonly kind: "at"; readonly field: PickField }
	| { readonly kind: "row"; readonly of: FlagSource }
	| { readonly kind: "weight"; readonly of: FlagSource }

/** A value a read or a row's field holds: a code, an integer or tenths, a text, or a set's codes in order. */
type Value = number | string | ReadonlyArray<number>

type Against = { readonly kind: "field" } | { readonly kind: "literal"; readonly value: Value }

type Pred =
	| { readonly kind: "eq"; readonly read: Read; readonly against: Against }
	| { readonly kind: "subset"; readonly of: FlagSource }
	| { readonly kind: "kind"; readonly ne: boolean; readonly handle: number }
	| { readonly kind: "and" | "or"; readonly args: readonly [Pred, Pred] }
	| { readonly kind: "not"; readonly arg: Pred }

interface AbsentCase {
	readonly world: World
	readonly checks: readonly [Pred, Pred]
	readonly contained: Pred
	readonly keyed: Pred
	readonly items: NonEmptyReadonlyArray<Item>
}

/** The text at index i over {a, b} in bijective base 2: "", "a", "b", "aa", "ab", "ba", "bb", … */
const textAt = (i: number): string =>
	i === 0 ? "" : `${textAt(Math.floor((i - 1) / 2))}${i % 2 === 1 ? "a" : "b"}`

/** A numeric(3, 1) of `tenths` tenths, as PostgreSQL prints it. */
const tenthsText = (tenths: number): string =>
	`${tenths < 0 ? "-" : ""}${Math.floor(Math.abs(tenths) / 10)}.${Math.abs(tenths) % 10}`

const smallInt = int(0, 3)
const tenthsGen: Gen<number> = (s) => s.draw(int(-3, 3)) * 5
const wildGen: Gen<string> = (s) => textAt(s.draw(int(0, 6)))
const shortGen: Gen<string> = (s) => textAt(s.draw(int(1, 6)))

/** Codes 0 … n − 1. */
const codesBelow = (n: number): ReadonlyArray<number> => Arr.makeBy(n, (code) => code)

const payloadGen =
	(flags: number): Gen<Payload> =>
	(s) => ({
		flag: s.draw(int(0, flags - 1)),
		n: s.draw(smallInt),
		d: s.draw(tenthsGen),
		t: s.draw(wildGen),
		u: s.draw(smallInt),
		p: s.draw(shortGen)
	})

const worldGen: Gen<World> = (s) => {
	const kinds = s.draw(int(1, 3))
	const flags = s.draw(int(1, 5))
	const codes = codesBelow(flags)
	return {
		kinds,
		flags,
		pick: Arr.map(codesBelow(kinds), () =>
			s.draw(boolean) ? s.draw(payloadGen(flags)) : undefined
		),
		next: Arr.map(codes, () => s.draw(subarray(codes))),
		weight: Arr.map(codes, () => (s.draw(boolean) ? s.draw(smallInt) : undefined)),
		allowed: Arr.map(codesBelow(kinds), () => s.draw(subarray(codes)))
	}
}

const readGen: Gen<Read> = oneOf<Read>([
	(s) => ({ kind: "at", field: s.draw(element(pickFields)) }),
	(s) => ({ kind: "row", of: s.draw(element(flagSources)) }),
	(s) => ({ kind: "weight", of: s.draw(element(flagSources)) })
])

/** A literal of a payload field's type. */
const atLiteralGen = (w: World, field: PickField): Gen<Value> => {
	switch (field) {
		case "flag":
			return int(0, w.flags - 1)
		case "n":
		case "u":
			return smallInt
		case "d":
			return tenthsGen
		case "t":
			return wildGen
		case "p":
			return shortGen
	}
}

/** A literal of a read's type. */
const literalGen = (w: World, read: Read): Gen<Value> => {
	switch (read.kind) {
		case "at":
			return atLiteralGen(w, read.field)
		case "row":
			return subarray(codesBelow(w.flags))
		case "weight":
			return smallInt
	}
}

const leafGen = (w: World): Gen<Pred> =>
	oneOf<Pred>([
		(s) => {
			const read = s.draw(readGen)
			return {
				kind: "eq",
				read,
				against: s.draw(boolean)
					? { kind: "field" }
					: { kind: "literal", value: s.draw(literalGen(w, read)) }
			}
		},
		(s) => ({ kind: "subset", of: s.draw(element(flagSources)) }),
		(s) => ({ kind: "kind", ne: s.draw(boolean), handle: s.draw(int(0, w.kinds - 1)) })
	])

/** A predicate nested at most `depth` levels: a leaf, AND or OR of two, or NOT of one. */
const predGen = (w: World, depth: number): Gen<Pred> =>
	depth === 0
		? leafGen(w)
		: weighted<Pred>([
				[2, leafGen(w)],
				[
					2,
					(s) => ({
						kind: s.draw(element(["and", "or"] as const)),
						args: [s.draw(predGen(w, depth - 1)), s.draw(predGen(w, depth - 1))]
					})
				],
				[1, (s) => ({ kind: "not", arg: s.draw(predGen(w, depth - 1)) })]
			])

const itemGen =
	(w: World): Gen<Item> =>
	(s) => ({
		kind: s.draw(int(0, w.kinds - 1)),
		flag: s.draw(int(0, w.flags - 1)),
		flags: s.draw(subarray(codesBelow(w.flags))),
		n: s.draw(smallInt),
		d: s.draw(tenthsGen),
		t: s.draw(wildGen),
		u: s.draw(smallInt),
		p: s.draw(shortGen)
	})

const caseGen: Gen<AbsentCase> = (s) => {
	const world = s.draw(worldGen)
	const pred = predGen(world, 2)
	const item = itemGen(world)
	return {
		world,
		checks: [s.draw(pred), s.draw(pred)],
		contained: s.draw(pred),
		keyed: s.draw(pred),
		items: [s.draw(item), ...s.draw(array(item, { min: 0, max: 3 }))]
	}
}

/** Kleene's truth values: what a predicate is over a row whose reads may be NULL. */
type Truth = "true" | "false" | "unknown"

const truthOf = (holds: boolean): Truth => (holds ? "true" : "false")

const not = (t: Truth): Truth => (t === "unknown" ? t : t === "true" ? "false" : "true")

const both = (a: Truth, b: Truth): Truth =>
	a === "false" || b === "false" ? "false" : a === "true" && b === "true" ? "true" : "unknown"

const either = (a: Truth, b: Truth): Truth => not(both(not(a), not(b)))

/** The flag a FlagRel or FlagW read keys on: undefined, NULL, where it is Pick's at a kind Pick holds no row at. */
const flagFrom = (w: World, keys: Keys, of: FlagSource): number | undefined =>
	of === "own" ? keys.flag : w.pick[keys.kind]?.flag

/** A read's value over a row, undefined where it is NULL: at an absent key, or at a NULL argument. */
const readOf = (w: World, keys: Keys, read: Read): Value | undefined => {
	switch (read.kind) {
		case "at":
			return w.pick[keys.kind]?.[read.field]
		case "row": {
			const flag = flagFrom(w, keys, read.of)
			return flag === undefined ? undefined : w.next[flag]
		}
		case "weight": {
			const flag = flagFrom(w, keys, read.of)
			return flag === undefined ? undefined : w.weight[flag]
		}
	}
}

/** The row's own field a read is compared with: the field of its type, the integer for a weight. */
const fieldOf = (item: Item, read: Read): Value => {
	switch (read.kind) {
		case "at":
			return item[read.field]
		case "row":
			return item.flags
		case "weight":
			return item.n
	}
}

const sameValue = (a: Value, b: Value): boolean =>
	typeof a === "object" && typeof b === "object"
		? a.length === b.length && Arr.every(a, (x, i) => x === b[i])
		: a === b

/** A predicate's truth over a row: SQL's three-valued logic, a read at an absent key unknown. */
const truth = (w: World, item: Item, p: Pred): Truth => {
	switch (p.kind) {
		case "eq": {
			const left = readOf(w, item, p.read)
			const right = p.against.kind === "field" ? fieldOf(item, p.read) : p.against.value
			return left === undefined ? "unknown" : truthOf(sameValue(left, right))
		}
		case "subset": {
			const set = readOf(w, item, { kind: "row", of: p.of })
			return set === undefined || typeof set !== "object"
				? "unknown"
				: truthOf(Arr.every(set, (code) => item.flags.includes(code)))
		}
		case "kind":
			return truthOf((item.kind === p.handle) !== p.ne)
		case "and":
			return both(truth(w, item, p.args[0]), truth(w, item, p.args[1]))
		case "or":
			return either(truth(w, item, p.args[0]), truth(w, item, p.args[1]))
		case "not":
			return not(truth(w, item, p.arg))
	}
}

/** Every read a predicate states. */
const readsOf = (p: Pred): ReadonlyArray<Read> => {
	switch (p.kind) {
		case "eq":
			return [p.read]
		case "subset":
			return [{ kind: "row", of: p.of }]
		case "kind":
			return []
		case "and":
		case "or":
			return [...readsOf(p.args[0]), ...readsOf(p.args[1])]
		case "not":
			return readsOf(p.arg)
	}
}

const kindOf = (code: number): string => `k${code}`
const flagOf = (code: number): string => `f${code}`

/** Handles h(0) … h(n − 1). */
const handlesOf = (n: number, h: (code: number) => string): NonEmptyReadonlyArray<string> => [
	h(0),
	...Arr.makeBy(n - 1, (code) => h(code + 1))
]

const Units = contract("Units", pg.integer, (x) => x.le(5))
const Wild = str.regex("^.*$", "su")
const Short = str.regex("^[a-z]{1,8}$", "u")

/** The generated relations, each holding one generated field g, the read named. */
const generatedReads = {
	GenFlag: { kind: "at", field: "flag" },
	GenN: { kind: "at", field: "n" },
	GenD: { kind: "at", field: "d" },
	GenT: { kind: "at", field: "t" },
	GenU: { kind: "at", field: "u" },
	GenP: { kind: "at", field: "p" },
	GenRowOwn: { kind: "row", of: "own" },
	GenRowPicked: { kind: "row", of: "picked" },
	GenWeightOwn: { kind: "weight", of: "own" },
	GenWeightPicked: { kind: "weight", of: "picked" }
} as const satisfies Readonly<Record<string, Read>>
type Generated = keyof typeof generatedReads

/** The case's schema: its rosters, closed relations, the relations its rules hold, and the generated relations. */
const schemaOf = (c: AbsentCase) => {
	const w = c.world
	const Kind = closed("Kind", handlesOf(w.kinds, kindOf))
	const Flag = closed("Flag", handlesOf(w.flags, flagOf))
	const Pick = closed.relation(
		"Pick",
		{
			kind: closedId(Kind),
			flag: closedId(Flag),
			n: pg.integer,
			d: pg.numeric(3, 1),
			t: Wild,
			u: Units,
			p: Short
		},
		["kind"],
		Arr.flatMap(w.pick, (payload, kind) =>
			payload === undefined
				? []
				: [
						{
							kind: kindOf(kind),
							flag: flagOf(payload.flag),
							n: payload.n,
							d: Decimal.of(tenthsText(payload.d)),
							t: payload.t,
							u: Units(payload.u),
							p: payload.p
						}
					]
		)
	)
	const FlagRel = closed.relation(
		"FlagRel",
		{ from: closedId(Flag), to: closedId(Flag) },
		["from", "to"],
		Arr.flatMap(w.next, (tos, from) =>
			Arr.map(tos, (to) => ({ from: flagOf(from), to: flagOf(to) }))
		)
	)
	const FlagW = closed.relation(
		"FlagW",
		{ flag: closedId(Flag), w: pg.integer },
		["flag"],
		Arr.flatMap(w.weight, (weight, flag) =>
			weight === undefined ? [] : [{ flag: flagOf(flag), w: weight }]
		)
	)
	const Allowed = closed.relation(
		"Allowed",
		{ kind: closedId(Kind), flag: closedId(Flag) },
		["kind", "flag"],
		Arr.flatMap(w.allowed, (flags, kind) =>
			Arr.map(flags, (flag) => ({ kind: kindOf(kind), flag: flagOf(flag) }))
		)
	)
	const itemOf = (name: string) =>
		relation(
			name,
			{
				id: pg.integer,
				kind: closedId(Kind),
				flag: closedId(Flag),
				flags: bits(Flag),
				n: pg.integer,
				d: pg.numeric(3, 1),
				t: Wild,
				u: Units,
				p: Short
			},
			["id"]
		)
	type ItemRow = RowScalars<ReturnType<typeof itemOf>>
	const flagTerm = (r: ItemRow, of: FlagSource) => (of === "own" ? r.flag : Pick.at("flag", r.kind))
	const eqAt = (r: ItemRow, field: PickField, literal: Value | undefined): Predicate => {
		switch (field) {
			case "flag":
				return r.eq(Pick.at("flag", r.kind), typeof literal === "number" ? flagOf(literal) : r.flag)
			case "n":
				return r.eq(Pick.at("n", r.kind), typeof literal === "number" ? literal : r.n)
			case "d":
				return r.eq(
					Pick.at("d", r.kind),
					typeof literal === "number" ? Decimal.of(tenthsText(literal)) : r.d
				)
			case "t":
				return r.eq(Pick.at("t", r.kind), typeof literal === "string" ? literal : r.t)
			case "u":
				return r.eq(Pick.at("u", r.kind), typeof literal === "number" ? literal : r.u)
			case "p":
				return r.eq(Pick.at("p", r.kind), typeof literal === "string" ? literal : r.p)
		}
	}
	const eqRead = (r: ItemRow, read: Read, against: Against): Predicate => {
		const literal = against.kind === "literal" ? against.value : undefined
		switch (read.kind) {
			case "at":
				return eqAt(r, read.field, literal)
			case "row":
				return Compute.eq(
					FlagRel.row(flagTerm(r, read.of)),
					typeof literal === "object" ? Bits.of(Flag, Arr.map(literal, flagOf)) : r.flags
				)
			case "weight":
				return r.eq(
					FlagW.at("w", flagTerm(r, read.of)),
					typeof literal === "number" ? literal : r.n
				)
		}
	}
	const predicate = (p: Pred, r: ItemRow): Predicate => {
		switch (p.kind) {
			case "eq":
				return eqRead(r, p.read, p.against)
			case "subset":
				return r.eq(Compute.subset(FlagRel.row(flagTerm(r, p.of)), r.flags), true)
			case "kind":
				return p.ne ? r.ne(r.kind, kindOf(p.handle)) : r.eq(r.kind, kindOf(p.handle))
			case "and":
			case "or":
				return r[p.kind](predicate(p.args[0], r), predicate(p.args[1], r))
			case "not":
				return r.not(predicate(p.arg, r))
		}
	}
	const Checked0 = itemOf("Checked0")
	const Checked1 = itemOf("Checked1")
	const Contained = itemOf("Contained")
	const Keyed = itemOf("Keyed")
	const genFields = { id: pg.integer, kind: closedId(Kind), flag: closedId(Flag) }
	const generatedRelations = {
		GenFlag: relation.generated("GenFlag", genFields, ["id"], (r) => ({
			g: generated(closedId(Flag), Pick.at("flag", r.kind))
		})),
		GenN: relation.generated("GenN", genFields, ["id"], (r) => ({
			g: generated(pg.integer, Pick.at("n", r.kind))
		})),
		GenD: relation.generated("GenD", genFields, ["id"], (r) => ({
			g: generated(pg.numeric(3, 1), Pick.at("d", r.kind))
		})),
		GenT: relation.generated("GenT", genFields, ["id"], (r) => ({
			g: generated(Wild, Pick.at("t", r.kind))
		})),
		GenU: relation.generated("GenU", genFields, ["id"], (r) => ({
			g: generated(Units, Pick.at("u", r.kind))
		})),
		GenP: relation.generated("GenP", genFields, ["id"], (r) => ({
			g: generated(Short, Pick.at("p", r.kind))
		})),
		GenRowOwn: relation.generated("GenRowOwn", genFields, ["id"], (r) => ({
			g: generated(bits(Flag), FlagRel.row(r.flag))
		})),
		GenRowPicked: relation.generated("GenRowPicked", genFields, ["id"], (r) => ({
			g: generated(bits(Flag), FlagRel.row(Pick.at("flag", r.kind)))
		})),
		GenWeightOwn: relation.generated("GenWeightOwn", genFields, ["id"], (r) => ({
			g: generated(pg.integer, FlagW.at("w", r.flag))
		})),
		GenWeightPicked: relation.generated("GenWeightPicked", genFields, ["id"], (r) => ({
			g: generated(pg.integer, FlagW.at("w", Pick.at("flag", r.kind)))
		}))
	}
	const statements = [
		check("Holds0", Checked0, (r) => predicate(c.checks[0], r)),
		check("Holds1", Checked1, (r) => predicate(c.checks[1], r)),
		contained(
			on(
				select(Contained, (r) => predicate(c.contained, r)),
				"kind",
				"flag"
			),
			on(Allowed, "kind", "flag")
		),
		key(
			on(
				select(Keyed, (r) => predicate(c.keyed, r)),
				"n"
			)
		)
	] as const
	const relations = {
		Kind,
		Flag,
		Pick,
		FlagRel,
		FlagW,
		Allowed,
		Checked0,
		Checked1,
		Contained,
		Keyed,
		...generatedRelations
	}
	return {
		Flag,
		checked: [Checked0, Checked1] as const,
		Contained,
		Keyed,
		generatedRelations,
		Absent: schema("Absent", relations, statements)
	}
}

type Feature =
	| "a check holds of a row with a NULL read"
	| "a check refuses a row it leaves unknown"
	| "a check refuses a row it finds false"
	| "a check reads a set at a NULL prefix"
	| "a check reads the empty set of a flag completed nowhere"
	| "a containment holds of a row its selection leaves unknown, outside its target"
	| "a containment refuses a selected row outside its target"
	| "a key holds apart only its selection: a row it leaves unknown shares a selected value"
	| "a key refuses a selected row at a selected row's value"
	| `${Exclude<Generated, "GenRowOwn">} refused by its NOT NULL`
	| "a generated set stored empty"

const situations: NonEmptyReadonlyArray<Feature> = [
	"a check holds of a row with a NULL read",
	"a check refuses a row it leaves unknown",
	"a check refuses a row it finds false",
	"a check reads a set at a NULL prefix",
	"a check reads the empty set of a flag completed nowhere",
	"a containment holds of a row its selection leaves unknown, outside its target",
	"a containment refuses a selected row outside its target",
	"a key holds apart only its selection: a row it leaves unknown shares a selected value",
	"a key refuses a selected row at a selected row's value",
	"GenFlag refused by its NOT NULL",
	"GenN refused by its NOT NULL",
	"GenD refused by its NOT NULL",
	"GenT refused by its NOT NULL",
	"GenU refused by its NOT NULL",
	"GenP refused by its NOT NULL",
	"GenRowPicked refused by its NOT NULL",
	"GenWeightOwn refused by its NOT NULL",
	"GenWeightPicked refused by its NOT NULL",
	"a generated set stored empty"
]

/** Whether a law is the one `relation` holds: its check, its selection's containment or key, or its generated field. */
const namesLaw = (law: Law, relation: string): boolean => {
	switch (law.kind) {
		case "check":
		case "generated":
			return law.relation === relation
		case "contained":
			return law.from.relation === relation
		case "key":
			return law.side.relation === relation
		case "primaryKey":
		case "coverage":
		case "family":
		case "tree":
		case "fold":
		case "contract":
		case "pattern":
			return false
	}
}

/**
 * Holds a write's outcome to the model's verdict: accepted where the row is lawful, and otherwise refused naming the
 * one law `relation` holds, never a contract's or a pattern's domain, and never a defect.
 */
const verdict = (
	applied: Result.Result<ApplyOutcome<unknown>, unknown>,
	relation: string,
	lawful: boolean,
	where: string
): void => {
	if (!Result.isSuccess(applied)) {
		return assert.fail(
			`${where}: the write is an outcome, not ${Formatter.format(applied.failure)}`
		)
	}
	const outcome = applied.success
	if (lawful) {
		return assert.equal(outcome.kind, "accepted", `${where} is lawful`)
	}
	if (outcome.kind !== "invariant-rejected") {
		return assert.fail(`${where} is unlawful, so refused, not ${outcome.kind}`)
	}
	assert.equal(outcome.laws.length, 1, `${where} breaks one law`)
	assert.ok(
		Arr.every(outcome.laws, (law) => namesLaw(law, relation)),
		`${where} is refused by ${relation}'s law, not ${Formatter.format(outcome.laws)}`
	)
}

/** A generated value as PostgreSQL prints it: a code, an integer, a numeric, a text, or a set's bits. */
const storedText = (w: World, read: Read, value: Value): string =>
	typeof value === "object"
		? setText(w.flags, value)
		: read.kind === "at" && read.field === "d" && typeof value === "number"
			? tenthsText(value)
			: String(value)

/**
 * The rows written into Keyed: each item at every kind, so a row the selection keeps and one it leaves unknown, at a
 * kind Pick holds no row at, share their integer wherever the selection reads Pick.
 */
const keyedRows = (c: AbsentCase): ReadonlyArray<Item> =>
	Arr.flatMap(c.items, (item) => Arr.map(codesBelow(c.world.kinds), (kind) => ({ ...item, kind })))

/** One case: its schema installed, every row written into every relation, and the generated values read back. */
const absentCase = (c: AbsentCase, notes: Case<Feature>) =>
	Effect.gen(function* () {
		const built = schemaOf(c)
		const o = yield* installed(built.Absent, {}, { label: "absent", extensions: [] })
		const names = namesOf(o.installed)
		const w = c.world
		const where = (relation: string, id: number) =>
			`${relation} row ${id} of ${Formatter.format(c)}`
		const itemFact = (item: Item, id: number) => ({
			id,
			kind: kindOf(item.kind),
			flag: flagOf(item.flag),
			flags: Bits.of(built.Flag, Arr.map(item.flags, flagOf)),
			n: item.n,
			d: Decimal.of(tenthsText(item.d)),
			t: item.t,
			u: Units(item.u),
			p: item.p
		})
		const stored = yield* Effect.gen(function* () {
			const db = yield* Db.open(o.server.roles.app, {})
			const empty = ChangeSet.empty(o.schema)
			for (const [at, relation] of built.checked.entries()) {
				const pred = c.checks[at === 0 ? 0 : 1]
				for (const [id, item] of c.items.entries()) {
					const t = truth(w, item, pred)
					const applied = yield* Effect.result(
						db.apply(empty.insert(relation, [itemFact(item, id)]), {})
					)
					verdict(applied, relation.name, t === "true", where(relation.name, id))
					const reads = Arr.map(readsOf(pred), (read) => readOf(w, item, read))
					if (t === "true" && Arr.some(reads, (value) => value === undefined)) {
						notes.note("a check holds of a row with a NULL read")
					}
					if (t === "unknown") {
						notes.note("a check refuses a row it leaves unknown")
					}
					if (t === "false") {
						notes.note("a check refuses a row it finds false")
					}
					if (
						Arr.some(
							readsOf(pred),
							(read) => read.kind === "row" && readOf(w, item, read) === undefined
						)
					) {
						notes.note("a check reads a set at a NULL prefix")
					}
					if (
						Arr.some(readsOf(pred), (read) => {
							const value = read.kind === "row" ? readOf(w, item, read) : undefined
							return typeof value === "object" && value.length === 0
						})
					) {
						notes.note("a check reads the empty set of a flag completed nowhere")
					}
				}
			}
			for (const [id, item] of c.items.entries()) {
				const t = truth(w, item, c.contained)
				const inside = w.allowed[item.kind]?.includes(item.flag) === true
				const applied = yield* Effect.result(
					db.apply(empty.insert(built.Contained, [itemFact(item, id)]), {})
				)
				verdict(applied, "Contained", t !== "true" || inside, where("Contained", id))
				if (!inside) {
					notes.note(
						t === "true"
							? "a containment refuses a selected row outside its target"
							: t === "unknown"
								? "a containment holds of a row its selection leaves unknown, outside its target"
								: "a containment refuses a selected row outside its target"
					)
				}
			}
			const selected: Array<number> = []
			const unknown: Array<number> = []
			for (const [id, item] of keyedRows(c).entries()) {
				const t = truth(w, item, c.keyed)
				const taken = selected.includes(item.n)
				const applied = yield* Effect.result(
					db.apply(empty.insert(built.Keyed, [itemFact(item, id)]), {})
				)
				verdict(applied, "Keyed", t !== "true" || !taken, where("Keyed", id))
				if (taken && t === "true") {
					notes.note("a key refuses a selected row at a selected row's value")
				}
				if (t === "true" && !taken) {
					selected.push(item.n)
				}
				if (t === "unknown") {
					unknown.push(item.n)
				}
			}
			if (Arr.some(unknown, (n) => selected.includes(n))) {
				notes.note(
					"a key holds apart only its selection: a row it leaves unknown shares a selected value"
				)
			}
			const kept: Array<{ readonly relation: Generated; readonly rows: ReadonlyArray<string> }> = []
			for (const [name, read] of Arr.fromRecord(generatedReads)) {
				const relation = built.generatedRelations[name]
				const rows: Array<string> = []
				for (const [id, item] of c.items.entries()) {
					const value = readOf(w, item, read)
					const applied = yield* Effect.result(
						db.apply(
							empty.insert(relation, [{ id, kind: kindOf(item.kind), flag: flagOf(item.flag) }]),
							{}
						)
					)
					verdict(applied, name, value !== undefined, where(name, id))
					if (value === undefined) {
						if (name !== "GenRowOwn") {
							notes.note(`${name} refused by its NOT NULL`)
						}
					} else {
						rows.push(`${id} ${storedText(w, read, value)}`)
						if (read.kind === "row" && typeof value === "object" && value.length === 0) {
							notes.note("a generated set stored empty")
						}
					}
				}
				kept.push({ relation: name, rows })
			}
			return kept
		}).pipe(Effect.scoped, withLayer(o.layer))
		const s = yield* Substrate
		const owner = yield* s.session(ownerSession())
		for (const { relation, rows } of stored) {
			const target = built.generatedRelations[relation]
			const read = yield* owner.values(
				`SELECT ${names.column(target, "id")}::text, ${names.column(target, "g")}::text FROM ${names.table(target)} ORDER BY ${names.column(target, "id")}`,
				[]
			)
			const lines: ReadonlyArray<string> = Arr.map(read, (row) =>
				Arr.join(Arr.map(row, String), " ")
			)
			assert.deepEqual(
				lines,
				rows,
				`${relation} stores each accepted row's read, a set its exact bits: ${Formatter.format(c)}`
			)
		}
	}).pipe(Effect.scoped)

layer(Substrate.layer, { excludeTestServices: true })("a closed read at an absent key", (it) => {
	it.effect("is judged by the rule that reads it, never refused by a domain's cast", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "pg/closed/absent",
					draw: drawn(caseGen),
					literal: Formatter.format,
					oracle: {
						kind: "specification",
						name: "the documented contract over the world's rows: C.at NULL at an absent key, C.row empty where nothing completes its prefix and NULL at a NULL prefix, Kleene's three-valued logic, a selection holding where it is true, and a generated field's NULL refused by its NOT NULL"
					},
					coverage: required<Feature>(situations, { cases: 64, sense: notesOnly }),
					kept: [
						{
							note: "downstream: Kind {a, b} and Flag {x, y}, Pick holds only a → x, FlagSelf the diagonal; SetItem's check or(ne(kind, a), subset(FlagSelf.row(Pick.at(flag, kind)), flags)) and ScalarItem's or(ne(kind, a), eq(Pick.at(flag, kind), x)) hold of kind b with no flags",
							sketch: {
								world: {
									kinds: 2,
									flags: 2,
									pick: [{ flag: 0, n: 0, d: 0, t: "", u: 0, p: "a" }, undefined],
									next: [[0], [1]],
									weight: [undefined, undefined],
									allowed: [[], []]
								},
								checks: [
									{
										kind: "or",
										args: [
											{ kind: "kind", ne: true, handle: 0 },
											{ kind: "subset", of: "picked" }
										]
									},
									{
										kind: "or",
										args: [
											{ kind: "kind", ne: true, handle: 0 },
											{
												kind: "eq",
												read: { kind: "at", field: "flag" },
												against: { kind: "literal", value: 0 }
											}
										]
									}
								],
								contained: { kind: "subset", of: "picked" },
								keyed: { kind: "subset", of: "picked" },
								items: [{ kind: 1, flag: 0, flags: [], n: 0, d: 0, t: "", u: 0, p: "a" }]
							},
							draws: "",
							reaches: [
								"a check holds of a row with a NULL read",
								"a check reads a set at a NULL prefix"
							]
						}
					],
					runs: 24,
					shrink: boundedShrink(40),
					concurrency: 1,
					steerEvery: 8,
					caseHang
				},
				absentCase
			)
		)
	)
})
