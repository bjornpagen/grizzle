import { encodeFailure, slotPlace } from "#compiler/codec/fault.ts"
import { parameterNormalizer, positionalColumns } from "#compiler/codec/recordset.ts"
import { paramEncoder } from "#compiler/codec/scalar.ts"
import type { CompileError, EncodingFailure } from "#compiler/core/errors.ts"
import type { LawId, ParamId } from "#compiler/core/ids.ts"
import { defined } from "#compiler/core/invariant.ts"
import * as Result from "#compiler/core/result.ts"
import type { ArrayTexts, LiteralBound, WriteSlot } from "#compiler/ir/products.ts"
import type { RelationChoice } from "#compiler/lower/shapes/index.ts"
import { runsLargeForm } from "#compiler/lower/shapes/take/index.ts"
import type { Law, Witness } from "#compiler/types/changeset/changeset.ts"
import { isIterable } from "#compiler/write/defined.ts"
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
				columns: positionalColumns(decl.heading)
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
		const text = paramEncoder(decl.type, decl.name)(value)
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
	return Result.ok({ kind: "bound", normalized, skip, form, values })
}
