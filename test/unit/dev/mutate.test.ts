/**
 * grizzle's mutation operator families, audited over the real tree they mutate: every mutant of the `sql-world` and
 * `set-semantics` families in the files `pnpm mutate` reads (packages/engine/src and packages/grizzle/src/adapter).
 *
 * - Every operator of both families plants at least one mutant in the real tree: an operator whose code moved away
 *   from the shapes it reads mutates nothing, and the measurement would lose it silently.
 * - Every mutant parses, so a run measures a fault and never a syntax error; changes its file, so no mutant is
 *   equivalent by construction; and has an id no other mutant of the files has, so a triage verdict names one mutant.
 * - Every mutant plants the fault its operator names, read off the text it replaces and the text it puts there.
 *
 * The oracle is the specification: each operator's fault, stated apart from the operator as a judgement of the text a
 * mutant replaces and its replacement, and TypeScript's own parser. The box is the real tree. Features, required in
 * the space: every operator of both families.
 *
 * Plant: ~/.cache/grizzle-release/BR07/plants/mutate-definer-text.patch (world-definer writing a replacement other than
 * INVOKER) turns the property red.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { applied, type Mutant, mutantsOf } from "@grizzle/testing/mutants"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, FileSystem, String as Str } from "effect"
import {
	type Operator,
	setSemantics,
	sqlWorld,
	type WorldOperator,
	worldOperators
} from "#scripts/dev/mutate/world.ts"
import { withNativeSyntax } from "#scripts/dev/shared/native-syntax.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { repoRoot } from "#test/support/files.ts"
import { caseHang } from "#test/support/limits.ts"

type FamilyOperator = WorldOperator | "set-semantics"

const familyOperators: Arr.NonEmptyReadonlyArray<FamilyOperator> = [
	...worldOperators,
	"set-semantics"
]

const isFamily = (m: Mutant<Operator>): m is Mutant<FamilyOperator> =>
	Arr.some(familyOperators, (o) => o === m.operator)

/** The membership flips world-membership makes, each a text and its replacement. */
const membershipFlips: ReadonlyArray<readonly [string, string]> = [
	["WITH INHERIT FALSE", "WITH INHERIT TRUE"],
	["INHERIT FALSE, SET TRUE", "INHERIT FALSE, SET FALSE"],
	["LOGIN NOINHERIT", "LOGIN INHERIT"]
]

/** What each operator's fault is, read off the text a mutant replaces and its replacement. */
const faults: Readonly<Record<FamilyOperator, (original: string, replacement: string) => boolean>> =
	{
		"world-conjunct": (o, r) =>
			Str.startsWith("and(")(o) && Str.startsWith("and(")(r) && r.length < o.length,
		"world-policy-true": (_, r) => r === "true",
		"world-barrier": (o, r) =>
			(r === '""' && Str.includes("security_barrier")(o)) || (o === "true" && r === "false"),
		"world-definer": (_, r) => r === "INVOKER",
		"world-search-path": (o, r) => r === "" && Str.startsWith(" SET search_path = ")(o),
		"world-catalog-bare": (o, r) => Str.startsWith("inCatalog(")(o) && o === `inCatalog(${r})`,
		"world-grant": (o, r) =>
			Str.endsWith("]")(o) &&
			Arr.some(["SELECT", "UPDATE", "TRUNCATE"], (p) => r === `${Str.slice(0, -1)(o)}, "${p}"]`),
		"world-public-execute": (o, r) =>
			o === "" &&
			Str.includes('{ kind: "grant", privileges: ["EXECUTE"]')(r) &&
			Str.includes('to: [{ kind: "PUBLIC" }]')(r),
		"world-membership": (o, r) => Arr.some(membershipFlips, ([from, to]) => o === from && r === to),
		"world-claims-session": (o, r) => o === "true" && r === "false",
		"world-context-field": (o, r) =>
			Str.startsWith("columns")(o) && Str.includes(".map((c) => ({ ...c, field: ")(r),
		"world-advance-max": (o, r) => Str.startsWith("gt(")(o) && r === "undefined",
		"world-isolation-guard": (o, r) =>
			Str.includes("refuseBelowSerializable")(o) && !Str.includes("refuseBelowSerializable")(r),
		"world-reads-flip": (o, r) =>
			(o === '"displayScale"' && r === '"value"') ||
			(r === "native" && (Str.startsWith("exactSum(")(o) || Str.startsWith("exactMean(")(o))),
		"world-precondition-drop": (o, r) => r === "total" && o !== "total",
		"set-semantics": (o, r) =>
			(o === "UNION ALL" && r === "UNION") ||
			(o === "UNION" && r === "UNION ALL") ||
			(Str.startsWith("DISTINCT")(o) && r === "") ||
			(o === "true" && r === "false") ||
			(o === "false" && r === "true")
	}

/** The TypeScript modules `pnpm mutate` mutates, with their text. */
const mutatedModules = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const listed = yield* Effect.forEach(
		["packages/engine/src", "packages/grizzle/src/adapter"],
		(dir) =>
			Effect.map(fs.readDirectory(`${repoRoot}${dir}`, { recursive: true }), (entries) =>
				Arr.map(
					Arr.filter(entries, (e) => Str.endsWith(".ts")(e) && !Str.endsWith(".d.ts")(e)),
					(e) => `${dir}/${e}`
				)
			)
	)
	return yield* Effect.forEach(
		Arr.filter(Arr.flatten(listed), (file) => sqlWorld.applies(file)),
		(file) => Effect.map(fs.readFileString(`${repoRoot}${file}`), (text) => ({ file, text }))
	)
})

layer(NodeServices.layer, { excludeTestServices: true })("mutation operators", (it) => {
	it.effect(
		"plant in the real tree, for every operator, mutants that parse, change their file, have ids of their own and plant the fault their operator names",
		(ctx) =>
			Effect.gen(function* () {
				const modules = yield* mutatedModules
				const all = yield* mutantsOf(modules, [setSemantics, sqlWorld])
				const family = nonEmpty(Arr.filter(all, isFamily), "the families' mutants")
				const parsed = withNativeSyntax(
					Arr.map(family, (m) => ({ file: m.id, text: applied(m) })),
					(sources) =>
						new Set(
							Arr.map(
								Arr.filter(sources, (s) => s.diagnostics.length === 0),
								(s) => s.file
							)
						)
				)
				const ids = new Map<string, number>()
				for (const m of all) {
					ids.set(m.id, (ids.get(m.id) ?? 0) + 1)
				}
				return yield* searched(
					ctx,
					exhaust(
						{
							suite: "unit/dev/mutation-operators",
							generator: element(family),
							literal: (m: Mutant<FamilyOperator>) => `${m.file}:${m.line} ${m.operator} ${m.id}`,
							coverage: requiredInSpace<FamilyOperator>(familyOperators),
							box: "every sql-world and set-semantics mutant of the files pnpm mutate reads",
							oracle: {
								kind: "specification",
								name: "each operator's fault, read off the text a mutant replaces and its replacement"
							},
							caseHang,
							concurrency: 1
						},
						(m: Mutant<FamilyOperator>, c) =>
							Effect.sync(() => {
								c.note(m.operator)
								const label = `${m.file}:${m.line} ${m.operator}`
								const original = Str.slice(m.start, m.end)(m.source)
								assert.ok(parsed.has(m.id), `${label} parses`)
								assert.notEqual(applied(m), m.source, `${label} changes its file`)
								assert.equal(ids.get(m.id), 1, `${label} has an id of its own`)
								assert.ok(
									faults[m.operator](original, m.replacement),
									`${label}: ${original} -> ${m.replacement}`
								)
							})
					)
				)
			})
	)
})
