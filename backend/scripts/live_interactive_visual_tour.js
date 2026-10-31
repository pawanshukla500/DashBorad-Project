#!/usr/bin/env node

/**
 * Disabled legacy Seller Hub walkthrough. It replayed a plaintext cookie
 * snapshot instead of using the persistent manual-login browser profile.
 * Use the ReconCentral desktop worker to sign in and inspect rate cards.
 */
console.error('Disabled: sign in through the ReconCentral desktop worker to use its persistent Seller Hub profile.');
process.exitCode = 1;
