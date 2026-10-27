using GameHub.Agent.Service;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddWindowsService(options => options.ServiceName = "GameHubAgent");

// Configuration lives next to the binaries so the installer can drop agent.json there.
builder.Configuration.AddJsonFile(
    Path.Combine(AppContext.BaseDirectory, "agent.json"), optional: true, reloadOnChange: false);

builder.Services.Configure<AgentOptions>(builder.Configuration.GetSection("Agent"));
builder.Services.AddSingleton<TokenStore>();
builder.Services.AddSingleton<AgentState>();
builder.Services.AddHttpClient<DeviceClient>()
    .ConfigureHttpClient(client => client.Timeout = TimeSpan.FromSeconds(10));
builder.Services.AddSingleton<SessionHostPipe>();
builder.Services.AddHostedService(provider => provider.GetRequiredService<SessionHostPipe>());
builder.Services.AddHostedService<AgentWorker>();

builder.Logging.AddSimpleConsole(options =>
{
    options.SingleLine = true;
    options.TimestampFormat = "yyyy-MM-ddTHH:mm:sszzz ";
});
builder.Logging.AddEventLog(sourceName: "GameHubAgent");

var host = builder.Build();
await host.RunAsync();
