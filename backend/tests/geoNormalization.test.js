import { describe, it, expect } from 'vitest';
import { normalizeDeliveryState, CANONICAL_STATES } from '../utils/geoNormalization.js';

describe('geoNormalization', () => {
  it('correctly maps 2-letter ISO state codes to canonical names', () => {
    expect(normalizeDeliveryState('BR')).toBe('Bihar');
    expect(normalizeDeliveryState('DL')).toBe('Delhi');
    expect(normalizeDeliveryState('UP')).toBe('Uttar Pradesh');
    expect(normalizeDeliveryState('MP')).toBe('Madhya Pradesh');
    expect(normalizeDeliveryState('MH')).toBe('Maharashtra');
    expect(normalizeDeliveryState('KA')).toBe('Karnataka');
    expect(normalizeDeliveryState('HR')).toBe('Haryana');
    expect(normalizeDeliveryState('RJ')).toBe('Rajasthan');
    expect(normalizeDeliveryState('PB')).toBe('Punjab');
    expect(normalizeDeliveryState('WB')).toBe('West Bengal');
    expect(normalizeDeliveryState('GJ')).toBe('Gujarat');
    expect(normalizeDeliveryState('TG')).toBe('Telangana');
    expect(normalizeDeliveryState('TS')).toBe('Telangana');
    expect(normalizeDeliveryState('AP')).toBe('Andhra Pradesh');
    expect(normalizeDeliveryState('TN')).toBe('Tamil Nadu');
    expect(normalizeDeliveryState('KL')).toBe('Kerala');
    expect(normalizeDeliveryState('OD')).toBe('Odisha');
    expect(normalizeDeliveryState('OR')).toBe('Odisha');
    expect(normalizeDeliveryState('JH')).toBe('Jharkhand');
    expect(normalizeDeliveryState('AS')).toBe('Assam');
    expect(normalizeDeliveryState('UK')).toBe('Uttarakhand');
    expect(normalizeDeliveryState('UT')).toBe('Uttarakhand');
    expect(normalizeDeliveryState('UA')).toBe('Uttarakhand');
    expect(normalizeDeliveryState('HP')).toBe('Himachal Pradesh');
    expect(normalizeDeliveryState('JK')).toBe('Jammu and Kashmir');
    expect(normalizeDeliveryState('GA')).toBe('Goa');
    expect(normalizeDeliveryState('CH')).toBe('Chandigarh');
    expect(normalizeDeliveryState('PY')).toBe('Puducherry');
    expect(normalizeDeliveryState('TR')).toBe('Tripura');
    expect(normalizeDeliveryState('MN')).toBe('Manipur');
    expect(normalizeDeliveryState('ML')).toBe('Meghalaya');
    expect(normalizeDeliveryState('MZ')).toBe('Mizoram');
    expect(normalizeDeliveryState('NL')).toBe('Nagaland');
    expect(normalizeDeliveryState('SK')).toBe('Sikkim');
    expect(normalizeDeliveryState('AR')).toBe('Arunachal Pradesh');
    expect(normalizeDeliveryState('LA')).toBe('Ladakh');
    expect(normalizeDeliveryState('AN')).toBe('Andaman and Nicobar Islands');
    expect(normalizeDeliveryState('DN')).toBe('Dadra and Nagar Haveli and Daman and Diu');
    expect(normalizeDeliveryState('DD')).toBe('Dadra and Nagar Haveli and Daman and Diu');
  });

  it('normalizes uppercase and mixed-case full names', () => {
    expect(normalizeDeliveryState('MAHARASHTRA')).toBe('Maharashtra');
    expect(normalizeDeliveryState('UTTAR PRADESH')).toBe('Uttar Pradesh');
    expect(normalizeDeliveryState('madhya pradesh')).toBe('Madhya Pradesh');
    expect(normalizeDeliveryState('kArNaTaKa')).toBe('Karnataka');
    expect(normalizeDeliveryState('WEST BENGAL')).toBe('West Bengal');
  });

  it('handles historical and alternate spellings', () => {
    expect(normalizeDeliveryState('Orissa')).toBe('Odisha');
    expect(normalizeDeliveryState('uttaranchal')).toBe('Uttarakhand');
    expect(normalizeDeliveryState('pondicherry')).toBe('Puducherry');
    expect(normalizeDeliveryState('Jammu & Kashmir')).toBe('Jammu and Kashmir');
    expect(normalizeDeliveryState('J&K')).toBe('Jammu and Kashmir');
    expect(normalizeDeliveryState('Dadra & Nagar Haveli')).toBe('Dadra and Nagar Haveli and Daman and Diu');
    expect(normalizeDeliveryState('Daman and Diu')).toBe('Dadra and Nagar Haveli and Daman and Diu');
  });

  it('returns null for empty or invalid placeholder values', () => {
    expect(normalizeDeliveryState(null)).toBeNull();
    expect(normalizeDeliveryState(undefined)).toBeNull();
    expect(normalizeDeliveryState('')).toBeNull();
    expect(normalizeDeliveryState('   ')).toBeNull();
    expect(normalizeDeliveryState('-')).toBeNull();
    expect(normalizeDeliveryState('CONFIDENTIAL')).toBeNull();
    expect(normalizeDeliveryState('null')).toBeNull();
    expect(normalizeDeliveryState('undefined')).toBeNull();
    expect(normalizeDeliveryState('123')).toBeNull();
    expect(normalizeDeliveryState('x')).toBeNull();
  });

  it('has 36 canonical Indian States and UTs', () => {
    expect(CANONICAL_STATES.length).toBe(36);
  });
});
