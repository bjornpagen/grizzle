/**
 * What the properties of stored.test.ts read: their schemas, their writes, and the comparisons each COMMIT is held to,
 * the stored rows against their definition's and the decoded changes against the stored rows'.
 */

import { assert } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	Result,
	type Scope,
	String as Str
} from "effect"
import { transactionReader } from "#adapter/live/changes.ts"
import { decodeMessage } from "#adapter/live/pgoutput.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import { withLeading } from "#compiler/lower/conservative/context.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { admittedIdentifier, notificationText } from "#compiler/plan/runtime.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Fn, Logic } from "#compiler/public/compute.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
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
import { ordinarySession } from "#test/support/ambient.ts"
import { writeAnswerOf, writeOnce } from "#test/support/calls.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { installGenerated } from "#test/support/install-migrate.ts"
import { installFullWorld } from "#test/support/installed.ts"
import { standUpRelations, upkeepBodyOf } from "#test/support/judge.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { bytesOfHex } from "#test/support/pg/live/source.fixtures.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { roleSession, Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * A document's places, keyed by its shelf, the document, then the place, and a link out of a place, keyed alike: both
 * sit in the unit of the shelf, every write of them borrowing its shelf, and every stored relation over them stands at
 * a document or narrower, a region narrower than the shelf, so its upkeep re-derives the documents and places a write
 * touched alone, never the rest of the shelf (analysis/derived/storage.ts deltaBounded). Doc and Link are closed, their
 * facts inserted and never changed or removed, or open, written in place and deleted inside their unit.
 */
const Doc = relation("Doc", { shelf: pg.integer, doc: pg.integer, at: pg.integer, v: pg.integer }, [
	"shelf",
	"doc",
	"at"
])
const Link = relation(
	"Link",
	{ shelf: pg.integer, doc: pg.integer, at: pg.integer, to: pg.integer },
	["shelf", "doc", "at"]
)
const Shelf = unit("Shelf", { shelf: pg.integer })

/** The shelf every write of a case stands at: the borrow its transactions take, its documents the units its stored
 * relations are kept at. */
const shelf = 1

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

/** The relations a case's writer writes, each of which it stands up before its first write, and no other. */
const written = ["Doc", "Link"] as const

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
		[
			...(openness === "open" ? [mutable(Doc), mutable(Link), Shelf] : [Shelf]),
			key(on(Link, "doc", "at"))
		]
	)

/**
 * The stored relations, each kept at a document of the shelf or narrower, every one stored by the installation's
 * inference, unit-local within the shelf Doc and Link sit in at a unit narrower than the shelf, so a write's upkeep
 * re-derives the documents it touched alone (analysis/derived/storage.ts): a projection, a count by document, a
 * negation within it, the rows of a function each place's document and place are passed to, which a restriction to the
 * written units reads at the unit's channels (analysis/theory/unit.ts channelled), and Programmed, each linked place's
 * value's program, a function called once per distinct value of a document (ir/expr.ts evaluatesCall); and, a level
 * above them, Hops, the placed places linked back to a document's placed place 0, which reads the stored Placed's table
 * and the links through the stored Linked's: its
 * upkeep runs a stratum after Placed's and Linked's (physical/ddl/rules.ts), though Hops sorts before Placed by name,
 * and reads Placed's table as Placed's upkeep left it in the same COMMIT, at the units whose places or links the
 * transaction changed and those whose Placed rows that upkeep changed. Unshelved, each link by its document and place
 * alone, its head hiding the shelf, which Link's key on (doc, at) determines, is kept with the shelf beside its head
 * (analysis/theory/unit.ts HiddenUnit), metis's DashboardEntry's shape, each read of it reading its head's columns of
 * its table.
 */
const storedNames = [
	"Placed",
	"Unshelved",
	"Counted",
	"Unlinked",
	"Coded",
	"Programmed",
	"Hops",
	"Dense",
	"Weighted",
	"Crowded"
] as const

const topOf = (openness: Openness, name: string) => {
	const base = baseOf(openness, name)
	/** The places of a value at least 0, a selection of Doc's rows, so no copy of them (analysis/derived/storage.ts
	 * copiedRelation), stored: the box writes values from -1, so a place of value -1 is a row of Doc it never holds. */
	const Placed = derived(
		"Placed",
		query(base).rule((r) => {
			const { shelf, doc, at, v: x } = v(Doc, "d")
			return r.match(Doc, { shelf, doc, at, v: x }).where(r.ge(x, 0)).find({ shelf, doc, at, v: x })
		})
	)
	/** Each link of a target at least 0, by its document and place: a selection of Link's rows, so no copy of them
	 * (copiedRelation), stored with the shelf beside its head; the box writes targets from -1, so a link of target -1 is
	 * a row of Link it never holds. */
	const Unshelved = derived(
		"Unshelved",
		query(base).rule((r) => {
			const { shelf, doc, at, to } = v(Link, "l")
			return r.match(Link, { shelf, doc, at, to }).where(r.ge(to, 0)).find({ doc, at, to })
		})
	)
	const Counted = derived(
		"Counted",
		query(base).rule((r) => {
			const { shelf, doc, at } = v(Doc, "d")
			return r.match(Doc, { shelf, doc, at }).find({ shelf, doc, places: r.count() })
		})
	)
	const Unlinked = derived(
		"Unlinked",
		query(base).rule((r) => {
			const { shelf, doc, at } = v(Doc, "d")
			return r
				.match(Doc, { shelf, doc, at })
				.where(r.not(Link, { shelf, doc, at }))
				.find({ shelf, doc, at })
		})
	)
	const Coded = derived(
		"Coded",
		query(base).rule((r) => {
			const { shelf, doc, at } = v(Doc, "d")
			const run = Fn.rows(codes, { d: doc, p: at })
			const { code } = v(run, "run")
			return r.match(Doc, { shelf, doc, at }).match(run, { code }).find({ shelf, doc, at, code })
		})
	)
	/**
	 * Each linked place's program, its value's compile: edullm's WalkPattern, its pattern matches, an element and its
	 * attribute, joined back to their texts' compiles, whose upkeep calls `compile` once for each distinct value of a
	 * document it keeps. The compiles are an interior stage of its rule, each of a document's distinct values compiled,
	 * one compile a text: a stage of the rule alone, no relation of the schema, so no table holds the compiles and the
	 * upkeep's statement computes them beside the join, where an imported query of them would be stored and read by its
	 * table (analysis/theory/query.ts LiveReading `stored`).
	 */
	const Programmed = derived(
		"Programmed",
		query(base).rule((r) => {
			const compiled = r.interior((c) => {
				const { shelf, doc, v: value } = v(Doc, "t")
				return c
					.match(Doc, { shelf, doc, v: value })
					.find({ shelf, doc, value, program: Fn.call(compile, { x: value }) })
			})
			const { shelf, doc, at, v: value } = v(Doc, "d")
			const { program } = v(compiled, "c")
			return r
				.match(Doc, { shelf, doc, at, v: value })
				.match(Link, { shelf, doc, at })
				.match(compiled, { shelf, doc, value, program })
				.find({ shelf, doc, at, program })
		})
	)
	/** Each link of a target at least 0, a stored relation Hops reads by its table: a selection of Link's rows, so no copy
	 * of them (copiedRelation); the box writes targets from -1. */
	const Linked = derived(
		"Linked",
		query(base).rule((r) => {
			const { shelf, doc, at, to } = v(Link, "l")
			return r.match(Link, { shelf, doc, at, to }).where(r.ge(to, 0)).find({ shelf, doc, at, to })
		})
	)
	const lower = schema.extend(
		[base],
		`${name}_top`,
		[Placed, Unshelved, Counted, Unlinked, Coded, Programmed, Linked],
		[]
	)
	/**
	 * The places linked back to a document's place 0, both placed: a level above Placed and Linked, reading both stored
	 * tables, kept a stratum after them. A recursion along the links, as it was, is live: its unit, the shelf, is no
	 * founded unit, so no write's delta keeps a recursion's rows (analysis/derived/storage.ts `recursive`).
	 */
	const Hops = derived(
		"Hops",
		query(lower).rule((r) => {
			const { shelf, doc, at: origin } = v(Placed, "origin")
			const l = v(Linked, "l")
			return r
				.match(Placed, { shelf, doc, at: origin })
				.match(Linked, { shelf, doc, at: l.at, to: origin })
				.match(Placed, { shelf, doc, at: l.at })
				.where(r.eq(origin, 0))
				.find({ shelf, doc, at: l.at })
		})
	)
	/** The documents of two places or more, a stored relation over the stored Counted's table, kept a stratum after it. */
	const Dense = derived(
		"Dense",
		query(lower).rule((r) => {
			const { shelf, doc, places } = v(Counted, "c")
			return r.match(Counted, { shelf, doc, places }).where(r.ge(places, 2n)).find({ shelf, doc })
		})
	)
	/**
	 * Each place with each heavy weight, a stored relation that matches the closed Weight itself, a relation of no unit
	 * whose rows no write changes, so its upkeep reads Doc's captures alone (analysis/theory/unit.ts storedUpkeep's
	 * holders): edullm's ItemRecordVariable over the closed Declares. A derived relation over Weight alone would be
	 * stored frozen at the installation (analysis/theory/frozen.ts), a table no write changes, never a read of Weight.
	 */
	const Weighted = derived(
		"Weighted",
		query(lower).rule((r) => {
			const { shelf, doc, at } = v(Doc, "d")
			const { w } = v(Weight, "weight")
			return r
				.match(Doc, { shelf, doc, at })
				.match(Weight, { w })
				.where(r.ge(w, 2))
				.find({ shelf, doc, at, w })
		})
	)
	const top = schema.extend([lower], `${name}_reach`, [Hops, Dense, Weighted], [])
	/**
	 * The dense documents placed at 0, a level above Dense, over the stored Dense and Placed alone: its upkeep runs a
	 * stratum above Dense's, which is two above Counted's, and reads Dense's table, whose writes in phase A its captures
	 * take, so a writer's stand-up of Doc makes Dense's deltas, two upkeeps above it and beside no block that reads Doc
	 * (physical/ddl/rules.ts besidesOf).
	 */
	const Crowded = derived(
		"Crowded",
		query(top).rule((r) => {
			const { shelf, doc } = v(Dense, "d")
			return r
				.match(Dense, { shelf, doc })
				.match(Placed, { shelf, doc, at: 0 })
				.find({ shelf, doc })
		})
	)
	const crowd = schema.extend([top], `${name}_crowd`, [Crowded], [])
	/** Each stored relation read whole by a query over the highest level, which reads its table. */
	const reads: Readonly<Record<(typeof storedNames)[number], unknown>> = {
		Crowded: query(crowd).rule((r) => {
			const s = v(Crowded, "s")
			return r.match(Crowded, s).find(s)
		}),
		Placed: query(crowd).rule((r) => {
			const s = v(Placed, "s")
			return r.match(Placed, s).find(s)
		}),
		Unshelved: query(crowd).rule((r) => {
			const s = v(Unshelved, "s")
			return r.match(Unshelved, s).find(s)
		}),
		Counted: query(crowd).rule((r) => {
			const s = v(Counted, "s")
			return r.match(Counted, s).find(s)
		}),
		Unlinked: query(crowd).rule((r) => {
			const s = v(Unlinked, "s")
			return r.match(Unlinked, s).find(s)
		}),
		Coded: query(crowd).rule((r) => {
			const s = v(Coded, "s")
			return r.match(Coded, s).find(s)
		}),
		Programmed: query(crowd).rule((r) => {
			const s = v(Programmed, "s")
			return r.match(Programmed, s).find(s)
		}),
		Hops: query(crowd).rule((r) => {
			const s = v(Hops, "s")
			return r.match(Hops, s).find(s)
		}),
		Dense: query(crowd).rule((r) => {
			const s = v(Dense, "s")
			return r.match(Dense, s).find(s)
		}),
		Weighted: query(crowd).rule((r) => {
			const s = v(Weighted, "s")
			return r.match(Weighted, s).find(s)
		})
	}
	return { top: crowd, Placed, Counted, Unlinked, reads }
}

/**
 * One write of a transaction at document `doc` and place `at` of the case's shelf: a place put or taken, a link put or
 * taken, or, where Doc is open, a place's value changed in place.
 */
export type Write =
	| { readonly kind: "place"; readonly doc: number; readonly at: number; readonly value: number }
	| { readonly kind: "unplace"; readonly doc: number; readonly at: number }
	| { readonly kind: "link"; readonly doc: number; readonly at: number; readonly to: number }
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
				: (["place", "link"] as const)
		const kind = s.draw(element(kinds))
		const doc = s.draw(int(1, 2))
		const at = s.draw(int(0, 2))
		switch (kind) {
			case "place":
			case "revalue":
				return { kind, doc, at, value: s.draw(int(-1, 3)) }
			case "link":
				return { kind, doc, at, to: s.draw(int(-1, 1)) }
			case "unplace":
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

/** What a case reached: each kind of write, a place and a link a selection rejects, a transaction that wrote two
 * documents, and an open Doc. */
export type UpkeepFeature =
	| `wrote ${Write["kind"]}`
	| "wrote a place of a value Placed rejects"
	| "wrote a link of a target Linked rejects"
	| "two documents in one transaction"
	| "Doc open"

/** One write as the owner's direct SQL at the case's shelf, a writer outside grizzle's programs, which the captures see
 * as any, over the installation's names `names`. */
const sqlOf = (names: PhysicalNames, w: Write): string => {
	const table = (relation: string) => {
		const name = names.relation(relation)
		return `${quoteIdent(name.schema)}.${quoteIdent(name.name)}`
	}
	const doc = table("Doc")
	const link = table("Link")
	const column = (relation: string, field: string) => quoteIdent(names.column(relation, field))
	const at = (relation: string) =>
		`${column(relation, "shelf")} = ${shelf} AND ${column(relation, "doc")} = ${w.doc} AND ${column(relation, "at")} = ${w.at}`
	switch (w.kind) {
		case "place":
			return `INSERT INTO ${doc} (${column("Doc", "shelf")}, ${column("Doc", "doc")}, ${column("Doc", "at")}, ${column("Doc", "v")}) VALUES (${shelf}, ${w.doc}, ${w.at}, ${w.value}) ON CONFLICT DO NOTHING`
		case "unplace":
			return `DELETE FROM ${doc} WHERE ${at("Doc")}`
		case "link":
			return `INSERT INTO ${link} (${column("Link", "shelf")}, ${column("Link", "doc")}, ${column("Link", "at")}, ${column("Link", "to")}) VALUES (${shelf}, ${w.doc}, ${w.at}, ${w.to}) ON CONFLICT DO NOTHING`
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
		const opened = yield* installDerived(built.top, {}, "upkeep")
		yield* standUpRelations(s.admin, opened.installed.installation, written)
		/** Each stored relation's heading as a reader reads it, its definition's: its table's columns but those it holds
		 * beside them, Unshelved's shelf, which its head hides (analysis/derived/storage.ts). */
		const headingOf = (name: string) => {
			const relation = opened.analysis.schema.canonicalNamed(name)
			if (relation === undefined) {
				throw new Error(`no derived relation ${name}`)
			}
			return relation.definition.read.heading
		}
		/** Each stored relation's read, compiled once for the installation as a query of its rows is (oracle/union-take
		 * compiled), its one statement's text, which reads the relation's table, never its definition, each row it
		 * delivers read as record text by the relation's heading, its columns by name in the heading's order, as its
		 * table's rows at those columns are (`heldSql`): a query delivers its columns by name, in an order of its own. */
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
				const fields = Arr.map(headingOf(name), (f) => `"q".${quoteIdent(f.name)}`)
				return [name, `SELECT ROW(${Arr.join(fields, ", ")})::text FROM (${sql}) AS "q"`] as const
			})
		)
		/** Each stored relation's table's rows at the columns of its heading as a reader reads it (`headingOf`). */
		const heldSql = new Map(
			Arr.map(storedNames, (name) => {
				const columns = Arr.map(
					headingOf(name),
					(f) => `"r1".${quoteIdent(opened.installed.names.column(name, f.name))}`
				)
				return [
					name,
					`SELECT ROW(${Arr.join(columns, ", ")})::text FROM ${opened.view(name)} AS "r1"`
				] as const
			})
		)
		if (c.openness === "open") {
			reached.note("Doc open")
		}
		for (const [step, writes] of c.transactions.entries()) {
			for (const w of writes) {
				reached.note(`wrote ${w.kind}`)
				if ((w.kind === "place" || w.kind === "revalue") && w.value < 0) {
					reached.note("wrote a place of a value Placed rejects")
				}
				if (w.kind === "link" && w.to < 0) {
					reached.note("wrote a link of a target Linked rejects")
				}
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
				const read = yield* s.admin.queryValues(readSql.get(name) ?? "", [])
				const queried = Arr.sort(
					Arr.map(read, (row) => String(row[0])),
					Order.String
				)
				const table = yield* s.admin.queryValues(heldSql.get(name) ?? "", [])
				const held = Arr.sort(
					Arr.map(table, (row) => String(row[0])),
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
	return { top, world: fullWorld(top, programs, []) }
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
		yield* standUpRelations(s.admin, installed.installation, written)
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
 * The lawful schema, its level over the base named as an installation names its first level above the root (`_1`), so
 * a login over it names the role the installation made: Placed and Counted stored over the document's places, and three
 * laws over them, each judged over
 * the stored rows as the transaction leaves them: every link at a place (a containment into Placed, a rule reading its
 * table in phase B), no two places of a document of one value (a key over Placed that is no key it proves, its UNIQUE,
 * refusing at phase A), and at most two places a document (a check over Counted, its CHECK).
 */
const lawfulOf = (openness: Openness, name: string) => {
	const base = baseOf(openness, name)
	/** The places of a value at least 0, a selection of Doc's rows, so no copy of them (analysis/derived/storage.ts
	 * copiedRelation), stored: the box writes values from -1, so a place of value -1 is a row of Doc it never holds. */
	const Placed = derived(
		"Placed",
		query(base).rule((r) => {
			const { shelf, doc, at, v: x } = v(Doc, "d")
			return r.match(Doc, { shelf, doc, at, v: x }).where(r.ge(x, 0)).find({ shelf, doc, at, v: x })
		})
	)
	const Counted = derived(
		"Counted",
		query(base).rule((r) => {
			const { shelf, doc, at } = v(Doc, "d")
			return r.match(Doc, { shelf, doc, at }).find({ shelf, doc, places: r.count() })
		})
	)
	return schema.extend(
		[base],
		`${name}_1`,
		[Placed, Counted],
		[
			contained(on(Link, "shelf", "doc", "at"), on(Placed, "shelf", "doc", "at")),
			key(on(Placed, "shelf", "doc", "v")),
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

/** Placed's rows of `m`: its places of a value at least 0, as Placed's condition selects them. */
const placedOf = (m: Model): ReadonlyMap<string, number> =>
	new Map(Arr.filter([...m.places], ([, value]) => value >= 0))

/** The law of the lawful schema `m` breaks, if any: a link at no place Placed holds, two of Placed's places of a document
 * of one value, or more than two of Doc's places a document. */
const broken = (
	m: Model
): "a link at no place" | "a value twice in a document" | "three places" | undefined => {
	const placed = placedOf(m)
	if (Arr.some([...m.links], (k) => !placed.has(k))) {
		return "a link at no place"
	}
	const values = new Map<string, Array<number>>()
	for (const [k, value] of placed) {
		const [doc] = Str.split(":")(k)
		values.set(doc, [...(values.get(doc) ?? []), value])
	}
	if (Arr.some([...values.values()], (vs) => new Set(vs).size < vs.length)) {
		return "a value twice in a document"
	}
	const counts = new Map<string, number>()
	for (const k of m.places.keys()) {
		const [doc] = Str.split(":")(k)
		counts.set(doc, (counts.get(doc) ?? 0) + 1)
	}
	return Arr.some([...counts.values()], (n) => n > 2) ? "three places" : undefined
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
		const opened = yield* installDerived(lawfulOf(c.openness, "stored_lawful"), {}, "lawful")
		yield* standUpRelations(s.admin, opened.installed.installation, written)
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
				Arr.map([...placedOf(model)], ([k, value]) => `${k}:${value}`),
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
 * The queries of stored relation `relation`'s upkeep (physical/ddl/rules.ts upkeepBlock): the units it re-derives,
 * where it deletes at any, its removal's region, each a row of the unit's key, the first item its loop's query reads,
 * under the query's WITH, whose CTEs hold the calls of the readers its region shares with the definition the query reads
 * (physical/ddl/deltas.ts headed), none where its holders are closed, whose rows no served write removes, so it deletes
 * nothing and inserts the facts the rows a write adds gain (analysis/theory/upkeep.ts ClosedLoss); and its first
 * insert's rows: its definition at those units that its table does not hold yet, or the facts gained.
 */
const upkeepOf = (
	installation: Installation,
	relation: string
): { readonly units: Option.Option<OperandSelect>; readonly inserted: OperandSelect } => {
	const body = upkeepBodyOf(installation, relation)
	const [region] = Arr.flatMap(body, (step) => {
		if (step.kind !== "forQuery" || step.query.body.kind !== "core") {
			return []
		}
		const [first] = step.query.body.from
		return first?.kind === "derived" ? [withLeading(first.query, step.query.with?.ctes ?? [])] : []
	})
	const [inserted] = Arr.flatMap(body, (step) =>
		step.kind === "modify" &&
		step.statement.kind === "insert" &&
		step.statement.source.kind === "query"
			? [step.statement.source.query]
			: []
	)
	if (inserted === undefined) {
		throw new Error(`the upkeep of ${relation}: an insert of its rows`)
	}
	return { units: Option.fromUndefinedOr(region), inserted }
}

/**
 * The call count's leg: each transaction of the case run by the owner's direct SQL and, before its COMMIT, over the
 * deltas its captures wrote, Programmed's upkeep read as the judge reads it, its units first and then its insert's rows
 * whole, `compile` counting its calls (`callsSetting`), the transaction then rolled back and run again to COMMIT: the
 * insert calls `compile` exactly once for each distinct value each of its units, a document, holds as the transaction
 * leaves it, counted on the host's model of the places (`applied`), however many of its places hold the value and
 * links stand at them. Where Doc and Link are closed the upkeep deletes nothing and has no region (`upkeepOf`): its
 * units are the documents the transaction's writes add rows at, and its insert derives the facts the added rows gain
 * alone, so it calls `compile` at most once for each distinct value they hold.
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
		const opened = yield* installDerived(topOf(c.openness, "stored_calls").top, {}, "calls")
		const installation = opened.installed.installation
		yield* standUpRelations(s.admin, installation, written)
		if (c.openness === "open") {
			reached.note("Doc open")
		}
		const upkeep = upkeepOf(installation, "Programmed")
		const units = Option.map(
			upkeep.units,
			(region) =>
				`SELECT "u".c2::text FROM ${printExpr({ kind: "subquery", query: region })} AS "u"(c1, c2)`
		)
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
							const docs = Option.isSome(units)
								? yield* Effect.map(pinned.queryValues(units.value, []), (rows) =>
										Arr.map(rows, (row) => Number(String(row[0])))
									)
								: Arr.dedupe(Arr.map(writes, (w) => w.doc))
							const before = yield* pinned.queryValues(calls, [])
							yield* pinned.queryValues(inserted, [])
							const after = yield* pinned.queryValues(calls, [])
							return {
								docs,
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
			/** A unit form re-derives its units whole, so it calls compile once for each distinct value they hold; a closed
			 * form's gain derives the facts the added rows open alone, so it calls it at most that often. */
			const rederived = Option.isSome(units)
			if (rederived ? seen.calls !== expected : seen.calls > expected) {
				return yield* new OracleFixtureFailed({
					message: `in transaction ${step}, the upkeep of Programmed called compile ${seen.calls} times where its units, the documents ${Arr.join(
						Arr.map(seen.docs, String),
						", "
					)}, hold ${expected} distinct values, which its ${rederived ? "re-derivation calls it for exactly" : "gain calls it for at most"}`
				})
			}
			yield* transaction(
				s.admin,
				Arr.map(writes, (w) => sqlOf(opened.installed.names, w))
			)
		}
	})

/**
 * What a served write of the lawful schema's documents states: places of one document, each at its own place, and the
 * law of the lawful schema they break as the stored relations leave them at COMMIT, if any (`broken`): two values alike,
 * Placed's key; three places, Counted's check; two values apart, none.
 */
const servedPlaces = {
	"two places of one value": [5, 5],
	"three places": [1, 2, 3],
	"two places of two values": [1, 2]
} as const satisfies Readonly<Record<string, ReadonlyArray<number>>>

export type ServedPlaces = keyof typeof servedPlaces

export type ServedLawFeature =
	| "refused for a value twice in a document"
	| "refused for three places"
	| "a lawful write accepted"

export const servedPlacesGen: Gen<ServedPlaces> = element([
	"two places of one value",
	"three places",
	"two places of two values"
] as const)

/**
 * One case on a fresh clone: the lawful schema installed through its first migration with the full world's login over
 * it, whose served insert of Doc places `places`' values at places 0, 1, ... of document 1, on a brand-new backend. The
 * judge's phase A keeps Placed and Counted at its COMMIT, so a call that breaks Placed's key or Counted's check is refused
 * there by its native object, the UNIQUE or the CHECK of the stored table, and the refusal names the law as the schema
 * states it (adapter/outcomes/index.ts, witness/index.ts), as a write of an ordinary relation's key names its key: the
 * stored relations a write changes at COMMIT are among those its role's refusals keep (program/schema.ts raisableOf
 * over laws/model/model.ts changedBy), where they kept the relations its statements write alone, so the UNIQUE's 23505
 * reached the shell unclaimed, an ExecutionFailure naming the index (edullm's pantry: trimmed_mark and id_binding).
 */
export const servedLawRun = (places: ServedPlaces, reached: Case<ServedLawFeature>) =>
	Effect.gen(function* () {
		const label = "stored_served_law"
		const done = yield* installFullWorld(lawfulOf("closed", label), {}, [], {
			ambient: ordinarySession,
			label
		})
		const top = lawfulOf("closed", done.schema)
		const values = servedPlaces[places]
		const facts = Arr.map(values, (value, at) => ({ shelf, doc: 1, at, v: value }))
		yield* withServedDb(done, fullWorld(top, {}, []).server.roles.app, {}, ({ serve }) =>
			Effect.gen(function* () {
				const served = yield* serve({ insert: ChangeSet.empty(top).insert(Doc, []) })
				const outcome = yield* writeAnswerOf(
					writeOnce(member(served, "insert"))({ params: {}, facts: { insert: { Doc: facts } } })
				)
				const where = `${places} (${Arr.join(Arr.map(values, String), ", ")})`
				if (places === "two places of two values") {
					assert.equal(outcome.kind, "accepted", `${where}: ${Formatter.format(outcome)}`)
					reached.note("a lawful write accepted")
					return
				}
				assert.ok(
					"refused" in outcome,
					`${where} is refused as the laws': ${Formatter.format(outcome)}`
				)
				const named = Arr.map(refusedLaws(outcome.refused), (law) =>
					law.kind === "key"
						? `key ${law.side.relation}`
						: law.kind === "check"
							? `check ${law.relation} ${law.name}`
							: Formatter.format(law)
				)
				if (places === "two places of one value") {
					assert.deepEqual(named, ["key Placed"], `${where} is refused by Placed's key`)
					reached.note("refused for a value twice in a document")
					return
				}
				assert.deepEqual(named, ["check Counted few"], `${where} is refused by Counted's check`)
				reached.note("refused for three places")
			})
		)
	})
