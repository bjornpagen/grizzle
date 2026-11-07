import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import {
	array,
	constant,
	element,
	filter,
	type Gen,
	int,
	map,
	oneOf,
	string,
	unicodeScalar,
	weighted
} from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint, double, float, uuid } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { cursorCodec, cursorTokenMaxLength } from "#compiler/codec/cursor/codec.ts"
import { scalarReader } from "#compiler/codec/read.ts"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import { int8Max, int8Min } from "#compiler/core/limits.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { type Codebook, rosterCodec } from "#compiler/ir/codes.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { anyNumeric, plainType, wildcardText } from "#compiler/scalar/compute/types.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { toReal } from "#compiler/scalar/values/float.ts"
import { type Carrier, type CarrierHost, compareValues } from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import {
	monetaryContext,
	type SqlNames,
	textOut,
	vectorSchemaOf,
	wireSql
} from "#test/pg/codec/support.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { outputText, paramText } from "#test/support/wire.ts"
import { decimalGen } from "#test/unit/values/support.ts"

/**
 * The cursor codec against PostgreSQL 19: boundary values captured
 * from decoded database output survive the token exactly, and the decoded boundary, bound as the seek predicate's
 * cast parameter, splits PostgreSQL's own order exactly where the captured row sits.
 *
 * For each carrier, each case's drawn batch beside the carrier's edge values (-0, NaN, the infinities, exact decimals,
 * int8 extremes and supplementary-plane text where admitted) is sent through a recordset and read back in PostgreSQL's
 * ORDER BY, with each row's count of rows at or before it. Each decoded row value becomes a cursor, the cursor is
 * decoded, and its parameter text is bound as `$2::type` in `v < $2`, `v = $2` and `v > $2`: the three counts must be
 * exactly PostgreSQL's own split around that row, so a cursor after it continues at the next distinct value and nothing
 * is skipped or repeated. The host order of the decoded values agrees with PostgreSQL's (scalar/values compareValues).
 */
interface Case {
	readonly label: string
	readonly type: ScalarType
	readonly values: Gen<unknown>
	readonly edge: ReadonlyArray<unknown>
}

/** A code point PostgreSQL stores as it is: any Unicode scalar value but NUL, as a binary string draws them. */
const storedCodePoint: Gen<string> = filter(unicodeScalar, (c) => c !== "\u0000", 2)

/**
 * Texts of up to six code points, well-formed and without NUL: the order's cases (a shared prefix, a
 * supplementary-plane character against a BMP one) need no longer text.
 */
const textGen: Gen<string> = string(storedCodePoint, { min: 0, max: 6 })

/** Every double, NaN and the infinities among them. */
const anyDouble: Gen<number> = weighted([
	[17, double(-Number.MAX_VALUE, Number.MAX_VALUE)],
	[1, constant(Number.NaN)],
	[1, constant(Number.POSITIVE_INFINITY)],
	[1, constant(Number.NEGATIVE_INFINITY)]
])

/** The largest finite 32-bit float. */
const maxReal = 3.4028234663852886e38

/** Every 32-bit float, NaN and the infinities among them. */
const anyReal: Gen<number> = weighted([
	[17, float(-maxReal, maxReal)],
	[1, constant(Number.NaN)],
	[1, constant(Number.POSITIVE_INFINITY)],
	[1, constant(Number.NEGATIVE_INFINITY)]
])

/** A UUID of a version from 1 to 5. */
const anyUuid: Gen<string> = (source) =>
	source.draw(uuid(source.draw(element([1, 2, 3, 4, 5] as const))))

/** The endpoints a range draws among: -5 to 5. */
const endpoints: Arr.NonEmptyReadonlyArray<bigint> = [
	-5n,
	-4n,
	-3n,
	-2n,
	-1n,
	0n,
	1n,
	2n,
	3n,
	4n,
	5n
]

/** Two distinct endpoints, each pair as likely as any other, the lower one first. */
const smallRange: Gen<{ readonly start: bigint; readonly end: bigint }> = (source) => {
	const first = source.draw(int(0, endpoints.length - 1))
	const other = source.draw(int(0, endpoints.length - 2))
	const second = other >= first ? other + 1 : other
	const a = Arr.getUnsafe(endpoints, first)
	const b = Arr.getUnsafe(endpoints, second)
	return a < b ? { start: a, end: b } : { start: b, end: a }
}

/** The closed relation Kind's handles, in declared order: the enum the test creates. */
const kindHandles = ["Manual", "Automatic", "Ünïcode"] as const

/**
 * Kind's codes, with a hole before each of its last two handles, so a code is no handle's position and PostgreSQL's
 * order of codes is the roster's declared order only because every handle keeps its code.
 */
const kindCodes: Codebook = {
	rosters: new Map([
		[
			parsedName("Kind"),
			rosterCodec(parsedName("Kind"), [
				{ kind: "live", handle: "Manual" },
				{ kind: "hole" },
				{ kind: "live", handle: "Automatic" },
				{ kind: "hole" },
				{ kind: "live", handle: "Ünïcode" }
			])
		]
	])
}

const cases: Arr.NonEmptyReadonlyArray<Case> = [
	{
		label: "double precision",
		type: plainType("float8"),
		values: oneOf([anyDouble, element([0, 1, -1])]),
		edge: [
			-0,
			0,
			Number.NaN,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			5e-324,
			-5e-324
		]
	},
	{
		label: "real",
		type: plainType("float4"),
		values: filter(anyReal, (x) => toReal(x).ok, 100),
		edge: [-0, Number.NaN, Number.POSITIVE_INFINITY, 2 ** -149, Math.fround(0.1)]
	},
	{
		label: "numeric",
		type: anyNumeric,
		values: decimalGen,
		edge: [
			Decimal.nan,
			Decimal.infinity,
			Decimal.negativeInfinity,
			Decimal.of("1.0"),
			Decimal.of("1.00")
		]
	},
	{
		label: "bigint",
		type: plainType("int8"),
		values: bigint(int8Min.value, int8Max.value),
		edge: [int8Min.value, int8Max.value, 0n, -1n, 2n ** 53n + 1n]
	},
	{
		label: "text",
		type: wildcardText,
		values: textGen,
		/** U+FFFF sorts before U+10000 in code point order, though not in UTF-16 order. */
		edge: ["", "￿", "\u{10000}", "\u{1d11e}", "\u{10ffff}", "a\u{1f600}", "é", "é"]
	},
	{
		label: "uuid",
		type: scalarOf({ kind: "uuid" }, {}),
		values: anyUuid,
		edge: ["00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"]
	},
	{
		label: "money",
		type: plainType("money"),
		values: map(bigint(int8Min.value, int8Max.value), (u) => Money.of(u)),
		edge: [Money.min, Money.max, Money.zero]
	},
	{
		label: "closed id",
		type: scalarOf({ kind: "closedId", roster: "Kind" }, { Kind: kindHandles }),
		values: element(kindHandles),
		edge: [...kindHandles]
	},
	{
		label: "int8range",
		type: scalarOf(
			{ kind: "span", endpoint: { kind: "pg", type: "bigint" }, width: undefined },
			{}
		),
		values: smallRange,
		edge: [{ start: int8Min.value, end: int8Max.value }]
	}
]

const generation = { schema: "cursor-codec-pg", extensions: {} }

const setup = Effect.gen(function* () {
	const { session, schema } = yield* Substrate
	const db = yield* session(ownerSession())
	yield* monetaryContext(db)
	const name = yield* schema(freshSchema)
	const vector = yield* vectorSchemaOf(db)
	const names: SqlNames = { schema: quoteIdent(name), vector, codes: kindCodes }
	return { db, names }
})

/**
 * A case's batch: up to 60 values, the sample each carrier sent before the search, sent beside its edge values in one
 * recordset.
 */
const batchOf = (values: Gen<unknown>): Gen<ReadonlyArray<unknown>> =>
	array(values, { min: 1, max: 60 })

/** A batch for every carrier, in the order the carriers are listed: each case checks them all. */
const batches: Gen<ReadonlyArray<ReadonlyArray<unknown>>> = (source) =>
	Arr.map(cases, (c) => source.draw(batchOf(c.values)))

const agreement = (db: RawSession, names: SqlNames, c: Case, batch: ReadonlyArray<unknown>) =>
	Effect.gen(function* () {
		const scalar = scalarCodec(c.type, kindCodes)
		const reader = scalarReader(c.type, kindCodes)
		const codec = succeeded(
			cursorCodec(
				{
					query: `pg-${c.label}`,
					comparators: [{ field: "v", direction: "asc", type: c.type }],
					generation
				},
				cursorTokenMaxLength,
				kindCodes
			)
		)
		const sample = [...c.edge, ...batch]
		const payload = jsonText(Arr.map(sample, (v) => ({ v: succeeded(scalar.encode(v)) })))
		const wire = wireSql(c.type, names)
		const source = `jsonb_to_recordset($1::text::jsonb) AS r(v ${wire})`
		/** PostgreSQL's order, and for each row the number of rows ordered at or before it (its peers included). */
		const ordered = yield* db.values(
			`SELECT ${textOut(c.type, "r.v")}, (count(*) OVER (ORDER BY r.v))::text FROM ${source} ORDER BY r.v`,
			[payload]
		)
		const total = sample.length
		let previous = Option.none<CarrierHost[Carrier]>()
		for (const row of ordered) {
			const text = row[0]
			assert.ok(typeof text === "string", "a row's value is its text")
			const atOrBefore = Number(row[1])
			/** The boundary is captured from converted database output. */
			const captured = reader.convert(outputText(text))
			const decoded = succeeded(codec.decode(succeeded(codec.encode([captured]))))
			/**
			 * Exactly the captured value: its canonical text (a real's is the binary64 text of its binary32 value,
			 * which names it as exactly as PostgreSQL's shorter binary32 text does).
			 */
			const exact = scalar.text(captured)
			assert.equal(scalar.text(decoded.values[0]), exact)
			assert.equal(decoded.texts[0], paramText(exact))
			if (Option.isSome(previous)) {
				assert.ok(
					compareValues(scalar.spec, previous.value, decoded.values[0]) <= 0,
					"the host orders the decoded values as PostgreSQL does"
				)
			}
			previous = Option.some(decoded.values[0])
			const param = textOut(c.type, `$2::${wire}`)
			const [split] = yield* db.values(
				`SELECT (count(*) FILTER (WHERE r.v < $2::${wire}))::text, (count(*) FILTER (WHERE r.v = $2::${wire}))::text, (count(*) FILTER (WHERE r.v > $2::${wire}))::text, ${param} FROM ${source}`,
				[payload, decoded.texts[0]]
			)
			const [before, equal, after, echoed] = Arr.map(split ?? [], String)
			assert.equal(Number(after), total - atOrBefore)
			assert.equal(Number(before) + Number(equal), atOrBefore)
			assert.ok(Number(equal) >= 1)
			assert.ok(echoed !== undefined, "the bound parameter is echoed")
			assert.equal(scalar.text(reader.convert(outputText(echoed))), exact)
		}
	})

layer(Substrate.layer)("the cursor codec against PostgreSQL's order", (it) => {
	it.effect("splits PostgreSQL's order of every carrier exactly at each decoded boundary", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { db, names } = yield* setup
				return yield* explore(
					{
						oracle: { kind: "unstated" },
						suite: "cursor/codec",
						draw: drawn(batches),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						/**
						 * One drawn case per run besides the floor's, each a batch for every carrier: drawn afresh each run
						 * and shrunk when it fails.
						 */
						runs: 1,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(drawnBatches) =>
						Effect.forEach(
							Arr.zip(cases, drawnBatches),
							([c, batch]) => agreement(db, names, c, batch),
							{ discard: true }
						)
				)
			})
		)
	)
})
