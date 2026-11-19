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
 * as the write lays a nesting out (nesting.ts levelOrder). Only once every row has met its types are the rows' domains
 * judged, so a refusal the write meets is decode's whatever domain another row breaks. The decoded rows are the value
 * itself: nothing is copied, and the insert admits them again as it admits any call's facts. A bytes value's bytes are
 * not read: its digest is the write's, and two bytes values of one digest that differ, a SHA-256 collision, are the
 * write's to refuse.
 */

import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { RelationNormalizer, RowRefusal } from "#compiler/codec/recordset.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { StoredRelationName } from "#compiler/core/ids.ts"
import { captureLoc } from "#compiler/core/loc.ts"
import type { PublicResult } from "#compiler/core/public-result.ts"
import { isList } from "#compiler/core/record.ts"
import type { FamilyId } from "#compiler/ir/law.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { isRefined } from "#compiler/ir/scalar.ts"
import { domainRefusal } from "#compiler/program/evaluate.ts"
import { familyInsertsOf } from "#compiler/program/preview.ts"
import { builtLawModel, parseBuiltSchema } from "#compiler/program/schema.ts"
import { type AdditionSplitter, additionSplitter } from "#compiler/runtime/write/addition.ts"
import { levelNormalizer, levelOrder, type NestingLevels } from "#compiler/runtime/write/nesting.ts"
import { type JudgedField, type Judge, judgeOf } from "#compiler/runtime/write/witness.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import type { ReadFact } from "#compiler/scalar/values/identity.ts"
import type { InsertableNameOf, InsertAllRowsOf } from "#compiler/types/changeset/changeset.ts"
import type { FactsDecoder, FactsRefused, RowPlace } from "#compiler/types/changeset/decode.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { closedTableOf } from "#compiler/write/program/decide.ts"

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

/** A level read: a fact's values as its level's normalizer read them, which its domains are judged over. */
interface LevelRead {
	readonly level: Level
	readonly read: ReadFact
}

/**
 * A relation as decode reads its rows, built where it is first decoded: each row read as the write reads a fact of its
 * member, into the levels its domains are judged over (one, a flat relation's; one a level of its nesting, a nested
 * relation's), or the refusal the write places at it.
 */
type RowReader = (fact: unknown) => Result.Result<ReadonlyArray<LevelRead>, RowPlaced>

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

/** The shape refusal of a row whose nesting does not split: a count field that holds no array, a member no record. */
const unsplit: RowPlaced = Object.freeze({ at: { kind: "shape" }, fault: "factShape" } as const)

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

/** A flat relation's rows (`RowReader`), each one fact read by its member's normalizer. */
const flatReader =
	(level: Level): RowReader =>
	(fact) => {
		const read = level.normalize.readRow(fact)
		return read.ok ? Result.ok([{ level, read: read.value }]) : Result.err(placed(read.error))
	}

/**
 * A nested relation's rows (`RowReader`): each fact split along the sequences its nesting reaches, then every level of
 * it read by its level's normalizer, members before their owners, as the write reads them.
 */
const nestedReader =
	(
		relation: StoredRelationName,
		levels: NestingLevels<Level>,
		split: AdditionSplitter
	): RowReader =>
	(fact) => {
		const addition = split(relation, fact)
		if (!addition.ok) {
			return Result.err(unsplit)
		}
		const order = levelOrder(levels, addition.value)
		const reads: Array<LevelRead> = []
		for (let i = order.length - 1; i >= 0; i -= 1) {
			const { addition: at, level } = defined(order[i], "a nested addition met in pre-order")
			const read = level.normalize.readRow(at.fact)
			if (!read.ok) {
				return Result.err(placed(read.error))
			}
			reads.push({ level, read: read.value })
		}
		return Result.ok(reads)
	}

/** The first refined field of a level read whose value is outside its domain (evaluate.ts domainRefusal), or none. */
const domainOf = (judge: Judge, { level, read }: LevelRead): string | undefined =>
	domainRefusal(
		judge,
		level.refined,
		(name) => read.values[defined(level.at.get(name), `${name}, a field its level reads`)]
	)

/**
 * factsDecoder(schema), the shell's (packages/grizzle adapter/public/host.ts), over `answer`, the shell's spelling of a
 * caller's Result (see the header): the schema compiled once, by insertAll's compile, or its CompileError; then
 * `decode(K, value)` is the value as K's rows, or the first refusal its rows meet. Each relation's reader is built where
 * it is first decoded and read by every later call.
 */
export const factsDecoderOver = <S extends AnySchema>(
	schema: S,
	answer: PublicResult
): Result.Result<FactsDecoder<S>, CompileError> =>
	Result.map(
		Result.flatMap(parseBuiltSchema(schema, captureLoc("factsDecoder", [])), builtLawModel),
		(model) => {
			const judge = judgeOf(closedTableOf({ schema: model.checked }), new CompilePatterns())
			const inserts = familyInsertsOf(schema, model)
			/** The reader of `relation`'s rows (RowReader), from its member's input in its families' insert, or the
			 * CompileError that insert refuses by. */
			const readerOf = (relation: string): Result.Result<RowReader, CompileError> =>
				Result.map(inserts.writeOf([relation]), ({ host }): RowReader => {
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
							return flatReader(levelOf(normalize, input.slot.heading))
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
							return nestedReader(nesting.relation, levels, additionSplitter(nesting.sequences))
						}
					}
				})
			const readers = new Map<string, Result.Result<RowReader, CompileError>>()
			/**
			 * The one site of the fact "rows decode admitted are InsertAllRowsOf<S>[K]": each row is K's addition in S, every
			 * field the codec's host value of its type inside its domains, which K's reader, the compiled insert's admission,
			 * read off the value at run time, a correlation of S's type with the compiled write that no TypeScript type ties.
			 * The rows are read against K's reader and the rows it admitted, every one of them.
			 */
			const isRowsOf = <K extends InsertableNameOf<S>>(
				relation: K,
				rows: ReadonlyArray<unknown>,
				admitted: number
			): rows is InsertAllRowsOf<S>[K] => readers.has(relation) && rows.length === admitted
			const decode = <K extends InsertableNameOf<S>>(
				relation: K,
				facts: unknown
			): Result.Result<InsertAllRowsOf<S>[K], FactsRefused> => {
				if (!isList(facts)) {
					return Result.err({ _tag: "RowsRefused" })
				}
				const compiled = readers.get(relation) ?? readerOf(relation)
				readers.set(relation, compiled)
				if (!compiled.ok) {
					return Result.err({ _tag: "Uncompiled", error: compiled.error })
				}
				const reader = compiled.value
				const rows: ReadonlyArray<unknown> = facts
				const reads: Array<ReadonlyArray<LevelRead>> = []
				for (const [row, fact] of rows.entries()) {
					const read = reader(fact)
					if (!read.ok) {
						return Result.err({ _tag: "ValueRefused", row, ...read.error })
					}
					reads.push(read.value)
				}
				for (const [row, levels] of reads.entries()) {
					for (const read of levels) {
						const field = domainOf(judge, read)
						if (field !== undefined) {
							return Result.err({ _tag: "DomainRefused", row, field })
						}
					}
				}
				if (!isRowsOf(relation, rows, reads.length)) {
					throw defect("decoded rows, every one of them admitted")
				}
				return Result.ok(rows)
			}
			return { decode: (relation, facts) => answer(decode(relation, facts)) }
		}
	)
