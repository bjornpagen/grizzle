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
	caseSpace,
	Decoded,
	type DecodeFeature,
	decodeFeatures,
	doubledGen,
	preview,
	stored,
	type Top,
	tops,
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
				const previewed = preview(c.rows)
				const note = (refusal: FactsRefused, relation: Top): void => {
					switch (refusal._tag) {
						case "RowsRefused":
							return k.note("rows that are no array")
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
					if (one.refusal._tag === "DomainRefused") {
						return assert.fail(`decode refuses by a domain where the write refuses the input`)
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
				original: "\t\t\t\tfor (const read of levels) {",
				replacement: "\t\t\t\tfor (const read of levels.slice(-1)) {",
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
					"\t\t\t\t\treturn nestedReader(nesting.relation, levels, additionSplitter(nesting.sequences))",
				replacement: "\t\t\t\t\treturn flatReader(levels.own)",
				why: "decode reads a nested relation's rows flat, as its own level alone: every row whose nesting holds a member array is refused as factShape, where the insert admits it."
			}
		]
	})

/** The calls a decoder's work is counted by: a heading planned, a pattern parsed, a relation's nesting split. */
const workSites = Object.freeze({
	plans: { file: "packages/engine/src/scalar/values/identity.ts", name: "headingPlan" },
	parses: { file: "packages/engine/src/scalar/regex/patterns.ts", name: "admittedParse" },
	splits: { file: "packages/engine/src/runtime/write/addition.ts", name: "relationSplit" }
})

/** A decoder compiled and every relation's rows decoded, its rows each admitted. */
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
				const [once, onceCounts] = yield* callCounts(decodeAll(rows.once), workSites)
				const [twice, twiceCounts] = yield* callCounts(decodeAll(rows.twice), workSites)
				assert.ok(
					Arr.every([...once, ...twice], (admitted) => admitted),
					"every relation's rows are admitted"
				)
				assert.ok(
					onceCounts.plans > 0 && onceCounts.parses > 0 && onceCounts.splits > 0,
					"a decoder plans its headings, parses its patterns and splits its nestings"
				)
				assert.deepEqual(twiceCounts, onceCounts, "twice the rows, the same work")
			}),
		oracle: { kind: "specification", name: "a decoder's work a function of its schema alone" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/decode.ts",
				original:
					"\t\t\t\t\treturn nestedReader(nesting.relation, levels, additionSplitter(nesting.sequences))",
				replacement:
					"\t\t\t\t\treturn (fact) => nestedReader(nesting.relation, levels, additionSplitter(nesting.sequences))(fact)",
				why: "Each row splits its nesting afresh: a relation's splits are worked out once a row, and twice the rows split twice as often."
			},
			{
				file: "packages/engine/src/program/decode.ts",
				original: "\t\t\t\t\tconst field = domainOf(judge, read)",
				replacement:
					"\t\t\t\t\tconst field = domainOf(judgeOf(closedTableOf(compiled.frontend), new CompilePatterns()), read)",
				why: "Each row's domains are judged by a judge of its own, its patterns parsed again: twice the rows parse twice as often."
			}
		]
	})
