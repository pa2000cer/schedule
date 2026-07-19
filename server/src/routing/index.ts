/**
 * Model-routing layer (T9) — public surface.
 *
 *   - `triage(request, opts?)` classifies a request into `"haiku"|"sonnet"|"opus"`.
 *   - `routeAndExecute(request, opts)` triages, then executes the action call
 *     on the chosen tier and returns the route, the concrete model id, and
 *     the result text.
 *
 * See `./triage.ts` and `./router.ts` for implementation details, and
 * [[Model Routing]] in the vault for the routing policy this implements.
 */
export { triage } from "./triage";
export { routeAndExecute } from "./router";
export { MODELS } from "./types";
export type { Route, TriageOptions, RouteAndExecuteOptions, RouteAndExecuteResult } from "./types";
