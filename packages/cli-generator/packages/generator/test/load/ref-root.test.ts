/**
 * `--ref-root` preloads every JSON and YAML file under its root, after the pairs, by the file URL of each file's real
 * path, in the walk's order, each once: a link inside the root reads as its target, a directory reached twice (a link
 * to it, a link back up the tree) is entered once, a tree forty levels deep is walked to its bottom, and anything not
 * named like a spec file that is no directory inside the root (a dangling link, a link out, a FIFO, a node_modules-style
 * directory link out) is skipped. A spec-named link out of the root is refused as outside-root, a spec-named FIFO as
 * unreadable-root before it is opened, a pair under a preloaded file's URI as a duplicate naming the file, and a member
 * swapped at its open (for a link out, its parent for a link out, or swapped back after the open) is refused; an entry
 * inside the root is that member, never a second document; a ../ path is outside the root. The generator's member
 * check takes the entry's own file under its exact URI as the entry, and refuses any other file under it or any other
 * spelling of it.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Effect } from "effect"
import { Digest } from "effect/crypto"
import {
	actualOf,
	comparable,
	type EntryFeature,
	entryCases,
	entryFeatures,
	expectedOf,
	type Hazard,
	laidOut,
	membersOf,
	trees
} from "#test/load/ref-root.fixtures.ts"
import { digestService } from "#test/support/digest.ts"

/**
 * A reference root loads as the specification's walk says, or is refused at its hazard. It replaces seventeen example
 * cases, so its rotating stream is seventeen drawn trees; its floor and steered phase reach each hazard by an aimed tree.
 */
export const refRoot = property.explore(trees, {
	needs: { dir: Scratch.dir, digest: digestService },
	situations: [
		"none",
		"a link to a member",
		"a directory link inside the root",
		"a spec-named link to an outside file",
		"a spec-named link to an outside directory",
		"a directory link to outside, not spec-named",
		"skipped entries: dangling, escaping and special",
		"a spec-named FIFO",
		"directory links closing a cycle",
		"a spec file deep below the root",
		"pairs beside the root",
		"a pair under a member's URI",
		"a member swapped for an outside link at its open",
		"a parent swapped for an outside link at its member's open",
		"a parent swapped out and back around its member's open",
		"a ../ path"
	] satisfies ReadonlyArray<Reached<Hazard["kind"]>>,
	check:
		({ dir, digest }, c: Case<Hazard["kind"]>) =>
		(tree) =>
			Effect.gen(function* () {
				const service = yield* digest
				const scratch = yield* dir
				const place = yield* laidOut(scratch, tree)
				const expected = yield* expectedOf(place, tree)
				const actual = yield* Effect.provideService(actualOf(place, tree), Digest.Digest, service)
				c.note(tree.hazard.kind)
				assert.deepEqual(comparable(expected, actual), expected)
			}),
	oracle: {
		kind: "specification",
		name: "the reference root's walk: every spec file once by its real path, in name order, or the hazard's refusal"
	},
	kept: [],
	budget: { runs: 17, steered: 32 },
	kills: [
		{
			file: "packages/generator/src/load/document-set.ts",
			original: '\t\t\t\t\t\tEffect.map((info) => info.type === "Directory"),',
			replacement: '\t\t\t\t\t\tEffect.map((info) => info.type !== "Directory"),',
			why: "A name not like a spec file is entered when it is no directory and skipped when it is one, so a subdirectory's spec files are never loaded; the property fails (CATCH's evidence, mutant 1504b072df)."
		},
		{
			file: "packages/generator/src/load/json.ts",
			original: "\t})\n\tstate.cursor += 1\n}\n",
			replacement: "\t})\n\t{}\n}\n",
			why: "Opening an object or array leaves the JSON reader on its bracket, so every JSON member file fails to parse; the property fails (CATCH's evidence, mutant 5bda9a6d80)."
		},
		{
			file: "packages/generator/src/load/document-set.ts",
			original:
				"isDocumentUri(pair.uri)\n\t\t? pair.uri\n\t\t: (yield* path.toFileUrl(pair.path).pipe(Effect.orDie)).href",
			replacement:
				"isDocumentUri(pair.uri) ? (yield* path.toFileUrl(pair.path).pipe(Effect.orDie)).href : pair.uri",
			why: "A refusal's document is the file URL for an absolute URI and the raw text otherwise, so a root's refusal, which names no URI, cannot be made; the property fails (CATCH's evidence, mutant 6b350018a4)."
		}
	]
})

/**
 * The generator's member check against the entry. It replaces one example case of two spellings; its budget is 4 drawn members, steered up to 8 while a situation is
 * unreached.
 */
export const entryMembers = property.explore(entryCases, {
	needs: { dir: Scratch.dir, digest: digestService },
	situations: [
		"exact over the entry's file",
		"exact over another file",
		"a dot segment over the entry's file",
		"upper scheme over another file",
		"another URI over another file"
	] satisfies ReadonlyArray<Reached<EntryFeature>>,
	check:
		({ dir, digest }, c: Case<EntryFeature>) =>
		(entryCase) =>
			Effect.gen(function* () {
				const service = yield* digest
				const scratch = yield* dir
				const judged = yield* Effect.provideService(
					membersOf(scratch, entryCase),
					Digest.Digest,
					service
				)
				c.noteAll(entryFeatures(entryCase))
				assert.deepEqual(judged.actual, judged.expected)
			}),
	oracle: {
		kind: "specification",
		name: "the entry's own file under its exact URI is the entry; another file or spelling under it is a duplicate"
	},
	kept: [],
	budget: { runs: 4, steered: 8 },
	kills: [
		{
			file: "packages/generator/src/generate.ts",
			original: "document !== entry.document || Option.isNone(entryPath)",
			replacement: "Option.isNone(entryPath)",
			why: "A member spelling the entry's URI differently over the entry's own file is taken as the entry instead of refused; the property fails (CATCH's evidence, mutant 63b3374ef1)."
		}
	]
})
