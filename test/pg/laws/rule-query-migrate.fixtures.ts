/** What the properties of rule-query-migrate.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Data, Effect } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { generated, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema, select } from "#compiler/public/schema.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

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

export const caseGen: Gen<MigrationCase> = (s) => ({
	first: s.draw(element(["none", "selected"] as const)),
	second: s.draw(element(["selected", "every", "negated"] as const)),
	change: s.draw(element(["kept", "renamed", "dropped", "redefined"] as const)),
	stored: s.draw(rowsGen),
	written: s.draw(rowsGen)
})

/** No rows. */
export const noRows: Rows = { facts: [], s: [], t: [] }

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
export const constructed: Arr.NonEmptyReadonlyArray<readonly [Feature, Gen<MigrationCase>]> = [
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
export const newT = (
	rows: Rows,
	held: ReadonlyArray<readonly [number, number]>
): ReadonlyArray<readonly [number, number]> =>
	Arr.filter(Arr.dedupeWith(rows.t, samePair), (p) => !Arr.some(held, (h) => samePair(h, p)))

/** The rows `stored` and `written` hold together. */
export const union = (stored: Rows, written: Rows): Rows => ({
	facts: [...stored.facts, ...written.facts],
	s: [...stored.s, ...written.s],
	t: [...stored.t, ...written.t]
})

/** The relation Fact's declared name at a version. */
export const factName = (c: MigrationCase, after: boolean): string =>
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
			return schema.extend([Base], `${name}_1`, [J2, Unpaired], [])
		case "every":
			return schema.extend(
				[Base],
				`${name}_1`,
				[J2, Unpaired],
				[contained(on(J2, "a", "b"), on(T, "a", "b"))]
			)
		case "selected":
			return schema.extend(
				[Base],
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
				[Base],
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
			return schema.extend([Base], `${name}_1`, [J2, Unpaired], [])
		case "every":
			return schema.extend(
				[Base],
				`${name}_1`,
				[J2, Unpaired],
				[contained(on(J2, "a", "b"), on(T, "a", "b"))]
			)
		case "selected":
			return schema.extend(
				[Base],
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
				[Base],
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
			return schema.extend([Base], `${name}_1`, [J2, Unpaired], [])
		case "every":
			return schema.extend(
				[Base],
				`${name}_1`,
				[J2, Unpaired],
				[contained(on(J2, "a", "b"), on(T, "a", "b"))]
			)
		case "selected":
			return schema.extend(
				[Base],
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
				[Base],
				`${name}_1`,
				[J2, Unpaired],
				[contained(on(Unpaired, "a", "b"), on(T, "a", "b"))]
			)
	}
}

/** The case's version: the first, or the second, with the case's change. */
export const versionOf = (name: string, c: MigrationCase, after: boolean) => {
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
export const secondJoin = (c: MigrationCase): J2Join => (c.change === "widened" ? "widened" : "onK")

/**
 * Whether the rows keep `rule`, J2 pairing them by `join`: every fact of J2 or Unpaired it reads has its (a, b) in T.
 */
export const keeps = (c: Rows, rule: Rule, join: J2Join): boolean =>
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

export const tableOf = (schemaIdent: string, relationName: string): string =>
	`${quoteIdent(schemaIdent)}.${quoteIdent(identifierOf(identity.table(parsedName(relationName))))}`

/** S's triggers by name, and the attnum of its column b. */
export interface STriggers {
	readonly names: ReadonlyArray<string>
	readonly b: number
}

/** The first column of each row a catalog query returns, as text. */
const texts = (rows: ReadonlyArray<ReadonlyArray<unknown>>): ReadonlyArray<string> =>
	Arr.flatMap(rows, (row) => Arr.filter(row.slice(0, 1), (x) => typeof x === "string"))

/** The names of a table's own triggers, read as the owner from PostgreSQL's catalog. */
export const triggerNamesOf = (owner: RawSession, table: string) =>
	Effect.map(
		owner.values(
			"SELECT t.tgname::pg_catalog.text FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid = $1::pg_catalog.text::pg_catalog.regclass AND NOT t.tgisinternal",
			[table]
		),
		texts
	).pipe(Effect.orDie)

/** S's triggers (STriggers), read as the owner from PostgreSQL's catalog. */
export const sTriggersOf = (owner: RawSession, table: string) =>
	Effect.gen(function* () {
		const names = yield* triggerNamesOf(owner, table)
		const b = yield* owner.values(
			"SELECT a.attnum::pg_catalog.text FROM pg_catalog.pg_attribute AS a WHERE a.attrelid = $1::pg_catalog.text::pg_catalog.regclass AND a.attname = 'b' AND NOT a.attisdropped",
			[table]
		)
		return { names, b: Number(Arr.join(texts(b), "")) }
	}).pipe(Effect.orDie)

export type Feature =
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

export class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}
