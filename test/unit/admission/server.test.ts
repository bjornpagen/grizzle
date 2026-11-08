import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, type Gen, oneOf, weighted, constant } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { admissionExpectation, serverMismatches } from "#adapter/admission/expectation.ts"
import type { AdmissionStage } from "#adapter/errors/failures.ts"
import { vectorExtension } from "#compiler/physical/vector/storage.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { Search } from "#test/support/fixtures/api/search.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { caseHang } from "#test/support/limits.ts"

/**
 * Admission's checks of the server (adapter/admission/expectation.ts serverMismatches): the server is PostgreSQL 19,
 * the database UTF8 with the builtin C.UTF-8 locale and its pg_c_utf8 collation, the server's max_stack_depth at least
 * its default, 2MB, and the extensions the schema needs are installed in the schema its compiled names place them in,
 * at the pinned version.
 *
 * Over drawn catalog answers, each value one PostgreSQL gives: a server_version_num around every bound of 19's, an
 * encoding, a locale provider, a builtin locale in each spelling PostgreSQL accepts and others, the collation's count,
 * a max_stack_depth in kilobytes around 2MB, from its least to a large one, and pgvector absent, installed as needed, elsewhere or at another version, for a schema without a vector field and one
 * with one. The oracle is README's list of what Db.open checks, restated: every check that fails is a mismatch, in the
 * order of the stages `version`, `locale` and `capability`, so a server of another major version is refused at stage
 * `version` whatever else is wrong with it, and an admitted server shows none.
 */
type Version =
	| "18's last"
	| "19's first"
	| "a minor of 19"
	| "19's last"
	| "20's first"
	| "a later major"
	| "an earlier major"

const versionText: Readonly<Record<Version, string>> = {
	"18's last": "189999",
	"19's first": "190000",
	"a minor of 19": "190007",
	"19's last": "199999",
	"20's first": "200000",
	"a later major": "210003",
	"an earlier major": "170005"
}

/** Whether a server_version_num is PostgreSQL 19's: 19 * 10000 and every minor of it. */
const isNineteen = (version: Version): boolean =>
	version === "19's first" || version === "a minor of 19" || version === "19's last"

type Installed = "absent" | "as needed" | "in another schema" | "at another version"

/** A max_stack_depth pg_settings reports, in kilobytes: its least, around its default of 2MB, and a large one. */
type StackDepth =
	| "its least"
	| "1MB"
	| "a kilobyte short of 2MB"
	| "2MB"
	| "a kilobyte past 2MB"
	| "64MB"

const stackDepthText: Readonly<Record<StackDepth, string>> = {
	"its least": "100",
	"1MB": "1024",
	"a kilobyte short of 2MB": "2047",
	"2MB": "2048",
	"a kilobyte past 2MB": "2049",
	"64MB": "65536"
}

/** Whether a max_stack_depth is at least its default, 2MB. */
const deepEnough = (depth: StackDepth): boolean =>
	depth === "2MB" || depth === "a kilobyte past 2MB" || depth === "64MB"

interface ServerCase {
	readonly schema: "without a vector field" | "with a vector field"
	readonly version: Version
	readonly encoding: string
	readonly provider: string
	readonly locale: string
	readonly collations: "1" | "0"
	readonly stackDepth: StackDepth
	readonly vector: Installed
}

const serverCaseGen: Gen<ServerCase> = (source) => ({
	schema: source.draw(element(["without a vector field", "with a vector field"] as const)),
	version: source.draw(
		element<Version>([
			"18's last",
			"19's first",
			"a minor of 19",
			"19's last",
			"20's first",
			"a later major",
			"an earlier major"
		])
	),
	encoding: source.draw(
		weighted([
			[3, constant("UTF8")],
			[1, element(["SQL_ASCII", "LATIN1", "EUC_JP"])]
		])
	),
	provider: source.draw(
		weighted([
			[3, constant("b")],
			[1, element(["c", "i"])]
		])
	),
	locale: source.draw(
		weighted([
			[3, element(["C.UTF-8", "C.UTF8", "c.utf-8", "C.utf8"])],
			[1, element(["C", "en_US.UTF-8", "", "C.UTF-16"])]
		])
	),
	collations: source.draw(
		weighted([
			[3, constant("1" as const)],
			[1, constant("0" as const)]
		])
	),
	stackDepth: source.draw(
		weighted<StackDepth>([
			[4, element<StackDepth>(["2MB", "a kilobyte past 2MB", "64MB"])],
			[1, element<StackDepth>(["its least", "1MB", "a kilobyte short of 2MB"])]
		])
	),
	vector: source.draw(
		oneOf<Installed>([
			constant("absent"),
			constant("as needed"),
			constant("in another schema"),
			constant("at another version")
		])
	)
})

const artifactsOf = {
	"without a vector field": succeeded(testArtifacts(W.Work, testCompile)),
	"with a vector field": succeeded(testArtifacts(Search, testCompile))
} as const

/** A mismatch as the model names it: its stage and its check. */
const mismatch = (stage: AdmissionStage, check: string): readonly [AdmissionStage, string] => [
	stage,
	check
]

/** Whether a builtin locale is C.UTF-8, in the spellings PostgreSQL accepts for it, its case ignored. */
const isCUtf8 = (locale: string): boolean =>
	locale === "C.UTF-8" || locale === "C.UTF8" || locale === "c.utf-8" || locale === "C.utf8"

type ServerFeature =
	| "admitted"
	| "refused at version alone"
	| "refused at version beside other mismatches"
	| "refused at locale"
	| "refused at capability"
	| "mismatches at all three stages"

describe("admission's checks of the server", () => {
	it.effect(
		"name every mismatch in stage order, a server of another major at stage version first",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/admission/server",
						draw: drawn(serverCaseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "README's list of what Db.open checks of the server, in the order of its stages"
						},
						coverage: required<ServerFeature>(
							[
								"admitted",
								"refused at version alone",
								"refused at version beside other mismatches",
								"refused at locale",
								"refused at capability",
								"mismatches at all three stages"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const artifacts = artifactsOf[c.schema]
							const vectorSchema = artifacts.names.vectorSchema
							const needsVector = c.schema === "with a vector field"
							const extensions =
								c.vector === "absent"
									? []
									: [
											{
												name: vectorExtension.name,
												schema:
													c.vector === "in another schema" ? `${vectorSchema}_other` : vectorSchema,
												version:
													c.vector === "at another version" ? "0.7.0" : vectorExtension.version
											},
											{ name: "plpgsql", schema: "pg_catalog", version: "1.0" }
										]
							const mismatches = serverMismatches(
								{
									database: {
										version: versionText[c.version],
										encoding: c.encoding,
										localeProvider: c.provider,
										locale: c.locale,
										cUtf8Collations: c.collations,
										stackDepth: stackDepthText[c.stackDepth]
									},
									extensions
								},
								admissionExpectation(artifacts)
							)
							const expected: ReadonlyArray<readonly [AdmissionStage, string]> = [
								...(isNineteen(c.version) ? [] : [mismatch("version", "server_version_num")]),
								...(c.encoding === "UTF8" ? [] : [mismatch("locale", "database encoding")]),
								...(c.provider === "b" ? [] : [mismatch("locale", "database locale provider")]),
								...(isCUtf8(c.locale) ? [] : [mismatch("locale", "database builtin locale")]),
								...(c.collations === "1"
									? []
									: [mismatch("locale", "collation pg_catalog.pg_c_utf8 (builtin)")]),
								...(deepEnough(c.stackDepth) ? [] : [mismatch("capability", "max_stack_depth")]),
								...(needsVector && c.vector !== "as needed"
									? [mismatch("capability", `extension ${vectorExtension.name}`)]
									: [])
							]
							assert.deepEqual<ReadonlyArray<readonly [AdmissionStage, string]>>(
								Arr.map(mismatches, (m) => [m.stage, m.check] as const),
								expected
							)
							const first = Option.map(Arr.head(mismatches), (m) => m.stage)
							if (Option.isNone(first)) {
								k.note("admitted")
								return
							}
							switch (first.value) {
								case "version":
									k.note(
										mismatches.length === 1
											? "refused at version alone"
											: "refused at version beside other mismatches"
									)
									break
								case "locale":
									k.note("refused at locale")
									break
								case "capability":
									k.note("refused at capability")
									break
								case "ledger":
								case "privileges":
								case "settings":
									assert.fail(`a server's mismatches name no ${first.value} stage`)
							}
							if (new Set(Arr.map(mismatches, (m) => m.stage)).size === 3) {
								k.note("mismatches at all three stages")
							}
						})
				)
			)
	)
})
