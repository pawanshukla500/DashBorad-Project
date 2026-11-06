(() => {
  const helpers = {
    isSuccessfulMessage(message) {
      return String(message).includes('✓') || /\b(?:success(?:ful(?:ly)?)?|completed|complete)\b/i.test(String(message));
    },
    shouldRenderChangeDetail(change) {
      if (!change || typeof change !== 'object') return false;
      // All flagged anomalies and removed fees must always be rendered
      if (change.anomaly) return true;
      if (change.changeType === 'REMOVED') return true;
      // FBF Pick & Pack changes and fees must be rendered
      if (change.table === 'rc_pick_pack' || change.type === 'pick_pack') return true;
      // If a change has no slab or explicit summary, render it
      if (!change.slab) return true;
      // Modified commission/fixed slabs without anomaly are already rendered on their parent card rows
      if (change.changeType === 'MODIFIED' && (change.table === 'rc_commission' || change.type === 'commission')) {
        return false;
      }
      return true;
    }
  };
  if (typeof window !== 'undefined') window.rateCardReviewHelpers = helpers;
})();
