/** What the property of rule-region.test.ts reads: its schemas and templates, its space, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { rowsTouched } from "#bench/harness/explain.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	check,
	derived,
	key,
	mutable,
	on,
	relation,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { judgedPlans, judgedStatementsOf } from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"

/** A row of a unit, `package` its unit: its id, and the value g it states. */
const T = relation("T", { package: int4, id: int4, g: int4 }, ["package", "id"])

/** How a rule's judge reads what a transaction wrote: by probes over its rows, or whole over the units they hold. */
const judgings = ["probed", "whole"] as const
type Judged = (typeof judgings)[number]

/**
 * The rule each judgment holds over Stated, each unit's g, a derived relation every row of its unit derives its fact of,
 * so a unit's rows that state one g derive one fact, each a read of the unit's rows once per binding of its region:
 *
 * - `probed`: T mutable in the unit of its whole key, (package, id), wider than the package a key over Stated pairs its
 *   rows within, so no borrow of one row covers it, and One g, that key, probed: each probe reads the rows a
 *   transaction wrote of T as its region, then the unit's Stated rows at each binding of it;
 * - `whole`: T immutable, and Natural g, a check over Stated, unit-local and judged whole: its step reads the unit's
 *   Stated rows once per unit of its region. A key would pair the unit's rows with each other in that one read, the
 *   square of the unit at any region, so the check is the rule whose read of a unit is linear.
 */
const regionSchema = (judged: Judged) => {
	switch (judged) {
		case "probed": {
			const Base = schema(
				"ProbedRegion",
				[T],
				[mutable(T), unit("Row", { package: int4, id: int4 })]
			)
			const Stated = derived(
				"Stated",
				query(Base).rule((r) => {
					const { package: unit, g } = v(T, "t")
					return r.match(T, { package: unit, g }).find({ package: unit, g })
				})
			)
			return schema.extend([Base], "ProbedRegion_1", [Stated], [key(on(Stated, "package"))])
		}
		case "whole": {
			const Base = schema("WholeRegion", [T], [])
			const Stated = derived(
				"Stated",
				query(Base).rule((r) => {
					const { package: unit, g } = v(T, "t")
					return r.match(T, { package: unit, g }).find({ package: unit, g })
				})
			)
			return schema.extend(
				[Base],
				"WholeRegion_1",
				[Stated],
				[check("Natural_g", Stated, (s) => s.ge(s.g, 0))]
			)
		}
	}
}

const templateOf = (judged: Judged) => {
	const value = regionSchema(judged)
	return migratedTemplate({
		declaredIn: import.meta,
		name: `${judged} region`,
		content: { schema: value.name, logins: [] },
		versions: [{ schema: value, declarations: noDeclarations }],
		options: {
			label: `${judged}_region`,
			extensions: [],
			compile: compileInstallation,
			ambient: ordinarySession,
			review: noPlaceholders
		}
	})
}

export const wholeRegionTemplate = templateOf("whole")
export const probedRegionTemplate = templateOf("probed")

/** A case: how its rule is judged, the rows first written, and the g they all state. */
export interface Repeats {
	readonly judged: Judged
	readonly rows: number
	readonly g: number
}

export const repeatsGen: Gen<Repeats> = (s) => ({
	judged: s.draw(element(judgings)),
	rows: s.draw(int(40, 120)),
	g: s.draw(int(0, 9))
})

export type RepeatsFeature = "a probed rule's region" | "a whole rule's region"

/**
 * The rows each judged statement handles at every node of its plan, over all of its loops (rowsTouched), on
 * `connection`: its work.
 */
const workOf = (installed: Installed, connection: PgConnection) =>
	Effect.map(
		judgedPlans(
			(sql, params) => connection.queryValues(sql, params),
			installed.installation,
			judgedStatementsOf(installed.installation)
		),
		Arr.map((judged) => rowsTouched(judged.plan))
	)

/**
 * The INSERT of T's rows `from` to `to` of unit 1, each stating `g`, through the captures, whose rows stand in the
 * deltas until the judge reads them, at COMMIT, which the case never reaches.
 */
const written = (
	installed: Installed,
	from: number,
	to: number,
	g: number
): ReadonlyArray<string> => [
	`INSERT INTO ${namesOf(installed).table(T)} (package, id, g) SELECT 1, i, ${g} FROM generate_series(${from}, ${to}) AS r(i)`
]

/**
 * One case in its one transaction, which the case's end rolls back: `rows` rows of one unit written, each stating one
 * g, so all derive one fact, and each judged statement explained over the deltas that hold them, the judge deferred to
 * a COMMIT the case never reaches, since the judge deletes every row of a delta it reads; then three times as many rows
 * of the unit again, and each explained again over the deltas that hold them all. Each statement's work must grow at most twice as fast as the rows, under eight
 * times for four times the rows: its region is the set of bindings the rows give it, one here, so it reads the unit's
 * rows once beside its region's, four times the work; a region of the rows themselves, each deriving the unit's fact
 * again, reads the unit's rows once per row, sixteen times the work.
 */
export const runRepeats = (
	installed: Installed,
	connection: PgConnection,
	drawn: Repeats,
	c: Case<RepeatsFeature>
) =>
	Effect.gen(function* () {
		const [rule, ...others] = installed.installation.laws.rules
		assert.ok(
			rule !== undefined &&
				others.length === 0 &&
				(rule.rule.kind === "whole") === (drawn.judged === "whole"),
			`the ${drawn.judged} judgment's one rule ${drawn.judged === "whole" ? "judged whole" : "probed"}`
		)
		for (const sql of written(installed, 0, drawn.rows - 1, drawn.g)) {
			yield* connection.query(sql, [])
		}
		const some = yield* workOf(installed, connection)
		assert.ok(some.length > 0, "the judge holds a statement for the key")
		for (const sql of written(installed, drawn.rows, 4 * drawn.rows - 1, drawn.g)) {
			yield* connection.query(sql, [])
		}
		const more = yield* workOf(installed, connection)
		assert.ok(
			Arr.every(Arr.zip(some, more), ([w, m]) => m < 8 * Math.max(w, 1)),
			`${Formatter.format(drawn)}: each judged statement's work grows with the rows a unit's write derives one fact from no faster than the rows, under eight times for four times as many, ${Formatter.format(some)} for ${drawn.rows} rows and then ${Formatter.format(more)} for ${4 * drawn.rows}`
		)
		c.note(drawn.judged === "probed" ? "a probed rule's region" : "a whole rule's region")
	})
