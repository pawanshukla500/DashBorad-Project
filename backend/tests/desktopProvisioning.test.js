import { describe, expect, it } from 'vitest';
import {
  desktopAnalystDatabaseUrl,
  desktopDatabaseUrl,
  desktopDatabaseProvisioningForRole,
  isPubliclyRoutableDbHost
} from '../utils/desktopProvisioning.js';

describe('isPubliclyRoutableDbHost', () => {
  it.each([
    ['db.example.com'],
    ['aws-0-ap-south-1.pooler.supabase.com'],
    ['face.cafe'],                    // bare hex-letter DNS labels are hostnames, not IPv4 forms
    ['dead.beef'],
    ['8.8.8.8'],
    ['100.63.255.1'],                // just below the CGNAT range
    ['100.128.0.1'],                 // just above the CGNAT range
    ['2001:4860:4860::8888']
  ])('accepts public host %s', (host) => {
    expect(isPubliclyRoutableDbHost(host)).toBe(true);
  });

  it.each([
    ['postgres'],                    // container-internal service name (the production bug)
    ['db'],                          // single-label service name
    ['localhost'],
    ['localhost.'],                  // fully-qualified loopback
    ['db.localhost'],                // RFC 6761 loopback subdomain
    ['postgres.'],                   // trailing-dot service name
    ['127.0.0.1'],
    ['127.0.1.1'],
    ['0177.0.0.1'],                // octal loopback
    ['127.1'],                     // short-form loopback
    ['0x7f.0.0.1'],                // hex loopback
    ['08.0.0.1'],                  // malformed octal-looking host
    ['2130706433'],                // single-number IPv4 (loopback)
    ['db.example'],                // RFC 2606 reserved documentation TLD
    ['db.invalid'],                // RFC 2606 reserved TLD
    ['payment.test'],              // RFC 6761 reserved testing TLD
    ['::1'],                         // IPv6 loopback
    ['0.0.0.0'],
    ['10.0.0.5'],                    // private IPv4
    ['192.168.1.10'],
    ['172.16.0.2'],
    ['172.31.255.254'],
    ['169.254.1.1'],                 // link-local
    ['fc00::1'],                     // private IPv6
    ['fe80::1'],                     // link-local IPv6
    ['100.64.0.1'],                  // carrier-grade NAT
    ['100.127.255.254'],
    ['192.0.2.1'],                   // TEST-NET-1
    ['198.51.100.7'],                // TEST-NET-2
    ['203.0.113.9'],                 // TEST-NET-3
    ['198.18.0.1'],                  // benchmarking
    ['224.0.0.1'],                   // multicast
    ['255.255.255.255'],             // broadcast / reserved
    ['2001:db8::1'],                 // documentation IPv6
    ['ff02::1'],                     // multicast IPv6
    ['::ffff:10.0.0.1'],             // IPv4-mapped IPv6
    ['::a00:5'],                     // IPv4-compatible IPv6 hex tail encoding 10.0.0.5
    ['::10.0.0.5'],                  // deprecated IPv4-compatible dotted form
    ['2001:2::1'],                   // RFC 2544/5180 benchmarking IPv6
    ['2001::1'],                     // Teredo
    ['2001:10::1'],                  // deprecated ORCHID
    ['registry.internal'],
    ['database.local'],
    ['']
  ])('rejects non-routable host %s', (host) => {
    expect(isPubliclyRoutableDbHost(host)).toBe(false);
  });
});

describe('desktopDatabaseUrl', () => {
  it('provisions the dashboard\'s own routable DATABASE_URL even when DESKTOP_DATABASE_URL is set', () => {
    // The desktop worker is an extension of the dashboard, never a separate
    // data system: the dashboard's own database always wins when reachable.
    const dashboardUrl = 'postgresql://app:pass@db.example.com:5432/paymentapp?sslmode=require';
    expect(
      desktopDatabaseUrl({
        DATABASE_URL: dashboardUrl,
        DESKTOP_DATABASE_URL: 'postgresql://worker:pass@other.example.com:5432/legacy_db?sslmode=require'
      })
    ).toBe(dashboardUrl);
  });

  it('falls back to DESKTOP_DATABASE_URL for the same database when DATABASE_URL is container-internal', () => {
    expect(
      desktopDatabaseUrl({
        DESKTOP_DATABASE_URL: 'postgresql://worker:pass@db.example.com:5432/paymentapp?sslmode=require',
        DATABASE_URL: 'postgresql://app:pass@postgres:5432/paymentapp'
      })
    ).toBe('postgresql://worker:pass@db.example.com:5432/paymentapp?sslmode=require');
  });

  it('refuses a DESKTOP_DATABASE_URL that names a different database than the dashboard\'s own', () => {
    expect(
      desktopDatabaseUrl({
        DESKTOP_DATABASE_URL: 'postgresql://worker:pass@db.example.com:5432/worker_only_db?sslmode=require',
        DATABASE_URL: 'postgresql://app:pass@postgres:5432/paymentapp'
      })
    ).toBe('');
  });

  it('never provisions a container-internal DATABASE_URL', () => {
    expect(desktopDatabaseUrl({ DATABASE_URL: 'postgresql://app:pass@postgres:5432/paymentapp' })).toBe('');
  });

  it('never provisions loopback or private DATABASE_URLs', () => {
    expect(desktopDatabaseUrl({ DATABASE_URL: 'postgresql://app:pass@localhost:5432/paymentapp' })).toBe('');
    expect(desktopDatabaseUrl({ DATABASE_URL: 'postgresql://app:pass@10.0.0.5:5432/paymentapp' })).toBe('');
    expect(desktopDatabaseUrl({ DATABASE_URL: 'postgresql://app:pass@192.168.1.10:5432/paymentapp' })).toBe('');
  });

  it('provisions a publicly routable DATABASE_URL', () => {
    const url = 'postgresql://app:pass@db.example.com:5432/paymentapp?sslmode=require';
    expect(desktopDatabaseUrl({ DATABASE_URL: url })).toBe(url);
  });

  it('returns an empty string when nothing is configured', () => {
    expect(desktopDatabaseUrl({})).toBe('');
    expect(desktopDatabaseUrl({ DATABASE_URL: '   ' })).toBe('');
  });

  it('returns an empty string for a malformed DATABASE_URL', () => {
    expect(desktopDatabaseUrl({ DATABASE_URL: 'not a valid url' })).toBe('');
  });

  it('ignores a blank DESKTOP_DATABASE_URL and falls back to DATABASE_URL rules', () => {
    expect(desktopDatabaseUrl({ DESKTOP_DATABASE_URL: '  ', DATABASE_URL: 'postgresql://app:pass@postgres:5432/paymentapp' })).toBe('');
  });
});

describe('desktopAnalystDatabaseUrl', () => {
  it('uses only the explicitly configured read-only database principal', () => {
    const analystUrl = 'postgresql://analyst:readonly@db.example.com:5432/paymentapp?sslmode=require';
    expect(desktopAnalystDatabaseUrl({
      DESKTOP_ANALYST_DATABASE_URL: analystUrl,
      DESKTOP_DATABASE_URL: 'postgresql://worker:write@db.example.com:5432/paymentapp',
      DATABASE_URL: 'postgresql://app:write@db.example.com:5432/paymentapp'
    })).toBe(analystUrl);
  });

  it('refuses a read-only principal that names a different database than the dashboard\'s own', () => {
    expect(desktopAnalystDatabaseUrl({
      DESKTOP_ANALYST_DATABASE_URL: 'postgresql://analyst:readonly@db.example.com:5432/analyst_only_db',
      DATABASE_URL: 'postgresql://app:write@db.example.com:5432/paymentapp'
    })).toBe('');
  });

  it('never falls back to a writer URL and rejects non-routable analyst URLs', () => {
    expect(desktopAnalystDatabaseUrl({
      DESKTOP_DATABASE_URL: 'postgresql://worker:write@db.example.com:5432/paymentapp',
      DATABASE_URL: 'postgresql://app:write@db.example.com:5432/paymentapp'
    })).toBe('');
    expect(desktopAnalystDatabaseUrl({
      DESKTOP_ANALYST_DATABASE_URL: 'postgresql://analyst:readonly@postgres:5432/paymentapp'
    })).toBe('');
  });
});

describe('desktopDatabaseProvisioningForRole', () => {
  it('uses separate credentials for analysts and privileged desktop roles', () => {
    const env = {
      DESKTOP_ANALYST_DATABASE_URL: 'postgresql://analyst:readonly@db.example.com:5432/paymentapp',
      DESKTOP_DATABASE_URL: 'postgresql://worker:write@db.example.com:5432/paymentapp'
    };
    expect(desktopDatabaseProvisioningForRole('analyst', env)).toEqual({
      databaseUrl: env.DESKTOP_ANALYST_DATABASE_URL,
      databaseAccess: 'read-only'
    });
    expect(desktopDatabaseProvisioningForRole('operator', env)).toEqual({
      databaseUrl: env.DESKTOP_DATABASE_URL,
      databaseAccess: 'standard'
    });
    expect(desktopDatabaseProvisioningForRole('viewer', env)).toEqual({
      databaseUrl: '',
      databaseAccess: 'none'
    });
  });
});
