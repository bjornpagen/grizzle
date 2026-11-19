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
 * Before any of it, PostgreSQL holds each value to its domain: a value outside its type's contract or pattern is
 * refused (DomainRefused), which a brand, unchecked, does not exclude. That is admit's, once a row (`evaluate.admit(R,
 * row)`): an admitted row is evaluated as a row of any source of R with no domain judged again, each item where it is
 * first read, kept on the admitted row and shared by every source of R. A row inside its domains meets every partial
 * operation's proof, so an evaluation that finds a precondition undefined is a defect of grizzle's, never an outcome.
 * An item whose expression the host does not lower or does not evaluate is Unevaluated, its place its own.
 */

import type { Result as Public } from "effect"
import { typingEnv } from "#compiler/analysis/theory/theory.ts"
import { rowNode } from "#compiler/check/generated.ts"
import { checkDefinition } from "#compiler/check/index.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { defect } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { connectiveExpr, type ExprDesc } from "#compiler/ir/desc.ts"
import { type ExprTable, predicateTable } from "#compiler/ir/expr.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import { isRefined } from "#compiler/ir/scalar.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { lawModel } from "#compiler/program/laws.ts"
import { type ColumnKey, fieldKey } from "#compiler/runtime/write/fill.ts"
import {
	type Evaluated,
	type FilledColumn,
	type JudgedField,
	type JudgedRow,
	type JudgedTable,
	type Judge,
	judgeOf
} from "#compiler/runtime/write/witness.ts"
import type { EvalStop } from "#compiler/scalar/compute/evaluate.ts"
import { exprEmitter, lowerPredicate } from "#compiler/scalar/compute/lower.ts"
import { admittedReads, noParams } from "#compiler/scalar/compute/typing.ts"
import { CompilePatterns, tablePatterns, typePatterns } from "#compiler/scalar/regex/patterns.ts"
import { hostOf } from "#compiler/scalar/values/identity.ts"
import { ownedDesc } from "#compiler/schema/protocol.ts"
import { namedRelation } from "#compiler/schema/relation.ts"
import type { SelectedDesc } from "#compiler/schema/statements.ts"
import { exprPatternReads } from "#compiler/schema/walk.ts"
import type {
	AdmittedRow,
	CheckVerdict,
	DomainRefused,
	EvaluatedRow,
	RowEvaluation,
	RowEvaluator,
	RowSource,
	SourceRelation,
	Unevaluated
} from "#compiler/types/schema/evaluation.ts"
import type { AnySchema, RelationOf } from "#compiler/types/schema/schema.ts"
import { closedTableOf, lawChecksOf, witnessField } from "#compiler/write/program/decide.ts"

/**
 * An expression the host evaluates over a source's rows, lowered once: its table, or Unevaluated where the host's
 * lowering of a row predicate (rowPredicate) refuses it, one only a query admits, such as float arithmetic, the
 * refusal's words its `why`.
 */
type Lowered = Result.Result<ExprTable, Unevaluated>

/**
 * A source as the host evaluates rows of it, read once: its relation's fields as the judge reads them, the fields of
 * its rows a domain holds, each generated field's expression and each row check by name, its selection's predicate,
 * and the judge over the patterns they read, each parsed once in the evaluator's table, which every source shares.
 */
interface Prepared {
	readonly relation: string
	readonly table: JudgedTable
	readonly filled: FilledFields
	readonly refined: ReadonlyArray<JudgedField>
	readonly generated: ReadonlyArray<{ readonly name: string; readonly expr: ExprTable }>
	readonly checks: ReadonlyArray<RowCheck>
	readonly selection: Lowered
	readonly judge: Judge
}

/**
 * The fields of a relation a row of it fills, by the column key the judge reads each at (runtime/write/fill.ts
 * fieldKey): its fields' names, read once a source, so a row's fill is read off the row itself, never a map built per
 * row.
 */
type FilledFields = ReadonlyMap<ColumnKey, string>

/**
 * A row check of a relation, by name, its predicate p lowered over the row: a row breaks it where p is false or NULL,
 * as both its discharges refuse the row, a table's `CHECK ((p) IS TRUE)` and a derived relation's rule's violation
 * query, `WHERE (p) IS NOT TRUE` (ir/desc.ts refusalCondition).
 */
interface RowCheck {
	readonly name: string
	readonly predicate: Lowered
}

/** A relation of the schema as a source reads it: its fields as the judge reads them, and its row checks by name. */
interface ReadRelation {
	readonly fields: ReadonlyArray<JudgedField>
	readonly checks: ReadonlyArray<RowCheck>
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
 * violation. It is its own lowering batch, so each closed payload it reads as a Compute.matches pattern is admitted for
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
			...typingEnv(model.owned),
			closed: admittedReads(model.checked.closedReads, exprPatternReads([predicate])),
			mode: "check",
			loc,
			emit: exprEmitter(`rowEvaluator ${relation}`),
			params: noParams,
			leaf: (desc, at) => {
				const field = desc.kind === "field" ? fields.find((f) => f.name === desc.field) : undefined
				return field === undefined
					? Result.err(malformedDescription(at, `a field of ${relation}`))
					: Result.ok({
							kind: "column",
							column: { node: rowNode, name: field.name },
							args: [],
							type: field.type,
							nonNull: "storage"
						})
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
 * Every relation of the model as a source reads it, by name: a stored relation's fields as its table holds them and its
 * row checks by the CHECK each is installed as (decide.ts lawChecksOf, the witness's reading); a derived relation's,
 * live or materialized, its definition's heading as the checker types it (check/index.ts checkDefinition, the theory's
 * typing of a rule over it) and its row checks, each its predicate over the derived row (rowPredicate); a closed
 * relation's, rosters among them, its heading as a query matches it (check/schema.ts ClosedRelation) and no row check,
 * which the schema refuses over the facts it fixes. The model compiled, so each definition checks.
 */
const readRelations = (model: LawModel): ReadonlyMap<string, ReadRelation> => {
	const read = new Map<string, ReadRelation>()
	for (const [name, stored] of model.checked.relations) {
		read.set(name, {
			fields: stored.fields.map(witnessField),
			checks: lawChecksOf(model, stored).flatMap(({ laws, test }) =>
				test.kind === "row"
					? laws.flatMap(({ described }) =>
							described.kind === "check"
								? [
										{
											name: described.name,
											predicate: Result.ok(test.predicate)
										}
									]
								: []
						)
					: []
			)
		})
	}
	for (const derived of Object.values(model.owned.relations)) {
		if (derived.desc.kind !== "derived") {
			continue
		}
		const admitted = checkDefinition(model.checked, `derived ${derived.name}`, derived.desc.query)
		if (!admitted.ok) {
			throw defect(`the definition of ${derived.name}, which the compiled schema checked`)
		}
		const heading = admitted.value.dag.roots[0].heading
		const checks: Array<RowCheck> = []
		for (const statement of model.owned.statements) {
			if (statement.kind !== "check" || statement.relation !== derived.name) {
				continue
			}
			checks.push({
				name: statement.name,
				predicate: rowPredicate(model, derived.name, heading, statement.predicate)
			})
		}
		read.set(derived.name, { fields: statedFields(heading), checks })
	}
	for (const [name, closed] of model.checked.closed) {
		read.set(name, { fields: statedFields(closed.heading), checks: [] })
	}
	return read
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

/** The patterns a lowered expression reads, none of one the host refused. */
const loweredPatterns = (lowered: Lowered) => (lowered.ok ? tablePatterns(lowered.value) : [])

/**
 * A source of the model read once (Prepared): its relation's reading and its selection's predicate lowered over its
 * fields, its judge reading the evaluator's pattern table, `table`, so a pattern every source of the evaluator reads is
 * parsed once, not once a source. The source is a value of the schema's type, so a relation the model does not hold is a
 * defect.
 */
const prepare = (
	model: LawModel,
	relations: ReadonlyMap<string, ReadRelation>,
	closed: ReturnType<typeof closedTableOf>,
	table: CompilePatterns,
	source: unknown
): Prepared => {
	const selected = selectedOf(source)
	const read = relations.get(selected.relation)
	if (read === undefined) {
		throw defect(`a row source of the schema, not of ${selected.relation}`)
	}
	const { fields, checks } = read
	const selection = rowPredicate(
		model,
		selected.relation,
		fields.map((f) => ({ name: f.name, type: f.type })),
		selected.predicate
	)
	const generated = fields.flatMap((f) =>
		f.writing.kind === "generated" ? [{ name: f.name, expr: f.writing.expr }] : []
	)
	const patterns = [
		...fields.flatMap((f) => typePatterns(f.type)),
		...generated.flatMap((g) => tablePatterns(g.expr)),
		...checks.flatMap((c) => loweredPatterns(c.predicate)),
		...loweredPatterns(selection)
	]
	return {
		relation: selected.relation,
		table: { fields, lawColumns: new Map() },
		filled: new Map(fields.map((f) => [fieldKey(f.name), f.name] as const)),
		refined: fields.filter((f) => f.writing.kind !== "generated" && isRefined(f.type)),
		generated,
		checks,
		selection,
		judge: judgeOf({ closed: [...closed.keys()], patterns }, closed, table)
	}
}

/** A column a row does not fill: a law column, which a row of a source holds none of, or a field it does not hold. */
const unfilled: FilledColumn = Object.freeze({ kind: "unfilled" })

/**
 * A row as the judge reads it (witness.ts JudgedRow): every field it holds stated, and each of its relation's fields
 * it holds filled at its value, read off the row itself by the relation's filled fields (FilledFields), a drawn or
 * accumulated field among them; no law column.
 */
const judgedRow = (row: Readonly<Record<string, unknown>>, fields: FilledFields): JudgedRow => ({
	kind: "known",
	stated: row,
	filled: (column) => {
		const name = fields.get(column)
		return name !== undefined && Object.hasOwn(row, name)
			? { kind: "filled", value: row[name] }
			: unfilled
	}
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

/** A predicate's truth as `IS TRUE` reads it (Evaluated): true only where it is true, NULL and false alike false. */
const truthOf = (e: Evaluated): Result.Result<boolean, Unevaluated> => {
	switch (e.kind) {
		case "value":
			return Result.ok(e.value === true)
		case "null":
			return Result.ok(false)
		case "unknown":
			return Result.err(unevaluated(e.stop))
	}
}

/** A row check's verdict from its predicate's truth: it holds where the predicate is true and breaks elsewhere. */
const verdictOf = (truth: boolean): CheckVerdict => (truth ? "holds" : "breaks")

/** Whether a field a domain refused is a field of R's evaluated row: one the row holds. */
const isRowField = <R>(
	row: Readonly<Record<string, unknown>>,
	field: string
): field is keyof EvaluatedRow<R> & string => Object.hasOwn(row, field)

/**
 * An admitted row's items as its relation reads them, each computed where it is first read and memoized there
 * (lazyRecord): its generated values and its check verdicts, keyed by the names of `relation`, the reading of R that
 * built them (itemsOf), and shared by every source of R's evaluation of the row.
 */
interface Items {
	readonly relation: Prepared
	readonly generated: Readonly<Record<string, Public.Result<unknown, Unevaluated>>>
	readonly checks: Readonly<Record<string, Public.Result<CheckVerdict, Unevaluated>>>
}

/** An admitted row's evaluation as a row of one source (RowEvaluation), its records keyed by its relation's names. */
interface SourceEvaluation {
	readonly generated: Items["generated"]
	readonly checks: Items["checks"]
	readonly selected: Public.Result<boolean, Unevaluated>
}

/**
 * An admitted row's evaluation as a row of one source of its relation (SourceEvaluation), built where it is first asked
 * for and kept on its admission, one for the pair, with the items it reads: its relation's generated values and
 * verdicts (Items), which every source of the relation shares, and its selection by the source, evaluated where it is
 * first read (once) and kept.
 */
interface KeptEvaluation {
	readonly items: Items
	readonly evaluation: SourceEvaluation
}

/** The evaluation of an admitted row as a row of `source` over its items, kept for the pair (KeptEvaluation). */
const keptEvaluation = (
	items: Items,
	source: Prepared,
	judged: JudgedRow,
	answer: Result.PublicResult
): KeptEvaluation => {
	const selected = once(() =>
		answer(
			Result.flatMap(source.selection, (selection) =>
				truthOf(source.judge.evaluate(source.table, selection, judged))
			)
		)
	)
	return {
		items,
		evaluation: {
			generated: items.generated,
			checks: items.checks,
			get selected() {
				return selected()
			}
		}
	}
}

/**
 * What admitting a row records of it, by the admitted row's identity: its relation, read as a whole source of itself
 * (select(R, TRUE)); the row as the judge reads it, built once; its relation's items (Items), built where the row is
 * first evaluated, which every source of the relation shares; and its evaluation as a row of each source (Evaluation),
 * built where it is first asked for, each item as the caller reads it, Effect's Result. A WeakMap holds nothing alive and is never enumerated, so it is no cache: it is the
 * admitted row's state.
 */
interface Admission {
	readonly relation: Prepared
	readonly judged: JudgedRow
	readonly items: () => Items
	readonly evaluations: Map<Prepared, KeptEvaluation>
}

const admissions = new WeakMap<object, Admission>()

/** The one site of the fact "this value is an admitted row of R": admit made it, which its state records. */
const isAdmittedRow = <R>(value: { readonly row: EvaluatedRow<R> }): value is AdmittedRow<R> =>
	admissions.has(value)

/** A value computed where it is first read, then read from its memo. */
const once = <A>(compute: () => A): (() => A) => {
	let computed: { readonly value: A } | undefined
	return () => {
		computed ??= { value: compute() }
		return computed.value
	}
}

/** A record of an item for each of `items`, by its name, each computed where it is first read (once). */
const lazyRecord = <T extends { readonly name: string }, A>(
	items: ReadonlyArray<T>,
	compute: (item: T) => A
): Readonly<Record<string, A>> => {
	const out: Record<string, A> = {}
	for (const item of items) {
		Object.defineProperty(out, item.name, { enumerable: true, get: once(() => compute(item)) })
	}
	return Object.freeze(out)
}

/**
 * The items of a row admitted to `relation` (Items): each generated field's value and each row check's verdict, by its
 * name, evaluated over the row as the judge reads it where it is first read, as `answer` spells a caller's Result.
 */
const itemsOf = (relation: Prepared, judged: JudgedRow, answer: Result.PublicResult): Items => {
	const { judge, table } = relation
	return {
		relation,
		generated: lazyRecord(relation.generated, (g) =>
			answer(valueOf(judge.evaluate(table, g.expr, judged)))
		),
		checks: lazyRecord(relation.checks, (c) =>
			answer(
				Result.flatMap(c.predicate, (predicate) =>
					Result.map(truthOf(judge.evaluate(table, predicate, judged)), verdictOf)
				)
			)
		)
	}
}

/**
 * The one site of the fact "an admitted row's evaluation is R's": its generated values are keyed by R's generated
 * fields and its verdicts by R's check names, which the schema's type of R states and R's reading, the relation the row
 * was admitted to, reads at run time, a correlation no TypeScript type ties. Its items are built over the names of the
 * reading that built them (itemsOf), which they record, so items of another reading are a defect.
 */
const isEvaluationOf = <S, R>(
	kept: KeptEvaluation,
	relation: Prepared
): kept is KeptEvaluation & { readonly evaluation: RowEvaluation<S, R> } =>
	kept.items.relation === relation

/**
 * A row of R admitted (see rowEvaluator's admit): each refined field of R the row holds is held to its domain, its
 * contract and its patterns, as PostgreSQL holds each value before it computes anything of the row; a value outside its
 * domain is DomainRefused, the row's one refusal, and a row inside every one is admitted, its evaluation then free of any
 * domain judgment. A brand is unchecked, so this is the only place a domain is judged.
 */
const admitted = <R>(
	relation: Prepared,
	row: EvaluatedRow<R>,
	answer: Result.PublicResult
): Result.Result<AdmittedRow<R>, DomainRefused<R>> => {
	const fields: Readonly<Record<string, unknown>> = row
	for (const field of relation.refined) {
		const member = relation.judge.member(hostOf(field.type.carrier, fields[field.name]), field.type)
		if (member === undefined) {
			throw defect(`the domain of ${field.name}, a contract and a pattern the host evaluates`)
		}
		if (member) {
			continue
		}
		if (!isRowField<R>(fields, field.name)) {
			throw defect(`the domain of a field ${field.name} the row holds`)
		}
		return Result.err({ _tag: "DomainRefused", field: field.name })
	}
	const value = Object.freeze({ row })
	const judged = judgedRow(fields, relation.filled)
	admissions.set(value, {
		relation,
		judged,
		items: once(() => itemsOf(relation, judged, answer)),
		evaluations: new Map()
	})
	if (!isAdmittedRow<R>(value)) {
		throw defect("an admitted row, its state recorded")
	}
	return Result.ok(value)
}

/**
 * An admitted row evaluated as a row of a prepared source of its relation (see the header): its evaluation as a row of
 * the source (Evaluation), built where it is first asked for and kept on the admitted row, so every later call returns
 * it; each item computed where it is first read and memoized there, its relation's generated values and verdicts by its
 * relation's reading, which every source of the relation shares, and its selection by the source's.
 */
const evaluated = <S, R>(
	source: Prepared,
	row: AdmittedRow<R>,
	answer: Result.PublicResult
): RowEvaluation<S, R> => {
	const admission = admissions.get(row)
	if (admission === undefined) {
		throw defect("an admitted row, which admit made")
	}
	const { relation } = admission
	let kept = admission.evaluations.get(source)
	if (kept === undefined) {
		if (source.relation !== relation.relation) {
			throw defect(`a source of ${relation.relation}, the relation the row was admitted to`)
		}
		kept = keptEvaluation(admission.items(), source, admission.judged, answer)
		admission.evaluations.set(source, kept)
	}
	if (!isEvaluationOf<S, R>(kept, relation)) {
		throw defect("a row's items keyed by the names of the relation it was admitted to")
	}
	return kept.evaluation
}

/**
 * rowEvaluator(schema), the shell's (packages/grizzle adapter/public/host.ts), over `answer`, the shell's spelling of a
 * caller's Result: the host's evaluation of rows of the schema's sources (see the header), its schema compiled and its
 * relations read once: `const evaluate = rowEvaluator(schema)`, then `evaluate.admit(R, row)` admits a row of R once,
 * holding it to its domains, and `evaluate(source, admitted)` is the admitted row's evaluation as a row of any source of
 * R, R itself or select(R, φ), each source read once, where it is first evaluated. Each answer a caller reads, an
 * admission and every item, is `answer`'s, made where it is computed. A schema that does not compile is its
 * CompileError.
 */
export const rowEvaluatorOver = <S extends AnySchema>(
	schema: S,
	answer: Result.PublicResult
): Result.Result<RowEvaluator<S>, CompileError> =>
	Result.map(lawModel(schema, "rowEvaluator"), (model): RowEvaluator<S> => {
		const relations = readRelations(model)
		const closed = closedTableOf({ schema: model.checked })
		const sources = new WeakMap<object, Prepared>()
		const patterns = new CompilePatterns()
		const preparedOf = (source: object): Prepared => {
			const known = sources.get(source)
			if (known !== undefined) {
				return known
			}
			const prepared = prepare(model, relations, closed, patterns, source)
			sources.set(source, prepared)
			return prepared
		}
		const evaluate = <Src extends RowSource<S>>(
			source: Src,
			row: AdmittedRow<SourceRelation<Src>>
		): RowEvaluation<S, SourceRelation<Src>> =>
			evaluated<S, SourceRelation<Src>>(preparedOf(source), row, answer)
		return Object.assign(evaluate, {
			admit: <R extends RelationOf<S>>(
				relation: R,
				row: EvaluatedRow<R>
			): Public.Result<AdmittedRow<R>, DomainRefused<R>> =>
				answer(admitted<R>(preparedOf(relation), row, answer))
		})
	})
