import type { SqlCatalog } from "#test/support/kernel/sqlgen.ts"

/**
 * The catalog the SQL suites generate statements over (the kernel's statementGen): a table's first column is its key,
 * and its names are words SQL reserves and spellings only quoting keeps names, so the printer must quote them and the
 * text audit must tell them from SQL.
 */
export const sqlCatalog: SqlCatalog = [
	{
		schema: "audit",
		name: "order",
		columns: [
			{ name: "id", type: "bigint" },
			{ name: "select", type: "text" },
			{ name: "is null", type: "boolean" },
			{ name: "amount", type: "numeric" }
		]
	},
	{
		schema: "audit",
		name: "line item",
		columns: [
			{ name: "id", type: "bigint" },
			{ name: "order", type: "bigint" },
			{ name: "rank", type: "integer" },
			{ name: 'say "hi"', type: "text" }
		]
	},
	{ schema: "audit", name: "tag", columns: [{ name: "label", type: "text" }] }
]
