/**
 * The unit-bound walk's two readings of a value another source delivers, held to each other (sql/unit-bound.ts
 * OuterReading): every scan the invariant's reading binds, PostgreSQL's binds, since a held outer column is one
 * PostgreSQL passes its block as a parameter, and a held ARRAY one it evaluates once, the reading
 * test/pg/sql/unit-bound.test.ts judges by PostgreSQL's plans; and the invariant's reading is stricter by exactly what
 * the definition asks, a column it fixes a scan by being held: fixed where its own level fixes it, read by a keyed chain
 * (a relation read at a held prefix of a declared key), the output of a query computed apart whose expression there is
 * held, or the call's own rows, a carrier's among them.
 *
 * Two spaces. The drawn statements of unit-bound.fixtures.ts, walked both ways. And a read of ub at the child of a
 * source drawn from seven, in one of two forms, a LATERAL block fenced so PostgreSQL plans it apart, at the source's
 * column, or a membership in an ARRAY of a sub-select of the source, which PostgreSQL evaluates once (an InitPlan): ua at
 * a parameter's child (held: fixed), ua whole (not), kc at a parameter's course (held: kc's key leads with course), kc at
 * a value of z, no key of it (not), a DISTINCT query of a parameter (held: its output is the parameter), a DISTINCT query
 * of ua's every child (not), and a carrier's rows, read through its reader (held: the call's own): the invariant binds ub
 * exactly where the source's column is held.
 *
 * Oracle: the drawn statements, the inclusion of one reading's faults in the other's; the seven sources in two forms,
 * the definition, a specification.
 *
 * Features: a scan only PostgreSQL's reading binds, each of the seven sources, each of the two forms.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Gen, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import type { FromSource, OperandCore, OperandSelect, Select } from "#compiler/sql/ast.ts"
import {
	col,
	core,
	derived,
	distinctCore,
	eq,
	lit,
	operandSelect,
	param,
	proved,
	target,
	types
} from "#compiler/sql/build.ts"
import { carrierName, carrierReaderScan, carrierScope, namedQuery } from "#compiler/sql/naming.ts"
import { readFaults } from "#compiler/sql/unit-bound.ts"
import { carrierColumnDef } from "#compiler/write/carriers/carriers.ts"
import { drawnGen, drawnTable, drawnTables } from "#test/pg/sql/unit-bound.fixtures.ts"

/** The features the two spaces reach. */
type ReadingFeature =
	| "a scan only PostgreSQL's reading binds"
	| "ua at a parameter"
	| "ua whole"
	| "kc at its key"
	| "kc at no key"
	| "a query of a parameter"
	| "a query of every child"
	| "a carrier's rows"
	| "a LATERAL block"
	| "an ARRAY sub-select"

/** The unit scans a reading leaves unbound, by alias. */
const unboundBy = (statement: Select, outer: "held" | "parameter"): ReadonlySet<string> =>
	new Set(
		Arr.flatMap(readFaults({ kind: "statement", statement }, drawnTables, outer), (f) =>
			f.kind === "unboundUnitRead" ? [f.alias] : []
		)
	)

/** Every scan the invariant's reading binds, PostgreSQL's binds. */
export const everyScanTheInvariantsReadingBindsPostgresqlsReadingBinds = property.explore(
	drawnGen,
	{
		needs: {},
		situations: ["a scan only PostgreSQL's reading binds"] satisfies ReadonlyArray<
			Reached<ReadingFeature>
		>,
		check: (_, c: Case<ReadingFeature>) => (drawn) =>
			Effect.sync(() => {
				const held = unboundBy(drawn.statement, "held")
				const parameter = unboundBy(drawn.statement, "parameter")
				for (const alias of parameter) {
					assert.ok(
						held.has(alias),
						`${alias}: PostgreSQL's reading leaves it unbound, and the invariant's binds it`
					)
				}
				if (held.size > parameter.size) {
					c.note("a scan only PostgreSQL's reading binds")
				}
			}),
		oracle: {
			kind: "universal",
			name: "inclusion: every scan the parameter reading leaves unbound, the held reading leaves unbound"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/unit-bound.ts",
				original:
					'\t\t\t\treturn this.#outer === "parameter" || this.held(this.#column(table, column, at), at)\n',
				replacement:
					'\t\t\t\treturn this.#outer === "held" || this.held(this.#column(table, column, at), at)\n',
				why: "The two readings traded: the invariant's takes every outer column for fixed and PostgreSQL's only a held one, so a scan PostgreSQL compares at a parameter is unbound where the invariant binds it."
			}
		]
	}
)

/** A source the read takes its child from: its FROM source, the column it delivers, and whether it is held. */
interface OuterSource {
	readonly feature: ReadingFeature
	readonly source: FromSource
	readonly child: string
	readonly held: boolean
}

/** The carrier the carrier's source reads: one column, the child. */
const carrier = carrierName(carrierScope(undefined), 1, {
	columns: [carrierColumnDef("child", types.integer)],
	primaryKey: undefined
})

/** One of the seven sources (the module header), by its place. */
const outerSourceGen: Gen<OuterSource> = (source) => {
	const p = param(1, types.integer)
	switch (int(0, 6)(source)) {
		case 0:
			return {
				feature: "ua at a parameter",
				source: derived(
					namedQuery(
						operandSelect(
							core([target(col("o", "child"))], [drawnTable("ua", "o")], eq(col("o", "child"), p))
						),
						["c1"]
					),
					"r1",
					false
				),
				child: "c1",
				held: true
			}
		case 1:
			return { feature: "ua whole", source: drawnTable("ua", "r1"), child: "child", held: false }
		case 2:
			return {
				feature: "kc at its key",
				source: derived(
					namedQuery(
						operandSelect(
							core([target(col("o", "child"))], [drawnTable("kc", "o")], eq(col("o", "course"), p))
						),
						["c1"]
					),
					"r1",
					false
				),
				child: "c1",
				held: true
			}
		case 3:
			return {
				feature: "kc at no key",
				source: derived(
					namedQuery(
						operandSelect(
							core([target(col("o", "child"))], [drawnTable("kc", "o")], eq(col("o", "z"), p))
						),
						["c1"]
					),
					"r1",
					false
				),
				child: "c1",
				held: false
			}
		case 4:
			return {
				feature: "a query of a parameter",
				source: derived(
					namedQuery(operandSelect(distinctCore([target(p)], [], undefined)), ["c1"]),
					"r1",
					false
				),
				child: "c1",
				held: true
			}
		case 5:
			return {
				feature: "a query of every child",
				source: derived(
					namedQuery(
						operandSelect(
							distinctCore([target(col("o", "child"))], [drawnTable("ua", "o")], undefined)
						),
						["c1"]
					),
					"r1",
					false
				),
				child: "c1",
				held: false
			}
		default:
			return {
				feature: "a carrier's rows",
				source: carrierReaderScan(carrier, ["child"], "r1"),
				child: "child",
				held: true
			}
	}
}

/** The form a read of ub takes its child from a source in. */
type ReadForm = "a LATERAL block" | "an ARRAY sub-select"

/** A source and the form ub is read at its child in. */
const readGen: Gen<{ readonly outer: OuterSource; readonly form: ReadForm }> = (source) => ({
	outer: outerSourceGen(source),
	form: int(0, 1)(source) === 0 ? "a LATERAL block" : "an ARRAY sub-select"
})

/** The statement that reads ub at the child of `outer` in `form`. */
const readAt = (outer: OuterSource, form: ReadForm): Select => {
	switch (form) {
		case "a LATERAL block":
			return lateralRead(outer)
		case "an ARRAY sub-select":
			return arrayRead(outer)
	}
}

/** A plain core as a query of its own. */
const selectOf = (c: OperandCore): Select => ({
	kind: "select",
	with: undefined,
	body: proved("certified", c),
	orderBy: [],
	limit: undefined,
	offset: undefined
})

/** The statement that reads ub where its child is a member of an ARRAY of `outer`'s children. */
const arrayRead = (outer: OuterSource): Select =>
	selectOf(
		core([target(col("b", "y"))], [drawnTable("ub", "b")], {
			kind: "equalsAny",
			expr: col("b", "child"),
			array: {
				kind: "array",
				query: selectOf(core([target(col("r1", outer.child))], [outer.source], undefined))
			},
			schema: undefined
		})
	)

/** The statement that reads ub, LATERAL and fenced by OFFSET 0, at the child of `outer`. */
const lateralRead = (outer: OuterSource): Select => {
	const block: OperandSelect = {
		...operandSelect(
			core(
				[target(col("b", "y"))],
				[drawnTable("ub", "b")],
				eq(col("b", "child"), col("r1", outer.child))
			)
		),
		offset: lit.int(0, types.bigint)
	}
	return selectOf(
		core(
			[target(col("r2", "c2"))],
			[outer.source, derived(namedQuery(block, ["c2"]), "r2", true)],
			undefined
		)
	)
}

/** The invariant's reading binds a scan read at another source's column exactly where that column is held. */
export const theInvariantsReadingBindsAScanReadAtAnotherSourcesColumnExactlyWhereTheColumnIsHeld =
	property.explore(readGen, {
		needs: {},
		situations: [
			"ua at a parameter",
			"ua whole",
			"kc at its key",
			"kc at no key",
			"a query of a parameter",
			"a query of every child",
			"a carrier's rows",
			"a LATERAL block",
			"an ARRAY sub-select"
		] satisfies ReadonlyArray<Reached<ReadingFeature>>,
		check:
			(_, c: Case<ReadingFeature>) =>
			({ outer, form }) =>
				Effect.sync(() => {
					c.note(outer.feature)
					c.note(form)
					const statement = readAt(outer, form)
					assert.equal(
						!unboundBy(statement, "held").has("b"),
						outer.held,
						`ub read at the child of ${outer.feature} in ${form}: bound exactly where that child is held`
					)
					assert.ok(
						!unboundBy(statement, "parameter").has("b"),
						"PostgreSQL's reading binds it at its parameter"
					)
				}),
		oracle: {
			kind: "specification",
			name: "the definition: a column another source delivers holds a scan exactly where it is fixed, read by a keyed chain, held by lineage, or the call's own"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/unit-bound.ts",
				original:
					'\t\t\t\treturn this.#outer === "parameter" || this.held(this.#column(table, column, at), at)\n',
				replacement: "\t\t\t\treturn true\n",
				why: "Every outer column read as held: a scan read at the child of every child stored, or of a value of a column no key leads with, is bound, though it reads every unit's rows."
			},
			{
				file: "packages/engine/src/sql/unit-bound.ts",
				original:
					'\t\treturn held !== undefined && (this.#outer === "parameter" || held[0] === true)\n',
				replacement: "\t\treturn held !== undefined\n",
				why: "Every ARRAY of a sub-select of no outer row read as held: a scan read at a member of every child stored, or of a value of a column no key leads with, is bound, though it reads every unit's rows."
			},
			{
				file: "packages/engine/src/sql/unit-bound.ts",
				original: "\t\t\t\t\t\tcarrierReadBy(s) === undefined\n",
				replacement: "\t\t\t\t\t\ttrue\n",
				why: "A carrier's rows read as its reader's call, a VOLATILE function's: the call's own rows, staged by a write, are no longer held, so a scan read at a carrier's child is unbound."
			}
		]
	})
