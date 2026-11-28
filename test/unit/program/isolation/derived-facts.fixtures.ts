/** What derived-facts.test.ts reads: its drawn login, compiled for READ COMMITTED as generate compiles it. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, derived, login, relation, role, schema, unit } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { changeLogin } from "#test/support/change-login.ts"

/**
 * Where the stored derived relation the writer reads is declared: in the level the login is over, or in the level
 * beneath it, whose schema of whole views is another (`__<level>`), as qti-pie's result suite reads the delivery
 * level's.
 */
export type Level = "the login's level" | "the level beneath"

const levels = ["the login's level", "the level beneath"] as const satisfies ReadonlyArray<Level>

/** A case: the level the stored derived relation is declared in. */
export const levelGen: Gen<Level> = (source) => source.draw(element(levels))

/** A row of a package, its unit: its id and the value x it states. */
const T = relation("T", { package: int4, id: int4, x: int4 }, ["package", "id"])

/** A row of a package beside T's at the same id: the value y it states. */
const U = relation("U", { package: int4, id: int4, y: int4 }, ["package", "id"])

const base = schema("DerivedFacts", [T, U], [unit("Package", { package: int4 })])

/**
 * Each id of a package with T's value and U's: a join within one package at a key of each relation it reads, so the
 * installation stores it (analysis/derived/storage.ts), its table a relation's of no declaration.
 */
const Rows = derived(
	"Rows",
	query(base).rule((r) => {
		const { package: unit, id, x } = v(T, "t")
		const { y } = v(U, "u")
		return r
			.match(T, { package: unit, id, x })
			.match(U, { package: unit, id, y })
			.find({ package: unit, id, x, y })
	})
)

/** The level that declares Rows and its check. */
const declaring = schema.extend(
	[base],
	"DerivedFacts_1",
	[Rows],
	[check("Bounded", Rows, (b) => b.le(b.x, 9))]
)

/** A level over the one that declares Rows, declaring nothing of its own. */
const above = schema.extend([declaring], "DerivedFacts_2", [], [])

/** The writer over the declaring level, holding T and U whole, and its login: its one change member reads Rows at a
 * package. */
const declaringLogin = () => {
	const writer = role(declaring, "writer", { T, U }, { insert: ["T"] })
	const member = ChangeSet.empty(writer).read("rows", () =>
		query(declaring).rule((r) => {
			const { id, x, y } = v(Rows, "rows")
			return r.match(Rows, { package: r.param("package", int4), id, x, y }).find({ id, x, y })
		})
	)
	return login(declaring, "app", [writer], { workload: [workload(writer, { member })] })
}

/** The writer over the level above, holding T and U whole, and its login: its one change member reads Rows at a
 * package. */
const aboveLogin = () => {
	const writer = role(above, "writer", { T, U }, { insert: ["T"] })
	const member = ChangeSet.empty(writer).read("rows", () =>
		query(above).rule((r) => {
			const { id, x, y } = v(Rows, "rows")
			return r.match(Rows, { package: r.param("package", int4), id, x, y }).find({ id, x, y })
		})
	)
	return login(above, "app", [writer], { workload: [workload(writer, { member })] })
}

/**
 * The login of a case as its change members compile (test/support/change-login.ts changeLogin): T and U, and Rows, a
 * stored derived relation joining them, declared under a check that reads it in the level `level` names; and one role
 * holding T and U whole, whose change member reads Rows at a package. It holds no entry of Rows, a derived relation, but sees every row
 * of what its definition reads, so it reads Rows in full through Rows's whole view (schema/own.ts OwnedRole
 * `wholeDerived`), a view of grizzle's naming no declared entry of the role names.
 */
export const derivedLoginOf = (level: Level) =>
	changeLogin(level === "the login's level" ? declaringLogin() : aboveLogin())
