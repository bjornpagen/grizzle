import { compareCodePoints } from "@bjornpagen/grizzle-text/text"
import { detailValue } from "#compiler/codec/read.ts"
import type { RoleRelationName, StoredRelationName } from "#compiler/core/ids.ts"
import type { TextsId } from "#compiler/core/text.ts"
import type { OutputText } from "#compiler/core/wire.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import {
	type ChangeRow,
	outcomeCounts,
	type RelationCounts,
	relationIdentity,
	type Tag
} from "#compiler/runtime/write/net.ts"
import { putRowConverter } from "#compiler/runtime/write/put-rows.ts"
import { type Fact, writeRowConverter } from "#compiler/runtime/write/rows.ts"
import {
	byStratum,
	removedTag,
	type WriteStep,
	type WriteStepResult,
	writeRows
} from "#compiler/runtime/write/steps.ts"
import { isAdmittedBytes } from "#compiler/scalar/values/bytes.ts"
import { isVector } from "#compiler/scalar/values/vector.ts"
import type { DrawnBy, KeyHost, Witness } from "#compiler/types/changeset/changeset.ts"
import type { FamilyPart } from "#compiler/write/family/written.ts"

/** The changes an artifact's statements made. */
interface WriteChanges {
	/** One entry per written relation, in code point order. */
	readonly counts: ReadonlyArray<RelationCounts>
}

/** A relation the ChangeSet writes, by name, with the identity its facts are netted across strata by: every field's
 * value (net.ts relationIdentity). */
export interface WrittenOutcome {
	readonly relation: StoredRelationName
	readonly identity: (fact: Fact) => TextsId
}

/** A relation the ChangeSet writes, by name, with its heading, every field's name and type. */
export interface WrittenHeading {
	readonly relation: StoredRelationName
	readonly heading: Heading
}

/** A written relation with its facts' identity, a closed id's and a set's values read by the installation's codes. */
export const writtenOutcome =
	(codes: Codebook) =>
	(written: WrittenHeading): WrittenOutcome =>
		Object.freeze({
			relation: written.relation,
			identity: relationIdentity(written.heading, codes)
		})

/** What a write's rows are read by: the relations it writes, and the installation's codes, which a returned row's closed
 * ids and sets are read by. */
export interface OutcomeContext {
	/** The relations the ChangeSet writes, in code point order. */
	readonly written: ReadonlyArray<WrittenOutcome>
	readonly codes: Codebook
}

/**
 * What a witness the server reports is read by: every ordinary relation of the base by the name a refusal's DETAIL
 * spells it, with its heading and the witness of a key of it in the words its role states its facts in (its own, or a
 * query entry's it writes the relation through); and the installation's codes, which a witness's closed ids and sets
 * are read by.
 */
export interface WitnessRelations {
	readonly relations: ReadonlyMap<
		string,
		{
			readonly heading: Heading
			readonly witness: (values: Readonly<Record<string, KeyHost>>) => KeyWitness
		}
	>
	readonly codes: Codebook
}

/** Whether a host value is a set's, which no key holds. */
const isSet = (value: unknown): value is ReadonlySet<unknown> => value instanceof Set

/** A witness that names one violating fact's key. */
export type KeyWitness = Extract<Witness, { readonly kind: "key" }>

/** The witness of one relation's key values, the relation named as the facts were stated: a stored relation's own name,
 * or a query entry's. */
export const keyWitness = (
	relation: RoleRelationName,
	key: Readonly<Record<string, KeyHost>>
): KeyWitness => Object.freeze({ kind: "key", relation, values: Object.freeze(key) })

/**
 * The witness of one relation's key where the database draws some of its fields (Witness `drawn`): the values of the
 * others, and each drawn field by what draws it.
 */
export const drawnWitness = (
	relation: RoleRelationName,
	values: Readonly<Record<string, KeyHost>>,
	drawn: Readonly<Record<string, DrawnBy>>
): Witness =>
	Object.freeze({
		kind: "drawn",
		relation,
		values: Object.freeze(values),
		drawn: Object.freeze(drawn)
	})

/** One fact a write statement's row made present or absent, with the tag of the change. */
interface RowChange {
	readonly tag: Tag
	readonly fact: Fact
}

type ChangesConverter = (row: ReadonlyArray<OutputText>) => ReadonlyArray<RowChange>

/** The changes of one write statement's rows, converted as its StatementSpec converts them, by its result
 * (`changeTags`): an insert's rows are facts its action made present, a deletion's facts made absent; an upsert's rows
 * are a put's facts, an update's each a put's fact and the occupant it displaced. */
const changesConverter = (result: WriteStepResult, codes: Codebook): ChangesConverter => {
	switch (result.kind) {
		case "insert": {
			const convert = writeRowConverter(result, codes)
			return (row) => [{ tag: result.of, fact: convert(row).fact }]
		}
		case "delete": {
			const convert = writeRowConverter(result, codes)
			const tag = removedTag(result)
			return (row) => [{ tag, fact: convert(row).fact }]
		}
		case "upsert":
		case "update": {
			const convert = putRowConverter(result, codes)
			return (row): ReadonlyArray<RowChange> => {
				const r = convert(row)
				switch (r.kind) {
					case "added":
						return [{ tag: "put", fact: r.fact }]
					case "replaced":
						return [
							{ tag: "displaced", fact: r.old },
							{ tag: "put", fact: r.fact }
						]
				}
			}
		}
	}
}

/**
 * The identity a write step's rows are told apart by: a relation's facts' (`relationIdentity` over its heading), but a
 * family's count statement's, whose rows are its owners' keys, counts and ends alone (write/family/statements.ts
 * countReturned), over exactly those columns, so no identity reads a column its statement did not return. A member's
 * writer reads no other column of its owner, and an owner's change from a member write is that part of it.
 */
const stepIdentity = (
	returned: FamilyPart["rows"],
	result: WriteStepResult,
	identity: (fact: Fact) => TextsId,
	codes: Codebook
): ((fact: Fact) => TextsId) =>
	returned === "counts" && result.kind === "update"
		? relationIdentity(result.columns.slice(0, result.fields.length), codes)
		: identity

/**
 * The changes of an artifact's statements from their rows; `rowsOf(i)` is statement i's rows, none when the runtime
 * skipped it, and is read only for the statements of the strata. Per stratum of the artifact (`byStratum`), the rows
 * its write steps returned for each written relation, each a fact's identity and its change's tag; a write step writes
 * only relations of `context.written`. Each stratum's rows are its change (net.ts stratumChange), the facts it made
 * present and absent, tagged by the member kind that requested them, and the strata's changes are summed by fact
 * identity into the counts (`outcomeCounts`), whose outcome kind the shell's outcome value decides from them
 * (runtime/write/net.ts outcomeKind). It reads fields grizzle controls only, never PostgreSQL's message or DETAIL prose.
 *
 * A relation only insertions return rows of is counted from its rows alone, none of them read (`insertedCounts`): each
 * is a fact its INSERT made present, so no row repeats another's fact and none is made absent, and its sum over the
 * strata is its rows' count under their insertions' tags.
 */
export const interpretRows = (
	context: OutcomeContext,
	statements: ReadonlyArray<{ readonly index: number; readonly step: WriteStep }>,
	rowsOf: (position: number) => ReadonlyArray<ReadonlyArray<OutputText>>
): WriteChanges => {
	const returned = byStratum(statements).map((inStratum) =>
		inStratum.flatMap((s) => writeRows(s.step, rowsOf(s.index))).filter((w) => w.rows.length > 0)
	)
	const steps = returned.flat()
	/** Whether only insertions return rows of `relation`. */
	const insertedOnly = (relation: StoredRelationName): boolean =>
		steps.every((w) => w.step.relation !== relation || w.step.result.kind === "insert")
	const inserted = [...new Set(context.written.map((w) => w.relation))].filter(insertedOnly)
	const netted = context.written.filter((w) => !insertedOnly(w.relation))
	const changes = returned.map(
		(inStratum) =>
			new Map(
				netted.flatMap(({ relation, identity }) => {
					const own = inStratum.filter((w) => w.step.relation === relation)
					if (own.length === 0) {
						return []
					}
					const rows: Array<ChangeRow> = []
					for (const w of own) {
						const convert = changesConverter(w.step.result, context.codes)
						const identityOf = stepIdentity(w.returned, w.step.result, identity, context.codes)
						for (const raw of w.rows) {
							for (const change of convert(raw)) {
								rows.push({ identity: identityOf(change.fact), tag: change.tag })
							}
						}
					}
					return [[relation, rows] as const]
				})
			)
	)
	return {
		counts: [
			...outcomeCounts(
				netted.map((w) => w.relation),
				changes
			),
			...inserted.map((relation) => insertedCounts(relation, steps))
		].toSorted((a, b) => compareCodePoints(a.relation, b.relation))
	}
}

/**
 * The counts of a relation only insertions return rows of (`interpretRows`): each step's rows under its insertion's
 * tag, an insert's added and a put's insert half's put.
 */
const insertedCounts = (
	relation: StoredRelationName,
	steps: ReadonlyArray<{
		readonly step: { readonly relation: StoredRelationName; readonly result: WriteStepResult }
		readonly rows: ReadonlyArray<unknown>
	}>
): RelationCounts => {
	let added = 0n
	let put = 0n
	for (const w of steps) {
		if (w.step.relation !== relation || w.step.result.kind !== "insert") {
			continue
		}
		const rows = BigInt(w.rows.length)
		switch (w.step.result.of) {
			case "insert":
				added += rows
				break
			case "put":
				put += rows
				break
		}
	}
	return { relation, added, deleted: 0n, put }
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
 *   at the key after the put's deletion, PutTargetConflict, and at a span key, SpanKeyChange.
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
export const witnessDecoder = (context: WitnessRelations): KeyDecoder => {
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
			 * set or bytes. The text is PostgreSQL's output of the value, which detailValue reads.
			 */
			const value = detailValue(column.type, context.codes, text)
			if (isVector(value) || isSet(value) || isAdmittedBytes(value)) {
				return undefined
			}
			values[field] = value
		}
		return info.witness(values)
	}
	return { fromRefusal: convertKey }
}
