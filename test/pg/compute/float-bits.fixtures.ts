/**
 * What the properties of float-bits.test.ts read: a float's identity image in the ledger's shape, its schema, template,
 * space and each case's run.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { doubleOrSpecial } from "@bjornpagen/testing/values"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { Compute } from "#compiler/public/compute.ts"
import { generated, pg } from "#compiler/public/fields.ts"
import { check, contained, key, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { floatBits } from "#compiler/scalar/compute/float.ts"
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
 * holding it to `Compute.floatBits(value)`, so -0 and 0 are two rows and every NaN one, while `value` keeps its float
 * for reads by `=`. A tally names a bag row by the same image, a generated `Compute.floatBits(value)` it holds a key
 * over and a containment over (variable, bits) reads, a foreign key into the bag's primary key.
 */
const Bag = relation(
	"Bag",
	{ variable: Short, bits: pg.bigint, value: pg["double precision"], count: pg.integer },
	["variable", "bits"]
)
const Tally = relation.generated(
	"Tally",
	{ variable: Short, value: pg["double precision"], at: pg.integer },
	["variable", "at"],
	(t) => ({ bits: generated(pg.bigint, Compute.floatBits(t.value)) })
)

const bagSchema = schema(
	"float_bits",
	[Bag, Tally],
	[
		check("Bag_image", Bag, (b) => b.eq(b.bits, Compute.floatBits(b.value))),
		key(on(Tally, "variable", "bits")),
		contained(on(Tally, "variable", "bits"), on(Bag, "variable", "bits"))
	]
)

export const bagTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "float bits",
	content: { schema: bagSchema.name, logins: [] },
	versions: [{ schema: bagSchema, logins: [], declarations: noDeclarations }],
	options: {
		label: "float_bits",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/** A float a multiple holds: both zeros, NaN and the infinities often, else any double. */
const valueGen: Gen<number> = weighted<number>([
	[2, element([0, -0] as const)],
	[3, doubleOrSpecial(-4, 4)]
])

/** One case: a multiple's values in the order written, and the values tallied, each named by identity or not. */
export interface Drawn {
	readonly values: ReadonlyArray<number>
	readonly tallied: ReadonlyArray<number>
	readonly shape: "seq" | "index"
}

export const drawnGen: Gen<Drawn> = (s) => ({
	values: s.draw(array(valueGen, { min: 1, max: 8 })),
	tallied: s.draw(array(valueGen, { min: 0, max: 4 })),
	shape: s.draw(boolean) ? "seq" : "index"
})

export type BitsFeature =
	| "both zeros held, two rows"
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
 * read by `=` on the value finds every row `=` holds equal, both zeros for a zero. Then each tally, under a savepoint:
 * accepted exactly when the bag holds its value's identity, so a tally of -0 is refused where the bag holds 0 alone.
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
			const image = floatBits(value, 64)
			counts.set(image, { value, count: (counts.get(image)?.count ?? 0) + 1 })
		}
		for (const { value, count } of counts.values()) {
			yield* connection.query(
				`INSERT INTO ${bag} (${b("variable")}, ${b("bits")}, ${b("value")}, ${b("count")}) VALUES ('v', ${floatBits(value, 64)}, ${literal(value)}::float8, ${count})`,
				[]
			)
		}
		const stored = yield* connection.queryValues(
			`SELECT ${b("bits")}::text, ${b("count")} FROM ${bag} ORDER BY ${b("bits")}`,
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
		if (counts.has(floatBits(0, 64)) && counts.has(floatBits(-0, 64))) {
			c.note("both zeros held, two rows")
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
			const byImage = yield* connection.queryValues(
				`SELECT ${b("count")} FROM ${bag} WHERE ${b("variable")} = 'v' AND ${b("bits")} = ${image}::int8`,
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
		for (const [at, value] of drawn.tallied.entries()) {
			yield* connection.query("SAVEPOINT tally", [])
			const refused = yield* refusalOf(
				connection.query(
					`INSERT INTO ${tally} (${t("variable")}, ${t("value")}, ${t("at")}) VALUES ('v', ${literal(value)}::float8, ${at})`,
					[]
				)
			)
			const held = counts.has(floatBits(value, 64))
			if (Option.isNone(refused)) {
				assert.ok(
					held,
					`a tally of ${literal(value)} accepted where the bag lacks its identity: ${where}`
				)
				yield* connection.query("RELEASE SAVEPOINT tally", [])
				c.note("a tally accepted")
				continue
			}
			yield* connection.query("ROLLBACK TO SAVEPOINT tally", [])
			assert.ok(
				!held,
				`a tally of ${literal(value)} refused (${refused.value.code}) where the bag holds its identity: ${where}`
			)
			if (Object.is(value, -0) && counts.has(floatBits(0, 64))) {
				c.note("a tally of -0 refused where only 0 is held")
			}
		}
	})
