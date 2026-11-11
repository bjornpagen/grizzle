import { indices } from "#compiler/core/array.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import { defect } from "#compiler/core/invariant.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import type { StatementRole, StatementSpec } from "#compiler/ir/products.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import type {
	DeclaredParamSlot,
	ProgramDelivery,
	WriteParamSlot
} from "#compiler/lower/conservative/types.ts"
import type {
	FusedStatement,
	OptimizedStatement,
	RelationChoice
} from "#compiler/lower/shapes/index.ts"
import {
	type SpecifiedArtifact,
	type SpecifiedStatement,
	statementSpec
} from "#compiler/lower/template.ts"
import { oneForm, type StatementForms } from "#compiler/runtime/lower/forms.ts"
import { declaredSlotOf } from "#compiler/runtime/lower/slots.ts"
import { mapTree, type StatementRoots } from "#compiler/runtime/lower/tree.ts"
import type { AddedTag, RemovedTag } from "#compiler/runtime/write/net.ts"
import type { Staged } from "#compiler/runtime/write/staged.ts"
import {
	byStratum,
	type CarrierCasts,
	type OwnStep,
	removedTag,
	type RowsStep,
	type WriteStep,
	type WriteStepResult
} from "#compiler/runtime/write/steps.ts"
import { wildcardText } from "#compiler/scalar/compute/types.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import type { EmittedText, SqlStatement } from "#compiler/sql/ast.ts"
import type { NameMap } from "#compiler/sql/naming.ts"
import type { WriteCarrier } from "#compiler/write/carriers/carriers.ts"
import { groupBy } from "#compiler/write/defined.ts"
import type { WriteStatement } from "#compiler/write/insert/statement.ts"
import type { SingleStatement } from "#compiler/write/program/single.ts"
import { carriersOf, nestedColumnOf, stagedOf } from "#compiler/write/program/staged.ts"
import type { PutStatement } from "#compiler/write/put/statement.ts"

/** The tags of the facts a write statement's rows make present and absent, by its result: an insert's
 * rows are facts its action made present; a deletion's are facts made absent; an upsert's are a put's facts, an
 * update's a put's fact and the occupant it displaced, a MERGE's a put's fact or a fact its absorbed deletion removed. */
const changeTags = (
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

/** The carrier statement that casts nothing a ChangeSet states. */
export const castsNothing: CarrierCasts = Object.freeze({ kind: "none" })

/** The write steps of a statement: a write step itself, a single statement's parts' steps, a family step; no other step
 * writes facts. */
const writesOf = (step: WriteStep): ReadonlyArray<RowsStep> => {
	switch (step.kind) {
		case "write":
		case "family":
			return [step]
		case "single":
			return step.parts.map((part) => part.step)
		case "familyWrite":
			return step.parts
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

/** One read-back as the artifact delivers it: its name, its query, and its statements as they reach the server
 * (`carried`). */
export interface ReadBackDelivery {
	readonly name: string
	readonly query: QueryDesc
	readonly carried: ReadBackCarried
}

/**
 * How a read-back's statements reach the server: `sent`, each a statement of the artifact after the writes, in order,
 * its main statement or first heading group's first leading, as the runtime runs them, each with its spec as placed and
 * its large form's (`run`); or `riding`, as parts of the write statement at `statement`, which writes every delta it
 * reads (write/schedule/plan.ts placeReadBacks): its sent statements in flight order, each a part of that statement
 * whose rows are its rows behind the part's tag, from `tag` on (write/program/single.ts), and none a text of its own
 * (`RiddenArtifact`).
 */
export type ReadBackCarried =
	| {
			readonly kind: "sent"
			readonly run: SpecifiedArtifact
			readonly statements: NonEmptyReadonlyArray<ArtifactStatement>
	  }
	| ({
			readonly kind: "riding"
			readonly statement: number
			readonly run: RiddenArtifact
	  } & RidingParts)

/**
 * A riding read-back's statements as the runtime reads their rows: each lowered statement in its tree, with how its
 * rows arrive, and how the rows combine. The statement it rides sends them, so none carries a text of its own.
 */
export interface RiddenArtifact {
	readonly delivery: ProgramDelivery
	readonly roots: StatementRoots<OptimizedStatement<RelationChoice, FusedStatement>>
}

/**
 * One sent statement of a riding read-back as a part of the statement it rides: each row its tag, then the `width`
 * cells the sent statement would answer alone. A `rows` part's rows are that statement's in the order it would send
 * them; a `numbered` part is an ordered statement's, each row's next cell its row number in the statement's order, by
 * which the runtime puts its rows back in that order, since no arm of the statement it rides orders its rows.
 */
export interface RidingPart {
	readonly kind: "rows" | "numbered"
	readonly width: number
}

/** Where a riding read-back's sent statements' rows stand among the rows of the statement it rides: the first one's tag,
 * and each one's part, in flight order (ReadBackCarried `riding`). */
export interface RidingParts {
	readonly tag: number
	readonly parts: NonEmptyReadonlyArray<RidingPart>
}

/** A read-back riding the statement it is placed with: its name, its query, its statements as the runtime reads their
 * rows, and where its rows stand among that statement's rows. */
export interface RidingReadBack extends RidingParts {
	readonly name: string
	readonly query: QueryDesc
	readonly run: RiddenArtifact
}

/** A form of a statement as one execution sends it: its text, what fills each placeholder ($n is params[n - 1]), and
 * its AST. */
export interface SentForm {
	readonly sql: EmittedText
	readonly params: ReadonlyArray<WriteParamSlot>
	readonly ast: SqlStatement
}

/** The forms of a statement, as a query's (`StatementForms`): its one form, the spec's; or, for a statement
 * whose take over the rows of a declared relation parameter is a per-execution choice, the LATERAL form, the spec's,
 * and the whole-relation form `large`, which an execution sends when some choice's parameter holds more distinct facts
 * than the choice's threshold (runsLargeForm). */
export type ArtifactForms = StatementForms<RelationChoice, SentForm>

/** One statement of an artifact: its position, its step, its spec and its AST, which `spec.sql` prints, its forms, and
 * its staged form, which sends its nested rows through carriers where they are past one Bind message
 * (write/program/staged.ts). */
export interface ArtifactStatement {
	readonly index: number
	readonly step: WriteStep
	readonly spec: StatementSpec<WriteParamSlot>
	readonly ast: SqlStatement
	readonly forms: ArtifactForms
	readonly staged: Staged
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
 * module (`writeSlotOf`): a member slot the array encoder over the statement's own columns, a
 * declared parameter its scalar codec or array encoder. A member slot's encoder writes facts the host already
 * normalized, so it never refuses a same-key pair. */
export interface WriteArtifact {
	/** Every statement, in the order they run in one flight: position order, since each depends only on earlier ones
	 * (spec.dependsOn). */
	readonly statements: ReadonlyArray<ArtifactStatement>
	/** The statements' specs and steps, position by position. */
	readonly specs: ReadonlyArray<StatementSpec<WriteParamSlot>>
	readonly steps: ReadonlyArray<WriteStep>
	/** Per stratum, the artifact positions of its statements, the carriers it fills at its start included: every step
	 * but a read-back's names its stratum or none. */
	readonly strata: ReadonlyArray<ReadonlyArray<number>>
	readonly readBacks: ReadonlyArray<ReadBackDelivery>
	readonly carriers: ReadonlyArray<WriteCarrier>
	/** Per written relation, the positions of the statements whose RETURNING forms delta.added and delta.removed: each
	 * write step's rows, by its result's change tags (changeTags). */
	readonly deltas: Readonly<
		Record<
			string,
			{ readonly added: ReadonlyArray<number>; readonly removed: ReadonlyArray<number> }
		>
	>
}

/** The large form of a read-back's placed statement: the large mode's statement and the form an execution sends, each
 * placeholder a declared parameter's. */
export interface PlacedLarge {
	readonly statement: FusedStatement
	readonly sent: SentForm & { readonly params: ReadonlyArray<DeclaredParamSlot> }
}

/** A statement placed in an artifact being built: the write program's own, with its step, its forms and the read-backs
 * riding it; or a read-back's, with its read-back and the statement its program lowered there, which determine its step
 * and its forms. Each holds its spec, its AST, and the generated names its text holds. */
export type PlacedStatement = {
	readonly ast: SqlStatement
	readonly names: NameMap
} & (
	| {
			readonly kind: "own"
			readonly step: OwnStep
			readonly spec: StatementSpec<WriteParamSlot>
			readonly forms: ArtifactForms
			readonly riders: ReadonlyArray<RidingReadBack>
	  }
	| {
			readonly kind: "readBack"
			readonly of: ReadBackOf
			readonly spec: StatementSpec<DeclaredParamSlot>
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

/** A read-back's statement as the runtime runs it, under its spec in the artifact `spec`, each placeholder with its
 * encoder under the installation's codes: its large form, when it has one, specified as the form it sends. */
export const specifiedRun = (
	run: OptimizedStatement<RelationChoice, PlacedLarge>,
	spec: StatementSpec<DeclaredParamSlot>,
	codes: Codebook
): SpecifiedStatement => {
	const slotOf = declaredSlotOf(codes, new CompilePatterns())
	const encoded = Object.freeze({ ...spec, paramSlots: spec.paramSlots.map(slotOf) })
	const forms = run.forms
	if (forms.kind === "one") {
		return Object.freeze({ statement: { ...run, forms }, spec: encoded })
	}
	const large = forms.large
	return Object.freeze({
		statement: {
			...run,
			forms: {
				...forms,
				large: {
					statement: large.statement,
					spec: Object.freeze({
						...encoded,
						sql: large.sent.sql,
						paramSlots: large.sent.params.map(slotOf)
					})
				}
			}
		},
		spec: encoded
	})
}

/** The artifact of the statements `placed`, in position order, and its carriers: its strata, deltas, read-backs and
 * name map are the placed statements' (WriteArtifact), each read-back's statements those that name it, in order. */
export const settledArtifact = (
	placed: ReadonlyArray<PlacedStatement>,
	carriers: ReadonlyArray<WriteCarrier>
): WriteArtifact => {
	/** The carrier the next staged form names first: after the program's own, and every earlier statement's. */
	let carrier = carriers.length + 1
	const settled = placed.map((p, index) => {
		const forms = placedForms(p)
		const staged = stagedOf(p.ast, p.spec.paramSlots.map(nestedColumnOf), carrier)
		if (staged.kind === "carriers" && forms.kind === "chosen") {
			throw defect("a statement that reads nested rows has one form")
		}
		carrier += carriersOf(staged)
		const statement: ArtifactStatement = Object.freeze({
			index,
			step: placedStep(p),
			spec: p.spec,
			ast: p.ast,
			forms,
			staged
		})
		return { placed: p, statement }
	})
	const statements = settled.map((s) => s.statement)
	const sent = groupBy(
		settled.flatMap(({ placed: p, statement }) =>
			p.kind === "readBack" ? [{ of: p.of, statement }] : []
		),
		(r) => r.of
	).map(([of, group]) => ({
		at: group[0].statement.index,
		delivery: Object.freeze({
			name: of.name,
			query: of.query,
			carried: Object.freeze({
				kind: "sent" as const,
				run: of.run,
				statements: Object.freeze(mapNonEmpty(group, (r) => r.statement))
			})
		})
	}))
	const riding = settled.flatMap(({ placed: p, statement }) =>
		p.kind === "own"
			? p.riders.map((rider) => ({
					at: statement.index,
					delivery: Object.freeze({
						name: rider.name,
						query: rider.query,
						carried: Object.freeze({
							kind: "riding" as const,
							statement: statement.index,
							run: rider.run,
							tag: rider.tag,
							parts: rider.parts
						})
					})
				}))
			: []
	)
	/** Every read-back by the position its statements reach the server at: a riding one with its statement, before the
	 * read-backs sent after every write. */
	const readBacks = [...riding, ...sent]
		.toSorted((x, y) => x.at - y.at)
		.map((r): ReadBackDelivery => r.delivery)
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
): StatementSpec<WriteParamSlot> =>
	Object.freeze({
		sql: statement.sql.text,
		paramSlots: statement.params,
		heading: resultHeading(statement.result),
		role: statement.role,
		dependsOn: Object.freeze([...dependsOn])
	})

/** The StatementSpec of a single statement: its rows are a tag, the part's index, then its part's
 * columns, padded with empty texts to the widest part, every column a text but the tag. */
export const singleStatementSpec = (
	statement: SingleStatement,
	dependsOn: ReadonlyArray<number>
): StatementSpec<WriteParamSlot> =>
	Object.freeze({
		sql: statement.sql.text,
		paramSlots: statement.params,
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
): StatementRoots<{ readonly statement: S; readonly spec: StatementSpec<DeclaredParamSlot> }> =>
	mapTree(roots, (statement) => {
		const spec = statementSpec(statement, (slot: DeclaredParamSlot) => slot)
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
