import type { LawModel } from "#compiler/laws/model/model.ts"
import { grantedPrivileges, roleUpdates } from "#compiler/physical/ddl/roles.ts"
import type { ArtifactsWorld } from "#compiler/program/schema.ts"
import type { WriteWorld } from "#compiler/write/entry/precheck.ts"

/** What a write compiled over artifacts of `world` writes as (write/entry/precheck.ts WriteWorld): reality, or the role,
 * with its names, the columns its grants let it update (physical/ddl/roles.ts roleUpdates) and the table privileges
 * they hold (grantedPrivileges). */
export const writeWorldOf = (world: ArtifactsWorld, laws: LawModel): WriteWorld =>
	world.kind === "role"
		? {
				kind: "role",
				names: world.names,
				updates: roleUpdates(laws, world.checked.world),
				privileges: grantedPrivileges(laws, world.checked)
			}
		: { kind: "reality" }
