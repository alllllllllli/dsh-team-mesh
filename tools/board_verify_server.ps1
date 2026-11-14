# board_verify_server.ps1 - server-side lifecycle manager for a temporary mesh board service.
#
# Runs on the SERVER machine only. Starts a throw-away board service (random high port,
# random token, temp db, audit dir) detached from the SSH session, and stops/cleans it.
# It NEVER touches the production board on 13090, existing processes, scheduled tasks,
# or anything outside the given temp root.
#
# Detach mechanism (two hard-won facts on this Windows host):
#   1. Windows OpenSSH kills the whole process tree when the session closes, so a plain
#      Start-Process from an SSH command does not survive.
#   2. A process created through WMI Win32_Process.Create() outlives the SSH session, but a
#      WMI-created powershell.exe -File launcher silently fails to run here (no files, no
#      logs). A WMI-created cmd.exe wrapper works, so the launcher is a .cmd file.
# The wrapper runs node with stdout/stderr redirected, writes its own start marker and the
# node exit code, and the node PID is discovered through ParentProcessId.
#
# Firewall: the board must be reachable from the peer machine over the LAN. A run-scoped
# rule is added (name + local port + peer IP + node path) and removed on Stop.
#
# Token: generated here, written to <WorkDir>\token.txt, read by the master over SSH, passed
# to node through the environment (never argv). This script never prints the token.
#
# All stdout output is a single compressed JSON object per action.
# Exit codes: 0 ok, 2 usage/safety failure, 3 start failure, 4 stop/clean failure.
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Start', 'Stop', 'Dump', 'Clean', 'Status')]
  [string]$Action,
  [string]$WorkDir = '',
  [string]$RepoPath = 'C:\Users\admin\mesh-verify\repo',
  [string]$NodeExe = 'C:\Users\admin\.local\node\node.exe',
  [int]$Port = 0,
  [string]$ClientIp = '172.24.112.11',
  [string]$Root = 'C:\Users\admin\mesh-verify',
  [string]$AllowUnverifiedAdopt = ''   # '' = do not set the env var; '1' = set it for this board
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$FORBIDDEN_PORTS = @(13090, 13080)
$PORT_MIN = 21000
$PORT_MAX = 60000

function Emit-Json($obj) {
  ($obj | ConvertTo-Json -Depth 8 -Compress) | Write-Output
}

function Fail([int]$code, [string]$msg) {
  Emit-Json @{ ok = $false; error = $msg }
  exit $code
}

function Assert-WorkDirPath([string]$wd) {
  if ([string]::IsNullOrWhiteSpace($wd)) { Fail 2 'WorkDir is required' }
  $full = [System.IO.Path]::GetFullPath($wd)
  $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  if (-not $full.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    Fail 2 ("WorkDir must live under " + $rootFull)
  }
  return $full
}

function New-RandomToken {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Get-FreePort {
  for ($i = 0; $i -lt 60; $i++) {
    $candidate = Get-Random -Minimum $PORT_MIN -Maximum ($PORT_MAX + 1)
    if ($FORBIDDEN_PORTS -contains $candidate) { continue }
    if (-not (Test-PortListening $candidate)) { return $candidate }
  }
  Fail 2 'could not find a free high port'
}

function Test-PortListening([int]$p) {
  try {
    $listener = New-Object -TypeName System.Net.Sockets.TcpListener -ArgumentList ([System.Net.IPAddress]::Any), $p
    $listener.Start()
    $listener.Stop()
    return $false
  } catch {
    return $true
  }
}

function Get-Health([int]$p) {
  try {
    return Invoke-RestMethod -Uri ("http://127.0.0.1:" + $p + "/health") -TimeoutSec 3 -UseBasicParsing
  } catch {
    return $null
  }
}

function Read-State([string]$wd) {
  $statePath = Join-Path $wd 'state.json'
  if (-not (Test-Path $statePath)) { Fail 2 ('state.json not found in ' + $wd) }
  return (Get-Content $statePath -Raw | ConvertFrom-Json)
}

function Write-State($state, [string]$wd) {
  $json = $state | ConvertTo-Json -Depth 8
  Set-Content -Path (Join-Path $wd 'state.json') -Value $json -Encoding ascii
}

function Remove-OurFirewallRule([string]$ruleName) {
  if ([string]::IsNullOrWhiteSpace($ruleName)) { return $false }
  $rules = @(Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)
  $removed = $false
  foreach ($r in $rules) {
    if ($r.DisplayName -ne $ruleName) { continue }
    Remove-NetFirewallRule -Name $r.Name -ErrorAction SilentlyContinue
    $removed = $true
  }
  return $removed
}

function Get-Descendants([int]$parentPid) {
  return @(Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + $parentPid) -ErrorAction SilentlyContinue)
}

function Find-NodeChild([int]$wrapperPid) {
  if ($wrapperPid -le 0) { return $null }
  $kids = @(Get-Descendants $wrapperPid | Where-Object { $_.Name -eq 'node.exe' })
  if ($kids.Count -gt 0) { return $kids[0] }
  return $null
}

function Stop-VerifiedProcess([int]$procId, [string[]]$allowedPatterns, [int]$requiredParent = -1) {
  # Only kill a process whose command line matches this run; never a random process.
  if ($procId -le 0) { return @{ pid = $procId; killed = $false; reason = 'no-pid' } }
  $proc = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $procId) -ErrorAction SilentlyContinue
  if ($null -eq $proc) { return @{ pid = $procId; killed = $false; reason = 'already-gone' } }
  if ($requiredParent -ge 0 -and [int]$proc.ParentProcessId -ne $requiredParent) {
    return @{ pid = $procId; killed = $false; reason = ('parent pid mismatch: ' + $proc.ParentProcessId + ' != ' + $requiredParent) }
  }
  $cmd = [string]$proc.CommandLine
  $matched = $false
  foreach ($pat in $allowedPatterns) {
    if ([string]::IsNullOrEmpty($pat)) { continue }
    if ($cmd.IndexOf($pat, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $matched = $true; break }
  }
  if (-not $matched) {
    return @{ pid = $procId; killed = $false; reason = ('command line does not match this run: ' + $cmd) }
  }
  Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  return @{ pid = $procId; killed = $true; reason = 'killed' }
}

function Read-LogTail([string]$filePath, [int]$lines = 20) {
  if (-not (Test-Path $filePath)) { return '' }
  try { return ((Get-Content $filePath -Tail $lines -ErrorAction SilentlyContinue) -join ' | ') } catch { return '' }
}

switch ($Action) {
  'Start' {
    if (-not (Test-Path (Join-Path $RepoPath 'src\server.js'))) { Fail 2 ('package repo not found or incomplete: ' + $RepoPath) }
    if (-not (Test-Path $NodeExe)) { Fail 2 ('node not found: ' + $NodeExe) }
    if ($Port -ne 0) {
      if ($FORBIDDEN_PORTS -contains $Port) { Fail 2 ('port is reserved/forbidden: ' + $Port) }
      if ($Port -lt 1024 -or $Port -gt 65535) { Fail 2 ('port out of range: ' + $Port) }
      if (Test-PortListening $Port) { Fail 3 ('port already in use on server: ' + $Port) }
    }

    if ([string]::IsNullOrWhiteSpace($WorkDir)) {
      $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
      $suffix = -join ((48..57) + (97..102) | Get-Random -Count 4 | ForEach-Object { [char]$_ })
      $WorkDir = Join-Path (Join-Path $Root 'verify') ("run-" + $stamp + '-' + $suffix)
    }
    $wd = Assert-WorkDirPath $WorkDir
    New-Item -ItemType Directory -Force -Path $wd | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $wd 'audit') | Out-Null

    $runId = [System.IO.Path]::GetFileName($wd) -replace '^run-', ''
    $port = if ($Port -eq 0) { Get-FreePort } else { $Port }

    $token = New-RandomToken
    $tokenFile = Join-Path $wd 'token.txt'
    Set-Content -Path $tokenFile -Value $token -Encoding ascii -NoNewline

    $ruleName = 'mesh-verify-tmp-' + $runId
    $dbPath = Join-Path $wd 'board.db'
    $auditDir = Join-Path $wd 'audit'
    $stdoutLog = Join-Path $wd 'stdout.log'
    $stderrLog = Join-Path $wd 'stderr.log'
    $pidFile = Join-Path $wd 'node.pid'
    $wrapper = Join-Path $wd 'launch.cmd'
    $exitFile = Join-Path $wd 'wrapper-exit.txt'
    $startedMarker = Join-Path $wd 'launcher-started.txt'

    $lines = @(
      '@echo off',
      ('cd /d "' + $RepoPath + '"'),
      ('echo started>&"' + $startedMarker + '"'),
      ('set /p DSH_TEAM_BOARD_TOKEN=<"' + $tokenFile + '"'),
      ('set "DSH_TEAM_BOARD_PORT=' + [string]$port + '"'),
      'set "DSH_TEAM_BOARD_HOST=0.0.0.0"',
      ('set "DSH_TEAM_BOARD_DB=' + $dbPath + '"'),
      ('set "DSH_TEAM_BOARD_AUDIT_DIR=' + $auditDir + '"'),
      'set "DSH_TEAM_BOARD_SWEEP_MS=0"'
    )
    if ($AllowUnverifiedAdopt -eq '1') { $lines += 'set "DSH_TEAM_BOARD_ALLOW_UNVERIFIED_ADOPT=1"' }
    $lines += ('"' + $NodeExe + '" src\server.js 1>"' + $stdoutLog + '" 2>"' + $stderrLog + '"')
    $lines += ('echo %ERRORLEVEL%>"' + $exitFile + '"')
    Set-Content -Path $wrapper -Value ($lines -join "`r`n") -Encoding ascii

    $ruleAdded = $false
    try {
      New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP `
        -LocalPort $port -RemoteAddress $ClientIp -Program $NodeExe -Profile Any -ErrorAction Stop | Out-Null
      $ruleAdded = $true
    } catch {
      Remove-Item -Recurse -Force $wd -ErrorAction SilentlyContinue
      Fail 3 ('failed to add scoped firewall rule: ' + $_.Exception.Message)
    }

    $startedAt = (Get-Date).ToString('o')
    $cmdLine = 'cmd.exe /c "' + $wrapper + '"'
    $created = ([wmiclass]'Win32_Process').Create($cmdLine)
    if ($created.ReturnValue -ne 0) {
      Remove-OurFirewallRule $ruleName | Out-Null
      Remove-Item -Recurse -Force $wd -ErrorAction SilentlyContinue
      Fail 3 ('WMI process create failed, return value ' + $created.ReturnValue)
    }
    $wrapperPid = [int]$created.ProcessId

    $health = $null
    for ($i = 0; $i -lt 80; $i++) {
      Start-Sleep -Milliseconds 250
      $health = Get-Health $port
      if ($null -ne $health) { break }
    }
    if ($null -eq $health) {
      $diag = @(
        ('started_marker=' + (Test-Path $startedMarker)),
        ('wrapper_exit=' + (Read-LogTail $exitFile 3)),
        ('stdout=' + (Read-LogTail $stdoutLog 10)),
        ('stderr=' + (Read-LogTail $stderrLog 10))
      ) -join ' ;; '
      Remove-OurFirewallRule $ruleName | Out-Null
      Stop-VerifiedProcess $wrapperPid @($wrapper, 'launch.cmd') | Out-Null
      $kids = @(Get-Descendants $wrapperPid)
      foreach ($k in $kids) { Stop-VerifiedProcess ([int]$k.ProcessId) @($RepoPath) | Out-Null }
      Remove-Item -Recurse -Force $wd -ErrorAction SilentlyContinue
      Fail 3 ('board did not become healthy: ' + $diag)
    }

    $nodeProc = $null
    for ($i = 0; $i -lt 40; $i++) {
      $nodeProc = Find-NodeChild $wrapperPid
      if ($null -ne $nodeProc) { break }
      Start-Sleep -Milliseconds 100
    }
    $nodePid = 0
    if ($null -ne $nodeProc) { $nodePid = [int]$nodeProc.ProcessId; Set-Content -Path $pidFile -Value $nodePid -Encoding ascii }

    $listenerPid = $null
    try {
      $conn = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($null -ne $conn) { $listenerPid = [int]$conn.OwningProcess }
    } catch { }

    $state = @{
      run_id                   = $runId
      workdir                  = $wd
      repo_path                = $RepoPath
      node_exe                 = $NodeExe
      port                     = $port
      server_hostname          = $env:COMPUTERNAME
      node_pid                 = $nodePid
      wrapper_pid              = $wrapperPid
      listener_pid             = $listenerPid
      rule_name                = $ruleName
      token_file               = $tokenFile
      db_path                  = $dbPath
      audit_dir                = $auditDir
      stdout_log               = $stdoutLog
      stderr_log               = $stderrLog
      wrapper_path             = $wrapper
      started_at               = $startedAt
      sweep_ms                 = 0
      allow_unverified_adopt   = ($AllowUnverifiedAdopt -eq '1')
      host                     = $env:COMPUTERNAME
    }
    Write-State $state $wd
    Emit-Json @{
      ok                    = $true
      action                = 'Start'
      run_id                 = $runId
      workdir                = $wd
      port                   = $port
      server_hostname        = $env:COMPUTERNAME
      node_pid               = $nodePid
      wrapper_pid            = $wrapperPid
      listener_pid           = $listenerPid
      rule_name              = $ruleName
      token_file             = $tokenFile
      repo_path              = $RepoPath
      node_exe               = $NodeExe
      allow_unverified_adopt = ($AllowUnverifiedAdopt -eq '1')
      health                 = $health
    }
    exit 0
  }

  'Stop' {
    $wd = Assert-WorkDirPath $WorkDir
    if (-not (Test-Path $wd)) { Emit-Json @{ ok = $true; action = 'Stop'; already_gone = $true; workdir = $wd }; exit 0 }
    $state = Read-State $wd
    $killed = @()
    $skipped = @()

    $nodePid = [int]$state.node_pid
    if ($nodePid -le 0) {
      $orphan = Find-NodeChild ([int]$state.wrapper_pid)
      if ($null -ne $orphan) { $nodePid = [int]$orphan.ProcessId }
    }
    if ($nodePid -gt 0) {
      $r = Stop-VerifiedProcess $nodePid @((Join-Path $state.repo_path 'src\server.js'), 'src\server.js')
      if ($r.killed) { $killed += $r.pid } elseif ($r.reason -ne 'already-gone') { $skipped += ($r.pid.ToString() + ': ' + $r.reason) }
    }
    $wrapperPid = [int]$state.wrapper_pid
    if ($wrapperPid -gt 0) {
      # Wait briefly for the wrapper to observe node exit, then remove it if still alive.
      Start-Sleep -Milliseconds 400
      $r = Stop-VerifiedProcess $wrapperPid @([string]$state.wrapper_path, 'launch.cmd')
      if ($r.killed) { $killed += $r.pid } elseif ($r.reason -ne 'already-gone') { $skipped += ($r.pid.ToString() + ': ' + $r.reason) }
    }

    $portClosed = $false
    for ($i = 0; $i -lt 25; $i++) {
      if (-not (Test-PortListening ([int]$state.port))) { $portClosed = $true; break }
      Start-Sleep -Milliseconds 200
    }
    $ruleRemoved = Remove-OurFirewallRule ([string]$state.rule_name)
    Emit-Json @{
      ok           = $true
      action       = 'Stop'
      workdir      = $wd
      killed       = $killed
      skipped      = $skipped
      node_pid     = $nodePid
      wrapper_pid  = $wrapperPid
      port_closed  = $portClosed
      rule_removed = $ruleRemoved
      rule_name    = [string]$state.rule_name
    }
    exit 0
  }

  'Dump' {
    $wd = Assert-WorkDirPath $WorkDir
    if (-not (Test-Path $wd)) { Fail 2 ('workdir not found: ' + $wd) }
    $maxBytes = 400000
    $readText = {
      param($filePath)
      if (-not (Test-Path $filePath)) { return $null }
      try {
        $raw = Get-Content $filePath -Raw -ErrorAction Stop
        if ($null -eq $raw) { return '' }
        if ($raw.Length -gt $maxBytes) { return $raw.Substring(0, $maxBytes) + "`n[truncated]" }
        return $raw
      } catch { return ('[read-error] ' + $_.Exception.Message) }
    }
    $auditFiles = @()
    $auditDir = Join-Path $wd 'audit'
    if (Test-Path $auditDir) {
      foreach ($f in (Get-ChildItem $auditDir -File -ErrorAction SilentlyContinue)) {
        $auditFiles += @{ name = $f.Name; size = $f.Length; content = (& $readText $f.FullName) }
      }
    }
    $repoManifest = @()
    foreach ($sub in @('src', 'test', 'tools')) {
      $dir = Join-Path $RepoPath $sub
      if (-not (Test-Path $dir)) { continue }
      foreach ($f in (Get-ChildItem $dir -Recurse -File -ErrorAction SilentlyContinue)) {
        $rel = $f.FullName.Substring($RepoPath.Length + 1).Replace('\', '/')
        $repoManifest += @{ path = $rel; size = $f.Length; sha256 = (Get-FileHash $f.FullName -Algorithm SHA256).Hash.ToLower() }
      }
    }
    foreach ($top in @('package.json', 'dsh.plugin.json')) {
      $p = Join-Path $RepoPath $top
      if (Test-Path $p) {
        $f = Get-Item $p
        $repoManifest += @{ path = $top; size = $f.Length; sha256 = (Get-FileHash $p -Algorithm SHA256).Hash.ToLower() }
      }
    }
    $state = $null
    if (Test-Path (Join-Path $wd 'state.json')) {
      try { $state = Get-Content (Join-Path $wd 'state.json') -Raw | ConvertFrom-Json } catch { $state = $null }
    }
    $health = $null
    if ($null -ne $state) { $health = Get-Health ([int]$state.port) }
    $artifacts = @{
      ok              = $true
      action          = 'Dump'
      collected_at    = (Get-Date).ToString('o')
      workdir         = $wd
      server_hostname = $env:COMPUTERNAME
      state           = $state
      health          = $health
      stdout_log      = (& $readText (Join-Path $wd 'stdout.log'))
      stderr_log      = (& $readText (Join-Path $wd 'stderr.log'))
      wrapper_exit    = (& $readText (Join-Path $wd 'wrapper-exit.txt'))
      audit_files     = $auditFiles
      repo_manifest   = $repoManifest
    }
    $outPath = Join-Path $wd 'artifacts.json'
    $artifacts | ConvertTo-Json -Depth 10 | Set-Content -Path $outPath -Encoding utf8
    Emit-Json @{ ok = $true; action = 'Dump'; artifacts_path = $outPath; audit_files = $auditFiles.Count; repo_manifest = $repoManifest.Count }
    exit 0
  }

  'Clean' {
    $wd = Assert-WorkDirPath $WorkDir
    if (-not (Test-Path $wd)) { Emit-Json @{ ok = $true; action = 'Clean'; already_gone = $true; workdir = $wd }; exit 0 }
    $state = $null
    if (Test-Path (Join-Path $wd 'state.json')) {
      try { $state = Get-Content (Join-Path $wd 'state.json') -Raw | ConvertFrom-Json } catch { $state = $null }
    }
    if ($null -ne $state) {
      if ([int]$state.node_pid -gt 0) {
        $proc = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$state.node_pid) -ErrorAction SilentlyContinue
        if ($null -ne $proc) { Fail 4 ('refusing to clean: board process ' + $state.node_pid + ' still running') }
      }
      if ([int]$state.wrapper_pid -gt 0) {
        $proc = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$state.wrapper_pid) -ErrorAction SilentlyContinue
        if ($null -ne $proc) { Fail 4 ('refusing to clean: wrapper process ' + $state.wrapper_pid + ' still running') }
      }
    }
    Remove-Item -Recurse -Force $wd -ErrorAction SilentlyContinue
    if (Test-Path $wd) { Fail 4 ('failed to remove ' + $wd) }
    Emit-Json @{ ok = $true; action = 'Clean'; workdir = $wd; removed = $true }
    exit 0
  }

  'Status' {
    $wd = Assert-WorkDirPath $WorkDir
    $state = Read-State $wd
    $health = Get-Health ([int]$state.port)
    $ruleExists = $false
    $rules = @(Get-NetFirewallRule -DisplayName ([string]$state.rule_name) -ErrorAction SilentlyContinue)
    if ($rules.Count -gt 0) { $ruleExists = $true }
    $nodeAlive = $false
    if ([int]$state.node_pid -gt 0) {
      $proc = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$state.node_pid) -ErrorAction SilentlyContinue
      if ($null -ne $proc) { $nodeAlive = $true }
    }
    Emit-Json @{
      ok             = $true
      action         = 'Status'
      workdir        = $wd
      port           = [int]$state.port
      node_pid       = [int]$state.node_pid
      node_alive     = $nodeAlive
      port_listening = (Test-PortListening ([int]$state.port))
      health         = $health
      rule_name      = [string]$state.rule_name
      rule_exists    = $ruleExists
      adoption       = if ($null -ne $health) { $health.adoption } else { $null }
      stdout_log     = (Join-Path $wd 'stdout.log')
      stderr_log     = (Join-Path $wd 'stderr.log')
    }
    exit 0
  }
}
