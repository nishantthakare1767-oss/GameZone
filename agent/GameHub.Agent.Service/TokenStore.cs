using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace GameHub.Agent.Service;

/// <summary>
/// Stores the device bearer token encrypted with DPAPI at machine scope, in a folder
/// that only SYSTEM and Administrators can read. The token is never written to logs.
/// </summary>
public sealed class TokenStore
{
    private readonly AgentOptions _options;
    private readonly ILogger<TokenStore> _logger;
    private readonly string _tokenPath;
    private string? _cached;

    public TokenStore(IOptions<AgentOptions> options, ILogger<TokenStore> logger)
    {
        _options = options.Value;
        _logger = logger;
        Directory.CreateDirectory(_options.DataDirectory);
        _tokenPath = Path.Combine(_options.DataDirectory, "device.token");
        HardenDirectory(_options.DataDirectory);
    }

    public bool HasToken => Load() is not null;

    public string? Load()
    {
        if (_cached is not null) return _cached;
        if (!File.Exists(_tokenPath)) return null;
        try
        {
            var protectedBytes = File.ReadAllBytes(_tokenPath);
            var plain = ProtectedData.Unprotect(protectedBytes, null, DataProtectionScope.LocalMachine);
            _cached = Encoding.UTF8.GetString(plain);
            return _cached;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Stored device token could not be decrypted; re-enrollment required.");
            return null;
        }
    }

    public void Save(string token)
    {
        var protectedBytes = ProtectedData.Protect(
            Encoding.UTF8.GetBytes(token), null, DataProtectionScope.LocalMachine);
        File.WriteAllBytes(_tokenPath, protectedBytes);
        _cached = token;
    }

    public void Clear()
    {
        _cached = null;
        if (File.Exists(_tokenPath)) File.Delete(_tokenPath);
    }

    private static void HardenDirectory(string path)
    {
        try
        {
            var info = new DirectoryInfo(path);
            var security = info.GetAccessControl();
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
                FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None, AccessControlType.Allow));
            info.SetAccessControl(security);
        }
        catch
        {
            // ACL hardening is best effort; the token is still DPAPI encrypted.
        }
    }
}

public sealed record AuthorizationSnapshot(
    string State,
    DateTimeOffset? ExpiresAtUtc,
    DateTimeOffset ServerTimeUtc,
    int GraceSeconds,
    string? Reason,
    Guid? SessionId,
    string? CustomerNickname);

/// <summary>Thread-safe view of the last authorization the server issued.</summary>
public sealed class AgentState
{
    private readonly object _gate = new();
    private readonly System.Collections.Concurrent.ConcurrentQueue<string> _acks = new();
    private AuthorizationSnapshot _snapshot =
        new("UNKNOWN", null, DateTimeOffset.UtcNow, 900, "Waiting for the first heartbeat", null, null);
    private DateTimeOffset _lastContactUtc = DateTimeOffset.MinValue;
    private string _pendingRestrictionSessionId = string.Empty;

    public event EventHandler<AuthorizationSnapshot>? Changed;

    public AuthorizationSnapshot Snapshot
    {
        get { lock (_gate) return _snapshot; }
    }

    public string PendingRestrictionSessionId
    {
        get { lock (_gate) return _pendingRestrictionSessionId; }
    }

    public DateTimeOffset LastContactUtc
    {
        get { lock (_gate) return _lastContactUtc; }
    }

    /// <summary>Session host acknowledgements, e.g. "ACK RESTRICTED &lt;sessionId&gt;".</summary>
    public void EnqueueAck(string message) => _acks.Enqueue(message);

    public bool TryDequeueAck(out string message) => _acks.TryDequeue(out message!);

    public void Update(AuthorizationSnapshot snapshot, string? pendingRestrictionSessionId)
    {
        bool changed;
        lock (_gate)
        {
            changed = _snapshot.State != snapshot.State
                      || _snapshot.ExpiresAtUtc != snapshot.ExpiresAtUtc
                      || _snapshot.SessionId != snapshot.SessionId;
            _snapshot = snapshot;
            _lastContactUtc = DateTimeOffset.UtcNow;
            _pendingRestrictionSessionId = pendingRestrictionSessionId ?? string.Empty;
        }
        if (changed) Changed?.Invoke(this, snapshot);
    }

    /// <summary>
    /// What the interactive host should display right now. Time-based degradation is
    /// computed locally so the desktop reacts even when the network is gone.
    /// </summary>
    public AuthorizationSnapshot Effective(DateTimeOffset now)
    {
        var snapshot = Snapshot;
        var silentFor = now - LastContactUtc;

        if (silentFor.TotalSeconds > snapshot.GraceSeconds)
        {
            return snapshot with
            {
                State = "RECOVERY",
                Reason = "Lost contact with the café server. Ask staff for help."
            };
        }

        if (snapshot.State == "AUTHORIZED" && snapshot.ExpiresAtUtc is { } expiry && now >= expiry)
        {
            return snapshot with { State = "EXPIRED", Reason = "Session time is over." };
        }

        return snapshot;
    }
}
