import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { applied, type Mutant, mutantsOf } from "@grizzle/testing/mutants"
import { Array as Arr, Effect, String as Str } from "effect"
import {
	classicOperators,
	type Operator,
	setSemantics,
	sqlWorld,
	type WorldOperator,
	worldOperators
} from "#scripts/dev/mutate/world.ts"
import { withNativeSyntax } from "#scripts/dev/shared/native-syntax.ts"
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
				`export const login = (name: string, on: boolean) => \`CREATE ROLE \${name} \${on ? "LOGIN NOINHERIT" : "NOLOGIN"}\``,
				"export const printCatalogType = (name: CatalogTypeName): string => {",
				"\tswitch (catalogSpelling[name]) {",
				'\t\tcase "keyword":',
				"\t\t\treturn name",
				'\t\tcase "qualified":',
				"\t\t\treturn inCatalog(name)",
				"\t}",
				"}",
				'const printFunctionName = (fn: FunctionRef): string => fn.kind === "builtin" ? inCatalog(fn.name) : printObjectName(fn)'
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
		file: "packages/engine/src/physical/ddl/advance.ts",
		text: 'export const move = simpleSelect([target(call("setval", [seq, past]))], [table(s, n, "r1")], gt(row(past), row(last)))'
	},
	{
		file: "packages/engine/src/physical/ddl/isolation.ts",
		text: 'export const body = [refuseBelowSerializable, { kind: "return", value: next }]'
	},
	{
		file: "packages/engine/src/scalar/compute/registry.ts",
		text: Arr.join(
			[
				'export type OperandReading = "value" | "displayScale"',
				"const divisor = requires([nonzero(1)])",
				'export const div = infix("div", "/", "numeric", "numeric", divisor, "displayScale")',
				'export const add = infix("add", "+", "int4", "int4", exactInteger, "value")',
				'export const mul = infix("mul", "*", "float8", "float8", ieee("mul"), "value")'
			],
			"\n"
		)
	},
	{
		file: "packages/engine/src/scalar/aggregate.ts",
		text: 'export const sums = { float8: { lowering: exactSum("float8") }, int4: { lowering: native } }'
	}
]

/** Every mutant of some sources by the library's operators and grizzle's two families. */
const mutantsOfProbes = (
	sources: ReadonlyArray<{ readonly file: string; readonly text: string }>
) => mutantsOf(sources, [setSemantics, sqlWorld])

const isWorld = (m: Mutant<Operator>): m is Mutant<WorldOperator> =>
	Arr.some(worldOperators, (o) => o === m.operator)

const isClassic = (m: Mutant<Operator>): boolean =>
	Arr.some(classicOperators, (o) => o === m.operator)

/** Whether each text parses with no syntax error, by the native parser, for checking a mutant keeps its file valid. */
const parses = (inputs: ReadonlyArray<{ readonly file: string; readonly text: string }>) =>
	withNativeSyntax(inputs, (sources) =>
		Arr.map(sources, (source) => ({ file: source.file, parses: source.diagnostics.length === 0 }))
	)

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
	"world-catalog-bare": (t) =>
		!Str.includes("return inCatalog(name)")(t) || !Str.includes("? inCatalog(fn.name)")(t),
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
	"world-advance-max": (t) => Str.endsWith(", undefined)")(t),
	"world-isolation-guard": (t) => !Str.includes("refuseBelowSerializable")(t),
	"world-reads-flip": (t) =>
		Str.includes('divisor, "value")')(t) || Str.includes("float8: { lowering: native }")(t),
	"world-precondition-drop": (t) =>
		Str.includes("const divisor = total")(t) || Str.includes(', total, "')(t)
}

layer(NodeServices.layer)("mutation operators", (it) => {
	it.effect("keeps every mutant parseable, with distinct identities", () =>
		Effect.gen(function* () {
			const mutants = yield* mutantsOfProbes([
				{ file: "src/probe.ts", text: classicProbe },
				...worldProbes
			])
			const all = Arr.map(mutants, (mutant) => ({
				file: `${mutant.file}:${mutant.line} ${mutant.operator}`,
				text: applied(mutant)
			}))
			for (const { file, parses: valid } of parses(all)) {
				assert.ok(valid, file)
			}
			assert.equal(new Set(Arr.map(mutants, (m) => m.id)).size, mutants.length)
		})
	)

	it.effect(
		"reaches every classic operator with its probe, and no world operator outside the world files",
		() =>
			Effect.gen(function* () {
				const mutants = yield* mutantsOfProbes([{ file: "src/probe.ts", text: classicProbe }])
				assert.deepEqual(
					new Set(Arr.map(Arr.filter(mutants, isClassic), (m) => m.operator)),
					new Set(classicOperators)
				)
				assert.ok(!Arr.some(mutants, isWorld), "no world mutant outside the world files")
			})
	)

	it.effect("reaches every world operator with the world probes", () =>
		Effect.gen(function* () {
			const mutants = yield* mutantsOfProbes(worldProbes)
			assert.deepEqual(
				new Set(Arr.map(Arr.filter(mutants, isWorld), (m) => m.operator)),
				new Set(worldOperators)
			)
		})
	)

	it.effect("plants in each world mutant the fault its operator names", () =>
		Effect.gen(function* () {
			for (const mutant of yield* mutantsOfProbes(worldProbes)) {
				if (isWorld(mutant)) {
					assert.ok(
						faults[mutant.operator](applied(mutant)),
						`${mutant.operator} at ${mutant.file}: ${mutant.replacement}`
					)
				}
			}
		})
	)

	it.effect("swaps a policy's clauses only where they differ", () =>
		Effect.gen(function* () {
			const same = `export const p = (f: string) => [\`  USING (\${f})\`, \`  WITH CHECK (\${f})\`]`
			const mutants = yield* mutantsOfProbes([
				{ file: "packages/engine/src/sql/print.ts", text: same }
			])
			assert.ok(!Arr.some(mutants, (m) => m.operator === "world-policy-swap"))
		})
	)
})
