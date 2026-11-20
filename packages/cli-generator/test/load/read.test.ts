/**
 * A document is read whole from what carries it, and only from a regular file the read has checked. An operator's path
 * loads through any chain of symlinks; a stream loads across any cut into chunks; a file that grew past the size its
 * handle reports is read on to its end, each read asking for that size; what loads is JSON when its first
 * non-whitespace character is `{` and YAML otherwise. A missing name, a directory, a FIFO, a file swapped in between the
 * stat and the open, and a special file (refused before it is opened) are each refused as unreadable at document
 * scope. A member file inside a trust boundary is read from the handle its check saw, never through a symlink at its
 * final component; a check that refuses leaves it refused. A refusal keeps its code, pointer and place.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Effect } from "effect"
import {
	actualMember,
	actualOf,
	askedFeatures,
	askedFields,
	askedOf,
	askedRefusals,
	type AskedFeature,
	type DeliveryFeature,
	deliveries,
	deliveryFeatures,
	expectedMember,
	expectedOf,
	type MemberFeature,
	memberFeatures,
	members,
	refusalFields
} from "#test/load/read.fixtures.ts"

/**
 * A document loads whole from a regular file, a chain of symlinks, a stream or a grown file, and nothing else. It
 * replaces ten example cases (json.test.ts's seven, read.test.ts's operator paths), so its rotating stream is ten
 * drawn deliveries; its floor and steered phase reach each required situation by an aimed delivery.
 */
export const documentRead = property.explore(deliveries, {
	needs: { dir: Scratch.dir },
	situations: [
		"a JSON document",
		"a YAML document",
		"leading whitespace before a brace",
		"a regular file",
		"a chain of symlinks",
		"a missing name",
		"a directory",
		"a FIFO",
		"a stream cut into chunks",
		"a file grown past its stat",
		"a special file left unopened",
		"a file swapped between its stat and its open"
	] satisfies ReadonlyArray<Reached<DeliveryFeature>>,
	check:
		({ dir }, c: Case<DeliveryFeature>) =>
		(delivery) =>
			Effect.gen(function* () {
				c.noteAll(deliveryFeatures(delivery))
				const scratch = yield* dir
				const actual = yield* actualOf(scratch, delivery)
				assert.deepEqual(actual, expectedOf(delivery))
			}),
	oracle: {
		kind: "specification",
		name: "the loader's reading of each carrier: whole from a regular file, the format by its first character, unreadable otherwise"
	},
	kept: [],
	budget: { runs: 10, steered: 24 },
	kills: [
		{
			file: "packages/cli-generator/src/load/index.ts",
			original: 'Str.startsWith("{")(Str.trimStart(text))',
			replacement: 'Str.startsWith("{")(text)',
			why: "The format is picked by the text's first character before whitespace is skipped, so a JSON object after leading whitespace loads as YAML; the property fails."
		},
		{
			file: "packages/cli-generator/src/load/read.ts",
			original:
				'info.type === "File" ? Effect.void : refuse(document, "DOC-14/unreadable", wholeInput)',
			replacement: "Effect.void",
			why: "A special file, a directory or a FIFO passes the regular-file check, so it is opened (and a FIFO blocks or a directory fails as something else); the property fails."
		},
		{
			file: "packages/cli-generator/src/load/read.ts",
			original:
				'sameFile(before, opened) ? Effect.void : refuse(document, "DOC-14/unreadable", wholeInput)',
			replacement: "Effect.void",
			why: "A file swapped in between the stat and the open is read, not refused; the property fails."
		},
		{
			file: "packages/cli-generator/src/load/read.ts",
			original: "onSome: (chunk): Page => [[chunk], Option.some(handle)]",
			replacement: "onSome: (chunk): Page => [[chunk], Option.none()]",
			why: "A file is read in one read of the size its handle reported, so a file that grew past it loads cut short; the property fails."
		}
	]
})

/**
 * A member file is read whole from the handle its check saw, and refused unread otherwise. It replaces six example
 * cases, so its rotating stream is six drawn members; its floor and steered phase reach each situation by an aimed one.
 */
export const memberRead = property.explore(members, {
	needs: { dir: Scratch.dir },
	situations: [
		"a regular member admitted",
		"a member the check refuses",
		"an empty member",
		"a member past a megabyte",
		"a symlink at the final component",
		"a directory member",
		"a FIFO member"
	] satisfies ReadonlyArray<Reached<MemberFeature>>,
	check:
		({ dir }, c: Case<MemberFeature>) =>
		(member) =>
			Effect.gen(function* () {
				c.noteAll(memberFeatures(member))
				const scratch = yield* dir
				const actual = yield* actualMember(scratch, member)
				assert.deepEqual(actual, expectedMember(member))
			}),
	oracle: {
		kind: "specification",
		name: "a boundary member's reading: its bytes from the checked handle, or unreadable before any check"
	},
	kept: [],
	budget: { runs: 6, steered: 14 },
	kills: [
		{
			file: "packages/cli-generator/src/load/read.ts",
			original: '.open(path, { flag: "r", noFollow: true })',
			replacement: '.open(path, { flag: "r", noFollow: false })',
			why: "A symlink at a member's final component is followed and its target read; the property fails."
		},
		{
			file: "packages/cli-generator/src/load/read.ts",
			original: "\tyield* verify(before, opened)",
			replacement: "\tyield* Effect.void",
			why: "The boundary's check of the opened handle is never run, so a member it refuses is read; the property fails."
		}
	]
})

/**
 * A load refusal keeps its tag, code, document scope, pointer, and its line, column and offset when it has a place. It
 * replaces one example case of two refusals; its budget is 4 drawn refusals.
 */
export const refusalKept = property.explore(askedRefusals, {
	needs: {},
	situations: ["a placed refusal", "a refusal without a place"] satisfies ReadonlyArray<
		Reached<AskedFeature>
	>,
	check: (_, c: Case<AskedFeature>) => (asked) =>
		Effect.map(askedOf(asked), (refusal) => {
			c.noteAll(askedFeatures(asked))
			assert.deepEqual(refusalFields(refusal), askedFields(asked))
		}),
	oracle: { kind: "specification", name: "the refusal's fields, as refuse was asked for them" },
	kept: [],
	budget: { runs: 4, steered: 4 },
	kills: [
		{
			file: "packages/cli-generator/src/load/read.ts",
			original: "makeDiagnostic({ ...fields, column: position.column, line: position.line })",
			replacement: "makeDiagnostic({ ...fields, column: position.line, line: position.column })",
			why: "A refusal's line and column trade places; the property fails."
		},
		{
			file: "packages/cli-generator/src/load/read.ts",
			original: "Effect.fail(LoadRefusal.make({ diagnostic, offset: position.offset }))",
			replacement: "Effect.fail(LoadRefusal.make({ diagnostic }))",
			why: "A placed refusal loses its byte offset; the property fails."
		}
	]
})
