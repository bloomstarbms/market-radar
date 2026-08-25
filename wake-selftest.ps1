# One observation beats twenty-eight registrations: query the LIVE wake-timer policy,
# then register a throwaway timer 10 minutes out. The machine is then slept manually;
# if it wakes on its own, the mechanism is proven end-to-end. Cleanup: WAKE-SELFTEST-CLEANUP.
Write-Output '--- live RTCWAKE policy (AC must be 0x1 Enable) ---'
powercfg /q SCHEME_CURRENT SUB_SLEEP RTCWAKE
$t = (Get-Date).AddMinutes(10)
$a = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c exit'
$s = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable
$tr = New-ScheduledTaskTrigger -Once -At $t
Register-ScheduledTask -TaskName 'Wake-SELFTEST' -TaskPath '\MarketRadar\' -Action $a -Trigger $tr -Settings $s -Force | Out-Null
Write-Output ('SELFTEST wake timer set for ' + $t.ToString('yyyy-MM-dd HH:mm:ss') + ' local')
Get-ScheduledTask -TaskPath '\MarketRadar\' -TaskName 'Wake-SELFTEST' | Select-Object TaskName, State | Format-Table
