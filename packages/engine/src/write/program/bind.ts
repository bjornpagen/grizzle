import { encodeFailure, slotPlace } from "#compiler/codec/fault.ts"
import { arrayTexts, parameterNormalizer, positionalColumns } from "#compiler/codec/recordset.ts"
import { paramEncoder } from "#compiler/codec/scalar.ts"
import type { CompileError, EncodingFailure } from "#compiler/core/errors.ts"
import type { LawId, ParamId } from "#compiler/core/ids.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { maxStringLength } from "#compiler/core/limits.ts"
import { isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { Family } from "#compiler/ir/family.ts"
import type { FamilyId } from "#compiler/ir/law.ts"
import type { ArrayTexts, LiteralBound, WriteSlot } from "#compiler/ir/products.ts"
import type { RelationChoice } from "#compiler/lower/shapes/index.ts"
import { runsLargeForm } from "#compiler/lower/shapes/take/index.ts"
import type { EmittedText } from "#compiler/sql/ast.ts"
import type { Law, Witness } from "#compiler/types/changeset/changeset.ts"
import { isIterable } from "#compiler/write/defined.ts"
import { compose, type RelationPlanAt, relationDepths } from "#compiler/write/family/compose.ts"
import {
	decodeRead,
	type Fact,
	type FillContext,
	ownersOf,
	planEdits,
	readKeys,
	type RelationChanges,
	type StoredFamily,
	type Values
} from "#compiler/write/family/edit.ts"
import { familyKey } from "#compiler/write/family/fold.ts"
import type { NestedRow } from "#compiler/write/family/nesting.ts"
import {
	type FamilyStatement,
	type Phase,
	type Plan,
	planOwners,
	planRead,
	planRelation,
	textsOf,
	type Transport,
	type Unsendable
} from "#compiler/write/family/order.ts"
import type { ReadShape } from "#compiler/write/family/statements.ts"
import type { EnumeratedInput } from "#compiler/write/frontend/compile.ts"
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
import type { CompiledWrite, EditProgram } from "#compiler/write/program/compile.ts"
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
 *   counts and ends of every touched group, then the artifact's statements, whose family writes `writes` plans from the
 *   reads' rows, one array of rows per read in order. Under SERIALIZABLE a concurrent writer to a group the reads read
 *   meets 40001 at one of the two, and grizzle does not retry.
 */
export type Flights =
	| { readonly kind: "write"; readonly chunks: Chunks }
	| {
			readonly kind: "read"
			readonly reads: NonEmptyReadonlyArray<ReadStatement>
			readonly writes: (
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
	const { frontend, edits: programEdits } = program
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
	const noRows: ReadonlyMap<string, ReadonlyMap<string, NestedRow>> = new Map()
	/** Each relation's depth among the families, which orders a stratum's relations' statements. */
	const depthOf = relationDepths(frontend.laws.families)
	/** A member relation's row no statement carries even alone, as the first family it is a member of names it. */
	const rowBound = (relation: string, row: Unsendable): FamilyRowBound => ({
		_tag: "FamilyRowBound",
		family: defined(
			frontend.laws.families.find((f) => f.member.name === relation),
			`a family whose member is ${relation}, which a family write writes`
		),
		row
	})
	/** Each stratum's nested rows planned, by relation: the rows its nested writes insert. */
	const nestedPlans = (
		stratum: number
	): Result.Result<ReadonlyArray<RelationPlanAt>, FamilyRowBound> => {
		const relations: Array<RelationPlanAt> = []
		for (const [relation, rows] of normalized.nested.get(stratum) ?? noRows) {
			const planned = planRelation(
				{
					relation,
					deletes: new Map(),
					trees: new Map(),
					updates: new Map(),
					inserts: new Map([...rows].map(([key, r]) => [key, r.row] as const))
				},
				inputs.transport
			)
			if (!planned.ok) {
				return Result.err(rowBound(relation, planned.error))
			}
			relations.push({ depth: depthOf(relation), plan: planned.value })
		}
		return Result.ok(relations)
	}
	const ctx: FillContext = { codes: frontend.codes, evaluate: frontend.evaluate }
	const factsAt = (slot: ParamId | undefined): ReadonlyArray<Fact> =>
		slot === undefined ? [] : factsOf(slot).facts
	/** The facts a stratum inserts of `relation`, by every insert slot of its but a generated addition's, whose key does
	 * not exist yet, so no member names it. */
	const insertedOf = (stratum: number, relation: string): ReadonlyArray<Fact> =>
		frontend.slots
			.filter((g) => g.stratum === stratum && g.relation.name === relation)
			.flatMap((g) => g.inputs.flatMap(insertSlots))
			.flatMap((slot) => factsOf(slot).facts)
	/** An edit as one application binds it: its changes, its families' inserted owners, and each family's reads, by
	 * their positions in the read flight. */
	interface BoundEdit {
		readonly program: EditProgram
		readonly changes: RelationChanges
		readonly owners: (family: Family) => ReadonlyMap<string, Values>
		readonly reads: ReadonlyArray<{
			readonly family: Family
			readonly shape: ReadShape
			readonly at: ReadonlyArray<number>
		}>
	}
	const reads: Array<ReadStatement> = []
	const edits: Array<BoundEdit> = []
	/** A read no statement carries even alone: the application cannot be sent, which every family step reports. */
	let unreadable: FamilyRowBound | undefined
	for (const editProgram of programEdits) {
		const { edit, target } = editProgram
		const changes: RelationChanges = {
			inserts: factsAt(edit.inserts),
			puts: factsAt(edit.puts),
			deletes: factsAt(edit.deletes)
		}
		const known = new Map<string, ReadonlyMap<string, Values>>()
		const owners = (family: Family): ReadonlyMap<string, Values> => {
			const id = familyKey(family.id)
			const had = known.get(id)
			if (had !== undefined) {
				return had
			}
			const found = ownersOf(ctx, family, insertedOf(edit.stratum, family.owner.name))
			known.set(id, found)
			return found
		}
		const familyReads: Array<BoundEdit["reads"][number]> = []
		for (const read of editProgram.reads) {
			const touched = readKeys(
				ctx,
				target,
				read.family,
				changes,
				new Set(owners(read.family).keys())
			)
			const at: Array<number> = []
			if (touched !== undefined) {
				const parts = planRead(
					touched.keys,
					touched.groups,
					{ key: target.layout.key.length, group: read.family.group.length },
					inputs.transport
				)
				if (!parts.ok) {
					unreadable ??= rowBound(target.relation.name, parts.error)
				} else {
					for (const part of parts.value) {
						at.push(reads.length)
						reads.push({
							family: read.family.id,
							sql: read.sql.sql.text,
							params: [
								...readLiterals(target.relation.name, part.keys, target.layout.key.length),
								...readLiterals(target.relation.name, part.groups, read.family.group.length)
							]
						})
					}
				}
			}
			familyReads.push({ family: read.family, shape: read.sql.shape, at })
		}
		edits.push({ program: editProgram, changes, owners, reads: familyReads })
	}
	/** Each stratum's plan from the reads' rows, one array of rows per read in order: its nested rows and its edits'
	 * rows by relation, composed by depth with its edits' counts. */
	const planned = (
		rows: ReadonlyArray<Raw>
	): Result.Result<ReadonlyMap<number, Plan>, EncodingFailure | FamilyRowBound> => {
		const strata = [
			...new Set([
				...frontend.nested.map((n) => n.stratum),
				...edits.map((e) => e.program.edit.stratum)
			])
		]
		const out = new Map<number, Plan>()
		for (const stratum of strata) {
			const relations = nestedPlans(stratum)
			if (!relations.ok) {
				return relations
			}
			const all: Array<RelationPlanAt> = [...relations.value]
			const counts: Array<Phase<"count">> = []
			for (const bound of edits.filter((e) => e.program.edit.stratum === stratum)) {
				const { target } = bound.program
				const stored = new Map<string, StoredFamily>()
				for (const read of bound.reads) {
					const decoded = decodeRead(
						ctx,
						target,
						read.family,
						read.shape,
						read.at.flatMap((i) => defined(rows[i], `the rows of read ${i}`))
					)
					if (!decoded.ok) {
						return decoded
					}
					stored.set(familyKey(read.family.id), decoded.value)
				}
				const edited = planEdits(ctx, target, bound.changes, stored, bound.owners)
				if (!edited.ok) {
					return edited
				}
				const rowsPlan = planRelation(edited.value.rows, inputs.transport)
				if (!rowsPlan.ok) {
					return Result.err(rowBound(target.relation.name, rowsPlan.error))
				}
				all.push({ depth: depthOf(target.relation.name), plan: rowsPlan.value })
				for (const owner of edited.value.owners) {
					const phase = planOwners(owner, inputs.transport)
					if (!phase.ok) {
						return Result.err(rowBound(target.relation.name, phase.error))
					}
					counts.push(phase.value)
				}
			}
			out.set(stratum, compose(all, counts))
		}
		return Result.ok(out)
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
	/** The chunks of the artifact's statements under the strata's plans: a family step's, one execution per planned
	 * statement of its kind and target; any other's, its one execution. */
	const chunksOf =
		(plans: Result.Result<ReadonlyMap<number, Plan>, EncodingFailure | FamilyRowBound>): Chunks =>
		(statement) => {
			const step = statement.step
			if (step.kind !== "family") {
				return Result.map(values(statement), (one) => [one])
			}
			if (!plans.ok) {
				return plans
			}
			const target = step.target
			const sent: ReadonlyArray<FamilyStatement> = (plans.value.get(step.stratum) ?? noPlan)
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
	const flights: Flights =
		unreadable !== undefined
			? { kind: "write", chunks: chunksOf(Result.err(unreadable)) }
			: isNonEmpty(reads)
				? {
						kind: "read",
						reads,
						writes: (rows) => {
							const plans = planned(rows)
							return plans.ok ? Result.ok(chunksOf(plans)) : plans
						}
					}
				: { kind: "write", chunks: chunksOf(planned([])) }
	return Result.ok({
		kind: "bound",
		normalized,
		skip,
		form,
		values,
		flights
	})
}

/** A read's keys as its placeholders carry them: one array literal per key field, each within the longest string. The
 * read was cut to its transport (order.ts planRead), so every literal fits. */
const readLiterals = (
	relation: string,
	keys: ReadonlyArray<ReadonlyArray<string>>,
	width: number
): ReadonlyArray<string> => {
	const literals = arrayTexts(
		relation,
		Array.from({ length: width }, (_, i) => `key ${i + 1}`),
		keys,
		maxStringLength.value
	)
	if (!literals.ok) {
		throw defect("a read cut to its transport carries every literal it writes")
	}
	return literals.value
}

/** The insert slots of an enumerated input whose facts carry their keys: an insert's, a nested insert's, and a classed
 * insert's complete one. */
const insertSlots = (input: EnumeratedInput): ReadonlyArray<ParamId> => {
	switch (input.kind) {
		case "single":
			return input.act.op === "insert" ? [input.slot.slot] : []
		case "nested":
			return [input.slot.slot]
		case "classed":
			return [input.complete.slot]
	}
}

const noPlan: Plan = [[], [], [], []]
