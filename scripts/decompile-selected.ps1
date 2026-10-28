param(
    [string]$GameRoot = 'F:\SteamLibrary\steamapps\common\Boomerang Fu',
    [string[]]$Types = @('Player', 'PlayerInput', 'PlayerAI', 'GameManager', 'MatchSettings', 'PowerupType', 'Powerup', 'Level', 'LevelManager', 'Camera3D')
)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path $PSScriptRoot -Parent
$engine = Join-Path $workspace 'tools\ilspy\lib\netstandard2.0\ICSharpCode.Decompiler.dll'
$assembly = Join-Path $GameRoot 'Boomerang Fu_Data\Managed\Assembly-CSharp.dll'
$output = Join-Path $workspace 'analysis\derived\csharp'
New-Item -ItemType Directory -Path $output -Force | Out-Null
Add-Type -Path $engine
$settings = [ICSharpCode.Decompiler.DecompilerSettings]::new()
$settings.ThrowOnAssemblyResolveErrors = $false
$decompiler = [ICSharpCode.Decompiler.CSharp.CSharpDecompiler]::new($assembly, $settings)
$records = @()
foreach ($name in $Types) {
    $type = [ICSharpCode.Decompiler.TypeSystem.FullTypeName]::new($name)
    $text = $decompiler.DecompileTypeAsString($type)
    $path = Join-Path $output ($name + '.cs')
    [IO.File]::WriteAllText($path, $text, [Text.UTF8Encoding]::new($false))
    $records += [ordered]@{ type = $name; file = $path; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower(); chars = $text.Length }
    Write-Output "$name : $($text.Length) chars"
}
[ordered]@{
    source = $assembly
    source_sha256 = (Get-FileHash -LiteralPath $assembly -Algorithm SHA256).Hash.ToLower()
    engine_version = [ICSharpCode.Decompiler.CSharp.CSharpDecompiler].Assembly.GetName().Version.ToString()
    engine_sha256 = (Get-FileHash -LiteralPath $engine -Algorithm SHA256).Hash.ToLower()
    kind = 'Static ILSpy reconstruction; target assembly not executed; not original source'
    types = $records
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $output ('manifest-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')) -Encoding utf8
