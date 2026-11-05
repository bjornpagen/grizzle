import { encodeFailure, slotPlace } from "#compiler/codec/fault.ts"
import { arrayTexts, parameterNormalizer, positionalColumns } from "#compiler/codec/recordset.ts"
import { paramEncoder } from "#compiler/codec/scalar.ts"
import type { CompileError, EncodingFailure } from "#compiler/core/errors.ts"
import type { LawId, ParamId } from "#compiler/core/ids.ts"
import { defined } from "#compiler/core/invariant.ts"
import { maxStringLength } from "#compiler/core/limits.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { Family } from "#compiler/ir/family.ts"
import type { FamilyId } from "#compiler/ir/law.ts"
import type { ArrayTexts, LiteralBound, WriteSlot } from "#compiler/ir/products.ts"
import type { RelationChoice } from "#compiler/lower/shapes/index.ts"
import { runsLargeForm } from "#compiler/lower/shapes/take/index.ts"
import type { EmittedText } from "#compiler/sql/ast.ts"
import type { Law, Witness } from "#compiler/types/changeset/changeset.ts"
import { isIterable } from "#compiler/write/defined.ts"
import { compose, type RelationPlanAt } from "#compiler/write/family/compose.ts"
import type { Row } from "#compiler/write/family/draw.ts"
import { familyKey } from "#compiler/write/family/fold.ts"
import {
	type FamilyStatement,
	type Plan,
	planRelation,
	textsOf,
	type Transport,
	type Unsendable
} from "#compiler/write/family/order.ts"
import {
	type MemberFacts,
	type Normalized,
	type NormalizedSlot,
	normalizeChangeSet
} from "#compiler/write/normalize/normalize.ts"
import {
	type ArtifactStatement,
	type SentForm,
	sentForm,
	type WriteArtifact
} from "#compiler/write/program/artifact.ts"
import type { CompiledWrite } from "#compiler/write/program/compile.ts"
import { keyWitness } from "#compiler/write/program/outcome.ts"

interface BindInputs {
	/** The facts each member slot of the ChangeSet value supplies (`collectInputs`). */
	readonly members: MemberFacts
	/** The declared parameters' values, by name: the caller's, and the values ChangeSet.bind closed under the private
	 * names the Description lists. */
	readonly params: Readonly<Record<string, unknown>>
	/** What one statement carries, which a family's statements are cut to (write/family/order.ts inForce over the
	 * wire's Bind frame). */
	readonly transport: Transport
}

/** A row of a nested write's family that no statement can carry even alone, as the family names it. */
export interface FamilyRowBound {
	readonly _tag: "FamilyRowBound"
	readonly family: Family
	readonly row: Unsendable
}

export type Raw = ReadonlyArray<ReadonlyArray<string>>

export interface BoundWrite {
	readonly kind: "bound"
	readonly normalized: Normalized
	/** The positions of each artifact the runtime may skip: their enumerated member holds no fact. */
	readonly skip: (artifact: WriteArtifact) => ReadonlySet<number>
	/** The form of a statement of an artifact this application sends (`sentForm`). */
	readonly form: (statement: ArtifactStatement) => SentForm
	/**
	 * The placeholder texts of that form: none reads another statement's rows. A relation input's arrays are written
	 * once per statement, by the encoder its placeholders share.
	 */
	readonly values: (
		statement: ArtifactStatement
	) => Result.Result<ReadonlyArray<string>, EncodingFailure | LiteralBound>
	/** How the application's statements reach the server: one flight, or a read flight first (`Flights`). */
	readonly flights: Flights
}

/**
 * The placeholder texts of each execution of a statement, in the order they are sent: one, its `values`, for every
 * statement but a family step's; a family step's, one per statement of its kind in its family's plan (write/family/
 * order.ts plan), each its rows' arrays, none when the application writes no row of that kind. Every execution sends
 * the statement's one text, and its rows are every execution's, in order. A row no statement carries even alone is its
 * family's FamilyRowBound, before any statement is sent.
 */
export type Chunks = (
	statement: ArtifactStatement
) => Result.Result<
	ReadonlyArray<ReadonlyArray<string>>,
	EncodingFailure | LiteralBound | FamilyRowBound
>

/** One family's read as one execution sends it (write/family/edit.ts SuffixRead): its text and its placeholders' texts. */
export interface ReadStatement {
	/** The family whose stored suffixes it reads, which a failure the read meets is attributed to. */
	readonly family: FamilyId
	readonly sql: EmittedText
	readonly params: ReadonlyArray<string>
}

/**
 * How one application's statements reach the server, in its one transaction (rows-first.md §2):
 * - `write`: one flight of the artifact's statements, every family write planned already, since every group it touches
 *   is an owner's the changeset inserts, empty before;
 * - `read`: first a flight of the family reads, one batched SELECT per family of the stored suffixes and the owners'
 *   counts and ends of every touched group, then the artifact's statements, whose family writes `then` plans from the
 *   reads' rows, one array of rows per read in order. Under SERIALIZABLE a concurrent writer to a group the reads read
 *   meets 40001 at one of the two, and grizzle does not retry.
 */
export type Flights =
	| { readonly kind: "write"; readonly chunks: Chunks }
	| {
			readonly kind: "read"
			readonly reads: NonEmptyReadonlyArray<ReadStatement>
			readonly then: (
				rows: ReadonlyArray<Raw>
			) => Result.Result<Chunks, EncodingFailure | FamilyRowBound>
	  }

type BindResult =
	| BoundWrite
	| {
			readonly kind: "invariant-rejected"
			readonly law: LawId
			readonly described: Law
			readonly witness: Witness
	  }

/** Normalizes and encodes one application's inputs.
 *
 * Binding one application's inputs to a WriteProgram, before any SQL is sent.
 *
 * 1. Host normalization of every enumerated member: admission through each column's exact carrier,
 *    collapse of equal facts, refusal of conflicting additions under a declared key, and netting of additions against
 *    deletions. A conflict is invariant-rejected with the key law before any SQL is sent. A commit is never split,
 *    whatever its members' sizes.
 * 2. Each statement's placeholder texts, through the statement's own encoders: a member slot's normalized facts as its
 *    arrays, a declared parameter's value (a ChangeSet.bind value under its private name, or the caller's), and an
 *    attachment's delivered parent keys from its parent statement's rows. A statement whose enumerated member holds no
 *    fact produces no statement, so the runtime may skip it. A column whose array would be longer than one string
 *    holds is refused as its LiteralBound, which the shell raises as InputTooLarge. */
export const bindWrite = (
	program: CompiledWrite,
	inputs: BindInputs
): Result.Result<BindResult, EncodingFailure | CompileError> => {
	const { frontend } = program
	const normalization = normalizeChangeSet(frontend, inputs.members)
	if (!normalization.ok) {
		return Result.err(normalization.error)
	}
	const normalized = normalization.value
	if (normalized.kind === "keyConflict") {
		return Result.ok({
			kind: "invariant-rejected",
			law: normalized.law,
			described: normalized.described,
			witness: keyWitness(normalized.relation, normalized.values)
		})
	}
	/** The normal facts of a member slot of the front end: the one site of the fact "normalizeChangeSet normalizes every
	 * slot of the front end", which each statement's member placeholder and skipped input name by id. A statement is
	 * compiled once and sent by every application, so it can hold only the slot's identity, and the facts exist only per
	 * application, in the table normalization builds over the front end's slots: joining the two is an environment
	 * lookup, a key fixed at compile time against a table built at run time, which no type makes total. */
	const factsOf = (slot: ParamId): NormalizedSlot =>
		defined(normalized.slots.get(slot), `the normal facts of member slot ${slot}`)
	/** The declared parameters' values; each relation parameter's distinct fact count, which chooses the form of a
	 * statement whose take its rows bound (`sentForm`). */
	const counted: Array<{ readonly param: ParamId; readonly count: number }> = []
	const paramValue = (name: string): unknown => inputs.params[name]
	for (const decl of program.params) {
		const value = paramValue(decl.name)
		if (decl.kind === "relation") {
			const normalize = parameterNormalizer({
				relation: decl.name,
				slot: { kind: "slot", name: decl.name },
				columns: positionalColumns(decl.heading),
				codes: frontend.codes
			})
			if (!isIterable(value)) {
				return Result.err(encodeFailure("factShape", slotPlace(decl.name)))
			}
			const normal = normalize(value)
			if (!normal.ok) {
				return Result.err(normal.error)
			}
			counted.push({ param: decl.id, count: normal.value.count })
			continue
		}
		const text = paramEncoder(decl.type, decl.name, frontend.codes)(value)
		if (!text.ok) {
			return Result.err(text.error)
		}
	}
	const holdsNoFact = (slot: ParamId): boolean => factsOf(slot).count === 0
	const skip = (artifact: WriteArtifact): ReadonlySet<number> =>
		new Set(
			artifact.steps.flatMap((step, i) =>
				(step.kind === "write" || step.kind === "advance" || step.kind === "check") &&
				step.skipWhenEmpty !== undefined &&
				holdsNoFact(step.skipWhenEmpty)
					? [i]
					: []
			)
		)
	/**
	 * A placeholder's text: a declared parameter's host value, by its declared name, or the array at its part of a
	 * relation input's arrays, which `arrays` holds once its input's shared encoder wrote them for the statement.
	 */
	const encodeSlot = (
		slot: WriteSlot,
		arrays: Map<unknown, ArrayTexts>
	): Result.Result<string, EncodingFailure | LiteralBound> => {
		switch (slot.kind) {
			case "scalar":
				return slot.encode(inputs.params[slot.param])
			case "relation":
			case "member": {
				const known = arrays.get(slot.encode)
				const written =
					known === undefined
						? slot.kind === "relation"
							? slot.encode(inputs.params[slot.param])
							: slot.encode(factsOf(slot.slot))
						: Result.ok(known)
				if (!written.ok) {
					return written
				}
				arrays.set(slot.encode, written.value)
				return Result.ok(
					defined(written.value[slot.part], `array ${slot.part} of a relation input's arrays`)
				)
			}
		}
	}
	/** Whether a choice runs its whole-relation form: the relation parameter it reads, counted above, holds more distinct
	 * facts than its threshold. Both forms deliver the same rows, so the count decides only which one is sent. */
	const runsLarge = (choice: RelationChoice): boolean =>
		counted.some((p) => p.param === choice.source.param && runsLargeForm(choice, p.count))
	const form = (statement: ArtifactStatement): SentForm => sentForm(statement, runsLarge)
	const values = (
		statement: ArtifactStatement
	): Result.Result<ReadonlyArray<string>, EncodingFailure | LiteralBound> => {
		const out: Array<string> = []
		const arrays = new Map<unknown, ArrayTexts>()
		for (const slot of form(statement).paramSlots) {
			const encoded = encodeSlot(slot, arrays)
			if (!encoded.ok) {
				return Result.err(encoded.error)
			}
			out.push(encoded.value)
		}
		return Result.ok(out)
	}
	/** Each stratum's plan, planned once, at its first family step: the rows of every nested write of the stratum, by
	 * relation, composed by depth. */
	const plans = new Map<number, Result.Result<Plan, FamilyRowBound>>()
	const planOf = (stratum: number): Result.Result<Plan, FamilyRowBound> => {
		const known = plans.get(stratum)
		if (known !== undefined) {
			return known
		}
		const relations: Array<RelationPlanAt> = []
		for (const nested of frontend.nested) {
			if (nested.stratum !== stratum) {
				continue
			}
			const rows = normalized.nested.get(nested.slot.slot) ?? new Map<string, ReadonlyArray<Row>>()
			for (const [relation, inserts] of rows) {
				const reached = defined(
					nested.nesting.reached.find((r) => r.family.member.name === relation),
					`the family a nested write reaches ${relation} by`
				)
				const planned = planRelation(
					{ relation, deletes: [], trees: [], updates: [], inserts },
					inputs.transport
				)
				if (!planned.ok) {
					const refused: Result.Result<Plan, FamilyRowBound> = Result.err({
						_tag: "FamilyRowBound",
						family: reached.family,
						row: planned.error
					})
					plans.set(stratum, refused)
					return refused
				}
				relations.push({ depth: reached.depth, plan: planned.value })
			}
		}
		const result: Result.Result<Plan, FamilyRowBound> = Result.ok(compose(relations, []))
		plans.set(stratum, result)
		return result
	}
	/** A planned statement's arrays: its rows' texts, column by column, each array within the longest string. */
	const arraysOf = (
		relation: string,
		statement: FamilyStatement
	): Result.Result<ReadonlyArray<string>, LiteralBound> => {
		const rows = textsOf(statement)
		const width = rows[0]?.length ?? 0
		return arrayTexts(
			relation,
			Array.from({ length: width }, (_, i) => `column ${i + 1}`),
			rows,
			maxStringLength.value
		)
	}
	const chunks = (
		statement: ArtifactStatement
	): Result.Result<
		ReadonlyArray<ReadonlyArray<string>>,
		EncodingFailure | LiteralBound | FamilyRowBound
	> => {
		const step = statement.step
		if (step.kind !== "family") {
			return Result.map(values(statement), (one) => [one])
		}
		const planned = planOf(step.stratum)
		if (!planned.ok) {
			return planned
		}
		const target = step.target
		const sent: ReadonlyArray<FamilyStatement> = planned.value
			.flat()
			.filter(
				(s) =>
					s.kind === step.statement &&
					(s.kind === "count"
						? target.kind === "owners" && familyKey(s.family) === familyKey(target.family)
						: target.kind === "rows" && s.relation === target.relation)
			)
		const out: Array<ReadonlyArray<string>> = []
		for (const s of sent) {
			const arrays = arraysOf(step.relation, s)
			if (!arrays.ok) {
				return arrays
			}
			out.push(arrays.value)
		}
		return Result.ok(out)
	}
	return Result.ok({
		kind: "bound",
		normalized,
		skip,
		form,
		values,
		flights: { kind: "write", chunks }
	})
}
