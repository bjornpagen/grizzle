/**
 * The structural decoders (ir/shape.ts) over a small shape of points, lists and marks, every one a decoder the
 * Description boundary and the IR are built from.
 *
 * - Broken: a live value decodes into an equal fresh copy, and one broken at one site is refused there, by its place's
 *   label and path, or passed over where the break is no break.
 * - Idempotent: decoding a decoded value again gives an equal fresh copy, key order included.
 * - Record keys: `__proto__` is an ordinary key of a record, in this process and in a child Node started as a library
 *   consumer's is, with no flag, where Object.prototype.__proto__ exists (every test process runs with
 *   --disable-proto=delete, which hides an assignment that would set the prototype).
 * - Unreadable: a proxy or a throwing getter is refused at its path.
 * - Defects: a decoder's own defect escapes decodeWith as itself, at every site.
 * - Refinements: exactly the distinct nonempty names, the nonempty lists and the safe and positive integers pass.
 * - Depth and cycles: a value nested at any depth decodes without deepening the call stack, and one that holds itself is
 *   refused where it meets itself, having read each container's link once and the one it meets again once more; a read
 *   past those throws, so a decode that goes round the cycle ends one read past it.
 *
 * Oracles: each break's site, the decode's own idempotence, the refinements' definitions, and the value's construction.
 *
 * Features: each break, each decoded form, an own __proto__ key in each process, each unreadable site, each defect
 * site, each refinement admitted and refused, depths within and past a small stack, each cycle length and form.
 */

import { Checkout } from "@bjornpagen/testing/checkout"
import { type Reached } from "@bjornpagen/testing/features"
import { array, constant, element, finite, int, map, weighted } from "@bjornpagen/testing/gen"
import { type Drawn, passed, wild } from "@bjornpagen/testing/lsw"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { indices } from "#compiler/core/array.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import * as S from "#compiler/ir/shape.ts"
import {
	assert,
	nonEmpty,
	placeOf,
	refusalLoc,
	refused,
	succeeded,
	unorderedEqual
} from "#test/support/assert.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import type { ConsumerRecord } from "#test/unit/ir/shape-record.child.ts"
import {
	type Break,
	breakNames,
	breaksOf,
	built,
	consumerProcess,
	containers,
	CycleReads,
	cyclic,
	type Decoded,
	type DecodedIn,
	decodedIn,
	Defect,
	defective,
	type DefectKind,
	type DefectSite,
	depthFeature,
	depthOf,
	edited,
	entriesGen,
	formGen,
	formShape,
	int4Gen,
	keysOf,
	liveGen,
	type NestingFeature,
	numberGen,
	placeAt,
	placed,
	shape,
	sitesOf,
	stepOf,
	type UnreadableFeature
} from "#test/unit/ir/shape.fixtures.ts"

/** Shapes decode a live value into an equal fresh copy, and refuse one broken at one site, naming that site. */
export const shapesDecodeALiveValueIntoAnEqualFreshCopyAndRefuseOneBrokenAtOneSiteNamingThatSite =
	property.explore(
		(source) => ({
			live: source.draw(liveGen),
			kind: source.draw(pickGen),
			site: source.draw(pickGen)
		}),
		{
			needs: {},
			situations: breakNames satisfies ReadonlyArray<Reached<Break>>,
			check:
				(_, c: Case<Break>) =>
				({ live, kind, site }) =>
					Effect.sync(() => {
						const decoded = succeeded(S.decodeWith(shape, live, "v"))
						assert.deepEqual<unknown>(decoded, structuredClone(live))
						const broken = pickFrom(
							pickFrom(nonEmpty(breaksOf(live), "a live value's breaks"), kind),
							site
						)
						c.note(broken.break)
						const result = S.decodeWith(shape, broken.value, "v")
						if (broken.outcome.kind === "passed over") {
							assert.deepEqual(succeeded(result), decoded)
						} else {
							assert.deepEqual(
								placeOf(refusalLoc(refused(result, "MalformedDescription"))),
								placeAt(broken.outcome.at)
							)
						}
					}),
			oracle: {
				kind: "specification",
				name: "each break's own site, compared by its label and path"
			},
			kept: [
				{
					token: ReplayToken(
						"test/unit/ir/shape.test.ts#shapesDecodeALiveValueIntoAnEqualFreshCopyAndRefuseOneBrokenAtOneSiteNamingThatSite:-:1.1.1.1.1.0.0.0"
					),
					reason: "null",
					since: "2026-10-29"
				},
				{
					token: ReplayToken(
						"test/unit/ir/shape.test.ts#shapesDecodeALiveValueIntoAnEqualFreshCopyAndRefuseOneBrokenAtOneSiteNamingThatSite:-:1.1.1.1.1.0.783.0"
					),
					reason: "unknown key",
					since: "2026-10-29"
				},
				{
					token: ReplayToken(
						"test/unit/ir/shape.test.ts#shapesDecodeALiveValueIntoAnEqualFreshCopyAndRefuseOneBrokenAtOneSiteNamingThatSite:-:1.1.1.1.1.0.eg5.pa8"
					),
					reason: "symbol key refused",
					since: "2026-10-29"
				},
				{
					token: ReplayToken(
						"test/unit/ir/shape.test.ts#shapesDecodeALiveValueIntoAnEqualFreshCopyAndRefuseOneBrokenAtOneSiteNamingThatSite:-:1.1.1.1.1.0.eg5.0"
					),
					reason: "symbol key passed over",
					since: "2026-10-29"
				},
				{
					token: ReplayToken(
						"test/unit/ir/shape.test.ts#shapesDecodeALiveValueIntoAnEqualFreshCopyAndRefuseOneBrokenAtOneSiteNamingThatSite:-:1.1.1.1.1.0.lo7.0"
					),
					reason: "hole",
					since: "2026-10-29"
				},
				{
					token: ReplayToken(
						"test/unit/ir/shape.test.ts#shapesDecodeALiveValueIntoAnEqualFreshCopyAndRefuseOneBrokenAtOneSiteNamingThatSite:-:1.1.1.1.1.0.swa.0"
					),
					reason: "unknown tag",
					since: "2026-10-29"
				},
				{
					token: ReplayToken(
						"test/unit/ir/shape.test.ts#shapesDecodeALiveValueIntoAnEqualFreshCopyAndRefuseOneBrokenAtOneSiteNamingThatSite:-:1.1.1.1.1.0.104c.0"
					),
					reason: "missing member",
					since: "2026-10-29"
				},
				{
					token: ReplayToken(
						"test/unit/ir/shape.test.ts#shapesDecodeALiveValueIntoAnEqualFreshCopyAndRefuseOneBrokenAtOneSiteNamingThatSite:-:1.1.1.1.1.0.17ce.0"
					),
					reason: "class instance",
					since: "2026-10-29"
				}
			],
			kills: [
				{
					file: "packages/engine/src/ir/shape.ts",
					original:
						"\t\t}\n\t\tsetOwn(out, key, yield* path.at(key, shapes[key].parse(child, path)))",
					replacement: "\t\t}\n\t\tsetOwn(out, key, yield* shapes[key].parse(child, path))",
					why: "A struct's required field is decoded at its container's place, so its refusal is placed at the container; the broken property fails."
				}
			]
		}
	)

/** Shapes decode a decoded value again into an equal fresh copy, key order included. */
export const shapesDecodeADecodedValueAgainIntoAnEqualFreshCopyKeyOrderIncluded = property.explore(
	liveGen,
	{
		needs: {},
		situations: ["a list of points", "a point", "a mark"] satisfies ReadonlyArray<Reached<Decoded>>,
		check: (_, c: Case<Decoded>) => (live) =>
			Effect.sync(() => {
				const out = succeeded(S.decodeWith(shape, live, "v"))
				c.note(
					out.kind === "point" ? "a point" : out.kind === "list" ? "a list of points" : "a mark"
				)
				const again = succeeded(S.decodeWith(shape, out, "v"))
				assert.notEqual(again, out)
				assert.deepEqual(again, out)
				assert.deepEqual(keysOf({ ...again }), keysOf({ ...out }))
			}),
		oracle: {
			kind: "universal",
			name: "decode ∘ decode = decode, a fresh copy, key order included"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/shape.ts",
				original: "function* within<A>(value: object, path: DecodePath, step: Step<A>): Step<A> {",
				replacement:
					"function* within<A>(value: object, path: DecodePath, step: Step<A>): Step<A> {\n\tif (Object.isFrozen(value)) {\n\t\treturn value\n\t}",
				why: "A frozen container is returned as decoded, unread; the idempotent property fails."
			}
		]
	}
)

/** Shapes refuse a value whose reading throws, at its path. */
export const shapesRefuseAValueWhoseReadingThrowsAtItsPath = property.explore(
	(source) => ({
		live: source.draw(liveGen),
		site: source.draw(pickGen),
		wild: source.draw(
			map(wild(["proxy", "throwing-getter"]), (w): Drawn<never, never> => ({
				kind: "wild",
				wild: w
			}))
		)
	}),
	{
		needs: {},
		situations: [
			"proxy at the root",
			"proxy nested",
			"throwing getter nested"
		] satisfies ReadonlyArray<Reached<UnreadableFeature>>,
		check:
			(_, c: Case<UnreadableFeature>) =>
			({ live, site, wild: drawnWild }) =>
				Effect.sync(() => {
					const path = pickFrom(sitesOf(live), site)
					const kind =
						drawnWild.kind === "wild" && drawnWild.wild.kind === "proxy"
							? "proxy"
							: "throwing getter"
					c.note(`${kind} ${path.length === 0 ? "at the root" : "nested"}`)
					const refusal = refused(
						S.decodeWith(
							shape,
							edited(live, path, () => passed(drawnWild)),
							"v"
						),
						"MalformedDescription"
					)
					assert.deepEqual(placeOf(refusalLoc(refusal)), placeAt(path))
				}),
		oracle: {
			kind: "specification",
			name: "a read that throws is refused at its path"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/shape.ts",
				original: "\tconst r = hostRead(unreadable, () => Result.ok(read()))",
				replacement: "\tconst r = Result.ok(read())",
				why: "A read of the caller's value runs unguarded, so a throwing proxy or getter escapes; the unreadable property fails."
			}
		]
	}
)

/** Shapes let a decoder's own defect escape. */
export const shapesLetADecodersOwnDefectEscape = property.exhaust(
	finite(
		(source) =>
			[
				source.draw(element<DefectKind>(["normalize", "refine", "brand"])),
				source.draw(
					element<DefectSite>([
						"the root",
						"an array item",
						"a struct field",
						"a union's first alternative",
						"a tagged case"
					])
				)
			] as const
	),
	{
		needs: {},
		situations: [
			"the root",
			"an array item",
			"a struct field",
			"a union's first alternative",
			"a tagged case"
		] satisfies ReadonlyArray<Reached<DefectSite>>,
		check:
			(_, c: Case<DefectSite>) =>
			([kind, site]) =>
				Effect.sync(() => {
					c.note(site)
					const defect = new Defect({ site: `a ${kind} defect in ${site}` })
					const { shape: decoder, value } = placed(site, defective(kind, defect))
					assert.throws(
						() => S.decodeWith(decoder, value, "v"),
						(e) => e === defect
					)
				}),
		oracle: {
			kind: "specification",
			name: "a decoder's own defect escapes decodeWith as itself"
		},
		box: "each kind of decoder defect at each site a shape decodes",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/shape.ts",
				original: "\t\t\treturn Result.err(caught.error)\n\t\t}\n\t\tthrow caught",
				replacement:
					'\t\t\treturn Result.err(caught.error)\n\t\t}\n\t\treturn Result.err(malformedAt(path.subject, path.keys, "a value its decoder reads"))',
				why: "A decoder's own defect is refused as malformed instead of escaping; the defects property fails."
			}
		]
	}
)

/** Shapes accept exactly the distinct nonempty names, the nonempty lists and the safe and positive integers. */
export const shapesAcceptExactlyTheDistinctNonemptyNamesTheNonemptyListsAndTheSafeAndPositiveIntegers =
	property.explore(
		(source) => ({
			names: source.draw(array(element(["", "a", "b", "c"]), { min: 0, max: 4 })),
			list: source.draw(array(int4Gen, { min: 0, max: 3 })),
			n: source.draw(numberGen)
		}),
		{
			needs: {},
			situations: [
				"names accepted",
				"a repeated name refused",
				"an empty name refused",
				"an empty list refused",
				"an integer refused",
				"a positive integer refused",
				"a positive integer accepted"
			] satisfies ReadonlyArray<
				Reached<
					| "names accepted"
					| "a repeated name refused"
					| "an empty name refused"
					| "an empty list refused"
					| "an integer refused"
					| "a positive integer refused"
					| "a positive integer accepted"
				>
			>,
			check:
				(
					_,
					c: Case<
						| "names accepted"
						| "a repeated name refused"
						| "an empty name refused"
						| "an empty list refused"
						| "an integer refused"
						| "a positive integer refused"
						| "a positive integer accepted"
					>
				) =>
				({ names, list, n }) =>
					Effect.sync(() => {
						const distinct = new Set(names).size === names.length
						const nonempty = Arr.every(names, (name) => name.length > 0)
						const decodedNames = S.decodeWith(
							S.uniqueStrings("names", S.nonEmptyString),
							names,
							"v"
						)
						if (distinct && nonempty) {
							c.note("names accepted")
							assert.deepEqual(succeeded(decodedNames), names)
						} else {
							c.note(nonempty ? "a repeated name refused" : "an empty name refused")
							refused(decodedNames, "MalformedDescription")
						}
						const decodedList = S.decodeWith(S.nonEmptyArray(S.integer), list, "v")
						if (list.length > 0) {
							assert.deepEqual<ReadonlyArray<number>>(succeeded(decodedList), list)
						} else {
							c.note("an empty list refused")
							refused(decodedList, "MalformedDescription")
						}
						const safe = Number.isSafeInteger(n)
						const integer = S.decodeWith(S.integer, n, "v")
						if (safe) {
							assert.equal(succeeded(integer), n)
						} else {
							c.note("an integer refused")
							refused(integer, "MalformedDescription")
						}
						const positive = S.decodeWith(S.positiveInteger, n, "v")
						if (safe && n > 0) {
							c.note("a positive integer accepted")
							assert.equal(succeeded(positive), n)
						} else {
							c.note("a positive integer refused")
							refused(positive, "MalformedDescription")
						}
					}),
			oracle: {
				kind: "specification",
				name: "distinct nonempty names, nonempty lists, safe and positive integers"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/ir/shape.ts",
					original: '\treturn n > 0 ? n : refuse(path, "a positive integer")',
					replacement: '\treturn n >= 0 ? n : refuse(path, "a positive integer")',
					why: "positiveInteger admits zero; the refinements property fails."
				}
			]
		}
	)

/** A record's keys keep __proto__ an ordinary key of a record, in this process and where Object.prototype.__proto__ exists. */
export const aRecordsKeysKeepProtoAnOrdinaryKeyOfARecordInThisProcessAndWhereObjectPrototypeProtoExists =
	property.explore((source) => [source.draw(entriesGen), source.draw(decodedIn)] as const, {
		needs: { checkout: Checkout.dir },
		situations: [
			"an own __proto__ key in this process",
			"an own __proto__ key in a consumer's process"
		] satisfies ReadonlyArray<Reached<`an own __proto__ key in ${DecodedIn}`>>,
		check:
			({ checkout }, c: Case<`an own __proto__ key in ${DecodedIn}`>) =>
			([entries, where]) =>
				Effect.gen(function* () {
					if (Arr.some(entries, ([key]) => key === "__proto__")) {
						c.note(`an own __proto__ key in ${where}`)
					}
					/** Record.fromEntries, which is Object.fromEntries, defines each key as an own property, as JSON.parse does. */
					const input = Rec.fromEntries(entries)
					switch (where) {
						case "this process": {
							const out = succeeded(
								S.decodeWith(S.recordShape(S.integer, S.nonEmptyString), input, "v")
							)
							unorderedEqual(Rec.toEntries(out), Rec.toEntries(input))
							assert.equal(Object.getPrototypeOf(out), Object.prototype)
							return
						}
						case "a consumer's process": {
							const dir = yield* checkout
							const consumer = yield* consumerProcess(dir)
							const answered = yield* consumer(entries)
							assert.equal(
								answered.kind,
								"answer",
								`the consumer's child exited:\n${answered.kind === "exited" ? answered.stderr : ""}`
							)
							if (answered.kind !== "answer") {
								return
							}
							const answer = trustedJson<ConsumerRecord>(answered.line)
							assert.equal(
								answer.accessor,
								true,
								"the consumer's child has Object.prototype.__proto__"
							)
							assert.equal(answer.decoded.kind, "decoded", Formatter.format(answer.decoded))
							if (answer.decoded.kind === "decoded") {
								unorderedEqual(answer.decoded.entries, Rec.toEntries(input))
								assert.equal(
									answer.decoded.plain,
									true,
									"the decoded record's prototype is Object.prototype"
								)
							}
							return
						}
					}
				}),
		oracle: {
			kind: "specification",
			name: "a record's entries are its own keys, __proto__ an ordinary one"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/shape.ts",
				original:
					"\tObject.defineProperty(target, key, {\n\t\tvalue,\n\t\tenumerable: true,\n\t\twritable: true,\n\t\tconfigurable: true\n\t})",
				replacement: "\ttarget[key] = value",
				why: "setOwn assigns every key, so where Object.prototype.__proto__ exists a \"__proto__\" key is lost, or sets the copy's prototype; the record keys property fails in the consumer's process."
			}
		]
	})

/** A value nested through a recursive shape decode at any depth, the call stack no deeper for it: a fresh copy decoded. */
export const aValueNestedThroughARecursiveShapeDecodeAtAnyDepthTheCallStackNoDeeperForItAFreshCopyDecoded =
	property.explore(
		(source) =>
			[
				source.draw(
					weighted([
						[1, constant(0)],
						[6, containers]
					])
				),
				source.draw(formGen)
			] as const,
		{
			needs: {},
			situations: [
				"chain",
				"nested array",
				"no container",
				"within a small stack's recursion",
				"past a small stack's recursion"
			] satisfies ReadonlyArray<Reached<NestingFeature>>,
			check:
				(_, c: Case<NestingFeature>) =>
				([depth, form]) =>
					Effect.sync(() => {
						c.note(form)
						c.note(depthFeature(depth))
						const value = built(form, depth)
						const decoded = succeeded(S.decodeWith(formShape(form), value, "v"))
						assert.equal(depthOf(form, decoded), depth)
						assert.equal(
							decoded === value,
							depth === 0 && form === "nested array",
							"every container decodes to a fresh copy, and an integer to itself"
						)
					}),
			oracle: {
				kind: "specification",
				name: "the value's own construction: its form and its depth"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/ir/shape.ts",
					original: "\t\t\treturn yield* deferred(shape().parse(value, path))",
					replacement: "\t\t\treturn yield* shape().parse(value, path)",
					why: "ref reads its part on the call stack, not deferred to the driver; the depth and cycles property fails past a small stack."
				}
			]
		}
	)

/** A value nested through a recursive shape refuse a value that holds itself as a cycle where it meets itself, however long the cycle. */
export const aValueNestedThroughARecursiveShapeRefuseAValueThatHoldsItselfAsACycleWhereItMeetsItselfHoweverLongTheCycle =
	property.explore(
		(source) => {
			const length = source.draw(containers)
			return [
				length,
				source.draw(
					weighted([
						[1, constant(0)],
						[1, constant(length - 1)],
						[1, int(0, length - 1)]
					])
				),
				source.draw(formGen)
			] as const
		},
		{
			needs: {},
			situations: [
				"chain",
				"nested array",
				"within a small stack's recursion",
				"past a small stack's recursion",
				"a cycle back to its root",
				"a cycle back to its last container",
				"a cycle back to a container between"
			] satisfies ReadonlyArray<Reached<NestingFeature>>,
			check:
				(_, c: Case<NestingFeature>) =>
				([length, back, form]) =>
					Effect.sync(() => {
						c.note(form)
						c.note(depthFeature(length))
						c.note(
							back === 0
								? "a cycle back to its root"
								: back === length - 1
									? "a cycle back to its last container"
									: "a cycle back to a container between"
						)
						const reads = new CycleReads(length)
						const value = cyclic(form, length, back, reads)
						const refusal = refused(
							S.decodeWith(formShape(form), value, "v"),
							"MalformedDescription"
						)
						assert.equal(
							reads.made,
							reads.most,
							`a decode refusing a cycle of ${length} containers reads each link once and the one it meets again once more, ${reads.most} reads; this one made ${reads.made}, so it went round the cycle with no container on its path refused`
						)
						assert.deepEqual(
							refusalLoc(refusal).path,
							Arr.map(indices(length), () => stepOf(form))
						)
					}),
			oracle: {
				kind: "specification",
				name: "the cycle's own construction: the path from its root back to itself"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/ir/shape.ts",
					original: '\tif (path.onPath.has(value)) {\n\t\tabort(path, "an acyclic value")\n\t}\n',
					replacement: "",
					why: "A container on the path is not refused as a cycle, so the decode goes round one that holds itself; the depth and cycles property fails one read past the cycle."
				}
			]
		}
	)
