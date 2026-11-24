/**
 * factsDecoder(schema): the rows `ChangeSet.empty(S).insertAll(rows)` takes of one top-level relation, decoded from a
 * value of any shape, by the insert's own admission: the value is held exactly where the write holds a call's facts and
 * its rows' domains are held as rowEvaluator holds them, so a value decode admits is one the insert admits and PostgreSQL
 * stores within every domain, and one it refuses is refused there, at the same row and field, by the same fault.
 *
 * The schema's law model is compiled once, the one every reader of the schema value reads (program/schema.ts
 * builtLawModel), and a relation's insert where it is first decoded: the insert of its families, the host half of the
 * compile every write takes, which insertPreview's calls compile and share (program/preview.ts familyInsertsOf), so a
 * relation's member is admitted by the normalizer its slot group holds (runtime/write/normalize.ts bindGroup, its
 * heading planned once, where the insert is prepared), and a nested relation's levels each by a normalizer of its own,
 * built where the relation is first decoded (runtime/write/nesting.ts levelNormalizer), each fact split along its
 * sequences by one splitter (runtime/write/addition.ts additionSplitter), whose splits are worked out once a relation.
 * A relation whose families' insert refuses as it compiles refuses each value decoded of it (Uncompiled). Every domain
 * is judged by one judge over the schema's closed relations and one table of patterns (runtime/write/witness.ts
 * judgeOf), as rowEvaluator judges them, so a closed relation is indexed and a pattern parsed once for the decoder.
 *
 * Each row is read as the write reads it, in the write's order: a flat relation's facts one after another, each by its
 * normalizer (codec/recordset.ts RelationNormalizer readRow: the null ban, the fact's shape, each field by
 * scalar/values/identity.ts admitValue), a nested relation's each split and then its levels read members before owners,
 * as the write lays a nesting out (nesting.ts nestedReader, the write's own reader). Only once every row has met its
 * types are the rows' domains judged, so a refusal the write meets is decode's whatever domain another row breaks.
 *
 * The decoded rows are the value itself, nothing copied, and what decode read of them is the write's read: decode
 * freezes the array and its rows and records its reads of them (runtime/write/decoded.ts), which a write of the array
 * under equal headings takes instead of reading the rows again, and a ChangeSet that takes the array keeps it as it is.
 * An array a proxy's traps keep from being frozen is not recorded, and is read again as any is. A bytes value's bytes
 * are not read: its digest is the write's, and two bytes values of one digest that differ, a SHA-256 collision, are the
 * write's to refuse.
 */

import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { closedTableOf } from "#compiler/analysis/schema.ts"
import type { RelationNormalizer, RowRefusal } from "#compiler/codec/recordset.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import type { StoredRelationName } from "#compiler/core/ids.ts"
import { captureLoc } from "#compiler/core/loc.ts"
import type { PublicResult } from "#compiler/core/public-result.ts"
import { isList } from "#compiler/core/record.ts"
import type { FamilyId } from "#compiler/ir/law.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { isRefined } from "#compiler/ir/scalar.ts"
import { domainRefusal } from "#compiler/program/evaluate.ts"
import { parseBuiltSchema } from "#compiler/program/input.ts"
import { familyInsertsOf } from "#compiler/program/preview.ts"
import { compiledSchema } from "#compiler/program/schema.ts"
import { additionSplitter, type NestingLevels } from "#compiler/runtime/write/addition.ts"
import { type DecodedInput, recordDecoded } from "#compiler/runtime/write/decoded.ts"
import { levelNormalizer, nestedReader } from "#compiler/runtime/write/nesting.ts"
import { type JudgedField, type Judge, judgeOf } from "#compiler/runtime/write/witness.ts"
import type { HeadingPlan, ReadFact } from "#compiler/scalar/values/identity.ts"
import type { InsertableNameOf, InsertAllRowsOf } from "#compiler/types/changeset/changeset.ts"
import type { FactsDecoder, FactsRefused, RowPlace } from "#compiler/types/changeset/decode.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"

/**
 * A level of a relation's rows as decode reads them: the normalizer its facts are read by, its refined fields, and each
 * field's position among the normalizer's, where a read fact holds its value (codec/recordset.ts RelationNormalizer
 * `fields`).
 */
interface Level {
	readonly normalize: RelationNormalizer
	readonly refined: ReadonlyArray<JudgedField>
	readonly at: ReadonlyMap<string, number>
}

/** A refusal of one row, where in the row it stands and by which fault, as decode answers it (FactsRefused). */
interface RowPlaced {
	readonly at: RowPlace
	readonly fault: RowRefusal["fault"]
}

/** A read's refusal placed in its row: at its field where it names one, at the row's shape otherwise. */
const placed = (refusal: RowRefusal): RowPlaced => ({
	at: refusal.field === undefined ? { kind: "shape" } : { kind: "field", field: refusal.field },
	fault: refusal.fault
})

/** A level over `normalize`, its refined fields read off `heading`, the heading its facts are admitted by. */
const levelOf = (normalize: RelationNormalizer, heading: Heading): Level => {
	const types = new Map(heading.map((c) => [c.name, c.type] as const))
	return {
		normalize,
		refined: normalize.fields.flatMap((name): ReadonlyArray<JudgedField> => {
			const type = defined(types.get(name), `the type of ${name}, a field its heading admits`)
			return isRefined(type) ? [{ name, type, writing: { kind: "caller" } }] : []
		}),
		at: new Map(normalize.fields.map((name, at) => [name, at] as const))
	}
}

/** The first refined field of a level's read whose value is outside its domain (evaluate.ts domainRefusal), or none. */
const domainOf = (judge: Judge, level: Level, read: ReadFact): string | undefined =>
	domainRefusal(
		judge,
		level.refined,
		(name) => read.values[defined(level.at.get(name), `${name}, a field its level reads`)]
	)

/**
 * A relation's rows decoded: each row read as the write reads a fact of its member, into its read (R), every row before
 * any domain is judged, then each row's domains, then the reads kept for the write (runtime/write/decoded.ts
 * DecodedInput); or the first refusal its rows meet, at its row.
 */
type RowsDecoder = (
	rows: ReadonlyArray<unknown>
) => Result.Result<
	DecodedInput,
	Exclude<FactsRefused, { readonly _tag: "RowsRefused" | "Uncompiled" }>
>

/**
 * The decoder of a relation's rows (`RowsDecoder`) whose rows each read into an R: `read`, the write's reader of a fact
 * of its member, its refusal unplaced; `domain`, the first refined field of a read outside its domain, at any level of
 * it; `kept`, the reads of every row, kept for the write.
 */
const rowsDecoder =
	<R>(
		read: (fact: unknown) => Result.Result<R, RowRefusal>,
		domain: (read: R) => string | undefined,
		kept: (reads: ReadonlyArray<R>) => DecodedInput
	): RowsDecoder =>
	(rows) => {
		const reads: Array<R> = []
		for (const [row, fact] of rows.entries()) {
			const one = read(fact)
			if (!one.ok) {
				return Result.err({ _tag: "ValueRefused", row, ...placed(one.error) })
			}
			reads.push(one.value)
		}
		for (const [row, one] of reads.entries()) {
			const field = domain(one)
			if (field !== undefined) {
				return Result.err({ _tag: "DomainRefused", row, field })
			}
		}
		return Result.ok(kept(reads))
	}

/** How many rows a decoded input's reads hold: one each. */
const rowsOf = (input: DecodedInput): number => {
	switch (input.kind) {
		case "flat":
			return input.reads.length
		case "nested":
			return input.readings.length
	}
}

/**
 * Freezes an array decode admitted and every row of it, so neither holds anything after decode but what decode read:
 * whether it could, since freezing a proxy runs its traps, which may throw or refuse.
 */
const frozen = (rows: ReadonlyArray<unknown>): boolean =>
	hostRead(
		() => "unfrozen" as const,
		() => {
			Object.freeze(rows)
			for (const row of rows) {
				Object.freeze(row)
			}
			return Result.ok("frozen" as const)
		}
	).ok

/**
 * factsDecoder(schema), the shell's (packages/grizzle adapter/public/host.ts), over `answer`, the shell's spelling of a
 * caller's Result (see the header): the schema's law model compiled once, or its CompileError; then `decode(K, value)`
 * is the value as K's rows, or the first refusal its rows meet. Each relation's decoder is built where it is first
 * decoded, from the insert of its families, and read by every later call.
 */
export const factsDecoderOver = <S extends AnySchema>(
	schema: S,
	answer: PublicResult
): Result.Result<FactsDecoder<S>, CompileError> =>
	Result.map(
		Result.flatMap(parseBuiltSchema(schema, captureLoc("factsDecoder", [])), compiledSchema),
		(state) => {
			const judge = judgeOf(closedTableOf(state.model.checked), state.model.checked.patterns)
			const inserts = familyInsertsOf(schema, state)
			/** The decoder of `relation`'s rows (RowsDecoder), from its member's input in its families' insert, or the
			 * CompileError that insert refuses by. */
			const decoderOf = (relation: string): Result.Result<RowsDecoder, CompileError> =>
				Result.map(inserts.writeOf([relation]), ({ host }): RowsDecoder => {
					const { slot } = defined(
						host.binding.members.find((m) => m.relation === relation),
						`the member of ${relation}, a relation its insert inserts at its top level`
					)
					const input = defined(
						host.prepared.groups
							.flatMap((group) => group.inputs)
							.find((i) => i.members.some((m) => m.name === slot)),
						`the input of ${slot}`
					)
					switch (input.kind) {
						case "single": {
							const normalize = defined(
								input.members.find((m) => m.name === slot),
								`the normalizer of ${slot}`
							).normalize
							const level = levelOf(normalize, input.slot.heading)
							return rowsDecoder(
								normalize.readRow,
								(read) => domainOf(judge, level, read),
								(reads) => ({ kind: "flat", plan: normalize.plan, reads })
							)
						}
						case "nested": {
							const { nesting } = input
							const level = (of: StoredRelationName, heading: Heading): Level =>
								levelOf(levelNormalizer(of, heading, slot, host.codes), heading)
							const levels: NestingLevels<Level> = {
								own: level(nesting.relation, nesting.own),
								members: new Map<FamilyId, Level>(
									nesting.sequences.map((f) => [f.id, level(f.member, f.heading)] as const)
								)
							}
							const plans: NestingLevels<HeadingPlan> = {
								own: levels.own.normalize.plan,
								members: new Map(
									[...levels.members].map(([family, l]) => [family, l.normalize.plan] as const)
								)
							}
							return rowsDecoder(
								nestedReader(nesting.relation, levels, additionSplitter(nesting.sequences)),
								(reading) => {
									for (const { level: at, read } of reading.reads) {
										const field = domainOf(judge, at, read)
										if (field !== undefined) {
											return field
										}
									}
									return undefined
								},
								(readings) => ({ kind: "nested", plans, readings })
							)
						}
					}
				})
			const decoders = new Map<string, Result.Result<RowsDecoder, CompileError>>()
			/**
			 * The one site of the fact "rows decode admitted are InsertAllRowsOf<S>[K]": each row is K's addition in S, every
			 * field the codec's host value of its type inside its domains, which K's decoder, the compiled insert's admission,
			 * read off the value at run time, a correlation of S's type with the compiled write that no TypeScript type ties.
			 * The rows are read against K's decoder and the rows it admitted, every one of them.
			 */
			const isRowsOf = <K extends InsertableNameOf<S>>(
				relation: K,
				rows: ReadonlyArray<unknown>,
				admitted: number
			): rows is InsertAllRowsOf<S>[K] => decoders.has(relation) && rows.length === admitted
			const decode = <K extends InsertableNameOf<S>>(
				relation: K,
				facts: unknown
			): Result.Result<InsertAllRowsOf<S>[K], FactsRefused> => {
				if (!isList(facts)) {
					return Result.err({ _tag: "RowsRefused" })
				}
				const compiled = decoders.getOrInsertComputed(relation, () => decoderOf(relation))
				if (!compiled.ok) {
					return Result.err({ _tag: "Uncompiled", error: compiled.error })
				}
				const rows: ReadonlyArray<unknown> = facts
				const input = compiled.value(rows)
				if (!input.ok) {
					return input
				}
				if (!isRowsOf(relation, rows, rowsOf(input.value))) {
					throw defect("decoded rows, every one of them admitted")
				}
				if (frozen(rows)) {
					recordDecoded(rows, input.value)
				}
				return Result.ok(rows)
			}
			return { decode: (relation, facts) => answer(decode(relation, facts)) }
		}
	)
