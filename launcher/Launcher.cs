// Native messaging host launcher.
//
// Chrome launches the manifest's `path` directly and passes no arguments, so a
// .cmd wrapper is not an option. This tiny executable starts Node with the real
// host script and pumps stdin/stdout through unchanged, keeping the byte stream
// (and therefore the framing) intact.
//
// Nothing here may hard-code a machine path: the same binary has to work on any
// checkout. Resolution order for both values:
//   1. command line:  native-host.exe <node.exe> <native.js>
//   2. environment:   TABMCP_NODE / TABMCP_HOST_SCRIPT
//   3. layout:        <launcher dir>\dist\src\host\native.js, node from PATH

using System;
using System.Diagnostics;
using System.IO;

internal static class Launcher
{
    private static int Main(string[] args)
    {
        var script = ResolveScript(args);
        if (script == null)
        {
            Console.Error.WriteLine("launcher: native.js not found. Set TABMCP_HOST_SCRIPT or pass it as the second argument.");
            return 2;
        }

        var node = ResolveNode(args);
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
            Console.Error.WriteLine("launcher: cannot start " + node + ": " + error.Message);
            return 2;
        }
        if (child == null)
        {
            Console.Error.WriteLine("launcher: node did not start");
            return 2;
        }

        var pumpOutput = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());

        // Chrome keeps this process's pipe open for as long as the process lives. So if node
        // dies and the launcher stays blocked in stdin.Read below, Chrome still sees a live
        // host, never respawns one, and the extension cannot reconnect - every call fails
        // while the UI looks healthy. Follow the child out instead.
        child.EnableRaisingEvents = true;
        child.Exited += delegate
        {
            try { pumpOutput.Wait(1000); }
            catch (Exception) { }
            Environment.Exit(0);
        };
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

        child.StandardInput.Close();
        try
        {
            child.WaitForExit();
            pumpOutput.Wait(2000);
        }
        catch (Exception)
        {
            // Nothing useful to do if the child is already gone.
        }
        return 0;
    }

    private static string ResolveScript(string[] args)
    {
        if (args.Length > 1 && File.Exists(args[1])) return Path.GetFullPath(args[1]);

        var fromEnv = Environment.GetEnvironmentVariable("TABMCP_HOST_SCRIPT");
        if (!string.IsNullOrEmpty(fromEnv) && File.Exists(fromEnv)) return Path.GetFullPath(fromEnv);

        var launcherDir = Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName);
        var beside = Path.Combine(launcherDir, "dist", "src", "host", "native.js");
        if (File.Exists(beside)) return beside;

        return null;
    }

    private static string ResolveNode(string[] args)
    {
        if (args.Length > 0 && File.Exists(args[0])) return Path.GetFullPath(args[0]);

        var fromEnv = Environment.GetEnvironmentVariable("TABMCP_NODE");
        if (!string.IsNullOrEmpty(fromEnv) && File.Exists(fromEnv)) return Path.GetFullPath(fromEnv);

        // "node" lets Windows resolve it through PATH, which is what a normal
        // install gives us; the explicit paths only cover the default installer.
        var candidates = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe"),
        };
        foreach (var candidate in candidates)
        {
            if (File.Exists(candidate)) return candidate;
        }
        return "node";
    }
}
