# Persistent WAV player for the Claude Code TTS VSCode extension, on Windows.
#
# Speaks the protocol of assets/wavplayer.swift (JSON lines on stdin, replies
# on stdout), so the extension drives both with the same code:
#   {"play":"C:\\a.wav","id":1,"rate":1.0,"volume":1.0,"final":false}
#   {"append":"C:\\b.wav","final":true}    the next part of the same utterance
#   {"end":true}                           no more parts; done after the last
#   {"rate":1.2}  {"volume":0.5}  {"pause":true}  {"resume":true}  {"stop":true}
#   -> {"ready":true}  {"done":true,"id":1}  {"done":true,"id":1,"stopped":true}
#      {"done":false,"id":1,"error":"..."}
#
# Why: a PowerShell started for every sentence to run System.Media.SoundPlayer
# cost about 850 ms of silence per sentence on a laptop, could not be paused,
# and ignored the volume. One process for the session, and the parts of an
# utterance queued as PCM buffers on the waveOut device (winmm, reached
# through a small C# class compiled here): consecutive buffers play without
# a gap, where a file per part through WPF's MediaPlayer put 35-90 ms of
# silence at every seam (250 ms when the part arrived just in time), which
# with a part a second was heard as a stutter. MediaPlayer stays as the
# fallback for a file that is not 16-bit PCM, and for a machine where the
# class cannot be compiled. The rate is accepted and ignored: this player
# does not stretch time, and the extension knows (it plans for a tempo of 1
# where the player cannot).
$ErrorActionPreference = "Continue"
try {
    [Console]::InputEncoding = [System.Text.Encoding]::UTF8
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {}

$out = [Console]::Out
function Send-Line($text) { $script:out.WriteLine($text); $script:out.Flush() }
function Send-Done($id, $stopped) {
    if ($stopped) { Send-Line "{`"done`":true,`"id`":$id,`"stopped`":true}" } else { Send-Line "{`"done`":true,`"id`":$id}" }
}
function Send-Error($id, $message) {
    Send-Line ("{`"done`":false,`"id`":$id,`"error`":" + (ConvertTo-Json -InputObject ([string]$message) -Compress) + "}")
}

$waveOutSource = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

public class CcttsWaveOut
{
    [StructLayout(LayoutKind.Sequential)]
    struct WAVEFORMATEX
    {
        public ushort wFormatTag; public ushort nChannels; public uint nSamplesPerSec; public uint nAvgBytesPerSec;
        public ushort nBlockAlign; public ushort wBitsPerSample; public ushort cbSize;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct WAVEHDR
    {
        public IntPtr lpData; public uint dwBufferLength; public uint dwBytesRecorded; public IntPtr dwUser;
        public uint dwFlags; public uint dwLoops; public IntPtr lpNext; public IntPtr reserved;
    }
    [DllImport("winmm.dll")] static extern int waveOutOpen(out IntPtr h, uint device, ref WAVEFORMATEX fmt, IntPtr cb, IntPtr inst, uint flags);
    [DllImport("winmm.dll")] static extern int waveOutPrepareHeader(IntPtr h, IntPtr hdr, int size);
    [DllImport("winmm.dll")] static extern int waveOutUnprepareHeader(IntPtr h, IntPtr hdr, int size);
    [DllImport("winmm.dll")] static extern int waveOutWrite(IntPtr h, IntPtr hdr, int size);
    [DllImport("winmm.dll")] static extern int waveOutReset(IntPtr h);
    [DllImport("winmm.dll")] static extern int waveOutPause(IntPtr h);
    [DllImport("winmm.dll")] static extern int waveOutRestart(IntPtr h);
    [DllImport("winmm.dll")] static extern int waveOutClose(IntPtr h);
    [DllImport("winmm.dll")] static extern int waveOutSetVolume(IntPtr h, uint volume);

    const uint WAVE_MAPPER = 0xFFFFFFFF;
    const uint WHDR_DONE = 1;
    static readonly int HDR_SIZE = Marshal.SizeOf(typeof(WAVEHDR));
    static readonly int FLAGS_OFFSET = (int)Marshal.OffsetOf(typeof(WAVEHDR), "dwFlags");

    IntPtr handle = IntPtr.Zero;
    int rate, channels;
    double volume = 1.0;
    bool paused;
    readonly List<IntPtr> headers = new List<IntPtr>();

    public bool IsOpen { get { return handle != IntPtr.Zero; } }
    public int Queued { get { return headers.Count; } }

    // The device for this format, kept open across utterances of the same format.
    public bool Open(int rate, int channels)
    {
        if (handle != IntPtr.Zero && rate == this.rate && channels == this.channels) return true;
        Close();
        var fmt = new WAVEFORMATEX();
        fmt.wFormatTag = 1; fmt.nChannels = (ushort)channels; fmt.nSamplesPerSec = (uint)rate;
        fmt.wBitsPerSample = 16; fmt.nBlockAlign = (ushort)(channels * 2); fmt.nAvgBytesPerSec = (uint)(rate * channels * 2); fmt.cbSize = 0;
        IntPtr h;
        if (waveOutOpen(out h, WAVE_MAPPER, ref fmt, IntPtr.Zero, IntPtr.Zero, 0) != 0) return false;
        handle = h; this.rate = rate; this.channels = channels; paused = false;
        ApplyVolume();
        return true;
    }

    // Queue a buffer behind whatever is playing: it starts the instant the one
    // before it ends. False when the device refused it, which the caller reports
    // rather than letting the part go by in silence.
    public bool Write(byte[] data)
    {
        if (handle == IntPtr.Zero) return false;
        if (data.Length == 0) return true;
        IntPtr buf = Marshal.AllocHGlobal(data.Length);
        Marshal.Copy(data, 0, buf, data.Length);
        var hdr = new WAVEHDR();
        hdr.lpData = buf; hdr.dwBufferLength = (uint)data.Length;
        IntPtr ph = Marshal.AllocHGlobal(HDR_SIZE);
        Marshal.StructureToPtr(hdr, ph, false);
        if (waveOutPrepareHeader(handle, ph, HDR_SIZE) != 0 || waveOutWrite(handle, ph, HDR_SIZE) != 0)
        {
            Marshal.FreeHGlobal(buf); Marshal.FreeHGlobal(ph);
            return false;
        }
        headers.Add(ph);
        return true;
    }

    // Free the buffers the device has finished with; true when none is left.
    public bool Idle()
    {
        while (headers.Count > 0)
        {
            IntPtr ph = headers[0];
            if ((Marshal.ReadInt32(ph, FLAGS_OFFSET) & WHDR_DONE) == 0) break;
            Release(ph);
            headers.RemoveAt(0);
        }
        return headers.Count == 0;
    }

    void Release(IntPtr ph)
    {
        waveOutUnprepareHeader(handle, ph, HDR_SIZE);
        var hdr = (WAVEHDR)Marshal.PtrToStructure(ph, typeof(WAVEHDR));
        Marshal.FreeHGlobal(hdr.lpData);
        Marshal.FreeHGlobal(ph);
    }

    // Drop everything queued, at once.
    public void Reset()
    {
        if (handle == IntPtr.Zero) return;
        waveOutReset(handle);
        foreach (IntPtr ph in headers) Release(ph);
        headers.Clear();
        if (paused) { waveOutRestart(handle); paused = false; }
    }

    public void Pause() { if (handle != IntPtr.Zero && !paused) { waveOutPause(handle); paused = true; } }
    public void Resume() { if (handle != IntPtr.Zero && paused) { waveOutRestart(handle); paused = false; } }

    public void SetVolume(double v) { volume = Math.Max(0.0, Math.Min(1.0, v)); ApplyVolume(); }
    void ApplyVolume()
    {
        if (handle == IntPtr.Zero) return;
        uint x = (uint)Math.Round(volume * 0xFFFF);
        waveOutSetVolume(handle, x | (x << 16));
    }

    public void Close()
    {
        if (handle == IntPtr.Zero) return;
        Reset();
        waveOutClose(handle);
        handle = IntPtr.Zero;
    }

    // The samples of a 16-bit PCM WAV, or null for anything else (MediaPlayer plays those).
    public static byte[] ReadPcm(string path, out int rate, out int channels)
    {
        rate = 0; channels = 0;
        byte[] b = File.ReadAllBytes(path);
        if (b.Length < 12 || b[0] != 'R' || b[1] != 'I' || b[2] != 'F' || b[3] != 'F' || b[8] != 'W' || b[9] != 'A' || b[10] != 'V' || b[11] != 'E') return null;
        int pos = 12; int bits = 0; int format = 0;
        while (pos + 8 <= b.Length)
        {
            string id = System.Text.Encoding.ASCII.GetString(b, pos, 4);
            int size = BitConverter.ToInt32(b, pos + 4);
            int body = pos + 8;
            if (id == "fmt ")
            {
                format = BitConverter.ToUInt16(b, body);
                channels = BitConverter.ToUInt16(b, body + 2);
                rate = BitConverter.ToInt32(b, body + 4);
                bits = BitConverter.ToUInt16(b, body + 14);
                if (format == 0xFFFE && size >= 26) format = BitConverter.ToUInt16(b, body + 24); // extensible: the subformat's first word
            }
            else if (id == "data")
            {
                if (format != 1 || bits != 16 || rate <= 0 || channels <= 0) return null;
                int n = Math.Min(size, b.Length - body);
                var data = new byte[n];
                Buffer.BlockCopy(b, body, data, 0, n);
                return data;
            }
            pos = body + size + (size & 1);
        }
        return null;
    }
}
'@

$pcm = $null
try {
    Add-Type -TypeDefinition $waveOutSource -Language CSharp
    $pcm = New-Object CcttsWaveOut
    # Opened now, in the format the neural engines write: the first open of
    # the device measured 1.2 s, which the first sentence would otherwise pay.
    [void]$pcm.Open(24000, 1)
} catch {
    $pcm = $null
}
try {
    Add-Type -AssemblyName PresentationCore
    # Two players alternate: the next part is opened while the current one
    # plays, so starting it is a Play() rather than a file open.
    $players = @((New-Object System.Windows.Media.MediaPlayer), (New-Object System.Windows.Media.MediaPlayer))
} catch {
    if ($pcm -eq $null) {
        Send-Line ("{`"ready`":false,`"error`":" + (ConvertTo-Json -InputObject ([string]$_) -Compress) + "}")
        exit 1
    }
    $players = @()
}

$stdin = [Console]::OpenStandardInput()
$buffer = New-Object byte[] 65536
$decoder = (New-Object System.Text.UTF8Encoding($false)).GetDecoder()
$chars = New-Object char[] 65536
$pending = ""
$read = $stdin.ReadAsync($buffer, 0, $buffer.Length)

# The utterance being played: its id, the parts still to play, the part
# playing, whether the last part has been announced, and the volume.
$streamId = 0
$queue = New-Object System.Collections.ArrayList   # file paths not yet started (MediaPlayer path)
$current = $null        # @{ player; file; opened (ms) }
$next = $null           # the pre-opened part: @{ player; file }
$finalReceived = $true
$paused = $false
$volume = 1.0
$which = 0
$clock = [Diagnostics.Stopwatch]::StartNew()
# The PCM path: whether the utterance being played goes through waveOut,
# and whether anything of it has been queued.
$pcmStream = $false
$pcmQueuedAny = $false

function Open-Part($file) {
    $script:which = 1 - $script:which
    $p = $script:players[$script:which]
    $p.Stop()
    $p.Volume = [double]$script:volume
    $p.Open([Uri]$file)
    return @{ player = $p; file = $file; opened = $script:clock.ElapsedMilliseconds }
}

function Start-Part($part) {
    $script:current = $part
    $part.player.Volume = [double]$script:volume
    $part.player.Position = [TimeSpan]::Zero
    if (-not $script:paused) { $part.player.Play() }
}

function Prepare-Next {
    if ($script:next -eq $null -and $script:queue.Count -gt 0) {
        $file = $script:queue[0]
        $script:queue.RemoveAt(0)
        $script:next = Open-Part $file
    }
}

function Stop-All {
    if ($script:pcm -ne $null) { try { $script:pcm.Reset() } catch {} }
    foreach ($p in $script:players) { try { $p.Stop(); $p.Close() } catch {} }
    $script:queue.Clear()
    $script:current = $null
    $script:next = $null
    $script:pcmStream = $false
    $script:pcmQueuedAny = $false
}

# Queue a file's samples on the device; $null when it is not 16-bit PCM.
function Queue-Pcm($file) {
    $rate = 0; $channels = 0
    $data = [CcttsWaveOut]::ReadPcm($file, [ref]$rate, [ref]$channels)
    if ($data -eq $null) { return $false }
    if (-not $script:pcm.Open($rate, $channels)) { throw "the audio device refused ${rate} Hz, ${channels} channel(s)" }
    $script:pcm.SetVolume([double]$script:volume)
    if ($script:paused) { $script:pcm.Pause() }
    if (-not $script:pcm.Write($data)) { throw "the audio device refused the buffer" }
    $script:pcmQueuedAny = $true
    return $true
}

# A part that has not reported a duration a while after opening will not:
# the file is unreadable, or not audio.
$OPEN_TIMEOUT_MS = 3000

function Invoke-Request($line) {
    try { $req = ConvertFrom-Json -InputObject $line } catch { return $true }
    if ($req.PSObject.Properties["play"]) {
        Stop-All
        $script:streamId = [int]$req.id
        $script:finalReceived = [bool]$req.final
        $script:paused = $false
        if ($req.PSObject.Properties["volume"]) { $script:volume = [Math]::Max(0.0, [Math]::Min(1.0, [double]$req.volume)) }
        try {
            $file = [string]$req.play
            if ($script:pcm -ne $null -and (Queue-Pcm $file)) {
                $script:pcmStream = $true
            } elseif ($script:players.Count -gt 0) {
                Start-Part (Open-Part $file)
            } else {
                throw "not a 16-bit PCM WAV file"
            }
        } catch {
            $script:current = $null
            $script:pcmStream = $false
            Send-Error $script:streamId ("cannot open audio file: " + $_)
        }
    } elseif ($req.PSObject.Properties["append"]) {
        if ([bool]$req.final) { $script:finalReceived = $true }
        if ($script:pcmStream) {
            try {
                if (-not (Queue-Pcm ([string]$req.append))) { throw "not a 16-bit PCM WAV file" }
            } catch {
                Send-Error $script:streamId ("cannot open audio file: " + $_)
                Stop-All
                $script:finalReceived = $true
            }
        } else {
            [void]$script:queue.Add([string]$req.append)
            if ($script:current -eq $null) {
                # An underrun: the previous part ended before this one arrived.
                Prepare-Next
                if ($script:next) { Start-Part $script:next; $script:next = $null }
            } else {
                Prepare-Next
            }
        }
    } elseif ($req.PSObject.Properties["end"]) {
        $script:finalReceived = $true
        if (-not $script:pcmStream -and $script:current -eq $null -and $script:queue.Count -eq 0 -and $script:next -eq $null) {
            Send-Done $script:streamId $false
        }
    } elseif ($req.PSObject.Properties["stop"]) {
        $id = $script:streamId
        Stop-All
        $script:finalReceived = $true
        Send-Done $id $true
    } elseif ($req.PSObject.Properties["pause"]) {
        $script:paused = $true
        if ($script:pcm -ne $null) { $script:pcm.Pause() }
        if ($script:current) { $script:current.player.Pause() }
    } elseif ($req.PSObject.Properties["resume"]) {
        $script:paused = $false
        if ($script:pcm -ne $null) { $script:pcm.Resume() }
        if ($script:current) { $script:current.player.Play() }
    } elseif ($req.PSObject.Properties["volume"]) {
        $script:volume = [Math]::Max(0.0, [Math]::Min(1.0, [double]$req.volume))
        if ($script:pcm -ne $null) { $script:pcm.SetVolume([double]$script:volume) }
        if ($script:current) { $script:current.player.Volume = [double]$script:volume }
    } elseif ($req.PSObject.Properties["rate"]) {
        # Accepted, not applied: no time-stretch here.
    } elseif ($req.PSObject.Properties["quit"]) {
        return $false
    }
    return $true
}

# Warm-up: PowerShell compiles a cmdlet and a class method on first use,
# and the audio engine opens its stream on the first buffer; together the
# first sentence measured 1.2 s late without this. A 10 ms silent WAV goes
# through the same path an utterance takes.
try {
    $null = ConvertFrom-Json -InputObject '{"warm":true}'
    $null = ConvertTo-Json -InputObject "warm" -Compress
    if ($pcm -ne $null) {
        $tmp = [IO.Path]::Combine([IO.Path]::GetTempPath(), "claude-code-tts-warm-$PID.wav")
        $samples = 480
        $bytes = New-Object byte[] (44 + $samples * 2)
        [Text.Encoding]::ASCII.GetBytes("RIFF").CopyTo($bytes, 0)
        [BitConverter]::GetBytes([int](36 + $samples * 2)).CopyTo($bytes, 4)
        [Text.Encoding]::ASCII.GetBytes("WAVEfmt ").CopyTo($bytes, 8)
        [BitConverter]::GetBytes([int]16).CopyTo($bytes, 16)
        [BitConverter]::GetBytes([int16]1).CopyTo($bytes, 20)
        [BitConverter]::GetBytes([int16]1).CopyTo($bytes, 22)
        [BitConverter]::GetBytes([int]24000).CopyTo($bytes, 24)
        [BitConverter]::GetBytes([int]48000).CopyTo($bytes, 28)
        [BitConverter]::GetBytes([int16]2).CopyTo($bytes, 32)
        [BitConverter]::GetBytes([int16]16).CopyTo($bytes, 34)
        [Text.Encoding]::ASCII.GetBytes("data").CopyTo($bytes, 36)
        [BitConverter]::GetBytes([int]($samples * 2)).CopyTo($bytes, 40)
        [IO.File]::WriteAllBytes($tmp, $bytes)
        $pcm.SetVolume(0.0)
        [void](Queue-Pcm $tmp)
        $deadline = $clock.ElapsedMilliseconds + 2000
        while (-not $pcm.Idle() -and $clock.ElapsedMilliseconds -lt $deadline) { Start-Sleep -Milliseconds 5 }
        $pcm.Reset()
        $pcm.SetVolume([double]$volume)
        $pcmQueuedAny = $false
        Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
    }
} catch {}

Send-Line "{`"ready`":true}"

$running = $true
while ($running) {
    if ($read.IsCompleted) {
        $n = 0
        try { $n = $read.Result } catch { $n = 0 }
        if ($n -le 0) { break }
        $count = $decoder.GetChars($buffer, 0, $n, $chars, 0)
        $pending += New-Object string ($chars, 0, $count)
        while (($i = $pending.IndexOf("`n")) -ge 0) {
            $line = $pending.Substring(0, $i).Trim()
            $pending = $pending.Substring($i + 1)
            if ($line -and -not (Invoke-Request $line)) { $running = $false }
        }
        if ($running) { $read = $stdin.ReadAsync($buffer, 0, $buffer.Length) }
    }
    if ($pcmStream -and -not $paused) {
        # Done when the device has played everything and the last part has
        # been announced; between parts the device simply waits (an underrun).
        if ($pcm.Idle() -and $finalReceived -and $pcmQueuedAny) {
            $pcmStream = $false
            $pcmQueuedAny = $false
            Send-Done $streamId $false
        }
    }
    if ($current -ne $null -and -not $paused) {
        $p = $current.player
        $ended = $false
        if ($p.NaturalDuration.HasTimeSpan) {
            if ($p.Position -ge $p.NaturalDuration.TimeSpan) { $ended = $true }
        } elseif ($clock.ElapsedMilliseconds - $current.opened -gt $OPEN_TIMEOUT_MS) {
            # Never opened: report and move on as if it had played.
            Send-Error $streamId ("cannot open audio file: " + $current.file)
            Stop-All
            $finalReceived = $true
            $current = $null
        }
        if ($ended) {
            $p.Stop()
            $current = $null
            Prepare-Next
            if ($next) {
                Start-Part $next
                $next = $null
                Prepare-Next
            } elseif ($finalReceived) {
                Send-Done $streamId $false
            }
            # else: waiting for the next part (an underrun); append starts it.
        }
    }
    if ($running -and -not $read.IsCompleted) { [void]$read.Wait(10) }
}

Stop-All
if ($pcm -ne $null) { try { $pcm.Close() } catch {} }
