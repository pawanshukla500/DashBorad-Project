// The filter bar selects Myntra by account (myntra_vb / myntra_ej). The API
// already scopes rows to that account, but many endpoints label each row with
// the marketplace itself ('myntra'), so an exact `row.marketplace === selected`
// check dropped every Myntra row. A generic 'myntra' on either side matches
// its accounts; two different accounts never match each other.
function family(value) {
  return value === 'myntra' || value.startsWith('myntra_') ? 'myntra' : value;
}

export function matchesMarketplace(rowMarketplace, selected) {
  if (!selected || selected === 'all') return true;
  const row = String(rowMarketplace || '').toLowerCase();
  const target = String(selected).toLowerCase();
  if (row === target) return true;
  return family(row) === family(target) && (row === 'myntra' || target === 'myntra');
}
