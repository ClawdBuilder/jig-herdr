# Holds this computer awake for another process, then exits. The keep-awake mod starts this hidden and detached.
# It ends when the stop file says "stop", when the owner process (Herdr) is gone, or when it is killed; the request is
# tied to this process, so nothing can stay awake once it is gone. It changes no power plan, registry or setting.
param(
    [Parameter(Mandatory = $true)][int]$Owner,
    [string]$OwnerName = "herdr-app",
    [string]$StopFile = "",
    [string]$Token = "",
    [string]$RecordFile = "",
    [int]$Display = 0,
    [int]$Seconds = 5
)

Add-Type -Namespace KeepAwake -Name Native -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@

$ES_CONTINUOUS = [uint32]2147483648
$ES_SYSTEM_REQUIRED = [uint32]1
$ES_DISPLAY_REQUIRED = [uint32]2
$flags = $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED
if ($Display -eq 1) { $flags = $flags -bor $ES_DISPLAY_REQUIRED }

[void][KeepAwake.Native]::SetThreadExecutionState($flags)
while ($true) {
    Start-Sleep -Seconds $Seconds
    if ($StopFile -ne "") {
        $said = Get-Content -LiteralPath $StopFile -Raw -ErrorAction SilentlyContinue
        if ($said) {
            $said = $said.Trim()
            if ($said -eq "stop" -or ($Token -ne "" -and $said -eq "stop $Token")) { break }
        }
    }
    $ownerProcess = Get-Process -Id $Owner -ErrorAction SilentlyContinue
    if (-not $ownerProcess -or $ownerProcess.ProcessName -ne $OwnerName) { break }
    # Another copy recorded its own helper (a reload or a second window): this one is the extra, so it goes.
    if ($RecordFile -ne "") {
        $rec = Get-Content -LiteralPath $RecordFile -Raw -ErrorAction SilentlyContinue
        if ($rec -and $rec -match '"phase"\s*:\s*"helper"' -and $rec -notmatch ('"pid"\s*:\s*' + [string]$PID + '(\D|$)')) { break }
    }
    [void][KeepAwake.Native]::SetThreadExecutionState($flags)
}
[void][KeepAwake.Native]::SetThreadExecutionState($ES_CONTINUOUS)
