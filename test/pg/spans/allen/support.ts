import { Array as Arr, Effect, Option, Order, type Scope } from "effect"
import { identity } from "#compiler/core/identity.ts"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import type { StatementSpec } from "#compiler/ir/products.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import type { InstallExtension } from "#compiler/physical/install/extension.ts"
import type { QueryTemplate } from "#compiler/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, paramTexts, testCompile } from "#test/support/compile.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { oracleOwnedLogin } from "#test/support/oracle/install/real.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import type { SqlError } from "#test/support/pg.ts"
import { owning } from "#test/support/policy.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import type { RawSession, SubstrateWorld } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { oracleWorld } from "#test/support/worlds.ts"

export interface InstalledSpans {
	readonly schema: string
	readonly installation: Installation
	/** The installation's one world, the oracle's full role (oracle/install/real.ts oracleLogin). */
	readonly world: SubstrateWorld
}

export interface SpanInstallOptions {
	readonly label: string
	/** The workload extensions whose programs' span predicates request GiST indexes; none for a schema alone. */
	readonly extensions: ReadonlyArray<InstallExtension>
}

/** The schema's installation under `schema`, as `owner` names it. */
const compileSpans = (
	desc: unknown,
	schema: string,
	owner: string,
	options: SpanInstallOptions
): Installation => {
	const owned = owning(desc)
	return succeeded(
		compileInstallation(owned, {
			...installOptions(owned, owner),
			installation: identity.schema(parsedSchemaName(schema)),
			extensions: options.extensions,
			logins: [oracleOwnedLogin(owned.desc)]
		}),
		`the installation of ${options.label}`
	)
}

/**
 * Shared support of the span storage and Allen suites (test/pg/spans/allen, test/pg/spans/storage).
 *
 * A span schema installs through the fresh-install compiler, which gives every span column its shape, width and
 * endpoint CHECKs (physical/span), under a unique schema name, because roles are cluster-wide; a workload extension's GiST
 * requests join the installation's index requests. A query compiles through the program compiler (program/compile.ts) into a template whose two artifacts, optimized and
 * conservative, run statement by statement on a raw session: each placeholder encoded by its statement's own encoder,
 * every result column already cast to text by the template, so a run is the server's raw texts.
 */
export const installSpans = (
	desc: unknown,
	options: SpanInstallOptions
): Effect.Effect<InstalledSpans, SqlError | TransactionRolledBack, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const schema = yield* s.schema({ create: false, label: options.label })
		const installation = compileSpans(desc, schema, s.owner.role, options)
		yield* transaction(s.admin, installation.sql)
		const out: InstalledSpans = { schema, installation, world: yield* oracleWorld(installation) }
		return out
	})

/** A query value compiled for the installed schema. */
export const compileSpanQuery = (q: unknown, schemaIdent: string): QueryTemplate =>
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
	schemaDesc: unknown,
	schemaIdent: string
): QueryTemplate =>
	succeeded(
		compileTemplate(q, schemaDesc, {
			...testCompile,
			installation: identity.schema(parsedSchemaName(schemaIdent))
		}),
		"the span query description compiles"
	)

export type RawRows = ReadonlyArray<ReadonlyArray<string>>

/** The rules the optimized artifact's certificates name: the rewrites a template rests on. */
export const optimizedRules = (template: QueryTemplate): ReadonlySet<CertificateRule> =>
	new Set(Arr.map(template.certificates, (c) => c.rule))

/** Runs one artifact's statements on `session` in order and returns each statement's raw text rows. */
export const runArtifact = (
	session: RawSession,
	template: QueryTemplate,
	artifact: "optimized" | "conservative",
	params: Readonly<Record<string, unknown>>
): Effect.Effect<ReadonlyArray<RawRows>, SqlError> =>
	Effect.gen(function* () {
		const out: Array<RawRows> = []
		for (const spec of template[artifact]) {
			const rows = yield* session.values(spec.sql, paramTexts(spec, params))
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
