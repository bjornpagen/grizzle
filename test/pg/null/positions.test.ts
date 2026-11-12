/**
 * NULL is a value of grizzle's scalar language wherever it arises, on PostgreSQL 19rc1: a differential search over
 * drawn expressions placed in every position a rule or a query reads one.
 *
 * Each case draws a world of closed relations over two rosters, some keys held by no row (language.ts World), rows of
 * every open relation, and an expression for each position, drawn by construction over every operator family
 * (comparisons, BETWEEN, IN, AND, OR and NOT, exact and IEEE 754 arithmetic, greatest and least, casts, text, sets,
 * span endpoints, conditionals, guards and a closed relation's presence, C.has, false at a key no row holds) over
 * every sort (integers, numerics, texts, closed ids, sets, booleans and
 * both floats, NaN and the infinities among them) and every NULL source (a closed read at an absent key, at a NULL
 * key, nested). Float arithmetic stands in a query alone, as grizzle admits it nowhere else. A span is never NULL, since
 * no closed relation holds one (closed.relation refuses a span field): its endpoints meet a NULL only beside a NULL
 * operand of the node above them. The positions:
 *
 * - three row checks on Checked;
 * - a containment of a selection of Contained into the closed Allowed;
 * - a key over a selection of Keyed, each row written at every kind;
 * - three generated relations, each a generated field of a drawn type and a row check;
 * - a fold, the sum of a family's integers under a drawn selection, filled by grizzle's writer: an owner with every row
 *   nested, a stored owner a member put at a time, and a refill past a deleted member;
 * - a query's filter, an aggregate's filter, keyed and with no key, and a query's head.
 *
 * The oracle is PostgreSQL itself: each expression, written in plain SQL from its meaning alone (closed relations as
 * values, a closed read a scalar subquery), evaluated by one SELECT at every row it is judged at. The model of
 * language.ts (Kleene's logic, strict operations) agrees with it at every row, and so does grizzle's host evaluator over
 * the law model's own expressions: each row check, the containment's guard, the key's selection and each generated
 * field. Through grizzle's writer and reader:
 *
 * - a row is accepted exactly where every law of its relation holds, a check and a selection holding where they are
 *   true; a refused row names exactly the laws it breaks, every check that is false or unknown at it, and a generated
 *   field NULL at it alone, as PostgreSQL checks NOT NULL first;
 * - each stored generated value is PostgreSQL's;
 * - each owner's fold total sums the members its selection makes true;
 * - a filter returns the rows it makes true, an aggregate the groups of those rows and no row where none is, and a head
 *   delivers PostgreSQL's value, or is refused at compile when it reads a closed relation.
 *
 * Steering aims a witness at each operator family a NULL operand has not reached in a position yet: its world leaves
 * its last kind absent from Pick, and the position's expression is built around a node of that family over a read at
 * it (language.ts aimedPredGen, aimedStoredGen).
 *
 * Plants: null-greatest-null-wins (the host's greatest and least return NULL when any operand is NULL).
 *
 * Features: every operator family in every position, reached by a NULL operand.
 */
import { layer } from "@effect/vitest"
import { type Case, drawn, explore, type Kept } from "@grizzle/testing/explore"
import { type Reached, required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen } from "@grizzle/testing/gen"
import { agree, exact } from "@grizzle/testing/oracle"
import { notesOnly } from "@grizzle/testing/sense"
import { boundedShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	Predicate,
	Record as Rec,
	Result
} from "effect"
import type { ServedCalls, WrittenOutcome } from "#adapter/db/handles.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import type { ServedRefusal } from "#adapter/public/compile.ts"
import { isCompileError } from "#compiler/core/errors.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { predicateTable, type ScalarExpr } from "#compiler/ir/expr.ts"
import { compileLaws, type LawModel } from "#compiler/laws/model/model.ts"
import type { CallError } from "#compiler/live/index.ts"
import type { Law } from "#compiler/public/changeset.ts"
import {
	contained,
	fin,
	fold,
	key,
	Monoid,
	mutable,
	on,
	ordered,
	schema
} from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { closedLeaf, type ClosedRows } from "#compiler/runtime/write/fill.ts"
import { evaluateTable, type EvalLeaves } from "#compiler/scalar/compute/evaluate.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import { everySlice } from "#compiler/schema/reach.ts"
import { generatedField, generatedRelation } from "#compiler/schema/relation.ts"
import { checkBuilder, selectBuilder } from "#compiler/schema/statements.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, assertVariant, succeeded } from "#test/support/assert.ts"
import { type WriteAnswer, answered, readOnce } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	buildPred,
	buildTerm,
	type Closed,
	closedOf,
	foldRelations,
	fromDelivered,
	fromHost,
	fromStored,
	hostColumns,
	itemFact,
	itemFields,
	itemRelation,
	kindOf,
	storedField
} from "#test/support/null/build.ts"
import {
	aimedPredGen,
	aimedStoredGen,
	aimedWorld,
	answerSql,
	type Decision,
	evalPred,
	evalTerm,
	type Family,
	families,
	heldKindPred,
	type Item,
	itemGen,
	type NullIdSource,
	nullIdOf,
	nullQuotientGen,
	nullSingletonPred,
	parseAnswer,
	parseTruth,
	type Pred,
	predGen,
	readsClosed,
	silent,
	type Source,
	type Stored,
	storedFieldGen,
	sortOf,
	type Term,
	termGen,
	type Trace,
	type Truth,
	twoKindWorld,
	truthSql,
	type Val,
	type World,
	worldGen,
	worldSql
} from "#test/support/null/language.ts"
import { owning } from "#test/support/policy.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

const positions = ["check", "contained", "key", "generated", "fold", "filter", "aggregate"] as const
type Position = (typeof positions)[number]

type Verdict =
	| "a check refuses a row it leaves unknown"
	| "a check holds of a row through a NULL"
	| "a refusal names an unknown check and a false one together"
	| "a containment spares a row its selection leaves unknown outside its target"
	| "a key holds apart only its selection: an unknown row shares a selected value"
	| "a NULL generated field is refused by its NOT NULL"
	| "a NULL generated field is named alone beside a check its row breaks"
	| "a fold skips a member its selection leaves unknown"
	| "a filter drops a row it leaves unknown"
	| "an aggregate over rows its filter leaves unknown delivers no row"
	| "a head refuses a closed read"
	| "a head delivers its value"

type Feature = Family | Position | Source | Decision | Verdict

/** A generated relation's field and its row check. */
interface GeneratedSpec extends Stored {
	readonly check: Pred
}

interface NullCase {
	readonly world: World
	readonly items: NonEmptyReadonlyArray<Item>
	readonly checks: readonly [Pred, Pred, Pred]
	readonly contained: Pred
	readonly keyed: Pred
	readonly generated: readonly [GeneratedSpec, GeneratedSpec, GeneratedSpec]
	readonly fold: Pred
	readonly filter: Pred
	readonly aggregate: Pred
	readonly head: Term
}

const generatedSpecGen =
	(w: World): Gen<GeneratedSpec> =>
	(s) => ({ ...s.draw(storedFieldGen(w)), check: s.draw(predGen(w, 1, "check")) })

const caseGen: Gen<NullCase> = (s) => {
	const world = s.draw(worldGen)
	const check = predGen(world, 2, "check")
	const query = predGen(world, 2, "query")
	const item = itemGen(world)
	const spec = generatedSpecGen(world)
	return {
		world,
		items: [s.draw(item), ...s.draw(array(item, { min: 0, max: 3 }))],
		checks: [s.draw(check), s.draw(check), s.draw(check)],
		contained: s.draw(check),
		keyed: s.draw(check),
		generated: [s.draw(spec), s.draw(spec), s.draw(spec)],
		fold: s.draw(check),
		filter: s.draw(query),
		aggregate: s.draw(query),
		head: s.draw(
			termGen(
				world,
				s.draw(
					element([
						"int",
						"exact",
						"big",
						"num",
						"text",
						"code",
						"set",
						"bool",
						"f8",
						"f4"
					] as const)
				),
				2,
				"query"
			)
		)
	}
}

/** Every operator family in every position: what a NULL operand must reach. */
const pairs: ReadonlyArray<readonly [Feature, Feature]> = Arr.flatMap(positions, (position) =>
	Arr.map(families, (family) => [family, position] as const)
)

const situations: NonEmptyReadonlyArray<Reached<Feature>> = [
	"a read at an absent key",
	"a read at a NULL key",
	"NOT keeps unknown unknown",
	"OR holds over unknown",
	"AND fails over unknown",
	"a guard takes its otherwise at NULL",
	"a conditional takes its else at unknown",
	"greatest or least skips a NULL",
	"BETWEEN is false with one bound unknown",
	"IN is unknown at a NULL subject",
	"a set read at a flag completed nowhere is empty",
	"a float quotient of NULL by zero is NULL",
	"a singleton of an id read at an absent key is NULL",
	"a singleton of an id read at a NULL key is NULL",
	"a singleton of an id an operation leaves NULL is NULL",
	"a presence of a key no row holds is false",
	"a check refuses a row it leaves unknown",
	"a check holds of a row through a NULL",
	"a refusal names an unknown check and a false one together",
	"a containment spares a row its selection leaves unknown outside its target",
	"a key holds apart only its selection: an unknown row shares a selected value",
	"a NULL generated field is refused by its NOT NULL",
	"a NULL generated field is named alone beside a check its row breaks",
	"a fold skips a member its selection leaves unknown",
	"a filter drops a row it leaves unknown",
	"an aggregate over rows its filter leaves unknown delivers no row",
	"a head refuses a closed read",
	"a head delivers its value",
	...pairs
]

/**
 * The case a witness runs: under steering, for each position a NULL operand has not reached some family in yet, a
 * draw may aim it there, under the world whose last kind Pick holds no row at.
 */
const aimed = (nc: NullCase, notes: Case<Feature>): NullCase => {
	const pending = Option.getOrUndefined(notes.steering)
	if (pending === undefined || !notes.draw(boolean)) {
		return nc
	}
	const shares = pending.has(
		"a key holds apart only its selection: an unknown row shares a selected value"
	)
	const w = shares ? twoKindWorld(nc.world) : aimedWorld(nc.world)
	const missing = (position: Position): ReadonlyArray<Family> =>
		Arr.filter(families, (family) => pending.has([family, position]))
	const pred = (position: Position, drawnPred: Pred): Pred => {
		const open = missing(position)
		const [first, ...rest] = open
		return first === undefined
			? drawnPred
			: notes.draw(
					aimedPredGen(
						w,
						notes.draw(element([first, ...rest])),
						position === "filter" || position === "aggregate" ? "query" : "check"
					)
				)
	}
	const quotient = pending.has("a float quotient of NULL by zero is NULL")
	const singletons: ReadonlyArray<readonly [Decision, NullIdSource]> = [
		["a singleton of an id read at an absent key is NULL", "absent key"],
		["a singleton of an id read at a NULL key is NULL", "NULL key"],
		["a singleton of an id an operation leaves NULL is NULL", "operation"]
	]
	const [single] = Arr.filter(singletons, ([decision]) => pending.has(decision))
	const [genFirst, ...genRest] = missing("generated")
	const stored = (spec: GeneratedSpec): GeneratedSpec =>
		genFirst === undefined
			? spec
			: {
					...notes.draw(aimedStoredGen(w, notes.draw(element([genFirst, ...genRest])))),
					check: spec.check
				}
	return {
		...nc,
		world: w,
		checks: [
			pred("check", nc.checks[0]),
			pred("check", nc.checks[1]),
			single === undefined ? nc.checks[2] : nullSingletonPred(w, single[1])
		],
		contained: pred("contained", nc.contained),
		keyed: shares ? heldKindPred : pred("key", nc.keyed),
		generated: [
			stored(nc.generated[0]),
			stored(nc.generated[1]),
			single === undefined
				? nc.generated[2]
				: {
						sort: "set",
						term: { t: "singleton", a: nullIdOf(w, single[1]) },
						check: nc.generated[2].check
					}
		],
		fold: pred("fold", nc.fold),
		filter: quotient ? notes.draw(nullQuotientGen(w, ["ne"])) : pred("filter", nc.filter),
		aggregate: quotient
			? notes.draw(nullQuotientGen(w, ["lt", "gt", "ne"]))
			: pred("aggregate", nc.aggregate)
	}
}

/** The rows written into Keyed: each row at every kind, so rows its selection keeps and leaves share their integer. */
const keyedRows = (nc: NullCase): ReadonlyArray<Item> =>
	Arr.flatMap(nc.items, (item) => upTo(nc.world.kinds, (kind) => ({ ...item, kind })))

/** The schema of a case: its world, the relations each position writes, their rules, and the fold's family. */
const schemaOf = (nc: NullCase) => {
	const c = closedOf(nc.world)
	const Checked = itemRelation(c, "Checked")
	const Contained = itemRelation(c, "Contained")
	const Keyed = itemRelation(c, "Keyed")
	const Rows = itemRelation(c, "Rows")
	const { Owner, Member } = foldRelations(c)
	const genOf = <const N extends string>(name: N, spec: GeneratedSpec) =>
		generatedRelation(
			name,
			itemFields(c),
			["id"],
			(r) => ({ g: generatedField(storedField(c, spec.sort), buildTerm(c, r, spec.term), []) }),
			[]
		)
	const G0 = genOf("G0", nc.generated[0])
	const G1 = genOf("G1", nc.generated[1])
	const G2 = genOf("G2", nc.generated[2])
	const members = ordered(on(Member, "owner", "at"), fin(Owner, "members"))
	const statements = [
		checkBuilder("Holds0", Checked, (r: Readonly<Record<string, unknown>>) =>
			buildPred(c, r, nc.checks[0])
		),
		checkBuilder("Holds1", Checked, (r: Readonly<Record<string, unknown>>) =>
			buildPred(c, r, nc.checks[1])
		),
		checkBuilder("Holds2", Checked, (r: Readonly<Record<string, unknown>>) =>
			buildPred(c, r, nc.checks[2])
		),
		checkBuilder("GenHolds0", G0, (r: Readonly<Record<string, unknown>>) =>
			buildPred(c, r, nc.generated[0].check)
		),
		checkBuilder("GenHolds1", G1, (r: Readonly<Record<string, unknown>>) =>
			buildPred(c, r, nc.generated[1].check)
		),
		checkBuilder("GenHolds2", G2, (r: Readonly<Record<string, unknown>>) =>
			buildPred(c, r, nc.generated[2].check)
		),
		contained(
			on(
				selectBuilder(Contained, (r: Readonly<Record<string, unknown>>) =>
					buildPred(c, r, nc.contained)
				),
				"kind",
				"flag"
			),
			on(c.Allowed, "kind", "flag")
		),
		key(
			on(
				selectBuilder(Keyed, (r: Readonly<Record<string, unknown>>) => buildPred(c, r, nc.keyed)),
				"n"
			)
		),
		members,
		fold(
			members,
			Monoid.sum,
			on(
				selectBuilder(Member, (r: Readonly<Record<string, unknown>>) => buildPred(c, r, nc.fold)),
				"owner",
				"n",
				"before",
				"after"
			),
			on(Owner, "id", "total")
		),
		mutable(Owner)
	] as const
	return {
		c,
		Checked,
		Contained,
		Keyed,
		Rows,
		Owner,
		Member,
		gens: [G0, G1, G2] as const,
		Null: schema(
			"Null",
			[...Rec.values(c), Checked, Contained, Keyed, Rows, Owner, Member, G0, G1, G2],
			statements
		)
	}
}

/** A trace that notes, for a position, each family a NULL operand reaches, the pair of both, and what decided. */
const traceAt = (notes: Case<Feature>, position: Position): Trace => ({
	reached: (family) => {
		notes.note(family)
		notes.note(position)
		notes.pair(family, position)
	},
	source: (source) => notes.note(source),
	decided: (decision) => notes.note(decision)
})

/** Whether evaluating a predicate at a row meets a NULL anywhere in it. */
const meetsNull = (w: World, item: Item, pred: Pred): boolean => {
	let met = false
	evalPred(w, item, pred, {
		reached: () => {
			met = true
		},
		source: () => {
			met = true
		},
		decided: () => {}
	})
	return met
}

/** One expression judged at rows: a predicate's truth or a term's value. */
type Judged =
	| { readonly kind: "pred"; readonly pred: Pred; readonly position: Position }
	| { readonly kind: "term"; readonly term: Term; readonly position: Position }

/** PostgreSQL's answers to each judged expression at each row, in order, from one SELECT. */
const postgresAnswers = (
	w: World,
	rows: ReadonlyArray<readonly [number, Item]>,
	judged: NonEmptyReadonlyArray<Judged>
) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const owner = yield* s.session(ownerSession())
		const columns = Arr.map(judged, (j) =>
			j.kind === "pred" ? truthSql(w, j.pred) : answerSql(w, j.term)
		)
		const [first, ...rest] = columns
		const read = yield* owner.values(worldSql(w, rows, [first, ...rest]), [])
		return new Map(
			Arr.map(
				read,
				(row) =>
					[
						Number(row[0]),
						Arr.map(judged, (j, at): Val | Truth => {
							const text = row[at + 1]
							return j.kind === "pred" ? parseTruth(text) : parseAnswer(sortOf(j.term), text)
						})
					] as const
			)
		)
	}).pipe(Effect.scoped)

/** The host evaluator's value of a law model expression over a row: SQL's value as the model reads it. */
const hostValueOf = (closed: EvalLeaves["closed"], expr: ScalarExpr, item: Item, id: number) => {
	const table = predicateTable(expr)
	return evaluateTable(
		table.exprs,
		table.root,
		{ value: undefined, column: hostColumns(item, id), closed },
		ProgramPatterns.of(tablePatterns(table))
	)
}

/** Kleene's AND of truths. */
const conjunction = (truths: ReadonlyArray<Truth>): Truth =>
	truths.includes(false) ? false : truths.includes(null) ? null : true

/** The checks and guards the law model installs, by what each judges: each its predicate's conjuncts. */
const lawExprs = (model: LawModel): ReadonlyMap<string, ReadonlyArray<ScalarExpr>> => {
	const out = new Map<string, ReadonlyArray<ScalarExpr>>()
	for (const native of model.natives) {
		const object = native.object
		if (object.kind === "TableCheck" && object.check.kind === "declared") {
			out.set(`${object.relation.name}.${object.check.name}`, [object.predicate])
		}
		if (object.kind === "ClosedCheck" && object.relation.name === "Contained") {
			out.set(
				"contained",
				Arr.map(object.guard, (g) => g.predicate)
			)
		}
		if (
			object.kind === "LawColumn" &&
			object.relation.name === "Keyed" &&
			object.value.kind === "generated"
		) {
			out.set("keyed", object.value.guard)
		}
	}
	return out
}

/** The generated field's expression of a generated relation, as the checked schema holds it. */
const generatedExpr = (model: LawModel, relation: string): ScalarExpr => {
	const field = Arr.findFirst(
		model.checked.relations.get(relation)?.fields ?? [],
		(f) => f.name === "g"
	)
	if (Option.isNone(field) || field.value.writing.kind !== "generated") {
		return assert.fail(`${relation} holds the generated field g`)
	}
	return field.value.writing.expr
}

/** The model's closed rows as the host's fill reads them. */
const closedRowsOf = (model: LawModel): EvalLeaves["closed"] =>
	closedLeaf(
		new Map(
			Arr.map([...model.checked.closed], ([name, c]): readonly [string, ClosedRows] => [
				name,
				{ heading: c.heading, key: c.relation.primaryFields.length, rows: c.rows }
			])
		)
	)

/** The laws an outcome names, by its relation and kind: a check by its name, a generated field as "g". */
const lawName = (law: Law): string => {
	switch (law.kind) {
		case "check":
			return `${law.relation}.${law.name}`
		case "generated":
			return `${law.relation}.${law.field}`
		case "contained":
			return `${law.from.relation} contained`
		case "key":
			return `${law.side.relation} key`
		case "primaryKey":
			return `${law.relation} primary key`
		case "coverage":
		case "family":
		case "tree":
		case "above":
		case "fold":
		case "contract":
		case "pattern":
			return law.kind
	}
}

/**
 * Holds a write's outcome to the laws it breaks: accepted where it breaks none, and otherwise refused naming exactly
 * those laws, every one the row breaks, never a defect.
 */
/** A change member of array members, applied with the call's facts. */
const appliedFacts = (change: ServedCalls, facts: unknown) => {
	assertVariant(change, "shape", "write", "a write's change member takes its call's facts")
	return answered(change.once({ params: {}, facts }))
}

/**
 * What the head's member read: refused where the served file is compiled, its head reading a closed relation, or its
 * rows or the read's failure.
 */
type Head =
	| { readonly kind: "refused"; readonly refusal: ServedRefusal | OpenError }
	| { readonly kind: "read"; readonly rows: Result.Result<ReadonlyArray<unknown>, CallError> }

const verdict = (
	applied: Result.Result<WriteAnswer<WrittenOutcome>, unknown>,
	broken: ReadonlyArray<string>,
	where: string
): void => {
	if (!Result.isSuccess(applied)) {
		return assert.fail(
			`${where}: the write is an outcome, not ${Formatter.format(applied.failure)}`
		)
	}
	const outcome = applied.success
	if (broken.length === 0) {
		return assert.equal(outcome.kind, "accepted", `${where} breaks no law`)
	}
	if (outcome.kind !== "refused") {
		return assert.fail(`${where} breaks ${Arr.join(broken, ", ")}, so refused, not ${outcome.kind}`)
	}
	const named: ReadonlyArray<string> = Arr.sort(
		Arr.map(refusedLaws(outcome.refused), lawName),
		Order.String
	)
	assert.deepEqual(
		{ kind: outcome.refused.kind, laws: named },
		{ kind: "every", laws: Arr.sort(broken, Order.String) },
		`${where} is refused naming every law it breaks`
	)
}

const nullCase = (drawnCase: NullCase, notes: Case<Feature>) =>
	Effect.gen(function* () {
		const nc = aimed(drawnCase, notes)
		const w = nc.world
		const built = schemaOf(nc)
		const c: Closed = built.c
		const keyed = keyedRows(nc)
		const itemRows = Arr.map(nc.items, (item, id) => [id, item] as const)
		const keyedIds = Arr.map(keyed, (item, at) => [100 + at, item] as const)
		const judged: NonEmptyReadonlyArray<Judged> = [
			{ kind: "pred", pred: nc.checks[0], position: "check" },
			{ kind: "pred", pred: nc.checks[1], position: "check" },
			{ kind: "pred", pred: nc.checks[2], position: "check" },
			{ kind: "pred", pred: nc.contained, position: "contained" },
			{ kind: "pred", pred: nc.keyed, position: "key" },
			{ kind: "term", term: nc.generated[0].term, position: "generated" },
			{ kind: "term", term: nc.generated[1].term, position: "generated" },
			{ kind: "term", term: nc.generated[2].term, position: "generated" },
			{ kind: "pred", pred: nc.generated[0].check, position: "check" },
			{ kind: "pred", pred: nc.generated[1].check, position: "check" },
			{ kind: "pred", pred: nc.generated[2].check, position: "check" },
			{ kind: "pred", pred: nc.fold, position: "fold" },
			{ kind: "pred", pred: nc.filter, position: "filter" },
			{ kind: "pred", pred: nc.aggregate, position: "aggregate" },
			{ kind: "term", term: nc.head, position: "filter" }
		]
		const answers = yield* postgresAnswers(w, [...itemRows, ...keyedIds], judged)
		const answer = (id: number, at: number): Val | Truth => {
			const row = answers.get(id)
			if (row === undefined || at >= row.length) {
				return assert.fail(`PostgreSQL answered row ${id}'s expression ${at}`)
			}
			return row[at] ?? null
		}
		const truthAt = (id: number, at: number): Truth => {
			const value = answer(id, at)
			return typeof value === "boolean" || value === null
				? value
				: assert.fail(`expression ${at} at row ${id} is a truth`)
		}
		for (const [at, j] of judged.entries()) {
			const rows = j.position === "key" ? keyedIds : itemRows
			for (const [id, item] of rows) {
				const counted = at === judged.length - 1 ? silent : traceAt(notes, j.position)
				const model =
					j.kind === "pred"
						? evalPred(w, item, j.pred, counted)
						: evalTerm(w, item, j.term, counted)
				yield* agree<Val | Truth>(
					[
						[`PostgreSQL, expression ${at} at row ${id}`, answer(id, at)],
						["the model of language.ts", model]
					],
					exact
				)
			}
		}
		const owned = owning(built.Null)
		const model = succeeded(
			compileLaws(owned, everySlice(owned), { kind: "planned" }),
			"the case's schema compiles its laws"
		)
		const closed = closedRowsOf(model)
		const exprs = lawExprs(model)
		const judgedBy = (name: string): ReadonlyArray<ScalarExpr> => {
			const found = exprs.get(name)
			return found ?? assert.fail(`the law model installs ${name}`)
		}
		const hostTruth = (
			conjuncts: ReadonlyArray<ScalarExpr>,
			item: Item,
			id: number
		): Truth | string => {
			const truths: Array<Truth> = []
			for (const expr of conjuncts) {
				const value = hostValueOf(closed, expr, item, id)
				if (!value.ok) {
					return `no value: ${Formatter.format(value.error)}`
				}
				const v = fromHost("bool", value.value)
				if (typeof v !== "boolean" && v !== null) {
					return `a value no truth is: ${String(v)}`
				}
				truths.push(v)
			}
			return conjunction(truths)
		}
		const hostAgrees = (
			name: string,
			conjuncts: ReadonlyArray<ScalarExpr>,
			at: number,
			rows: ReadonlyArray<readonly [number, Item]>
		) =>
			Effect.forEach(rows, ([id, item]) =>
				agree<Val | Truth | string>(
					[
						[`PostgreSQL, ${name} at row ${id}`, answer(id, at)],
						["grizzle's host evaluator", hostTruth(conjuncts, item, id)]
					],
					exact
				)
			)
		yield* hostAgrees("Checked.Holds0", judgedBy("Checked.Holds0"), 0, itemRows)
		yield* hostAgrees("Checked.Holds1", judgedBy("Checked.Holds1"), 1, itemRows)
		yield* hostAgrees("Checked.Holds2", judgedBy("Checked.Holds2"), 2, itemRows)
		yield* hostAgrees("Contained's guard", judgedBy("contained"), 3, itemRows)
		yield* hostAgrees("Keyed's selection", judgedBy("keyed"), 4, keyedIds)
		for (const g of [0, 1, 2] as const) {
			yield* hostAgrees(`G${g}.GenHolds${g}`, judgedBy(`G${g}.GenHolds${g}`), 8 + g, itemRows)
			const expr = generatedExpr(model, `G${g}`)
			const sort = sortOf(nc.generated[g].term)
			yield* Effect.forEach(itemRows, ([id, item]) => {
				const value = hostValueOf(closed, expr, item, id)
				return agree<Val | Truth | string>(
					[
						[`PostgreSQL, G${g}.g at row ${id}`, answer(id, 5 + g)],
						[
							"grizzle's host evaluator",
							value.ok ? fromHost(sort, value.value) : `no value: ${Formatter.format(value.error)}`
						]
					],
					exact
				)
			})
		}
		const o = yield* installed(built.Null, {}, { label: "null", programs: {} })
		const names = namesOf(o.installed)
		const where = (relation: string, id: number) =>
			`${relation} row ${id} of ${Formatter.format(nc)}`
		const delivered = yield* withServedDb(o.installed, o.server.roles.app, {}, ({ serve }) =>
			Effect.gen(function* () {
				/** Every write of the case, a change member of the relation and the op it writes, its facts each call's own. */
				const writes = yield* serve({
					insertChecked: changeSetOver.empty(o.schema).insert(built.Checked, []),
					insertContained: changeSetOver.empty(o.schema).insert(built.Contained, []),
					insertKeyed: changeSetOver.empty(o.schema).insert(built.Keyed, []),
					insertG0: changeSetOver.empty(o.schema).insert(built.gens[0], []),
					insertG1: changeSetOver.empty(o.schema).insert(built.gens[1], []),
					insertG2: changeSetOver.empty(o.schema).insert(built.gens[2], []),
					insertOwner: changeSetOver.empty(o.schema).insert(built.Owner, []),
					putMember: changeSetOver.empty(o.schema).put(built.Member, []),
					deleteMember: changeSetOver.empty(o.schema).delete(built.Member, []),
					insertRows: changeSetOver.empty(o.schema).insert(built.Rows, [])
				})
				/** One write of `facts` into the relation `relation` by `op`, held to the laws it breaks (verdict). */
				const judge = (
					relation: string,
					facts: ReadonlyArray<unknown>,
					op: "insert" | "put" | "delete",
					broken: ReadonlyArray<string>,
					at: string
				) =>
					Effect.map(
						Effect.result(
							appliedFacts(member(writes, `${op}${relation}`), { [op]: { [relation]: facts } })
						),
						(applied) => verdict(applied, broken, at)
					)
				for (const [id, item] of itemRows) {
					const broken = Arr.flatMap([0, 1, 2] as const, (j) =>
						truthAt(id, j) === true ? [] : [`Checked.Holds${j}`]
					)
					yield* judge("Checked", [itemFact(c, item, id)], "insert", broken, where("Checked", id))
					const truths = Arr.map([0, 1, 2] as const, (j) => truthAt(id, j))
					if (truths.includes(null) && broken.length > 0) {
						notes.note("a check refuses a row it leaves unknown")
					}
					if (truths.includes(null) && truths.includes(false)) {
						notes.note("a refusal names an unknown check and a false one together")
					}
					if (
						Arr.some(
							[0, 1, 2] as const,
							(j) => truthAt(id, j) === true && meetsNull(w, item, nc.checks[j])
						)
					) {
						notes.note("a check holds of a row through a NULL")
					}
				}
				for (const [id, item] of itemRows) {
					const t = truthAt(id, 3)
					const inside = w.allowed[item.kind]?.includes(item.flag) === true
					yield* judge(
						"Contained",
						[itemFact(c, item, id)],
						"insert",
						t === true && !inside ? ["Contained contained"] : [],
						where("Contained", id)
					)
					if (t === null && !inside) {
						notes.note("a containment spares a row its selection leaves unknown outside its target")
					}
				}
				const selected: Array<number> = []
				const unknown: Array<number> = []
				for (const [id, item] of keyedIds) {
					const t = truthAt(id, 4)
					const taken = selected.includes(item.n)
					yield* judge(
						"Keyed",
						[itemFact(c, item, id)],
						"insert",
						t === true && taken ? ["Keyed key"] : [],
						where("Keyed", id)
					)
					if (t === true && !taken) {
						selected.push(item.n)
					}
					if (t === null) {
						unknown.push(item.n)
					}
				}
				if (Arr.some(unknown, (n) => selected.includes(n))) {
					notes.note("a key holds apart only its selection: an unknown row shares a selected value")
				}
				for (const g of [0, 1, 2] as const) {
					for (const [id, item] of itemRows) {
						const value = answer(id, 5 + g)
						const holds = truthAt(id, 8 + g)
						yield* judge(
							`G${g}`,
							[itemFact(c, item, id)],
							"insert",
							value === null ? [`G${g}.g`] : holds === true ? [] : [`G${g}.GenHolds${g}`],
							where(`G${g}`, id)
						)
						if (value === null) {
							notes.note("a NULL generated field is refused by its NOT NULL")
							if (holds !== true) {
								notes.note("a NULL generated field is named alone beside a check its row breaks")
							}
						}
					}
				}
				const memberFact = (item: Item, id: number, owner: number) => ({
					...itemFact(c, item, id),
					owner
				})
				yield* judge(
					"Owner",
					[{ id: 0, members: Arr.map(nc.items, (item, id) => itemFact(c, item, id)) }],
					"insert",
					[],
					where("Owner", 0)
				)
				yield* judge("Owner", [{ id: 1, members: [] }], "insert", [], where("Owner", 1))
				for (const [i, item] of nc.items.entries()) {
					yield* judge(
						"Member",
						[memberFact(item, 100 + i, 1)],
						"put",
						[],
						where("Member", 100 + i)
					)
				}
				yield* judge("Member", [memberFact(nc.items[0], 0, 0)], "delete", [], where("Member", 0))
				if (Arr.some(itemRows, ([id, item]) => item.n !== 0 && truthAt(id, 11) === null)) {
					notes.note("a fold skips a member its selection leaves unknown")
				}
				yield* judge(
					"Rows",
					Arr.map(itemRows, ([id, item]) => itemFact(c, item, id)),
					"insert",
					[],
					where("Rows", 0)
				)
				const rule = (find: (r: RuleValue, x: Readonly<Record<string, unknown>>) => unknown) =>
					queryOver(o.schema).rule((r: RuleValue) => {
						const x = varsOver(built.Rows, "row")
						return find(r, x)
					})
				const reads = yield* serve({
					filtered: rule((r, x) =>
						r
							.match(built.Rows, x)
							.where(buildPred(c, x, nc.filter))
							.find({ id: x["id"] })
					),
					grouped: rule((r, x) =>
						r
							.match(built.Rows, x)
							.where(buildPred(c, x, nc.aggregate))
							.find({ kind: x["kind"], total: r.sum(x["n"]), count: r.count() })
					),
					whole: rule((r, x) =>
						r
							.match(built.Rows, x)
							.where(buildPred(c, x, nc.aggregate))
							.find({ total: r.sum(x["n"]) })
					)
				})
				const collect = (served: ReadonlyMap<string, ServedCalls>, name: string) =>
					readOnce(member(served, name))({ params: {}, facts: {} })
				const filtered = yield* collect(reads, "filtered")
				const grouped = yield* collect(reads, "grouped")
				const whole = yield* collect(reads, "whole")
				/** The head's member, which the compile of the served file refuses where its head reads a closed relation. */
				const headServed = yield* Effect.result(
					serve({
						head: rule((r, x) =>
							r.match(built.Rows, x).find({ id: x["id"], g: buildTerm(c, x, nc.head) })
						)
					})
				)
				const head: Head = Result.isFailure(headServed)
					? { kind: "refused", refusal: headServed.failure }
					: { kind: "read", rows: yield* Effect.result(collect(headServed.success, "head")) }
				return { filtered, grouped, whole, head }
			})
		)
		const field = (row: unknown, name: "id" | "g" | "kind" | "total" | "count"): unknown =>
			Predicate.hasProperty(row, name) ? row[name] : undefined
		const filterTrue = Arr.filter(itemRows, ([id]) => truthAt(id, 12) === true)
		assert.deepEqual(
			Arr.sort(
				Arr.map(delivered.filtered, (row) => Number(field(row, "id"))),
				Order.Number
			),
			Arr.map(filterTrue, ([id]) => id),
			`the filter returns the rows it makes true: ${Formatter.format(nc)}`
		)
		if (Arr.some(itemRows, ([id]) => truthAt(id, 12) === null)) {
			notes.note("a filter drops a row it leaves unknown")
		}
		const aggregated = Arr.filter(itemRows, ([id]) => truthAt(id, 13) === true)
		const byKind = Arr.groupBy(aggregated, ([, item]) => kindOf(item.kind))
		assert.deepEqual(
			Arr.sort(
				Arr.map(
					delivered.grouped,
					(row) =>
						`${String(field(row, "kind"))} ${String(field(row, "total"))} ${String(field(row, "count"))}`
				),
				Order.String
			),
			Arr.sort(
				Arr.map(
					Rec.toEntries(byKind),
					([kind, rows]) =>
						`${kind} ${Arr.reduce(rows, 0n, (sum, [, item]) => sum + BigInt(item.n))} ${rows.length}`
				),
				Order.String
			),
			`the keyed aggregate holds a group of each kind its filter makes true, none other: ${Formatter.format(nc)}`
		)
		assert.deepEqual(
			Arr.map(delivered.whole, (row) => String(field(row, "total"))),
			aggregated.length === 0
				? []
				: [String(Arr.reduce(aggregated, 0n, (sum, [, item]) => sum + BigInt(item.n)))],
			`the aggregate with no key delivers one row where its filter makes one true, none otherwise: ${Formatter.format(nc)}`
		)
		if (aggregated.length === 0 && Arr.some(itemRows, ([id]) => truthAt(id, 13) === null)) {
			notes.note("an aggregate over rows its filter leaves unknown delivers no row")
		}
		const headSort = sortOf(nc.head)
		if (readsClosed(nc.head)) {
			const head = delivered.head
			assert.ok(
				head.kind === "refused" &&
					!(head.refusal instanceof OpenError) &&
					isCompileError(head.refusal.error) &&
					head.refusal.error.reason._tag === "UnsupportedOperation",
				`a head that reads a closed relation is refused where its member is compiled, not ${Formatter.format(head)}: ${Formatter.format(nc)}`
			)
			notes.note("a head refuses a closed read")
		} else {
			const head = delivered.head
			if (head.kind !== "read" || !Result.isSuccess(head.rows)) {
				return assert.fail(
					`a head that reads no closed relation delivers, not ${Formatter.format(head)}: ${Formatter.format(nc)}`
				)
			}
			const rows = Arr.sort(
				Arr.map(
					head.rows.success,
					(row) => [Number(field(row, "id")), fromDelivered(headSort, field(row, "g"))] as const
				),
				Order.mapInput(Order.Number, ([id]: readonly [number, Val | null]) => id)
			)
			yield* agree<ReadonlyArray<readonly [number, Val | Truth | null]>>(
				[
					[
						"PostgreSQL's head",
						Arr.map(itemRows, ([id]) => [id, answer(id, judged.length - 1)] as const)
					],
					["grizzle's head", rows]
				],
				exact
			)
			notes.note("a head delivers its value")
		}
		const s = yield* Substrate
		const owner = yield* s.session(ownerSession())
		for (const g of [0, 1, 2] as const) {
			const relation = built.gens[g]
			const stored = yield* owner.values(
				`SELECT ${names.column(relation, "id")}::text, ${names.column(relation, "g")}::text FROM ${names.table(relation)} ORDER BY ${names.column(relation, "id")}`,
				[]
			)
			const expected = Arr.flatMap(itemRows, ([id]) => {
				const value = answer(id, 5 + g)
				return value === null || truthAt(id, 8 + g) !== true ? [] : [[id, value] as const]
			})
			yield* agree<ReadonlyArray<readonly [number, Val | Truth | null]>>(
				[
					[`PostgreSQL's plain SELECT of G${g}.g`, expected],
					[
						`G${g}'s stored values`,
						Arr.map(
							stored,
							(row) => [Number(row[0]), fromStored(nc.generated[g].sort, row[1])] as const
						)
					]
				],
				exact
			)
		}
		const totals = yield* owner.values(
			`SELECT ${names.column(built.Owner, "id")}::text, ${names.column(built.Owner, "total")}::text FROM ${names.table(built.Owner)} ORDER BY ${names.column(built.Owner, "id")}`,
			[]
		)
		const sumOf = (rows: ReadonlyArray<readonly [number, Item]>): string =>
			String(
				Arr.reduce(rows, 0, (sum, [id, item]) => (truthAt(id, 11) === true ? sum + item.n : sum))
			)
		assert.deepEqual(
			Arr.map(totals, (row) => `${String(row[0])} ${String(row[1])}`),
			[`0 ${sumOf(itemRows.slice(1))}`, `1 ${sumOf(itemRows)}`],
			`each owner's total sums the members its selection makes true, none it leaves unknown: ${Formatter.format(nc)}`
		)
	}).pipe(Effect.scoped)

/** Kind {k0, k1} and Flag {f0, f1}: Pick holds k0 alone, so every read at a row of kind k1 is NULL. */
const keptWorld: World = {
	kinds: 2,
	flags: 2,
	pick: [{ flag: 0, n: 1, d: 5, t: "a", b: true, x: 0.5, y: 0.5 }, undefined],
	weight: [undefined, 1],
	succ: [1, undefined],
	next: [[1], []],
	allowed: [[0], []]
}

/** A row of kind k1, where Pick holds no row, outside Allowed. */
const keptItem: Item = {
	kind: 1,
	flag: 0,
	flags: [],
	n: 2,
	m: 0,
	d: 0,
	t: "",
	b: false,
	x: 0,
	y: 0,
	s: [0, 1]
}

const nOf: Term = { t: "field", field: "n" }
const atN: Term = { t: "at", field: "n", key: { k: "own" } }
const holds: Pred = { p: "cmp", op: "eq", a: nOf, b: nOf }
const fails: Pred = { p: "cmp", op: "ne", a: nOf, b: nOf }
const unknownAtN: Pred = { p: "cmp", op: "eq", a: atN, b: nOf }
const plain: GeneratedSpec = { sort: "int", term: nOf, check: holds }
const concatNe: Pred = {
	p: "cmp",
	op: "ne",
	a: {
		t: "concat",
		a: { t: "at", field: "t", key: { k: "own" } },
		b: { t: "lit", literal: { sort: "text", value: "b" } }
	},
	b: { t: "field", field: "t" }
}

/** A case of the kept world whose every position holds, but the positions `over` states. */
const keptCase = (over: Partial<NullCase>): NullCase => ({
	world: keptWorld,
	items: [keptItem],
	checks: [holds, holds, holds],
	contained: holds,
	keyed: holds,
	generated: [plain, plain, plain],
	fold: holds,
	filter: holds,
	aggregate: holds,
	head: nOf,
	...over
})

const keptCases = [
	{
		note: "a domain that refused NULL: a check or(eq(n, n), eq(subset(Next.row(Pick.at(flag, kind)), flags), true)) holds of a row of kind k1, and a generated set Next.row(Pick.at(flag, kind)) is refused by its NOT NULL, never by the set's domain",
		sketch: keptCase({
			checks: [
				{
					p: "or",
					args: [
						holds,
						{
							p: "cmp",
							op: "eq",
							a: {
								t: "settest",
								op: "subset",
								a: { t: "row", flag: { t: "at", field: "flag", key: { k: "own" } } },
								b: { t: "field", field: "flags" }
							},
							b: { t: "lit", literal: { sort: "bool", value: true } }
						}
					]
				},
				holds,
				holds
			],
			generated: [
				{
					sort: "set",
					term: { t: "row", flag: { t: "at", field: "flag", key: { k: "own" } } },
					check: holds
				},
				plain,
				plain
			]
		}),
		draws: "",
		reaches: [
			"a check holds of a row through a NULL",
			"a NULL generated field is refused by its NOT NULL"
		]
	},
	{
		note: "a containment NOT φ OR member: a row outside Allowed whose selection eq(Pick.at(n, kind), n) is unknown is accepted",
		sketch: keptCase({ contained: unknownAtN }),
		draws: "",
		reaches: ["a containment spares a row its selection leaves unknown outside its target"]
	},
	{
		note: "a host evaluator that read NULL as unsupported, and a fold CHECK of two-valued logic: a member whose selection eq(Pick.at(n, kind), n) is unknown is filled, skipped, with its owner, into a stored owner and by a refill",
		sketch: keptCase({ fold: unknownAtN }),
		draws: "",
		reaches: ["a fold skips a member its selection leaves unknown"]
	},
	{
		note: "a witness that judged NULL by heuristics: a row whose first check is unknown, second false and third true is refused naming the first two",
		sketch: keptCase({ checks: [unknownAtN, fails, holds] }),
		draws: "",
		reaches: [
			"a check refuses a row it leaves unknown",
			"a refusal names an unknown check and a false one together"
		]
	},
	{
		note: "a generated field NULL at a row judged against its table's CHECKs: Pick.at(n, kind) at k1 beside a false check is refused naming the generated field alone",
		sketch: keptCase({ generated: [{ sort: "int", term: atN, check: fails }, plain, plain] }),
		draws: "",
		reaches: ["a NULL generated field is named alone beside a check its row breaks"]
	},
	{
		note: 'a comparison over a concatenation decided by lengths, a prefix and a suffix: ne(concat(Pick.at(t, kind), "b"), t) is unknown at k1 for t empty, so the row check refuses the row and the containment\'s selection leaves it out',
		sketch: keptCase({ checks: [concatNe, holds, holds], contained: concatNe }),
		draws: "",
		reaches: [
			"a check refuses a row it leaves unknown",
			"a containment spares a row its selection leaves unknown outside its target"
		]
	},
	{
		note: 'a generated field comparing texts that read no row field: cond(eq(Pick.at(t, k1), "a"), n, m), a constant comparison in a generation expression, installs and takes its else where Pick holds no row at k1',
		sketch: keptCase({
			generated: [
				{
					sort: "int",
					term: {
						t: "cond",
						p: {
							p: "cmp",
							op: "eq",
							a: { t: "at", field: "t", key: { k: "handle", code: 1 } },
							b: { t: "lit", literal: { sort: "text", value: "a" } }
						},
						a: nOf,
						b: { t: "field", field: "m" }
					},
					check: holds
				},
				plain,
				plain
			]
		}),
		draws: "",
		reaches: ["a conditional takes its else at unknown"]
	},
	{
		note: "a closed read with no bound: a generated integer narrowing mul(n, Pick.at(n, kind)) under Compute.within and a generated bigint casting add(n, Pick.at(n, kind)) compile, the first taking its otherwise at k1 and the second refused by its NOT NULL",
		sketch: keptCase({
			generated: [
				{
					sort: "int",
					term: {
						t: "narrow",
						e: { t: "arith", op: "mul", a: nOf, b: atN },
						o: { t: "field", field: "m" }
					},
					check: holds
				},
				{
					sort: "big",
					term: { t: "widen", e: { t: "arith", op: "add", a: nOf, b: atN } },
					check: holds
				},
				plain
			]
		}),
		draws: "",
		reaches: [
			"a guard takes its otherwise at NULL",
			"a NULL generated field is refused by its NOT NULL"
		]
	}
] as const satisfies ReadonlyArray<Kept<NullCase, Feature>>

layer(Substrate.layer, { excludeTestServices: true })("NULL in every position", (it) => {
	it.effect(
		"is judged by PostgreSQL's three-valued logic in every rule and query, by the host evaluator and the writer alike",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/null/positions",
						draw: drawn(caseGen),
						literal: Formatter.format,
						oracle: {
							kind: "postgresql",
							name: "each expression written in plain SQL from its meaning alone and evaluated by one SELECT at every row it is judged at, with the model of language.ts agreeing; grizzle's host evaluator, writer and reader held to its values"
						},
						coverage: required<Feature>(situations, { cases: 48, sense: notesOnly }),
						kept: keptCases,
						runs: 24,
						shrink: boundedShrink(40),
						concurrency: 1,
						steerEvery: 4,
						caseHang
					},
					nullCase
				)
			)
	)
})
