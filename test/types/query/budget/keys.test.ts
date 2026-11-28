/**
 * What a rule's keys cost (query/budget/keys.ts): a rule over a relation of a composite key, and a rule matching a
 * bound query beside it, each written 10 and 20 times over one schema, each program checked alone by one checker. A
 * rule's evidence reads the keys of what it matches (types/evidence/evidence.ts HeadKeys): each key's fields' needs once
 * per match, read by its dependencies and its choices alike, and the head's terms once, so the fields holding what a
 * key needs are one walk of the head's entries.
 *
 * Properties: every program typechecks with no diagnostic, and each query the larger program adds costs at most its
 * shape's measured instantiations. Oracle: the compiler's own counts (test/support/types/batch/measured.ts), against the bound
 * measured when the keys were cut (keys.ts addedAtMost).
 */
import { costGate } from "#test/support/types/batch/measured.ts"
import { keyedQueries } from "#test/types/query/budget/keys.dictionary.ts"
import { keyedCost, keyedShapeName } from "#test/types/query/budget/keys.ts"

/** Each shape's added query costs at most its measured instantiations. */
export const cost = costGate(keyedQueries, {
	box: "every shape of a keyed rule",
	name: keyedShapeName,
	measure: keyedCost,
	oracle: {
		kind: "universal",
		name: "the compiler's own counts, against each shape's measured bound"
	},
	kills: [
		{
			file: "packages/engine/src/types/evidence/evidence.ts",
			original: "\t\t: HeldFields<Need, EntriesIn<HeadEntries<H>, Need>>",
			replacement:
				"\t\t: Need extends string\n\t\t\t? HeldFields<Need, EntriesIn<HeadEntries<H>, Need>>\n\t\t\t: never",
			why: "The head's entries are walked once per variable a key needs, not once per key: a key of four fields walks them four times, so a query over a composite key costs 2,591 instantiations against its bound of 2,287."
		},
		{
			file: "packages/engine/src/types/evidence/evidence.ts",
			original:
				"\t\t\t: KeyNeeds<\n\t\t\t\t\t| BoundNeeds<B, FixedFields>[F & keyof B]\n\t\t\t\t\t| UnboundNeeds<Exclude<F, keyof B>, B, FixedFields, Gen>\n\t\t\t\t>",
			replacement:
				"\t\t\t: KeyNeeds<\n\t\t\t\t\t{\n\t\t\t\t\t\t[K in F]-?: K extends keyof B\n\t\t\t\t\t\t\t? BoundNeeds<B, FixedFields>[K]\n\t\t\t\t\t\t\t: UnboundNeeds<K, B, FixedFields, Gen>\n\t\t\t\t\t}[F]\n\t\t\t\t>",
			why: "Each key's fields' needs are read one field at a time, a mapped type over the key, where the match's needs by field are read at the key's fields at once: a query over a composite key costs 2,337 instantiations against its bound of 2,287."
		},
		{
			file: "packages/engine/src/types/evidence/evidence.ts",
			original:
				"type Covers<H, C, Known extends string, FixedFields extends string> = DeterminedBy<\n\tNeedsOf<H, FixedFields>[Exclude<TargetFields<H>, C> & keyof NeedsOf<H, FixedFields>],\n\tKnown\n>",
			replacement:
				"type Covers<H, C, Known extends string, FixedFields extends string> = false extends {\n\t[N in TargetFields<H>]-?: N extends C\n\t\t? true\n\t\t: DeterminedBy<NeedsOf<H, FixedFields>[N & keyof NeedsOf<H, FixedFields>], Known>\n}[TargetFields<H>]\n\t? false\n\t: true",
			why: "Each candidate judges every head field apart, a mapped type over the head per candidate, where the needs of the fields outside it are read at once: a query over a composite key costs 2,475 instantiations against its bound of 2,287."
		}
	]
})
