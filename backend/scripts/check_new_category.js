#!/usr/bin/env node

/**
 * Disabled legacy Seller Hub inspector. It replayed plaintext cookies and
 * offered direct PostgreSQL writes. Use the desktop worker's manual sign-in,
 * local staging, comparison, and operator review workflow instead.
 */
console.error('Disabled: run Seller Hub extraction through the ReconCentral desktop worker and review staged rate changes before publishing.');
process.exitCode = 1;
