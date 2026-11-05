import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { summarize } from "#bench/cold/stats.ts"
import {
	type CaseRecord,
	type Conditions,
	defineGate,
	equivalence,
	type GateCheck,
	mechanism
} from "#bench/harness/gate.ts"
import { GateSetupError } from "#bench/query/support/kit.ts"
import { oneRow, timed, writeConditions } from "#bench/write/support/writes.ts"
import type { Limit } from "#compiler/core/limits.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { packCodes } from "#compiler/ir/cells.ts"
import type { ObjectName, TypeRef } from "#compiler/sql/ast.ts"
import { namedType, types } from "#compiler/sql/build.ts"
import { column, printConstantExpr } from "#compiler/sql/constants.ts"
import { printObjectName, quoteIdent } from "#compiler/sql/print.ts"
import type { SqlError } from "#test/support/pg.ts"
import {
	addColumnSql,
	type ClosedRelation,
	type CodeColumn,
	cellCount,
	cellDomainSql,
	cellExpr,
	checkConstraint,
	constantBits,
	derivedExpr,
	digitsAt,
	dropConstantSql,
	foreignKeySql,
	generatedColumn,
	hostBits,
	memberColumns,
	membersOf,
	membersTableSql,
	packSql,
	repointSql,
	rowLaw,
	setExpressionSql,
	tableOfCodes,
	testTypeSchema,
	widthOf
} from "#test/support/sql.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * law-cost: what each placement of a law over a closed relation costs a one-row INSERT, by the size of the constant it
 * reads.
 *
 * A closed relation compiles to a constant, one bit string of cells behind an IMMUTABLE SQL function, and a law over
 * it sits in one of five places. In a scratch schema, at constants of 363 bits (a roster of 363 live codes), 263,538
 * bits (a set of 17,661 of 2 · 363 · 363 cells) and 1,054,152 bits (the same cells, each one of eight ranks in 4
 * bits), every placement gets a table of three int2 codes:
 *
 * - an FK into the set's seeded members table, the placement erasure replaces;
 * - a CHECK calling the constant at the codes' cell;
 * - a cell written by the host into a column of the relation's domain, whose check reads the constant;
 * - a cell generated from the codes, STORED, typed by that domain;
 * - a derived column, the payload code at the codes' cell, STORED.
 *
 * Every statement that packs, reads, re-points or drops a constant, every domain, the members tables, the foreign key
 * and the host-written cells are the engine's print (test/support/sql.ts over sql/constants.ts and sql/print.ts), so
 * the figures are those of what grizzle emits. The table of codes and the clause that adds a CHECK or a generated column
 * are written by hand around the engine's print of their expressions, since the engine's table AST holds no constant
 * expression yet.
 *
 * Each table takes the set's members by rank, one one-row INSERT a statement from one plpgsql DO block, the tables
 * interleaved in every round after TRUNCATE and CHECKPOINT. A placement's cost is the median over rounds of its time
 * less its base's in the same round, per statement; the base is the bare table of the codes, or for the written cell
 * the same table with a plain int8 cell. A case is held to its ceiling, a Limit measured by a full run of this gate on
 * the build it runs on, once such a run has measured it; until then its cost is recorded and gates nothing.
 *
 * The verdict holds that every constant PostgreSQL packs is the host encoder's string of its members (ir/cells.ts
 * bitText); that every law refuses the row one past its constant's end, which reads as absent, with its SQLSTATE; and
 * that every derived column reads its relation's payload code on every stored row and NULL past the end. Recorded
 * beside it: each constant's pack, the migration's DO block; the first INSERT through each domain in a fresh backend,
 * beyond the plain cell's; and a change of the set over `rows` rows, its domain re-pointed at a grown set and
 * VALIDATEd, its derived column rewritten by SET EXPRESSION, and a VALIDATE against a constant that drops a stored
 * member refused.
 */
interface Options extends Readonly<Record<string, unknown>> {
	/** One-row INSERTs per table per round. */
	readonly statements: number
	/** Measured rounds, after one warm-up round. */
	readonly rounds: number
	/** Timed packs of each constant. */
	readonly packs: number
	/** Fresh backends per table, each timing its first and second INSERT. */
	readonly backends: number
	/** Rows of the tables a change reads: at least the set's members, so every member is stored. */
	readonly rows: number
	/** Swaps of the set's domain and derived column, alternating between the grown set and the set. */
	readonly changes: number
}

/** The code columns of every table. */
type CodeName = "version" | "parent" | "child"

/** A row of codes, one per code column. */
type Row = { readonly [K in CodeName]: number }

/** The closed relations the placements read, over the code columns. */
type Relation = ClosedRelation<CodeName>

const version: CodeColumn<CodeName> = { column: "version", codes: 2 }
const parent: CodeColumn<CodeName> = { column: "parent", codes: 363 }
const child: CodeColumn<CodeName> = { column: "child", codes: 363 }

/** Every table's codes, in this order: the key of the set and of the ranks, of which the roster reads the child. */
const codes: Arr.NonEmptyReadonlyArray<CodeColumn<CodeName>> = [version, parent, child]

/** The row of code 0 in every column, a code of each column's space. */
const origin: Row = { version: 0, parent: 0, child: 0 }

/**
 * The stride that scatters every relation's members over its cells: a prime dividing neither 363 nor 2 · 363², so the
 * ranks it gives are a permutation of each relation's cells.
 */
const stride = 7919

/** Every one of 363 codes live: 363 bits, the constant of a roster's domain. */
const roster: Relation = { name: "roster", key: [child], payload: [], members: 363, stride }

/** 17,661 members of 263,538 cells: a set over three codes, one bit a cell. */
const triples: Relation = { name: "triples", key: codes, payload: [], members: 17661, stride }

/** The set's members, each one of eight ranks: a function, 4 bits a cell. */
const ranks: Relation = { name: "ranks", key: codes, payload: [8], members: 17661, stride }

/** The set grown by the member of next rank: a change that every stored row still meets. */
const grown: Relation = { ...triples, name: "triples_grown", members: triples.members + 1 }

/** The set without its member of last rank, which a change's rows store: a change VALIDATE refuses. */
const shrunk: Relation = { ...triples, name: "triples_shrunk", members: triples.members - 1 }

/** The relations whose constants the placements read, by size. */
const sides: ReadonlyArray<Relation> = [roster, triples, ranks]

/** The row whose key columns hold `digits`, the relation's key codes in key order, and every other column code 0. */
const rowAt = (relation: Relation, digits: ReadonlyArray<number>): Row =>
	Arr.reduce(Arr.zip(relation.key, digits), origin, (row, [k, code]): Row => ({
		...row,
		[k.column]: code
	}))

/** The row one past the end of a relation's constant: its first key digit lies outside its code space. */
const pastTheEnd = (relation: Relation): Row =>
	rowAt(relation, digitsAt(relation, cellCount(relation)))

/** The objects of a run, each named in its scratch schema. */
interface Names {
	readonly object: (name: string) => ObjectName
	readonly constant: (relation: Relation) => ObjectName
	readonly domain: (relation: Relation) => ObjectName
	/** A relation's domain as a column's type. */
	readonly domainType: (relation: Relation) => TypeRef
	readonly members: (relation: Relation) => ObjectName
}

const namesIn = (schema: string): Names => ({
	object: (name) => ({ schema, name }),
	constant: (relation) => ({ schema, name: `${relation.name}_c` }),
	domain: (relation) => ({ schema, name: `${relation.name}_cell` }),
	domainType: (relation) => namedType(testTypeSchema(schema), `${relation.name}_cell`, []),
	members: (relation) => ({ schema, name: `${relation.name}_members` })
})

/** The column of a table that holds a law's cell, written by the host or generated. */
const cellColumn = "cell"

/** The column of a table derived from a relation: the payload code at the row's cell, or NULL outside the relation. */
const payloadColumn = "payload"

/** A table of the codes, and what it adds to them. */
interface Table {
	readonly name: string
	readonly title: string
	/** The relation whose cell the host writes into the table's cell column; none where it writes no cell. */
	readonly cell: Option.Option<Relation>
	/** The statements that add its column or constraint to its table of codes, `table`. */
	readonly ddl: (at: Names, table: ObjectName) => ReadonlyArray<string>
}

/** Where a law over a relation sits on a table of codes. */
type LawKind = "foreignKey" | "check" | "domainCell" | "generatedCell" | "derived"

/** What a placement is, read in one place: its table's name, its title, its refusal and its DDL. */
interface LawSpec {
	/** The name of its table, before the name of the relation it reads. */
	readonly prefix: string
	readonly title: (relation: Relation) => string
	/** The SQLSTATE it refuses a row outside its relation with; none for a placement that is no law. */
	readonly refusal: Option.Option<string>
	readonly writesCell: boolean
	readonly ddl: (at: Names, relation: Relation, table: ObjectName) => ReadonlyArray<string>
}

const sized = (relation: Relation): string =>
	`the ${constantBits(relation)}-bit ${relation.name} constant`

/** The cell of a table's own codes. */
const ownCell = (relation: Relation) => cellExpr(relation, (k) => column(undefined, k.column))

const laws: { readonly [K in LawKind]: LawSpec } = {
	foreignKey: {
		prefix: "fk",
		title: (relation) => `an FK into the seeded ${relation.name} members`,
		refusal: Option.some(sqlstates.foreignKeyViolation),
		writesCell: false,
		ddl: (at, relation, table) => [
			foreignKeySql(table, "into_members", relation, at.members(relation))
		]
	},
	check: {
		prefix: "checked",
		title: (relation) => `a CHECK calling ${sized(relation)}`,
		refusal: Option.some(sqlstates.checkViolation),
		writesCell: false,
		ddl: (at, relation, table) => [
			checkConstraint(table, "member", rowLaw(at.constant(relation), relation))
		]
	},
	domainCell: {
		prefix: "domain",
		title: (relation) => `a cell written by the host, typed by the domain over ${sized(relation)}`,
		refusal: Option.some(sqlstates.checkViolation),
		writesCell: true,
		ddl: (at, relation, table) => [addColumnSql(table, cellColumn, at.domainType(relation))]
	},
	generatedCell: {
		prefix: "generated",
		title: (relation) => `a generated cell typed by the domain over ${sized(relation)}`,
		refusal: Option.some(sqlstates.checkViolation),
		writesCell: false,
		ddl: (at, relation, table) => [
			generatedColumn(table, cellColumn, at.domainType(relation), ownCell(relation))
		]
	},
	derived: {
		prefix: "derived",
		title: (relation) => `a derived column reading ${sized(relation)}`,
		refusal: Option.none(),
		writesCell: false,
		ddl: (at, relation, table) => [
			generatedColumn(
				table,
				payloadColumn,
				types.integer,
				derivedExpr(at.constant(relation), relation)
			)
		]
	}
}

/**
 * A placement's table, the relation it reads, the base it is measured beyond, and the ceiling of its cost per
 * statement beyond that base: a Limit measured by a full run of this gate, or none while no run has measured the case,
 * which is then recorded and gates nothing.
 */
interface LawCase extends Table {
	readonly kind: LawKind
	readonly relation: Relation
	readonly refusal: Option.Option<string>
	readonly base: Table
	readonly ceiling: Option.Option<Limit>
}

const lawCase = (
	kind: LawKind,
	relation: Relation,
	base: Table,
	ceiling: Option.Option<Limit>
): LawCase => {
	const spec = laws[kind]
	return {
		name: `${spec.prefix}_${relation.name}`,
		title: spec.title(relation),
		cell: spec.writesCell ? Option.some(relation) : Option.none(),
		ddl: (at, table) => spec.ddl(at, relation, table),
		kind,
		relation,
		refusal: spec.refusal,
		base,
		ceiling
	}
}

const bare: Table = {
	name: "bare",
	title: "the bare table of three codes",
	cell: Option.none(),
	ddl: () => []
}

/** The written cell's base: the set's cell, written by the host into a plain int8 column. */
const plainCell: Table = {
	name: "plain_triples",
	title: "a plain int8 cell written by the host",
	cell: Option.some(triples),
	ddl: (_at, table) => [addColumnSql(table, cellColumn, types.bigint)]
}

/** The set's domain-typed cell, whose domain a change re-points and VALIDATEs. */
const domainTriples = lawCase("domainCell", triples, plainCell, Option.none())

/** The set's derived column, which a change rewrites by SET EXPRESSION. */
const derivedTriples = lawCase("derived", triples, bare, Option.none())

/** Every placement, with its base: none is yet measured by a full run of this gate, so each is recorded. */
const lawCases: ReadonlyArray<LawCase> = [
	lawCase("foreignKey", triples, bare, Option.none()),
	lawCase("check", roster, bare, Option.none()),
	lawCase("check", triples, bare, Option.none()),
	lawCase("check", ranks, bare, Option.none()),
	lawCase("domainCell", roster, plainCell, Option.none()),
	domainTriples,
	lawCase("domainCell", ranks, plainCell, Option.none()),
	lawCase("generatedCell", roster, bare, Option.none()),
	lawCase("generatedCell", triples, bare, Option.none()),
	lawCase("generatedCell", ranks, bare, Option.none()),
	lawCase("derived", roster, bare, Option.none()),
	derivedTriples,
	lawCase("derived", ranks, bare, Option.none())
]

/** Every table a round fills, in its order: the two bases, then every placement. */
const tables: ReadonlyArray<Table> = [bare, plainCell, ...lawCases]

/** A column a statement writes, its element type, and the SQL of its value over a row of the members table. */
interface WrittenColumn {
	readonly column: string
	readonly type: string
	readonly value: string
}

/** The columns the host writes into a table from the members table under `alias`: the codes, and its cell. */
const writtenColumns = (table: Table, alias: string): ReadonlyArray<WrittenColumn> => [
	...Arr.map(codes, (k) => ({
		column: quoteIdent(k.column),
		type: "int2",
		value: printConstantExpr(column(alias, k.column))
	})),
	...Option.toArray(
		Option.map(table.cell, (relation) => ({
			column: quoteIdent(cellColumn),
			type: "int8",
			value: printConstantExpr(cellExpr(relation, (k) => column(alias, k.column)))
		}))
	)
]

const columnList = (columns: ReadonlyArray<{ readonly column: string }>): string =>
	Arr.join(
		Arr.map(columns, (c) => c.column),
		", "
	)

/**
 * One round's statements for `table`: the set's members aggregated once into an array per written column, in rank
 * order, then `statements` one-row INSERTs cycling through them. Every member of the set is a member of the ranks, and
 * its child a live code of the roster, so every table accepts every row.
 */
const loopSql = (at: Names, table: Table, statements: number): string => {
	const arrays = Arr.map(writtenColumns(table, "m"), (c, i) => ({ ...c, array: `a${i}` }))
	const position = `i % ${triples.members} + 1`
	return `DO $loop$
DECLARE ${Arr.join(
		Arr.map(arrays, (a) => `${a.array} ${a.type}[];`),
		" "
	)}
BEGIN
	SELECT ${Arr.join(
		Arr.map(
			arrays,
			(a) => `pg_catalog.array_agg(${a.value} ORDER BY "m".${quoteIdent(memberColumns.rank)})`
		),
		", "
	)} INTO ${Arr.join(
		Arr.map(arrays, (a) => a.array),
		", "
	)} FROM ${printObjectName(at.members(triples))} AS "m";
	FOR i IN 0..${statements - 1} LOOP
		INSERT INTO ${printObjectName(at.object(table.name))} (${columnList(arrays)}) VALUES (${Arr.join(
			Arr.map(arrays, (a) => `${a.array}[${position}]`),
			", "
		)});
	END LOOP;
END $loop$`
}

/** One INSERT of `rows` rows into `table`, the set's members cycled by rank. */
const loadSql = (at: Names, table: Table, rows: number): string => {
	const columns = writtenColumns(table, "m")
	return `INSERT INTO ${printObjectName(at.object(table.name))} (${columnList(columns)}) SELECT ${Arr.join(
		Arr.map(columns, (c) => c.value),
		", "
	)} FROM pg_catalog.generate_series(0, ${rows - 1}) AS g(i) JOIN ${printObjectName(at.members(triples))} AS "m" ON "m".${quoteIdent(memberColumns.rank)} = g.i % ${triples.members}`
}

/** One INSERT of a row of codes, with the cell the host packs of them (ir/cells.ts packCodes), if it writes one. */
const insertRow = (at: Names, table: Table, row: Row): string => {
	const values = [
		...Arr.map(codes, (k) => ({ column: quoteIdent(k.column), value: String(row[k.column]) })),
		...Option.toArray(
			Option.map(table.cell, (relation) => ({
				column: quoteIdent(cellColumn),
				value: String(packCodes(Arr.map(relation.key, (k) => row[k.column])))
			}))
		)
	]
	return `INSERT INTO ${printObjectName(at.object(table.name))} (${columnList(values)}) VALUES (${Arr.join(
		Arr.map(values, (v) => v.value),
		", "
	)})`
}

/**
 * The rows of `table` and how many of them disagree with `relation`: a row disagrees where its derived payload is not
 * the payload code of its codes' member, which is NULL where they name no member.
 */
const agreementSql = (at: Names, table: string, relation: Relation): string =>
	`SELECT pg_catalog.count(*)::text, (pg_catalog.count(*) FILTER (WHERE "t".${quoteIdent(payloadColumn)} IS DISTINCT FROM "m".${quoteIdent(memberColumns.code)}))::text FROM ${printObjectName(at.object(table))} AS "t" LEFT JOIN ${printObjectName(at.members(relation))} AS "m" ON ${Arr.join(
		Arr.map(relation.key, (k) => `"m".${quoteIdent(k.column)} = "t".${quoteIdent(k.column)}`),
		" AND "
	)}`

/** What PostgreSQL answered one statement: it accepted it, or refused it with a SQLSTATE, naming a table or not. */
type Answer =
	| { readonly kind: "accepted" }
	| {
			readonly kind: "refused"
			readonly sqlstate: string
			readonly table: Option.Option<string>
	  }

const answerText = (answer: Answer): string =>
	answer.kind === "accepted"
		? "accepted"
		: `refused ${answer.sqlstate}${Option.match(answer.table, { onNone: () => "", onSome: (t) => ` on ${t}` })}`

/** The answer to one statement; a session that fails is the run's failure, never an answer. */
const answerOf = Effect.fn("answerOf")(function* (
	session: RawSession,
	sql: string
): Effect.fn.Return<Answer, SqlError> {
	const result = yield* Effect.result(session.values(sql, []))
	if (Result.isSuccess(result)) {
		return { kind: "accepted" }
	}
	const reason = result.failure.reason
	if (reason._tag === "ConnectionError") {
		return yield* result.failure
	}
	return { kind: "refused", sqlstate: reason.fields.code, table: reason.fields.table }
})

/** A whole number a statement answers as text: a count, a length or a code. */
const wholeNumber = (cell: unknown): number => {
	const n = typeof cell === "string" ? Number(cell) : Number.NaN
	if (!Number.isSafeInteger(n)) {
		throw new GateSetupError({ what: `${String(cell)} where the gate reads a whole number` })
	}
	return n
}

/** The two whole numbers of a row of two text cells; another shape is a defect of the gate's setup. */
const pairOf = (row: ReadonlyArray<unknown>): readonly [number, number] => {
	const [a, b, ...more] = row
	if (a === undefined || b === undefined || more.length > 0) {
		throw new GateSetupError({ what: `${row.length} cells where the gate reads two` })
	}
	return [wholeNumber(a), wholeNumber(b)]
}

/** The one text cell of a row; another shape is a defect of the gate's setup. */
const textOf = (row: ReadonlyArray<unknown>): string => {
	const [only, ...more] = row
	if (typeof only !== "string" || more.length > 0) {
		throw new GateSetupError({ what: `${row.length} cells where the gate reads one text` })
	}
	return only
}

/** A run of a table's loop, as one round timed it. */
interface Timed {
	readonly table: string
	readonly ms: number
}

const inRound = (round: ReadonlyArray<Timed>, table: Table): number =>
	Option.getOrThrowWith(
		Arr.findFirst(round, (t) => (t.table === table.name ? Option.some(t.ms) : Option.none())),
		() => new GateSetupError({ what: `a round without ${table.name}` })
	)

const round3 = (x: number): number => Math.round(x * 1000) / 1000

/** The middle of a nonempty list of samples, by nearest rank. */
const median = (xs: ReadonlyArray<number>): number => summarize(xs).p50

/** Whether every one of `xs` holds, and what each observed. */
const allHold = (
	xs: ReadonlyArray<{ readonly holds: boolean; readonly detail: string }>
): { readonly holds: boolean; readonly detail: string } => ({
	holds: Arr.every(xs, (x) => x.holds),
	detail: Arr.join(
		Arr.map(xs, (x) => x.detail),
		"; "
	)
})

const schemaState =
	"a scratch schema: each constant packed by the engine's DO block, each domain the engine's over its constant, the members tables and the foreign key the engine's, every table empty at the start of each round (TRUNCATE, then CHECKPOINT)"

const data = `the set's ${triples.members} members of ${cellCount(triples)} cells, scattered by the stride ${stride}, taken in rank order`

const conditions = (c: {
	readonly workload: string
	readonly parameters: Readonly<Record<string, unknown>>
	readonly semantics: string
	readonly cache: string
}): Conditions => writeConditions({ ...c, schemaState, data })

/** @internal */
export default defineGate({
	name: "write-laws",
	gates: ["law-cost"],
	title: "Each law placement's cost per one-row INSERT, by the size of its constant",
	scope:
		"An FK into a seeded table, a CHECK calling a constant, a domain-typed cell, a generated cell and a derived column, " +
		"at constants of 363, 263,538 and 1,054,152 bits, one-row INSERTs interleaved in rounds, every constant statement " +
		"the engine's print; each constant's pack, the first INSERT through each domain per backend, and VALIDATE and SET " +
		"EXPRESSION over a change's rows, recorded.",
	phases: [
		"loopMs",
		"packMs",
		"firstInsertMs",
		"secondInsertMs",
		"swapMs",
		"validateMs",
		"setExpressionMs"
	],
	options: {
		full: {
			statements: 20000,
			rounds: 15,
			packs: 5,
			backends: 15,
			rows: 1000000,
			changes: 3
		},
		quick: { statements: 2000, rounds: 3, packs: 1, backends: 3, rows: 20000, changes: 1 }
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			if (options.rows < triples.members) {
				return yield* new GateSetupError({
					what: `${options.rows} rows store fewer than the set's ${triples.members} members`
				})
			}
			const s = yield* Substrate
			const schemaName = yield* s.schema({ ...freshSchema, label: "benchlaws" })
			const at = namesIn(schemaName)
			const session = yield* s.session({ ...ownerSession(), label: "law cost" })
			const exec = (sql: string) => session.values(sql, [])
			const pairFrom = (sql: string) => Effect.map(exec(sql), (rows) => pairOf(oneRow(rows)))

			for (const relation of [...sides, grown]) {
				const [create, fill] = membersTableSql(at.members(relation), relation)
				yield* exec(create)
				yield* session.values(fill.sql, fill.params)
				yield* exec(`VACUUM (ANALYZE) ${printObjectName(at.members(relation))}`)
			}

			/** Each side's packs, each timed and then dropped, before the pack that installs it. */
			const packCases: Array<CaseRecord<"law-cost">> = []
			for (const relation of sides) {
				const pack = packSql(at.constant(relation), relation)
				const drop = dropConstantSql(at.constant(relation))
				const packs: Array<number> = []
				for (let k = 0; k < options.packs; k++) {
					const packed = yield* timed(exec(pack))
					packs.push(packed.ms)
					yield* exec(drop)
				}
				yield* exec(pack)
				const sizes = yield* session.values(
					`SELECT pg_catalog.pg_column_size(p.prosqlbody)::text, pg_catalog.pg_column_size(${printObjectName(at.constant(relation))}())::text FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = $1::text AND p.proname = $2::text`,
					[schemaName, at.constant(relation).name]
				)
				const [storedBytes, constantBytes] = pairOf(oneRow(sizes))
				packCases.push({
					name: `the pack of ${sized(relation)}: ${cellCount(relation)} cells of ${widthOf(relation)} bits`,
					gates: ["law-cost"],
					conditions: conditions({
						workload: `the engine's pack, one DO block: its ${relation.members} members as VALUES rows, the outer join of ${cellCount(relation)} cells against them, and CREATE FUNCTION with the cells as its body`,
						parameters: { cells: cellCount(relation), members: relation.members },
						semantics:
							"the function returns the constant: its cells at their width, its members present",
						cache: "each sample a fresh function, dropped after it is timed"
					}),
					phases: { packMs: summarize(packs) },
					variants: [],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						cells: cellCount(relation),
						constantBits: constantBits(relation),
						storedBytes,
						constantBytes
					}
				})
			}
			for (const relation of [grown, shrunk]) {
				yield* exec(packSql(at.constant(relation), relation))
			}

			/** Each constant PostgreSQL packed, against the host encoder's string of its members. */
			const shapes = yield* Effect.forEach([...sides, grown, shrunk], (relation) =>
				Effect.gen(function* () {
					const expected = hostBits(relation)
					if (!expected.ok) {
						return yield* new GateSetupError({
							what: `the host cannot encode ${relation.name}: ${Formatter.format(expected.error)}`
						})
					}
					const read = yield* exec(`SELECT ${printObjectName(at.constant(relation))}()::text`)
					const packed = textOf(oneRow(read))
					return {
						holds: packed === expected.value,
						detail: `${relation.name}: ${packed.length} bits of ${constantBits(relation)}, ${packed === expected.value ? "the host's" : "not the host's"}`
					}
				})
			)

			for (const relation of sides) {
				for (const sql of cellDomainSql(at.domain(relation), at.constant(relation), relation)) {
					yield* exec(sql)
				}
			}
			for (const table of tables) {
				const name = at.object(table.name)
				yield* exec(tableOfCodes(name, codes))
				for (const sql of table.ddl(at, name)) {
					yield* exec(sql)
				}
			}

			/** Each law's answer to the row one past its constant's end. */
			const refusals = yield* Effect.forEach(
				Arr.flatMap(lawCases, (c) =>
					Option.toArray(Option.map(c.refusal, (expected) => ({ c, expected })))
				),
				({ c, expected }) =>
					Effect.map(answerOf(session, insertRow(at, c, pastTheEnd(c.relation))), (answer) => ({
						holds: answer.kind === "refused" && answer.sqlstate === expected,
						detail: `${c.name}: ${answerText(answer)}, expected ${expected}`
					}))
			)

			const truncate = `TRUNCATE ${Arr.join(
				Arr.map(tables, (t) => printObjectName(at.object(t.name))),
				", "
			)}`
			const round = Effect.fn("round")(function* () {
				yield* exec(truncate)
				yield* s.superuser("CHECKPOINT")
				return yield* Effect.forEach(tables, (table) =>
					Effect.map(timed(exec(loopSql(at, table, options.statements))), (t): Timed => ({
						table: table.name,
						ms: t.ms
					}))
				)
			})
			yield* round()
			const rounds = yield* Effect.forEach(
				Arr.makeBy(options.rounds, (i) => i),
				() => round()
			)
			const perStatement = (ms: number): number => round3((ms * 1000) / options.statements)
			const loopsOf = (table: Table): ReadonlyArray<number> =>
				Arr.map(rounds, (r) => inRound(r, table))
			const beyond = (table: Table, base: Table): number =>
				perStatement(median(Arr.map(rounds, (r) => inRound(r, table) - inRound(r, base))))

			/** Each derived column read past the end, then compared with its relation's payload on every stored row. */
			const derivation = Effect.fn("derivation")(function* (c: LawCase) {
				yield* exec(insertRow(at, c, pastTheEnd(c.relation)))
				const [stored, disagreeing] = yield* pairFrom(agreementSql(at, c.name, c.relation))
				return {
					holds: stored === options.statements + 1 && disagreeing === 0,
					detail: `${c.name}: ${disagreeing} of ${stored} rows disagree`
				}
			})
			const derivations = yield* Effect.forEach(
				Arr.filter(lawCases, (c) => c.kind === "derived"),
				derivation
			)

			const statementCase = (
				table: Table,
				comparison: Readonly<Record<string, number>>
			): CaseRecord<"law-cost"> => ({
				name: table.title,
				gates: ["law-cost"],
				conditions: conditions({
					workload: `${options.statements} one-row INSERTs into ${table.name} from one plpgsql DO block, a statement each, in each of ${options.rounds} rounds`,
					parameters: {
						table: table.name,
						statements: options.statements,
						rounds: options.rounds
					},
					semantics: "every row is a member, so every INSERT keeps its law and is accepted",
					cache:
						"one warm owner backend: a warm-up round before the measured ones, the tables interleaved in each round"
				}),
				phases: { loopMs: summarize(loopsOf(table)) },
				variants: [],
				comparisons: [],
				transactions: {},
				loads: {},
				measures: { microsPerStatement: perStatement(median(loopsOf(table))), ...comparison }
			})
			const costs = Arr.map(lawCases, (c) => ({ c, micros: beyond(c, c.base) }))
			const statementCases: ReadonlyArray<CaseRecord<"law-cost">> = [
				statementCase(bare, {}),
				statementCase(plainCell, { microsBeyondBase: beyond(plainCell, bare) }),
				...Arr.map(costs, ({ c, micros }) =>
					statementCase(c, {
						microsBeyondBase: micros,
						constantBits: constantBits(c.relation),
						...Option.match(c.ceiling, {
							onNone: () => ({}),
							onSome: (ceiling) => ({ ceilingMicros: round3(ceiling.value) })
						})
					})
				)
			]

			/**
			 * The first and second INSERT through each written cell, each sample in a fresh backend: the set's members of
			 * rank 0 and 1.
			 */
			const [memberA, memberB] = membersOf(triples)
			if (memberA === undefined || memberB === undefined) {
				return yield* new GateSetupError({ what: "the set has fewer than two members" })
			}
			const rowA = rowAt(triples, memberA.key)
			const rowB = rowAt(triples, memberB.key)
			const firstUseSample = Effect.fn("firstUseSample")(function* (table: Table) {
				const fresh = yield* s.session({
					...ownerSession(),
					label: `law cost first use ${table.name}`
				})
				const first = yield* timed(fresh.values(insertRow(at, table, rowA), []))
				const second = yield* timed(fresh.values(insertRow(at, table, rowB), []))
				return { first: first.ms, second: second.ms }
			})
			const firstUse = (table: Table) =>
				Effect.map(
					Effect.forEach(
						Arr.makeBy(options.backends, (i) => i),
						() => Effect.scoped(firstUseSample(table))
					),
					(samples) => {
						const first = Arr.map(samples, (x) => x.first)
						const second = Arr.map(samples, (x) => x.second)
						return { first, second, ms: round3(median(first) - median(second)) }
					}
				)
			const plainUse = yield* firstUse(plainCell)
			const domainUses = yield* Effect.forEach(
				Arr.filter(lawCases, (c) => c.kind === "domainCell"),
				(c) => Effect.map(firstUse(c), (use) => ({ c, use }))
			)
			const firstUseCase = (
				table: Table,
				use: { readonly first: ReadonlyArray<number>; readonly second: ReadonlyArray<number> },
				measures: Readonly<Record<string, number>>
			): CaseRecord<"law-cost"> => ({
				name: `the first use per backend of ${table.title}`,
				gates: ["law-cost"],
				conditions: conditions({
					workload: `in a fresh backend, two one-row INSERTs into ${table.name}, each timed`,
					parameters: { table: table.name, backends: options.backends },
					semantics: "both rows are members and are accepted",
					cache:
						"each sample a fresh backend: its first INSERT plans the table's expressions and, through a domain, folds the constant into the typcache"
				}),
				phases: { firstInsertMs: summarize(use.first), secondInsertMs: summarize(use.second) },
				variants: [],
				comparisons: [],
				transactions: {},
				loads: {},
				measures
			})
			const firstUseCases: ReadonlyArray<CaseRecord<"law-cost">> = [
				firstUseCase(plainCell, plainUse, { firstUseMs: plainUse.ms }),
				...Arr.map(domainUses, ({ c, use }) =>
					firstUseCase(c, use, {
						firstUseMs: use.ms,
						firstUseBeyondBaseMs: round3(use.ms - plainUse.ms),
						constantBits: constantBits(c.relation)
					})
				)
			]

			yield* exec(truncate)
			const domainLoad = yield* timed(exec(loadSql(at, domainTriples, options.rows)))
			const derivedLoad = yield* timed(exec(loadSql(at, derivedTriples, options.rows)))
			/** The member the grown set adds, its rank the set's member count. */
			const added = Arr.findFirst(membersOf(grown), (m) => m.rank === triples.members)
			if (Option.isNone(added)) {
				return yield* new GateSetupError({ what: "the grown set adds no member" })
			}
			yield* exec(insertRow(at, derivedTriples, rowAt(grown, added.value.key)))
			const disagreeing = (relation: Relation) =>
				Effect.map(pairFrom(agreementSql(at, derivedTriples.name, relation)), ([, n]) => n)
			const beforeAgainstSet = yield* disagreeing(triples)
			const domain = at.domain(triples)
			const derivedTable = at.object(derivedTriples.name)
			/**
			 * One change of the set over `rows` rows: its domain re-pointed at `to` and VALIDATEd, and its derived column
			 * rewritten to read `to`. The changes alternate between the grown set and the set, and a VALIDATE against the
			 * shrunk set, refused, is rolled back after them.
			 */
			const change = Effect.fn("change")(function* (to: Relation) {
				const [drop, add, validate] = repointSql(domain, at.constant(to), to)
				const swapped = yield* timed(Effect.andThen(exec(drop), exec(add)))
				const validated = yield* timed(exec(validate))
				const reread = yield* timed(
					exec(setExpressionSql(derivedTable, payloadColumn, derivedExpr(at.constant(to), to)))
				)
				return { swap: swapped.ms, validate: validated.ms, reread: reread.ms }
			})
			const swaps = Arr.makeBy(options.changes, (k) => (k % 2 === 0 ? grown : triples))
			const [firstSwap, ...laterSwaps] = swaps
			const firstChange = yield* change(firstSwap)
			const afterAgainstGrown = yield* disagreeing(grown)
			const afterAgainstSet = yield* disagreeing(triples)
			const laterChanges = yield* Effect.forEach(laterSwaps, change)
			const changes = [firstChange, ...laterChanges]
			yield* session.begin
			const [dropLast, addShrunk, validateShrunk] = repointSql(domain, at.constant(shrunk), shrunk)
			yield* exec(dropLast)
			yield* exec(addShrunk)
			const shrunkAnswer = yield* answerOf(session, validateShrunk)
			yield* session.rollback
			const perMillionRows = (ms: number): number => round3((ms * 1000000) / options.rows)
			const changeCase: CaseRecord<"law-cost"> = {
				name: `a change of ${sized(triples)} over ${options.rows} rows`,
				gates: ["law-cost"],
				conditions: conditions({
					workload: `${options.rows} rows in ${domainTriples.name} and ${derivedTriples.name}; the set's domain re-pointed (DROP CONSTRAINT, then ADD CONSTRAINT NOT VALID) and VALIDATEd, and ${derivedTriples.name}'s derived column rewritten by SET EXPRESSION, ${options.changes} times between the grown set and the set`,
					parameters: { rows: options.rows, changes: options.changes },
					semantics:
						"every stored row of the domain-typed table is a member of both constants, so every VALIDATE passes, and every rewrite re-derives every row",
					cache: "one warm owner backend; each sample reads the constant its re-point installs"
				}),
				phases: {
					swapMs: summarize(Arr.map(changes, (x) => x.swap)),
					validateMs: summarize(Arr.map(changes, (x) => x.validate)),
					setExpressionMs: summarize(Arr.map(changes, (x) => x.reread))
				},
				variants: [],
				comparisons: [],
				transactions: {},
				loads: {},
				measures: {
					rows: options.rows,
					domainCellLoadMs: domainLoad.ms,
					derivedLoadMs: derivedLoad.ms,
					validateMsPerMillionRows: perMillionRows(median(Arr.map(changes, (x) => x.validate))),
					setExpressionMsPerMillionRows: perMillionRows(median(Arr.map(changes, (x) => x.reread)))
				}
			}

			const shaped = allHold(shapes)
			const refused = allHold(refusals)
			const derives = allHold(derivations)
			const ceilingChecks: ReadonlyArray<GateCheck> = Arr.flatMap(costs, ({ c, micros }) =>
				Option.toArray(
					Option.map(c.ceiling, (ceiling) =>
						mechanism(
							`${c.title} costs at most ${round3(ceiling.value)} µs per one-row INSERT beyond ${c.base.title}`,
							micros <= ceiling.value,
							`${micros} µs`
						)
					)
				)
			)
			return {
				cases: [...statementCases, ...packCases, ...firstUseCases, changeCase],
				verdicts: {
					"law-cost": {
						checks: [
							equivalence(
								"every constant PostgreSQL packs is the host encoder's string of its members",
								shaped.holds,
								shaped.detail
							),
							equivalence(
								"every law refuses the row one past its constant's end: a CHECK, a domain-typed cell and a generated cell with check_violation, an FK with foreign_key_violation",
								refused.holds,
								refused.detail
							),
							equivalence(
								"every derived column reads its relation's payload code on every stored row, and NULL one past the end",
								derives.holds,
								derives.detail
							),
							equivalence(
								"SET EXPRESSION re-derives every row: the member the grown set adds reads NULL before the rewrite and its code after it",
								beforeAgainstSet === 0 && afterAgainstGrown === 0 && afterAgainstSet === 1,
								`rows disagreeing with the set before: ${beforeAgainstSet}; after, with the grown set: ${afterAgainstGrown}, with the set: ${afterAgainstSet}`
							),
							equivalence(
								"VALIDATE against a constant that drops a stored member refuses with check_violation, naming the domain-typed table",
								shrunkAnswer.kind === "refused" &&
									shrunkAnswer.sqlstate === sqlstates.checkViolation &&
									Option.contains(shrunkAnswer.table, domainTriples.name),
								answerText(shrunkAnswer)
							),
							...ceilingChecks
						]
					}
				}
			}
		})
})
