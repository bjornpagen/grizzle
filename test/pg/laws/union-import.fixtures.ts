/** What the property of union-import.test.ts reads: its templates, its space, and each case's run. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import { baselineRuleChecks, lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { foundQueryOf, judgedStatementsOf, raisedRule } from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { refusalOf } from "#test/support/substrate.ts"
import {
	type Facts,
	factsGen,
	type Shape,
	unionSchemaOf,
	stored,
	widthOf
} from "#test/support/unit/laws/union-import.schema.ts"

/** The shapes installed: a union of one rule, of two and of three, each at its own level and from a level above. */
const shapes = {
	"own: open": { union: "open", level: "own" },
	"own: open, suspended": { union: "open, suspended", level: "own" },
	"own: open, suspended, late": { union: "open, suspended, late", level: "own" },
	"above: open": { union: "open", level: "above" },
	"above: open, suspended": { union: "open, suspended", level: "above" },
	"above: open, suspended, late": { union: "open, suspended, late", level: "above" }
} as const satisfies Readonly<Record<string, Shape>>

export type ShapeKey = keyof typeof shapes

const shapeKeys = [
	"own: open",
	"own: open, suspended",
	"own: open, suspended, late",
	"above: open",
	"above: open, suspended",
	"above: open, suspended, late"
] as const satisfies ReadonlyArray<ShapeKey>

const templateOf = (shape: Shape) => {
	const value = unionSchemaOf(shape)
	const width = widthOf(shape.union)
	return migratedTemplate({
		declaredIn: import.meta,
		name: `union import ${shape.level} ${width}`,
		content: { schema: value.name, logins: [] },
		versions: [{ schema: value, declarations: noDeclarations }],
		options: {
			label: `union_import_${shape.level}_${width}`,
			extensions: [],
			compile: compileInstallation,
			ambient: ordinarySession,
			review: noPlaceholders
		}
	})
}

/** Each shape installed by its migration, its judge among it. */
export const unionTemplates = Rec.map(shapes, templateOf)

/** A case: its shape, and a state written in two parts, the judge run after each. */
export interface UnionCase {
	readonly shape: ShapeKey
	readonly first: Facts
	readonly second: Facts
}

/** A drawn state, each row written in the first part or the second. */
export const unionCaseGen: Gen<UnionCase> = (s) => {
	const facts = s.draw(factsGen)
	const parted = Rec.map(facts, (rows) =>
		Arr.map(rows, (row) => ({ row, first: s.draw(int(0, 1)) === 1 }))
	)
	return {
		shape: s.draw(element(shapeKeys)),
		first: Rec.map(parted, (rows) => Arr.flatMap(rows, (r) => (r.first ? [r.row] : []))),
		second: Rec.map(parted, (rows) => Arr.flatMap(rows, (r) => (r.first ? [] : [r.row])))
	}
}

export type UnionFeature =
	| "a union of one rule"
	| "a union of two rules"
	| "a union of three rules"
	| "compiled from a level above"
	| "refused by the judge"
	| "accepted by the judge"
	| "refused over the units of a second part"

export const unionFeatures: readonly [UnionFeature, ...Array<UnionFeature>] = [
	"a union of one rule",
	"a union of two rules",
	"a union of three rules",
	"compiled from a level above",
	"refused by the judge",
	"accepted by the judge",
	"refused over the units of a second part"
]

/** The fields of each stored relation, in the order its rows are written. */
const fieldsOf = {
	Snap: ["child", "n", "at"],
	Item: ["child", "n", "stage"],
	Sess: ["child", "stage"],
	Visit: ["child", "stage", "k", "at"],
	Susp: ["child", "stage", "k", "at"]
} as const satisfies { readonly [R in keyof Facts]: ReadonlyArray<string> }

/** The INSERTs of `facts`, one per stored relation that holds a row of it. */
const written = (installed: Installed, facts: Facts): ReadonlyArray<string> => {
	const names = namesOf(installed)
	return Arr.flatMap(Rec.toEntries(fieldsOf), ([name, fields]) => {
		const rows = facts[name]
		if (rows.length === 0) {
			return []
		}
		const relation = stored[name]
		const columns = Arr.join(
			Arr.map(fields, (f) => quoteIdent(names.columnIdent(relation, f))),
			", "
		)
		const values = Arr.join(
			Arr.map(
				rows,
				(row) =>
					`(${Arr.join(
						Arr.map(fields, (f) => String(defined(row[f], `${name}.${f}`))),
						", "
					)})`
			),
			", "
		)
		return [`INSERT INTO ${names.table(relation)} (${columns}) VALUES ${values}`]
	})
}

/**
 * The state the case's transaction holds, judged: whether the containment's violation query, lowered by the oracle
 * baseline, finds a row; its check over every row, the one a migration runs, must find one exactly then, and the judge,
 * run over the units the transaction wrote since it last ran (SET CONSTRAINTS ALL IMMEDIATE), must refuse exactly then,
 * under the containment's name and an integrity SQLSTATE.
 */
const verdict = (installed: Installed, connection: PgConnection, where: string) =>
	Effect.gen(function* () {
		const installation = installed.installation
		const [baseline, ...more] = baselineRuleChecks(installation)
		assert.ok(
			baseline !== undefined && more.length === 0,
			"the schema states one rule, the containment"
		)
		const broken =
			(yield* connection.queryValues(
				`SELECT EXISTS (${printStatement(baseline.query)})`,
				[]
			))[0]?.[0] === true
		for (const check of lawChecks(installation).rules) {
			const found = (yield* connection.queryValues(foundQueryOf(check.query), []))[0]?.[0] === true
			assert.equal(
				found,
				broken,
				`the check over every row agrees with the violation query, ${where}`
			)
		}
		const refused = yield* refusalOf(connection.query("SET CONSTRAINTS ALL IMMEDIATE", []))
		assert.equal(
			Option.isSome(refused),
			broken,
			`the judge ${Option.isSome(refused) ? "refused" : "accepted"} a state the violation query finds ${broken ? "broken" : "lawful"}, ${where}`
		)
		if (Option.isSome(refused)) {
			const raised = Arr.getSomes(Arr.map(judgedStatementsOf(installation), raisedRule))
			assert.ok(
				refused.value.constraint !== undefined && Arr.contains(raised, refused.value.constraint),
				`the judge refused under ${refused.value.constraint ?? "no constraint"}, the containment's, ${where}`
			)
			assert.ok(
				Arr.contains(["23503", "23505", "23514"], refused.value.code),
				`the judge refused under ${refused.value.code}, an integrity SQLSTATE, ${where}`
			)
		}
		return broken
	})

/**
 * The constraints deferred again: SET CONSTRAINTS ALL IMMEDIATE holds to the transaction's end, so the judge would run
 * at each statement of the second part, where it runs once the part is written.
 */
const deferred = "SET CONSTRAINTS ALL DEFERRED"

/**
 * One case in its one transaction, which the case's end rolls back: the first part written and judged; where the judge
 * accepts it, the constraints deferred again, and the second part written and judged over the units it wrote.
 */
export const runUnion = (
	installed: Installed,
	connection: PgConnection,
	drawn: UnionCase,
	c: Case<UnionFeature>
) =>
	Effect.gen(function* () {
		const shape = shapes[drawn.shape]
		const width = widthOf(shape.union)
		c.note(
			width === 1
				? "a union of one rule"
				: width === 2
					? "a union of two rules"
					: "a union of three rules"
		)
		if (shape.level === "above") {
			c.note("compiled from a level above")
		}
		for (const sql of written(installed, drawn.first)) {
			yield* connection.query(sql, [])
		}
		if (yield* verdict(installed, connection, `${Formatter.format(drawn)}, after its first part`)) {
			c.note("refused by the judge")
			return
		}
		yield* connection.query(deferred, [])
		for (const sql of written(installed, drawn.second)) {
			yield* connection.query(sql, [])
		}
		if (
			yield* verdict(installed, connection, `${Formatter.format(drawn)}, after its second part`)
		) {
			c.note("refused by the judge")
			c.note("refused over the units of a second part")
			return
		}
		c.note("accepted by the judge")
	})
