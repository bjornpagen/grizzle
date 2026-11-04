import type { Case as Notes } from "@grizzle/testing/explore"
import { agree, type Equivalence, type Side } from "@grizzle/testing/oracle"
import {
	Array as Arr,
	Cause,
	Effect,
	Exit,
	Layer,
	Option,
	Record as Rec,
	Result,
	Schema,
	type Scope
} from "effect"
import { type ReferenceObserver, unobserved } from "#test/support/oracle/reference/evaluate.ts"

import {
	type ApplyError,
	OpenError,
	type ReadError,
	ReadFailure,
	StaleSnapshot,
	TransientFailure
} from "#adapter/errors/execution.ts"
import { AdmissionRefused } from "#adapter/errors/failures.ts"
import { type ApplyOutcome, Db } from "#adapter/public/db.ts"
import type { CompiledReadValue, ReaderValue } from "#adapter/reader/reader.ts"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import { CursorError, isCompileError } from "#compiler/core/errors.ts"
import { isRecord } from "#compiler/core/record.ts"
import { nativeEqualityKey } from "#compiler/ir/expr.ts"
import { baseOf, numericTypmodOf, type ScalarType } from "#compiler/ir/scalar.ts"
import {
	mapTree,
	type StatementRoots,
	type StatementTree
} from "#compiler/lower/conservative/types.ts"
import type { CompiledTemplate } from "#compiler/program/template.ts"
import type { AnyRole } from "#compiler/types/schema/world.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import {
	CellDisagreement,
	type SentRow,
	type StrictReader,
	strictReaderOf
} from "#test/pg/oracle/public/cells.ts"
import type { Conversion, Stitch } from "#test/pg/oracle/public/planted.ts"
import type { PublicFeature } from "#test/pg/oracle/public/suite.ts"
import { defined } from "#test/support/assert.ts"
import { type Installed, installMigrated as install } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import type { SpelledValue } from "#test/support/oracle/gen/domain.ts"
import {
	permuted,
	restoredFacts,
	spelledRespelling,
	type StoredRelation
} from "#test/support/oracle/gen/restorage.ts"
import { type FactSet, factStatements } from "#test/support/oracle/install/load.ts"
import { perturbedContext } from "#test/support/oracle/perturb.ts"
import {
	type Answer,
	answerEquivalence,
	answersReport,
	mixedRows,
	mixedShapes,
	type Nested,
	publicRows,
	readBackShape,
	type Shape,
	shapeOf
} from "#test/support/oracle/public/answer.ts"
import { storedInput } from "#test/support/oracle/runner.ts"

import {
	type BuiltSchema,
	buildMixed,
	buildRoot,
	buildSchema,
	factRecord,
	factsChangeSet,
	hostValue,
	type SchemaValue
} from "#test/support/oracle/public/build.ts"
import { brokenDelivery } from "#test/support/oracle/public/delivery.ts"
import { mixedFeatures, programFeatures } from "#test/support/oracle/public/generate.ts"
import {
	expectedHandle,
	expectedKey,
	expectedMixed,
	expectedQuery
} from "#test/support/oracle/public/meaning.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import {
	type ArgTerm,
	type ComputedTerm,
	hasFilter,
	type HeadItem,
	isAggregate,
	type ProgramCase,
	type ProgramField,
	type ParentColumn,
	type Query,
	type ProgramRead,
	sourceFields,
	type StoredFact,
	type Var
} from "#test/support/oracle/public/program.ts"
import { applyRuntime, contextOf, dbReader } from "#test/support/runtime-db.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { loginLayer } from "#test/support/worlds.ts"

/**
 * Which check of the case disagreed: a public answer with the reference's, a cell or a delivered field with its strict
 * reading, a refusal with the one the contract names, the case's setup (install, layer, open, store), or the
 * reference and the language's own proofs.
 */
export type DisagreementCheck = Disagreement["check"]

export class Disagreement extends Schema.TaggedError<
	Disagreement,
	{ readonly brand: unique symbol }
>()("Disagreement", {
	check: Schema.Literals(["answer", "cell", "refusal", "setup", "reference"]),
	report: Schema.String
}) {
	override get message(): string {
		return this.report
	}
}

/** Where a case's features go: the case's own note. */
type Note = Notes<PublicFeature>["note"]

/**
 * A public call's exit, unless the strict reader's cell check died judging what the call read or delivered: that is
 * the cell check's disagreement, never an answer's failure.
 */
const sideExit = <A, E, R>(
	effect: Effect.Effect<A, E, R>
): Effect.Effect<Exit.Exit<A, E>, Disagreement, R> =>
	Effect.flatMap(Effect.exit(effect), (exit) => {
		if (Exit.isFailure(exit)) {
			const defect = Cause.findDefect(exit.cause)
			if (Result.isSuccess(defect) && Schema.is(CellDisagreement)(defect.success)) {
				return Effect.fail(Disagreement.make({ check: "cell", report: defect.success.report }))
			}
		}
		return Effect.succeed(exit)
	})

const describe = (error: unknown): string => {
	if (
		Schema.is(ReadFailure)(error) ||
		Schema.is(TransientFailure)(error) ||
		Schema.is(StaleSnapshot)(error)
	) {
		return `${error._tag}{${error.message}}`
	}
	if (error instanceof CursorError) {
		return `CursorError{reason: ${error.reason._tag}}`
	}
	if (Schema.is(OpenError)(error)) {
		return `${error._tag}{stage: ${error.stage}, reason: ${describe(error.reason)}}`
	}
	if (isCompileError(error)) {
		return `CompileError{${error.message}}`
	}
	if (Schema.is(AdmissionRefused)(error)) {
		return `AdmissionRefused{${Arr.join(
			Arr.map(
				error.mismatches,
				(m) => `${m.stage} ${m.check}: expected ${m.expected}, observed ${m.observed}`
			),
			"; "
		)}}`
	}
	if (Error.isError(error)) {
		return `${error.name}: ${error.message}`
	}
	return String(error)
}

/**
 * What a public call ended with, as an answer's failure: its typed error, or the defect it died with, which the
 * comparison then reports beside the case rather than ending it unprinted.
 */
const ended = (cause: Cause.Cause<unknown>): string =>
	Cause.hasDies(cause)
		? `a defect: ${describe(Cause.squash(cause))}\n${Cause.pretty(cause)}`
		: describe(Cause.squash(cause))

/** A side's rows; its typed failure or defect as a failed answer. */
const answered = <E>(
	rows: Effect.Effect<ReadonlyArray<unknown>, E>,
	shape: Shape
): Effect.Effect<Answer, Disagreement> =>
	Effect.map(sideExit(rows), (exit) =>
		Exit.isSuccess(exit) ? publicRows(shape, exit.value) : Result.fail(ended(exit.cause))
	)

interface Sided {
	readonly side: string
	readonly output: Answer
}

/** The answers must agree with the first, the reference's, under `equivalence`; a disagreement fails the case with
 * every answer. */
const agreeing = (
	c: ProgramCase,
	label: string,
	shape: Shape,
	equivalence: Equivalence<Answer>,
	answers: ReadonlyArray<Sided>
): Effect.Effect<void, Disagreement> => {
	if (!Arr.isReadonlyArrayNonEmpty(answers)) {
		return Effect.void
	}
	const sides = Arr.map(answers, (a): Side<Answer> => [a.side, a.output])
	return Effect.mapError(agree(sides, equivalence), (disagreement) =>
		Disagreement.make({
			check: "answer",
			report: `${label}: ${answersReport(shape, disagreement.message, sides)}\n${printCase(c)}`
		})
	)
}

/** The attachments of a template's statements, by path from the root ("a", "a/g"), and how each is delivered. */
const attachmentForms = (
	compiled: CompiledTemplate
): ReadonlyMap<string, "fused" | "pipelined"> => {
	const forms = new Map<string, "fused" | "pipelined">()
	const under = (
		tree: StatementTree<{ readonly fused: ReadonlyArray<{ readonly name: string }> }>,
		path: ReadonlyArray<string>
	): void => {
		for (const f of tree.statement.fused) {
			forms.set(Arr.join([...path, f.name], "/"), "fused")
		}
		for (const a of tree.attachments) {
			const own = [...path, a.attach.name]
			forms.set(Arr.join(own, "/"), "pipelined")
			under(a, own)
		}
	}
	const roots: StatementRoots<{ readonly fused: ReadonlyArray<{ readonly name: string }> }> =
		compiled.selection.artifact === "optimized"
			? compiled.template.programs.optimized.roots
			: mapTree(compiled.template.programs.conservative.roots, () => ({ fused: [] }))
	for (const tree of roots) {
		under(tree, [])
	}
	return forms
}

/** The parent columns a child binds. */
const parentColumnsOf = (q: Query<ParentColumn>): ReadonlyArray<string> => [
	...new Set(
		Arr.flatMap(q.arms[0].matches, (m) =>
			Arr.flatMap(m.bindings, (b) => (b.operand.kind === "parent" ? [b.operand.column.name] : []))
		)
	)
]

/**
 * Notes the spellings among each attachment's parent keys in a delivery as PostgreSQL sent it (cells.ts SentRow): two
 * parents whose keys are equal by native equality but whose key cells were sent in different spellings, the spellings
 * their facts were stored in, and whether such a key has children, under the form the runtime chose, and over a vector
 * key, whose one twin spelling holds -0 components.
 */
const noteSpellings = (
	q: Query<ParentColumn>,
	rows: ReadonlyArray<SentRow>,
	forms: ReadonlyMap<string, "fused" | "pipelined">,
	path: string,
	note: Note
): void => {
	for (const attachment of q.attachments) {
		const here = path === "" ? attachment.name : `${path}/${attachment.name}`
		const bound = new Set(parentColumnsOf(attachment.child))
		const keyColumns = Arr.filter(q.heading, (c) => bound.has(c.name))
		const byKey = new Map<string, { readonly spellings: Set<string>; children: number }>()
		for (const row of rows) {
			const texts = Arr.map(keyColumns, (c) =>
				defined(row.texts.get(c.name), `the sent cell of ${c.name}`)
			)
			const id = Arr.join(
				Arr.map(keyColumns, (c, k) => sentKey(c.type, defined(texts[k], `the key text ${k}`))),
				"\u0000"
			)
			const group = byKey.get(id) ?? { spellings: new Set<string>(), children: 0 }
			group.spellings.add(Arr.join(texts, "\u0000"))
			group.children += defined(row.children.get(attachment.name), `the sent ${here}`).length
			byKey.set(id, group)
		}
		const form = forms.get(here)
		const vectorKeyed = Arr.some(keyColumns, (c) => baseOf(c.type).carrier === "vector")
		const twice = Arr.filter([...byKey.values()], (group) => group.spellings.size > 1)
		const spelledTwice = Arr.flatMap(twice, (group): ReadonlyArray<PublicFeature> => [
			"two spellings among parent keys",
			...(group.children > 0 && vectorKeyed
				? ["a vector parent key stored with a -0 component" as const]
				: []),
			...(group.children > 0 && form === "pipelined"
				? ["pipelined attachment over two spellings of one parent key" as const]
				: []),
			...(group.children > 0 && form === "fused"
				? ["fused attachment over two spellings of one parent key" as const]
				: [])
		])
		noteAll(note, spelledTwice)
		const children = Arr.flatMap(rows, (row) =>
			defined(row.children.get(attachment.name), `the sent ${here}`)
		)
		noteSpellings(attachment.child, children, forms, here, note)
	}
}

/** The native identity of a sent key cell: its codec's one text of the value the cell spells. */
const sentKey = (type: ScalarType, text: string): string => scalarCodec(type).cellText(text)

/** A stored value's spelling: its one form, or its twin text. */
const spellingOf = (v: SpelledValue): string =>
	v.spelling.kind === "twin" ? `twin ${v.spelling.text}` : "canonical"

/**
 * The fields at which two of the case's facts hold one value in two stored spellings: equal by native equality, written
 * in different input spellings, at a field no typmod coerces to one display scale.
 */
const twiceSpelled = (c: ProgramCase): ReadonlySet<ProgramField> => {
	const out = new Set<ProgramField>()
	for (const r of c.schema.relations) {
		const facts = defined(c.facts.get(r.name), `the facts of ${r.name}`)
		for (const [i, f] of r.fields.entries()) {
			if (numericTypmodOf(f.type) !== undefined) {
				continue
			}
			const spellings = new Map<string, Set<string>>()
			for (const fact of facts) {
				const v = defined(fact[i], `the value of ${r.name}.${f.name}`)
				const key = nativeEqualityKey(v.literal)
				const seen = spellings.get(key) ?? new Set<string>()
				seen.add(spellingOf(v))
				spellings.set(key, seen)
			}
			if (Arr.some([...spellings.values()], (seen) => seen.size > 1)) {
				out.add(f)
			}
		}
	}
	return out
}

/** The field each variable of a rule is first bound at in a match of a stored relation. */
const storedFields = (rule: Rule): ReadonlyMap<number, ProgramField> => {
	const out = new Map<number, ProgramField>()
	for (const m of rule.matches) {
		if (m.source.kind !== "stored") {
			continue
		}
		for (const b of m.bindings) {
			if (b.operand.kind === "var" && !out.has(b.operand.var.id)) {
				out.set(b.operand.var.id, b.field)
			}
		}
	}
	return out
}

const argVars = (a: ArgTerm): ReadonlyArray<Var> => [a.kind === "var" ? a.var : a.padding.arg]

/** The variables a Compute term reads. */
const termVars = (t: ComputedTerm): ReadonlyArray<Var> => {
	switch (t.kind) {
		case "base":
		case "cast numeric":
		case "cond":
			return [t.arg]
		case "padded":
			return [t.padding.arg]
		case "div":
			return argVars(t.dividend)
		case "sqrt":
			return argVars(t.radicand)
		case "power":
			return argVars(t.base)
	}
}

/** What a Compute term reads at the display scale, where it is such a reading: a quotient's, root's or power's operand. */
const termReading = (t: ComputedTerm): ArgTerm | undefined => {
	switch (t.kind) {
		case "div":
			return t.dividend
		case "sqrt":
			return t.radicand
		case "power":
			return t.base
		case "base":
		case "cast numeric":
		case "cond":
		case "padded":
			return undefined
	}
}

/** What a head item reads at the display scale, where it is such a reading: a Compute reading's operand, or a mean's. */
const readingOf = (h: HeadItem): ArgTerm | undefined => {
	switch (h.kind) {
		case "computed":
			return termReading(h.term)
		case "fold":
			return h.fn === "mean" ? h.arg : undefined
		case "var":
		case "count":
		case "literal":
			return undefined
	}
}

/**
 * Whether a rule's delivered rows collapse two facts that hold one value in two stored spellings into one: a single
 * match of a stored relation binding every field it binds to a variable of its own, filtered by nothing, whose rows
 * are the facts projected onto the fields its head reads (every bound field, for an aggregate, whose distinct complete
 * bindings it folds), two of which agree by native equality there while their spellings differ.
 */
const collapses = (c: ProgramCase, rule: Rule): boolean => {
	const [m, ...more] = rule.matches
	const source = m.source
	const vars = Arr.flatMap(m.bindings, (b) => (b.operand.kind === "var" ? [b.operand.var.id] : []))
	if (
		more.length > 0 ||
		hasFilter(rule) ||
		rule.negations.length > 0 ||
		source.kind !== "stored" ||
		vars.length !== m.bindings.length ||
		new Set(vars).size !== vars.length
	) {
		return false
	}
	const fieldOf = storedFields(rule)
	const read = isAggregate(rule)
		? vars
		: Arr.flatMap(rule.head, (h) =>
				h.kind === "var"
					? [h.var.id]
					: h.kind === "computed"
						? Arr.map(termVars(h.term), (v) => v.id)
						: []
			)
	const positions = [
		...new Set(
			Arr.flatMap(read, (id) => {
				const field = fieldOf.get(id)
				return field === undefined ? [] : [source.fields.indexOf(field)]
			})
		)
	]
	if (positions.length === 0) {
		return false
	}
	const groups = new Map<string, Set<string>>()
	for (const fact of defined(c.facts.get(source.name), `the facts of ${source.name}`)) {
		const at = (i: number) => defined(fact[i], `the value of ${source.name} at ${i}`)
		const key = Arr.join(
			Arr.map(positions, (i) => nativeEqualityKey(at(i).literal)),
			"\u0000"
		)
		const spellings = groups.get(key) ?? new Set<string>()
		spellings.add(
			Arr.join(
				Arr.map(positions, (i) => spellingOf(at(i))),
				"\u0000"
			)
		)
		groups.set(key, spellings)
	}
	return Arr.some([...groups.values()], (spellings) => spellings.size > 1)
}

/**
 * The value features of one rule, read off the case's construction, since a delivered value no longer carries the
 * spelling it was stored in: a collapse of two stored spellings of one value; a display-scale reading (a quotient, a
 * root, a power or a mean) over a padding, or over a variable bound where the facts hold one value in two spellings; a
 * padding as a head key, which the head's set semantics collapses; and a mean of a padding.
 */
const ruleValueFeatures = (
	c: ProgramCase,
	spelled: ReadonlySet<ProgramField>,
	rule: Rule
): ReadonlyArray<PublicFeature> => {
	const fieldOf = storedFields(rule)
	const twice = (v: Var): boolean => {
		const field = fieldOf.get(v.id)
		return field !== undefined && spelled.has(field)
	}
	return [
		...(collapses(c, rule) ? ["a collapse over two stored spellings of one value" as const] : []),
		...Arr.flatMap(rule.head, (h): ReadonlyArray<PublicFeature> => {
			const reading = readingOf(h)
			return [
				...(reading !== undefined && (reading.kind === "padded" || twice(reading.var))
					? ["a display-scale reading over a collapsed or padded value" as const]
					: []),
				...(h.kind === "computed" && h.term.kind === "padded"
					? ["a padded term at a collapse" as const]
					: []),
				...(h.kind === "fold" && h.fn === "mean" && h.arg.kind === "padded"
					? ["padded mean" as const]
					: [])
			]
		})
	]
}

/** The value features of every rule of a query: its arms' and, at every depth, its attachments' children's. */
const queryValueFeatures = (
	c: ProgramCase,
	spelled: ReadonlySet<ProgramField>,
	q: Query<ParentColumn>
): ReadonlyArray<PublicFeature> => [
	...Arr.flatMap(q.arms, (rule) => ruleValueFeatures(c, spelled, rule)),
	...Arr.flatMap(q.attachments, (a) => queryValueFeatures(c, spelled, a.child))
]

/** The value features of a case's query and mixed reads (ruleValueFeatures). */
const valueFeatures = (c: ProgramCase): ReadonlyArray<PublicFeature> => {
	const spelled = twiceSpelled(c)
	return Arr.flatMap(c.reads, (read): ReadonlyArray<PublicFeature> => {
		switch (read.kind) {
			case "query":
				return queryValueFeatures(c, spelled, read.query)
			case "mixed":
				return Arr.flatMap(read.root.arms, (arm) => ruleValueFeatures(c, spelled, arm.rule))
			case "key":
			case "handle":
				return []
		}
	})
}

/**
 * The features of a case's program, before anything runs: what its swarm drew, and every program feature of each
 * query read.
 */
const noteProgram = (c: ProgramCase, note: Note): void => {
	noteAll(note, valueFeatures(c))
	for (const kind of c.schema.nameKinds) {
		note(`name ${kind}`)
	}
	for (const setting of c.perturbation.settings) {
		note(`planner ${setting}`)
	}
	for (const r of c.schema.relations) {
		if (r.candidates.length > 0) {
			note("candidate key")
		}
		for (const f of [...r.primaryKey, ...r.candidates.flat()]) {
			note(`key of ${f.kind}`)
		}
	}
	for (const read of c.reads) {
		if (read.kind === "handle") {
			note("key get closed")
			continue
		}
		if (read.kind === "key") {
			note(read.candidate ? "key get candidate" : "key get primary")
			continue
		}
		if (read.kind === "mixed") {
			note("union")
			noteAll(note, mixedFeatures(read.root))
			continue
		}
		const q = read.query
		if (q.arms.length > 1) {
			note("union")
		}
		if (q.bound.kind === "take") {
			note("take")
		}
		if (q.delivery.kind === "ordered") {
			note("ordered")
		}
		if (q.heading.length === 0) {
			note("zero-column head")
		}
		if (read.params.length > 0) {
			note("parameter")
		}
		noteQuery(q, note)
		noteAll(note, programFeatures(q))
	}
}

/** Notes each of `features`. */
const noteAll = (note: Note, features: Iterable<PublicFeature>): void => {
	for (const f of features) {
		note(f)
	}
}

type Rule = Query<ParentColumn>["arms"][number]

/** A match's features: a roster's, an existential one's, and each binding's operand. */
const noteMatch = (m: Rule["matches"][number], note: Note): void => {
	if (m.source.kind === "roster") {
		note("roster match")
	}
	if (m.bindings.length < sourceFields(m.source).length) {
		note("existential")
	}
	for (const b of m.bindings) {
		note(`bind ${b.operand.kind}`)
	}
}

/** A head item's feature: an aggregate's. */
const noteHead = (h: Rule["head"][number], note: Note): void => {
	switch (h.kind) {
		case "count":
			note("aggregate count")
			return
		case "fold":
			note(`aggregate ${h.fn}`)
			return
		case "var":
		case "computed":
		case "literal":
			return
	}
}

const noteQuery = (q: Query<ParentColumn>, note: Note): void => {
	for (const rule of q.arms) {
		for (const m of rule.matches) {
			noteMatch(m, note)
		}
		for (const w of rule.where) {
			note(`compare ${w.op} ${w.right.kind}`)
		}
		if (rule.negations.length > 0) {
			note("negation")
		}
		for (const h of rule.head) {
			noteHead(h, note)
		}
	}
	for (const a of q.attachments) {
		note(q.attachments.length > 1 ? "attachments, several" : "attachment")
		note(`stated ${a.delivery.kind}`)
		if (a.child.attachments.length > 0) {
			note("attachment nested")
		}
		noteQuery(a.child, note)
	}
}

/**
 * Notes which way the reference delivered each arm to its parents: Some where the parent's field holds the handle,
 * None where it holds another.
 */
const noteArms = (shape: Shape, rows: ReadonlyArray<Nested>, note: Note): void => {
	for (const row of rows) {
		noteRowArms(shape, row, note)
	}
}

/** Notes which way the reference delivered each arm of one row to its parents, and of its children. */
const noteRowArms = (shape: Shape, row: Nested, note: Note): void => {
	for (const [i, a] of shape.attachments.entries()) {
		const children = row.attachments[i] ?? []
		if (a.delivery.kind === "arm") {
			note(children.length > 0 ? "arm some" : "arm none")
		}
		noteArms(a.shape, children, note)
	}
}

/** The host values of a read's parameters: each scalar one's value, each relation parameter's rows as records. */
const hostParams = (
	read: Extract<ProgramRead, { readonly kind: "query" }>
): Readonly<Record<string, unknown>> =>
	Rec.fromEntries([
		...Arr.map(read.params, (p): readonly [string, unknown] => [
			p.name,
			hostValue(p.value, p.type)
		]),
		...Arr.map(read.relations, (r): readonly [string, unknown] => [
			r.name,
			Arr.map(r.rows, (fact) => factRecord(r.relation, fact))
		])
	])

/** A refusal must be its typed error, and nothing else. */
const refused = (
	c: ProgramCase,
	what: string,
	exit: Exit.Exit<unknown, unknown>,
	expected: (error: unknown) => boolean
): Effect.Effect<void, Disagreement> => {
	if (Exit.isFailure(exit) && expected(Cause.squash(exit.cause))) {
		return Effect.void
	}
	const got = Exit.isSuccess(exit) ? "an answer" : Cause.pretty(exit.cause)
	return Effect.fail(
		Disagreement.make({
			check: "refusal",
			report: `${what} was not refused as the contract names: ${got}\n${printCase(c)}`
		})
	)
}

/**
 * What a db.get over a query read: refused before any SQL as not proved at most one row, or an answer: its one row or
 * none, or the failure or defect it died with.
 */
type Gotten =
	| { readonly kind: "refused" }
	| { readonly kind: "answered"; readonly output: Answer; readonly got: "some" | "none" | "failed" }

const gotten = (shape: Shape, exit: Exit.Exit<Option.Option<unknown>, ReadError>): Gotten => {
	if (Exit.isSuccess(exit)) {
		const rows = Option.isSome(exit.value) ? [exit.value.value] : []
		return {
			kind: "answered",
			output: publicRows(shape, rows),
			got: rows.length > 0 ? "some" : "none"
		}
	}
	const error = Cause.squash(exit.cause)
	return !Cause.hasDies(exit.cause) && Schema.is(ReadFailure)(error) && error.stage === "compile"
		? { kind: "refused" }
		: { kind: "answered", output: Result.fail(ended(exit.cause)), got: "failed" }
}

/**
 * Pages of an ordered root, walked by `page` with requests of `size` in one direction, concatenated in order. Every
 * page but the last holds `size` rows and says there is another; the last says there is none.
 */
const walk = (
	page: (request: unknown) => Effect.Effect<unknown, ReadError | CursorError>,
	size: number,
	direction: "forward" | "backward",
	shape: Shape,
	bound: number
): Effect.Effect<Answer, Disagreement> =>
	Effect.gen(function* () {
		const pages: Array<ReadonlyArray<unknown>> = []
		let cursor: Option.Option<string> = Option.none()
		for (let n = 0; ; n++) {
			if (n > bound) {
				return Result.fail(`the ${direction} pages never end`)
			}
			const request = Option.match(cursor, {
				onNone: () => (direction === "forward" ? { first: size } : { last: size }),
				onSome: (at) =>
					direction === "forward" ? { first: size, after: at } : { last: size, before: at }
			})
			const got = yield* sideExit(page(request))
			if (Exit.isFailure(got)) {
				return Result.fail(ended(got.cause))
			}
			const p = got.value
			if (!isRecord(p) || !Arr.isArray(p["edges"]) || !isRecord(p["pageInfo"])) {
				return Result.fail("a page that is no { edges, pageInfo }")
			}
			const nodes = Arr.map(p["edges"], (e: unknown) => (isRecord(e) ? e["node"] : undefined))
			const more =
				direction === "forward" ? p["pageInfo"]["hasNextPage"] : p["pageInfo"]["hasPreviousPage"]
			const next =
				direction === "forward" ? p["pageInfo"]["endCursor"] : p["pageInfo"]["startCursor"]
			pages.push(nodes)
			if (more !== true) {
				break
			}
			if (nodes.length !== size) {
				return Result.fail(
					`page ${n} holds ${nodes.length} rows of ${size} and says there are more`
				)
			}
			if (!Option.isOption(next) || Option.isNone(next) || typeof next.value !== "string") {
				return Result.fail(`page ${n} says there are more and gives no cursor`)
			}
			cursor = Option.some(next.value)
		}
		const ordered = direction === "forward" ? pages : Arr.reverse([...pages])
		return publicRows(shape, ordered.flat())
	})

/** db.apply of a ChangeSet value, with no parameters beyond those it binds. */
type Applier = (changes: unknown) => Effect.Effect<ApplyOutcome<unknown>, ApplyError>

const isList = (value: unknown): value is ReadonlyArray<unknown> => Arr.isArray(value)

/** The name of the one read-back a query read's ChangeSet carries. */
const readBackName = "readBack"

/**
 * A query read as a ChangeSet's read-back: db.apply of the ChangeSet of no write that reads the query back, its
 * parameters bound, and the read-back's rows of its outcome in the delivery a read-back reads (readBackShape).
 */
const readBackAnswer = (
	apply: Applier,
	value: SchemaValue,
	query: unknown,
	params: Readonly<Record<string, unknown>>,
	shape: Shape
): Effect.Effect<Answer, Disagreement> =>
	Effect.map(
		sideExit(
			Effect.suspend(() => {
				const read = changeSetOver.empty(value).read(readBackName, () => query)
				return apply(Rec.keys(params).length > 0 ? read.bind(params) : read)
			})
		),
		(exit): Answer => {
			if (Exit.isFailure(exit)) {
				return Result.fail(ended(exit.cause))
			}
			const outcome = exit.value
			if (outcome.kind !== "accepted" && outcome.kind !== "no-change") {
				return Result.fail(`the read-back's apply was ${outcome.kind}`)
			}
			const rows = isRecord(outcome.reads) ? outcome.reads[readBackName] : undefined
			return isList(rows)
				? publicRows(readBackShape(shape), rows)
				: Result.fail("an outcome without its read-back")
		}
	)

/** The reference observer that notes each of its declines by its reason (reference/values.ts DeclineReason). */
const observing = (note: Note): ReferenceObserver => ({
	...unobserved,
	decline: (reason) => note(`declined ${reason}`)
})

/** A read's second reading: it must answer exactly as the read first did. */
type Reading = Effect.Effect<void, Disagreement>

/** A read's second reading, made once the case's facts are stored otherwise (runCase). */
type Again = () => Reading

/**
 * A query read's second reading: db.execute and the perturbed reader over the facts stored otherwise, each exactly
 * db.execute's first answer, `first`.
 */
const queryAgain = (
	c: ProgramCase,
	reader: ReaderValue,
	perturbed: StrictReader,
	read: Extract<ProgramRead, { readonly kind: "query" }>,
	q: unknown,
	params: Readonly<Record<string, unknown>>,
	label: string,
	first: Answer,
	stitch: Stitch
): Reading =>
	Effect.gen(function* () {
		const shape = shapeOf(read.query)
		const plain = yield* answered(
			Effect.flatMap(reader.execute(q, params), (r) => r.collect),
			shape
		)
		const planned = yield* answered(
			Effect.flatMap(perturbed.execute(q, params), (r) => r.collect),
			shape
		)
		const sent = perturbed.sentRows()
		yield* agreeing(
			c,
			`${label}, read again over its facts stored otherwise`,
			shape,
			answerEquivalence(shape, read.query.delivery.kind === "ordered"),
			[
				{ side: "db.execute", output: first },
				{ side: "db.execute, read again", output: plain },
				{
					side: "db.execute under the planner perturbation, read again",
					output: Result.map(planned, (rows) => stitch(rows, read.query, sent))
				}
			]
		)
	})

/**
 * One query read through every public form, against the reference and against itself, and its second reading
 * (queryAgain).
 *
 * The program states only deliveries its language proves (delivery.ts): the reference's children per parent keep
 * each one, or the proof is wrong.
 */
const queryRead = (
	c: ProgramCase,
	reader: ReaderValue,
	perturbed: StrictReader,
	apply: Applier,
	built: BuiltSchema,
	value: SchemaValue,
	read: Extract<ProgramRead, { readonly kind: "query" }>,
	index: number,
	note: Note,
	stitch: Stitch
): Effect.Effect<Again, Disagreement> =>
	Effect.gen(function* () {
		const label = `read ${index}`
		const q = buildRoot(built, value, read.query)
		const params = hostParams(read)
		const shape = shapeOf(read.query)
		const inOrder = read.query.delivery.kind === "ordered"
		const expected = yield* Effect.try({
			try: () => expectedQuery(c, read, observing(note)),
			catch: (e) =>
				Disagreement.make({
					check: "reference",
					report: `${label}: the reference could not evaluate the program: ${describe(e)}\n${printCase(c)}`
				})
		})
		if (Result.isSuccess(expected)) {
			const broken = brokenDelivery(shape, expected.success)
			if (Option.isSome(broken)) {
				return yield* Disagreement.make({
					check: "reference",
					report: `${label}: the language proves a delivery the reference breaks: ${broken.value}\n${printCase(c)}`
				})
			}
			noteArms(shape, expected.success, note)
		}
		const probe = read.probe
		switch (probe.kind) {
			case "encode": {
				const exit = yield* sideExit(
					Effect.flatMap(
						reader.execute(q, { ...params, [probe.param.name]: { wild: true } }),
						(r) => r.collect
					)
				)
				yield* refused(
					c,
					`${label}: a parameter of another host type`,
					exit,
					(e) => Schema.is(ReadFailure)(e) && e.stage === "encode"
				)
				note("refused encode")
				break
			}
			case "page size": {
				const exit = yield* sideExit(reader.page(q, params, { first: probe.size }))
				yield* refused(
					c,
					`${label}: a page of ${probe.size} rows`,
					exit,
					(e) => Schema.is(ReadFailure)(e) && e.stage === "request"
				)
				note("refused page size")
				break
			}
			case "cursor": {
				const first = yield* sideExit(reader.page(q, params, { first: 1 }))
				const cursor =
					Exit.isSuccess(first) && Option.isSome(first.value.pageInfo.endCursor)
						? `${first.value.pageInfo.endCursor.value}~`
						: "not a cursor"
				const exit = yield* sideExit(reader.page(q, params, { first: 1, after: cursor }))
				yield* refused(
					c,
					`${label}: a cursor its codec cannot read`,
					exit,
					(e) => e instanceof CursorError
				)
				note("refused cursor")
				break
			}
			case "none":
				break
		}
		const result = yield* sideExit(reader.execute(q, params))
		const execute = Exit.isSuccess(result)
			? yield* answered(result.value.collect, shape)
			: Result.fail(ended(result.cause))
		const again = Exit.isSuccess(result) ? yield* answered(result.value.collect, shape) : execute
		const compiled = yield* sideExit(reader.compile(q))
		const executed = (handle: CompiledReadValue) =>
			answered(
				Effect.flatMap(handle.execute(params), (r) => r.collect),
				shape
			)
		const compiledOnce = Exit.isSuccess(compiled)
			? yield* executed(compiled.value)
			: Result.fail(ended(compiled.cause))
		const compiledTwice = Exit.isSuccess(compiled) ? yield* executed(compiled.value) : compiledOnce
		/**
		 * The Db's own reader over its context with the case's planner settings set in every transaction it opens, every
		 * cell it reads read strictly (cells.ts): a read whose statements share one snapshot (an attachment's) runs under
		 * another plan.
		 */
		const planned = yield* answered(
			Effect.flatMap(perturbed.execute(q, params), (r) => r.collect),
			shape
		)
		/** The perturbed execute's rows as PostgreSQL sent them, row for row with its delivery. */
		const sent = perturbed.sentRows()
		const readBack = yield* readBackAnswer(apply, value, q, params, shape)
		const strictlyCompiled = yield* sideExit(perturbed.compile(q))
		const strictlyExecuted = Exit.isSuccess(strictlyCompiled)
			? yield* executed(strictlyCompiled.value)
			: Result.fail(ended(strictlyCompiled.cause))
		const answers: Array<Sided> = [
			{ side: "reference", output: expected },
			{ side: "db.execute", output: execute },
			{ side: "db.execute, collected again", output: again },
			{
				side: "db.execute under the planner perturbation",
				output: Result.map(planned, (rows) => stitch(rows, read.query, sent))
			},
			{ side: "db.compile, executed", output: compiledOnce },
			{ side: "db.compile, executed again", output: compiledTwice },
			{ side: "db.compile under the planner perturbation, executed", output: strictlyExecuted },
			{ side: "db.apply's read-back", output: readBack }
		]
		/**
		 * get answers where the query is proved at most one row, and is refused before any SQL where it is not; a second
		 * row from a query proved to have at most one is a defect, which the comparison reports as get's answer. Both
		 * readers answer or both refuse.
		 */
		const plainExit = yield* sideExit(reader.get(q, params))
		const plainGet = gotten(shape, plainExit)
		const strictExit = yield* sideExit(perturbed.get(q, params))
		const strictGet = gotten(shape, strictExit)
		if (plainGet.kind === "refused") {
			note("get refused: not proved at most one row")
		} else if (plainGet.got !== "failed") {
			note(`get ${plainGet.got}`)
		}
		if (plainGet.kind !== strictGet.kind) {
			return yield* Disagreement.make({
				check: "answer",
				report: `${label}: db.get ${plainGet.kind} and under the planner perturbation ${strictGet.kind}\n${printCase(c)}`
			})
		}
		if (plainGet.kind === "answered") {
			answers.push({ side: "db.get", output: plainGet.output })
		}
		if (strictGet.kind === "answered") {
			answers.push({ side: "db.get under the planner perturbation", output: strictGet.output })
		}
		if (read.query.delivery.kind === "ordered") {
			const size = read.query.delivery.pageSize
			const bound = (Result.isSuccess(expected) ? expected.success.length : 0) + 2
			const forward = yield* walk(
				(request) => reader.page(q, params, request),
				size,
				"forward",
				shape,
				bound
			)
			const backward = Exit.isSuccess(compiled)
				? yield* walk(
						(request) => compiled.value.page(params, request),
						size,
						"backward",
						shape,
						bound
					)
				: compiledOnce
			const strictForward = yield* walk(
				(request) => perturbed.page(q, params, request),
				size,
				"forward",
				shape,
				bound
			)
			const strictBackward = Exit.isSuccess(strictlyCompiled)
				? yield* walk(
						(request) => strictlyCompiled.value.page(params, request),
						size,
						"backward",
						shape,
						bound
					)
				: strictlyExecuted
			answers.push(
				{ side: "db.page forward", output: forward },
				{ side: "db.compile's page backward", output: backward },
				{ side: "db.page forward under the planner perturbation", output: strictForward },
				{
					side: "db.compile's page backward under the planner perturbation",
					output: strictBackward
				}
			)
			note("page")
			if (Result.isSuccess(expected) && expected.success.length > size) {
				note("pages, several")
			}
		}
		/**
		 * Every side, the reference, the read-back and the perturbed reader among them, delivers the same values
		 * exactly: grizzle delivers each value in its one form, whatever the plan, the storage order or the spelling
		 * stored, so one exact check judges them all (answer.ts answerEquivalence).
		 */
		const sameValues = answerEquivalence(shape, inOrder)
		yield* agreeing(c, label, shape, sameValues, answers)
		/**
		 * And against itself, with no reference in the judgment: every public side delivers exactly what db.execute
		 * delivers, the perturbed plans' among them, which judges every column the reference declines.
		 */
		const publicSides = Arr.filter(answers, (a) => a.side !== "reference")
		yield* agreeing(c, `${label}, against itself`, shape, sameValues, publicSides)
		/** The spellings are read off the cells PostgreSQL sent the perturbed reader, as their facts stored them. */
		const template = Exit.isSuccess(compiled) ? compiled.value.compiled : undefined
		if (template !== undefined && Result.isSuccess(planned)) {
			const forms = attachmentForms(template)
			for (const form of new Set(forms.values())) {
				note(`attachment ${form}`)
			}
			noteSpellings(read.query, sent, forms, "", note)
		}
		return () => queryAgain(c, reader, perturbed, read, q, params, label, execute, stitch)
	}).pipe(Effect.scoped)

/**
 * One mixed root, a union whose arms find different heads, read through db.execute, the perturbed reader and db.compile,
 * against the reference per heading group: each delivered row is read strictly as a row of the group whose columns are
 * exactly its keys (answer.ts mixedRows), and each group's rows are judged as queryRead judges a query's.
 */
const mixedRead = (
	c: ProgramCase,
	reader: ReaderValue,
	perturbed: ReaderValue,
	built: BuiltSchema,
	value: SchemaValue,
	read: Extract<ProgramRead, { readonly kind: "mixed" }>,
	index: number,
	note: Note
): Effect.Effect<Again, Disagreement> =>
	Effect.gen(function* () {
		const label = `read ${index}`
		const q = buildMixed(built, value, read.root)
		const expected = yield* Effect.try({
			try: () => expectedMixed(c, read.root, observing(note)),
			catch: (e) =>
				Disagreement.make({
					check: "reference",
					report: `${label}: the reference could not evaluate the mixed root: ${describe(e)}\n${printCase(c)}`
				})
		})
		/** A side's rows per heading group; its typed failure or defect as every group's failed answer. */
		const grouped = <E>(rows: Effect.Effect<ReadonlyArray<unknown>, E>) =>
			Effect.map(
				sideExit(rows),
				(exit): Result.Result<ReadonlyArray<ReadonlyArray<Nested>>, string> =>
					Exit.isSuccess(exit) ? mixedRows(read.root, exit.value) : Result.fail(ended(exit.cause))
			)
		const compiled = yield* sideExit(reader.compile(q))
		const executed = yield* grouped(Effect.flatMap(reader.execute(q, {}), (r) => r.collect))
		const sides = [
			{ side: "db.execute", output: executed },
			{
				side: "db.execute under the planner perturbation",
				output: yield* grouped(Effect.flatMap(perturbed.execute(q, {}), (r) => r.collect))
			},
			{
				side: "db.compile, executed",
				output: Exit.isSuccess(compiled)
					? yield* grouped(Effect.flatMap(compiled.value.execute({}), (r) => r.collect))
					: Result.fail(ended(compiled.cause))
			}
		]
		/** Each heading group's answers agree, `reference` first where it is given. */
		const judged = (
			against: string,
			reference: Option.Option<ReadonlyArray<Answer>>,
			sided: ReadonlyArray<{
				readonly side: string
				readonly output: Result.Result<ReadonlyArray<ReadonlyArray<Nested>>, string>
			}>
		): Effect.Effect<void, Disagreement> =>
			Effect.forEach(
				mixedShapes(read.root),
				(shape, g) => {
					const groupOf = (groups: ReadonlyArray<ReadonlyArray<Nested>>): ReadonlyArray<Nested> =>
						defined(groups[g], `heading group ${g}`)
					const stated: ReadonlyArray<Sided> = Option.match(reference, {
						onNone: () => [],
						onSome: (answers) => [
							{
								side: "reference",
								output: defined(answers[g], `the reference's heading group ${g}`)
							}
						]
					})
					return agreeing(
						c,
						`${label}, heading group ${g}${against}`,
						shape,
						answerEquivalence(shape, false),
						[
							...stated,
							...Arr.map(sided, (s) => ({ side: s.side, output: Result.map(s.output, groupOf) }))
						]
					)
				},
				{ discard: true }
			)
		yield* judged("", Option.some(expected), sides)
		yield* judged(", against itself", Option.none(), sides)
		return () =>
			Effect.gen(function* () {
				yield* judged(", read again over its facts stored otherwise", Option.none(), [
					{ side: "db.execute", output: executed },
					{
						side: "db.execute, read again",
						output: yield* grouped(Effect.flatMap(reader.execute(q, {}), (r) => r.collect))
					},
					{
						side: "db.execute under the planner perturbation, read again",
						output: yield* grouped(Effect.flatMap(perturbed.execute(q, {}), (r) => r.collect))
					}
				])
			})
	}).pipe(Effect.scoped)

/** A keyed db.get's answer: its one fact or none, or the failure or defect it died with. */
const keyed = (shape: Shape, exit: Exit.Exit<Option.Option<unknown>, ReadError>): Answer =>
	Exit.isSuccess(exit)
		? publicRows(shape, Option.isSome(exit.value) ? [exit.value.value] : [])
		: Result.fail(ended(exit.cause))

/**
 * A keyed read's second reading: db.get through the plain and the perturbed reader over the facts stored otherwise,
 * each exactly db.get's first answer, `first`.
 */
const getAgain = (
	c: ProgramCase,
	label: string,
	shape: Shape,
	first: Answer,
	readers: { readonly plain: ReaderValue; readonly perturbed: ReaderValue },
	get: (reader: ReaderValue) => Effect.Effect<Option.Option<unknown>, ReadError>
): Reading =>
	Effect.gen(function* () {
		const plainExit = yield* sideExit(get(readers.plain))
		const plain = keyed(shape, plainExit)
		const perturbedExit = yield* sideExit(get(readers.perturbed))
		const planned = keyed(shape, perturbedExit)
		yield* agreeing(
			c,
			`${label}, read again over its facts stored otherwise`,
			shape,
			answerEquivalence(shape, false),
			[
				{ side: "db.get", output: first },
				{ side: "db.get, read again", output: plain },
				{ side: "db.get under the planner perturbation, read again", output: planned }
			]
		)
	})

/** One keyed read: db.get over a primary key or a candidate key, against the facts, and its second reading. */
const keyRead = (
	c: ProgramCase,
	reader: ReaderValue,
	perturbed: ReaderValue,
	built: BuiltSchema,
	read: Extract<ProgramRead, { readonly kind: "key" }>,
	index: number,
	note: Note
): Effect.Effect<Again, Disagreement> =>
	Effect.gen(function* () {
		const shape: Shape = { columns: read.relation.fields, attachments: [] }
		const target = read.candidate
			? built.candidate(read.relation, [
					read.key[0].name,
					...Arr.map(read.key.slice(1), (f) => f.name)
				])
			: built.relation(read.relation)
		const values: Record<string, unknown> = {}
		for (const [i, f] of read.key.entries()) {
			const literal = read.values[i]
			if (literal === undefined) {
				throw new Error(`the keyed read has no value for ${f.name}`)
			}
			values[f.name] = hostValue(literal, f.type)
		}
		const got = yield* sideExit(reader.get(target, values))
		if (Exit.isSuccess(got)) {
			note(Option.isSome(got.value) ? "key get some" : "key get none")
		}
		const first = keyed(shape, got)
		const exit = yield* sideExit(perturbed.get(target, values))
		yield* agreeing(c, `read ${index}`, shape, answerEquivalence(shape, false), [
			{ side: "reference", output: expectedKey(c, read) },
			{ side: "db.get", output: first },
			{
				side: "db.get under the planner perturbation",
				output: keyed(shape, exit)
			}
		])
		return () =>
			getAgain(c, `read ${index}`, shape, first, { plain: reader, perturbed }, (r) =>
				r.get(target, values)
			)
	})

/**
 * One read of the closed roster: db.get(roster, { id }), which a closed relation's key ["id"] answers, and its second
 * reading, which no stored fact can move.
 */
const handleRead = (
	c: ProgramCase,
	reader: ReaderValue,
	perturbed: ReaderValue,
	built: BuiltSchema,
	read: Extract<ProgramRead, { readonly kind: "handle" }>,
	index: number,
	note: Note
): Effect.Effect<Again, Disagreement> =>
	Effect.gen(function* () {
		const shape: Shape = { columns: [c.schema.roster.id], attachments: [] }
		const got = yield* sideExit(reader.get(built.roster, { id: read.handle }))
		if (Exit.isSuccess(got) && Option.isSome(got.value)) {
			note("key get closed some")
		}
		const first = keyed(shape, got)
		const exit = yield* sideExit(perturbed.get(built.roster, { id: read.handle }))
		yield* agreeing(c, `read ${index}`, shape, answerEquivalence(shape, false), [
			{ side: "reference", output: expectedHandle(read) },
			{ side: "db.get", output: first },
			{
				side: "db.get under the planner perturbation",
				output: keyed(shape, exit)
			}
		])
		return () =>
			getAgain(c, `read ${index}`, shape, first, { plain: reader, perturbed }, (r) =>
				r.get(built.roster, { id: read.handle })
			)
	})

/** Whether a stored fact holds a twin spelling, which db.apply cannot store: it stores every value in its one form. */
const spelledFacts = (c: ProgramCase): boolean =>
	Arr.some([...c.facts.values()], (facts) =>
		Arr.some(facts, (fact) => Arr.some(fact, (v) => v.spelling.kind === "twin"))
	)

/** The case's facts as the oracle loader's records, each value in the spelling its fact drew (runner.ts storedInput). */
const directFacts = (c: ProgramCase): FactSet =>
	Rec.fromEntries(
		Arr.map(
			c.schema.relations,
			(r): readonly [string, ReadonlyArray<Readonly<Record<string, unknown>>>] => [
				r.name,
				Arr.map(c.facts.get(r.name) ?? [], (fact) =>
					Rec.fromEntries(
						Arr.map(r.fields, (f, i): readonly [string, unknown] => [
							f.name,
							storedInput(defined(fact[i], `the value of ${r.name}.${f.name}`), f.type)
						])
					)
				)
			]
		)
	)

/**
 * Stores the case's facts through a direct SQL writer, as the README's direct-writer contract admits one: a session of
 * the case's login that takes on its role and writes every fact in one SERIALIZABLE transaction, each value in the input
 * spelling its fact drew, so the database holds two spellings of one value where the case planted them.
 */
const storeDirectly = (
	c: ProgramCase,
	done: Installed,
	role: AnyRole
): Effect.Effect<void, Disagreement, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const unstored = (e: unknown) =>
			Disagreement.make({
				check: "setup",
				report: `the direct writer did not store the facts: ${describe(e)}\n${printCase(c)}`
			})
		const statements = factStatements(done.plan, directFacts(c))
		if (!statements.ok) {
			return yield* unstored(statements.error)
		}
		const substrate = yield* Substrate
		yield* Effect.mapError(
			Effect.gen(function* () {
				const writer = yield* substrate.session(worldSession(done.world(role)))
				yield* writer.begin
				for (const sql of statements.value) {
					yield* writer.query(sql, [])
				}
				yield* writer.commit
			}),
			unstored
		)
	})

/** The case with its facts stored otherwise by its restorage (gen/restorage.ts restoredFacts), and what that moved. */
const restoredProgram = (
	c: ProgramCase
): { readonly case: ProgramCase; readonly reordered: boolean; readonly respelled: boolean } => {
	const restored = restoredFacts(
		Arr.map(c.schema.relations, (r): StoredRelation<SpelledValue> => ({
			name: r.name,
			columns: Arr.map(r.fields, (f) => spelledRespelling(f.type)),
			rows: defined(c.facts.get(r.name), `the facts of ${r.name}`)
		})),
		permuted,
		c.restorage
	)
	return {
		case: {
			...c,
			facts: new Map(
				Arr.map(restored.relations, (r): readonly [string, ReadonlyArray<StoredFact>] => [
					r.name,
					r.rows
				])
			)
		},
		reordered: restored.reordered,
		respelled: restored.respelled
	}
}

/**
 * Stores the case's facts afresh for its second reading: every stored relation truncated in one SERIALIZABLE
 * transaction of the installation's owner (substrate/replace.ts replaceRows), whose TRUNCATE reads no row, then every
 * fact written again by the case's direct SQL writer (storeDirectly), in its restored order and spelling.
 */
const restore = (
	c: ProgramCase,
	done: Installed,
	role: AnyRole
): Effect.Effect<void, Disagreement, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		yield* Effect.mapError(
			replaceRows(substrate.admin, installationGroup(namesOf(done)), []),
			(e) =>
				Disagreement.make({
					check: "setup",
					report: `the facts were not truncated for their second reading: ${describe(e)}\n${printCase(c)}`
				})
		)
		yield* storeDirectly(c, done, role)
	})

/** Stores the case's facts through db.apply of the ChangeSet inserting them: accepted, each relation's facts added. */
const store = <R, P>(
	c: ProgramCase,
	db: Db<R, P>,
	built: BuiltSchema,
	value: SchemaValue
): Effect.Effect<void, Disagreement> =>
	Effect.gen(function* () {
		const changes = factsChangeSet(c, built, value)
		if (Option.isNone(changes)) {
			return
		}
		const exit = yield* sideExit(applyRuntime(db, changes.value, {}))
		const outcome = Exit.isSuccess(exit) ? exit.value : undefined
		const counted =
			outcome?.kind === "accepted" &&
			Arr.every(c.schema.relations, (r) => {
				const facts = BigInt((c.facts.get(r.name) ?? []).length)
				const added = Option.map(
					Arr.findFirst(outcome.counts, (n) => n.relation === r.name),
					(n) => n.added
				)
				return facts === 0n
					? Option.getOrElse(added, () => 0n) === 0n
					: Option.contains(added, facts)
			})
		if (!counted) {
			const answer =
				outcome === undefined
					? Exit.isFailure(exit)
						? Cause.pretty(exit.cause)
						: "no outcome"
					: outcome.kind === "accepted"
						? `accepted, adding ${Arr.join(
								Arr.map(outcome.counts, (n) => `${n.added} to ${n.relation}`),
								", "
							)}`
						: outcome.kind
			return yield* Disagreement.make({
				check: "setup",
				report: `db.apply did not store the facts: ${answer}\n${printCase(c)}`
			})
		}
	})

/**
 * One case through grizzle's public runtime, judged against the reference.
 *
 * Rule: grizzle runs the case exactly as an application deploys and reads it.
 *
 * 1. The schema, built by the public constructors (build.ts), is installed through its first migration
 *    (test/support/install-migrate.ts): `grizzle migrate generate` drafts it and `grizzle migrate apply` runs it as the
 *    migration identity, so the catalog is a deployment's.
 * 2. A DbLayer of the case's login is built, and Db.open admits the database as its full role (build.ts): a login
 *    taking on a world role with only its derived grants, never the owner, so its search path and privileges are an
 *    application's.
 * 3. The facts are stored by db.apply of the ChangeSet that inserts them, which must accept every one, or, where a
 *    fact holds a twin spelling, which db.apply cannot store, by a direct SQL writer of the case's role at
 *    SERIALIZABLE, each value as its fact spells it.
 * 4. Every read runs through every public form that answers it, each compared with the reference's answer under the
 *    contract's equivalence (answer.ts):
 *    - a query: db.execute, its result collected twice, db.compile executed twice, db.get, which answers when the
 *      query is proved at most one row and is otherwise refused before any SQL, and, for an ordered root, db.page
 *      forward and the compiled handle's page backward, the pages concatenated, every page but the last full;
 *    - a keyed lookup: db.get over a relation's primary key or a key(...)'s candidate key, an Option of the fact;
 *    - each of them again under the case's planner settings (perturb.ts, which reach every read that opens a
 *      transaction), through a reader that reads every cell text strictly and compares every field it delivers with
 *      its cell (cells.ts);
 *    - a query as a ChangeSet's read-back, db.apply of a ChangeSet that writes nothing and reads the query back, in
 *      the delivery a read-back reads; its rows must also be spelled exactly as the strict reader's execute.
 *    A refusal probe runs first (program.ts Probe) and must be its typed error, and the reads after it answer as
 *    before. Each attachment states a delivery its program proves (delivery.ts): the reference's children per parent
 *    must keep it, and every public form must deliver exactly it, an Option, the one child or an arm's Some and None
 *    as its parent's handle selects (answer.ts).
 * 5. Every read is judged against itself too, with no reference in the judgment, which judges every column the
 *    reference declines (answer.ts unstated): every public side exactly as db.execute, under both plans (the plan
 *    relation); and once every read has answered, the facts are stored again otherwise (ProgramCase.restorage: another
 *    storage order through a fresh load, one value in its next twin spelling) and every read is read again, through
 *    the plain and the perturbed reader, exactly as it first answered (the storage-order and twin-spelling relations).
 *
 * The case's features (features.ts) are noted as it runs: the program's shapes, how the runtime delivered each
 * attachment (fused into its parent's statement or pipelined as one of its own, read off the template it ran), the
 * spellings among each attachment's parent keys, and every refusal.
 *
 * Runs one case, noting its features, its Db connecting to the server. The perturbed reader checks every cell text
 * against `conversion`, and every delivered field against its cell (cells.ts). The case's scope holds its installation
 * and its Db.
 */
export const runCase = (
	c: ProgramCase,
	note: Note,
	stitch: Stitch,
	conversion: Conversion
): Effect.Effect<void, Disagreement, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		noteProgram(c, note)
		const built = buildSchema(c.schema)
		const unready = (what: string) => (e: unknown) =>
			Disagreement.make({ check: "setup", report: `${what}: ${describe(e)}\n${printCase(c)}` })
		const done = yield* Effect.mapError(
			install(built.schema, {
				ambient: c.ambient,
				label: "real",
				logins: [built.world.server],
				extensions: []
			}),
			unready("the schema did not install")
		)
		const value = built.installedAs(done.schema)
		const world = built.worldAs(done.schema)
		const context = yield* Effect.mapError(
			Layer.build(loginLayer(done, world.server)),
			unready("the DbLayer refused its config")
		)
		const db = yield* Db.open(world.server.roles.app, {}).pipe(
			Effect.provideContext(context),
			Effect.mapError(unready("Db.open refused the installation"))
		)
		if (spelledFacts(c)) {
			note("facts by a direct writer")
			yield* storeDirectly(c, done, world.server.roles.app.role)
		} else {
			yield* store(c, db, built, value)
		}
		const reader = dbReader(db)
		const apply: Applier = (changes) => applyRuntime(db, changes, {})
		const perturbed = strictReaderOf(perturbedContext(contextOf(db), c.perturbation), conversion)
		const again: Array<Again> = []
		for (const [i, read] of c.reads.entries()) {
			if (read.kind === "key") {
				const reread = yield* keyRead(c, reader, perturbed, built, read, i, note)
				again.push(reread)
			} else if (read.kind === "handle") {
				const reread = yield* handleRead(c, reader, perturbed, built, read, i, note)
				again.push(reread)
			} else if (read.kind === "mixed") {
				const reread = yield* mixedRead(c, reader, perturbed, built, value, read, i, note)
				again.push(reread)
			} else {
				const reread = yield* queryRead(
					c,
					reader,
					perturbed,
					apply,
					built,
					value,
					read,
					i,
					note,
					stitch
				)
				again.push(reread)
			}
		}
		const restored = restoredProgram(c)
		if (restored.reordered) {
			note("facts reordered on a second reading")
		}
		if (restored.respelled) {
			note("a fact respelled on a second reading")
		}
		yield* restore(restored.case, done, world.server.roles.app.role)
		for (const readAgain of again) {
			yield* readAgain()
		}
	})
