/** What sealed.test.ts reads: its sealed schema and its unsealed twin, their templates, its space, and each case's run. */

import { defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Formatter, Option } from "effect"
import { lawsOfConstraint } from "#compiler/ir/products.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query } from "#compiler/public/query.ts"
import { login, relation, role, schema, sealed, unit } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Generated, generatedTemplate, type Installed } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { attempt } from "#test/support/substrate.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import type { SubstrateTemplate } from "#test/support/substrate/substrate.ts"

/** A sheet, keyed by the unit's key alone. */
const Sheet = relation("Sheet", { sheet: pg.integer, label: pg.integer }, ["sheet"])
/** A sheet's cover, keyed by the unit's key alone too. */
const Cover = relation("Cover", { sheet: pg.integer, color: pg.integer }, ["sheet"])
/** A sheet's cells, each at a place. */
const Cell = relation("Cell", { sheet: pg.integer, place: pg.integer, amount: pg.integer }, [
	"sheet",
	"place"
])
/** A sheet's notes, each at a line. */
const Note = relation("Note", { sheet: pg.integer, line: pg.integer }, ["sheet", "line"])

/**
 * A schema over Sheet, Cover, Cell and Note under the unit Sheet, sealed or not, with its login: the role `writer`,
 * which inserts into the four, its one program `found` putting a sheet whole, a row of each, as an application founds
 * a unit in one write. Certification runs the writer READ COMMITTED, a closed relation's every write an insert under
 * its unit's borrow, so no table takes the SERIALIZABLE guard and a direct writer writes at either level.
 */
const sheetsShape = (name: string, sealedUnit: boolean) => {
	const relations = { Sheet, Cover, Cell, Note } as const
	const declared = unit("Sheet", { sheet: pg.integer })
	const base = schema(name, [Sheet, Cover, Cell, Note], [sealedUnit ? sealed(declared) : declared])
	const writer = role(base, "writer", relations, { insert: ["Sheet", "Cover", "Cell", "Note"] })
	const mine = writer.relations
	const found = ChangeSet.empty(writer)
		.insert(
			mine.Sheet,
			query(writer).rule((r) =>
				r.find({ sheet: r.param("sheet", pg.integer), label: r.param("value", pg.integer) })
			)
		)
		.insert(
			mine.Cover,
			query(writer).rule((r) =>
				r.find({ sheet: r.param("sheet", pg.integer), color: r.param("value", pg.integer) })
			)
		)
		.insert(
			mine.Cell,
			query(writer).rule((r) =>
				r.find({
					sheet: r.param("sheet", pg.integer),
					place: r.param("value", pg.integer),
					amount: r.param("value", pg.integer)
				})
			)
		)
		.insert(
			mine.Note,
			query(writer).rule((r) =>
				r.find({ sheet: r.param("sheet", pg.integer), line: r.param("value", pg.integer) })
			)
		)
	return {
		schema: base,
		login: login(base, "app", [writer], { workload: [workload(writer, { found })] })
	}
}

/** A sheets shape installed as `grizzle generate` drafts and serves it, its writer at the level certification gives. */
const sheetsTemplate = (name: string, sealedUnit: boolean): SubstrateTemplate<Generated> =>
	generatedTemplate({
		declaredIn: import.meta,
		name,
		content: { sealed: sealedUnit },
		build: (schemaName) => {
			const shape = sheetsShape(schemaName, sealedUnit)
			return { schema: shape.schema, logins: [shape.login] }
		},
		ambient: ordinarySession
	})

/** The sealed unit Sheet over Sheet, Cover, Cell and Note, every one closed. */
export const sealedTemplate = sheetsTemplate("sealed sheets", true)
/** Its unsealed twin: the same relations under the unit Sheet, unsealed. */
export const openTemplate = sheetsTemplate("open sheets", false)

/** The sheets a case writes: two units. */
const sheets = [1, 2] as const
type SheetKey = (typeof sheets)[number]

/** The relations under the unit, a row of each of which a write inserts: two keyed by the unit's key alone, two wider. */
const members = ["Sheet", "Cover", "Cell", "Note"] as const
type Member = (typeof members)[number]

/** Whether a relation is keyed by the unit's key alone, so it holds one row at a sheet. */
const keyedAlone = (m: Member): boolean => m === "Sheet" || m === "Cover"

/** One row inserted: into a relation under the unit, at a sheet, a wider relation's at a place no earlier row holds. */
interface Write {
	readonly kind: "insert"
	readonly into: Member
	readonly sheet: SheetKey
}

/**
 * One step of a transaction: a row inserted; a savepoint around inserts, released or rolled back; or SET CONSTRAINTS
 * ALL IMMEDIATE, which the seal, checked at its statement, is no constraint of.
 */
export type Op =
	| Write
	| {
			readonly kind: "savepoint"
			readonly writes: ReadonlyArray<Write>
			readonly ends: "release" | "rollback"
	  }
	| { readonly kind: "immediate" }

type Level = "READ COMMITTED" | "SERIALIZABLE"

/** A transaction: the level it runs at and its steps in order. */
export interface Transaction {
	readonly level: Level
	readonly ops: ReadonlyArray<Op>
}

const levelGen = element<Level>(["READ COMMITTED", "SERIALIZABLE"])

const writeGen: Gen<Write> = (s) => ({
	kind: "insert",
	into: s.draw(element(members)),
	sheet: s.draw(element(sheets))
})

const opGen: Gen<Op> = weighted<Op>([
	[6, writeGen],
	[
		1,
		(s) => ({
			kind: "savepoint",
			writes: s.draw(array(writeGen, { min: 1, max: 3 })),
			ends: s.draw(element(["release", "rollback"] as const))
		})
	],
	[1, () => ({ kind: "immediate" })]
])

const transactionGen: Gen<Transaction> = (s) => ({
	level: s.draw(levelGen),
	ops: s.draw(array(opGen, { min: 1, max: 5 }))
})

/**
 * A case aimed at the founding and its refusal: a transaction founding a sheet by a row of each relation keyed by the
 * unit's key alone and of one wider, founded at once, inside a savepoint released or rolled back, or before SET
 * CONSTRAINTS ALL IMMEDIATE, then a later transaction's row at the sheet, into any of the four.
 */
const aimed: Gen<ReadonlyArray<Transaction>> = (s) => {
	const sheet = s.draw(element(sheets))
	const wider = s.draw(element(["Cell", "Note"] as const))
	const ends = s.draw(element(["release", "rollback"] as const))
	const founding = s.draw(
		element<ReadonlyArray<Op>>([
			[
				{ kind: "insert", into: "Sheet", sheet },
				{ kind: "insert", into: "Cover", sheet },
				{ kind: "insert", into: wider, sheet }
			],
			[
				{ kind: "savepoint", writes: [{ kind: "insert", into: wider, sheet }], ends },
				{ kind: "insert", into: "Cover", sheet },
				{ kind: "insert", into: "Sheet", sheet }
			],
			[
				{ kind: "insert", into: wider, sheet },
				{ kind: "immediate" },
				{ kind: "insert", into: "Sheet", sheet },
				{ kind: "insert", into: "Cover", sheet }
			]
		])
	)
	return [
		{ level: s.draw(levelGen), ops: founding },
		{ level: s.draw(levelGen), ops: [{ kind: "insert", into: s.draw(element(members)), sheet }] }
	]
}

/** A case: transactions run one after another, each on its own, against the sealed schema and its unsealed twin. */
export const space: Gen<ReadonlyArray<Transaction>> = weighted<ReadonlyArray<Transaction>>([
	[3, array(transactionGen, { min: 1, max: 4 })],
	[1, aimed]
])

export type SealedFeature =
	| "a founding transaction's rows committed"
	| "two rows keyed by the unit's key alone committed by their founding transaction"
	| "a row after a savepoint that founded its unit committed"
	| "a row after a savepoint that rolled its founding back committed"
	| "a row after SET CONSTRAINTS ALL IMMEDIATE committed"
	| "a row of a unit an earlier transaction founded refused"
	| "a row keyed by the unit's key alone refused in a later transaction"
	| "committed at READ COMMITTED"
	| "refused at READ COMMITTED"
	| "the unsealed twin committed a row the seal refused"

/** A statement of a transaction as the model reads it: a row inserted, or a savepoint's scope opened or closed. */
type Step = Write | { readonly kind: "savepoint" | "release" | "rollback" | "immediate" }

/** A transaction's steps, its savepoints opened and closed around their writes. */
const stepsOf = (t: Transaction): ReadonlyArray<Step> =>
	Arr.flatMap(t.ops, (op): ReadonlyArray<Step> => {
		switch (op.kind) {
			case "insert":
			case "immediate":
				return [op]
			case "savepoint":
				return [{ kind: "savepoint" }, ...op.writes, { kind: op.ends }]
		}
	})

/** A row of a relation keyed by the unit's key alone, as a member of the model's sets. */
const aloneKey = (m: Member, sheet: SheetKey): string => `${m} ${sheet}`

/** What the transactions before one left: the sheets they founded, and the rows of the relations keyed alone. */
interface Stored {
	readonly founded: ReadonlySet<SheetKey>
	readonly alone: ReadonlySet<string>
}

const nothingStored: Stored = { founded: new Set(), alone: new Set() }

/** A refusal of one statement: its index among the transaction's steps, the law that refused it and the row's relation. */
interface Refusal {
	readonly index: number
	readonly law: "seal" | "key"
	readonly into: Member
}

/**
 * What a transaction comes to, as the model reads it: the first statement refused, which the transaction's verdict
 * reports, or none; and what it leaves stored where it commits, or none where a refusal outside every savepoint rolled
 * back aborted it. A statement refused inside a savepoint the transaction rolls back is recovered from: PostgreSQL
 * answers the savepoint's later statements as an aborted transaction's, then ROLLBACK TO SAVEPOINT restores the
 * transaction, which goes on and may commit.
 */
interface Verdict {
	readonly refused: Refusal | undefined
	readonly stored: Stored | undefined
}

/** Where a transaction stands as the model walks it: the sheets it founded, and its rows of the relations keyed alone. */
interface Walk {
	readonly founded: ReadonlySet<SheetKey>
	readonly alone: ReadonlySet<string>
}

/**
 * The model: a transaction over what the transactions before it stored, on the sealed schema or its twin. A row of a
 * relation keyed by the unit's key alone at a sheet it holds a row at is refused by its key (23505); on the sealed
 * schema, a row at a sheet a committed transaction founded is refused by the seal (23503), and the first row at a sheet
 * no transaction founded founds it. Each refusal is at its statement, SET CONSTRAINTS changing nothing, and a savepoint
 * rolled back takes its rows and the foundings they made with it, a refusal inside it among them.
 */
const modelOf = (t: Transaction, stored: Stored, sealedUnit: boolean): Verdict => {
	let walk: Walk = { founded: new Set(), alone: new Set() }
	let first: Refusal | undefined = undefined
	let index = 0
	/** The refusal of `w` at statement `at` over `walk`, or the walk it leaves. */
	const inserted = (w: Write, at: number, over: Walk): Refusal | Walk => {
		const key = aloneKey(w.into, w.sheet)
		if (keyedAlone(w.into) && (stored.alone.has(key) || over.alone.has(key))) {
			return { index: at, law: "key", into: w.into }
		}
		if (sealedUnit && stored.founded.has(w.sheet)) {
			return { index: at, law: "seal", into: w.into }
		}
		return {
			founded: new Set([...over.founded, w.sheet]),
			alone: keyedAlone(w.into) ? new Set([...over.alone, key]) : over.alone
		}
	}
	for (const op of t.ops) {
		switch (op.kind) {
			case "immediate":
				index += 1
				break
			case "insert": {
				const next = inserted(op, index, walk)
				index += 1
				if ("index" in next) {
					return { refused: first ?? next, stored: undefined }
				}
				walk = next
				break
			}
			case "savepoint": {
				const saved = walk
				let failed: Refusal | undefined = undefined
				index += 1
				for (const w of op.writes) {
					if (failed === undefined) {
						const next = inserted(w, index, walk)
						if ("index" in next) {
							failed = next
						} else {
							walk = next
						}
					}
					index += 1
				}
				index += 1
				if (op.ends === "rollback") {
					walk = saved
					first = first ?? failed
				} else if (failed !== undefined) {
					return { refused: first ?? failed, stored: undefined }
				}
				break
			}
		}
	}
	return {
		refused: first,
		stored: {
			founded: new Set([...stored.founded, ...walk.founded]),
			alone: new Set([...stored.alone, ...walk.alone])
		}
	}
}

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** The tables of the four relations in an installation, as its writes name them. */
interface Tables {
	readonly Sheet: string
	readonly Cover: string
	readonly Cell: string
	readonly Note: string
}

/** The INSERT of one row, on `tables`, a wider relation's at the fresh place `place`. */
const insertOf = (tables: Tables, w: Write, place: () => number): string => {
	switch (w.into) {
		case "Sheet":
			return `INSERT INTO ${tables.Sheet} (sheet, label) VALUES (${w.sheet}, 0)`
		case "Cover":
			return `INSERT INTO ${tables.Cover} (sheet, color) VALUES (${w.sheet}, 0)`
		case "Cell":
			return `INSERT INTO ${tables.Cell} (sheet, place, amount) VALUES (${w.sheet}, ${place()}, 0)`
		case "Note":
			return `INSERT INTO ${tables.Note} (sheet, line) VALUES (${w.sheet}, ${place()})`
	}
}

/** The statements of a transaction's steps on `tables`, after its SET TRANSACTION. */
const statementsOf = (
	tables: Tables,
	t: Transaction,
	place: () => number
): ReadonlyArray<string> => [
	`SET TRANSACTION ISOLATION LEVEL ${t.level}`,
	...Arr.map(stepsOf(t), (step) => {
		switch (step.kind) {
			case "insert":
				return insertOf(tables, step, place)
			case "savepoint":
				return "SAVEPOINT founding"
			case "release":
				return "RELEASE SAVEPOINT founding"
			case "rollback":
				return "ROLLBACK TO SAVEPOINT founding"
			case "immediate":
				return "SET CONSTRAINTS ALL IMMEDIATE"
		}
	})
]

/**
 * A schedule's transactions on one installation, each held to the model (`modelOf`): committed exactly where the model
 * commits, refused at the statement it refuses at, a key's refusal under 23505 on its row's table, a seal's under 23503
 * on the table of the row it refused, naming a constraint the installation maps to Sheet's seal law. Each transaction's
 * verdict, in order.
 */
const runOn = (
	installed: Installed,
	session: RawSession,
	schedule: ReadonlyArray<Transaction>,
	sealedUnit: boolean
) =>
	Effect.gen(function* () {
		const installation = installed.installation
		const names = namesOf(installed)
		const tables: Tables = {
			Sheet: names.table(Sheet),
			Cover: names.table(Cover),
			Cell: names.table(Cell),
			Note: names.table(Note)
		}
		let next = 0
		const place = (): number => {
			next += 1
			return next
		}
		let stored = nothingStored
		const verdicts: Array<Verdict> = []
		for (const [at, t] of schedule.entries()) {
			const where = `transaction ${at} of ${Formatter.format(schedule)} on the ${sealedUnit ? "sealed" : "unsealed"} schema`
			const verdict = modelOf(t, stored, sealedUnit)
			const outcome = yield* attempt(session, statementsOf(tables, t, place))
			verdicts.push(verdict)
			stored = verdict.stored ?? stored
			const refused = verdict.refused
			if (outcome.kind === "committed") {
				if (refused !== undefined) {
					return yield* new Disagreed({
						message: `a transaction the model refuses by its ${refused.law} committed, ${where}`
					})
				}
				continue
			}
			const fields = outcome.fields
			const table = Option.getOrUndefined(fields.table)
			if (refused === undefined) {
				return yield* new Disagreed({
					message: `refused with ${fields.code} ${fields.constraint ?? "naming no constraint"} on ${table ?? "no table"}, where the model commits, ${where}`
				})
			}
			/** The model's statement, past the transaction's SET TRANSACTION. */
			const index = refused.index + 1
			if (outcome.moment.kind !== "statement" || outcome.moment.index !== index) {
				return yield* new Disagreed({
					message: `refused at ${Formatter.format(outcome.moment)}, where the model refuses at statement ${index}, ${where}`
				})
			}
			const refusedTable = installation.names.relation(refused.into).name
			const laws =
				fields.constraint === undefined
					? []
					: (lawsOfConstraint(
							installation.constraintToLaw,
							{ kind: "table", name: refusedTable },
							fields.constraint
						) ?? [])
			const stated = Arr.map(laws, (law) => installation.described.get(law))
			const agrees =
				table === refusedTable &&
				(refused.law === "key"
					? fields.code === "23505"
					: fields.code === "23503" &&
						Arr.some(stated, (d) => d?.kind === "sealed" && d.unit === "Sheet"))
			if (!agrees) {
				return yield* new Disagreed({
					message: `refused with ${fields.code} ${fields.constraint ?? "naming no constraint"} on ${table ?? "no table"}, mapped to ${Formatter.format(stated)}, where ${refused.into}'s ${refused.law} refuses, ${where}`
				})
			}
		}
		return verdicts
	})

/** Whether a transaction inserts rows of both relations keyed by the unit's key alone at one sheet, outside savepoints. */
const bothAlone = (t: Transaction): boolean =>
	Arr.some(sheets, (sheet) =>
		Arr.every(["Sheet", "Cover"] as const, (m) =>
			Arr.some(t.ops, (op) => op.kind === "insert" && op.into === m && op.sheet === sheet)
		)
	)

/** Whether a transaction inserts a row at a sheet after a savepoint, ended `ends`, that inserted a row there. */
const afterSavepoint = (t: Transaction, ends: "release" | "rollback"): boolean =>
	Arr.some(
		t.ops,
		(op, i) =>
			op.kind === "savepoint" &&
			op.ends === ends &&
			Arr.some(op.writes, (w) =>
				Arr.some(
					Arr.drop(t.ops, i + 1),
					(later) => later.kind === "insert" && later.sheet === w.sheet
				)
			)
	)

/** Whether a transaction inserts a row after SET CONSTRAINTS ALL IMMEDIATE. */
const afterImmediate = (t: Transaction): boolean =>
	Arr.some(
		t.ops,
		(op, i) =>
			op.kind === "immediate" &&
			Arr.some(
				Arr.drop(t.ops, i + 1),
				(later) => later.kind === "insert" || later.kind === "savepoint"
			)
	)

/**
 * One case: its transactions run in turn on the sealed schema and on its unsealed twin, each on its own, each held to
 * the model (`runOn`), the twin committing every row its keys admit.
 */
export const runSealed = (
	sealedInstalled: Installed,
	sealedSession: RawSession,
	openInstalled: Installed,
	openSession: RawSession,
	schedule: ReadonlyArray<Transaction>,
	c: Case<SealedFeature>
) =>
	Effect.gen(function* () {
		const sealedVerdicts = yield* runOn(sealedInstalled, sealedSession, schedule, true)
		const openVerdicts = yield* runOn(openInstalled, openSession, schedule, false)
		for (const [i, verdict] of sealedVerdicts.entries()) {
			const t = defined(schedule[i], "a verdict's transaction")
			const refused = verdict.refused
			if (refused === undefined) {
				if (Arr.some(t.ops, (op) => op.kind !== "immediate")) {
					c.note("a founding transaction's rows committed")
				}
				if (bothAlone(t)) {
					c.note("two rows keyed by the unit's key alone committed by their founding transaction")
				}
				if (afterSavepoint(t, "release")) {
					c.note("a row after a savepoint that founded its unit committed")
				}
				if (afterSavepoint(t, "rollback")) {
					c.note("a row after a savepoint that rolled its founding back committed")
				}
				if (afterImmediate(t)) {
					c.note("a row after SET CONSTRAINTS ALL IMMEDIATE committed")
				}
				if (t.level === "READ COMMITTED") {
					c.note("committed at READ COMMITTED")
				}
				continue
			}
			if (refused.law !== "seal") {
				continue
			}
			c.note("a row of a unit an earlier transaction founded refused")
			if (keyedAlone(refused.into)) {
				c.note("a row keyed by the unit's key alone refused in a later transaction")
			}
			if (t.level === "READ COMMITTED") {
				c.note("refused at READ COMMITTED")
			}
			if (openVerdicts[i]?.refused === undefined) {
				c.note("the unsealed twin committed a row the seal refused")
			}
		}
	})
