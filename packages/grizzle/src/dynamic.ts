/**
 * @bjornpagen/grizzle/dynamic, read as gDynamic: the door for a generated schema, whose relations' names are known only
 * at run time. relation, relation.generated, closed.ordered, closed.unordered and closed.relation take any string as a
 * name, and their values are typed AnyRelation, AnyRoster and AnyClosedRelation; records takes any string as a stem and
 * a run-time record of names by attachment path, its value typed GeneratedRecords; derivedName({ stem, path }) builds
 * relations, generated relations and unordered rosters whose names a library derives, as the root's derivedName, each
 * typed as the door's own: the schema's types do not key on such a name, and the run time checks it, as it checks every
 * name. Every relation whose name a literal states is declared through the package root, whose types check it.
 */
export { closed, derivedName, records, relation } from "#compiler/public/dynamic.ts"
