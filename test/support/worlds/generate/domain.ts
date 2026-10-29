import { Array as Arr, Option, pipe, Record as Rec, String as Str } from "effect"
import { hostSpan, isSpan } from "#test/pg/laws/families/model.ts"
import { literalDefault } from "#test/support/worlds/model/host.ts"
import type {
	BaseSpec,
	FieldDomain,
	FieldSpec,
	HeadTerm,
	Occurrence,
	Rule,
	HostValue
} from "#test/support/worlds/model/types.ts"

import { regex } from "arkregex"
/** A list known to hold at least one element, or a defect of the harness naming what was empty. */
export const knownNonEmpty = <A>(
	items: ReadonlyArray<A>,
	what: string
): Arr.NonEmptyReadonlyArray<A> => {
	if (Arr.isReadonlyArrayNonEmpty(items)) {
		return items
	}
	throw new Error(`${what}: none`)
}

/** Whether two domains are one: values of one are values of the other, and a rule may equate their fields. */
export const sameDomain = (a: FieldDomain, b: FieldDomain): boolean => {
	switch (a.kind) {
		case "uuid":
		case "boolean":
			return b.kind === a.kind
		case "text":
			return b.kind === "text" && b.pattern === a.pattern && b.flags === a.flags
		case "integer":
			return b.kind === "integer" && b.bits === a.bits
		case "serial":
			return b.kind === "serial" && b.bits === a.bits
		case "handle":
			return b.kind === "handle" && b.closed === a.closed
		case "span":
			return b.kind === "span" && b.bits === a.bits
		case "contract":
			return b.kind === "contract" && b.name === a.name
	}
}

/** Whether a domain holds integers: an integer, a serial, or a contract over an integer type. */
export const isIntegerDomain = (domain: FieldDomain): boolean =>
	domain.kind === "integer" || domain.kind === "serial" || domain.kind === "contract"

/** Whether a domain holds 64-bit integers, which a claim may spell as a string of digits. */
export const isInt8Domain = (domain: FieldDomain): boolean =>
	(domain.kind === "integer" || domain.kind === "contract") && domain.bits === 64

/** The greatest integer of a field of `bits` bits that a host number states exactly. */
const greatestOf = (bits: 16 | 32 | 64): number =>
	bits === 16 ? 32_767 : bits === 32 ? 2_147_483_647 : Number.MAX_SAFE_INTEGER

const uuidPattern = regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

/** Whether a value belongs to a domain, as a base declares it: the harness's own check of what it draws as live. */
export const inDomain = (domain: FieldDomain, value: HostValue): boolean => {
	switch (domain.kind) {
		case "uuid":
			return typeof value === "string" && uuidPattern.test(value)
		case "text":
			return typeof value === "string" && regex.as(domain.pattern, domain.flags).test(value)
		case "integer":
			return (
				typeof value === "number" &&
				Number.isInteger(value) &&
				Math.abs(value) <= greatestOf(domain.bits)
			)
		case "serial":
			return (
				typeof value === "number" &&
				Number.isInteger(value) &&
				value >= 1 &&
				value <= greatestOf(domain.bits)
			)
		case "boolean":
			return typeof value === "boolean"
		case "handle":
			return typeof value === "string" && domain.members.includes(value)
		case "contract":
			return (
				typeof value === "number" &&
				Number.isInteger(value) &&
				value >= domain.min &&
				value <= domain.max
			)
		case "span":
			return (
				isSpan(value) &&
				Number.isInteger(value.start) &&
				Number.isInteger(value.end) &&
				value.start < value.end &&
				Math.abs(value.start) <= greatestOf(domain.bits) &&
				Math.abs(value.end) <= greatestOf(domain.bits)
			)
	}
}

/**
 * The uuids of the pools: distinct tokens of one shape no message spells by accident, so a search of an error's text
 * for a hidden one finds it only where the value itself was written.
 */
export const uuidToken = (n: number): string =>
	`${pipe((0x5eed_a000 + n * 0x0101).toString(16), Str.padStart(8, "0"))}-7c3e-4a1b-9d2f-0e5c7a9b3d1f`

/** The small integers every integer pool holds, straddling the literals the installs compare with. */
const smallIntegers: Arr.NonEmptyReadonlyArray<number> = [0, 1, 2, 3, 4, 5, 6, 7]

/** The serial values a pool holds: facts take distinct ones of them, so stored serials keep gaps. */
const serials: Arr.NonEmptyReadonlyArray<number> = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

/** Every span of small endpoints: a start in 0..4 and a width of 1..3. */
const smallSpans: Arr.NonEmptyReadonlyArray<HostValue> = knownNonEmpty(
	Arr.flatMap([0, 1, 2, 3, 4], (start) =>
		Arr.map([1, 2, 3], (width) => hostSpan(start, start + width))
	),
	"the span pool"
)

/** A domain's canonical text: one per domain, so two fields of one domain have one key. */
export const domainKey = (domain: FieldDomain): string => {
	switch (domain.kind) {
		case "uuid":
		case "boolean":
			return domain.kind
		case "text":
			return `text/${domain.pattern}/${domain.flags}`
		case "integer":
		case "serial":
		case "span":
			return `${domain.kind}${domain.bits}`
		case "handle":
			return `handle/${domain.closed}`
		case "contract":
			return `contract/${domain.name}`
	}
}

/**
 * The pool of a domain: one per domain, shared by every field and context field of it, so a fact's subject is a
 * claim's subject and a reference meets its target. A text domain carries its own, drawn as it was built (model/text.ts
 * textDomain).
 */
export const pool = (domain: FieldDomain): Arr.NonEmptyReadonlyArray<HostValue> => {
	switch (domain.kind) {
		case "uuid":
			return [uuidToken(1), uuidToken(2), uuidToken(3), uuidToken(4)]
		case "text":
			return domain.pool
		case "integer":
			return smallIntegers
		case "serial":
			return serials
		case "boolean":
			return [false, true]
		case "handle":
			return domain.members
		case "span":
			return smallSpans
		case "contract":
			return contractPool(domain.min, domain.max)
	}
}

/** A contract's pool: its bounds and the values just inside them, every one within [min, max]. */
const contractPool = (min: number, max: number): Arr.NonEmptyReadonlyArray<HostValue> =>
	knownNonEmpty(
		[...new Set([min, Math.min(max, min + 1), Math.max(min, max - 1), max])],
		"a contract's pool"
	)

/** The values just outside a contract's bounds: what its DOMAIN's CHECK refuses. */
export const outsideContract = (domain: FieldDomain): ReadonlyArray<HostValue> =>
	domain.kind === "contract" ? [domain.min - 1, domain.max + 1] : []

/**
 * The value just past a 16- or 32-bit integer type's range, of an integer field or a contract over one: what grizzle's
 * encoder refuses before any SQL. A 64-bit type's range ends past every number a host value states exactly.
 */
export const pastType = (domain: FieldDomain): ReadonlyArray<HostValue> =>
	(domain.kind === "integer" || domain.kind === "contract") && domain.bits !== 64
		? [greatestOf(domain.bits) + 1]
		: []

/** The pool value a draw selects: draws shrink toward the first value. */
export const pooled = (domain: FieldDomain, n: number): HostValue => {
	const values = pool(domain)
	const value = values[n % values.length]
	if (value === undefined) {
		throw new Error("a pool index outside its pool")
	}
	return value
}

/** The one field a closed roster holds as a relation: its handle. */
export const closedField = "id"

/** The fields of a relation-valued source of a base: an ordinary relation's, a closed roster's handle, a derived head. */
export const fieldsOfSource = (base: BaseSpec, name: string): ReadonlyArray<FieldSpec> =>
	pipe(
		Arr.findFirst(base.relations, (r) => r.name === name),
		Option.map((r): ReadonlyArray<FieldSpec> => r.fields),
		Option.orElse(() =>
			Option.map(
				Arr.findFirst(base.closed, (c) => c.name === name),
				(roster): ReadonlyArray<FieldSpec> => [
					{
						name: closedField,
						domain: { kind: "handle", closed: roster.name, members: roster.members }
					}
				]
			)
		),
		Option.orElse(() =>
			Option.map(
				Arr.findFirst(base.derived, (d) => d.name === name),
				(derived) => derivedHeading(base, derived.rules)
			)
		),
		Option.getOrThrowWith(() => new Error(`the base ${base.name} has no relation ${name}`))
	)

const contextFieldDomain = (base: BaseSpec, context: string, field: string): FieldDomain =>
	pipe(
		Arr.findFirst(base.contexts, (c) => c.name === context),
		Option.flatMap((c) => Arr.findFirst(c.fields, (f) => f.name === field)),
		Option.map((f) => f.domain),
		Option.getOrThrowWith(
			() => new Error(`the base ${base.name} has no context field ${context}.${field}`)
		)
	)

/**
 * The domain a head term carries in its rule: a variable's, the field the first match binding it reads; a context
 * term's, its context field's; a typed handle's, its roster's; a literal carries none of its own.
 */
const headTermDomain = (
	base: BaseSpec,
	term: HeadTerm,
	matches: ReadonlyArray<Occurrence>,
	name: string
): FieldDomain | undefined => {
	switch (term.kind) {
		case "context":
			return contextFieldDomain(base, term.context, term.field)
		case "handle":
			return fieldDomainOf(base, term.closed, "id")
		case "literal":
			return undefined
		case "var":
			return pipe(
				Arr.findFirst(
					Arr.flatMap(matches, (occurrence) =>
						Arr.map(Rec.toEntries(occurrence.fields), ([field, bound]) => ({
							occurrence,
							field,
							bound
						}))
					),
					(b) => b.bound.kind === "var" && b.bound.name === term.name
				),
				Option.map(({ occurrence, field }): FieldDomain =>
					occurrence.source.kind === "context"
						? contextFieldDomain(base, occurrence.source.name, field)
						: fieldDomainOf(base, occurrence.source.name, field)
				),
				Option.getOrThrowWith(
					() =>
						new Error(
							`the head field ${name} reads the variable ${term.name}, which no match binds`
						)
				)
			)
	}
}

/**
 * A rule set's heading with its domains, as grizzle types it: each field's the first rule's term carries (headTermDomain)
 * that some rule's term carries, which every literal of the field takes; a field only literals fill, its first
 * literal's JavaScript default (model/host.ts literalDefault).
 */
export const derivedHeading = (
	base: BaseSpec,
	rules: Arr.NonEmptyReadonlyArray<Rule>
): ReadonlyArray<FieldSpec> =>
	Arr.map(Rec.toEntries(rules[0].head), ([name, first]): FieldSpec => {
		const typed = Arr.findFirst(rules, (rule) => {
			const term = rule.head[name]
			return term !== undefined && headTermDomain(base, term, rule.matches, name) !== undefined
		})
		if (Option.isSome(typed)) {
			const term = typed.value.head[name]
			const domain =
				term === undefined ? undefined : headTermDomain(base, term, typed.value.matches, name)
			if (domain !== undefined) {
				return { name, domain }
			}
		}
		const domain = first.kind === "literal" ? literalDefault(first.value) : undefined
		if (domain === undefined) {
			throw new Error(`the head field ${name} holds a value no term or JavaScript default types`)
		}
		return { name, domain }
	})

/** The domain of a field of a relation-valued source. */
const fieldDomainOf = (base: BaseSpec, source: string, field: string): FieldDomain =>
	pipe(
		Arr.findFirst(fieldsOfSource(base, source), (f) => f.name === field),
		Option.map((f) => f.domain),
		Option.getOrThrowWith(() => new Error(`the relation ${source} has no field ${field}`))
	)
