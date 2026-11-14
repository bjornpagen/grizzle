/**
 * One rewrite per table: a migration over a populated installation rewrites each table at most once, however many
 * stored generated columns it adds to it, converts or drops, on PostgreSQL 19rc1.
 *
 * A case draws a populated first version, R(id, a, b, e, gone) and S(id, x), its rows, and a delta to a second
 * version: k ≤ 3 containments of R's rows selected by b = j into S's key, each a partial projection of a, which grizzle
 * stores as a STORED generated law column on R beside its foreign key; up to two generated fields of R over e; b
 * converted from integer to bigint, which the law columns read, so they go and come back around the conversion; a
 * field c added to R and gone dropped from it, as declared; a CHECK over c; and a new candidate key on S's x with R's e
 * contained in it, a foreign key onto a new UNIQUE. The rows keep every law of the second version by construction: a
 * and e name S rows, S's x values are distinct, and the reviewer gives c 0 and converts b by its cast.
 *
 * Oracle: PostgreSQL itself. A table_rewrite event trigger (test/support/migrate/rewrites.ts) records each table
 * PostgreSQL rewrites while the second version's folder applies, so the property is that no table of the installation
 * is rewritten twice; and the migrated catalog equals a fresh installation of the second version, both read from
 * PostgreSQL's catalog (test/pg/migrate/support.ts sameCatalog).
 *
 * Features: several stored generated columns added to one table; an add plus a drop on one table; a CHECK over a new
 * column; a cross-table foreign key onto a new UNIQUE; and a conversion beside generated columns over it. Each pending
 * one is aimed at by a case whose delta turns it on.
 *
 * The event trigger is the database's, so the file builds a database of its own (Substrate.isolatedLayer).
 *
 * Plant (~/.cache/grizzle-release/MIGBATCH/plants/rewrites-one-statement-per-column.patch): the diff drafts one ALTER
 * TABLE per subcommand again, so a table gaining two generated columns is rewritten twice.
 */
import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, type Gen, int, shuffled } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { printType, quoteIdent } from "#compiler/sql/print.ts"
import { sameCatalog } from "#test/pg/migrate/support.ts"
import {
	check,
	contained,
	eq,
	f,
	field,
	ge,
	key,
	literal,
	on,
	onWhere,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { migrated } from "#test/support/installed.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { Placeholder } from "#test/support/migrate/review.ts"
import { type RewriteMark, rewriteObserver } from "#test/support/migrate/rewrites.ts"
import { PropertyFailed } from "#test/support/oracle/runner.ts"
import { attempt, refusalText } from "#test/support/substrate.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** What the second version changes. */
interface Delta {
	/** The selected containments of R into S's key, by b = 0 … selections − 1, each a stored law column on R. */
	readonly selections: number
	/** The generated fields R gains over e. */
	readonly generated: number
	readonly retyped: boolean
	readonly added: boolean
	readonly dropped: boolean
	/** A CHECK over c, when R gains it. */
	readonly checked: boolean
	readonly referenced: boolean
}

/** A row of R: a and e by the S row they name, b, and gone. */
interface RRow {
	readonly a: number
	readonly b: number
	readonly e: number
	readonly gone: number
}

interface RewriteCase {
	readonly delta: Delta
	/** S's x values, one per row, distinct. */
	readonly xs: ReadonlyArray<number>
	readonly rows: ReadonlyArray<RRow>
}

const maxSelections = 3
const maxGenerated = 2
const maxS = 3
const maxR = 4

const deltaGen: Gen<Delta> = (s) => ({
	selections: s.draw(int(0, maxSelections)),
	generated: s.draw(int(0, maxGenerated)),
	retyped: s.draw(boolean),
	added: s.draw(boolean),
	dropped: s.draw(boolean),
	checked: s.draw(boolean),
	referenced: s.draw(boolean)
})

const rowGen: Gen<RRow> = (s) => ({
	a: s.draw(int(0, maxS - 1)),
	b: s.draw(int(0, maxSelections)),
	e: s.draw(int(0, maxS - 1)),
	gone: s.draw(int(-2, 2))
})

const caseGen: Gen<RewriteCase> = (s) => ({
	delta: s.draw(deltaGen),
	xs: s.draw(shuffled(Arr.range(10, 19), { min: 1, max: maxS })),
	rows: s.draw(array(rowGen, { min: 0, max: maxR }))
})

type Feature =
	| "several stored generated columns added to one table"
	| "an add plus a drop on one table"
	| "a CHECK over a new column"
	| "a cross-table foreign key onto a new UNIQUE"
	| "a conversion beside generated columns over it"

const features: Arr.NonEmptyReadonlyArray<Feature> = [
	"several stored generated columns added to one table",
	"an add plus a drop on one table",
	"a CHECK over a new column",
	"a cross-table foreign key onto a new UNIQUE",
	"a conversion beside generated columns over it"
]

/** The features a delta reaches. */
const reached = (d: Delta): ReadonlyArray<Feature> => [
	...(d.selections + d.generated >= 2
		? ["several stored generated columns added to one table" as const]
		: []),
	...(d.added && d.dropped ? ["an add plus a drop on one table" as const] : []),
	...(d.added && d.checked ? ["a CHECK over a new column" as const] : []),
	...(d.referenced ? ["a cross-table foreign key onto a new UNIQUE" as const] : []),
	...(d.retyped && d.selections > 0
		? ["a conversion beside generated columns over it" as const]
		: [])
]

/** The delta a case runs: the drawn one, with every feature its steering leaves pending turned on. */
const aimed = (d: Delta, c: Case<Feature>): Delta =>
	Option.match(c.steering, {
		onNone: () => d,
		onSome: (pending) => ({
			selections:
				pending.names("several stored generated columns added to one table") ||
				pending.names("a conversion beside generated columns over it")
					? Math.max(d.selections, 2)
					: d.selections,
			generated: d.generated,
			retyped: d.retyped || pending.names("a conversion beside generated columns over it"),
			added:
				d.added ||
				pending.names("an add plus a drop on one table") ||
				pending.names("a CHECK over a new column"),
			dropped: d.dropped || pending.names("an add plus a drop on one table"),
			checked: d.checked || pending.names("a CHECK over a new column"),
			referenced: d.referenced || pending.names("a cross-table foreign key onto a new UNIQUE")
		})
	})

const s = relation("S", { id: f.integer, x: f.integer }, ["id"])

/** The first version: R and S, no law but their keys. */
const first = (name: string): SchemaDesc => ({
	name,
	relations: [
		relation("R", { id: f.integer, a: f.integer, b: f.integer, e: f.integer, gone: f.integer }, [
			"id"
		]),
		s
	],
	statements: [],
	extends: undefined
})

/** The second version under `d`. */
const second = (name: string, d: Delta): SchemaDesc => ({
	name,
	relations: [
		relation(
			"R",
			{
				id: f.integer,
				a: f.integer,
				b: d.retyped ? f.bigint : f.integer,
				e: f.integer,
				...(d.dropped ? {} : { gone: f.integer }),
				...(d.added ? { c: f.integer } : {}),
				...Rec.fromEntries(
					Array.from(
						{ length: d.generated },
						(_, g) => [`g${g}`, f.generated(f.integer, field("e"))] as const
					)
				)
			},
			["id"]
		),
		s
	],
	statements: [
		...Array.from({ length: d.selections }, (_, j) =>
			contained(
				onWhere("R", ["a"], eq(field("b"), literal(d.retyped ? BigInt(j) : j))),
				on("S", ["id"])
			)
		),
		...(d.added && d.checked ? [check("CNonNegative", "R", ge(field("c"), literal(0)))] : []),
		...(d.referenced ? [key(on("S", ["x"])), contained(on("R", ["e"]), on("S", ["x"]))] : [])
	],
	extends: undefined
})

/** The drops the second version declares: gone, when it drops it. */
const declaredOf =
	(d: Delta) =>
	(version: number): Declarations =>
		version === 1 && d.dropped
			? {
					renames: [],
					drops: [{ kind: "field", relation: parsedName("R"), field: parsedName("gone") }]
				}
			: noDeclarations

/** The reviewer's value of each placeholder: 0 for an added column, a conversion by its cast. */
const reviewed = (p: Placeholder): string => {
	switch (p.kind) {
		case "placeholderColumn":
			return "0"
		case "placeholderRetype":
			return `${quoteIdent(p.column.name)}::${printType(p.column.type)}`
	}
}

const tableOf = (schema: string, name: string): string =>
	`${quoteIdent(schema)}.${quoteIdent(identifierOf(identity.table(parsedName(name))))}`

const columnsOf = (names: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.map(names, (n) => quoteIdent(identifierOf(identity.column(parsedName(n))))),
		", "
	)

/** The first version's rows: S's x values, and R's rows, a and e naming S rows by their index. */
const rowsSql = (schema: string, c: RewriteCase): ReadonlyArray<string> => {
	const id = (i: number): number => (i % c.xs.length) + 1
	const x = (i: number): number => Arr.getUnsafe(c.xs, i % c.xs.length)
	return [
		...Arr.map(
			c.xs,
			(value, i) =>
				`INSERT INTO ${tableOf(schema, "S")} (${columnsOf(["id", "x"])}) VALUES (${i + 1}, ${value})`
		),
		...Arr.map(
			c.rows,
			(r, i) =>
				`INSERT INTO ${tableOf(schema, "R")} (${columnsOf(["id", "a", "b", "e", "gone"])}) VALUES (${i + 1}, ${id(r.a)}, ${r.b}, ${x(r.e)}, ${r.gone})`
		)
	]
}

const failed = (report: string) => Effect.fail(new PropertyFailed({ report }))

const property = (c: RewriteCase, notes: Case<Feature>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const observer = yield* rewriteObserver(substrate)
			const d = aimed(c.delta, notes)
			for (const feature of reached(d)) {
				notes.note(feature)
			}
			const state: { schema: string; mark: Option.Option<RewriteMark> } = {
				schema: "",
				mark: Option.none()
			}
			const counted: Array<ReadonlyMap<string, number>> = []
			const observe = (version: number, owner: RawSession) =>
				Effect.gen(function* () {
					if (version === 0) {
						const loaded = yield* Effect.orDie(attempt(owner, rowsSql(state.schema, c)))
						if (loaded.kind !== "committed") {
							return yield* Effect.die(
								new Error(`the first version refused its rows: ${refusalText(loaded.fields)}`)
							)
						}
						const mark = yield* observer.mark
						state.mark = Option.some(mark)
						return
					}
					const mark = yield* Option.match(state.mark, {
						onNone: () => Effect.die(new Error("the second version applies after the first")),
						onSome: Effect.succeed
					})
					const counts = yield* observer.since(mark, state.schema)
					counted.push(counts)
				})
			const m = yield* migrated({
				label: "rewrites",
				schemaName: { kind: "unique" },
				first: (name) => {
					state.schema = identifierOf(identity.schema(parsedSchemaName(name)))
					return { schema: first(name), logins: [] }
				},
				later: [(name) => ({ schema: second(name, d), logins: [] })],
				apply: { kind: "values", value: reviewed },
				declared: declaredOf(d),
				observe: Option.some(observe)
			})
			const rewrites = Arr.flatMap(counted, (counts) => [...counts])
			const twice = Arr.filter(rewrites, ([, n]) => n > 1)
			if (twice.length > 0) {
				return yield* failed(
					`the migration rewrote ${Arr.join(
						Arr.map(twice, ([table, n]) => `${table} ${n} times`),
						", "
					)}, where each table is rewritten at most once: ${Formatter.format(d)}`
				)
			}
			const fresh = yield* migrated({
				label: "rewrites_fresh",
				schemaName: { kind: "unique" },
				first: (name) => ({ schema: second(name, d), logins: [] }),
				later: [],
				apply: { kind: "noPlaceholders" },
				declared: () => noDeclarations,
				observe: Option.none()
			})
			yield* sameCatalog(
				m.installation,
				fresh.installation,
				"the migrated second version against a fresh one"
			)
		})
	)

layer(Substrate.isolatedLayer)("one rewrite per table on PostgreSQL", (it) => {
	it.effect(
		"a migration over a populated installation rewrites each table at most once, and its catalog is a fresh installation's",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "postgresql",
							name: "PostgreSQL's table_rewrite events during the migration, and its catalog of the migrated and of a fresh installation"
						},
						suite: "pg/migrate/rewrites",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<Feature>(features, { cases: 2 * features.length, sense: notesOnly }),
						kept: [],
						runs: 6,
						shrink: { kind: "bounded", candidates: 20 },
						concurrency: 1,
						steerEvery: 2,
						caseHang
					},
					(c, notes) => property(c, notes)
				)
			)
	)
})
