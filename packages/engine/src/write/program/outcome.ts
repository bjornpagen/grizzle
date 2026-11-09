import { scalarReader } from "#compiler/codec/read.ts"
import type { OutputText } from "#compiler/core/wire.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { RelationInfo } from "#compiler/ir/law.ts"
import { isAdmittedBytes } from "#compiler/scalar/values/bytes.ts"
import type { FactIdentity } from "#compiler/scalar/values/identity.ts"
import { isVector } from "#compiler/scalar/values/vector.ts"
import type { KeyHost, Witness } from "#compiler/types/changeset/changeset.ts"
import {
	type AddedTag,
	type ChangeRow,
	type NettedRelation,
	netStrata,
	outcomeCounts,
	type RelationCounts,
	type RemovedTag,
	relationChanges,
	relationIdentity,
	type StratumChange,
	stratumChange
} from "#compiler/write/delta/net.ts"
import { type Fact, writeRowConverter } from "#compiler/write/insert/rows.ts"
import {
	byStratum,
	removedTag,
	type WriteArtifact,
	type WriteStepResult,
	writeRows
} from "#compiler/write/program/artifact.ts"
import { putRowConverter } from "#compiler/write/put/rows.ts"

/** The changes an artifact's statements made. */
interface WriteChanges {
	/** One entry per written relation, in code point order. */
	readonly counts: ReadonlyArray<RelationCounts>
	/** Per stratum of the artifact, each relation it changed and what it changed. */
	readonly strata: ReadonlyArray<ReadonlyMap<string, StratumChange>>
	/** Per written relation, delta.added and delta.removed netted across strata. */
	readonly deltas: ReadonlyMap<string, NettedRelation>
}

/** A relation the ChangeSet writes, with the identity its facts are netted across strata by: every field's value
 * (delta/net.ts relationIdentity). */
export interface WrittenOutcome {
	readonly relation: RelationInfo
	readonly identity: (fact: Fact) => FactIdentity
}

/** A written relation with its facts' identity, a closed id's and a set's values read by the installation's codes. */
export const writtenOutcome =
	(codes: Codebook) =>
	(relation: RelationInfo): WrittenOutcome =>
		Object.freeze({
			relation,
			identity: relationIdentity(
				relation.heading.map((f) => ({ name: f.name, type: f.type })),
				codes
			)
		})

export interface OutcomeContext {
	/** The relations the ChangeSet writes, in code point order. */
	readonly written: ReadonlyArray<WrittenOutcome>
	/** Every ordinary relation of the base by name, as a witness the server reports names it. */
	readonly relations: ReadonlyMap<string, RelationInfo>
	/** The installation's codes, which a returned row's and a witness's closed ids and sets are read by. */
	readonly codes: Codebook
}

/** Whether a host value is a set's, which no key holds. */
const isSet = (value: unknown): value is ReadonlySet<unknown> => value instanceof Set

/** A witness that names one violating fact's key. */
export type KeyWitness = Extract<Witness, { readonly kind: "key" }>

/** The witness of one relation's key values. */
export const keyWitness = (relation: string, key: Readonly<Record<string, KeyHost>>): KeyWitness =>
	Object.freeze({ kind: "key", relation, values: Object.freeze(key) })

/** One fact a write statement's row made present or absent, with the tag of the change. */
type RowChange =
	| { readonly side: "added"; readonly tag: AddedTag; readonly fact: Fact }
	| { readonly side: "removed"; readonly tag: RemovedTag; readonly fact: Fact }

type ChangesConverter = (row: ReadonlyArray<OutputText>) => ReadonlyArray<RowChange>

/** The changes of one write statement's rows, converted as its StatementSpec converts them, by its result
 * (`changeTags`): an insert's rows are facts its action made present, a deletion's facts made absent; an upsert's rows
 * are a put's facts, an update's each a put's fact and the occupant it displaced, a MERGE's a put's fact or a fact its
 * absorbed deletion removed. A span classification raises or returns no row. */
const changesConverter = (result: WriteStepResult, codes: Codebook): ChangesConverter => {
	switch (result.kind) {
		case "insert": {
			const convert = writeRowConverter(result, codes)
			return (row) => [{ side: "added", tag: result.of, fact: convert(row).fact }]
		}
		case "delete": {
			const convert = writeRowConverter(result, codes)
			const tag = removedTag(result)
			return (row) => [{ side: "removed", tag, fact: convert(row).fact }]
		}
		case "upsert":
		case "update":
		case "merge": {
			const convert = putRowConverter(result, codes)
			return (row): ReadonlyArray<RowChange> => {
				const r = convert(row)
				switch (r.kind) {
					case "added":
						return [{ side: "added", tag: "put", fact: r.fact }]
					case "replaced":
						return [
							{ side: "removed", tag: "displaced", fact: r.old },
							{ side: "added", tag: "put", fact: r.fact }
						]
					case "removed":
						return [{ side: "removed", tag: "delete", fact: r.fact }]
				}
			}
		}
		case "spanClassify":
			return () => []
	}
}

/**
 * The identity a write step's rows are told apart by: a relation's facts' (`relationIdentity` over its heading), but a
 * family's count statement's, whose rows are its owners' keys, counts and ends alone (write/family/statements.ts
 * countReturned), over exactly those columns, so no identity reads a column its statement did not return. A member's
 * writer reads no other column of its owner, and an owner's change from a member write is that part of it.
 */
const stepIdentity = (
	counts: boolean,
	result: WriteStepResult,
	identity: (fact: Fact) => FactIdentity,
	codes: Codebook
): ((fact: Fact) => FactIdentity) =>
	counts && result.kind === "update"
		? relationIdentity(result.columns.slice(0, result.fields.length), codes)
		: identity

/**
 * The changes of an artifact's statements from their rows; `rowsOf(i)` is statement i's rows, none when the runtime
 * skipped it, and is read only for the statements of the strata. Per stratum of the artifact (`byStratum`), its change
 * to each written relation its write steps returned rows for, keyed by fact identity (`stratumChange`); a write step
 * writes only relations of `context.written`. The changes are each stratum's facts made present and absent, tagged by
 * the member kind that requested them, netted across strata by fact identity into delta.added, delta.removed and the
 * counts, whose outcome kind the shell's outcome value decides from them (delta/net.ts outcomeKind). It reads fields
 * grizzle controls only, never PostgreSQL's message or DETAIL prose.
 */
export const interpretRows = (
	context: OutcomeContext,
	artifact: WriteArtifact,
	rowsOf: (position: number) => ReadonlyArray<ReadonlyArray<OutputText>>
): WriteChanges => {
	const changes = byStratum(artifact.statements).map((statements) => {
		const returned = statements
			.flatMap((s) => writeRows(s.step, rowsOf(s.index)))
			.filter((w) => w.rows.length > 0)
		return new Map(
			context.written.flatMap(({ relation, identity }) => {
				const own = returned.filter((w) => w.step.relation === relation.name)
				if (own.length === 0) {
					return []
				}
				const rows = own.flatMap((w) => {
					const convert = changesConverter(w.step.result, context.codes)
					const identityOf = stepIdentity(w.counts, w.step.result, identity, context.codes)
					return w.rows.flatMap((raw) =>
						convert(raw).map((change): ChangeRow => ({
							...change,
							identity: identityOf(change.fact)
						}))
					)
				})
				return [[relation.name, stratumChange(rows)] as const]
			})
		)
	})
	const written = context.written.map((w) => w.relation.name)
	const counts = outcomeCounts(written, changes)
	const deltas = new Map<string, NettedRelation>()
	for (const relation of written) {
		deltas.set(relation, netStrata(relationChanges(changes, relation)))
	}
	return { counts, strata: changes, deltas }
}

/** The witness decoder of a write, converting grizzle's own texts without a check into a witness:
 * fromRefusal converts a write statement's refusal key, each text by its field's result codec, into the
 * refused relation's key values. It never reads PostgreSQL's prose.
 *
 * A refusal is never a row. The statement that detects it raises it inside the transaction, so PostgreSQL aborts the
 * transaction and nothing commits:
 *
 * - a law's refusal is SQLSTATE 23000 with the law's identity as the constraint name: a same-key pair within the input
 *   (c9), on a put's insert half as anywhere else, or a DO SELECT conflict witness on an insertion (c7 false), the
 *   primary key's law (the protocol's arbiter) with the key values as its witness; a unique object besides the arbiter
 *   refusing a requested fact, that object's law with the fact's values at the object's fields as its witness, on a
 *   put's insert half too; two requested facts overlapping at a span primary key, or a stored fact overlapping a
 *   requested one, the key law with the requested key;
 * - a concurrent change is SQLSTATE 40Z01: a DO SELECT conflict witness on a put's insert half is a concurrent commit
 *   at the key after the put's deletion, PutTargetConflict; an occupant the arbiter met at a span key that has since
 *   gone, or on a put's insert half one committed at the put's key after its deletion, SpanKeyChange.
 *
 * The runtime classifies the raised error as it does any statement's, its witness converted by this decoder: a
 * refusal's DETAIL carries the refused key's fields and texts, grizzle's own, so nothing is checked. Every other law is
 * a native the server names by its constraint, whose witness its classifier reads. */
export interface KeyDecoder {
	readonly fromRefusal: (
		relation: string,
		key: ReadonlyArray<{ readonly field: string; readonly text: OutputText }>
	) => KeyWitness | undefined
}

/** A witness is converted from the server's answer, so a text naming a relation, a field or a law this installation does
 * not have, or a key value no key holds, is no witness: undefined, which the caller reports as any statement it cannot
 * classify. */
export const witnessDecoder = (context: OutcomeContext): KeyDecoder => {
	const convertKey = (
		relation: string,
		key: ReadonlyArray<{ readonly field: string; readonly text: OutputText }>
	): KeyWitness | undefined => {
		const info = context.relations.get(relation)
		if (info === undefined) {
			return undefined
		}
		const values: Record<string, KeyHost> = {}
		for (const { field, text } of key) {
			const column = info.heading.find((h) => h.name === field)
			if (column === undefined) {
				return undefined
			}
			/**
			 * Every carrier's host value but a vector's, a set's and bytes' is a key value: ownership refuses a key over a
			 * set or bytes.
			 */
			const value = scalarReader(column.type, context.codes).convert(text)
			if (isVector(value) || isSet(value) || isAdmittedBytes(value)) {
				return undefined
			}
			values[field] = value
		}
		return keyWitness(relation, values)
	}
	return { fromRefusal: convertKey }
}
