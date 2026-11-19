import { Effect, type Scope } from "effect"
import { identity } from "#compiler/core/identity.ts"
import type { ConstraintName, LawId } from "#compiler/core/ids.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import type { SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { installationNamesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { oracleOwnedLogin } from "#test/support/oracle/install/real.ts"
import type { SqlError } from "#test/support/pg.ts"
import { owning } from "#test/support/policy.ts"
import { type ScriptInstall, scriptTemplate } from "#test/support/script-template.ts"
import { installationGroup, type ResetGroup } from "#test/support/substrate/replace.ts"
import type { RawSession, SubstrateWorld } from "#test/support/substrate/session.ts"
import { Substrate, type SubstrateCase, worldSession } from "#test/support/substrate/substrate.ts"

export interface SpanInstall {
	readonly schema: string
	/** The quoted schema, for SQL text. */
	readonly q: string
	readonly installation: Installation
	/** The oracle's full role, as a direct SQL writer takes it on. */
	readonly writer: SubstrateWorld
	/** The quoted, schema-qualified table of a relation. */
	readonly table: (relation: string) => string
	/** Every relation's table, which a reset truncates together (substrate/replace.ts). */
	readonly group: ResetGroup
	/** The installed name of the PERIOD foreign key that enforces a coverage law, read through the naming door. */
	readonly periodForeignKey: (law: LawId) => ConstraintName
}

/** A span-law schema's installation under `schema`, every law native, with the oracle's one login. */
const compileSpanLaws = (desc: SchemaDesc, schema: string): Installation => {
	const owned = owning(desc)
	return succeeded(
		compileInstallation(owned, {
			...installOptions(owned),
			levels: [identity.schema(parsedSchemaName(schema))],
			logins: [oracleOwnedLogin(owned.desc)]
		}),
		"the span-law schema compiles"
	)
}

/** An installation of a span-law schema under `schema` as a case reads it, its writer taking on `writer`. */
const spanInstallOf = (
	schema: string,
	installation: Installation,
	writer: SubstrateWorld
): SpanInstall => {
	const names = installationNamesOf(installation)
	const q = quoteIdent(schema)
	return {
		schema,
		q,
		installation,
		writer,
		table: (relation: string) => `${q}.${quoteIdent(names.tableIdent({ name: relation }))}`,
		group: installationGroup(names),
		periodForeignKey: (law: LawId) => names.constraintOf(law, "PeriodForeignKey")
	}
}

/**
 * A span-law schema for the span law tests installed through the real fresh-install compiler, every law native: a
 * coverage is a PERIOD foreign key, from a selected source's range law column, into a target keyed WITHOUT OVERLAPS
 * (fin.md §7). Its script runs as the owner in one transaction once per member (script-template.ts scriptTemplate),
 * under the template's name, with the oracle's one login, where a suite installed it in every case; a case reads its
 * SpanInstall over its clone (spanInstallIn), and its writer takes on its full role with only its derived grants, as a
 * grizzle connection or a psql writer does.
 */
export const spanLawsTemplate = (declaredIn: ImportMeta, desc: SchemaDesc, label: string) =>
	scriptTemplate({
		declaredIn,
		name: label,
		label,
		compile: (schema) => compileSpanLaws(desc, schema)
	})

/** The SpanInstall of a case over a clone of a span-law template (spanLawsTemplate). */
export const spanInstallIn = (taken: SubstrateCase<ScriptInstall>): SpanInstall =>
	spanInstallOf(taken.value.schema, taken.value.installation, taken.value.world)

/** A writer session taking on the schema's full role, holding only its derived grants. */
export const writerOf = (
	install: SpanInstall,
	label: string
): Effect.Effect<RawSession, SqlError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		return yield* substrate.session({ ...worldSession(install.writer), label })
	})
