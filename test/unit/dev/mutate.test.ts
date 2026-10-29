import { describe, it } from "@effect/vitest"
import { Array as Arr, String as Str } from "effect"
import {
	applyMutant,
	classicOperators,
	mutantsOf,
	parsed,
	type Mutant
} from "#scripts/dev/mutate/operators.ts"
import { type WorldOperator, worldOperators } from "#scripts/dev/mutate/world.ts"
import { assert } from "#test/support/assert.ts"

import { regex } from "arkregex"
/** A source outside the world files, which gives every classic operator a mutant. */
const classicProbe = Arr.join(
	[
		"export const within = (n: number, limit: number): boolean => n >= 0 && n < limit && limit !== 3",
		"export function first(xs: ReadonlyArray<number>, k: number): number | undefined {",
		"\tfor (const x of xs) {",
		"\t\tif (x === k) continue",
		"\t\tif (x > k + 1) return x",
		"\t}",
		"\treturn undefined",
		"}",
		'export const op = (unique: boolean) => (unique ? "UNION ALL" : "UNION")',
		'export const sql = "SELECT DISTINCT a FROM t WHERE a IS DISTINCT FROM b"',
		"export const flags = { distinct: true as const }",
		'interface Shape { readonly op: "UNION ALL"; readonly n: 1 }',
		"export type { Shape }"
	],
	"\n"
)

/** Synthetic world files, in the shapes the compiler builds its world SQL in, each at a path the family aims at. */
const worldProbes: ReadonlyArray<{ readonly file: string; readonly text: string }> = [
	{
		file: "packages/engine/src/sql/print.ts",
		text: Arr.join(
			[
				"export const policy = (s: { readonly using: string; readonly check: string }) => [",
				"\t`CREATE POLICY p ON t AS PERMISSIVE FOR ALL TO r`,",
				`\t\`  USING (\${print(s.using)})\`,`,
				`\t\`  WITH CHECK (\${print(s.check)})\``,
				"]",
				`export const view = (barrier: boolean) => \`CREATE VIEW v\${barrier ? " WITH (security_barrier)" : ""} AS\``,
				`export const header = (fn: Fn) => \`LANGUAGE sql STABLE SECURITY \${fn.security} SET search_path = \${list(fn.path)}\``,
				`export const member = (role: string, to: string) => \`GRANT \${role} TO \${to} WITH INHERIT FALSE, SET TRUE\``,
				`export const login = (name: string, on: boolean) => \`CREATE ROLE \${name} \${on ? "LOGIN NOINHERIT" : "NOLOGIN"}\``
			],
			"\n"
		)
	},
	{
		file: "packages/grizzle/src/adapter/wire/batch.ts",
		text: "export const prologue = \"SELECT pg_catalog.set_config('role', $1, true), pg_catalog.set_config('grizzle.claims', $2, true)\""
	},
	{
		file: "packages/engine/src/physical/ddl/roles.ts",
		text: Arr.join(
			[
				"export const probe = (a: Expr, b: Expr, c: Expr) => and(a, b, c)",
				'export const grants = (mutable: boolean) => [grant(mutable ? ["SELECT", "UPDATE"] : ["SELECT"], on)]',
				'export const ddl = [fn, { kind: "revoke", privileges: ["ALL"], on: { kind: "FUNCTION", names: [n] }, from: [{ kind: "PUBLIC" }] }]',
				'export const view = { kind: "createView", barrier: true }'
			],
			"\n"
		)
	},
	{
		file: "packages/engine/src/lower/conservative/claims/index.ts",
		text: 'export const source = (context: string, columns: ReadonlyArray<{ readonly field: string }>) => ({ kind: "context", context, columns })'
	},
	{
		file: "packages/engine/src/laws/residual/sql.ts",
		text: 'export const detail = (shown: Expr, keys: Expr) => ({ kind: "case", whens: [{ when: shown, result: keys }] })'
	},
	{
		file: "packages/engine/src/physical/ddl/advance.ts",
		text: 'export const move = simpleSelect([target(call("setval", [seq, past]))], [table(s, n, "r1")], gt(row(past), row(last)))'
	},
	{
		file: "packages/engine/src/physical/ddl/isolation.ts",
		text: 'export const body = [refuseBelowSerializable, { kind: "return", value: next }]'
	}
]

const classicMutants = Arr.flatMap(
	mutantsOf([{ file: "src/probe.ts", text: classicProbe }]),
	(m) => m.mutants
)

const worldMutants = Arr.flatMap(mutantsOf(worldProbes), ({ input, mutants }) =>
	Arr.map(mutants, (mutant) => ({
		mutant,
		mutated: applyMutant(input.text, mutant),
		file: input.file
	}))
)

const isWorld = (m: Mutant): m is Mutant & { readonly operator: WorldOperator } =>
	Arr.some(worldOperators, (o) => o === m.operator)

/**
 * What each world operator's fault is, read off the mutated text: the defining change, so a mutant that passes is the
 * fault the operator names and not some other edit.
 */
const faults: Readonly<Record<WorldOperator, (mutated: string) => boolean>> = {
	"world-conjunct": (t) => regex("and\\([abc], [abc]\\)").test(t),
	"world-policy-true": (t) =>
		Str.includes("USING (true)")(t) || Str.includes("WITH CHECK (true)")(t),
	"world-policy-swap": (t) =>
		Str.includes(`USING (\${print(s.check)})`)(t) &&
		Str.includes(`WITH CHECK (\${print(s.using)})`)(t),
	"world-barrier": (t) =>
		!Str.includes('" WITH (security_barrier)"')(t) || Str.includes("barrier: false")(t),
	"world-definer": (t) => Str.includes("SECURITY INVOKER")(t),
	"world-search-path": (t) => !Str.includes("search_path")(t),
	"world-grant": (t) => regex('"(?:TRUNCATE|UPDATE|SELECT)"\\]').test(t),
	"world-public-execute": (t) =>
		Str.includes('{ kind: "grant", privileges: ["EXECUTE"]')(t) &&
		Str.includes('to: [{ kind: "PUBLIC" }]')(t),
	"world-membership": (t) =>
		Str.includes("INHERIT TRUE")(t) ||
		Str.includes("SET FALSE")(t) ||
		Str.includes("LOGIN INHERIT")(t),
	"world-claims-session": (t) => regex("set_config\\('[^']+', \\$\\d, false\\)").test(t),
	"world-context-field": (t) =>
		Str.includes("columns: columns.map((c) => ({ ...c, field: context }))")(t),
	"world-witness": (t) => Str.includes("when: lit.bool(true)")(t),
	"world-advance-max": (t) => Str.endsWith(", undefined)")(t),
	"world-isolation-guard": (t) => !Str.includes("refuseBelowSerializable")(t)
}

describe("mutation operators", () => {
	it("keeps every mutant parseable, with distinct identities", () => {
		const all = [
			...Arr.map(classicMutants, (m) => ({
				file: "src/probe.ts",
				text: applyMutant(classicProbe, m),
				mutant: m
			})),
			...Arr.map(worldMutants, (w) => ({ file: w.file, text: w.mutated, mutant: w.mutant }))
		]
		for (const { input, parses } of parsed(all)) {
			assert.ok(parses, `${input.mutant.operator} at ${input.file}:${input.mutant.line}`)
		}
		assert.equal(new Set(Arr.map(all, (a) => a.mutant.id)).size, all.length)
	})

	it("reaches every classic operator with its probe, and no world operator outside the world files", () => {
		assert.deepEqual(new Set(Arr.map(classicMutants, (m) => m.operator)), new Set(classicOperators))
	})

	it("reaches every world operator with the world probes", () => {
		assert.deepEqual(
			new Set(
				Arr.map(
					Arr.filter(worldMutants, (w) => isWorld(w.mutant)),
					(w) => w.mutant.operator
				)
			),
			new Set(worldOperators)
		)
	})

	it("plants in each world mutant the fault its operator names", () => {
		for (const { mutant, mutated, file } of worldMutants) {
			if (isWorld(mutant)) {
				assert.ok(
					faults[mutant.operator](mutated),
					`${mutant.operator} at ${file}: ${mutant.replacement}`
				)
			}
		}
	})

	it("swaps a policy's clauses only where they differ", () => {
		const same = `export const p = (f: string) => [\`  USING (\${f})\`, \`  WITH CHECK (\${f})\`]`
		const [only] = mutantsOf([{ file: "packages/engine/src/sql/print.ts", text: same }])
		assert.ok(
			only !== undefined && !Arr.some(only.mutants, (m) => m.operator === "world-policy-swap")
		)
	})
})
