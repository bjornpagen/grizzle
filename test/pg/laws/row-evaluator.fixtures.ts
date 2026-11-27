/**
 * The cases of row-evaluator.test.ts: a world of the NULL language (test/support/null/language.ts), rows of it each
 * with two refined values, a generated field, one to three row checks, a selection and a selection of the world's
 * closed relation Pick, drawn over the language; the schema that states them; and one case's check, the host's
 * rowEvaluator against PostgreSQL.
 */
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert, nonEmpty } from "@bjornpagen/testing/assert"
import { array, characterOf, type Gen, int, string, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec, Result } from "effect"
import { rowEvaluator } from "#adapter/public/host.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { constraintNamesOf } from "#compiler/program/laws.ts"
import { Logic } from "#compiler/public/compute.ts"
import { closedId, contract, mintOf, pg } from "#compiler/public/fields.ts"
import { closed, derived, relation, schema, type RelationName } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { query, v } from "#compiler/query/build/query.ts"
import { generatedField, generatedRelation } from "#compiler/schema/relation.ts"
import { checkBuilder, selectBuilder } from "#compiler/schema/statements.ts"
import { type Unevaluated } from "#compiler/types/schema/evaluation.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { standUpJudge } from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import {
	buildPred,
	buildTerm,
	closedOf,
	fromHost,
	fromStored,
	itemFact,
	itemFields,
	kindOf,
	storedField
} from "#test/support/null/build.ts"
import {
	evalPred,
	type Item,
	itemColumns,
	itemGen,
	itemValues,
	parseTruth,
	pickTruthSql,
	type Pred,
	predGen,
	selectedSql,
	silent,
	type Stored,
	type StoredSort,
	textSql,
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

/**
 * A case: its world, its rows, its generated field's sort and term, its row checks, the checks of its derived
 * relations, each in the rule vocabulary, its selection's predicate, and the predicate of its selection of Pick, in the
 * closed vocabulary, over Pick's row.
 */
export interface EvalCase {
	readonly world: World
	readonly rows: NonEmptyReadonlyArray<EvalRow>
	readonly generated: Stored
	readonly checks: NonEmptyReadonlyArray<Pred>
	readonly rules: NonEmptyReadonlyArray<Pred>
	readonly selection: Pred
	readonly closedSelection: Pred
}

/**
 * What a case reaches: each domain's refusal, each stored sort, a NULL generated value, and each truth of a check, of
 * the selection and of the selection of Pick.
 */
export type Feature =
	| "a row its pattern refuses"
	| "a row its contract refuses"
	| "a row both its domains refuse"
	| `a generated ${StoredSort}`
	| "a NULL generated value refused by its NOT NULL"
	| "a check holds"
	| "a check breaks at false"
	| "a check breaks at NULL"
	| "a derived check holds"
	| "a derived check breaks at false"
	| "a derived check breaks at NULL"
	| "a row every check holds of stored"
	| "a refusal naming one check of several a row breaks"
	| "a row selected"
	| "a row its selection leaves at false"
	| "a row its selection leaves at NULL"
	| "a closed row selected"
	| "a closed row its selection leaves at false"
	| "a closed row its selection leaves at NULL"

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
	"a derived check holds",
	"a derived check breaks at false",
	"a derived check breaks at NULL",
	"a row every check holds of stored",
	"a refusal naming one check of several a row breaks",
	"a row selected",
	"a row its selection leaves at false",
	"a row its selection leaves at NULL",
	"a closed row selected",
	"a closed row its selection leaves at false",
	"a closed row its selection leaves at NULL"
]

const Short = str.regex("^[a-c]{0,3}$")
const unitsKey = Symbol("Units")
const Units = contract<typeof unitsKey>()("Units", pg.integer, (x) => Logic.le(x, 5))
const toUnits = mintOf(unitsKey)

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

/**
 * A case: a world, two to six rows, a generated field of a drawn sort, one to three row checks, one to three checks of
 * derived relations, a selection and a selection of Pick.
 */
export const caseGen: Gen<EvalCase> = (s) => {
	const world = s.draw(worldGen)
	const pred = predGen(world, 2, "check")
	const rule = predGen(world, 2, "rule")
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
		rules: [s.draw(rule), ...s.draw(array(rule, { min: 0, max: 2 }))],
		selection: s.draw(pred),
		closedSelection: s.draw(predGen(world, 2, "closed"))
	}
}

/**
 * The names of a case's checks and of the relations each stands on, one slot per check, in order: names the schema's
 * type reads, so a level over it holds its relations by name (types/schema/schema.ts DeclaredOver).
 */
const slots = [
	{ name: "Holds0", each: "Each0", src: "Src0", derived: "D0" },
	{ name: "Holds1", each: "Each1", src: "Src1", derived: "D1" },
	{ name: "Holds2", each: "Each2", src: "Src2", derived: "D2" }
] as const

/**
 * The schema of a case. Its first level holds its world's closed relations; Refined, a closed relation of no row over
 * a kind and the rows' two refined fields; Gen, the rows' fields and the generated field g; All, the rows' fields under
 * every row check; for each check, EachJ under it alone, named as All's; and SrcJ, the rows' fields under none. Its
 * second level holds DJ, live, every row of SrcJ, under the case's Jth derived check, which a trigger on SrcJ holds.
 * The selection is of Gen by the case's predicate, and the closed selection of Pick by its closed one.
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
	const Refined = closed.relation(
		"Refined",
		{ kind: closedId(c.Kind), p: Short, u: Units },
		["kind"],
		[]
	)
	const holding = (pred: Pred) => (r: Readonly<Record<string, unknown>>) => buildPred(c, r, pred)
	const [s0, s1, s2] = slots
	const Each0 = relation(s0.each, fields, ["id"])
	const Each1 = relation(s1.each, fields, ["id"])
	const Each2 = relation(s2.each, fields, ["id"])
	const Src0 = relation(s0.src, fields, ["id"])
	const Src1 = relation(s1.src, fields, ["id"])
	const Src2 = relation(s2.src, fields, ["id"])
	const checks = Arr.map(
		Arr.zip(ec.checks, [
			{ slot: s0, Each: Each0 },
			{ slot: s1, Each: Each1 },
			{ slot: s2, Each: Each2 }
		] as const),
		([pred, { slot, Each }]) => ({
			pred,
			name: slot.name,
			Each,
			inAll: checkBuilder(slot.name, All, holding(pred)),
			inEach: checkBuilder(slot.name, Each, holding(pred))
		})
	)
	const level = schema(
		"RowEvaluator",
		[
			c.Kind,
			c.Flag,
			c.Pick,
			c.Wt,
			c.Succ,
			c.Next,
			c.Allowed,
			Refined,
			Gen,
			All,
			Each0,
			Each1,
			Each2,
			Src0,
			Src1,
			Src2
		],
		Arr.flatMap(checks, (check) => [check.inAll, check.inEach])
	)
	const derivedOf = <const N extends string>(
		name: RelationName<N>,
		Src: typeof Src0 | typeof Src1 | typeof Src2
	) =>
		derived(
			name,
			query(level).rule((r) => {
				const x = v(Src, "s")
				return r.match(Src, x).find(x)
			})
		)
	const D0 = derivedOf(s0.derived, Src0)
	const D1 = derivedOf(s1.derived, Src1)
	const D2 = derivedOf(s2.derived, Src2)
	const rules = Arr.map(
		Arr.zip(ec.rules, [
			{ slot: s0, Src: Src0, D: D0 },
			{ slot: s1, Src: Src1, D: D1 },
			{ slot: s2, Src: Src2, D: D2 }
		] as const),
		([pred, { slot, Src, D }]) => ({
			pred,
			name: slot.name,
			Src,
			D,
			inD: checkBuilder(slot.name, D, holding(pred))
		})
	)
	return {
		c,
		Refined,
		Gen,
		All,
		checks,
		rules,
		selected: selectBuilder(Gen, holding(ec.selection)),
		pickSelected: selectBuilder(c.Pick, holding(ec.closedSelection)),
		declared: schema.extend(
			[level],
			"RowEvaluatorDerived",
			[D0, D1, D2],
			Arr.map(rules, (j) => j.inD)
		)
	}
}

/** A case's schema and the relations and checks it states. */
type Built = ReturnType<typeof builtOf>
/** A check of a case, its relation under it alone and its statements. */
type Judged = Built["checks"][number]
/** A relation under one check alone, or under none. */
type Each = Judged["Each"] | Built["rules"][number]["Src"]

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
		p: textSql(row.p),
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
const evaluatedItem = <A>(item: Result.Result<A, Unevaluated> | undefined, what: string): A =>
	item === undefined
		? assert.fail(`the host's evaluation holds ${what}`)
		: Result.isSuccess(item)
			? item.success
			: assert.fail(`the host evaluates ${what}: ${item.failure.why}`)

/** A truth's verdict as `CHECK ((p) IS TRUE)` reads it, and its note. */
const checkNote = (truth: Truth): Feature =>
	truth === true
		? "a check holds"
		: truth === false
			? "a check breaks at false"
			: "a check breaks at NULL"

const derivedNote = (truth: Truth): Feature =>
	truth === true
		? "a derived check holds"
		: truth === false
			? "a derived check breaks at false"
			: "a derived check breaks at NULL"

const selectionNote = (truth: Truth): Feature =>
	truth === true
		? "a row selected"
		: truth === false
			? "a row its selection leaves at false"
			: "a row its selection leaves at NULL"

const closedSelectionNote = (truth: Truth): Feature =>
	truth === true
		? "a closed row selected"
		: truth === false
			? "a closed row its selection leaves at false"
			: "a closed row its selection leaves at NULL"

/**
 * The evaluation of a row of a closed relation, a roster among them, as a row of that relation, its domains admitting
 * it: no generated field and no row check, which a closed relation holds none of, and selected, as a relation keeps
 * every row, being select(C, TRUE).
 */
const closedEvaluation = Result.succeed({
	generated: {},
	checks: {},
	selected: Result.succeed(true)
})

/**
 * One case: the schema compiled by rowEvaluator and installed through its first migration; each row evaluated by the
 * host as a row of Gen, of All, of each EachJ, of each DJ, of Refined and of the selection, and written by a direct
 * writer into each relation; each row of the world's closed relations, rosters among them, evaluated as a row of its
 * relation; and each row of Pick as a row of the closed selection, held to PostgreSQL's WHERE over Pick.
 */
export const rowEvaluatorCase = (ec: EvalCase, k: Case<Feature>) =>
	Effect.gen(function* () {
		const built = builtOf(ec)
		const { Gen, All } = built
		const evaluate = succeeded(rowEvaluator(built.declared), "the case's schema compiles")
		const installed = yield* installMigrated(built.declared, {
			ambient: ordinarySession,
			label: "row_evaluator",
			extensions: []
		})
		const names = namesOf(installed)
		const substrate = yield* Substrate
		const session = yield* substrate.session({ ...ownerSession(), label: "row evaluator writer" })
		yield* standUpJudge(session, installed.installation)
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
		const constraintNameOf = constraintNamesOf(built.declared)
		const admitted: Array<readonly [number, Item]> = []
		const hostSelected: Array<string> = []
		for (const [id, row] of ec.rows.entries()) {
			const at = `row ${id}, ${Formatter.format(row)}, of ${Formatter.format(ec)}`
			const fact = { ...itemFact(built.c, row.item, id), p: row.p, u: toUnits(row.u) }
			const asGen = evaluate.admit(Gen, fact)
			const ofGen = Result.map(asGen, (admitted) => evaluate(Gen, admitted))
			const ofAll = Result.map(evaluate.admit(All, fact), (admitted) => evaluate(All, admitted))
			const ofSelection = Result.map(asGen, (admitted) => evaluate(built.selected, admitted))
			const ofRefined = Result.map(
				evaluate.admit(built.Refined, {
					kind: kindOf(row.item.kind),
					p: row.p,
					u: toUnits(row.u)
				}),
				(admitted) => evaluate(built.Refined, admitted)
			)
			const judged = Arr.map(built.checks, (check) => ({
				...check,
				of: Result.map(evaluate.admit(check.Each, fact), (admitted) =>
					evaluate(check.Each, admitted)
				)
			}))
			const ruled = Arr.map(built.rules, (rule) => ({
				...rule,
				of: Result.map(evaluate.admit(rule.D, fact), (admitted) => evaluate(rule.D, admitted))
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
					[ofRefined, "Refined"],
					...Arr.map(judged, (j) => [j.of, `Each of ${j.name}`] as const),
					...Arr.map(ruled, (j) => [j.of, j.D.name] as const)
				] as const) {
					assert.ok(
						Result.isFailure(evaluation) && fields.includes(evaluation.failure.field),
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
			if (
				Result.isFailure(asGen) ||
				Result.isFailure(ofGen) ||
				Result.isFailure(ofAll) ||
				Result.isFailure(ofSelection)
			) {
				return assert.fail(`the host admits ${at}, inside its domains`)
			}
			assert.ok(
				evaluate(built.selected, asGen.success).generated.g ===
					evaluate(Gen, asGen.success).generated.g,
				`two sources of Gen over one admitted row share the item both read, g at ${at}`
			)
			assert.ok(
				evaluate(built.selected, asGen.success).generated ===
					evaluate(Gen, asGen.success).generated,
				`two sources of Gen over one admitted row read one record of its generated values, built once for the row, at ${at}`
			)
			assert.deepEqual(
				ofRefined,
				closedEvaluation,
				`the host evaluates ${at} as a row of the closed Refined, inside its domains`
			)
			const g = evaluatedItem(ofGen.success.generated.g, `g at ${at}`)
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
			const allVerdicts = ofAll.success.checks
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
				if (Result.isFailure(check.of)) {
					return assert.fail(`the host admits ${at} as a row of Each of ${check.name}`)
				}
				const verdict = evaluatedItem(
					check.of.success.checks[check.name],
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
			for (const rule of ruled) {
				if (Result.isFailure(rule.of)) {
					return assert.fail(`the host admits ${at} as a row of ${rule.D.name}`)
				}
				const verdict = evaluatedItem(
					rule.of.success.checks[rule.name],
					`${rule.name} of ${rule.D.name} at ${at}`
				)
				const refused = yield* insert(rule.Src, id, row)
				assert.ok(
					verdict === "holds"
						? Option.isNone(refused)
						: Option.isSome(refused) &&
								refused.value.code === "23514" &&
								refused.value.constraint ===
									constraintNameOf({ kind: "check", relation: rule.D.name, name: rule.name }),
					`the host's verdict ${verdict} of ${rule.name} over ${rule.D.name} at ${at} is its rule trigger's: ${Formatter.format(refused)}`
				)
				k.note(derivedNote(evalPred(ec.world, row.item, rule.pred, silent)))
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
			if (evaluatedItem(ofSelection.success.selected, `the selection at ${at}`)) {
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
		const { c } = built
		const closedRows = [
			...Arr.map(c.Kind.handles, (id) =>
				Result.map(evaluate.admit(c.Kind, { id }), (admitted) => evaluate(c.Kind, admitted))
			),
			...Arr.map(c.Flag.handles, (id) =>
				Result.map(evaluate.admit(c.Flag, { id }), (admitted) => evaluate(c.Flag, admitted))
			),
			...Arr.map(c.Pick.rows, (row) =>
				Result.map(evaluate.admit(c.Pick, row), (admitted) => evaluate(c.Pick, admitted))
			),
			...Arr.map(c.Wt.rows, (row) =>
				Result.map(evaluate.admit(c.Wt, row), (admitted) => evaluate(c.Wt, admitted))
			),
			...Arr.map(c.Succ.rows, (row) =>
				Result.map(evaluate.admit(c.Succ, row), (admitted) => evaluate(c.Succ, admitted))
			),
			...Arr.map(c.Next.rows, (row) =>
				Result.map(evaluate.admit(c.Next, row), (admitted) => evaluate(c.Next, admitted))
			),
			...Arr.map(c.Allowed.rows, (row) =>
				Result.map(evaluate.admit(c.Allowed, row), (admitted) => evaluate(c.Allowed, admitted))
			)
		]
		for (const evaluation of closedRows) {
			assert.deepEqual(
				evaluation,
				closedEvaluation,
				`the host evaluates a row of a closed relation as a row of it, of ${Formatter.format(ec.world)}`
			)
		}
		const hostPicked = Rec.fromEntries(
			Arr.map(c.Pick.rows, (row) => {
				const evaluation = Result.map(evaluate.admit(c.Pick, row), (admitted) =>
					evaluate(built.pickSelected, admitted)
				)
				return Result.isSuccess(evaluation)
					? ([
							row.kind,
							evaluatedItem(evaluation.success.selected, `the closed selection at ${row.kind}`)
						] as const)
					: assert.fail(`the host admits Pick's row ${row.kind}: ${Formatter.format(evaluation)}`)
			})
		)
		const truths = yield* session.values(pickTruthSql(ec.world, ec.closedSelection), [])
		assert.deepEqual(
			hostPicked,
			Rec.fromEntries(
				Arr.map(truths, ([code, truth]) => {
					k.note(closedSelectionNote(parseTruth(truth)))
					return [
						kindOf(Number(textOf(code, "a Pick row's kind"))),
						parseTruth(truth) === true
					] as const
				})
			),
			`the host selects the rows of Pick PostgreSQL's WHERE keeps, of ${Formatter.format(ec)}`
		)
	})
