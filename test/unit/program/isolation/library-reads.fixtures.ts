/** What library-reads.test.ts reads: its drawn login, compiled for READ COMMITTED as generate compiles it. */

import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Crypto, Fn } from "#compiler/public/compute.ts"
import { generated, pg, sha256 } from "#compiler/public/fields.ts"
import { query } from "#compiler/public/query.ts"
import { fn, login, relation, role, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { workload } from "#compiler/public/workload.ts"
import { changeLogin } from "#test/support/change-login.ts"

/** Where R's primary key holds its digest h of its text p, beside its caller field b, or holds b alone. */
export type Primary = "(b, h)" | "(h, b)" | "(h)" | "(b)"

/** A case: R's primary key, and whether the write computes R's field d by a declared function of the schema. */
export interface Drawn {
	readonly primary: Primary
	readonly declared: boolean
}

/** A text of any length, which no key may hold: what a digest stands for in a key. */
const Path = str.regex("^.*$", "su")

/** Each primary key a case draws. */
const primaries = ["(b, h)", "(h, b)", "(h)", "(b)"] as const satisfies ReadonlyArray<Primary>

export const drawnGen: Gen<Drawn> = (source) => ({
	primary: source.draw(element(primaries)),
	declared: source.draw(boolean)
})

/** A declared function of the schema: one installed under its function owner (physical/ddl/functions.ts). */
const doubled = fn("doubled", {
	calls: [],
	args: { x: pg.integer },
	returns: pg.integer,
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT $1 * 2`
})

/**
 * The login of a case as its change members compile (test/support/change-login.ts changeLogin): R(b, p, d, h = Crypto.sha256(p)) keyed as `primary` says, which its writes compute by grizzle's text
 * digest (physical/ddl/library.ts textDigest), and one role inserting it from its parameters, d the declared function
 * `doubled` of b where `declared` holds and b itself otherwise, compiled with no database over the artifacts its served
 * file compiles over.
 */
export const digestLoginOf = ({ primary, declared }: Drawn) => {
	const R = relation.generated(
		"R",
		{ b: pg.integer, p: Path, d: pg.integer },
		primary === "(b, h)"
			? ["b", "h"]
			: primary === "(h, b)"
				? ["h", "b"]
				: primary === "(h)"
					? ["h"]
					: ["b"],
		(row) => ({ h: generated(sha256, Crypto.sha256(row.p)) })
	)
	const Digests = schema("LibraryReads", [R, doubled], [])
	const writer = role(Digests, "writer", { R }, { insert: ["R"] })
	const add = ChangeSet.empty(writer).insert(
		writer.relations.R,
		query(writer).rule((r) => {
			const b = r.param("b", pg.integer)
			return r.find({ b, p: r.param("p", Path), d: declared ? Fn.call(doubled, { x: b }) : b })
		})
	)
	const value = login(Digests, "app", [writer], { workload: [workload(writer, { add })] })
	return changeLogin(value)
}
