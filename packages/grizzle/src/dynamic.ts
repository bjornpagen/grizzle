/**
 * @bjornpagen/grizzle/dynamic: the door for a generated schema, whose relations' names are known only at run time.
 * relation, relation.generated, closed.ordered, closed.unordered and closed.relation take any string as a name, and
 * their values are typed AnyRelation, AnyRoster and AnyClosedRelation: the schema's types do not key on such a name,
 * and the run time checks it, as it checks every name. Every relation whose name a literal states is declared through
 * the package root, whose types check it.
 */
export { closed, relation } from "#compiler/public/dynamic.ts"
