/**
 * The cases of row-evaluator.test.ts: a world of the NULL language (test/support/null/language.ts), rows of it each
 * with two refined values, a generated field, one to three row checks and a selection, drawn over the language; the
 * schema that states them; and one case's check, the host's rowEvaluator against PostgreSQL.
 */
import { array, characterOf, type Gen, int, string, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec } from "effect"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { Result } from "#compiler/core/result.ts"
import { contract, pg } from "#compiler/public/fields.ts"
import { relation, rowEvaluator, schema, type Unevaluated } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { generatedField, generatedRelation } from "#compiler/schema/relation.ts"
import { checkBuilder, selectBuilder } from "#compiler/schema/statements.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, nonEmpty, succeeded } from "#test/support/assert.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import {
	buildPred,
	buildTerm,
	closedOf,
	fromHost,
	fromStored,
	itemFact,
	itemFields,
	storedField
} from "#test/support/null/build.ts"
import {
	evalPred,
	type Item,
	itemColumns,
	itemGen,
	itemValues,
	type Pred,
	predGen,
	selectedSql,
	silent,
	type Stored,
	type StoredSort,
	sqlText,
	storedFieldGen,
	type Truth,
	type World,
	worldGen
} from "#test/support/null/language.ts"
import { refusalOf } from "#test/support/substrate.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A row of a case: a row of the language, and two values of refined types, each inside its domain or outside it: `p` a
 * text of the pattern ^[a-c]{0,3}$, and `u` an integer of the contract Units, u ≤ 5.
 */
export interface EvalRow {
	readonly item: Item
	readonly p: string
	readonly u: number
}

/** A case: its world, its rows, its generated field's sort and term, its row checks and its selection's predicate. */
export interface EvalCase {
	readonly world: World
	readonly rows: NonEmptyReadonlyArray<EvalRow>
	readonly generated: Stored
	readonly checks: NonEmptyReadonlyArray<Pred>
	readonly selection: Pred
}

/** What a case reaches: each domain's refusal, each stored sort, a NULL generated value, and each truth of a check and of the selection. */
export type Feature =
	| "a row its pattern refuses"
	| "a row its contract refuses"
	| "a row both its domains refuse"
	| `a generated ${StoredSort}`
	| "a NULL generated value refused by its NOT NULL"
	| "a check holds"
	| "a check breaks at false"
	| "a check breaks at NULL"
	| "a row every check holds of stored"
	| "a refusal naming one check of several a row breaks"
	| "a row selected"
	| "a row its selection leaves at false"
	| "a row its selection leaves at NULL"

/** Every situation a witness must reach. */
export const required: NonEmptyReadonlyArray<Feature> = [
	"a row its pattern refuses",
	"a row its contract refuses",
	"a row both its domains refuse",
	"a generated int",
	"a generated big",
	"a generated num",
	"a generated text",
	"a generated code",
	"a generated set",
	"a generated bool",
	"a generated f8",
	"a generated f4",
	"a NULL generated value refused by its NOT NULL",
	"a check holds",
	"a check breaks at false",
	"a check breaks at NULL",
	"a row every check holds of stored",
	"a refusal naming one check of several a row breaks",
	"a row selected",
	"a row its selection leaves at false",
	"a row its selection leaves at NULL"
]

const Short = str.regex("^[a-c]{0,3}$")
const Units = contract("Units", pg.integer, (x) => x.le(5))

const letters = (spelled: string) => characterOf(nonEmpty(Arr.fromIterable(spelled), spelled))

/** A text of Short three times in four, and otherwise any of up to four letters, a d or a fourth letter outside it. */
const pGen: Gen<string> = weighted([
	[3, string(letters("abc"), { min: 0, max: 3 })],
	[1, string(letters("abcd"), { min: 0, max: 4 })]
])

/** An integer of Units four times in five, and otherwise one above it. */
const uGen: Gen<number> = weighted([
	[4, int(-2, 5)],
	[1, int(6, 8)]
])

/** A case: a world, two to six rows, a generated field of a drawn sort, one to three row checks and a selection. */
export const caseGen: Gen<EvalCase> = (s) => {
	const world = s.draw(worldGen)
	const pred = predGen(world, 2, "check")
	const row: Gen<EvalRow> = (r) => ({
		item: r.draw(itemGen(world)),
		p: r.draw(pGen),
		u: r.draw(uGen)
	})
	return {
		world,
		rows: [s.draw(row), s.draw(row), ...s.draw(array(row, { min: 0, max: 4 }))],
		generated: s.draw(storedFieldGen(world)),
		checks: [s.draw(pred), ...s.draw(array(pred, { min: 0, max: 2 }))],
		selection: s.draw(pred)
	}
}

/** A row check's name: Holds0, Holds1, Holds2. */
const checkName = (j: number): string => `Holds${j}`

/**
 * The schema of a case: its world's closed relations; Gen, the rows' fields and the generated field g; All, the rows'
 * fields under every row check; for each check, EachJ under it alone, named as All's; and the selection of Gen by the
 * case's predicate.
 */
const builtOf = (ec: EvalCase) => {
	const c = closedOf(ec.world)
	const fields = { ...itemFields(c), p: Short, u: Units }
	const Gen = generatedRelation(
		"Gen",
		fields,
		["id"],
		(r) => ({
			g: generatedField(storedField(c, ec.generated.sort), buildTerm(c, r, ec.generated.term), [])
		}),
		[]
	)
	const All = relation("All", fields, ["id"])
	const holding = (pred: Pred) => (r: Readonly<Record<string, unknown>>) => buildPred(c, r, pred)
	const checks = Arr.map(ec.checks, (pred, j) => {
		const name = checkName(j)
		const Each = relation(`Each${j}`, fields, ["id"])
		return {
			pred,
			name,
			Each,
			inAll: checkBuilder(name, All, holding(pred)),
			inEach: checkBuilder(name, Each, holding(pred))
		}
	})
	return {
		c,
		Gen,
		All,
		checks,
		selected: selectBuilder(Gen, holding(ec.selection)),
		declared: schema(
			"RowEvaluator",
			[...Rec.values(c), Gen, All, ...Arr.map(checks, (j) => j.Each)],
			[...Arr.map(checks, (j) => j.inAll), ...Arr.map(checks, (j) => j.inEach)]
		)
	}
}

/** A case's schema and the relations and checks it states. */
type Built = ReturnType<typeof builtOf>
/** A check of a case, its relation under it alone and its statements. */
type Judged = Built["checks"][number]
/** The relation under one check alone. */
type Each = Judged["Each"]

/** The fields a row writes, in the order its values are written (rowValues). */
const written = [...itemColumns, "p", "u"] as const

/**
 * A row's values in plain SQL, as written lists its fields: its set cast to its column's type `flagsType`, bit(n) for n
 * at least the roster's codes, which pads it past them as a direct writer must.
 */
const rowValues = (w: World, id: number, row: EvalRow, flagsType: string): string => {
	const item = itemValues(w, id, row.item)
	const values = {
		...item,
		flags: `(${item.flags})::${flagsType}`,
		p: sqlText(row.p),
		u: `${row.u}`
	}
	return `(${Arr.join(
		Arr.map(written, (field) => values[field]),
		", "
	)})`
}

/** The one value a one-row, one-column read answers, or the case fails naming what it read. */
const onlyValue = (rows: ReadonlyArray<ReadonlyArray<unknown>>, what: string): unknown => {
	const [row, ...more] = rows
	return row !== undefined && more.length === 0 && row.length === 1
		? row[0]
		: assert.fail(`PostgreSQL answers ${what} in one value, not ${Formatter.format(rows)}`)
}

/** A value PostgreSQL printed as text, or the case fails naming what it read. */
const textOf = (value: unknown, what: string): string =>
	typeof value === "string"
		? value
		: assert.fail(`PostgreSQL prints ${what} as text, not ${Formatter.format(value)}`)

/**
 * An item of the host's evaluation, the value it holds; the case fails where the host had none, naming why, or where
 * its evaluation holds no such item, a check's read by a name only the run time knows.
 */
const evaluatedItem = <A>(item: Result<A, Unevaluated> | undefined, what: string): A =>
	item === undefined
		? assert.fail(`the host's evaluation holds ${what}`)
		: item.ok
			? item.value
			: assert.fail(`the host evaluates ${what}: ${item.error.why}`)

/** A truth's verdict as `CHECK ((p) IS TRUE)` reads it, and its note. */
const checkNote = (truth: Truth): Feature =>
	truth === true
		? "a check holds"
		: truth === false
			? "a check breaks at false"
			: "a check breaks at NULL"

const selectionNote = (truth: Truth): Feature =>
	truth === true
		? "a row selected"
		: truth === false
			? "a row its selection leaves at false"
			: "a row its selection leaves at NULL"

/**
 * One case: the schema compiled by rowEvaluator and installed through its first migration; each row evaluated by the
 * host as a row of Gen, of All, of each EachJ and of the selection, and written by a direct writer into each relation.
 */
export const rowEvaluatorCase = (ec: EvalCase, k: Case<Feature>) =>
	Effect.gen(function* () {
		const built = builtOf(ec)
		const { Gen, All } = built
		const evaluate = succeeded(rowEvaluator(built.declared), "the case's schema compiles")
		const installed = yield* installMigrated(built.declared, {
			ambient: ordinarySession,
			label: "row_evaluator",
			logins: [],
			extensions: []
		})
		const names = namesOf(installed)
		const substrate = yield* Substrate
		const session = yield* substrate.session({ ...ownerSession(), label: "row evaluator writer" })
		const domainOf = (domain: string) => `${quoteIdent(names.schema)}.${quoteIdent(domain)}`
		const pattern = names.textDomain(Gen, "p")
		const units = names.contract("Units")
		if (units.kind !== "checked") {
			return assert.fail("Units installs a domain whose CHECK holds its predicate")
		}
		const flagsColumn = yield* session.values(
			`SELECT pg_catalog.format_type(atttypid, atttypmod) FROM pg_catalog.pg_attribute WHERE attrelid = '${names.table(Gen)}'::regclass AND attname = '${names.columnIdent(Gen, "flags")}'`,
			[]
		)
		const flagsType = textOf(onlyValue(flagsColumn, "a set's column"), "a set's column's type")
		const insert = (relation: typeof Gen | typeof All | Each, id: number, row: EvalRow) =>
			refusalOf(
				session.query(
					`INSERT INTO ${names.table(relation)} (${Arr.join(
						Arr.map(written, (f) => names.column(relation, f)),
						", "
					)}) VALUES ${rowValues(ec.world, id, row, flagsType)}`,
					[]
				)
			)
		const checkConstraint = (statement: Judged["inAll"] | Judged["inEach"]) =>
			names.constraintOf(names.lawOf(statement), "TableCheck")
		const admitted: Array<readonly [number, Item]> = []
		const hostSelected: Array<string> = []
		for (const [id, row] of ec.rows.entries()) {
			const at = `row ${id}, ${Formatter.format(row)}, of ${Formatter.format(ec)}`
			const fact = { ...itemFact(built.c, row.item, id), p: row.p, u: Units(row.u) }
			const ofGen = evaluate(Gen, fact)
			const ofAll = evaluate(All, fact)
			const ofSelection = evaluate(built.selected, fact)
			const judged = Arr.map(built.checks, (check) => ({
				...check,
				of: evaluate(check.Each, fact)
			}))
			const domains = yield* session.values(
				`SELECT pg_input_is_valid($1::text, $2::text), pg_input_is_valid($3::text, $4::text)`,
				[row.p, domainOf(pattern.domain), `${row.u}`, domainOf(units.domain)]
			)
			const [valid] = domains
			if (valid === undefined) {
				return assert.fail(`PostgreSQL answers whether ${at} is inside its domains`)
			}
			const refusing = [
				...(valid[0] === true ? [] : [{ field: "p", constraint: pattern.constraint }]),
				...(valid[1] === true ? [] : [{ field: "u", constraint: units.constraint }])
			]
			if (Arr.isReadonlyArrayNonEmpty(refusing)) {
				const fields = Arr.map(refusing, (r) => r.field)
				for (const [evaluation, of] of [
					[ofGen, "Gen"],
					[ofAll, "All"],
					[ofSelection, "the selection"],
					...Arr.map(judged, (j) => [j.of, `Each of ${j.name}`] as const)
				] as const) {
					assert.ok(
						!evaluation.ok && fields.includes(evaluation.error.field),
						`the host refuses ${at} as a row of ${of} at a field PostgreSQL's domain refuses, ${Formatter.format(fields)}, not ${Formatter.format(evaluation)}`
					)
				}
				const refused = yield* insert(Gen, id, row)
				assert.ok(
					Option.isSome(refused) &&
						refused.value.code === "23514" &&
						Arr.some(refusing, (r) => r.constraint === refused.value.constraint),
					`PostgreSQL refuses ${at} at a domain's CHECK, not ${Formatter.format(refused)}`
				)
				k.note(
					refusing.length === 2
						? "a row both its domains refuse"
						: refusing[0].field === "p"
							? "a row its pattern refuses"
							: "a row its contract refuses"
				)
				continue
			}
			admitted.push([id, row.item])
			if (!ofGen.ok || !ofAll.ok || !ofSelection.ok) {
				return assert.fail(`the host admits ${at}, inside its domains`)
			}
			const g = evaluatedItem(ofGen.value.generated.g, `g at ${at}`)
			const stored = yield* insert(Gen, id, row)
			if (g === null) {
				assert.ok(
					Option.isSome(stored) &&
						stored.value.code === "23502" &&
						Option.getOrUndefined(stored.value.column) === names.columnIdent(Gen, "g"),
					`PostgreSQL refuses ${at} by g's NOT NULL, the host's NULL, not ${Formatter.format(stored)}`
				)
				k.note("a NULL generated value refused by its NOT NULL")
			} else {
				assert.ok(
					Option.isNone(stored),
					`PostgreSQL stores ${at} in Gen: ${Formatter.format(stored)}`
				)
				const storedG = yield* session.values(
					`SELECT ${names.column(Gen, "g")}::text FROM ${names.table(Gen)} WHERE ${names.column(Gen, "id")} = ${id}`,
					[]
				)
				const read = onlyValue(storedG, `g of ${at}`)
				assert.deepEqual(
					fromHost(ec.generated.sort, g),
					fromStored(ec.generated.sort, read),
					`the host's g at ${at} is PostgreSQL's stored value`
				)
				k.note(`a generated ${ec.generated.sort}`)
			}
			const allVerdicts = ofAll.value.checks
			assert.deepEqual(
				Arr.sort(Rec.keys(allVerdicts), Order.String),
				Arr.sort(
					Arr.map(built.checks, (j) => j.name),
					Order.String
				),
				`All's evaluation at ${at} holds a verdict of each of its checks`
			)
			const breaking: Array<string> = []
			for (const check of judged) {
				if (!check.of.ok) {
					return assert.fail(`the host admits ${at} as a row of Each of ${check.name}`)
				}
				const verdict = evaluatedItem(
					check.of.value.checks[check.name],
					`${check.name} alone at ${at}`
				)
				assert.equal(
					evaluatedItem(allVerdicts[check.name], `${check.name} of All at ${at}`),
					verdict,
					`${check.name} judges ${at} alike in All and alone`
				)
				const refused = yield* insert(check.Each, id, row)
				assert.ok(
					verdict === "holds"
						? Option.isNone(refused)
						: Option.isSome(refused) &&
								refused.value.code === "23514" &&
								refused.value.constraint === checkConstraint(check.inEach),
					`the host's verdict ${verdict} of ${check.name} at ${at} is PostgreSQL's CHECK's: ${Formatter.format(refused)}`
				)
				if (verdict === "breaks") {
					breaking.push(checkConstraint(check.inAll))
				}
				k.note(checkNote(evalPred(ec.world, row.item, check.pred, silent)))
			}
			const refusedAll = yield* insert(All, id, row)
			assert.ok(
				breaking.length === 0
					? Option.isNone(refusedAll)
					: Option.isSome(refusedAll) &&
							refusedAll.value.code === "23514" &&
							Arr.some(breaking, (c) => c === refusedAll.value.constraint),
				`PostgreSQL stores ${at} in All exactly where the host holds every check, and names one it breaks: ${Formatter.format(refusedAll)}`
			)
			if (breaking.length === 0) {
				k.note("a row every check holds of stored")
			}
			if (breaking.length > 1) {
				k.note("a refusal naming one check of several a row breaks")
			}
			if (evaluatedItem(ofSelection.value.selected, `the selection at ${at}`)) {
				hostSelected.push(`${id}`)
			}
			k.note(selectionNote(evalPred(ec.world, row.item, ec.selection, silent)))
		}
		if (Arr.isReadonlyArrayNonEmpty(admitted)) {
			const selected = yield* session.values(selectedSql(ec.world, admitted, ec.selection), [])
			assert.deepEqual(
				hostSelected,
				Arr.map(selected, (r) => textOf(r[0], "a selected row's id")),
				`the host selects the rows PostgreSQL's WHERE keeps, of ${Formatter.format(ec)}`
			)
		}
	})
