/** Invoke a progress hook without allowing rejected callbacks to escape unhandled. */
export async function invokeProgressSafely(callback, message, onError = () => {}) {
  if (typeof callback !== 'function') return false;
  try {
    await callback(message);
    return true;
  } catch (error) {
    try { onError(error); } catch {}
    return false;
  }
}
