# ──────────────────────────────────────────────────────────────────────────────
# install.ps1 — First-time Windows installer for Vantek CRM
# ──────────────────────────────────────────────────────────────────────────────
#
# WHAT IT DOES
#   Run once by the technician as Administrator on the client PC. Since this
#   script ships INSIDE Vantek-*.zip, it first reuses the app files sitting
#   next to it (no redundant GitHub re-download); it only downloads the release
#   from GitHub when run standalone. Provisions portable Node.js and NSSM locally
#   (nothing installed system-wide), and registers the "VANTEK" Windows service
#   via install-service.bat. node\ and tools\ survive later auto-updates.
#
# RELATIONSHIPS
#   Used by / Calls:
#     · Technician (manual, elevated PowerShell) → one-time bootstrap
#     · GitHub Releases API + nodejs.org + nssm.cc → download release, Node, NSSM
#     · launcher\install-service.bat → register and start the Windows service
#
# INPUTS / OUTPUTS
#   Input:  params -InstallDir/-Repo/-NodeVersion/-Token/-Force; internet access
#   Output: installed app tree in InstallDir, node\, tools\nssm.exe, running VANTEK
#           service; temp working folder cleaned up on exit
#
# NOTES
#   · Windows-only. Requires Administrator privileges and TLS 1.2.
#   · Safe to re-run; skips Node/NSSM unless -Force, and won't clobber an existing
#     service registration.
#   · Fast by design: $ProgressPreference='SilentlyContinue' (speeds up downloads
#     on PS 5.1), .NET ZipFile extraction (faster than Expand-Archive), and reuse
#     of the local release payload instead of re-downloading it.
#   · All downloads retry with backoff (nssm.cc returns transient 503s).
# ──────────────────────────────────────────────────────────────────────────────

<#
.SYNOPSIS
    Instalador de primera vez de Vantek CRM para Windows.

.DESCRIPTION
    Pensado para que el tecnico lo ejecute UNA sola vez en el PC del cliente,
    como Administrador. Realiza el arranque completo sin instalar nada de forma
    global en el sistema:

      1. Reutiliza los ficheros de la app que viajan junto a este script dentro
         de Vantek-<version>.zip (copiandolos al directorio de instalacion). Solo
         descarga el release desde GitHub si el script se ejecuta suelto.
      2. Descarga Node.js 24 portable (win-x64) en <instalacion>\node.
      3. Descarga NSSM en <instalacion>\tools\nssm.exe.
      4. Ejecuta launcher\install-service.bat, que registra el servicio de
         Windows "VANTEK" apuntando al launcher con el Node portable.

    A partir de aqui el launcher se encarga de las actualizaciones descargando
    el mismo Vantek-*.zip de cada nueva release. node\ y tools\ NO viajan
    en las actualizaciones: se aportan aqui una unica vez y sobreviven a los
    updates (Expand-Archive solo sobreescribe lo que trae el ZIP).

.PARAMETER InstallDir
    Carpeta de instalacion. Por defecto C:\Vantek.

.PARAMETER Repo
    Repositorio GitHub owner/name. Por defecto HeRoDaRu/vantek.

.PARAMETER NodeVersion
    Version de Node.js portable. Acepta una version completa (ej. 24.10.0) o solo
    el major (ej. 24). Por defecto '24': resuelve e instala la ULTIMA 24.x
    publicada en nodejs.org, para no quedarse nunca en una version antigua.
    El MAJOR debe coincidir con el que compila el binario nativo de
    better-sqlite3 en release.yml (Node 24 = ABI 137); cambiar de major obliga a
    tocar tambien release.yml, la imagen Docker, el Makefile y ci.yml, y a
    reempaquetar el release.

.PARAMETER Token
    Token de GitHub opcional (para evitar limites de la API en redes con mucho
    trafico). No es necesario para un repositorio publico.

.PARAMETER Force
    Vuelve a descargar Node y NSSM aunque ya existan.

.EXAMPLE
    # Desde PowerShell como Administrador:
    Set-ExecutionPolicy -Scope Process Bypass -Force
    .\install.ps1

.EXAMPLE
    # Fijar una version exacta en lugar de la ultima 24.x:
    .\install.ps1 -InstallDir 'D:\Vantek' -NodeVersion '24.10.0'
#>

[CmdletBinding()]
param(
    [string] $InstallDir  = 'C:\Vantek',
    [string] $Repo        = 'hectorrf16/vantek',
    [string] $NodeVersion = '24',
    [string] $Token       = '',
    [switch] $Force
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

$NssmVersion  = '2.24'
# Node de reserva si no se puede resolver la ultima version online (offline).
# Debe ser del MISMO major para el que se compila el binario de better-sqlite3.
$FallbackNode = '24.0.0'

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Info($msg) { Write-Host "    $msg" -ForegroundColor Gray }

# ─── Descarga con reintentos ──────────────────────────────────────────────────
function Get-File {
    param(
        [Parameter(Mandatory)] [string]   $Uri,
        [Parameter(Mandatory)] [string]   $OutFile,
        [hashtable]                       $Headers = @{},
        [int]                             $Retries = 4
    )
    for ($i = 1; $i -le $Retries; $i++) {
        try {
            Invoke-WebRequest -Uri $Uri -Headers $Headers -OutFile $OutFile -UseBasicParsing -TimeoutSec 120
            return
        } catch {
            $msg = $_.Exception.Message
            if ($i -eq $Retries) { throw "No se pudo descargar tras $Retries intentos: $Uri`n    $msg" }
            $wait = [int][math]::Min(30, [math]::Pow(2, $i))
            Write-Info "Intento $i fallido ($msg). Reintentando en ${wait}s..."
            Start-Sleep -Seconds $wait
        }
    }
}

# ─── Extraccion rapida de ZIP ─────────────────────────────────────────────────
function Expand-Zip {
    param(
        [Parameter(Mandatory)] [string] $ZipPath,
        [Parameter(Mandatory)] [string] $Destination
    )
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
        $destFull = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
        $zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
        try {
            foreach ($entry in $zip.Entries) {
                $target = [System.IO.Path]::GetFullPath((Join-Path $Destination $entry.FullName))
                if (-not $target.StartsWith($destFull, [StringComparison]::OrdinalIgnoreCase)) {
                    throw "Entrada de ZIP fuera del destino (zip-slip): $($entry.FullName)"
                }
                if ($entry.FullName.EndsWith('/')) {
                    New-Item -ItemType Directory -Force -Path $target | Out-Null
                    continue
                }
                $dir = [System.IO.Path]::GetDirectoryName($target)
                if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
                [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
            }
        } finally {
            $zip.Dispose()
        }
    } catch {
        Write-Info "Extraccion rapida no disponible ($($_.Exception.Message)); usando Expand-Archive."
        Expand-Archive -LiteralPath $ZipPath -DestinationPath $Destination -Force
    }
}

# ─── Resolver la version de Node ───────────────────────────────────────────
# Acepta una version completa (22.22.3) o solo el major (22). Si es un major,
# resuelve la ULTIMA version de esa rama publicada en nodejs.org (el indice va
# ordenado de mas nueva a mas antigua), para no instalar nunca una version
# vieja. El MAJOR debe coincidir con el de release.yml (setup-node): el binario
# nativo de better-sqlite3 que viaja en el ZIP se compila para esa ABI
# (Node 24 = ABI 137). Cambiar de major obliga a cambiar tambien release.yml, la
# imagen Docker, el Makefile y ci.yml, y a reempaquetar el release.
function Resolve-NodeVersion([string] $spec) {
    if ($spec -notmatch '^\d+$') { return $spec }
    $major = $spec
    try {
        $index  = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing -TimeoutSec 60
        $ultima = $index | Where-Object { $_.version -like "v${major}.*" } | Select-Object -First 1
        if ($ultima) {
            $v = $ultima.version.TrimStart('v')
            Write-Info "Ultima version de Node ${major}.x: v$v"
            return $v
        }
        Write-Info "No se pudo resolver la ultima ${major}.x; usando v$FallbackNode."
    } catch {
        Write-Info "Sin acceso al indice de Node ($($_.Exception.Message)); usando v$FallbackNode."
    }
    return $FallbackNode
}

# ─── 1. Comprobar privilegios de Administrador ─────────────────────────────────
$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Este instalador debe ejecutarse como Administrador. Abre PowerShell con "Ejecutar como administrador" y vuelve a lanzarlo.'
}

Write-Host '=================================================='
Write-Host '        Vantek CRM - Instalacion (Windows)'
Write-Host '=================================================='
Write-Info "Directorio de instalacion: $InstallDir"
Write-Info "Repositorio:               $Repo"
$NodeVersion = Resolve-NodeVersion $NodeVersion
Write-Info "Node.js portable:          v$NodeVersion (win-x64)"

# Cabeceras para la API de GitHub (User-Agent es obligatorio)
$ghHeaders = @{ 'User-Agent' = 'Vantek-Installer' }
if ($Token -ne '') { $ghHeaders['Authorization'] = "Bearer $Token" }

# Carpeta temporal de trabajo
$tmp = Join-Path $env:TEMP ("vantek-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    # ─── 2. Detener el servicio si ya existe (reinstalacion) ───────────────────
    $svc = Get-Service -Name 'VANTEK' -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq 'Running') {
        Write-Step 'Deteniendo el servicio VANTEK existente...'
        Stop-Service -Name 'VANTEK' -Force
        Start-Sleep -Seconds 2
    }

    # ─── 3. Obtener la aplicacion (local si existe, si no desde GitHub) ─────────
    # install.ps1 viaja DENTRO de Vantek-<version>.zip. Si el tecnico ya ha
    # descargado y extraido el release para ejecutar este script, los ficheros
    # de la app estan justo al lado: los copiamos y NOS AHORRAMOS la descarga y
    # la descompresion del mismo ZIP desde GitHub. Solo se descarga si el script
    # se ejecuta suelto (p. ej. install.ps1 en crudo sin el resto del release).
    $scriptDir  = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    $scriptFull = [System.IO.Path]::GetFullPath($scriptDir)
    $installFull = [System.IO.Path]::GetFullPath($InstallDir)
    $localPayload = Test-Path (Join-Path $scriptDir 'launcher\install-service.bat')

    if ($localPayload) {
        if ($scriptFull.TrimEnd('\') -ieq $installFull.TrimEnd('\')) {
            Write-Step "Aplicacion ya presente en $InstallDir; no se descarga nada de GitHub."
        } else {
            Write-Step "Copiando la aplicacion local en $InstallDir (sin descargar de GitHub)..."
            # /XD node tools: no arrastramos ni pisamos node/ ni tools/ (los
            # aporta este instalador y sobreviven a las actualizaciones).
            robocopy $scriptFull $installFull /E /XD node tools /NFL /NDL /NJH /NJS /NP | Out-Null
            if ($LASTEXITCODE -ge 8) { throw "No se pudo copiar la aplicacion local (robocopy $LASTEXITCODE)." }
            $global:LASTEXITCODE = 0
        }
    } else {
        Write-Step 'Obteniendo el ultimo release desde GitHub...'
        $releaseApi = "https://api.github.com/repos/$Repo/releases/latest"
        $release    = Invoke-RestMethod -Uri $releaseApi -Headers $ghHeaders
        $asset      = $release.assets | Where-Object { $_.name -like 'Vantek-*.zip' } | Select-Object -First 1
        if (-not $asset) {
            throw "El release '$($release.tag_name)' no contiene el asset Vantek-*.zip."
        }
        Write-Info "Release: $($release.tag_name)"

        $zipPath = Join-Path $tmp $asset.name
        Write-Info "Descargando $($asset.name)..."
        Get-File -Uri $asset.browser_download_url -Headers $ghHeaders -OutFile $zipPath

        Write-Info "Extrayendo en $InstallDir ..."
        Expand-Zip -ZipPath $zipPath -Destination $InstallDir
    }

    # ─── 4. Node.js portable ───────────────────────────────────────────────────
    $nodeDir = Join-Path $InstallDir 'node'
    $nodeExe = Join-Path $nodeDir 'node.exe'
    if ((Test-Path $nodeExe) -and -not $Force) {
        Write-Step "Node.js portable ya presente en $nodeDir (omitido)."
    } else {
        Write-Step "Descargando Node.js v$NodeVersion portable..."
        $nodeName = "node-v$NodeVersion-win-x64"
        $nodeUrl  = "https://nodejs.org/dist/v$NodeVersion/$nodeName.zip"
        $nodeZip  = Join-Path $tmp "$nodeName.zip"
        Get-File -Uri $nodeUrl -OutFile $nodeZip

        Write-Info 'Extrayendo Node.js...'
        Expand-Zip -ZipPath $nodeZip -Destination $tmp

        New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
        # El zip contiene una carpeta node-vX.Y.Z-win-x64 con node.exe en su raiz.
        robocopy (Join-Path $tmp $nodeName) $nodeDir /E /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "No se pudo copiar Node.js (robocopy $LASTEXITCODE)." }
        $global:LASTEXITCODE = 0

        if (-not (Test-Path $nodeExe)) { throw "Node.js no quedo instalado correctamente en $nodeExe." }
        Write-Info "Node.js instalado en $nodeDir"
    }

    # ─── 5. NSSM ────────────────────────────────────────────────────────────────
    $toolsDir = Join-Path $InstallDir 'tools'
    $nssmExe  = Join-Path $toolsDir 'nssm.exe'
    if ((Test-Path $nssmExe) -and -not $Force) {
        Write-Step "NSSM ya presente en $nssmExe (omitido)."
    } else {
        Write-Step "Descargando NSSM v$NssmVersion..."
        Write-Info 'Nota: nssm.cc a veces devuelve 503; se reintenta automaticamente.'
        $nssmUrl = "https://nssm.cc/release/nssm-$NssmVersion.zip"
        $nssmZip = Join-Path $tmp "nssm-$NssmVersion.zip"
        Get-File -Uri $nssmUrl -OutFile $nssmZip

        Write-Info 'Extrayendo NSSM...'
        Expand-Zip -ZipPath $nssmZip -Destination $tmp

        New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
        $nssmSrc = Join-Path $tmp "nssm-$NssmVersion\win64\nssm.exe"
        if (-not (Test-Path $nssmSrc)) { throw "No se encontro nssm.exe (win64) en el paquete descargado." }
        Copy-Item $nssmSrc $nssmExe -Force
        Write-Info "NSSM instalado en $nssmExe"
    }

    # ─── 6. Registrar el servicio de Windows ───────────────────────────────────
    Write-Step 'Registrando el servicio de Windows VANTEK...'
    $installBat = Join-Path $InstallDir 'launcher\install-service.bat'
    if (-not (Test-Path $installBat)) {
        throw "No se encontro $installBat. El release puede estar incompleto."
    }

    if ($svc) {
        Write-Info 'El servicio VANTEK ya existe; se omite install-service.bat.'
        Write-Info 'Para reinstalarlo de cero, ejecuta primero launcher\uninstall-service.bat.'
        Start-Service -Name 'VANTEK'
    } else {
        & cmd.exe /c "`"$installBat`""
    }

    Write-Host "`n=================================================="  -ForegroundColor Green
    Write-Host '   Instalacion completada.'                            -ForegroundColor Green
    Write-Host '=================================================='    -ForegroundColor Green
    Write-Info 'El servicio VANTEK queda arrancado y se iniciara automaticamente con Windows.'
    Write-Info 'Abre la aplicacion en: http://localhost:3000'
    Write-Info 'La primera vez, la propia aplicacion mostrara el asistente de configuracion.'
}
finally {
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}
