/**
 * Rules over queries through grizzle's migrations, on PostgreSQL 19rc1: a migration that adds a rule over a query, or
 * changes one, runs its violation query over the stored rows and fails exactly where a row breaks it, the rule it
 * installs holds at every COMMIT after, through a declared rename of a table its query reads, and the migrated catalog
 * is a fresh install's of the second version, through a field the rule reads dropped and added again.
 *
 * A case draws rows of Fact(id, k, a), S(id, k, b, c) and T(a, b), the first version's rule over J2 = Fact ⋈ S on k
 * (none, or J2's facts whose b is not 0 contained in T), and the second's (those facts, every fact of J2, or the facts
 * of Unpaired contained in T, the facts of J2 whose k no S row shares whose b is a T row's a: a negated join of S and
 * T), the second version renaming Fact to Moved or not, and turning S's b from a field its caller writes into one
 * generated from c or not, which the migration drops and adds again (a rewritten field), so a rule trigger on S whose
 * UPDATE OF lists b stands over a redefined column. Every S row holds c equal to b, so b keeps its value. The rows are
 * stored under the first version, where its rule admits them. The oracle is the rule restated over the rows: the
 * second migration fails, its violation check raising 23000, exactly when the stored rows break its rule; once it
 * applies, the migrated schema holds the catalog a fresh install of the second version holds, both read from
 * PostgreSQL's catalog (test/pg/migrate/support.ts sameCatalog): its triggers, constraints, indexes and columns; and one
 * transaction writing drawn rows of Fact (or Moved), S and T commits exactly when the rows then keep the installed
 * rule, and is otherwise refused at COMMIT with 23503.
 *
 * Features: an added and a changed rule, each refused over rows that break it and applied over rows that keep it; the
 * same over a negated join; a write the installed rule admits committed and one it breaks refused at COMMIT; a rule
 * over a renamed table refusing such a write; and a rule trigger whose UPDATE OF lists a column the migration drops and
 * adds again, kept under its name and replaced under a new one, each read off PostgreSQL's catalog before and after the
 * migration (S's b at another attnum, and S's triggers over b by name). Plants: ~/.cache/grizzle-release/BR09/plants/
 * rule-query-migrate-changed-rule-unchecked.patch, a changed rule's violation check skipped, applies the migration
 * over stored rows that break it; the plant of the negated join, written for the pin-time run, a violation query
 * that reads each negated arm as an anti-join of its first match alone, under which Unpaired derives nothing, so a
 * migration adding its rule applies over stored rows that break it; and ~/.cache/grizzle-release/TRIGDROP/plants/
 * redefined-takes-along.patch, the drop of what a column dropped and added again takes left to the column's DROP
 * COLUMN but for foreign keys and law columns, which PostgreSQL refuses under a rule trigger over the column (2BP01),
 * as edullm's QTI identity migration was drafted.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
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

/** What the second version changes beside its rule: nothing, Fact renamed to Moved, or S's b generated from c, which
 * the migration drops and adds again. */
type Change = "kept" | "renamed" | "redefined"

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
	change: s.draw(element(["kept", "renamed", "redefined"] as const)),
	stored: s.draw(rowsGen),
	written: s.draw(rowsGen)
})

/** No rows. */
const noRows: Rows = { facts: [], s: [], t: [] }

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
	after && c.change === "renamed" ? "Moved" : "Fact"

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
 * The version under `name` with Fact: Fact, S and T, J2 = Fact ⋈ S on k, Unpaired = J2's facts whose k no S row shares
 * whose b is a T row's a, and `rule`.
 */
const factVersion = (name: string, rule: Rule) => {
	const Base = schema(name, { Fact, S, T }, [])
	const J2 = derived(
		"J2",
		query(Base).rule((r) => {
			const { k, a } = v(Fact, "fact")
			const { b } = v(S, "s")
			return r.match(Fact, { k, a }).match(S, { k, b }).find({ k, a, b })
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
			return schema.extend(Base, `${name}_1`, { J2, Unpaired }, [])
		case "every":
			return schema.extend(Base, `${name}_1`, { J2, Unpaired }, [
				contained(on(J2, "a", "b"), on(T, "a", "b"))
			])
		case "selected":
			return schema.extend(Base, `${name}_1`, { J2, Unpaired }, [
				contained(
					on(
						select(J2, (j) => j.ne(j.b, 0)),
						"a",
						"b"
					),
					on(T, "a", "b")
				)
			])
		case "negated":
			return schema.extend(Base, `${name}_1`, { J2, Unpaired }, [
				contained(on(Unpaired, "a", "b"), on(T, "a", "b"))
			])
	}
}

/** The version under `name` with S's b generated from c (SGenerated). */
const generatedVersion = (name: string, rule: Rule) => {
	const Base = schema(name, { Fact, S: SGenerated, T }, [])
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
			return schema.extend(Base, `${name}_1`, { J2, Unpaired }, [])
		case "every":
			return schema.extend(Base, `${name}_1`, { J2, Unpaired }, [
				contained(on(J2, "a", "b"), on(T, "a", "b"))
			])
		case "selected":
			return schema.extend(Base, `${name}_1`, { J2, Unpaired }, [
				contained(
					on(
						select(J2, (j) => j.ne(j.b, 0)),
						"a",
						"b"
					),
					on(T, "a", "b")
				)
			])
		case "negated":
			return schema.extend(Base, `${name}_1`, { J2, Unpaired }, [
				contained(on(Unpaired, "a", "b"), on(T, "a", "b"))
			])
	}
}

/** The version under `name` with Fact renamed to Moved. */
const movedVersion = (name: string, rule: Rule) => {
	const Base = schema(name, { Moved, S, T }, [])
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
			return schema.extend(Base, `${name}_1`, { J2, Unpaired }, [])
		case "every":
			return schema.extend(Base, `${name}_1`, { J2, Unpaired }, [
				contained(on(J2, "a", "b"), on(T, "a", "b"))
			])
		case "selected":
			return schema.extend(Base, `${name}_1`, { J2, Unpaired }, [
				contained(
					on(
						select(J2, (j) => j.ne(j.b, 0)),
						"a",
						"b"
					),
					on(T, "a", "b")
				)
			])
		case "negated":
			return schema.extend(Base, `${name}_1`, { J2, Unpaired }, [
				contained(on(Unpaired, "a", "b"), on(T, "a", "b"))
			])
	}
}

/** The case's version: the first, or the second, with the case's change. */
const versionOf = (name: string, c: MigrationCase, after: boolean) => {
	if (!after) {
		return factVersion(name, c.first)
	}
	switch (c.change) {
		case "kept":
			return factVersion(name, c.second)
		case "renamed":
			return movedVersion(name, c.second)
		case "redefined":
			return generatedVersion(name, c.second)
	}
}

/** Whether some S row of k has a b that is a T row's a: whether the k is paired, which Unpaired negates. */
const paired = (c: Rows, k: number): boolean =>
	Arr.some(c.s, ([sk, b]) => sk === k && Arr.some(c.t, ([ta]) => ta === b))

/** Whether the rows keep `rule`: every fact of J2 or Unpaired it reads has its (a, b) in T. */
const keeps = (c: Rows, rule: Rule): boolean =>
	rule === "none" ||
	Arr.every(c.facts, ([k, a]) =>
		Arr.every(
			Arr.filter(
				c.s,
				([sk, b]) =>
					sk === k && (rule === "every" || (rule === "selected" ? b !== 0 : !paired(c, k)))
			),
			([, b]) => Arr.some(c.t, ([ta, tb]) => ta === a && tb === b)
		)
	)

const tableOf = (schemaIdent: string, relationName: string): string =>
	`${quoteIdent(schemaIdent)}.${quoteIdent(identifierOf(identity.table(parsedName(relationName))))}`

/** S's triggers as PostgreSQL's catalog holds them: every one's name, the names of those whose UPDATE OF lists b, and
 * b's attnum, which a column dropped and added again changes. */
interface STriggers {
	readonly names: ReadonlyArray<string>
	readonly overB: ReadonlyArray<string>
	readonly b: number
}

/** The first column of each row a catalog query returns, as text. */
const texts = (rows: ReadonlyArray<ReadonlyArray<unknown>>): ReadonlyArray<string> =>
	Arr.flatMap(rows, (row) => Arr.filter(row.slice(0, 1), (x) => typeof x === "string"))

/** S's triggers (STriggers), read as the owner from PostgreSQL's catalog. */
const sTriggersOf = (owner: RawSession, table: string) =>
	Effect.gen(function* () {
		const names = yield* owner.values(
			"SELECT t.tgname::pg_catalog.text FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid = $1::pg_catalog.text::pg_catalog.regclass AND NOT t.tgisinternal",
			[table]
		)
		const overB = yield* owner.values(
			"SELECT t.tgname::pg_catalog.text FROM pg_catalog.pg_trigger AS t JOIN pg_catalog.pg_attribute AS a ON a.attrelid = t.tgrelid AND a.attnum = ANY (t.tgattr::pg_catalog.int2[]) WHERE t.tgrelid = $1::pg_catalog.text::pg_catalog.regclass AND NOT t.tgisinternal AND a.attname = 'b'",
			[table]
		)
		const b = yield* owner.values(
			"SELECT a.attnum::pg_catalog.text FROM pg_catalog.pg_attribute AS a WHERE a.attrelid = $1::pg_catalog.text::pg_catalog.regclass AND a.attname = 'b' AND NOT a.attisdropped",
			[table]
		)
		return { names: texts(names), overB: texts(overB), b: Number(Arr.join(texts(b), "")) }
	}).pipe(Effect.orDie)

type Feature =
	| "a write the installed rule admits committed"
	| "a write the installed rule breaks refused at COMMIT"
	| "an added rule the stored rows break refused"
	| "an added rule the stored rows keep applied"
	| "a changed rule the stored rows break refused"
	| "a changed rule the stored rows keep applied"
	| "a rule over a renamed table holds after the rename"
	| "a rule over a negated join the stored rows break refused"
	| "a rule over a negated join the stored rows keep applied"
	| "a rule trigger over a redefined column kept under its name"
	| "a rule trigger over a redefined column replaced under a new name"

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

layer(Substrate.layer)("rules over queries through migrations on PostgreSQL 19rc1", (it) => {
	it.effect(
		"fail a migration adding or changing a rule over a query exactly where the stored rows break it, leave a fresh install's catalog where it applies, and hold the rule it installs at every COMMIT after",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "laws/rule-query-migrate",
						draw: drawn(caseGen),
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
								"a rule over a renamed table holds after the rename",
								"a write the installed rule admits committed",
								"a write the installed rule breaks refused at COMMIT",
								"a rule over a negated join the stored rows break refused",
								"a rule over a negated join the stored rows keep applied",
								"a rule trigger over a redefined column kept under its name",
								"a rule trigger over a redefined column replaced under a new name"
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
							const rows = keeps(c.stored, c.first) ? c.stored : noRows
							const breaks = !keeps(rows, c.second)
							let schemaIdent = ""
							const triggers: Array<STriggers> = []
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
								if (Arr.some(before.overB, (t) => Arr.contains(after.names, t))) {
									n.note("a rule trigger over a redefined column kept under its name")
								}
								if (Arr.some(before.overB, (t) => !Arr.contains(after.names, t))) {
									n.note("a rule trigger over a redefined column replaced under a new name")
								}
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
							const lawful = keeps(union(rows, c.written), c.second)
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
