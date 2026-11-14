import { floorPopulation, type Situations } from "@bjornpagen/testing/features"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { floorSeed, rotatingSeed } from "@bjornpagen/testing/random"
import { sample, type Source } from "@bjornpagen/testing/source"
import { Array as Arr, Effect } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { type PreludeAt, preludeAt, preludeFrom, preludeProgram } from "#test/support/prelude.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * The assertion door's contract (test/support/assert.ts): assert.equal and assert.deepEqual take their expected value
 * at the actual value's type (NoInfer), so an expected value that drifted from that type is a compile error, never a
 * run-time mismatch. The oracle is conformance: a drawn type, the actual's, and a value drawn of it, with at most one
 * planted fault, the expected; the assertion typechecks exactly when the value conforms to the type.
 *
 * A type is a union of string literals, a number, a string, a boolean, a list of a type or a record of named types,
 * two levels deep at most; a value conforms to its type by construction, and a fault makes it not: a literal outside
 * its union, a value of another kind, a record's field left out or a field its type lacks, in the value itself or
 * inside a record or a list of it. Each assertion stands on one line, under a `refused` directive exactly where a fault
 * is planted: the contract is that the assertion does not compile, whichever diagnostic the checker elaborates it to.
 */
type Ty =
	| { readonly kind: "literal"; readonly members: Arr.NonEmptyReadonlyArray<string> }
	| { readonly kind: "number" | "string" | "boolean" }
	| { readonly kind: "list"; readonly of: Ty }
	| { readonly kind: "record"; readonly fields: Arr.NonEmptyReadonlyArray<readonly [string, Ty]> }

type Val =
	| { readonly kind: "text"; readonly value: string }
	| { readonly kind: "number"; readonly value: number }
	| { readonly kind: "boolean"; readonly value: boolean }
	| { readonly kind: "list"; readonly items: ReadonlyArray<Val> }
	| { readonly kind: "record"; readonly fields: ReadonlyArray<readonly [string, Val]> }

const faults = [
	"a literal outside its union",
	"a value of another kind",
	"a field left out",
	"a field its type lacks"
] as const
type Fault = (typeof faults)[number]

/** Where a planted fault stands: in the expected value itself, or inside a record or a list of it. */
type Depth = "top" | "inner"

export type DoorNote = "admitted" | `${Fault} ${Depth}` | "equal" | "deepEqual"

const literalWords = ["low", "mid", "high", "none"] as const
const fieldNames = ["id", "name", "loc", "rank"] as const

const coin = (source: Source, odds: number): boolean => source.draw(int(1, odds)) === 1

const tyGen =
	(depth: number): Gen<Ty> =>
	(source) => {
		const kind = source.draw(
			element(
				depth === 0
					? (["literal", "number", "string", "boolean"] as const)
					: (["literal", "number", "string", "boolean", "list", "record", "record"] as const)
			)
		)
		switch (kind) {
			case "literal": {
				const first = source.draw(element(literalWords))
				return {
					kind,
					members: [first, ...Arr.filter(literalWords, (w) => w !== first && coin(source, 2))]
				}
			}
			case "number":
			case "string":
			case "boolean":
				return { kind }
			case "list":
				return { kind, of: source.draw(tyGen(depth - 1)) }
			case "record":
				return source.draw(recordGen(depth))
		}
	}

/** A value of a type, by construction. */
const valueOf =
	(ty: Ty): Gen<Val> =>
	(source) => {
		switch (ty.kind) {
			case "literal":
				return { kind: "text", value: source.draw(element(ty.members)) }
			case "number":
				return { kind: "number", value: source.draw(int(0, 9)) }
			case "string":
				return { kind: "text", value: source.draw(element(["a", "b"] as const)) }
			case "boolean":
				return { kind: "boolean", value: coin(source, 2) }
			case "list":
				return {
					kind: "list",
					items: Arr.map(
						upTo(source.draw(int(1, 2)), (i) => i + 1),
						() => source.draw(valueOf(ty.of))
					)
				}
			case "record":
				return {
					kind: "record",
					fields: Arr.map(ty.fields, ([n, t]) => [n, source.draw(valueOf(t))] as const)
				}
		}
	}

/** A value of another kind than a type's: a number for text, text for a number or a boolean, a number for a list or a record. */
const otherKind = (ty: Ty): Val => {
	switch (ty.kind) {
		case "literal":
		case "string":
			return { kind: "number", value: 1 }
		case "number":
		case "boolean":
		case "list":
		case "record":
			return { kind: "text", value: "z" }
	}
}

/** A planted fault: the value with it, and where it stands. */
interface Planted {
	readonly value: Val
	readonly fault: Fault
	readonly depth: Depth
}

/** The places of a value a fault may stand at: the value itself, and every member of its records and lists. */
const plant = (
	ty: Ty,
	value: Val,
	fault: Fault,
	source: Source,
	top: boolean,
	wanted: Depth
): Planted | undefined => {
	const depth: Depth = top ? "top" : "inner"
	const here = (): Planted | undefined => {
		switch (fault) {
			case "a literal outside its union":
				return ty.kind === "literal"
					? { value: { kind: "text", value: "stray" }, fault, depth }
					: undefined
			case "a value of another kind":
				return { value: otherKind(ty), fault, depth }
			case "a field left out":
				return ty.kind === "record" && value.kind === "record"
					? (() => {
							const drop = source.draw(element(ty.fields))[0]
							return {
								value: { kind: "record", fields: Arr.filter(value.fields, ([n]) => n !== drop) },
								fault,
								depth
							}
						})()
					: undefined
			case "a field its type lacks":
				return value.kind === "record"
					? {
							value: {
								kind: "record",
								fields: [...value.fields, ["extra", { kind: "number", value: 1 }]]
							},
							fault,
							depth
						}
					: undefined
		}
	}
	const inner = (): Planted | undefined => {
		if (ty.kind === "record" && value.kind === "record") {
			const members = Arr.zip(ty.fields, value.fields)
			if (!Arr.isReadonlyArrayNonEmpty(members)) {
				return undefined
			}
			const [[name, fieldTy], [, fieldValue]] = source.draw(element(members))
			const planted = plant(fieldTy, fieldValue, fault, source, false, wanted)
			return planted === undefined
				? undefined
				: {
						...planted,
						value: {
							kind: "record",
							fields: Arr.map(
								value.fields,
								([n, v]) => [n, n === name ? planted.value : v] as const
							)
						}
					}
		}
		if (ty.kind === "list" && value.kind === "list") {
			const items = Arr.map(value.items, (item, at) => [item, at] as const)
			if (!Arr.isReadonlyArrayNonEmpty(items)) {
				return undefined
			}
			const [item, at] = source.draw(element(items))
			const planted = plant(ty.of, item, fault, source, false, wanted)
			return planted === undefined
				? undefined
				: {
						...planted,
						value: {
							kind: "list",
							items: Arr.map(value.items, (v, i) => (i === at ? planted.value : v))
						}
					}
		}
		return undefined
	}
	return top && wanted === "inner" ? (inner() ?? here()) : (here() ?? inner())
}

interface DoorCase {
	readonly ty: Ty
	readonly value: Val
	readonly assertion: "equal" | "deepEqual"
	readonly planted: Planted | undefined
}

/**
 * A type whose member, inside a list or a record, is a record where a fault needs one, so a fault aimed inside the
 * value finds its place.
 */
const containerGen =
	(fault: Fault): Gen<Ty> =>
	(source) => {
		const member =
			fault === "a field left out" || fault === "a field its type lacks"
				? source.draw(recordGen(1))
				: source.draw(tyGen(1))
		return coin(source, 2)
			? { kind: "list", of: member }
			: {
					kind: "record",
					fields: [
						["loc", member],
						...Arr.map(
							Arr.take(fieldNames, source.draw(int(0, 1))),
							(n) => [n, source.draw(tyGen(0))] as const
						)
					]
				}
	}

/** A record of drawn fields, each of a type `depth` levels deep at most. */
const recordGen =
	(depth: number): Gen<Ty> =>
	(source) => {
		const first = source.draw(element(fieldNames))
		const names: Arr.NonEmptyReadonlyArray<string> = [
			first,
			...Arr.filter(fieldNames, (n) => n !== first && coin(source, 3))
		]
		return {
			kind: "record",
			fields: Arr.map(names, (n) => [n, source.draw(tyGen(depth - 1))] as const)
		}
	}

/**
 * A case: its fault and the depth it is aimed at, drawn first; then a type, a container of a record where the fault
 * is aimed inside and needs one, and a value of it with the fault planted.
 */
const caseGen: Gen<DoorCase> = (source) => {
	const fault = coin(source, 4) ? undefined : source.draw(element(faults))
	const wanted = source.draw(element(["top", "inner"] as const))
	const ty =
		fault !== undefined && wanted === "inner"
			? source.draw(containerGen(fault))
			: source.draw(tyGen(2))
	const value = source.draw(valueOf(ty))
	const planted = fault === undefined ? undefined : plant(ty, value, fault, source, true, wanted)
	return {
		ty,
		value: planted === undefined ? value : planted.value,
		assertion: source.draw(element(["equal", "deepEqual"] as const)),
		planted
	}
}

const notesOf = (c: DoorCase): ReadonlyArray<DoorNote> => [
	c.assertion,
	c.planted === undefined ? "admitted" : `${c.planted.fault} ${c.planted.depth}`
]

/** The situations the floor's witnesses reach: an admitted case, both assertions, and every fault at both depths. */
export const doorRequired: Situations<DoorNote> = [
	"admitted",
	"equal",
	"deepEqual",
	...Arr.flatMap(faults, (f) => [`${f} top` as const, `${f} inner` as const])
]

/** The cases the run's own stream draws, beside the floor's witnesses. */
const doorCount = 120

const doorLabel = "types/harness door"

export const doorWitnesses = () => floorPopulation(doorLabel, caseGen, doorCount, notesOf)

const tySource = (ty: Ty): string => {
	switch (ty.kind) {
		case "literal":
			return `(${Arr.join(Arr.map(ty.members, jsonText), " | ")})`
		case "number":
		case "string":
		case "boolean":
			return ty.kind
		case "list":
			return `ReadonlyArray<${tySource(ty.of)}>`
		case "record":
			return `{ ${Arr.join(
				Arr.map(ty.fields, ([n, t]) => `readonly ${n}: ${tySource(t)}`),
				"; "
			)} }`
	}
}

const valSource = (v: Val): string => {
	switch (v.kind) {
		case "text":
			return jsonText(v.value)
		case "number":
		case "boolean":
			return String(v.value)
		case "list":
			return `[${Arr.join(Arr.map(v.items, valSource), ", ")}]`
		case "record":
			return `{ ${Arr.join(
				Arr.map(v.fields, ([n, x]) => `${n}: ${valSource(x)}`),
				", "
			)} }`
	}
}

const blockOf = (c: DoorCase, i: number): ReadonlyArray<string> => [
	`declare const a${i}: ${tySource(c.ty)}`,
	...(c.planted === undefined
		? []
		: [`// @ts-expect-error -- refused: ${c.planted.fault}, ${c.planted.depth}`]),
	`export const e${i} = (): void => assert.${c.assertion}(a${i}, ${valSource(c.value)})`
]

/** The door program's prelude (test/support/programs/door.ts), the repository's door it reads. */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/door.ts"))

/** The program's prelude as its directory reaches it, `entry` spelling a repository path from there. */
export const doorEntriesFrom = (entry: (path: string) => string): PreludeAt =>
	preludeFrom(prelude, entry)

/** The program over the run's cases: one module, its door the repository's. */
export const doorModule = (entries: PreludeAt, seed: number): string =>
	preludeProgram(
		"// Generated by test/types/harness/door.ts: the assertion door's contract.",
		entries,
		Arr.join(
			[
				...Arr.flatMap(
					[
						...doorWitnesses().values,
						...sample(caseGen, rotatingSeed(seed, floorSeed(doorLabel)), doorCount)
					],
					blockOf
				),
				""
			],
			"\n"
		)
	)
