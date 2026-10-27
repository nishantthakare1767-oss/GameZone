using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace GameHub.Agent.Service;

/// <summary>
/// Serves the current authorization to the interactive session host over a named pipe.
/// Only authenticated local users may connect, and the pipe is read-only: the session
/// host cannot ask the service to grant time.
/// </summary>
public sealed class SessionHostPipe : BackgroundService
{
    private readonly AgentState _state;
    private readonly ILogger<SessionHostPipe> _logger;
    private readonly string _pipeName;

    public SessionHostPipe(AgentState state, IOptions<AgentOptions> options, ILogger<SessionHostPipe> logger)
    {
        _state = state;
        _logger = logger;
        _pipeName = options.Value.PipeName;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var security = new PipeSecurity();
                security.AddAccessRule(new PipeAccessRule(
                    new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null),
                    PipeAccessRights.ReadWrite, AccessControlType.Allow));
                security.AddAccessRule(new PipeAccessRule(
                    new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                    PipeAccessRights.FullControl, AccessControlType.Allow));

                await using var server = NamedPipeServerStreamAcl.Create(
                    _pipeName, PipeDirection.InOut, 4, PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous, 4096, 4096, security);

                await server.WaitForConnectionAsync(stoppingToken);
                using var reader = new StreamReader(server, Encoding.UTF8);
                using var writer = new StreamWriter(server, Encoding.UTF8) { AutoFlush = true };

                var request = await reader.ReadLineAsync(stoppingToken);

                // The interactive host reports what it actually applied; the service
                // forwards that to the server as access-control evidence.
                if (request is not null && request.StartsWith("ACK", StringComparison.OrdinalIgnoreCase))
                {
                    _state.EnqueueAck(request);
                    await writer.WriteLineAsync("ok");
                    await server.FlushAsync(stoppingToken);
                    continue;
                }

                var snapshot = _state.Effective(DateTimeOffset.UtcNow);
                var payload = JsonSerializer.Serialize(new
                {
                    state = snapshot.State,
                    expiresAtUtc = snapshot.ExpiresAtUtc,
                    serverTimeUtc = snapshot.ServerTimeUtc,
                    graceSeconds = snapshot.GraceSeconds,
                    reason = snapshot.Reason,
                    sessionId = snapshot.SessionId,
                    customerNickname = snapshot.CustomerNickname,
                    lastContactUtc = _state.LastContactUtc,
                    request
                });
                await writer.WriteLineAsync(payload);
                await server.FlushAsync(stoppingToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Named pipe request failed");
                await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
            }
        }
    }
}
