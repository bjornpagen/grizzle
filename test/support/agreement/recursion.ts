import { floorPopulation, type Situations } from "@grizzle/testing/features"
import { constant, element, type Gen, int, proportional } from "@grizzle/testing/gen"
import { floorSeed, rotatingSeed } from "@grizzle/testing/random"
import { sample, type Source } from "@grizzle/testing/source"
import { Array as Arr, Effect, Record as Rec, String as Str } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { RecursionRefusal } from "#compiler/core/causes.ts"
import { headingsOf } from "#compiler/core/decoder.ts"
import type { CompileReason, CompileReasonTag } from "#compiler/core/errors.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import * as Result from "#compiler/core/result.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { queryOver, type QueryValue, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { pgDescriptors } from "#compiler/scalar/pg.ts"
import { uuidDescriptor } from "#compiler/scalar/uuid.ts"
import { groupFields, paramsType, recordType } from "#test/support/agreement/heading.ts"
import { Edge, Graph, Node } from "#test/support/agreement/recursion-schema.ts"
import { defined } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { messageOf } from "#test/support/message.ts"
import {
	identifiers,
	preludeAt,
	preludeImports,
	type PreludeAt,
	preludeFrom
} from "#test/support/prelude.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * The recursion agreement: recursive queries, query(Graph).recursive(name, { row, base, rec }), drawn over
 * ./recursion-schema.ts, each with the engine's verdict on it, and the one TypeScript program that states every verdict
 * as types, which the type tier checks (test/types/api/recursion.test.ts). The engine is the oracle: a drawn recursion
 * typechecks exactly when the engine builds and compiles it; a refusal the types name by a Refusal names the engine's
 * reason; and an admitted recursion's records are the engine's decoded heading, its parameters the engine's, every
 * arm's joined, its evidence proves nothing, and the get of its workload member's handle, as a Db of Reader serving it
 * holds it (WorkloadHandles), takes it exactly where the engine proves it at most one row per binding, which a fixed
 * point never is.
 *
 * A case's row is a pair of node ids, or the pair and the reached node's rank; its base arms read an edge, its recursive
 * arms extend self by one, each maybe filtered by a parameter, `start` for a base arm and `avoid` for a recursive one,
 * which every arm shares by name. A case plants at most one fault, in an arm list or the one arm of its base or
 * recursive list, so no other arm's heading differs from it: a head missing a row field, holding one the row lacks, or
 * delivering one of another type; self bound at a field its row lacks; no base arm or no recursive arm; and the two
 * declared classes (declaredClasses), recursions the types accept and the engine refuses, each for the one reason it
 * states, since the types count no reading of self: self read twice in one arm (RecursionRefused nonlinearFeedback),
 * and self negated (RecursionRefused selfNegation). A refusal stands under its directive at the line of its site.
 */
const recursionFaults = [
	"a head missing a row field",
	"a head with a field the row lacks",
	"a head field of another type",
	"self bound at a field the row lacks",
	"no base arm",
	"no recursive arm"
] as const
type RecursionFault = (typeof recursionFaults)[number]

const declaredClasses = ["self read twice", "self negated"] as const
type DeclaredClass = (typeof declaredClasses)[number]

type Planted = RecursionFault | DeclaredClass

const isDeclared = (planted: Planted): planted is DeclaredClass =>
	Arr.contains<Planted>(declaredClasses, planted)

/**
 * The engine's reason a refusal is, as the agreement compares it: its tag, a recursion refusal's kind, and a named
 * refusal's message (core/refusals.ts).
 */
const reasonKey = (reason: CompileReason): string =>
	reason._tag === "RecursionRefused"
		? `${reason._tag}:${reason.cause.kind}`
		: reason._tag === "Refused"
			? `${reason._tag}:${reason.refusal}`
			: reason._tag

/** A refusal the oracle predicts: the engine's tag, a recursion refusal's kind, or a named refusal's message. */
type Expected =
	| { readonly tag: Exclude<CompileReasonTag, "RecursionRefused" | "Refused"> }
	| { readonly tag: "RecursionRefused"; readonly cause: RecursionRefusal["kind"] }
	| { readonly tag: "Refused"; readonly refusal: Refused }

const expectedKey = (e: Expected): string =>
	e.tag === "RecursionRefused"
		? `${e.tag}:${e.cause}`
		: e.tag === "Refused"
			? `${e.tag}:${e.refusal}`
			: e.tag

/** Where a planted fault stands: an arm list's line, or the one arm of a list. */
type Site = "base list" | "rec list" | "base arm" | "rec arm"

/** Each fault's refusal: the engine's reason, and what the types claim at its site. */
const refusals: {
	readonly [F in RecursionFault]: {
		readonly engine: Expected
		readonly claim:
			| { readonly kind: "refusal"; readonly refusal: Refused }
			| { readonly kind: "prose"; readonly why: string }
	}
} = {
	"a head missing a row field": {
		engine: { tag: "RecursionRefused", cause: "armHead" },
		claim: {
			kind: "refusal",
			refusal:
				"an arm's head delivers the row: each of its fields, at a type that meets the field's"
		}
	},
	"a head with a field the row lacks": {
		engine: { tag: "RecursionRefused", cause: "armHead" },
		claim: {
			kind: "refusal",
			refusal:
				"an arm's head delivers the row: each of its fields, at a type that meets the field's"
		}
	},
	"a head field of another type": {
		engine: { tag: "RecursionRefused", cause: "inexactConversion" },
		claim: {
			kind: "refusal",
			refusal:
				"an arm's head delivers the row: each of its fields, at a type that meets the field's"
		}
	},
	"self bound at a field the row lacks": {
		engine: { tag: "Refused", refusal: "not a field of the arms the bindings select" },
		claim: { kind: "refusal", refusal: "not a field of the arms the bindings select" }
	},
	"no base arm": {
		engine: { tag: "MalformedDescription" },
		claim: {
			kind: "refusal",
			refusal: "a recursion has at least one base arm and at least one recursive arm"
		}
	},
	"no recursive arm": {
		engine: { tag: "MalformedDescription" },
		claim: {
			kind: "refusal",
			refusal: "a recursion has at least one base arm and at least one recursive arm"
		}
	}
}

/** Each declared class's refusal by the engine. */
const declared: { readonly [C in DeclaredClass]: Expected } = {
	"self read twice": { tag: "RecursionRefused", cause: "nonlinearFeedback" },
	"self negated": { tag: "RecursionRefused", cause: "selfNegation" }
}

/** Each planted fault's site. */
const siteOf: { readonly [P in Planted]: Site } = {
	"a head missing a row field": "base arm",
	"a head with a field the row lacks": "base arm",
	"a head field of another type": "base arm",
	"self bound at a field the row lacks": "rec arm",
	"no base arm": "base list",
	"no recursive arm": "rec list",
	"self read twice": "rec arm",
	"self negated": "rec arm"
}

/** A variable of an arm: its scope's name and the field. */
interface Ref {
	readonly scope: string
	readonly field: string
}

type Bindings = ReadonlyArray<readonly [string, Ref]>

type SourceName = "Edge" | "Node" | "self"

/** One arm as data, which both readings walk: its scopes, its matches, its filters and its head. */
interface Arm {
	readonly scopes: ReadonlyArray<readonly [string, SourceName]>
	readonly matches: ReadonlyArray<{ readonly source: SourceName; readonly bindings: Bindings }>
	readonly filters: ReadonlyArray<
		| { readonly kind: "param"; readonly op: "eq" | "ne"; readonly ref: Ref; readonly name: string }
		| { readonly kind: "notSelf"; readonly bindings: Bindings }
	>
	readonly head: Bindings
}

/** One case: its row, its arms, and the fault it plants. */
interface RecursionSpec {
	readonly ranked: boolean
	readonly base: ReadonlyArray<Arm>
	readonly rec: ReadonlyArray<Arm>
	readonly planted: Planted | undefined
}

/** What a case reached: its shapes, the fault it plants, and the verdict. */
export type RecursionNote =
	| "admitted"
	| "a ranked row"
	| "two base arms"
	| "two recursive arms"
	| "a start parameter"
	| "an avoid parameter"
	| Planted

const ref = (scope: string, field: string): Ref => ({ scope, field })

const coin = (source: Source, odds: number): boolean => source.draw(int(1, odds)) === 1

/** A base arm: an edge, maybe its target node's rank, maybe filtered by `start`, and its planted head fault. */
const baseArm = (source: Source, ranked: boolean, fault: Planted | undefined): Arm => {
	const typed = fault === "a head field of another type"
	const node = ranked || typed
	const field = typed ? source.draw(element(["rank", "kind"] as const)) : "rank"
	const head: Bindings = [
		["from", ref("edge", "from")],
		...(fault === "a head missing a row field"
			? []
			: [["to", typed ? ref("node", field) : ref("edge", "to")] as const]),
		...(ranked ? [["rank", ref("node", "rank")] as const] : []),
		...(fault === "a head with a field the row lacks"
			? [["extra", ref("edge", "to")] as const]
			: [])
	]
	return {
		scopes: [["edge", "Edge"], ...(node ? [["node", "Node"] as const] : [])],
		matches: [
			{
				source: "Edge",
				bindings: [
					["from", ref("edge", "from")],
					["to", ref("edge", "to")]
				]
			},
			...(node
				? [
						{
							source: "Node",
							bindings: [
								["id", ref("edge", "to")],
								...(ranked || (typed && field === "rank")
									? [["rank", ref("node", "rank")] as const]
									: []),
								...(typed && field === "kind" ? [["kind", ref("node", "kind")] as const] : [])
							]
						} as const
					]
				: [])
		],
		filters: coin(source, 2)
			? [{ kind: "param", op: "eq", ref: ref("edge", "from"), name: "start" }]
			: [],
		head
	}
}

/** A recursive arm: self extended by one edge, maybe its target's rank, maybe filtered by `avoid`, and its fault. */
const recArm = (source: Source, ranked: boolean, fault: Planted | undefined): Arm => {
	const twice = fault === "self read twice"
	const reached = twice ? ref("other", "to") : ref("edge", "to")
	const selfBindings: Bindings = [
		["from", ref("prior", "from")],
		[fault === "self bound at a field the row lacks" ? "via" : "to", ref("prior", "to")],
		...(ranked ? [["rank", ref("prior", "rank")] as const] : [])
	]
	const step = twice
		? {
				source: "self" as const,
				bindings: [
					["from", ref("prior", "to")],
					["to", ref("other", "to")],
					...(ranked ? [["rank", ref("other", "rank")] as const] : [])
				] as const
			}
		: {
				source: "Edge" as const,
				bindings: [
					["from", ref("prior", "to")],
					["to", ref("edge", "to")]
				] as const
			}
	return {
		scopes: [
			["prior", "self"],
			twice ? ["other", "self"] : ["edge", "Edge"],
			...(ranked ? [["node", "Node"] as const] : [])
		],
		matches: [
			{ source: "self", bindings: selfBindings },
			step,
			...(ranked
				? [
						{
							source: "Node",
							bindings: [
								["id", reached],
								["rank", ref("node", "rank")]
							]
						} as const
					]
				: [])
		],
		filters: [
			...(coin(source, 2)
				? [{ kind: "param", op: "ne", ref: reached, name: "avoid" } as const]
				: []),
			...(fault === "self negated"
				? [
						{
							kind: "notSelf",
							bindings: [
								["from", ref("prior", "from")],
								["to", reached],
								...(ranked ? [["rank", ref("node", "rank")] as const] : [])
							]
						} as const
					]
				: [])
		],
		head: [
			["from", ref("prior", "from")],
			["to", reached],
			...(ranked ? [["rank", ref("node", "rank")] as const] : [])
		]
	}
}

/** No plant three parts in the sum of the plants' count and three, and each plant one part. */
const plantedGen: Gen<Planted | undefined> = proportional<Planted | undefined>([
	[3, constant(undefined)],
	[
		recursionFaults.length + declaredClasses.length,
		element<Planted>([...recursionFaults, ...declaredClasses])
	]
])

const specGen: Gen<RecursionSpec> = (source) => {
	const ranked = coin(source, 2)
	const planted = source.draw(plantedGen)
	const site = planted === undefined ? undefined : siteOf[planted]
	const arms = (count: number, make: () => Arm): ReadonlyArray<Arm> =>
		Arr.map(
			upTo(count, (i) => i + 1),
			make
		)
	return {
		ranked,
		base:
			site === "base list"
				? []
				: site === "base arm"
					? [baseArm(source, ranked, planted)]
					: arms(source.draw(int(1, 2)), () => baseArm(source, ranked, undefined)),
		rec:
			site === "rec list"
				? []
				: site === "rec arm"
					? [recArm(source, ranked, planted)]
					: arms(source.draw(int(1, 2)), () => recArm(source, ranked, undefined)),
		planted
	}
}

/** A variable in the program. */
const refSource = (r: Ref): string => `${r.scope}.${r.field}`

const bindingsSource = (bindings: Bindings): string =>
	`{ ${Arr.join(
		Arr.map(bindings, ([field, r]) => `${field}: ${refSource(r)}`),
		", "
	)} }`

/** An arm's callback, in the program, on one line. */
const armSource = (arm: Arm, recursive: boolean): string => {
	const scopes = Arr.join(
		Arr.map(arm.scopes, ([name, s]) => `const ${name} = v(${s}, ${jsonText(name)}); `),
		""
	)
	const matches = Arr.join(
		Arr.map(arm.matches, (m) => `.match(${m.source}, ${bindingsSource(m.bindings)})`),
		""
	)
	const filters = Arr.join(
		Arr.map(arm.filters, (f) =>
			f.kind === "param"
				? `.where(r.${f.op}(${refSource(f.ref)}, r.param(${jsonText(f.name)}, uuid)))`
				: `.where(r.not(self, ${bindingsSource(f.bindings)}))`
		),
		""
	)
	return `${recursive ? "(r, self)" : "(r)"} => { ${scopes}return r${matches}${filters}.find(${bindingsSource(arm.head)}) },`
}

/** The row, in the program: a descriptor per field. */
const rowSource = (spec: RecursionSpec): string =>
	spec.ranked ? "{ from: uuid, to: uuid, rank: pg.integer }" : "{ from: uuid, to: uuid }"

/** A recursion's lines in the program, each with the site it is the line of. */
const linesOf = (
	spec: RecursionSpec,
	i: number
): ReadonlyArray<{ readonly text: string; readonly site: Site | undefined }> => {
	const list = (
		arms: ReadonlyArray<Arm>,
		name: "base" | "rec"
	): ReadonlyArray<{ readonly text: string; readonly site: Site | undefined }> =>
		Arr.isReadonlyArrayNonEmpty(arms)
			? [
					{ text: `\t${name}: [`, site: undefined },
					...Arr.map(
						arms,
						(arm, at): { readonly text: string; readonly site: Site | undefined } => ({
							text: `\t\t${armSource(arm, name === "rec")}`,
							site: at === 0 ? (name === "base" ? "base arm" : "rec arm") : undefined
						})
					),
					{ text: "\t],", site: undefined }
				]
			: [{ text: `\t${name}: [],`, site: name === "base" ? "base list" : "rec list" }]
	return [
		{ text: `export const q${i} = query(Graph).recursive("Reach", {`, site: undefined },
		{ text: `\trow: ${rowSource(spec)},`, site: undefined },
		...list(spec.base, "base"),
		...list(spec.rec, "rec"),
		{ text: "})", site: undefined }
	]
}

const relations = { Edge, Node } as const

/** An arm, built through the query builder's JavaScript view. */
const builtArm = (arm: Arm, r: RuleValue, self: unknown): unknown => {
	const vars = Rec.fromEntries(
		Arr.map(arm.scopes, ([name, s]) => [name, varsOver(s === "self" ? self : relations[s], name)])
	)
	const term = (x: Ref): unknown => defined(vars[x.scope], `the scope ${x.scope}`)[x.field]
	const bound = (bindings: Bindings) =>
		Rec.fromEntries(Arr.map(bindings, ([field, x]) => [field, term(x)]))
	const matched = Arr.reduce(arm.matches, r, (rule, m) =>
		rule.match(m.source === "self" ? self : relations[m.source], bound(m.bindings))
	)
	const filtered = Arr.reduce(arm.filters, matched, (rule, f) =>
		rule.where(
			f.kind === "param"
				? r[f.op](term(f.ref), r.param(f.name, uuidDescriptor))
				: r.not(self, bound(f.bindings))
		)
	)
	return filtered.find(bound(arm.head))
}

/** The row as the builder is given it. */
const rowValue = (spec: RecursionSpec): Readonly<Record<string, unknown>> => ({
	from: uuidDescriptor,
	to: uuidDescriptor,
	...(spec.ranked ? { rank: pgDescriptors.integer } : {})
})

const builtRecursion = (spec: RecursionSpec): QueryValue =>
	queryOver(Graph).recursive("Reach", {
		row: rowValue(spec),
		base: Arr.map(spec.base, (arm) => (r: RuleValue) => builtArm(arm, r, undefined)),
		rec: Arr.map(spec.rec, (arm) => (r: RuleValue, self: unknown) => builtArm(arm, r, self))
	})

/** What the engine proves of a recursion it compiles: its records and its parameters. */
interface Proved {
	readonly head: string
	readonly params: string
}

type Verdict =
	| { readonly kind: "admitted"; readonly proved: Proved }
	| { readonly kind: "refused"; readonly key: string; readonly message: string }

const verdictOf = (spec: RecursionSpec): Verdict => {
	const built = catchCompileError(() => builtRecursion(spec))
	const template = Result.flatMap(built, (q) => compileTemplate(q, undefined, testCompile))
	if (!template.ok || !built.ok) {
		const error = template.ok ? undefined : template.error
		if (error === undefined) {
			throw new Error("a compiled recursion was built")
		}
		return { kind: "refused", key: reasonKey(error.reason), message: messageOf(error) }
	}
	const q = built.value
	return {
		kind: "admitted",
		proved: {
			head: recordType(
				groupFields(
					defined(headingsOf(q.rows)[0], "a recursion's one heading group"),
					q.heading,
					template.value.heading
				)
			),
			params: paramsType(template.value.params)
		}
	}
}

interface RecursionCase {
	readonly spec: RecursionSpec
	readonly verdict: Verdict
	readonly notes: ReadonlySet<RecursionNote>
}

const caseGen: Gen<RecursionCase> = (source) => {
	const spec = specGen(source)
	const verdict = verdictOf(spec)
	const planted = spec.planted
	const expected =
		planted === undefined
			? undefined
			: expectedKey(isDeclared(planted) ? declared[planted] : refusals[planted].engine)
	if (verdict.kind === "refused" ? verdict.key !== expected : expected !== undefined) {
		throw new Error(
			`the engine's verdict is not the one its fault (${planted ?? "none"}) predicts, ${expected ?? "admitted"}: ${verdict.kind === "refused" ? verdict.message : "admitted"}\n${Arr.join(
				Arr.map(linesOf(spec, 0), (l) => l.text),
				"\n"
			)}`
		)
	}
	const notes = new Set<RecursionNote>()
	if (planted === undefined) {
		notes.add("admitted")
	} else {
		notes.add(planted)
	}
	if (spec.ranked) {
		notes.add("a ranked row")
	}
	if (spec.base.length > 1) {
		notes.add("two base arms")
	}
	if (spec.rec.length > 1) {
		notes.add("two recursive arms")
	}
	const params = Arr.flatMap([...spec.base, ...spec.rec], (arm) =>
		Arr.flatMap(arm.filters, (f) => (f.kind === "param" ? [f.name] : []))
	)
	if (Arr.contains(params, "start")) {
		notes.add("a start parameter")
	}
	if (Arr.contains(params, "avoid")) {
		notes.add("an avoid parameter")
	}
	return { spec, verdict, notes }
}

/** A line's leading tabs, which its directive stands at. */
const indentOf = (line: string): string =>
	Str.slice(0, line.length - Str.trimStart(line).length)(line)

/** One case's statements: the recursion, under its fault's directive at its site, or its verdict asserted. */
const blockOf = (c: RecursionCase, i: number): ReadonlyArray<string> => {
	const lines = linesOf(c.spec, i)
	const planted = c.spec.planted
	if (c.verdict.kind === "refused") {
		if (planted === undefined || isDeclared(planted)) {
			return [
				`/** Declared: the types count no reading of self; the engine refuses it, ${c.verdict.key}. */`,
				...Arr.map(lines, (l) => l.text),
				""
			]
		}
		const refusing = refusals[planted]
		const directive =
			refusing.claim.kind === "refusal"
				? `// @ts-expect-error -- refusal: ${refusing.claim.refusal}`
				: `// @ts-expect-error -- refused: ${refusing.claim.why}`
		return [
			`/** The engine refuses it, ${c.verdict.key}. */`,
			...Arr.flatMap(lines, (l) =>
				l.site === siteOf[planted] ? [`${indentOf(l.text)}${directive}`, l.text] : [l.text]
			),
			""
		]
	}
	const { head, params } = c.verdict.proved
	return [
		...Arr.map(lines, (l) => l.text),
		`export type h${i} = Expect<Equals<HeadOf<typeof q${i}>, ${head}>>`,
		params === "unknown"
			? `export type p${i} = Expect<Equals<keyof ParamsOf<typeof q${i}>, never>>`
			: `export type p${i} = Expect<Equals<ParamsOf<typeof q${i}>, ${params}>>`,
		`export type e${i} = Expect<Equals<EvidenceOfQuery<typeof q${i}>, Evidence.Unknown>>`,
		`export const g${i} = (h: WorkloadHandles<typeof Reader, { readonly m: typeof q${i} }>["m"]) => (input: InputOf<typeof q${i}>) =>`,
		`\th.once(input)`,
		""
	]
}

/** The situations the floor's witnesses reach: every fault, both declared classes, and every admitted shape. */
export const recursionRequired: Situations<RecursionNote> = [
	"admitted",
	"a ranked row",
	"two base arms",
	"two recursive arms",
	"a start parameter",
	"an avoid parameter",
	...recursionFaults,
	...declaredClasses
]

/** The recursions the run's own stream draws, beside the floor's witnesses. */
const recursionCount = 80

const recursionLabel = "types/api recursion agreement"

export const recursionWitnesses = () =>
	floorPopulation(recursionLabel, caseGen, recursionCount, (c) => [...c.notes])

const recursionCases = (seed: number): ReadonlyArray<RecursionCase> => [
	...recursionWitnesses().values,
	...sample(caseGen, rotatingSeed(seed, floorSeed(recursionLabel)), recursionCount)
]

/** The recursion program's prelude (test/support/programs/recursion.ts), every name it reads. */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/recursion.ts"))

export const recursionEntriesFrom = (entry: (path: string) => string): PreludeAt =>
	preludeFrom(prelude, entry)

/** The program over the run's cases: one module, its imports the names its blocks read. */
export const recursionModule = (entries: PreludeAt, seed: number): string => {
	const body = Arr.join(Arr.flatMap(recursionCases(seed), blockOf), "\n")
	const read = identifiers(body)
	return Arr.join(
		[
			"// Generated by test/support/agreement/recursion.ts: the recursion type/engine agreement.",
			...preludeImports(entries, read),
			"",
			...(read.has("Expect")
				? [
						"type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
						"type Expect<T extends true> = T",
						""
					]
				: []),
			body,
			""
		],
		"\n"
	)
}
