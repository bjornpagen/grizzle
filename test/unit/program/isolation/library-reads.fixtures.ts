/** What library-reads.test.ts reads: its drawn login, compiled for READ COMMITTED as generate compiles it. */

import { defined } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { artifactsOver, builtLogin, ownLoginOver } from "#adapter/served/login.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { transactionClock } from "#compiler/ir/clock.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { namedLogin } from "#compiler/physical/ddl/names.ts"
import { installBasis, unserved } from "#compiler/physical/install/plan.ts"
import { planWorkload } from "#compiler/program/workload/compile.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Crypto, Fn } from "#compiler/public/compute.ts"
import { generated, pg, sha256 } from "#compiler/public/fields.ts"
import { query } from "#compiler/public/query.ts"
import { fn, login, relation, role, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { workload } from "#compiler/public/workload.ts"
import { ownBuilt, rostersOf } from "#compiler/schema/own.ts"
import { everySlice } from "#compiler/schema/reach.ts"
import { succeeded } from "#test/support/assert.ts"

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
 * The login of a case as its change members compile (test/unit/program/isolation/extraction-once.fixtures.ts
 * fencedLoginOf): R(b, p, d, h = Crypto.sha256(p)) keyed as `primary` says, which its writes compute by grizzle's text
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
	const built = defined(builtLogin(value), "a login built by login(...)")
	const owned = succeeded(ownBuilt(built.base), "the login's base")
	const basis = succeeded(
		installBasis(owned, firstCodebook(rostersOf(owned)), everySlice(owned)),
		"the base's basis"
	)
	const checking = succeeded(artifactsOver(basis, unserved), "the base's artifacts")
	const ownedLogin = succeeded(ownLoginOver(built, owned), "the login over its base")
	const planned = succeeded(
		planWorkload(
			[{ login: ownedLogin.name, workloads: built.workload }],
			built.base,
			{ artifacts: checking, roles: ownedLogin.roles },
			silentPhases
		),
		"the login's workload plan"
	)
	const artifacts = succeeded(
		artifactsOver(basis, { kind: "planned", types: planned.plan.params }),
		"the login's artifacts"
	)
	return {
		roles: built.roles,
		workload: built.workload,
		named: succeeded(namedLogin(ownedLogin, artifacts.names.levels), "the login named"),
		artifacts,
		clock: transactionClock,
		planned: planned.frontends
	}
}
