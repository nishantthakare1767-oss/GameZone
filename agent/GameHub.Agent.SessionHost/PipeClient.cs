using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace GameHub.Agent.SessionHost;

public sealed record AgentSnapshot(
    [property: JsonPropertyName("state")] string State,
    [property: JsonPropertyName("expiresAtUtc")] DateTimeOffset? ExpiresAtUtc,
    [property: JsonPropertyName("serverTimeUtc")] DateTimeOffset ServerTimeUtc,
    [property: JsonPropertyName("graceSeconds")] int GraceSeconds,
    [property: JsonPropertyName("reason")] string? Reason,
    [property: JsonPropertyName("sessionId")] Guid? SessionId,
    [property: JsonPropertyName("customerNickname")] string? CustomerNickname,
    [property: JsonPropertyName("lastContactUtc")] DateTimeOffset LastContactUtc);

/// <summary>
/// Reads authorization from the service. This process is unprivileged: it can only ask
/// for state and acknowledge an applied restriction, never grant time.
/// </summary>
public static class PipeClient
{
    private const string PipeName = "gamehub-agent";

    public static AgentSnapshot? Query()
    {
        try
        {
            using var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut, PipeOptions.None);
            pipe.Connect(1500);
            using var writer = new StreamWriter(pipe, Encoding.UTF8) { AutoFlush = true };
            using var reader = new StreamReader(pipe, Encoding.UTF8);
            writer.WriteLine("STATE");
            var line = reader.ReadLine();
            if (string.IsNullOrWhiteSpace(line)) return null;
            return JsonSerializer.Deserialize<AgentSnapshot>(line);
        }
        catch (TimeoutException)
        {
            return null;
        }
        catch (IOException)
        {
            return null;
        }
    }

    /// <summary>Tells the service that this desktop is actually locked right now.</summary>
    public static void AcknowledgeRestriction(Guid? sessionId)
    {
        try
        {
            using var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut, PipeOptions.None);
            pipe.Connect(1500);
            using var writer = new StreamWriter(pipe, Encoding.UTF8) { AutoFlush = true };
            writer.WriteLine($"ACK RESTRICTED {sessionId}");
        }
        catch
        {
            // Best effort: the service retries on the next heartbeat.
        }
    }
}
