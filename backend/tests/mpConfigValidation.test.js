import { describe, expect, it } from 'vitest';
import { parseMpConfigInput } from '../routes/mpSettlement.js';

describe('marketplace payment configuration validation', () => {
  it('normalizes a valid supported marketplace configuration', () => {
    expect(parseMpConfigInput({
      marketplace: 'MyNtra', displayName: 'Myntra VB', recoType: 'invoice', color: 'Pink', notes: 'VB account',
    })).toEqual({
      marketplace: 'myntra', displayName: 'Myntra VB', recoType: 'invoice', color: 'pink', notes: 'VB account',
    });
  });

  it('rejects unsupported configuration values rather than persisting arbitrary strings', () => {
    expect(() => parseMpConfigInput({ marketplace: 'Myntra!', display_name: 'Myntra' }))
      .toThrow('marketplace must contain');
    expect(() => parseMpConfigInput({ marketplace: 'myntra', display_name: 'Myntra', reco_type: 'anything' }))
      .toThrow('reco_type must be');
    expect(() => parseMpConfigInput({ is_active: 'yes' }, { partial: true }))
      .toThrow('is_active must be true or false');
  });
});
