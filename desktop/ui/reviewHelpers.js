(() => {
  const helpers = {
    isSuccessfulMessage(message) {
      return String(message).includes('✓') || /\b(?:success(?:ful(?:ly)?)?|completed|complete)\b/i.test(String(message));
    },
    shouldRenderChangeDetail(change) {
      if (change?.table === 'rc_pick_pack') return false;
      if (change?.changeType) return change.changeType === 'REMOVED';
      return !change?.slab;
    }
  };
  if (typeof window !== 'undefined') window.rateCardReviewHelpers = helpers;
})();
