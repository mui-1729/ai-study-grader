$ErrorActionPreference = 'Stop'
$studyRoot = Split-Path -Parent $PSScriptRoot
$studyData = Join-Path $studyRoot 'data'
New-Item -ItemType Directory -Force -Path $studyData | Out-Null
$studySecret = Read-Host 'INIAD AI-MOP API key (hidden)' -AsSecureString
$studyModel = Read-Host 'Model ID [gpt-6-luna]'
if ([string]::IsNullOrWhiteSpace($studyModel)) { $studyModel = 'gpt-6-luna' }
if ($studyModel -notmatch '^[a-zA-Z0-9._:/-]{1,100}$') { throw 'Invalid model ID' }
$studyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($studySecret)
try {
  $studyKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($studyPointer)
  if ([string]::IsNullOrWhiteSpace($studyKey)) { throw 'API key is empty' }
  $studyConfig = @{ apiKey = $studyKey.Trim(); model = $studyModel.Trim() } | ConvertTo-Json -Compress
  $studyStart = New-Object Diagnostics.ProcessStartInfo
  $studyStart.FileName = 'node'
  $studyStart.Arguments = '--import tsx "' + (Join-Path $PSScriptRoot 'save-credential.ts') + '"'
  $studyStart.WorkingDirectory = $studyRoot
  $studyStart.UseShellExecute = $false
  $studyStart.CreateNoWindow = $true
  $studyStart.RedirectStandardInput = $true
  $studyStart.RedirectStandardOutput = $true
  $studyStart.RedirectStandardError = $true
  $studyProcess = [Diagnostics.Process]::Start($studyStart)
  $studyProcess.StandardInput.WriteLine($studyConfig)
  $studyProcess.StandardInput.Close()
  $studyOutput = $studyProcess.StandardOutput.ReadToEnd()
  $studyError = $studyProcess.StandardError.ReadToEnd()
  $studyProcess.WaitForExit()
  if ($studyProcess.ExitCode -ne 0) { throw 'Could not protect and save the key' }
  Write-Host $studyOutput
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($studyPointer)
  $studyKey = $null
  $studyConfig = $null
}
Write-Host 'Saved with Windows user encryption outside the project. Restart the app to apply.'
