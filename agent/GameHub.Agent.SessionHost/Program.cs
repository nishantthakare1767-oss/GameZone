using System.Diagnostics;
using GameHub.Agent.SessionHost;

// This executable is the shell of the kiosk Windows account. It never runs elevated.
const string InstanceName = "GameHub.SessionHost.SingleInstance";

using var mutex = new Mutex(true, InstanceName, out var isFirstInstance);
if (!isFirstInstance) return;

ApplicationConfiguration.Initialize();

var stationName = Environment.GetEnvironmentVariable("GAMEHUB_STATION") ?? Environment.MachineName;

using var form = new KioskForm(stationName);

// When authorized, hand the desktop over to the configured launcher exactly once.
var launcher = Environment.GetEnvironmentVariable("GAMEHUB_LAUNCHER");
var launched = false;
form.SessionAuthorized += (_, _) =>
{
    if (launched || string.IsNullOrWhiteSpace(launcher)) return;
    launched = true;
    try
    {
        Process.Start(new ProcessStartInfo(launcher) { UseShellExecute = true });
    }
    catch (Exception ex)
    {
        File.AppendAllText(
            Path.Combine(Path.GetTempPath(), "gamehub-sessionhost.log"),
            $"{DateTimeOffset.Now:O} launcher failed: {ex.Message}{Environment.NewLine}");
    }
};

Application.Run(form);
