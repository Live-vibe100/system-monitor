using System;
using System.Diagnostics;
using System.IO;
using System.Text;

class Wrapper
{
    static int Main(string[] args)
    {
        string exeDir = AppDomain.CurrentDomain.BaseDirectory;
        string real = Path.Combine(exeDir, "_7za-real.exe");

        var sb = new StringBuilder();
        foreach (var a in args)
        {
            if (sb.Length > 0) sb.Append(' ');
            if (a.Length == 0 || a.IndexOfAny(new[] { ' ', '"', '\t' }) >= 0)
            {
                sb.Append('"');
                sb.Append(a.Replace("\"", "\\\""));
                sb.Append('"');
            }
            else
            {
                sb.Append(a);
            }
        }

        var psi = new ProcessStartInfo(real, sb.ToString());
        psi.UseShellExecute = false;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;

        var stderr = new StringBuilder();
        var p = new Process { StartInfo = psi };
        p.OutputDataReceived += (s, e) => { if (e.Data != null) Console.Out.WriteLine(e.Data); };
        p.ErrorDataReceived += (s, e) => {
            if (e.Data != null)
            {
                stderr.AppendLine(e.Data);
                Console.Error.WriteLine(e.Data);
            }
        };
        p.Start();
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        p.WaitForExit();

        int code = p.ExitCode;
        if (code == 2)
        {
            string errText = stderr.ToString();
            bool onlySymlinkErrors = errText.IndexOf("Cannot create symbolic link", StringComparison.Ordinal) >= 0
                && (errText.IndexOf("darwin", StringComparison.Ordinal) >= 0
                    || errText.IndexOf(".dylib", StringComparison.Ordinal) >= 0);
            if (onlySymlinkErrors)
            {
                Console.Error.WriteLine("[7za-wrapper] Ignoring darwin symlink extraction errors on Windows non-admin.");
                return 0;
            }
        }
        return code;
    }
}
