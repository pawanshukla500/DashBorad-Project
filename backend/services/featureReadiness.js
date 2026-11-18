// Readiness of features whose database schema is applied by a migration that
// may still be pending (it failed on this start and retries on the next one).
// Routes for such a feature answer a clear 503 instead of raw database errors.
// Unknown features count as ready, so development setups that skip startup
// DDL keep working.
const readiness = new Map();

export function setFeatureReadiness(feature, ready, message) {
  if (ready) readiness.delete(feature);
  else readiness.set(feature, message || `${feature} is temporarily unavailable.`);
}

/** The unavailability message, or null when the feature is ready. */
export function featureUnavailable(feature) {
  return readiness.get(feature) ?? null;
}

/** Express middleware answering 503 while `feature` is not ready. */
export function requireFeatureReady(feature) {
  return function featureReadyGuard(req, res, next) {
    const message = featureUnavailable(feature);
    if (message) return res.status(503).json({ error: message, feature });
    return next();
  };
}
