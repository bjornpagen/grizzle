import { dropFormerLiveSlot } from "#compiler/physical/ddl/live.ts"
import type { ObjectName, SqlStatement } from "#compiler/sql/ast.ts"

/**
 * An object a live installation holds that no object of the target is, by its PostgreSQL identity: what its drop
 * names. `grizzle upgrade` reads them off the drift check of the target against the live catalog (the shell's
 * cli/upgrade.ts), where an installation's committed snapshot is of another format: an object of the format before
 * that the format after names otherwise, or no longer installs. Each holds no stored data, which the reader refuses
 * before any departure is drafted: a function, a key or CHECK or foreign key, a trigger, a policy, an index, a
 * statistics object, a view, a materialized view (whose rows its definition computes again), a domain, a composite
 * type, a generated column (a law column, which PostgreSQL computes from its row), a table's row security or replica
 * identity, a schema of views, the database default an installation of format 7 or before set,
 * default_transaction_isolation serializable, which grizzle no longer sets and which its departure resets, and a
 * replication slot a leader of format 7 or before made in the database, named by its decoder login, which no leader of
 * this grizzle reads or drops and which holds its WAL while it stands.
 */
export type Departure =
	| { readonly kind: "function"; readonly name: ObjectName }
	| {
			readonly kind: "constraint" | "trigger" | "policy"
			readonly table: ObjectName
			readonly name: string
	  }
	| {
			readonly kind: "index" | "statistics" | "view" | "materializedView" | "domain" | "type"
			readonly name: ObjectName
	  }
	| { readonly kind: "generatedColumn"; readonly table: ObjectName; readonly column: string }
	| { readonly kind: "rowSecurity" | "replicaIdentity"; readonly table: ObjectName }
	| { readonly kind: "schema"; readonly name: string }
	| { readonly kind: "databaseDefault" }
	| { readonly kind: "formerLiveSlot"; readonly name: string }

/** The drop of a departed object, RESTRICT, as a drop of the diff's own removals is: nothing outside it goes with it. */
export const departureDrop = (d: Departure): SqlStatement => {
	switch (d.kind) {
		case "function":
			return { kind: "drop", object: "FUNCTION", name: d.name, ifExists: false }
		case "constraint":
			return {
				kind: "alterTable",
				table: d.table,
				actions: [{ kind: "dropConstraint", name: d.name }]
			}
		case "trigger":
			return { kind: "dropTrigger", name: d.name, table: d.table, ifExists: false }
		case "policy":
			return { kind: "dropPolicy", name: d.name, table: d.table }
		case "index":
			return { kind: "dropIndex", name: d.name, concurrently: false, ifExists: false }
		case "statistics":
			return { kind: "drop", object: "STATISTICS", name: d.name, ifExists: false }
		case "view":
			return { kind: "drop", object: "VIEW", name: d.name, ifExists: false }
		case "materializedView":
			return { kind: "drop", object: "MATERIALIZED VIEW", name: d.name, ifExists: false }
		case "domain":
			return { kind: "drop", object: "DOMAIN", name: d.name, ifExists: false }
		case "type":
			return { kind: "drop", object: "TYPE", name: d.name, ifExists: false }
		case "generatedColumn":
			return {
				kind: "alterTable",
				table: d.table,
				actions: [{ kind: "dropColumn", column: d.column }]
			}
		case "rowSecurity":
			return { kind: "alterTable", table: d.table, actions: [{ kind: "disableRowSecurity" }] }
		case "replicaIdentity":
			return {
				kind: "alterTable",
				table: d.table,
				actions: [{ kind: "replicaIdentity", identity: "default" }]
			}
		case "schema":
			return { kind: "drop", object: "SCHEMA", name: d.name, ifExists: false }
		case "databaseDefault":
			return { kind: "resetDatabaseDefault", parameter: "default_transaction_isolation" }
		case "formerLiveSlot":
			return dropFormerLiveSlot(d.name)
	}
}
