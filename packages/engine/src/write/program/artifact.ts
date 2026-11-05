import { indices, maxOf } from "#compiler/core/array.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import type { TransientReason } from "#compiler/core/errors.ts"
import type { ConstraintName, ParamId } from "#compiler/core/ids.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import type { StatementRole, StatementSpec, WriteSlot } from "#compiler/ir/products.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { mapTree, type StatementRoots } from "#compiler/lower/conservative/types.ts"
import {
	type FusedStatement,
	type OptimizedStatement,
	oneForm,
	type RelationChoice,
	type StatementForms
} from "#compiler/lower/shapes/index.ts"
import {
	declaredSlotOf,
	type SpecifiedArtifact,
	type SpecifiedStatement,
	statementSpec,
	writeSlotOf
} from "#compiler/lower/template.ts"
import { plainType, wildcardText } from "#compiler/scalar/compute/types.ts"
import type { EmittedText, SqlStatement } from "#compiler/sql/ast.ts"
import { type NameMap, renderNameMap } from "#compiler/sql/naming.ts"
import type { Carrier } from "#compiler/write/carriers/carriers.ts"
import { groupBy } from "#compiler/write/defined.ts"
import type { AddedTag, RemovedTag } from "#compiler/write/delta/net.ts"
import type {
	DeleteResult,
	InsertResult,
	SpanClassifyResult,
	WriteStatement
} from "#compiler/write/insert/statement.ts"
import type { SingleStatement } from "#compiler/write/program/single.ts"
import type { PutResult, PutStatement } from "#compiler/write/put/statement.ts"

/** A unique violation at a statement into `relation` that aborts the apply with a TransientFailure of `reason`: a
 * generated addition's own insert on a key holding its serial field, a MERGE insert at a key its put targets, or a
 * probed insert's 23505 or 23P01 on a unique object besides its arbiter, raised by an occupant its snapshot did not see. */
export interface UniqueAbort {
	readonly constraint: ConstraintName
	readonly relation: string
	readonly reason: Extract<
		TransientReason["_tag"],
		"GeneratedSerialUnique" | "PutTargetConflict" | "UnseenOccupant"
	>
}

/** The result of a write statement: rows of facts it made present or absent, or a span classification's, which raises
 * or returns no row. */
export type WriteStepResult = InsertResult | DeleteResult | PutResult | SpanClassifyResult

/** The tag of each fact a deletion's rows make absent: a delete member's, or the occupants a put displaced. */
export const removedTag = (result: DeleteResult): RemovedTag =>
	result.mode === "exact" ? "delete" : "displaced"

/** The tags of the facts a write statement's rows make present and absent, by its result: an insert's
 * rows are facts its action made present; a deletion's are facts made absent; an upsert's are a put's facts, an
 * update's a put's fact and the occupant it displaced, a MERGE's a put's fact or a fact its absorbed deletion removed. */
export const changeTags = (
	result: WriteStepResult
): { readonly added: AddedTag | undefined; readonly removed: RemovedTag | undefined } => {
	switch (result.kind) {
		case "insert":
			return { added: result.of, removed: undefined }
		case "delete":
			return { added: undefined, removed: removedTag(result) }
		case "upsert":
			return { added: "put", removed: undefined }
		case "update":
			return { added: "put", removed: "displaced" }
		case "merge":
			return { added: "put", removed: "delete" }
		case "spanClassify":
			return { added: undefined, removed: undefined }
	}
}

export type WriteStep =
	| {
			readonly kind: "write"
			readonly stratum: number
			/** The action's index in its stratum (ir.strata[stratum].actions). */
			readonly action: number
			readonly relation: string
			readonly result: WriteStepResult
			/** The enumerated input whose emptiness lets the runtime skip the statement, none for a statement of no
			 * enumerated input. */
			readonly skipWhenEmpty: ParamId | undefined
			readonly uniqueAborts: ReadonlyArray<UniqueAbort>
	  }
	| {
			readonly kind: "carrier"
			readonly carrier: string
			readonly step: "create" | "fill"
			/** Its stratum, none for a carrier around the strata. */
			readonly stratum: number | undefined
	  }
	| {
			readonly kind: "analyze"
			readonly carriers: ReadonlyArray<string>
			readonly stratum: number | undefined
	  }
	| {
			readonly kind: "advance"
			readonly stratum: number
			readonly action: number
			readonly relation: string
			readonly field: string
			readonly skipWhenEmpty: ParamId | undefined
	  }
	| { readonly kind: "readBack"; readonly name: string }
	| {
			readonly kind: "check"
			readonly stratum: number
			readonly entry: string
			readonly skipWhenEmpty: ParamId | undefined
	  }
	| {
			readonly kind: "single"
			readonly stratum: number
			readonly parts: ReadonlyArray<WritePart>
			/** Every part's unique aborts: each part writes its own relation, so a violation names its part's constraint. */
			readonly uniqueAborts: ReadonlyArray<UniqueAbort>
	  }

/** One write action of a single statement: its step, whose rows are the statement's rows tagged with the part's index,
 * each the tag and then the step's `width` columns, the rest of the row padding. */
interface WritePart {
	readonly step: Extract<WriteStep, { readonly kind: "write" }>
	readonly width: number
}

/** The write steps of a statement: a write step itself, a single statement's parts' steps; no other step writes facts. */
const writesOf = (
	step: WriteStep
): ReadonlyArray<Extract<WriteStep, { readonly kind: "write" }>> => {
	switch (step.kind) {
		case "write":
			return [step]
		case "single":
			return step.parts.map((part) => part.step)
		case "carrier":
		case "analyze":
		case "advance":
		case "readBack":
		case "check":
			return []
	}
}

/** The write steps a statement's rows are read as, each with its own rows: a write step's are the statement's, a single
 * statement's parts' are its rows of their tag, cut to their width; no other step has rows the outcome reads. */
export const writeRows = (
	step: WriteStep,
	rows: ReadonlyArray<ReadonlyArray<string>>
): ReadonlyArray<{
	readonly step: Extract<WriteStep, { readonly kind: "write" }>
	readonly rows: ReadonlyArray<ReadonlyArray<string>>
}> => {
	switch (step.kind) {
		case "write":
			return [{ step, rows }]
		case "single":
			return step.parts.map((part, tag) => {
				const own = String(tag)
				return {
					step: part.step,
					rows: rows.flatMap((row) => (row[0] === own ? [row.slice(1, 1 + part.width)] : []))
				}
			})
		case "carrier":
		case "analyze":
		case "advance":
		case "readBack":
		case "check":
			return []
	}
}

/** A read-back as each of its placed statements names it: its name, its query as the ChangeSet's Description states
 * it, and how its statements' rows combine into its result, by the program it was lowered as. */
export interface ReadBackOf {
	readonly name: string
	readonly query: QueryDesc
	/** Its statements as the runtime runs them, each with its spec as placed and its large form's. */
	readonly run: SpecifiedArtifact
}

/** One read-back as the artifact delivers it: its query, its statements in the artifact in order, its main statement or
 * first heading group's first leading, and the same statements as the runtime runs them, each with its spec as placed
 * and its large form's (`run`). */
export interface ReadBackDelivery {
	readonly name: string
	readonly query: QueryDesc
	readonly statements: NonEmptyReadonlyArray<ArtifactStatement>
	readonly run: SpecifiedArtifact
}

/** A form of a statement as one execution sends it: its text, the encoder of each placeholder ($n is paramSlots[n - 1])
 * and its AST. */
export interface SentForm {
	readonly sql: EmittedText
	readonly paramSlots: ReadonlyArray<WriteSlot>
	readonly ast: SqlStatement
}

/** The forms of a statement, as a query's (`StatementForms`): its one form, the spec's; or, for a statement
 * whose take over the rows of a declared relation parameter is a per-execution choice, the LATERAL form, the spec's,
 * and the whole-relation form `large`, which an execution sends when some choice's parameter holds more distinct facts
 * than the choice's threshold (runsLargeForm). */
export type ArtifactForms = StatementForms<RelationChoice, SentForm>

/** One statement of an artifact: its position, its step, its spec and its AST, which `spec.sql` prints, and its
 * forms. */
export interface ArtifactStatement {
	readonly index: number
	readonly step: WriteStep
	readonly spec: StatementSpec<WriteSlot>
	readonly ast: SqlStatement
	readonly forms: ArtifactForms
}

/** The form of a statement an execution sends: its whole-relation form when it runs some per-execution choice large
 * (`runsLarge`, by the distinct fact count of the relation parameter the choice reads), its own otherwise. */
export const sentForm = (
	statement: ArtifactStatement,
	runsLarge: (choice: RelationChoice) => boolean
): SentForm => {
	const forms = statement.forms
	const own = { sql: statement.spec.sql, paramSlots: statement.spec.paramSlots, ast: statement.ast }
	switch (forms.kind) {
		case "one":
			return own
		case "chosen":
			return forms.choices.some((c) => runsLarge(c)) ? forms.large : own
	}
}

/** One artifact of a WriteProgram: its statements as the runtime binds, runs and converts them, and what each statement's
 * rows mean.
 *
 * A WriteProgram carries two artifacts of one ChangeSet, like every compiled template: the optimized one (the scheduled
 * statements of schedule/, with the put targets of put/) and the conservative realization (conservative/), the write
 * oracle's baseline. Both run in the write's one transaction, and both are
 * described alike, statement by statement, so the runtime reads either without parsing SQL:
 *
 * - a write statement's step names the stratum and action it realizes, the result descriptor of its rows
 *   (`WriteResult`, `PutResult`), the change its rows are for the netting of deltas and
 *   counts, the enumerated slot whose emptiness lets the runtime skip it,
 *   and the unique violations (23505, 23P01) at this statement that are aborts rather than key laws;
 * - a carrier statement creates, fills or analyzes transaction-scoped carriers; a sequence advance moves an identity
 *   sequence; neither returns rows the outcome reads;
 * - a read-back statement belongs to one read-back, delivered as a query's statements are.
 *
 * Every write statement's text already casts its outer columns to text; a read-back statement's text is
 * the template module's executable text. Every placeholder gets its encoder from the template
 * module (`writeSlotOf`): a member slot the recordset encoder under the statement's own JSON keys, a
 * declared parameter its scalar codec or recordset encoder. Encoding a member slot re-admits facts the host already
 * normalized, so it never refuses a same-key pair. */
export interface WriteArtifact {
	/** Every statement, in the order they run in one flight: position order, since each depends only on earlier ones
	 * (spec.dependsOn). */
	readonly statements: ReadonlyArray<ArtifactStatement>
	/** The statements' specs and steps, position by position. */
	readonly specs: ReadonlyArray<StatementSpec>
	readonly steps: ReadonlyArray<WriteStep>
	/** Per stratum, the artifact positions of its statements, the carriers it fills at its start included: every step
	 * but a read-back's names its stratum or none. */
	readonly strata: ReadonlyArray<ReadonlyArray<number>>
	readonly readBacks: ReadonlyArray<ReadBackDelivery>
	readonly carriers: ReadonlyArray<Carrier>
	/** Per written relation, the positions of the statements whose RETURNING forms delta.added and delta.removed: each
	 * write step's rows, by its result's change tags (changeTags). */
	readonly deltas: Readonly<
		Record<
			string,
			{ readonly added: ReadonlyArray<number>; readonly removed: ReadonlyArray<number> }
		>
	>
	/** Generated SQL name, `<position>:<name>`, to what it stands for. */
	readonly nameMap: Readonly<Record<string, string>>
}

/** The large form of a read-back's placed statement: the large mode's statement and the form an execution sends. */
export interface PlacedLarge {
	readonly statement: FusedStatement
	readonly sent: SentForm
}

/** The step of a statement of the write program's own: every step but a read-back's. */
export type OwnStep = Exclude<WriteStep, { readonly kind: "readBack" }>

/** A statement placed in an artifact being built: the write program's own, with its step and its forms; or a
 * read-back's, with its read-back and the statement its program lowered there, which determine its step and its forms.
 * Each holds its spec, its AST, and the generated names its text holds. */
export type PlacedStatement = {
	readonly spec: StatementSpec<WriteSlot>
	readonly ast: SqlStatement
	readonly names: NameMap
} & (
	| { readonly kind: "own"; readonly step: OwnStep; readonly forms: ArtifactForms }
	| {
			readonly kind: "readBack"
			readonly of: ReadBackOf
			readonly run: OptimizedStatement<RelationChoice, PlacedLarge>
	  }
)

/** A placed statement's step: its own, or its read-back's. */
export const placedStep = (placed: PlacedStatement): WriteStep =>
	placed.kind === "own" ? placed.step : Object.freeze({ kind: "readBack", name: placed.of.name })

/** A placed statement's forms: its own, or those its read-back statement sends. */
const placedForms = (placed: PlacedStatement): ArtifactForms => {
	if (placed.kind === "own") {
		return placed.forms
	}
	const forms = placed.run.forms
	return forms.kind === "one"
		? oneForm
		: Object.freeze({ kind: "chosen", choices: forms.choices, large: forms.large.sent })
}

/** A read-back's statement as the runtime runs it, under its spec in the artifact `spec`: its large form, when it has
 * one, specified as the form it sends. */
export const specifiedRun = (
	run: OptimizedStatement<RelationChoice, PlacedLarge>,
	spec: StatementSpec<WriteSlot>
): SpecifiedStatement => {
	const forms = run.forms
	if (forms.kind === "one") {
		return Object.freeze({ statement: { ...run, forms }, spec })
	}
	const large = forms.large
	return Object.freeze({
		statement: {
			...run,
			forms: {
				...forms,
				large: {
					statement: large.statement,
					spec: Object.freeze({ ...spec, sql: large.sent.sql, paramSlots: large.sent.paramSlots })
				}
			}
		},
		spec
	})
}

/** The stratum a step belongs to, none for a carrier around the strata and a read-back's statement. */
export const stratumOf = (step: WriteStep): number | undefined => {
	switch (step.kind) {
		case "readBack":
			return undefined
		case "carrier":
		case "analyze":
			return step.stratum
		case "write":
		case "advance":
		case "check":
		case "single":
			return step.stratum
	}
}

/** Per stratum, up to the last any statement names, the statements in it, in their order. */
export const byStratum = <S extends { readonly step: WriteStep }>(
	statements: ReadonlyArray<S>
): ReadonlyArray<ReadonlyArray<S>> => {
	const placed = statements.flatMap((statement) => {
		const stratum = stratumOf(statement.step)
		return stratum === undefined ? [] : [{ stratum, statement }]
	})
	return indices(
		maxOf(
			placed.map((p) => p.stratum + 1),
			0
		)
	).map((s) => placed.filter((p) => p.stratum === s).map((p) => p.statement))
}

/** The artifact of the statements `placed`, in position order, and its carriers: its strata, deltas, read-backs and
 * name map are the placed statements' (WriteArtifact), each read-back's statements those that name it, in order. */
export const settledArtifact = (
	placed: ReadonlyArray<PlacedStatement>,
	carriers: ReadonlyArray<Carrier>
): WriteArtifact => {
	const settled = placed.map((p, index) => {
		const statement: ArtifactStatement = Object.freeze({
			index,
			step: placedStep(p),
			spec: p.spec,
			ast: p.ast,
			forms: placedForms(p)
		})
		return { placed: p, statement }
	})
	const statements = settled.map((s) => s.statement)
	const readBacks = groupBy(
		settled.flatMap(({ placed: p, statement }) =>
			p.kind === "readBack" ? [{ of: p.of, statement }] : []
		),
		(r) => r.of
	).map(([of, group]): ReadBackDelivery =>
		Object.freeze({
			name: of.name,
			query: of.query,
			statements: Object.freeze(mapNonEmpty(group, (r) => r.statement)),
			run: of.run
		})
	)
	const writes = statements.flatMap(({ step, index }) =>
		writesOf(step).map((write) => ({
			relation: write.relation,
			tags: changeTags(write.result),
			position: index
		}))
	)
	const deltas = [...new Set(writes.map((w) => w.relation))].map((relation) => {
		const own = writes.filter((w) => w.relation === relation)
		return [
			relation,
			Object.freeze({
				added: Object.freeze(own.flatMap((w) => (w.tags.added === undefined ? [] : [w.position]))),
				removed: Object.freeze(
					own.flatMap((w) => (w.tags.removed === undefined ? [] : [w.position]))
				)
			})
		] as const
	})
	return Object.freeze({
		statements: Object.freeze(statements),
		specs: Object.freeze(placed.map((p) => p.spec)),
		steps: Object.freeze(statements.map((s) => s.step)),
		strata: Object.freeze(
			byStratum(statements).map((s) => Object.freeze(s.map((statement) => statement.index)))
		),
		deltas: Object.freeze(Object.fromEntries(deltas)),
		nameMap: Object.freeze(
			Object.fromEntries(
				placed.flatMap(({ names }, position) =>
					names.map((entry) => [
						`${position}:${entry.name}`,
						renderNameMap([entry]).slice(entry.name.length + 1)
					])
				)
			)
		),
		readBacks: Object.freeze(readBacks),
		carriers
	})
}

/** The columns a write statement's rows hold: a write's returned facts, which the outcome converts by the statement's
 * result; none for a carrier's creation, fill or analysis, a span classification, a sequence advance or a
 * query entry's check. */
export const resultHeading = (result: (WriteStatement | PutStatement)["result"]): Heading => {
	switch (result.kind) {
		case "insert":
		case "delete":
		case "upsert":
		case "update":
		case "merge":
			return result.columns
		case "spanClassify":
		case "sequenceAdvance":
		case "carrier":
		case "analyze":
		case "entryCheck":
			return []
	}
}

/** The StatementSpec of a write, carrier or sequence-advance statement. */
export const writeStatementSpec = (
	statement: WriteStatement | PutStatement,
	dependsOn: ReadonlyArray<number>
): StatementSpec<WriteSlot> =>
	Object.freeze({
		sql: statement.sql.text,
		paramSlots: Object.freeze(statement.params.map(writeSlotOf)),
		heading: resultHeading(statement.result),
		role: statement.role,
		dependsOn: Object.freeze([...dependsOn])
	})

/** The StatementSpec of a single statement: its rows are a tag, the part's index, then its part's
 * columns, padded with empty texts to the widest part, every column a text but the tag. */
export const singleStatementSpec = (
	statement: SingleStatement,
	dependsOn: ReadonlyArray<number>
): StatementSpec<WriteSlot> =>
	Object.freeze({
		sql: statement.sql.text,
		paramSlots: Object.freeze(statement.params.map(writeSlotOf)),
		heading: [
			{ name: "tag", type: plainType("int4") },
			...indices(statement.width).map((i) => ({ name: `column ${i + 1}`, type: wildcardText }))
		],
		role: "member" as const,
		dependsOn: Object.freeze([...dependsOn])
	})

/** Each statement of one read-back with its StatementSpec, placed at artifact position `offset`: the template module's
 * executable texts, each statement's dependencies moved to artifact positions. */
export const readBackSpecs = <S extends FusedStatement>(
	roots: StatementRoots<S>,
	offset: number
): StatementRoots<{ readonly statement: S; readonly spec: StatementSpec<WriteSlot> }> =>
	mapTree(roots, (statement) => {
		const spec = statementSpec(statement, declaredSlotOf)
		if (!spec.ok) {
			throw new Refusal(spec.error)
		}
		const role: StatementRole = spec.value.role === "main" ? "readBack" : spec.value.role
		return {
			statement,
			spec: Object.freeze({
				...spec.value,
				role,
				dependsOn: spec.value.dependsOn.map((d) => d + offset)
			})
		}
	})

/** The positions a statement depends on: every earlier statement that writes what it reads or writes, or reads what it
 * writes, over relations, carriers and sequences, with the earlier statements its action depends on. */
export class DependencyTracker {
	readonly #reads: Array<ReadonlySet<string>> = []
	readonly #writes: Array<ReadonlySet<string>> = []

	/** A statement that reads `reads` and writes `writes`, with no action of its own. */
	add(reads: Iterable<string>, writes: Iterable<string>): ReadonlyArray<number> {
		return this.addAfter(reads, writes, [])
	}

	/** A statement of an action, which also depends on the earlier statements `also` of the actions it follows. */
	addAfter(
		reads: Iterable<string>,
		writes: Iterable<string>,
		also: Iterable<number>
	): ReadonlyArray<number> {
		const r = new Set(reads)
		const w = new Set(writes)
		const out = new Set<number>(also)
		for (const [i, prior] of this.#writes.entries()) {
			for (const x of prior) {
				if (r.has(x) || w.has(x)) {
					out.add(i)
				}
			}
		}
		for (const [i, prior] of this.#reads.entries()) {
			for (const x of prior) {
				if (w.has(x)) {
					out.add(i)
				}
			}
		}
		this.#reads.push(r)
		this.#writes.push(w)
		return [...out].toSorted((a, b) => a - b)
	}
}
