// Native messaging host launcher.
//
// Chrome launches the manifest's `path` directly and passes no arguments, so a
// .cmd wrapper is not an option. This tiny executable starts Node with the real
// host script and pumps stdin/stdout through unchanged, keeping the byte stream
// (and therefore the framing) intact.

using System;
using System.Diagnostics;
using System.IO;

internal static class Launcher
{
    private static int Main()
    {
        var node = @"C:\Program Files\nodejs\node.exe";
        var script = @"D:\work\browsermcp-rebuild\dist\src\host\native.js";

        var startInfo = new ProcessStartInfo(node, "\"" + script + "\"")
        {
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = false,
            CreateNoWindow = true
        };

        Process child;
        try
        {
            child = Process.Start(startInfo);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("launcher: cannot start node: " + error.Message);
            return 2;
        }
        if (child == null)
        {
            Console.Error.WriteLine("launcher: node did not start");
            return 2;
        }

        var pumpOutput = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
        var stdin = Console.OpenStandardInput();
        var buffer = new byte[8192];

        try
        {
            int read;
            while ((read = stdin.Read(buffer, 0, buffer.Length)) > 0)
            {
                child.StandardInput.BaseStream.Write(buffer, 0, read);
                child.StandardInput.BaseStream.Flush();
            }
        }
        catch (IOException)
        {
            // Chrome closed the pipe; let the child exit on its own.
        }

        try { child.StandardInput.Close(); } catch (IOException) { }
        try { pumpOutput.Wait(2000); } catch (AggregateException) { }
        try { child.WaitForExit(2000); } catch (Exception) { }
        return 0;
    }
}
