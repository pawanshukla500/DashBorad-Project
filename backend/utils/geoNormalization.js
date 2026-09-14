/**
 * Indian State & UT Canonical Normalization Utility
 * 
 * Standardizes raw state names, ISO 3166-2:IN codes (e.g. BR, DL, UP, MH),
 * and alternate/historical spellings into clean, canonical Title Case names.
 */

export const CANONICAL_STATES = [
  // 28 States
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chhattisgarh',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
  // 8 Union Territories
  'Andaman and Nicobar Islands',
  'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Jammu and Kashmir',
  'Ladakh',
  'Lakshadweep',
  'Puducherry',
];

export const STATE_ALIAS_MAP = {
  // ISO 3166-2:IN 2-Letter Codes and common abbreviations
  'an': 'Andaman and Nicobar Islands',
  'ap': 'Andhra Pradesh',
  'ar': 'Arunachal Pradesh',
  'as': 'Assam',
  'br': 'Bihar',
  'cg': 'Chhattisgarh',
  'ch': 'Chandigarh',
  'ct': 'Chhattisgarh',
  'dd': 'Dadra and Nagar Haveli and Daman and Diu',
  'dl': 'Delhi',
  'dn': 'Dadra and Nagar Haveli and Daman and Diu',
  'dnh': 'Dadra and Nagar Haveli and Daman and Diu',
  'ga': 'Goa',
  'gj': 'Gujarat',
  'hp': 'Himachal Pradesh',
  'hr': 'Haryana',
  'jh': 'Jharkhand',
  'jk': 'Jammu and Kashmir',
  'ka': 'Karnataka',
  'kl': 'Kerala',
  'la': 'Ladakh',
  'ld': 'Lakshadweep',
  'lk': 'Ladakh',
  'mh': 'Maharashtra',
  'ml': 'Meghalaya',
  'mn': 'Manipur',
  'mp': 'Madhya Pradesh',
  'mz': 'Mizoram',
  'nl': 'Nagaland',
  'od': 'Odisha',
  'or': 'Odisha',
  'pb': 'Punjab',
  'py': 'Puducherry',
  'rj': 'Rajasthan',
  'sk': 'Sikkim',
  'tg': 'Telangana',
  'tn': 'Tamil Nadu',
  'tr': 'Tripura',
  'ts': 'Telangana',
  'ua': 'Uttarakhand',
  'uk': 'Uttarakhand',
  'up': 'Uttar Pradesh',
  'ut': 'Uttarakhand',
  'wb': 'West Bengal',

  // Full names and common spelling variations
  'andaman and nicobar islands': 'Andaman and Nicobar Islands',
  'andaman & nicobar islands': 'Andaman and Nicobar Islands',
  'andaman and nicobar': 'Andaman and Nicobar Islands',
  'andaman & nicobar': 'Andaman and Nicobar Islands',
  'andhra pradesh': 'Andhra Pradesh',
  'arunachal pradesh': 'Arunachal Pradesh',
  'assam': 'Assam',
  'bihar': 'Bihar',
  'chandigarh': 'Chandigarh',
  'chhattisgarh': 'Chhattisgarh',
  'chattisgarh': 'Chhattisgarh',
  'dadra and nagar haveli': 'Dadra and Nagar Haveli and Daman and Diu',
  'dadra & nagar haveli': 'Dadra and Nagar Haveli and Daman and Diu',
  'daman and diu': 'Dadra and Nagar Haveli and Daman and Diu',
  'daman & diu': 'Dadra and Nagar Haveli and Daman and Diu',
  'dadra and nagar haveli and daman and diu': 'Dadra and Nagar Haveli and Daman and Diu',
  'dadra & nagar haveli & daman & diu': 'Dadra and Nagar Haveli and Daman and Diu',
  'delhi': 'Delhi',
  'new delhi': 'Delhi',
  'nct of delhi': 'Delhi',
  'delhi ncr': 'Delhi',
  'national capital territory of delhi': 'Delhi',
  'goa': 'Goa',
  'gujarat': 'Gujarat',
  'haryana': 'Haryana',
  'himachal pradesh': 'Himachal Pradesh',
  'jammu and kashmir': 'Jammu and Kashmir',
  'jammu & kashmir': 'Jammu and Kashmir',
  'jammu & kashmir (ut)': 'Jammu and Kashmir',
  'j&k': 'Jammu and Kashmir',
  'j & k': 'Jammu and Kashmir',
  'jharkhand': 'Jharkhand',
  'karnataka': 'Karnataka',
  'kerala': 'Kerala',
  'ladakh': 'Ladakh',
  'lakshadweep': 'Lakshadweep',
  'madhya pradesh': 'Madhya Pradesh',
  'maharashtra': 'Maharashtra',
  'manipur': 'Manipur',
  'meghalaya': 'Meghalaya',
  'mizoram': 'Mizoram',
  'nagaland': 'Nagaland',
  'odisha': 'Odisha',
  'orissa': 'Odisha',
  'puducherry': 'Puducherry',
  'pondicherry': 'Puducherry',
  'punjab': 'Punjab',
  'rajasthan': 'Rajasthan',
  'sikkim': 'Sikkim',
  'tamil nadu': 'Tamil Nadu',
  'telangana': 'Telangana',
  'tripura': 'Tripura',
  'uttar pradesh': 'Uttar Pradesh',
  'uttarakhand': 'Uttarakhand',
  'uttaranchal': 'Uttarakhand',
  'west bengal': 'West Bengal',
};

// Set of canonical names in lowercase for fast lookup
const CANONICAL_LOWER_MAP = new Map(
  CANONICAL_STATES.map(state => [state.toLowerCase(), state])
);

/**
 * Normalizes an arbitrary state name/code into its canonical Indian State/UT name.
 * 
 * @param {string|any} rawState - Raw state code or name (e.g. 'BR', 'DL', 'UTTAR PRADESH', 'bihar')
 * @returns {string|null} - Canonical Title Case state name, or null if empty/invalid/unrecognized
 */
export function normalizeDeliveryState(rawState) {
  if (rawState == null) return null;
  const strVal = String(rawState).trim();
  if (!strVal) return null;

  // Filter out placeholder/invalid strings
  const lower = strVal.toLowerCase();
  if (
    lower === '-' ||
    lower === 'null' ||
    lower === 'undefined' ||
    lower === 'none' ||
    lower === 'n/a' ||
    lower === 'na' ||
    lower === 'confidential' ||
    lower === 'unknown'
  ) {
    return null;
  }

  // Clean punctuation and excess whitespace
  const cleanKey = lower
    .replace(/[.']/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // 1. Direct alias / code lookup (e.g. 'br' -> 'Bihar', 'dl' -> 'Delhi')
  if (STATE_ALIAS_MAP[cleanKey]) {
    return STATE_ALIAS_MAP[cleanKey];
  }

  // 2. Exact match against canonical states (case-insensitive)
  if (CANONICAL_LOWER_MAP.has(cleanKey)) {
    return CANONICAL_LOWER_MAP.get(cleanKey);
  }

  // 3. If valid string not in dictionary, format as Title Case fallback
  // Ignore purely numeric or single-letter noise
  if (/^[0-9]+$/.test(cleanKey) || cleanKey.length < 2) {
    return null;
  }

  return cleanKey
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
