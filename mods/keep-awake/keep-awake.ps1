# Holds this computer awake for another process, then exits. The keep-awake mod starts this hidden and detached.
# It ends when the stop file says "stop", when the owner process (Herdr) is gone, or when it is killed; the request is
# tied to this process, so nothing can stay awake once it is gone. It changes no power plan, registry or setting.
param(
    [Parameter(Mandatory = $true)][int]$Owner,
    [string]$StopFile = "",
    [int]$Display = 0,
    [int]$Seconds = 20
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
        if ($said -and $said.Trim() -eq "stop") { break }
    }
    if (-not (Get-Process -Id $Owner -ErrorAction SilentlyContinue)) { break }
    [void][KeepAwake.Native]::SetThreadExecutionState($flags)
}
[void][KeepAwake.Native]::SetThreadExecutionState($ES_CONTINUOUS)
