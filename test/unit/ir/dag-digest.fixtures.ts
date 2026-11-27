/** What the properties of dag-digest.test.ts read: its spaces, models and helpers. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { codePoint, element, type Gen, int, string } from "@bjornpagen/testing/gen"
import { Record as Rec } from "effect"
import { encode, omitSourceLocs } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { digest } from "#compiler/core/fingerprint.ts"
import { makeIdSupply } from "#compiler/core/ids.ts"
import { derivationForm, type TableOuterNames } from "#compiler/ir/dag-digest.ts"
import { normalizeReach } from "#compiler/ir/dag.ts"
import type { RelDag, Roots } from "#compiler/ir/rel.ts"
import { everyKind } from "#test/unit/ir/fixture.ts"
import { generatedDags } from "#test/unit/ir/population.ts"

export type DigestFeature = "followed" | "labelled" | "every kind of node" | "a generated DAG"

/**
 * A DAG to digest every sub-query of, as the IR suites draw them (one of every kind of node, and generated query and
 * recursive cases), how its enclosing nodes are read, and a one-line domain.
 */
export const digestCaseGen: Gen<{
	readonly dag: RelDag
	readonly every: boolean
	readonly outer: TableOuterNames
	readonly domain: string
}> = (source) => {
	const every = source.draw(element([true, false]))
	return {
		dag: every ? everyKind(makeIdSupply()).dag : source.draw(generatedDags),
		every,
		outer: source.draw(element<TableOuterNames>(["followed", "labelled"])),
		domain: source.draw(string(codePoint(0x21, 0x7e), { min: 1, max: 8 }))
	}
}

/** The derivation form of a sub-query's normal form: the table a share or evaluation key digests. */
const derivationTable = (
	dag: RelDag,
	roots: Roots,
	outer: TableOuterNames
): Result.Result<unknown, CompileError> =>
	Result.map(normalizeReach(dag, roots, outer), (normal) => ({
		roots: normal.roots,
		nodes: Rec.map(normal.nodes, derivationForm),
		exprs: normal.exprs
	}))

/** The UTF-16 code units of a sub-query's table's canonical text, the text its key's digest writes after its frame. */
export const tableUnits = (
	dag: RelDag,
	roots: Roots,
	outer: TableOuterNames
): Result.Result<number, CompileError> =>
	Result.flatMap(derivationTable(dag, roots, outer), (table) =>
		Result.map(encode(table, { omit: omitSourceLocs }), (text) => text.length)
	)

/**
 * The digest a sub-query's key was before templates: SHA-256 of the canonical text of its normal form's table
 * (normalizeReach), each node in its derivation form (derivationForm), source locations left out, under the domain's
 * frame.
 */
export const tableDigest = (
	dag: RelDag,
	roots: Roots,
	domain: string,
	outer: TableOuterNames
): Result.Result<string, CompileError> =>
	Result.flatMap(derivationTable(dag, roots, outer), (table) =>
		digest(domain, table, { omit: omitSourceLocs })
	)

/** A share key's case under a limit of the table's text drawn below its length or at it, as a share of the length. */
export const boundCaseGen: Gen<{
	readonly dag: RelDag
	readonly outer: TableOuterNames
	readonly share: number
}> = (source) => ({
	dag: source.draw(generatedDags),
	outer: source.draw(element<TableOuterNames>(["followed", "labelled"])),
	share: source.draw(int(0, 100))
})
