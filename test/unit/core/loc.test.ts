/**
 * Source locations (core/loc.ts): a SourceLoc names a logical path, a label and the JavaScript call site that built it,
 * parsed by hand from a stack's frame lines, V8's ("    at fn (file:line:col)") and SpiderMonkey's or
 * JavaScriptCore's ("fn@file:line:col"), the library's and the runtime's frames skipped.
 *
 * The frames are drawn from their parts (a function name or none, a file spelled as a URL, a POSIX or Windows path or a
 * runtime module, a line and a column), written in each engine's form, so the oracle is the parts themselves.
 *
 * - Frames: every engine's frame line reads as its file, line and column, every other line reads as no site, a stack
 *   reads as its frames' sites in order, a frame is the library's exactly when its file is the library's, its engine's
 *   or its shell's, or the runtime's, and a stack's site is its first user frame's. Oracle: the frame's own parts.
 * - Capture: a declaration made through a chain of compiled frames is located at its innermost caller outside the
 *   library. Oracle: the drawn chain, whose call lines are placed by construction.
 * - Structure: a SourceLoc is recognized by its exact structure, and nothing else is. Oracle: the constructors
 *   (SourceLoc, sitedLoc) against the parser, and each named malformation.
 * - Relocation: a refusal moved inside a value has its path prefixed, and keeps its label, site and reason. Oracle: the
 *   location built with the prefixed path.
 *
 * Features: each engine's form and each kind of file, a line of no site; the caller's own call, through the library, a
 * user frame the library calls; each spelling of a SourceLoc and each malformation; a site and no site.
 *
 * A file as a stack names it: a user's, or the library's (its engine's or its shell's) or the runtime's, which a
 * user-facing location skips.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { malformedDescription, within } from "#compiler/core/errors.ts"
import {
	captureLoc,
	isLibraryFrame,
	isSourceLoc,
	parseFrame,
	parseSourceLoc,
	parseStack,
	readSite,
	SourceLoc,
	sitedLoc,
	siteFromStack
} from "#compiler/core/loc.ts"
import {
	callLine,
	captureGen,
	compiled,
	type FileKind,
	type Form,
	linesGen,
	type Placed,
	type Reach,
	type Spelling,
	structureGen,
	userKind,
	withinGen,
	written
} from "#test/unit/core/loc.fixtures.ts"

/** Stack frame parsing reads every engine's frame as its file, line and column, and no site from any other line. Its budget is its suite's before it was a property (test/unit/core/loc.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const stackFrameParsingReadsEveryEnginesFrameAsItsFileLineAndColumnAndNoSiteFromAnyOtherLine =
	property.explore(linesGen, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"V8 in a function",
			"V8 at top level",
			"SpiderMonkey in a function",
			"SpiderMonkey anonymous",
			"a file URL",
			"a POSIX path",
			"a Windows path",
			"an HTTP URL",
			"the library",
			"the shell",
			"the runtime",
			"a line of no site"
		] satisfies ReadonlyArray<Reached<Form | FileKind | "a line of no site">>,
		check: (_, c: Case<Form | FileKind | "a line of no site">) => (lines) =>
			Effect.sync(() => {
				const sites = Arr.flatMap(lines, (line) => {
					if (typeof line === "string") {
						assert.equal(parseFrame(line), undefined)
						c.note("a line of no site")
						return []
					}
					const site = { file: line.at.file, line: line.line, column: line.column }
					assert.deepEqual(parseFrame(written(line)), site)
					c.note(line.form)
					c.note(line.at.kind)
					return [
						{
							site,
							user: userKind(line.at.kind)
						}
					]
				})
				const stack = Arr.join(
					Arr.map(lines, (line) => (typeof line === "string" ? line : written(line))),
					"\n"
				)
				assert.deepEqual(
					parseStack(stack),
					Arr.map(sites, (s) => s.site)
				)
				for (const s of sites) {
					assert.equal(isLibraryFrame(s.site.file), !s.user)
				}
				assert.deepEqual(
					siteFromStack(stack),
					Arr.findFirst(sites, (s) => s.user).pipe(
						Option.map((s) => s.site),
						Option.getOrUndefined
					)
				)
			}),
		oracle: { kind: "specification", name: "the parts each frame was written from" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/loc.ts",
				original: "\t\t\treturn open < 0 ? undefined : parseLocation(rest.slice(open + 1, -1))",
				replacement:
					'\t\t\treturn open < 0 ? undefined : parseLocation(rest.slice(open + 1, rest.lastIndexOf(":")))',
				why: "a V8 frame's location cut before its column, so the frame reads as no site; the frames property fails."
			},
			{
				file: "packages/engine/src/core/loc.ts",
				original: '\tfile.startsWith("node:") ||\n',
				replacement: "",
				why: "a runtime frame (`node:`) taken as the user's; the frames and the capture properties fail."
			},
			{
				file: "packages/engine/src/core/loc.ts",
				original: '\tfile.includes("/packages/grizzle/src/") ||\n',
				replacement: "",
				why: "a frame of grizzle's shell taken as the user's, so a refusal codecText reads through the engine is located in the shell; the frames property fails."
			}
		]
	})

/** Call-site capture locates a declaration at the line of its innermost caller outside the library. Its budget is its suite's before it was a property (test/unit/core/loc.test.ts at 4ca3036a): 50 runs and 50 steered cases. */
export const callSiteCaptureLocatesADeclarationAtTheLineOfItsInnermostCallerOutsideTheLibrary =
	property.explore(captureGen, {
		needs: {},
		budget: { runs: 50, steered: 50 },
		situations: [
			"the caller's own call",
			"through the library",
			"a user frame the library calls"
		] satisfies ReadonlyArray<Reached<Reach>>,
		check:
			(_, c: Case<Reach>) =>
			({ label, path, caller, inner }) =>
				Effect.sync(() => {
					const user = (p: Placed): boolean => userKind(p.at.kind)
					const expected = Option.getOrElse(Arr.findLast(inner, user), () => caller)
					if (inner.length === 0) {
						c.note("the caller's own call")
					}
					if (Option.exists(Arr.last(inner), (p) => !user(p))) {
						c.note("through the library")
					}
					if (Arr.some(Arr.dropWhile(inner, user), user)) {
						c.note("a user frame the library calls")
					}
					const captured: unknown = Reflect.apply(compiled(caller), undefined, [
						[...Arr.map(inner, compiled), captureLoc],
						label,
						path
					])
					const loc = defined(parseSourceLoc(captured), "the captured location")
					const site = defined(readSite(loc.site), "the captured site")
					assert.deepEqual(
						{ label: loc.label, path: loc.path, file: site.file, line: site.line },
						{ label, path, file: expected.at.file, line: callLine(expected) }
					)
				}),
		oracle: { kind: "specification", name: "the drawn chain's placed call lines" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/loc.ts",
				original: '\tfile.startsWith("node:") ||\n',
				replacement: "",
				why: "a runtime frame (`node:`) taken as the user's; the frames and the capture properties fail."
			}
		]
	})

/** SourceLoc is recognized by its exact structure. Its budget is its suite's before it was a property (test/unit/core/loc.test.ts at 4ca3036a): 200 runs and 200 steered cases. */
export const sourceLocIsRecognizedByItsExactStructure = property.explore(structureGen, {
	needs: {},
	budget: { runs: 200, steered: 200 },
	situations: [
		"a location",
		"a location with a site",
		"an extra key",
		"a bad path segment",
		"a bad site",
		"no record"
	] satisfies ReadonlyArray<Reached<Spelling>>,
	check:
		(_, c: Case<Spelling>) =>
		([{ label, path, site }, spelling]) =>
			Effect.sync(() => {
				c.note(spelling)
				switch (spelling) {
					case "a location":
						assert.deepEqual(parseSourceLoc({ path, label }), SourceLoc(label, path))
						return
					case "a location with a site":
						assert.deepEqual(parseSourceLoc({ path, label, site }), sitedLoc(label, path, site))
						return
					case "an extra key":
						assert.equal(isSourceLoc({ path, label, extra: 1 }), false)
						return
					case "a bad path segment":
						assert.equal(isSourceLoc({ path: [...path, {}], label }), false)
						return
					case "a bad site":
						assert.equal(isSourceLoc({ path, label, site: { file: site.file } }), false)
						return
					case "no record":
						assert.equal(isSourceLoc(label), false)
						assert.equal(isSourceLoc(null), false)
						return
				}
			}),
	oracle: {
		kind: "specification",
		name: "the constructors, and each named malformation"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/core/loc.ts",
			original:
				'\tif (!Object.keys(value).every((k) => k === "path" || k === "label" || k === "site")) {',
			replacement:
				'\tif (!Object.keys(value).some((k) => k === "path" || k === "label" || k === "site")) {',
			why: "a record with a key beyond a location's read as one; the structure property fails."
		}
	]
})

/** SourceLoc relocates a refusal inside a value by prefixing its path, keeping its label, site, reason and capability. Its budget is its suite's before it was a property (test/unit/core/loc.test.ts at 4ca3036a): 200 runs and 200 steered cases. */
export const sourceLocRelocatesARefusalInsideAValueByPrefixingItsPathKeepingItsLabelSiteReasonAndCapability =
	property.explore(withinGen, {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: ["a site", "no site"] satisfies ReadonlyArray<Reached<"a site" | "no site">>,
		check:
			(_, c: Case<"a site" | "no site">) =>
			({ label, path, prefix, site }) =>
				Effect.sync(() => {
					c.note(site === undefined ? "no site" : "a site")
					const refusal = malformedDescription(sitedLoc(label, path, site), "a planted rule")
					const moved = within(refusal, prefix)
					assert.deepEqual(moved.reason, {
						_tag: "MalformedDescription",
						at: sitedLoc(label, [...prefix, ...path], site),
						what: "a planted rule"
					})
				}),
		oracle: { kind: "specification", name: "the location built at the prefixed path" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/loc.ts",
				original: "\tpath: [...path, ...loc.path],",
				replacement: "\tpath: [...loc.path, ...path],",
				why: "a relocation's prefix appended after the path; the relocation property fails."
			}
		]
	})
