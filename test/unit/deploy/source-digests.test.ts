/**
 * A committed snapshot's record of a function's source digests the body its CREATE FUNCTION writes, printed once
 * (sql/print.ts functionSource, sourceLines; sql/print-once.ts printedFunction), and generate holds every function its
 * folder creates to that record by the bytes the folder writes (deploy/render/sources.ts assertSourcesAsRecorded).
 *
 * qti-pie's B'' on grizzle 8ff136e86 installed pantry and refused at its own drift check: the record of
 * ForwardBranchRule's upkeep digested the body as it was lowered, where the file held it printed once, its NOT
 * MATERIALIZED CTE read once in place under its reference's alias, and `grizzle check` regenerated both alike and passed.
 *
 * - **Property:** over drawn PL/pgSQL functions and ForwardBranchRule's upkeep's shape, each function's record digests
 *   the source PostgreSQL stores of its printed CREATE FUNCTION; generate's reader reads that source off the statement
 *   as a drafted file spells it, a body holding a tab as an escape string, and holds it to the record; and each function
 *   printed again alone, and every function printed again in a drawn order, each a copy that shares nothing with the
 *   first print, prints the bytes it printed first, so a function's text is a function of the function alone.
 * - **Oracle:** specification: the source read off the printed text's one dollar-quoted constant by the lexer, apart
 *   from generate's reader, its SHA-256 the record's; the first print's bytes.
 * - **Space:** two to four functions of one to three probes, each probe's query one of print-once's drawn statements
 *   (one to four CTEs, plain, MATERIALIZED, NOT MATERIALIZED or VOLATILE, read none, one or two times), its message
 *   holding a tab or not; ForwardBranchRule's upkeep's shape beside them in every case, kept.
 * - **Features:** a CTE printed in place, a body spelled as an escape string, and ForwardBranchRule's upkeep.
 *
 * And generate's hold: a folder whose CREATE FUNCTION installs a source its record does not digest is an internal
 * compiler error naming the function, the last CREATE of a function in the folder the one held.
 *
 * - **Property:** over each folder of the box, the hold refuses exactly a folder that creates a recorded function whose
 *   last CREATE installs a source of another digest than its record's, naming it: a record of another function's
 *   digest, and a record of a function's first CREATE where the folder creates it twice; it admits a folder as recorded
 *   and one whose record names a function the folder does not create, which a folder before it created.
 * - **Oracle:** specification: refused exactly there.
 * - **Box, exhausted:** ForwardBranchRule's upkeep created or not, after a first CREATE of it or not, a function of one
 *   probe beside it or not, its record the last CREATE's digest, the first's, the other function's or none.
 * - **Features:** a folder as recorded, a record of another function's digest, a function created twice, a record of a
 *   replaced CREATE, and a recorded function the folder does not create.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { boolean, element, finite, type Gen } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { sha256Hex } from "#compiler/core/sha256.ts"
import { wellFormed } from "#compiler/core/text.ts"
import { assertSourcesAsRecorded, writtenSources } from "#compiler/deploy/render/sources.ts"
import type { PlFunction } from "#compiler/sql/ast.ts"
import { printedFunction } from "#compiler/sql/print-once.ts"
import { printObjectName, printStatement } from "#compiler/sql/print.ts"
import {
	filedCreate,
	folderOf,
	type FunctionsShape,
	forwardBranchRuleUpkeep,
	functionOf,
	functionsGen,
	permutationOf,
	plFunction,
	recordedSourceOf,
	storedSourceOf
} from "#test/unit/deploy/source-digests.fixtures.ts"

type SourceFeature =
	| "a CTE printed in place"
	| "a body spelled as an escape string"
	| "ForwardBranchRule's upkeep"

/** The SHA-256 of a source, as the drift check digests pg_proc.prosrc. */
const digestOf = (source: string): string => sha256Hex(wellFormed(source))

/** Every function's record digests the body its CREATE FUNCTION writes, and a function prints alike alone and in any order. */
export const everyRecordedSourceDigestsTheBodyItsCreateFunctionWritesWhereverItIsPrinted =
	property.explore(functionsGen, {
		needs: {},
		situations: [
			"a CTE printed in place",
			"a body spelled as an escape string",
			"ForwardBranchRule's upkeep"
		] satisfies ReadonlyArray<Reached<SourceFeature>>,
		check: (_, c: Case<SourceFeature>) => (shape: FunctionsShape) =>
			Effect.sync(() => {
				const functions: ReadonlyArray<PlFunction> = [
					forwardBranchRuleUpkeep,
					...Arr.map(shape.functions, functionOf)
				]
				c.note("ForwardBranchRule's upkeep")
				const emitted = Arr.map(functions, (fn) => printStatement(fn))
				const filed = Arr.map(functions, filedCreate)
				const read = writtenSources(folderOf(filed))
				for (const [i, fn] of functions.entries()) {
					const name = printObjectName(fn.name)
					const text = emitted[i] ?? ""
					const stored = storedSourceOf(text)
					if (printedFunction(fn) !== fn) {
						c.note("a CTE printed in place")
					}
					if (filed[i] !== text) {
						c.note("a body spelled as an escape string")
					}
					const recorded: string = recordedSourceOf(fn)
					assert.equal(
						recorded,
						digestOf(stored),
						`${name}: the record digests the source its CREATE FUNCTION installs`
					)
					assert.equal(
						read.get(name),
						stored,
						`${name}: generate reads the source the drafted file installs, as PostgreSQL stores it`
					)
					assert.equal(
						printStatement(structuredClone(fn)),
						text,
						`${name}: printed again alone, sharing nothing with the first print, it prints its first bytes`
					)
				}
				assertSourcesAsRecorded(
					folderOf(filed),
					Arr.map(functions, (fn) => ({ function: fn.name, source: recordedSourceOf(fn) }))
				)
				const order = permutationOf(shape.order)
				const again = Arr.map(order, (i) => {
					const fn = functions[i]
					return fn === undefined ? "" : printStatement(structuredClone(fn))
				})
				assert.deepEqual(
					again,
					Arr.map(order, (i) => emitted[i] ?? ""),
					`printed again in the order ${Arr.join(Arr.map(order, String), ", ")}, every function prints its first bytes`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the source read off the printed text's one dollar-quoted constant by the lexer, its SHA-256; the first print's bytes"
		},
		show: (shape) =>
			`${shape.functions.length} functions of ${Arr.join(
				Arr.map(shape.functions, (f) => String(f.probes.length)),
				", "
			)} probes, printed again in the order ${Arr.join(Arr.map(permutationOf(shape.order), String), ", ")}`,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: `export const functionSource = (fn: PlFunction): string => \`\\n\${sourceLines(fn).join("\\n")}\\n\``,
				replacement: `export const functionSource = (fn: PlFunction): string => \`\\n\${blockLines(fn.body).join("\\n")}\\n\``,
				why: "A second print: the record digests the body as it was lowered, printed by a path of its own, where its CREATE FUNCTION writes it printed once, so ForwardBranchRule's upkeep drifts on every database (qti-pie B'')."
			},
			{
				file: "packages/engine/src/sql/print-once.ts",
				original: "\t\t\t\talias: source.alias ?? cte.name,\n",
				replacement: `\t\t\t\talias: \`\${source.alias ?? cte.name}_\${String(Reflect.set(globalThis, "printedAliases", Number(Reflect.get(globalThis, "printedAliases") ?? 0) + 1) && Reflect.get(globalThis, "printedAliases"))}\`,\n`,
				why: "A shared alias counter: an alias numbered by every print before it, so a function printed alone, or after others, prints other bytes than its first print, which its record digests."
			},
			{
				file: "packages/engine/src/sql/escape.ts",
				original: '\t["t", "\\t"],\n',
				replacement: '\t["t", "t"],\n',
				why: "An escape string's tab read back as the letter t: generate reads another source than the one a drafted file installs."
			}
		]
	})

/** A function of one probe under ForwardBranchRule's upkeep's name and another body: the first of its two CREATEs. */
const firstUpkeep = plFunction(forwardBranchRuleUpkeep.name.name, [
	{ kind: "raise", message: "the upkeep as a first CREATE defined it", using: [] }
])

/** A function of one probe, which a folder creates beside the upkeep or in its place. */
const another = plFunction("__another", [{ kind: "raise", message: "another function", using: [] }])

/**
 * A folder the hold reads: whether it creates the upkeep, and before that CREATE another of it (firstUpkeep); whether
 * it creates another function beside it; and whose digest the snapshot records the upkeep's source by, the last
 * CREATE's, the first's, another function's, or none.
 */
interface HeldFolder {
	readonly upkeep: boolean
	readonly twice: boolean
	readonly beside: boolean
	readonly recorded: "last" | "first" | "another" | "none"
}

const heldFolderGen: Gen<HeldFolder> = (source) => ({
	upkeep: source.draw(boolean),
	twice: source.draw(boolean),
	beside: source.draw(boolean),
	recorded: source.draw(element(["last", "first", "another", "none"] as const))
})

type HoldFeature =
	| "a folder as recorded"
	| "a record of another function's digest"
	| "a function created twice"
	| "a record of a replaced CREATE"
	| "a recorded function the folder does not create"

/** The hold refuses exactly a folder whose last CREATE of a recorded function installs a source of another digest. */
export const generateHoldsEveryFunctionItsFolderCreatesToItsRecord = property.exhaust(
	finite(heldFolderGen),
	{
		needs: {},
		situations: [
			"a folder as recorded",
			"a record of another function's digest",
			"a function created twice",
			"a record of a replaced CREATE",
			"a recorded function the folder does not create"
		] satisfies ReadonlyArray<Reached<HoldFeature>>,
		check: (_, c: Case<HoldFeature>) => (held) =>
			Effect.sync(() => {
				const creates = [
					...(held.upkeep && held.twice ? [firstUpkeep] : []),
					...(held.upkeep ? [forwardBranchRuleUpkeep] : []),
					...(held.beside ? [another] : [])
				]
				const recordedOf = {
					last: recordedSourceOf(forwardBranchRuleUpkeep),
					first: recordedSourceOf(firstUpkeep),
					another: recordedSourceOf(another)
				}
				const recorded =
					held.recorded === "none"
						? []
						: [{ function: forwardBranchRuleUpkeep.name, source: recordedOf[held.recorded] }]
				const refused = held.upkeep && held.recorded !== "none" && held.recorded !== "last"
				if (held.upkeep && held.twice) {
					c.note("a function created twice")
				}
				if (!held.upkeep && held.recorded !== "none") {
					c.note("a recorded function the folder does not create")
				}
				if (refused) {
					c.note(
						held.recorded === "first" && held.twice
							? "a record of a replaced CREATE"
							: "a record of another function's digest"
					)
				} else if (held.upkeep) {
					c.note("a folder as recorded")
				}
				const hold = (): void =>
					assertSourcesAsRecorded(folderOf(Arr.map(creates, filedCreate)), recorded)
				if (refused) {
					assert.throws(
						hold,
						(e) => Str.includes(printObjectName(forwardBranchRuleUpkeep.name))(String(e)),
						"the hold refuses the record of a source its folder's last CREATE does not install, naming the function"
					)
				} else {
					hold()
				}
			}),
		oracle: {
			kind: "specification",
			name: "refused exactly where the folder creates a recorded function whose last CREATE installs a source of another digest"
		},
		box: "the upkeep created or not, after a first CREATE of it or not, another function beside it or not, its record the last CREATE's digest, the first's, another function's or none",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/render/sources.ts",
				original: "\t\tif (digest !== r.source) {\n",
				replacement: "\t\tif (false) {\n",
				why: "No hold: a record of another digest than the source its folder installs is written, and drifts on every database."
			},
			{
				file: "packages/engine/src/deploy/render/sources.ts",
				original: "\t\t\t\t\tsources.set(created.name, created.source)\n",
				replacement:
					"\t\t\t\t\tsources.set(created.name, sources.get(created.name) ?? created.source)\n",
				why: "The first CREATE of a function held, where PostgreSQL holds the last."
			}
		]
	}
)
