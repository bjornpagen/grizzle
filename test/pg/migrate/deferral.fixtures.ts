/** What the properties of deferral.test.ts read: its box, its versions and its walk. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { generated, int4 } from "#compiler/public/fields.ts"
import { contained, on, relation, schema } from "#compiler/public/schema.ts"
import { ambientOwner, ordinarySession } from "#test/support/ambient.ts"
import { joined } from "#test/support/chunked.ts"
import {
	type DraftedVersion,
	draftVersion,
	expectFreshCatalog,
	noPlaceholders
} from "#test/support/install-migrate.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import {
	fromEmpty,
	fromSnapshot,
	noDeclarations,
	type Previous
} from "#test/support/migrate/kit.ts"
import type { RealInstallPlan } from "#test/support/oracle/install/real.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { apply, checkedAdmission, openMigrator } from "#test/support/pg/migrate/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Parent as a version declares it: keyed by its one field, or with a field PostgreSQL generates beside its key. */
const parents = ["its key alone", "a generated field beside its key"] as const
type ParentShape = (typeof parents)[number]

export interface DeferralCase {
	readonly before: ParentShape
	readonly after: ParentShape
}

export const caseGen: Gen<DeferralCase> = (s) => ({
	before: s.draw(element(parents)),
	after: s.draw(element(parents))
})

const ParentAlone = relation("Parent", { id: int4 }, ["id"])

const ParentBeside = relation.generated("Parent", { id: int4 }, ["id"], (r) => ({
	copy: generated(int4, r.id)
}))

/** Child, keyed apart from Parent, its parent field contained in Parent's key: a foreign key whatever the version, its
 * join across units (laws/model/plan.ts containmentDischarge). */
const Child = relation("Child", { id: int4, parent: int4 }, ["id"])

/** The version whose Parent has `shape`, under `name`. */
const schemaOf = (name: string, shape: ParentShape) => {
	switch (shape) {
		case "its key alone":
			return schema(
				name,
				[ParentAlone, Child],
				[contained(on(Child, "parent"), on(ParentAlone, "id"))]
			)
		case "a generated field beside its key":
			return schema(
				name,
				[ParentBeside, Child],
				[contained(on(Child, "parent"), on(ParentBeside, "id"))]
			)
	}
}

/** The installed name of the one foreign key of a version, Child's into Parent. */
const foreignKeyOf = (plan: RealInstallPlan): string =>
	Option.getOrThrowWith(
		Arr.findFirst(
			Arr.flatMap(plan.installation.laws.natives, (n) =>
				n.namespace === "constraint" && n.object.kind === "ForeignKey"
					? [identifierOf(n.named)]
					: []
			),
			() => true
		),
		() => new Error("the version's one foreign key")
	)

/** Whether the foreign key is DEFERRABLE INITIALLY DEFERRED in a version: Parent holds a field beside the key it
 * references (laws/model/model.ts #deferral). */
const deferredIn = (shape: ParentShape): boolean => shape === "a generated field beside its key"

/** The statements of a folder's files that name the constraint `name`, each with its file. */
const naming = (draft: DraftedVersion, name: string) =>
	Arr.flatMap(draft.folder.files, (f) =>
		Arr.map(
			Arr.filter(Str.split(joined(f.text), ";\n"), Str.includes(quoteIdent(name))),
			(statement) => ({
				file: f.name,
				statement: Str.trim(statement)
			})
		)
	)

export type Feature = "immediate then deferred" | "deferred then immediate" | "its deferral kept"

export const walk = (c: DeferralCase, note: (feature: Feature) => void) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const name = yield* substrate.schema({ create: false, label: "deferral" })
		const installation = identity.schema(parsedSchemaName(name))
		const table = (relationName: string) =>
			`${quoteIdent(identifierOf(installation))}.${quoteIdent(identifierOf(identity.table(parsedName(relationName))))}`
		const ownerLogin = yield* ambientOwner(ordinarySession, [identifierOf(installation)])
		const migrator = yield* openMigrator(substrate, ownerLogin.credentials)
		const drafted: Array<DraftedVersion> = []
		let previous: Previous = fromEmpty
		for (const [step, shape] of [c.before, c.after].entries()) {
			const draft = yield* draftVersion(
				{ schema: schemaOf(name, shape), declarations: noDeclarations },
				{ installation, previous, step },
				{ extensions: [], compile: compileInstallation, review: noPlaceholders }
			)
			drafted.push(draft)
			previous = fromSnapshot(draft.snapshot)
			const folders = Arr.map(drafted, (d) => d.folder)
			yield* apply(
				migrator,
				{ snapshot: draft.snapshot, folders },
				checkedAdmission(draft.plan.installation, substrate.admin)
			).pipe(Effect.orDie)
			if (step === 0) {
				yield* transaction(substrate.admin, [
					`INSERT INTO ${table("Parent")} (id) VALUES (1), (2)`,
					`INSERT INTO ${table("Child")} (id, parent) VALUES (1, 1), (2, 1), (3, 2)`
				])
				continue
			}
			const fk = foreignKeyOf(draft.plan)
			const statements = naming(draft, fk)
			if (deferredIn(c.before) === deferredIn(c.after)) {
				assert.deepEqual(statements, [], `the folder names the kept foreign key ${fk} nowhere`)
				note("its deferral kept")
			} else {
				const [only, ...more] = statements
				assert.deepEqual(more, [], `one statement names ${fk}: ${Formatter.format(statements)}`)
				assert.ok(
					only !== undefined &&
						Str.endsWith("-publish.sql")(only.file) &&
						Str.includes(
							`ALTER CONSTRAINT ${quoteIdent(fk)} ${deferredIn(c.after) ? "DEFERRABLE INITIALLY DEFERRED" : "NOT DEFERRABLE"}`
						)(only.statement),
					`its deferral changed in place, in Publish: ${Formatter.format(statements)}`
				)
				note(deferredIn(c.after) ? "immediate then deferred" : "deferred then immediate")
			}
			yield* expectFreshCatalog(draft.plan.installation, folders, draft.planned)
		}
	})
