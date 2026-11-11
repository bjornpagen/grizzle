import type { Case as Notes } from "@grizzle/testing/explore"
import { agree, type Equivalence, type Side } from "@grizzle/testing/oracle"
import {
	Array as Arr,
	Cause,
	Data,
	Effect,
	Exit,
	Formatter,
	Option,
	Predicate,
	Record as Rec,
	Result,
	type Scope
} from "effect"
import { memberCalls, type WrittenOutcome } from "#adapter/db/handles.ts"
import type { StatementRoots, StatementTree } from "#compiler/runtime/lower/tree.ts"
import { type ValueIdentity, sameIdentity } from "#test/support/kernel/identity.ts"
import { type ReferenceObserver, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { valueIdentity } from "#test/support/oracle/reference/values.ts"

import { OpenError } from "#adapter/errors/execution.ts"
import type { HostParams } from "#adapter/reader/execution.ts"
import type { DecodedRow } from "#adapter/reader/stream.ts"
import { isCompileError } from "#compiler/core/errors.ts"
import { isRecord } from "#compiler/core/record.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { nativeEqualityKey } from "#compiler/ir/expr.ts"
import { baseOf, numericTypmodOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { Anchor, CallError, CallErrorKind, Entry } from "#compiler/live/index.ts"
import { pagedMember } from "#compiler/program/workload/value.ts"
import type { AnyRole } from "#compiler/types/schema/world.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import {
	CellDisagreement,
	freshCodesOf,
	type ReadCalls,
	type ReadValue,
	readCalls,
	type SentRow,
	strictReaderOf
} from "#test/pg/oracle/public/cells.ts"
import type { PublicFeature } from "#test/pg/oracle/public/suite.ts"
import { defined, succeeded } from "#test/support/assert.ts"
import { compileTemplate, installedCodes, testCompile } from "#test/support/compile.ts"
import type { OracleTemplate } from "#test/support/conservative.ts"
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

import { scalarReader } from "#compiler/codec/read.ts"
import { rowsOf, writeOnce } from "#test/support/calls.ts"
import {
	type BuiltSchema,
	buildMixed,
	buildRoot,
	buildSchema,
	factRecord,
	factRows,
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
	deliveredOrder,
	hasFilter,
	type HeadItem,
	isAggregate,
	type OrderKey,
	type ProgramCase,
	type ProgramField,
	type ParentColumn,
	type Query,
	type ProgramRead,
	type Root,
	sourceFields,
	type StoredFact,
	type Var
} from "#test/support/oracle/public/program.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { outputText } from "#test/support/wire.ts"

/**
 * Which check of the case disagreed: a public answer with the reference's, a cell or a delivered field with its strict
 * reading, a refusal with the one the contract names, the case's setup (install, layer, open, store), the reference and
 * the language's own proofs, or a root delivered in an order whose statements state none.
 */
type DisagreementCheck = "answer" | "cell" | "refusal" | "setup" | "reference" | "order"

class Disagreement extends Data.TaggedError("Disagreement")<{
	readonly check: DisagreementCheck
	readonly report: string
}> {
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
			if (Result.isSuccess(defect) && defect.success instanceof CellDisagreement) {
				return Effect.fail(new Disagreement({ check: "cell", report: defect.success.report }))
			}
		}
		return Effect.succeed(exit)
	})

const describe = (error: unknown): string => {
	if (
		Predicate.hasProperty(error, "kind") &&
		Predicate.hasProperty(error, "retry") &&
		Predicate.hasProperty(error, "message")
	) {
		return `${String(error.kind)}{${String(error.message)}}`
	}
	if (error instanceof OpenError) {
		return `${error._tag}{stage: ${error.stage}, reason: ${describe(error.reason)}}`
	}
	if (isCompileError(error)) {
		return `CompileError{${error.message}}`
	}
	if (Error.isError(error)) {
		return `${error.name}: ${error.message}`
	}
	return String(error)
}

/** A case's setup refused where its served login compiles or opens, as the setup's disagreement. */
const servedRefusal = (c: ProgramCase, what: string, error: unknown): Disagreement =>
	new Disagreement({
		check: "setup",
		report: `${what}: ${error instanceof OpenError ? describe(error) : Formatter.format(error)}\n${printCase(c)}`
	})

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
	return Effect.mapError(
		agree(sides, equivalence),
		(disagreement) =>
			new Disagreement({
				check: "answer",
				report: `${label}: ${answersReport(shape, disagreement.message, sides)}\n${printCase(c)}`
			})
	)
}

/** The attachments of a template's statements, by path from the root ("a", "a/g"), and how each is delivered. */
const attachmentForms = (template: OracleTemplate): ReadonlyMap<string, "fused" | "pipelined"> => {
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
		template.programs.optimized.roots
	for (const tree of roots) {
		under(tree, [])
	}
	return forms
}

/**
 * The artifacts of a template whose delivered relations leave their rows unordered. PostgreSQL delivers rows in an
 * order only under an ORDER BY, whatever plan it picks, so a root delivered in an order states one in every delivered
 * statement of the conservative artifact, and in the optimized one's one part, or numbers each of its delivered parts'
 * rows in it (lower/parts.ts TaggedPart): an order the rows arrive in only by the plan's grace is no delivery.
 */
const unorderedArtifacts = (
	template: OracleTemplate
): ReadonlyArray<"optimized" | "conservative"> => {
	const optimized = template.programs.optimized
	const parts = optimized.parts
	const optimizedOrdered =
		parts.kind === "one"
			? parts.delivered.ast.orderBy.length > 0
			: Arr.every(
					optimized.roots,
					(tree) => parts.parts[tree.statement.answer]?.kind === "numbered"
				)
	const conservativeOrdered = Arr.every(
		template.programs.conservative.roots,
		(tree) => tree.statement.ast.orderBy.length > 0
	)
	return [
		...(optimizedOrdered ? [] : (["optimized"] as const)),
		...(conservativeOrdered ? [] : (["conservative"] as const))
	]
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
const sentKey = (type: ScalarType, text: string): string =>
	scalarReader(type, freshCodesOf(type)).cellText(outputText(text))

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

/**
 * Notes each attached take whose order decides what a parent receives, by the expected delivery: two children or more
 * under one parent, and among them two the take's first key, descending, orders apart.
 */
const noteTakes = (q: Query<ParentColumn>, rows: ReadonlyArray<Nested>, note: Note): void => {
	for (const row of rows) {
		for (const [i, a] of q.attachments.entries()) {
			const children = row.attachments[i] ?? []
			const bound = a.child.bound
			if (bound.kind === "take" && children.length > 1) {
				note("an attached take of two children or more")
				const [first] = bound.order
				const at = Arr.findFirstIndex(a.child.heading, (c) => c.name === first.column.name)
				const keyAt = (child: Nested): ValueIdentity | undefined => {
					const v = Option.isSome(at) ? child.values[at.value] : undefined
					return v === undefined ? undefined : valueIdentity(v, first.column.type)
				}
				/** Whether two children hold one identity at the key's column, or neither holds one. */
				const tiedAt = (x: Nested, y: Nested): boolean => {
					const a = keyAt(x)
					const b = keyAt(y)
					return a === undefined || b === undefined
						? a === undefined && b === undefined
						: sameIdentity(a, b)
				}
				if (
					first.dir === "desc" &&
					Arr.some(children, (child, k) => {
						const before = children[k - 1]
						return before !== undefined && !tiedAt(before, child)
					})
				) {
					note("an attached take delivered descending")
				}
			}
			noteTakes(a.child, children, note)
		}
	}
}

/**
 * Notes a root take whose order decides what its caller receives, by the expected delivery: two rows or more, two of
 * them ordered apart by the take's first key, descending, and two its stated keys tie, which the take's completion
 * orders (program.ts takeOrder).
 */
const noteRootTake = (q: Root, rows: ReadonlyArray<Nested>, note: Note): void => {
	const bound = q.bound
	if (bound.kind !== "take" || q.delivery.kind !== "set" || rows.length < 2) {
		return
	}
	note("a root take of two rows or more")
	/** A row's value at a key's column by its identity under native equality (valueIdentity). */
	const identityAt = (row: Nested, key: OrderKey): ValueIdentity | undefined =>
		Option.match(
			Arr.findFirstIndex(q.heading, (c) => c.name === key.column.name),
			{
				onNone: () => undefined,
				onSome: (i) => {
					const v = row.values[i]
					return v === undefined ? undefined : valueIdentity(v, key.column.type)
				}
			}
		)
	const tied = (a: Nested, b: Nested, key: OrderKey): boolean => {
		const x = identityAt(a, key)
		const y = identityAt(b, key)
		return x !== undefined && y !== undefined && sameIdentity(x, y)
	}
	const [first] = bound.order
	const adjacent = Arr.zip(rows, Arr.drop(rows, 1))
	if (first.dir === "desc" && Arr.some(adjacent, ([a, b]) => !tied(a, b, first))) {
		note("a root take descending")
	}
	if (Arr.some(adjacent, ([a, b]) => Arr.every(bound.order, (key) => tied(a, b, key)))) {
		note("a root take with tied order keys")
	}
}

/**
 * The host values of a read's parameters, by name: each scalar one's value, each relation parameter's rows as records,
 * the case's own data as a member's parameters.
 */
const hostRecord = (read: Extract<ProgramRead, { readonly kind: "query" }>): HostParams =>
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

/** A refusal must be a CallError of its kind, and nothing else. */
const refused = (
	c: ProgramCase,
	what: string,
	exit: Exit.Exit<unknown, CallError>,
	expected: CallErrorKind
): Effect.Effect<void, Disagreement> => {
	if (Option.exists(Exit.findErrorOption(exit), (error) => error.kind === expected)) {
		return Effect.void
	}
	const got = Exit.isSuccess(exit) ? "an answer" : Cause.pretty(exit.cause)
	return Effect.fail(
		new Disagreement({
			check: "refusal",
			report: `${what} was not refused as the contract names: ${got}\n${printCase(c)}`
		})
	)
}

/**
 * What a query read's value says of its one row (live/keyed.ts): refused as not proved at most one row where its served
 * key names a field, since a value keyed by no field is the value of at most one row (served/forms.ts ServedKey), or an
 * answer: its one row or none, or the failure or defect it died with.
 */
type Gotten =
	| { readonly kind: "refused" }
	| { readonly kind: "answered"; readonly output: Answer; readonly got: "some" | "none" | "failed" }

const gotten = (shape: Shape, exit: Exit.Exit<ReadValue, CallError>): Gotten => {
	if (Exit.isFailure(exit)) {
		return { kind: "answered", output: Result.fail(ended(exit.cause)), got: "failed" }
	}
	if (exit.value.fields.length > 0) {
		return { kind: "refused" }
	}
	const rows = [...exit.value]
	return {
		kind: "answered",
		output: publicRows(shape, rows),
		got: rows.length > 0 ? "some" : "none"
	}
}

/**
 * Windows of an ordered root, walked by `window` `size` rows at a time in one direction, from its start forward or from
 * its end backward, each anchored at the key of the last row the one before reached, until a window answers no row;
 * concatenated in order. A window holds at most `size` rows, and one that holds fewer is the last that holds any.
 */
const walk = (
	window: (window: unknown) => Effect.Effect<ReadValue, CallError>,
	size: number,
	direction: "forward" | "backward",
	shape: Shape,
	bound: number
): Effect.Effect<Answer, Disagreement> =>
	Effect.gen(function* () {
		const windows: Array<ReadonlyArray<unknown>> = []
		let anchor: Anchor = direction === "forward" ? { kind: "start" } : { kind: "end" }
		let short = false
		for (let n = 0; ; n++) {
			if (n > bound) {
				return Result.fail(`the ${direction} windows never end`)
			}
			const got: Exit.Exit<ReadValue, CallError> = yield* sideExit(window({ anchor, size }))
			if (Exit.isFailure(got)) {
				return Result.fail(ended(got.cause))
			}
			const entries: ReadonlyArray<Entry<DecodedRow>> = [...got.value.entries()]
			const edge: Option.Option<Entry<DecodedRow>> =
				direction === "forward" ? Arr.last(entries) : Arr.head(entries)
			if (Option.isNone(edge)) {
				break
			}
			if (entries.length > size) {
				return Result.fail(`window ${n} holds ${entries.length} rows of ${size}`)
			}
			if (short) {
				return Result.fail(`window ${n} holds rows after a window of fewer than ${size}`)
			}
			short = entries.length < size
			windows.push(Arr.map(entries, (entry) => entry.row))
			anchor =
				direction === "forward"
					? { kind: "after", key: edge.value.key }
					: { kind: "before", key: edge.value.key }
		}
		const ordered = direction === "forward" ? windows : Arr.reverse([...windows])
		return publicRows(shape, ordered.flat())
	})

const isList = (value: unknown): value is ReadonlyArray<unknown> => Arr.isArray(value)

/** The name of the one read-back a query read's ChangeSet carries. */
const readBackName = "readBack"

/**
 * The ChangeSet of no write that reads `query` back under readBackName, its parameters bound to `params`: a query read's
 * read-back member.
 */
const readBackChangeSet = (
	value: SchemaValue,
	query: unknown,
	params: Readonly<Record<string, unknown>>
): unknown => {
	const read = changeSetOver.empty(value).read(readBackName, () => query)
	return Rec.keys(params).length > 0 ? read.bind(params) : read
}

/**
 * A query read as a ChangeSet's read-back: its read-back member applied (readBackChangeSet), and the read-back's rows of
 * its outcome in the delivery a read-back reads (readBackShape).
 */
const readBackAnswer = (
	back: Effect.Effect<WrittenOutcome, CallError>,
	shape: Shape
): Effect.Effect<Answer, Disagreement> =>
	Effect.map(sideExit(back), (exit): Answer => {
		if (Exit.isFailure(exit)) {
			return Result.fail(ended(exit.cause))
		}
		const outcome = exit.value
		if (outcome.kind !== "accepted" && outcome.kind !== "unchanged") {
			return Result.fail(`the read-back's apply was ${outcome.kind}`)
		}
		const rows = isRecord(outcome.reads) ? outcome.reads[readBackName] : undefined
		return isList(rows)
			? publicRows(readBackShape(shape), rows)
			: Result.fail("an outcome without its read-back")
	})

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
 * A query read's second reading: its member's once and the strict one's over the facts stored otherwise, each
 * exactly the first once's answer, `first`.
 */
const queryAgain = (
	c: ProgramCase,
	members: Members,
	name: string,
	read: Extract<ProgramRead, { readonly kind: "query" }>,
	params: HostParams,
	label: string,
	first: Answer
): Reading =>
	Effect.gen(function* () {
		const shape = shapeOf(read.query)
		const plain = yield* answered(rowsOf(members.plain(name).read(params)), shape)
		const planned = yield* answered(rowsOf(members.strict(name).read(params)), shape)
		yield* agreeing(
			c,
			`${label}, read again over its facts stored otherwise`,
			shape,
			answerEquivalence(shape, Option.isSome(deliveredOrder(read.query))),
			[
				{ side: "once", output: first },
				{ side: "once, read again", output: plain },
				{ side: "once under the planner perturbation, read again", output: planned }
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
	members: Members,
	codes: Codebook,
	built: BuiltSchema,
	value: SchemaValue,
	read: Extract<ProgramRead, { readonly kind: "query" }>,
	index: number,
	note: Note
): Effect.Effect<Again, Disagreement> =>
	Effect.gen(function* () {
		const label = `read ${index}`
		const name = readMember(index)
		const plain = members.plain(name)
		const strict = members.strict(name)
		const params = hostRecord(read)
		const shape = shapeOf(read.query)
		const inOrder = Option.isSome(deliveredOrder(read.query))
		const expected = yield* Effect.try({
			try: () => expectedQuery(c, read, observing(note)),
			catch: (e) =>
				new Disagreement({
					check: "reference",
					report: `${label}: the reference could not evaluate the program: ${describe(e)}\n${printCase(c)}`
				})
		})
		if (Result.isSuccess(expected)) {
			const broken = brokenDelivery(shape, expected.success)
			if (Option.isSome(broken)) {
				return yield* new Disagreement({
					check: "reference",
					report: `${label}: the language proves a delivery the reference breaks: ${broken.value}\n${printCase(c)}`
				})
			}
			noteArms(shape, expected.success, note)
			noteTakes(read.query, expected.success, note)
			noteRootTake(read.query, expected.success, note)
		}
		const probe = read.probe
		switch (probe.kind) {
			case "encode": {
				const exit = yield* sideExit(plain.read({ ...params, [probe.param.name]: { wild: true } }))
				yield* refused(c, `${label}: a parameter of another host type`, exit, "input")
				note("refused encode")
				break
			}
			case "page size": {
				const exit = yield* sideExit(
					plain.window(params, { anchor: { kind: "start" }, size: probe.size })
				)
				yield* refused(c, `${label}: a window of ${probe.size} rows`, exit, "input")
				note("refused page size")
				break
			}
			case "anchor": {
				const first = yield* sideExit(plain.window(params, { anchor: { kind: "start" }, size: 1 }))
				const key: ReadonlyArray<unknown> = Exit.isSuccess(first)
					? Option.match(Arr.head([...first.value.entries()]), {
							onNone: () => [],
							onSome: (entry) => [...entry.key, "~"]
						})
					: []
				const exit = yield* sideExit(
					plain.window(params, { anchor: { kind: "after", key }, size: 1 })
				)
				yield* refused(c, `${label}: an anchor of another length than its order's`, exit, "input")
				note("refused anchor")
				break
			}
			case "none":
				break
		}
		const result = yield* sideExit(plain.read(params))
		const execute = Exit.isSuccess(result)
			? publicRows(shape, [...result.value])
			: Result.fail(ended(result.cause))
		const again = Exit.isSuccess(result) ? publicRows(shape, [...result.value]) : execute
		/**
		 * The read's optimized and conservative artifacts, compiled as the served file's compile compiles its query, over
		 * the installed schema and its codes: the order a root is delivered in is stated in its statements or nowhere.
		 */
		const template = succeeded(
			compileTemplate(buildRoot(built, value, read.query), undefined, {
				...testCompile,
				codes: installedCodes(codes)
			}),
			"the read's template"
		)
		const unordered = unorderedArtifacts(template)
		if (inOrder && Arr.isReadonlyArrayNonEmpty(unordered)) {
			return yield* new Disagreement({
				check: "order",
				report: `${label}: delivered in an order, its ${Arr.join(unordered, " and ")} statements state no ORDER BY\n${printCase(c)}`
			})
		}
		const executed = (calls: ReadCalls) => answered(rowsOf(calls.read(params)), shape)
		const executedAgain = yield* executed(plain)
		/**
		 * The member over the Db's context with the case's planner settings set in every transaction it opens, every
		 * cell it reads read strictly (cells.ts): a read whose statements share one snapshot (an attachment's) runs under
		 * another plan.
		 */
		const planned = yield* executed(strict)
		/** The perturbed once's rows as PostgreSQL sent them, row for row with its delivery. */
		const sent = members.sentRows()
		const readBack = yield* readBackAnswer(members.back(backMember(index)), shape)
		const strictlyAgain = yield* executed(strict)
		const answers: Array<Sided> = [
			{ side: "reference", output: expected },
			{ side: "once", output: execute },
			{ side: "once, its value read again", output: again },
			{ side: "once under the planner perturbation", output: planned },
			{ side: "once again", output: executedAgain },
			{ side: "once under the planner perturbation, again", output: strictlyAgain },
			{ side: "the read-back member's once", output: readBack }
		]
		/**
		 * The one row of a value keyed by no field, a query proved at most one row, and none where its value is keyed by
		 * a field (gotten); a second row from a query proved to have at most one is a defect, which the comparison
		 * reports as the one row's answer. Both readers answer or both refuse.
		 */
		const plainExit = yield* sideExit(plain.read(params))
		const plainGet = gotten(shape, plainExit)
		const strictExit = yield* sideExit(strict.read(params))
		const strictGet = gotten(shape, strictExit)
		if (plainGet.kind === "refused") {
			note("get refused: not proved at most one row")
		} else if (plainGet.got !== "failed") {
			note(`get ${plainGet.got}`)
		}
		if (plainGet.kind !== strictGet.kind) {
			return yield* new Disagreement({
				check: "answer",
				report: `${label}: get ${plainGet.kind} and under the planner perturbation ${strictGet.kind}\n${printCase(c)}`
			})
		}
		if (plainGet.kind === "answered") {
			answers.push({ side: "the one row", output: plainGet.output })
		}
		if (strictGet.kind === "answered") {
			answers.push({ side: "the one row under the planner perturbation", output: strictGet.output })
		}
		if (read.query.delivery.kind === "ordered") {
			const size = read.query.delivery.pageSize
			const bound = (Result.isSuccess(expected) ? expected.success.length : 0) + 2
			const forward = yield* walk(
				(window) => plain.window(params, window),
				size,
				"forward",
				shape,
				bound
			)
			const backward = yield* walk(
				(window) => plain.window(params, window),
				size,
				"backward",
				shape,
				bound
			)
			const strictForward = yield* walk(
				(window) => strict.window(params, window),
				size,
				"forward",
				shape,
				bound
			)
			const strictBackward = yield* walk(
				(window) => strict.window(params, window),
				size,
				"backward",
				shape,
				bound
			)
			answers.push(
				{ side: "windows forward", output: forward },
				{ side: "windows backward", output: backward },
				{ side: "windows forward under the planner perturbation", output: strictForward },
				{ side: "windows backward under the planner perturbation", output: strictBackward }
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
		 * And against itself, with no reference in the judgment: every public side delivers exactly what once delivers,
		 * the perturbed plans' among them, which judges every column the reference declines.
		 */
		const publicSides = Arr.filter(answers, (a) => a.side !== "reference")
		yield* agreeing(c, `${label}, against itself`, shape, sameValues, publicSides)
		if (Result.isSuccess(planned)) {
			/** The spellings are read off the cells PostgreSQL sent the perturbed reader, as their facts stored them. */
			const forms = attachmentForms(template)
			for (const form of new Set(forms.values())) {
				note(`attachment ${form}`)
			}
			noteSpellings(read.query, sent, forms, "", note)
		}
		return () => queryAgain(c, members, name, read, params, label, execute)
	}).pipe(Effect.scoped)

/**
 * One mixed root, a union whose arms find different heads, read through its member's once, twice, and the strict
 * one's, against the reference per heading group: each delivered row is read strictly as a row of the group whose
 * columns are exactly its keys (answer.ts mixedRows), and each group's rows are judged as queryRead judges a query's.
 */
const mixedRead = (
	c: ProgramCase,
	members: Members,
	read: Extract<ProgramRead, { readonly kind: "mixed" }>,
	index: number,
	note: Note
): Effect.Effect<Again, Disagreement> =>
	Effect.gen(function* () {
		const label = `read ${index}`
		const name = readMember(index)
		const expected = yield* Effect.try({
			try: () => expectedMixed(c, read.root, observing(note)),
			catch: (e) =>
				new Disagreement({
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
		const rows = (calls: ReadCalls) => calls.read({}).pipe(rowsOf, grouped)
		const executed = yield* rows(members.plain(name))
		const sides = [
			{ side: "once", output: executed },
			{
				side: "once under the planner perturbation",
				output: yield* rows(members.strict(name))
			},
			{ side: "once again", output: yield* rows(members.plain(name)) }
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
					{ side: "once", output: executed },
					{ side: "once, read again", output: yield* rows(members.plain(name)) },
					{
						side: "once under the planner perturbation, read again",
						output: yield* rows(members.strict(name))
					}
				])
			})
	}).pipe(Effect.scoped)

/** A key member's answer: its value's one fact or none, or the failure or defect it died with. */
const keyed = (shape: Shape, exit: Exit.Exit<ReadValue, CallError>): Answer =>
	Exit.isSuccess(exit) ? publicRows(shape, [...exit.value]) : Result.fail(ended(exit.cause))

/**
 * A keyed read's second reading: its key member's once and the strict one's over the facts stored otherwise, each
 * exactly the first once's answer, `first`.
 */
const getAgain = (
	c: ProgramCase,
	label: string,
	shape: Shape,
	first: Answer,
	members: Members,
	name: string,
	values: HostParams
): Reading =>
	Effect.gen(function* () {
		const plainExit = yield* sideExit(members.plain(name).read(values))
		const plain = keyed(shape, plainExit)
		const perturbedExit = yield* sideExit(members.strict(name).read(values))
		const planned = keyed(shape, perturbedExit)
		yield* agreeing(
			c,
			`${label}, read again over its facts stored otherwise`,
			shape,
			answerEquivalence(shape, false),
			[
				{ side: "once", output: first },
				{ side: "once, read again", output: plain },
				{ side: "once under the planner perturbation, read again", output: planned }
			]
		)
	})

/** The key member of a keyed read: its relation, for its primary key, or the Key of its candidate key. */
const keyTargetOf = (
	built: BuiltSchema,
	read: Extract<ProgramRead, { readonly kind: "key" }>
): unknown =>
	read.candidate
		? built.candidate(read.relation, [
				read.key[0].name,
				...Arr.map(read.key.slice(1), (f) => f.name)
			])
		: built.relation(read.relation)

/** One keyed read: its key member's once over a primary key or a candidate key, against the facts, and its second reading. */
const keyRead = (
	c: ProgramCase,
	members: Members,
	read: Extract<ProgramRead, { readonly kind: "key" }>,
	index: number,
	note: Note
): Effect.Effect<Again, Disagreement> =>
	Effect.gen(function* () {
		const shape: Shape = { columns: read.relation.fields, attachments: [] }
		const name = readMember(index)
		const record: Record<string, unknown> = {}
		for (const [i, f] of read.key.entries()) {
			const literal = read.values[i]
			if (literal === undefined) {
				throw new Error(`the keyed read has no value for ${f.name}`)
			}
			record[f.name] = hostValue(literal, f.type)
		}
		const values: HostParams = record
		const got = yield* sideExit(members.plain(name).read(values))
		if (Exit.isSuccess(got)) {
			note(got.value.size > 0 ? "key get some" : "key get none")
		}
		const first = keyed(shape, got)
		const exit = yield* sideExit(members.strict(name).read(values))
		yield* agreeing(c, `read ${index}`, shape, answerEquivalence(shape, false), [
			{ side: "reference", output: expectedKey(c, read) },
			{ side: "once", output: first },
			{
				side: "once under the planner perturbation",
				output: keyed(shape, exit)
			}
		])
		return () => getAgain(c, `read ${index}`, shape, first, members, name, values)
	})

/**
 * One read of the closed roster: its key member's once with params { id }, which a closed relation's key ["id"]
 * answers, and its second reading, which no stored fact can move.
 */
const handleRead = (
	c: ProgramCase,
	members: Members,
	read: Extract<ProgramRead, { readonly kind: "handle" }>,
	index: number,
	note: Note
): Effect.Effect<Again, Disagreement> =>
	Effect.gen(function* () {
		const shape: Shape = { columns: [c.schema.roster.id], attachments: [] }
		const name = readMember(index)
		const values: HostParams = { id: read.handle }
		const got = yield* sideExit(members.plain(name).read(values))
		if (Exit.isSuccess(got) && got.value.size > 0) {
			note("key get closed some")
		}
		const first = keyed(shape, got)
		const exit = yield* sideExit(members.strict(name).read(values))
		yield* agreeing(c, `read ${index}`, shape, answerEquivalence(shape, false), [
			{ side: "reference", output: expectedHandle(read) },
			{ side: "once", output: first },
			{
				side: "once under the planner perturbation",
				output: keyed(shape, exit)
			}
		])
		return () => getAgain(c, `read ${index}`, shape, first, members, name, values)
	})

/** Whether a stored fact holds a twin spelling, which a change member cannot store: it stores every value in its one form. */
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
			new Disagreement({
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
				new Disagreement({
					check: "setup",
					report: `the facts were not truncated for their second reading: ${describe(e)}\n${printCase(c)}`
				})
		)
		yield* storeDirectly(c, done, role)
	})

/** The member that stores a case's facts (build.ts factsChangeSet), its rows each call's own (factRows). */
const storeMember = "store"

/**
 * Stores the case's facts through its store member, the ChangeSet inserting them, each relation's rows supplied by the
 * call under its insert: accepted, each relation's facts added.
 */
const store = (c: ProgramCase, members: Members): Effect.Effect<void, Disagreement> =>
	Effect.gen(function* () {
		const rows = factRows(c)
		if (!Arr.isReadonlyArrayNonEmpty(rows)) {
			return
		}
		const facts = {
			insert: Rec.fromEntries(Arr.map(rows, (r) => [r.relation.name, r.rows] as const))
		}
		const exit = yield* sideExit(members.store(storeMember, facts))
		const outcome = Exit.isSuccess(exit) ? exit.value : undefined
		const counted =
			outcome?.kind === "accepted" &&
			Arr.every(c.schema.relations, (r) => {
				const held = BigInt((c.facts.get(r.name) ?? []).length)
				const added = Option.map(
					Arr.findFirst(outcome.counts, (n) => n.relation === r.name),
					(n) => n.added
				)
				return held === 0n ? Option.getOrElse(added, () => 0n) === 0n : Option.contains(added, held)
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
			return yield* new Disagreement({
				check: "setup",
				report: `the store member did not store the facts: ${answer}\n${printCase(c)}`
			})
		}
	})

/** The member a read reads through, by its position among the case's reads. */
const readMember = (index: number): string => `read${index}`

/** The read-back member of a query read, by its position among the case's reads (readBackChangeSet). */
const backMember = (index: number): string => `back${index}`

/**
 * The case's programs, each a member of its role's workload under its name: every read's (a query, an ordered root as a
 * paged member, a key, the roster's key, a mixed root), every query read's read-back, and the store of its facts where
 * a relation holds any.
 */
const casePrograms = (
	c: ProgramCase,
	built: BuiltSchema,
	value: SchemaValue
): Readonly<Record<string, unknown>> => {
	const programs: Record<string, unknown> = {}
	for (const [i, read] of c.reads.entries()) {
		switch (read.kind) {
			case "query": {
				const q = buildRoot(built, value, read.query)
				programs[readMember(i)] = read.query.delivery.kind === "ordered" ? pagedMember(q) : q
				programs[backMember(i)] = readBackChangeSet(value, q, hostRecord(read))
				break
			}
			case "key":
				programs[readMember(i)] = keyTargetOf(built, read)
				break
			case "handle":
				programs[readMember(i)] = built.roster
				break
			case "mixed":
				programs[readMember(i)] = buildMixed(built, value, read.root)
				break
		}
	}
	const changes = factsChangeSet(c, built, value)
	if (Option.isSome(changes)) {
		programs[storeMember] = changes.value
	}
	return programs
}

/**
 * A case's members as its reads run them, each by its name: on the Db's pool, and through the strict reader under the
 * case's planner settings (cells.ts), whose last read's rows as PostgreSQL sent them `sentRows` gives; and the store,
 * the member that stores the case's facts with each call's rows.
 */
interface Members {
	readonly plain: (name: string) => ReadCalls
	readonly strict: (name: string) => ReadCalls
	readonly sentRows: () => ReadonlyArray<SentRow>
	/** The read-back member `name`'s once, its parameters bound in its ChangeSet. */
	readonly back: (name: string) => Effect.Effect<WrittenOutcome, CallError>
	readonly store: (
		name: string,
		facts: { readonly insert: Readonly<Record<string, ReadonlyArray<unknown>>> }
	) => Effect.Effect<WrittenOutcome, CallError>
}

/**
 * One case through grizzle's public runtime, judged against the reference.
 *
 * Rule: grizzle runs the case exactly as an application deploys and reads it.
 *
 * 1. The schema, built by the public constructors (build.ts), is installed through its first migration
 *    (test/support/install-migrate.ts): `grizzle migrate generate` drafts it and `grizzle migrate apply` runs it as the
 *    migration identity, so the catalog is a deployment's.
 * 2. Every program of the case is a member of its full role's workload (casePrograms): every read, every query read's
 *    read-back, and the store of its facts, compiled into the login's served file under the snapshot the migration
 *    reached by the one compile `grizzle generate` runs, and the Db opens through that login's served layer
 *    (test/support/served-db.ts withServedDb): a login taking on a world role with only its derived grants, never the
 *    owner, so its search path and privileges are an application's.
 * 3. The facts are stored by the store member, the ChangeSet that inserts them, each relation's rows the call's own,
 *    which must accept every one, or, where a fact holds a twin spelling, which a change member cannot store, by a
 *    direct SQL writer of the case's role at SERIALIZABLE, each value as its fact spells it.
 * 4. Every read runs through every call of its member that answers it, each compared with the reference's
 *    answer under the contract's equivalence (answer.ts):
 *    - a query: its member's once (an ordered root's, a paged member's, the window of its every row), its value read
 *      twice, and once again, its one row where its value is keyed by no field, a query proved at most one row, and,
 *      for an ordered root, its windows forward and backward, concatenated, every window but the last that holds rows
 *      full;
 *    - a keyed lookup: a key member's once over a relation's primary key or a key(...)'s candidate key, its value of
 *      the fact or none;
 *    - each of them again under the case's planner settings (perturb.ts, which reach every read that opens a
 *      transaction), through a reader that reads every cell text strictly and compares every field it delivers with
 *      its cell (cells.ts);
 *    - a query as a ChangeSet's read-back, a change member that writes nothing and reads the query back, in the
 *      delivery a read-back reads; its rows must also be spelled exactly as the strict reader's once.
 *    A refusal probe runs first (program.ts Probe) and must be its CallError's kind, and the reads after it answer as
 *    before. Each attachment states a delivery its program proves (delivery.ts): the reference's children per parent
 *    must keep it, and every public form must deliver exactly it, an Option, the one child or an arm's Some and None
 *    as its parent's handle selects (answer.ts).
 * 5. Every read is judged against itself too, with no reference in the judgment, which judges every column the
 *    reference declines (answer.ts unstated): every public side exactly as its member's once, under both plans
 *    (the plan relation); and once every read has answered, the facts are stored again otherwise
 *    (ProgramCase.restorage: another storage order through a fresh load, one value in its next twin spelling) and
 *    every read is read again, plainly and strictly, exactly as it first answered (the storage-order and twin-spelling
 *    relations).
 *
 * The case's features (features.ts) are noted as it runs: the program's shapes, how the runtime delivered each
 * attachment (fused into its parent's statement or pipelined as one of its own, read off the read's template), the
 * spellings among each attachment's parent keys, and every refusal.
 *
 * Runs one case, noting its features, its Db connecting to the server. The perturbed reader checks every cell text
 * against the library's conversion, and every delivered field against its cell (cells.ts). The case's scope holds its installation
 * and its Db.
 */
export const runCase = (
	c: ProgramCase,
	note: Note
): Effect.Effect<void, Disagreement, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		noteProgram(c, note)
		const built = buildSchema(c.schema)
		const unready = (what: string) => (e: unknown) =>
			new Disagreement({ check: "setup", report: `${what}: ${describe(e)}\n${printCase(c)}` })
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
		const refused = (what: string) => (e: unknown) =>
			e instanceof Disagreement ? e : servedRefusal(c, what, e)
		yield* Effect.mapError(
			withServedDb(done, world.server.roles.app, {}, ({ ctx, load }) =>
				Effect.gen(function* () {
					const loaded = yield* Effect.mapError(
						load(casePrograms(c, built, value)),
						refused("the case's workload did not compile")
					)
					const strict = strictReaderOf(perturbedContext(ctx, c.perturbation))
					const served = (name: string) => memberCalls(ctx, member(loaded, name))
					const members: Members = {
						plain: (name) => readCalls(ctx, member(loaded, name)),
						strict: (name) => strict.calls(member(loaded, name)),
						sentRows: strict.sentRows,
						back: (name) => writeOnce(served(name))({ params: {}, facts: {} }),
						store: (name, facts) => writeOnce(served(name))({ params: {}, facts })
					}
					/** A read through the members, first reading and second (Again). */
					const readOf = (read: ProgramRead, i: number): Effect.Effect<Again, Disagreement> => {
						switch (read.kind) {
							case "key":
								return keyRead(c, members, read, i, note)
							case "handle":
								return handleRead(c, members, read, i, note)
							case "mixed":
								return mixedRead(c, members, read, i, note)
							case "query":
								return queryRead(c, members, done.names.codes, built, value, read, i, note)
						}
					}
					if (spelledFacts(c)) {
						note("facts by a direct writer")
						yield* storeDirectly(c, done, world.server.roles.app.role)
					} else {
						yield* store(c, members)
					}
					const again: Array<Again> = []
					for (const [i, read] of c.reads.entries()) {
						const reread = yield* readOf(read, i)
						again.push(reread)
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
			),
			refused("the case's Db did not open through its served login")
		)
	})
