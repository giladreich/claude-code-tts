# Persistent System.Speech host for the Claude Code TTS VSCode extension.
#
# The built-in Windows voice used to be a fresh powershell.exe per sentence:
# a .NET runtime and the speech assemblies loaded, a synthesizer created and
# an audio device opened for every one of them, which on a laptop is a gap
# of a second or two between sentences, and speech fell behind Claude. This
# process is started once and keeps one synthesizer for speaking and one for
# rendering exports, taking JSON lines on stdin and answering on stdout:
#
#   {"id":1,"speak":"...","rate":0,"volume":100,"voice":"Microsoft Zira Desktop"}
#       -> {"id":1,"ok":true} when it has been spoken (or "cancelled":true)
#   {"id":2,"render":"...","out":"C:\\...\\x.wav","rate":0,"voice":"..."}
#       -> {"id":2,"ok":true} when the WAV is written, in the voice's own format
#   {"cancel":true}   stops the sentence being spoken, at once
#   {"pause":true} / {"resume":true}   freeze mid-word and continue
#   {"volume":40}     the sentence being spoken, from here on
#   {"quit":true}     or closing stdin ends the process
#
# Everything is local: System.Speech is part of Windows. Runs under Windows
# PowerShell 5.1, which every Windows has.
$ErrorActionPreference = "Continue"
try {
    [Console]::InputEncoding = [System.Text.Encoding]::UTF8
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {}

$out = [Console]::Out

function Send-Line($text) {
    $script:out.WriteLine($text)
    $script:out.Flush()
}

function Send-Reply($id, $ok, $error, $cancelled) {
    $fields = @("`"id`":$id", "`"ok`":$(if ($ok) { 'true' } else { 'false' })")
    if ($error) { $fields += "`"error`":" + (ConvertTo-Json -InputObject ([string]$error) -Compress) }
    if ($cancelled) { $fields += "`"cancelled`":true" }
    Send-Line ("{" + ($fields -join ",") + "}")
}

try {
    Add-Type -AssemblyName System.Speech
    $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
} catch {
    Send-Line ("{`"ready`":false,`"error`":" + (ConvertTo-Json -InputObject ([string]$_) -Compress) + "}")
    exit 1
}
$renderer = $null

# stdin is read on the thread pool so the loop below stays free to notice a
# finished sentence, and a cancel lands while one is being spoken.
$stdin = [Console]::OpenStandardInput()
$buffer = New-Object byte[] 65536
$decoder = (New-Object System.Text.UTF8Encoding($false)).GetDecoder()
$chars = New-Object char[] 65536
$pending = ""
$read = $stdin.ReadAsync($buffer, 0, $buffer.Length)

$current = $null   # the sentence being spoken: id, prompt, whether it was cancelled
$render = $null    # the export being rendered: id, prompt, file
$renders = New-Object System.Collections.ArrayList
$paused = $false

function Start-Speak($req) {
    if ($script:current) {
        # A new sentence supersedes the one in progress (the queue's restart).
        $script:speaker.SpeakAsyncCancelAll()
        Send-Reply $script:current.id $false "superseded" $true
        $script:current = $null
    }
    $s = $script:speaker
    try {
        $s.Rate = [int]$req.rate
        $s.Volume = [Math]::Max(0, [Math]::Min(100, [int]$req.volume))
        if ($req.voice) { try { $s.SelectVoice([string]$req.voice) } catch {} }
        if ($script:paused) { $s.Resume(); $script:paused = $false }
        $prompt = $s.SpeakAsync([string]$req.speak)
        $script:current = @{ id = $req.id; prompt = $prompt; cancelled = $false }
    } catch {
        Send-Reply $req.id $false ([string]$_) $false
    }
}

function Start-Render($req) {
    if (-not $script:renderer) {
        $script:renderer = New-Object System.Speech.Synthesis.SpeechSynthesizer
    }
    $r = $script:renderer
    try {
        $r.Rate = [int]$req.rate
        if ($req.voice) { try { $r.SelectVoice([string]$req.voice) } catch {} }
        $r.SetOutputToWaveFile([string]$req.out)
        $prompt = $r.SpeakAsync([string]$req.render)
        $script:render = @{ id = $req.id; prompt = $prompt; file = [string]$req.out }
    } catch {
        try { $r.SetOutputToNull() } catch {}
        Send-Reply $req.id $false ([string]$_) $false
        # A failed start must not strand what is queued behind it.
        if ($script:renders.Count -gt 0) {
            $next = $script:renders[0]
            $script:renders.RemoveAt(0)
            Start-Render $next
        }
    }
}

function Invoke-Request($line) {
    try {
        $req = ConvertFrom-Json -InputObject $line
    } catch {
        return $true
    }
    if ($req.PSObject.Properties["speak"]) {
        Start-Speak $req
    } elseif ($req.PSObject.Properties["render"]) {
        if ($script:render) { [void]$script:renders.Add($req) } else { Start-Render $req }
    } elseif ($req.PSObject.Properties["cancel"]) {
        if ($script:current) {
            $script:current.cancelled = $true
            $script:speaker.SpeakAsyncCancelAll()
            if ($script:paused) { $script:speaker.Resume(); $script:paused = $false }
        }
    } elseif ($req.PSObject.Properties["pause"]) {
        if ($script:current -and -not $script:paused) { $script:speaker.Pause(); $script:paused = $true }
    } elseif ($req.PSObject.Properties["resume"]) {
        if ($script:paused) { $script:speaker.Resume(); $script:paused = $false }
    } elseif ($req.PSObject.Properties["volume"]) {
        $script:speaker.Volume = [Math]::Max(0, [Math]::Min(100, [int]$req.volume))
    } elseif ($req.PSObject.Properties["quit"]) {
        return $false
    }
    return $true
}

Send-Line "{`"ready`":true}"

$running = $true
while ($running) {
    if ($read.IsCompleted) {
        $n = 0
        try { $n = $read.Result } catch { $n = 0 }
        if ($n -le 0) { break }   # stdin closed: the extension is gone
        $count = $decoder.GetChars($buffer, 0, $n, $chars, 0)
        $pending += New-Object string ($chars, 0, $count)
        while (($i = $pending.IndexOf("`n")) -ge 0) {
            $line = $pending.Substring(0, $i).Trim()
            $pending = $pending.Substring($i + 1)
            if ($line -and -not (Invoke-Request $line)) { $running = $false }
        }
        if ($running) { $read = $stdin.ReadAsync($buffer, 0, $buffer.Length) }
    }
    if ($current -and $current.prompt.IsCompleted) {
        $done = $current
        $current = $null
        if ($done.cancelled) { Send-Reply $done.id $false "cancelled" $true } else { Send-Reply $done.id $true $null $false }
    }
    if ($render -and $render.prompt.IsCompleted) {
        $done = $render
        $render = $null
        try { $renderer.SetOutputToNull() } catch {}   # closes the WAV
        Send-Reply $done.id $true $null $false
        if ($renders.Count -gt 0) {
            $next = $renders[0]
            $renders.RemoveAt(0)
            Start-Render $next
        }
    }
    if ($running -and -not $read.IsCompleted) {
        # Sleep until stdin has something or 15 ms pass, whichever is first.
        [void]$read.Wait(15)
    }
}

try { $speaker.SpeakAsyncCancelAll(); $speaker.Dispose() } catch {}
if ($renderer) { try { $renderer.Dispose() } catch {} }
