/**
 * What upkeep-digests.test.ts reads: a box of stored relations that copy a text whose digest their source declares,
 * each keyed apart from the source, and its installation.
 */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { element, type FiniteSpace, finite } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { Crypto } from "#compiler/public/compute.ts"
import { closedId, generated, int4, sha256 } from "#compiler/public/fields.ts"
import { closed, mutable, relation, schema, unit } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { derivedBuilder } from "#compiler/schema/relation.ts"
import { ownedInput } from "#test/support/policy.ts"

/**
 * How the stored relation names the attribute it copies the value of: by a token a graded name maps the attribute's
 * name to (`token`, qti-pie's DeclarationAttribute through GradedAttributeName), or by the kind of its element, whose
 * holder names the attribute (`holder`, the ledger's declared values through ValueHolder).
 */
export type Naming = "token" | "holder"

/** A case: how the stored relation names the attribute. */
export interface Shape {
	readonly naming: Naming
}

export const shapeGen: FiniteSpace<Shape> = finite((source) => ({
	naming: source.draw(element<Naming>(["token", "holder"]))
}))

/** An attribute's value: a text of no byte bound, which no B-tree entry holds. */
const Value = str.regex("^.+$", "su")

/** A token the reader reads a name by: a text of a byte bound, which a B-tree entry holds. */
const Token = str.bytes(8, str.regex("^[a-z]+$"))

/**
 * The installation of the case's schema, as qti-pie's ledger reads pantry's attributes: Names, the attributes' names, a
 * roster; Kinds, the elements' kinds; Attr, each element's attribute by its package, start and name, its value a text
 * of no byte bound and `valueDigest` its SHA-256, as pantry's Attribute declares them; Node, each element's kind by
 * its package and start; Graded, the names the reader grades, each by
 * its token, a closed relation as GradedAttributeName is; Holder, the name of the attribute each kind holds its value
 * in, a closed relation as ValueHolder is; and above them Copied, the case's attributes' values, each by the package,
 * the start and the token or the kind, never the attribute's name, stored at the package's unit
 * (analysis/derived/storage.ts), every match reached from its head by a key, Attr and Node open in it, so its upkeep
 * checks each fact a write may have lost at the fact (analysis/theory/upkeep.ts `checked`), reading the attribute a
 * stored row copies at the stored row's copied value.
 */
export const installationOf = (shape: Shape): Result.Result<Installation, CompileError> => {
	const Names = closed.ordered("Names", ["alpha", "beta", "gamma"])
	const Kinds = closed.ordered("Kinds", ["entry", "table"])
	const Attr = relation.generated(
		"Attr",
		{ package: int4, start: int4, name: closedId(Names), value: Value },
		["package", "start", "name"],
		(row) => ({ valueDigest: generated(sha256, Crypto.sha256(row.value)) })
	)
	const Node = relation("Node", { package: int4, start: int4, kind: closedId(Kinds) }, [
		"package",
		"start"
	])
	const Graded = closed.relation(
		"Graded",
		{ name: closedId(Names), token: Token },
		["name"],
		[
			{ name: "alpha", token: "alpha" },
			{ name: "beta", token: "beta" }
		]
	)
	const Holder = closed.relation(
		"Holder",
		{ kind: closedId(Kinds), name: closedId(Names) },
		["kind"],
		[
			{ kind: "entry", name: "alpha" },
			{ kind: "table", name: "gamma" }
		]
	)
	const Pkg = unit("Pkg", { package: int4 })
	const base = schema(
		"Base",
		[Names, Kinds, Attr, Node, Graded, Holder],
		[Pkg, mutable(Attr), mutable(Node)]
	)
	const copied = queryOver(base).rule((r: RuleValue) => {
		const { package: pkg, start, name, value } = varsOver(Attr, "attr")
		const { kind } = varsOver(Node, "node")
		const read = r
			.match(Node, { package: pkg, start, kind })
			.match(Attr, { package: pkg, start, name, value })
		if (shape.naming === "token") {
			const { token } = varsOver(Graded, "graded")
			return read.match(Graded, { name, token }).find({ package: pkg, start, by: token, value })
		}
		return read.match(Holder, { kind, name }).find({ package: pkg, start, by: kind, value })
	})
	const top = schema.extend([base], "Top", [derivedBuilder("Copied", copied, [])], [])
	return Result.flatMap(ownedInput(top), (owned) =>
		compileInstallation(owned, installOptions(owned))
	)
}

/** Every index of Attr the installation plans, by its keys' columns. */
export const attrIndexes = (installation: Installation): ReadonlyArray<ReadonlyArray<string>> =>
	Arr.map(
		Arr.filter(installation.indexes, (i) => i.relation === "Attr"),
		(i) => Arr.map(i.keys, (k) => (k.column.kind === "field" ? k.column.field : k.column.kind))
	)
