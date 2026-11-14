# ============================================================
# worker.ps1 — motor de entrada e captura de ecrã (Windows)
# Corre como processo-filho do agent.js.
#
# Protocolo: um comando JSON por linha no stdin; respostas no stdout:
#   SIZE x y w h               → geometria do ecrã virtual (no arranque)
#   FRAME x y w h <base64jpeg> → screenshot (resposta ao comando "shot")
#   PONG <ts>                  → resposta ao comando "ping"
#   ERR <mensagem>             → erro de um comando
#
# Comandos aceites (stdin, JSON):
#   {op:"move",  x, y}          mover o cursor
#   {op:"down"/"up", b}        premir/largar botão (left|right|middle)
#   {op:"wheel", d}            roda (-1/1 trotadas de 120)
#   {op:"kdown"/"kup", vk, ext} tecla física (VK code) baixo/alto
#   {op:"type", ch}            escrever caractere unicode
#   {op:"shot", q}             screenshot JPEG (qualidade q)
#   {op:"ping", ts}            medir latência
# ============================================================

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class Native {
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public InputUnion U;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint n, INPUT[] inputs, int size);

    public static void TypeUnicode(ushort ch) {
        INPUT[] arr = new INPUT[2];
        arr[0].type = 1;
        arr[0].U.ki.wVk = 0;
        arr[0].U.ki.wScan = ch;
        arr[0].U.ki.dwFlags = 0x0004;             // KEYEVENTF_UNICODE
        arr[1].type = 1;
        arr[1].U.ki.wVk = 0;
        arr[1].U.ki.wScan = ch;
        arr[1].U.ki.dwFlags = 0x0004 | 0x0002;    // UNICODE | KEYUP
        uint sent = SendInput(2, arr, Marshal.SizeOf(typeof(INPUT)));
        if (sent != 2) throw new Exception("SendInput falhou (erro " + Marshal.GetLastWin32Error() + ")");
    }
}
"@

$out = [Console]::Out

function Reply([string]$s) {
    $out.WriteLine($s)
    $out.Flush()
}

function Get-VirtualScreen {
    return [System.Windows.Forms.SystemInformation]::VirtualScreen
}

function Take-Shot([int]$quality) {
    $vs = Get-VirtualScreen

    $bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $bmp.Size)
    $g.Dispose()

    $ms = New-Object System.IO.MemoryStream
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
        Where-Object { $_.MimeType -eq 'image/jpeg' }
    if ($codec) {
        $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
        $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
            [System.Drawing.Imaging.Encoder]::Quality, [int64]$quality)
        $bmp.Save($ms, $codec, $ep)
        $ep.Dispose()
    } else {
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg)
    }
    $bmp.Dispose()

    $b64 = [Convert]::ToBase64String($ms.ToArray())
    $ms.Dispose()
    Reply ("FRAME {0} {1} {2} {3} {4}" -f $vs.X, $vs.Y, $vs.Width, $vs.Height, $b64)
}

function Send-MouseButton([string]$b, [bool]$isDown) {
    $map = @{
        left   = @(0x0002, 0x0004)   # LEFTDOWN, LEFTUP
        right  = @(0x0008, 0x0010)   # RIGHTDOWN, RIGHTUP
        middle = @(0x0020, 0x0040)   # MIDDLEDOWN, MIDDLEUP
    }
    if (-not $map.ContainsKey($b)) { return }
    $flag = if ($isDown) { $map[$b][0] } else { $map[$b][1] }
    [Native]::mouse_event([uint32]$flag, 0, 0, 0, [UIntPtr]::Zero)
}

# geometria inicial do ecrã virtual (pode ter offset se houver vários monitores)
$vs0 = Get-VirtualScreen
Reply ("SIZE {0} {1} {2} {3}" -f $vs0.X, $vs0.Y, $vs0.Width, $vs0.Height)

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }          # stdin fechado → sair
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    try {
        $cmd = $line | ConvertFrom-Json
        switch ($cmd.op) {
            'move' {
                [void][Native]::SetCursorPos([int]$cmd.x, [int]$cmd.y)
            }
            'down' {
                Send-MouseButton ([string]$cmd.b) $true
            }
            'up' {
                Send-MouseButton ([string]$cmd.b) $false
            }
            'wheel' {
                $d = 120 * [int]$cmd.d
                [Native]::mouse_event(0x0800, 0, 0, [int]$d, [UIntPtr]::Zero)
            }
            'kdown' {
                $f = 0
                if ($cmd.ext -eq $true) { $f = 1 }    # KEYEVENTF_EXTENDEDKEY
                [Native]::keybd_event([byte][int]$cmd.vk, 0, [uint32]$f, [UIntPtr]::Zero)
            }
            'kup' {
                $f = 2                                  # KEYEVENTF_KEYUP
                if ($cmd.ext -eq $true) { $f = 3 }
                [Native]::keybd_event([byte][int]$cmd.vk, 0, [uint32]$f, [UIntPtr]::Zero)
            }
            'type' {
                [Native]::TypeUnicode([ushort][int]$cmd.ch)
            }
            'shot' {
                Take-Shot ([int]$cmd.q)
            }
            'ping' {
                Reply ("PONG " + $cmd.ts)
            }
            default { }
        }
    } catch {
        Reply ("ERR " + ($_.Exception.Message -replace "`r`n", ' '))
    }
}
