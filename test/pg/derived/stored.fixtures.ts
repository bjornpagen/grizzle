/**
 * What the properties of stored.test.ts read: their schemas, their writes, and the comparisons each COMMIT is held to,
 * the stored rows against their definition's and the decoded changes against the stored rows'.
 */

import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order, Result, type Scope, String as Str } from "effect"
import { transactionReader } from "#adapter/live/changes.ts"
import { decodeMessage } from "#adapter/live/pgoutput.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { admittedIdentifier, notificationText } from "#compiler/plan/runtime.ts"
import { Fn, Logic } from "#compiler/public/compute.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import { query, type SelfSource, v } from "#compiler/public/query.ts"
import {
	check,
	closed,
	contained,
	derived,
	fn,
	key,
	mutable,
	on,
	relation,
	rows,
	schema,
	unit
} from "#compiler/public/schema.ts"
import type { OperandSelect } from "#compiler/sql/ast.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { installDerived, OracleFixtureFailed, snapshotOf } from "#test/pg/derived/oracle/harness.ts"
import { bytesOfHex } from "#test/pg/live/source.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { installGenerated } from "#test/support/install-migrate.ts"
import { standUpJudge } from "#test/support/judge.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { roleSession, Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * A document's places, keyed by the document then the place, and a link out of a place, keyed alike: both sit in the
 * unit of the document, which a stored relation over them stands in. Doc is closed, never updated, or open, written in
 * place inside its unit.
 */
const Doc = relation("Doc", { doc: pg.integer, at: pg.integer, v: pg.integer }, ["doc", "at"])
const Link = relation("Link", { doc: pg.integer, at: pg.integer, to: pg.integer }, ["doc", "at"])
const Document = unit("Document", { doc: pg.integer })

/** A place's codes, a set-returning immutable function of its document and place, two rows for a first place. */
const codes = fn("codes", {
	calls: [],
	args: { d: pg.integer, p: pg.integer },
	returns: rows({ code: pg.integer }),
	volatility: "immutable",
	nullInput: "strict",
	language: "sql",
	body: fn.body`SELECT d * 10 + p UNION ALL SELECT d WHERE p = 0`
})

/** The setting `compile` counts its calls in, a placeholder any session may set, which its body names as written. */
const callsSetting = "stored_test.compiled"

/**
 * A value's program, declared immutable, as its value is a function of its argument alone, which counts each call of
 * it in the session's setting `callsSetting`: a body of PL/pgSQL, which PostgreSQL never inlines, so every evaluation
 * runs it. The count is set as the session's own (set_config's `false`), which a transaction that rolls back undoes,
 * and which no function's SET clause around the call restores.
 */
const compile = fn("compile", {
	calls: [],
	args: { x: pg.integer },
	returns: pg.integer,
	volatility: "immutable",
	nullInput: "called",
	language: "plpgsql",
	body: fn.body`\nBEGIN\n  PERFORM pg_catalog.set_config('stored_test.compiled', (COALESCE(NULLIF(pg_catalog.current_setting('stored_test.compiled', true), ''), '0')::integer + 1)::text, false);\n  RETURN x * 7 + 1;\nEND\n`
})

/** Whether Doc is closed or open. */
export type Openness = "closed" | "open"

/** A roster of shades and a closed relation weighing each, facts no write changes. */
const Shade = closed.ordered("Shade", ["light", "dark"])
const Weight = closed.relation(
	"Weight",
	{ shade: closedId(Shade), w: pg.integer },
	["shade"],
	[
		{ shade: "light", w: 1 },
		{ shade: "dark", w: 2 }
	]
)

const baseOf = (openness: Openness, name: string) =>
	schema(
		name,
		[Doc, Link, codes, compile, Shade, Weight],
		openness === "open" ? [mutable(Doc), Document] : [Document]
	)

/**
 * The stored relations, each over the document's unit: a projection, a count by document, a negation within it, the
 * rows of a function each place's document and place are passed to, which a restriction to the written units reads at
 * the unit's channels (analysis/theory/unit.ts channelled), and Programmed, each linked place's value's program, a
 * function called once per distinct value of a document (ir/expr.ts evaluatesCall); and, a level above them, Hops, the places a
 * document reaches from its place 0 back along links from placed places, a recursion whose base and step read the stored
 * Placed, which its upkeep reads through Placed's definition, the step's among them (analysis/theory/query.ts
 * liveQuery, theory.ts `maintained`), so it never reads Placed's table as phase A leaves it: Hops sorts before Placed,
 * so its upkeep runs first.
 */
const storedNames = [
	"Placed",
	"Counted",
	"Unlinked",
	"Coded",
	"Programmed",
	"Hops",
	"Dense",
	"Weighted"
] as const

const topOf = (openness: Openness, name: string) => {
	const base = baseOf(openness, name)
	const Placed = derived.stored(
		"Placed",
		query(base).rule((r) => {
			const { doc, at, v: x } = v(Doc, "d")
			return r.match(Doc, { doc, at, v: x }).find({ doc, at, v: x })
		})
	)
	const Counted = derived.stored(
		"Counted",
		query(base).rule((r) => {
			const { doc, at } = v(Doc, "d")
			return r.match(Doc, { doc, at }).find({ doc, places: r.count() })
		})
	)
	const Unlinked = derived.stored(
		"Unlinked",
		query(base).rule((r) => {
			const { doc, at } = v(Doc, "d")
			return r.match(Doc, { doc, at }).where(r.not(Link, { doc, at })).find({ doc, at })
		})
	)
	const Coded = derived.stored(
		"Coded",
		query(base).rule((r) => {
			const { doc, at } = v(Doc, "d")
			const run = Fn.rows(codes, { d: doc, p: at })
			const { code } = v(run, "run")
			return r.match(Doc, { doc, at }).match(run, { code }).find({ doc, at, code })
		})
	)
	/** The heavy weights, a live derived relation over the closed Weight, which a stored relation reads through it. */
	const Heavy = derived(
		"Heavy",
		query(base).rule((r) => {
			const { shade, w } = v(Weight, "weight")
			return r.match(Weight, { shade, w }).where(r.ge(w, 2)).find({ w })
		})
	)
	/** The places a link stands at, each with its value: edullm's written pattern matches, an element and its attribute. */
	const linked = query(base).rule((r) => {
		const { doc, at, v: value } = v(Doc, "d")
		return r.match(Doc, { doc, at, v: value }).match(Link, { doc, at }).find({ doc, at, value })
	})
	/** Each document's distinct values: edullm's pattern texts, one row a text, however many elements write it. */
	const values = query(base).rule((r) => {
		const { doc, v: value } = v(Doc, "d")
		return r.match(Doc, { doc, v: value }).find({ doc, value })
	})
	/** Each of a document's distinct values compiled (`compile`): edullm's compiled patterns, one compile a text. */
	const compiled = query(base).rule((r) => {
		const { doc, value } = v(values, "t")
		return r
			.match(values, { doc, value })
			.find({ doc, value, program: Fn.call(compile, { x: value }) })
	})
	/**
	 * Each linked place's program, its value's compile: edullm's WalkPattern, its pattern matches joined back to their
	 * texts' compiles, whose upkeep calls `compile` once for each distinct value of a document it keeps.
	 */
	const Programmed = derived.stored(
		"Programmed",
		query(base).rule((r) => {
			const { doc, at, value } = v(linked, "p")
			const { program } = v(compiled, "c")
			return r
				.match(linked, { doc, at, value })
				.match(compiled, { doc, value, program })
				.find({ doc, at, program })
		})
	)
	const lower = schema.extend(
		[base],
		`${name}_top`,
		[Placed, Counted, Unlinked, Coded, Programmed, Heavy],
		[]
	)
	const hop = { doc: pg.integer, at: pg.integer }
	const Hops = derived.stored(
		"Hops",
		query(lower).recursive("Hop", {
			row: hop,
			base: [
				(r) => {
					const { doc, at } = v(Placed, "p")
					return r.match(Placed, { doc, at }).where(r.eq(at, 0)).find({ doc, at })
				}
			],
			rec: [
				(r, self: SelfSource<typeof hop>) => {
					const s = v(self, "s")
					const l = v(Link, "l")
					return r
						.match(self, { doc: s.doc, at: s.at })
						.match(Link, { doc: s.doc, at: l.at, to: s.at })
						.match(Placed, { doc: s.doc, at: l.at })
						.find({ doc: s.doc, at: l.at })
				}
			]
		})
	)
	/** The documents of two places or more, a stored relation over the stored Counted, kept in the same COMMIT. */
	const Dense = derived.stored(
		"Dense",
		query(lower).rule((r) => {
			const { doc, places } = v(Counted, "c")
			return r.match(Counted, { doc, places }).where(r.ge(places, 2n)).find({ doc })
		})
	)
	/** Each place with each heavy weight, a stored relation reading the closed Weight through the live Heavy. */
	const Weighted = derived.stored(
		"Weighted",
		query(lower).rule((r) => {
			const { doc, at } = v(Doc, "d")
			const { w } = v(Heavy, "h")
			return r.match(Doc, { doc, at }).match(Heavy, { w }).find({ doc, at, w })
		})
	)
	const top = schema.extend([lower], `${name}_reach`, [Hops, Dense, Weighted], [])
	/** Each stored relation read whole by a query over the top level, which reads its table. */
	const reads: Readonly<Record<(typeof storedNames)[number], unknown>> = {
		Placed: query(top).rule((r) => {
			const s = v(Placed, "s")
			return r.match(Placed, s).find(s)
		}),
		Counted: query(top).rule((r) => {
			const s = v(Counted, "s")
			return r.match(Counted, s).find(s)
		}),
		Unlinked: query(top).rule((r) => {
			const s = v(Unlinked, "s")
			return r.match(Unlinked, s).find(s)
		}),
		Coded: query(top).rule((r) => {
			const s = v(Coded, "s")
			return r.match(Coded, s).find(s)
		}),
		Programmed: query(top).rule((r) => {
			const s = v(Programmed, "s")
			return r.match(Programmed, s).find(s)
		}),
		Hops: query(top).rule((r) => {
			const s = v(Hops, "s")
			return r.match(Hops, s).find(s)
		}),
		Dense: query(top).rule((r) => {
			const s = v(Dense, "s")
			return r.match(Dense, s).find(s)
		}),
		Weighted: query(top).rule((r) => {
			const s = v(Weighted, "s")
			return r.match(Weighted, s).find(s)
		})
	}
	return { top, Placed, Counted, Unlinked, reads }
}

/**
 * One write of a transaction at document `doc` and place `at`: a place put or taken, a link put or taken, or, where Doc
 * is open, a place's value changed in place.
 */
export type Write =
	| { readonly kind: "place"; readonly doc: number; readonly at: number; readonly value: number }
	| { readonly kind: "unplace"; readonly doc: number; readonly at: number }
	| { readonly kind: "link"; readonly doc: number; readonly at: number }
	| { readonly kind: "unlink"; readonly doc: number; readonly at: number }
	| { readonly kind: "revalue"; readonly doc: number; readonly at: number; readonly value: number }

export interface UpkeepCase {
	readonly openness: Openness
	/** The transactions, each its writes in order, each committed before the next begins. */
	readonly transactions: ReadonlyArray<ReadonlyArray<Write>>
}

const writeGen =
	(openness: Openness): Gen<Write> =>
	(s) => {
		const kinds =
			openness === "open"
				? (["place", "unplace", "link", "unlink", "revalue"] as const)
				: (["place", "unplace", "link", "unlink"] as const)
		const kind = s.draw(element(kinds))
		const doc = s.draw(int(1, 2))
		const at = s.draw(int(0, 2))
		switch (kind) {
			case "place":
			case "revalue":
				return { kind, doc, at, value: s.draw(int(0, 3)) }
			case "unplace":
			case "link":
			case "unlink":
				return { kind, doc, at }
		}
	}

export const upkeepCase: Gen<UpkeepCase> = (s) => {
	const openness: Openness = s.draw(boolean) ? "open" : "closed"
	return {
		openness,
		transactions: s.draw(array(array(writeGen(openness), { min: 1, max: 4 }), { min: 1, max: 5 }))
	}
}

/** What a case reached: each kind of write, a transaction that wrote two documents, and an open Doc. */
export type UpkeepFeature =
	| `wrote ${Write["kind"]}`
	| "two documents in one transaction"
	| "Doc open"

/** One write as the owner's direct SQL, a writer outside grizzle's programs, which the captures see as any, over the
 * installation's names `names`. */
const sqlOf = (names: PhysicalNames, w: Write): string => {
	const table = (relation: string) => {
		const name = names.relation(relation)
		return `${quoteIdent(name.schema)}.${quoteIdent(name.name)}`
	}
	const doc = table("Doc")
	const link = table("Link")
	const column = (relation: string, field: string) => quoteIdent(names.column(relation, field))
	const at = (relation: string) =>
		`${column(relation, "doc")} = ${w.doc} AND ${column(relation, "at")} = ${w.at}`
	switch (w.kind) {
		case "place":
			return `INSERT INTO ${doc} (${column("Doc", "doc")}, ${column("Doc", "at")}, ${column("Doc", "v")}) VALUES (${w.doc}, ${w.at}, ${w.value}) ON CONFLICT DO NOTHING`
		case "unplace":
			return `DELETE FROM ${doc} WHERE ${at("Doc")}`
		case "link":
			return `INSERT INTO ${link} (${column("Link", "doc")}, ${column("Link", "at")}, ${column("Link", "to")}) VALUES (${w.doc}, ${w.at}, 0) ON CONFLICT DO NOTHING`
		case "unlink":
			return `DELETE FROM ${link} WHERE ${at("Link")}`
		case "revalue":
			return `UPDATE ${doc} SET ${column("Doc", "v")} = ${w.value} WHERE ${at("Doc")}`
	}
}

/**
 * The case on a fresh installation: each transaction committed in turn by the owner's direct SQL, and after each
 * COMMIT, in one read-only snapshot, every stored relation's rows equal to its definition's rows there, the definition
 * evaluated by the conservative lowering, which relies on no evidence (oracle/harness.ts snapshotOf).
 */
export const upkeepRun = (
	c: UpkeepCase,
	reached: Case<UpkeepFeature>
): Effect.Effect<
	void,
	OracleFixtureFailed | CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const built = topOf(c.openness, "stored_upkeep")
		const opened = yield* installDerived(built.top, {}, "upkeep", [])
		yield* standUpJudge(s.admin, opened.installed.installation)
		/** Each stored relation's read, compiled once for the installation as a query of its rows is (oracle/union-take
		 * compiled), its one statement's text, which reads the relation's table, never its definition. */
		const readSql = new Map(
			Arr.map(storedNames, (name) => {
				const compiled = compileTemplate(built.reads[name], undefined, {
					...testCompile,
					installation: identity.schema(parsedSchemaName(opened.installed.schema))
				})
				if (!compiled.ok) {
					throw new Error(`a query of ${name}: ${compiled.error.message}`)
				}
				const sql = compiled.value.runs.optimized.statement.spec.sql
				if (!Str.includes(opened.view(name))(sql)) {
					throw new Error(
						`a query of ${name} reads its definition, not its table ${opened.view(name)}: ${sql}`
					)
				}
				return [name, sql] as const
			})
		)
		if (c.openness === "open") {
			reached.note("Doc open")
		}
		for (const [step, writes] of c.transactions.entries()) {
			for (const w of writes) {
				reached.note(`wrote ${w.kind}`)
			}
			if (new Set(Arr.map(writes, (w) => w.doc)).size > 1) {
				reached.note("two documents in one transaction")
			}
			yield* transaction(
				s.admin,
				Arr.map(writes, (w) => sqlOf(opened.installed.names, w))
			)
			const snapshot = yield* snapshotOf(opened, storedNames, storedNames)
			for (const name of storedNames) {
				const stored = Arr.map(snapshot.stored.get(name) ?? [], (r) => r.value)
				const defined = snapshot.defined.get(name) ?? []
				if (Arr.join(stored, "\n") !== Arr.join(defined, "\n")) {
					return yield* new OracleFixtureFailed({
						message: `after transaction ${step}, ${name} holds [${Arr.join(stored, "; ")}] where its definition gives [${Arr.join(defined, "; ")}]`
					})
				}
				const read = yield* s.admin.queryValues(
					`SELECT ROW("q".*)::text FROM (${readSql.get(name) ?? ""}) AS "q"`,
					[]
				)
				const queried = Arr.sort(
					Arr.map(read, (row) => String(row[0])),
					Order.String
				)
				const held = Arr.sort(
					Arr.map(snapshot.stored.get(name) ?? [], (r) => r.text),
					Order.String
				)
				if (Arr.join(queried, "\n") !== Arr.join(held, "\n")) {
					return yield* new OracleFixtureFailed({
						message: `after transaction ${step}, a query of ${name} reads [${Arr.join(queried, "; ")}] where its table holds [${Arr.join(held, "; ")}]`
					})
				}
			}
		}
	})

/**
 * The stored relations' schema named `name` and its full world's login (test/support/worlds.ts fullWorld), whose
 * workload watches each stored relation at one document, and Placed also at one value, a route outside its primary key
 * (doc, at), so its table is published whole (physical/ddl/live.ts identityOf).
 */
const watchedOf = (openness: Openness, name: string) => {
	const { top, Placed, Counted, Unlinked } = topOf(openness, name)
	const programs: Record<string, unknown> = {
		placedAt: query(top).rule((r) => {
			const { at, v: x } = v(Placed, "p")
			return r.match(Placed, { doc: r.param("doc", pg.integer), at, v: x }).find({ at, v: x })
		}),
		placedOf: query(top).rule((r) => {
			const { doc, at } = v(Placed, "p")
			return r.match(Placed, { doc, at, v: r.param("v", pg.integer) }).find({ doc, at })
		}),
		countedAt: query(top).rule((r) => {
			const { places } = v(Counted, "c")
			return r.match(Counted, { doc: r.param("doc", pg.integer), places }).find({ places })
		}),
		unlinkedAt: query(top).rule((r) => {
			const { at } = v(Unlinked, "u")
			return r.match(Unlinked, { doc: r.param("doc", pg.integer), at }).find({ at })
		})
	}
	return { top, world: fullWorld(top, programs) }
}

/** What a case of the watch reached: a stored row's route keys decoded, a commit that changed no stored row, and a
 * table published whole. */
export type WatchFeature =
	| "a stored row's change decoded"
	| "a commit that changed no stored row"
	| "a stored table published whole"
	| "Doc open"

/** A published stored table: its schema, and the columns its plan routes it by. */
interface StoredTable {
	readonly schema: string
	readonly routes: ReadonlyArray<string>
}

/** A stored row as the host reads it: its routed columns' texts, in the plan's order, and its whole row's text. */
interface StoredRow {
	readonly routed: ReadonlyArray<string>
	readonly whole: string
}

/** Each stored table's rows, by its installed identifier (StoredRow). */
const storedRows = (
	admin: PgConnection,
	tables: ReadonlyMap<string, StoredTable>
): Effect.Effect<ReadonlyMap<string, ReadonlyArray<StoredRow>>, SqlError> =>
	Effect.map(
		Effect.forEach([...tables], ([table, t]) =>
			Effect.map(
				admin.queryValues(
					`SELECT ${Arr.join(
						[...Arr.map(t.routes, (c) => `r.${quoteIdent(c)}::text`), "r::text"],
						", "
					)} FROM ${quoteIdent(t.schema)}.${quoteIdent(table)} AS r`,
					[]
				),
				(rows) =>
					[
						table,
						Arr.map(rows, (row): StoredRow => {
							const texts = Arr.map(row, String)
							return { routed: texts.slice(0, -1), whole: texts.at(-1) ?? "" }
						})
					] as const
			)
		),
		(entries) => new Map(entries)
	)

/**
 * The route keys a commit decodes to, from each stored table's rows before and after it: for each row one side holds
 * and the other does not, each routed column's keyed key at the row's value, or the table's key for a table routed by
 * none. The upkeep inserts and deletes and never updates, so a row it changed is a row one side alone holds.
 */
const keysOfChange = (
	tables: ReadonlyMap<string, StoredTable>,
	before: ReadonlyMap<string, ReadonlyArray<StoredRow>>,
	after: ReadonlyMap<string, ReadonlyArray<StoredRow>>
): ReadonlySet<string> => {
	const keys = new Set<string>()
	for (const [table, t] of tables) {
		const was = before.get(table) ?? []
		const now = after.get(table) ?? []
		const wasTexts = new Set(Arr.map(was, (row) => row.whole))
		const nowTexts = new Set(Arr.map(now, (row) => row.whole))
		const changed = [
			...Arr.filter(was, (row) => !nowTexts.has(row.whole)),
			...Arr.filter(now, (row) => !wasTexts.has(row.whole))
		]
		const named = admittedIdentifier<"table">(table)
		for (const row of changed) {
			if (t.routes.length === 0) {
				keys.add(notificationText({ kind: "table", table: named }))
			}
			for (const [i, column] of t.routes.entries()) {
				keys.add(
					notificationText({
						kind: "keyed",
						table: named,
						column: admittedIdentifier<"column">(column),
						value: row.routed[i] ?? ""
					})
				)
			}
		}
	}
	return keys
}

/**
 * The live leg: the case's schema generated with a login watching the stored relations, installed with its live
 * source, and a temporary pgoutput slot opened as the decoder login before the first transaction. After each COMMIT,
 * the slot's changes read through the leader's own reader (adapter/live/pgoutput.ts decodeMessage,
 * adapter/live/changes.ts transactionReader) are exactly one transaction holding the route keys of the stored rows the
 * commit's upkeep changed, computed on the host from the stored rows before and after it, or nothing where it changed
 * none: a watch of a stored relation is woken by the writing transaction itself.
 */
export const watchRun = (
	c: UpkeepCase,
	reached: Case<WatchFeature>
): Effect.Effect<
	void,
	OracleFixtureFailed | CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const generated = yield* installGenerated(
			(name) => {
				const watched = watchedOf(c.openness, name)
				return { schema: watched.top, logins: [watched.world.server] }
			},
			{ label: "upkeep_live", ambient: ordinarySession }
		)
		const { installed } = generated
		yield* standUpJudge(s.admin, installed.installation)
		if (c.openness === "open") {
			reached.note("Doc open")
		}
		const plan = installed.installation.live
		if (plan.kind === "none") {
			return yield* new OracleFixtureFailed({
				message: "a workload that watches holds no live plan"
			})
		}
		const tables = new Map(
			Arr.map(plan.tables, (t): readonly [string, StoredTable] => {
				const name = installed.names.relation(t.relation)
				return [
					name.name,
					{
						schema: name.schema,
						routes: Arr.map(t.routes, (f) => installed.names.column(t.relation, f))
					}
				]
			})
		)
		if (Arr.some(plan.tables, (t) => t.routes.length > 1)) {
			reached.note("a stored table published whole")
		}
		const publication = identifierOf(identity.liveSource(installed.schema))
		const slot = `${installed.schema}_decoded`
		const decoder = yield* s.session(roleSession(installed.decoder()))
		yield* decoder.query(
			"SELECT pg_catalog.pg_create_logical_replication_slot($1::name, 'pgoutput', true)",
			[slot]
		)
		const reader = transactionReader(
			new Map(Arr.map([...tables], ([table, t]) => [table, t.routes] as const)),
			identifierOf(identity.ledger())
		)
		for (const [step, writes] of c.transactions.entries()) {
			const before = yield* storedRows(s.admin, tables)
			yield* transaction(
				s.admin,
				Arr.map(writes, (w) => sqlOf(installed.names, w))
			)
			const after = yield* storedRows(s.admin, tables)
			const expected = keysOfChange(tables, before, after)
			const rows = yield* decoder.values(
				"SELECT pg_catalog.encode(data, 'hex') FROM pg_catalog.pg_logical_slot_get_binary_changes($1::name, NULL, NULL, 'proto_version', '1', 'publication_names', $2::text)",
				[slot, `"${publication}"`]
			)
			const decoded: Array<ReadonlySet<string>> = []
			for (const [hex] of rows) {
				const message = decodeMessage(bytesOfHex(String(hex)))
				if (Result.isFailure(message)) {
					return yield* new OracleFixtureFailed({ message: Formatter.format(message.failure) })
				}
				const read = reader.read(message.success)
				if (Result.isFailure(read)) {
					return yield* new OracleFixtureFailed({ message: read.failure.message })
				}
				if (read.success !== undefined) {
					decoded.push(new Set(Arr.map(read.success.notifications, notificationText)))
				}
			}
			reached.note(
				expected.size === 0
					? "a commit that changed no stored row"
					: "a stored row's change decoded"
			)
			const want = expected.size === 0 ? [] : [expected]
			const same =
				decoded.length === want.length &&
				Arr.every(decoded, (keys, i) => {
					const w = want[i] ?? new Set<string>()
					return keys.size === w.size && Arr.every([...keys], (k) => w.has(k))
				})
			if (!same) {
				return yield* new OracleFixtureFailed({
					message: `after transaction ${step}, decoded ${Formatter.format(Arr.map(decoded, (k) => [...k]))} where its stored rows' changes give ${Formatter.format(Arr.map(want, (k) => [...k]))}`
				})
			}
		}
	})

/**
 * The lawful schema: Placed and Counted stored over the document's places, and three laws over them, each judged over
 * the stored rows as the transaction leaves them: every link at a place (a containment into Placed, a rule reading its
 * table in phase B), no two places of a document of one value (a key over Placed that is no key it proves, its UNIQUE,
 * refusing at phase A), and at most two places a document (a check over Counted, its CHECK).
 */
const lawfulOf = (openness: Openness, name: string) => {
	const base = baseOf(openness, name)
	const Placed = derived.stored(
		"Placed",
		query(base).rule((r) => {
			const { doc, at, v: x } = v(Doc, "d")
			return r.match(Doc, { doc, at, v: x }).find({ doc, at, v: x })
		})
	)
	const Counted = derived.stored(
		"Counted",
		query(base).rule((r) => {
			const { doc, at } = v(Doc, "d")
			return r.match(Doc, { doc, at }).find({ doc, places: r.count() })
		})
	)
	return schema.extend(
		[base],
		`${name}_top`,
		[Placed, Counted],
		[
			contained(on(Link, "doc", "at"), on(Placed, "doc", "at")),
			key(on(Placed, "doc", "v")),
			check("few", Counted, (row) => Logic.le(row.places, 2n))
		]
	)
}

/** The host's model of the base relations: each place's value by its document and place, and each link. */
interface Model {
	readonly places: ReadonlyMap<string, number>
	readonly links: ReadonlySet<string>
}

const placeKey = (doc: number, at: number): string => `${doc}:${at}`

/** `m` after `w`, as the direct SQL of sqlOf writes it: a put place or link where none stands, a taken one, a changed value. */
const applied = (m: Model, w: Write): Model => {
	const k = placeKey(w.doc, w.at)
	const places = new Map(m.places)
	const links = new Set(m.links)
	switch (w.kind) {
		case "place":
			if (!places.has(k)) {
				places.set(k, w.value)
			}
			break
		case "unplace":
			places.delete(k)
			break
		case "link":
			links.add(k)
			break
		case "unlink":
			links.delete(k)
			break
		case "revalue":
			if (places.has(k)) {
				places.set(k, w.value)
			}
			break
	}
	return { places, links }
}

/** The law of the lawful schema `m` breaks, if any: a link at no place, two places of a document of one value, or more
 * than two places a document. */
const broken = (
	m: Model
): "a link at no place" | "a value twice in a document" | "three places" | undefined => {
	if (Arr.some([...m.links], (k) => !m.places.has(k))) {
		return "a link at no place"
	}
	const values = new Map<string, Array<number>>()
	for (const [k, value] of m.places) {
		const [doc] = Str.split(":")(k)
		values.set(doc, [...(values.get(doc) ?? []), value])
	}
	if (Arr.some([...values.values()], (vs) => new Set(vs).size < vs.length)) {
		return "a value twice in a document"
	}
	return Arr.some([...values.values()], (vs) => vs.length > 2) ? "three places" : undefined
}

/** What a case of the lawful property reached: a commit, each law's refusal, and an open Doc. */
export type LawfulFeature =
	| "a lawful transaction committed"
	| `refused for ${NonNullable<ReturnType<typeof broken>>}`
	| "Doc open"

/**
 * The lawful leg: each transaction of the case attempted on the lawful schema, which commits exactly where the state it
 * leaves keeps every law over the stored relations, computed on the host from the base relations alone (`broken`), and
 * is refused, an integrity violation (SQLSTATE class 23), changing nothing, where it breaks one; after each, every stored
 * relation's rows its definition's, and Placed's rows the host's places.
 */
export const lawfulRun = (
	c: UpkeepCase,
	reached: Case<LawfulFeature>
): Effect.Effect<
	void,
	OracleFixtureFailed | CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const opened = yield* installDerived(lawfulOf(c.openness, "stored_lawful"), {}, "lawful", [])
		yield* standUpJudge(s.admin, opened.installed.installation)
		if (c.openness === "open") {
			reached.note("Doc open")
		}
		/** The key over Placed is its table's UNIQUE beside its primary key, and the check over Counted its CHECK, never a
		 * rule reading their definitions. */
		const natives = yield* s.admin.queryValues(
			`SELECT (SELECT count(*) FROM pg_catalog.pg_index AS "i" WHERE "i".indrelid = '${opened.view("Placed")}'::regclass AND "i".indisunique)::text, (SELECT count(*) FROM pg_catalog.pg_constraint AS "k" WHERE "k".conrelid = '${opened.view("Counted")}'::regclass AND "k".contype = 'c')::text`,
			[]
		)
		const [uniques, checks] = Arr.map(natives[0] ?? [], String)
		if (uniques !== "2" || checks !== "1") {
			return yield* new OracleFixtureFailed({
				message: `Placed holds ${uniques ?? "no"} unique indexes where its primary key and its key's are two, and Counted ${checks ?? "no"} CHECKs where its check's is one`
			})
		}
		let model: Model = { places: new Map(), links: new Set() }
		for (const [step, writes] of c.transactions.entries()) {
			const next = Arr.reduce(writes, model, applied)
			const breaks = broken(next)
			const outcome = yield* Effect.result(
				transaction(
					s.admin,
					Arr.map(writes, (w) => sqlOf(opened.installed.names, w))
				)
			)
			if (Result.isSuccess(outcome)) {
				if (breaks !== undefined) {
					return yield* new OracleFixtureFailed({
						message: `transaction ${step} committed a state with ${breaks}`
					})
				}
				reached.note("a lawful transaction committed")
				model = next
			} else {
				const failure = outcome.failure
				const code =
					failure._tag === "SqlError" && failure.reason._tag === "ServerError"
						? failure.reason.fields.code
						: undefined
				if (breaks === undefined || code === undefined || !Str.startsWith("23")(code)) {
					return yield* new OracleFixtureFailed({
						message: `transaction ${step} was refused (${code ?? failure._tag}) where its state keeps every law (${breaks ?? "none broken"})`
					})
				}
				reached.note(`refused for ${breaks}`)
			}
			const snapshot = yield* snapshotOf(opened, ["Placed", "Counted"], ["Placed", "Counted"])
			for (const name of ["Placed", "Counted"]) {
				const stored = Arr.map(snapshot.stored.get(name) ?? [], (r) => r.value)
				const defined = snapshot.defined.get(name) ?? []
				if (Arr.join(stored, "\n") !== Arr.join(defined, "\n")) {
					return yield* new OracleFixtureFailed({
						message: `after transaction ${step}, ${name} holds [${Arr.join(stored, "; ")}] where its definition gives [${Arr.join(defined, "; ")}]`
					})
				}
			}
			const places = Arr.sort(
				Arr.map([...model.places], ([k, value]) => `${k}:${value}`),
				Order.String
			)
			const column = (field: string) => quoteIdent(opened.installed.names.column("Placed", field))
			const placed = yield* s.admin.queryValues(
				`SELECT ${column("doc")}::text || ':' || ${column("at")}::text || ':' || ${column("v")}::text FROM ${opened.view("Placed")}`,
				[]
			)
			const held = Arr.sort(
				Arr.map(placed, (row) => String(row[0])),
				Order.String
			)
			if (Arr.join(places, ";") !== Arr.join(held, ";")) {
				return yield* new OracleFixtureFailed({
					message: `after transaction ${step}, Placed holds [${Arr.join(held, "; ")}] where the host's places are [${Arr.join(places, "; ")}]`
				})
			}
		}
	})

/** What a case of the call count reached: a written document holding one value at two places, one holding a value no
 * linked place holds, and an open Doc. */
export type CallsFeature =
	| "a value at two places of a written document"
	| "a value at no linked place of a written document"
	| "Doc open"

/**
 * The two queries of stored relation `relation`'s upkeep (physical/ddl/rules.ts upkeepBlock): the units the transaction
 * wrote, its delete's region, each a row of the unit's key, and its insert's rows, its definition at those units that
 * its table does not hold yet.
 */
const upkeepOf = (
	installation: Installation,
	relation: string
): { readonly units: OperandSelect; readonly inserted: OperandSelect } => {
	const name = identifierOf(identity.storedUpkeep(relation))
	const body = Arr.flatMap(installation.statements, (statement) =>
		statement.kind === "createFunction" &&
		statement.language === "plpgsql" &&
		statement.name.name === name
			? statement.body.body
			: []
	)
	const [region] = Arr.flatMap(body, (step) =>
		step.kind === "modify" && step.statement.kind === "delete"
			? Arr.flatMap(step.statement.using, (u) => (u.kind === "derived" ? [u.query] : []))
			: []
	)
	const [inserted] = Arr.flatMap(body, (step) =>
		step.kind === "modify" &&
		step.statement.kind === "insert" &&
		step.statement.source.kind === "query"
			? [step.statement.source.query]
			: []
	)
	if (region === undefined || inserted === undefined) {
		throw new Error(`the upkeep of ${relation}: a delete at its region and an insert of its rows`)
	}
	return { units: region, inserted }
}

/**
 * The call count's leg: each transaction of the case run by the owner's direct SQL and, before its COMMIT, over the
 * deltas its captures wrote, Programmed's upkeep read as the judge reads it, its units first and then its insert's rows
 * whole, `compile` counting its calls (`callsSetting`), the transaction then rolled back and run again to COMMIT: the
 * insert calls `compile` exactly once for each distinct value each of its units, a document, holds as the transaction
 * leaves it, counted on the host's model of the places (`applied`), however many of its places hold the value and
 * links stand at them.
 */
export const callsRun = (
	c: UpkeepCase,
	reached: Case<CallsFeature>
): Effect.Effect<
	void,
	OracleFixtureFailed | CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const opened = yield* installDerived(topOf(c.openness, "stored_calls").top, {}, "calls", [])
		const installation = opened.installed.installation
		yield* standUpJudge(s.admin, installation)
		if (c.openness === "open") {
			reached.note("Doc open")
		}
		const upkeep = upkeepOf(installation, "Programmed")
		const units = `SELECT "u".c1::text FROM ${printExpr({ kind: "subquery", query: upkeep.units })} AS "u"(c1)`
		const inserted = `SELECT ROW("q".*)::text FROM ${printExpr({ kind: "subquery", query: upkeep.inserted })} AS "q"`
		const calls = `SELECT COALESCE(NULLIF(pg_catalog.current_setting('${callsSetting}', true), ''), '0')`
		let model: Model = { places: new Map(), links: new Set() }
		for (const [step, writes] of c.transactions.entries()) {
			model = Arr.reduce(writes, model, applied)
			const seen = yield* Effect.scoped(
				Effect.gen(function* () {
					const pinned = yield* s.admin.pin
					yield* pinned.query("BEGIN", [])
					return yield* Effect.ensuring(
						Effect.gen(function* () {
							for (const w of writes) {
								yield* pinned.query(sqlOf(opened.installed.names, w), [])
							}
							const docs = yield* pinned.queryValues(units, [])
							const before = yield* pinned.queryValues(calls, [])
							yield* pinned.queryValues(inserted, [])
							const after = yield* pinned.queryValues(calls, [])
							return {
								docs: Arr.map(docs, (row) => Number(String(row[0]))),
								calls: Number(String(after[0]?.[0])) - Number(String(before[0]?.[0]))
							}
						}),
						Effect.ignore(pinned.query("ROLLBACK", []))
					)
				})
			)
			let expected = 0
			for (const doc of seen.docs) {
				const placed = Arr.filter([...model.places], ([k]) => Str.startsWith(`${doc}:`)(k))
				const distinct = new Set(Arr.map(placed, ([, value]) => value))
				expected += distinct.size
				if (distinct.size < placed.length) {
					reached.note("a value at two places of a written document")
				}
				const linked = new Set(
					Arr.flatMap(placed, ([k, value]) => (model.links.has(k) ? [value] : []))
				)
				if (Arr.some([...distinct], (value) => !linked.has(value))) {
					reached.note("a value at no linked place of a written document")
				}
			}
			if (seen.calls !== expected) {
				return yield* new OracleFixtureFailed({
					message: `in transaction ${step}, the upkeep of Programmed called compile ${seen.calls} times where its units, the documents ${Arr.join(
						Arr.map(seen.docs, String),
						", "
					)}, hold ${expected} distinct values`
				})
			}
			yield* transaction(
				s.admin,
				Arr.map(writes, (w) => sqlOf(opened.installed.names, w))
			)
		}
	})
