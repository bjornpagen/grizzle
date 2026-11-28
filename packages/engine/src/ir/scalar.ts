import { sameOrder } from "@bjornpagen/grizzle-text/base/array"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { type TextBounds, textBounds } from "@bjornpagen/grizzle-text/regex/dfa"
import type { Patterns, PatternSource } from "@bjornpagen/grizzle-text/regex/parse"
import { nominal } from "#compiler/core/brand.ts"
import {
	type Canonicalizable,
	canonicalTag,
	everyProperty,
	type TaggedValue
} from "#compiler/core/canonical.ts"
import { ownedDigest, type RosterDigest, rosterDigest } from "#compiler/core/fingerprint.ts"
import type { DeclaredName, HeldName } from "#compiler/core/identity.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { isIntegerTypmod } from "#compiler/ir/carriers.ts"
import type { ExprTable } from "#compiler/ir/expr.ts"
import type { Fact } from "#compiler/ir/proof.ts"
import type { TextSearchConfiguration } from "#compiler/ir/search.ts"

/**
 * The native carriers grizzle admits. range4, range8 and rangeDate are int4range, int8range and daterange,
 * the only span carriers; date is a calendar day; inet and cidr are PostgreSQL's network address types, an address
 * with its network's mask and a network (scalar/values/net.ts); bytes is bytea, a value stored and read back whole (BytesType); tsvector
 * is a search document, a value PostgreSQL alone computes and matches (SearchType); there is
 * no timestamp, interval, JSON or array carrier. exactInteger and exactMoney are the exact arithmetic carriers
 * (ExactType), and a field of any size of each holds what that arithmetic delivers. sha256 is a SHA-256 digest, 32 bytes
 * of bytea under the installation's digest domain (DigestType). variant is a typed sum, one of a roster's arms, each a
 * heading of typed fields, stored as one column of a domain over a composite (VariantType), the newest carrier and so
 * the last, every other's place among them kept.
 */
export const carriers = [
	"int2",
	"int4",
	"int8",
	"numeric",
	"float4",
	"float8",
	"money",
	"bool",
	"uuid",
	"date",
	"inet",
	"cidr",
	"text",
	"bytes",
	"code",
	"bits",
	"range4",
	"range8",
	"rangeDate",
	"vector",
	"tsvector",
	"exactInteger",
	"exactMoney",
	"sha256",
	"variant"
] as const
export type Carrier = (typeof carriers)[number]

/** The exact arithmetic carriers: what integer and money arithmetic computes (ExactType). */
export const exactValueCarriers = [
	"exactInteger",
	"exactMoney"
] as const satisfies ReadonlyArray<Carrier>
export type ExactValueCarrier = (typeof exactValueCarriers)[number]

/**
 * Whether a column of each carrier holds few values, so that fixing it bounds no scan: a closed id holds one of a
 * roster's codes, a boolean one of two. A set over a roster holds one of 2^n sets, which bounds a scan as a text does. An index led by such a column narrows a lookup little, and a lookup that fixes
 * only such columns is no access path.
 */
export const fewValued: Readonly<Record<Carrier, boolean>> = {
	int2: false,
	int4: false,
	int8: false,
	numeric: false,
	float4: false,
	float8: false,
	money: false,
	bool: true,
	uuid: false,
	date: false,
	inet: false,
	cidr: false,
	text: false,
	bytes: false,
	sha256: false,
	code: true,
	bits: false,
	range4: false,
	range8: false,
	rangeDate: false,
	vector: false,
	tsvector: false,
	exactInteger: false,
	exactMoney: false,
	variant: false
}

/**
 * Whether a column of each carrier routes a change by its value (logical/routes.ts Routes): PostgreSQL's `::text` of a
 * stored value, under any writer's session settings, is the codec's canonical text of the value (codec/scalar.ts
 * ScalarCodec text), so a change's text and a bound parameter's text are equal exactly when the values are. A date's
 * text follows DateStyle, a float's extra_float_digits and its -0, a money's lc_monetary, a bytea's bytea_output, an
 * inet's and a cidr's network_show, which states every mask where inet_out omits a whole one; a
 * numeric prints its stored scale where the codec trims it, a set prints bit_out's binary where the codec writes hex,
 * and a vector, a date span and an exact carrier are none a route compares.
 */
export const routable: Readonly<Record<Carrier, boolean>> = {
	int2: true,
	int4: true,
	int8: true,
	numeric: false,
	float4: false,
	float8: false,
	money: false,
	bool: true,
	uuid: true,
	date: false,
	inet: false,
	cidr: false,
	text: true,
	bytes: false,
	sha256: false,
	code: true,
	bits: false,
	range4: true,
	range8: true,
	rangeDate: false,
	vector: false,
	tsvector: false,
	exactInteger: false,
	exactMoney: false,
	variant: false
}

/** The span carriers over integer endpoints, range4 over int4 and range8 over int8. */
export const integerSpanCarriers = ["range4", "range8"] as const satisfies ReadonlyArray<Carrier>

/** The span carriers: those over integer endpoints, and rangeDate over date endpoints. */
export const spanCarriers = [
	...integerSpanCarriers,
	"rangeDate"
] as const satisfies ReadonlyArray<Carrier>

/**
 * The operation capability vocabulary: storage, equality, ordering, hashing used for bucketing, the
 * aggregate overload families, span endpoints, expression-index eligibility, GiST, the set algebra of a set over a
 * roster (union, intersection, difference, cardinality, subset and disjointness, and the singleton of a closed id of
 * it), the containment of PostgreSQL's network address types (`<<=`, `<<` and `&&`), PostgreSQL's full text search of a search document (its match and its ranks), and the admitted extension
 * operation. A CapabilitySet is sorted and duplicate-free, so its canonical form is its identity.
 */
export const capabilities = [
	"avg",
	"boolAgg",
	"equality",
	"expressionIndex",
	"gist",
	"hashing",
	"minMax",
	"netContainment",
	"ordering",
	"setAlgebra",
	"spanEndpoint",
	"storage",
	"sum",
	"textSearch",
	"vectorDistance"
] as const
export type Capability = (typeof capabilities)[number]
export type CapabilitySet = ReadonlyArray<Capability>

export const capabilitySet = (caps: ReadonlyArray<Capability>): CapabilitySet =>
	Object.freeze([...new Set(caps)].toSorted(compareStrings))

/**
 * numeric(p, s): precision 1..numericMaxPrecision, scale numericMinScale..numericMaxScale, both present wherever a
 * typmod is, as a numeric(p, s) field, cast, parameter and typed literal declares them: one typmod, one identity.
 * numeric of no typmod has none (NumericValueType).
 */
export interface NumericTypmod {
	readonly precision: number
	readonly scale: number
}

/**
 * What a computed numeric value is proved to be: every finite value below 10^digits in magnitude, with at most `scale`
 * fraction digits, within numeric's own limits, numericMaxIntegerDigits and numericMaxFractionDigits. Its digits are
 * negative for values below one by an order of magnitude or more, as a numeric(p, s) with s above p converts into one,
 * and never fewer than -numericMaxFractionDigits, below which no numeric value but zero lies. It is set where
 * the value is made, from what makes it: a sum's from its argument's and the rows' count, a mean's from its argument's
 * and PostgreSQL's display scale, an operation's from its operands' bounds. A making past numericMaxIntegerDigits is
 * ResourceBound there, so no bound passes it.
 */
export interface NumericBound {
	readonly digits: number
	readonly scale: number
}

/** vector(n): 1..vectorMaxDimensions dimensions (ir/carriers.ts). */
export interface VectorTypmod {
	readonly dims: number
}

/**
 * A nominal contract: a domain over its base with an optional predicate and the facts it proves. Compatibility is by
 * contract identity (name and base), never by predicate equality: sameScalarType ignores the predicate and the facts. The predicate
 * is the domain's one constraint, <contract>__check, an ExprTable in normal form (expr.ts predicateTable), so its
 * canonical text, which fingerprints include, does not depend on allocation order. The base is a value domain of the
 * contract's own carrier.
 * The name is a declared name, parsed where the contract is built (scalar/registry.ts contractOver) and where a
 * descriptor is decoded (scalar-shape.ts): the contract's identity as a type. Its domain is named by its physical
 * definition (core/identity.ts identity.contractDomain), which contracts of one definition share.
 */
export interface ContractInfo {
	readonly name: DeclaredName
	readonly base: ContractBase
	readonly predicate: ExprTable | undefined
	/**
	 * The facts every value of the contract has, which its declaration states and its build proved from its predicate
	 * (scalar/contract.ts): sorted, each once. A term of the contract carries them in its TypeScript type, so a divisor
	 * of a nonzero contract needs no guard.
	 */
	readonly facts: ReadonlyArray<Fact>
}

/**
 * The identity of a regex's language: the SHA-256 of the text analysis's canonical pattern key
 * (text/refinement.ts TextRefinement.digest). Two patterns are the same refinement exactly when their keys are equal.
 */
export type RegexKey = string & { readonly [regexKeyBrand]: true }
declare const regexKeyBrand: unique symbol
export const RegexKey = nominal<string, RegexKey>()

/**
 * How PostgreSQL enforces a language of a text's patterns some admitted text value is no member of, with the bounds the
 * enforcement proves on every member: `VALUE IN (...)` of its members, at least one since an analyzed language has a
 * member, or `VALUE ~ '<ARE>'` of the translation of each pattern of the conjunction the check reads, joined by AND.
 * The text analysis chooses it (text/refinement.ts) and makes it by finiteCheck or regexCheck alone, so every one is
 * frozen with all it holds.
 */
export type PatternCheck =
	| {
			readonly kind: "finite"
			readonly members: NonEmptyReadonlyArray<string>
			readonly bounds: TextBounds
	  }
	| {
			readonly kind: "regex"
			readonly ares: NonEmptyReadonlyArray<string>
			readonly bounds: TextBounds | undefined
	  }

/** `VALUE IN (...)` of a finite language's `members`, a frozen copy of them: the one constructor of a finite check. */
export const finiteCheck = (
	members: NonEmptyReadonlyArray<string>,
	bounds: TextBounds
): PatternCheck => {
	const [first, ...rest] = members
	const copy: NonEmptyReadonlyArray<string> = [first, ...rest]
	return Object.freeze({ kind: "finite", members: Object.freeze(copy), bounds })
}

/**
 * `VALUE ~ '<ARE>'` of each ARE `ares` holds, one for each member of a conjunction its check reads, joined by AND: the
 * one constructor of a regex check, frozen.
 */
export const regexCheck = (
	ares: NonEmptyReadonlyArray<string>,
	bounds: TextBounds | undefined
): PatternCheck => Object.freeze({ kind: "regex", ares: Object.freeze(ares), bounds })

/**
 * How PostgreSQL enforces a text refinement: its pattern's language (PatternCheck), or a byte bound that cuts it,
 * `octet_length(VALUE) <= octets` beside the pattern's check, or alone where the pattern admits every value
 * (str.bytes), with the tighter of the pattern's bounds and the byte bound's, a code point taking at least a byte. A
 * byte bound's is made by octetsCheck alone, frozen.
 */
export type RegexCheck =
	| PatternCheck
	| {
			readonly kind: "octets"
			readonly octets: number
			readonly check: PatternCheck | undefined
			readonly bounds: TextBounds
	  }

/** The byte bound a check enforces beside its pattern's, str.bytes's: none for a pattern's check alone. */
export const octetsOf = (check: RegexCheck): number | undefined =>
	check.kind === "octets" ? check.octets : undefined

/** A text's patterns as diagnostics name them: each `/source/flags`, joined by ` & ` as the host type joins them. */
export const patternsText = (patterns: Patterns): string =>
	patterns.map((p) => `/${p.source}/${p.flags}`).join(" & ")

/**
 * A regex refinement: its patterns as declared, its language's key and its enforcement, which the text analysis
 * computes where it builds the reference. The text package owns the pattern IR; the scalar type carries what every
 * later pass reads of it, so none analyzes the patterns again.
 */
export interface RegexRef {
	readonly patterns: Patterns
	readonly key: RegexKey
	readonly check: RegexCheck
}

/**
 * What the text analysis proved of a text descriptor's patterns, which the descriptor carries from where it is admitted
 * (text/refinement.ts textLanguage): every admitted value, a tautology, or a language some admitted value is no member
 * of, by its key and its enforcement. It is a function of the patterns beside it, so it is no part of the descriptor's
 * semantic identity (core/canonical.ts omitSourceLocs).
 */
export type TextLanguage =
	| { readonly kind: "every" }
	| { readonly kind: "refined"; readonly key: RegexKey; readonly check: RegexCheck }

/** A frozen copy of `patterns`, each member frozen: what a regex reference holds. */
const frozenPatterns = (patterns: Patterns): Patterns =>
	Object.freeze(mapNonEmpty(patterns, (p) => Object.freeze({ source: p.source, flags: p.flags })))

/** The refinement a text type carries for patterns of `language`: the wildcard, or its regex reference. */
export const textInfoOf = (patterns: Patterns, language: TextLanguage): TextInfo =>
	language.kind === "every"
		? "wildcard"
		: Object.freeze({
				patterns: frozenPatterns(patterns),
				key: language.key,
				check: language.check
			})

/**
 * A text refinement's regex reference: a specific pattern's, none for the wildcard or a text of patterns, whose values
 * are every text as far as their language goes.
 */
export const regexOf = (text: TextInfo): RegexRef | undefined =>
	text === "wildcard" || text === "pattern" ? undefined : text

/** The language a text type's refinement states: what a descriptor of that type carries. */
export const languageOfText = (text: TextInfo): TextLanguage => {
	const regex = regexOf(text)
	return regex === undefined
		? Object.freeze({ kind: "every" })
		: Object.freeze({ kind: "refined", key: regex.key, check: regex.check })
}

/**
 * The bounds a text refinement proves on every value, in code points and UTF-8 bytes: its enforcement's
 * (RegexCheck), none for the wildcard or a pattern that proves none.
 */
export const textInfoBounds = (text: TextInfo): TextBounds | undefined =>
	regexOf(text)?.check.bounds

/** The byte bound a text descriptor's language enforces beside its pattern's (octetsOf): none for an unrefined text. */
export const languageOctets = (language: TextLanguage): number | undefined =>
	language.kind === "every" ? undefined : octetsOf(language.check)

/** The pattern of every text as grizzle spells it: what a byte bound over every text cuts, `str.regex("^.*$", "su")`. */
export const wildcardPattern: PatternSource = Object.freeze({ source: "^.*$", flags: "su" })

/**
 * The pattern of a token of a whitespace-separated list (r.tokens, ir/rel.ts TextSplit `tokens`): one character or
 * more, none of them XML whitespace (XML 1.0 S: tab, LF, CR and space), `str.regex("^[^\\t\\n\\r ]+$")`.
 */
export const tokenPattern: PatternSource = Object.freeze({ source: "^[^\\t\\n\\r ]+$", flags: "u" })

/** The patterns a text type's language is stated by: its regex reference's, or the wildcard's alone. */
export const textPatterns = (text: TextInfo): Patterns =>
	regexOf(text)?.patterns ?? [wildcardPattern]

/**
 * The own language of a text's patterns, before a byte bound cuts it: every text, or the language their check
 * enforces, by its key. The text analysis proves one of a conjunction of patterns (text/refinement.ts textLookup).
 */
export type PatternLanguage =
	| { readonly kind: "every" }
	| { readonly kind: "refined"; readonly key: RegexKey; readonly check: PatternCheck }

/**
 * The key of a language whose canonical text is `text`: its SHA-256 under the regex-language domain. A pattern's text
 * is its canonical key (text/refinement.ts TextRefinement.key), and a cut's its pattern's key and its bound.
 */
export const languageKey = (text: string): RegexKey =>
	RegexKey(ownedDigest("regex-language", text, everyProperty))

/** The tighter of a pattern's bounds and a byte bound's: a code point takes at least a byte. */
const boundsWithin = (bounds: TextBounds | undefined, octets: number): TextBounds =>
	bounds === undefined
		? textBounds(octets, octets)
		: textBounds(Math.min(bounds.length, octets), Math.min(bounds.bytes, octets))

/**
 * `octet_length(VALUE) <= octets` beside a pattern's `check`, or alone where the pattern admits every value, with the
 * tighter bounds of the two (boundsWithin): the one constructor of a byte bound's check, frozen.
 */
const octetsCheck = (octets: number, check: PatternCheck | undefined): RegexCheck =>
	Object.freeze({ kind: "octets", octets, check, bounds: boundsWithin(check?.bounds, octets) })

/**
 * The language of a text of at most `octets` UTF-8 bytes whose pattern's own language is `pattern`, as str.bytes and a
 * guard of a text's bytes state it: the pattern's own where its bounds prove every member fits, so the two spell one
 * language, one key and one domain; else its members of at most so many bytes, enforced by `octet_length(VALUE) <=
 * octets` beside the pattern's check, or alone for every text, keyed by the pattern's own key and the bound, so a
 * language and a bound have one key however they are reached.
 */
export const languageWithin = (pattern: PatternLanguage, octets: number): TextLanguage => {
	if (pattern.kind === "every") {
		const every: TextLanguage = {
			kind: "refined",
			key: languageKey(`octets<=${octets}`),
			check: octetsCheck(octets, undefined)
		}
		return Object.freeze(every)
	}
	const { check } = pattern
	if (check.bounds !== undefined && check.bounds.bytes <= octets) {
		return pattern
	}
	const cut: TextLanguage = {
		kind: "refined",
		key: languageKey(`${pattern.key}&octets<=${octets}`),
		check: octetsCheck(octets, check)
	}
	return Object.freeze(cut)
}

/**
 * A text descriptor's refinement: a specific pattern's regex reference, whose enforcement holds the bounds it proves
 * (textInfoBounds); the canonical wildcard, which admits every value and proves none; or `pattern`, a closed relation's
 * text whose every value is a Text.matches pattern of grizzle's grammar (str.pattern), admitted once where the
 * relation is read (check/closed.ts) and translated into the ARE PostgreSQL reads where the relation's constants are
 * planned (physical/ddl/constants.ts), every text as far as its language goes.
 */
export type TextInfo = RegexRef | "wildcard" | "pattern"

/**
 * Whether a roster's order means something, which its declaration states: `ordered` (closed.ordered), its handles'
 * declared order, which is their codes' order and so comparison order; or `unordered` (closed.unordered), none, so no
 * comparison, range, orderBy, least, greatest, min, max or fold max reads a closed id of it, and a declaration may list
 * its handles in any order; or `zones` (closed.zones), an unordered roster whose handles are time zones' IANA names, each
 * an Area/Location name (isZoneName), which the migration that installs it finds among the server's
 * time zones and Time.wall reads a closed id of as its zone. Its codes are history either way (ir/cells.ts
 * historyCodes).
 */
export const rosterOrders = ["ordered", "unordered", "zones"] as const
export type RosterOrder = (typeof rosterOrders)[number]

/**
 * Whether a handle is a time zone's IANA name in its Area/Location form, as tzdata spells one: two components or more
 * joined by "/", each of ASCII letters, digits, ".", "-", "_" and "+", the first opening with a letter and none "." or
 * "..", such as "America/Argentina/Buenos_Aires" or "Etc/GMT+5". A name of one component (UTC, EST, CET, GB, EST5EDT)
 * is refused: PostgreSQL's timezone(text, timestamptz) reads a name as a time zone abbreviation first, from the
 * timezone_abbreviations setting and the session's TimeZone, and as a POSIX zone, before it reads it as a zone of its
 * tzdata, and no abbreviation or POSIX zone holds a "/". The migration that installs the roster finds each among the
 * server's time zones (deploy/diff/diff.ts zoneChecks), and the handles of a zone roster are such names (closed.zones).
 */
export const isZoneName = (handle: string): boolean => {
	const components = handle.split("/")
	const isLetter = (code: number): boolean =>
		(code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
	const isNameCode = (code: number): boolean =>
		isLetter(code) ||
		(code >= 0x30 && code <= 0x39) ||
		code === 0x2e ||
		code === 0x2d ||
		code === 0x5f ||
		code === 0x2b
	return (
		components.length > 1 &&
		isLetter(handle.charCodeAt(0)) &&
		components.every(
			(c) =>
				c.length > 0 &&
				c !== "." &&
				c !== ".." &&
				Array.from(c).every((ch) => isNameCode(ch.charCodeAt(0)))
		)
	)
}

/** The tag of a roster's canonical form, by its order, so two rosters of one name and handles but not one order differ. */
const rosterTags = {
	ordered: "roster",
	unordered: "unorderedroster",
	zones: "zoneroster"
} as const satisfies {
	readonly [O in RosterOrder]: string
}

/**
 * A roster's handles in its own order: an ordered roster's as declared, and an unordered roster's, a set, in UTF-16
 * code-unit order (core/order.ts compareStrings), so no declaration's order reaches its identity: the order its
 * Description (schema/relation.ts admitRoster) and its Roster hold them in.
 */
export const handlesInOrder = (
	order: RosterOrder,
	handles: ReadonlyArray<string>
): ReadonlyArray<string> => {
	switch (order) {
		case "ordered":
			return handles
		case "unordered":
		case "zones":
			return handles.toSorted(compareStrings)
	}
}

/**
 * A closed roster: the closed relation's name (a declared one, or one a library derives), its order, and its distinct live handles in that order
 * (handlesInOrder): an ordered roster's in declared order, which is their codes' order and so comparison order, and an
 * unordered roster's in one canonical order, which no code follows. The name is the roster's whole link to its domain
 * and codes: the naming door mints the roster's domain from it by its naming (schema/own.ts), and the
 * installation's codebook holds its codes (ir/codes.ts), which no type holds, since they depend on the codes the
 * installation held before.
 *
 * Its identity is its name, its order and its handles in order, as type identity compares them (sameScalarType): one
 * name holds other handles in another schema, which a snapshot or a migration compares this one's against. Its canonical
 * form (core/canonical.ts Canonicalizable) is its name and its handles' digest (core/fingerprint.ts rosterDigest) under
 * its order's tag, the digest taken once, where the roster is first made (Roster.of), so a type, a literal or a
 * predicate over the roster encodes the same characters whatever the roster's size, and every encoding of it changes
 * with its handles.
 */
export class Roster implements Canonicalizable {
	readonly closed: HeldName
	readonly order: RosterOrder
	readonly handles: ReadonlyArray<string>
	readonly digest: RosterDigest

	/** The roster of `closed` of `order` over `handles`, its digest taken here (core/fingerprint.ts rosterDigest). */
	static of(closed: HeldName, order: RosterOrder, handles: ReadonlyArray<string>): Roster {
		const held = handlesInOrder(order, handles)
		return new Roster(closed, order, held, rosterDigest(held))
	}

	/**
	 * The roster of `closed` of `order` over `handles`, in its order (handlesInOrder), whose digest is `digest`: the one
	 * Roster.of takes, or the one a served file carries beside the roster's name, which generate took (served/json.ts),
	 * so a load hashes no handle.
	 */
	constructor(
		closed: HeldName,
		order: RosterOrder,
		handles: ReadonlyArray<string>,
		digest: RosterDigest
	) {
		const held = handlesInOrder(order, handles)
		this.closed = closed
		this.order = order
		this.handles = Object.isFrozen(held) ? held : Object.freeze(held)
		this.digest = digest
		Object.freeze(this)
	}

	[canonicalTag](): TaggedValue {
		return { tag: rosterTags[this.order], payload: `${this.closed}:${this.digest}` }
	}
}

/** What a roster's declaration states beside its name: its order and its handles, which a Roster holds in that order. */
export interface RosterHandles {
	readonly order: RosterOrder
	readonly handles: ReadonlyArray<string>
}

/** How a closed id's type names its roster's order in a diagnostic (typeLabel). */
const rosterCodeLabels = {
	ordered: "code",
	unordered: "unordered code",
	zones: "zone code"
} as const satisfies { readonly [O in RosterOrder]: string }

/** The integer carriers. */
export type IntegerCarrier = "int2" | "int4" | "int8"
export type SpanCarrier = (typeof spanCarriers)[number]
/** The carriers whose descriptor holds nothing beside its carrier, its capabilities and its contract. */
export type BareCarrier = "float4" | "float8" | "money" | "bool" | "uuid" | "date" | "inet" | "cidr"

/**
 * The descriptor is a union tagged by carrier: each plain variant holds exactly the fields its carrier has, and a
 * contract's holds its carrier, its capabilities and the contract alone, its base holding every other field
 * (ContractType). A field is read off a plain variant the carrier narrowed to, or through its total accessor
 * (textOf, rosterOf, spanOf, numericTypmodOf, vectorTypmodOf), which reads a contract's through its base, or by its
 * `contract`, which every descriptor states, undefined for a plain one.
 */
interface IntegerType<C extends IntegerCarrier = IntegerCarrier> {
	readonly carrier: C
	readonly caps: CapabilitySet
	readonly contract: undefined
}

/** numeric(p, s): what a field, a cast, a parameter and a typed literal declare, a contract's base among them. */
interface NumericTypmodType {
	readonly carrier: "numeric"
	readonly caps: CapabilitySet
	readonly typmod: NumericTypmod
	readonly contract: undefined
}

/**
 * PostgreSQL's numeric of no typmod, with the bound what makes it proved: an aggregate's, an operation's or a
 * conversion's result, a computed numeric, with its making's, and numeric's declaration, a field, a parameter, a
 * declared function's argument or result or a contract's base, with numeric's own limits, which PostgreSQL enforces
 * (scalar/registry.ts numericOwnLimits). No declaration states a narrower bound.
 */
export interface NumericValueType {
	readonly carrier: "numeric"
	readonly caps: CapabilitySet
	readonly typmod: undefined
	readonly contract: undefined
	readonly bound: NumericBound
}

type NumericType = NumericTypmodType | NumericValueType

interface BareType {
	readonly carrier: BareCarrier
	readonly caps: CapabilitySet
	readonly contract: undefined
}

export interface TextType {
	readonly carrier: "text"
	readonly caps: CapabilitySet
	readonly contract: undefined
	readonly text: TextInfo
}

/**
 * A closed id: one of the roster's live handles, stored as its code, a smallint under the roster's domain. An ordered
 * roster's closed id is ordered by code, which is the roster's declared order; an unordered roster's has none, which its
 * capabilities state (scalar/native.ts unorderedCodeCapabilities). `only` is the subset of the roster's handles its
 * values are, in the roster's order, never every handle; none for every handle (ir/desc.ts FieldDesc). It meets a
 * closed id of its roster whatever either's subset (scalar/compute/types.ts compatible), as a refined text meets text,
 * and a stored column of it is held to its subset by its CHECK (physical/ddl/column-checks.ts).
 */
interface CodeType {
	readonly carrier: "code"
	readonly caps: CapabilitySet
	readonly contract: undefined
	readonly roster: Roster
	readonly only: NonEmptyReadonlyArray<string> | undefined
}

/**
 * A set over a roster's codes: bit(n), n every code the roster has minted, holes included, position i code i. No
 * contract is over one, and no field is a span or vector of one.
 */
interface BitsType {
	readonly carrier: "bits"
	readonly caps: CapabilitySet
	readonly contract: undefined
	readonly roster: Roster
}

/**
 * bytea: a value written and read back whole, of the storage capability alone (scalar/registry.ts nativeCapabilities),
 * so no key, rule, computation, parameter or filter reads one, and no contract is over one.
 */
interface BytesType {
	readonly carrier: "bytes"
	readonly caps: CapabilitySet
	readonly contract: undefined
}

/**
 * sha256: a SHA-256 digest, exactly sha256Octets bytes (core/sha256.ts), stored as bytea under the installation's digest
 * domain, whose CHECK holds its length (physical/ddl/context.ts digestDomain), and held on the host as its bytes
 * (scalar/values/sha256.ts Sha256). It is what Crypto.sha256 yields, and, unlike bytes, a value of bounded length that
 * bytea's B-tree and hash classes compare by its bytes, so a key, a reference and a comparison read it. No contract is
 * over one: its one predicate is its length, which its domain holds.
 */
interface DigestType {
	readonly carrier: "sha256"
	readonly caps: CapabilitySet
	readonly contract: undefined
}

interface SpanType {
	readonly carrier: SpanCarrier
	readonly caps: CapabilitySet
	readonly contract: undefined
	readonly span: SpanInfo
}

interface VectorType {
	readonly carrier: "vector"
	readonly caps: CapabilitySet
	readonly typmod: VectorTypmod
	readonly contract: undefined
}

/**
 * tsvector: a search document PostgreSQL computes from texts under `configuration` (ir/search.ts), whose
 * configuration is its identity as a type, so a query is parsed under the configuration of the document it meets and two
 * documents of two configurations are two types: a generated field's parse of its row's texts (searchDocument), or a
 * field its caller writes from a document a read delivered (tsvector). It is of storage and textSearch alone
 * (scalar/native.ts): written and read back whole as the text PostgreSQL prints, matched and ranked by PostgreSQL, and
 * nothing more, so no key, rule, comparison, parameter or host computation reads one, and no contract is over one.
 */
export interface SearchType {
	readonly carrier: "tsvector"
	readonly caps: CapabilitySet
	readonly contract: undefined
	readonly configuration: TextSearchConfiguration
}

/**
 * An exact arithmetic result: exactInteger, an integer, the value of add, sub, mul, neg, abs, gcd, lcm and integer
 * division over the integer carriers; exactMoney, an amount of money in cents, the value of add and sub over money and
 * of a money sum. Delivered as bigint and as Money, so no such operation overflows: `digits` bounds every value,
 * |x| < 10^digits (of the amount, for money), as its operands' bounds give it (scalar/compute/typing.ts), the way a
 * typmod bounds numeric(p, 0). In SQL an exact integer of at most 18 digits is bigint, and any other exact value
 * numeric (exactMoney at scale 2). A field of each, exactInteger or exactMoney (scalar/exact.ts), is the type at
 * numeric's own limit, numericMaxIntegerDigits, so it holds every value any operation delivers: a numeric column
 * CHECKed to the values its host spells (physical/numeric/storage.ts exactNumeric), whose arithmetic past the limit
 * PostgreSQL refuses (22003), as numeric's. No contract is over one; Type.cast narrows one into a storage carrier
 * where the value is proved to fit.
 */
interface ExactType {
	readonly carrier: ExactValueCarrier
	readonly caps: CapabilitySet
	readonly contract: undefined
	readonly digits: number
}

/**
 * One field of a variant's arm: its name, unique within its arm and never `tag`, which names the arm itself, and its
 * declared type, every value type a field declares but a variant, bytes, a search document, a vector and money
 * (scalar/registry.ts isArmFieldType).
 */
export interface ArmField {
	readonly name: string
	readonly type: DeclaredType
}

/** One arm of a variant: the roster handle that tags it and its fields, in declared order, none for a payload-less arm. */
export interface VariantArm {
	readonly handle: string
	readonly fields: ReadonlyArray<ArmField>
	/**
	 * The arm's check, a predicate over the variant's VALUE that reads that arm's fields alone (ir/desc.ts VariantArmDesc
	 * `check`), an ExprTable in normal form as a contract's predicate is, which the variant's domain's CHECK holds under
	 * the arm's code (physical/ddl/variants.ts); none for an arm of no check, and none in a descriptor read outside a
	 * schema, which types it where the schema compiles (scalar/registry.ts variantAt).
	 */
	readonly check: ExprTable | undefined
}

/**
 * A variant: a closed sum of headings. Its tag is a closed id of the subset of `roster`'s live handles its arms name,
 * every handle or some (variantOnly), each tagging exactly one arm, in the roster's handle order; a value is one arm's
 * handle with a value of each of that arm's fields, and a handle no arm names is no value of it. Its identity is its
 * declared name, its roster and its arms, field by field (sameVariant). The installation names its composite and its
 * domain by its declared name (core/identity.ts identity.variantRow, identity.variantDomain), so an arm appended to it
 * alters its composite in place rather than retyping a column.
 */
export interface VariantInfo {
	readonly name: DeclaredName
	readonly roster: Roster
	readonly arms: NonEmptyReadonlyArray<VariantArm>
}

/**
 * A typed sum value: one of a variant's arms (VariantInfo), stored as one column whose type is a domain over a
 * composite (physical/ddl/variants.ts): the composite's first attribute is the tag, the arm's code, a smallint, then
 * each arm's fields at their base types, the arms in their codes' order (ir/codes.ts variantLayout), a float's value
 * followed by whether it is -0; the domain's CHECK holds the tagged arm's attributes present, each field judged by its
 * own type and each arm check the variant states, and every other arm's absent. PostgreSQL's record equality, hash and
 * B-tree order over that composite read two absent attributes as equal and a float's zero sign beside it, so its one
 * equality is the variant's identity (scalar/variant-digest.ts): its tag, then its arm's fields, -0 apart from 0, every
 * NaN one, a text by its bytes; and its order is the tag's code, then the arm's fields in declared order: keys,
 * references, DISTINCT, UNION, GROUP BY and ORDER BY read a variant column as they read any column. It has equality
 * and hashing and no stated order (scalar/native.ts); a completed order breaks ties by it (scalar/registry.ts
 * breaksTies). No contract is over one.
 */
export interface VariantType {
	readonly carrier: "variant"
	readonly caps: CapabilitySet
	readonly contract: undefined
	readonly variant: VariantInfo
}

/** A type with no contract: what a contract is over at its last level (baseOf), and every operation's result. */
export type PlainType =
	| IntegerType<"int2">
	| IntegerType<"int4">
	| IntegerType<"int8">
	| NumericType
	| BareType
	| TextType
	| BytesType
	| DigestType
	| CodeType
	| BitsType
	| SpanType
	| VectorType
	| SearchType
	| ExactType
	| VariantType

/**
 * The plain value domains a contract is over at its last level: every value type a field declares but an exact value, a
 * set, bytes, a digest, a search document and a variant.
 */
type ContractedType = Exclude<
	PlainType,
	ExactType | BitsType | BytesType | DigestType | SearchType | VariantType
>

/** The carriers a contract is over. */
export type ContractCarrier = ContractedType["carrier"]

/**
 * A contract's descriptor, of carrier C, its base's, which a switch on carriers reads it by: the contract, whose base
 * holds its capabilities, its typmod, its text refinement, its roster and its span (capsOf, textOf, …), which this
 * descriptor never repeats, so nothing holds two copies of one field to keep alike.
 */
export interface ContractType<C extends ContractCarrier = ContractCarrier> {
	readonly carrier: C
	readonly contract: ContractInfo
}

/** A contract's descriptor of each carrier a contract is over. */
type ContractTypes = { readonly [C in ContractCarrier]: ContractType<C> }[ContractCarrier]

/**
 * The value domains a contract is over: every value type a field declares, numeric of no typmod at numeric's own limits
 * among them, never an exact value, arithmetic's own type, whose field holds what an operation delivers as it is, nor a
 * set over a roster, whose holes and padding no
 * predicate over it could keep apart, nor bytes, which no predicate reads; a contract's among them, so a contract is
 * over another.
 */
export type ContractBase = ContractedType | ContractTypes

/**
 * What a field descriptor declares (scalar/registry.ts scalarTypeOf): a value domain a contract may be over, a set over
 * a roster, bytes, a digest, a search document, or an exact value at numeric's own limit (ExactType). An exact value's
 * narrower digit bound and a computed numeric's narrower bound are a value's making, which no declaration states. How a
 * field is written, by its sequence among the ways, is the field's writing, never its type.
 */
export type DeclaredType =
	| ContractBase
	| BitsType
	| BytesType
	| DigestType
	| SearchType
	| ExactType
	| VariantType

/** A date: a calendar day, or a contract over one, as a span's endpoint, a closed id's payload or a field. */
export type DateType = (BareType & { readonly carrier: "date" }) | ContractType<"date">

/** Whether a type is a date's, a date itself or a contract over one. */
export const isDateType = (t: ScalarType): t is DateType => t.carrier === "date"

/**
 * A bounded, half-open span over an endpoint of its carrier (range4 over int4, range8 over int8, rangeDate over date),
 * a contract over one among them, with an optional fixed positive width, of the endpoint's units: a count of days over
 * date. Every value of a span type is nonempty and bounded, so lower() and upper() never return NULL: a stored column
 * carries the span shape CHECK (physical/span/storage.ts), a literal has start < end (expr.ts literalProblem), a
 * parameter or fact is admitted only as one (scalar/values/span.ts makeSpan), a producer never delivers an empty piece,
 * and no operation of the catalogue returns a span. The Allen reading of endpoint predicates (check/allen.ts) rests on
 * it.
 */
export interface SpanInfo {
	readonly endpoint:
		| IntegerType<"int4">
		| IntegerType<"int8">
		| ContractType<"int4">
		| ContractType<"int8">
		| DateType
	readonly width: bigint | undefined
}

/** Whether a type is numeric of no typmod, a computed numeric or numeric's, and no contract. */
export const isNumericValue = (t: ScalarType): t is NumericValueType =>
	t.carrier === "numeric" && t.contract === undefined && t.typmod === undefined

/** Whether a type is an exact arithmetic result, which no declaration states. */
export const isExactValue = (t: ScalarType): t is ExactType =>
	t.carrier === "exactInteger" || t.carrier === "exactMoney"

/**
 * The scalar type IR.
 *
 * A ScalarType is the canonical native carrier identity of a value plus everything that changes its meaning:
 * numeric typmod or a computed numeric's bound, contract identity, text refinement, closed roster, span endpoint, vector
 * dimensions, an exact value's digit bound, and the operation capability set. Two descriptors are the
 * same type exactly when they agree in each of these, a contract by its identity (sameScalarType).
 *
 * There is no nullable type: every ScalarType denotes a non-null domain, and absence is zero rows.
 */
export type ScalarType = PlainType | ContractTypes

/** The name of natural, the builtin contract over bigint whose values are never below zero (scalar/natural.ts). */
export const naturalName = "natural"

/** A contract contributes its base: the plain type a contract is over at its last level, every other type itself. */
export const baseOf = (t: ScalarType): PlainType =>
	t.contract === undefined ? t : baseOf(t.contract.base)

/**
 * A float type's carrier, real's or double precision's, whose two zeros are one value under PostgreSQL's equality and
 * two values, -0 and +0; undefined for a type of any other carrier.
 */
export const floatCarrierOf = (t: ScalarType): "float4" | "float8" | undefined => {
	const carrier = baseOf(t).carrier
	return carrier === "float4" || carrier === "float8" ? carrier : undefined
}

/** Whether a type is a float's, real or double precision (floatCarrierOf). */
export const isFloat = (t: ScalarType): boolean => floatCarrierOf(t) !== undefined

/**
 * Whether equality over a carrier is identity: two values PostgreSQL's equality holds equal are one value of grizzle's,
 * written and delivered alike, so a column an equality holds at a value holds that very value. A float's two zeros are
 * not (-0 = 0), which a fact's identity tells apart (ir/compare.ts factEq). Every other carrier's are:
 *
 * - a numeric's display scales (1.0 = 1.00) are no part of its value: its output text decodes to one Numeric in its one
 *   form, of no display scale (scalar/values/decimal.ts fromOutput; test/unit/values/decimal.test.ts
 *   decimalParsingConvertsNumericOutTextAtEveryDisplayScaleToTheValuesOneFormItsTextAndPartsTheValues), and each
 *   overload that reads a display scale reads its operands through trim_scale (lower/conservative/expr/ops.ts
 *   operandsAsRead; test/pg/compute/catalogue.test.ts), so no term grizzle computes reads one. The exact carriers are
 *   numerics.
 * - a vector's components' zeros ('[-0]' = '[0]') are one: its output text decodes into its one form, each component's
 *   -0 read as 0 (scalar/values/float.ts convertComponent; test/unit/codec/float.test.ts
 *   exactBinary32ReadingAgreesWithAnIndependentRationalReadingOnRandomDecimalsAndRefusesOverflowAndNonzeroUnderflow),
 *   and Vector.componentText writes -0 as 0 in identity texts, canonical payloads and literals (scalar/values/vector.ts;
 *   test/unit/values/vector.test.ts
 *   vectorInTheCanonicalSerializerRoundTripsEveryFloat32VectorBitForBitAHostVectorOneTextWithItsCanonicalForm), so no
 *   vector grizzle reads or writes holds a zero's sign.
 * - every text is C-collated, so a text's equality is its bytes'; inet and cidr, ranges, tsvector and money normalize
 *   on input, so equal values print alike (measured on PostgreSQL 19). grizzle has no interval carrier.
 */
const equalityIsIdentityOf = {
	int2: true,
	int4: true,
	int8: true,
	numeric: true,
	float4: false,
	float8: false,
	money: true,
	bool: true,
	uuid: true,
	date: true,
	inet: true,
	cidr: true,
	text: true,
	bytes: true,
	code: true,
	bits: true,
	range4: true,
	range8: true,
	rangeDate: true,
	vector: true,
	tsvector: true,
	exactInteger: true,
	exactMoney: true,
	sha256: true,
	variant: true
} as const satisfies { readonly [C in Carrier]: boolean }

/**
 * The carriers whose equality is no identity (equalityIsIdentityOf), each with its canonical form (ir/expr.ts
 * canonicalIds): real and double precision.
 */
export type NonIdentityCarrier = {
	readonly [C in Carrier]: (typeof equalityIsIdentityOf)[C] extends true ? never : C
}[Carrier]

/** Whether a carrier's equality is no identity (NonIdentityCarrier). */
export const isNonIdentity = (carrier: Carrier): carrier is NonIdentityCarrier =>
	!equalityIsIdentityOf[carrier]

/**
 * A type's carrier where its equality is no identity (equalityIsIdentityOf), a contract's its base's; undefined for a
 * type whose equality is identity. The one fact of it: what a merge and a navigation deliver of a term several equal
 * values may stand for (scalar/compute/registry.ts canonicalSpec), and wherever an equality is read as fixing a value,
 * read it.
 */
export const nonIdentityCarrierOf = (t: ScalarType): NonIdentityCarrier | undefined => {
	const carrier = baseOf(t).carrier
	return isNonIdentity(carrier) ? carrier : undefined
}

/** Whether a type's equality is identity (nonIdentityCarrierOf). */
export const equalityIsIdentity = (t: ScalarType): boolean => nonIdentityCarrierOf(t) === undefined

/** The capabilities of a descriptor, a contract's its base's. */
export const capsOf = (t: ScalarType): CapabilitySet => baseOf(t).caps

/** The text refinement of a text descriptor, a contract's its base's. */
export const textOf = (t: ScalarType): TextInfo | undefined => {
	const b = baseOf(t)
	return b.carrier === "text" ? b.text : undefined
}

/** The regex reference of a type's text refinement (regexOf), through any depth of contracts: none for every other type. */
export const regexRefOf = (t: ScalarType): RegexRef | undefined => {
	const text = textOf(t)
	return text === undefined ? undefined : regexOf(text)
}

/** The bounds a text descriptor's refinement proves on every value (textInfoBounds); none for any other type. */
export const textBoundsOf = (t: ScalarType): TextBounds | undefined => {
	const text = textOf(t)
	return text === undefined ? undefined : textInfoBounds(text)
}

/** The roster of a closed id or of a set over a roster, a contract's its base's. */
export const rosterOf = (t: ScalarType): Roster | undefined => {
	const b = baseOf(t)
	return b.carrier === "code" || b.carrier === "bits" ? b.roster : undefined
}

/** The arm of `variant` its handle tags; none for a handle no arm of it holds. */
export const armAt = (variant: VariantInfo, handle: string): VariantArm | undefined =>
	variant.arms.find((arm) => arm.handle === handle)

/** Whether `handles` are live handles of `roster`, each once, in its order: every one of them or some. */
export const inRosterOrder = (roster: Roster, handles: ReadonlyArray<string>): boolean =>
	sameOrder(
		roster.handles.filter((handle) => handles.includes(handle)),
		handles
	)

/**
 * Whether `only` is a subset of `roster`'s handles as a closed id holds one (CodeType): live handles of the roster,
 * each once, in its order, short of every handle, so one subset has one spelling.
 */
export const isRosterSubset = (roster: Roster, only: NonEmptyReadonlyArray<string>): boolean =>
	only.length < roster.handles.length && inRosterOrder(roster, only)

/**
 * The subset of its roster's handles a variant holds, as a closed id of its tag holds it (CodeType `only`): its arms'
 * handles, in the roster's order; none where its arms name every handle.
 */
export const variantOnly = (variant: VariantInfo): NonEmptyReadonlyArray<string> | undefined =>
	variant.arms.length === variant.roster.handles.length
		? undefined
		: mapNonEmpty(variant.arms, (arm) => arm.handle)

/**
 * The subset of its roster's handles a closed id holds, read through its contracts: none for a closed id of every
 * handle, and for every other type.
 */
export const onlyOf = (t: ScalarType): NonEmptyReadonlyArray<string> | undefined => {
	const base = baseOf(t)
	return base.carrier === "code" ? base.only : undefined
}

/** The range carrier of a span descriptor. */
export const spanCarrierOf = (t: ScalarType): SpanCarrier | undefined =>
	t.carrier === "range4" || t.carrier === "range8" || t.carrier === "rangeDate"
		? t.carrier
		: undefined

/** Whether a carrier is a span's. */
export const isSpanCarrier = (carrier: Carrier): carrier is SpanCarrier =>
	carrier === "range4" || carrier === "range8" || carrier === "rangeDate"

/** The span of a range descriptor, a contract's its base's. */
export const spanOf = (t: ScalarType): SpanInfo | undefined => {
	const b = baseOf(t)
	return b.carrier === "range4" || b.carrier === "range8" || b.carrier === "rangeDate"
		? b.span
		: undefined
}

/**
 * The typmod of a numeric descriptor, numeric(p, s), a contract's its base's; undefined for numeric of no typmod and
 * every other carrier.
 */
export const numericTypmodOf = (t: ScalarType): NumericTypmod | undefined => {
	const b = baseOf(t)
	return b.carrier === "numeric" ? b.typmod : undefined
}

/**
 * The typmod of a type whose values are integers held as bigints, numeric(p, 0) (isIntegerTypmod), a contract over one
 * among them; none for every other type.
 */
export const integerTypmodOf = (t: ScalarType): NumericTypmod | undefined => {
	const typmod = numericTypmodOf(t)
	return typmod !== undefined && isIntegerTypmod(typmod) ? typmod : undefined
}

/** The typmod of a vector descriptor, vector(n), a contract's its base's. */
export const vectorTypmodOf = (t: ScalarType): VectorTypmod | undefined => {
	const b = baseOf(t)
	return b.carrier === "vector" ? b.typmod : undefined
}

/** The digit bound of an exact descriptor; undefined for every other carrier. */
export const exactDigitsOf = (t: ScalarType): number | undefined =>
	t.carrier === "exactInteger" || t.carrier === "exactMoney" ? t.digits : undefined

/**
 * The bound of numeric of no typmod, a contract's its base's: a computed numeric's proved one, numeric's numeric's
 * own limits; undefined for numeric(p, s) and every other carrier.
 */
export const numericBoundOf = (t: ScalarType): NumericBound | undefined => {
	const b = baseOf(t)
	return b.carrier === "numeric" && b.typmod === undefined ? b.bound : undefined
}

/** One list of patterns: each member's source and flags, in order. */
export const samePatterns = (a: Patterns, b: Patterns): boolean =>
	a === b ||
	(a.length === b.length &&
		a.every((p, i) => {
			const q = b[i]
			return q !== undefined && p.source === q.source && p.flags === q.flags
		}))

/** One text refinement: the wildcard, the patterns' text, or one list of patterns of one language's key. */
const sameText = (a: TextInfo, b: TextInfo): boolean =>
	typeof a === "string" || typeof b === "string"
		? a === b
		: samePatterns(a.patterns, b.patterns) && a.key === b.key

/** One subset of a roster's handles, each in the roster's order (isRosterSubset), or every handle for both. */
export const sameSubset = (
	a: NonEmptyReadonlyArray<string> | undefined,
	b: NonEmptyReadonlyArray<string> | undefined
): boolean => (a === undefined || b === undefined ? a === b : sameOrder(a, b))

/** One roster: its name, its order and its handles in order, by their digest, as its canonical form states them. */
const sameRoster = (a: Roster, b: Roster): boolean =>
	a.closed === b.closed && a.order === b.order && a.digest === b.digest

/**
 * One variant: its declared name, its roster, and its arms, each of one handle and one list of fields, each of one name
 * and one type.
 */
const sameVariant = (a: VariantInfo, b: VariantInfo): boolean =>
	a === b ||
	(a.name === b.name &&
		sameRoster(a.roster, b.roster) &&
		a.arms.length === b.arms.length &&
		a.arms.every((arm, i) => {
			const other = b.arms[i]
			return (
				other !== undefined &&
				arm.handle === other.handle &&
				arm.fields.length === other.fields.length &&
				arm.fields.every((f, j) => {
					const g = other.fields[j]
					return g !== undefined && f.name === g.name && sameScalarType(f.type, g.type)
				})
			)
		}))

/**
 * Two plain types of one carrier and capability set are one where their carrier's fields are: its numeric typmod or
 * computed bound, its vector dimensions, a search document's configuration, its exact digit bound, its text refinement
 * (patterns and language key), its roster or its span.
 */
const samePlain = (a: PlainType, b: PlainType): boolean => {
	if (a.carrier !== b.carrier || !sameOrder(a.caps, b.caps)) {
		return false
	}
	switch (a.carrier) {
		case "numeric":
			if (b.carrier !== "numeric") {
				return false
			}
			if (a.typmod === undefined || b.typmod === undefined) {
				return (
					a.typmod === undefined &&
					b.typmod === undefined &&
					a.bound.digits === b.bound.digits &&
					a.bound.scale === b.bound.scale
				)
			}
			return a.typmod.precision === b.typmod.precision && a.typmod.scale === b.typmod.scale
		case "vector":
			return b.carrier === "vector" && a.typmod.dims === b.typmod.dims
		case "tsvector":
			return b.carrier === "tsvector" && a.configuration === b.configuration
		case "exactInteger":
		case "exactMoney":
			return (b.carrier === "exactInteger" || b.carrier === "exactMoney") && a.digits === b.digits
		case "text":
			return b.carrier === "text" && sameText(a.text, b.text)
		case "code":
			return b.carrier === "code" && sameRoster(a.roster, b.roster) && sameSubset(a.only, b.only)
		case "bits":
			return b.carrier === "bits" && sameRoster(a.roster, b.roster)
		case "variant":
			return b.carrier === "variant" && sameVariant(a.variant, b.variant)
		case "range4":
		case "range8":
		case "rangeDate":
			return (
				(b.carrier === "range4" || b.carrier === "range8" || b.carrier === "rangeDate") &&
				a.span.width === b.span.width &&
				sameScalarType(a.span.endpoint, b.span.endpoint)
			)
		case "int2":
		case "int4":
		case "int8":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "inet":
		case "cidr":
		case "bytes":
		case "sha256":
			return true
	}
}

/**
 * Type identity: two plain types field by field (samePlain), and two contracts by their identity, their names and
 * bases, whatever predicate either carries, a contract and a plain type never one. Source locations never appear
 * inside a descriptor.
 */
export const sameScalarType = (a: ScalarType, b: ScalarType): boolean =>
	a === b ||
	(a.contract === undefined || b.contract === undefined
		? a.contract === undefined && b.contract === undefined && samePlain(a, b)
		: a.carrier === b.carrier &&
			a.contract.name === b.contract.name &&
			sameScalarType(a.contract.base, b.contract.base))

/**
 * A type without the refinement its column's domain alone enforces, which the TypeScript type of its values leaves
 * unnamed: a text's pattern and byte bound, leaving the text of every value. Every other part of a type is its values'
 * own: a contract, natural among them, whose identity the field classes keep (analysis/theory/classes.ts), a numeric
 * typmod, which rounds, an integer width, a roster, a span's endpoint and width, and a vector's dimensions.
 *
 * A value enters a stored column of type `t` at `enteredType(t)`, whoever writes it, the caller, PostgreSQL's generation
 * or grizzle's fill, and the column's domain refuses one outside `t`, an outcome on that pattern's rule.
 */
export const enteredType = (t: ScalarType): ScalarType =>
	t.carrier === "text" && t.contract === undefined && t.text !== "wildcard"
		? Object.freeze({ ...t, text: "wildcard" })
		: t

/**
 * Subsumption: every value of `sub` is a value of `sup` as it stands, so an expression of `sub` stands wherever `sup` is
 * asked for, with no node of its own: `sup` is `sub` itself, an ancestor along `sub`'s contract chain (a domain's base,
 * or a wider contract it refines), or the text a refined text refines (enteredType: the text of a pattern or a byte
 * bound). PostgreSQL compares a domain's value as its base's, relabelled where it matches an index, so a cast up to
 * such a `sup` is no conversion and the IR builds none (ir/expr.ts builtExpr), where it hid the stored column from
 * every walk that reads a comparison's columns: metis carryEnter's `stage: Type.base(number)`, and every foreign key
 * law's anti-join over a child column of a domain. A narrowing from `sup` down to `sub` stays a cast, its domain the
 * judge.
 */
export const subsumes = (sup: ScalarType, sub: ScalarType): boolean => {
	for (let t: ScalarType | undefined = sub; t !== undefined; t = t.contract?.base) {
		if (sameScalarType(sup, t) || sameScalarType(sup, enteredType(t))) {
			return true
		}
	}
	return false
}

/**
 * Whether two types differ only in what a column's domain enforces (enteredType): a value of either enters a stored
 * column of the other, its domain the judge.
 */
const sameEnteredType = (a: ScalarType, b: ScalarType): boolean =>
	sameScalarType(enteredType(a), enteredType(b))

/** The type of every handle of a closed id's roster, for a closed id of a subset; every other type as it is. */
const everyHandle = (t: ScalarType): ScalarType =>
	t.contract === undefined && t.carrier === "code" && t.only !== undefined
		? Object.freeze({ ...t, only: undefined })
		: t

/**
 * Whether an exact value enters an exact column of its carrier: the column's digit bound at least the value's, as an
 * exact field's, at numeric's own limit (scalar/exact.ts), is every exact value's of its carrier, so integer or money
 * arithmetic of any bound is written into it as it is.
 */
const withinExact = (column: ScalarType, value: ScalarType): boolean =>
	isExactValue(column) &&
	isExactValue(value) &&
	column.carrier === value.carrier &&
	sameOrder(column.caps, value.caps) &&
	value.digits <= column.digits

/**
 * Whether a value of type `value` enters a stored column of type `column` at the column's own type, as a caller's value,
 * a generated field's term, a fold's step and a member's column do: one type but for what the column's domain enforces
 * (sameEnteredType) and a closed id's subset, the value's handles every one the column holds (onlyOf), so a closed id of
 * a subset enters a column of a wider subset of its roster or of the whole roster, and one of the whole roster no column
 * of a subset, which no value of it is proved to keep to; and an exact value of its carrier within the column's digit
 * bound (withinExact).
 */
export const entersColumn = (column: ScalarType, value: ScalarType): boolean =>
	(sameEnteredType(everyHandle(column), everyHandle(value)) || withinExact(column, value)) &&
	subsetWithin(column, value)

/**
 * Whether every handle a value of type `value` can be is one a closed id of type `target` holds (onlyOf): always where
 * the target holds every handle, and otherwise exactly where the value's type is of a subset within the target's. A
 * closed id of the whole roster is within no subset, so a value of a subset comes from a value of that subset alone:
 * the one rule a stored column, a generated field, a made value's field and a cast hold a value's handles to.
 */
export const subsetWithin = (target: ScalarType, value: ScalarType): boolean => {
	const held = onlyOf(target)
	const given = onlyOf(value)
	return held === undefined || given?.every((h) => held.includes(h)) === true
}

/**
 * Whether a value of this type is refined beyond its base: a contract, or text with a specific pattern. A comparison
 * parameter is never cast to such a type.
 */
export const isRefined = (t: ScalarType): boolean => {
	const text = textOf(t)
	return t.contract !== undefined || (text !== undefined && regexOf(text) !== undefined)
}

/** Whether a field of type `t` is a float, which a variant's layout gives a zero-sign attribute (ir/codes.ts FieldLayout). */
export const isFloatType = (t: ScalarType): boolean => {
	const carrier = baseOf(t).carrier
	return carrier === "float4" || carrier === "float8"
}

/**
 * Whether a value of this type is held to a domain beyond its base's values, which the host judges as PostgreSQL's
 * domain does (scalar/compute/evaluate.ts membership): a refined type's contract and patterns, and a variant's domain,
 * which holds its tagged arm's fields each to its own type and the arm's check. Every admission and decode of a row on
 * the host judges exactly these fields.
 */
export const isJudged = (t: ScalarType): boolean => isRefined(t) || baseOf(t).carrier === "variant"

/** Each carrier's PostgreSQL type name, which typeLabel prints for a carrier of no parameters. */
export const nativeNames = {
	int2: "smallint",
	int4: "integer",
	int8: "bigint",
	numeric: "numeric",
	float4: "real",
	float8: "double precision",
	money: "money",
	bool: "boolean",
	uuid: "uuid",
	date: "date",
	inet: "inet",
	cidr: "cidr",
	text: "text",
	bytes: "bytea",
	sha256: "bytea",
	code: "smallint",
	bits: "bit",
	range4: "int4range",
	range8: "int8range",
	rangeDate: "daterange",
	vector: "vector",
	tsvector: "tsvector",
	exactInteger: "numeric",
	exactMoney: "numeric",
	variant: "record"
} as const satisfies { readonly [C in Carrier]: string }

/**
 * A text refinement as diagnostics name it: its patterns, and the byte bound str.bytes cuts it to, as
 * "text ~ /^[a-z]+$/u", "text ~ /^[a-z]+$/u & /^.{0,8}$/su" or "text ~ /^.*$/su of at most 64 bytes".
 */
const refinementText = (regex: RegexRef): string => {
	const octets = octetsOf(regex.check)
	return `text ~ ${patternsText(regex.patterns)}${octets === undefined ? "" : ` of at most ${octets} bytes`}`
}

/**
 * A short human label for printing and diagnostics, never emitted SQL (the physical package owns domain identifiers):
 * "numeric(10,2)", "contract Cents over bigint", "code Kind", "bits Kind", "text ~ /^[a-z]+$/u".
 */
export const typeLabel = (t: ScalarType): string => {
	if (t.contract !== undefined) {
		return `domain ${t.contract.name} over ${typeLabel(t.contract.base)}`
	}
	switch (t.carrier) {
		case "int2":
		case "int4":
		case "int8":
			return nativeNames[t.carrier]
		case "numeric":
			return t.typmod === undefined
				? `numeric of ${t.bound.digits} integer and ${t.bound.scale} fraction digits`
				: `numeric(${t.typmod.precision},${t.typmod.scale})`
		case "vector":
			return `vector(${t.typmod.dims})`
		case "tsvector":
			return `tsvector ${t.configuration}`
		case "code": {
			const code = `${rosterCodeLabels[t.roster.order]} ${t.roster.closed}`
			return t.only === undefined ? code : `${code} of ${t.only.join(", ")}`
		}
		case "bits":
			return `bits ${t.roster.closed}`
		case "variant":
			return `variant ${t.variant.name}`
		case "text": {
			return t.text === "wildcard"
				? "text"
				: t.text === "pattern"
					? "pattern"
					: refinementText(t.text)
		}
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "inet":
		case "cidr":
		case "bytes":
		case "range4":
		case "range8":
		case "rangeDate":
			return nativeNames[t.carrier]
		case "sha256":
			return "sha256 digest"
		case "exactInteger":
			return `exact integer of ${t.digits} digits`
		case "exactMoney":
			return `exact money of ${t.digits} digits`
	}
}
