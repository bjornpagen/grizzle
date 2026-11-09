/**
 * A served file's refusals read back as the compile's, so a layer classifies a violation exactly as its compile does:
 * a role's refusals drawn from its artifacts (adapter/served/refusals.ts installationRefusals), written by servedText
 * and read by servedFile from the JSON value an import of the file yields, rebuild a classifier (witness/index.ts
 * servedWitness) whose every key-law table answers as the one built from the refusals before they were written.
 *
 * Over generated public schemas (test/support/oracle/public), each one's artifacts compiled as the runtime's compile
 * compiles them:
 *
 * - Round trip: the refusals read back are the refusals written (runtimeDifference finds no member that differs).
 * - Classifier: for every installed constraint, under its owner, the laws the loaded classifier reads are the compile's;
 *   so is each stored relation's table, each roster domain, each generated field's law, and every law a write statement
 *   raises.
 *
 * Essay ideas: an oracle (the compile's own classifier) over generated installations, compared as the runtime reads it.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { installationRefusals } from "#adapter/served/refusals.ts"
import { servedWitness } from "#adapter/witness/index.ts"
import { noLevelAbove } from "#adapter/witness/keylaw.ts"
import { SchemaFingerprint } from "#compiler/core/ids.ts"
import type * as Result from "#compiler/core/result.ts"
import { trusted, trustedJson } from "#compiler/core/trusted.ts"
import type { ConstraintOwner } from "#compiler/ir/products.ts"
import { servedSession } from "#compiler/program/served.ts"
import type { ServedFile, ServedRefusals } from "#compiler/served/forms.ts"
import { servedFile, servedText } from "#compiler/served/json.ts"
import { assert } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
import { buildSchema } from "#test/support/oracle/public/build.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import type { ProgramCase } from "#test/support/oracle/public/program.ts"
import { runtimeDifference } from "#test/support/served.ts"

type Feature = "a constraint law" | "a law a write statement raises"

/** The served file of one login of one role whose refusals are `refusals`, under the codes `rosters`. */
const fileOf = (refusals: ServedRefusals, rosters: ServedFile["rosters"]): ServedFile => ({
	login: "app",
	fingerprint: SchemaFingerprint(Str.repeat(64)("0")),
	base: "base",
	level: 0,
	role: "app_login",
	schema: "base",
	prologue: { fence: trusted("SELECT 1"), enter: trusted("SELECT 2") },
	session: servedSession,
	rosters,
	above: { schemas: [], constraints: { tables: {}, domains: {} }, laws: new Map() },
	roles: [{ name: "writer", installed: "base__writer", contexts: [], refusals, members: [] }]
})

const ok = <A, E extends { readonly message: string }>(
	r: Result.Result<A, E>,
	what: string,
	c: ProgramCase
): A => {
	if (!r.ok) {
		throw new Error(`${what}: ${r.error.message}\n${printCase(c)}`)
	}
	return r.value
}

/** That two answers of the classifiers' tables are one, as the runtime reads them, for `what`. */
const same = (a: unknown, b: unknown, what: string, c: ProgramCase): void => {
	const differs = runtimeDifference(a, b)
	assert.equal(differs, undefined, `${what} reads otherwise at ${differs}\n${printCase(c)}`)
}

const roundTrip = (c: ProgramCase, note: (feature: Feature) => void): void => {
	const value = buildSchema(c.schema).schema
	const artifacts = ok(testArtifacts(value, testCompile), "the schema's artifacts", c)
	const codes = artifacts.names.codes
	const refusals = installationRefusals(artifacts)
	const file = fileOf(
		refusals,
		new Map(Arr.map([...codes.rosters], ([name, codec]) => [name, codec.codes] as const))
	)
	const back = servedFile(trustedJson<unknown>(ok(servedText(file), "the served file's text", c)))
	const [role] = back.roles
	if (role === undefined) {
		throw new Error(`the file reads back no role\n${printCase(c)}`)
	}
	same(refusals, role.refusals, "the refusals", c)
	const compiled = servedWitness(refusals, noLevelAbove, codes).laws
	const loaded = servedWitness(role.refusals, back.above, codes).laws
	same([...compiled.schemas], [...loaded.schemas], "the schemas", c)
	for (const law of refusals.laws.constraintLaws) {
		const owner: ConstraintOwner =
			law.kind === "domainConstraint"
				? { kind: "domain", name: law.owner }
				: { kind: "table", name: law.owner }
		same(
			compiled.lawsOf(law.name, owner),
			loaded.lawsOf(law.name, owner),
			`the laws of ${law.name}`,
			c
		)
		note("a constraint law")
	}
	for (const relation of refusals.relations.keys()) {
		same(compiled.tableOf(relation), loaded.tableOf(relation), `the table of ${relation}`, c)
	}
	for (const { code, bits } of refusals.laws.rosterDomains) {
		same(compiled.rosterDomainOf(code), loaded.rosterDomainOf(code), `roster domain ${code}`, c)
		same(compiled.rosterDomainOf(bits), loaded.rosterDomainOf(bits), `roster domain ${bits}`, c)
	}
	for (const { table, column } of refusals.laws.generated) {
		same(
			compiled.generatedOf(table, column),
			loaded.generatedOf(table, column),
			`the generated law of ${table}.${column}`,
			c
		)
	}
	same([...compiled.raised], [...loaded.raised], "the raised laws", c)
	if (compiled.raised.size > 0) {
		note("a law a write statement raises")
	}
}

describe("a served file's refusals", () => {
	it.effect("read back as the compile's, and classify as the compile's classifier does", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: { kind: "specification", name: "the compile's own classifier" },
					suite: "unit/served/refusals",
					draw: drawn((source) => source.draw(caseSketchGen)),
					literal: Formatter.format,
					coverage: required<Feature>(["a constraint law"], { cases: 60, sense: notesOnly }),
					kept: [],
					runs: 60,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(sketch, notes) => Effect.sync(() => roundTrip(notes.draw(resolveCase(sketch)), notes.note))
			)
		)
	)
})
