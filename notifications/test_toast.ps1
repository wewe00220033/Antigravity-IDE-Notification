param(
    [string]$Title = "Antigravity Notification Test",
    [string]$Body = "",
    [string]$AppId = "Google.AntigravityIDE",
    [switch]$Silent,
    [string]$LaunchUri = "antigravity-ide://google.google-antigravity/open-conversation"
)

$ErrorActionPreference = "Stop"

if ($ExecutionContext.SessionState.LanguageMode -ne "FullLanguage") {
    Write-Error "PowerShell LanguageMode is not FullLanguage; WinRT Toast APIs require FullLanguage."
    exit 1
}

$Apps = @(Get-StartApps)
$App = $Apps | Where-Object { $_.AppID -eq $AppId } | Select-Object -First 1
if (-not $App) {
    $App = $Apps | Where-Object { $_.Name -like "*Antigravity*" -or $_.Name -like "*Visual Studio Code*" } | Select-Object -First 1
}
if (-not $App -or -not $App.AppID) {
    Write-Error "Could not find Antigravity IDE in Get-StartApps. Registered Antigravity apps: $(($Apps | Where-Object { $_.Name -like '*Antigravity*' } | Out-String))"
    exit 1
}

Write-Host "Resolved App: $($App.Name) ($($App.AppID))"

$LogoCandidates = @(
    "$env:LOCALAPPDATA\Programs\Antigravity IDE\resources\app\extensions\agy\img\logo.png",
    "$env:LOCALAPPDATA\Programs\Antigravity\resources\app\extensions\agy\img\logo.png",
    "$env:ProgramFiles\Antigravity IDE\resources\app\extensions\agy\img\logo.png"
)
$IconUri = $null
foreach ($candidate in $LogoCandidates) {
    if (Test-Path $candidate) {
        $IconUri = ([System.Uri]$candidate).AbsoluteUri
        break
    }
}

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

$TemplateType = if ($IconUri) {
    [Windows.UI.Notifications.ToastTemplateType]::ToastImageAndText02
} else {
    [Windows.UI.Notifications.ToastTemplateType]::ToastText02
}

$Template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($TemplateType)
$RawXml = [xml]$Template.GetXml()
$RawXml.toast.SetAttribute("activationType", "protocol")
$RawXml.toast.SetAttribute("launch", $LaunchUri)

if ($IconUri) {
    $RawXml.toast.visual.binding.SetAttribute("template", "ToastGeneric")
    ($RawXml.toast.visual.binding.image | Where-Object { $_.id -eq "1" }).SetAttribute("src", $IconUri)
    ($RawXml.toast.visual.binding.image | Where-Object { $_.id -eq "1" }).SetAttribute("placement", "appLogoOverride")
}

($RawXml.toast.visual.binding.text | Where-Object { $_.id -eq "1" }).AppendChild($RawXml.CreateTextNode($Title)) | Out-Null
if ($Body) {
    ($RawXml.toast.visual.binding.text | Where-Object { $_.id -eq "2" }).AppendChild($RawXml.CreateTextNode($Body)) | Out-Null
}
if ($Silent.IsPresent) {
    $Audio = $RawXml.CreateElement("audio")
    $Audio.SetAttribute("silent", "true")
    $RawXml.toast.AppendChild($Audio) | Out-Null
}

$SerializedXml = New-Object Windows.Data.Xml.Dom.XmlDocument
$SerializedXml.LoadXml($RawXml.OuterXml)
$Toast = [Windows.UI.Notifications.ToastNotification]::new($SerializedXml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($App.AppID).Show($Toast)

Write-Host "Toast sent successfully via AppID: $($App.AppID)"
