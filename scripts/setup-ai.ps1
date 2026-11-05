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
  $studyConfig = @{ apiKey = $studyKey.Trim(); model = $studyModel.Trim() } | ConvertTo-Json
  [IO.File]::WriteAllText((Join-Path $studyData 'ai-config.json'), $studyConfig, (New-Object Text.UTF8Encoding($false)))
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($studyPointer)
  $studyKey = $null
  $studyConfig = $null
}
Write-Host 'Saved locally. Restart the app to apply. Do not share data/ or .env.'
