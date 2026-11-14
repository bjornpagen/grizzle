/**
 * A closed read at an absent key is judged by the rule that reads it, never refused by a cast, on PostgreSQL 19rc2.
 *
 * The documented contract: `C.at` at a key its closed relation holds no row at reads NULL, `C.row` of a prefix the
 * relation completes nowhere reads the empty set and of a NULL prefix NULL, `C.has` of a key no row holds is false and
 * of a NULL key value NULL, and the rule's three-valued logic decides.
 * A row check holds where its predicate is true, a selection keeps the rows it is true of, and a generated field's
 * NULL term is refused by its column's NOT NULL. Every domain admits NULL, so no cast to a roster's, a set's, a
 * contract's or a pattern's domain refuses a read first.
 *
 * Each case draws a world: rosters Kind and Flag of one to three and one to five handles, so a set over Flag is padded
 * by three bits down to none; Pick, keyed by a kind, whose payload is a flag, an integer, a numeric(3, 1), a text, a
 * contract over an integer and a refined text, holding a drawn subset of the kinds; FlagRel, a set of (from, to) flags,
 * whose row of a flag is its completions, empty for a flag it completes nowhere; FlagW, a flag's integer weight,
 * holding a drawn subset of the flags; Allowed, a set of (kind, flag) pairs; and Slot, keyed by a kind and a flag,
 * whose payload is a flag, holding a drawn subset of the pairs. A read is Pick.at of a payload field at the row's kind,
 * or FlagRel.row, FlagW.at or `Compute.singleton` at the row's own flag or, nested, at Pick.at("flag", kind) or at
 * Slot.at("slot", kind, flag), so FlagRel.row of the slotted flag is the double lookup, a set read whose key is a
 * closed read keyed by two fields, read at a NULL prefix where Slot lacks the pair; or the union of FlagRel.row at the
 * own flag with such a singleton, or a `Compute.cond` over `C.has` of Pick.at at the row's kind or of FlagW.at at a
 * flag, its literal where the key is absent or NULL. A presence is `C.has` of Pick at the row's kind, of FlagW at a
 * flag, of Allowed at the kind and a flag, or of FlagRel at two flags, each flag the own, the picked or the slotted
 * one, so a key value is NULL in every key position. Its positions:
 *
 * - two row checks, each a drawn predicate: a read equal to the row's field of its type or to a literal, the
 *   downstream `Compute.subset(FlagRel.row(…), flags)` equal to true and its converse, the flags within the read, a
 *   flag's membership in a set, `Compute.subset(Compute.singleton(flag), set)` of the own, picked or slotted flag in
 *   the row's flags or a FlagRel.row, a presence, the kind equal or unequal to a handle, and AND, OR and NOT of them,
 *   the guard `or(not(C.has(k…)), φ(C.at(…, k…)))` among them;
 * - a containment of a selection's (kind, flag) into Allowed, under a drawn predicate: a table CHECK whose guard is
 *   the selection;
 * - a key over a selection's integer, under a drawn predicate: a law column `CASE WHEN φ THEN n END`, which grizzle's
 *   writer probes by a query that lowers the selection again. Each drawn row is written at every kind, so a row the
 *   selection keeps and one it leaves unknown share their integer;
 * - a generated field of each read, each its own relation: a closed id, an integer, a numeric, a text, a contract and
 *   a refined text read by Pick.at; a set and an integer read by FlagRel.row and FlagW.at at the own and at the picked
 *   flag; the singleton of the own and of the picked flag; the union of the own flag's FlagRel.row with the picked
 *   flag's singleton; and the conditionals over `C.has`, which store their literal where the key is absent or NULL;
 * - a fold, the sum of an ordered family's integers under a drawn selection of its members. On the host, grizzle's
 *   writer fills it: an owner with every row nested as its members, a stored owner one member put at a time at its
 *   end, and a refill past the first owner's deleted first member; each owner's total must be the sum over the members the
 *   selection makes true. On the server, each stored member's after set to its other branch (its before where the
 *   selection is true, its stepped value where it is false or unknown) must be refused by the fold's CHECK, 23514,
 *   wherever its integer is not 0.
 *
 * Each drawn row is written into each relation by grizzle's writer through the full world's served workload, one
 * insert per call: into a generated relation through the one insert of them all whose call holds the row in that
 * relation alone, and into each other relation through its own. The oracle is the
 * documented contract restated over the world's rows: Kleene's three-valued logic over reads that are NULL exactly at
 * an absent key or a NULL argument. A lawful row is accepted; an unlawful one is `invariant-rejected` naming its
 * relation's one law; and every stored generated value is the read's, a set its exact bits. A domain's refusal of a
 * NULL is a 23514 on a roster's or a set's domain, which grizzle's writer dies with as its own defect, or names a
 * contract's or a pattern's law: neither is what the contract names.
 *
 * The planted bugs: a domain CHECK that refuses NULL refuses the downstream case and every generated closed id, set,
 * contract or pattern field at an absent key; a C.row of a prefix completed nowhere read as NULL refuses a subset
 * check and a generated set the contract stores empty; a host evaluator that reads a closed read at an absent key as
 * unsupported refuses a fold write whose selection it leaves unknown; a fold CHECK that steps where `NOT φ` fails,
 * not where φ holds, refuses the host's fill of such a member; a singleton whose bit is set at its code plus one, or
 * counted from the right, stores another set and decides a membership otherwise; a singleton of a NULL id read as
 * the empty set, on the host or in PostgreSQL, decides a membership the contract leaves unknown and stores a set where
 * the contract refuses the row; a C.has read as NULL at an absent key, on the host or in PostgreSQL, refuses the
 * guard's row the contract holds and skips a fold's member its negation makes true; and a C.has of a NULL key value read
 * as false holds a negated presence the contract leaves unknown.
 *
 * Their patches under ~/.cache/grizzle-release/BR09/plants/, each a .patch: absent-domain-check-refuses-null (the
 * printer's domain CHECK without its VALUE IS NULL arm), absent-host-row-nowhere-null (the host's C.row of a prefix
 * completed nowhere read as NULL), absent-host-at-absent-key-unsupported, absent-fold-steps-where-not-fails,
 * absent-singleton-bit-plus-one, absent-null-singleton-empty (PostgreSQL's singleton of a NULL id the empty set),
 * absent-has-null-at-absent-key (PostgreSQL's C.has) and absent-has-of-null-key-false.
 *
 * A second search holds the downstream's guarded read alone: a row check `or(not(kind = K), ψ)` at a drawn handle K, ψ
 * the double lookup's set, FlagRel.row(Slot.at("slot", kind, flag)), within the row's flags or the flags within it.
 * Each case draws the lookups, K, ψ's direction and one to four rows, each written into Guarded by grizzle's writer and
 * judged by the guarded read restated over the drawn rows in Kleene's logic: accepted where it is true, and otherwise
 * refused naming Guarded's one law. Coverage requires the guard true and false, the inner key held and absent, and the
 * flags empty and not. So a row whose inner key is absent is refused by its check, never accepted, where the guard
 * fails, though its flags be empty: the documented contract reads NULL where a key value is NULL, and the subset of a
 * NULL is unknown. Its plants, under ~/.cache/grizzle-release/MOVED/plants/: absent-row-casts-null (a set's bits
 * domain CHECK without its VALUE IS NULL arm, so FlagRel.row at the NULL of an absent inner key is refused by its cast
 * before the guard holds) and absent-row-reads-empty-as-full (PostgreSQL's C.row read as every handle where its prefix
 * is NULL or completed nowhere, so a row whose flags that read leaves unknown or refuses is accepted).
 *
 * The world's Flag has one to five handles, so a set over it is a whole number of hex digits (four flags) or padded,
 * and a singleton meets the first and the last code; the downstream shape a diagonal closed relation once spelled, a
 * row's own flag in FlagRel.row of the flag its kind picks, is a kept case, at a kind Pick holds and at one it lacks;
 * so is the downstream count bound, a payload compared only where `C.has` holds the key, and the conditional that reads
 * a payload where the key is held and a literal where it is not.
 */
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
import { Array as Arr, Effect, Formatter, Order, Record as Rec, Result } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { ApplyOutcome } from "#adapter/public/db.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { ChangeSet, type Law } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import {
	accumulated,
	Bits,
	bits,
	closedId,
	contract,
	Decimal,
	drawn as drawnField,
	generated,
	natural,
	pg
} from "#compiler/public/fields.ts"
import {
	check,
	closed,
	contained,
	fin,
	fold,
	key,
	Monoid,
	mutable,
	on,
	ordered,
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
import { refusedLaws } from "#test/support/refused.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import { withLayer } from "#test/support/with-layer.ts"

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
 * What the double lookup reads: the sizes of the rosters Kind and Flag; FlagRel's completions of each flag, in code
 * order; and Slot's flag at each kind and flag, undefined where it holds none.
 */
interface Lookups {
	readonly kinds: number
	readonly flags: number
	readonly next: ReadonlyArray<ReadonlyArray<number>>
	readonly slot: ReadonlyArray<ReadonlyArray<number | undefined>>
}

/**
 * The closed relations' rows: the lookups'; Pick's payload at each kind, undefined where it holds none; FlagW's weight
 * at each flag, undefined where it holds none; and Allowed's flags of each kind.
 */
interface World extends Lookups {
	readonly pick: ReadonlyArray<Payload | undefined>
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

/**
 * Where a FlagRel or FlagW read takes its flag: the row's own; Pick.at("flag", kind), NULL at an absent kind; or
 * Slot.at("slot", kind, flag), a read keyed by two fields, NULL at a pair Slot lacks, so FlagRel.row of it is the double
 * lookup.
 */
const flagSources = ["own", "picked", "slotted"] as const
type FlagSource = (typeof flagSources)[number]

/** The Pick fields a conditional over `C.has` reads, each with the literal it takes where Pick holds no row. */
const orFields = ["n", "flag"] as const
type OrField = (typeof orFields)[number]

/** The literal a conditional over `C.has` takes where the key is absent or NULL: no payload a world draws is it. */
const orInteger = 9

type Read =
	| { readonly kind: "at"; readonly field: PickField }
	| { readonly kind: "row"; readonly of: FlagSource }
	| { readonly kind: "weight"; readonly of: FlagSource }
	| { readonly kind: "single"; readonly of: FlagSource }
	| { readonly kind: "joined"; readonly of: FlagSource }
	| { readonly kind: "atOr"; readonly field: OrField }
	| { readonly kind: "weightOr"; readonly of: FlagSource }

/**
 * The key a presence reads: Pick's at the row's kind; FlagW's at a flag; Allowed's at the kind and a flag; FlagRel's at
 * two flags. Each flag is the row's own, or the one its kind picks, NULL where Pick holds no row at the kind.
 */
type HasKey =
	| { readonly relation: "Pick" }
	| { readonly relation: "FlagW"; readonly of: FlagSource }
	| { readonly relation: "Allowed"; readonly of: FlagSource }
	| { readonly relation: "FlagRel"; readonly from: FlagSource; readonly to: FlagSource }

/** The set a membership tests a flag against: the row's flags, or FlagRel.row at the own or the picked flag. */
type Within = { readonly kind: "flags" } | { readonly kind: "row"; readonly of: FlagSource }

/** A value a read or a row's field holds: a code, an integer or tenths, a text, or a set's codes in order. */
type Value = number | string | ReadonlyArray<number>

type Against = { readonly kind: "field" } | { readonly kind: "literal"; readonly value: Value }

type Pred =
	| { readonly kind: "eq"; readonly read: Read; readonly against: Against }
	| { readonly kind: "subset"; readonly of: FlagSource }
	| { readonly kind: "admits"; readonly of: FlagSource }
	| { readonly kind: "member"; readonly of: FlagSource; readonly within: Within }
	| { readonly kind: "has"; readonly key: HasKey }
	| { readonly kind: "kind"; readonly ne: boolean; readonly handle: number }
	| { readonly kind: "and" | "or"; readonly args: readonly [Pred, Pred] }
	| { readonly kind: "not"; readonly arg: Pred }

/**
 * The downstream's guarded read, `or(not(kind = K), ψ)` at the handle K: ψ the double lookup's set within the row's
 * flags (`subset`), or the row's flags within it (`admits`).
 */
interface Guarded {
	readonly handle: number
	readonly leaf: "subset" | "admits"
}

interface AbsentCase {
	readonly world: World
	readonly checks: readonly [Pred, Pred]
	readonly contained: Pred
	readonly keyed: Pred
	readonly folded: Pred
	readonly items: NonEmptyReadonlyArray<Item>
}

/** A row the guarded read is written against: its kind and flag codes, and its set of flags. */
interface GuardedRow extends Keys {
	readonly flags: ReadonlyArray<number>
}

/** A case of the guarded read: its lookups, the guard's handle and ψ's direction, and the rows written. */
interface GuardedCase extends Lookups {
	readonly guarded: Guarded
	readonly rows: NonEmptyReadonlyArray<GuardedRow>
}

const guardTruths = ["holds", "fails"] as const
const innerKeys = ["held", "absent"] as const
const flagFills = ["empty", "not empty"] as const

/** A situation of the guarded read: its guard's truth, its inner key's presence, and whether the row's flags are empty. */
type GuardedFeature =
	`the guarded read: the guard ${(typeof guardTruths)[number]}, the double lookup's inner key ${(typeof innerKeys)[number]}, the flags ${(typeof flagFills)[number]}`

const guardedFeature = (
	guard: (typeof guardTruths)[number],
	inner: (typeof innerKeys)[number],
	fill: (typeof flagFills)[number]
): GuardedFeature =>
	`the guarded read: the guard ${guard}, the double lookup's inner key ${inner}, the flags ${fill}`

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
const codesBelow = (n: number): ReadonlyArray<number> => upTo(n, (code) => code)

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

/** Rosters of one to three kinds and one to five flags, each flag's completions, and Slot holding a drawn subset of the pairs. */
const lookupsGen: Gen<Lookups> = (s) => {
	const kinds = s.draw(int(1, 3))
	const flags = s.draw(int(1, 5))
	const codes = codesBelow(flags)
	return {
		kinds,
		flags,
		next: Arr.map(codes, () => s.draw(subarray(codes))),
		slot: Arr.map(codesBelow(kinds), () =>
			Arr.map(codes, () => (s.draw(boolean) ? s.draw(int(0, flags - 1)) : undefined))
		)
	}
}

const worldGen: Gen<World> = (s) => {
	const lookups = s.draw(lookupsGen)
	const codes = codesBelow(lookups.flags)
	return {
		...lookups,
		pick: Arr.map(codesBelow(lookups.kinds), () =>
			s.draw(boolean) ? s.draw(payloadGen(lookups.flags)) : undefined
		),
		weight: Arr.map(codes, () => (s.draw(boolean) ? s.draw(smallInt) : undefined)),
		allowed: Arr.map(codesBelow(lookups.kinds), () => s.draw(subarray(codes)))
	}
}

/**
 * A guarded case: its lookups, a handle K of its kinds, ψ's direction, and one to four rows, each of a drawn kind, flag
 * and set of flags.
 */
const guardedCaseGen: Gen<GuardedCase> = (s) => {
	const lookups = s.draw(lookupsGen)
	const row: Gen<GuardedRow> = (t) => ({
		kind: t.draw(int(0, lookups.kinds - 1)),
		flag: t.draw(int(0, lookups.flags - 1)),
		flags: t.draw(subarray(codesBelow(lookups.flags)))
	})
	return {
		...lookups,
		guarded: {
			handle: s.draw(int(0, lookups.kinds - 1)),
			leaf: s.draw(element(["subset", "admits"] as const))
		},
		rows: [s.draw(row), ...s.draw(array(row, { min: 0, max: 3 }))]
	}
}

const readGen: Gen<Read> = oneOf<Read>([
	(s) => ({ kind: "at", field: s.draw(element(pickFields)) }),
	(s) => ({ kind: "row", of: s.draw(element(flagSources)) }),
	(s) => ({ kind: "weight", of: s.draw(element(flagSources)) }),
	(s) => ({ kind: "single", of: s.draw(element(flagSources)) }),
	(s) => ({ kind: "joined", of: s.draw(element(flagSources)) }),
	(s) => ({ kind: "atOr", field: s.draw(element(orFields)) }),
	(s) => ({ kind: "weightOr", of: s.draw(element(flagSources)) })
])

const hasKeyGen: Gen<HasKey> = oneOf<HasKey>([
	() => ({ relation: "Pick" }),
	(s) => ({ relation: "FlagW", of: s.draw(element(flagSources)) }),
	(s) => ({ relation: "Allowed", of: s.draw(element(flagSources)) }),
	(s) => ({
		relation: "FlagRel",
		from: s.draw(element(flagSources)),
		to: s.draw(element(flagSources))
	})
])

const withinGen: Gen<Within> = oneOf<Within>([
	() => ({ kind: "flags" }),
	(s) => ({ kind: "row", of: s.draw(element(flagSources)) })
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
		case "single":
		case "joined":
			return subarray(codesBelow(w.flags))
		case "weight":
		case "weightOr":
			return oneOf<Value>([smallInt, () => orInteger])
		case "atOr":
			return read.field === "n" ? oneOf<Value>([smallInt, () => orInteger]) : int(0, w.flags - 1)
	}
}

/**
 * A leaf: a read compared, a FlagRel.row within the flags or the flags within it, a membership, the downstream
 * membership of the own flag in FlagRel.row of the flag its kind picks, NULL at a kind Pick lacks, a presence or its
 * negation, the guard that compares Pick's payload only where Pick holds the row's kind, or the kind compared with a
 * handle.
 */
const leafGen = (w: World): Gen<Pred> =>
	oneOf<Pred>([
		(s) => ({ kind: "has", key: s.draw(hasKeyGen) }),
		(s) => ({ kind: "not", arg: { kind: "has", key: s.draw(hasKeyGen) } }),
		(s) => {
			const field = s.draw(element(pickFields))
			const read: Read = { kind: "at", field }
			return {
				kind: "or",
				args: [
					{ kind: "not", arg: { kind: "has", key: { relation: "Pick" } } },
					{
						kind: "eq",
						read,
						against: s.draw(boolean)
							? { kind: "field" }
							: { kind: "literal", value: s.draw(literalGen(w, read)) }
					}
				]
			}
		},
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
		(s) => ({ kind: "admits", of: s.draw(element(flagSources)) }),
		(s) => ({ kind: "member", of: s.draw(element(flagSources)), within: s.draw(withinGen) }),
		() => ({ kind: "member", of: "own", within: { kind: "row", of: "picked" } }),
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
		folded: s.draw(pred),
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

/**
 * The flag a FlagRel or FlagW read keys on: undefined, NULL, where it is Pick's at a kind Pick holds no row at, or
 * Slot's at a kind and flag Slot holds no row at.
 */
const flagFrom = (w: World, keys: Keys, of: FlagSource): number | undefined => {
	switch (of) {
		case "own":
			return keys.flag
		case "picked":
			return w.pick[keys.kind]?.flag
		case "slotted":
			return w.slot[keys.kind]?.[keys.flag]
	}
}

/**
 * Whether a presence's relation holds its key at a row: undefined, NULL, where a key value is NULL, a flag picked at a
 * kind Pick holds no row at.
 */
const heldOf = (w: World, keys: Keys, key: HasKey): boolean | undefined => {
	switch (key.relation) {
		case "Pick":
			return w.pick[keys.kind] !== undefined
		case "FlagW": {
			const flag = flagFrom(w, keys, key.of)
			return flag === undefined ? undefined : w.weight[flag] !== undefined
		}
		case "Allowed": {
			const flag = flagFrom(w, keys, key.of)
			return flag === undefined ? undefined : w.allowed[keys.kind]?.includes(flag) === true
		}
		case "FlagRel": {
			const from = flagFrom(w, keys, key.from)
			const to = flagFrom(w, keys, key.to)
			return from === undefined || to === undefined
				? undefined
				: w.next[from]?.includes(to) === true
		}
	}
}

/** A read's value over a row, undefined where it is NULL: at an absent key, or at a NULL argument. */
const readOf = (w: World, keys: Keys, read: Read): Value | undefined => {
	switch (read.kind) {
		case "atOr": {
			const payload = w.pick[keys.kind]
			return payload !== undefined
				? payload[read.field]
				: read.field === "n"
					? orInteger
					: w.flags - 1
		}
		case "weightOr": {
			const flag = flagFrom(w, keys, read.of)
			return (flag === undefined ? undefined : w.weight[flag]) ?? orInteger
		}
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
		case "single": {
			const flag = flagFrom(w, keys, read.of)
			return flag === undefined ? undefined : [flag]
		}
		case "joined": {
			const flag = flagFrom(w, keys, read.of)
			return flag === undefined
				? undefined
				: Arr.sort(Arr.dedupe([...(w.next[keys.flag] ?? []), flag]), Order.Number)
		}
	}
}

/** The row's own field a read is compared with: the field of its type, the integer for a weight. */
const fieldOf = (item: Item, read: Read): Value => {
	switch (read.kind) {
		case "at":
		case "atOr":
			return item[read.field]
		case "row":
		case "single":
		case "joined":
			return item.flags
		case "weight":
		case "weightOr":
			return item.n
	}
}

const sameValue = (a: Value, b: Value): boolean =>
	typeof a === "object" && typeof b === "object"
		? a.length === b.length && Arr.every(a, (x, i) => x === b[i])
		: a === b

/** A membership's flag and set over a row, each undefined where it is NULL. */
const membershipOf = (
	w: World,
	item: Item,
	p: Extract<Pred, { readonly kind: "member" }>
): { readonly flag: number | undefined; readonly set: ReadonlyArray<number> | undefined } => {
	const set =
		p.within.kind === "flags" ? item.flags : readOf(w, item, { kind: "row", of: p.within.of })
	return { flag: flagFrom(w, item, p.of), set: typeof set === "object" ? set : undefined }
}

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
		case "admits": {
			const set = readOf(w, item, { kind: "row", of: p.of })
			return set === undefined || typeof set !== "object"
				? "unknown"
				: truthOf(Arr.every(item.flags, (code) => set.includes(code)))
		}
		case "member": {
			const { flag, set } = membershipOf(w, item, p)
			return flag === undefined || set === undefined ? "unknown" : truthOf(set.includes(flag))
		}
		case "has": {
			const held = heldOf(w, item, p.key)
			return held === undefined ? "unknown" : truthOf(held)
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

/** Every membership a predicate states. */
const membershipsOf = (p: Pred): ReadonlyArray<Extract<Pred, { readonly kind: "member" }>> => {
	switch (p.kind) {
		case "member":
			return [p]
		case "eq":
		case "subset":
		case "admits":
		case "has":
		case "kind":
			return []
		case "and":
		case "or":
			return [...membershipsOf(p.args[0]), ...membershipsOf(p.args[1])]
		case "not":
			return membershipsOf(p.arg)
	}
}

/** Every read a predicate states. */
const readsOf = (p: Pred): ReadonlyArray<Read> => {
	switch (p.kind) {
		case "eq":
			return [p.read]
		case "subset":
		case "admits":
			return [{ kind: "row", of: p.of }]
		case "member":
			return [
				{ kind: "single", of: p.of },
				...(p.within.kind === "row" ? [{ kind: "row", of: p.within.of } as const] : [])
			]
		case "has":
		case "kind":
			return []
		case "and":
		case "or":
			return [...readsOf(p.args[0]), ...readsOf(p.args[1])]
		case "not":
			return readsOf(p.arg)
	}
}

/** Every presence a predicate negates directly, `not(C.has(k…))`. */
const negatedPresencesOf = (p: Pred): ReadonlyArray<HasKey> => {
	switch (p.kind) {
		case "not":
			return p.arg.kind === "has" ? [p.arg.key] : negatedPresencesOf(p.arg)
		case "eq":
		case "subset":
		case "admits":
		case "member":
		case "has":
		case "kind":
			return []
		case "and":
		case "or":
			return [...negatedPresencesOf(p.args[0]), ...negatedPresencesOf(p.args[1])]
	}
}

/** Every presence a predicate states. */
const presencesOf = (p: Pred): ReadonlyArray<HasKey> => {
	switch (p.kind) {
		case "has":
			return [p.key]
		case "eq":
		case "subset":
		case "admits":
		case "member":
		case "kind":
			return []
		case "and":
		case "or":
			return [...presencesOf(p.args[0]), ...presencesOf(p.args[1])]
		case "not":
			return presencesOf(p.arg)
	}
}

/**
 * The double lookup's set at a row, FlagRel.row(Slot.at("slot", kind, flag)): the completions of Slot's flag at the
 * row's kind and flag, empty for a flag completed nowhere, and undefined, NULL, where Slot holds no row at the pair.
 */
const lookedUp = (c: GuardedCase, row: GuardedRow): ReadonlyArray<number> | undefined => {
	const slot = c.slot[row.kind]?.[row.flag]
	return slot === undefined ? undefined : c.next[slot]
}

/**
 * The guarded read's truth at a row, in Kleene's logic: `not(kind = K)` or ψ, ψ unknown where the double lookup is NULL,
 * else the lookup's set within the row's flags (`subset`) or the flags within it (`admits`).
 */
const guardedTruth = (c: GuardedCase, row: GuardedRow): Truth => {
	const set = lookedUp(c, row)
	const within: Truth =
		set === undefined
			? "unknown"
			: truthOf(
					c.guarded.leaf === "subset"
						? Arr.every(set, (code) => row.flags.includes(code))
						: Arr.every(row.flags, (code) => set.includes(code))
				)
	return either(truthOf(row.kind !== c.guarded.handle), within)
}

const kindOf = (code: number): string => `k${code}`
const flagOf = (code: number): string => `f${code}`

/** Handles h(0) … h(n − 1). */
const handlesOf = (n: number, h: (code: number) => string): NonEmptyReadonlyArray<string> => [
	h(0),
	...upTo(n - 1, (code) => h(code + 1))
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
	GenWeightPicked: { kind: "weight", of: "picked" },
	GenSingleOwn: { kind: "single", of: "own" },
	GenSinglePicked: { kind: "single", of: "picked" },
	GenJoinedPicked: { kind: "joined", of: "picked" },
	GenOrN: { kind: "atOr", field: "n" },
	GenOrFlag: { kind: "atOr", field: "flag" },
	GenOrWeightPicked: { kind: "weightOr", of: "picked" }
} as const satisfies Readonly<Record<string, Read>>
type Generated = keyof typeof generatedReads

/**
 * The generated relations whose read is never NULL: each reads the row's own flag alone, or takes its literal where
 * its presence is false or NULL.
 */
const neverNull = ["GenRowOwn", "GenSingleOwn", "GenOrN", "GenOrFlag", "GenOrWeightPicked"] as const
type NeverNull = (typeof neverNull)[number]

/** Whether a generated relation's read may be NULL: it is none of neverNull. */
const nullable = (name: Generated): name is Exclude<Generated, NeverNull> =>
	!Arr.some(neverNull, (n) => n === name)

/** The lookups' rosters Kind and Flag and closed relations FlagRel and Slot. */
const lookupsOf = (sizes: Lookups) => {
	const Kind = closed("Kind", handlesOf(sizes.kinds, kindOf))
	const Flag = closed("Flag", handlesOf(sizes.flags, flagOf))
	const FlagRel = closed.relation(
		"FlagRel",
		{ from: closedId(Flag), to: closedId(Flag) },
		["from", "to"],
		Arr.flatMap(sizes.next, (tos, from) =>
			Arr.map(tos, (to) => ({ from: flagOf(from), to: flagOf(to) }))
		)
	)
	const Slot = closed.relation(
		"Slot",
		{ kind: closedId(Kind), flag: closedId(Flag), slot: closedId(Flag) },
		["kind", "flag"],
		Arr.flatMap(sizes.slot, (slots, kind) =>
			Arr.flatMap(slots, (slot, flag) =>
				slot === undefined ? [] : [{ kind: kindOf(kind), flag: flagOf(flag), slot: flagOf(slot) }]
			)
		)
	)
	return { Kind, Flag, FlagRel, Slot }
}

/**
 * The case's schema: its rosters, closed relations, the relations its rules hold, and the generated relations; and its
 * full world's workload, an insert into each relation its rules hold, one insert of every generated relation, an
 * owner's insert, and a member's put and delete, each of the facts each call gives.
 */
const schemaOf = (c: AbsentCase) => {
	const w = c.world
	const { Kind, Flag, FlagRel, Slot } = lookupsOf(w)
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
	const itemFields = {
		id: pg.integer,
		kind: closedId(Kind),
		flag: closedId(Flag),
		flags: bits(Flag),
		n: pg.integer,
		d: pg.numeric(3, 1),
		t: Wild,
		u: Units,
		p: Short
	}
	const itemOf = (name: string) => relation(name, itemFields, ["id"])
	type ItemRow = RowScalars<ReturnType<typeof itemOf>>
	const flagTerm = (r: ItemRow, of: FlagSource) => {
		switch (of) {
			case "own":
				return r.flag
			case "picked":
				return Pick.at("flag", r.kind)
			case "slotted":
				return Slot.at("slot", r.kind, r.flag)
		}
	}
	const joinedTerm = (r: ItemRow, of: FlagSource) =>
		Compute.union(FlagRel.row(r.flag), Compute.singleton(flagTerm(r, of)))
	const presence = (r: ItemRow, key: HasKey): Predicate => {
		switch (key.relation) {
			case "Pick":
				return Pick.has(r.kind)
			case "FlagW":
				return FlagW.has(flagTerm(r, key.of))
			case "Allowed":
				return Allowed.has(r.kind, flagTerm(r, key.of))
			case "FlagRel":
				return FlagRel.has(flagTerm(r, key.from), flagTerm(r, key.to))
		}
	}
	const orN = (r: ItemRow) => Compute.cond(Pick.has(r.kind), Pick.at("n", r.kind), orInteger)
	const orFlag = (r: ItemRow) =>
		Compute.cond(Pick.has(r.kind), Pick.at("flag", r.kind), flagOf(w.flags - 1))
	const orWeight = (r: ItemRow, of: FlagSource) =>
		Compute.cond(FlagW.has(flagTerm(r, of)), FlagW.at("w", flagTerm(r, of)), orInteger)
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
			case "single":
				return Compute.eq(
					Compute.singleton(flagTerm(r, read.of)),
					typeof literal === "object" ? Bits.of(Flag, Arr.map(literal, flagOf)) : r.flags
				)
			case "joined":
				return Compute.eq(
					joinedTerm(r, read.of),
					typeof literal === "object" ? Bits.of(Flag, Arr.map(literal, flagOf)) : r.flags
				)
			case "atOr":
				return read.field === "n"
					? r.eq(orN(r), typeof literal === "number" ? literal : r.n)
					: r.eq(orFlag(r), typeof literal === "number" ? flagOf(literal) : r.flag)
			case "weightOr":
				return r.eq(orWeight(r, read.of), typeof literal === "number" ? literal : r.n)
		}
	}
	const predicate = (p: Pred, r: ItemRow): Predicate => {
		switch (p.kind) {
			case "eq":
				return eqRead(r, p.read, p.against)
			case "subset":
				return r.eq(Compute.subset(FlagRel.row(flagTerm(r, p.of)), r.flags), true)
			case "admits":
				return r.eq(Compute.subset(r.flags, FlagRel.row(flagTerm(r, p.of))), true)
			case "member":
				return r.eq(
					Compute.subset(
						Compute.singleton(flagTerm(r, p.of)),
						p.within.kind === "flags" ? r.flags : FlagRel.row(flagTerm(r, p.within.of))
					),
					true
				)
			case "has":
				return presence(r, p.key)
			case "kind":
				return p.ne ? r.ne(r.kind, kindOf(p.handle)) : r.eq(r.kind, kindOf(p.handle))
			case "and":
			case "or":
				return r[p.kind](predicate(p.args[0], r), predicate(p.args[1], r))
			case "not":
				return r.not(predicate(p.arg, r))
		}
	}
	const Owner = relation(
		"Owner",
		{ id: pg.integer, members: drawnField(natural), total: accumulated(pg.integer, 0) },
		["id"]
	)
	const Member = relation(
		"Member",
		{
			...itemFields,
			owner: pg.integer,
			at: drawnField(natural),
			before: accumulated(pg.integer, 0),
			after: accumulated(pg.integer, 0)
		},
		["id"]
	)
	const members = ordered(on(Member, "owner", "at"), fin(Owner, "members"))
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
		})),
		GenSingleOwn: relation.generated("GenSingleOwn", genFields, ["id"], (r) => ({
			g: generated(bits(Flag), Compute.singleton(r.flag))
		})),
		GenSinglePicked: relation.generated("GenSinglePicked", genFields, ["id"], (r) => ({
			g: generated(bits(Flag), Compute.singleton(Pick.at("flag", r.kind)))
		})),
		GenJoinedPicked: relation.generated("GenJoinedPicked", genFields, ["id"], (r) => ({
			g: generated(
				bits(Flag),
				Compute.union(FlagRel.row(r.flag), Compute.singleton(Pick.at("flag", r.kind)))
			)
		})),
		GenOrN: relation.generated("GenOrN", genFields, ["id"], (r) => ({
			g: generated(pg.integer, Compute.cond(Pick.has(r.kind), Pick.at("n", r.kind), orInteger))
		})),
		GenOrFlag: relation.generated("GenOrFlag", genFields, ["id"], (r) => ({
			g: generated(
				closedId(Flag),
				Compute.cond(Pick.has(r.kind), Pick.at("flag", r.kind), flagOf(w.flags - 1))
			)
		})),
		GenOrWeightPicked: relation.generated("GenOrWeightPicked", genFields, ["id"], (r) => ({
			g: generated(
				pg.integer,
				Compute.cond(
					FlagW.has(Pick.at("flag", r.kind)),
					FlagW.at("w", Pick.at("flag", r.kind)),
					orInteger
				)
			)
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
		),
		members,
		fold(
			members,
			Monoid.sum,
			on(
				select(Member, (r) => predicate(c.folded, r)),
				"owner",
				"n",
				"before",
				"after"
			),
			on(Owner, "id", "total")
		),
		mutable(Owner)
	] as const
	const relations = {
		Kind,
		Flag,
		Pick,
		FlagRel,
		FlagW,
		Allowed,
		Slot,
		Checked0,
		Checked1,
		Contained,
		Keyed,
		Owner,
		Member,
		...generatedRelations
	}
	const Absent = schema("Absent", relations, statements)
	return {
		Flag,
		checked: [Checked0, Checked1] as const,
		Owner,
		Member,
		generatedRelations,
		Absent,
		programs: {
			insertChecked0: ChangeSet.empty(Absent).insert(Checked0, []),
			insertChecked1: ChangeSet.empty(Absent).insert(Checked1, []),
			insertContained: ChangeSet.empty(Absent).insert(Contained, []),
			insertKeyed: ChangeSet.empty(Absent).insert(Keyed, []),
			insertGenerated: ChangeSet.empty(Absent).insertAll({
				GenFlag: [],
				GenN: [],
				GenD: [],
				GenT: [],
				GenU: [],
				GenP: [],
				GenRowOwn: [],
				GenRowPicked: [],
				GenWeightOwn: [],
				GenWeightPicked: [],
				GenSingleOwn: [],
				GenSinglePicked: [],
				GenJoinedPicked: [],
				GenOrN: [],
				GenOrFlag: [],
				GenOrWeightPicked: []
			}),
			insertOwner: ChangeSet.empty(Absent).insert(Owner, []),
			putMember: ChangeSet.empty(Absent).put(Member, []),
			deleteMember: ChangeSet.empty(Absent).delete(Member, [])
		}
	}
}

/**
 * The guarded case's schema: its lookups, and Guarded, whose row check is the downstream's guarded read; and its full
 * world's workload, an insert into Guarded.
 */
const guardedSchemaOf = (c: GuardedCase) => {
	const { Kind, Flag, FlagRel, Slot } = lookupsOf(c)
	const Guarded = relation(
		"Guarded",
		{ id: pg.integer, kind: closedId(Kind), flag: closedId(Flag), flags: bits(Flag) },
		["id"]
	)
	const guards = check("Guards", Guarded, (r) =>
		r.or(
			r.not(r.eq(r.kind, kindOf(c.guarded.handle))),
			c.guarded.leaf === "subset"
				? r.eq(Compute.subset(FlagRel.row(Slot.at("slot", r.kind, r.flag)), r.flags), true)
				: r.eq(Compute.subset(r.flags, FlagRel.row(Slot.at("slot", r.kind, r.flag))), true)
		)
	)
	const Lookup = schema("Lookup", { Kind, Flag, FlagRel, Slot, Guarded }, [guards])
	return {
		Flag,
		Guarded,
		Lookup,
		programs: { insertGuarded: ChangeSet.empty(Lookup).insert(Guarded, []) }
	}
}

/** Every situation of the guarded read: the guard true and false, the inner key held and absent, the flags empty and not. */
const guardedSituations: NonEmptyReadonlyArray<GuardedFeature> = Arr.flatMap(guardTruths, (guard) =>
	Arr.flatMap(innerKeys, (inner) =>
		Arr.map(flagFills, (fill) => guardedFeature(guard, inner, fill))
	)
)

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
	| "a check finds a membership true"
	| "a check finds a membership false"
	| "a check leaves a membership unknown at a NULL id"
	| "a check leaves a membership unknown at a NULL set"
	| "a containment's selection reads a membership"
	| "a key's selection reads a membership"
	| "a fold's selection reads a membership"
	| "a check finds a key held"
	| "a check finds a key absent"
	| "a check leaves a presence unknown at a NULL key value"
	| "a check leaves a negated presence unknown at a NULL key value"
	| "a check holds of a row at a key its presence finds absent"
	| "a containment's selection reads a presence"
	| "a key's selection reads a presence"
	| "a fold's selection reads a presence"
	| "a conditional stores its payload at a held key"
	| "a conditional stores its literal at an absent key"
	| "a conditional stores its literal at a NULL key value"
	| `${Exclude<Generated, NeverNull>} refused by its NOT NULL`
	| "a generated set stored empty"
	| "a singleton stored at the first code"
	| "a singleton stored at the last code"
	| "a singleton stored over a roster of whole hex digits"
	| "a singleton stored over a padded roster"
	| "a fold steps a member its selection makes true"
	| "a fold skips a member its selection leaves unknown, filled with its owner"
	| "a fold skips a member its selection leaves unknown, filled into a stored owner"
	| "a fold refills past a deleted member, skipping one its selection leaves unknown"
	| "the fold's CHECK refuses the unstepped after of a member its selection makes true"
	| "the fold's CHECK refuses the stepped after of a member its selection leaves unknown"
	| "the fold's CHECK refuses the stepped after of a member its selection makes false"

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
	"GenSinglePicked refused by its NOT NULL",
	"GenJoinedPicked refused by its NOT NULL",
	"a generated set stored empty",
	"a check finds a membership true",
	"a check finds a membership false",
	"a check leaves a membership unknown at a NULL id",
	"a check leaves a membership unknown at a NULL set",
	"a containment's selection reads a membership",
	"a key's selection reads a membership",
	"a fold's selection reads a membership",
	"a check finds a key held",
	"a check finds a key absent",
	"a check leaves a presence unknown at a NULL key value",
	"a check leaves a negated presence unknown at a NULL key value",
	"a check holds of a row at a key its presence finds absent",
	"a containment's selection reads a presence",
	"a key's selection reads a presence",
	"a fold's selection reads a presence",
	"a conditional stores its payload at a held key",
	"a conditional stores its literal at an absent key",
	"a conditional stores its literal at a NULL key value",
	"a singleton stored at the first code",
	"a singleton stored at the last code",
	"a singleton stored over a roster of whole hex digits",
	"a singleton stored over a padded roster",
	"a fold steps a member its selection makes true",
	"a fold skips a member its selection leaves unknown, filled with its owner",
	"a fold skips a member its selection leaves unknown, filled into a stored owner",
	"a fold refills past a deleted member, skipping one its selection leaves unknown",
	"the fold's CHECK refuses the unstepped after of a member its selection makes true",
	"the fold's CHECK refuses the stepped after of a member its selection leaves unknown"
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
		case "above":
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
	assert.equal(refusedLaws(outcome.refused).length, 1, `${where} breaks one law`)
	assert.ok(
		Arr.every(refusedLaws(outcome.refused), (law) => namesLaw(law, relation)),
		`${where} is refused by ${relation}'s law, not ${Formatter.format(refusedLaws(outcome.refused))}`
	)
}

/** A generated value as PostgreSQL prints it: a code, an integer, a numeric, a text, or a set's bits. */
const storedText = (w: World, read: Read, value: Value): string =>
	typeof value === "object"
		? setText(w.flags, value)
		: read.kind === "at" && read.field === "d" && typeof value === "number"
			? tenthsText(value)
			: String(value)

/** The id of the member of the stored owner 1 the item at `i` is written as, one insert each. */
const memberOfLater = (i: number): number => 100 + i

/** An owner's fold total over `members`: the sum of the integers of the members its selection makes true. */
const foldedTotal = (c: AbsentCase, members: ReadonlyArray<Item>): number =>
	Arr.reduce(members, 0, (sum, item) =>
		truth(c.world, item, c.folded) === "true" ? sum + item.n : sum
	)

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
		const o = yield* installed(
			built.Absent,
			{},
			{
				label: "absent",
				extensions: [],
				programs: built.programs
			}
		)
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
			const db = yield* Db.open(o.served.login.roles.app, {})
			for (const [at, relation] of built.checked.entries()) {
				const pred = c.checks[at === 0 ? 0 : 1]
				for (const [id, item] of c.items.entries()) {
					const t = truth(w, item, pred)
					const applied = yield* Effect.result(
						at === 0
							? db.workload.insertChecked0.apply({ insert: { Checked0: [itemFact(item, id)] } }, {})
							: db.workload.insertChecked1.apply({ insert: { Checked1: [itemFact(item, id)] } }, {})
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
					for (const membership of membershipsOf(pred)) {
						const { flag, set } = membershipOf(w, item, membership)
						notes.note(
							flag === undefined
								? "a check leaves a membership unknown at a NULL id"
								: set === undefined
									? "a check leaves a membership unknown at a NULL set"
									: set.includes(flag)
										? "a check finds a membership true"
										: "a check finds a membership false"
						)
					}
					const held = Arr.map(presencesOf(pred), (key) => heldOf(w, item, key))
					for (const presence of held) {
						notes.note(
							presence === undefined
								? "a check leaves a presence unknown at a NULL key value"
								: presence
									? "a check finds a key held"
									: "a check finds a key absent"
						)
					}
					if (t === "true" && Arr.some(held, (presence) => presence === false)) {
						notes.note("a check holds of a row at a key its presence finds absent")
					}
					if (Arr.some(negatedPresencesOf(pred), (key) => heldOf(w, item, key) === undefined)) {
						notes.note("a check leaves a negated presence unknown at a NULL key value")
					}
				}
			}
			if (membershipsOf(c.contained).length > 0) {
				notes.note("a containment's selection reads a membership")
			}
			if (membershipsOf(c.keyed).length > 0) {
				notes.note("a key's selection reads a membership")
			}
			if (membershipsOf(c.folded).length > 0) {
				notes.note("a fold's selection reads a membership")
			}
			if (presencesOf(c.contained).length > 0) {
				notes.note("a containment's selection reads a presence")
			}
			if (presencesOf(c.keyed).length > 0) {
				notes.note("a key's selection reads a presence")
			}
			if (presencesOf(c.folded).length > 0) {
				notes.note("a fold's selection reads a presence")
			}
			for (const [id, item] of c.items.entries()) {
				const t = truth(w, item, c.contained)
				const inside = w.allowed[item.kind]?.includes(item.flag) === true
				const applied = yield* Effect.result(
					db.workload.insertContained.apply({ insert: { Contained: [itemFact(item, id)] } }, {})
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
					db.workload.insertKeyed.apply({ insert: { Keyed: [itemFact(item, id)] } }, {})
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
				const rows: Array<string> = []
				for (const [id, item] of c.items.entries()) {
					const value = readOf(w, item, read)
					const fact = { id, kind: kindOf(item.kind), flag: flagOf(item.flag) }
					const applied = yield* Effect.result(
						db.workload.insertGenerated.apply(
							{
								insert: Rec.map(built.generatedRelations, (_, relation) =>
									relation === name ? [fact] : []
								)
							},
							{}
						)
					)
					verdict(applied, name, value !== undefined, where(name, id))
					if (read.kind === "atOr" || read.kind === "weightOr") {
						const held =
							read.kind === "atOr"
								? heldOf(w, item, { relation: "Pick" })
								: heldOf(w, item, { relation: "FlagW", of: read.of })
						notes.note(
							held === undefined
								? "a conditional stores its literal at a NULL key value"
								: held
									? "a conditional stores its payload at a held key"
									: "a conditional stores its literal at an absent key"
						)
					}
					if (value === undefined) {
						if (nullable(name)) {
							notes.note(`${name} refused by its NOT NULL`)
						}
					} else {
						rows.push(`${id} ${storedText(w, read, value)}`)
						if (read.kind === "row" && typeof value === "object" && value.length === 0) {
							notes.note("a generated set stored empty")
						}
						if (read.kind === "single" && typeof value === "object") {
							if (value.includes(0)) {
								notes.note("a singleton stored at the first code")
							}
							if (w.flags > 1 && value.includes(w.flags - 1)) {
								notes.note("a singleton stored at the last code")
							}
							notes.note(
								w.flags % 4 === 0
									? "a singleton stored over a roster of whole hex digits"
									: "a singleton stored over a padded roster"
							)
						}
					}
				}
				kept.push({ relation: name, rows })
			}
			const memberFact = (item: Item, id: number, of: number) => ({
				...itemFact(item, id),
				owner: of
			})
			const members = Arr.map(c.items, (item, id) => itemFact(item, id))
			const together = yield* Effect.result(
				db.workload.insertOwner.apply({ insert: { Owner: [{ id: 0, members }] } }, {})
			)
			verdict(together, "Member", true, where("Member", 0))
			const stored = yield* Effect.result(
				db.workload.insertOwner.apply({ insert: { Owner: [{ id: 1, members: [] }] } }, {})
			)
			verdict(stored, "Owner", true, where("Owner", 1))
			for (const [i, item] of c.items.entries()) {
				const one = yield* Effect.result(
					db.workload.putMember.apply(
						{ put: { Member: [memberFact(item, memberOfLater(i), 1)] } },
						{}
					)
				)
				verdict(one, "Member", true, where("Member", memberOfLater(i)))
			}
			const deleted = yield* Effect.result(
				db.workload.deleteMember.apply({ delete: { Member: [memberFact(c.items[0], 0, 0)] } }, {})
			)
			verdict(deleted, "Member", true, where("Member", 0))
			for (const item of c.items) {
				if (item.n > 0 && truth(w, item, c.folded) === "true") {
					notes.note("a fold steps a member its selection makes true")
				}
				if (item.n > 0 && truth(w, item, c.folded) === "unknown") {
					notes.note("a fold skips a member its selection leaves unknown, filled with its owner")
					notes.note(
						"a fold skips a member its selection leaves unknown, filled into a stored owner"
					)
				}
			}
			if (
				c.items.length > 1 &&
				Arr.some(c.items.slice(1), (item) => item.n > 0 && truth(w, item, c.folded) === "unknown")
			) {
				notes.note(
					"a fold refills past a deleted member, skipping one its selection leaves unknown"
				)
			}
			return kept
		}).pipe(Effect.scoped, withLayer(o.served.layer))
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
		const totals = yield* owner.values(
			`SELECT ${names.column(built.Owner, "id")}::text, ${names.column(built.Owner, "total")}::text FROM ${names.table(built.Owner)} ORDER BY ${names.column(built.Owner, "id")}`,
			[]
		)
		const totalLines: ReadonlyArray<string> = Arr.map(totals, (row) =>
			Arr.join(Arr.map(row, String), " ")
		)
		assert.deepEqual(
			totalLines,
			[`0 ${foldedTotal(c, c.items.slice(1))}`, `1 ${foldedTotal(c, c.items)}`],
			`each owner's total sums the members its selection makes true, none it leaves unknown: ${Formatter.format(c)}`
		)
		const probes = [
			...Arr.map(c.items.slice(1), (item, i) => ({ item, id: i + 1 })),
			...Arr.map(c.items, (item, i) => ({ item, id: memberOfLater(i) }))
		]
		for (const { item, id } of probes) {
			const t = truth(w, item, c.folded)
			const before = names.column(built.Member, "before")
			const unstepped = t === "true" ? before : `${before} + ${names.column(built.Member, "n")}`
			const updated = yield* Effect.result(
				owner.query(
					`UPDATE ${names.table(built.Member)} SET ${names.column(built.Member, "after")} = ${unstepped} WHERE ${names.column(built.Member, "id")} = ${id}`,
					[]
				)
			)
			const at = `the stored member ${id}'s after set to its other branch, the selection ${t}, of ${Formatter.format(c)}`
			if (item.n === 0) {
				assert.equal(updated._tag, "Success", `${at} is its own after, so it stands`)
				continue
			}
			const fields = updated._tag === "Failure" ? pgErrorFields(updated.failure) : undefined
			assert.equal(fields?.code, "23514", `${at} is refused by the fold's CHECK`)
			notes.note(
				t === "true"
					? "the fold's CHECK refuses the unstepped after of a member its selection makes true"
					: t === "unknown"
						? "the fold's CHECK refuses the stepped after of a member its selection leaves unknown"
						: "the fold's CHECK refuses the stepped after of a member its selection makes false"
			)
		}
	}).pipe(Effect.scoped)

/** One guarded case: its schema installed, and each row written into Guarded alone, judged by the guarded read's truth. */
const guardedCase = (c: GuardedCase, notes: Case<GuardedFeature>) =>
	Effect.gen(function* () {
		const built = guardedSchemaOf(c)
		const o = yield* installed(
			built.Lookup,
			{},
			{ label: "lookup", extensions: [], programs: built.programs }
		)
		yield* Effect.gen(function* () {
			const db = yield* Db.open(o.served.login.roles.app, {})
			for (const [id, row] of c.rows.entries()) {
				const applied = yield* Effect.result(
					db.workload.insertGuarded.apply(
						{
							insert: {
								Guarded: [
									{
										id,
										kind: kindOf(row.kind),
										flag: flagOf(row.flag),
										flags: Bits.of(built.Flag, Arr.map(row.flags, flagOf))
									}
								]
							}
						},
						{}
					)
				)
				verdict(
					applied,
					built.Guarded.name,
					guardedTruth(c, row) === "true",
					`Guarded row ${id} of ${Formatter.format(c)}`
				)
				notes.note(
					guardedFeature(
						row.kind === c.guarded.handle ? "fails" : "holds",
						lookedUp(c, row) === undefined ? "absent" : "held",
						row.flags.length === 0 ? "empty" : "not empty"
					)
				)
			}
		}).pipe(Effect.scoped, withLayer(o.served.layer))
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
						name: "the documented contract over the world's rows: C.at NULL at an absent key, C.row empty where nothing completes its prefix and NULL at a NULL prefix, C.has false at an absent key and NULL at a NULL key value, Kleene's three-valued logic, a selection holding where it is true, and a generated field's NULL refused by its NOT NULL"
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
									allowed: [[], []],
									slot: [
										[undefined, undefined],
										[undefined, undefined]
									]
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
								folded: { kind: "subset", of: "picked" },
								items: [{ kind: 1, flag: 0, flags: [], n: 0, d: 0, t: "", u: 0, p: "a" }]
							},
							draws: "",
							reaches: [
								"a check holds of a row with a NULL read",
								"a check reads a set at a NULL prefix"
							]
						},
						{
							note: "downstream, with no diagonal: Kind {a, b} and Flag {x, y}, Pick holds only a → x, FlagRel x → {x} and y → {x, y}; Checked0's or(ne(kind, a), subset(singleton(flag), FlagRel.row(Pick.at(flag, kind)))) holds of kind a with flag x and of kind b, whose Pick read is NULL; Checked1's membership alone refuses kind b's unknown row and kind a's flag y; every selection reads the membership, and the picked singleton is refused by its NOT NULL at kind b",
							sketch: {
								world: {
									kinds: 2,
									flags: 2,
									pick: [{ flag: 0, n: 1, d: 0, t: "", u: 0, p: "a" }, undefined],
									next: [[0], [0, 1]],
									weight: [undefined, undefined],
									allowed: [[0], [0, 1]],
									slot: [
										[undefined, undefined],
										[undefined, undefined]
									]
								},
								checks: [
									{
										kind: "or",
										args: [
											{ kind: "kind", ne: true, handle: 0 },
											{ kind: "member", of: "own", within: { kind: "row", of: "picked" } }
										]
									},
									{ kind: "member", of: "own", within: { kind: "row", of: "picked" } }
								],
								contained: { kind: "member", of: "own", within: { kind: "row", of: "picked" } },
								keyed: { kind: "member", of: "own", within: { kind: "row", of: "picked" } },
								folded: { kind: "member", of: "own", within: { kind: "row", of: "picked" } },
								items: [
									{ kind: 0, flag: 0, flags: [0], n: 1, d: 0, t: "", u: 0, p: "a" },
									{ kind: 1, flag: 1, flags: [], n: 2, d: 0, t: "", u: 0, p: "a" },
									{ kind: 0, flag: 1, flags: [1], n: 3, d: 0, t: "", u: 0, p: "a" }
								]
							},
							draws: "",
							reaches: [
								"a check holds of a row with a NULL read",
								"a check finds a membership true",
								"a check finds a membership false",
								"a check leaves a membership unknown at a NULL set",
								"a containment's selection reads a membership",
								"a key's selection reads a membership",
								"a fold's selection reads a membership",
								"GenSinglePicked refused by its NOT NULL",
								"a singleton stored at the first code",
								"a singleton stored at the last code",
								"a singleton stored over a padded roster"
							]
						},
						{
							note: "downstream, absence stated by C.has: Kind {a, b} and Flag {x, y}, Pick holds only a → (x, n 1), FlagW only x; Checked0 is the count bound, or(not(Pick.has(kind)), eq(Pick.at(n, kind), n)), which holds of kind b at any n and refuses kind a's n 2; Checked1 negates a guarded comparison, not(and(Pick.has(kind), eq(Pick.at(flag, kind), x))), true at kind b; the selections read presences, FlagW's at the picked flag NULL at kind b; and the conditionals store Pick's payload at kind a and their literal at kind b, the picked weight's at its NULL key",
							sketch: {
								world: {
									kinds: 2,
									flags: 2,
									pick: [{ flag: 0, n: 1, d: 0, t: "", u: 0, p: "a" }, undefined],
									next: [[0], [1]],
									weight: [2, undefined],
									allowed: [[0], [0, 1]],
									slot: [
										[undefined, undefined],
										[undefined, undefined]
									]
								},
								checks: [
									{
										kind: "or",
										args: [
											{ kind: "not", arg: { kind: "has", key: { relation: "Pick" } } },
											{ kind: "eq", read: { kind: "at", field: "n" }, against: { kind: "field" } }
										]
									},
									{
										kind: "not",
										arg: {
											kind: "and",
											args: [
												{ kind: "has", key: { relation: "Pick" } },
												{
													kind: "eq",
													read: { kind: "at", field: "flag" },
													against: { kind: "literal", value: 0 }
												}
											]
										}
									}
								],
								contained: { kind: "has", key: { relation: "FlagW", of: "picked" } },
								keyed: {
									kind: "not",
									arg: { kind: "has", key: { relation: "Allowed", of: "own" } }
								},
								folded: {
									kind: "or",
									args: [
										{ kind: "not", arg: { kind: "has", key: { relation: "Pick" } } },
										{ kind: "eq", read: { kind: "at", field: "n" }, against: { kind: "field" } }
									]
								},
								items: [
									{ kind: 0, flag: 0, flags: [0], n: 1, d: 0, t: "", u: 0, p: "a" },
									{ kind: 0, flag: 1, flags: [], n: 2, d: 0, t: "", u: 0, p: "a" },
									{ kind: 1, flag: 1, flags: [1], n: 3, d: 0, t: "", u: 0, p: "a" }
								]
							},
							draws: "",
							reaches: [
								"a check finds a key held",
								"a check finds a key absent",
								"a check holds of a row at a key its presence finds absent",
								"a check refuses a row it finds false",
								"a containment's selection reads a presence",
								"a key's selection reads a presence",
								"a fold's selection reads a presence",
								"a conditional stores its payload at a held key",
								"a conditional stores its literal at an absent key",
								"a conditional stores its literal at a NULL key value"
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
	it.effect(
		"under the downstream's guard, read through a second closed read keyed by two fields, is judged by its row check",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/closed/absent/guarded",
						draw: drawn(guardedCaseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the guarded read restated over the drawn rows: Slot.at NULL at a pair Slot lacks, FlagRel.row NULL at a NULL prefix and empty where nothing completes it, the subset in Kleene's logic, and the row check holding where `not(kind = K)` or the subset is true"
						},
						coverage: required<GuardedFeature>(guardedSituations, { cases: 64, sense: notesOnly }),
						kept: [],
						runs: 24,
						shrink: boundedShrink(40),
						concurrency: 1,
						steerEvery: 8,
						caseHang
					},
					guardedCase
				)
			)
	)
})
