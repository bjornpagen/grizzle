import { Array as Arr, Effect, Option, Order } from "effect"
import { identity } from "#compiler/core/identity.ts"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import type { StatementSpec } from "#compiler/ir/products.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import type { InstallExtension } from "#compiler/physical/install/extension.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	compileTemplate,
	type FixtureSchema,
	paramTexts,
	testCompile
} from "#test/support/compile.ts"
import type { OracleTemplate } from "#test/support/conservative.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { oracleOwnedLogin } from "#test/support/oracle/install/real.ts"
import type { SqlError } from "#test/support/pg.ts"
import { owning } from "#test/support/policy.ts"
import { type ScriptInstall, scriptTemplate } from "#test/support/script-template.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import type { SubstrateTemplate } from "#test/support/substrate/substrate.ts"

export interface SpanInstallOptions {
	readonly label: string
	/** The workload extensions whose programs' span predicates request GiST indexes; none for a schema alone. */
	readonly extensions: ReadonlyArray<InstallExtension>
}

/** The schema's installation under `schema`, as `owner` names it. */
export const compileSpans = (
	desc: FixtureSchema,
	schema: string,
	options: SpanInstallOptions
): Installation => {
	const owned = owning(desc)
	return succeeded(
		compileInstallation(owned, {
			...installOptions(owned),
			levels: [identity.schema(parsedSchemaName(schema))],
			extensions: options.extensions,
			logins: [oracleOwnedLogin(owned.desc)]
		}),
		`the installation of ${options.label}`
	)
}

/**
 * A span schema as a template (script-template.ts scriptTemplate): `desc` compiled under the template's schema name
 * (compileSpans) by every worker, its script run once per member and its oracle login given its password, each case's
 * installation the template's in its clone. `name` tells it from its module's other templates.
 */
export const spansTemplate = (
	declaredIn: ImportMeta,
	name: string,
	desc: FixtureSchema,
	options: SpanInstallOptions
): SubstrateTemplate<ScriptInstall> =>
	scriptTemplate({
		declaredIn,
		name,
		label: options.label,
		compile: (schema) => compileSpans(desc, schema, options)
	})

/** A query value compiled for the installed schema. */
export const compileSpanQuery = (q: unknown, schemaIdent: string): OracleTemplate =>
	succeeded(
		compileTemplate(q, undefined, {
			...testCompile,
			installation: identity.schema(parsedSchemaName(schemaIdent))
		}),
		"the span query compiles"
	)

/** A query description over `schemaDesc` compiled for the installed schema. */
export const compileSpanDesc = (
	q: unknown,
	schemaDesc: FixtureSchema | undefined,
	schemaIdent: string
): OracleTemplate =>
	succeeded(
		compileTemplate(q, schemaDesc, {
			...testCompile,
			installation: identity.schema(parsedSchemaName(schemaIdent))
		}),
		"the span query description compiles"
	)

export type RawRows = ReadonlyArray<ReadonlyArray<string>>

/** The rules the optimized artifact's certificates name: the rewrites a template rests on. */
export const optimizedRules = (template: OracleTemplate): ReadonlySet<CertificateRule> =>
	new Set(Arr.map(template.certificates, (c) => c.rule))

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
