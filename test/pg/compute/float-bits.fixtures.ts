/**
 * What the properties of float-bits.test.ts read: a float's identity image in the ledger's shape, its schema, template,
 * space and each case's run.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { doubleOrSpecial } from "@bjornpagen/testing/values"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { compileInstallation } from "#compiler/program/install.ts"
import { floatBits, Num } from "#compiler/public/compute.ts"
import { generated, float8, int4, int8 } from "#compiler/public/fields.ts"
import { check, contained, key, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { refusalOf } from "#test/support/substrate.ts"

const Short = str.bytes(16, str.regex("^.*$", "su"))

/**
 * A multiple's bag in the ledger's shape: each value of a variable once, by identity, beside how many times it is
 * held. Its key is the variable and the value's identity image, `bits`, which a primary key reads written, a check
 * holding it to `Num.floatBits(value)`, so -0 and 0 are two rows and every NaN one, while `value` keeps its float
 * for reads by `=`. A tally names a bag row by the same image, a generated `Num.floatBits(value)` it holds a key
 * over and a containment over (variable, bits) reads, a foreign key into the bag's primary key.
 */
const Bag = relation("Bag", { variable: Short, bits: int8, value: float8, count: int4 }, [
	"variable",
	"bits"
])
const Tally = relation.generated(
	"Tally",
	{ variable: Short, value: float8, at: int4 },
	["variable", "at"],
	(t) => ({ bits: generated(int8, Num.floatBits(t.value)) })
)

const bagSchema = schema(
	"float_bits",
	[Bag, Tally],
	[
		check("Bag_image", Bag, (b) => b.eq(b.bits, Num.floatBits(b.value))),
		key(on(Tally, "variable", "bits")),
		contained(on(Tally, "variable", "bits"), on(Bag, "variable", "bits"))
	]
)

export const bagTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "float bits",
	content: { schema: bagSchema.name, logins: [] },
	versions: [{ schema: bagSchema, declarations: noDeclarations }],
	options: {
		label: "float_bits",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/** The doubles at the subnormal range's ends, each sign: the least, and the greatest below the least normal. */
const subnormals = [
	Number.MIN_VALUE,
	-Number.MIN_VALUE,
	2.2250738585072009e-308,
	-2.2250738585072009e-308
] as const

/** A float a multiple holds: both zeros, NaN and the infinities often, subnormals now and then, else any double. */
const valueGen: Gen<number> = weighted<number>([
	[2, element([0, -0] as const)],
	[1, element(subnormals)],
	[3, doubleOrSpecial(-4, 4)]
])

/** One case: a multiple's values in the order written, and the values tallied, each named by identity or not. */
export interface Drawn {
	readonly values: ReadonlyArray<number>
	/** A value written with another's image, which the law refuses: the value, and the one whose image it states. */
	readonly mismatched: readonly [number, number]
	readonly tallied: ReadonlyArray<number>
	readonly shape: "seq" | "index"
}

export const drawnGen: Gen<Drawn> = (s) => ({
	values: s.draw(array(valueGen, { min: 1, max: 8 })),
	mismatched: [s.draw(valueGen), s.draw(valueGen)],
	tallied: s.draw(array(valueGen, { min: 0, max: 4 })),
	shape: s.draw(boolean) ? "seq" : "index"
})

export type BitsFeature =
	| "both zeros held, two rows"
	| "a value written with another's image refused"
	| "a subnormal held"
	| "a NaN held"
	| "an infinity held"
	| "a tally of -0 refused where only 0 is held"
	| "a tally accepted"
	| "read by index"
	| "read by a scan"

/** A double as SQL text: its specials by name, -0 among them, every finite value by its shortest round trip. */
const literal = (x: number): string =>
	Number.isNaN(x)
		? "'NaN'"
		: x === Number.POSITIVE_INFINITY
			? "'Infinity'"
			: x === Number.NEGATIVE_INFINITY
				? "'-Infinity'"
				: Object.is(x, -0)
					? "'-0'"
					: `'${String(x)}'`

/**
 * One case in its one transaction, which the case's end rolls back. The bag is written as the ledger writes it, one
 * row per value by identity with the number of times the multiple holds it: every insert is accepted, -0 and 0 are two
 * rows and every NaN one, each row's stored image is the host's (scalar/compute/float.ts floatBits), and its count the
 * model's; a read by the image, under an index scan or a sequential one, finds exactly the row of that identity, and a
 * read by `=` on the value finds every row `=` holds equal, both zeros for a zero. Then each tally, inserted alone:
 * accepted exactly when the bag holds its value's identity, so a tally of -0 is refused where the bag holds 0 alone. A
 * refused insert, a tally's or a value's written with another's image, leaves the transaction as it was, rolled back
 * to the savepoint the substrate sets under every statement of a case (substrate.ts undoneAlone): a savepoint the case
 * set itself would be released with that one, and a rollback to it fail (3B001).
 */
export const runBag = (
	installed: Installed,
	connection: PgConnection,
	drawn: Drawn,
	c: Case<BitsFeature>
) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const bag = names.table(Bag)
		const tally = names.table(Tally)
		const b = (f: "variable" | "value" | "bits" | "count") => names.column(Bag, f)
		const t = (f: "variable" | "value" | "at") => names.column(Tally, f)
		const where = Formatter.format(drawn)
		yield* connection.query("SET CONSTRAINTS ALL IMMEDIATE", [])
		const counts = new Map<bigint, { readonly value: number; readonly count: number }>()
		for (const value of drawn.values) {
			const image = floatBits(value)
			counts.set(image, { value, count: (counts.get(image)?.count ?? 0) + 1 })
		}
		for (const { value, count } of counts.values()) {
			yield* connection.query(
				`INSERT INTO ${bag} (${b("variable")}, ${b("bits")}, ${b("value")}, ${b("count")}) VALUES ('v', ${floatBits(value)}, ${literal(value)}::float8, ${count})`,
				[]
			)
		}
		/** Ordered by the stored image, a bigint, which the table's alias names, not the select list's text of it. */
		const stored = yield* connection.queryValues(
			`SELECT bag.${b("bits")}::text, bag.${b("count")} FROM ${bag} AS bag ORDER BY bag.${b("bits")}`,
			[]
		)
		assert.deepEqual(
			Arr.map(stored, (r) => [String(r[0]), Number(r[1])]),
			Arr.map(
				Arr.sort(
					[...counts.entries()],
					Order.mapInput(Order.BigInt, ([image]: readonly [bigint, unknown]) => image)
				),
				([image, { count }]) => [String(image), count]
			),
			`one row per identity, the host's image and the model's count: ${where}`
		)
		if (counts.has(floatBits(0)) && counts.has(floatBits(-0))) {
			c.note("both zeros held, two rows")
		}
		if (Arr.some(drawn.values, (x) => Arr.contains(subnormals, x))) {
			c.note("a subnormal held")
		}
		const [value, other] = drawn.mismatched
		if (floatBits(value) !== floatBits(other)) {
			const refused = yield* refusalOf(
				connection.query(
					`INSERT INTO ${bag} (${b("variable")}, ${b("bits")}, ${b("value")}, ${b("count")}) VALUES ('w', ${floatBits(other)}, ${literal(value)}::float8, 1)`,
					[]
				)
			)
			assert.ok(
				Option.isSome(refused) && refused.value.code === "23514",
				`the law refuses ${literal(value)} written with ${literal(other)}'s image: ${where}`
			)
			c.note("a value written with another's image refused")
		}
		if (Arr.some(drawn.values, Number.isNaN)) {
			c.note("a NaN held")
		}
		if (Arr.some(drawn.values, (x) => Math.abs(x) === Number.POSITIVE_INFINITY)) {
			c.note("an infinity held")
		}
		yield* connection.query(
			drawn.shape === "seq" ? "SET LOCAL enable_indexscan = off" : "SET LOCAL enable_seqscan = off",
			[]
		)
		yield* connection.query("SET LOCAL enable_bitmapscan = off", [])
		c.note(drawn.shape === "seq" ? "read by a scan" : "read by index")
		for (const [image, { value }] of counts.entries()) {
			/** The image as a typed literal, since `-x::int8` casts x before negating it and -0's, int8's least, overflows. */
			const byImage = yield* connection.queryValues(
				`SELECT ${b("count")} FROM ${bag} WHERE ${b("variable")} = 'v' AND ${b("bits")} = '${image}'::int8`,
				[]
			)
			assert.deepEqual(
				Arr.map(byImage, (r) => Number(r[0])),
				[defined(counts.get(image), "the identity's count").count],
				`a read by the image finds its one row: ${literal(value)}: ${where}`
			)
			const byValue = yield* connection.queryValues(
				`SELECT count(*) FROM ${bag} WHERE ${b("variable")} = 'v' AND ${b("value")} = ${literal(value)}::float8`,
				[]
			)
			const equal = Arr.filter([...counts.values()], (r) =>
				Number.isNaN(value) ? Number.isNaN(r.value) : r.value === value
			).length
			assert.equal(
				Number(defined(byValue[0], "a count")[0]),
				equal,
				`a read by = on ${literal(value)}: ${where}`
			)
		}
		yield* connection.query("SET LOCAL enable_indexscan = on", [])
		yield* connection.query("SET LOCAL enable_seqscan = on", [])
		yield* connection.query("SET LOCAL enable_bitmapscan = on", [])
		/** The images the tallies accepted so far hold, under the tally's key over (variable, bits). */
		const tallied = new Set<bigint>()
		for (const [at, value] of drawn.tallied.entries()) {
			const refused = yield* refusalOf(
				connection.query(
					`INSERT INTO ${tally} (${t("variable")}, ${t("value")}, ${t("at")}) VALUES ('v', ${literal(value)}::float8, ${at})`,
					[]
				)
			)
			const image = floatBits(value)
			const held = counts.has(image)
			const again = tallied.has(image)
			if (Option.isNone(refused)) {
				assert.ok(
					held && !again,
					`a tally of ${literal(value)} accepted where the bag lacks its identity or a tally holds it: ${where}`
				)
				tallied.add(image)
				c.note("a tally accepted")
				continue
			}
			assert.equal(
				refused.value.code,
				held ? "23505" : "23503",
				`a tally of ${literal(value)} refused (${refused.value.code}): by its key where a tally holds its identity, by the containment where the bag lacks it: ${where}`
			)
			assert.ok(
				!held || again,
				`a tally of ${literal(value)} refused where the bag holds its identity and no tally does: ${where}`
			)
			if (Object.is(value, -0) && counts.has(floatBits(0))) {
				c.note("a tally of -0 refused where only 0 is held")
			}
		}
	})
