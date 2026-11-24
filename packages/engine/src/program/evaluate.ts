/**
 * rowEvaluator(schema): the host's evaluation of one row of a schema's relation, by grizzle's one evaluator of its
 * terms (scalar/compute/evaluate.ts), through the judge a refused write's witness reads its rows by
 * (runtime/write/witness.ts judgeOf), over each value's one host form, its codec's (scalar/values/identity.ts
 * CarrierHost), and its one order (identity.ts compareValues).
 *
 * A row is evaluated as a row of a source: a relation of the schema, stored, derived or closed, or a selection of one,
 * select(R, φ). A relation is its selection of every row, select(R, TRUE), so every source states one predicate, which
 * is read once, where the source is first evaluated. Its evaluation is what PostgreSQL computes of the row:
 * - each field PostgreSQL generates, its value, NULL as null, by the generation expression its column holds;
 * - each row check of the relation, check(name, R, φ), its verdict as both its discharges judge it, a NULL φ breaking
 *   it: a stored relation's CHECK, `CHECK ((φ) IS TRUE)` (the law model's native), and a derived relation's rule's
 *   violation query, `WHERE (φ) IS NOT TRUE` over the derived row (ir/desc.ts refusalCondition);
 * - whether the source selects it, its predicate's truth, NULL selecting no row, as `WHERE` reads it.
 *
 * A closed relation, a roster among them, is a source as the others are: its rows are facts of its heading, and a
 * selection of it is a side a rule reads (a containment into it selects by its fields' literals, and one between closed
 * relations by any predicate, which the migration's violation query reads). Its evaluation has no generated field and no
 * row check, since closed.relation refuses a field grizzle writes and the schema a check over facts it fixes.
 *
 * Before any of it, PostgreSQL reads each value as its column's type and holds it to its domain: a value that is none
 * of its type's, an integer that is none or past its range, a text holding NUL, a date no calendar holds, a numeric past
 * its typmod, a bytes value that is no Uint8Array, is refused by its type's input function (ValueRefused, the codec's
 * fault, as a write's fact is refused: scalar/values/identity.ts admitValue), and a value outside its type's contract or
 * pattern by its domain (DomainRefused), which a brand, unchecked, does not exclude. That is admit's, once a row
 * (`evaluate.admit(R, row)`, `admission`), every refusal of it a Result, none thrown: an admitted row is evaluated as a
 * row of any source of R with no domain judged again, over one reading of its admitted values, each column read once
 * (runtime/write/witness.ts RowReading), its relation's items computed in one pass where it is first evaluated, kept on
 * the admitted row and shared by every source of R. A row inside its domains meets every partial operation's proof, so
 * an evaluation that finds a precondition undefined is a defect of grizzle's, never an outcome.
 * An item whose expression the host does not lower or does not evaluate is Unevaluated, its place its own.
 */

import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { Result as Public } from "effect"
import { closedTableOf } from "#compiler/analysis/schema.ts"
import { typingEnv } from "#compiler/analysis/theory/theory.ts"
import { rowNode } from "#compiler/check/generated.ts"
import { checkDefinition } from "#compiler/check/index.ts"
import { CheckSession } from "#compiler/check/session.ts"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { once } from "#compiler/core/lazy.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { PublicResult } from "#compiler/core/public-result.ts"
import { type Codebook, firstCodebook } from "#compiler/ir/codes.ts"
import { connectiveExpr, type ExprDesc } from "#compiler/ir/desc.ts"
import { type ExprTable, predicateTable, storedColumn } from "#compiler/ir/expr.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import { baseOf, type Carrier, isRefined, type ScalarType } from "#compiler/ir/scalar.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { lawModel } from "#compiler/program/laws.ts"
import {
	type Evaluated,
	type FilledColumn,
	type JudgedField,
	type JudgedRow,
	type JudgedTable,
	type Judge,
	judgedGeneration,
	judgeOf,
	type RowReading
} from "#compiler/runtime/write/witness.ts"
import type { EvalStop } from "#compiler/scalar/compute/evaluate.ts"
import { exprEmitter, lowerPredicate } from "#compiler/scalar/compute/lower.ts"
import { noParams } from "#compiler/scalar/compute/typing.ts"
import { AdmittedBytes } from "#compiler/scalar/values/bytes.ts"
import {
	admitValue,
	evaluatedValue,
	type HeadingField,
	heldValue
} from "#compiler/scalar/values/identity.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { ownedDesc } from "#compiler/schema/protocol.ts"
import { namedRelation } from "#compiler/schema/relation.ts"
import type { SelectedDesc } from "#compiler/schema/statements.ts"
import type {
	AdmittedRow,
	CheckVerdict,
	DomainRefused,
	EvaluatedRow,
	RowEvaluation,
	RowEvaluator,
	RowSource,
	SourceRelation,
	Unevaluated,
	ValueRefused
} from "#compiler/types/schema/evaluation.ts"
import type { AnySchema, RelationOf } from "#compiler/types/schema/schema.ts"
import { lawChecksOf, witnessField } from "#compiler/write/program/decide.ts"

/**
 * An expression the host evaluates over a source's rows, lowered once: its table, or Unevaluated where the host's
 * lowering of a row predicate (rowPredicate) refuses it, one only a query admits, such as float arithmetic, the
 * refusal's words its `why`.
 */
type Lowered = Result.Result<ExprTable, Unevaluated>

/**
 * A relation of the schema as its sources read its rows, read once a relation (relationReadingOf): its name, its fields as
 * the judge reads them, the fields of its rows a domain holds, its generated fields and its row checks by name.
 * Every source of the relation reads the one reading, so a row admitted to it is read once over it (witness.ts
 * RowReading), however many sources evaluate the row.
 */
interface RelationReading extends Admitting {
	readonly name: string
	readonly table: JudgedTable
	readonly generated: ReadonlyArray<JudgedField>
	readonly checks: ReadonlyArray<RowCheck>
}

/**
 * What admitting a row of a relation reads of it (admission): each field a row states, by its name and its carrier's
 * spec, as the write's facts are read (scalar/values/identity.ts HeadingField), and each refined one, by its name and
 * its type, whose domain holds its value.
 */
interface Admitting {
	readonly stated: ReadonlyArray<HeadingField>
	readonly refined: ReadonlyArray<JudgedField>
}

/** A source as the host evaluates rows of it, read once: its relation's reading and its selection's predicate. */
interface Prepared {
	readonly relation: RelationReading
	readonly selection: Lowered
}

/**
 * A row check of a relation, by name, its predicate p lowered over the row: a row breaks it where p is false or NULL,
 * as both its discharges refuse the row, a table's `CHECK ((p) IS TRUE)` and a derived relation's rule's violation
 * query, `WHERE (p) IS NOT TRUE` (ir/desc.ts refusalCondition).
 */
interface RowCheck {
	readonly name: string
	readonly predicate: Lowered
}

/** Where a host evaluation of `relation` lowers what it reads, for its refusals. */
const evaluationLoc = (relation: string): SourceLoc => SourceLoc(`rowEvaluator ${relation}`, [])

/** A lowering the host refuses, as the item it is of: Unevaluated, the refusal's words its `why`. */
const refusedLowering = (error: CompileError): Unevaluated => ({
	_tag: "Unevaluated",
	why: error.message
})

/**
 * A row predicate over `relation`'s fields lowered as a check lowers one (mode "check"), each field read as a column of
 * the row (check/generated.ts rowNode), as its table: a selection's predicate, or a derived relation's row check's
 * violation. It is its own lowering batch, so each closed payload it reads as a Text.matches pattern is admitted for
 * it (typing.ts admittedReads). One the check lowering refuses is Unevaluated (Lowered): a rule's predicate is lowered
 * where its violation query is checked, as a query's, which admits what no check does.
 */
const rowPredicate = (
	model: LawModel,
	relation: string,
	fields: ReadonlyArray<HeadingColumn>,
	predicate: ExprDesc
): Lowered => {
	const loc = evaluationLoc(relation)
	const lowered = Result.map(
		lowerPredicate(predicate, {
			...typingEnv(model.owned, model.checked.patterns),
			closed: model.checked.closedReads,
			mode: "check",
			loc,
			emit: exprEmitter(`rowEvaluator ${relation}`),
			params: noParams,
			leaf: (desc, at) => {
				const field = desc.kind === "field" ? fields.find((f) => f.name === desc.field) : undefined
				return field === undefined
					? Result.err(malformedDescription(at, `a field of ${relation}`))
					: Result.ok(storedColumn(rowNode, field.name, field.type))
			}
		}),
		(table) => predicateTable(table.expr)
	)
	return Result.mapError(lowered, refusedLowering)
}

/** A heading's columns as the judge reads a row's fields: each one the row states, none generated. */
const statedFields = (heading: ReadonlyArray<HeadingColumn>): ReadonlyArray<JudgedField> =>
	heading.map((c) => ({ name: c.name, type: c.type, writing: { kind: "caller" } }))

/**
 * A relation's reading (RelationReading) over its fields and its row checks, under `codes`, which a closed id's and a
 * set's handles are admitted by: each field a row states read as the write reads a fact's field, by its carrier's spec
 * (scalar/values/identity.ts admitValue), whose refusal is the fault every other admission of the column's values gives.
 */
const relationReading = (
	name: string,
	fields: ReadonlyArray<JudgedField>,
	checks: ReadonlyArray<RowCheck>,
	codes: Codebook
): RelationReading => ({
	name,
	table: { fields, lawColumns: new Map() },
	stated: fields.flatMap((f) =>
		judgedGeneration(f) === undefined ? [{ name: f.name, spec: carrierSpecOf(f.type, codes) }] : []
	),
	refined: fields.filter((f) => judgedGeneration(f) === undefined && isRefined(f.type)),
	generated: fields.filter((f) => judgedGeneration(f) !== undefined),
	checks
})

/**
 * The relation `name` of the model as its sources read it (RelationReading), none for a name the model holds no
 * relation of: a stored relation's fields as its table holds them and its row checks by the CHECK each is installed as
 * (decide.ts lawChecksOf, the witness's reading); a derived relation's, live or materialized, its definition's heading
 * as the checker types it (check/index.ts checkDefinition, the theory's typing of a rule over it) and its row checks,
 * each its predicate over the derived row (rowPredicate); a closed relation's, rosters among them, its heading as a
 * query matches it (check/schema.ts ClosedRelation) and no row check, which the schema refuses over the facts it fixes.
 * The model compiled, so its definition checks. Read where a source of the relation is first prepared (rowEvaluatorOver
 * `readingOf`), never for a relation no source of the evaluator reads.
 */
const relationReadingOf = (
	model: LawModel,
	codes: Codebook,
	name: string
): RelationReading | undefined => {
	const stored = model.checked.relations.get(name)
	if (stored !== undefined) {
		return relationReading(
			name,
			stored.fields.map(witnessField),
			lawChecksOf(model, stored).flatMap(({ laws, test }) =>
				test.kind === "row"
					? laws.flatMap(({ described }) =>
							described.kind === "check"
								? [{ name: described.name, predicate: Result.ok(test.predicate) }]
								: []
						)
					: []
			),
			codes
		)
	}
	const closed = model.checked.closed.get(name)
	if (closed !== undefined) {
		return relationReading(name, statedFields(closed.heading), [], codes)
	}
	const derived = model.owned.relations[name]
	if (derived?.desc.kind !== "derived") {
		return undefined
	}
	const admitted = checkDefinition(
		model.checked,
		`derived ${name}`,
		derived.desc.query,
		new CheckSession(model.checked.patterns)
	)
	if (!admitted.ok) {
		throw defect(`the definition of ${name}, which the compiled schema checked`)
	}
	const heading = admitted.value.dag.roots[0].heading
	const checks = model.owned.statements.flatMap((statement): ReadonlyArray<RowCheck> =>
		statement.kind === "check" && statement.relation === name
			? [
					{
						name: statement.name,
						predicate: rowPredicate(model, name, heading, statement.predicate)
					}
				]
			: []
	)
	return relationReading(name, statedFields(heading), checks, codes)
}

/**
 * The one predicate a source states (SelectedDesc), the conjunction of its conjuncts (ir/desc.ts connectiveExpr): a
 * selection's, its own predicate; a relation's, the empty conjunction, TRUE, so a relation is select(R, TRUE).
 */
const selectedOf = (source: unknown): SelectedDesc => {
	const selection = ownedDesc(source, "selection")
	return selection === undefined
		? { relation: namedRelation(source, "a row source").name, predicate: connectiveExpr("and", []) }
		: { relation: selection.relation, predicate: connectiveExpr("and", [selection.predicate]) }
}

/**
 * A source of the model read once (Prepared): its relation's reading and its selection's predicate lowered over its
 * fields. The source is a value of the schema's type, so a relation the model does not hold is a defect.
 */
const prepare = (
	model: LawModel,
	readingOf: (relation: string) => RelationReading,
	source: unknown
): Prepared => {
	const selected = selectedOf(source)
	const relation = readingOf(selected.relation)
	return {
		relation,
		selection: rowPredicate(
			model,
			selected.relation,
			relation.table.fields.map((f) => ({ name: f.name, type: f.type })),
			selected.predicate
		)
	}
}

/** A column a row does not fill: a law column, which a row of a source holds none of, or a field it does not hold. */
const unfilled: FilledColumn = Object.freeze({ kind: "unfilled" })

/**
 * A row as the judge reads it (witness.ts JudgedRow): every field it holds stated, and each of its relation's fields
 * it holds filled at its value, read off the row itself at the field's column key, its name (ir/law.ts ColumnKey), a
 * drawn or accumulated field among them; no law column, whose key no row's field has.
 */
const judgedRow = (row: Readonly<Record<string, unknown>>): JudgedRow => ({
	kind: "known",
	stated: row,
	filled: (column) =>
		Object.hasOwn(row, column) ? { kind: "filled", value: row[column] } : unfilled
})

/**
 * What the host's stop means for a row inside its domains: an expression the host does not evaluate is Unevaluated; a
 * precondition undefined at a row inside its domains, which every partial operation's proof excludes, is a defect.
 */
const unevaluated = (stop: EvalStop): Unevaluated => {
	if (stop.kind === "undefined") {
		throw defect(
			`a row inside its domains meets every proved precondition, not one undefined (${stop.precondition})`
		)
	}
	return { _tag: "Unevaluated", why: stop.what }
}

/** A generated field's value (Evaluated): its value, NULL as null, or Unevaluated. */
const valueOf = (e: Evaluated): Result.Result<unknown, Unevaluated> => {
	switch (e.kind) {
		case "value":
			return Result.ok(e.value)
		case "null":
			return Result.ok(null)
		case "unknown":
			return Result.err(unevaluated(e.stop))
	}
}

/** A generated field's value as its field of type `type` holds it (values/identity.ts heldValue), NULL as null. */
const heldOf = (
	type: ScalarType,
	value: Result.Result<unknown, Unevaluated>
): Result.Result<unknown, Unevaluated> =>
	Result.map(value, (v) => (v === null ? null : heldValue(type, v)))

/** A truth as the evaluation states it, each one value. */
const truths = { true: Result.ok(true), false: Result.ok(false) } as const

/** A predicate's truth as `IS TRUE` reads it (Evaluated): true only where it is true, NULL and false alike false. */
const truthOf = (e: Evaluated): Result.Result<boolean, Unevaluated> => {
	switch (e.kind) {
		case "value":
			return e.value === true ? truths.true : truths.false
		case "null":
			return truths.false
		case "unknown":
			return Result.err(unevaluated(e.stop))
	}
}

/** A row check's verdict, as the evaluation states it, each one value. */
const verdicts: { readonly [V in CheckVerdict]: Result.Result<CheckVerdict, Unevaluated> } = {
	holds: Result.ok("holds"),
	breaks: Result.ok("breaks")
}

/** A row check's verdict from its predicate's truth: it holds where the predicate is true and breaks elsewhere. */
const verdictOf = (
	truth: Result.Result<boolean, Unevaluated>
): Result.Result<CheckVerdict, Unevaluated> =>
	truth.ok ? (truth.value ? verdicts.holds : verdicts.breaks) : truth

/**
 * The answers a caller reads (core/result.ts PublicResult), spelled by `answer`, Effect's Result: a truth and a verdict,
 * each of its two values spelled once for the evaluator, and every other item where it is computed.
 */
interface Answers {
	readonly answer: PublicResult
	readonly truth: (
		truth: Result.Result<boolean, Unevaluated>
	) => Public.Result<boolean, Unevaluated>
	readonly verdict: (
		verdict: Result.Result<CheckVerdict, Unevaluated>
	) => Public.Result<CheckVerdict, Unevaluated>
}

/** The answers of one evaluator over `answer` (Answers). */
const answersOf = (answer: PublicResult): Answers => {
	const truth = {
		true: answer<boolean, Unevaluated>(truths.true),
		false: answer<boolean, Unevaluated>(truths.false)
	} as const
	const verdict = {
		holds: answer<CheckVerdict, Unevaluated>(verdicts.holds),
		breaks: answer<CheckVerdict, Unevaluated>(verdicts.breaks)
	} as const
	return {
		answer,
		truth: (t) => (t.ok ? (t.value ? truth.true : truth.false) : answer(t)),
		verdict: (v) => (v.ok ? verdict[v.value] : answer(v))
	}
}

/** Whether a field a domain refused is a field of R's evaluated row: one the row holds. */
const isRowField = <R>(
	row: Readonly<Record<string, unknown>>,
	field: string
): field is keyof EvaluatedRow<R> & string => Object.hasOwn(row, field)

/**
 * An admitted row's items as its relation reads them, computed in one pass where the row is first evaluated: its
 * generated values and its check verdicts, keyed by the names of `relation`, the reading of R that built them (itemsOf),
 * and shared by every source of R's evaluation of the row.
 */
interface Items {
	readonly relation: RelationReading
	readonly generated: Readonly<Record<string, Public.Result<unknown, Unevaluated>>>
	readonly checks: Readonly<Record<string, Public.Result<CheckVerdict, Unevaluated>>>
}

/**
 * What admitting a row records of it, by the admitted row's identity: its relation's reading; the row as the judge reads
 * it over its relation (witness.ts RowReading), each column read once, which every source of the relation evaluates
 * the row over; and its relation's items (Items), computed where the row is first evaluated, which every source of the
 * relation shares. A WeakMap holds nothing alive and is never enumerated, so it is no cache: it is the admitted row's
 * state.
 */
interface Admission {
	readonly relation: RelationReading
	readonly reading: RowReading
	readonly items: () => Items
}

const admissions = new WeakMap<object, Admission>()

/** The one site of the fact "this value is an admitted row of R": admit made it, which its state records. */
const isAdmittedRow = <R>(value: { readonly row: EvaluatedRow<R> }): value is AdmittedRow<R> =>
	admissions.has(value)

/**
 * The items of a row admitted to `relation` (Items), in one pass over the row's reading: each generated field's value,
 * the one its column holds for every expression over the row, and each row check's verdict, by its name.
 */
const itemsOf = (relation: RelationReading, reading: RowReading, answers: Answers): Items => ({
	relation,
	generated: Object.freeze(
		Object.fromEntries(
			relation.generated.map(
				(f) => [f.name, answers.answer(heldOf(f.type, valueOf(reading.generated(f.name))))] as const
			)
		)
	),
	checks: Object.freeze(
		Object.fromEntries(
			relation.checks.map(
				(c) =>
					[
						c.name,
						answers.verdict(
							Result.flatMap(c.predicate, (predicate) =>
								verdictOf(truthOf(reading.evaluate(predicate)))
							)
						)
					] as const
			)
		)
	)
})

/**
 * The one site of the fact "an admitted row's items are R's": its generated values are keyed by R's generated fields
 * and its verdicts by R's check names, which the schema's type of R states and R's reading, the relation the row was
 * admitted to, reads at run time, a correlation no TypeScript type ties. Items are built over the names of the reading
 * that built them (itemsOf), which they record, so items of another reading are a defect.
 */
const isItemsOf = <S, R>(
	items: Items,
	relation: RelationReading
): items is Items & Pick<RowEvaluation<S, R>, "generated" | "checks"> => items.relation === relation

/**
 * A value admitValue read at `carrier` as a fact holds it: a bytes value with its digest (values/bytes.ts
 * AdmittedBytes), every other value itself, a digest's array among them, which is its carrier's host value as it is.
 */
const heldRead = (carrier: Carrier, value: unknown): unknown =>
	carrier === "bytes" && value instanceof Uint8Array ? new AdmittedBytes(value) : value

/**
 * The first refined field of `refined` whose value is outside its domain, its contract and its patterns, as PostgreSQL
 * holds each value before it computes anything of it: the one judgment of a value's domain on the host, every
 * admission's, an evaluated row's (admission) and a decoded row's (program/decode.ts), each value read by `held`, the
 * value its field's type admitted. None when every value is inside its domain. The judge evaluates every contract and
 * pattern a schema's types state, so one it does not is a defect.
 */
export const domainRefusal = (
	judge: Judge,
	refined: ReadonlyArray<JudgedField>,
	held: (field: string) => unknown
): string | undefined => {
	for (const field of refined) {
		const member = judge.member(
			evaluatedValue(field.type, heldRead(baseOf(field.type).carrier, held(field.name))),
			field.type
		)
		if (member === undefined) {
			throw defect(`the domain of ${field.name}, a contract and a pattern the host evaluates`)
		}
		if (!member) {
			return field.name
		}
	}
	return undefined
}

/**
 * A row of R admitted (see rowEvaluator's admit), pure: each field of R the row states read as its column's type, as
 * the write reads a fact's field (scalar/values/identity.ts admitValue), after the null ban, a value that is none of the
 * type's ValueRefused by the codec's fault; then each refined field's admitted value held to its domain (domainRefusal),
 * a value outside it DomainRefused. The first refusal is the row's; a row inside every one is its admitted values by
 * name, as PostgreSQL holds them, a bytes value with its digest. A brand is unchecked, so this is the only place either
 * is judged of a row the host evaluates, and neither throws.
 */
const admission = <R>(
	judge: Judge,
	relation: Admitting,
	row: EvaluatedRow<R>
): Result.Result<Readonly<Record<string, unknown>>, ValueRefused<R> | DomainRefused<R>> => {
	const fields: Readonly<Record<string, unknown>> = row
	const values: Record<string, unknown> = {}
	Reflect.setPrototypeOf(values, null)
	for (const field of relation.stated) {
		const value = fields[field.name]
		const read = admitValue(field.spec, value)
		if (!read.ok) {
			if (!isRowField<R>(fields, field.name)) {
				throw defect(`the type of a field ${field.name} the row states`)
			}
			return Result.err({ _tag: "ValueRefused", field: field.name, fault: read.error })
		}
		values[field.name] = heldRead(field.spec.carrier, read.value)
	}
	const refused = domainRefusal(judge, relation.refined, (name) => values[name])
	if (refused === undefined) {
		return Result.ok(Object.freeze(values))
	}
	if (!isRowField<R>(fields, refused)) {
		throw defect(`the domain of a field ${refused} the row holds`)
	}
	return Result.err({ _tag: "DomainRefused", field: refused })
}

/**
 * A row of R admitted and recorded (see rowEvaluator's admit): its admission, then, of a row inside every domain, its
 * state, by the admitted row's identity: its relation's reading, the row's reading over its admitted values, each column
 * read once, and its items computed where it is first evaluated, so its evaluation is free of any type or domain
 * judgment.
 */
const admitted = <R>(
	judge: Judge,
	answers: Answers,
	relation: RelationReading,
	row: EvaluatedRow<R>
): Result.Result<AdmittedRow<R>, ValueRefused<R> | DomainRefused<R>> =>
	Result.map(admission<R>(judge, relation, row), (values) => {
		const value = Object.freeze({ row })
		const reading = judge.reading(relation.table, judgedRow(values))
		admissions.set(value, {
			relation,
			reading,
			items: once(() => itemsOf(relation, reading, answers))
		})
		if (!isAdmittedRow<R>(value)) {
			throw defect("an admitted row, its state recorded")
		}
		return value
	})

/**
 * An admitted row evaluated as a row of a prepared source of its relation (see the header): its relation's items,
 * computed where the row is first evaluated and shared by every source of the relation, and its selection by the
 * source, each over the row's one reading, so no source of the relation reads a column of the row again.
 */
const evaluated = <S, R>(
	source: Prepared,
	row: AdmittedRow<R>,
	answers: Answers
): RowEvaluation<S, R> => {
	const recorded = admissions.get(row)
	if (recorded === undefined) {
		throw defect("an admitted row, which admit made")
	}
	const { relation, reading } = recorded
	if (source.relation !== relation) {
		throw defect(`a source of ${relation.name}, the relation the row was admitted to`)
	}
	const items = recorded.items()
	if (!isItemsOf<S, R>(items, relation)) {
		throw defect("a row's items keyed by the names of the relation it was admitted to")
	}
	return {
		generated: items.generated,
		checks: items.checks,
		selected: answers.truth(
			Result.flatMap(source.selection, (selection) => truthOf(reading.evaluate(selection)))
		)
	}
}

/**
 * rowEvaluator(schema), the shell's (packages/grizzle adapter/public/host.ts), over `answer`, the shell's spelling of a
 * caller's Result: the host's evaluation of rows of the schema's sources (see the header), its schema compiled once and
 * each relation read once, where a source of it is first evaluated, and held for every other (`readingOf`), so a
 * relation no source reads is never read: `const evaluate = rowEvaluator(schema)`, then `evaluate.admit(R, row)` admits
 * a row of R once, holding it to its domains, and `evaluate(source, admitted)` is the admitted row's evaluation as a row
 * of any source of R, R itself or select(R, φ), each source read once, where it is first evaluated. One judge reads every row, over the
 * schema's closed relations and its checked schema's pattern table, so a closed relation is indexed once for the
 * evaluator and a pattern parsed once for the schema's compile. Each answer a caller reads, an admission and every item, is `answer`'s, made where it is computed (Answers).
 * A schema that does not compile is its CompileError.
 */
export const rowEvaluatorOver = <S extends AnySchema>(
	schema: S,
	answer: PublicResult
): Result.Result<RowEvaluator<S>, CompileError> =>
	Result.map(lawModel(schema, "rowEvaluator"), (model): RowEvaluator<S> => {
		const codes = firstCodebook(rostersOf(model.owned))
		const judge = judgeOf(closedTableOf(model.checked), model.checked.patterns)
		const answers = answersOf(answer)
		const readings = new Map<string, RelationReading>()
		const readingOf = (relation: string): RelationReading => {
			const known = readings.get(relation)
			if (known !== undefined) {
				return known
			}
			const read = relationReadingOf(model, codes, relation)
			if (read === undefined) {
				throw defect(`a row source of the schema, not of ${relation}`)
			}
			readings.set(relation, read)
			return read
		}
		const sources = new WeakMap<object, Prepared>()
		const preparedOf = (source: object): Prepared => {
			const known = sources.get(source)
			if (known !== undefined) {
				return known
			}
			const prepared = prepare(model, readingOf, source)
			sources.set(source, prepared)
			return prepared
		}
		const evaluate = <Src extends RowSource<S>>(
			source: Src,
			row: AdmittedRow<SourceRelation<Src>>
		): RowEvaluation<S, SourceRelation<Src>> =>
			evaluated<S, SourceRelation<Src>>(preparedOf(source), row, answers)
		return Object.assign(evaluate, {
			admit: <R extends RelationOf<S>>(
				relation: R,
				row: EvaluatedRow<R>
			): Public.Result<AdmittedRow<R>, ValueRefused<R> | DomainRefused<R>> =>
				answer(admitted<R>(judge, answers, preparedOf(relation).relation, row))
		})
	})
