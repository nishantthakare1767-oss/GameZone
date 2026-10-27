namespace GameHub.Agent.Service;

public sealed class AgentOptions
{
    /// <summary>Base URL of the café server, e.g. http://192.168.1.10:4000 (no trailing slash).</summary>
    public string ServerUrl { get; set; } = "http://127.0.0.1:4000";

    public Guid DeviceId { get; set; }

    /// <summary>One-time code printed by the dashboard. Cleared from config after enrollment.</summary>
    public string? EnrollmentCode { get; set; }

    public int HeartbeatSeconds { get; set; } = 15;

    /// <summary>Seconds between session-state checks while the server is unreachable.</summary>
    public int OfflineRetrySeconds { get; set; } = 5;

    /// <summary>Upper bound on how long a stale authorization may be trusted.</summary>
    public int GraceSeconds { get; set; } = 900;

    /// <summary>Named pipe shared with the interactive session host.</summary>
    public string PipeName { get; set; } = "gamehub-agent";

    /// <summary>Writable program data folder for the token and local log.</summary>
    public string DataDirectory { get; set; } = @"C:\ProgramData\GameHub";
}
