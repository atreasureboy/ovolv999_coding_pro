/**
 * v0.5.5 §6 — RoutingUnavailableError.
 *
 * Thrown by the Coordinator when the Router returns
 * `RouteApplication.kind === 'unavailable'`. The Run is
 * terminated BEFORE any ModelGateway call. The reasonCodes and
 * per-profile circuit state are carried on the error so callers
 * can produce structured exit codes and audit logs.
 */
export class RoutingUnavailableError extends Error {
  readonly reasonCodes: string[]
  readonly profiles: Array<{
    profileId: string
    model: string
    circuit: string
  }>

  constructor(reasonCodes: string[], profiles: Array<{ profileId: string; model: string; circuit: string }> = []) {
    super(
      `routing unavailable: ${reasonCodes.join(',') || 'no profile available'}`,
    )
    this.name = 'RoutingUnavailableError'
    this.reasonCodes = reasonCodes
    this.profiles = profiles
  }
}