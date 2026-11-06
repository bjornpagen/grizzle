/**
 * A containment's reverse probe is served by an index, generated: PostgreSQL's half of the reverse-index rule, whose
 * plan the law model's suite checks (test/unit/laws/model/reverse-index.test.ts).
 *
 * Before a target row is deleted or its key updated, PostgreSQL's RI trigger (ri_triggers.c, RI_FKey_noaction_del)
 * probes the source for a row that still references it, SELECT 1 FROM ONLY <source> x WHERE $1 = <column> AND ... FOR
 * KEY SHARE OF x over the foreign key's referencing columns, a plan it prepares once and reuses. Each case is a
 * containment drawn as test/support/laws/reverse.ts draws them: a free text at every position, a declared key over the
 * bounded columns or none, a selected source or not. A run installs a batch of them as one schema through its first
 * migration. For each case the probe over the foreign key's referencing columns, as pg_constraint lists them, is
 * prepared and its generic plan explained (plan_cache_mode = force_generic_plan) with sequential scans disabled
 * (enable_seqscan = off): the plan scans no relation sequentially, reads the source through an index scan, an index-only
 * scan or a bitmap index scan with an index condition, and every index it reads is the source's own, of the access
 * method the rule plans: a B-tree, or a hash index. A source text of no bound stores a 10,000-byte value, three times
 * BTMaxItemSize, in a row its selection leaves out.
 */
import { layer } from "@effect/vitest"
import { type Case as SearchCase, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { parsePlanTree, planNodes } from "#bench/harness/explain.ts"
import { indices } from "#compiler/core/array.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { installMigrated as install } from "#test/support/install-migrate.ts"
import {
	type ColumnType,
	columnNames,
	expectedOf,
	featuresOf,
	freePositions,
	type ReverseCase,
	type ReverseFeature,
	relationsAt,
	reverseCaseGen,
	reverseFeatures,
	reverseSchema
} from "#test/support/laws/reverse.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** The situations a batch reaches: each case's, and a wide text stored in a row its source's selection leaves out. */
type ProbeFeature = ReverseFeature | "a wide text stored"

/** The bytes of the wide text: three times BTMaxItemSize, past any B-tree entry however its datum is compressed. */
const wideBytes = 10_000

/**
 * A text of `wideBytes` printable ASCII bytes that no compression shrinks into a B-tree entry: the high bits of a
 * linear congruential sequence from `seed`.
 */
const wideText = (seed: number): string => {
	const chars: Array<string> = []
	let state = seed
	for (let i = 0; i < wideBytes; i++) {
		state = (Math.imul(state, 1103515245) + 12345) >>> 0
		chars.push(String.fromCharCode(33 + ((state >>> 16) % 94)))
	}
	return Arr.join(chars, "")
}

/** A column's value in a row its source's selection leaves out: the wide text where its type has no bound. */
const valueOf = (t: ColumnType, wide: string): string => {
	switch (t.kind) {
		case "uuid":
			return "00000000-0000-4000-8000-000000000000"
		case "bigint":
		case "integer":
		case "smallint":
			return "0"
		case "boolean":
			return "false"
		case "text":
			return "a"
		case "free":
			return wide
	}
}

/** The scans that read a relation through an index. */
const indexScans: ReadonlySet<string> = new Set([
	"Index Scan",
	"Index Only Scan",
	"Bitmap Index Scan"
])

/** A cell PostgreSQL returns as text, by what it is. */
const textCell = (row: ReadonlyArray<unknown> | undefined, at: number, what: string): string => {
	const cell = row?.[at]
	return typeof cell === "string" ? cell : assert.fail(`${what} is text`)
}

/** Containments per batch, each its own source and target of the batch's one schema. */
const cases = 32

/**
 * One run: the floor and the rotating stream draw one batch each. A shrink candidate is one migration of its own, so a
 * failing batch's shrink is bounded to 60 candidates.
 */
const reverseProbes = explore(
	{
		suite: "laws/reverse-probe",
		draw: drawn(array(reverseCaseGen, { min: cases, max: cases })),
		literal: Formatter.format,
		coverage: required<ProbeFeature>([...reverseFeatures, "a wide text stored"], {
			cases: 1,
			sense: notesOnly
		}),
		kept: [],
		runs: 1,
		shrink: { kind: "bounded", candidates: 60 },
		concurrency: 1,
		steerEvery: 16,
		caseHang
	},
	(b, c) => probeBatch(b, c.noteAll)
)

/** Installs a batch's containments as one schema, explains each one's reverse probe, and stores its wide texts. */
const probeBatch = (batch: ReadonlyArray<ReverseCase>, note: SearchCase<ProbeFeature>["noteAll"]) =>
	Effect.gen(function* () {
		const installed = yield* install(reverseSchema(batch), {
			ambient: ordinarySession,
			label: "reverse",
			logins: [],
			extensions: []
		})
		const substrate = yield* Substrate
		const session = yield* substrate.session({ ...ownerSession(), label: "reverse probe" })
		yield* session.query("SET plan_cache_mode = force_generic_plan", [])
		yield* session.query("SET enable_seqscan = off", [])
		for (const [at, c] of batch.entries()) {
			note(featuresOf(c))
			const expected = expectedOf(c)
			const { source } = relationsAt(at)
			const where = `${source}, ${Formatter.format(c)}`
			const name = installed.names.relation(source)
			const table = `${quoteIdent(name.schema)}.${quoteIdent(name.name)}`
			const references = yield* session.values(
				`SELECT c.conname::text, a.attname::text FROM pg_catalog.pg_constraint c CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum WHERE c.conrelid = '${table}'::regclass AND c.contype = 'f' ORDER BY k.ord`,
				[]
			)
			assert.equal(
				Arr.dedupe(Arr.map(references, (r) => textCell(r, 0, "a constraint's name"))).length,
				1,
				`${where}: one foreign key`
			)
			const columns = Arr.map(references, (r) => textCell(r, 1, "a referencing column"))
			const indexes = yield* session.values(
				`SELECT i.relname::text, am.amname::text FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid JOIN pg_catalog.pg_am am ON am.oid = i.relam WHERE x.indrelid = '${table}'::regclass`,
				[]
			)
			const methods = new Map(
				Arr.map(
					indexes,
					(r) => [textCell(r, 0, "an index's name"), textCell(r, 1, "its access method")] as const
				)
			)
			const probe = `SELECT 1 FROM ONLY ${table} x WHERE ${Arr.join(
				Arr.map(columns, (column, i) => `$${i + 1} = x.${quoteIdent(column)}`),
				" AND "
			)} FOR KEY SHARE OF x`
			yield* session.query(`PREPARE probe${at} AS ${probe}`, [])
			const explained = yield* session.values(
				`EXPLAIN (FORMAT JSON) EXECUTE probe${at}(${Arr.join(
					Arr.map(columns, () => "NULL"),
					", "
				)})`,
				[]
			)
			const nodes = planNodes(
				succeeded(parsePlanTree(explained[0]?.[0]), "one EXPLAIN plan")
			).toArray()
			assert.deepEqual(
				Arr.map(
					Arr.filter(nodes, (n) => n.nodeType === "Seq Scan"),
					(n) => n.relation
				),
				[],
				`${where}: the probe scans no relation sequentially`
			)
			const scans = Arr.filter(nodes, (n) => indexScans.has(n.nodeType))
			assert.ok(scans.length > 0, `${where}: the probe reads the source through an index`)
			for (const scan of scans) {
				const index = Option.getOrElse(scan.index, () =>
					assert.fail(`${where}: a ${scan.nodeType} names its index`)
				)
				assert.ok(Option.isSome(scan.indexCond), `${where}: ${index} has an index condition`)
				assert.equal(
					methods.get(index),
					expected.method,
					`${where}: ${index} is the source's own, of the access method the rule plans`
				)
			}
			const frees = freePositions(c)
			if (c.selected && frees.length > 0) {
				const wide = wideText(at + 1)
				const fields = ["id", "live", ...columnNames(c)]
				yield* session.query(
					`INSERT INTO ${table} (${Arr.join(
						Arr.map(fields, (f) => quoteIdent(installed.names.column(source, f))),
						", "
					)}) VALUES (${Arr.join(
						Arr.map(indices(fields.length), (i) => `$${i + 1}`),
						", "
					)})`,
					[
						`00000000-0000-4000-8000-${Str.padStart(12, "0")(String(at))}`,
						"false",
						...Arr.map(c.types, (t) => valueOf(t, wide))
					]
				)
				const stored = yield* session.values(
					`SELECT ${Arr.join(
						Arr.map(
							frees,
							(i) =>
								`octet_length(${quoteIdent(
									installed.names.column(source, defined(columnNames(c)[i], "a free column"))
								)})::text`
						),
						", "
					)} FROM ${table} WHERE NOT ${quoteIdent(installed.names.column(source, "live"))}`,
					[]
				)
				assert.deepEqual(
					stored,
					[Arr.map(frees, () => String(wideBytes))],
					`${where}: a source text of no bound stores ${wideBytes} bytes in a row its selection leaves out`
				)
				note(["a wide text stored"])
			}
		}
	})

layer(Substrate.layer)("a containment's reverse probe, generated", (it) => {
	it.effect(
		"is served by the source's index of the method the rule plans, and a text of no bound stores 10,000 bytes",
		(ctx) => searched(ctx, reverseProbes)
	)
})
