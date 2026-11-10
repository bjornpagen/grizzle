/**
 * A table privilege a role's grant plan holds on a base relation's table, a column privilege counting as its table's:
 * what certification reads of each role (analysis/isolation/facts.ts RoleFacts.privileges).
 */
export type TablePrivilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE"
