/**
 * Rules over queries through grizzle's migrations, on PostgreSQL 19rc2: a migration that adds a rule over a query, or
 * changes one or a definition it reads, runs its violation query over the stored rows and fails exactly where a row
 * breaks it, the rule it installs holds at every COMMIT after, through a declared rename of a table its query reads,
 * and the migrated catalog is a fresh install's of the second version, through a field the rule reads dropped and added
 * again and a table it reads dropped.
 *
 * A case draws rows of Fact(id, k, a), S(id, k, b, c) and T(a, b), the first version's rule over J2 = Fact ⋈ S on k
 * (none, or J2's facts whose b is not 0 contained in T), the second's (those facts, every fact of J2, or the facts of
 * Unpaired contained in T, the facts of J2 whose k no S row shares whose b is a T row's a: a negated join of S and T),
 * and one change of the second version: none; Fact renamed to Moved, as declared; Fact dropped, as declared, and Moved
 * added in its place, a new identity holding none of Fact's rows, so the judge's captures of Fact go with its table; or
 * S's b turned from a field its caller writes into one generated from c, which the migration drops and adds again (a
 * rewritten field), under S's captures (physical/ddl/rules.ts addRules), statement triggers that name no column, so no
 * trigger stands over the redefined column and each capture keeps its name. Every S row holds c
 * equal to b, so b keeps its value. A case constructed to reach the change of a definition a rule reads keeps the first
 * version's selected rule as it is and widens J2 to every pair of a Fact row and an S row, whatever their k: the same
 * law, a containment being named by its sides, whose check is a new one, since the definition it reads changed. It
 * stores a Fact row of one k and an S row of the other whose b is 1, so the first J2 holds no fact and the rows keep
 * its rule, while the widened J2 holds their pair, which no T row holds. That case, and one for each required situation
 * a drawn case reaches in one case of twenty or fewer (a changed rule or a rule over a negated join refused over rows
 * that break it, S's captures kept through b's redefinition, a write refused after a rename), is
 * constructed (constructed), and a witness whose turn aims at what it reaches draws it (aimed). The rows are
 * stored under the first version, where its rule admits them. The oracle is the rule restated over the rows: the second
 * migration fails, its violation check raising 23000, exactly when the rows it carries break its rule; once it applies,
 * the migrated schema holds the catalog a fresh install of the second version holds, both read from PostgreSQL's
 * catalog (test/pg/migrate/support.ts sameCatalog): its triggers, constraints, indexes and columns; and one transaction
 * writing drawn rows of Fact (or Moved), S and T commits exactly when the rows then keep the installed rule, and is
 * otherwise refused at COMMIT with 23503.
 *
 * Features: an added and a changed rule, each refused over rows that break it and applied over rows that keep it; a
 * rule kept through the widening of J2 refused over rows that break it; the same over a negated join; a write the
 * installed rule admits committed and one it breaks refused at COMMIT; a rule over a renamed table refusing such a
 * write; S's captures kept under their names through a column the migration drops and adds again, read off
 * PostgreSQL's catalog before and after the migration (S's b at another attnum, and S's triggers by name); and a
 * capture on a table the migration drops (Fact's, read off the catalog before it).
 */
import { aimed, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Data, Effect, Formatter, Option } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { generated, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema, select } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { sameCatalog } from "#test/pg/migrate/support.ts"
import { migrated } from "#test/support/installed.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { attempt, refusalText } from "#test/support/substrate.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A version's rule: none, J2's facts whose b is not 0 contained in T, every fact of J2, or every fact of Unpaired, which
 * negates a join of S and T.
 */
type Rule = "none" | "selected" | "every" | "negated"

/** Rows of Fact as (k, a), of S as (k, b) and of T as (a, b). */
interface Rows {
	readonly facts: ReadonlyArray<readonly [number, number]>
	readonly s: ReadonlyArray<readonly [number, number]>
	readonly t: ReadonlyArray<readonly [number, number]>
}

/** What the second version changes beside its rule: nothing, Fact renamed to Moved, Fact dropped and Moved added in
 * its place (a new identity, Fact's rows lost as declared), S's b generated from c, which the migration drops and adds
 * again, or J2 widened to every pair of a Fact row and an S row, whatever their k (J2Join), under the first version's
 * rule kept as it is: the same law, its definition changed. */
type Change = "kept" | "renamed" | "dropped" | "redefined" | "widened"

/** How a version's J2 pairs Fact's rows with S's: on k, or every pair, whatever their k. */
type J2Join = "onK" | "widened"

/** A case: the two versions' rules, the second's change, the rows stored under the first, and the rows a transaction
 * writes once the second applies. */
interface MigrationCase {
	readonly first: Rule
	readonly second: Exclude<Rule, "none">
	readonly change: Change
	readonly stored: Rows
	readonly written: Rows
}

const pairGen: Gen<readonly [number, number]> = (s) => [s.draw(int(0, 1)), s.draw(int(0, 1))]

const rowsGen: Gen<Rows> = (s) => ({
	facts: s.draw(array(pairGen, { min: 0, max: 3 })),
	s: s.draw(array(pairGen, { min: 0, max: 3 })),
	t: s.draw(array(pairGen, { min: 0, max: 3 }))
})

const caseGen: Gen<MigrationCase> = (s) => ({
	first: s.draw(element(["none", "selected"] as const)),
	second: s.draw(element(["selected", "every", "negated"] as const)),
	change: s.draw(element(["kept", "renamed", "dropped", "redefined"] as const)),
	stored: s.draw(rowsGen),
	written: s.draw(rowsGen)
})

/** No rows. */
const noRows: Rows = { facts: [], s: [], t: [] }

/**
 * The cases constructed to reach what a drawn case reaches in one case of twenty or fewer, each from rows that keep the
 * first version's rule, the one a witness whose turn aims at its situation draws (aimed):
 *
 * - a changed rule the stored rows break: J2's facts whose b is not 0 changed to every fact of J2, over a fact of J2
 *   whose b is 0 and no T row;
 * - a rule over a negated join the stored rows break: Unpaired's rule added over a fact of Unpaired and no T row;
 * - a rule kept through a change of its definition that the stored rows break: the first version's selected rule kept
 *   as it is through J2 widened, over a Fact row of k and an S row of the other k whose b is 1, so the first J2 holds
 *   no fact and the stored rows keep its rule, while the widened J2 holds their pair, whose (a, 1) no T row holds;
 * - S's captures kept through a redefined column: the selected rule kept through S's b redefined;
 * - a rule over a renamed table refusing a write: every fact of J2 added through Fact's rename, over no stored rows,
 *   then a fact of J2 written with no T row.
 */
const constructed: Arr.NonEmptyReadonlyArray<readonly [Feature, Gen<MigrationCase>]> = [
	[
		"a changed rule the stored rows break refused",
		(s) => {
			const k = s.draw(int(0, 1))
			return {
				first: "selected",
				second: "every",
				change: "kept",
				stored: { facts: [[k, s.draw(int(0, 1))]], s: [[k, 0]], t: [] },
				written: s.draw(rowsGen)
			}
		}
	],
	[
		"a rule over a negated join the stored rows break refused",
		(s) => {
			const k = s.draw(int(0, 1))
			return {
				first: "none",
				second: "negated",
				change: "kept",
				stored: { facts: [[k, s.draw(int(0, 1))]], s: [[k, s.draw(int(0, 1))]], t: [] },
				written: s.draw(rowsGen)
			}
		}
	],
	[
		"a rule kept through a change of its definition the stored rows break refused",
		(s) => {
			const k = s.draw(int(0, 1))
			return {
				first: "selected",
				second: "selected",
				change: "widened",
				stored: { facts: [[k, s.draw(int(0, 1))]], s: [[1 - k, 1]], t: [] },
				written: s.draw(rowsGen)
			}
		}
	],
	[
		"S's captures kept under their names through a redefined column",
		(s) => ({
			first: "selected",
			second: "selected",
			change: "redefined",
			stored: s.draw(rowsGen),
			written: s.draw(rowsGen)
		})
	],
	[
		"a rule over a renamed table holds after the rename",
		(s) => {
			const k = s.draw(int(0, 1))
			return {
				first: "none",
				second: "every",
				change: "renamed",
				stored: noRows,
				written: { facts: [[k, s.draw(int(0, 1))]], s: [[k, s.draw(int(0, 1))]], t: [] }
			}
		}
	]
]

/** Whether two pairs are one. */
const samePair = (x: readonly [number, number], y: readonly [number, number]): boolean =>
	x[0] === y[0] && x[1] === y[1]

/** T's rows of `rows` a write adds beside `held`: each pair once, none `held` already holds, as T's key requires. */
const newT = (
	rows: Rows,
	held: ReadonlyArray<readonly [number, number]>
): ReadonlyArray<readonly [number, number]> =>
	Arr.filter(Arr.dedupeWith(rows.t, samePair), (p) => !Arr.some(held, (h) => samePair(h, p)))

/** The rows `stored` and `written` hold together. */
const union = (stored: Rows, written: Rows): Rows => ({
	facts: [...stored.facts, ...written.facts],
	s: [...stored.s, ...written.s],
	t: [...stored.t, ...written.t]
})

/** The relation Fact's declared name at a version. */
const factName = (c: MigrationCase, after: boolean): string =>
	after && (c.change === "renamed" || c.change === "dropped") ? "Moved" : "Fact"

const S = relation("S", { id: pg.integer, k: pg.integer, b: pg.integer, c: pg.integer }, ["id"])
/** S with b generated from c: the field a migration from S drops and adds again. */
const SGenerated = relation.generated(
	"S",
	{ id: pg.integer, k: pg.integer, c: pg.integer },
	["id"],
	(row) => ({
		b: generated(pg.integer, row.c)
	})
)
const T = relation("T", { a: pg.integer, b: pg.integer }, ["a", "b"])
const Fact = relation("Fact", { id: pg.integer, k: pg.integer, a: pg.integer }, ["id"])
const Moved = relation("Moved", { id: pg.integer, k: pg.integer, a: pg.integer }, ["id"])

/**
 * The version under `name` with Fact: Fact, S and T, J2 = Fact ⋈ S on k, or every pair of their rows where `join` is
 * widened, Unpaired = the facts of Fact ⋈ S on k whose k no S row shares whose b is a T row's a, and `rule`.
 */
const factVersion = (name: string, rule: Rule, join: J2Join) => {
	const Base = schema(name, [Fact, S, T], [])
	const J2 = derived(
		"J2",
		query(Base).rule((r) => {
			const { k, a } = v(Fact, "fact")
			const { b } = v(S, "s")
			return join === "onK"
				? r.match(Fact, { k, a }).match(S, { k, b }).find({ k, a, b })
				: r.match(Fact, { k, a }).match(S, { b }).find({ k, a, b })
		})
	)
	const paired = query(Base).rule((r) => {
		const { k, b } = v(S, "s")
		return r.match(S, { k, b }).match(T, { a: b }).find({ k })
	})
	const Unpaired = derived(
		"Unpaired",
		query(Base).rule((r) => {
			const { k, a } = v(Fact, "fact")
			const { b } = v(S, "s")
			return r
				.match(Fact, { k, a })
				.match(S, { k, b })
				.where(r.not(paired, { k }))
				.find({ k, a, b })
		})
	)
	switch (rule) {
		case "none":
			return schema.extend(Base, `${name}_1`, [J2, Unpaired], [])
		case "every":
			return schema.extend(
				Base,
				`${name}_1`,
				[J2, Unpaired],
				[contained(on(J2, "a", "b"), on(T, "a", "b"))]
			)
		case "selected":
			return schema.extend(
				Base,
				`${name}_1`,
				[J2, Unpaired],
				[
					contained(
						on(
							select(J2, (j) => j.ne(j.b, 0)),
							"a",
							"b"
						),
						on(T, "a", "b")
					)
				]
			)
		case "negated":
			return schema.extend(
				Base,
				`${name}_1`,
				[J2, Unpaired],
				[contained(on(Unpaired, "a", "b"), on(T, "a", "b"))]
			)
	}
}

/** The version under `name` with S's b generated from c (SGenerated). */
const generatedVersion = (name: string, rule: Rule) => {
	const Base = schema(name, [Fact, SGenerated, T], [])
	const J2 = derived(
		"J2",
		query(Base).rule((r) => {
			const { k, a } = v(Fact, "fact")
			const { b } = v(SGenerated, "s")
			return r.match(Fact, { k, a }).match(SGenerated, { k, b }).find({ k, a, b })
		})
	)
	const paired = query(Base).rule((r) => {
		const { k, b } = v(SGenerated, "s")
		return r.match(SGenerated, { k, b }).match(T, { a: b }).find({ k })
	})
	const Unpaired = derived(
		"Unpaired",
		query(Base).rule((r) => {
			const { k, a } = v(Fact, "fact")
			const { b } = v(SGenerated, "s")
			return r
				.match(Fact, { k, a })
				.match(SGenerated, { k, b })
				.where(r.not(paired, { k }))
				.find({ k, a, b })
		})
	)
	switch (rule) {
		case "none":
			return schema.extend(Base, `${name}_1`, [J2, Unpaired], [])
		case "every":
			return schema.extend(
				Base,
				`${name}_1`,
				[J2, Unpaired],
				[contained(on(J2, "a", "b"), on(T, "a", "b"))]
			)
		case "selected":
			return schema.extend(
				Base,
				`${name}_1`,
				[J2, Unpaired],
				[
					contained(
						on(
							select(J2, (j) => j.ne(j.b, 0)),
							"a",
							"b"
						),
						on(T, "a", "b")
					)
				]
			)
		case "negated":
			return schema.extend(
				Base,
				`${name}_1`,
				[J2, Unpaired],
				[contained(on(Unpaired, "a", "b"), on(T, "a", "b"))]
			)
	}
}

/** The version under `name` with Fact renamed to Moved. */
const movedVersion = (name: string, rule: Rule) => {
	const Base = schema(name, [Moved, S, T], [])
	const J2 = derived(
		"J2",
		query(Base).rule((r) => {
			const { k, a } = v(Moved, "fact")
			const { b } = v(S, "s")
			return r.match(Moved, { k, a }).match(S, { k, b }).find({ k, a, b })
		})
	)
	const paired = query(Base).rule((r) => {
		const { k, b } = v(S, "s")
		return r.match(S, { k, b }).match(T, { a: b }).find({ k })
	})
	const Unpaired = derived(
		"Unpaired",
		query(Base).rule((r) => {
			const { k, a } = v(Moved, "fact")
			const { b } = v(S, "s")
			return r
				.match(Moved, { k, a })
				.match(S, { k, b })
				.where(r.not(paired, { k }))
				.find({ k, a, b })
		})
	)
	switch (rule) {
		case "none":
			return schema.extend(Base, `${name}_1`, [J2, Unpaired], [])
		case "every":
			return schema.extend(
				Base,
				`${name}_1`,
				[J2, Unpaired],
				[contained(on(J2, "a", "b"), on(T, "a", "b"))]
			)
		case "selected":
			return schema.extend(
				Base,
				`${name}_1`,
				[J2, Unpaired],
				[
					contained(
						on(
							select(J2, (j) => j.ne(j.b, 0)),
							"a",
							"b"
						),
						on(T, "a", "b")
					)
				]
			)
		case "negated":
			return schema.extend(
				Base,
				`${name}_1`,
				[J2, Unpaired],
				[contained(on(Unpaired, "a", "b"), on(T, "a", "b"))]
			)
	}
}

/** The case's version: the first, or the second, with the case's change. */
const versionOf = (name: string, c: MigrationCase, after: boolean) => {
	if (!after) {
		return factVersion(name, c.first, "onK")
	}
	switch (c.change) {
		case "kept":
			return factVersion(name, c.second, "onK")
		case "widened":
			return factVersion(name, c.second, "widened")
		case "renamed":
		case "dropped":
			return movedVersion(name, c.second)
		case "redefined":
			return generatedVersion(name, c.second)
	}
}

/** Whether some S row of k has a b that is a T row's a: whether the k is paired, which Unpaired negates. */
const paired = (c: Rows, k: number): boolean =>
	Arr.some(c.s, ([sk, b]) => sk === k && Arr.some(c.t, ([ta]) => ta === b))

/** How the second version's J2 pairs Fact's rows with S's: widened by its change, on k otherwise. */
const secondJoin = (c: MigrationCase): J2Join => (c.change === "widened" ? "widened" : "onK")

/**
 * Whether the rows keep `rule`, J2 pairing them by `join`: every fact of J2 or Unpaired it reads has its (a, b) in T.
 */
const keeps = (c: Rows, rule: Rule, join: J2Join): boolean =>
	rule === "none" ||
	Arr.every(c.facts, ([k, a]) =>
		Arr.every(
			Arr.filter(c.s, ([sk, b]) =>
				rule === "negated"
					? sk === k && !paired(c, k)
					: (join === "widened" || sk === k) && (rule === "every" || b !== 0)
			),
			([, b]) => Arr.some(c.t, ([ta, tb]) => ta === a && tb === b)
		)
	)

const tableOf = (schemaIdent: string, relationName: string): string =>
	`${quoteIdent(schemaIdent)}.${quoteIdent(identifierOf(identity.table(parsedName(relationName))))}`

/** S's triggers by name, and the attnum of its column b. */
interface STriggers {
	readonly names: ReadonlyArray<string>
	readonly b: number
}

/** The first column of each row a catalog query returns, as text. */
const texts = (rows: ReadonlyArray<ReadonlyArray<unknown>>): ReadonlyArray<string> =>
	Arr.flatMap(rows, (row) => Arr.filter(row.slice(0, 1), (x) => typeof x === "string"))

/** The names of a table's own triggers, read as the owner from PostgreSQL's catalog. */
const triggerNamesOf = (owner: RawSession, table: string) =>
	Effect.map(
		owner.values(
			"SELECT t.tgname::pg_catalog.text FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid = $1::pg_catalog.text::pg_catalog.regclass AND NOT t.tgisinternal",
			[table]
		),
		texts
	).pipe(Effect.orDie)

/** S's triggers (STriggers), read as the owner from PostgreSQL's catalog. */
const sTriggersOf = (owner: RawSession, table: string) =>
	Effect.gen(function* () {
		const names = yield* triggerNamesOf(owner, table)
		const b = yield* owner.values(
			"SELECT a.attnum::pg_catalog.text FROM pg_catalog.pg_attribute AS a WHERE a.attrelid = $1::pg_catalog.text::pg_catalog.regclass AND a.attname = 'b' AND NOT a.attisdropped",
			[table]
		)
		return { names, b: Number(Arr.join(texts(b), "")) }
	}).pipe(Effect.orDie)

type Feature =
	| "a write the installed rule admits committed"
	| "a write the installed rule breaks refused at COMMIT"
	| "an added rule the stored rows break refused"
	| "an added rule the stored rows keep applied"
	| "a changed rule the stored rows break refused"
	| "a changed rule the stored rows keep applied"
	| "a rule kept through a change of its definition the stored rows break refused"
	| "a rule over a renamed table holds after the rename"
	| "a rule over a negated join the stored rows break refused"
	| "a rule over a negated join the stored rows keep applied"
	| "S's captures kept under their names through a redefined column"
	| "a capture on a dropped table"

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

layer(Substrate.layer)("rules over queries through migrations on PostgreSQL 19rc2", (it) => {
	it.effect(
		"fail a migration adding or changing a rule over a query exactly where the stored rows break it, leave a fresh install's catalog where it applies, and hold the rule it installs at every COMMIT after",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "laws/rule-query-migrate",
						draw: aimed(caseGen, constructed),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the rule restated over the rows: a migration installing it applies exactly when the stored rows keep it, and a write after it commits exactly when the rows then keep it; and PostgreSQL's catalog of a fresh install of the second version"
						},
						coverage: required<Feature>(
							[
								"an added rule the stored rows break refused",
								"an added rule the stored rows keep applied",
								"a changed rule the stored rows break refused",
								"a changed rule the stored rows keep applied",
								"a rule kept through a change of its definition the stored rows break refused",
								"a rule over a renamed table holds after the rename",
								"a write the installed rule admits committed",
								"a write the installed rule breaks refused at COMMIT",
								"a rule over a negated join the stored rows break refused",
								"a rule over a negated join the stored rows keep applied",
								"S's captures kept under their names through a redefined column",
								"a capture on a dropped table"
							],
							{ cases: 60, sense: notesOnly }
						),
						kept: [],
						runs: 24,
						shrink: { kind: "bounded", candidates: 20 },
						concurrency: 1,
						steerEvery: 8,
						caseHang
					},
					(c, n) =>
						Effect.gen(function* () {
							const rows = keeps(c.stored, c.first, "onK") ? c.stored : noRows
							const carried = c.change === "dropped" ? { ...rows, facts: [] } : rows
							const breaks = !keeps(carried, c.second, secondJoin(c))
							let schemaIdent = ""
							const triggers: Array<STriggers> = []
							let factTriggers: ReadonlyArray<string> = []
							const declared = (version: number): Declarations =>
								version === 1 && c.change === "renamed"
									? {
											renames: [
												{
													from: { kind: "relation", relation: parsedName("Fact") },
													to: { kind: "relation", relation: parsedName("Moved") }
												}
											],
											drops: []
										}
									: version === 1 && c.change === "dropped"
										? {
												renames: [],
												drops: [{ kind: "relation", relation: parsedName("Fact") }]
											}
										: noDeclarations
							const store = (owner: RawSession) =>
								Effect.gen(function* () {
									const statements = [
										...Arr.map(
											rows.facts,
											([k, a], i) =>
												`INSERT INTO ${tableOf(schemaIdent, "Fact")} (id, k, a) VALUES (${i + 1}, ${k}, ${a})`
										),
										...Arr.map(
											rows.s,
											([k, b], i) =>
												`INSERT INTO ${tableOf(schemaIdent, "S")} (id, k, b, c) VALUES (${i + 1}, ${k}, ${b}, ${b})`
										),
										...Arr.map(
											newT(rows, []),
											([a, b]) =>
												`INSERT INTO ${tableOf(schemaIdent, "T")} (a, b) VALUES (${a}, ${b})`
										)
									]
									const verdict = yield* attempt(owner, statements)
									if (verdict.kind !== "committed") {
										return yield* Effect.die(
											new Error(
												`the first version refused rows its rule keeps: ${refusalText(verdict.fields)}`
											)
										)
									}
								}).pipe(Effect.orDie)
							const outcome = yield* Effect.result(
								migrated({
									label: "rule_migrate",
									schemaName: { kind: "unique" },
									first: (name) => {
										schemaIdent = identifierOf(identity.schema(parsedSchemaName(name)))
										return { schema: versionOf(name, c, false), logins: [] }
									},
									later: [(name) => ({ schema: versionOf(name, c, true), logins: [] })],
									apply: { kind: "noPlaceholders" },
									declared,
									observe: Option.some((version: number, owner: RawSession) =>
										Effect.gen(function* () {
											if (version === 0) {
												yield* store(owner)
												factTriggers = yield* triggerNamesOf(owner, tableOf(schemaIdent, "Fact"))
											}
											const read = yield* sTriggersOf(owner, tableOf(schemaIdent, "S"))
											triggers.push(read)
										})
									)
								})
							)
							const kind = c.first === "none" ? "an added" : "a changed"
							if (outcome._tag === "Failure") {
								const failure = outcome.failure
								const refusedByCheck =
									failure._tag === "MigrateError" &&
									failure.reason._tag === "StatementFailed" &&
									failure.reason.failure._tag === "ServerError" &&
									failure.reason.failure.sqlstate === "23000"
								if (!breaks || !refusedByCheck) {
									return yield* new Disagreed({
										message: `the migration failed (${failure.message}; ${failure._tag === "MigrateError" && failure.reason._tag === "Drifted" ? Formatter.format(failure.reason.mismatches) : ""}) where the stored rows ${breaks ? "break" : "keep"} its rule: ${Formatter.format(c)}`
									})
								}
								n.note(`${kind} rule the stored rows break refused`)
								if (c.change === "widened") {
									n.note(
										"a rule kept through a change of its definition the stored rows break refused"
									)
								}
								if (c.second === "negated") {
									n.note("a rule over a negated join the stored rows break refused")
								}
								return
							}
							if (breaks) {
								return yield* new Disagreed({
									message: `the migration applied a rule the stored rows break: ${Formatter.format(c)}`
								})
							}
							n.note(`${kind} rule the stored rows keep applied`)
							if (c.second === "negated") {
								n.note("a rule over a negated join the stored rows keep applied")
							}
							const m = outcome.success
							const [before, after] = triggers
							if (before !== undefined && after !== undefined && before.b !== after.b) {
								if (
									before.names.length > 0 &&
									Arr.every(before.names, (t) => Arr.contains(after.names, t))
								) {
									n.note("S's captures kept under their names through a redefined column")
								}
							}
							if (c.change === "dropped" && factTriggers.length > 0) {
								n.note("a capture on a dropped table")
							}
							const fresh = yield* migrated({
								label: "rule_migrate_fresh",
								schemaName: { kind: "unique" },
								first: (name) => ({ schema: versionOf(name, c, true), logins: [] }),
								later: [],
								apply: { kind: "noPlaceholders" },
								declared: () => noDeclarations,
								observe: Option.none()
							})
							yield* sameCatalog(
								m.installation,
								fresh.installation,
								"the migrated second version against a fresh install of it"
							)
							const written = [
								...Arr.map(
									c.written.facts,
									([k, a], i) =>
										`INSERT INTO ${tableOf(schemaIdent, factName(c, true))} (id, k, a) VALUES (${100 + i}, ${k}, ${a})`
								),
								...Arr.map(c.written.s, ([k, b], i) =>
									c.change === "redefined"
										? `INSERT INTO ${tableOf(schemaIdent, "S")} (id, k, c) VALUES (${100 + i}, ${k}, ${b})`
										: `INSERT INTO ${tableOf(schemaIdent, "S")} (id, k, b, c) VALUES (${100 + i}, ${k}, ${b}, ${b})`
								),
								...Arr.map(
									newT(c.written, rows.t),
									([a, b]) => `INSERT INTO ${tableOf(schemaIdent, "T")} (a, b) VALUES (${a}, ${b})`
								)
							]
							const lawful = keeps(union(carried, c.written), c.second, secondJoin(c))
							const verdict = yield* attempt(m.owner, written)
							if (verdict.kind === "committed" && lawful) {
								n.note("a write the installed rule admits committed")
								return
							}
							if (
								verdict.kind === "committed" ||
								lawful ||
								verdict.moment.kind !== "commit" ||
								verdict.fields.code !== "23503"
							) {
								return yield* new Disagreed({
									message: `a write ${lawful ? "keeping" : "breaking"} the installed rule ${verdict.kind === "committed" ? "committed" : `was refused by ${refusalText(verdict.fields)}`}, where the rule refuses exactly a breaking write at COMMIT with 23503: ${Formatter.format(c)}`
								})
							}
							n.note("a write the installed rule breaks refused at COMMIT")
							if (c.change === "renamed") {
								n.note("a rule over a renamed table holds after the rename")
							}
						}).pipe(Effect.scoped)
				)
			)
	)
})
