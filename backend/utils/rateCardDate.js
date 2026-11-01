const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Resolve and validate the UTC-effective date shared by discovery and review. */
export function resolveRateCardEffectiveDate(value) {
  const text = value == null || value === '' ? new Date().toISOString().slice(0, 10) : String(value).trim();
  const parsed = ISO_DATE.test(text) ? new Date(`${text}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw Object.assign(new Error('Effective date must be a real date in YYYY-MM-DD format.'), {
      code: 'INVALID_EFFECTIVE_DATE',
      status: 400,
    });
  }
  return text;
}
