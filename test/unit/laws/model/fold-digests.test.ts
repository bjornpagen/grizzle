/**
 * A concat fold's sides may name its running texts' SHA-256 digests in their places (ir/family.ts FoldCarrier): a
 * generated field `Crypto.sha256(row.v)` over each accumulated text v. Its predecessor and last axes then pair the
 * digests, a member's before's with its predecessor's after's and the owner's end's with its last member's after's, so
 * a running text of no bound rides a UNIQUE of digests; its CHECK and its base pins stay on the texts, which the host
 * fills. Named unalike, a plane is refused, since an axis pairs a digest only with a digest; a generation that is no
 * digest names no accumulator, and is refused.
 *
 * The box, exhausted: an ordered family of lines or a tree of nodes, texts of no bound or of a hundred-byte pattern, and
 * each of the before, after and end named as its text, its digest or its lowering (`Text.lowerAscii`). The oracle is
 * the specification (fold-digests.fixtures.ts verdictOf): admitted with the digests on the axes for any bound where all
 * three name digests; with the texts where all three name texts of a bound; refused as unbounded where they name
 * unbounded texts (KeyFault foldAccumulator); refused as unalike where they mix texts and digests; refused by the fold
 * rule where one names a lowering. Every admitted fold's CHECKs are judged on rows by the reference evaluator: its
 * first-slot pin `at > 0 OR before = ''`, its combine `after = before || piece` and its empty end `n > 0 OR text = ''`,
 * each over the texts whatever the axes carry.
 *
 * Features: each sequence carried by its digests over each bound, and by its texts; each refusal.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { refused, refusedKeys, succeeded } from "#test/support/assert.ts"
import type { ModelValue } from "#test/support/oracle/evaluate/catalog.ts"
import {
	accepts,
	checksOf,
	compiledModel,
	foldLaws,
	foreignKeyShapes,
	type Row
} from "#test/support/unit/laws/model/natives.ts"
import {
	type Feature,
	featureOf,
	layoutOf,
	type Shape,
	schemaOf,
	shapeGen,
	verdictOf
} from "#test/unit/laws/model/fold-digests.fixtures.ts"

/** Every pair of every foreign key of the model, `from → to`. */
const pairsOf = (model: LawModel): ReadonlyArray<string> =>
	Arr.flatMap(foreignKeyShapes(model), (fk) => fk.pairs)

/** Whether a pair `from → to` names the field `name` on either side. */
const names = (pair: string, name: string): boolean =>
	Arr.some(Str.split(pair, " → "), (side) => side === name)

/**
 * The fold's CHECKs judged on rows: a member at slot 0 holds the empty before, its after its before and its piece, a
 * member at slot 1 its before and piece, and an empty owner the empty end, each a row the CHECK accepts exactly where
 * the pin, the combine and the empty end hold.
 */
const checkRows = (model: LawModel, s: Shape): void => {
	const [law, ...more] = foldLaws(model)
	assert.ok(law !== undefined && more.length === 0, "one fold")
	const l = layoutOf(s)
	const checkOn = (relation: string) => {
		const [check, ...extra] = checksOf(model, relation, law)
		assert.ok(check !== undefined && extra.length === 0, `the fold states one CHECK on ${relation}`)
		return check
	}
	const member = checkOn(l.member)
	const owner = checkOn(l.owner)
	/** A member's row; on a tree, whose node is its own owner, with an owner part that holds. */
	const memberRow = (at: bigint, before: string, after: string): Row =>
		new Map<string, ModelValue>([
			["at", at],
			["piece", "a"],
			["before", before],
			["after", after],
			...(s.sequence === "tree"
				? ([
						[l.count, 1n],
						["text", "x"]
					] as const)
				: [])
		])
	/** An owner's row; on a tree, with a member part that holds. */
	const ownerRow = (n: bigint, text: string): Row =>
		new Map<string, ModelValue>([
			[l.count, n],
			["text", text],
			...(s.sequence === "tree"
				? ([
						["at", 1n],
						["piece", "a"],
						["before", "x"],
						["after", "xa"]
					] as const)
				: [])
		])
	const cases: ReadonlyArray<readonly [string, boolean, boolean]> = [
		[
			"the first member's empty before and its piece",
			accepts(member, memberRow(0n, "", "a")),
			true
		],
		[
			"a first member's before that is not the empty text",
			accepts(member, memberRow(0n, "x", "xa")),
			false
		],
		["a later member's before and its piece", accepts(member, memberRow(1n, "x", "xa")), true],
		[
			"a later member's after that is not its before and its piece",
			accepts(member, memberRow(1n, "x", "xb")),
			false
		],
		["an empty owner's empty end", accepts(owner, ownerRow(0n, "")), true],
		["an empty owner's end that is not the empty text", accepts(owner, ownerRow(0n, "x")), false],
		["an owner's end with members", accepts(owner, ownerRow(1n, "x")), true]
	]
	for (const [what, accepted, due] of cases) {
		assert.equal(accepted, due, `${what} is ${due ? "accepted" : "refused"}`)
	}
}

/** A concat fold's axes carry its texts or the digests its sides name in their places, and its CHECKs read the texts. */
export const aConcatFoldsAxesCarryItsTextsOrTheDigestsItsSidesNameInTheirPlacesAndItsChecksReadTheTexts =
	property.exhaust(finite(shapeGen), {
		needs: {},
		situations: [
			"ordered carried by its digests over unbounded texts",
			"ordered carried by its digests over bounded texts",
			"tree carried by its digests over unbounded texts",
			"tree carried by its digests over bounded texts",
			"ordered carried by its texts",
			"tree carried by its texts",
			"another generation refused",
			"a plane named unalike refused",
			"unbounded texts refused"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (s) =>
			Effect.sync(() => {
				const verdict = verdictOf(s)
				c.note(featureOf(s, verdict))
				const compiled = compiledModel(schemaOf(s))
				const shape = Formatter.format(s)
				switch (verdict.kind) {
					case "admitted": {
						const model = succeeded(compiled, `${shape} compiles`)
						const pairs = pairsOf(model)
						const [before, after, end] =
							verdict.carried === "digest"
								? (["beforeDigest", "afterDigest", "textDigest"] as const)
								: (["before", "after", "text"] as const)
						assert.ok(
							Arr.contains(pairs, `${before} → ${after}`),
							`${shape}: the predecessor axis pairs ${before} with ${after}`
						)
						assert.ok(
							Arr.contains(pairs, `${end} → ${after}`),
							`${shape}: the last axis pairs ${end} with ${after}`
						)
						const carriedNot =
							verdict.carried === "digest"
								? (["before", "after", "text"] as const)
								: (["beforeDigest", "afterDigest", "textDigest"] as const)
						for (const other of carriedNot) {
							assert.ok(
								!Arr.some(pairs, (p) => names(p, other)),
								`${shape}: no foreign key pairs ${other}`
							)
						}
						checkRows(model, s)
						return
					}
					case "lowered": {
						const reason = refused(compiled, "MalformedDescription", `${shape} is refused`).reason
						assert.equal(
							reason._tag === "MalformedDescription" ? reason.what : reason._tag,
							`a fold's accumulator is an accumulated field, filled on the host, or a text's SHA-256 digest, a generated field Crypto.sha256(row.v) over the accumulated v; ${verdict.field} is written by generated`
						)
						return
					}
					case "unalike": {
						const reason = refused(compiled, "MalformedDescription", `${shape} is refused`).reason
						assert.ok(
							reason._tag === "MalformedDescription" &&
								Str.startsWith(
									"a fold's sides name a plane's before, after and end alike, each its running value or each its SHA-256 digest"
								)(reason.what),
							`${shape} is refused as named unalike, not ${reason._tag}`
						)
						return
					}
					case "unbounded": {
						const keys = refusedKeys(refused(compiled, "UnrepresentableKey", `${shape} is refused`))
						assert.ok(
							Arr.every(keys, (k) => k.fault.kind === "foldAccumulator"),
							`${shape} is refused for its fold's unbounded running text, not ${Arr.join(
								Arr.map(keys, (k) => k.fault.kind),
								", "
							)}`
						)
						return
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "ir/family.ts FoldCarrier: a plane's axes carry its texts, or the SHA-256 digests its sides name in their places; its CHECK and pins read the texts"
		},
		box: "an ordered family or a tree, texts of no bound or a hundred-byte pattern, each running text named as itself, its digest or its lowering",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: "\t\t\tconst native = this.#carrier(axis, p)",
				replacement: "\t\t\tconst native = p",
				why: "The axes pair the running texts whatever the fold's sides name: a fold naming its digests over unbounded texts is refused for its axis key, and over bounded texts pairs the texts; the property fails."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: "\t\tconst start = this.#startOf(pair.pinned)",
				replacement: "\t\tconst start = this.#startOf(pair.from)",
				why: "The base pin reads the column the axis carries: a digest, generated, has no start, so a fold carried by its digests states no first-slot pin and no empty end, and a first member's before that is not the empty text is accepted; the property fails."
			},
			{
				file: "packages/engine/src/ir/law.ts",
				original: '\t\t\tw.desc.fn !== "sha256" ||\n',
				replacement: "",
				why: "Any generation over a running text stands for it, a lowering among them, which is no digest: its equality proves no equality of the texts, and a fold naming lowerings is admitted; the property fails."
			},
			{
				file: "packages/engine/src/analysis/theory/families.ts",
				original:
					'\tif (before.kind === "value" && after.kind === "value" && end.kind === "value") {\n\t\treturn valuesCarried\n\t}',
				replacement: "\treturn valuesCarried",
				why: "A plane named unalike, a digest beside a text, is carried as its texts, so the fold is admitted or refused for its axis key where it is unalike; the property fails."
			}
		]
	})
