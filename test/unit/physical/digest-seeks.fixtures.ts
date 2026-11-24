/** What digest-seeks.test.ts reads: its space, each case's schema and program, and its installation. */

import { boolean, constant, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { Crypto, Text } from "#compiler/public/compute.ts"
import { generated, pg, sha256 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { planOf } from "#test/unit/workload/fixtures.ts"
import { installWith } from "#test/unit/workload/install.fixtures.ts"

/**
 * How a case's read states its text equal to a value: a literal or a parameter its match binds the text to, an
 * equality (with a value of T's text's type or of another text type) or a membership its where states, an equality with another match's text, one variable another match binds
 * to its text, a negation's literal or parameter, or a parameter it binds the text to through a query that delivers T's
 * text, and its digest where T declares one.
 */
const forms = [
	"a literal",
	"a parameter",
	"an equality",
	"an equality of another text type",
	"a membership",
	"a joined text",
	"a shared variable",
	"a negated literal",
	"a negated parameter",
	"an imported text"
] as const

export type Form = (typeof forms)[number]

/**
 * A case: how its read binds T's text `t` by equality, whether T declares `t`'s digest `h`, and whether the read binds
 * T's key `k` besides, which reads one row.
 */
export interface DigestCase {
	readonly form: Form
	readonly digest: boolean
	readonly keyed: boolean
}

/**
 * A case of each form, sought by its digest half the time (T declares h, the read binds no key), refused a quarter (T
 * declares none) and read by its key a quarter: each form is a situation of the sought cases, so a kill of one form's
 * digest meets a case that must seek by it.
 */
export const digestCaseGen: Gen<DigestCase> = (source) => {
	const form = source.draw(element(forms))
	return source.draw(
		weighted<DigestCase>([
			[2, constant({ form, digest: true, keyed: false })],
			[1, constant({ form, digest: false, keyed: false })],
			[1, (inner) => ({ form, digest: inner.draw(boolean), keyed: true })]
		])
	)
}

/** A text of any length, which no B-tree entry holds. */
const Path = str.regex("^.*$", "su")

/** A text of another type than T's, which a parameter an equality with T's text compares is of. */
const Word = str.regex("^[a-z]{1,40}$")

/**
 * The case's schema: T(k, g, t) keyed by k, with `h = Crypto.sha256(t)` where the case declares the digest, beside a
 * generation of t that is no digest, `l = Text.lowerAscii(t)`, declared before it, and S(s, u)
 * keyed by s, whose text `u` a joined read equates with T's.
 */
const digestSchemaOf = (c: DigestCase) => {
	const T = c.digest
		? relation.generated("T", { k: pg.integer, g: pg.integer, t: Path }, ["k"], (row) => ({
				l: generated(Path, Text.lowerAscii(row.t)),
				h: generated(sha256, Crypto.sha256(row.t))
			}))
		: relation("T", { k: pg.integer, g: pg.integer, t: Path }, ["k"])
	const S = relation("S", { s: pg.integer, u: Path }, ["s"])
	return { T, S, schema: schema("DigestSeeks", [S, T], []) }
}

/** The case's one served read of T, binding T's text as its form states and its key where the case binds it. */
const programOf = (
	c: DigestCase & { readonly form: Exclude<Form, "an imported text"> },
	{ T, S, schema: Digests }: ReturnType<typeof digestSchemaOf>
) => {
	const reads = query(Digests)
	switch (c.form) {
		case "a literal":
			return reads.rule((r) => {
				const { k, g } = v(T, "t")
				return r.match(T, { k: c.keyed ? r.param("k", pg.integer) : k, g, t: "x" }).find({ g })
			})
		case "a parameter":
			return reads.rule((r) => {
				const { k, g } = v(T, "t")
				return r
					.match(T, { k: c.keyed ? r.param("k", pg.integer) : k, g, t: r.param("t", Path) })
					.find({ g })
			})
		case "an equality":
			return reads.rule((r) => {
				const { k, g, t } = v(T, "t")
				return r
					.match(T, { k: c.keyed ? r.param("k", pg.integer) : k, g, t })
					.where(r.eq(t, r.param("t", Path)))
					.find({ g })
			})
		case "an equality of another text type":
			return reads.rule((r) => {
				const { k, g, t } = v(T, "t")
				return r
					.match(T, { k: c.keyed ? r.param("k", pg.integer) : k, g, t })
					.where(r.eq(t, r.param("t", Word)))
					.find({ g })
			})
		case "a membership":
			return reads.rule((r) => {
				const { k, g, t } = v(T, "t")
				return r
					.match(T, { k: c.keyed ? r.param("k", pg.integer) : k, g, t })
					.where(r.in(t, ["x", "y"]))
					.find({ g })
			})
		case "a joined text":
			return reads.rule((r) => {
				const { k, g, t } = v(T, "t")
				const { u } = v(S, "s")
				return r
					.match(S, { s: r.param("s", pg.integer), u })
					.match(T, { k: c.keyed ? r.param("k", pg.integer) : k, g, t })
					.where(r.eq(t, u))
					.find({ g })
			})
		case "a shared variable":
			return reads.rule((r) => {
				const { k, g } = v(T, "t")
				const { u } = v(S, "s")
				return r
					.match(S, { s: r.param("s", pg.integer), u })
					.match(T, { k: c.keyed ? r.param("k", pg.integer) : k, g, t: u })
					.find({ g })
			})
		case "a negated literal":
		case "a negated parameter":
			return reads.rule((r) => {
				const { s, u } = v(S, "s")
				const t = c.form === "a negated literal" ? "x" : r.param("t", Path)
				return r
					.match(S, { s, u })
					.where(r.not(T, c.keyed ? { k: s, t } : { g: s, t }))
					.find({ s })
			})
	}
}

/**
 * The read of T's text through a query of T, `Texts`, which delivers T's text and, where T declares one, its digest
 * (Checker `digestColumns`): the read binds the query's text to a parameter, and its key where the case binds it.
 */
const importedRead = (c: DigestCase) => {
	const S = relation("S", { s: pg.integer, u: Path }, ["s"])
	if (c.digest) {
		const T = relation.generated("T", { k: pg.integer, g: pg.integer, t: Path }, ["k"], (row) => ({
			l: generated(Path, Text.lowerAscii(row.t)),
			h: generated(sha256, Crypto.sha256(row.t))
		}))
		const Digests = schema("DigestSeeks", [S, T], [])
		const Texts = query(Digests).rule((r) => {
			const { k, g, t, h } = v(T, "t")
			return r.match(T, { k, g, t, h }).find({ k, g, t, h })
		})
		const read = query(Digests).rule((r) => {
			const { k, g } = v(Texts, "text")
			return r
				.match(Texts, { k: c.keyed ? r.param("k", pg.integer) : k, g, t: r.param("t", Path) })
				.find({ g })
		})
		return installWith(Digests, planOf(Digests, { read }))
	}
	const T = relation("T", { k: pg.integer, g: pg.integer, t: Path }, ["k"])
	const Digests = schema("DigestSeeks", [S, T], [])
	const Texts = query(Digests).rule((r) => {
		const { k, g, t } = v(T, "t")
		return r.match(T, { k, g, t }).find({ k, g, t })
	})
	const read = query(Digests).rule((r) => {
		const { k, g } = v(Texts, "text")
		return r
			.match(Texts, { k: c.keyed ? r.param("k", pg.integer) : k, g, t: r.param("t", Path) })
			.find({ g })
	})
	return installWith(Digests, planOf(Digests, { read }))
}

/** The installation of the case's schema with its read as the workload's one program. */
export const installDigestCase = (c: DigestCase) => {
	if (c.form === "an imported text") {
		return importedRead(c)
	}
	const built = digestSchemaOf(c)
	return installWith(
		built.schema,
		planOf(built.schema, { read: programOf({ ...c, form: c.form }, built) })
	)
}
