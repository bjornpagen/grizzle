/**
 * Rules over queries through grizzle's migrations, on PostgreSQL 19rc1: a migration that adds a rule over a query, or
 * changes one, runs its violation query over the stored rows and fails exactly where a row breaks it, and the rule it
 * installs holds at every COMMIT after, through a declared rename of a table its query reads.
 *
 * A case draws rows of Fact(id, k, a), S(id, k, b) and T(a, b), the first version's rule over J2 = Fact ⋈ S on k (none,
 * or J2's facts whose b is not 0 contained in T), and the second's (those facts, every fact of J2, or the facts of
 * Unpaired contained in T, the facts of J2 whose k no S row shares whose b is a T row's a: a negated join of S and T),
 * the second version renaming Fact to Moved or not. The rows are stored under the first version, where its rule
 * admits them. The oracle is the rule restated over the rows: the second migration fails, its violation check raising
 * 23000, exactly when the stored rows break its rule; and once it applies, a transaction writing a fact of J2 the rule
 * needs a T row for is refused at COMMIT with 23503, and commits beside that T row.
 *
 * The plant of the negated join, written for the pin-time run, which must fail the search: a violation query that reads
 * each negated arm as an anti-join of its first match alone, under which Unpaired derives nothing, so a migration adding
 * its rule applies over stored rows that break it.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Data, Effect, Formatter, Option } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema, select } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
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

interface MigrationCase {
	readonly first: Rule
	readonly second: Exclude<Rule, "none">
	readonly renamed: boolean
	readonly facts: ReadonlyArray<readonly [number, number]>
	readonly s: ReadonlyArray<readonly [number, number]>
	readonly t: ReadonlyArray<readonly [number, number]>
}

const pairGen: Gen<readonly [number, number]> = (s) => [s.draw(int(0, 1)), s.draw(int(0, 1))]

const caseGen: Gen<MigrationCase> = (s) => ({
	first: s.draw(element(["none", "selected"] as const)),
	second: s.draw(element(["selected", "every", "negated"] as const)),
	renamed: s.draw(boolean),
	facts: s.draw(array(pairGen, { min: 0, max: 3 })),
	s: s.draw(array(pairGen, { min: 0, max: 3 })),
	t: s.draw(array(pairGen, { min: 0, max: 3 }))
})

/** The relation Fact's declared name at a version. */
const factName = (c: MigrationCase, after: boolean): string =>
	after && c.renamed ? "Moved" : "Fact"

const S = relation("S", { id: pg.integer, k: pg.integer, b: pg.integer }, ["id"])
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

/** The case's version: the first, or the second, renaming Fact where the case does. */
const versionOf = (name: string, c: MigrationCase, after: boolean) =>
	after && c.renamed ? movedVersion(name, c.second) : factVersion(name, after ? c.second : c.first)

/** Whether some S row of k has a b that is a T row's a: whether the k is paired, which Unpaired negates. */
const paired = (c: MigrationCase, k: number): boolean =>
	Arr.some(c.s, ([sk, b]) => sk === k && Arr.some(c.t, ([ta]) => ta === b))

/** Whether the rows keep `rule`: every fact of J2 or Unpaired it reads has its (a, b) in T. */
const keeps = (c: MigrationCase, rule: Rule): boolean =>
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

type Feature =
	| "an added rule the stored rows break refused"
	| "an added rule the stored rows keep applied"
	| "a changed rule the stored rows break refused"
	| "a changed rule the stored rows keep applied"
	| "a rule over a renamed table holds after the rename"
	| "a rule over a negated join the stored rows break refused"
	| "a rule over a negated join the stored rows keep applied"

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

layer(Substrate.layer)("rules over queries through migrations on PostgreSQL 19rc1", (it) => {
	it.effect(
		"fail a migration adding or changing a rule over a query exactly where the stored rows break it, and hold the rule it installs at every COMMIT after",
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
							name: "the rule restated over the rows: a migration installing it applies exactly when the stored rows keep it"
						},
						coverage: required<Feature>(
							[
								"an added rule the stored rows break refused",
								"an added rule the stored rows keep applied",
								"a changed rule the stored rows break refused",
								"a changed rule the stored rows keep applied",
								"a rule over a renamed table holds after the rename",
								"a rule over a negated join the stored rows break refused",
								"a rule over a negated join the stored rows keep applied"
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
							const stored = keeps(c, c.first)
							const rows = stored ? c : { ...c, facts: [], s: [], t: [] }
							const breaks = !keeps(rows, c.second)
							let schemaIdent = ""
							const declared = (version: number): Declarations =>
								version === 1 && c.renamed
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
												`INSERT INTO ${tableOf(schemaIdent, "S")} (id, k, b) VALUES (${i + 1}, ${k}, ${b})`
										),
										...Arr.map(
											Arr.dedupeWith(rows.t, (x, y) => x[0] === y[0] && x[1] === y[1]),
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
										version === 0 ? store(owner) : Effect.void
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
							const fact = tableOf(schemaIdent, factName(c, true))
							const needing = [
								`INSERT INTO ${fact} (id, k, a) VALUES (100, 9, 9)`,
								`INSERT INTO ${tableOf(schemaIdent, "S")} (id, k, b) VALUES (100, 9, 9)`
							]
							const refused = yield* attempt(m.owner, needing)
							if (
								refused.kind !== "refused" ||
								refused.moment.kind !== "commit" ||
								refused.fields.code !== "23503"
							) {
								return yield* new Disagreed({
									message: `a fact the rule needs a T row for was not refused at COMMIT with 23503: ${Formatter.format(c)}`
								})
							}
							const kept = yield* attempt(m.owner, [
								...needing,
								`INSERT INTO ${tableOf(schemaIdent, "T")} (a, b) VALUES (9, 9)`
							])
							if (kept.kind !== "committed") {
								return yield* new Disagreed({
									message: `a fact beside the T row it needs was refused: ${refusalText(kept.fields)}`
								})
							}
							if (c.renamed) {
								n.note("a rule over a renamed table holds after the rename")
							}
						}).pipe(Effect.scoped)
				)
			)
	)
})
