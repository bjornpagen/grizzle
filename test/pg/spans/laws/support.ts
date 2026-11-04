import { Array as Arr, Effect, Option, Record as Rec, type Scope } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { lawUnits, namedDetail, type ResidualLaw } from "#compiler/ir/law.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { withResidualLaws } from "#compiler/physical/laws/objects.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { installationSql } from "#test/support/compile.ts"
import { strictDetail } from "#test/support/detail.ts"
import type { SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { installationNamesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { oracleOwnedLogin } from "#test/support/oracle/install/real.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import type { SqlError } from "#test/support/pg.ts"
import { owning } from "#test/support/policy.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { installationGroup, type ResetGroup } from "#test/support/substrate/replace.ts"
import type { RawSession, SubstrateWorld } from "#test/support/substrate/session.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { oracleWorld } from "#test/support/worlds.ts"

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
	readonly residual: (id: string) => ResidualLaw
	/** The installed name of the native constraint that enforces a law. */
	readonly constraint: (law: string) => string
	/** The `SET CONSTRAINTS ... IMMEDIATE` of a law's trigger on a relation, schema-qualified. */
	readonly immediate: (law: string, relation: string) => string
}

const compileSpans = (desc: SchemaDesc, schema: string, owner: string) => {
	const owned = owning(desc)
	return compileInstallation(
		owned,
		withResidualLaws({
			...installOptions(owned, owner),
			installation: identity.schema(parsedSchemaName(schema)),
			logins: [oracleOwnedLogin(owned.desc)]
		})
	)
}

/**
 * Installing span-law schemas for the span law tests through the real installer: the fresh-install compiler with the
 * residual law extension (packages/engine/src/physical/laws), whose selected-source coverage functions come from the
 * coverage family (packages/engine/src/laws/families/coverage). The script runs as the owner in one transaction,
 * under a unique schema name, because roles are cluster-wide, with the oracle's one login; the writer takes on its full
 * role with only its derived grants, as a grizzle connection or a psql writer does.
 */
export const installSpans = (
	desc: SchemaDesc,
	label: string
): Effect.Effect<SpanInstall, SqlError | TransactionRolledBack, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const schema = yield* substrate.schema({ create: false, label })
		const compiled = compileSpans(desc, schema, substrate.owner.role)
		if (!compiled.ok) {
			return yield* Effect.die(new Error(`compile: ${compiled.error.message}`))
		}
		const installation = compiled.value
		yield* transaction(substrate.admin, installationSql(installation))
		const writer = yield* oracleWorld(installation)
		const q = quoteIdent(schema)
		return {
			schema,
			q,
			installation,
			writer,
			table: (relation: string) =>
				`${q}.${quoteIdent(
					Option.getOrThrowWith(
						Arr.findFirst(
							Rec.values(installation.laws.theory.relations),
							(r) => r.name === relation
						),
						() => new Error(`no relation ${relation}`)
					).ident
				)}`,
			group: installationGroup(installationNamesOf(installation)),
			residual: (id: string) =>
				Option.getOrThrowWith(
					Arr.findFirst(installation.laws.residuals, (r) => r.lawId === id),
					() =>
						new Error(
							`no residual law ${id}; there are ${Arr.join(
								Arr.map(installation.laws.residuals, (r) => r.lawId),
								", "
							)}`
						)
				),
			constraint: (law: string) =>
				Option.getOrThrowWith(
					Arr.findFirst(
						installation.laws.constraints,
						(c) => c.law === law && c.kind === "constraint"
					),
					() => new Error(`no constraint enforces ${law}`)
				).name,
			immediate: (law: string, relation: string) => {
				const units = Arr.flatMap(
					Arr.filter(installation.laws.residuals, (r) => r.lawId === law),
					lawUnits
				)
				const triggers = Arr.flatMap(units, (u) =>
					u.participant.relation.name === relation
						? [`${q}.${quoteIdent(identifierOf(u.unit.trigger))}`]
						: []
				)
				if (!Arr.isReadonlyArrayNonEmpty(triggers)) {
					throw new Error(`no trigger of law ${law} on ${relation}`)
				}
				return `SET CONSTRAINTS ${Arr.join(triggers, ", ")} IMMEDIATE`
			}
		} satisfies SpanInstall
	})

/** A writer session taking on the schema's full role, holding only its derived grants. */
export const writerOf = (
	install: SpanInstall,
	label: string
): Effect.Effect<RawSession, SqlError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		return yield* substrate.session({ ...worldSession(install.writer), label })
	})

/** The key texts of a law function's DETAIL (DetailCodec), or a failure naming what was wrong. */
export const witness = (law: ResidualLaw, detail: Option.Option<string>): ReadonlyArray<string> => {
	if (Option.isNone(detail)) {
		throw new Error(`law ${law.lawId} raised without a DETAIL`)
	}
	return strictDetail(namedDetail(law.detail), detail.value)
}
