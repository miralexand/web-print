# WebPrint text-print CJK encoding verification
#
# RUN THIS ON THE PRINT HOST - the Windows machine running WebPrintTray, i.e. the one
# with Word/WPS installed and the printers attached. It cannot be validated inside a
# sandboxed dev box: the sandbox blocks the out-of-process Word COM server from reading
# files, and unconfined attempts leave stuck COM processes behind.
#
# Why this file is ASCII-only: Windows PowerShell 5.1 decodes a .ps1 without a UTF-8 BOM
# using the system ANSI code page and mangles non-ASCII *source*. The Chinese sample is
# therefore embedded as base64 UTF-8 and decoded at runtime.
#
# What it checks
#   Part 1  POST /api/print/text accepts Chinese and the agent prints it (needs a printer).
#   Part 2  Word/WPS COM turns the generated .txt into a PDF with no mojibake, and shows
#           that the UTF-8 BOM is what makes the result deterministic (no printer needed).
#
# Usage (STA matters for Office COM):
#   powershell -NoProfile -STA -ExecutionPolicy Bypass -File verify-text-encoding.ps1
#   powershell -NoProfile -STA -ExecutionPolicy Bypass -File verify-text-encoding.ps1 -BaseUrl http://192.168.1.100:3000
#   powershell -NoProfile -STA -ExecutionPolicy Bypass -File verify-text-encoding.ps1 -SkipEndpoint
#   powershell -NoProfile -STA -ExecutionPolicy Bypass -File verify-text-encoding.ps1 -SkipConversion
#
# Nothing is installed; temporary files are removed unless -KeepFiles is given.

param(
  [string]$BaseUrl = 'http://127.0.0.1:3000',
  [string]$Printer = '',
  [switch]$SkipEndpoint,
  [switch]$SkipConversion,
  [switch]$KeepFiles
)

$ErrorActionPreference = 'Continue'
$script:Pass = 0
$script:Fail = 0

function Ok([string]$m)   { $script:Pass++; Write-Host ("  [PASS] " + $m) -ForegroundColor Green }
function Bad([string]$m)  { $script:Fail++; Write-Host ("  [FAIL] " + $m) -ForegroundColor Red }
function Info([string]$m) { Write-Host ("  " + $m) -ForegroundColor Gray }
function Head([string]$m) { Write-Host ''; Write-Host $m -ForegroundColor Cyan }
function Utf8Len([string]$s) { return [System.Text.Encoding]::UTF8.GetByteCount($s) }

# Sample text as base64 UTF-8, decoded at runtime so this source stays pure ASCII.
$SampleB64 = 'V2ViUHJpbnQg5paH5pys5omT5Y2w5Lit5paH57yW56CB6aqM6K+BCuesrOS4gOihjO+8muS9oOWlve+8jOS4lueVjO+8gei/meaYr+S4gOauteS4reaWh+aJk+WNsOa1i+ivleOAggrnrKzkuozooYzvvJrph5Hpop0g77+lMSwyMzQuNTbvvIzml6XmnJ8gMjAyNi0wMi0xNOOAggrnrKzkuInooYzvvJrnibnmrornrKblj7cg44CK5Lmm5ZCN44CL44CQ6YeN54K544CR4oCU4oCU4oCc5byV5Y+34oCd4oCm4oCmCuesrOWbm+ihjO+8muS4reiLsea3t+aOkiBBQkNkZWYxMjMg5rWL6K+V5a6M5oiQ44CCCuesrOS6lOihjO+8muWuueaYk+a3t+a3hueahOWtlyDlt7Hlt7Llt7Mg5pyq5pyrIOaXpeabsCDljIDli7og6ZyA56Gu6K6k5LiN5Lii5a2X44CCCg=='
$Sample = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($SampleB64))
$Expect = ($Sample -replace '\s+', '')

Write-Host 'WebPrint text-print CJK encoding verification' -ForegroundColor White
Write-Host ('PowerShell ' + $PSVersionTable.PSVersion + ' / ' + $PSVersionTable.PSEdition)
$sta = [System.Threading.Thread]::CurrentThread.GetApartmentState()
Info ('Apartment = ' + $sta)
if ($sta -ne 'STA') { Write-Host '  WARNING: not STA. Office COM is unreliable in MTA; re-run with -STA.' -ForegroundColor Yellow }

$tmp = Join-Path $env:TEMP ('wp-encoding-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
Info ('Temp dir: ' + $tmp)

# =====================================================================
# Part 1 - gateway endpoint (needs the service and a printer)
# =====================================================================
if (-not $SkipEndpoint) {
  Head 'Part 1 / POST /api/print/text'

  $payload = @{
    content   = $Sample
    copies    = 1
    color     = 'mono'
    paperSize = 'A4'
    printer   = $Printer
  } | ConvertTo-Json -Compress

  # Send UTF-8 BYTES. On PowerShell 5.1 a string -Body is encoded as ANSI, which would
  # transmit mojibake and look like a server-side bug that is not there.
  $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($payload)

  $taskId = $null
  try {
    $resp = Invoke-RestMethod -Method Post -Uri ($BaseUrl + '/api/print/text') `
      -ContentType 'application/json; charset=utf-8' -Body $bodyBytes -TimeoutSec 30
    Ok 'endpoint accepted the request (HTTP 201)'
    $taskId = $resp.task.id
    Info ('task.id      = ' + $resp.task.id)
    Info ('originalName = ' + $resp.task.originalName)
    Info ('kind / size  = ' + $resp.task.kind + ' / ' + $resp.task.size)
    Info ('quota        = ' + ($resp.quota | ConvertTo-Json -Compress))
    if ($resp.task.kind -eq 'text') { Ok 'task.kind = text' } else { Bad ('task.kind = ' + $resp.task.kind) }
    if ($resp.task.originalName -like '*.txt') { Ok 'originalName ends with .txt' } else { Bad 'originalName is not .txt' }
    if ($resp.task.size -eq (Utf8Len $Sample) + 3) { Ok 'stored size = content + 3-byte UTF-8 BOM' }
    else { Bad ('stored size ' + $resp.task.size + ' != content(' + (Utf8Len $Sample) + ') + 3 (BOM)') }
  } catch {
    Bad ('endpoint call failed: ' + $_.Exception.Message)
  }

  if ($taskId) {
    Head 'Part 1b / wait for the print agent'
    $final = $null
    for ($i = 0; $i -lt 60; $i++) {
      Start-Sleep -Milliseconds 1000
      try {
        $tasks = Invoke-RestMethod -Method Get -Uri ($BaseUrl + '/api/tasks') -TimeoutSec 15
        $me = $tasks.tasks | Where-Object { $_.id -eq $taskId }
        if ($me) {
          $final = $me
          if ($me.status -ne 'pending' -and $me.status -ne 'processing') { break }
        }
      } catch { }
    }
    if ($final) {
      Info ('status = ' + $final.status + '   printer = ' + $final.printer)
      if ($final.status -eq 'success') { Ok 'agent reported success - Chinese text was printed' }
      else { Bad ('task status = ' + $final.status + '  error = ' + $final.error) }
    } else { Bad 'task never appeared in /api/tasks' }
  }
}

# =====================================================================
# Part 2 - Word/WPS COM conversion, no printer required
# =====================================================================
if (-not $SkipConversion) {
  Head 'Part 2 / Word or WPS COM conversion (.txt -> PDF)'

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $utf8Bom   = New-Object System.Text.UTF8Encoding($true)
  $plain = Join-Path $tmp 'cjk-nobom.txt'
  $bom   = Join-Path $tmp 'cjk-bom.txt'
  [System.IO.File]::WriteAllBytes($plain, $utf8NoBom.GetBytes($Sample))
  [System.IO.File]::WriteAllBytes($bom, $utf8Bom.GetBytes($Sample))

  $progId = $null
  foreach ($cand in 'KWPS.Application', 'Word.Application') {
    if ([Type]::GetTypeFromProgID($cand)) { $progId = $cand; break }
  }
  if (-not $progId) {
    Bad 'neither WPS (KWPS.Application) nor Word (Word.Application) is registered'
  } else {
    Ok ('using COM server: ' + $progId)
    $app = $null
    try {
      $app = New-Object -ComObject $progId
      $app.Visible = $false
      $app.DisplayAlerts = 0
      try { $app.Options.ConfirmConversions = $false } catch { }
      Info ('ActivePrinter = ' + $app.ActivePrinter)
    } catch {
      Bad ('cannot create ' + $progId + ': ' + $_.Exception.Message)
    }

    if ($app) {
      foreach ($case in @(
        @{ Name = 'UTF-8 WITHOUT BOM'; Path = $plain; ExpectOk = $false },
        @{ Name = 'UTF-8 WITH BOM';    Path = $bom;   ExpectOk = $true  }
      )) {
        $n = $case.Name
        $in = $case.Path
        $pdf = [System.IO.Path]::ChangeExtension($in, '.pdf')
        Write-Host ''
        Info ('--- ' + $n)
        try {
          # Mirrors desktop/lib/printService.js: force code page 65001 only when a BOM is present.
          $head = [System.IO.File]::ReadAllBytes($in)
          $hasBom = ($head.Length -ge 3 -and $head[0] -eq 0xEF -and $head[1] -eq 0xBB -and $head[2] -eq 0xBF)
          $doc = $null
          if ($hasBom) {
            try { $doc = $app.Documents.Open($in, $false, $true, $false, '', '', $false, '', '', 0, 65001) }
            catch { $doc = $app.Documents.Open($in, $false, $true) }
          } else {
            $doc = $app.Documents.Open($in, $false, $true)
          }
          $readback = $doc.Content.Text
          $pages = $doc.ComputeStatistics(2)
          $doc.ExportAsFixedFormat($pdf, 17)
          $doc.Close($false)

          $decoded = (($readback -replace '\s+', '') -eq $Expect)
          Info ('pages=' + $pages + '  decodedTextMatchesSource=' + $decoded)
          if (-not $decoded) { Info ('readback = ' + ($readback -replace "`r?`n", ' | ')) }

          if (Test-Path $pdf) {
            $raw = [System.IO.File]::ReadAllText($pdf, [System.Text.Encoding]::GetEncoding(28591))
            $cid = $raw.Contains('/Type0') -or $raw.Contains('/Identity-H')
            Info ('pdfBytes=' + (Get-Item $pdf).Length + '  embedsCidFont=' + $cid)
            if ($cid) { Ok ($n + ': PDF embeds a CID (CJK) font') } else { Bad ($n + ': PDF has no CID font') }

            # Independent cross-check: let Word read the produced PDF back.
            try {
              $pd = $app.Documents.Open($pdf, $false, $true)
              $pdfText = $pd.Content.Text
              $pd.Close($false)
              $pdfOk = (($pdfText -replace '\s+', '')).Contains($Expect)
              Info ('pdfRoundTripMatchesSource=' + $pdfOk)
              if ($pdfOk) { Ok ($n + ': PDF text round-trips correctly') }
              else { Bad ($n + ': PDF text does NOT round-trip') }
            } catch { Info ('PDF round-trip skipped: ' + $_.Exception.Message) }
          } else { Bad ($n + ': no PDF was produced') }

          if ($case.ExpectOk) {
            if ($decoded) { Ok ($n + ': decoded correctly (this is the configuration we ship)') }
            else { Bad ($n + ': decoded incorrectly - the BOM fix is NOT working') }
          } else {
            if ($decoded) {
              Info ($n + ': decoded correctly here (this host''s ANSI code page happens to be UTF-8)')
            } else {
              Info ($n + ': MISDECODED, as expected - this is exactly why the gateway writes a BOM')
            }
          }
        } catch {
          Bad ($n + ' conversion failed: ' + $_.Exception.Message)
        }
      }
      try { $app.Quit() } catch { }
    }
  }
}

# =====================================================================
# Summary
# =====================================================================
Head 'Summary'
Write-Host ('  PASS=' + $script:Pass + '  FAIL=' + $script:Fail) -ForegroundColor White
if ($script:Fail -eq 0) { Write-Host '  RESULT: OK' -ForegroundColor Green }
else { Write-Host '  RESULT: PROBLEMS FOUND - see [FAIL] lines above' -ForegroundColor Red }

Start-Sleep -Milliseconds 500
Get-Process WINWORD -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
if ($KeepFiles) { Info ('kept: ' + $tmp) } else { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }

if ($script:Fail -gt 0) { exit 1 } else { exit 0 }
