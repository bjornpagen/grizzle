/**
 * What document-set.test.ts's properties read: document sets built from drawn chains, schema cycles, `$id`
 * declarations, implicit connections and `$self` collisions, each with what the specification says its resolution is.
 */

import { word } from "@bjornpagen/testing/dictionary"
import {
	type Aimed,
	aimed,
	boolean,
	constant,
	element,
	finite,
	type FiniteSpace,
	type Gen,
	int,
	map,
	oneOf,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Order, Record } from "effect"
import { type DocumentUri, fixedDocumentUri } from "#model/brands.ts"
import type { Json } from "#model/pointer.ts"
import type { SpecLine } from "#model/spec-section.ts"
import { type CanonicalKey, keyOf } from "#resolve/canonical.ts"
import {
	implicitComponent,
	type Resolution,
	type ResolveMember,
	referenceAt,
	resolve
} from "#resolve/index.ts"
import { specLines } from "#test/model/spec-section.dictionary.ts"
import {
	type CollisionFeature,
	collisionFeatures,
	type Declaration,
	declarations,
	type Home,
	homes,
	idLines
} from "#test/resolve/document-set.dictionary.ts"

/** The entry document's retrieval URI. */
const ENTRY: DocumentUri = fixedDocumentUri("file:///spec/openapi.json")

/** The `$self` a 3.2 entry may declare, which moves its base off its retrieval URI. */
const SELF = "https://api.example.com/v1/openapi.json"

/** The directory each home names, as a reference relative to it resolves. */
const DIRECTORY: Readonly<Record<Home, string>> = {
	retrieval: "file:///spec/",
	self: "https://api.example.com/v1/"
}

/** The file names members take, in set order. */
const NAMES: Arr.NonEmptyReadonlyArray<string> = ["m0.json", "m1.json", "m2.json"]

/** The retrieval URIs of the members, in set order, under each home. */
const MEMBERS: Readonly<Record<Home, Arr.NonEmptyReadonlyArray<DocumentUri>>> = {
	retrieval: [
		fixedDocumentUri("file:///spec/m0.json"),
		fixedDocumentUri("file:///spec/m1.json"),
		fixedDocumentUri("file:///spec/m2.json")
	],
	self: [
		fixedDocumentUri("https://api.example.com/v1/m0.json"),
		fixedDocumentUri("https://api.example.com/v1/m1.json"),
		fixedDocumentUri("https://api.example.com/v1/m2.json")
	]
}

const LINES: Arr.NonEmptyReadonlyArray<SpecLine> = ["3.0", "3.1", "3.2"]

const VERSION: Readonly<Record<SpecLine, string>> = {
	"3.0": "3.0.3",
	"3.1": "3.1.1",
	"3.2": "3.2.0"
}

/** An OpenAPI document of a line with no paths, and `members` beside its required fields. */
const openapiOf = (line: SpecLine, members: Readonly<Record<string, Json>>): Json => ({
	info: { title: "t", version: "1" },
	openapi: VERSION[line],
	paths: {},
	...members
})

/** The use site every chain starts from: the one parameter of the entry's one operation. */
const SITE = "/paths/~1a/get/parameters/0"

/** The paths of an entry whose one operation's one parameter is a Reference Object to `ref`. */
const usingParameter = (ref: string): Readonly<Record<string, Json>> => ({
	paths: {
		"/a": { get: { parameters: [{ $ref: ref }], responses: { "200": { description: "ok" } } } }
	}
})

/** The parameter every chain that resolves ends at. */
const PARAMETER: Json = { in: "query", name: "p" }

/**
 * How a reference names its target: by a file name its holder's base resolves (`relative`), by the target's whole
 * retrieval URI (`absolute`), or by a fragment alone, within its holder (`local`).
 */
export type Spelling = "relative" | "absolute" | "local"

/** One hop of a chain: the member whose `/P<index>` it reaches, and how the reference before it names it. */
export type Hop = Readonly<{ member: number; spelling: Spelling }>

/**
 * What the last node of a chain holds: the parameter it resolves to (the entry's own when the chain has no hop), a
 * reference to a pointer a member lacks, a reference outside the set, or a reference back to a hop of the chain.
 */
export type End =
	| Readonly<{ kind: "parameter" }>
	| Readonly<{ kind: "missing"; member: number; spelling: Spelling }>
	| Readonly<{ kind: "outside"; spelling: "relative" | "absolute" }>
	| Readonly<{ kind: "cycle"; back: number; spelling: Spelling }>

/**
 * A chain of non-schema references from the entry's parameter use site across a set of `members` members: the line,
 * whether a 3.2 entry declares `$self`, where the members live, the hops, and the end.
 */
export type Chain = Readonly<{
	line: SpecLine
	self: boolean
	home: Home
	members: number
	hops: ReadonlyArray<Hop>
	end: End
}>

/** Who holds a reference: the entry, or a member by its place in the set. */
type Holder = Readonly<{ kind: "entry" }> | Readonly<{ kind: "member"; member: number }>

const ENTRY_HOLDER: Holder = { kind: "entry" }

/** The spellings a reference from `holder` to `member` may take: a fragment alone only within one member. */
const spellingsFrom = (holder: Holder, member: number): Arr.NonEmptyReadonlyArray<Spelling> =>
	holder.kind === "member" && holder.member === member
		? ["local", "relative", "absolute"]
		: ["relative", "absolute"]

/** The member a hop or an end reaches, drawn among the set's, and the spelling its holder names it by. */
const reach =
	(members: number, holder: Holder): Gen<Hop> =>
	(s) => {
		const member = s.draw(int(0, members - 1))
		return { member, spelling: s.draw(element(spellingsFrom(holder, member))) }
	}

/** Hops of a chain across `members` members, each reached from the hop before it: few, or past two hundred. */
const hopsAcross =
	(members: number): Gen<ReadonlyArray<Hop>> =>
	(s) => {
		const count = s.draw(
			weighted([
				[5, int(0, 5)],
				[1, int(200, 260)]
			])
		)
		const hops: Array<Hop> = []
		for (let index = 0; index < count; index += 1) {
			hops.push(s.draw(reach(members, holderAfter(hops))))
		}
		return hops
	}

/** The holder of the reference after `hops`: the last hop's member, or the entry when there is none. */
const holderAfter = (hops: ReadonlyArray<Hop>): Holder =>
	Option.match(Arr.last(hops), {
		onNone: () => ENTRY_HOLDER,
		onSome: (last): Holder => ({ kind: "member", member: last.member })
	})

const outsideEnd: Gen<End> = map(
	element<"relative" | "absolute">(["relative", "absolute"]),
	(spelling): End => ({ kind: "outside", spelling })
)

/** The end of a chain of `hops` across `members` members: what the set admits drawing. */
const endOf =
	(members: number, hops: ReadonlyArray<Hop>): Gen<End> =>
	(s) => {
		const holder = holderAfter(hops)
		const ends: Arr.NonEmptyArray<Gen<End>> = [constant<End>({ kind: "parameter" }), outsideEnd]
		if (members > 0) {
			ends.push(map(reach(members, holder), (to): End => ({ kind: "missing", ...to })))
		}
		if (Arr.isReadonlyArrayNonEmpty(hops)) {
			ends.push((t): End => {
				const back = t.draw(int(0, hops.length - 1))
				const target = Arr.getUnsafe(hops, back).member
				return { kind: "cycle", back, spelling: t.draw(element(spellingsFrom(holder, target))) }
			})
		}
		return s.draw(oneOf(ends))
	}

const chains: Gen<Chain> = (s) => {
	const line = s.draw(element(LINES))
	const members = s.draw(int(0, NAMES.length))
	const hops = members === 0 ? [] : s.draw(hopsAcross(members))
	return {
		line,
		self: line === "3.2" && s.draw(element([false, true])),
		home: s.draw(element<Home>(["retrieval", "self"])),
		members,
		hops,
		end: s.draw(endOf(members, hops))
	}
}

/** The key a hop reaches: its member's `/P<index>`. */
const hopKey = (chain: Chain, index: number): CanonicalKey => ({
	document: Arr.getUnsafe(MEMBERS[chain.home], Arr.getUnsafe(chain.hops, index).member),
	pointer: `/P${String(index)}`
})

/** The text of a reference from `holder` to `member`'s `pointer`, spelled as drawn. */
const refText = (chain: Chain, member: number, pointer: string, spelling: Spelling): string => {
	switch (spelling) {
		case "local":
			return `#${pointer}`
		case "relative":
			return `${Arr.getUnsafe(NAMES, member)}#${pointer}`
		case "absolute":
			return `${Arr.getUnsafe(MEMBERS[chain.home], member)}#${pointer}`
	}
}

const OUTSIDE: Readonly<Record<"relative" | "absolute", string>> = {
	relative: "outside.json#/P",
	absolute: "https://elsewhere.example.com/outside.json#/P"
}

/** The pointer a missing end names, which no member holds. */
const ABSENT = "/Absent"

/** The reference the chain's last node holds, or the parameter it is. */
const endNode = (chain: Chain): Json => {
	switch (chain.end.kind) {
		case "parameter":
			return PARAMETER
		case "missing":
			return { $ref: refText(chain, chain.end.member, ABSENT, chain.end.spelling) }
		case "outside":
			return { $ref: OUTSIDE[chain.end.spelling] }
		case "cycle":
			return {
				$ref: refText(
					chain,
					Arr.getUnsafe(chain.hops, chain.end.back).member,
					`/P${String(chain.end.back)}`,
					chain.end.spelling
				)
			}
	}
}

/** The node at hop `index`: a reference to the next hop, or the chain's end at the last. */
const hopNode = (chain: Chain, index: number): Json =>
	index === chain.hops.length - 1
		? endNode(chain)
		: {
				$ref: refText(
					chain,
					Arr.getUnsafe(chain.hops, index + 1).member,
					`/P${String(index + 1)}`,
					Arr.getUnsafe(chain.hops, index + 1).spelling
				)
			}

/** The reference at the entry's use site: to the first hop, or the end itself when the chain has none. */
const siteRef = (chain: Chain): string =>
	Option.match(Arr.head(chain.hops), {
		onSome: (first) => refText(chain, first.member, "/P0", first.spelling),
		onNone: () => {
			switch (chain.end.kind) {
				case "parameter":
					return "#/components/parameters/P"
				case "missing":
					return refText(chain, chain.end.member, ABSENT, chain.end.spelling)
				case "outside":
					return OUTSIDE[chain.end.spelling]
				case "cycle":
					return "#/components/parameters/P"
			}
		}
	})

/** The entry document a chain starts in. */
const entryOf = (chain: Chain): Json =>
	openapiOf(chain.line, {
		...(chain.self ? { $self: SELF } : {}),
		...usingParameter(siteRef(chain)),
		...(Arr.isReadonlyArrayNonEmpty(chain.hops)
			? {}
			: { components: { parameters: { P: PARAMETER } } })
	})

/** The members of a chain's set, each holding the hops that land in it, as fragments. */
const membersOf = (chain: Chain): ReadonlyArray<ResolveMember> =>
	Array.from({ length: chain.members }, (_, member) => ({
		document: Arr.getUnsafe(MEMBERS[chain.home], member),
		value: Record.fromEntries(
			Arr.flatMap(chain.hops, (hop, index) =>
				hop.member === member ? [[`P${String(index)}`, hopNode(chain, index)] as const] : []
			)
		)
	}))

/** A refusal as a resolution's failure states it: its code, scope, place, and the place it relates. */
export type Refused = Readonly<{
	code: string
	scope: string
	at: CanonicalKey
	related: ReadonlyArray<CanonicalKey>
}>

/** A chain's resolution: the use site's target and the Reference Objects between, with the set's documents; or a refusal. */
export type ChainOutcome =
	| Readonly<{
			kind: "resolved"
			target: Option.Option<CanonicalKey>
			via: ReadonlyArray<CanonicalKey>
			documents: ReadonlyArray<DocumentUri>
	  }>
	| Readonly<{ kind: "refused"; refused: Refused }>

/** The refusal a failed resolution carries, as its diagnostic states it. */
const refusedOf = (
	error: Readonly<{ diagnostic: Resolution["diagnostics"][number] }>
): Refused => ({
	code: error.diagnostic.code,
	scope: error.diagnostic.scope,
	at: { document: error.diagnostic.document, pointer: error.diagnostic.pointer },
	related: Arr.map(error.diagnostic.related ?? [], (key) => ({
		document: key.document,
		pointer: key.pointer
	}))
})

/** Resolves a chain's set from its entry. */
export const chainResolved = (chain: Chain) =>
	resolve({
		document: ENTRY,
		line: chain.line,
		members: membersOf(chain),
		value: entryOf(chain)
	}).pipe(
		Effect.map((resolution): ChainOutcome => ({
			kind: "resolved",
			target: Option.map(
				Option.fromNullishOr(referenceAt(resolution, SITE)),
				(found) => found.target
			),
			via: Option.match(Option.fromNullishOr(referenceAt(resolution, SITE)), {
				onNone: () => [],
				onSome: (found) => found.via
			}),
			documents: Arr.sort(Arr.fromIterable(resolution.documents.keys()), Order.String)
		})),
		Effect.catchTag("ResolveRefusal", (error) =>
			Effect.succeed<ChainOutcome>({ kind: "refused", refused: refusedOf(error) })
		)
	)

/** The directory a holder's relative references resolve against: a member's home, or the entry's base. */
const directoryOf = (chain: Chain, holder: Holder): string =>
	holder.kind === "member"
		? DIRECTORY[chain.home]
		: chain.self
			? DIRECTORY.self
			: DIRECTORY.retrieval

/** Whether a reference from `holder` spelled as drawn names a member of the set: a relative one only from its home. */
const inSet = (chain: Chain, holder: Holder, spelling: Spelling): boolean =>
	spelling !== "relative" || directoryOf(chain, holder) === DIRECTORY[chain.home]

/** The use site every chain's refusal is stated at. */
const SITE_KEY: CanonicalKey = { document: ENTRY, pointer: SITE }

const refusal = (code: string, related: ReadonlyArray<CanonicalKey>): ChainOutcome => ({
	kind: "refused",
	refused: { code, scope: "document", at: SITE_KEY, related }
})

/**
 * What design 3.3 says a chain resolves to. Each reference resolves against the base of the document that holds it:
 * a member's retrieval URI, and the entry's `$self` on 3.2 when it declares one; a relative reference that lands
 * outside the set is REF-15, an absolute URI outside it REF-16, both stated at the use site; a pointer a member lacks
 * is REF-18 relating it; a reference back to a hop already on the chain is DOC-23 relating that hop; and a chain of any
 * length that ends at a parameter resolves to it with every Reference Object between as `via`, the set's documents
 * the entry and every member.
 */
export const expectedChain = (chain: Chain): ChainOutcome => {
	const firstOutside = Arr.findFirstIndex(
		chain.hops,
		(hop, index) =>
			!inSet(
				chain,
				index === 0
					? ENTRY_HOLDER
					: { kind: "member", member: Arr.getUnsafe(chain.hops, index - 1).member },
				hop.spelling
			)
	)
	if (Option.isSome(firstOutside)) {
		return refusal("REF-15/outside-set", [])
	}
	const holder = holderAfter(chain.hops)
	switch (chain.end.kind) {
		case "outside":
			return refusal(
				chain.end.spelling === "relative" ? "REF-15/outside-set" : "REF-16/outside-set",
				[]
			)
		case "missing":
			return inSet(chain, holder, chain.end.spelling)
				? refusal("REF-18/unresolvable", [
						{ document: Arr.getUnsafe(MEMBERS[chain.home], chain.end.member), pointer: ABSENT }
					])
				: refusal("REF-15/outside-set", [])
		case "cycle":
			return inSet(chain, holder, chain.end.spelling)
				? refusal("DOC-23/non-schema-cycle", [hopKey(chain, chain.end.back)])
				: refusal("REF-15/outside-set", [])
		case "parameter":
			return {
				kind: "resolved",
				target: Option.some(
					Arr.isReadonlyArrayNonEmpty(chain.hops)
						? hopKey(chain, chain.hops.length - 1)
						: { document: ENTRY, pointer: "/components/parameters/P" }
				),
				via: Arr.map(Arr.take(chain.hops, Math.max(chain.hops.length - 1, 0)), (_, index) =>
					hopKey(chain, index)
				),
				documents: Arr.sort([ENTRY, ...Arr.take(MEMBERS[chain.home], chain.members)], Order.String)
			}
	}
}

export type ChainFeature =
	| "a set of one"
	| "a chain across two members"
	| "a chain past two hundred hops"
	| "a local hop inside a member"
	| "a relative hop inside a member away from the entry"
	| "the entry's $self as its base"
	| "a relative reference only the retrieval URI places in the set"
	| "a missing target in a member"
	| "a relative file outside the set"
	| "an absolute URI outside the set"
	| "a cycle across documents"

/** The situations a chain reaches. */
export const chainFeatures = (chain: Chain): ReadonlyArray<ChainFeature> => {
	const outcome = expectedChain(chain)
	const resolved = outcome.kind === "resolved"
	const code = outcome.kind === "refused" ? outcome.refused.code : "resolved"
	const first = Arr.head(chain.hops)
	const away = DIRECTORY[chain.home] !== directoryOf(chain, ENTRY_HOLDER)
	const distinct = Arr.dedupe(Arr.map(chain.hops, (hop) => hop.member))
	const when = (holds: boolean, feature: ChainFeature): ReadonlyArray<ChainFeature> =>
		holds ? [feature] : []
	return [
		...when(chain.members === 0 && resolved, "a set of one"),
		...when(resolved && distinct.length >= 2, "a chain across two members"),
		...when(resolved && chain.hops.length > 200, "a chain past two hundred hops"),
		...when(
			resolved && Arr.some(Arr.drop(chain.hops, 1), (hop) => hop.spelling === "local"),
			"a local hop inside a member"
		),
		...when(
			resolved && away && Arr.some(Arr.drop(chain.hops, 1), (hop) => hop.spelling === "relative"),
			"a relative hop inside a member away from the entry"
		),
		...when(
			resolved &&
				chain.self &&
				chain.home === "self" &&
				Option.exists(first, (hop) => hop.spelling === "relative"),
			"the entry's $self as its base"
		),
		...when(
			chain.self &&
				chain.home === "retrieval" &&
				Option.exists(first, (hop) => hop.spelling === "relative"),
			"a relative reference only the retrieval URI places in the set"
		),
		...when(code === "REF-18/unresolvable", "a missing target in a member"),
		...when(
			chain.end.kind === "outside" &&
				chain.end.spelling === "relative" &&
				code === "REF-15/outside-set",
			"a relative file outside the set"
		),
		...when(code === "REF-16/outside-set", "an absolute URI outside the set"),
		...when(code === "DOC-23/non-schema-cycle" && distinct.length >= 2, "a cycle across documents")
	]
}

/** `count` hops spelled by their whole URIs, alternating over the set's first two members, or within one when it has one. */
const alternating = (members: number, count: number): ReadonlyArray<Hop> =>
	Array.from({ length: count }, (_, index) => ({
		member: members > 1 ? index % 2 : 0,
		spelling: "absolute"
	}))

/** Chains, aimed at each pending situation by one built to reach it. */
export const aimedChains: Aimed<Chain, ChainFeature> = aimed(chains, [
	[
		"a set of one",
		(s): Chain => ({
			line: s.draw(element(LINES)),
			self: false,
			home: "retrieval",
			members: 0,
			hops: [],
			end: { kind: "parameter" }
		})
	],
	[
		"a chain across two members",
		(s): Chain => {
			const members = s.draw(int(2, NAMES.length))
			return {
				line: s.draw(element(LINES)),
				self: false,
				home: s.draw(element<Home>(["retrieval", "self"])),
				members,
				hops: alternating(members, s.draw(int(2, 6))),
				end: { kind: "parameter" }
			}
		}
	],
	[
		"a chain past two hundred hops",
		(s): Chain => ({
			line: s.draw(element(LINES)),
			self: false,
			home: "retrieval",
			members: 2,
			hops: alternating(2, s.draw(int(201, 260))),
			end: { kind: "parameter" }
		})
	],
	[
		"a local hop inside a member",
		(s): Chain => {
			const members = s.draw(int(1, NAMES.length))
			const member = s.draw(int(0, members - 1))
			return {
				line: s.draw(element(LINES)),
				self: false,
				home: "retrieval",
				members,
				hops: [
					{ member, spelling: "absolute" },
					{ member, spelling: "local" }
				],
				end: { kind: "parameter" }
			}
		}
	],
	[
		"a relative hop inside a member away from the entry",
		(s): Chain => {
			const members = s.draw(int(2, NAMES.length))
			return {
				line: s.draw(element(LINES)),
				self: false,
				home: "self",
				members,
				hops: [
					{ member: 0, spelling: "absolute" },
					{ member: 1, spelling: "relative" }
				],
				end: { kind: "parameter" }
			}
		}
	],
	[
		"the entry's $self as its base",
		(s): Chain => {
			const members = s.draw(int(1, NAMES.length))
			return {
				line: "3.2",
				self: true,
				home: "self",
				members,
				hops: [{ member: s.draw(int(0, members - 1)), spelling: "relative" }],
				end: { kind: "parameter" }
			}
		}
	],
	[
		"a relative reference only the retrieval URI places in the set",
		(s): Chain => {
			const members = s.draw(int(1, NAMES.length))
			return {
				line: "3.2",
				self: true,
				home: "retrieval",
				members,
				hops: [{ member: s.draw(int(0, members - 1)), spelling: "relative" }],
				end: { kind: "parameter" }
			}
		}
	],
	[
		"a missing target in a member",
		(s): Chain => {
			const members = s.draw(int(1, NAMES.length))
			return {
				line: s.draw(element(LINES)),
				self: false,
				home: "retrieval",
				members,
				hops: alternating(members, s.draw(int(0, 3))),
				end: { kind: "missing", member: s.draw(int(0, members - 1)), spelling: "absolute" }
			}
		}
	],
	[
		"a relative file outside the set",
		(s): Chain => {
			const members = s.draw(int(0, NAMES.length))
			return {
				line: s.draw(element(LINES)),
				self: false,
				home: "retrieval",
				members,
				hops: members === 0 ? [] : alternating(members, s.draw(int(0, 3))),
				end: { kind: "outside", spelling: "relative" }
			}
		}
	],
	[
		"an absolute URI outside the set",
		(s): Chain => {
			const members = s.draw(int(0, NAMES.length))
			return {
				line: s.draw(element(LINES)),
				self: false,
				home: "retrieval",
				members,
				hops: members === 0 ? [] : alternating(members, s.draw(int(0, 3))),
				end: { kind: "outside", spelling: "absolute" }
			}
		}
	],
	[
		"a cycle across documents",
		(s): Chain => {
			const members = s.draw(int(2, NAMES.length))
			return {
				line: s.draw(element(LINES)),
				self: false,
				home: "retrieval",
				members,
				hops: alternating(members, s.draw(int(2, 6))),
				end: { kind: "cycle", back: 0, spelling: "absolute" }
			}
		}
	]
])

/** A schema cycle across the set's first two members: each `/S<i>` of one holds `allOf` of two references to the other's next level. */
export type SchemaCycle = Readonly<{ line: SpecLine; home: Home; levels: number }>

const schemaCycles: Gen<SchemaCycle> = (s) => ({
	line: s.draw(element(LINES)),
	home: s.draw(element<Home>(["retrieval", "self"])),
	levels: s.draw(
		weighted([
			[4, int(1, 40)],
			[1, int(1000, 2500)]
		])
	)
})

/** The two members of a schema cycle, in set order. */
const cycleMembers = (cycle: SchemaCycle): readonly [DocumentUri, DocumentUri] => [
	Arr.getUnsafe(MEMBERS[cycle.home], 0),
	Arr.getUnsafe(MEMBERS[cycle.home], 1)
]

/** A member of a schema cycle: every level, each an `allOf` of two references to the other member's next level. */
const cycleMember = (cycle: SchemaCycle, other: DocumentUri): Json =>
	Record.fromEntries(
		Array.from({ length: cycle.levels }, (_, level) => {
			const next: Json = { $ref: `${other}#/S${String((level + 1) % cycle.levels)}` }
			return [`S${String(level)}`, { allOf: [next, next] }] as const
		})
	)

/** Resolves a schema cycle's set from an entry whose one schema references the first member's `/S0`; its `$defs` keys. */
export const cycleResolved = (cycle: SchemaCycle) => {
	const [first, second] = cycleMembers(cycle)
	return resolve({
		document: ENTRY,
		line: cycle.line,
		members: [
			{ document: first, value: cycleMember(cycle, second) },
			{ document: second, value: cycleMember(cycle, first) }
		],
		value: openapiOf(cycle.line, { components: { schemas: { Root: { $ref: `${first}#/S0` } } } })
	}).pipe(
		Effect.map((resolution): CycleOutcome => ({
			kind: "resolved",
			defs: Arr.sort(Arr.fromIterable(resolution.defs.keys()), Order.String),
			lifted: Arr.every(
				Arr.fromIterable(resolution.defs.entries()),
				([target, key]) => target === key
			)
		})),
		Effect.catchTag("ResolveRefusal", (error) =>
			Effect.succeed<CycleOutcome>({ kind: "refused", refused: refusedOf(error) })
		)
	)
}

/**
 * What design 2.2 and 3.3 say a schema cycle across two documents resolves to: every schema the cycle reaches from the
 * first member's `/S0`, alternating between the members a level at a time, is a target lifted under its canonical key,
 * however many levels the cycle has and however many references each level holds.
 */
export const expectedCycle = (cycle: SchemaCycle): CycleOutcome => {
	const [first, second] = cycleMembers(cycle)
	const reached = cycle.levels % 2 === 0 ? cycle.levels : 2 * cycle.levels
	return {
		kind: "resolved",
		defs: Arr.sort(
			Array.from({ length: reached }, (_, step) =>
				keyOf({
					document: step % 2 === 0 ? first : second,
					pointer: `/S${String(step % cycle.levels)}`
				})
			),
			Order.String
		),
		lifted: true
	}
}

/** A schema cycle's resolution: the targets it lifts, sorted, and whether each is lifted under its own key; or a refusal. */
export type CycleOutcome =
	| Readonly<{ kind: "resolved"; defs: ReadonlyArray<string>; lifted: boolean }>
	| Readonly<{ kind: "refused"; refused: Refused }>

export type CycleFeature =
	| "one level"
	| "an even cycle"
	| "an odd cycle"
	| "a thousand levels or more"

export const cycleFeatures = (cycle: SchemaCycle): ReadonlyArray<CycleFeature> => [
	...(cycle.levels === 1 ? ["one level" as const] : []),
	...(cycle.levels % 2 === 0 ? ["an even cycle" as const] : ["an odd cycle" as const]),
	...(cycle.levels >= 1000 ? ["a thousand levels or more" as const] : [])
]

/** Schema cycles, aimed at each pending situation by one built to reach it. */
export const aimedCycles: Aimed<SchemaCycle, CycleFeature> = aimed(schemaCycles, [
	["one level", (s) => ({ ...s.draw(schemaCycles), levels: 1 })],
	["an even cycle", (s) => ({ ...s.draw(schemaCycles), levels: 2 * s.draw(int(1, 20)) })],
	["an odd cycle", (s) => ({ ...s.draw(schemaCycles), levels: 2 * s.draw(int(1, 20)) + 1 })],
	[
		"a thousand levels or more",
		(s) => ({ ...s.draw(schemaCycles), levels: s.draw(int(1000, 2500)) })
	]
])

/** An unreached member's declaration, on a line that has `$id`, and whether the entry declares the same `$id` too. */
export type Indexed = Readonly<{
	line: "3.1" | "3.2"
	home: Home
	declaration: Declaration
	duplicate: boolean
}>

const ID = "https://example.com/schemas/pet"

const ANCHORED = "https://example.com/s.json"

/** Every declaration, under each line and home, with the entry's duplicate where the declaration is an `$id`. */
export const indexedSpace: FiniteSpace<Indexed> = finite((s) => {
	const declaration = word(declarations)(s)
	return {
		line: word(idLines)(s),
		home: word(homes)(s),
		declaration,
		duplicate: declaration !== "an $anchor under its root $id" && boolean(s)
	}
})

/** The member's value and the pointer of what it declares, with the reference that names it. */
const declared = (
	indexed: Indexed
): Readonly<{ value: Json; pointer: string; ref: string; line: Option.Option<SpecLine> }> => {
	switch (indexed.declaration) {
		case "a fragment's $id":
			return {
				value: { $defs: { Pet: { $id: ID, type: "object" } } },
				pointer: "/$defs/Pet",
				ref: ID,
				line: Option.none()
			}
		case "an OpenAPI document's component $id":
			return {
				value: openapiOf(indexed.line, {
					components: { schemas: { Pet: { $id: ID, type: "object" } } }
				}),
				pointer: "/components/schemas/Pet",
				ref: ID,
				line: Option.some(indexed.line)
			}
		case "an $anchor under its root $id":
			return {
				value: { $defs: { Pet: { $anchor: "pet" } }, $id: ANCHORED },
				pointer: "/$defs/Pet",
				ref: `${ANCHORED}#pet`,
				line: Option.none()
			}
	}
}

/** The use site of the entry's one schema reference. */
const ROOT: CanonicalKey = { document: ENTRY, pointer: "/components/schemas/Root" }

/** Resolves an unreached member's declaration from the entry's one schema reference to it: its target, or the refusal. */
export const indexedResolved = (indexed: Indexed) => {
	const member = Arr.getUnsafe(MEMBERS[indexed.home], 0)
	const found = declared(indexed)
	return resolve({
		document: ENTRY,
		line: indexed.line,
		members: [
			Option.match(found.line, {
				onNone: (): ResolveMember => ({ document: member, value: found.value }),
				onSome: (line): ResolveMember => ({ document: member, line, value: found.value })
			})
		],
		value: openapiOf(indexed.line, {
			components: {
				schemas: {
					Root: { $ref: found.ref },
					...(indexed.duplicate ? { Twin: { $id: ID, type: "object" } } : {})
				}
			}
		})
	}).pipe(
		Effect.map((resolution): IndexedOutcome => ({
			kind: "resolved",
			target: Option.map(
				Option.fromNullishOr(resolution.references.get(keyOf(ROOT))),
				(reference) => reference.target
			)
		})),
		Effect.catchTag("ResolveRefusal", (error) =>
			Effect.succeed<IndexedOutcome>({ kind: "refused", refused: refusedOf(error) })
		)
	)
}

export type IndexedOutcome =
	| Readonly<{ kind: "resolved"; target: Option.Option<CanonicalKey> }>
	| Readonly<{ kind: "refused"; refused: Refused }>

/**
 * What design 3.3 (B10) says: every member's `$id` and `$anchor` is indexed before any reference is judged, so a
 * reference to one declared in a member no reference reaches resolves to it, a fragment's or an OpenAPI document's
 * component alike, an `$anchor` under its resource's root `$id`; and an `$id` the entry declares again in a member is
 * REF-14, stated at the member's declaration.
 */
export const expectedIndexed = (indexed: Indexed): IndexedOutcome => {
	const at: CanonicalKey = {
		document: Arr.getUnsafe(MEMBERS[indexed.home], 0),
		pointer: declared(indexed).pointer
	}
	return indexed.duplicate
		? {
				kind: "refused",
				refused: { code: "REF-14/duplicate-id", scope: "document", at, related: [] }
			}
		: { kind: "resolved", target: Option.some(at) }
}

export type IndexedFeature = Declaration | "an $id the entry declares again"

export const indexedFeatures = (indexed: Indexed): ReadonlyArray<IndexedFeature> => [
	indexed.declaration,
	...(indexed.duplicate ? ["an $id the entry declares again" as const] : [])
]

/**
 * An entry beside two members, a fragment holding a path item with an operationId and an OpenAPI document holding a
 * security scheme, the entry's one path a reference to the fragment's path item; the entry may hold a scheme of the
 * same name and an operation of its own.
 */
export type Connections = Readonly<{
	line: SpecLine
	home: Home
	entryScheme: boolean
	entryOperation: boolean
}>

export const connectionsSpace: FiniteSpace<Connections> = finite((s) => ({
	line: word(specLines)(s),
	home: word(homes)(s),
	entryScheme: boolean(s),
	entryOperation: boolean(s)
}))

/** The scheme name both documents may hold. */
const SCHEME = "MemberKey"

/** The entry's own operationId, and the one only the member holds. */
const ENTRY_OPERATION = "inEntry"

const MEMBER_OPERATION = "inMember"

/** What a resolution connects implicitly: the scheme by name, the operationIds recorded, and where `/a` resolves. */
export type Connected = Readonly<{
	scheme: Option.Option<CanonicalKey>
	operationIds: ReadonlyArray<string>
	path: Option.Option<DocumentUri>
}>

/** Resolves a connections case's set; what it connects implicitly. */
export const connectionsResolved = (connections: Connections) => {
	const [fragment, document] = [
		Arr.getUnsafe(MEMBERS[connections.home], 0),
		Arr.getUnsafe(MEMBERS[connections.home], 1)
	]
	const scheme: Json = { in: "header", name: "X-Key", type: "apiKey" }
	return resolve({
		document: ENTRY,
		line: connections.line,
		members: [
			{
				document: fragment,
				value: { Item: { get: { operationId: MEMBER_OPERATION, responses: {} } } }
			},
			{
				document,
				line: connections.line,
				value: openapiOf(connections.line, {
					components: { securitySchemes: { [SCHEME]: scheme } }
				})
			}
		],
		value: openapiOf(connections.line, {
			paths: {
				"/a": { $ref: `${fragment}#/Item` },
				...(connections.entryOperation
					? {
							"/b": {
								get: { operationId: ENTRY_OPERATION, responses: { "200": { description: "ok" } } }
							}
						}
					: {})
			},
			...(connections.entryScheme ? { components: { securitySchemes: { [SCHEME]: scheme } } } : {})
		})
	}).pipe(
		Effect.map((resolution): Connected => ({
			scheme: implicitComponent(resolution, "securitySchemes", SCHEME),
			operationIds: Arr.sort(Arr.fromIterable(resolution.operationIds.keys()), Order.String),
			path: Option.map(
				Option.fromNullishOr(referenceAt(resolution, "/paths/~1a")),
				(reference) => reference.target.document
			)
		}))
	)
}

/**
 * What design 3.3 says: implicit connections resolve from the entry document only. A security scheme a member alone
 * holds is not found by name, nor is an operationId a member alone holds recorded, though the entry's path reaches the
 * member's path item; the entry's own are.
 */
export const expectedConnections = (connections: Connections): Connected => ({
	scheme: connections.entryScheme
		? Option.some({ document: ENTRY, pointer: `/components/securitySchemes/${SCHEME}` })
		: Option.none(),
	operationIds: connections.entryOperation ? [ENTRY_OPERATION] : [],
	path: Option.some(Arr.getUnsafe(MEMBERS[connections.home], 0))
})

export type ConnectionFeature =
	| "a scheme a member alone holds"
	| "a scheme the entry holds too"
	| "an operationId a member alone holds"
	| "an operationId of the entry's own"

export const connectionFeatures = (connections: Connections): ReadonlyArray<ConnectionFeature> => [
	connections.entryScheme ? "a scheme the entry holds too" : "a scheme a member alone holds",
	...(connections.entryOperation ? ["an operationId of the entry's own" as const] : []),
	"an operationId a member alone holds"
]

/** Which document a 3.2 member's `$self` names: the entry, a member before it, or a member after it. */
export type Collision = Readonly<{ named: CollisionFeature; home: Home }>

export const collisionSpace: FiniteSpace<Collision> = finite((s) => ({
	named: word(collisionFeatures)(s),
	home: word(homes)(s)
}))

/**
 * A collision's set: a fragment and a 3.2 OpenAPI member whose `$self` names a document of the set, the fragment before
 * it unless it names a member after it.
 */
const collisionMembers = (collision: Collision): ReadonlyArray<ResolveMember> => {
	const [one, two] = [
		Arr.getUnsafe(MEMBERS[collision.home], 0),
		Arr.getUnsafe(MEMBERS[collision.home], 1)
	]
	const named = (fragment: DocumentUri) => (collision.named === "the entry" ? ENTRY : fragment)
	return collision.named === "a member after it"
		? [
				{ document: one, line: "3.2", value: openapiOf("3.2", { $self: two }) },
				{ document: two, value: {} }
			]
		: [
				{ document: one, value: {} },
				{ document: two, line: "3.2", value: openapiOf("3.2", { $self: named(one) }) }
			]
}

/** Resolves a collision's set; its refusal, or the resolution's documents when none is refused. */
export const collisionResolved = (collision: Collision) =>
	resolve({
		document: ENTRY,
		line: "3.2",
		members: collisionMembers(collision),
		value: openapiOf("3.2", {})
	}).pipe(
		Effect.map((resolution) => Arr.fromIterable(resolution.documents.keys())),
		Effect.catchTag("ResolveRefusal", (error) => Effect.succeed(refusedOf(error)))
	)

/**
 * What design 3.3 says: no two documents of a set share a URI, by retrieval or by `$self`. Documents register in set
 * order, each by its retrieval URI and then its `$self`, and the first URI already taken is REF-14: at the member's
 * `$self` when it names the entry or a member before it, and at the later member's root when its retrieval URI is the
 * one an earlier `$self` took.
 */
export const expectedCollision = (collision: Collision): Refused => ({
	code: "REF-14/duplicate-id",
	scope: "document",
	at:
		collision.named === "a member after it"
			? { document: Arr.getUnsafe(MEMBERS[collision.home], 1), pointer: "" }
			: { document: Arr.getUnsafe(MEMBERS[collision.home], 1), pointer: "/$self" },
	related: []
})
