/** What the properties of oracle.test.ts read: its spaces, models and helpers. */

import { exact, ordered, set, structuralHash } from "@bjornpagen/testing/oracle"
import { Array as Arr, Effect, Option, Order } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import type { StatementSpec } from "#compiler/ir/products.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	compileTemplate,
	type FixtureSchema,
	paramTexts,
	testCompile
} from "#test/support/compile.ts"
import type { OracleTemplate } from "#test/support/conservative.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import {
	type SpanEndpointKind,
	type SpanQuery,
	type SpanSchema,
	spanEndpointKinds,
	spanSchemaDesc,
	type SpanVariant,
	bySpanVariant
} from "#test/support/oracle/gen/spans.ts"
import { oracleOwnedLogin } from "#test/support/oracle/install/real.ts"
import type { SqlError } from "#test/support/pg.ts"
import { owning } from "#test/support/policy.ts"
import { type ScriptInstall, scriptTemplate } from "#test/support/script-template.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import type { SubstrateTemplate } from "#test/support/substrate/substrate.ts"

export const cases = 300

/** How a query writes the window or the point it compares stored spans with: a parameter or a literal. */
const operandForms = ["param", "literal"] as const

type OperandForm = (typeof operandForms)[number]

/**
 * What a case reaches: its query kind over its endpoint kind, with the form of its operand where the kind has one. A
 * parameter is cast to its declared type as it is bound, a contract's domain for a contract endpoint, which a literal
 * never is, so the two forms lower apart.
 */
type AllenOracleFeature =
	| `allenFilter:${SpanEndpointKind}:${OperandForm}`
	| `allenJoin:${SpanEndpointKind}`
	| `pointIn:${SpanEndpointKind}:${OperandForm}`

/** Every feature the suite must reach. */
export const allenOracleFeatures: Arr.NonEmptyReadonlyArray<AllenOracleFeature> = Arr.flatMap(
	spanEndpointKinds,
	(e): Arr.NonEmptyReadonlyArray<AllenOracleFeature> => [
		`allenJoin:${e}`,
		...Arr.map(operandForms, (f): AllenOracleFeature => `allenFilter:${e}:${f}`),
		...Arr.map(operandForms, (f): AllenOracleFeature => `pointIn:${e}:${f}`)
	]
)

/** The feature a case of `query` over `endpoint` reaches. */
export const featureOf = (query: SpanQuery, endpoint: SpanEndpointKind): AllenOracleFeature => {
	switch (query.kind) {
		case "allenFilter":
			return `allenFilter:${endpoint}:${query.window.kind}`
		case "allenJoin":
			return `allenJoin:${endpoint}`
		case "pointIn":
			return `pointIn:${endpoint}:${query.point.kind}`
	}
}

const schemaOf = (endpoint: SpanEndpointKind, left: boolean, right: boolean): SpanSchema => ({
	endpoint,
	relations: { Left: { name: "Left", spanKeyed: left }, Right: { name: "Right", spanKeyed: right } }
})

export const sameRowSet = set(structuralHash, ordered(exact))

/**
 * Every schema a case can draw, each installed once per member by its variant: the templates the cases' seats clone.
 * Each is its span schema compiled under the template's schema name by every worker (script-template.ts
 * scriptTemplate), its script run once per member and its oracle login given its password.
 */
export const oracleSpans: Readonly<Record<SpanVariant, SubstrateTemplate<ScriptInstall>>> =
	bySpanVariant((endpoint, left, right) =>
		scriptTemplate({
			declaredIn: import.meta,
			name: `spanoracle ${endpoint} ${left} ${right}`,
			label: "spanoracle",
			compile: (schema) => {
				const owned = owning(spanSchemaDesc(schemaOf(endpoint, left === "span", right === "span")))
				return succeeded(
					compileInstallation(owned, {
						...installOptions(owned),
						levels: [identity.schema(parsedSchemaName(schema))],
						extensions: [],
						logins: [oracleOwnedLogin(owned.desc)]
					}),
					"the installation of spanoracle"
				)
			}
		})
	)

/** A query description over `schemaDesc` compiled for the installed schema. */
export const compileSpanDesc = (
	q: unknown,
	schemaDesc: FixtureSchema,
	schemaIdent: string
): OracleTemplate =>
	succeeded(
		compileTemplate(q, schemaDesc, {
			...testCompile,
			installation: identity.schema(parsedSchemaName(schemaIdent))
		}),
		"the span query description compiles"
	)

type RawRows = ReadonlyArray<ReadonlyArray<string>>

/**
 * Runs one artifact's statements on `session` in order and returns each statement's raw text rows. A span schema holds
 * no roster, so the codebook its queries compile under is empty, and a relation parameter's input is normalized under
 * that one (a roster-typed parameter would be a defect here, never a silently miscoded one).
 */
export const runArtifact = (
	session: RawSession,
	template: OracleTemplate,
	artifact: "optimized" | "conservative",
	params: Readonly<Record<string, unknown>>
): Effect.Effect<ReadonlyArray<RawRows>, SqlError> =>
	Effect.gen(function* () {
		const out: Array<RawRows> = []
		const declared = { params: template.params, codes: emptyCodebook }
		for (const spec of template[artifact]) {
			const rows = yield* session.values(spec.sql, paramTexts(spec, params, declared))
			out.push(Arr.map(rows, (row) => Arr.map(row, (v) => String(v))))
		}
		return out
	})

/**
 * The rows of one statement as a set of text rows reordered to `columns`, by the statement's heading, and the number
 * of rows the statement repeated. A row's cells are range or output texts, which hold no NUL, so NUL joins its key.
 */
export const rowsAs = (
	spec: StatementSpec,
	rows: RawRows,
	columns: ReadonlyArray<string>
): { readonly rows: ReadonlyArray<ReadonlyArray<string>>; readonly repeats: number } => {
	const positions = Arr.map(columns, (c) =>
		Option.getOrThrowWith(
			Arr.findFirstIndex(spec.heading, (h) => h.name === c),
			() => new Error(`no output column ${c}`)
		)
	)
	const byKey = new Map<string, ReadonlyArray<string>>()
	for (const row of rows) {
		const r = Arr.map(positions, (p) => {
			const cell = row[p]
			if (cell === undefined) {
				throw new Error(`a row without output column ${p}`)
			}
			return cell
		})
		byKey.set(Arr.join(r, "\u0000"), r)
	}
	const sorted = Arr.sort(byKey.values(), Order.Array(Order.String))
	return { rows: sorted, repeats: rows.length - byKey.size }
}
