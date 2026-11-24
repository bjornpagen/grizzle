/**
 * factsDecoder (engine program/decode.ts): decode admits a value as a top-level relation's rows exactly where the insert's
 * own admission admits it, and refuses it where that refuses it, at the same row and field by the same fault. Over drawn
 * rows of a schema with a flat relation of every carrier an export's rows hold (a closed id, a set, a bytes value, a
 * numeric of a typmod, a contract and a pattern among them), an ordered family nested in its owner and a tree nested to
 * any depth, each case plants at most one fault: rows that are no array, a row of another shape (no record, a NULL, a
 * key extra, missing or renamed, a NULL field, a nesting that does not split), a value its field's type refuses, or one
 * its domain refuses, at a top-level row or a nested member. Each top-level relation's rows are decoded, and the same
 * rows previewed as one insertAll (program/preview.ts previewOver, the write's own binding before any SQL):
 *
 * - where the preview refuses the input (InputRefused), the faulted relation's decode refuses, with the write's fault at
 *   the write's place, and every other relation's admits;
 * - where the preview gives rows and rowEvaluator's admit refuses one by its domain (DomainRefused), as PostgreSQL's
 *   domain CHECK refuses the stored row, the faulted relation's decode refuses at that field, and every other admits;
 * - where neither refuses, every decode admits, its rows the value itself.
 *
 * And a decoder's work is a function of its schema, never of the rows it decodes: the calls of its compile and its
 * decodes to plan a heading, to parse a pattern and to split a relation's nesting, read off V8's call counts
 * (kernel/calls.ts callCounts), are the same over rows of each relation and over twice as many.
 *
 * Features: each of `decodeFeatures`, noted where the case reaches it.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record as Rec, Result } from "effect"
import { factsDecoder, rowEvaluator } from "#adapter/public/host.ts"
import type { FactsRefused } from "#compiler/types/changeset/decode.ts"
import type { AnyRelation } from "#compiler/types/schema/relation.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import {
	type ArrayRows,
	arrayRows,
	caseSpace,
	codings,
	Decoded,
	type DecodeFeature,
	decodeFeatures,
	describedShape,
	detachedOne,
	doubledGen,
	flights,
	keptOf,
	nestedTops,
	nodesOf,
	outcomeOf,
	preview,
	setsChanged,
	shapeOfRow,
	stored,
	type TakenFeature,
	takenFeatures,
	takenSpace,
	type Top,
	tops,
	undecodedRows,
	writtenOf
} from "#test/unit/program/decode.fixtures.ts"

/** The decoder and the evaluator every case reads, the schema compiled once each. */
const decoder = Result.getOrThrow(factsDecoder(Decoded))
const evaluator = Result.getOrThrow(rowEvaluator<AnySchema>(Decoded))

/** The first row of a preview's rows that rowEvaluator's admit refuses by its domain: its relation and field. */
const domainRefusalOf = (
	rows: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>>
): { readonly relation: string; readonly field: string } | undefined => {
	for (const [relation, R] of stored) {
		for (const row of Rec.get(rows, relation).pipe(Option.getOrElse(() => []))) {
			const admitted = evaluator.admit<AnyRelation>(R, row)
			if (Result.isFailure(admitted)) {
				const refusal = admitted.failure
				return refusal._tag === "DomainRefused"
					? { relation, field: String(refusal.field) }
					: assert.fail(`a preview's row is inside its types: ${relation}.${String(refusal.field)}`)
			}
		}
	}
	return undefined
}

/** decode refuses exactly where the insert's own admission refuses, at the same row and field, by the same fault. */
export const decodeRefusesExactlyWhereTheInsertsOwnAdmissionRefusesAtTheSameFieldByTheSameFault =
	property.explore(caseSpace, {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: decodeFeatures satisfies ReadonlyArray<Reached<DecodeFeature>>,
		check: (_, k: Case<DecodeFeature>) => (c) =>
			Effect.sync(() => {
				const decoded = Arr.map(tops, (relation) => ({
					relation,
					answer: decoder.decode(relation, c.rows[relation])
				}))
				const refused = Arr.flatMap(decoded, ({ relation, answer }) =>
					Result.isFailure(answer) ? [{ relation, refusal: answer.failure }] : []
				)
				const previewed = preview(undecodedRows(c.rows))
				const note = (refusal: FactsRefused, relation: Top): void => {
					switch (refusal._tag) {
						case "RowsRefused":
							return k.note("rows that are no array")
						case "Uncompiled":
							return assert.fail(
								`the insert of ${relation}'s families compiles: ${refusal.error.message}`
							)
						case "DomainRefused":
							k.note("a value its domain refuses")
							break
						case "ValueRefused":
							k.note(
								refusal.fault === "nullValue"
									? "a NULL"
									: refusal.fault !== "factShape"
										? "a value its type refuses"
										: refusal.at.kind === "field"
											? "a missing field"
											: "a row's shape"
							)
							if (refusal.at.kind === "field" && refusal.at.field === "b") {
								k.note("a bytes field")
							}
							if (refusal.fault === "codeHandle") {
								k.note("a handle no roster holds")
							}
							if (refusal.fault === "bitsMember") {
								k.note("a set of a handle no roster holds")
							}
					}
					if (c.planted.kind === "unsplit") {
						k.note("a nesting that does not split")
					}
					if (
						(c.planted.kind === "value" && c.planted.site.depth === "member") ||
						(c.planted.kind === "row" && c.planted.depth === "member")
					) {
						k.note(relation === "Owner" ? "a nested member's field" : "a tree's child's field")
					}
				}
				if (!previewed.ok) {
					const refusal = previewed.error
					if (refusal._tag !== "InputRefused" || refusal.failure._tag !== "EncodingFailure") {
						return assert.fail(`the preview refuses only the input: ${refusal._tag}`)
					}
					const one = refused[0]
					if (one === undefined || refused.length > 1) {
						return assert.fail(
							`the faulted relation's decode alone refuses, where the write refuses ${refusal.failure.reason._tag}`
						)
					}
					if (one.refusal._tag === "DomainRefused" || one.refusal._tag === "Uncompiled") {
						return assert.fail(
							`decode refuses by ${one.refusal._tag} where the write refuses the input`
						)
					}
					assert.deepEqual(
						writtenOf(one.relation, one.refusal),
						{ fault: refusal.failure.reason._tag, place: refusal.failure.place },
						`${one.relation}: decode's fault and place are the write's`
					)
					return note(one.refusal, one.relation)
				}
				const domain = domainRefusalOf(previewed.value)
				if (domain !== undefined) {
					const one = refused[0]
					if (one === undefined || refused.length > 1) {
						return assert.fail("one relation's decode refuses, by a domain")
					}
					assert.deepEqual(
						one.refusal,
						{
							_tag: "DomainRefused",
							row: c.planted.kind === "value" ? c.planted.row : -1,
							field: domain.field
						},
						`${one.relation}: decode refuses by the domain rowEvaluator refuses ${domain.relation}'s row by`
					)
					return note(one.refusal, one.relation)
				}
				assert.equal(refused.length, 0, "every relation's decode admits rows the insert admits")
				for (const { relation, answer } of decoded) {
					assert.ok(
						Result.isSuccess(answer) && answer.success === c.rows[relation],
						`${relation}: the decoded rows are the value itself`
					)
				}
				k.note("no fault")
			}),
		oracle: {
			kind: "second-implementation",
			name: "the write's own binding of the rows (previewOver), and rowEvaluator's domains over the rows it stores"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/decode.ts",
				original:
					'\t\t\treturn isRefined(type) ? [{ name, type, writing: { kind: "caller" } }] : []',
				replacement: "\t\t\treturn []",
				why: "decode holds no field to its contract or pattern: a value outside its domain is decoded, where rowEvaluator refuses the row the insert stores and PostgreSQL's domain CHECK refuses it."
			},
			{
				file: "packages/engine/src/program/decode.ts",
				original: "\t\t\t\t\t\t\t\t\tfor (const { level: at, read } of reading.reads) {",
				replacement:
					"\t\t\t\t\t\t\t\t\tfor (const { level: at, read } of reading.reads.slice(-1)) {",
				why: "decode judges the domains of a row's own level alone: a nested member's or a tree child's value outside its contract is decoded, so decode and the insert disagree on that one contract."
			},
			{
				file: "packages/engine/src/scalar/values/identity.ts",
				original:
					'\ttypeof value === "string" && roster.rank.has(value) ? Result.ok(value) : Result.err("codeHandle")',
				replacement: '\ttypeof value === "string" ? Result.ok(value) : Result.err("codeHandle")',
				why: "A closed id's roster goes unchecked: decode admits a handle no roster holds, which the write cannot code."
			},
			{
				file: "packages/engine/src/program/decode.ts",
				original:
					"\t\t\t\t\t\t\t\tnestedReader(nesting.relation, levels, additionSplitter(nesting.sequences)),",
				replacement:
					"\t\t\t\t\t\t\t\t(fact) => Result.map(levels.own.normalize.readRow(fact), (read) => ({ shape: { relation: nesting.relation, families: [] }, reads: [{ level: levels.own, read }] })),",
				why: "decode reads a nested relation's rows flat, as its own level alone: every row whose nesting holds a member array is refused as factShape, where the insert admits it."
			}
		]
	})

/**
 * The calls a decoder's work is counted by: a heading planned, a pattern parsed, a judge of its rows' domains made, a
 * relation's nesting split.
 */
const workSites = Object.freeze({
	plans: { file: "packages/engine/src/scalar/values/identity.ts", name: "headingPlan" },
	parses: { file: "packages/text/src/regex/parse.ts", name: "parsePattern" },
	judges: { file: "packages/engine/src/runtime/write/witness.ts", name: "judgeOf" },
	splits: { file: "packages/engine/src/runtime/write/addition.ts", name: "relationSplit" }
})

/**
 * A decoder compiled and every relation's rows decoded, its rows each admitted. A relation's insert, its headings
 * planned among it, is compiled where a reader of the schema value first writes or decodes the relation and shared by
 * every later one (program/preview.ts familyInsertsOf), so a decoder's own work is counted past a first decode.
 */
const decodeAll = (rows: Readonly<Record<Top, ReadonlyArray<unknown>>>) =>
	Effect.sync(() => {
		const decode = Result.getOrThrow(factsDecoder(Decoded))
		return Arr.map(tops, (relation) => Result.isSuccess(decode.decode(relation, rows[relation])))
	})

/** A decoder plans each heading, parses each pattern and splits each nesting once, whatever the rows it decodes. */
export const aDecoderPlansEachHeadingParsesEachPatternAndSplitsEachNestingOnceWhateverTheRowsItDecodes =
	property.explore(doubledGen, {
		needs: {},
		budget: { runs: 12, steered: 0 },
		situations: [],
		check: () => (rows) =>
			Effect.gen(function* () {
				yield* decodeAll(rows.once)
				const [once, onceCounts] = yield* callCounts(decodeAll(rows.once), workSites)
				const [twice, twiceCounts] = yield* callCounts(decodeAll(rows.twice), workSites)
				assert.ok(
					Arr.every([...once, ...twice], (admitted) => admitted),
					"every relation's rows are admitted"
				)
				assert.ok(onceCounts.splits > 0, "a decoder splits its nestings")
				assert.deepEqual(twiceCounts, onceCounts, "twice the rows, the same work")
			}),
		oracle: { kind: "specification", name: "a decoder's work a function of its schema alone" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/decode.ts",
				original:
					"\t\t\t\t\t\t\t\tnestedReader(nesting.relation, levels, additionSplitter(nesting.sequences)),",
				replacement:
					"\t\t\t\t\t\t\t\t(fact) => nestedReader(nesting.relation, levels, additionSplitter(nesting.sequences))(fact),",
				why: "Each row splits its nesting afresh: a relation's splits are worked out once a row, and twice the rows split twice as often."
			},
			{
				file: "packages/engine/src/program/decode.ts",
				original: "\t\t\t\t\t\t\t\t\t\tconst field = domainOf(judge, at, read)",
				replacement:
					"\t\t\t\t\t\t\t\t\t\tconst field = domainOf(judgeOf(closedTableOf(state.model.checked), state.model.checked.patterns), at, read)",
				why: "Each row's domains are judged by a judge of its own, the closed relations indexed again: twice the rows make twice the judges."
			}
		]
	})

/** Every top-level relation's rows decoded: which of them decode admitted. */
const decodedAll = (rows: ArrayRows): ReadonlyArray<Top> =>
	Arr.filter(tops, (relation) => Result.isSuccess(decoder.decode(relation, rows[relation])))

/**
 * The insert of rows decode admitted is the insert of the same rows undecoded, refusals included: over drawn rows with at
 * most one fault planted, every relation's rows are decoded, then, it may be, a bytes value's buffer detached, as a
 * caller may once decode has read it; then `ChangeSet.empty(Decoded).insertAll(rows)` is bound before any SQL
 * (runtime/write/bind.ts bindWrite) over the rows themselves and over a copy of them no decode admitted, under the
 * decoder's own codes, where the insert takes decode's reads (runtime/write/decoded.ts), and under an installation's
 * other codes, where it reads the rows again: every statement's executions alike, or one refusal. And a set a bound
 * write holds is its own: a handle no roster holds put into every set the decoded insert's rows hold, the decoded rows'
 * insert bound again is the copy's still.
 */
export const theInsertOfRowsDecodeAdmittedIsTheInsertOfTheSameRowsUndecodedRefusalsIncluded =
	property.explore(takenSpace, {
		needs: {},
		budget: { runs: 150, steered: 150 },
		situations: takenFeatures satisfies ReadonlyArray<Reached<TakenFeature>>,
		check: (_, k: Case<TakenFeature>) => (c) =>
			Effect.gen(function* () {
				const rows = arrayRows(c.decoded.rows)
				if (rows === undefined) {
					return assert.fail("a case's rows are arrays")
				}
				const copy = arrayRows(undecodedRows(rows))
				if (copy === undefined) {
					return assert.fail("a copy of arrays is arrays")
				}
				const admitted = decodedAll(rows)
				if (c.afterward === "a buffer detached" && detachedOne(rows)) {
					k.note("a buffer detached since")
				}
				for (const coding of codings) {
					const flight = flights[coding]
					const taken = yield* outcomeOf(flight, rows)
					const read = yield* outcomeOf(flight, copy)
					assert.deepEqual(
						taken.outcome,
						read.outcome,
						`under ${coding}, the decoded rows' insert is the copy's`
					)
					if (taken.outcome.kind !== "bound") {
						k.note("refused alike")
						continue
					}
					if (coding === "the decoder's codes" && setsChanged(taken.inserted)) {
						const again = yield* outcomeOf(flight, rows)
						assert.deepEqual(
							again.outcome,
							read.outcome,
							"the decoded rows' insert again, once a set the last one held is changed, is the copy's"
						)
						k.note("a set taken again")
					}
				}
				if (Arr.some(admitted, (relation) => relation === "Flat" && rows.Flat.length > 0)) {
					k.note("a flat relation's reads taken")
				}
				if (Arr.some(admitted, (relation) => relation !== "Flat" && rows[relation].length > 0)) {
					k.note("a nested relation's readings taken")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the insert of a copy of the rows no decode admitted, which reads every row"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/identity.ts",
				original: '\tbytes: "again",',
				replacement: '\tbytes: "shared",',
				why: "A write takes a decoded bytes value as decode read it, unchecked: a buffer detached since is stored as no bytes, where the copy's insert refuses it as bytesType."
			},
			{
				file: "packages/engine/src/scalar/values/identity.ts",
				original: '\tbits: "again",',
				replacement: '\tbits: "shared",',
				why: "A write takes a decoded set as decode's own copy, which the write's rows hand out: a handle put into it reaches the next insert of the decoded rows, unadmitted."
			},
			{
				file: "packages/engine/src/scalar/values/identity.ts",
				original:
					"\t\t\treturn other !== undefined && field.name === other.name && sameSpec(field.spec, other.spec)",
				replacement: "\t\t\treturn other !== undefined && field.name === other.name",
				why: "A write under other roster codes takes decode's reads, whose closed ids are parted by the decoder's codes: a nested node's closed id is sent as the decoder's code, not the installation's."
			}
		]
	})

/** The calls a read of a fact is counted by (scalar/values/identity.ts readFact). */
const readSites = Object.freeze({
	reads: { file: "packages/engine/src/scalar/values/identity.ts", name: "readFact" }
})

/**
 * Decode and the insert of what it admitted read each row once in all: over drawn rows of every top-level relation, a
 * flat one and two nested, each admitted, decoding every relation's rows and then binding their insert reads exactly as
 * many facts as binding the insert of a copy of them alone (scalar/values/identity.ts readFact, read off V8's call
 * counts, kernel/calls.ts callCounts), and decode alone reads some.
 */
export const decodeAndTheInsertOfWhatItAdmittedReadEachRowOnceInAll = property.explore(doubledGen, {
	needs: {},
	budget: { runs: 12, steered: 0 },
	situations: [],
	check: () => (drawn) =>
		Effect.gen(function* () {
			const rows: ArrayRows = drawn.once
			const copy = arrayRows(undecodedRows(rows))
			if (copy === undefined) {
				return assert.fail("a copy of arrays is arrays")
			}
			const flight = flights["the decoder's codes"]
			const [alone, aloneCounts] = yield* callCounts(outcomeOf(flight, copy), readSites)
			const [decoded, decodedCounts] = yield* callCounts(
				Effect.sync(() => decodedAll(rows)),
				readSites
			)
			const [both, bothCounts] = yield* callCounts(outcomeOf(flight, rows), readSites)
			assert.deepEqual(decoded, tops, "decode admits every relation's rows")
			assert.equal(alone.outcome.kind, "bound", "the copy's insert binds")
			assert.deepEqual(both.outcome, alone.outcome, "the decoded rows' insert is the copy's")
			assert.ok(decodedCounts.reads > 0, "decode reads the rows")
			assert.equal(
				decodedCounts.reads + bothCounts.reads,
				aloneCounts.reads,
				"decode and the insert of what it admitted read as many facts as the insert alone"
			)
		}),
	oracle: {
		kind: "specification",
		name: "a row decode read is read by no insert of it again"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/runtime/write/normalize.ts",
			original: "\tconst kept = keptReads(facts, normalize.plan)",
			replacement: "\tconst kept = undefined",
			why: "The insert reads a decoded flat relation's rows again: decode and the insert read each of Flat's rows twice."
		},
		{
			file: "packages/engine/src/runtime/write/nesting.ts",
			original: "\tconst kept = keptReadings(facts, normalizers)",
			replacement: "\tconst kept = undefined",
			why: "The insert reads a decoded nested relation's rows again: every level of Owner's and Node's rows is read twice."
		},
		{
			file: "packages/engine/src/write/changeset/value.ts",
			original: "\tfixedFacts(facts) ? facts : Object.freeze(facts.map(frozenFact))",
			replacement: "\tObject.freeze(facts.map(frozenFact))",
			why: "A ChangeSet copies a decoded array, so its insert meets no array decode admitted and reads every row again."
		}
	]
})

/**
 * Decode keeps of a nested row its levels' reads and its nesting's shape alone (runtime/write/addition.ts NestedShape):
 * over drawn rows of each nested top-level relation, an owner with its items and a tree to depth two, each admitted,
 * decode records one reading of each row, its shape and its reads alone, whose shape is the row's nesting node for
 * node, each node holding its relation, its slot and its families and nothing more, each family its id and its members,
 * the row's in order, and whose reads are one a node, so no reading holds a copy of any level's fields the split made,
 * which no write reads after decode.
 */
export const decodeKeepsOfANestedRowItsLevelsReadsAndItsNestingsShapeAlone = property.explore(
	doubledGen,
	{
		needs: {},
		budget: { runs: 40, steered: 0 },
		situations: [],
		check: () => (drawn) =>
			Effect.sync(() => {
				for (const relation of nestedTops) {
					const rows = drawn.once[relation]
					assert.ok(
						Result.isSuccess(decoder.decode(relation, rows)),
						`decode admits ${relation}'s rows`
					)
					const readings = keptOf(relation, rows)
					if (readings === undefined) {
						return assert.fail(`decode records the readings of ${relation}'s rows`)
					}
					assert.equal(readings.length, rows.length, `one reading of each of ${relation}'s rows`)
					for (const [i, reading] of readings.entries()) {
						assert.deepEqual(
							Arr.map(Reflect.ownKeys(reading), String),
							["shape", "reads"],
							`${relation}'s row ${i}: its reading is its shape and its reads`
						)
						const expected = shapeOfRow(relation, rows[i])
						assert.deepEqual(
							describedShape(reading.shape),
							expected,
							`${relation}'s row ${i}: its reading keeps its nesting's shape alone`
						)
						assert.equal(
							reading.reads.length,
							nodesOf(expected),
							`${relation}'s row ${i}: one read of each level of it`
						)
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "a nested row's reading keeps its shape and its levels' reads, no copy of its fields"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/write/nesting.ts",
				original: "\t\treturn Result.ok({ shape, reads })",
				replacement: "\t\treturn Result.ok({ shape, facts, reads })",
				why: "A nested row's reading keeps its split's own fields beside its reads: decode holds a frozen copy of every level's fields of every nested row it admitted, which no write reads after decode."
			}
		]
	}
)
