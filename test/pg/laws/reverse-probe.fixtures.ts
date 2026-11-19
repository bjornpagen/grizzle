/** What the properties of reverse-probe.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import type { Case as SearchCase } from "@bjornpagen/testing/explore"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, String as Str } from "effect"
import { parsePlanTree, planNodes } from "#bench/harness/explain.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { installMigrated as install } from "#test/support/install-migrate.ts"
import {
	axesBox,
	type AxesFeature,
	axesFeaturesOf,
	axesParts,
	axesRelationsAt
} from "#test/support/laws/axes.ts"
import {
	columnNames,
	type ColumnType,
	expectedOf,
	featuresOf,
	freePositions,
	relationsAt,
	type ReverseCase,
	type ReverseFeature,
	reverseParts,
	setPositions
} from "#test/support/laws/reverse.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** Each axis whose probe a batch plans, by its family's kind (test/support/laws/axes.ts). */
type AxisKind =
	| "a family's owner axis"
	| "an ordered family's predecessor axis"
	| "a counted family's predecessor axis"
	| "a family's last axis"
	| "a tree's owner axis"
	| "a tree's predecessor axis"
	| "a tree's last axis"

/** How an axis's probe is served: by an index binding every referencing column, or by a unique one binding its own. */
type AxisServing =
	| "an axis served by an index its columns lead"
	| "an axis served by a unique index within them"

export const axisFeatures: Arr.NonEmptyReadonlyArray<AxisKind | AxisServing | AxesFeature> = [
	"a family's owner axis",
	"an ordered family's predecessor axis",
	"a counted family's predecessor axis",
	"a family's last axis",
	"a tree's owner axis",
	"a tree's predecessor axis",
	"a tree's last axis",
	"an axis served by an index its columns lead",
	"an axis served by a unique index within them",
	"a group of two fields",
	"folded axes",
	"an owner axis carrying a copy"
]

/**
 * The situations a batch reaches: each case's, a wide text stored in a row its source's selection leaves out, and each
 * axis of the axes' box with the index that serves it.
 */
export type ProbeFeature =
	| ReverseFeature
	| "a wide text stored"
	| AxisKind
	| AxisServing
	| AxesFeature

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

/**
 * A column's value in a row its source's selection leaves out: the wide text where its type has no bound, a set's empty
 * set of `bits`, its installed bit(n)'s width, which every value of it takes.
 */
const valueOf = (t: ColumnType, wide: string, bits: () => number): string => {
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
		case "set":
			return Str.repeat(bits())("0")
	}
}

/** The width n of a set column's installed bit(n), its domain's typmod or its own. */
const bitWidthSql = `SELECT coalesce(nullif(t.typtypmod, -1), a.atttypmod)::text FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type t ON t.oid = a.atttypid WHERE a.attrelid = $1::text::regclass AND a.attname = $2::text`

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
export const cases = 32

/** Every foreign key of a table, each by its name with its referencing columns in key order and its target's table
 * name. */
const foreignKeysOf = (session: RawSession, table: string) =>
	Effect.map(
		session.values(
			`SELECT c.conname::text, a.attname::text, t.relname::text, (quote_ident(tn.nspname) || '.' || quote_ident(t.relname))::text, f.attname::text FROM pg_catalog.pg_constraint c CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(attnum, fattnum, ord) JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum JOIN pg_catalog.pg_attribute f ON f.attrelid = c.confrelid AND f.attnum = k.fattnum JOIN pg_catalog.pg_class t ON t.oid = c.confrelid JOIN pg_catalog.pg_namespace tn ON tn.oid = t.relnamespace WHERE c.conrelid = '${table}'::regclass AND c.contype = 'f' ORDER BY c.conname, k.ord`,
			[]
		),
		(rows) =>
			Arr.map(
				Rec.toEntries(Arr.groupBy(rows, (r) => textCell(r, 0, "a constraint's name"))),
				([name, of]) => ({
					name,
					columns: Arr.map(of, (r) => textCell(r, 1, "a referencing column")),
					target: textCell(of[0], 2, "a referenced table"),
					targetTable: textCell(of[0], 3, "a referenced table, qualified"),
					referenced: Arr.map(of, (r) => textCell(r, 4, "a referenced column"))
				})
			)
	)

/** A foreign key as the catalog states it (`foreignKeysOf`). */
type CatalogReference = Effect.Success<ReturnType<typeof foreignKeysOf>>[number]

/** An index of a table: its access method, whether it is unique, and its key columns in order. */
interface TableIndex {
	readonly method: string
	readonly unique: boolean
	readonly columns: ReadonlyArray<string>
}

/** Every index of a table, by its name. */
const indexesOf = (session: RawSession, table: string) =>
	Effect.map(
		session.values(
			`SELECT i.relname::text, am.amname::text, x.indisunique::text, coalesce((SELECT string_agg(a.attname::text, ',' ORDER BY k.o) FROM unnest(x.indkey::int2[]) WITH ORDINALITY AS k(n, o) JOIN pg_catalog.pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.n WHERE k.o <= x.indnkeyatts), '') FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid JOIN pg_catalog.pg_am am ON am.oid = i.relam WHERE x.indrelid = '${table}'::regclass`,
			[]
		),
		(rows) =>
			new Map(
				Arr.map(rows, (r): readonly [string, TableIndex] => [
					textCell(r, 0, "an index's name"),
					{
						method: textCell(r, 1, "its access method"),
						unique: textCell(r, 2, "whether it is unique") === "true",
						columns: Str.split(textCell(r, 3, "its key columns"), ",")
					}
				])
			)
	)

/**
 * The index scans of a foreign key's reverse probe over `columns` of `table`, prepared as `name` and its generic plan
 * explained, failing `of` where the plan scans a relation sequentially or reads none through an index.
 */
const probeScans = (
	session: RawSession,
	table: string,
	columns: ReadonlyArray<string>,
	name: string,
	of: string
) =>
	Effect.gen(function* () {
		const probe = `SELECT 1 FROM ONLY ${table} x WHERE ${Arr.join(
			Arr.map(columns, (column, i) => `$${i + 1} = x.${quoteIdent(column)}`),
			" AND "
		)} FOR KEY SHARE OF x`
		yield* session.query(`PREPARE ${name} AS ${probe}`, [])
		const explained = yield* session.values(
			`EXPLAIN (FORMAT JSON) EXECUTE ${name}(${Arr.join(
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
			`${of}: it scans no relation sequentially`
		)
		const scans = Arr.filter(nodes, (n) => indexScans.has(n.nodeType))
		assert.ok(scans.length > 0, `${of}: it reads the referencing relation through an index`)
		return Arr.map(scans, (scan) => ({
			index: Option.getOrElse(scan.index, () =>
				assert.fail(`${of}: a ${scan.nodeType} names its index`)
			),
			cond: Option.getOrElse(scan.indexCond, () =>
				assert.fail(`${of}: the scan has an index condition`)
			)
		}))
	})

/** Whether a character continues an identifier PostgreSQL prints bare: a letter, a digit or an underscore. */
const identifierChar = (ch: string): boolean =>
	(ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_"

/** The identifiers an index condition names: its maximal runs of identifier characters. */
const identifiersOf = (cond: string): ReadonlySet<string> => {
	const out = new Set<string>()
	let run = ""
	for (const ch of cond) {
		if (identifierChar(ch)) {
			run += ch
		} else {
			if (run !== "") {
				out.add(run)
			}
			run = ""
		}
	}
	if (run !== "") {
		out.add(run)
	}
	return out
}

/** Whether an index condition binds a column, named whole in it. */
const binds = (cond: string, column: string): boolean => identifiersOf(cond).has(column)

/**
 * The referencing columns of `fk` that pair with each key of its target: every one, for the referenced columns
 * themselves, and those paired with each unique B-tree of the target within the referenced columns. The rows equal at
 * any of them reference one target row (test/support/laws/referencing.ts).
 */
const keyedRuns = (
	fk: CatalogReference,
	targetIndexes: ReadonlyMap<string, TableIndex>
): ReadonlyArray<ReadonlyArray<string>> => [
	fk.columns,
	...Arr.flatMap([...targetIndexes.values()], (key): ReadonlyArray<ReadonlyArray<string>> =>
		key.unique &&
		key.method === "btree" &&
		Arr.every(key.columns, (c) => Arr.contains(fk.referenced, c))
			? [
					Arr.flatMap(
						Arr.zip(fk.columns, fk.referenced),
						([column, referenced]: readonly [string, string]): ReadonlyArray<string> =>
							Arr.contains(key.columns, referenced) ? [column] : []
					)
				]
			: []
	)
]

/**
 * How an index scan of a probe reads only the rows that reference one target row: the scanned index leads with exactly
 * the columns of one of `runs` and its condition binds them all, or its condition binds every column of a unique index
 * of the relation, which finds at most one row; none where neither holds. A condition binding a run through an index
 * that holds another column before it is a skip scan, which reads every value of that column (PostgreSQL 18's B-tree
 * skip arrays), so the leading columns are judged, not the condition alone.
 */
const servedBy = (
	scan: { readonly index: string; readonly cond: string },
	runs: ReadonlyArray<ReadonlyArray<string>>,
	indexes: ReadonlyMap<string, TableIndex>
): AxisServing | undefined => {
	const leading = indexes.get(scan.index)?.columns ?? []
	return Arr.some(
		runs,
		(run) =>
			Arr.every(Arr.take(leading, run.length), (c) => Arr.contains(run, c)) &&
			leading.length >= run.length &&
			Arr.every(run, (c) => binds(scan.cond, c))
	)
		? "an axis served by an index its columns lead"
		: Arr.some(
					[...indexes.values()],
					(index) => index.unique && Arr.every(index.columns, (c) => binds(scan.cond, c))
			  )
			? "an axis served by a unique index within them"
			: undefined
}

/** An axis of the axes' box by the relations its foreign key joins and, in a tree, the columns it references from. */
const axisKind = (
	names: ReturnType<typeof axesRelationsAt>,
	relation: string,
	target: string,
	columns: ReadonlyArray<string>,
	column: (relation: string, field: string) => string
): AxisKind => {
	if (relation === names.node) {
		return Arr.contains(columns, column(relation, "parent"))
			? "a tree's owner axis"
			: Arr.contains(columns, column(relation, "end"))
				? "a tree's last axis"
				: "a tree's predecessor axis"
	}
	if (relation === names.orderedOwner || relation === names.countedOwner) {
		return "a family's last axis"
	}
	if (relation !== target) {
		return "a family's owner axis"
	}
	return relation === names.orderedMember
		? "an ordered family's predecessor axis"
		: "a counted family's predecessor axis"
}

/**
 * Installs a batch's containments and the axes' box as one schema, explains each foreign key's reverse probe, and
 * stores the containments' wide texts.
 */
export const probeBatch = (
	batch: ReadonlyArray<ReverseCase>,
	note: SearchCase<ProbeFeature>["noteAll"]
) =>
	Effect.gen(function* () {
		const containments = reverseParts(batch)
		const axes = Arr.map(axesBox, (a, at) => axesParts(a, at))
		const installed = yield* install(
			schema(
				"Reverse",
				Arr.map(
					[...containments.relations, ...Arr.flatMap(axes, (p) => p.relations)],
					([, r]) => r
				),
				[...containments.statements, ...Arr.flatMap(axes, (p) => p.statements)],
				[]
			),
			{
				ambient: ordinarySession,
				label: "reverse",
				logins: [],
				extensions: []
			}
		)
		const substrate = yield* Substrate
		const session = yield* substrate.session({ ...ownerSession(), label: "reverse probe" })
		yield* session.query("SET plan_cache_mode = force_generic_plan", [])
		yield* session.query("SET enable_seqscan = off", [])
		const tableOf = (relation: string): string => {
			const name = installed.names.relation(relation)
			return `${quoteIdent(name.schema)}.${quoteIdent(name.name)}`
		}
		for (const [at, c] of batch.entries()) {
			note(featuresOf(c))
			const expected = expectedOf(c)
			const { source } = relationsAt(at)
			const where = `${source}, ${Formatter.format(c)}`
			const table = tableOf(source)
			const foreignKeys = yield* foreignKeysOf(session, table)
			assert.ok(foreignKeys.length > 0, `${where}: the containment is a foreign key`)
			const indexes = yield* indexesOf(session, table)
			/** The rule's run is every referencing column: the index it plans binds them all, never a prefix. */
			const whole = expected.method === "btree" && expected.positions.length === c.types.length
			for (const [k, fk] of foreignKeys.entries()) {
				const of = `${where}, the probe of ${fk.name}`
				const scans = yield* probeScans(session, table, fk.columns, `probe${at}_${k}`, of)
				const targetIndexes = yield* indexesOf(session, fk.targetTable)
				const runs = keyedRuns(fk, targetIndexes)
				for (const scan of scans) {
					assert.equal(
						indexes.get(scan.index)?.method,
						expected.method,
						`${of}: ${scan.index} is the source's own, of the access method the rule plans`
					)
					assert.ok(
						!whole || servedBy(scan, runs, indexes) !== undefined,
						`${of}: ${scan.index} binds the referencing columns that pair with a key of the target, or a unique index's own; its condition is ${scan.cond}`
					)
				}
			}
			const frees = freePositions(c)
			if (c.selected && frees.length > 0) {
				const wide = wideText(at + 1)
				const measured = yield* Effect.forEach(setPositions(c), (i) =>
					Effect.map(
						session.values(bitWidthSql, [
							table,
							installed.names.column(source, defined(columnNames(c)[i], "a set column"))
						]),
						(rows) => [i, Number(textCell(rows[0], 0, "a set's bit width"))] as const
					)
				)
				const widths = new Map(measured)
				const fields = ["id", "live", "x", ...columnNames(c)]
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
						"00000000-0000-4000-8000-000000000000",
						...Arr.map(c.types, (t, i) =>
							valueOf(t, wide, () => defined(widths.get(i), "a set column's width"))
						)
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
		for (const [at, a] of axesBox.entries()) {
			note(axesFeaturesOf(a))
			const names = axesRelationsAt(at)
			const column = (relation: string, field: string): string =>
				installed.names.column(relation, field)
			for (const relation of Rec.values(names)) {
				const table = tableOf(relation)
				const indexes = yield* indexesOf(session, table)
				const foreignKeys = yield* foreignKeysOf(session, table)
				for (const [k, fk] of foreignKeys.entries()) {
					const target = Arr.findFirst(
						Rec.values(names),
						(r) => installed.names.relation(r).name === fk.target
					)
					const kind = axisKind(
						names,
						relation,
						Option.getOrElse(target, () =>
							assert.fail(`${fk.name} references a relation of its case`)
						),
						fk.columns,
						column
					)
					const of = `${relation} (${Formatter.format(a)}), ${kind}, the probe of ${fk.name}`
					note([kind])
					const scans = yield* probeScans(
						session,
						table,
						fk.columns,
						`axis${at}_${relation}_${k}`,
						of
					)
					const targetIndexes = yield* indexesOf(session, fk.targetTable)
					const runs = keyedRuns(fk, targetIndexes)
					for (const scan of scans) {
						assert.ok(indexes.has(scan.index), `${of}: ${scan.index} is the relation's own`)
						const served = servedBy(scan, runs, indexes)
						assert.ok(
							served !== undefined,
							`${of}: ${scan.index} binds the referencing columns that pair with a key of the target (${Arr.join(
								Arr.map(runs, (r) => Arr.join(r, ", ")),
								"; "
							)}), or a unique index's own; its condition is ${scan.cond}`
						)
						note([served])
					}
				}
			}
		}
	})
