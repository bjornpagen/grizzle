/**
 * Every refusal of an index request names the reads that asked for it: index planning takes each request with its
 * askers, one at least (ir/products.ts AskedIndexRequest, IndexAsker), a served program by its login, its name and its
 * Description's call site (ir/desc.ts programAt), so no request reaches it and no refusal of one is written without
 * them, and a request many reads make is planned once, its refusal naming them all (physical/indexes/engine.ts
 * everyAsker, askedLabel). Where a request carried what it asked alone, metis's generate refused
 * "UnrepresentableKey at access index request on SnapshotSingle(value) for equality lookup" naming no read (METIS-TSGRADE's
 * probe6 at 1b28f756), and finding the read that asked took an instrumented build of the consumer.
 *
 * The box: Note(id, text), keyed by its id, its text of no byte bound with no digest declared; a login serving one to
 * three of its reads, two binding the text alone by equality, a lookup no index finds its rows by, which the
 * installation refuses as UnrepresentableKey, and one binding its id.
 *
 * Oracle: the specification. The draft is refused exactly where a text read is served, the refusal naming each served
 * text read by its login, its name and its Description's call site in this box's fixtures, and no other read.
 *
 * Features: one text read refused; both refused, named in one refusal; the key read beside them; the key read alone.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case as CaseOf, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { caseGen, refusalOf, textReads } from "#test/unit/physical/asked-by.fixtures.ts"

type Feature =
	| "one text read refused"
	| "both text reads named in one refusal"
	| "the key read beside a text read"
	| "the key read alone"

/** A refusal of an index request names every program that asked for it, at its call site, and no other. */
export const aRefusedRequestNamesEveryReadThatAskedForIt = property.exhaust(caseGen, {
	needs: {},
	situations: [
		"one text read refused",
		"both text reads named in one refusal",
		"the key read beside a text read",
		"the key read alone"
	] satisfies ReadonlyArray<Reached<Feature>>,
	check: (_, notes: CaseOf<Feature>) => (c) =>
		Effect.gen(function* () {
			const refusal = yield* refusalOf(c)
			const asked = Arr.filter(c, (name) => textReads.has(name))
			if (!Arr.isReadonlyArrayNonEmpty(asked)) {
				notes.note("the key read alone")
				assert.equal(refusal, undefined, "a login serving the key read alone drafts")
				return
			}
			notes.note(
				asked.length > 1 ? "both text reads named in one refusal" : "one text read refused"
			)
			if (Arr.contains(c, "byId")) {
				notes.note("the key read beside a text read")
			}
			assert.ok(
				refusal !== undefined && Str.includes("UnrepresentableKey")(refusal),
				`a login serving a text read is refused: ${String(refusal)}`
			)
			for (const name of c) {
				const named = Str.includes(`login app's program ${name} (`)(refusal)
				assert.equal(
					named,
					textReads.has(name),
					`the refusal names ${name} exactly where it asked for the refused request: ${refusal}`
				)
			}
			assert.ok(
				Str.includes("asked-by.fixtures.ts:")(refusal),
				`the refusal names each read's call site: ${refusal}`
			)
		}),
	oracle: {
		kind: "specification",
		name: "the draft refused exactly where a text read is served, naming each served text read by its login, its name and its call site, and no other"
	},
	box: "a login serving one to three of Note's reads, two binding its text of no byte bound alone and one its key",
	kept: [
		{
			token: ReplayToken(
				"test/unit/physical/asked-by.test.ts#aRefusedRequestNamesEveryReadThatAskedForIt:-:0.0.0.0"
			),
			reason:
				"a login serving alsoByText alone: the installation refused Note(text) as UnrepresentableKey naming the request and no read, as metis's generate refused SnapshotSingle(value) (METIS-TSGRADE's probe6 at 1b28f756), where the refusal names the program and its call site",
			since: "2026-11-28"
		}
	],
	kills: [
		{
			file: "packages/engine/src/physical/indexes/engine.ts",
			original: `\t\`\${requestLabel(asked.request)}, asked by \${asked.askedBy.map(askerText).join("; ")}\`\n`,
			replacement: "\trequestLabel(asked.request)\n",
			why: "A refusal names the request alone: a login serving alsoByText is refused as UnrepresentableKey on Note(text) naming no read, so its author cannot tell which program asked."
		},
		{
			file: "packages/engine/src/physical/indexes/engine.ts",
			original:
				"\t\taskers.set(text, known === undefined ? a.askedBy : extendNonEmpty(known, a.askedBy))\n",
			replacement: "\t\taskers.set(text, known === undefined ? a.askedBy : known)\n",
			why: "A request two reads make keeps its first asker alone: a login serving byText and alsoByText is refused naming one of them, the other read asking the same refused request unnamed."
		}
	]
})
