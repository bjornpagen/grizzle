import { scalarCodec } from "#compiler/codec/scalar.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { namedDetail, type NamedDetailCodec, type RelationInfo } from "#compiler/ir/law.ts"
import { decodeDetail } from "#compiler/laws/model/detail.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { withoutSerial } from "#compiler/scalar/compute/types.ts"
import { isVector } from "#compiler/scalar/values/vector.ts"
import type { KeyHost, Witness } from "#compiler/types/changeset/changeset.ts"
import {
	type AddedTag,
	type ChangeRow,
	type NettedRelation,
	netStrata,
	outcomeCounts,
	outcomeKind,
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
	readonly outcome: "accepted" | "no-change"
	/** One entry per written relation, in code point order. */
	readonly counts: ReadonlyArray<RelationCounts>
	/** Per stratum of the artifact, each relation it changed and what it changed. */
	readonly strata: ReadonlyArray<ReadonlyMap<string, StratumChange>>
	/** Per written relation, delta.added and delta.removed netted across strata. */
	readonly deltas: ReadonlyMap<string, NettedRelation>
}

/** A relation the ChangeSet writes, with the identity its facts are netted across strata by: every field's value, the
 * serial generation flag dropped (delta/net.ts relationIdentity). */
export interface WrittenOutcome {
	readonly relation: RelationInfo
	readonly identity: (fact: Fact) => string
}

/** A written relation with its facts' identity. */
export const writtenOutcome = (relation: RelationInfo): WrittenOutcome =>
	Object.freeze({
		relation,
		identity: relationIdentity(
			relation.heading.map((f) => ({ name: f.name, type: withoutSerial(f.type) }))
		)
	})

export interface OutcomeContext {
	/** The relations the ChangeSet writes, in code point order. */
	readonly written: ReadonlyArray<WrittenOutcome>
	/** Every ordinary relation of the base by name, as a witness the server reports names it. */
	readonly relations: ReadonlyMap<string, RelationInfo>
}

/** A witness that names one violating fact's key. */
export type KeyWitness = Extract<Witness, { readonly kind: "key" }>

/** The witness of one relation's key values. */
export const keyWitness = (relation: string, key: Readonly<Record<string, KeyHost>>): KeyWitness =>
	Object.freeze({ kind: "key", relation, values: Object.freeze(key) })

/** The witness of a residual law whose function withheld the key from a role that does not hold its relation whole. */
const withheldWitness: Witness = Object.freeze({ kind: "withheld" })

/** One fact a write statement's row made present or absent, with the tag of the change. */
type RowChange =
	| { readonly side: "added"; readonly tag: AddedTag; readonly fact: Fact }
	| { readonly side: "removed"; readonly tag: RemovedTag; readonly fact: Fact }

type ChangesConverter = (row: ReadonlyArray<string>) => ReadonlyArray<RowChange>

/** The changes of one write statement's rows, converted as its StatementSpec converts them, by its result
 * (`changeTags`): an insert's rows are facts its action made present, a deletion's facts made absent; an upsert's rows
 * are a put's facts, an update's each a put's fact and the occupant it displaced, a MERGE's a put's fact or a fact its
 * absorbed deletion removed. A span classification raises or returns no row. */
const changesConverter = (result: WriteStepResult): ChangesConverter => {
	switch (result.kind) {
		case "insert": {
			const convert = writeRowConverter(result)
			return (row) => [{ side: "added", tag: result.of, fact: convert(row).fact }]
		}
		case "delete": {
			const convert = writeRowConverter(result)
			const tag = removedTag(result)
			return (row) => [{ side: "removed", tag, fact: convert(row).fact }]
		}
		case "upsert":
		case "update":
		case "merge": {
			const convert = putRowConverter(result)
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

/** The changes of an artifact's statements from their rows; `rowsOf(i)` is statement i's rows, none when the runtime
 * skipped it, and is read only for the statements of the strata. Per stratum of the artifact (`byStratum`), its change
 * to each written relation its write steps returned rows for, keyed by fact identity (`stratumChange`); a write step
 * writes only relations of `context.written`. The changes are each stratum's facts made present and absent, tagged by the member
 * kind that requested them, netted across strata by fact identity into delta.added, delta.removed and the counts, and
 * the outcome kind the counts decide. It reads fields grizzle controls only, never PostgreSQL's message or DETAIL
 * prose. */
export const interpretRows = (
	context: OutcomeContext,
	artifact: WriteArtifact,
	rowsOf: (position: number) => ReadonlyArray<ReadonlyArray<string>>
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
					const convert = changesConverter(w.step.result)
					return w.rows.flatMap((raw) =>
						convert(raw).map((change): ChangeRow => ({
							...change,
							identity: identity(change.fact)
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
	return { outcome: outcomeKind(counts), counts, strata: changes, deltas }
}

/** The witness decoder of a WriteProgram (`WitnessDecoder`), converting grizzle's own texts without a check into a
 * witness:
 *
 * - fromRefusal converts a write statement's refusal key, each text by its field's result codec, into the refused
 *   relation's key values;
 * - fromDetail converts a residual law's DETAIL (`DetailCodec`) into the violating relation's key values by the codec of
 *   the law that raised, which the runtime knows from the constraint name: its key, or `withheld` when the law function
 *   withheld it from a role that does not hold the relation whole. It never reads PostgreSQL's prose.
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
 * refusal's DETAIL carries the refused key's fields and texts, a residual law's DETAIL its DetailCodec key. Both are
 * grizzle's own texts, so nothing is checked. */
export interface KeyDecoder {
	readonly fromRefusal: (
		relation: string,
		key: ReadonlyArray<{ readonly field: string; readonly text: string }>
	) => KeyWitness | undefined
	readonly fromDetail: (detail: string, law: LawId) => Witness | undefined
}

/** A witness is converted from the server's answer, so a text naming a relation, a field or a law this installation does
 * not have, or a key value no key holds, is no witness: undefined, which the caller reports as any statement it cannot
 * classify. */
export const witnessDecoder = (context: OutcomeContext, laws: LawModel): KeyDecoder => {
	const convertKey = (
		relation: string,
		key: ReadonlyArray<{ readonly field: string; readonly text: string }>
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
			/** Every carrier's host value but a vector's is a key value. */
			const value = scalarCodec(withoutSerial(column.type)).convert(text)
			if (isVector(value)) {
				return undefined
			}
			values[field] = value
		}
		return keyWitness(relation, values)
	}
	const codecOf = new Map<LawId, NamedDetailCodec>(
		laws.residuals.map((l) => [l.lawId, namedDetail(l.detail)] as const)
	)
	return {
		fromRefusal: convertKey,
		fromDetail: (detail, law) => {
			/** The law that raised names its own codec, whose relation and key the DETAIL lists, or withholds from a role
			 * that does not hold the relation whole. */
			const codec = codecOf.get(law)
			if (codec === undefined) {
				return undefined
			}
			const decoded = decodeDetail(codec, detail)
			return decoded.kind === "withheld"
				? withheldWitness
				: convertKey(codec.relation, decoded.keys)
		}
	}
}
