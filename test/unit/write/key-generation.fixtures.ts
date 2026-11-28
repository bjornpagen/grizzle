/** What the property of key-generation.test.ts reads: its box, the schemas over it and the rules it restates. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Predicate, Record } from "effect"
import { Crypto } from "#compiler/public/compute.ts"
import { generated, sha256, int4 } from "#compiler/public/fields.ts"
import { mutable, relation, schema, unit } from "#compiler/public/schema.ts"
import type { KeyValues } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryOver as query, type QueryValue, varsOver as v } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import type { PutChoice } from "#compiler/write/put/choose.ts"

/** Where R's primary key holds its key generation h, a digest of its text p, beside its caller field b. */
export type Primary = "(b, h)" | "(h, b)" | "(h)"

/** How the ChangeSet writes R, in one stratum: a put of R's own facts, alone or beside a deletion, an enumerated put, or
 * an insert of facts a query computes. */
export type Form = "own facts" | "own facts beside a deletion" | "enumerated" | "computed insert"

/** A text of any length, which no key may hold: what a key generation digests. */
const Path = str.regex("^.*$", "su")

/**
 * R(b, p, x, h = Crypto.sha256(p)), keyed as `primary` says: keyed by (b, h), mutable inside the unit of its b; keyed by
 * its digest first, closed, since no unit's heading holds a field grizzle writes. S(b, p, x), the source a computed insert
 * reads.
 */
export const schemaOf = (primary: Primary) => {
	const R = relation.generated(
		"R",
		{ b: int4, p: Path, x: int4 },
		primary === "(b, h)" ? ["b", "h"] : primary === "(h, b)" ? ["h", "b"] : ["h"],
		(row) => ({ h: generated(sha256, Crypto.sha256(row.p)) })
	)
	const S = relation("S", { b: int4, p: Path, x: int4 }, ["b"])
	return {
		R,
		S,
		s: schema("Keyed", [R, S], primary === "(b, h)" ? [unit("Bs", { b: int4 }), mutable(R)] : [])
	}
}

type Schema = ReturnType<typeof schemaOf>

/** Every stored fact of R, its x set to 1: a put whose every key is a stored fact's, its member stating no h. */
const ownFacts = ({ R, s }: Schema): QueryValue =>
	query(s).rule((r: RuleValue) => {
		const { b, p, x } = v(R, "stored")
		return r.match(R, { b, p, x }).find({ b, p, x: 1 })
	})

/** Every stored fact of R with x = 0. */
const zeroFacts = ({ R, s }: Schema): QueryValue =>
	query(s).rule((r: RuleValue) => {
		const { b, p } = v(R, "stored")
		return r.match(R, { b, p, x: 0 }).find({ b, p, x: 0 })
	})

/** Every fact of S, as a fact of R: an insert its member states no h of. */
const fromSource = ({ S, s }: Schema): QueryValue =>
	query(s).rule((r: RuleValue) => {
		const { b, p, x } = v(S, "source")
		return r.match(S, { b, p, x }).find({ b, p, x })
	})

/**
 * A general query over R stating its text alone, `p = $p`: no key read, so it compares what its author states and no
 * more, a filter, never a probe of the digest key the text would generate.
 */
export const textOnly = ({ R, s }: Schema): QueryValue =>
	query(s).rule((r: RuleValue) => {
		const { b, p, x, h } = v(R, "stored")
		return r
			.match(R, { b, p, x, h })
			.where(r.eq(p, r.param("p", Path)))
			.find({ b, p, x, h })
	})

/** The comparisons a description holds, at any depth: each node whose kind is "compare". */
export const comparesIn = (value: unknown): number => {
	if (Arr.isArray(value)) {
		return Arr.reduce(value, 0, (n: number, item: unknown) => n + comparesIn(item))
	}
	if (!Predicate.isObject(value)) {
		return 0
	}
	const own = value["kind"] === "compare" ? 1 : 0
	return Arr.reduce(Record.values(value), own, (n: number, item: unknown) => n + comparesIn(item))
}

/** The ChangeSet of a form, R's first write first. */
export const changeSetOf = (schema: Schema, form: Form) => {
	const empty = ChangeSet.empty(schema.s)
	switch (form) {
		case "own facts":
			return empty.put(schema.R, ownFacts(schema))
		case "own facts beside a deletion":
			return empty.put(schema.R, ownFacts(schema)).delete(schema.R, zeroFacts(schema))
		case "enumerated":
			return empty.put(schema.R, [{ b: 1, p: "a/b", x: 1 }])
		case "computed insert":
			return empty.insert(schema.R, fromSource(schema))
	}
}

/** The statement a put lowers to, and why. */
export interface Choice {
	readonly target: PutChoice["target"]
	readonly reason: PutChoice["reason"]
}

/** A form's feature: the statement its put lowers to, or the insert. */
export type KeyFeature = `${PutChoice["target"]} (${PutChoice["reason"]})` | "computed insert"

/**
 * The statement a put of a form lowers to under a key generation, restated from write/put/choose.ts's rules as they
 * read a key of written fields (test/unit/write/put/choose.fixtures.ts expectedOf): R's own facts are an UPDATE ... FROM,
 * their key proved a stored fact's through the fields its generation reads, unless a deletion beside them leaves the
 * UPDATE no row; an enumerated put is ON CONFLICT DO UPDATE.
 */
export const expectedOf = (form: Exclude<Form, "computed insert">): Choice => {
	switch (form) {
		case "own facts":
			return { target: "updateFrom", reason: "existingKeys" }
		case "own facts beside a deletion":
			return { target: "deleteThenInsert", reason: "unproved" }
		case "enumerated":
			return { target: "onConflictDoUpdate", reason: "enumerated" }
	}
}

const forms: Arr.NonEmptyReadonlyArray<Form> = [
	"own facts",
	"own facts beside a deletion",
	"enumerated",
	"computed insert"
]

/**
 * A case: R keyed by (b, h), mutable, under every form; or keyed by its digest first, closed, written by the computed
 * insert alone, its facts inserted and never changed or deleted.
 */
export type KeyCase =
	| { readonly primary: "(b, h)"; readonly form: Form }
	| { readonly primary: "(h, b)" | "(h)"; readonly form: "computed insert" }

export const caseGen: Gen<KeyCase> = (source) => {
	const primary = source.draw(element<Primary>(["(b, h)", "(h, b)", "(h)"]))
	return primary === "(b, h)"
		? { primary, form: source.draw(element(forms)) }
		: { primary, form: "computed insert" }
}

/**
 * What a caller states to name a fact of R by its key, R keyed by (b, h) (types/schema/statements.ts KeyValues): its
 * key heads, b and p, the text h is generated from, never the digest. A record over exactly those keys is a record of
 * them: a missing head or one more, h among them, is a type error, so the type checker holds it, and each case reads it.
 */
export const keyHeadsOfR: Readonly<
	Record<keyof KeyValues<ReturnType<typeof schemaOf>["R"]>, true>
> = {
	b: true,
	p: true
}
