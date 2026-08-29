# Prints this machine's primary LAN IPv4 for teammate sharing.
# Usage: powershell -File scripts/lan-ip.ps1
# Optional: -OpenFirewall  → allow inbound TCP 5173 + 3001 (needs Admin)

param(
  [switch]$OpenFirewall
)

function Get-LanIPv4 {
  $candidates = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -notlike '127.*' -and
      $_.IPAddress -notlike '169.254.*' -and
      $_.PrefixOrigin -ne 'WellKnown'
    } |
    Sort-Object -Property InterfaceMetric, SkipAsSource

  foreach ($c in $candidates) {
    # Prefer private LAN ranges
    if ($c.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)') {
      return $c.IPAddress
    }
  }
  if ($candidates) { return $candidates[0].IPAddress }
  return $null
}

$ip = Get-LanIPv4
if (-not $ip) {
  Write-Host "LAN_IP="
  Write-Host "Could not detect a LAN IPv4 address." -ForegroundColor Yellow
  exit 1
}

Write-Host "LAN_IP=$ip"
Write-Host "TEAM_URL=http://${ip}:5173"
Write-Host "API_URL=http://${ip}:3001"

if ($OpenFirewall) {
  $rules = @(
    @{ Name = 'ReconCentral Dev Frontend 5173'; Port = 5173 },
    @{ Name = 'ReconCentral Dev Backend 3001'; Port = 3001 }
  )
  foreach ($r in $rules) {
    $exists = Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue
    if (-not $exists) {
      try {
        New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Protocol TCP `
          -LocalPort $r.Port -Action Allow -Profile Private -ErrorAction Stop | Out-Null
        Write-Host "Firewall: allowed TCP $($r.Port) ($($r.Name))" -ForegroundColor Green
      } catch {
        Write-Host "Firewall: could not add rule for port $($r.Port). Run START.bat as Administrator once." -ForegroundColor Yellow
      }
    } else {
      Write-Host "Firewall: rule already exists for port $($r.Port)" -ForegroundColor DarkGray
    }
  }
}
