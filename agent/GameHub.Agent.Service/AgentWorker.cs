using System.Runtime.InteropServices;
using Microsoft.Extensions.Options;

namespace GameHub.Agent.Service;

/// <summary>
/// The agent's brain: enroll once, heartbeat, reconcile authorization, and turn state
/// changes into access-control reports. Every timing decision uses the server-issued
/// expiry; the agent never invents play time.
/// </summary>
public sealed class AgentWorker : BackgroundService
{
    private const string AgentVersion = "1.0.0";

    private readonly DeviceClient _client;
    private readonly AgentState _state;
    private readonly TokenStore _tokens;
    private readonly AgentOptions _options;
    private readonly ILogger<AgentWorker> _logger;
    private readonly string _os = RuntimeInformation.OSDescription;
    private string _lastReportedState = "UNKNOWN";
    private DateTimeOffset _lastSyncFailureReport = DateTimeOffset.MinValue;

    public AgentWorker(
        DeviceClient client,
        AgentState state,
        TokenStore tokens,
        IOptions<AgentOptions> options,
        ILogger<AgentWorker> logger)
    {
        _client = client;
        _state = state;
        _tokens = tokens;
        _options = options.Value;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Startup check: never trust a desktop that was left unlocked while the PC was off.
        await EnsureEnrolledAsync(stoppingToken);
        if (!_tokens.HasToken)
        {
            _logger.LogWarning(
                "Agent is not enrolled. Set Agent:EnrollmentCode in agent.json and restart the service.");
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            var started = DateTimeOffset.UtcNow;
            try
            {
                var effective = _state.Effective(DateTimeOffset.UtcNow);
                var response = await _client.HeartbeatAsync(
                    AgentVersion, _os, effective.State, _state.PendingRestrictionSessionId, stoppingToken);

                var auth = response.Authorization;
                _state.Update(
                    new AuthorizationSnapshot(
                        auth.State,
                        auth.Session?.ExpiresAt,
                        auth.ServerTime,
                        auth.GraceSeconds > 0 ? auth.GraceSeconds : _options.GraceSeconds,
                        auth.Reason,
                        auth.Session?.Id,
                        auth.Session?.CustomerNickname),
                    response.PendingRestrictionSessionId);

                await DrainAcknowledgementsAsync(stoppingToken);

                if (auth.State != _lastReportedState)
                {
                    _logger.LogInformation("Authorization state {From} -> {To} ({Reason})",
                        _lastReportedState, auth.State, auth.Reason);
                    _lastReportedState = auth.State;
                }
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception ex)
            {
                // Network or server problem: keep the local state, but stop trusting it
                // past the grace window (AgentState.Effective handles that).
                _logger.LogWarning("Heartbeat failed: {Message}", ex.Message);
                if (DateTimeOffset.UtcNow - _lastSyncFailureReport > TimeSpan.FromMinutes(5))
                {
                    _lastSyncFailureReport = DateTimeOffset.UtcNow;
                    await TryReportAsync(new AgentEventDto(
                        "SYNC_FAILED", "SYNC", "FAILED", null,
                        "Heartbeat to the café server failed: " + ex.Message), stoppingToken);
                }
            }

            var elapsed = DateTimeOffset.UtcNow - started;
            var delay = TimeSpan.FromSeconds(Math.Max(2, _options.HeartbeatSeconds - elapsed.TotalSeconds));
            await Task.Delay(delay, stoppingToken);
        }
    }

    private async Task EnsureEnrolledAsync(CancellationToken ct)
    {
        if (_tokens.HasToken) return;
        if (string.IsNullOrWhiteSpace(_options.EnrollmentCode))
        {
            _logger.LogWarning("No device token and no enrollment code configured.");
            return;
        }

        try
        {
            await _client.EnrollAsync(_options.EnrollmentCode!, AgentVersion, _os, ct);
            _logger.LogInformation("Device enrolled successfully.");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Enrollment failed; will retry on next start.");
        }
    }

    /// <summary>Reports what the interactive host actually applied.</summary>
    private async Task DrainAcknowledgementsAsync(CancellationToken ct)
    {
        while (_state.TryDequeueAck(out var ack))
        {
            var parts = ack.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 2) continue;
            var kind = parts[1].ToUpperInvariant();
            Guid? sessionId = parts.Length > 2 && Guid.TryParse(parts[2], out var parsed) ? parsed : null;

            await TryReportAsync(new AgentEventDto(
                kind == "RESTRICTED" ? "RESTRICTION_APPLIED" : kind,
                kind == "RESTRICTED" ? "RESTRICT" : "SYNC",
                "SUCCESS",
                sessionId,
                kind == "RESTRICTED" ? "Session host lock screen is active." : null), ct);
        }
    }

    private async Task TryReportAsync(AgentEventDto evt, CancellationToken ct)
    {
        try
        {
            await _client.ReportEventsAsync(new[] { evt }, ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning("Could not report event {Type}: {Message}", evt.Type, ex.Message);
        }
    }
}
