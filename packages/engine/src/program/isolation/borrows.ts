import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
/**
 * The installation the borrow rules read (analysis/isolation/borrows.ts BorrowInstallation), from the IR alone: what
 * certification and each login's change compile build once and both read, so no member's verdict or lock plan reads
 * another member's compile.
 */
import * as Result from "@bjornpagen/grizzle-text/base/result"
import {
	type BorrowInstallation,
	borrowInstallation,
	type UnitPlace
} from "#compiler/analysis/isolation/borrows.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"
import { triggerLawsOver } from "#compiler/laws/model/model.ts"
import { checkedRole, grantedPrivileges } from "#compiler/physical/ddl/roles.ts"
import type { ParamSource } from "#compiler/physical/install/plan.ts"
import { relationFacts } from "#compiler/program/isolation/input.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import type { ChangeLogin } from "#compiler/program/workload/change.ts"
import type { OwnedUnit } from "#compiler/schema/own.ts"

/**
 * The borrow rules' installation over `artifacts`, the installation's over every relation, and `logins`, every login
 * it serves: each relation's facts from its law model (input.ts relationFacts); each role's privileges, every role of
 * every login, as its grant plan holds them over its checked world (physical/ddl/roles.ts grantedPrivileges); each
 * relation under a declared unit at its place there, a stored relation (D11) at the unit its holders sit in, its
 * theory's (Theory.stored `declared`), one map every reader reads membership from; and the stored relations. A role
 * whose world does not check is the CompileError its check refuses with.
 */
export const borrowInstallationOf = <S extends ParamSource>(
	artifacts: SchemaArtifacts,
	logins: ReadonlyArray<ChangeLogin<S>>
): Result.Result<BorrowInstallation, CompileError> => {
	const privileges: Array<ReadonlyMap<string, ReadonlySet<TablePrivilege>>> = []
	for (const login of logins) {
		for (const role of login.named.roles) {
			const checked = checkedRole(artifacts.derived.schema, role)
			if (!checked.ok) {
				return checked
			}
			privileges.push(grantedPrivileges(artifacts.laws, checked.value.checked))
		}
	}
	const owned = artifacts.laws.owned
	const units = new Map<string, UnitPlace>()
	for (const [relation, member] of owned.unitOf) {
		units.set(relation, placeIn(owned.units, member.unit, member.fields))
	}
	const stored = artifacts.laws.theory.stored
	for (const [relation, { declared }] of Object.entries(stored)) {
		units.set(relation, placeIn(owned.units, declared.unit, declared.fields))
	}
	return Result.ok(
		borrowInstallation(
			relationFacts(artifacts.laws, triggerLawsOver),
			privileges,
			units,
			new Set(Object.keys(stored))
		)
	)
}

/** A relation's place in the declared unit `unit` (UnitPlace): each field of the unit's heading with the relation's
 * field that holds it, `fields` in the heading's order. */
const placeIn = (
	units: ReadonlyMap<string, OwnedUnit>,
	unit: string,
	fields: NonEmptyReadonlyArray<string>
): UnitPlace => {
	const declared = units.get(unit)
	if (declared === undefined) {
		throw defect(`a relation under unit ${unit}, which its schema declares`)
	}
	return {
		unit,
		fields: mapNonEmpty(declared.heading, (h, i) => {
			const field = fields[i]
			if (field === undefined) {
				throw defect("a relation under a unit holds each field of the unit's declared heading")
			}
			return { key: h.field, field }
		})
	}
}
