using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;

namespace GameHub.Agent.Service;

public sealed record EnrollRequest(
    [property: JsonPropertyName("deviceId")] Guid DeviceId,
    [property: JsonPropertyName("enrollmentCode")] string EnrollmentCode,
    [property: JsonPropertyName("agentVersion")] string AgentVersion,
    [property: JsonPropertyName("os")] string Os);

public sealed record EnrollResponse(
    [property: JsonPropertyName("deviceToken")] string DeviceToken,
    [property: JsonPropertyName("device")] JsonElement Device);

public sealed record HeartbeatResponse(
    [property: JsonPropertyName("authorization")] AuthorizationDto Authorization,
    [property: JsonPropertyName("pendingRestrictionSessionId")] string? PendingRestrictionSessionId,
    [property: JsonPropertyName("serverTime")] DateTimeOffset ServerTime);

public sealed record AuthorizationDto(
    [property: JsonPropertyName("state")] string State,
    [property: JsonPropertyName("serverTime")] DateTimeOffset ServerTime,
    [property: JsonPropertyName("graceSeconds")] int GraceSeconds,
    [property: JsonPropertyName("reason")] string? Reason,
    [property: JsonPropertyName("session")] SessionDto? Session,
    [property: JsonPropertyName("accessMethod")] string? AccessMethod);

public sealed record SessionDto(
    [property: JsonPropertyName("id")] Guid Id,
    [property: JsonPropertyName("expiresAt")] DateTimeOffset ExpiresAt,
    [property: JsonPropertyName("customerNickname")] string? CustomerNickname,
    [property: JsonPropertyName("startedAt")] DateTimeOffset StartedAt);

public sealed record AgentEventDto(
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("action")] string? Action,
    [property: JsonPropertyName("outcome")] string? Outcome,
    [property: JsonPropertyName("sessionId")] Guid? SessionId,
    [property: JsonPropertyName("message")] string? Message);

/// <summary>
/// Thin, retry-free wrapper over the device API. Retry/backoff lives in the worker so
/// the whole state machine (not just one request) reacts to an outage.
/// </summary>
public sealed class DeviceClient
{
    private readonly HttpClient _http;
    private readonly TokenStore _tokens;
    private readonly AgentOptions _options;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public DeviceClient(HttpClient http, TokenStore tokens, IOptions<AgentOptions> options)
    {
        _http = http;
        _tokens = tokens;
        _options = options.Value;
        _http.BaseAddress = new Uri(_options.ServerUrl.TrimEnd('/') + "/");
        _http.Timeout = TimeSpan.FromSeconds(10);
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("GameHub-Agent/1.0");
    }

    public async Task EnrollAsync(string enrollmentCode, string agentVersion, string os, CancellationToken ct)
    {
        var response = await _http.PostAsJsonAsync("api/agent/register",
            new EnrollRequest(_options.DeviceId, enrollmentCode, agentVersion, os), Json, ct);
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<EnrollResponse>(Json, ct)
                   ?? throw new InvalidOperationException("Empty enrollment response");
        _tokens.Save(body.DeviceToken);
    }

    public async Task<HeartbeatResponse> HeartbeatAsync(string agentVersion, string os, string accessState,
        string? pendingRestrictionSessionId, CancellationToken ct)
    {
        var token = _tokens.Load() ?? throw new InvalidOperationException("Device is not enrolled");
        using var request = new HttpRequestMessage(HttpMethod.Post, "api/agent/heartbeat")
        {
            Content = JsonContent.Create(new
            {
                agentVersion,
                os,
                accessState,
                pendingRestrictionSessionId
            })
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

        using var response = await _http.SendAsync(request, ct);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<HeartbeatResponse>(Json, ct)
               ?? throw new InvalidOperationException("Empty heartbeat response");
    }

    public async Task<HeartbeatResponse> GetSessionStateAsync(CancellationToken ct)
    {
        var token = _tokens.Load() ?? throw new InvalidOperationException("Device is not enrolled");
        using var request = new HttpRequestMessage(HttpMethod.Get, "api/agent/session-state");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var response = await _http.SendAsync(request, ct);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<HeartbeatResponse>(Json, ct)
               ?? throw new InvalidOperationException("Empty session-state response");
    }

    public async Task ReportEventsAsync(IEnumerable<AgentEventDto> events, CancellationToken ct)
    {
        var token = _tokens.Load();
        if (token is null) return;
        using var request = new HttpRequestMessage(HttpMethod.Post, "api/agent/events")
        {
            Content = JsonContent.Create(new { events })
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var response = await _http.SendAsync(request, ct);
        response.EnsureSuccessStatusCode();
    }
}
