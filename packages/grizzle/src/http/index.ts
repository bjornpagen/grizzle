/**
 * @bjornpagen/grizzle/http: a login's served workload over HTTP. httpHandler builds a fetch-style handler from the
 * served logins whose DbLayers its Effect requires, one route per member of each of their roles, `POST
 * /<login>/<role>/<program>`, each call answered by a text/event-stream of its events; nodeListener mounts it on
 * node:http's or node:http2's server; httpRoutes lists the routes a set of served logins gives.
 */
export {
	type HttpConfig,
	type HttpConfigFault,
	HttpConfigRefused,
	type HttpHandler,
	httpHandler
} from "#http/handler.ts"
export { type NodeRequest, type NodeResponse, nodeListener } from "#http/node.ts"
export { type HttpRoute, httpRoutes } from "#http/routes.ts"
