/** What the properties of cells.test.ts read: the templates each proof writes, their boxes, models and cases. */
import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert, containsText, nonEmpty } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { type Case } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Formatter, Option } from "effect"
import { cell, fromText } from "#compiler/codec/bits.ts"
import { maxStringLength } from "#compiler/core/canonical.ts"
import {
	cellWidth,
	constantOf as encodedOf,
	type CellLayout,
	spaceSize,
	type Tuple
} from "#compiler/ir/cells.ts"
import { succeeded } from "#test/support/assert.ts"
import { templateNeedBudget } from "#test/support/budgets.ts"
import { bitText } from "#test/support/closed/bit-text.ts"
import { qualified, refusalOf, refusalText, tuple } from "#test/support/substrate.ts"
import { fixtureGroup, noTables } from "#test/support/substrate/replace.ts"
import {
	freshSchema,
	ownerSession,
	Substrate,
	installTemplate
} from "#test/support/substrate/substrate.ts"
/** A product layout, the one these templates are written for: each key coordinate's and payload coordinate's codes. */
interface Product {
	readonly key: Arr.NonEmptyReadonlyArray<number>
	readonly payload: ReadonlyArray<number>
}

/** The host encoder's constant of a product layout's tuples (ir/cells.ts constantOf over the product key space). */
const constantOf = (layout: Product, tuples: ReadonlyArray<Tuple>) =>
	encodedOf(
		{ key: { kind: "product", sizes: layout.key }, payload: layout.payload } satisfies CellLayout,
		tuples
	)

/** PostgreSQL's disagreement with the host encoder or a model, with both sides spelt out. */
class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** The digits of `index` in a mixed-radix space of `sizes`, first most significant. */
const digitsOf = (sizes: ReadonlyArray<number>, index: number): ReadonlyArray<number> => {
	const out: Array<number> = []
	let rest = index
	for (const size of Arr.reverse(sizes)) {
		out.unshift(rest % size)
		rest = Math.floor(rest / size)
	}
	return out
}

/** The SQL of a mixed-radix index over `columns` of a row source aliased `r`, row-major. */
const radixSql = (
	alias: string,
	columns: ReadonlyArray<string>,
	sizes: ReadonlyArray<number>
): string =>
	Arr.reduce(
		Arr.drop(Arr.zip(columns, sizes), 1),
		`${alias}.${Arr.getUnsafe(columns, 0)}`,
		(acc, [column, size]) => `(${acc}) * ${size} + ${alias}.${column}`
	)

/**
 * A relation's rows as a row source of codes, its key columns `k0 …` and payload columns `p0 …`: a VALUES list, or a
 * typed empty select where it has no row, since VALUES cannot be empty.
 */
const rowsSql = (layout: Product, rows: ReadonlyArray<ReadonlyArray<number>>): string => {
	const columns = [
		...Arr.map(layout.key, (_, i) => `k${i}`),
		...Arr.map(layout.payload, (_, i) => `p${i}`)
	]
	return Arr.isReadonlyArrayNonEmpty(rows)
		? `(VALUES ${Arr.join(Arr.map(rows, tuple), ", ")}) AS v(${Arr.join(columns, ", ")})`
		: `(SELECT ${Arr.join(
				Arr.map(columns, (c) => `NULL::int4 AS ${c}`),
				", "
			)} WHERE false) AS v`
}

/**
 * The migration's pack of a relation into the IMMUTABLE function `fn`, as fin.md §17 step 2 writes it, with step 1's
 * key law first: two rows at one key refuse the block with 23505; then the cells in index order, an outer join of the
 * key space against the rows, each `coalesce(1 + c, 0)::bit(w)`, c the payload's mixed-radix code; and the function
 * created with the cells as its literal body.
 */
const packSql = (
	fn: string,
	layout: Product,
	rows: ReadonlyArray<ReadonlyArray<number>>
): string => {
	const keys = Arr.map(layout.key, (_, i) => `k${i}`)
	const payloads = Arr.map(layout.payload, (_, i) => `p${i}`)
	const width = cellWidth(spaceSize(layout.payload))
	const cells = Number(spaceSize(layout.key))
	const code = Arr.isReadonlyArrayNonEmpty(payloads) ? radixSql("v", payloads, layout.payload) : "0"
	return `DO $pack$
DECLARE cells text;
BEGIN
	IF EXISTS (SELECT 1 FROM ${rowsSql(layout, rows)} GROUP BY ${radixSql("v", keys, layout.key)} HAVING pg_catalog.count(*) > 1) THEN
		RAISE EXCEPTION USING ERRCODE = 'unique_violation', MESSAGE = 'two rows of the relation share a cell';
	END IF;
	SELECT pg_catalog.string_agg(coalesce(1 + r.c, 0)::bit(${width})::text, '' ORDER BY g.i) INTO cells
	FROM pg_catalog.generate_series(0, ${cells - 1}) AS g(i)
	LEFT JOIN (SELECT ${Arr.join(keys, ", ")}, ${code} AS c FROM ${rowsSql(layout, rows)}) AS r ON ${radixSql("r", keys, layout.key)} = g.i;
	EXECUTE pg_catalog.format($f$CREATE FUNCTION ${fn}() RETURNS bit varying LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURN %L::bit varying$f$, cells);
END $pack$`
}

/** A key layout of at most four cells, and a payload layout of at most four codes. */
const KEYS: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<number>> = [
	[1],
	[2],
	[3],
	[4],
	[1, 1],
	[1, 2],
	[2, 1],
	[2, 2]
]
const PAYLOADS: Arr.NonEmptyReadonlyArray<ReadonlyArray<number>> = [[], [2], [3], [2, 2]]

/** A relation of the pack's box: its layout, and each key cell absent or holding one payload code. */
export interface PackCase {
	readonly layout: Product
	readonly cells: ReadonlyArray<Option.Option<number>>
}

export const packGen: Gen<PackCase> = (source) => {
	const layout: Product = {
		key: source.draw(element(KEYS)),
		payload: source.draw(element(PAYLOADS))
	}
	const payloads = Number(spaceSize(layout.payload))
	const choices = nonEmpty([Option.none<number>(), ...Arr.map(indices(payloads), Option.some)])
	return {
		layout,
		cells: Arr.map(indices(Number(spaceSize(layout.key))), () => source.draw(element(choices)))
	}
}

/** A relation's tuples, as the host encoder takes them, and its rows of codes, as the migration writes them. */
const tuplesOf = (c: PackCase): ReadonlyArray<Tuple> =>
	Arr.flatMap(c.cells, (payload, index) =>
		Option.match(payload, {
			onNone: () => [],
			onSome: (code) => [
				{ key: digitsOf(c.layout.key, index), payload: digitsOf(c.layout.payload, code) }
			]
		})
	)

const rowOf = (t: Tuple): ReadonlyArray<number> => [...t.key, ...t.payload]

export type PackFeature = "a set" | "a function" | "empty" | "full" | "a two-coordinate key"

/** A relation whose key law fails or holds: each key cell absent, one payload code, or two different ones. */
export interface KeyLawCase {
	readonly layout: Product
	readonly cells: ReadonlyArray<ReadonlyArray<number>>
}

const KEY_LAW_LAYOUTS: Arr.NonEmptyReadonlyArray<Product> = [
	{ key: [1], payload: [2] },
	{ key: [2], payload: [2] },
	{ key: [2], payload: [3] },
	{ key: [3], payload: [2] }
]

/** The payload codes a key cell may hold in the key law's box: none, one, or two different ones. */
const holdings = (payloads: number): Arr.NonEmptyReadonlyArray<ReadonlyArray<number>> =>
	nonEmpty([
		[],
		...Arr.map(indices(payloads), (c) => [c]),
		...Arr.flatMap(indices(payloads), (a) =>
			Arr.map(
				Arr.filter(indices(payloads), (b) => b > a),
				(b) => [a, b]
			)
		)
	])

export const keyLawGen: Gen<KeyLawCase> = (source) => {
	const layout = source.draw(element(KEY_LAW_LAYOUTS))
	const choices = holdings(Number(spaceSize(layout.payload)))
	return {
		layout,
		cells: Arr.map(indices(Number(spaceSize(layout.key))), () => source.draw(element(choices)))
	}
}

export type KeyLawFeature = "refused by its key" | "packed"

/**
 * Three rosters for the domain template, each a live-code string: A of two codes, B of three with code 1 a hole, C of
 * two. The set R over them holds the live tuples whose codes sum to an even number, and (1, 0, 1), so the alias of
 * B's digit 3 at x = 0 lands on a member.
 */
const ROSTERS = { A: [true, true], B: [true, false, true], C: [true, true] } as const

/** The three rosters' names, each a domain and a constant of its own. */
const ROSTER_NAMES = ["A", "B", "C"] as const

const rosterBits = (live: ReadonlyArray<boolean>): string =>
	Arr.join(
		Arr.map(live, (l) => (l ? "1" : "0")),
		""
	)

const liveIn = (live: ReadonlyArray<boolean>, code: number): boolean => live[code] === true

const inR = (x: number, y: number, z: number): boolean =>
	liveIn(ROSTERS.A, x) &&
	liveIn(ROSTERS.B, y) &&
	liveIn(ROSTERS.C, z) &&
	((x + y + z) % 2 === 0 || (x === 1 && y === 0 && z === 1))

const sizes = [ROSTERS.A.length, ROSTERS.B.length, ROSTERS.C.length] as const

/** R's constant, as the host encoder writes it. */
const rConstant = (): string =>
	succeeded(
		bitText(
			succeeded(
				constantOf(
					{ key: [...sizes], payload: [] },
					Arr.flatMap(indices(sizes[0] * sizes[1] * sizes[2]), (index) => {
						const [x, y, z] = digitsOf(sizes, index)
						return inR(x ?? 0, y ?? 0, z ?? 0)
							? [{ key: [x ?? 0, y ?? 0, z ?? 0], payload: [] }]
							: []
					})
				)
			),
			maxStringLength
		)
	)

/** A digit tuple of the domain template's box: each digit from one below its roster to two past its last code. */
export interface DigitCase {
	readonly x: number
	readonly y: number
	readonly z: number
}

export const digitGen: Gen<DigitCase> = (source) => ({
	x: source.draw(int(-1, sizes[0] + 1)),
	y: source.draw(int(-1, sizes[1] + 1)),
	z: source.draw(int(-1, sizes[2] + 1))
})

export type DigitFeature =
	| "typed admits a member"
	| "typed refuses a hole"
	| "typed refuses a digit out of range"
	| "typed refuses a live tuple outside the set"
	| "bare admits an alias the roster domains refuse"

/**
 * A partial function F from a roster of four codes to a payload of three, at two bits a cell, and a set S over F's
 * payload and a roster of two codes, for function application and a lookup through it.
 */
const F_CELLS: ReadonlyArray<Option.Option<number>> = [
	Option.some(2),
	Option.none(),
	Option.some(0),
	Option.some(1)
]
const S_SIZES = [3, 2] as const
const inS = (p: number, q: number): boolean => (p + q) % 2 === 1

export type ReadCase =
	| { readonly kind: "apply"; readonly index: number }
	| { readonly kind: "lookup"; readonly x: number; readonly y: number }

export const readGen: Gen<ReadCase> = (source) =>
	source.draw(element<"apply" | "lookup">(["apply", "lookup"])) === "apply"
		? { kind: "apply", index: source.draw(int(-2, F_CELLS.length + 1)) }
		: {
				kind: "lookup",
				x: source.draw(int(0, F_CELLS.length - 1)),
				y: source.draw(int(0, S_SIZES[1] - 1))
			}

export type ReadFeature =
	| "applied to a present cell"
	| "applied to an absent cell"
	| "applied past either end"
	| "a lookup through an absent cell refused"
	| "a lookup admitted"

/** A roster's migration: its old live codes, the codes it removes, whether it appends one, and the rows two tables hold. */
export interface RepointCase {
	readonly old: ReadonlyArray<boolean>
	readonly removed: ReadonlyArray<number>
	readonly appended: boolean
	readonly t1: ReadonlyArray<number>
	readonly t2: ReadonlyArray<number>
}

/** Every subset of `items`, drawn one membership decision at a time. */
const subsetGen =
	<A>(items: ReadonlyArray<A>): Gen<ReadonlyArray<A>> =>
	(source) =>
		Arr.filter(items, () => source.draw(element([false, true] as const)))

export const repointGen: Gen<RepointCase> = (source) => {
	const length = source.draw(int(1, 3))
	const old = Arr.map(indices(length), () => source.draw(element([false, true] as const)))
	const live = Arr.filter(indices(length), (c) => old[c] === true)
	return {
		old,
		removed: source.draw(subsetGen(live)),
		appended: source.draw(element([false, true] as const)),
		t1: source.draw(subsetGen(live)),
		t2: source.draw(subsetGen(live))
	}
}

/** The new roster after a migration: the old codes less the removed, as holes, and one appended live code or none. */
const newRoster = (c: RepointCase): ReadonlyArray<boolean> => [
	...Arr.map(c.old, (l, code) => l && !c.removed.includes(code)),
	...(c.appended ? [true] : [])
]

export type RepointFeature =
	| "validated"
	| "validate names a row holding a removed code"
	| "a removed code refused after the swap"
	| "an appended code admitted after the swap"

/** The kinds of object that read a constant, each a dependent pg_depend records. */
export const DEPENDENTS = ["domain", "check", "generated", "function"] as const

type Dependent = (typeof DEPENDENTS)[number]

/** The name a dependent's DETAIL line names it by, one of each kind. */
const dependentName: Readonly<Record<Dependent, string>> = {
	domain: "dk_live",
	check: "t_check_live",
	generated: "t_gen",
	function: "uses"
}

export interface RestrictCase {
	readonly installed: ReadonlyArray<Dependent>
	readonly handled: ReadonlyArray<Dependent>
}

export const restrictGen: Gen<RestrictCase> = (source) => {
	const installed = source.draw(subsetGen(DEPENDENTS))
	return { installed, handled: source.draw(subsetGen(installed)) }
}

export type RestrictFeature = "dropped" | `refused naming a missed ${Dependent}`

/** An IMMUTABLE constant function of `bits`, created anew: erasure never replaces one in place. */
const constantSql = (fn: string, bits: string): string =>
	`CREATE FUNCTION ${fn}() RETURNS bit varying LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURN B'${bits}'::bit varying`

/** A roster domain's check: VALUE is a live code of the constant `fn` returns. */
const liveCheckSql = (fn: string): string =>
	`CHECK ((substring(${fn}() FROM VALUE + 1 FOR 1) = B'1') IS TRUE)`

/** The constants of the cached-check box: the live codes before a swap and after it. */
const BEFORE = "110"
const AFTER = "1001"

/**
 * A case of the cached-check box: a domain-typed column, written directly or as a STORED generation of a plain one; a
 * writer that already wrote through the domain before its constraint changed, or a session opened after; the change,
 * the domain's constraint swapped for a new constant's or a first constraint added; and the code written after it.
 */
export interface CachedCheckCase {
	readonly column: "plain" | "generated"
	readonly session: "warm" | "fresh"
	readonly change: "swapped" | "added"
	readonly code: 0 | 1 | 3
}

export type CachedCheckFeature =
	| `${CachedCheckCase["column"]}, ${CachedCheckCase["session"]}, ${CachedCheckCase["change"]}`
	| "admitted"
	| "refused"

/**
 * A schema of its own once per member (substrate.ts installTemplate), empty, where each search allocated one before its
 * cases: each case creates the templates it proves in it and drops them, so the seat empties nothing.
 */
export const cellsSchemaTemplate = installTemplate({
	budget: templateNeedBudget,
	declaredIn: import.meta,
	name: "cells schema",
	content: { schema: "empty" },
	plan: (names) => Effect.succeed(names.schema),
	install: () => Effect.flatMap(Substrate, (s) => s.schema({ create: true, label: "install" })),
	bind: (schema) => schema,
	reset: () => noTables
})

/** The closed law as a table CHECK over the digit columns, the mixed-radix index read in the constant. */
const memberCheck = (schema: string) =>
	`CONSTRAINT r_member CHECK ((substring(${qualified(schema, "r_c")}() FROM ((x * ${sizes[1]} + y) * ${sizes[2]} + z) + 1 FOR 1) = B'1') IS TRUE)`

/** The digit proof's templates: each roster's constant and domain, the closed law's constant, and the table of typed digits. */
const digitsDdl = (schema: string): ReadonlyArray<string> => {
	const name = (n: string) => qualified(schema, n)
	return [
		...Arr.flatMap(ROSTER_NAMES, (roster) => [
			constantSql(name(`${roster}_live`), rosterBits(ROSTERS[roster])),
			`CREATE DOMAIN ${name(roster)} AS int2 CONSTRAINT ${roster}_live ${liveCheckSql(name(`${roster}_live`))}`
		]),
		`CREATE FUNCTION ${name("r_c")}() RETURNS bit varying LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURN B'${rConstant()}'::bit varying`,
		`CREATE TABLE ${name("typed")} (x ${name("A")} NOT NULL, y ${name("B")} NOT NULL, z ${name("C")} NOT NULL, ${memberCheck(schema)})`
	]
}

/** A proof's templates installed in a schema of its own once per member, where its search installed them before its cases. */
const ddlTemplate = (name: string, ddl: (schema: string) => ReadonlyArray<string>, table: string) =>
	installTemplate({
		budget: templateNeedBudget,
		declaredIn: import.meta,
		name,
		content: { templates: name },
		plan: (names) => Effect.succeed(names.schema),
		install: () =>
			Effect.gen(function* () {
				const s = yield* Substrate
				const schema = yield* s.schema({ create: true, label: "install" })
				for (const statement of ddl(schema)) {
					yield* s.admin.query(statement, [])
				}
			}),
		bind: (schema) => ({ schema, tables: fixtureGroup([qualified(schema, table)]) }),
		reset: (installed) => installed.tables
	})

/** The digit proof's templates (digitsDdl), the typed table emptied after each case. */
export const digitsTemplate = ddlTemplate("cells digits", digitsDdl, "typed")

/** A cell of three codes' width: the function application proof's. */
const width = cellWidth(3n)

/** f's constant, the host encoder's string of F_CELLS. */
const fText = succeeded(
	bitText(
		succeeded(
			constantOf(
				{ key: [F_CELLS.length], payload: [3] },
				Arr.flatMap(F_CELLS, (payload, x) =>
					Option.match(payload, {
						onNone: () => [],
						onSome: (p) => [{ key: [x], payload: [p] }]
					})
				)
			)
		),
		maxStringLength
	)
)

/** s's constant, its set's bits in row-major order. */
const sText = Arr.join(
	Arr.map(indices(S_SIZES[0] * S_SIZES[1]), (i) =>
		inS(Math.floor(i / S_SIZES[1]), i % S_SIZES[1]) ? "1" : "0"
	),
	""
)

/** f applied at the index `x`, absence as NULL, over the schema's f. */
const appliedIn = (schema: string) => (x: string) =>
	`(NULLIF(substring(${qualified(schema, "f")}() FROM (${x}) * ${width} + 1 FOR ${width})::int4, 0) - 1)`

/** The application proof's templates: f's and s's constants, and the lookup table through f into s. */
const readDdl = (schema: string): ReadonlyArray<string> => [
	`CREATE FUNCTION ${qualified(schema, "f")}() RETURNS bit varying LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURN B'${fText}'::bit varying`,
	`CREATE FUNCTION ${qualified(schema, "s")}() RETURNS bit varying LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURN B'${sText}'::bit varying`,
	`CREATE TABLE ${qualified(schema, "lookup")} (x int2 NOT NULL, y int2 NOT NULL, CONSTRAINT through_s CHECK ((substring(${qualified(schema, "s")}() FROM ${appliedIn(schema)("x")} * ${S_SIZES[1]} + y + 1 FOR 1) = B'1') IS TRUE))`
]

/** The application proof's templates (readDdl), the lookup table emptied after each case. */
export const readTemplate = ddlTemplate("cells application", readDdl, "lookup")

/** A pack case over the case's clone of the empty schema: PostgreSQL's DO block and the host encoder, bit for bit. */
export const packCase = (schema: string, c: PackCase, k: Case<PackFeature>) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const fn = qualified(schema, "packed")

		const tuples = tuplesOf(c)
		const host = succeeded(bitText(succeeded(constantOf(c.layout, tuples)), maxStringLength))
		yield* s.admin.query(packSql(fn, c.layout, Arr.map(tuples, rowOf)), [])
		const [[packed] = []] = yield* s.admin.queryValues(`SELECT ${fn}()::text`, [])
		yield* s.admin.query(`DROP FUNCTION ${fn}()`, [])
		if (packed !== host) {
			return yield* new Disagreed({
				message: `PostgreSQL packs ${String(packed)}, the host encoder ${host}, for ${Formatter.format(c)}`
			})
		}
		k.note(Arr.isReadonlyArrayNonEmpty(c.layout.payload) ? "a function" : "a set")
		if (tuples.length === 0) {
			k.note("empty")
		}
		if (tuples.length === c.cells.length) {
			k.note("full")
		}
		if (c.layout.key.length > 1) {
			k.note("a two-coordinate key")
		}
	})

/** A key-law case over the case's clone of the empty schema: a pack refused exactly where the host encoder refuses it. */
export const keyLawCase = (schema: string, c: KeyLawCase, k: Case<KeyLawFeature>) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const fn = qualified(schema, "packed")

		const tuples = Arr.flatMap(c.cells, (codes, index) =>
			Arr.map(codes, (code) => ({
				key: digitsOf(c.layout.key, index),
				payload: digitsOf(c.layout.payload, code)
			}))
		)
		const host = constantOf(c.layout, tuples)
		const refused = yield* refusalOf(
			s.admin.query(packSql(fn, c.layout, Arr.map(tuples, rowOf)), [])
		)
		if (host.ok !== Option.isNone(refused)) {
			return yield* new Disagreed({
				message: `the host encoder ${host.ok ? "packs" : "refuses"} ${Formatter.format(c)}, PostgreSQL ${Option.match(refused, { onNone: () => "packs it", onSome: refusalText })}`
			})
		}
		if (Option.isSome(refused)) {
			assert.equal(refused.value.code, "23505")
			k.note("refused by its key")
		} else {
			yield* s.admin.query(`DROP FUNCTION ${fn}()`, [])
			k.note("packed")
		}
	})

/** A digit tuple written over the case's clone of the digit templates. */
export const digitCase = (schema: string, c: DigitCase, k: Case<DigitFeature>) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const name = (n: string) => qualified(schema, n)
		const db = yield* s.session({ ...ownerSession(), label: "writer" })
		const values = tuple([c.x, c.y, c.z])
		const typed = yield* refusalOf(
			db.query(`INSERT INTO ${name("typed")} (x, y, z) VALUES ${values}`, [])
		)
		const inRange = (code: number, size: number) => code >= 0 && code < size
		const ranged = inRange(c.x, sizes[0]) && inRange(c.y, sizes[1]) && inRange(c.z, sizes[2])
		const live = liveIn(ROSTERS.A, c.x) && liveIn(ROSTERS.B, c.y) && liveIn(ROSTERS.C, c.z)
		const member = inR(c.x, c.y, c.z)
		for (const [table, refused, admits] of [["typed", typed, member]] as const) {
			if (Option.isNone(refused) !== admits) {
				return yield* new Disagreed({
					message: `${table} ${Option.match(refused, { onNone: () => "admits", onSome: refusalText })} ${Formatter.format(c)}, which it should ${admits ? "admit" : "refuse"}`
				})
			}
			if (Option.isSome(refused) && refused.value.code !== "23514") {
				return yield* new Disagreed({
					message: `${table} refuses ${Formatter.format(c)} with ${refusalText(refused.value)}, not 23514`
				})
			}
		}
		if (Option.isNone(typed)) {
			k.note("typed admits a member")
		} else if (!ranged) {
			k.note("typed refuses a digit out of range")
		} else if (!live) {
			k.note("typed refuses a hole")
		} else {
			k.note("typed refuses a live tuple outside the set")
		}
	})

/** An application or a lookup over the case's clone of the application templates. */
export const readCase = (schema: string, c: ReadCase, k: Case<ReadFeature>) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const name = (n: string) => qualified(schema, n)
		const applied = appliedIn(schema)
		const bits = fromText(fText)
		switch (c.kind) {
			case "apply": {
				const [[value] = []] = yield* s.admin.queryValues(`SELECT ${applied(String(c.index))}`, [])
				const read = cell(bits, c.index, width)
				const expected = read === 0 ? null : read - 1
				assert.equal(value, expected, `F applied at ${c.index}`)
				k.note(
					c.index < 0 || c.index >= F_CELLS.length
						? "applied past either end"
						: read === 0
							? "applied to an absent cell"
							: "applied to a present cell"
				)
				return
			}
			case "lookup": {
				const refused = yield* refusalOf(
					s.admin.query(`INSERT INTO ${name("lookup")} (x, y) VALUES (${c.x}, ${c.y})`, [])
				)
				const fx = Arr.getUnsafe(F_CELLS, c.x)
				const admits = Option.match(fx, {
					onNone: () => false,
					onSome: (p) => inS(p, c.y)
				})
				if (Option.isNone(refused) !== admits) {
					return yield* new Disagreed({
						message: `the lookup through F at ${c.x} then ${c.y} is ${Option.isNone(refused) ? "admitted" : "refused"}`
					})
				}
				if (Option.isSome(refused)) {
					assert.equal(refused.value.code, "23514")
					if (Option.isNone(fx)) {
						k.note("a lookup through an absent cell refused")
					}
				} else {
					k.note("a lookup admitted")
				}
			}
		}
	})

/** A re-pointing over the case's clone of the empty schema, which the case leaves as it found it. */
export const repointCase = (schema: string, c: RepointCase, k: Case<RepointFeature>) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const name = (n: string) => qualified(schema, n)
		const migrator = yield* s.session({ ...ownerSession(), label: "migration" })
		const writer = yield* s.session({ ...ownerSession(), label: "writer" })
		const liveCheck = (fn: string) =>
			`CHECK ((substring(${name(fn)}() FROM VALUE + 1 FOR 1) = B'1') IS TRUE)`
		const constant = (fn: string, live: ReadonlyArray<boolean>) =>
			`CREATE FUNCTION ${name(fn)}() RETURNS bit varying LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURN B'${rosterBits(live)}'::bit varying`

		yield* s.admin.query(constant("live_v1", c.old), [])
		yield* s.admin.query(
			`CREATE DOMAIN ${name("roster")} AS int2 CONSTRAINT live_v1 ${liveCheck("live_v1")}`,
			[]
		)
		for (const [table, codes] of [
			["t1", c.t1],
			["t2", c.t2]
		] as const) {
			yield* s.admin.query(`CREATE TABLE ${name(table)} (x ${name("roster")} NOT NULL)`, [])
			for (const code of codes) {
				yield* writer.query(`INSERT INTO ${name(table)} (x) VALUES (${code})`, [])
			}
		}
		const next = newRoster(c)
		yield* migrator.begin
		yield* migrator.query(constant("live_v2", next), [])
		yield* migrator.query(`ALTER DOMAIN ${name("roster")} DROP CONSTRAINT live_v1`, [])
		yield* migrator.query(
			`ALTER DOMAIN ${name("roster")} ADD CONSTRAINT live_v2 ${liveCheck("live_v2")} NOT VALID`,
			[]
		)
		const validated = yield* refusalOf(
			migrator.query(`ALTER DOMAIN ${name("roster")} VALIDATE CONSTRAINT live_v2`, [])
		)
		const holding = Arr.filter(
			[
				["t1", c.t1],
				["t2", c.t2]
			] as const,
			([, codes]) => Arr.some(codes, (code) => c.removed.includes(code))
		)
		if (Option.isSome(validated)) {
			yield* migrator.rollback
			const fields = validated.value
			if (
				fields.code !== "23514" ||
				!Arr.some(holding, ([table]) => Option.contains(fields.table, table)) ||
				!Option.contains(fields.column, "x")
			) {
				return yield* new Disagreed({
					message: `VALIDATE refused ${Formatter.format(c)} with ${refusalText(fields)} naming table ${Option.getOrElse(fields.table, () => "none")}, column ${Option.getOrElse(fields.column, () => "none")}; the rows holding a removed code are in ${Formatter.format(Arr.map(holding, ([t]) => t))}`
				})
			}
			k.note("validate names a row holding a removed code")
		} else {
			if (Arr.isReadonlyArrayNonEmpty(holding)) {
				return yield* new Disagreed({
					message: `VALIDATE admitted ${Formatter.format(c)}, whose rows hold a removed code`
				})
			}
			yield* migrator.query(`DROP FUNCTION ${name("live_v1")}() RESTRICT`, [])
			yield* migrator.commit
			k.note("validated")
			for (const code of [-1, ...indices(next.length + 1)]) {
				const refused = yield* refusalOf(
					writer.query(`INSERT INTO ${name("t1")} (x) VALUES (${code})`, [])
				)
				const admits = liveIn(next, code)
				if (Option.isNone(refused) !== admits) {
					return yield* new Disagreed({
						message: `after the swap of ${Formatter.format(c)}, code ${code} is ${Option.isNone(refused) ? "admitted" : "refused"}`
					})
				}
				if (c.removed.includes(code)) {
					k.note("a removed code refused after the swap")
				}
				if (admits && code >= c.old.length) {
					k.note("an appended code admitted after the swap")
				}
			}
		}
		yield* s.admin.query(`DROP TABLE ${name("t1")}, ${name("t2")}`, [])
		yield* s.admin.query(`DROP DOMAIN ${name("roster")}`, [])
		yield* s.admin.query(`DROP FUNCTION IF EXISTS ${name("live_v1")}(), ${name("live_v2")}()`, [])
	})

/** A RESTRICT drop over the case's clone of the empty schema, which the case leaves as it found it. */
export const restrictCase = (schema: string, c: RestrictCase, note: Case<RestrictFeature>) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const name = (n: string) => qualified(schema, n)
		const k = name("k")
		const install: Readonly<Record<Dependent, string>> = {
			domain: `CREATE DOMAIN ${name("dk")} AS int2 CONSTRAINT dk_live CHECK ((substring(${k}() FROM VALUE + 1 FOR 1) = B'1') IS TRUE)`,
			check: `CREATE TABLE ${name("t_check")} (x int2, CONSTRAINT t_check_live CHECK ((substring(${k}() FROM x + 1 FOR 1) = B'1') IS TRUE))`,
			generated: `CREATE TABLE ${name("t_gen")} (x int2, y int4 GENERATED ALWAYS AS (substring(${k}() FROM x + 1 FOR 1)::int4) STORED)`,
			function: `CREATE FUNCTION ${name("uses")}() RETURNS bit varying LANGUAGE sql IMMUTABLE RETURN ${k}()`
		}
		const remove: Readonly<Record<Dependent, string>> = {
			domain: `DROP DOMAIN ${name("dk")}`,
			check: `DROP TABLE ${name("t_check")}`,
			generated: `DROP TABLE ${name("t_gen")}`,
			function: `DROP FUNCTION ${name("uses")}()`
		}

		yield* s.admin.query(
			`CREATE FUNCTION ${k}() RETURNS bit varying LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURN B'1101'::bit varying`,
			[]
		)
		for (const d of c.installed) {
			yield* s.admin.query(install[d], [])
		}
		for (const d of c.handled) {
			yield* s.admin.query(remove[d], [])
		}
		const missed = Arr.filter(c.installed, (d) => !c.handled.includes(d))
		const refused = yield* refusalOf(s.admin.query(`DROP FUNCTION ${k}() RESTRICT`, []))
		if (Option.isSome(refused)) {
			assert.equal(refused.value.code, "2BP01")
			const detail = Option.getOrElse(refused.value.detail, () => "")
			for (const d of missed) {
				containsText(detail, dependentName[d], `the drop names the missed ${d}`)
				note.note(`refused naming a missed ${d}`)
			}
			assert.ok(
				Arr.isReadonlyArrayNonEmpty(missed),
				"RESTRICT refuses only a drop with a dependent left"
			)
			for (const d of missed) {
				yield* s.admin.query(remove[d], [])
			}
			yield* s.admin.query(`DROP FUNCTION ${k}() RESTRICT`, [])
		} else {
			assert.equal(missed.length, 0, "RESTRICT drops the constant only when no dependent is left")
			note.note("dropped")
		}
	})

/** A domain's constraint changed under a write in a schema of the case's own. */
export const cachedCheckCase = (c: CachedCheckCase, k: Case<CachedCheckFeature>) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const schema = yield* s.schema(freshSchema)
		const name = (n: string) => qualified(schema, n)
		yield* s.admin.query(constantSql(name("before"), BEFORE), [])
		yield* s.admin.query(
			c.change === "swapped"
				? `CREATE DOMAIN ${name("code")} AS int2 CONSTRAINT before ${liveCheckSql(name("before"))}`
				: `CREATE DOMAIN ${name("code")} AS int2`,
			[]
		)
		const target = name("t")
		yield* s.admin.query(
			c.column === "plain"
				? `CREATE TABLE ${target} (x ${name("code")} NOT NULL)`
				: `CREATE TABLE ${target} (x int2 NOT NULL, y ${name("code")} GENERATED ALWAYS AS (x) STORED)`,
			[]
		)
		const insert = (code: number) => `INSERT INTO ${target} (x) VALUES (${code})`
		const warm = yield* s.session({ ...ownerSession(), label: "warm" })
		yield* warm.query(insert(0), [])
		yield* s.admin.query(constantSql(name("after"), AFTER), [])
		if (c.change === "swapped") {
			yield* s.admin.query(`ALTER DOMAIN ${name("code")} DROP CONSTRAINT before`, [])
		}
		yield* s.admin.query(
			`ALTER DOMAIN ${name("code")} ADD CONSTRAINT after ${liveCheckSql(name("after"))} NOT VALID`,
			[]
		)
		const writer =
			c.session === "warm" ? warm : yield* s.session({ ...ownerSession(), label: "fresh" })
		const refused = yield* refusalOf(writer.query(insert(c.code), []))
		const admits = AFTER[c.code] === "1"
		k.note(`${c.column}, ${c.session}, ${c.change}`)
		k.note(admits ? "admitted" : "refused")
		if (Option.isNone(refused) !== admits) {
			return yield* new Disagreed({
				message: `${Formatter.format(c)}: code ${c.code} is ${Option.match(refused, { onNone: () => "admitted", onSome: refusalText })} after the change`
			})
		}
		for (const fields of Option.toArray(refused)) {
			assert.equal(fields.code, "23514")
			assert.ok(Option.isSome(fields.dataType), "the refusal is the domain's")
		}
	})

/** Every column kind, session, change and code of the cached-check proof's box. */
export const cachedCheckGen: Gen<CachedCheckCase> = (source) => ({
	column: source.draw(element(["plain", "generated"] as const)),
	session: source.draw(element(["warm", "fresh"] as const)),
	change: source.draw(element(["swapped", "added"] as const)),
	code: source.draw(element([0, 1, 3] as const))
})
