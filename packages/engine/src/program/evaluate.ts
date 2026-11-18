import { typingEnv } from "#compiler/analysis/theory/theory.ts"
import { rowNode } from "#compiler/check/generated.ts"
/**
 * rowEvaluator(schema): the host's evaluation of one row of a schema's relation, by grizzle's one evaluator of its
 * terms (scalar/compute/evaluate.ts), through the judge a refused write's witness reads its rows by
 * (runtime/write/witness.ts judgeOf), over each value's one host form, its codec's (scalar/values/identity.ts
 * CarrierHost), and its one order (identity.ts compareValues).
 *
 * A row is evaluated as a row of a source: a relation of the schema, stored or derived, or a selection of one,
 * select(R, φ). A relation is its selection of every row, select(R, TRUE), so every source states one predicate, which
 * is read once, where the source is first evaluated. Its evaluation is what PostgreSQL computes of the row:
 * - each field PostgreSQL generates, its value, NULL as null, by the generation expression its column holds;
 * - each row check of the relation, check(name, R, φ), its verdict as `CHECK ((φ) IS TRUE)` judges it: a stored
 *   relation's by the CHECK its table holds (the law model's native), a derived relation's by its predicate over the
 *   derived row, which its rule's violation query filters by;
 * - whether the source selects it, its predicate's truth, NULL selecting no row, as `WHERE` reads it.
 *
 * Before any of it, PostgreSQL holds each value to its domain: a value outside its type's contract or pattern is
 * refused (DomainRefused), which a brand, unchecked, does not exclude. A row inside its domains meets every partial
 * operation's proof, so an evaluation that finds a precondition undefined is a defect of grizzle's, never an outcome.
 * An item whose expression reads what the host does not evaluate is Unevaluated, its place its own.
 */
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
import { fieldKey } from "#compiler/runtime/write/fill.ts"
import {
	type Evaluated,
	type JudgedField,
	type JudgedRow,
	type JudgedTable,
	type Judge,
	judgeOf
} from "#compiler/runtime/write/witness.ts"
import type { EvalStop } from "#compiler/scalar/compute/evaluate.ts"
import { exprEmitter, lowerPredicate, noParams } from "#compiler/scalar/compute/lower.ts"
import { ProgramPatterns, tablePatterns, typePatterns } from "#compiler/scalar/regex/patterns.ts"
import { hostOf } from "#compiler/scalar/values/identity.ts"
import { ownedDesc } from "#compiler/schema/protocol.ts"
import { namedRelation } from "#compiler/schema/relation.ts"
import type { SelectedDesc } from "#compiler/schema/statements.ts"
import type {
	CheckVerdict,
	DomainRefused,
	EvaluatedRow,
	RowEvaluation,
	RowEvaluator,
	RowSource,
	SourceRelation,
	Unevaluated
} from "#compiler/types/schema/evaluation.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { closedTableOf, lawChecksOf, witnessField } from "#compiler/write/program/decide.ts"

/**
 * A source as the host evaluates rows of it, read once: its relation's fields as the judge reads them, the fields of
 * its rows a domain holds, each generated field's expression and each row check's predicate by name, its selection's
 * predicate, and the judge over the patterns they read.
 */
interface Prepared {
	readonly table: JudgedTable
	readonly refined: ReadonlyArray<JudgedField>
	readonly generated: ReadonlyArray<{ readonly name: string; readonly expr: ExprTable }>
	readonly checks: ReadonlyArray<{ readonly name: string; readonly predicate: ExprTable }>
	readonly selection: ExprTable
	readonly judge: Judge
}

/** A relation of the schema as a source reads it: its fields as the judge reads them, and its row checks by name. */
interface ReadRelation {
	readonly fields: ReadonlyArray<JudgedField>
	readonly checks: ReadonlyArray<{ readonly name: string; readonly predicate: ExprTable }>
}

/** Where a host evaluation of `relation` lowers what it reads, for its refusals. */
const evaluationLoc = (relation: string): SourceLoc => SourceLoc(`rowEvaluator ${relation}`, [])

/**
 * A row predicate over `relation`'s fields lowered as a check lowers one (mode "check"), each field read as a column of
 * the row (check/generated.ts rowNode), as its table: a selection's predicate, or a derived relation's row check.
 */
const rowPredicate = (
	model: LawModel,
	relation: string,
	fields: ReadonlyArray<HeadingColumn>,
	predicate: ExprDesc
): Result.Result<ExprTable, CompileError> => {
	const loc = evaluationLoc(relation)
	return Result.map(
		lowerPredicate(predicate, {
			...typingEnv(model.owned),
			closed: model.checked.closedReads,
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
		(lowered) => predicateTable(lowered.expr)
	)
}

/**
 * Every relation of the model as a source reads it, by name: a stored relation's fields as its table holds them and its
 * row checks by the CHECK each is installed as (decide.ts lawChecksOf, the witness's reading); a derived relation's
 * heading and its row checks, each its predicate over the derived row (rowPredicate), which its rule's violation query
 * filters by. A derived row check that does not lower is the schema's CompileError.
 */
const readRelations = (
	model: LawModel
): Result.Result<ReadonlyMap<string, ReadRelation>, CompileError> => {
	const read = new Map<string, ReadRelation>()
	for (const [name, stored] of model.checked.relations) {
		read.set(name, {
			fields: stored.fields.map(witnessField),
			checks: lawChecksOf(model, stored).flatMap(({ laws, test }) =>
				test.kind === "row"
					? laws.flatMap(({ described }) =>
							described.kind === "check"
								? [{ name: described.name, predicate: test.predicate }]
								: []
						)
					: []
			)
		})
	}
	for (const derived of model.checked.derived) {
		const heading = derived.read.heading
		const checks: Array<{ readonly name: string; readonly predicate: ExprTable }> = []
		for (const statement of model.owned.statements) {
			if (statement.kind !== "check" || statement.relation !== derived.name) {
				continue
			}
			const predicate = rowPredicate(model, derived.name, heading, statement.predicate)
			if (!predicate.ok) {
				return predicate
			}
			checks.push({ name: statement.name, predicate: predicate.value })
		}
		read.set(derived.name, {
			fields: heading.map((c): JudgedField => ({
				name: c.name,
				type: c.type,
				writing: { kind: "caller" }
			})),
			checks
		})
	}
	return Result.ok(read)
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
 * fields. The source is a value of the schema's type, so a relation the model does not hold, or a selection over it
 * that does not lower, is a defect.
 */
const prepare = (
	model: LawModel,
	relations: ReadonlyMap<string, ReadRelation>,
	closed: ReturnType<typeof closedTableOf>,
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
	if (!selection.ok) {
		throw defect(`the selection of ${selected.relation}, which its builder admitted over its row`)
	}
	const generated = fields.flatMap((f) =>
		f.writing.kind === "generated" ? [{ name: f.name, expr: f.writing.expr }] : []
	)
	const patterns = [
		...fields.flatMap((f) => typePatterns(f.type)),
		...generated.flatMap((g) => tablePatterns(g.expr)),
		...checks.flatMap((c) => tablePatterns(c.predicate)),
		...tablePatterns(selection.value)
	]
	return {
		table: { fields, lawColumns: new Map() },
		refined: fields.filter((f) => f.writing.kind !== "generated" && isRefined(f.type)),
		generated,
		checks,
		selection: selection.value,
		judge: judgeOf({ closed: [...closed.keys()], patterns }, closed, ProgramPatterns.of(patterns))
	}
}

/**
 * A row as the judge reads it (witness.ts JudgedRow): every field it holds stated, a drawn or accumulated field filled
 * at its value, and no law column, which a row of a source holds none of.
 */
const judgedRow = (row: Readonly<Record<string, unknown>>): JudgedRow => {
	const filled = new Map(
		Object.entries(row).map(([name, value]) => [fieldKey(name), value] as const)
	)
	return {
		kind: "known",
		stated: row,
		filled: (column) =>
			filled.has(column) ? { kind: "filled", value: filled.get(column) } : { kind: "unfilled" }
	}
}

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

/** A row's evaluation as the host builds it, before its keys are read off its source's type (isEvaluationOf). */
interface BuiltEvaluation {
	readonly generated: Readonly<Record<string, Result.Result<unknown, Unevaluated>>>
	readonly checks: Readonly<Record<string, Result.Result<CheckVerdict, Unevaluated>>>
	readonly selected: Result.Result<boolean, Unevaluated>
}

/**
 * The one site of the fact "a built evaluation of a row of R is R's evaluation": its generated values are keyed by R's
 * generated fields and its verdicts by R's check names, which the schema's type of R states and the prepared source
 * reads at run time, a correlation no TypeScript type ties. Its keys are read against the source's, so a value of
 * other keys is a defect.
 */
const isEvaluationOf = <S, R>(
	built: BuiltEvaluation,
	prepared: Prepared
): built is BuiltEvaluation & RowEvaluation<S, R> =>
	Object.keys(built.generated).length === prepared.generated.length &&
	prepared.generated.every((g) => Object.hasOwn(built.generated, g.name)) &&
	prepared.checks.every((c) => Object.hasOwn(built.checks, c.name))

/** Whether a field a domain refused is a field of R's evaluated row: one the row holds. */
const isRowField = <R>(
	row: Readonly<Record<string, unknown>>,
	field: string
): field is keyof EvaluatedRow<R> & string => Object.hasOwn(row, field)

/** One row of a prepared source evaluated (see the header). */
const evaluated = <S, R>(
	prepared: Prepared,
	row: Readonly<Record<string, unknown>>
): Result.Result<RowEvaluation<S, R>, DomainRefused<R>> => {
	const { judge, table } = prepared
	for (const field of prepared.refined) {
		const member = judge.member(hostOf(field.type.carrier, row[field.name]), field.type)
		if (member === undefined) {
			throw defect(`the domain of ${field.name}, a contract and a pattern the host evaluates`)
		}
		if (member) {
			continue
		}
		if (!isRowField<R>(row, field.name)) {
			throw defect(`the domain of a field ${field.name} the row holds`)
		}
		return Result.err({ _tag: "DomainRefused", field: field.name })
	}
	const judged = judgedRow(row)
	const built: BuiltEvaluation = {
		generated: Object.fromEntries(
			prepared.generated.map((g) => [g.name, valueOf(judge.evaluate(table, g.expr, judged))])
		),
		checks: Object.fromEntries(
			prepared.checks.map((c) => [
				c.name,
				Result.map(truthOf(judge.evaluate(table, c.predicate, judged)), verdictOf)
			])
		),
		selected: truthOf(judge.evaluate(table, prepared.selection, judged))
	}
	if (!isEvaluationOf<S, R>(built, prepared)) {
		throw defect("a row's evaluation keyed by its source's generated fields and checks")
	}
	return Result.ok(built)
}

/**
 * rowEvaluator(schema): the host's evaluation of rows of the schema's sources (see the header), its schema compiled and
 * its relations read once, as a function: `const evaluate = rowEvaluator(schema)`, then `evaluate(source, row)` is the
 * row's evaluation, each source read once, where it is first evaluated. A schema that does not compile, a row check of
 * a derived relation among it, is its CompileError.
 */
export const rowEvaluator = <S extends AnySchema>(
	schema: S
): Result.Result<RowEvaluator<S>, CompileError> =>
	Result.flatMap(lawModel(schema, "rowEvaluator"), (model) =>
		Result.map(readRelations(model), (relations): RowEvaluator<S> => {
			const closed = closedTableOf({ schema: model.checked })
			const sources = new WeakMap<object, Prepared>()
			const preparedOf = (source: object): Prepared => {
				const known = sources.get(source)
				if (known !== undefined) {
					return known
				}
				const prepared = prepare(model, relations, closed, source)
				sources.set(source, prepared)
				return prepared
			}
			return <Src extends RowSource<S>>(source: Src, row: EvaluatedRow<SourceRelation<Src>>) =>
				evaluated<S, SourceRelation<Src>>(preparedOf(source), row)
		})
	)
